import type { Server } from "bun";
import type { LiveView } from "../core/live-turn";
import { type WebDashboardOptions, webDashboardRouter } from "../web/routes";
import { isLiveOrigin } from "./agy-conversation";
import { appAssets, PAGE_CSS, serveAsset, WEB_MANIFEST, withGzip } from "./assets";
import {
	type BoardCard,
	type BoardPanel,
	type BoardPromptRef,
	type BoardSource,
	type BoardTaskRef,
	boardView,
} from "./board";
import type { DiffAnswer, DiffSubject } from "./diff";
import { guardRequest, hostAllowlist } from "./host-guard";
import { renderDashboardPage, SCRIPT } from "./html";
import type { MonitorDetail } from "./monitor-detail";
import { proxyPaneGet } from "./proxy";
import * as route from "./routes";
import { type DashboardSnapshot, JOB_NAME } from "./snapshot";
import type { ThreadConversation } from "./thread-conversation";
import type { TurnTrace } from "./trace";

/** The agent board behind `api/board`, its event stream, the pane proxy and the page's board block. */
export interface DashboardBoardOptions {
	source: BoardSource;
	/** Open TASKs the cards are matched against (read-only database read per board view). */
	tasks: () => BoardTaskRef[];
	/** The newest recorded prompt of each (host, agent) for the cards' 마지막 지시 (read per board view); absent = none. */
	prompts?: () => BoardPromptRef[];
	/** herdr-web-ui address for the cards' "herdr에서 답하기" links; absent = no link. */
	herdrWebUrl?: string;
	/** Comment line sent on an idle `api/board/events` stream. Default 15 s. */
	keepAliveMs?: number;
	/** Board changes within this window go out as one `snapshot` event with the last board. Default 200 ms; 0 = at once. */
	debounceMs?: number;
}

export interface DashboardServerOptions {
	port: number;
	/** Loopback only (`127.0.0.1` or `::1`); outside exposure is a tunnel with access control in front. */
	hostname: string;
	/** Extra `Host` names (a tunnel's public name) besides loopback; any other `Host` is 421. */
	allowedHosts?: readonly string[];
	snapshot: () => Promise<DashboardSnapshot>;
	/** Hears a snapshot that could not be built (answered as 500). */
	onError?: (error: unknown) => void;
	/**
	 * Hears one owner-opened request: `page` (detail = the `view` query), `trace`, `conversation`, `monitor_detail`, `diff` and
	 * `board_pane`, and the snapshot poll (`snapshot`, or `snapshot_hidden` from a hidden tab; detail = the tab's `view`). Health, board, live and the event streams are not heard. A throw is ignored.
	 */
	onRequest?: (kind: string, detail?: string) => void;
	/** Absent when config has no `herdrBoard`: the board routes answer 404 `board_disabled`. */
	board?: DashboardBoardOptions;
	/** `api/turn/<id>/trace`: one turn's waterfall (read per request, never cached); absent = 404 `trace_disabled`. */
	trace?: (inboundId: number) => TurnTrace;
	/** `api/pane/trace`: the waterfall of a local omp worker card's last turn (read per request); absent = 404 `trace_disabled`. */
	cardTrace?: (card: BoardCard) => TurnTrace;
	/** `api/job/trace?name=<name>`: a background job's last turn waterfall (read per request); absent = 404 `trace_disabled`. */
	jobTrace?: (name: string) => TurnTrace;
	/**
	 * `api/thread/conversation?origin=<key>[&before=<cursor>]`: one conversation's omp session, masked (read per
	 * request, never cached); absent = 404 `conversation_disabled`.
	 */
	conversation?: (originKey: string, before?: string) => ThreadConversation;
	/**
	 * `api/monitor/detail?id=<monitor id>`: one monitor's masked instruction, procedure file heads and last runs (read
	 * per request, never cached); absent = 404 `monitor_detail_disabled`.
	 */
	monitorDetail?: (id: string) => MonitorDetail;
	/**
	 * `api/diff?lane=<name>` or `?task=<id>`: the change the owner is about to merge, masked and size-capped (read per
	 * request, never cached); throws when git fails (500 `diff_failed`). Absent = 404 `diff_disabled`.
	 */
	diff?: (subject: DiffSubject) => Promise<DiffAnswer>;
	/**
	 * `api/thread/live` and its event stream: what the conversation's running turn is writing now (the daemon's `live`
	 * op); throws when the daemon cannot be asked. Absent = 404 `live_disabled`.
	 */
	live?: (originKey: string) => Promise<LiveView | null>;
	/** Schedules the next live read and returns its cancel (default `setTimeout`/`clearTimeout`); tests run it by hand. */
	liveSchedule?: (fn: () => void, ms: number) => () => void;
	/** Hears an origin's live subscriber count after every change (subscribe or the server handling a disconnect). */
	onLiveSubscribers?: (originKey: string, count: number) => void;
	web?: WebDashboardOptions | undefined;
	now?: () => number;
}

