import { afterEach, describe, expect, test } from "bun:test";
import type { BoardCard, BoardView } from "../src/dashboard/board";
import { renderItemDetail, renderTaskDetail } from "../src/dashboard/detail";
import { renderDashboardPage, SCRIPT } from "../src/dashboard/html";
import { inboxAttention } from "../src/dashboard/inbox";
import { renderDashboardMain } from "../src/dashboard/main-view";
import { renderMarkdown } from "../src/dashboard/markdown";
import { startDashboardServer } from "../src/dashboard/server";
import type { DashboardSnapshot, TaskInfo } from "../src/dashboard/snapshot";
import { boardSourceFor } from "../src/dashboard/snapshot-assembly";
import { STYLE } from "../src/dashboard/style";

const NOW = Date.parse("2026-11-04T01:00:00Z");
/** The dashboard's own public address: `herdrBoard.url` points here, so TASK card links carry this origin. */
const SELF = "https://dash.example.test";

const card = (key: string, status: string, column: BoardCard["column"], extra: Partial<BoardCard> = {}): BoardCard => ({
	key,
	local: !key.includes("m-ssh"),
	machineId: key.includes("m-ssh") ? "m-ssh" : "local",
	machineName: key.includes("m-ssh") ? "wsl" : "oci",
	paneId: key.replace(/^m-ssh:/, ""),
	workspaceId: "w1",
	workspaceLabel: "main",
	tabLabel: "tab",
	paneLabel: `pane ${key}`,
	name: `agent-${key}`,
	agent: "omp",
	status,
	column,
	unknown: false,
	since: NOW - 5 * 60_000,
	cwd: "/srv/work",
	...extra,
});

const BOARD: BoardView = {
	ok: true,
	generatedAt: NOW,
	machines: [
		{ id: "local", name: "oci", connected: true },
		{ id: "m-ssh", name: "wsl", connected: true },
	],
	cards: [
		card("w1:p1", "working", "working", {
			taskId: "T-20261104-50",
			replyUrl: "https://herdr.example.test/?ws=w1&pane=w1%3Ap1&view=chat",
		}),
		card("w1:p2", "blocked", "attention"),
		card("m-ssh:w9:p1", "idle", "idle"),
		card("m-ssh:w9:p2", "done", "done", { since: NOW - 60 * 60_000 }),
	],
};

const task = (taskId: string, extra: Partial<TaskInfo>): TaskInfo => ({
	taskId,
	title: `title ${taskId}`,
	risk: "L2",
	status: "working",
	host: "local",
	agent: taskId.toLowerCase(),
	branch: `task/${taskId}`,
	open: true,
	updatedAt: "2026-11-04T09:30:00+09:00",
	acTotal: 13,
	...extra,
});

