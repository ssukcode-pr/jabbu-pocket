import { typicalNote } from "../store/turn-duration";
import type { BoardPanel } from "./board";
import { discordThreadHref, renderFlowChain } from "./detail";
import { hostChecksLevel, repoCountsText } from "./host-checks";
import { byAttention, type InboxEntry, inboxEntries, isStale } from "./inbox";
import { contextBar, costCardBody } from "./load-view";
import type { DashboardSnapshot, JobInfo, MonitorInfo } from "./snapshot";
import {
	APPROVAL_OUTCOMES,
	alertText,
	esc,
	GATE_LIMITS,
	gateText,
	JOB_LABELS,
	MONITOR_STAGES,
	monitorTook,
	openTurnsText,
	TURN_LABELS,
} from "./text";
import { type Turn, type TurnGroup, turnOf } from "./turn";
import { resetIn, trendHtml, usageLevel } from "./usage-forecast";

/** What the page is showing besides the data: the chosen view, the search text, the list order, the open entry and theme. */
export interface DashboardUi {
	/** `?view=`: inbox (default), list, turns, lanes, approvals, monitors, alerts, system; anything else = inbox + notice. */
	view?: string;
	/** Search text, matched against titles, TASK IDs and machine names. */
	q?: string;
	/** List column the List view is sorted by (state, title, machine, task, ac, age); default 확인 필요 → 진행 중 → 완료·대기. */
	sort?: string;
	desc?: boolean;
	/** `data-row` of the entry open in the detail panel (card key, TASK ID or row id): drawn as selected. */
	selected?: string;
	/** Theme preference: system (default), light or dark. */
	theme?: string;
	/** `?layout=list` of the turns view: its threads as one table instead of the three columns. */
	layout?: string;
	/** `?stale=1` of the inbox and list views: only 방치 panes ({@link isStale}). */
	stale?: boolean;
	/** Inbox entry ids unread in this browser ({@link unreadIds}): a dot on their cards and rows, a count per column. */
	unread?: string[];
}

/**
 * The redrawn part of the page for one snapshot: the top bar, the side navigation and the chosen view. Self-contained
 * on purpose — no imports, and the only module-level helpers are `gateText`/`alertText`/`GATE_LIMITS`/`TURN_LABELS`/
 * `JOB_LABELS`/`MONITOR_STAGES`/`APPROVAL_OUTCOMES`/`monitorTook`,
 * which the page ships next to it: the page ships this very function's source as its inline script, so the server's
 * first render and every client redraw are the same code. Every free string goes through `esc`.
 *
 * Inline 16x16 SVG line icons are hand-crafted for jabbu (MIT, no external requests).
 *
 * Badge colours carry one meaning each: is-success done/healthy · is-info in progress · is-warning someone has to
 * look (blocked, stalled, open gate, frozen, waiting on the owner) · is-danger failed/down/gone · grey idle/waiting.
 * Every status pill pairs an icon shape with its word so status is never conveyed by colour alone.
 */
