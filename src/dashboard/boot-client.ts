/**
 * The page wiring of the dashboard's inline script (`SCRIPT` in html.ts): `boot()` and its call. Plain browser
 * JavaScript, shipped as text after the renderers it calls.
 */
export const BOOT_CLIENT = `function boot() {
	const main = document.getElementById("main");
	const stale = document.getElementById("stale");
	const search = document.getElementById("search");
	const detail = document.getElementById("detail");
	const tabs = document.getElementById("detail-tabs");
	const head = document.getElementById("detail-head");
	const plan = document.getElementById("detail-plan");
	const conv = document.getElementById("detail-conv");
	const traceHost = document.getElementById("detail-trace");
	const trace = traceController(traceHost);
	const closer = detail.querySelector("[data-close]");
	const cmdModal = document.getElementById("cmd-palette");
	const cmdInput = document.getElementById("cmd-input");
	const cmdList = document.getElementById("cmd-list");
	const helpModal = document.getElementById("kb-help");
	const toast = document.getElementById("toast");
	const stackEl = document.getElementById("event-stack");
	const stackBody = document.getElementById("es-body");
	const stackSay = document.getElementById("es-say");
	const boardOn = main.getAttribute("data-board") === "1";
	const LABELS = { card: "카드 상세", task: "TASK 상세", item: "항목 상세", diff: "변경 보기" };
	let snapshot = null;
	// The board the server drew the page with, so the first snapshot refresh does not redraw without it.
	const seeded = boardOn ? document.getElementById("board-data") : null;
	let board = seeded && seeded.textContent ? JSON.parse(seeded.textContent) : null;
	const ui = { view: "inbox", q: "", sort: "", desc: false, theme: "system", layout: "", stale: false };
	let open = null;
	let tab = "head";
	// The turn the 트레이스 tab shows when not the thread's last one (a 최근 턴 row, or the old one-turn address).
	let traceTurn = null;
	// Whether the open card's tab strip has the 트레이스 tab (only a local omp worker's does).
	let cardTrace = false;
	// The open thread's updatedAt and last turn as the snapshot last told them: a change reads its conversation again.
	let threadSeen = "";
	// The open monitor's \`api/monitor/detail\` answer as drawn by renderMonitorDetail; null while it is being read.
	let monitorHtml = null;
	// The open lane's or TASK's \`api/diff\` answer as drawn by renderDiffDetail; null while it is being read.
	let diffHtml = null;
	let drawnMain = "";
	let drawnHead = "";
	let loadedKey = null;
	let turns = [];
	let cursor;
	let paged = false;
	let generation = 0;
	// The 대화 tab's live stream (one at a time) and its block: the last view, when it came, and while "확정 중" the
	// ended message kept on screen until a conversation read started after the end (ticket) has drawn it for good.
	let liveSource = null;
	let liveOrigin = null;
	let liveView = null;
	let liveAt = 0;
	let liveKept = null;
	let liveError = "";
	let liveFail = "";
	let drawnLive = "";
	let loadTicket = 0;
	let settleTicket = Infinity;
	let reloading = null;
	let reloadAgain = false;
	let toastTimer = null;
	let chordTimer = null;
	let gPending = false;
	let cmdItems = [];
	let cmdIdx = 0;
	let prevFocus = null;
	const prevStates = new Map();
	const changedUntil = new Map();
	// Cards that newly need the owner or moved column: a 1.6 s ring, once (not on the first draw).
	const ringUntil = new Map();
	// Motion memory, kept here and never read back from the DOM (a rolling digit or a "+n" would pollute it): the header
	// numbers, each inbox card's column, the event stack, and the live steps already shown.
	const reducedMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
	let rollPrev = new Map();
	let rollView = null;
	const rollActive = new Map();
	let colPrev = new Map();
	let stack = [];
	let stackTouched = 0;
	let stackDropped = 0;
	let stackTimer = null;
	let stackDrawn = "";
	const pillUntil = new Map();
	let stepSeen = null;
	let stepFor = "";
	const popUntil = new Map();

	// The inbox read marks live in this browser's localStorage only; a storage that cannot be used turns them off.
	let unreadStore = null;
	try {
		localStorage.getItem(UNREAD_KEY);
		unreadStore = {
			get: () => localStorage.getItem(UNREAD_KEY),
			set: (value) => {
				try {
					localStorage.setItem(UNREAD_KEY, value);
				} catch {
					unreadStore = null;
				}
			},
		};
	} catch {}
	// The entry the read marks last recorded as opened (kind:id), so opening it marks it read once.
	let seenOpen = "";

	const resolveTheme = (mode) => {
		if (mode === "light" || mode === "dark") return mode;
		return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
	};
	const applyTheme = (mode, save) => {
		const valid = mode === "light" || mode === "dark" ? mode : "system";
		ui.theme = valid;
		if (save) {
			try {
				localStorage.setItem("jabbu-theme", valid);
			} catch {}
		}
		document.documentElement.setAttribute("data-theme", resolveTheme(valid));
		document.documentElement.setAttribute("data-theme-mode", valid);
		for (const btn of document.querySelectorAll("[data-theme-set]")) {
			btn.setAttribute("aria-pressed", String(btn.getAttribute("data-theme-set") === valid));
		}
		if (snapshot) drawMain(false);
	};
	try {
		applyTheme(localStorage.getItem("jabbu-theme") || "system", false);
	} catch {
		applyTheme("system", false);
	}
	if (window.matchMedia) {
		window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
			if (ui.theme === "system") applyTheme("system", false);
		});
	}

	const showToast = (text) => {
		if (!toast) return;
		toast.textContent = text;
		toast.hidden = false;
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			toast.hidden = true;
		}, 2200);
	};
	const copyText = async (value, label) => {
		let ok = false;
		if (navigator.clipboard && navigator.clipboard.writeText) {
			try {
				await navigator.clipboard.writeText(value);
				ok = true;
			} catch {}
		}
		if (!ok) {
			try {
				const area = document.createElement("textarea");
				area.value = value;
				area.style.position = "fixed";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				ok = document.execCommand("copy");
				area.remove();
			} catch {}
		}
		showToast((label || "값") + (ok ? " 복사됨: " + value : " 복사 실패"));
	};

	const fromUrl = () => {
		const query = new URLSearchParams(location.search);
		const view = query.get("view") || "inbox";
		const layout = query.get("layout") === "list" ? "list" : "";
		const stale = query.get("stale") === "1";
		for (const kind of ["card", "task", "item", "diff"]) {
			const id = query.get(kind);
			if (id) return { view, layout, stale, open: { kind, id } };
		}
		return { view, layout, stale, open: null };
	};
	const toUrl = (target) => {
		const url = new URL(location.href);
		for (const name of ["view", "layout", "stale", "card", "task", "item", "diff"]) url.searchParams.delete(name);
		if (ui.view !== "inbox") url.searchParams.set("view", ui.view);
		if (ui.view === "turns" && ui.layout === "list") url.searchParams.set("layout", "list");
		if (ui.stale && (ui.view === "inbox" || ui.view === "list")) url.searchParams.set("stale", "1");
		if (target) url.searchParams.set(target.kind, target.id);
		url.hash = "";
		return url;
	};
	const cardOf = (key) => {
		const card = board && board.ok ? board.cards.find((item) => item.key === key) : undefined;
		return card ? cardWithSay(snapshot, card) : undefined;
	};
	/** The open card runs omp on this machine: the only kind with a trace (the server answers the rest 404). */
	const traceableCard = () => {
		const card = !!open && open.kind === "card" ? cardOf(open.id) : undefined;
		return !!card && card.local === true && card.agent === "omp";
	};
	/** A card's tab strip follows its board entry: the 트레이스 tab appears or goes with it. */
	function syncCardTabs() {
		if (!open || open.kind !== "card") return;
		const want = traceableCard();
		if (want === cardTrace) return;
		cardTrace = want;
		tabs.innerHTML = renderDetailTabs("card", tab, want);
		if (!want && tab === "trace") setTab("head");
	}
	/** A turn-board conversation is open (any turns-view item but a background job). */
	const threadOpen = () => !!open && open.kind === "item" && ui.view === "turns" && !open.id.startsWith("job:");
	/** A background job detail is open (\`?view=turns&item=job:<name>\`). */
	const jobOpen = () => !!open && open.kind === "item" && ui.view === "turns" && open.id.startsWith("job:");
	const jobOf = (id) => {
		if (!snapshot || !snapshot.jobs || !snapshot.jobs.ok) return undefined;
		const name = id.slice(4);
		return snapshot.jobs.items.find((item) => item.name === name);
	};
	const jobIsLive = (job) => !!job && job.state === "running" && job.health !== "dead";
	/** The snapshot's thread by origin key, or the one holding inbound id \`id\` (the old one-turn address). */
	const threadOf = (id) => {
		if (!snapshot || !snapshot.turns.ok) return undefined;
		const list = snapshot.turns.threads;
		return /^\\d+$/.test(id)
			? list.find((item) => item.recent.some((turn) => String(turn.inboundId) === id))
			: list.find((item) => item.originKey === id);
	};
	/** A monitor row is open (\`?view=monitors&item=<id or name>\`). */
	const monitorOpen = () => !!open && open.kind === "item" && ui.view === "monitors";
	const monitorOf = (id) =>
		snapshot && snapshot.monitors.ok
			? snapshot.monitors.items.find((item) => item.id === id || item.name === id)
			: undefined;
	const threadSign = (thread) => (thread ? thread.updatedAt + "|" + thread.latest.inboundId + "|" + thread.latest.state : "");
	const taskById = (id) =>
		snapshot && snapshot.tasks.ok ? snapshot.tasks.items.find((task) => task.taskId === id) : undefined;
	const rowOf = (id) => {
		for (const element of main.querySelectorAll("[data-row]")) {
			if (element.getAttribute("data-row") === id) {
				return element.matches("a") ? element : element.querySelector("a[data-row-link]") || element.querySelector("a");
			}
		}
		return null;
	};
	const visibleRows = () => {
		const out = [];
		for (const element of main.querySelectorAll("[data-row]")) {
			const closedDetails = element.closest("details:not([open])");
			if (closedDetails) continue;
			const link = element.matches("a") ? element : element.querySelector("a[data-row-link]") || element.querySelector("a");
			if (link) out.push({ id: element.getAttribute("data-row"), link });
		}
		return out;
	};
	const note = (target, text) => {
		const line = document.createElement("p");
		line.className = "note";
		line.textContent = text;
		target.replaceChildren(line);
	};
	const shimmer = (target, text) => {
		const wrap = document.createElement("div");
		wrap.className = "skeleton";
		wrap.setAttribute("role", "status");
		const label = document.createElement("p");
		label.className = "note-sub";
		label.textContent = text;
		wrap.appendChild(label);
		for (const w of ["is-w70", "is-w90", "is-w50"]) {
			const bar = document.createElement("div");
			bar.className = "skeleton-bar " + w;
			wrap.appendChild(bar);
		}
		target.replaceChildren(wrap);
	};

	function markChanges() {
		const now = Date.now();
		const hadPrev = prevStates.size > 0;
		for (const el of main.querySelectorAll("[data-row][data-state]")) {
			const id = el.getAttribute("data-row");
			const state = el.getAttribute("data-state");
			if (!id || !state) continue;
			const prev = prevStates.get(id);
			if (hadPrev && prev !== undefined && prev !== state) {
				changedUntil.set(id, now + 1300);
				const kind = pillMotion(prev, state);
				if (kind) pillUntil.set(id, { kind: kind, until: now + 1300 });
				else pillUntil.delete(id);
			}
			const col = state.split(":")[0];
			if (hadPrev && (prev === undefined ? col === "attention" || col === "mine" : prev.split(":")[0] !== col)) {
				ringUntil.set(id, now + 1600);
			}
			prevStates.set(id, state);
			const until = changedUntil.get(id) || 0;
			if (until > now) el.classList.add("is-changed");
			const pill = pillUntil.get(id);
			if (pill && pill.until > now) el.classList.add("pill-" + pill.kind);
			if ((ringUntil.get(id) || 0) > now) el.classList.add("is-ring");
		}
	}
	/** Plays one header number's roll (digit strips, then a "+n" at the chip's end that goes after what is left of 1.4 s). */
	function playRoll(el, change, remaining) {
		const to = String(change.to);
		const from = String(change.from).padStart(to.length, "0").slice(-to.length);
		el.textContent = "";
		el.setAttribute("role", "img");
		el.setAttribute("aria-label", to);
		const strips = [];
		for (let i = 0; i < to.length; i++) {
			const col = document.createElement("span");
			col.className = "roll-col";
			col.setAttribute("aria-hidden", "true");
			const strip = document.createElement("span");
			strip.className = "roll-strip";
			for (let d = 0; d < 10; d++) {
				const cell = document.createElement("i");
				cell.textContent = String(d);
				strip.appendChild(cell);
			}
			strip.style.transform = "translateY(" + -Number(from[i]) * 1.2 + "em)";
			col.appendChild(strip);
			el.appendChild(col);
			strips.push([strip, Number(to[i])]);
		}
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				for (const [strip, digit] of strips) strip.style.transform = "translateY(" + -digit * 1.2 + "em)";
			}),
		);
		const label = rollLabel(change, el.getAttribute("data-roll-bad") || undefined);
		const tag = document.createElement("small");
		tag.className = "roll-delta is-" + label.tone;
		tag.textContent = label.text;
		const chip = el.closest(".badge, .limit-chip") || el.parentNode;
		const twin = [...chip.querySelectorAll(".roll-delta")].some((other) => other.textContent === label.text);
		if (!twin) chip.append(tag);
		setTimeout(() => {
			tag.remove();
			el.textContent = to;
			el.removeAttribute("role");
			el.removeAttribute("aria-label");
		}, remaining);
	}
	/** Right after a redraw: compares the header numbers with the last draw's and rolls the ones that changed. */
	function drawRolls() {
		const els = main.querySelectorAll("[data-roll]");
		const items = [];
		const keys = new Set();
		for (const el of els) {
			const key = el.getAttribute("data-roll");
			const value = Number(el.getAttribute("data-roll-v"));
			if (!key || !Number.isFinite(value) || keys.has(key)) continue;
			keys.add(key);
			items.push({ key: key, value: value });
		}
		const result = rollDiff(rollView === ui.view ? rollPrev : new Map(), items);
		rollPrev = result.next;
		rollView = ui.view;
		const now = Date.now();
		for (const change of rollEffects(result.changes, reducedMotion())) rollActive.set(change.key, { change: change, until: now + 1400 });
		for (const el of els) {
			const active = rollActive.get(el.getAttribute("data-roll"));
			if (active && active.until > now) playRoll(el, active.change, active.until - now);
		}
		for (const [key, active] of rollActive) if (active.until <= now) rollActive.delete(key);
	}
	/** Draws the stack's cards (three at most) and says the newest in one line. */
	function drawStack() {
		const out = stackHtml(stack);
		// Only a changed stack is redrawn, so the front card's entrance does not replay on every clock tick.
		if (out.html !== stackDrawn) {
			stackDrawn = out.html;
			stackBody.innerHTML = out.html;
			stackSay.textContent = out.say;
		}
		stackEl.hidden = stack.length === 0;
		if (stack.length === 0) stackEl.classList.remove("is-open");
		if (stackTimer) clearTimeout(stackTimer);
		stackTimer = stack.length === 0 || reducedMotion() ? null : setTimeout(tickStack, 1000);
	}
	function tickStack() {
		const now = Date.now();
		if (stackEl.matches(":hover, :focus-within, .is-open")) stackTouched = now;
		const left = expireStack(stack, now, Math.max(stackTouched, stackDropped), 6000, reducedMotion());
		if (left.length !== stack.length) {
			stackDropped = now;
			stack = left;
		}
		drawStack();
	}
	/** New inbox cards and cards that changed column go on the event stack; \`quiet\` is the read marks' first visit. */
	function syncStack(quiet) {
		const entries = inboxEntries(snapshot, board === null ? undefined : board).map((entry) => ({
			id: entry.id,
			kind: entry.kind,
			col: entry.col,
			title: entry.title,
		}));
		const result = freshCards(colPrev, entries, quiet);
		colPrev = result.next;
		const fresh = result.cards.filter((card) => !open || open.id !== card.id);
		if (fresh.length === 0) return;
		stack = pushStack(stack, fresh, Date.now());
		drawStack();
	}
	/**
	 * Tab title, tab icon and the quiet next line from the last snapshot and board; \`failed\` (or #stale showing) marks
	 * the last refresh as failed. Every view, also while the tab is hidden.
	 */
	function updateTabSignal(failed) {
		if (!snapshot) return;
		const signal = tabSignal(snapshot, board, failed === true || !stale.hidden);
		document.title = signal.title;
		const icon = document.getElementById("favicon");
		if (icon) icon.setAttribute("href", signal.favicon);
		const quiet = main.querySelector(".next-quiet");
		if (quiet) quiet.textContent = signal.bad ? "다음 · 상태 모름 — 갱신 끊김" : "다음 · 기다리는 항목 없음";
	}
	/** One snapshot read, given up after 8 seconds so a server that never answers shows as cut off too. */
	async function getSnapshot(hidden) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 8000);
		try {
			const response = await fetch("api/snapshot?view=" + encodeURIComponent(ui.view) + (hidden ? "&hidden=1" : ""), { cache: "no-store", signal: controller.signal });
			if (!response.ok) throw new Error("HTTP " + response.status);
			return await response.json();
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * The read marks for this snapshot: seeds the first visit and prunes old marks (only on a snapshot that reads the
	 * whole inbox), marks the open entry read when it opens or changes while open, and returns the unread ids.
	 */
	function syncUnread(now) {
		const store = unreadStore;
		if (!store) return [];
		const boardArg = boardOn ? board : undefined;
		seedStore(store, snapshot, boardArg, now);
		pruneStore(store, snapshot, boardArg, now);
		const entries = inboxEntries(snapshot, board === null ? undefined : board);
		const ids = unreadIds(entries, store);
		const opened = open ? entries.find((entry) => entry.kind === open.kind && entry.id === open.id) : undefined;
		if (!opened) return ids;
		const key = opened.kind + ":" + opened.id;
		if (seenOpen === key && !ids.includes(opened.id)) return ids;
		markSeen(store, opened, now);
		seenOpen = key;
		return ids.filter((id) => id !== opened.id);
	}
	/** Redraws the bar, the navigation and the view; keeps the view's scroll, the closed list and the focused row. */
	function drawMain(top) {
		if (!snapshot) return;
		const now = Date.now();
		const firstVisit = unreadStore !== null && !readUnread(unreadStore).seeded;
		const unread = syncUnread(now);
		syncStack(firstVisit);
		const html = renderDashboardMain(snapshot, board === null ? undefined : board, now, {
			view: ui.view,
			q: ui.q,
			sort: ui.sort,
			desc: ui.desc,
			selected: open ? open.id : "",
			theme: ui.theme,
			layout: ui.layout,
			stale: ui.stale,
			unread: unread,
		});
		if (html === drawnMain) return;
		const view = document.getElementById("view");
		const scroll = top || !view ? 0 : view.scrollTop;
		const active = document.activeElement;
		const row = active && main.contains(active) && active.closest("[data-row]");
		const focusRow = row ? row.getAttribute("data-row") : null;
		const sorter = active && main.contains(active) ? active.getAttribute("data-sort") : null;
		// Folds with an id (최근 닫힘, 더 보기) stay open across the redraw.
		const folds = Array.from(main.querySelectorAll("details[open][id]"), (fold) => fold.id);
		main.innerHTML = html;
		drawnMain = html;
		markChanges();
		drawRolls();
		updateTabSignal();
		scrollToHere(main);
		const next = document.getElementById("view");
		if (next) next.scrollTop = scroll;
		if (top) window.scrollTo(0, 0);
		for (const id of folds) document.getElementById(id)?.setAttribute("open", "");
		if (focusRow !== null) {
			const target = rowOf(focusRow);
			if (target) target.focus({ preventScroll: true });
		} else if (sorter) {
			const target = main.querySelector('[data-sort="' + sorter + '"]');
			if (target) target.focus();
		}
	}
	/** Each flow row starts scrolled so its selected box, else its 지금 여기 box, is in sight. */
	function scrollToHere(root) {
		for (const row of root.querySelectorAll(".flow-row")) {
			const box = row.querySelector(".is-selected") || row.querySelector(".is-here");
			if (!box) continue;
			const end = box.offsetLeft + box.offsetWidth;
			if (end > row.clientWidth) row.scrollLeft = end - row.clientWidth + 4;
		}
	}
	/** The flow chain holding TASK \`id\`, for the TASK and card panels. */
	function chainOf(id) {
		if (!snapshot || !snapshot.flows || !snapshot.flows.ok) return undefined;
		return snapshot.flows.items.find((chain) => chain.tasks.some((step) => step.taskId === id));
	}
	/** The bar's 디스코드에서 답하기 link follows the open conversation, on every tab. */
	function syncReplyLink() {
		const thread = threadOpen() ? threadOf(open.id) : undefined;
		const links = [
			[
				"detail-discord",
				thread && snapshot ? discordThreadHref(snapshot.discordGuild, thread.originKey, thread.threadRef) : "",
			],
		];
		for (const [id, href] of links) {
			const link = document.getElementById(id);
			if (!link) continue;
			link.hidden = href === "";
			if (href !== "") link.setAttribute("href", href);
			// Only the Discord link leaves for another site (a new tab).
			if (href !== "" && id === "detail-discord") {
				link.setAttribute("target", "_blank");
				link.setAttribute("rel", "noopener noreferrer");
			}
		}
	}
	/** The bar's context title shows the open conversation or card title while on non-head tabs. */
	function syncBarTitle() {
		const barTitle = document.getElementById("detail-bar-title");
		if (!barTitle) return;
		const titleEl = document.getElementById("detail-title");
		const text = open && titleEl ? (titleEl.textContent || "").trim() : "";
		const tabbed = !!open && (open.kind === "card" || threadOpen() || jobOpen());
		barTitle.textContent = text;
		barTitle.hidden = !tabbed || tab === "head" || text === "";
	}
	function drawDetail() {
		syncReplyLink();
		if (!open) {
			syncBarTitle();
			return;
		}
		let html = null;
		if (open.kind === "card") {
			if (board === null) return;
			syncCardTabs();
			const card = cardOf(open.id);
			html = renderDetailHead(
				open.id,
				card,
				card && card.taskId ? taskById(card.taskId) : undefined,
				Date.now(),
				card && card.taskId ? chainOf(card.taskId) : undefined,
			);
		} else if (open.kind === "diff") {
			html = diffHtml === null ? renderDiffDetail(open.id) : diffHtml;
		} else if (snapshot) {
			if (open.kind === "task") {
				const card = board && board.ok ? board.cards.find((item) => item.taskId === open.id) : undefined;
				html = renderTaskDetail(open.id, taskById(open.id), card ? card.key : undefined, chainOf(open.id));
			} else html = renderItemDetail(snapshot, ui.view, open.id, monitorHtml === null ? undefined : monitorHtml);
		}
		if (html === null || html === drawnHead) {
			syncBarTitle();
			return;
		}
		const focused = document.activeElement && document.activeElement.id === "detail-title";
		head.innerHTML = html;
		drawnHead = html;
		scrollToHere(head);
		syncBarTitle();
		const title = document.getElementById("detail-title");
		if (focused && title) title.focus({ preventScroll: true });
	}
	function setTab(name) {
		tab = name;
		const card = !!open && open.kind === "card";
		const thread = threadOpen();
		const tabbed = card || thread || jobOpen();
		for (const button of tabs.querySelectorAll("[data-tab]")) {
			button.setAttribute("aria-selected", String(button.getAttribute("data-tab") === name));
		}
		head.hidden = tabbed && name !== "head";
		conv.hidden = !(card || thread) || name !== "conv";
		plan.hidden = !card || name !== "plan";
		detail.scrollTop = name === "conv" ? detail.scrollHeight : 0;
		syncBarTitle();
		syncTrace();
		syncLive();
	}
	/** A herdr card's pane answer (\`api/pane/*\`), or a conversation's omp session (\`api/thread/conversation\`). */
	async function readPane(kind, before) {
		const thread = threadOpen();
		const query = new URLSearchParams(thread ? { origin: open.id } : { card: open.id });
		if (before) query.set("before", before);
		const path = thread ? "api/thread/conversation" : "api/pane/" + kind;
		const response = await fetch(path + "?" + query.toString(), { cache: "no-store" });
		if (!response.ok) throw new Error("HTTP " + response.status);
		return response.json();
	}
	async function loadConversation(mode) {
		const mine = generation;
		const ticket = ++loadTicket;
		try {
			const body = await readPane("conversation", mode === "older" ? cursor : undefined);
			if (mine !== generation) return;
			const page = Array.isArray(body.turns) ? body.turns : [];
			turns = mode === "older" ? page.concat(turns) : page;
			cursor = body.cursor;
			if (mode === "older") paged = true;
			const card = cardOf(open.id);
			const nearEnd = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 40;
			const height = detail.scrollHeight;
			const agent = threadOpen() ? "omp" : card ? card.agent : "agent";
			// The read that ends "확정 중" swaps the kept block for the final text in this one DOM update.
			if (ticket >= settleTicket) {
				liveKept = null;
				liveFail = "";
				settleTicket = Infinity;
			}
			drawnLive = liveHtml();
			conv.innerHTML =
				renderConversation({ turns: turns, cursor: cursor }, agent, renderMarkdown, Date.now()) +
				(threadOpen() ? '<div class="live-slot" data-live>' + drawnLive + "</div>" : "");
			if (tab !== "conv") return;
			if (mode === "older") detail.scrollTop += detail.scrollHeight - height;
			else if (mode === "first" || nearEnd) detail.scrollTop = detail.scrollHeight;
		} catch (error) {
			if (mine !== generation) return;
			const failed = "대화를 읽지 못했어요 (" + (error && error.message ? error.message : String(error)) + ")";
			if (mode !== "refresh") note(conv, failed);
			else if (liveKept) {
				liveFail = failed;
				drawLive();
			}
		}
	}
	/** Reads the open conversation again: one read at a time, and one more right after when asked meanwhile. */
	function reloadThread() {
		if (!threadOpen() || loadedKey !== open.id || paged) return;
		if (reloading) {
			reloadAgain = true;
			return;
		}
		reloading = loadConversation("refresh").finally(() => {
			reloading = null;
			if (!reloadAgain) return;
			reloadAgain = false;
			reloadThread();
		});
	}
	const wrote = (view) => !!view && (view.text !== "" || view.thinking !== "" || view.toolCalls.length > 0);
	/** The view the block draws: while "확정 중", the kept message with whatever runs now. */
	function liveHtml() {
		const shown = liveKept
			? Object.assign({ running: [] }, liveView || {}, liveKept)
			: liveView;
		return renderLiveTurn(shown, renderMarkdown, {
			settling: !!liveKept,
			error: liveError,
			fail: liveFail,
			elapsedMs: Date.now() - liveAt,
		});
	}
	/** Finished steps seen for the first time get their check popped (once; a redraw does not replay older ones). */
	function popSteps(slot) {
		const done = liveView && Array.isArray(liveView.done) ? liveView.done : [];
		if (liveView && liveView.inboundId !== stepFor) {
			stepFor = liveView.inboundId;
			stepSeen = null;
		}
		const result = freshSteps(stepSeen, done);
		stepSeen = new Set(result.keys);
		const now = Date.now();
		if (!reducedMotion()) for (const i of result.fresh) popUntil.set(result.keys[i], now + 420);
		const items = slot.querySelectorAll(".live-step[data-step]");
		for (let i = 0; i < items.length; i++) {
			const until = popUntil.get(result.keys[i]) || 0;
			if (until > now) items[i].classList.add("is-new");
		}
	}
	/** Redraws only the live block; keeps its open folds, and the reader's place unless they were at the bottom. */
	function drawLive() {
		const slot = conv.querySelector("[data-live]");
		if (!slot) return;
		const html = liveHtml();
		if (html === drawnLive) return;
		const folds = new Map();
		for (const fold of slot.querySelectorAll("details[data-fold]")) folds.set(fold.getAttribute("data-fold"), fold.open);
		const nearEnd = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 40;
		const top = detail.scrollTop;
		slot.innerHTML = html;
		drawnLive = html;
		popSteps(slot);
		for (const fold of slot.querySelectorAll("details[data-fold]")) {
			const was = folds.get(fold.getAttribute("data-fold"));
			if (was !== undefined) fold.open = was;
		}
		if (tab === "conv") detail.scrollTop = nearEnd ? detail.scrollHeight : top;
	}
	/**
	 * One \`live\` event. A message that ended (the view went null, or its text, thinking and tool calls emptied) stays
	 * on screen as "확정 중" and the conversation is read again; that read replaces the block.
	 */
	function onLive(body) {
		const next = body && body.live ? body.live : null;
		const prev = liveView;
		liveError = body && body.error ? body.error : "";
		liveView = next;
		liveAt = Date.now();
		if (prev && !liveError && (next === null || (next.seq > prev.seq && wrote(prev) && !wrote(next)))) {
			if (wrote(prev) && !paged) {
				liveKept = { text: prev.text, thinking: prev.thinking, toolCalls: prev.toolCalls };
				liveFail = "";
				settleTicket = loadTicket + 1;
			}
			reloadThread();
		}
		drawLive();
	}
	/**
	 * The one live stream: open while the 대화 tab shows a conversation the snapshot counts as running. Closing it on the
	 * same conversation counts as the turn ending; another conversation starts clean.
	 */
	function syncLive() {
		const thread = threadOpen() && loadedKey === open.id && tab === "conv" ? threadOf(open.id) : undefined;
		const want = thread && thread.openCount > 0 ? open.id : null;
		if (want === liveOrigin) return;
		if (liveSource) liveSource.close();
		liveSource = null;
		const same = liveOrigin !== null && !!open && liveOrigin === open.id;
		liveOrigin = want;
		if (same) onLive({ live: null });
		else {
			liveView = null;
			liveKept = null;
			liveError = "";
			liveFail = "";
			settleTicket = Infinity;
			drawLive();
		}
		if (want === null) return;
		liveSource = new EventSource("api/thread/live/events?origin=" + encodeURIComponent(want));
		liveSource.addEventListener("live", (event) => onLive(JSON.parse(event.data)));
	}
	async function loadPlan() {
		const mine = generation;
		try {
			const body = await readPane("plan");
			if (mine !== generation) return;
			const html = renderPlan(body);
			if (html === "") note(plan, "이 패널에는 plan이 없어요");
			else plan.innerHTML = html;
		} catch (error) {
			if (mine === generation) note(plan, "plan을 읽지 못했어요 (" + (error && error.message ? error.message : String(error)) + ")");
		}
	}
	/** Reads the open monitor's instruction, procedure files and runs (\`api/monitor/detail\`) into its panel. */
	async function loadMonitor(id) {
		const mine = generation;
		let body;
		try {
			const response = await fetch("api/monitor/detail?" + new URLSearchParams({ id: id }).toString(), { cache: "no-store" });
			body = await response.json();
			if (!response.ok && !(body && body.error)) body = { error: "HTTP " + response.status };
		} catch (error) {
			body = { error: error && error.message ? error.message : String(error) };
		}
		if (mine !== generation) return;
		monitorHtml = renderMonitorDetail(body);
		drawDetail();
	}
	/** Reads the open lane's or TASK's change (\`api/diff\`) into its panel. */
	async function loadDiff(id) {
		const mine = generation;
		const at = id.indexOf(":");
		const kind = id.slice(0, at);
		let body;
		try {
			if (kind !== "lane" && kind !== "task") throw new Error("lane:<이름> 또는 task:<id>만 열 수 있어요");
			const query = new URLSearchParams();
			query.set(kind, id.slice(at + 1));
			const response = await fetch("api/diff?" + query.toString(), { cache: "no-store" });
			body = await response.json();
			if (!response.ok && !(body && body.error)) body = { error: "HTTP " + response.status };
		} catch (error) {
			body = { error: error && error.message ? error.message : String(error) };
		}
		if (mine !== generation) return;
		diffHtml = renderDiffDetail(id, body);
		drawDetail();
	}
	/** Starts reading the open card's pane once the board has it, the open conversation's session, or a monitor's detail. */
	function sync() {
		if (!open || loadedKey === open.id) return;
		if (open.kind === "diff") {
			loadedKey = open.id;
			loadDiff(open.id);
			return;
		}
		if (threadOpen()) {
			// The old one-turn address waits for the snapshot to name its conversation.
			if (/^\\d+$/.test(open.id)) return;
			loadedKey = open.id;
			threadSeen = threadSign(threadOf(open.id));
			shimmer(conv, "대화를 불러오는 중…");
			loadConversation("first");
			return;
		}
		if (monitorOpen()) {
			// An old link by name waits for the snapshot to name the monitor's id.
			const monitor = monitorOf(open.id);
			if (!monitor) return;
			loadedKey = open.id;
			loadMonitor(monitor.id);
			return;
		}
		if (open.kind !== "card" || !cardOf(open.id)) return;
		loadedKey = open.id;
		shimmer(conv, "대화를 불러오는 중…");
		shimmer(plan, "plan을 불러오는 중…");
		loadPlan();
		loadConversation("first");
	}
	/**
	 * The one path from a snapshot to the open conversation: when its thread's updatedAt or last turn moved, the 대화
	 * tab reads the session again (kept at the bottom if it was there, else where the reader is). No timer of its own.
	 */
	function followThread() {
		if (!threadOpen() || loadedKey !== open.id) return;
		const seen = threadSign(threadOf(open.id));
		if (seen === threadSeen) return;
		threadSeen = seen;
		reloadThread();
	}
	/** The old one-turn address (\`?view=turns&item=<inbound id>\`) becomes its conversation's, on the 트레이스 tab. */
	function adoptOldTurn() {
		if (!threadOpen() || !/^\\d+$/.test(open.id)) return;
		const thread = threadOf(open.id);
		if (!thread) return;
		open = { kind: "item", id: thread.originKey };
		drawnHead = "";
		history.replaceState(history.state, "", toUrl(open));
	}
	function show(target, how) {
		const before = open;
		const same = before && target ? before.kind === target.kind && before.id === target.id : before === target;
		if (how === "push") {
			const opened = !!(history.state && history.state.opened);
			if (target && before) history.replaceState({ opened: opened }, "", toUrl(target));
			else if (target) history.pushState({ opened: true }, "", toUrl(target));
			else history.pushState(null, "", toUrl(null));
		}
		if (same) return;
		open = target;
		loadedKey = null;
		generation += 1;
		turns = [];
		cursor = undefined;
		paged = false;
		drawnHead = "";
		monitorHtml = null;
		diffHtml = null;
		const thread = threadOpen();
		const job = jobOpen();
		traceTurn = thread && /^\\d+$/.test(open.id) ? open.id : null;
		adoptOldTurn();
		detail.hidden = !open;
		detail.classList.toggle("is-open", !!open);
		detail.setAttribute("aria-label", LABELS[open ? open.kind : "card"]);
		document.body.classList.toggle("detail-open", !!open);
		tabs.hidden = !open || (open.kind !== "card" && !thread && !job);
		cardTrace = traceableCard();
		tabs.innerHTML = renderDetailTabs(
			thread ? "thread" : job ? "job" : "card",
			thread ? (traceTurn ? "trace" : "conv") : "head",
			cardTrace,
		);
		const back = toUrl(null);
		closer.setAttribute("href", back.search || "./");
		plan.replaceChildren();
		conv.replaceChildren();
		setTab(thread ? (traceTurn ? "trace" : "conv") : "head");
		drawMain(false);
		if (!open) {
			const row = before ? rowOf(before.id) : null;
			if (row) row.focus();
			return;
		}
		drawDetail();
		sync();
		syncLive();
		const title = document.getElementById("detail-title");
		if (title) title.focus({ preventScroll: true });
	}
	const CARD_TRACE_NOTES = {
		no_session: "이 워커의 omp 세션을 찾지 못했습니다",
		unsupported_card: "이 카드는 트레이스를 지원하지 않습니다",
		unknown_pane: "이 카드는 더 이상 보드에 없습니다",
		trace_disabled: "이 대시보드는 트레이스를 켜지 않았습니다",
		board_disabled: "이 대시보드는 에이전트 보드를 켜지 않았습니다",
	};
	const JOB_TRACE_NOTES = {
		no_session: "이 작업의 omp 세션을 찾지 못했습니다",
		unknown_job: "이 작업은 더 이상 목록에 없습니다",
		invalid_name: "작업 이름이 올바르지 않습니다",
		trace_disabled: "이 대시보드는 트레이스를 켜지 않았습니다",
	};
	/** A conversation's 트레이스 tab carries the waterfall of its last (or chosen) turn and widens the panel; a local omp worker card's or job's, its last turn. */
	function syncTrace() {
		const onCard = !!open && open.kind === "card" && tab === "trace" && cardTrace;
		if (onCard) {
			document.body.classList.add("detail-trace");
			const card = cardOf(open.id);
			return trace.open("card:" + open.id, card ? card.paneLabel : "", {
				url: "api/pane/trace?card=" + encodeURIComponent(open.id),
				notes: CARD_TRACE_NOTES,
			});
		}
		if (jobOpen() && tab === "trace") {
			document.body.classList.add("detail-trace");
			const job = jobOf(open.id);
			const name = open.id.slice(4);
			return trace.open(open.id, job ? job.title : name, {
				url: "api/job/trace?name=" + encodeURIComponent(name),
				notes: JOB_TRACE_NOTES,
			});
		}
		const on = threadOpen() && tab === "trace";
		document.body.classList.toggle("detail-trace", on);
		const thread = on ? threadOf(open.id) : undefined;
		const turnId = !on ? null : traceTurn || (thread ? String(thread.latest.inboundId) : null);
		if (turnId === null) return trace.close();
		const turn = thread ? thread.recent.find((item) => String(item.inboundId) === turnId) : undefined;
		trace.open(turnId, turn && turn.preview ? turn.preview : thread ? thread.title : "");
	}
	function close() {
		if (!open) return;
		if (history.state && history.state.opened) history.back();
		else show(null, "push");
	}
	function setView(view) {
		// The 방치 filter follows a move between the inbox and the list; any other view drops it.
		if (view !== "inbox" && view !== "list") ui.stale = false;
		ui.view = view;
		ui.layout = "";
		if (open) show(null, "none");
		history.pushState(null, "", toUrl(null));
		drawMain(true);
		const target = document.getElementById("view");
		if (target) target.focus({ preventScroll: true });
	}

	// ---- Command Palette (⌘K / Ctrl+K) and Shortcut Help (?) ----
	function buildCommands() {
		const list = [
			{ label: "보기: 에이전트 인박스 (Board)", sub: "g i", run: () => setView("inbox") },
			{ label: "보기: 에이전트 목록 (List)", sub: "g l", run: () => setView("list") },
			{ label: "보기: 턴", sub: "g t", run: () => setView("turns") },
			{ label: "보기: 흐름", sub: "g f", run: () => setView("flow") },
			{ label: "보기: 레인", sub: "g n", run: () => setView("lanes") },
			{ label: "보기: 승인 대기", sub: "g a", run: () => setView("approvals") },
			{ label: "보기: 모니터", sub: "g m", run: () => setView("monitors") },
			{ label: "보기: 알림", sub: "g e", run: () => setView("alerts") },
			{ label: "보기: 시스템", sub: "g s", run: () => setView("system") },
			{ label: "테마: 시스템 설정 따르기", sub: "Theme", run: () => applyTheme("system", true) },
			{ label: "테마: 라이트 모드", sub: "Theme", run: () => applyTheme("light", true) },
			{ label: "테마: 다크 모드", sub: "Theme", run: () => applyTheme("dark", true) },
		];
		if (snapshot && snapshot.tasks && snapshot.tasks.ok) {
			for (const t of snapshot.tasks.items) {
				list.push({
					label: "TASK 이동: " + t.taskId + " · " + t.title,
					sub: t.status,
					run: () => show({ kind: "task", id: t.taskId }, "push"),
				});
			}
		}
		if (board && board.ok) {
			for (const c of board.cards) {
				list.push({
					label: "카드 이동: " + c.key + " · " + c.paneLabel,
					sub: c.machineName,
					run: () => show({ kind: "card", id: c.key }, "push"),
				});
			}
		}
		return list;
	}
	function renderCmdList() {
		const q = (cmdInput ? cmdInput.value : "").trim().toLowerCase();
		const all = buildCommands();
		cmdItems = q === "" ? all : all.filter((item) => item.label.toLowerCase().includes(q) || item.sub.toLowerCase().includes(q));
		if (cmdIdx >= cmdItems.length) cmdIdx = Math.max(0, cmdItems.length - 1);
		if (!cmdList) return;
		if (cmdItems.length === 0) {
			cmdList.innerHTML = '<p class="cmd-empty">일치하는 명령이나 TASK가 없어요</p>';
			return;
		}
		cmdList.innerHTML = cmdItems
			.map(
				(item, idx) =>
					'<button type="button" class="cmd-item" role="option" data-cmd-idx="' +
					idx +
					'" aria-selected="' +
					(idx === cmdIdx) +
					'"><span>' +
					item.label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
					'</span><span class="cmd-item-sub">' +
					item.sub.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
					"</span></button>",
			)
			.join("");
	}
	function openCmd() {
		if (!cmdModal) return;
		if (!helpModal.hidden) helpModal.hidden = true;
		prevFocus = document.activeElement;
		cmdModal.hidden = false;
		cmdIdx = 0;
		if (cmdInput) {
			cmdInput.value = "";
			renderCmdList();
			cmdInput.focus();
		}
	}
	function closeCmd(restore) {
		if (!cmdModal || cmdModal.hidden) return;
		cmdModal.hidden = true;
		if (restore && prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
	}
	function openHelp() {
		if (!helpModal) return;
		if (!cmdModal.hidden) cmdModal.hidden = true;
		prevFocus = document.activeElement;
		helpModal.hidden = false;
		const closeBtn = helpModal.querySelector("[data-help-close]");
		if (closeBtn) closeBtn.focus();
	}
	function closeHelp() {
		if (!helpModal || helpModal.hidden) return;
		helpModal.hidden = true;
		if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
	}
	// Tab and Shift+Tab go round the open modal's focusable elements and never reach the page behind it.
	function trapTab(modal, event) {
		const items = Array.from(
			modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'),
		).filter((el) => el.getClientRects().length > 0);
		event.preventDefault();
		if (items.length === 0) return;
		const at = items.indexOf(document.activeElement);
		const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at < 0 || at === items.length - 1 ? 0 : at + 1;
		items[next].focus();
	}

	function moveRow(delta) {
		const list = visibleRows();
		if (list.length === 0) return;
		const active = document.activeElement;
		const currentRow = active && main.contains(active) && active.closest("[data-row]");
		const currentId = currentRow ? currentRow.getAttribute("data-row") : open ? open.id : null;
		let idx = list.findIndex((item) => item.id === currentId);
		if (idx < 0) idx = delta > 0 ? 0 : list.length - 1;
		else idx = Math.max(0, Math.min(list.length - 1, idx + delta));
		const target = list[idx];
		if (target && target.link) target.link.focus();
	}

	const touchStack = () => {
		stackTouched = Date.now();
	};
	stackEl.addEventListener("mouseenter", touchStack);
	stackEl.addEventListener("focusin", touchStack);
	const plain = (event) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
	document.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		if (!target) return;
		if (!target.closest("#event-stack")) stackEl.classList.remove("is-open");
		if (target.closest("[data-es-close]")) {
			event.preventDefault();
			stack = [];
			return drawStack();
		}
		const stacked = target.closest("[data-es-card]");
		if (stacked) {
			// On a touch screen the first tap unfolds the stack; the next opens the card.
			if (window.matchMedia("(hover: none)").matches && !stackEl.classList.contains("is-open")) {
				event.preventDefault();
				stackEl.classList.add("is-open");
				stackTouched = Date.now();
				return;
			}
			const gone = stacked.getAttribute("data-es-card");
			stack = stack.filter((card) => card.id !== gone);
			drawStack();
		}
		const outbound = target.closest("[data-open]");
		if (outbound) {
			event.preventDefault();
			window.open(outbound.getAttribute("data-open") || "", "_blank", "noopener,noreferrer");
			return;
		}
		const copyBtn = target.closest("[data-copy]");
		if (copyBtn) {
			event.preventDefault();
			return copyText(copyBtn.getAttribute("data-copy") || "", copyBtn.getAttribute("data-copy-label") || "값");
		}
		const themeBtn = target.closest("[data-theme-set]");
		if (themeBtn) {
			event.preventDefault();
			return applyTheme(themeBtn.getAttribute("data-theme-set") || "system", true);
		}
		if (target.closest("[data-cmd-open]")) {
			event.preventDefault();
			return openCmd();
		}
		if (target.closest("[data-cmd-close]") || target === cmdModal) {
			event.preventDefault();
			return closeCmd(true);
		}
		const cmdBtn = target.closest("[data-cmd-idx]");
		if (cmdBtn) {
			event.preventDefault();
			const idx = Number(cmdBtn.getAttribute("data-cmd-idx"));
			const item = cmdItems[idx];
			closeCmd(false);
			if (item) item.run();
			return;
		}
		if (target.closest("[data-help-open]")) {
			event.preventDefault();
			return openHelp();
		}
		if (target.closest("[data-help-close]") || target === helpModal) {
			event.preventDefault();
			return closeHelp();
		}
		if (traceHost.contains(target) && trace.click(target)) {
			event.preventDefault();
			return;
		}
		if (target.closest("[data-clear-search]")) {
			event.preventDefault();
			search.value = "";
			ui.q = "";
			drawMain(true);
			search.focus();
			return;
		}
		const staleToggle = target.closest("[data-stale], [data-stale-off]");
		if (staleToggle) {
			event.preventDefault();
			ui.stale = staleToggle.hasAttribute("data-stale") ? !ui.stale : false;
			history.pushState(history.state, "", toUrl(open));
			return drawMain(true);
		}
		const markRead = target.closest("button[data-mark-read]");
		if (markRead) {
			event.preventDefault();
			const store = unreadStore;
			const column = document.getElementById("col-" + markRead.getAttribute("data-mark-read"));
			if (!store || !snapshot || !column) return;
			// Every card of the column on screen (after the search and the 방치 filter), not the folded 최근 닫힘 rows.
			const entries = inboxEntries(snapshot, board === null ? undefined : board);
			const now = Date.now();
			for (const row of column.querySelectorAll(".card[data-row]")) {
				const read = entries.find((item) => item.id === row.getAttribute("data-row"));
				if (read) markSeen(store, read, now);
			}
			return drawMain(false);
		}
		const entry = target.closest("a[data-card], a[data-task], a[data-item]");
		if (entry && plain(event)) {
			event.preventDefault();
			for (const kind of ["card", "task", "item"]) {
				const id = entry.getAttribute("data-" + kind);
				if (id) return show({ kind: kind, id: id }, "push");
			}
		}
		const nav = target.closest("a[data-view], a[data-layout]");
		if (nav && snapshot && plain(event)) {
			event.preventDefault();
			const layout = nav.getAttribute("data-layout");
			// On the turns view Board/List switch its own layout and keep the open conversation.
			if (layout && ui.view === "turns") {
				ui.layout = layout === "list" ? "list" : "";
				history.pushState(history.state, "", toUrl(open));
				return drawMain(true);
			}
			return setView(layout ? (layout === "list" ? "list" : "inbox") : nav.getAttribute("data-view"));
		}
		if (target.closest("[data-close]")) {
			event.preventDefault();
			return close();
		}
		const sorter = target.closest("button[data-sort]");
		if (sorter) {
			const key = sorter.getAttribute("data-sort");
			if ((ui.sort || "state") === key) ui.desc = !ui.desc;
			else {
				ui.sort = key;
				ui.desc = false;
			}
			return drawMain(false);
		}
		const recentTurn = target.closest("button[data-trace-turn]");
		if (recentTurn) {
			traceTurn = recentTurn.getAttribute("data-trace-turn");
			return setTab("trace");
		}
		const tabButton = target.closest("button[data-tab]");
		if (tabButton) return setTab(tabButton.getAttribute("data-tab"));
		const more = target.closest("button[data-before]");
		if (more) {
			more.disabled = true;
			loadConversation("older");
		}
	});
	if (cmdInput) {
		cmdInput.addEventListener("input", () => {
			cmdIdx = 0;
			renderCmdList();
		});
	}
	document.addEventListener("keydown", (event) => {
		if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
			event.preventDefault();
			if (cmdModal && !cmdModal.hidden) closeCmd(true);
			else openCmd();
			return;
		}
		if (cmdModal && !cmdModal.hidden) {
			if (event.key === "Escape") {
				event.preventDefault();
				closeCmd(true);
			} else if (event.key === "ArrowDown") {
				event.preventDefault();
				if (cmdItems.length > 0) {
					cmdIdx = (cmdIdx + 1) % cmdItems.length;
					renderCmdList();
				}
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				if (cmdItems.length > 0) {
					cmdIdx = (cmdIdx - 1 + cmdItems.length) % cmdItems.length;
					renderCmdList();
				}
			} else if (event.key === "Enter") {
				event.preventDefault();
				const item = cmdItems[cmdIdx];
				closeCmd(false);
				if (item) item.run();
			} else if (event.key === "Tab") {
				trapTab(cmdModal, event);
			}
			return;
		}
		if (helpModal && !helpModal.hidden) {
			if (event.key === "Escape" || event.key === "?") {
				event.preventDefault();
				closeHelp();
			} else if (event.key === "Tab") {
				trapTab(helpModal, event);
			}
			return;
		}
		// Inside the waterfall its tree keys win; Escape with no details open still closes the panel below.
		if (event.target instanceof Element && traceHost.contains(event.target) && !event.metaKey && !event.ctrlKey && !event.altKey && trace.key(event)) {
			event.preventDefault();
			return;
		}
		const typing = event.target instanceof Element && Boolean(event.target.closest("input, textarea, select, [contenteditable]"));
		if (typing) {
			if (event.key === "Escape" && event.target === search) {
				if (search.value !== "") {
					search.value = "";
					ui.q = "";
					drawMain(false);
				} else {
					search.blur();
				}
			}
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (gPending) {
			gPending = false;
			if (chordTimer) clearTimeout(chordTimer);
			const G_MAP = { i: "inbox", l: "list", t: "turns", f: "flow", n: "lanes", a: "approvals", m: "monitors", e: "alerts", s: "system" };
			const dest = G_MAP[event.key.toLowerCase()];
			if (dest) {
				event.preventDefault();
				setView(dest);
				return;
			}
		}
		if (event.key === "Escape") {
			if (open) {
				event.preventDefault();
				close();
			} else if (search.value !== "") {
				search.value = "";
				ui.q = "";
				drawMain(false);
			}
			return;
		}
		if (event.key === "/") {
			event.preventDefault();
			search.focus();
			search.select();
			return;
		}
		if (event.key === "?") {
			event.preventDefault();
			openHelp();
			return;
		}
		if (event.key === "g") {
			gPending = true;
			if (chordTimer) clearTimeout(chordTimer);
			chordTimer = setTimeout(() => {
				gPending = false;
			}, 1000);
			return;
		}
		// 1…9 open the 확인 필요 card with that number on screen; r opens the next line's reply link in a new tab.
		const keyInput = {
			key: event.key,
			meta: event.metaKey,
			ctrl: event.ctrlKey,
			alt: event.altKey,
			typing: typing,
			modalOpen: (cmdModal && !cmdModal.hidden) || (helpModal && !helpModal.hidden),
			view: ui.view,
		};
		const numbered = Array.from(main.querySelectorAll("a[data-order]"));
		const orderId = orderKeyTarget(
			keyInput,
			numbered.map((el) => el.getAttribute("data-row")),
		);
		if (orderId) {
			event.preventDefault();
			const card = numbered.find((el) => el.getAttribute("data-row") === orderId);
			return show({ kind: card && card.hasAttribute("data-task") ? "task" : "card", id: orderId }, "push");
		}
		const replyLink = main.querySelector(".next-reply");
		const replyHref = replyKeyTarget(keyInput, replyLink ? replyLink.getAttribute("href") : null);
		if (replyHref) {
			event.preventDefault();
			window.open(replyHref, "_blank", "noopener");
			return;
		}
		if (event.key === "j" || event.key === "ArrowDown") {
			event.preventDefault();
			moveRow(1);
			return;
		}
		if (event.key === "k" || event.key === "ArrowUp") {
			event.preventDefault();
			moveRow(-1);
			return;
		}
		if (event.key === "Enter" && event.target instanceof Element) {
			const entry = event.target.closest("a[data-card], a[data-task], a[data-item]");
			if (entry) {
				event.preventDefault();
				for (const kind of ["card", "task", "item"]) {
					const id = entry.getAttribute("data-" + kind);
					if (id) return show({ kind: kind, id: id }, "push");
				}
			}
		}
		if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && event.target instanceof Element && event.target.matches("button[data-tab]")) {
			event.preventDefault();
			const order = Array.from(tabs.querySelectorAll("[data-tab]")).map((button) => button.getAttribute("data-tab"));
			const idx = order.indexOf(tab);
			const next = order[(idx + (event.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
			setTab(next);
			const btn = tabs.querySelector('[data-tab="' + next + '"]');
			if (btn) btn.focus();
		}
	});
	search.addEventListener("input", () => {
		ui.q = search.value;
		drawMain(true);
	});
	window.addEventListener("popstate", () => {
		const state = fromUrl();
		const moved = state.view !== ui.view || state.layout !== ui.layout || state.stale !== ui.stale;
		ui.view = state.view;
		ui.layout = state.layout;
		ui.stale = state.stale;
		show(state.open, "none");
		if (moved) drawMain(true);
	});
	async function refresh() {
		const wasJobLive = jobOpen() && jobIsLive(jobOf(open.id));
		try {
			snapshot = await getSnapshot();
			adoptOldTurn();
			drawMain(false);
			// Without the board stream this is the only redraw: a ?card= deep link loads its conversation here too.
			drawDetail();
			sync();
			followThread();
			syncLive();
			// A ?view=turns&item= deep link starts its waterfall here, and the root row picks up the request line.
			syncTrace();
			if (jobOpen() && tab === "trace" && (wasJobLive || jobIsLive(jobOf(open.id)))) trace.reload();
			stale.hidden = true;
			updateTabSignal();
		} catch (error) {
			stale.textContent = "갱신 실패: " + (error && error.message ? error.message : String(error)) + " · 15초 뒤 다시 시도해요";
			stale.hidden = false;
			updateTabSignal(true);
		}
	}
	const start = fromUrl();
	ui.view = start.view;
	ui.layout = start.layout;
	ui.stale = start.stale;
	open = start.open;
	if (threadOpen()) {
		traceTurn = /^\\d+$/.test(open.id) ? open.id : null;
		tab = traceTurn ? "trace" : "conv";
	}
	search.value = "";
	refresh();
	// A hidden tab skips the poll (each snapshot can run herdr over ssh) and catches up the moment it shows again.
	setInterval(() => {
		if (document.visibilityState === "visible") refresh();
	}, 15000);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") refresh();
	});
	// A hidden tab reads a snapshot once a minute for the tab title and icon only; the page itself is not redrawn.
	setInterval(() => {
		if (document.visibilityState === "visible") return;
		getSnapshot(true)
			.then((next) => {
				snapshot = next;
				updateTabSignal();
			})
			.catch(() => updateTabSignal(true));
	}, 60000);
	setInterval(() => {
		if (open && open.kind === "card" && loadedKey === open.id && !paged && document.visibilityState === "visible") {
			loadConversation("refresh");
		}
	}, 10000);
	// One clock for the waterfall and the live block's tool ages (no timer of its own).
	setInterval(() => {
		trace.tick();
		if (liveView && liveView.running.length > 0) drawLive();
	}, 1000);
	if (boardOn) {
		const events = new EventSource("api/board/events");
		events.addEventListener("snapshot", (event) => {
			const before = open && open.kind === "card" ? cardOf(open.id) : undefined;
			board = JSON.parse(event.data);
			drawMain(false);
			drawDetail();
			// A status move (working → done) ends the live trace: read it once more so no span stays running.
			const after = open && open.kind === "card" ? cardOf(open.id) : undefined;
			if (before && after && before.status !== after.status && tab === "trace" && cardTrace) trace.reload();
			sync();
			updateTabSignal();
		});
	}
}
if (typeof window !== "undefined") boot();
`;