const SNAPSHOT: DashboardSnapshot = {
	generatedAt: "2026-11-04T10:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: { ok: false, error: "no daemon" },
	turns: {
		ok: true,
		items: [
			{
				inboundId: 7,
				originKey: "discord/dm/200000000000000001",
				threadRef: "200000000000000001:300000000000000001",
				state: "dispatched",
				createdAt: "2026-11-04T09:50:00+09:00",
				ageMs: 600_000,
				silentMs: 30_000,
				stalled: false,
				kind: "message",
				preview: "인박스 셸 손봐 줘",
				waitReason: null,
				blocksRestart: false,
				topLevel: false,
				slash: false,
			},
		],
		threads: [
			{
				originKey: "discord/dm/200000000000000001",
				threadRef: "200000000000000001:300000000000000001",
				kind: "message",
				title: "인박스 셸 손봐 줘",
				column: "working",
				latest: {
					inboundId: 7,
					state: "dispatched",
					createdAt: "2026-11-04T09:50:00+09:00",
					preview: "인박스 셸 손봐 줘",
					ageMs: 600_000,
					silentMs: 30_000,
					stalled: false,
					waitReason: null,
				},
				turnCount: 1,
				openCount: 1,
				runCount: 1,
				pendingCount: 0,
				stalledCount: 0,
				updatedAt: "2026-11-04T09:59:30+09:00",
				recent: [
					{ inboundId: 7, state: "dispatched", createdAt: "2026-11-04T09:50:00+09:00", preview: "인박스 셸 손봐 줘" },
				],
			},
		],
	},
	tasks: {
		ok: true,
		items: [
			task("T-20261104-50", {
				title: "인박스 셸",
				acChecked: 3,
				stepsDone: 2,
				stepsTotal: 7,
				progress: { status: "working", updated: "2026-11-04T09:40:00+09:00", current: "S3 셸 구현", blockedReason: "" },
				herdr: { ok: true, status: "working" },
				link: `${SELF}/?card=w1%3Ap1`,
			}),
			task("T-20261104-51", {
				title: "막힌 작업",
				status: "blocked",
				acChecked: 1,
				acTotal: 2,
				stepsDone: 0,
				stepsTotal: 3,
				progress: {
					status: "blocked",
					updated: "2026-11-04T09:10:00+09:00",
					current: "S1",
					blockedReason: "오너 결정",
				},
				acceptance: [
					{ id: "AC-1", text: "첫 <기준>", checked: true },
					{ id: "AC-2", text: "둘째 기준", checked: false },
				],
				steps: [
					{ id: "S1", text: "준비", done: false },
					{ id: "S2", text: "구현", done: false },
					{ id: "S3", text: "검증", done: false },
				],
				herdr: { ok: true, status: "gone" },
				link: `${SELF}/`,
			}),
			task("T-20261104-52", {
				title: "검토 대기 작업",
				status: "review",
				acChecked: 2,
				acTotal: 2,
				stepsDone: 4,
				stepsTotal: 4,
				herdr: { ok: true, status: "idle" },
				link: `${SELF}/?card=m-ssh%3Aw9%3Ap7`,
			}),
			task("T-20261103-09", { title: "어제 닫힘", status: "done", open: false, closedAt: "2026-11-03T18:00:00+09:00" }),
		],
	},
	lanes: { ok: true, items: [] },
	herdr: { ok: true, hosts: [] },
	approvals: {
		ok: true,
		items: [
			{
				approvalId: "ap1",
				summary: "push to main",
				createdAt: "2026-11-04T09:55:00+09:00",
				expiresAt: "2026-11-04T10:55:00+09:00",
				originKey: "discord/dm/200000000000000001",
				originThreadRef: null,
				title: "push to main",
				detail: null,
				cardUrl: null,
				originUrl: null,
				remainingMs: 55 * 60_000,
				originLabel: "DM",
			},
		],
		recent: [],
		stats: { days: 7, approved: 0, denied: 0, expired: 0, replied: 0, medianAnswerMs: null },
	},
	monitors: { ok: true, items: [] },
	alerts: {
		ok: true,
		items: [
			{
				scope: "daemon",
				signature: "turn_failed",
				count: 3,
				lastAt: "2026-11-04T09:58:00+09:00",
				incidentId: 1,
				firstAt: "2026-11-04T09:40:00+09:00",
				status: "alerted",
			},
		],
	},
	gates: { ok: true, items: [] },
	backup: { ok: true, offsite: null },
	jobs: { ok: true, items: [] },
};

/** The markup of one inbox group (`col-mine`, `col-working`, `col-read`, `col-done`). */
const column = (html: string, id: string): string => {
	const start = html.indexOf(`id="col-${id}"`);
	if (start < 0) throw new Error(`no column ${id}`);
	return html.slice(start, html.indexOf("</section>", start));
};

/** The `<a …>…</a>` element carrying `attribute`. */
const anchor = (html: string, attribute: string): string => {
	const at = html.indexOf(attribute);
	if (at < 0) throw new Error(`no ${attribute}`);
	const start = html.lastIndexOf("<a ", at);
	return html.slice(start, html.indexOf("</a>", at) + 4);
};