const KEEP_ALIVE_MS = 15_000;

const DEBOUNCE_MS = 200;
const LIVE_INTERVAL_MS = 1000;
/** At most this many distinct live origins at once: one origin is one daemon read per second while any stream is open. */
const MAX_LIVE_CHANNELS = 32;
/** At most this many `api/board/events` streams at once: each one costs a full board build at subscribe time. */
const MAX_BOARD_STREAMS = 32;

const COMMON_HEADERS = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};
const PAGE_CSP =
	"default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const jsonReply = (body: unknown, status: number, head: boolean): Response =>
	new Response(head ? null : JSON.stringify(body), {
		status,
		headers: { ...COMMON_HEADERS, "content-type": "application/json; charset=utf-8" },
	});

const snapshotEvent = (panel: BoardPanel): string => `event: snapshot\ndata: ${JSON.stringify(panel)}\n\n`;

/** Hands every open `api/board/events` stream the same `snapshot` event for a board change. */
interface BoardFanout {
	/** Registers a stream's sender; the returned function removes it. */
	add(send: (chunk: string) => void): () => void;
	/** True while another stream may subscribe. */
	canAdd(): boolean;
}

/**
 * One board subscription per server, held only while a stream is open. A change starts a `debounceMs` window; when it
 * ends the board view is built once and the same event goes to every stream, so a burst of changes reaches each stream
 * as one event carrying the last board.
 */
function boardFanout(board: DashboardBoardOptions, panel: () => BoardPanel): BoardFanout {
	const senders = new Set<(chunk: string) => void>();
	const debounceMs = board.debounceMs ?? DEBOUNCE_MS;
	let unsubscribe: (() => void) | undefined;
	let timer: NodeJS.Timeout | undefined;
	const flush = (): void => {
		timer = undefined;
		if (senders.size === 0) return;
		const event = snapshotEvent(panel());
		for (const send of senders) send(event);
	};
	const changed = (): void => {
		if (debounceMs <= 0) flush();
		else timer ??= setTimeout(flush, debounceMs);
	};
	return {
		canAdd: () => senders.size < MAX_BOARD_STREAMS,
		add(send) {
			senders.add(send);
			unsubscribe ??= board.source.onChange(changed);
			return () => {
				if (!senders.delete(send) || senders.size > 0) return;
				clearTimeout(timer);
				timer = undefined;
				unsubscribe?.();
				unsubscribe = undefined;
			};
		},
	};
}

/**
 * A `text/event-stream` response: `subscribe` registers the stream's sender (and may send at once) and returns its
 * removal, run once when the client goes; a comment line goes out every `keepAliveMs` while the stream is open.
 */