export function renderDashboardMain(
	s: DashboardSnapshot,
	board?: BoardPanel,
	now?: number,
	ui: DashboardUi = {},
): string {
	/** `2026-11-04T09:02:53-05:00` → `11-04 09:02` (times arrive with the offset of the snapshot's `timezone`). */
	const at = (iso: string | null | undefined): string => (iso ? esc(iso.slice(5, 16).replace("T", " ")) : "-");
	const dur = (ms: number | null | undefined): string => {
		if (ms === null || ms === undefined) return "-";
		const minutes = Math.floor(ms / 60_000);
		if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}초`;
		if (minutes < 60) return `${minutes}분`;
		const hours = Math.floor(minutes / 60);
		return hours < 48 ? `${hours}시간 ${minutes % 60}분` : `${Math.floor(hours / 24)}일`;
	};
	const live = board?.ok ? board : undefined;
	const clock = now ?? (live === undefined ? Date.parse(s.generatedAt) : live.generatedAt);
	const ago = (since: number): string => {
		if (!since) return "-";
		const minutes = Math.floor(Math.max(0, clock - since) / 60_000);
		if (minutes < 1) return "방금";
		if (minutes < 60) return `${minutes}분 전`;
		const hours = Math.floor(minutes / 60);
		return hours < 24 ? `${hours}시간 전` : `${Math.floor(hours / 24)}일 전`;
	};
	const msOf = (iso: string | undefined): number => {
		const ms = Date.parse(iso ?? "");
		return Number.isNaN(ms) ? 0 : ms;
	};
	/** Hand-crafted 16x16 SVG line icons (MIT). */
	const svg = (paths: string, cls = "state-ico"): string =>
		`<svg class="ico ${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
	const statusIcon = (tone: string): string => {
		if (tone === "is-info")
			return svg('<circle cx="8" cy="8" r="5.5" stroke-opacity="0.3"/><path d="M8 2.5A5.5 5.5 0 0 1 13.5 8"/>');
		if (tone === "is-success") return svg('<circle cx="8" cy="8" r="5.5"/><path d="m5.5 8.2 1.7 1.7 3.5-3.6"/>');
		if (tone === "is-warning")
			return svg(
				'<path d="M8 2.3 14 13H2L8 2.3Z"/><path d="M8 6.5v3"/><circle cx="8" cy="11.2" r="0.4" fill="currentColor"/>',
			);
		if (tone === "is-danger")
			return svg('<circle cx="8" cy="8" r="5.5"/><path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4"/>');
		return svg('<circle cx="8" cy="8" r="5.5" stroke-dasharray="2.4 2"/>');
	};
	const navIcon = (id: string): string => {
		const icons: Record<string, string> = {
			inbox: '<path d="M2.5 4h11v8.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4Z"/><path d="M2.5 9h3.2l1 1.5h2.6l1-1.5h3.2"/>',
			turns: '<polyline points="1.8 8 4.8 8 6.6 3.8 9.4 12.2 11.2 8 14.2 8"/>',
			flow: '<rect x="1.5" y="5.5" width="4" height="5" rx="1"/><rect x="10.5" y="5.5" width="4" height="5" rx="1"/><path d="M5.5 8h4.5M8.6 6.4 10.2 8l-1.6 1.6"/>',
			lanes:
				'<circle cx="4.5" cy="4" r="1.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="8" r="1.5"/><path d="M4.5 5.5v5M6 4h3.5a2 2 0 0 1 2 2v.5"/>',
			approvals:
				'<path d="M8 2 3 4.2v3.6c0 3.2 2.1 5.5 5 6.2 2.9-.7 5-3 5-6.2V4.2L8 2Z"/><path d="m5.8 8 1.6 1.6 3-3.2"/>',
			monitors: '<circle cx="8" cy="8" r="5.5"/><polyline points="8 4.8 8 8 10.4 9.4"/>',
			alerts:
				'<path d="M8 2.5a4 4 0 0 0-4 4v2.8L2.8 11h10.4L12 9.3V6.5a4 4 0 0 0-4-4Z"/><path d="M6.8 13a1.5 1.5 0 0 0 2.4 0"/>',
			system:
				'<rect x="2.5" y="3" width="11" height="4" rx="1"/><rect x="2.5" y="9" width="11" height="4" rx="1"/><circle cx="5" cy="5" r="0.6" fill="currentColor"/><circle cx="5" cy="11" r="0.6" fill="currentColor"/>',
		};
		return svg(icons[id] ?? icons.inbox ?? "", "nav-ico");
	};
	/** state → [label, badge tone]; anything not listed is grey with its raw name. */
	const STATES: Record<string, [string, string]> = {
		working: ["진행 중", "is-info"],
		dispatched: ["진행 중", "is-info"],
		pending: ["대기", ""],
		uncertain: ["전달 불확실", "is-warning"],
		idle: ["쉬는 중", ""],
		unknown: ["알 수 없음", ""],
		cancelled: ["취소", ""],
		blocked: ["막힘", "is-warning"],
		review: ["검토 대기", "is-warning"],
		"not-done": ["미완료", "is-warning"],
		paused: ["멈춤", "is-warning"],
		done: ["완료", "is-success"],
		"done-claimed": ["완료 보고", "is-success"],
		delivered: ["전달", "is-success"],
		gone: ["사라짐", "is-danger"],
		failed: ["실패", "is-danger"],
		failed_no_retry: ["실패", "is-danger"],
		answered: ["답함", "is-success"],
		failed_notified: ["실패", "is-danger"],
		discarded: ["버림", ""],
		no_report: ["조용히 끝남", ""],
		skipped: ["건너뜀", ""],
		admitted: ["대기", ""],
		authored: ["작성됨", "is-info"],
	};
	const badge = (text: string, tone: string, html = esc(text)): string =>
		`<span class="status-pill ${tone}">${statusIcon(tone)}<span class="badge ${tone}">${html}</span></span>`;
	/** A header number the page rolls when it changes: `bad` says which way is worse (see `rollLabel`). */
	const roll = (key: string, value: number | string, bad: string): string =>
		`<span class="roll-n" data-roll="${esc(key)}" data-roll-v="${esc(value)}" data-roll-bad="${bad}">${esc(value)}</span>`;
	const state = (name: string, prefix = ""): string => {
		const known = STATES[name];
		return known === undefined ? badge(`${prefix}${name || "?"}`, "") : badge(`${prefix}${known[0]}`, known[1]);
	};
	const failed = (error: string): string =>
		`<div class="notice is-danger">${badge("읽기 실패", "is-danger")}<span>${esc(error)}</span><span class="notice-next">다음 행동: DB 파일 권한이나 디스크 상태를 확인한 뒤 새로고침하세요.</span></div>`;
	/** A to-do line: escaped, backtick spans as `<code>`. */
	const cmd = (text: string): string => esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");

	const VIEWS: Array<[string, string]> = [
		["inbox", "인박스"],
		["turns", "턴"],
		["flow", "흐름"],
		["lanes", "레인"],
		["approvals", "승인 대기"],
		["monitors", "모니터"],
		["alerts", "알림"],
		["system", "시스템"],
	];
	const asked = ui.view ?? "inbox";
	const view = asked === "list" || VIEWS.some(([id]) => id === asked) ? asked : "inbox";
	const viewLabel = view === "list" ? "목록" : (VIEWS.find(([id]) => id === view)?.[1] ?? "인박스");
	const q = (ui.q ?? "").trim().toLowerCase();
	const hit = (...texts: unknown[]): boolean =>
		q === "" || texts.some((text) => `${text ?? ""}`.toLowerCase().includes(q));
	const selected = ui.selected ?? "";
	const isSel = (id: string): boolean => id !== "" && id === selected;
	const theme = ui.theme === "light" || ui.theme === "dark" ? ui.theme : "system";
	// Read marks change no order, number, next line or tab title: unread is no 확인 필요.
	const unread = new Set(ui.unread ?? []);
	const unreadDot = (id: string): string =>
		unread.has(id) ? '<span class="unread-dot" title="안 읽음" role="img" aria-label="안 읽음"></span>' : "";

	// ---- the inbox: one row per agent pane, plus the open TASKs no pane carries; `turnOf` alone groups them ----
	type Entry = InboxEntry;
	const tasks = s.tasks.ok ? s.tasks.items : [];
	const entries = inboxEntries(s, live);
	const turns = new Map(entries.map((entry) => [entry.id, turnOf(entry, unread.has(entry.id))]));
	const turnFor = (entry: Entry): Turn => turns.get(entry.id) ?? turnOf(entry);
	/** The groups top to bottom: label and how many rows show before 더 보기 (0 = all). */
	const GROUPS: Array<[TurnGroup, string, number]> = [
		["mine", "내 차례", 0],
		["working", "진행 중", 5],
		["read", "읽을 것", 3],
		["done", "확인함", 3],
	];
	const RANK: Record<TurnGroup, number> = { mine: 0, working: 1, read: 2, done: 3 };
	const groupOf = (entry: Entry): TurnGroup => turnFor(entry).group;
	// 내 차례 keeps the one order (longest wait first); the other groups show the newest first.
	const byDefault = (a: Entry, b: Entry): number =>
		RANK[groupOf(a)] - RANK[groupOf(b)] || (groupOf(a) === "mine" ? byAttention(a, b) : b.since - a.since);
	// The 방치 filter lives on the inbox and list only; its chip counts before the search. Filter and search dim the
	// rows they leave out instead of dropping them, so nothing moves under the pointer and every count stays whole.
	const staleOn = ui.stale === true && (view === "inbox" || view === "list");
	const staleCount = entries.filter((entry) => isStale(entry, clock)).length;
	const hitOf = (entry: Entry): boolean =>
		(!staleOn || isStale(entry, clock)) &&
		hit(entry.title, entry.taskId, entry.machine, entry.card?.paneLabel, entry.card?.name);
	const hits = entries.filter(hitOf).length;
	// The next line and the tab count use every 내 차례 entry, whatever the search dims.
	const attention = entries.filter((entry) => entry.col === "mine").sort(byAttention);
	const next = attention[0];
	const signalBad = !s.daemon.ok || !s.daemon.running || (board !== undefined && !board.ok);
	const closed = staleOn ? [] : tasks.filter((task) => !task.open && hit(task.title, task.taskId, task.host));

	const linkOf = (entry: { kind: string; id: string }): string =>
		entry.kind === "card"
			? `href="?card=${esc(encodeURIComponent(entry.id))}" data-card="${esc(entry.id)}"`
			: `href="?task=${esc(encodeURIComponent(entry.id))}" data-task="${esc(entry.id)}"`;
	const stateKeyOf = (entry: Entry): string =>
		`${groupOf(entry)}:${entry.card?.status ?? ""}:${entry.task?.status ?? ""}`;
	/** A row's mark (`!` for 내 차례, the rest drawn by the style). */
	const markOf = (entry: Entry): string =>
		`<span class="mk" aria-hidden="true">${turnFor(entry).mark === "!" ? "!" : ""}</span>`;
	/** A row's one state word (방치 says so in place of the word). */
	const wordOf = (entry: Entry): string =>
		`<b class="tw">${esc(isStale(entry, clock) ? "방치" : turnFor(entry).word)}</b>`;
	/**
	 * One inbox row, two lines: the question or the title, then `저장소 · TASK`, the state word, the worker model and one
	 * reason; the age at the end. A 내 차례 row carries its number on screen (1…9, `order`). Worker briefs and the
	 * judge's own wording stay in the detail panel.
	 */
	const rowOf = (entry: Entry, order = 0): string => {
		const turn = turnFor(entry);
		const task = entry.task;
		const where = [task?.repo, entry.taskId || entry.machine].filter((part) => part).join(" · ");
		const [model = "", effort] = (task?.workerModel ?? "").split(":");
		const modelText = model === "" ? "" : `${model.split("/")[0]}${effort ? ` · ${effort}` : ""}`;
		const slow = task?.typical !== undefined && (task.elapsedMs ?? 0) > task.typical.p90Ms;
		const isNext = next !== undefined && next.kind === entry.kind && next.id === entry.id;
		// Rows the search or the 방치 filter leaves out are dimmed, and so is a 방치 row while the filter is off.
		const classes = `card trow is-${turn.group}${isSel(entry.id) ? " is-selected" : ""}${isNext ? " is-next" : ""}${
			hitOf(entry) && (staleOn || !isStale(entry, clock)) ? "" : " is-dim"
		}`;
		return `<a class="${classes}" data-state="${esc(stateKeyOf(entry))}" ${linkOf(entry)} data-row="${esc(entry.id)}"${
			order > 0 ? ` data-order="${order}"` : ""
		}${isSel(entry.id) ? ' aria-current="true"' : ""}>${markOf(entry)}<span class="t1">${
			order > 0 ? `<span class="order-no">${order}</span>` : ""
		}${unreadDot(entry.id)}${esc(turn.line)}</span><span class="t2">${where === "" ? "" : `<span>${esc(where)}</span>`}${wordOf(
			entry,
		)}${modelText === "" ? "" : `<small>${esc(modelText)}</small>`}<span>${esc(
			turn.reason,
		)}</span>${slow ? "<small>평소보다 길어짐</small>" : ""}</span><span class="card-time">${ago(entry.since)}</span></a>`;
	};
	/** The next line: the first 내 차례 entry (search or not), why, where and how long; a quiet line when none. */
	const nextLine = (): string => {
		if (next === undefined) {
			return `<p class="next-quiet">${signalBad ? "다음 · 상태 모름 — 갱신 끊김" : "다음 · 기다리는 항목 없음"}</p>`;
		}
		const minutes = next.since ? Math.floor(Math.max(0, clock - next.since) / 60_000) : -1;
		const [amount, unit] =
			minutes < 0
				? ["-", ""]
				: minutes < 1
					? ["방금", ""]
					: minutes < 60
						? [String(minutes), "분"]
						: minutes < 1440
							? [String(Math.floor(minutes / 60)), "시간"]
							: [String(Math.floor(minutes / 1440)), "일"];
		const line = turnFor(next).line;
		const title = line.length > 24 ? `${line.slice(0, 23)}…` : line;
		const where = [next.machine, next.task?.branch || next.taskId].filter((part) => part).join(" · ");
		const reply = next.card?.replyUrl;
		return `<div class="next-line"><a class="next-up" ${linkOf(next)}><span class="next-label">다음</span><span class="next-title">${esc(
			title,
		)}</span><span class="next-why">${esc([turnFor(next).reason, next.task?.overlap ?? []].flat().join(" · "))}${
			where === "" ? "" : ` · ${esc(where)}`
		}</span><span class="next-wait"><b>${amount}</b>${unit}</span></a>${
			reply
				? `<a class="next-reply" href="${esc(reply)}" target="_blank" rel="noopener noreferrer">herdr에서 답하기 ↗</a>`
				: ""
		}</div>`;
	};

	const banners: string[] = [];
	const d = s.daemon;
	if (!d.ok) {
		banners.push(
			`<div class="notice is-danger">${badge("데몬 상태 모름", "is-danger")}<span>${esc(d.error)}</span><span class="notice-next">다음 행동: 터미널에서 <code>jabbu-pocket status</code> 또는 <code>jabbu-pocket doctor</code>로 데몬 소켓·DB 상태를 확인하세요.</span></div>`,
		);
	} else if (!d.running) {
		banners.push(
			`<div class="notice is-danger">${badge("데몬 꺼짐", "is-danger")}<span>데몬이 응답하지 않아요. 아래 내용은 DB에 남은 마지막 상태예요.</span><span class="notice-next">다음 행동: <code>systemctl --user status jabbu</code>으로 데몬 상태를 확인하고 필요하면 다시 켜세요.</span></div>`,
		);
	}
	if (board !== undefined && !board.ok) {
		banners.push(
			`<div class="notice is-danger">${badge("에이전트 보드 연결 안 됨", "is-danger")}<span>herdr-web-ui에 다시 붙는 중이에요 (${esc(board.error)}). TASK는 마지막으로 읽은 워커 상태로 보여요.</span><span class="notice-next">다음 행동: herdr-web-ui 서비스(${esc(board.origin ? board.origin.replace(/^https?:\/\//, "").replace(/\/+$/, "") : "127.0.0.1:7317")})와 연결 상태를 확인하거나 자동 재연결을 잠시 기다려 주세요.</span></div>`,
		);
	}
	if (!s.tasks.ok) banners.push(failed(s.tasks.error));
	if (asked !== view) {
		banners.push(
			`<p class="notice is-warning" role="status">${badge(" 안내", "is-warning")}<span>모르는 보기 '${esc(asked)}'예요. 인박스를 보여 드려요. 왼쪽 내비나 ⌘K 명령 팔레트에서 다른 보기를 고를 수 있어요.</span></p>`,
		);
	}
	const clearBtn =
		q !== ""
			? `<button type="button" class="button is-ghost is-sm" data-clear-search>검색 '${esc(ui.q)}' 지우기 (Esc)</button>`
			: "";
	const staleOffBtn = '<button type="button" class="button is-ghost is-sm" data-stale-off>방치 필터 끄기</button>';
	/** The 방치 chip and, while the filter is on, the button that turns it off; no chip with nothing 방치 and the filter off. */
	const staleHead =
		staleCount === 0 && !staleOn
			? ""
			: `<button type="button" class="chip" data-stale aria-pressed="${staleOn}">방치 <b>${staleCount}</b></button>${
					staleOn ? staleOffBtn : ""
				}`;
	const nothing = staleOn
		? `<div class="empty-box" role="status"><p class="note">${
				q !== "" ? "검색어와 방치 필터를 모두 만족하는 항목이 없어요" : "방치된 패널이 없어요"
			}</p><p class="note-sub">다음 행동: 방치 필터를 끄면 모든 항목이 다시 보여요.</p>${staleOffBtn}</div>`
		: q !== ""
			? `<div class="empty-box" role="status"><p class="note">'${esc(ui.q)}'와 맞는 항목이 없어요.</p><p class="note-sub">다음 행동: 검색어를 지우거나(Esc) 다른 제목·TASK ID·머신 이름으로 다시 검색해 보세요.</p><button type="button" class="button is-ghost is-sm" data-clear-search>검색어 지우기 (Esc)</button></div>`
			: "";
	const head = (title: string, count: number | string | undefined, extra = ""): string =>
		`<div class="view-head"><h1 class="view-title">${esc(title)}</h1>${
			count === undefined ? "" : `<span class="count-chip">${esc(count)}</span>`
		}${extra}${clearBtn}</div>`;

	/** The four group counts, the same line on the inbox and the list. */
	const groupSum = `<p class="badges group-sum">${GROUPS.map(
		([id, label]) =>
			`<a class="chip" href="#col-${id}">${esc(label)} <b>${entries.filter((entry) => groupOf(entry) === id).length}</b></a>`,
	).join("")}</p>`;
	const inboxView = (): string => {
		const machines =
			live === undefined
				? ""
				: `<div class="badges">${live.machines
						.map((machine) =>
							badge(`${machine.name}${machine.connected ? "" : " · 끊김"}`, machine.connected ? "" : "is-danger"),
						)
						.join("")}</div>`;
		const columns = GROUPS.map(([id, label, keep]) => {
			const cards = entries.filter((entry) => groupOf(entry) === id).sort(byDefault);
			// Numbers go to the 내 차례 rows the search leaves lit, 1…9 without gaps.
			let order = 0;
			const drawn = cards.map((entry) => rowOf(entry, id === "mine" && hitOf(entry) && order < 9 ? ++order : 0));
			const rest = keep === 0 ? [] : drawn.splice(keep);
			// `id` keeps the fold open across the redraw, like 최근 닫힘.
			const more =
				rest.length === 0
					? ""
					: `<details class="closed" id="more-${id}"><summary>더 보기 <span class="count-chip">${rest.length}</span></summary>${rest.join("")}</details>`;
			const body = `${drawn.join("")}${more}`;
			// Below the head, not in it: the unread count of the rows and a button that reads them all.
			const unreadCount = cards.filter((entry) => unread.has(entry.id)).length;
			const unreadLine =
				unreadCount === 0
					? ""
					: `<div class="col-unread"><span>안 읽음 <b>${unreadCount}</b></span><button type="button" class="button is-ghost is-sm" data-mark-read="${id}">모두 읽음</button></div>`;
			const recent =
				id !== "done" || closed.length === 0
					? ""
					: `<details class="closed" id="closed"><summary>최근 닫힘 <span class="count-chip">${closed.length}</span></summary>${closed
							.map(
								(task) =>
									`<a class="closed-row" ${linkOf({ kind: "task", id: task.taskId })} data-row="${esc(task.taskId)}"><b>${esc(
										task.taskId,
									)}</b> ${esc(task.title)} · ${esc(STATES[task.status]?.[0] ?? task.status)} ${at(task.closedAt)}</a>`,
							)
							.join("")}</details>`;
			return `<section class="grp" id="col-${id}" aria-label="${esc(label)}"${
				cards.length === 0 && recent === "" ? " data-empty" : ""
			}><h2 class="col-head"><span>${esc(
				label,
			)}</span><span class="count-chip">${cards.length}</span></h2>${unreadLine}${body}${recent}</section>`;
		}).join("");
		const herdr = s.herdr;
		// Without a live board, the `herdr agent list` of every host stays visible under the inbox.
		const agents =
			live !== undefined || (herdr.ok && herdr.hosts.length === 0)
				? ""
				: `<section class="rows-block" aria-label="herdr 에이전트">${head(
						"herdr 에이전트",
						herdr.ok ? herdr.hosts.reduce((sum, host) => sum + (host.ok ? host.agents.length : 0), 0) : undefined,
					)}${
						herdr.ok
							? herdr.hosts
									.map(
										(host) =>
											`<p class="group">${esc(host.host)}</p>${
												!host.ok
													? `<div class="notice is-danger">${badge("호스트 연결 실패", "is-danger")}<span>${esc(host.error)}</span><span class="notice-next">다음 행동: <code>jabbu-pocket doctor</code>로 해당 호스트의 SSH 및 herdr 경로를 점검하세요.</span></div>`
													: host.agents.length === 0
														? '<div class="empty-box"><p class="note">실행 중인 에이전트가 없어요</p><p class="note-sub">새 작업을 위임하면 이 호스트의 에이전트 목록에 나타납니다.</p></div>'
														: `<div class="rows">${host.agents
																.map(
																	(agent) =>
																		`<div class="row"><div class="row-main"><div class="badges">${state(agent.agentStatus)}</div><p class="row-title">${esc(agent.name)}</p>${
																			agent.terminalTitle ? `<p class="row-sub">${esc(agent.terminalTitle)}</p>` : ""
																		}${
																			agent.question
																				? `<p class="row-sub">묻는 말: ${esc(agent.question)}</p>`
																				: agent.blocked || agent.lastSay
																					? `<p class="row-sub">${esc(agent.blocked || agent.lastSay)}</p>`
																					: ""
																		}<p class="row-sub">${agent.taskId ? `${esc(agent.taskId)} · ` : ""}${esc(agent.cwd)}</p></div></div>`,
																)
																.join("")}</div>`
											}`,
									)
									.join("")
							: `<div class="notice is-danger">${badge("herdr 조회 실패", "is-danger")}<span>${esc(herdr.error)}</span><span class="notice-next">다음 행동: 로컬 herdr 실행 파일과 데몬 설정을 확인하세요(<code>jabbu-pocket doctor</code>).</span></div>`
					}</section>`;
		// The head's 확인 필요 is the 내 차례 rows, the same number as the tab title.
		const top = `${head("에이전트 인박스", undefined, `<span class="view-sum">확인 필요 <b>${attention.length}</b></span>${staleHead}${machines}`)}${banners.join("")}${nextLine()}`;
		return `${top}${hits === 0 ? nothing : ""}${groupSum}<div class="groups">${columns}</div>${agents}`;
	};

	const SORTS: Array<[string, string]> = [
		["state", "상태"],
		["title", "제목"],
		["machine", "머신"],
		["task", "TASK"],
		["ac", "AC"],
		["age", "경과"],
	];
	const listView = (): string => {
		const key = SORTS.some(([id]) => id === ui.sort) ? (ui.sort as string) : "state";
		const flip = ui.desc === true ? -1 : 1;
		const ratio = (entry: Entry): number =>
			entry.task === undefined || entry.task.acTotal === 0 ? -1 : (entry.task.acChecked ?? 0) / entry.task.acTotal;
		const value = (entry: Entry): string | number =>
			key === "title"
				? entry.title
				: key === "machine"
					? entry.machine
					: key === "task"
						? entry.taskId
						: key === "ac"
							? ratio(entry)
							: key === "age"
								? clock - entry.since
								: RANK[groupOf(entry)];
		const rows = entries.slice().sort((a, b) => {
			const x = value(a);
			const y = value(b);
			const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ko");
			return order === 0 ? byDefault(a, b) : order * flip;
		});
		const heads = SORTS.map(([id, label]) => {
			const active = id === key;
			const sort = active ? (flip === 1 ? "ascending" : "descending") : "none";
			return `<th scope="col" aria-sort="${sort}"><button type="button" data-sort="${id}">${esc(label)}${
				active ? `<span aria-hidden="true"> ${flip === 1 ? "↑" : "↓"}</span>` : ""
			}</button></th>`;
		}).join("");
		const body = rows
			.map(
				(entry) =>
					`<tr data-row="${esc(entry.id)}" data-state="${esc(stateKeyOf(entry))}" class="is-${groupOf(entry)}${
						isSel(entry.id) ? " is-selected" : ""
					}${hitOf(entry) ? "" : " is-dim"}"><td>${markOf(entry)}${wordOf(entry)}</td><td class="list-title">${unreadDot(entry.id)}<a ${linkOf(entry)}${isSel(entry.id) ? ' aria-current="true"' : ""}>${esc(
						entry.title,
					)}</a></td><td>${esc(entry.machine)}</td><td class="mono">${esc(entry.taskId || "-")}</td><td class="num">${
						entry.task === undefined ? "-" : esc(`${entry.task.acChecked ?? "-"}/${entry.task.acTotal}`)
					}</td><td class="num">${ago(entry.since)}</td></tr>`,
			)
			.join("");
		return `${head("에이전트 목록", rows.length, staleHead)}${banners.join("")}${
			rows.length === 0
				? '<div class="empty-box"><p class="note">보여 줄 에이전트나 TASK가 없어요.</p><p class="note-sub">새로운 작업이 시작되면 목록에 표시됩니다.</p></div>'
				: `${hits === 0 ? nothing : ""}${groupSum}<table class="list"><thead><tr>${heads}</tr></thead><tbody>${body}</tbody></table>`
		}`;
	};

	// 겹침: a badge whose hover lists the path and the other sessions; agy sessions are not checked (card hover says so).
	const overlapOf = (key: string): string[] =>
		s.overlaps?.hints[key] === undefined
			? []
			: [badge("", "is-warning", `<span title="${esc(s.overlaps.hints[key])}">겹침</span>`)];
	const agyTitle = (key: string): string => (s.overlaps?.agy.includes(key) ? ' title="agy 세션은 검사 안 함"' : "");
	const overlapRow = (line: string): string => `<p class="row">${badge("겹침", "is-warning")} ${esc(line)}</p>`;
	/** A row of one of the other views; it opens in the detail panel as `?view=<view>&item=<id>`. */
	const row = (id: string, badges: string[], title: string, sub: string[]): string => {
		const lines = sub
			.filter((line) => line !== "")
			.map((line) => `<p class="row-sub">${line}</p>`)
			.join("");
		return `<a class="row${isSel(id) ? " is-selected" : ""}" href="?view=${view}&amp;item=${esc(encodeURIComponent(id))}" data-item="${esc(
			id,
		)}" data-row="${esc(id)}"${isSel(id) ? ' aria-current="true"' : ""}><div class="row-main">${
			badges.length === 0 ? "" : `<div class="badges">${badges.join("")}</div>`
		}<p class="row-title">${title}</p>${lines}</div></a>`;
	};
	const listOf = (title: string, rows: string[], total: number, none: string, hint: string, lead = ""): string =>
		`${head(title, total)}${banners.join("")}${lead}${
			rows.length === 0
				? total > 0
					? nothing
					: `<div class="empty-box"><p class="note">${esc(none)}</p><p class="note-sub">${esc(hint)}</p></div>`
				: `<div class="rows">${rows.join("")}</div>`
		}`;

	const sectionView = (): string => {
		if (view === "turns") {
			const turns = s.turns;
			// Background jobs (`<home>/jobs/*.json`) under the turns: they outlive the turn that started them.
			const jobs = s.jobs;
			const jobRow = (job: JobInfo): string => {
				const [word, tone] = JOB_LABELS[job.health === "ok" ? (job.state ?? "running") : job.health];
				const counts =
					job.done === undefined || job.total === undefined
						? ""
						: `${
								job.percent === undefined
									? ""
									: `<span class="meter" role="img" aria-label="진행 ${job.percent}%"><i style="width:${job.percent}%"></i></span> `
							}${esc(
								`${job.done}/${job.total}${job.unit ? ` ${job.unit}` : ""}${job.percent === undefined ? "" : ` (${job.percent}%)`}`,
							)}`;
				return row(`job:${job.name}`, [badge(word, tone)], esc(job.title), [
					counts,
					`${job.startedAt ? `시작 ${at(job.startedAt)} · ` : ""}마지막 갱신 뒤 ${dur(job.ageMs)}`,
					job.thread ? `스레드 ${esc(job.thread)}` : "",
					esc(job.detail ?? ""),
				]);
			};
			const shownJobs = jobs.ok ? jobs.items.filter((job) => hit(job.title, job.name, job.detail, job.thread)) : [];
			// Running or troubled jobs sit above the board where they are seen; cleanly finished ones fold at the bottom.
			const finished = (job: JobInfo): boolean =>
				(job.state === "done" || job.state === "stopped") && job.health === "ok";
			const liveJobs = shownJobs.filter((job) => !finished(job));
			const doneJobs = shownJobs.filter(finished);
			const jobTop = !jobs.ok
				? `<div class="view-head" id="jobs"><h2 class="h2">백그라운드 작업</h2></div>${failed(jobs.error)}`
				: liveJobs.length === 0
					? ""
					: `<div class="view-head" id="jobs"><h2 class="h2">백그라운드 작업</h2><span class="count-chip">${liveJobs.length}</span></div><div class="rows">${liveJobs.map(jobRow).join("")}</div>`;
			// `id="closed"` keeps the fold open across the 15-second redraw, like the inbox's 최근 닫힘.
			const jobDone =
				doneJobs.length === 0
					? ""
					: `<details class="closed" id="closed"><summary>끝난 백그라운드 작업 <span class="count-chip">${doneJobs.length}</span></summary><div class="rows">${doneJobs.map(jobRow).join("")}</div></details>`;
			const runningJobs = jobs.ok ? jobs.items.filter((job) => job.state === "running").length : 0;
			if (!turns.ok) return `${head("턴", undefined)}${banners.join("")}${failed(turns.error)}${jobTop}${jobDone}`;
			const draining = d.ok && (d.drain !== undefined || d.heartbeat?.draining === true);
			const holding = turns.items.filter((turn) => turn.blocksRestart);
			const oldest = holding.reduce((max, turn) => Math.max(max, turn.ageMs), 0);
			const drainLine = draining
				? `<p class="notice is-warning" role="status">${badge("재시작 준비 중", "is-warning")}<span>${
						holding.length === 0
							? "남은 도구 실행·승인이 끝나면 재시작합니다."
							: `진행 중인 턴 ${holding.length}개가 끝나면 재시작합니다 (가장 오래된 턴 경과 ${dur(oldest)}).`
					} 그동안 들어온 요청은 재시작 뒤 처리됩니다.</span></p>`
				: "";
			// One card per conversation (chat thread = omp session), laid out like the inbox.
			const openThreads = turns.threads.filter((thread) => thread.column === "working").length;
			// Every number in the head says what it counts: open threads match the 진행 중 column, jobs link to their block.
			const bg = runningJobs > 0 ? ` · <a href="#jobs">백그라운드 작업 <b>${runningJobs}</b></a>` : "";
			const title = head("턴", undefined, `<span class="view-sum">진행 중 스레드 <b>${openThreads}</b>${bg}</span>`);
			// No thread but live jobs: the jobs stand in for the empty board.
			if (turns.threads.length === 0) {
				return liveJobs.length > 0
					? `${title}${banners.join("")}${drainLine}${jobTop}${jobDone}`
					: `${title}${banners.join("")}${drainLine}${jobTop}<div class="empty-box"><p class="note">최근 24시간 턴이 없어요</p><p class="note-sub">채팅 대화나 모니터에서 새 턴이 시작되면 실시간으로 표시됩니다.</p></div>${jobDone}`;
			}
			type ThreadCol = "attention" | "working" | "done";
			const THREAD_RANK: Record<ThreadCol, number> = { attention: 0, working: 1, done: 2 };
			const threads = turns.threads.filter((thread) =>
				hit(thread.title, thread.latest.preview, thread.originKey, thread.threadRef, ...(thread.jobs ?? [])),
			);
			const restartHeld = new Set(holding.map((turn) => turn.originKey));
			const placeOf = (key: string): string => {
				// Any platform's owner DM (`<platform>/dm/<id>`); this runs in the browser, so no parseChatOrigin here.
				if (/^([^/:]+:)?[a-z]+\/dm\//.test(key)) return "DM";
				const channel = /^(?:[^/:]+:)?(slack|discord)\/ch\/([^/]+)(\/t\/[^/]+)?$/.exec(key);
				if (channel !== null) {
					const id = `${channel[1] === "discord" ? "Discord " : ""}${channel[2] ?? ""}`;
					return channel[3] === undefined ? `${id} 채널 메인` : id;
				}
				return key.startsWith("monitor/") ? "" : key;
			};
			const threadLink = (key: string): string =>
				`href="?view=turns&amp;item=${esc(encodeURIComponent(key))}" data-item="${esc(key)}"`;
			const jobByName = new Map((s.jobs.ok ? s.jobs.items : []).map((job) => [job.name, job]));
			const threadJobBadge = (thread: (typeof threads)[number]): string => {
				const names = thread.jobs ?? [];
				if (names.length === 0) return "";
				const sorted = names.slice().sort((a, b) => {
					const ja = jobByName.get(a);
					const jb = jobByName.get(b);
					if (ja === undefined && jb === undefined) return 0;
					if (ja === undefined) return 1;
					if (jb === undefined) return -1;
					return msOf(jb.updatedAt) - msOf(ja.updatedAt);
				});
				const target = `job:${sorted[0]}`;
				return `<a class="badge is-info card-job" href="?view=turns&amp;item=${esc(
					encodeURIComponent(target),
				)}" data-item="${esc(target)}" title="${esc(sorted.join(", "))}">백그라운드 작업 ${names.length}</a>`;
			};
			const threadBadges = (thread: (typeof threads)[number]): string =>
				[
					state(thread.latest.state),
					...(thread.stalledCount > 0 ? [badge("정체", "is-warning")] : []),
					...(restartHeld.has(thread.originKey) ? [badge("재시작이 기다리는 턴", "is-warning")] : []),
					...(thread.jobs && thread.jobs.length > 0 ? [threadJobBadge(thread)] : []),
					...overlapOf(thread.originKey),
				].join("");
			const byRecent = (a: (typeof threads)[number], b: (typeof threads)[number]): number =>
				THREAD_RANK[a.column] - THREAD_RANK[b.column] || msOf(b.updatedAt) - msOf(a.updatedAt);
			/** The session's model (provider cut) and thinking; a fallback model in the warning tone. Nothing when unknown. */
			const modelChip = (model: (typeof threads)[number]["model"]): string => {
				if (model === undefined) return "";
				const name = model.model.slice(model.model.lastIndexOf("/") + 1);
				const text = model.thinking === null ? name : `${name} · ${model.thinking}`;
				return `<span class="badge model-chip${model.fallback ? " is-warning" : ""}" title="${esc(model.model)}">${
					model.fallback ? "폴백 · " : ""
				}${esc(text)}</span>`;
			};
			const threadCard = (thread: (typeof threads)[number]): string => {
				const key = thread.originKey;
				const place = placeOf(key);
				const latest = thread.latest;
				const sum = [
					latest.preview !== null && latest.preview !== thread.title ? `<span>${esc(latest.preview)}</span>` : "",
					latest.waitReason === null
						? ""
						: `<span class="card-wait">${esc(TURN_LABELS.wait[latest.waitReason])}</span>`,
				]
					.filter((part) => part !== "")
					.join(" · ");
				// One open turn is already the state badge; more rows say whether they are one run or a queue.
				const meta = [`턴 ${thread.turnCount}`, ...(thread.openCount > 1 ? [openTurnsText(thread)] : [])];
				return `<article class="card card-thread${isSel(key) ? " is-selected" : ""}"${agyTitle(key)} data-state="${esc(
					`${thread.column}:${latest.state}`,
				)}" data-row="${esc(key)}"><a class="card-link" data-row-link ${threadLink(key)}${
					isSel(key) ? ' aria-current="true"' : ""
				}><p class="card-eyebrow"><span>${esc(TURN_LABELS.kind[thread.kind])}</span>${
					place === "" ? "" : ` · <span>${esc(place)}</span>`
				}</p><p class="card-title">${esc(thread.title)}</p>${
					sum === "" ? "" : `<p class="card-sum">${sum}</p>`
				}</a><div class="card-foot"><span class="badges">${threadBadges(
					thread,
				)}</span><span class="card-time">${ago(msOf(thread.updatedAt))}</span><span class="card-meta">${meta
					.map((part) => `<span>${esc(part)}</span>`)
					.join("")}${modelChip(thread.model)}${contextBar(thread.context)}</span></div></article>`;
			};
			const lead = `${banners.join("")}${drainLine}${threads.length === 0 ? nothing : ""}`;
			if (ui.layout === "list") {
				const TURN_SORTS: Array<[string, string]> = [
					["state", "상태"],
					["title", "제목"],
					["kind", "종류"],
					["turns", "턴 수"],
					["age", "경과"],
					["updated", "갱신"],
				];
				const key = TURN_SORTS.some(([id]) => id === ui.sort) ? (ui.sort as string) : "state";
				const flip = ui.desc === true ? -1 : 1;
				const value = (thread: (typeof threads)[number]): string | number =>
					key === "title"
						? thread.title
						: key === "kind"
							? TURN_LABELS.kind[thread.kind]
							: key === "turns"
								? thread.turnCount
								: key === "age"
									? thread.latest.ageMs
									: key === "updated"
										? clock - msOf(thread.updatedAt)
										: THREAD_RANK[thread.column];
				const sorted = threads.slice().sort((a, b) => {
					const x = value(a);
					const y = value(b);
					const order =
						typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ko");
					return order === 0 ? byRecent(a, b) : order * flip;
				});
				const heads = TURN_SORTS.map(([id, label]) => {
					const active = id === key;
					const sort = active ? (flip === 1 ? "ascending" : "descending") : "none";
					return `<th scope="col" aria-sort="${sort}"><button type="button" data-sort="${id}">${esc(label)}${
						active ? `<span aria-hidden="true"> ${flip === 1 ? "↑" : "↓"}</span>` : ""
					}</button></th>`;
				}).join("");
				const body = sorted
					.map(
						(thread) =>
							`<tr data-row="${esc(thread.originKey)}" data-state="${esc(`${thread.column}:${thread.latest.state}`)}"${
								isSel(thread.originKey) ? ' class="is-selected"' : ""
							}><td><span class="badges">${threadBadges(thread)}</span></td><td class="list-title"><a data-row-link ${threadLink(
								thread.originKey,
							)}${isSel(thread.originKey) ? ' aria-current="true"' : ""}>${esc(thread.title)}</a></td><td>${esc(
								TURN_LABELS.kind[thread.kind],
							)}</td><td class="num">${thread.turnCount}</td><td class="num">${dur(thread.latest.ageMs)}</td><td class="num">${ago(
								msOf(thread.updatedAt),
							)}</td></tr>`,
					)
					.join("");
				return `${title}${lead}${jobTop}${
					sorted.length === 0
						? ""
						: `<table class="list"><thead><tr>${heads}</tr></thead><tbody>${body}</tbody></table>`
				}${jobDone}`;
			}
			const TURN_COLS: Array<[ThreadCol, string, string, string]> = [
				["attention", "확인 필요", "확인할 스레드가 없어요", "멈췄거나 실패로 끝난 스레드가 생기면 여기에 모입니다."],
				[
					"working",
					"진행 중",
					"진행 중인 턴이 없어요",
					"채팅 대화나 모니터에서 새 턴이 시작되면 실시간으로 표시됩니다.",
				],
				["done", "완료", "끝난 스레드가 없어요", "턴이 끝난 스레드는 마지막 활동 뒤 24시간 동안 여기에 남습니다."],
			];
			const chips = TURN_COLS.map(
				([id, label]) =>
					`<a class="chip" href="#col-${id}">${esc(label)} <b>${threads.filter((thread) => thread.column === id).length}</b></a>`,
			).join("");
			const columns = TURN_COLS.map(([id, label, none, hint]) => {
				const cards = threads.filter((thread) => thread.column === id).sort(byRecent);
				const body =
					cards.length === 0
						? `<div class="col-empty-wrap"><p class="col-empty">${esc(none)}</p><p class="col-empty-sub">${esc(hint)}</p></div>`
						: cards.map(threadCard).join("");
				return `<section class="col" id="col-${id}" aria-label="${esc(label)}"${cards.length === 0 ? " data-empty" : ""}><h2 class="col-head"><span>${esc(
					label,
				)}</span><span class="count-chip">${cards.length}</span></h2>${body}</section>`;
			}).join("");
			if (q !== "" && threads.length === 0) {
				return `${title}${lead}${jobTop}${jobDone}`;
			}
			return `${title}${lead}${jobTop}<nav class="col-chips" aria-label="열로 이동">${chips}</nav><div class="inbox">${columns}</div>${jobDone}`;
		}
		if (view === "flow") {
			const flows = s.flows;
			if (flows === undefined || !flows.ok) {
				return `${head("흐름", undefined)}${banners.join("")}${failed(flows?.error ?? "이 스냅샷에는 흐름이 없어요")}`;
			}
			const shown = flows.items.filter((chain) =>
				hit(chain.title, chain.place, ...chain.tasks.flatMap((step) => [step.taskId, step.title, step.branch])),
			);
			const cards = shown.map((chain) => {
				const first = chain.tasks[0]?.createdAt;
				return `<section class="flow-card${chain.here === null ? " is-closed" : ""}" data-thread="${esc(
					chain.threadRef,
				)}"><h2 class="flow-title"><span>${esc(chain.title)}</span><small>${chain.done}/${chain.total} 끝남</small></h2><p class="flow-meta">${esc(
					[`TASK ${chain.total}개`, `${at(first)} ~ ${at(chain.updatedAt)}`, chain.place ?? ""]
						.filter((part) => part !== "")
						.join(" · "),
				)}</p>${renderFlowChain(chain, selected, false)}</section>`;
			});
			const lead =
				'<p class="lead flow-lead">요청 하나가 어떤 TASK를 거쳐 끝나는지 보여 줘요. 시간이 겹쳐 같이 돈 TASK는 한 묶음 상자에 쌓이고, 묶음 사이 노란 알약은 다음 묶음까지 기다린 시간이에요. 노란 테두리 상자가 다음에 풀 고리예요. 상자를 누르면 오른쪽에 TASK 상세가 열려요.</p>';
			return `${head("흐름", flows.items.length)}${banners.join("")}${lead}${
				cards.length === 0
					? flows.items.length > 0
						? nothing
						: '<div class="empty-box"><p class="note">최근 7일 안에 TASK가 있는 요청이 없어요</p><p class="note-sub">요청이 TASK로 등록되면 여기에 고리로 표시됩니다.</p></div>'
					: `<div class="flow-list">${cards.join("")}</div>`
			}`;
		}
		if (view === "lanes") {
			const lanes = s.lanes;
			if (!lanes.ok) return `${head("레인", undefined)}${banners.join("")}${failed(lanes.error)}`;
			const rows = lanes.items
				.filter((lane) => hit(lane.title, lane.name, lane.cwd))
				.map((lane) =>
					row(lane.name, [state(lane.status), ...overlapOf(lane.originKey)], esc(lane.title), [
						`${lane.evidence === undefined ? "" : `<span title="${esc(`진행 증거: ${lane.evidence.file} sha256 ${lane.evidence.sha256}`)}">`}${esc(lane.name)} · 갱신 ${at(lane.updatedAt)}${lane.uncertainCount > 0 ? ` · 보류 ${lane.uncertainCount}건` : ""}${lane.typical === undefined ? "" : ` · 경과 ${Math.floor((lane.elapsedMs ?? 0) / 60_000)}분 · ${typicalNote(lane.elapsedMs ?? 0, lane.typical)}`}${lane.evidence === undefined ? "" : "</span>"}`,
						`<span${agyTitle(lane.originKey)}>${esc(lane.cwd)}</span>`,
					]),
				);
			return listOf(
				"레인",
				rows,
				lanes.items.length,
				"열린 레인이 없어요",
				"채팅에서 '작업: <제목> @<경로>'로 작업 레인을 열면 여기에 표시됩니다.",
			);
		}
		if (view === "approvals") {
			const approvals = s.approvals;
			if (!approvals.ok) return `${head("승인 대기", undefined)}${banners.join("")}${failed(approvals.error)}`;
			const rows = approvals.items
				.filter((item) => hit(item.summary, item.title, item.originKey, ...Object.values(item.detail ?? {})))
				.map((item) => {
					const minutes = Math.ceil(item.remainingMs / 60_000);
					const left =
						item.remainingMs <= 0
							? badge("만료 처리 중", "is-warning")
							: badge(`${minutes}분 남음`, minutes <= 10 ? "is-warning" : "");
					// Row ids (approval id, origin key) stay out of the text: the detail panel keeps them under 내부 정보.
					return row(
						item.approvalId,
						[left, ...(item.detail?.rollback ? [badge("되돌릴 수 없음", "is-warning")] : [])],
						esc(item.title),
						[
							`요청 ${esc(item.createdAt.slice(11, 16))} · 만료 ${esc(item.expiresAt.slice(11, 16))}`,
							item.originLabel === null ? "" : esc(item.originLabel),
						],
					);
				});
			const stats = approvals.stats;
			const settled = stats.approved + stats.denied + stats.expired + stats.replied;
			const lead =
				settled === 0
					? ""
					: `<p class="list-lead">최근 ${stats.days}일 ${[
							`승인 ${stats.approved}`,
							`거절 ${stats.denied}`,
							...(stats.replied > 0 ? [`답장 ${stats.replied}`] : []),
							`만료 ${stats.expired}`,
							...(stats.medianAnswerMs === null ? [] : [`답까지 중앙값 ${monitorTook(stats.medianAnswerMs)}`]),
						]
							.map((text) => `<span>${esc(text)}</span>`)
							.join("")}</p>`;
			const decided = approvals.recent
				.filter((item) => hit(item.summary, item.title, item.originKey, ...Object.values(item.detail ?? {})))
				.map((item) => {
					const [word, tone] = APPROVAL_OUTCOMES[item.status] ?? [item.status, ""];
					return row(item.approvalId, [badge(word, tone)], esc(item.title), [
						`요청 ${at(item.createdAt)}${item.tookMs === null ? "" : ` · ${esc(monitorTook(item.tookMs))} 뒤 ${esc(word)}`}`,
						item.originLabel === null ? "" : esc(item.originLabel),
					]);
				});
			// Questions the deadline answered: read-only rows, the thread link is the only thing to open.
			const auto = s.autoChoices?.ok
				? s.autoChoices.items
						.filter((item) => hit(item.question, item.chosen, item.originKey))
						.map((item) => {
							const href = discordThreadHref(s.discordGuild, item.originKey, item.threadRef);
							const link =
								href === ""
									? ""
									: ` · <a href="${esc(href)}" target="_blank" rel="noopener noreferrer">스레드 보기</a>`;
							return `<div class="row"><div class="row-main"><p class="row-title">${esc(item.question)}</p><p class="row-sub">→ ${esc(item.chosen)}</p><p class="row-sub">${at(item.at)}${link}</p></div></div>`;
						})
				: [];
			return `${listOf(
				"승인 대기",
				rows,
				approvals.items.length,
				"기다리는 승인이 없어요",
				"승인이 필요한 작업이 올라오면 채팅 승인 카드와 함께 여기에 표시됩니다.",
				lead,
			)}${
				decided.length === 0
					? ""
					: `<h2 class="list-section">최근 결정 <span class="count-chip">${decided.length}</span></h2><div class="rows" data-list="decided">${decided.join("")}</div>`
			}${
				auto.length === 0
					? ""
					: `<h2 class="list-section">최근 자동 선택(${s.autoChoices?.ok ? s.autoChoices.days : 7}일) <span class="count-chip">${auto.length}</span></h2><div class="rows" data-list="auto-choices">${auto.join("")}</div>`
			}`;
		}
		if (view === "monitors") {
			const monitors = s.monitors;
			if (!monitors.ok) return `${head("모니터", undefined)}${banners.join("")}${failed(monitors.error)}`;
			// Groups by the day of the next fire against the snapshot's own day; both are written in the snapshot's zone
			// (`s.timezone`), so the calendar date after `today` is plain date arithmetic, whatever the offset or DST.
			const generated = Date.parse(s.generatedAt);
			const today = s.generatedAt.slice(0, 10);
			const [year = 0, month = 1, day = 1] = today.split("-").map(Number);
			const tomorrow = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
			const dayOf = (monitor: MonitorInfo): string => {
				const day = monitor.nextFireAt?.slice(0, 10);
				return day === undefined ? "none" : day === today ? "today" : day === tomorrow ? "tomorrow" : "later";
			};
			const GROUPS: Array<[string, string]> = [
				["today", `오늘 ${today.slice(5)}`],
				["tomorrow", `내일 ${tomorrow.slice(5)}`],
				["later", "그 뒤"],
				["none", "예정 없음"],
			];
			const stageOf = (stage: string): [string, string] => MONITOR_STAGES[stage] ?? [stage || "?", ""];
			/** One of the 7 run dots, never by colour alone: its time and result are its label. */
			const dot = (event: MonitorInfo["recent"][number] | undefined): string => {
				if (event === undefined) {
					return '<span class="mon-dot is-empty" role="img" title="기록 없음" aria-label="기록 없음"></span>';
				}
				const [word, tone] = stageOf(event.stage);
				const label = `${at(event.at)} ${esc(word)}${event.manual ? " · 수동" : ""}`;
				return `<span class="mon-dot ${tone}${event.manual ? " is-manual" : ""}" role="img" title="${label}" aria-label="${label}"></span>`;
			};
			const lastLines = (monitor: MonitorInfo): string[] => {
				const run = monitor.lastRun;
				if (run === null) return ["정기 실행 아직 없음"];
				const took =
					run.durationMs === null
						? `진행 중 · 시작 후 ${dur(generated - Date.parse(run.slotAt))}`
						: `${esc(stageOf(run.stage)[0])} ${at(run.at)} · ${
								run.attempts > 0
									? `재시도 ${run.attempts}회 · 지연 포함 ${monitorTook(run.durationMs)}`
									: monitorTook(run.durationMs)
							}`;
				return [`${took}${run.manual ? " · 수동" : ""}`, ...(monitor.scheduledRun ? [] : ["정기 실행 아직 없음"])];
			};
			const monitorRow = (monitor: MonitorInfo): string => {
				const id = monitor.id;
				const selected = isSel(id) || isSel(monitor.name);
				const chips = [
					`→ ${monitor.destination}`,
					...(monitor.copyTo === null ? [] : [`+ 사본 ${monitor.copyTo}`]),
					monitor.deliver === "verbatim" ? "턴 없음" : (monitor.model?.split("/").pop() ?? "기본 모델"),
					...monitor.files.map((file) => `${file.kind === "procedure" ? "절차" : "스크립트"} ${file.name}`),
				]
					.map((text) => `<span class="mon-chip">${esc(text)}</span>`)
					.join("");
				const health = [
					...(monitor.running ? [badge("실행 중", "is-info")] : []),
					...(monitor.failStreak > 0
						? [badge(monitor.failStreak > 1 ? `연속 실패 ${monitor.failStreak}회` : "최근 실패", "is-danger")]
						: []),
					...(monitor.openIncidents > 0 ? [badge(`사건 ${monitor.openIncidents}`, "is-danger")] : []),
				];
				// Oldest on the left, empty slots before the first event.
				const dots = [
					...Array.from({ length: Math.max(0, 7 - monitor.recent.length) }, () => dot(undefined)),
					...monitor.recent.map(dot),
				].join("");
				return `<a class="row mon-row${selected ? " is-selected" : ""}" href="?view=monitors&amp;item=${esc(
					encodeURIComponent(id),
				)}" data-item="${esc(id)}" data-row="${esc(id)}" data-state="${esc(monitor.lastStage ?? "")}"${
					selected ? ' aria-current="true"' : ""
				}><div class="mon-when"><span class="mon-time">${
					monitor.nextFireAt === null ? "-" : esc(monitor.nextFireAt.slice(11, 16))
				}</span><span class="mon-sched">${esc(monitor.schedule)}</span></div><div class="row-main"><p class="row-title">${esc(
					monitor.name,
				)}</p><p class="row-sub">${esc(monitor.summary)}</p><p class="mon-chips">${chips}</p>${
					health.length === 0 ? "" : `<div class="badges">${health.join("")}</div>`
				}</div><div class="mon-side"><span class="mon-dots">${dots}</span>${lastLines(monitor)
					.map((line) => `<span class="mon-last">${line}</span>`)
					.join("")}</div></a>`;
			};
			const shown = monitors.items.filter((monitor) =>
				hit(
					monitor.name,
					monitor.summary,
					monitor.destination,
					monitor.copyTo,
					monitor.schedule,
					monitor.deliver === "verbatim" ? "턴 없음" : (monitor.model ?? "기본 모델"),
					...monitor.files.map((file) => file.name),
				),
			);
			// The whole list in one line: what is still due today and how the last runs ended.
			const sum = (pick: (monitor: MonitorInfo) => number): number =>
				monitors.items.reduce((total, monitor) => total + pick(monitor), 0);
			const failedRuns = sum((monitor) => monitor.stats.failed);
			const skippedRuns = sum((monitor) => monitor.stats.skipped);
			const peerLead = (monitors.peerErrors ?? [])
				.map(
					(peer) =>
						`<div class="notice is-danger">${badge("읽기 실패", "is-danger")}<span>${esc(
							`${peer.install} 모니터를 읽지 못함(${peer.error})`,
						)}</span></div>`,
				)
				.join("");
			const lead =
				peerLead +
				(monitors.items.length === 0
					? ""
					: `<p class="list-lead">${[
							`오늘 남은 실행 ${monitors.items.filter((monitor) => dayOf(monitor) === "today").length}`,
							`최근 ${monitors.items[0]?.stats.days ?? 0}일 전달 ${sum((monitor) => monitor.stats.delivered)}`,
							`조용히 끝남 ${sum((monitor) => monitor.stats.quiet)}`,
							...(skippedRuns > 0 ? [`건너뜀 ${skippedRuns}`] : []),
						]
							.map((text) => `<span>${esc(text)}</span>`)
							.join("")}<span${failedRuns > 0 ? ' class="is-danger"' : ""}>실패 ${failedRuns}</span>${
							monitors.items.some((monitor) => monitor.running) ? "<span>지금 실행 중 있음</span>" : ""
						}</p>`);
			const rows = GROUPS.flatMap(([key, label]) => {
				const group = shown.filter((monitor) => dayOf(monitor) === key);
				return group.length === 0
					? []
					: [
							`<h3 class="mon-group">${esc(label)} <span class="count-chip">${group.length}</span></h3>`,
							...group.map(monitorRow),
						];
			});
			return listOf(
				"모니터",
				rows,
				monitors.items.length,
				"켜진 모니터가 없어요",
				"jabbu-pocket monitors add로 등록한 정기·조건 모니터가 여기에 표시됩니다.",
				lead,
			);
		}
		if (view === "alerts") {
			const alerts = s.alerts;
			if (!alerts.ok) return `${head("알림", undefined)}${banners.join("")}${failed(alerts.error)}`;
			// Open gates first, then the most recent; a closed gate's row is a record the daemon has not cleared yet.
			const rows = alerts.items
				.slice()
				.sort(
					(a, b) => Number(b.gateState === "open") - Number(a.gateState === "open") || msOf(b.lastAt) - msOf(a.lastAt),
				)
				.map((alert) => ({ alert, text: alertText(alert.scope) }))
				.filter(({ alert, text }) => hit(text.title, alert.scope, alert.signature))
				.map(({ alert, text }) => {
					const [word, tone] =
						alert.gateState === "open"
							? ["지금 열림", "is-danger"]
							: alert.gateState === "closed"
								? ["지금은 닫힘 · 기록만 남음", ""]
								: alert.gateState === "unknown"
									? ["상태 모름", "is-warning"]
									: ["기록만 남음", ""];
					return row(String(alert.incidentId), [badge(word, tone), badge(`${alert.count}회`, "")], esc(text.title), [
						`처음 ${at(alert.firstAt)} · 마지막 ${at(alert.lastAt)} · 지속 ${dur(msOf(alert.lastAt) - msOf(alert.firstAt))}`,
						`할 일: ${cmd(text.todo)}`,
					]);
				});
			if (alerts.items.length > 0 && !alerts.items.some((alert) => alert.gateState === "open")) {
				banners.push(
					`<p class="notice" role="status">${badge("안내", "")}<span>지금 열린 알림은 없습니다. 아래는 아직 정리되지 않은 기록입니다.</span></p>`,
				);
			}
			const lines = s.overlaps?.lines ?? [];
			return listOf(
				"알림",
				[...lines.filter((line) => hit(line)).map(overlapRow), ...rows],
				alerts.items.length + lines.length,
				"열린 알림이 없어요",
				"데몬이나 모니터에서 반복 실패 인시던트가 발생하면 여기에 모입니다.",
			);
		}
		// system: one card per area, each headed by a dot and a word (정상/주의/문제) so colour is never alone.
		const facts = (rows: Array<[string, string]>): string =>
			`<dl class="facts">${rows.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${value}</dd>`).join("")}</dl>`;
		const LEVELS: Record<string, [string, string]> = {
			ok: ["정상", "is-success"],
			warn: ["주의", "is-warning"],
			bad: ["문제", "is-danger"],
		};
		const cards: string[] = [];
		const pushCard = (
			id: string,
			title: string,
			level: string,
			body: string,
			wide = false,
			link?: { href: string; text: string },
		): void => {
			const [word, tone] = LEVELS[level] ?? ["?", ""];
			if (!hit(id, title, word, body.replace(/<[^>]*>/g, " "))) return;
			const anchor =
				link === undefined
					? ""
					: `<a class="sys-link" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">${esc(link.text)}</a>`;
			cards.push(
				`<section class="sys-card${wide ? " is-wide" : ""}" data-card="${id}" aria-label="${esc(title)}"><header class="sys-head"><span class="sys-dot ${tone}" aria-hidden="true"></span><h3 class="h3">${esc(
					title,
				)}</h3>${anchor}${badge(word, tone)}</header>${body}</section>`,
			);
		};
		const note = (text: string): string => `<p class="note">${esc(text)}</p>`;
		const noDaemon = note(d.ok ? "" : `데몬 상태를 읽지 못했어요: ${d.error}`);

		if (!d.ok) pushCard("daemon", "데몬", "bad", noDaemon);
		else {
			pushCard(
				"daemon",
				"데몬",
				!d.running ? "bad" : d.frozen || d.drain || d.heartbeat?.draining ? "warn" : "ok",
				facts([
					["상태", d.running ? "켜짐" : "꺼짐 · DB에서 읽음"],
					["시작 뒤", d.started ? `${dur(d.started.ageMs)} · ${at(d.started.at)}부터` : "-"],
					["커밋", d.commit ? `<code>${esc(d.commit)}</code>` : "-"],
					["omp", esc(d.ompVersion)],
					["대화", `${d.origins}개 중 ${d.busy}개 작업 중`],
					["동결", d.frozen ? `${esc(d.frozen.reason || "-")} · ${esc(d.frozen.since)}부터` : "아님"],
					[
						"drain",
						d.drain
							? `턴 ${d.drain.turns} · 도구 ${d.drain.hostTools} · 승인 ${d.drain.approvals}`
							: d.heartbeat?.draining
								? "진행 중"
								: "아님",
					],
				]),
			);
		}

		// Only an install with Discord on records its gateway in the heartbeat; without it there is no card.
		const gateway = d.ok ? d.heartbeat?.discord : undefined;
		if (gateway !== undefined) {
			pushCard(
				"discord",
				"Discord",
				gateway.state === "up" ? "ok" : "bad",
				facts([
					["게이트웨이", gateway.state === "up" ? "연결" : "끊김"],
					["그 뒤", `${dur(clock - msOf(gateway.since))} · ${at(gateway.since)}부터`],
				]),
			);
		}

		const beat = d.ok ? d.heartbeat : undefined;
		if (!d.ok) pushCard("sweep", "스윕·하트비트", "warn", noDaemon);
		else if (beat === undefined) pushCard("sweep", "스윕·하트비트", "warn", note("하트비트 기록이 아직 없어요."));
		else {
			pushCard(
				"sweep",
				"스윕·하트비트",
				beat.ageMs > GATE_LIMITS.sweepStalledMs ? "warn" : "ok",
				facts([
					["나이", `${dur(beat.ageMs)} 전 · ${at(beat.at)}`],
					["loop", beat.loopMs === undefined ? "-" : `${beat.loopMs}ms`],
					["기준", `${dur(GATE_LIMITS.sweepStalledMs)} 넘으면 주의`],
				]),
			);
		}

		if (!d.ok) pushCard("ledger", "전달 장부", "warn", noDaemon);
		else {
			pushCard(
				"ledger",
				"전달 장부",
				d.ledger.ambiguous + d.ledger.expired > 0 ? "warn" : "ok",
				facts([
					["대기", String(d.ledger.pending)],
					["보내는 중", String(d.ledger.inflight)],
					["확인", String(d.ledger.confirmed)],
					["모호", String(d.ledger.ambiguous)],
					["만료", String(d.ledger.expired)],
				]),
			);
		}

		const backup = s.backup;
		if (!backup.ok) pushCard("backup", "백업", "bad", note(backup.error));
		else {
			const max = GATE_LIMITS.backupMaxAgeMs;
			const stale = (age: { ageMs: number } | null | undefined): boolean =>
				age === undefined || (age !== null && age.ageMs > max);
			const stamped = (age: { at: string; ageMs: number } | undefined, none: string): string =>
				age === undefined
					? none
					: `${at(age.at)} · ${dur(age.ageMs)} 전${age.ageMs > max ? ` ${badge("오래됨", "is-warning")}` : ""}`;
			pushCard(
				"backup",
				"백업",
				backup.local === undefined ? "bad" : stale(backup.local) || stale(backup.offsite) ? "warn" : "ok",
				facts([
					["로컬", stamped(backup.local, badge("기록 없음", "is-danger"))],
					[
						"오프사이트",
						backup.offsite === null ? "설정 안 됨" : stamped(backup.offsite, badge("기록 없음", "is-warning")),
					],
					["기준", `${Math.round(max / 3_600_000)}시간 안에 한 번`],
				]),
			);
		}

		if (s.costLedger) pushCard("cost", "7일 비용", s.costLedger.ok ? "ok" : "warn", costCardBody(s.costLedger));

		const gates = s.gates;
		if (!gates.ok) pushCard("gates", "게이트", "bad", note(`게이트를 읽지 못했어요: ${gates.error}`), true);
		else {
			const filteredGates = gates.items
				.slice()
				.sort((a, b) => Number(b.state === "open") - Number(a.state === "open"))
				.filter((gate) =>
					hit(
						"gates",
						"게이트",
						gate.name,
						gateText(gate.name).label,
						gate.detail,
						gate.state === "open" ? "열림" : "닫힘",
					),
				);
			const lines = filteredGates.map((gate) => {
				const open = gate.state === "open";
				return `<li class="gate-row${open ? " is-open" : ""}" data-gate="${esc(gate.name)}" data-state="${esc(
					gate.state,
				)}"><span class="sys-dot ${open ? "is-warning" : "is-success"}" aria-hidden="true"></span><span class="gate-word">${
					open ? "열림" : "닫힘"
				}</span><span class="gate-label">${esc(gateText(gate.name).label)}</span><code class="gate-detail">${esc(
					gate.detail,
				)}</code></li>`;
			});
			if (lines.length > 0 || q === "") {
				pushCard(
					"gates",
					`게이트 ${gates.items.length}개`,
					gates.items.some((gate) => gate.state === "open") ? "warn" : "ok",
					`<ul class="gate-list">${lines.join("")}</ul>`,
					true,
				);
			}
		}

		const peerMonitors = s.monitors.ok ? s.monitors.items.filter((monitor) => monitor.install !== undefined).length : 0;
		const monitorCount = d.ok ? d.monitors.count : s.monitors.ok ? s.monitors.items.length - peerMonitors : 0;
		const troubled = s.monitors.ok
			? s.monitors.items.filter((monitor) => monitor.openIncidents > 0 || monitor.failStreak > 0).length
			: 0;
		const herdr = s.herdr;
		const hosts = herdr.ok ? herdr.hosts.filter((host) => host.ok || host.error !== "herdr is not configured") : [];
		const machines =
			live !== undefined
				? live.machines
						.map((machine) =>
							badge(
								`${machine.name}${machine.connected ? " · 연결" : " · 끊김"}`,
								machine.connected ? "" : "is-danger",
							),
						)
						.join(" ") || "머신 없음"
				: board !== undefined
					? badge("보드 연결 안 됨", "is-danger")
					: !herdr.ok
						? badge("읽기 실패", "is-danger")
						: hosts.length === 0
							? "herdr 설정 없음"
							: hosts
									.map((host) =>
										badge(
											host.ok ? `${host.host} · 에이전트 ${host.agents.length}` : `${host.host} · 연결 실패`,
											host.ok ? "" : "is-danger",
										),
									)
									.join(" ");
		const herdrDown =
			(board !== undefined && !board.ok) ||
			live?.machines.some((machine) => !machine.connected) === true ||
			!herdr.ok ||
			hosts.some((host) => !host.ok);
		pushCard(
			"monitors",
			"모니터·herdr 머신",
			herdrDown || troubled > 0 || !s.monitors.ok ? "warn" : "ok",
			facts([
				[
					"모니터",
					`${monitorCount}개${peerMonitors > 0 ? `(+피어 ${peerMonitors})` : ""}${troubled > 0 ? ` · 사건 ${troubled}` : ""}`,
				],
				["herdr 머신", machines],
			]),
		);

		// Other hosts' ops-check results (config `dashboard.opsStatus`): not a gate, alert or menu count.
		const checks = s.hostChecks;
		if (checks !== undefined) {
			const link = s.hostChecksUrl === undefined ? undefined : { href: s.hostChecksUrl, text: "전체 보기" };
			if (!checks.ok) {
				pushCard("hosts", "호스트 점검", "bad", note(`호스트 점검을 읽지 못했어요: ${checks.error}`), true, link);
			} else {
				const rows: Array<[string, string]> = [];
				const lines: string[] = [];
				const line = (key: string, state: string, tone: string, word: string, label: string, detail: string) =>
					`<li class="gate-row is-open" data-check="${esc(key)}" data-state="${esc(state)}"><span class="sys-dot ${tone}" aria-hidden="true"></span><span class="gate-word">${word}</span><span class="gate-label">${esc(
						label,
					)}</span><code class="gate-detail">${esc(detail)}</code></li>`;
				for (const host of checks.hosts) {
					const age = host.reportAgeMs === null ? "보고 없음" : `${dur(host.reportAgeMs)} 전`;
					const repo = host.repoCounts === undefined ? undefined : repoCountsText(host.repoCounts);
					const repoShown = repo !== undefined && host.issues.some((issue) => issue.detail === repo);
					rows.push([
						host.label,
						host.online
							? [
									`정상 ${host.okCount}/${host.total}`,
									age,
									...(host.skipped > 0 ? [`건너뜀 ${host.skipped}`] : []),
									...(repo === undefined || repoShown ? [] : [`저장소 ${repo}`]),
								]
									.map(esc)
									.join(" · ")
							: badge(`보고 끊김 · ${age}`, "is-danger"),
					]);
					const stale = host.online ? [] : host.issues.filter((issue) => issue.state === "stale");
					for (const issue of host.issues) {
						if (stale.includes(issue)) continue;
						const alert = issue.state === "fail" && issue.severity === "alert";
						const word = issue.severity === "alert" ? "❌" : issue.severity === "notice" ? "🆕" : "ℹ";
						lines.push(
							line(
								`${host.host}:${issue.id}`,
								issue.state,
								alert ? "is-danger" : "is-warning",
								word,
								`${host.label} · ${issue.label}`,
								issue.detail,
							),
						);
					}
					if (stale.length > 0) {
						lines.push(
							line(host.host, "stale", "is-danger", "판정 보류", host.label, `점검 ${stale.length}개 판정 보류`),
						);
					}
				}
				pushCard(
					"hosts",
					"호스트 점검",
					hostChecksLevel(checks),
					`${facts(rows)}${lines.length === 0 ? "" : `<ul class="gate-list">${lines.join("")}</ul>`}`,
					true,
					link,
				);
			}
		}

		return `${head("시스템", undefined)}${banners.join("")}${
			cards.length === 0 ? nothing : `<div class="sys-grid">${cards.join("")}</div>`
		}`;
	};

	// ---- top bar and side navigation ----
	const chips: string[] = [];
	const sessionChip = (s: { count: number | null; ceiling: number }): string =>
		badge(
			`세션 ${s.count ?? "?"}${s.ceiling === 0 ? "·상한 끔" : `/${s.ceiling}`}`,
			s.count !== null && s.ceiling > 0 && s.count >= s.ceiling ? "is-warning" : "",
		);
	if (!d.ok) chips.push(badge("데몬 상태 모름", "is-danger"));
	else {
		chips.push(d.running ? badge("데몬 켜짐", "is-success") : badge("데몬 꺼짐", "is-danger"));
		chips.push(
			d.openGates.length === 0
				? badge("게이트 정상", "is-success")
				: badge("", "is-warning", `<span>게이트 ${roll("gate", d.openGates.length, "up")}개 열림</span>`),
		);
		if (d.frozen) chips.push(badge("동결", "is-warning"));
		if (d.drain || d.heartbeat?.draining) chips.push(badge("drain", "is-warning"));
		if (d.hostSessions !== undefined) chips.push(sessionChip(d.hostSessions));
	}
	if (board !== undefined && !board.ok) chips.push(badge("보드 끊김", "is-danger"));
	chips.push(badge(`갱신 ${s.generatedAt.slice(11, 19)}`, ""));

	const count = <T>(section: { ok: true; items: T[] } | { ok: false; error: string }): number =>
		section.ok ? section.items.length : 0;
	const warnOf = (section: { ok: boolean }, warn: boolean): boolean => !section.ok || warn;
	/** Only alerts whose gate is open right now warn; closed-gate records are a grey count. */
	const openAlerts = s.alerts.ok ? s.alerts.items.filter((alert) => alert.gateState === "open").length : 0;
	const NAV: Record<string, [number, boolean]> = {
		// Entries in 진행 중, like the turns item; an entry in 내 차례 lights the warning.
		inbox: [entries.filter((entry) => entry.col === "working").length, !s.tasks.ok || attention.length > 0],
		// Threads in the 진행 중 column, the same number the column shows; a thread in 확인 필요 or a troubled job
		// lights the warning. Running jobs are counted in the view's head, not here.
		turns: [
			s.turns.ok ? s.turns.threads.filter((thread) => thread.column === "working").length : 0,
			warnOf(s.turns, s.turns.ok && s.turns.threads.some((thread) => thread.column === "attention")) ||
				warnOf(s.jobs, s.jobs.ok && s.jobs.items.some((job) => job.health !== "ok")),
		],
		// Requests with an open TASK; a blocked TASK in any of them lights the warning.
		flow: [
			s.flows?.ok ? s.flows.items.filter((chain) => chain.here !== null).length : 0,
			s.flows === undefined ||
				!s.flows.ok ||
				s.flows.items.some((chain) => chain.tasks.some((step) => step.status === "blocked")),
		],
		lanes: [count(s.lanes), !s.lanes.ok],
		approvals: [count(s.approvals), warnOf(s.approvals, count(s.approvals) > 0)],
		monitors: [
			count(s.monitors),
			warnOf(
				s.monitors,
				s.monitors.ok && s.monitors.items.some((monitor) => monitor.openIncidents > 0 || monitor.failStreak > 0),
			),
		],
		// Only open alerts count; closed-gate records stay in the tab's list without a number on the tab.
		alerts: [openAlerts, openAlerts > 0 || !s.alerts.ok],
		system: [d.ok ? d.openGates.length : 0, !d.ok || !d.running || d.openGates.length > 0 || d.frozen !== undefined],
	};
	const nav = VIEWS.map(([id, label]) => {
		const [n, warn] = NAV[id] ?? [0, false];
		const current = id === view || (id === "inbox" && view === "list");
		return `<a class="nav-item" href="${id === "inbox" ? "./" : `?view=${id}`}" data-view="${id}"${
			current ? ' aria-current="page"' : ""
		}><span>${esc(label)}</span>${
			id === "alerts" && n === 0 && !warn ? "" : `<span class="nav-count${warn ? " is-warn" : ""}">${n}</span>`
		}${navIcon(id)}</a>`;
	}).join("");
	const hasLayout = view === "inbox" || view === "list" || view === "turns";
	const layout = view === "list" || (view === "turns" && ui.layout === "list") ? "list" : "board";
	// The turns view switches between its own board and table; inbox and list switch between theirs.
	const [boardHref, listHref] =
		view === "turns" ? ["?view=turns", "?view=turns&amp;layout=list"] : ["./", "?view=list"];
	const layoutSeg = hasLayout
		? `<div class="seg" role="group" aria-label="보기 방식"><a class="seg-item" href="${boardHref}" data-layout="board"${
				layout === "board" ? ' aria-current="true"' : ""
			}>Board</a><a class="seg-item" href="${listHref}" data-layout="list"${layout === "list" ? ' aria-current="true"' : ""}>List</a></div>`
		: "";
	const themeBtn = (mode: string, text: string): string =>
		`<button type="button" class="seg-item" data-theme-set="${mode}" aria-pressed="${theme === mode}">${text}</button>`;
	// Model limits (config `dashboard.usageLimits`) in the top bar: a chip per source with its lowest five-hour and weekly
	// remaining share; hover or focus opens a panel with a tile per source (five-hour and weekly windows only, other
	// windows left out). 20% remaining warns, 5% is danger.
	const limitsPop = (): string => {
		const usage = s.usageLimits;
		if (usage === undefined) return "";
		const wrap = (chips: string, tiles: string): string =>
			`<div class="limits-pop"><button type="button" class="limits-trigger" aria-label="모델 한도 자세히">${chips}</button><div class="limits-panel" role="tooltip">${tiles}</div></div>`;
		if (!usage.ok) {
			return wrap(
				`<span class="limit-chip is-muted"><i class="dot is-muted" aria-hidden="true"></i>한도 ?</span>`,
				`<div class="limit-tile is-failed"><div class="limit-head"><b>모델 한도</b></div><p class="limit-error">읽지 못했어요: ${esc(usage.error)}</p></div>`,
			);
		}
		const parts = usage.sources.map((source) => {
			const headOf = (tone: string): string =>
				`<div class="limit-head"><i class="dot is-${tone}" aria-hidden="true"></i><b>${esc(source.name)}</b>${
					source.account === undefined ? "" : `<span class="limit-acct">${esc(source.account)}</span>`
				}</div>`;
			if (!source.ok) {
				return {
					chip: `<span class="limit-chip is-muted" data-source="${esc(source.name)}"><i class="dot is-muted" aria-hidden="true"></i>${esc(source.name)} ?</span>`,
					tile: `<div class="limit-tile is-failed" data-source="${esc(source.name)}">${headOf("muted")}<p class="limit-error">${esc(source.error)}</p></div>`,
					tone: "muted",
					least: undefined,
				};
			}
			// A row's group: the parenthesised part of an omp label ("Claude 7 Day (Fable)"), the model family of an agy
			// label ("Gemini Models" → "Gemini"), else none; rows keep their group's first place, five-hour first.
			const groupOf = (label: string): string => {
				const paren = /\(([^)]+)\)/.exec(label);
				if (paren) return paren[1] ?? "";
				if (source.name !== "Antigravity") return "";
				return label.replace(/\s+models$/i, "").replace(/\s+and\s+/i, "·");
			};
			const picked = source.rows.filter((row) => row.window !== "other");
			const rows = (picked.length === 0 ? source.rows : picked).map((row) => ({ row, group: groupOf(row.label) }));
			const order = [...new Set(rows.map((r) => r.group))];
			rows.sort(
				(a, b) =>
					order.indexOf(a.group) - order.indexOf(b.group) ||
					(a.row.window === "5h" ? 0 : 1) - (b.row.window === "5h" ? 0 : 1),
			);
			let worst = "ok";
			const lines = rows.map(({ row, group }) => {
				const tone = usageLevel(row.remainingPct);
				if (tone === "danger" || (tone === "warn" && worst === "ok")) worst = tone;
				const win = row.window === "5h" ? "5시간" : row.window === "weekly" ? "주간" : row.windowLabel;
				const left = resetIn(row.resetsAt, clock);
				return `<div class="limit-row is-${tone}" data-window="${row.window}"><span class="limit-name">${esc(
					group === "" ? win : `${group} ${win}`,
				)}</span><span class="meter" role="img" aria-label="남은 ${row.remainingPct}%"><i style="width:${row.remainingPct}%"></i></span><b class="limit-pct">${row.remainingPct}%</b><span class="limit-reset"${
					left === "" ? "" : ` title="${esc(`${left} 뒤 초기화`)}"`
				}>${esc(left)}</span>${trendHtml(row.trend, clock)}</div>`;
			});
			const lowest = (window: string): string => {
				const pcts = rows.filter((r) => r.row.window === window).map((r) => r.row.remainingPct);
				return pcts.length === 0 ? "" : String(Math.min(...pcts));
			};
			const short = lowest("5h");
			const week = lowest("weekly");
			const least = Math.min(...rows.map((r) => r.row.remainingPct));
			// Wide top bars show both windows (`lc-full`), narrower ones only the least remaining share (`lc-min`).
			return {
				chip: `<span class="limit-chip is-${worst}" data-source="${esc(source.name)}"><i class="dot is-${worst}" aria-hidden="true"></i><b>${esc(
					source.name === "Antigravity" ? "AG" : source.name,
				)}</b><span class="lc-full">${short === "" ? "" : `<small>5h</small>${roll(`lim:${source.name}:5h`, short, "down")}`}${
					week === "" ? "" : `<small>주</small>${roll(`lim:${source.name}:week`, week, "down")}`
				}</span><span class="lc-min">${rows.length === 0 ? "" : `${roll(`lim:${source.name}:min`, least, "down")}%`}</span></span>`,
				tile: `<div class="limit-tile is-${worst}" data-source="${esc(source.name)}">${headOf(worst)}${lines.join("")}</div>`,
				tone: worst,
				least: rows.length === 0 ? undefined : least,
			};
		});
		// The narrowest desktop bars show one summary instead of the chips: a dot per source and the least share overall.
		const leasts = parts.flatMap((part) => (part.least === undefined ? [] : [part.least]));
		const tones = parts.map((part) => part.tone);
		const sumTone = tones.includes("danger") ? "danger" : tones.some((tone) => tone !== "ok") ? "warn" : "ok";
		const summary = `<span class="limit-sum limit-chip is-${sumTone}">${tones
			.map((tone) => `<i class="dot is-${tone}" aria-hidden="true"></i>`)
			.join("")}${leasts.length === 0 ? "?" : `${roll("lim:sum", Math.min(...leasts), "down")}%`}</span>`;
		return wrap(parts.map((part) => part.chip).join("") + summary, parts.map((part) => part.tile).join(""));
	};
	// The test chip: hidden with nothing running or queued; the queue opens on click.
	const heavy = s.heavyRun;
	const heavyChip =
		heavy?.ok && (heavy.running !== null || heavy.waiting.length > 0)
			? `<details class="heavy-pop"><summary class="limit-chip" title="전체 테스트(호스트에서 한 번에 하나)">🧪 ${
					heavy.running === null ? "" : `${esc(heavy.running.label)} ${dur(heavy.running.ageMs)} · `
				}대기 ${heavy.waiting.length}</summary><ul class="heavy-list">${
					heavy.waiting.length === 0
						? "<li>대기 없음</li>"
						: heavy.waiting.map((item) => `<li>${esc(item.label)} <b>${dur(item.waitedMs)}</b></li>`).join("")
				}<li class="heavy-note">표시는 대기 시작 순서이고 실제 실행 순서는 보장되지 않습니다.</li></ul></details>`
			: "";
	const topbar = `<header class="topbar"><nav class="crumbs" aria-label="위치"><span>jabbu</span><span aria-hidden="true">/</span><span aria-current="page">${esc(
		viewLabel,
	)}</span></nav><div class="status-chips" aria-label="봇 상태">${chips.join("")}</div>${heavyChip}${limitsPop()}<div class="top-tools">${layoutSeg}<div class="seg" role="group" aria-label="테마">${themeBtn("system", "시스템")}${themeBtn("light", "라이트")}${themeBtn("dark", "다크")}</div><button type="button" class="cmd-trigger" data-cmd-open aria-label="명령 팔레트 열기"><span>명령</span><kbd>⌘K</kbd></button></div></header>`;
	const content = view === "inbox" ? inboxView() : view === "list" ? listView() : sectionView();
	return `${topbar}<nav class="sidenav" aria-label="보기">${nav}</nav><main class="view" id="view" aria-label="${esc(
		viewLabel,
	)}" tabindex="-1">${content}</main>`;
}