describe("dashboard inbox", () => {
	let stop: (() => void) | undefined;
	afterEach(() => stop?.());

	function serve(): string {
		const server = startDashboardServer({ port: 0, hostname: "127.0.0.1", snapshot: async () => SNAPSHOT });
		stop = () => server.stop(true);
		return `http://127.0.0.1:${server.port}`;
	}

	test("AC-1: only other-origin links open a new tab; the dashboard's own card links open in the page", () => {
		const pages = [
			renderDashboardPage(SNAPSHOT, { board: BOARD }),
			renderDashboardPage(SNAPSHOT, { board: BOARD, card: "w1:p1" }),
			renderDashboardPage(SNAPSHOT, { board: BOARD, task: "T-20261104-50" }),
			renderDashboardPage(SNAPSHOT),
			renderDashboardPage(SNAPSHOT, { board: { ok: false, error: "herdr_unreachable" } }),
		];
		expect(pages[1]).toContain('target="_blank"');
		for (const html of pages) {
			for (const [, attributes] of html.matchAll(/<a\b([^>]*)>/g)) {
				if (!attributes?.includes('target="_blank"')) continue;
				const href = /href="([^"]*)"/.exec(attributes)?.[1] ?? "";
				expect(href).toMatch(/^https?:\/\//);
				expect(new URL(href.replace(/&amp;/g, "&")).origin).not.toBe(SELF);
			}
			expect(html).not.toContain(`href="${SELF}`);
		}
		const [boardPage, , , bare] = pages as [string, string, string, string];
		expect(anchor(boardPage, 'data-card="w1:p1"')).toContain("인박스 셸");
		expect(anchor(boardPage, 'data-task="T-20261104-51"')).toContain('href="?task=T-20261104-51"');
		expect(anchor(bare, 'data-task="T-20261104-50"')).toContain('href="?task=T-20261104-50"');
	});

	test("AC-2: the desktop first render has the top bar, the side navigation and the four inbox groups", async () => {
		const html = await (await fetch(`${serve()}/`)).text();
		expect(html).toMatch(/<header class="topbar"[^>]*>/);
		expect(html).toMatch(/<nav class="crumbs" aria-label="위치"><span>jabbu<\/span>.*<span[^>]*>인박스<\/span><\/nav>/);
		expect(html).toContain('class="status-chips"');
		expect(html).toMatch(/data-layout="board"[^>]*>Board</);
		expect(html).toMatch(/data-layout="list"[^>]*>List</);
		expect(html).toMatch(/<input[^>]*type="search"/);
		const nav = /<nav class="sidenav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
		for (const [view, label, count] of [
			["inbox", "인박스", 1],
			["turns", "턴", 1],
			["lanes", "레인", 0],
			["approvals", "승인 대기", 1],
			["monitors", "모니터", 0],
			["system", "시스템", 0],
		] as const) {
			expect(nav).toMatch(
				new RegExp(`data-view="${view}"[^>]*><span>${label}</span><span class="nav-count[^"]*">${count}</span>`),
			);
		}
		// The one alert is a record, not an open gate: the alerts item carries no number.
		expect(nav).toMatch(/data-view="alerts"[^>]*><span>알림<\/span><svg/);
		// Without a board: the blocked TASK and the TASK in review are the owner's; the working one is 진행 중.
		for (const [id, label, count] of [
			["mine", "내 차례", 2],
			["working", "진행 중", 1],
			["read", "읽을 것", 0],
			["done", "확인함", 0],
		] as const) {
			expect(column(html, id)).toMatch(
				new RegExp(`<h2 class="col-head"><span>${label}</span><span class="count-chip">${count}</span></h2>`),
			);
		}
	});

	test("AC-3: a TASK with an agent is one row; an open TASK without one is a lone row under 내 차례", () => {
		const html = renderDashboardMain(SNAPSHOT, BOARD, NOW);
		const inbox = ["mine", "working", "read", "done"].map((id) => column(html, id)).join("");
		expect(inbox.split("T-20261104-50").length - 1).toBe(1);
		expect(inbox.split('data-card="w1:p1"').length - 1).toBe(1);
		expect(column(html, "working")).toContain('data-card="w1:p1"');
		const mine = column(html, "mine");
		expect(mine).toContain('data-task="T-20261104-51"');
		expect(mine).toContain('data-task="T-20261104-52"');
		expect(mine).toContain('data-card="w1:p2"');
		// A closed TASK is no row: only a row of the folded "최근 닫힘" list at the bottom of 확인함.
		expect(anchor(html, 'data-task="T-20261103-09"')).toStartWith('<a class="closed-row"');
		expect(column(html, "done")).toMatch(/최근 닫힘 <span class="count-chip">1<\/span>/);
	});

	test("AC-4: a TASK row shows its title, then TASK ID, one state word and its PROGRESS step as the reason", () => {
		const html = renderDashboardMain(SNAPSHOT, BOARD, NOW);
		const merged = anchor(html, 'data-card="w1:p1"');
		expect(merged).toContain('<span class="t1">인박스 셸</span>');
		expect(merged).toContain('<b class="tw">진행 중</b>');
		expect(merged).toContain("<span>S3 셸 구현</span>");
		expect(merged).toContain("T-20261104-50");
		// One state word: no badge row, no AC/단계 figures on the row (they stay in the detail panel).
		expect(merged).not.toContain('class="badge');
		expect(merged).not.toContain("AC 3/13");
		const lone = anchor(column(html, "mine"), 'data-task="T-20261104-51"');
		expect(lone).toContain('<span class="order-no">1</span>막힌 작업</span>');
		expect(lone).toContain('<b class="tw">확인 필요</b>');
		expect(lone).toContain("<span>워커 사라짐</span>");
	});

	test("a working TASK whose agent finished shows 판정 대기 in 진행 중 (the sweep's turn)", () => {
		const board: BoardView = { ...BOARD, cards: [card("w1:p1", "done", "done", { taskId: "T-20261104-50" })] };
		const merged = anchor(column(renderDashboardMain(SNAPSHOT, board, NOW), "working"), 'data-card="w1:p1"');
		expect(merged).toContain('<b class="tw">판정 대기</b>');
		expect(merged).not.toContain(">진행 중</b>");
	});

	test("AC-5: ?card=, ?task= and ?view= start the page with that detail or view; unknown values say so", async () => {
		const opened = renderDashboardPage(SNAPSHOT, { board: BOARD, card: "w1:p1" });
		expect(opened).toContain('<aside id="detail" class="detail is-open"');
		expect(opened).toContain("pane w1:p1");
		expect(opened).toContain("task/T-20261104-50");

		const base = serve();
		const lone = await (await fetch(`${base}/?task=T-20261104-51`)).text();
		expect(lone).toContain('<aside id="detail" class="detail is-open" aria-label="TASK 상세"');
		const detail = lone.slice(lone.indexOf('<aside id="detail"'));
		expect(detail).toContain("task/T-20261104-51");
		expect(detail).toContain("AC 1/2");
		expect(detail).toContain("단계 0/3");
		expect(detail).toContain("오너 결정");
		const checks = /<ol class="checks" aria-label="AC 체크 목록">([\s\S]*?)<\/ol>/.exec(detail)?.[1] ?? "";
		const rows = [
			...checks.matchAll(
				/<li class="([^"]*)"><span class="badge [^"]*">([^<]+)<\/span><span><b>([^<]+)<\/b> ([^<]*)<\/span><\/li>/g,
			),
		];
		expect(rows.map((match) => match.slice(1))).toEqual([
			["is-done", "충족", "AC-1", "첫 &lt;기준&gt;"],
			["", "미충족", "AC-2", "둘째 기준"],
		]);
		const steps = /<ol class="checks" aria-label="단계 목록">([\s\S]*?)<\/ol>/.exec(detail)?.[1] ?? "";
		expect([...steps.matchAll(/<b>(S\d)<\/b> ([^<]*)/g)].map((match) => `${match[1]} ${match[2]}`)).toEqual([
			"S1 준비",
			"S2 구현",
			"S3 검증",
		]);
		// The agent card's detail draws the same list for its TASK.
		const merged = SNAPSHOT.tasks.ok ? SNAPSHOT.tasks.items[0] : undefined;
		if (merged === undefined) throw new Error("no fixture task");
		const onCard = renderDashboardPage(
			{
				...SNAPSHOT,
				tasks: { ok: true, items: [{ ...merged, acceptance: [{ id: "AC-1", text: "카드 기준", checked: false }] }] },
			},
			{ board: BOARD, card: "w1:p1" },
		);
		expect(onCard.slice(onCard.indexOf('<aside id="detail"'))).toMatch(
			/aria-label="AC 체크 목록"><li class=""><span class="badge [^"]*">미충족<\/span><span><b>AC-1<\/b> 카드 기준/,
		);

		const approvals = await (await fetch(`${base}/?view=approvals`)).text();
		expect(approvals).toMatch(/data-view="approvals"[^>]*aria-current="page"/);
		expect(approvals).toContain("push to main");
		expect(approvals).toMatch(/<nav class="crumbs"[^>]*>.*승인 대기<\/span><\/nav>/);

		const bogus = await (await fetch(`${base}/?view=nope`)).text();
		expect(bogus).toContain("모르는 보기");
		expect(bogus).toMatch(/data-view="inbox"[^>]*aria-current="page"/);
		const unknownTask = await (await fetch(`${base}/?task=T-19990101-01`)).text();
		expect(unknownTask).toContain("지금 목록에 없는 TASK");
		expect(unknownTask).toMatch(/data-view="inbox"[^>]*aria-current="page"/);
	});

	test("AC-6: ?view=list draws one table, 내 차례 → 진행 중 → 읽을 것 → 확인함", async () => {
		const html = await (await fetch(`${serve()}/?view=list`)).text();
		const head = /<thead>([\s\S]*?)<\/thead>/.exec(html)?.[1] ?? "";
		expect([...head.matchAll(/<th[^>]*>(?:<button[^>]*>)?([^<]+)/g)].map((match) => match[1])).toEqual([
			"상태",
			"제목",
			"머신",
			"TASK",
			"AC",
			"경과",
		]);
		const order = [...html.matchAll(/<tr[^>]*data-row="([^"]+)"/g)].map((match) => match[1]);
		// The TASK in review waits for the owner's decision: 내 차례, after the failed one.
		expect(order).toEqual(["T-20261104-51", "T-20261104-52", "T-20261104-50"]);

		const board = renderDashboardMain(SNAPSHOT, BOARD, NOW, { view: "list" });
		const keys = [...board.matchAll(/<tr[^>]*data-row="([^"]+)"/g)].map((match) => match[1]);
		// 내 차례 in the one order: failed (worker gone), blocked, the decision; a pane with no TASK is 확인함.
		expect(keys).toEqual(["T-20261104-51", "w1:p2", "T-20261104-52", "w1:p1", "m-ssh:w9:p1", "m-ssh:w9:p2"]);
	});

	test("AC-1 순번: failed first, then blocked by longest wait, then no agent card; the column and order-no agree", () => {
		const snapshot: DashboardSnapshot = {
			...SNAPSHOT,
			tasks: {
				ok: true,
				items: [
					task("T-20261104-60", {
						error: "문서 판정 실패: outcome.md 없음",
						progress: { status: "working", updated: "2026-11-04T09:58:00+09:00", current: "S2", blockedReason: "" },
					}),
					task("T-20261104-61", {
						progress: { status: "working", updated: "2026-11-04T09:00:00+09:00", current: "S1", blockedReason: "" },
					}),
				],
			},
		};
		const board: BoardView = {
			...BOARD,
			cards: [
				card("w2:b10", "blocked", "attention", { since: NOW - 10 * 60_000 }),
				card("w2:b30", "blocked", "attention", { since: NOW - 30 * 60_000 }),
			],
		};
		const expected = ["T-20261104-60", "w2:b30", "w2:b10", "T-20261104-61"];
		expect(inboxAttention(snapshot, board).map((entry) => entry.id)).toEqual(expected);
		const attention = column(renderDashboardMain(snapshot, board, NOW), "mine");
		expect([...attention.matchAll(/data-row="([^"]+)"/g)].map((match) => match[1])).toEqual(expected);
		expect([...attention.matchAll(/data-row="([^"]+)" data-order="(\d)"/g)].map((m) => `${m[2]}:${m[1]}`)).toEqual(
			expected.map((id, index) => `${index + 1}:${id}`),
		);
		expect([...attention.matchAll(/<span class="order-no">(\d)<\/span>/g)].map((match) => match[1])).toEqual([
			"1",
			"2",
			"3",
			"4",
		]);
	});
});