function eventStream(
	request: Request,
	keepAliveMs: number,
	subscribe: (send: (chunk: string) => void) => () => void,
): Response {
	const encoder = new TextEncoder();
	let finish = (): void => undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let open = true;
			const send = (chunk: string): void => {
				if (!open) return;
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					finish();
				}
			};
			let remove = (): void => undefined;
			const timer = setInterval(() => send(": keep-alive\n\n"), keepAliveMs);
			finish = () => {
				if (!open) return;
				open = false;
				remove();
				clearInterval(timer);
				try {
					controller.close();
				} catch {
					// already closed by the client going away
				}
			};
			request.signal.addEventListener("abort", () => finish());
			remove = subscribe(send);
		},
		cancel() {
			finish();
		},
	});
	return new Response(body, {
		headers: { ...COMMON_HEADERS, "content-type": "text/event-stream; charset=utf-8" },
	});
}

/** One origin's live reads, shared by its `api/thread/live/events` streams. */
interface LiveChannel {
	senders: Set<(chunk: string) => void>;
	/** A read is running (no next read is scheduled meanwhile). */
	running: boolean;
	/** Cancels the scheduled next read; undefined when none is scheduled. */
	cancel: (() => void) | undefined;
	/** What the last event said (`<inboundId>:<seq>`, `null` or `error`) and the event itself, for late subscribers. */
	said: string | undefined;
	event: string | undefined;
}

/**
 * Live reads per origin, held only while a stream of that origin is open: one read at a time, the next scheduled
 * `LIVE_INTERVAL_MS` after the previous one ended (so a stuck daemon never piles up reads), and an event only when the
 * answer changed — another seq or turn, null, or the daemon becoming unreachable.
 */
function liveFanout(
	live: (originKey: string) => Promise<LiveView | null>,
	options: Pick<DashboardServerOptions, "liveSchedule" | "onLiveSubscribers">,
): { add(originKey: string, send: (chunk: string) => void): () => void; canAdd(originKey: string): boolean } {
	const channels = new Map<string, LiveChannel>();
	const schedule =
		options.liveSchedule ??
		((fn: () => void, ms: number) => {
			const timer = setTimeout(fn, ms);
			return () => clearTimeout(timer);
		});
	const plan = (originKey: string, channel: LiveChannel, ms: number): void => {
		channel.cancel = schedule(() => {
			channel.cancel = undefined;
			void read(originKey, channel);
		}, ms);
	};
	const read = async (originKey: string, channel: LiveChannel): Promise<void> => {
		channel.running = true;
		let said: string;
		let body: unknown;
		try {
			const view = await live(originKey);
			said = view === null ? "null" : `${view.inboundId}:${view.seq}`;
			body = { live: view };
		} catch {
			said = "error";
			body = { live: null, error: "daemon_unreachable" };
		}
		channel.running = false;
		if (channel.senders.size === 0) {
			if (channels.get(originKey) === channel) channels.delete(originKey);
			return;
		}
		if (said !== channel.said) {
			channel.said = said;
			channel.event = `event: live\ndata: ${JSON.stringify(body)}\n\n`;
			for (const send of channel.senders) send(channel.event);
		}
		plan(originKey, channel, LIVE_INTERVAL_MS);
	};
	return {
		canAdd: (originKey: string): boolean => channels.has(originKey) || channels.size < MAX_LIVE_CHANNELS,
		add(originKey, send) {
			let channel = channels.get(originKey);
			if (channel === undefined) {
				channel = { senders: new Set(), running: false, cancel: undefined, said: undefined, event: undefined };
				channels.set(originKey, channel);
			}
			const mine = channel;
			mine.senders.add(send);
			if (mine.event !== undefined) send(mine.event);
			if (!mine.running && mine.cancel === undefined) plan(originKey, mine, 0);
			options.onLiveSubscribers?.(originKey, mine.senders.size);
			return () => {
				if (!mine.senders.delete(send)) return;
				if (mine.senders.size === 0) {
					mine.cancel?.();
					mine.cancel = undefined;
					if (!mine.running && channels.get(originKey) === mine) channels.delete(originKey);
				}
				options.onLiveSubscribers?.(originKey, mine.senders.size);
			};
		},
	};
}

