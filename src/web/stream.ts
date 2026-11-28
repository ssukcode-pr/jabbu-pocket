import { GRAMMAR } from "../core/origin-key";
import { readWebChanges, readWebWatermark } from "../store/web-messages";
import type { WebBotTarget } from "./bots";
import { renderWebMessageHtml } from "./card-html";

export type EventStreamFn = (
	request: Request,
	keepAliveMs: number,
	subscribe: (send: (chunk: string) => void) => () => void,
) => Response;

export interface WebStreamConfig {
	streamPollMs?: number | undefined;
	streamSchedule?: ((fn: () => void, ms: number) => () => void) | undefined;
	keepAliveMs?: number | undefined;
}

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_KEEP_ALIVE_MS = 15_000;
/** At most this many open `api/web/stream` streams per bot: each one polls the bot's `web_messages` DB every second. */
const MAX_WEB_STREAMS = 32;

/** Open web streams per bot home, so one bot's streams cannot starve another's. */
const openWebStreams = new Map<string, number>();

export function nonNegInt(raw: string | null): number | undefined {
	if (raw === null || raw === "") return 0;
	if (!/^\d{1,15}$/.test(raw)) return undefined;
	return Number(raw);
}

/** Handles `GET/HEAD /api/web/stream` by polling the target bot's `web_messages` watermark. */
export function handleWebStream(
	request: Request,
	url: URL,
	config: WebStreamConfig,
	target: WebBotTarget,
	head: boolean,
	commonHeaders: Record<string, string>,
	eventStream: EventStreamFn,
): Response {
	const err = (code: string, status = 400) =>
		new Response(head ? null : JSON.stringify({ error: code }), {
			status,
			headers: { ...commonHeaders, "content-type": "application/json; charset=utf-8" },
		});
	const conversationParam = url.searchParams.get("c");
	const conversation = conversationParam === null || conversationParam === "" ? undefined : conversationParam;
	if (conversation !== undefined && !GRAMMAR.web.conversation.test(conversation)) return err("invalid_conversation");
	const after = nonNegInt(url.searchParams.get("after"));
	const afterEdited = nonNegInt(url.searchParams.get("afterEdited"));
	if (after === undefined || afterEdited === undefined) return err("invalid_cursor");
	if (head) {
		return new Response(null, { headers: { ...commonHeaders, "content-type": "text/event-stream; charset=utf-8" } });
	}
	if ((openWebStreams.get(target.homeDir) ?? 0) >= MAX_WEB_STREAMS) {
		return err("too_many_web_streams", 429);
	}
	const schedule =
		config.streamSchedule ??
		((fn: () => void, ms: number) => {
			const timer = setTimeout(fn, ms);
			return () => clearTimeout(timer);
		});
	const pollMs = config.streamPollMs ?? DEFAULT_POLL_MS;
	const keepAliveMs = config.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;

	return eventStream(request, keepAliveMs, (send) => {
		let open = true;
		let cancel: (() => void) | undefined;
		let lastId = after;
		let lastEditedAt = afterEdited;

		const poll = (): void => {
			cancel = undefined;
			if (!open) return;
			const mark = readWebWatermark(target.homeDir, conversation);
			if (mark.maxId > lastId || mark.maxEditedAt > lastEditedAt) {
				// Page through every row changed since the cursors by id, so edits to older rows
				// cannot make a full page repeat forever and starve the rows behind it.
				let pageAfterId = 0;
				while (open) {
					const changes = readWebChanges(target.homeDir, lastId, lastEditedAt, conversation, 200, pageAfterId);
					if (changes.length > 0) {
						const enriched = changes.map((row) => ({ ...row, html: renderWebMessageHtml(row, { botId: target.id }) }));
						send(`event: messages\ndata: ${JSON.stringify({ messages: enriched })}\n\n`);
					}
					const tail = changes.at(-1);
					if (changes.length < 200 || tail === undefined) break;
					pageAfterId = tail.id;
				}
				lastId = Math.max(lastId, mark.maxId);
				lastEditedAt = Math.max(lastEditedAt, mark.maxEditedAt);
			}
			if (open) cancel = schedule(poll, pollMs);
		};

		send(": web\n\n");
		openWebStreams.set(target.homeDir, (openWebStreams.get(target.homeDir) ?? 0) + 1);
		cancel = schedule(poll, 0);
		return () => {
			open = false;
			cancel?.();
			cancel = undefined;
			const left = (openWebStreams.get(target.homeDir) ?? 0) - 1;
			if (left <= 0) openWebStreams.delete(target.homeDir);
			else openWebStreams.set(target.homeDir, left);
		};
	});
}