describe("dashboard: Discord", () => {
	const DISCORD_DM = "discord/dm/123456789012345678";
	const turns = SNAPSHOT.turns.ok ? SNAPSHOT.turns : undefined;
	const thread = turns?.threads[0];
	if (turns === undefined || thread === undefined) throw new Error("no fixture thread");
	const running = (heartbeat: Record<string, unknown>): DashboardSnapshot => ({
		...SNAPSHOT,
		daemon: {
			ok: true,
			running: true,
			ompVersion: "1",
			origins: 1,
			busy: 0,
			ledger: { pending: 0, inflight: 0, confirmed: 0, ambiguous: 0, expired: 0 },
			inbound: { pending: 0, dispatched: 0, answered: 0, failed_notified: 0, discarded: 0, uncertain: 0 },
			monitors: { count: 0, next: null },
			openGates: [],
			heartbeat: { at: "2026-11-04T09:59:50+09:00", ageMs: 10_000, ...heartbeat },
		},
	});
	const systemCards = (html: string): string[] =>
		[...html.matchAll(/class="sys-card[^"]*" data-card="([a-z]+)"/g)].map((match) => match[1] ?? "");
	const sysCard = (html: string, id: string): string => {
		const start = html.indexOf(`data-card="${id}"`);
		return html.slice(start, html.indexOf("</section>", start));
	};

	test("a Discord DM conversation is labelled DM on its card", () => {
		const html = renderDashboardMain(
			{ ...SNAPSHOT, turns: { ...turns, threads: [{ ...thread, originKey: DISCORD_DM }] } },
			BOARD,
			NOW,
			{ view: "turns" },
		);
		const at = html.indexOf(`data-row="${DISCORD_DM}"`);
		expect(at).toBeGreaterThan(-1);
		const start = html.indexOf('<p class="card-eyebrow">', at);
		expect(html.slice(start, html.indexOf("</p>", start))).toContain("<span>DM</span>");
	});

	test("the system view has a Discord card showing up or down right after the daemon's", () => {
		const up = renderDashboardMain(
			running({ discord: { state: "up", since: "2026-11-04T09:30:00+09:00" } }),
			BOARD,
			NOW,
			{ view: "system" },
		);
		expect(systemCards(up).slice(0, 2)).toEqual(["daemon", "discord"]);
		expect(sysCard(up, "discord")).toContain("연결");
		expect(sysCard(up, "discord")).toContain("is-success");

		const down = renderDashboardMain(
			running({ discord: { state: "down", since: "2026-11-04T09:55:00+09:00" } }),
			BOARD,
			NOW,
			{ view: "system" },
		);
		expect(sysCard(down, "discord")).toContain("끊김");
		expect(sysCard(down, "discord")).toContain("is-danger");
	});

	test("an install without Discord has no Discord card", () => {
		const html = renderDashboardMain(running({}), BOARD, NOW, { view: "system" });
		expect(systemCards(html)).not.toContain("discord");
		expect(systemCards(html)).not.toContain("slack");
	});
});

describe("dashboard polish", () => {
	const luminance = (hex: string): number => {
		const raw = hex.replace("#", "");
		const [r, g, b] = [0, 2, 4].map((offset) => {
			const c = Number.parseInt(raw.slice(offset, offset + 2), 16) / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		}) as [number, number, number];
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const contrast = (fg: string, bg: string): number => {
		const l1 = luminance(fg);
		const l2 = luminance(bg);
		return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
	};
	const varsOf = (block: string): Record<string, string> =>
		Object.fromEntries([...block.matchAll(/(--c-[a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));

	test("AC-2: light and dark theme body text tokens have >= 4.5:1 contrast on surface and bg", () => {
		const lightBlock = /:root,\s*:root\[data-theme="light"\]\s*\{([^}]*)\}/.exec(STYLE)?.[1] ?? "";
		const darkBlock = /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(STYLE)?.[1] ?? "";
		const light = varsOf(lightBlock);
		const dark = varsOf(darkBlock);
		for (const palette of [light, dark]) {
			const surface = palette["--c-surface"] ?? "";
			const bg = palette["--c-bg"] ?? "";
			for (const token of ["--c-text-1", "--c-text-2", "--c-text-3", "--c-brand-text"]) {
				const fg = palette[token] ?? "";
				expect(contrast(fg, surface)).toBeGreaterThanOrEqual(4.5);
				expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
			}
			for (const kind of ["danger", "success", "warning", "info"]) {
				expect(
					contrast(palette[`--c-${kind}-tint-text`] ?? "", palette[`--c-${kind}-tint`] ?? ""),
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	test("SVG icons, theme toggles, command palette, shortcut help, copy buttons and empty/error next actions", () => {
		const page = renderDashboardPage(SNAPSHOT, { board: BOARD, card: "w1:p1" });
		expect(page).toContain('<svg class="ico nav-ico"');
		expect(page).toContain('<svg class="ico state-ico"');
		expect(page).toContain('data-theme-set="system" aria-pressed="true"');
		expect(page).toContain('data-theme-set="light" aria-pressed="false"');
		expect(page).toContain('data-theme-set="dark" aria-pressed="false"');
		expect(page).toContain('id="cmd-palette"');
		expect(page).toContain('id="kb-help"');
		expect(page).toContain('class="hint-bar"');
		expect(page).toContain('data-copy="T-20261104-50"');
		expect(page).toContain('data-copy="task/T-20261104-50"');

		const noMatch = renderDashboardMain(SNAPSHOT, BOARD, NOW, { q: "없는검색어123" });
		expect(noMatch).toContain("'없는검색어123'와 맞는 항목이 없어요.");
		expect(noMatch).toContain("data-clear-search");
		// A search dims the rows it leaves out instead of dropping them, so the groups keep their place.
		expect(noMatch).toContain('id="col-working"');
		expect(noMatch).toMatch(/class="card trow is-working is-dim"[^>]*data-card="w1:p1"/);

		const down = renderDashboardMain(
			{
				...SNAPSHOT,
				daemon: {
					ok: true,
					running: false,
					ompVersion: "1",
					origins: 0,
					busy: 0,
					ledger: { pending: 0, inflight: 0, confirmed: 0, ambiguous: 0, expired: 0 },
					inbound: { pending: 0, dispatched: 0, answered: 0, failed_notified: 0, discarded: 0, uncertain: 0 },
					monitors: { count: 0, next: null },
					openGates: [],
				},
			},
			{ ok: false, error: "herdr_unreachable" },
			NOW,
		);
		expect(down).toContain("데몬 꺼짐");
		expect(down).toContain("systemctl --user status jabbu");
		expect(down).toContain("에이전트 보드 연결 안 됨");
		expect(down).toContain("herdr-web-ui 서비스");
		expect(STYLE).toContain("@media (prefers-reduced-motion: reduce)");
	});

	test("UX QA fixes: sticky detail tabs/title, contextual Board/List, non-gate alert records, system search, closed task AC and nested markdown ol", () => {
		// UX-001: sticky #detail-tabs and #detail-bar-title shown on non-head tabs (e.g. turns conversation tab).
		const turnPage = renderDashboardPage(SNAPSHOT, { view: "turns", item: "discord/dm/200000000000000001" });
		expect(turnPage).toContain('<span id="detail-bar-title" class="detail-bar-title">인박스 셸 손봐 줘</span>');
		const cardPage = renderDashboardPage(SNAPSHOT, { board: BOARD, card: "w1:p1" });
		expect(cardPage).toContain('<span id="detail-bar-title" class="detail-bar-title" hidden>pane w1:p1</span>');
		expect(STYLE).toMatch(/\.tabs\s*\{[^}]*position:\s*sticky/);

		// UX-002: g f, the Command Palette and the side nav all reach the flow view.
		const fullPage = renderDashboardPage(SNAPSHOT, { board: BOARD });
		expect(SCRIPT).toContain('label: "보기: 흐름"');
		expect(SCRIPT).toContain('f: "flow"');
		expect(fullPage).toContain('data-view="flow"');

		// UX-003: Board | List segmented control appears only on inbox, list, and turns views.
		for (const v of ["inbox", "list", "turns"]) {
			expect(renderDashboardMain(SNAPSHOT, BOARD, NOW, { view: v })).toContain('data-layout="board"');
		}
		for (const v of ["monitors", "alerts", "system", "lanes", "approvals", "flow"]) {
			expect(renderDashboardMain(SNAPSHOT, BOARD, NOW, { view: v })).not.toContain('data-layout="board"');
		}

		// UX-004: non-gate alert records (gateState === undefined) read 기록만 남음 without warning tone.
		const alertsHtml = renderDashboardMain(SNAPSHOT, BOARD, NOW, { view: "alerts" });
		expect(alertsHtml).toContain("기록만 남음");
		expect(alertsHtml).not.toContain(">상태 모름<");
		expect(renderItemDetail(SNAPSHOT, "alerts", "1")).toContain("기록만 남음 · 기록 alerted");

		// UX-005: system view filters by q and shows empty-box when nothing matches; active q shows clear button in head.
		const sysHit = renderDashboardMain(SNAPSHOT, BOARD, NOW, { view: "system", q: "백업" });
		expect(sysHit).toContain('data-card="backup"');
		expect(sysHit).not.toContain('data-card="ledger"');
		expect(sysHit).toContain("data-clear-search");
		const sysMiss = renderDashboardMain(SNAPSHOT, BOARD, NOW, { view: "system", q: "없는시스템항목" });
		expect(sysMiss).toContain("'없는시스템항목'와 맞는 항목이 없어요.");

		// UX-006: closed task detail displays AC count without -/N or 0% meter; nested markdown <ol> preserves top-level numbering.
		const closedDetail = renderTaskDetail(
			"T-20261103-09",
			task("T-20261103-09", { title: "어제 닫힘", status: "done", open: false, acTotal: 7 }),
		);
		expect(closedDetail).toContain('<p class="lead">AC 7개</p>');
		expect(closedDetail).toContain("<dt>AC 충족</dt><dd>7개</dd>");
		expect(closedDetail).not.toContain("-/7");
		const md = renderMarkdown("1. 첫 단계\n   - 하위 A\n   - 하위 B\n2. 둘째 단계");
		expect(md).toContain('<li class="md-d0">첫 단계</li>');
		expect(md).toContain('<li class="md-d1">하위 A</li>');
		expect(md).toContain('<li class="md-d0" value="2">둘째 단계</li>');
	});

	test("unreachable board banner shows configured herdrBoard.api origin or default 127.0.0.1:7317", async () => {
		for (const { api, expected } of [
			{ api: "http://127.0.0.1:7319", expected: "127.0.0.1:7319" },
			{ api: undefined, expected: "127.0.0.1:7317" },
		]) {
			const source = boardSourceFor({ herdrBoard: { url: SELF, ...(api === undefined ? {} : { api }) } });
			if (source === undefined) throw new Error("expected board source");
			const server = startDashboardServer({
				port: 0,
				hostname: "127.0.0.1",
				snapshot: async () => SNAPSHOT,
				board: { source, tasks: () => [] },
			});
			try {
				const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
				expect(html).toContain("에이전트 보드 연결 안 됨");
				expect(html).toContain(`herdr-web-ui 서비스(${expected})`);
			} finally {
				server.stop(true);
			}
		}
	});
});