/**
 * Read-only: GET and HEAD of the page, the snapshot JSON, a turn's trace, a monitor's detail, a conversation's session and what its running
 * turn is writing (one read or an event stream), a health line, the web app manifest and its icons and — with a board — the board JSON, its event
 * stream and GET-only reads of a board card's conversation and plan. Nothing here changes any state.
 */
export function startDashboardServer(options: DashboardServerOptions): Server<undefined> {
	const now = options.now ?? Date.now;
	const board = options.board;
	const allowedHosts = hostAllowlist(options.allowedHosts);
	const panel = (): BoardPanel | undefined => {
		if (board === undefined) return undefined;
		const state = board.source.current();
		if (state === undefined) return { ok: false, error: "herdr_unreachable", origin: board.source.origin };
		return boardView(state, {
			tasks: board.tasks(),
			...(board.prompts === undefined ? {} : { prompts: board.prompts() }),
			now: now(),
			...(board.herdrWebUrl === undefined ? {} : { herdrWebUrl: board.herdrWebUrl }),
		});
	};
	const boardPanel = (): BoardPanel => panel() ?? { ok: false, error: "board_disabled" };
	const fanout = board === undefined ? undefined : boardFanout(board, boardPanel);
	const live = options.live === undefined ? undefined : liveFanout(options.live, options);
	const webRouter = webDashboardRouter(options.web, COMMON_HEADERS, eventStream);
	const heard = (kind: string, detail?: string): void => {
		try {
			options.onRequest?.(kind, detail);
		} catch {
			// The request log is a usage count; failing to write it must not change the answer.
		}
	};
	const assets = appAssets(SCRIPT, PAGE_CSS);
	const handle = async (request: Request): Promise<Response> => {
		const head = request.method === "HEAD";
		const refused = guardRequest(request, allowedHosts, COMMON_HEADERS);
		if (refused !== undefined) return refused;
		const url = new URL(request.url);
		const { pathname } = url;
		const reply = (body: string, contentType: string, extra: Record<string, string> = {}, status = 200) =>
			new Response(head ? null : body, {
				status,
				headers: { ...COMMON_HEADERS, ...extra, "content-type": contentType },
			});
		if (route.WEB_ANY.test(pathname)) return webRouter.api(request, pathname, url);
		if (request.method !== "GET" && !head) {
			return reply("method not allowed\n", "text/plain; charset=utf-8", { allow: "GET, HEAD" }, 405);
		}
		if (route.HEALTH.test(pathname)) return reply("ok", "text/plain; charset=utf-8");
		if (route.MANIFEST.test(pathname)) return reply(WEB_MANIFEST, "application/manifest+json; charset=utf-8");
		const served = serveAsset(request, pathname, assets, COMMON_HEADERS) ?? webRouter.asset(request, pathname);
		if (served !== undefined) return served;
		const icon = route.ICON.exec(pathname);
		if (icon !== null) {
			const file = Bun.file(new URL(`./icons/${icon[1]}.png`, import.meta.url));
			return new Response(head ? null : file, {
				headers: { ...COMMON_HEADERS, "content-type": "image/png", "cache-control": "max-age=86400" },
			});
		}
		const trace = route.TRACE.exec(pathname);
		if (trace !== null) {
			heard("trace");
			if (options.trace === undefined) return jsonReply({ error: "trace_disabled" }, 404, head);
			let answer: TurnTrace;
			try {
				answer = options.trace(Number(trace[1]));
			} catch (error) {
				options.onError?.(error);
				return jsonReply({ ok: false, error: "trace_failed" }, 500, head);
			}
			return jsonReply(answer, answer.ok ? 200 : 404, head);
		}
		if (route.JOB_TRACE.test(pathname)) {
			heard("trace");
			if (options.jobTrace === undefined) return jsonReply({ error: "trace_disabled" }, 404, head);
			const name = url.searchParams.get("name") ?? "";
			if (!JOB_NAME.test(name)) return jsonReply({ error: "invalid_name" }, 400, head);
			let answer: TurnTrace;
			try {
				answer = options.jobTrace(name);
			} catch (error) {
				options.onError?.(error);
				return jsonReply({ ok: false, error: "trace_failed" }, 500, head);
			}
			return jsonReply(answer, answer.ok ? 200 : 404, head);
		}
		const liveEvents = route.THREAD_LIVE_EVENTS.test(pathname);
		if (liveEvents || route.THREAD_LIVE.test(pathname)) {
			if (options.live === undefined || live === undefined) return jsonReply({ error: "live_disabled" }, 404, head);
			const origin = (url.searchParams.get("origin") ?? "").trim();
			if (origin === "" || !isLiveOrigin(origin)) return jsonReply({ error: "invalid_origin" }, 400, head);
			if (liveEvents) {
				if (!live.canAdd(origin)) return jsonReply({ error: "too_many_live_origins" }, 429, head);
				return head
					? new Response(null, {
							headers: { ...COMMON_HEADERS, "content-type": "text/event-stream; charset=utf-8" },
						})
					: eventStream(request, KEEP_ALIVE_MS, (send) => {
							// A first line at once: the response (and its headers) goes out before the first read ends.
							send(": live\n\n");
							return live.add(origin, send);
						});
			}
			try {
				return jsonReply({ live: await options.live(origin) }, 200, head);
			} catch {
				return jsonReply({ error: "daemon_unreachable" }, 503, head);
			}
		}
		if (route.THREAD_CONVERSATION.test(pathname)) {
			heard("conversation");
			if (options.conversation === undefined) return jsonReply({ error: "conversation_disabled" }, 404, head);
			let answer: ThreadConversation;
			try {
				answer = options.conversation(
					url.searchParams.get("origin") ?? "",
					url.searchParams.get("before") || undefined,
				);
			} catch (error) {
				options.onError?.(error);
				return jsonReply({ error: "conversation_failed" }, 500, head);
			}
			return answer.ok
				? jsonReply(
						{ turns: answer.turns, ...(answer.cursor === undefined ? {} : { cursor: answer.cursor }) },
						200,
						head,
					)
				: jsonReply({ error: answer.error }, 404, head);
		}
		if (route.MONITOR_DETAIL.test(pathname)) {
			heard("monitor_detail");
			if (options.monitorDetail === undefined) return jsonReply({ error: "monitor_detail_disabled" }, 404, head);
			const id = (url.searchParams.get("id") ?? "").trim();
			if (id === "") return jsonReply({ error: "invalid_id" }, 400, head);
			let answer: MonitorDetail;
			try {
				answer = options.monitorDetail(id);
			} catch (error) {
				options.onError?.(error);
				return jsonReply({ error: "monitor_detail_failed" }, 500, head);
			}
			return answer.ok ? jsonReply(answer, 200, head) : jsonReply({ error: answer.error }, 404, head);
		}
		if (route.DIFF.test(pathname)) {
			heard("diff");
			if (options.diff === undefined) return jsonReply({ error: "diff_disabled" }, 404, head);
			const lane = url.searchParams.get("lane") ?? "";
			const task = url.searchParams.get("task") ?? "";
			if ((lane === "") === (task === "")) return jsonReply({ error: "invalid_subject" }, 400, head);
			let answer: DiffAnswer;
			try {
				answer = await options.diff(lane === "" ? { task } : { lane });
			} catch (error) {
				options.onError?.(error);
				return jsonReply({ ok: false, error: "diff_failed" }, 500, head);
			}
			return answer.ok ? jsonReply(answer, 200, head) : jsonReply({ error: answer.error }, 404, head);
		}
		const pane = route.PANE.exec(pathname);
		if (route.BOARD.test(pathname) || route.BOARD_EVENTS.test(pathname) || pane !== null) {
			if (board === undefined || fanout === undefined) return jsonReply({ error: "board_disabled" }, 404, head);
			if (route.BOARD.test(pathname)) {
				// Built per request, never cached: a new TASK shows on its card at once.
				const current = boardPanel();
				return current.ok ? jsonReply(current, 200, head) : jsonReply({ error: current.error }, 503, head);
			}
			// `api/board/events`: one `snapshot` event at once and one per (debounced) board change.
			if (route.BOARD_EVENTS.test(pathname)) {
				if (!head && !fanout.canAdd()) return jsonReply({ error: "too_many_board_streams" }, 429, head);
				return head
					? new Response(null, {
							headers: { ...COMMON_HEADERS, "content-type": "text/event-stream; charset=utf-8" },
						})
					: eventStream(request, board.keepAliveMs ?? KEEP_ALIVE_MS, (send) => {
							const remove = fanout.add(send);
							send(snapshotEvent(boardPanel()));
							return remove;
						});
			}
			heard(pane?.[1] === "trace" ? "trace" : "board_pane");
			// The pane proxy needs only the live card, not the TASK-matched board view (no database read).
			if (pane?.[1] === "trace" && options.cardTrace === undefined) {
				return jsonReply({ error: "trace_disabled" }, 404, head);
			}
			const card = board.source.card(url.searchParams.get("card") ?? "");
			if (card === undefined) return jsonReply({ error: "unknown_pane" }, 404, head);
			if (pane?.[1] === "trace" && options.cardTrace !== undefined) {
				let answer: TurnTrace;
				try {
					answer = options.cardTrace(card);
				} catch (error) {
					options.onError?.(error);
					return jsonReply({ ok: false, error: "trace_failed" }, 500, head);
				}
				return jsonReply(answer, answer.ok ? 200 : 404, head);
			}
			const proxied = await proxyPaneGet(
				pane?.[1] === "plan" ? "plan" : "conversation",
				board.source.origin,
				card,
				url.searchParams,
			);
			return head ? new Response(null, { status: proxied.status, headers: proxied.headers }) : proxied;
		}
		const isPage = route.PAGE.test(pathname);
		if (!isPage && !route.SNAPSHOT.test(pathname)) {
			return reply("not found\n", "text/plain; charset=utf-8", {}, 404);
		}
		const kind = isPage ? "page" : url.searchParams.get("hidden") === "1" ? "snapshot_hidden" : "snapshot";
		heard(kind, url.searchParams.get("view") || undefined);
		const param = (name: string): string | undefined => url.searchParams.get(name) || undefined;
		const [view, card, task, item, diff, layout, stale] = [
			"view",
			"card",
			"task",
			"item",
			"diff",
			"layout",
			"stale",
		].map(param);
		if (isPage && view === "chat") return webRouter.page(request, url, head, PAGE_CSP);
		let snapshot: DashboardSnapshot;
		try {
			snapshot = await options.snapshot();
		} catch (error) {
			options.onError?.(error);
			return reply("snapshot failed\n", "text/plain; charset=utf-8", {}, 500);
		}
		return isPage
			? reply(
					renderDashboardPage(snapshot, {
						...(board === undefined ? {} : { board: panel() }),
						...(view === undefined ? {} : { view }),
						...(card === undefined ? {} : { card }),
						...(task === undefined ? {} : { task }),
						...(item === undefined ? {} : { item }),
						...(diff === undefined ? {} : { diff }),
						...(layout === undefined ? {} : { layout }),
						...(stale === undefined ? {} : { stale }),
					}),
					"text/html; charset=utf-8",
					{ "content-security-policy": PAGE_CSP },
				)
			: reply(JSON.stringify(snapshot), "application/json; charset=utf-8");
	};
	return Bun.serve({
		port: options.port,
		hostname: options.hostname,
		// `api/board/events` stays open; its keep-alive line comes well inside this.
		idleTimeout: 60,
		fetch: async (request) => withGzip(request, await handle(request)),
	});
}
