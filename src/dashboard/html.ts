import { formatTypicalRange, typicalNote } from "../store/turn-duration";
import { appAssets, PAGE_CSS } from "./assets";
import type { BoardPanel } from "./board";
import { BOOT_CLIENT } from "./boot-client";
import {
	discordThreadHref,
	renderConversation,
	renderDetailHead,
	renderDetailTabs,
	renderDiffDetail,
	renderFlowChain,
	renderItemDetail,
	renderLiveTurn,
	renderMonitorDetail,
	renderPlan,
	renderTaskDetail,
	renderTaskFacts,
} from "./detail";
import { hostChecksLevel, repoCountsText } from "./host-checks";
import {
	attentionGroup,
	byAttention,
	cardWithSay,
	entrySig,
	faviconHref,
	inboxAttention,
	inboxEntries,
	isStale,
	markSeen,
	orderKeyTarget,
	pruneStore,
	readUnread,
	replyKeyTarget,
	STALE_MS,
	seedStore,
	tabSignal,
	UNREAD_KEEP_MS,
	UNREAD_KEY,
	UNREAD_MAX,
	unreadIds,
	unreadReady,
} from "./inbox";
import { contextBar, costCardBody } from "./load-view";
import { renderDashboardMain } from "./main-view";
import { renderMarkdown } from "./markdown";
import {
	expireStack,
	freshCards,
	freshSteps,
	pillMotion,
	pushStack,
	rollDiff,
	rollEffects,
	rollLabel,
	stackHtml,
} from "./motion";
import type { DashboardSnapshot, FlowChainInfo } from "./snapshot";
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
import { TRACE_CLIENT } from "./trace-client";
import { flowDoing, renderFlow, renderTrace } from "./trace-view";
import { turnOf } from "./turn";
import { resetIn, trendHtml, usageLevel } from "./usage-forecast";

/**
 * Page script (served as `app-<hash>.js`): the renderers above as shipped source, then the page wiring — the 15-second snapshot refresh, the
 * board stream (`api/board/events`, only with a board), view switching (`?view=`), search and List sorting, theme
 * persistence, keyboard navigation (`j`/`k`, `Enter`, `Esc`, `g <key>`, `/`, `?`, `⌘K`/`Ctrl+K`), copy toast, and the
 * detail panel (`?card=`, `?task=`, `?item=` in the address; a card's conversation and plan read through
 * `api/pane/*`). Every request is relative to the page, so any tunnel prefix works.
 */
export const SCRIPT = `const GATE_LIMITS = ${JSON.stringify(GATE_LIMITS)};
const TURN_LABELS = ${JSON.stringify(TURN_LABELS)};
const JOB_LABELS = ${JSON.stringify(JOB_LABELS)};
const MONITOR_STAGES = ${JSON.stringify(MONITOR_STAGES)};
const APPROVAL_OUTCOMES = ${JSON.stringify(APPROVAL_OUTCOMES)};
const esc = ${esc.toString()};
const monitorTook = ${monitorTook.toString()};
const gateText = ${gateText.toString()};
const alertText = ${alertText.toString()};
const openTurnsText = ${openTurnsText.toString()};
const cardWithSay = ${cardWithSay.toString()};
const inboxEntries = ${inboxEntries.toString()};
const STALE_MS = ${STALE_MS};
const isStale = ${isStale.toString()};
const attentionGroup = ${attentionGroup.toString()};
const byAttention = ${byAttention.toString()};
const inboxAttention = ${inboxAttention.toString()};
const turnOf = ${turnOf.toString()};
const faviconHref = ${faviconHref.toString()};
const tabSignal = ${tabSignal.toString()};
const orderKeyTarget = ${orderKeyTarget.toString()};
const replyKeyTarget = ${replyKeyTarget.toString()};
const UNREAD_KEY = ${JSON.stringify(UNREAD_KEY)};
const UNREAD_KEEP_MS = ${JSON.stringify(UNREAD_KEEP_MS)};
const UNREAD_MAX = ${JSON.stringify(UNREAD_MAX)};
const readUnread = ${readUnread.toString()};
const entrySig = ${entrySig.toString()};
const unreadIds = ${unreadIds.toString()};
const unreadReady = ${unreadReady.toString()};
const seedStore = ${seedStore.toString()};
const markSeen = ${markSeen.toString()};
const pruneStore = ${pruneStore.toString()};
const formatTypicalRange = ${formatTypicalRange.toString()};
const typicalNote = ${typicalNote.toString()};
const hostChecksLevel = ${hostChecksLevel.toString()};
const repoCountsText = ${repoCountsText.toString()};
const usageLevel = ${usageLevel.toString()}, resetIn = ${resetIn.toString()}, trendHtml = ${trendHtml.toString()}, contextBar = ${contextBar.toString()}, costCardBody = ${costCardBody.toString()};
const renderDashboardMain = ${renderDashboardMain.toString()};
const renderTaskFacts = ${renderTaskFacts.toString()};
const renderFlowChain = ${renderFlowChain.toString()};
const discordThreadHref = ${discordThreadHref.toString()};
const renderTaskDetail = ${renderTaskDetail.toString()};
const renderDetailHead = ${renderDetailHead.toString()};
const renderItemDetail = ${renderItemDetail.toString()};
const renderMonitorDetail = ${renderMonitorDetail.toString()};
const renderDiffDetail = ${renderDiffDetail.toString()};
const renderDetailTabs = ${renderDetailTabs.toString()};
const renderPlan = ${renderPlan.toString()};
const renderConversation = ${renderConversation.toString()};
const renderLiveTurn = ${renderLiveTurn.toString()};
const rollDiff = ${rollDiff.toString()};
const rollEffects = ${rollEffects.toString()};
const rollLabel = ${rollLabel.toString()};
const freshCards = ${freshCards.toString()};
const pushStack = ${pushStack.toString()};
const expireStack = ${expireStack.toString()};
const stackHtml = ${stackHtml.toString()};
const pillMotion = ${pillMotion.toString()};
const freshSteps = ${freshSteps.toString()};
const renderMarkdown = ${renderMarkdown.toString()};
const renderTrace = ${renderTrace.toString()};
const flowDoing = ${flowDoing.toString()};
const renderFlow = ${renderFlow.toString()};
${TRACE_CLIENT}
${BOOT_CLIENT}`.replace(/<\/script/gi, "<\\/script");

export interface DashboardPageOptions {
	/** The agent board (config has `herdrBoard`); absent = no board stream, TASKs only in the inbox. */
	board?: BoardPanel | undefined;
	/** `?view=` of the request (unknown names fall back to the inbox with a notice). */
	view?: string;
	/** `?card=` of the request: the detail panel starts open on that card. */
	card?: string;
	/** `?task=` of the request: the detail panel starts open on that TASK. */
	task?: string;
	/** `?item=` of the request: the detail panel starts open on that row of the view. */
	item?: string;
	/** `?diff=` of the request (`lane:<name>` or `task:<id>`): the detail panel starts open on that change. */
	diff?: string;
	/** `?layout=` of the request (`list`: the turns view as a table). */
	layout?: string;
	/** `?stale=` of the request (`1`: the inbox and list show 방치 panes only). */
	stale?: string;
}

/** The whole page: first render on the server (readable without JavaScript), then the inline script. */
export function renderDashboardPage(snapshot: DashboardSnapshot, options: DashboardPageOptions = {}): string {
	const { board, view, card, task, item, diff, layout, stale } = options;
	const live = board?.ok === true ? board : undefined;
	const tasks = snapshot.tasks.ok ? snapshot.tasks.items : [];
	const open =
		card !== undefined
			? { kind: "card" as const, id: card }
			: task !== undefined
				? { kind: "task" as const, id: task }
				: item !== undefined
					? { kind: "item" as const, id: item }
					: diff !== undefined
						? { kind: "diff" as const, id: diff }
						: undefined;
	const chainOf = (id: string | undefined): FlowChainInfo | undefined =>
		id === undefined || !snapshot.flows?.ok
			? undefined
			: snapshot.flows.items.find((chain) => chain.tasks.some((step) => step.taskId === id));
	let headHtml = "";
	if (open?.kind === "card") {
		const onBoard = live?.cards.find((entry) => entry.key === open.id);
		const found = onBoard === undefined ? undefined : cardWithSay(snapshot, onBoard);
		const owner = found?.taskId === undefined ? undefined : tasks.find((entry) => entry.taskId === found.taskId);
		headHtml = renderDetailHead(open.id, found, owner, live?.generatedAt ?? 0, chainOf(found?.taskId));
	} else if (open?.kind === "task") {
		const key = live?.cards.find((entry) => entry.taskId === open.id)?.key;
		headHtml = renderTaskDetail(
			open.id,
			tasks.find((entry) => entry.taskId === open.id),
			key,
			chainOf(open.id),
		);
	} else if (open?.kind === "item") {
		headHtml = renderItemDetail(snapshot, view ?? "inbox", open.id);
	} else if (open?.kind === "diff") {
		headHtml = renderDiffDetail(open.id);
	}
	const label =
		open === undefined || open.kind === "card"
			? "카드 상세"
			: open.kind === "task"
				? "TASK 상세"
				: open.kind === "diff"
					? "변경 보기"
					: "항목 상세";
	const turnsList = view === "turns" && layout === "list";
	const back =
		view !== undefined && /^(list|turns|flow|lanes|approvals|monitors|alerts|system)$/.test(view)
			? `?view=${view}${turnsList ? "&amp;layout=list" : ""}`
			: "./";
	// A turn-board conversation: tabs 개요/대화/트레이스, 대화 first; the old one-turn address opens on 트레이스. A job opens on 개요/트레이스.
	const jobDetail = open?.kind === "item" && view === "turns" && open.id.startsWith("job:");
	const thread = open?.kind === "item" && view === "turns" && !open.id.startsWith("job:");
	const oldTurn = thread && /^\d+$/.test(open.id);
	const found =
		thread && snapshot.turns.ok
			? oldTurn
				? snapshot.turns.threads.find((entry) => entry.recent.some((turn) => String(turn.inboundId) === open.id))
				: snapshot.turns.threads.find((entry) => entry.originKey === open.id)
			: undefined;
	const tab = open?.kind === "card" || jobDetail ? "head" : thread ? (oldTurn ? "trace" : "conv") : undefined;
	const discordHref =
		found === undefined ? "" : discordThreadHref(snapshot.discordGuild, found.originKey, found.threadRef);
	const barTitle = /<h2 class="detail-title"[^>]*>([\s\S]*?)<\/h2>/.exec(headHtml)?.[1] ?? "";
	const ui = {
		...(view === undefined ? {} : { view }),
		...(open === undefined ? {} : { selected: found?.originKey ?? open.id }),
		...(turnsList ? { layout: "list" } : {}),
		...(stale === "1" ? { stale: true } : {}),
	};
	const signal = tabSignal(snapshot, board, false);
	return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${signal.title}</title>
<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">
<link rel="icon" id="favicon" href="${signal.favicon}">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#15181D" media="(prefers-color-scheme: dark)">
<link rel="stylesheet" href="${appAssets(SCRIPT, PAGE_CSS).css.name}">
</head>
<body${open === undefined ? "" : tab === "trace" ? ' class="detail-open detail-trace"' : ' class="detail-open"'}>
<div class="shell">
<div id="main" data-board="${board === undefined ? "0" : "1"}">
${renderDashboardMain(snapshot, board, undefined, ui)}
</div>
<div class="search"><input id="search" type="search" placeholder="제목·TASK·머신 검색 ( / )" aria-label="제목·TASK ID·머신 검색" autocomplete="off"></div>
${open === undefined ? `<aside id="detail" class="detail" aria-label="${label}" hidden>` : `<aside id="detail" class="detail is-open" aria-label="${label}">`}
<div class="detail-bar"><span id="detail-bar-title" class="detail-bar-title"${
		tab === undefined || tab === "head" || barTitle === "" ? " hidden" : ""
	}>${barTitle}</span><a id="detail-discord" class="button is-ghost detail-reply" href="${discordHref}"${
		discordHref === "" ? " hidden" : ' target="_blank" rel="noopener noreferrer"'
	}>디스코드에서 답하기</a><a class="detail-close" href="${back}" data-close>닫기 <kbd>Esc</kbd></a></div>
<div id="detail-tabs" class="tabs" role="tablist" aria-label="상세 보기"${tab === undefined ? " hidden" : ""}>${renderDetailTabs(
		thread ? "thread" : jobDetail ? "job" : "card",
		tab ?? "head",
		open?.kind === "card" && live?.cards.some((entry) => entry.key === open.id && entry.local && entry.agent === "omp"),
	)}</div>
<div id="detail-head" role="tabpanel" aria-labelledby="tab-head"${tab === undefined || tab === "head" ? "" : " hidden"}>${headHtml}</div>
<section id="detail-plan" role="tabpanel" aria-labelledby="tab-plan" hidden></section>
<section id="detail-conv" role="tabpanel" aria-labelledby="tab-conv"${tab === "conv" ? "" : " hidden"}></section>
<section id="detail-trace" role="tabpanel" aria-labelledby="tab-trace" aria-label="턴 트레이스" hidden></section>
</aside>
<footer class="hint-bar" aria-label="단축키 안내"><span class="hint-item"><kbd>j</kbd><kbd>k</kbd><span>이동</span></span><span class="hint-item"><kbd>Enter</kbd><span>열기</span></span><span class="hint-item"><kbd>1–9</kbd><span>확인 필요 n번째 열기</span></span><span class="hint-item"><kbd>Esc</kbd><span>닫기</span></span><span class="hint-item"><kbd>/</kbd><span>검색</span></span><span class="hint-item"><kbd>g</kbd><kbd>i</kbd><span>인박스</span></span><span class="hint-item"><kbd>g</kbd><kbd>a</kbd><span>승인</span></span><button type="button" class="hint-btn" data-cmd-open><kbd>⌘K</kbd><span>명령 팔레트</span></button><button type="button" class="hint-btn" data-help-open><kbd>?</kbd><span>도움말</span></button></footer>
</div>
<div id="cmd-palette" class="modal-backdrop" role="dialog" aria-modal="true" aria-label="명령 팔레트" hidden><div class="modal-card"><div class="cmd-head"><input id="cmd-input" type="text" placeholder="보기 전환, TASK ID·카드 이동, 테마 전환…" aria-label="명령 또는 TASK 검색" autocomplete="off"><button type="button" class="detail-close" data-cmd-close>닫기 <kbd>Esc</kbd></button></div><div id="cmd-list" class="cmd-list" role="listbox" aria-label="명령 목록"></div></div></div>
<div id="kb-help" class="modal-backdrop" role="dialog" aria-modal="true" aria-label="단축키 도움말" hidden><div class="modal-card"><div class="help-head"><h2 class="h3">키보드 단축키</h2><button type="button" class="detail-close" data-help-close>닫기 <kbd>Esc</kbd></button></div><div class="help-body"><div class="help-group"><h3 class="h3">목록·상세 탐색</h3><div class="help-row"><span>다음·이전 항목</span><span><kbd>j</kbd> <kbd>k</kbd> / <kbd>↓</kbd> <kbd>↑</kbd></span></div><div class="help-row"><span>상세 열기</span><kbd>Enter</kbd></div><div class="help-row"><span>상세·창 닫기</span><kbd>Esc</kbd></div><div class="help-row"><span>검색창 포커스</span><kbd>/</kbd></div><div class="help-row"><span>확인 필요 n번째 열기</span><span><kbd>1</kbd>–<kbd>9</kbd></span></div><div class="help-row"><span>다음 항목에 답하기(herdr)</span><kbd>r</kbd></div><div class="help-row"><span>명령 팔레트</span><span><kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd></span></div><div class="help-row"><span>단축키 도움말</span><kbd>?</kbd></div></div><div class="help-group"><h3 class="h3">턴 트레이스</h3><div class="help-row"><span>단계 이동</span><span><kbd>↓</kbd> <kbd>↑</kbd> · <kbd>Home</kbd> <kbd>End</kbd></span></div><div class="help-row"><span>펼치기·자식으로</span><kbd>→</kbd></div><div class="help-row"><span>접기·부모로</span><kbd>←</kbd></div><div class="help-row"><span>단계 상세 열고 닫기</span><span><kbd>Enter</kbd> / <kbd>Space</kbd></span></div><div class="help-row"><span>단계 상세 닫기</span><kbd>Esc</kbd></div></div><div class="help-group"><h3 class="h3">보기 바로 이동</h3><div class="help-row"><span>에이전트 인박스 (Board)</span><span><kbd>g</kbd> <kbd>i</kbd></span></div><div class="help-row"><span>에이전트 목록 (List)</span><span><kbd>g</kbd> <kbd>l</kbd></span></div><div class="help-row"><span>진행 중 턴</span><span><kbd>g</kbd> <kbd>t</kbd></span></div><div class="help-row"><span>흐름</span><span><kbd>g</kbd> <kbd>f</kbd></span></div><div class="help-row"><span>레인</span><span><kbd>g</kbd> <kbd>n</kbd></span></div><div class="help-row"><span>승인 대기</span><span><kbd>g</kbd> <kbd>a</kbd></span></div><div class="help-row"><span>모니터 / 알림 / 시스템</span><span><kbd>g</kbd> <kbd>m</kbd> / <kbd>e</kbd> / <kbd>s</kbd></span></div></div></div></div></div>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
<div id="event-stack" class="event-stack" hidden><p id="es-say" class="es-say" aria-live="polite"></p><div id="es-body"></div></div>
<p id="stale" class="stale" role="status" hidden></p>
${board === undefined ? "" : `<script type="application/json" id="board-data">${JSON.stringify(board).replace(/</g, "\\u003c")}</script>\n`}<script src="${appAssets(SCRIPT, PAGE_CSS).js.name}"></script>
</body>
</html>
`;
}
