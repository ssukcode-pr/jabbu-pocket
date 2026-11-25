import { describe, expect, test } from "bun:test";
import type { BoardCard, BoardView } from "../src/dashboard/board";
import { type InboxEntry, inboxEntries, tabSignal } from "../src/dashboard/inbox";
import { renderDashboardMain } from "../src/dashboard/main-view";
import type { DashboardSnapshot, TaskInfo } from "../src/dashboard/snapshot";
import { DIFF_TOO_LARGE_UNMET, taskTurnFields, turnOf } from "../src/dashboard/turn";
import { type CommitCheck, checkTask, digest } from "../src/tasks/checker";
import { acceptanceItems, renderSpec } from "../src/tasks/docs";
import type { TaskRow } from "../src/tasks/ledger";

const NOW = Date.parse("2026-11-25T03:00:00Z");

const task = (taskId: string, extra: Partial<TaskInfo> = {}): TaskInfo => ({
	taskId,
	title: `title ${taskId}`,
	risk: "L3",
	status: "working",
	host: "local",
	agent: taskId.toLowerCase(),
	branch: `task/${taskId}`,
	open: true,
	updatedAt: "2026-11-25T11:00:00+09:00",
	acTotal: 3,
	herdr: { ok: true, status: "working" },
	...extra,
});

const card = (key: string, status: string, column: BoardCard["column"], extra: Partial<BoardCard> = {}): BoardCard => ({
	key,
	local: true,
	machineId: "local",
	machineName: "oci",
	paneId: key,
	workspaceId: "w1",
	workspaceLabel: "main",
	tabLabel: "tab",
	paneLabel: `pane ${key}`,
	name: `agent-${key}`,
	agent: "omp",
	status,
	column,
	unknown: false,
	since: NOW - 60_000,
	cwd: "/srv/work",
	...extra,
});

const lone = (info: TaskInfo): InboxEntry => ({
	id: info.taskId,
	kind: "task",
	col: "done",
	since: NOW,
	title: info.title,
	machine: info.host,
	taskId: info.taskId,
	task: info,
});

const paned = (pane: BoardCard, info?: TaskInfo): InboxEntry => ({
	id: pane.key,
	kind: "card",
	col: "done",
	since: pane.since,
	title: info?.title ?? pane.paneLabel,
	machine: pane.machineName,
	taskId: info?.taskId ?? "",
	card: pane,
	...(info === undefined ? {} : { task: info }),
});

// The table of the plan, each row against the value the daemon writes: `judge` from the sweep's notices
// (src/tasks/sweeper.ts nudge/nudgecap, src/tasks/checker.ts pendingChecks), `land.state` from `tasks.land_json`.
describe("turnOf: one group per fixed snapshot", () => {
	test("판정 막힘 diff too large (judge=diff, last unmet notice) → 내 차례", () => {
		const turn = turnOf(lone(task("T-1", { judge: "diff" })));
		expect(turn.group).toBe("mine");
		expect(turn.word).toBe("판정 막힘");
		expect(turn.mark).toBe("!");
		expect(`${turn.line} ${turn.reason}`).not.toContain("diff too large");
	});

	test("판정 막힘 nudgecap (judge=nudgecap) → 내 차례", () => {
		expect(turnOf(lone(task("T-2", { judge: "nudgecap" }))).group).toBe("mine");
	});

	test("질문 멈춤 (blocked + PROGRESS question) → 내 차례, the question is the first line", () => {
		const turn = turnOf(
			lone(task("T-3", { status: "blocked", decision: { question: "A안과 B안 중 무엇으로 갈까요?" } })),
		);
		expect(turn).toMatchObject({ group: "mine", word: "질문", line: "A안과 B안 중 무엇으로 갈까요?" });
	});

	test("질문 멈춤 (pane blocked on an ask question) → 내 차례", () => {
		const pane = card("p1", "blocked", "attention", { question: "계속할까요?" });
		expect(turnOf(paned(pane, task("T-4", { status: "working" })))).toMatchObject({
			group: "mine",
			word: "질문",
			line: "계속할까요?",
		});
	});

	test("오너 결정 review (status review, no land, no gate) → 내 차례", () => {
		expect(turnOf(lone(task("T-5", { status: "review" })))).toMatchObject({ group: "mine", word: "결정 대기" });
	});

	test("PR 착지 중 review (land.state=active) → 진행 중", () => {
		const turn = turnOf(lone(task("T-6", { status: "review", land: "active" })));
		expect(turn).toMatchObject({ group: "working", word: "착지 중", mark: "spin" });
	});

	test("게이트 진행 중 review (gate=running) → 진행 중", () => {
		expect(turnOf(lone(task("T-7", { status: "review", gate: "running" }))).group).toBe("working");
	});

	test("판정 대기 pendingChecks (judge=pending) → 진행 중", () => {
		const turn = turnOf(lone(task("T-8", { judge: "pending", herdr: { ok: true, status: "done" } })));
		expect(turn).toMatchObject({ group: "working", word: "판정 대기" });
	});

	test("완료 + 안 읽음 (pane done, unread) → 읽을 것", () => {
		const entry = paned(card("p2", "done", "done", { lastSay: "끝났습니다" }));
		expect(turnOf(entry, true)).toMatchObject({ group: "read", mark: "dot", word: "완료", reason: "끝났습니다" });
	});

	test("그 밖 (pane done and read, or idle) → 확인함", () => {
		expect(turnOf(paned(card("p3", "done", "done"))).group).toBe("done");
		expect(turnOf(paned(card("p4", "idle", "idle")), true).group).toBe("done");
	});

	test("a read 내 차례 question stays 내 차례", () => {
		const entry = lone(task("T-9", { status: "blocked", decision: { question: "어느 쪽?" } }));
		expect(turnOf(entry, true).group).toBe("mine");
		expect(turnOf(entry, false).group).toBe("mine");
	});

	test("inboxEntries stores the group turnOf gives without read marks", () => {
		const s = {
			tasks: { ok: true, items: [task("T-10", { judge: "diff" }), task("T-11", { status: "review", land: "active" })] },
			herdr: { ok: true, hosts: [] },
		} as unknown as DashboardSnapshot;
		expect(inboxEntries(s).map((entry) => [entry.id, entry.col])).toEqual([
			["T-10", "mine"],
			["T-11", "working"],
		]);
	});
});

const off = { ok: false as const, error: "not in this test" };
const snapshotOf = (items: TaskInfo[]): DashboardSnapshot => ({
	generatedAt: "2026-11-25T12:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: off,
	turns: off,
	tasks: { ok: true, items },
	lanes: off,
	herdr: { ok: true, hosts: [] },
	approvals: off,
	monitors: off,
	alerts: off,
	gates: off,
	backup: off,
	jobs: off,
});
const boardOf = (cards: BoardCard[]): BoardView => ({
	ok: true,
	generatedAt: NOW,
	machines: [{ id: "local", name: "oci", connected: true }],
	cards,
});
/** One `<a …>` row of the inbox by its `data-row`. */
const rowHtml = (html: string, id: string): string => {
	const at = html.indexOf(`data-row="${id}"`);
	if (at < 0) throw new Error(`no row ${id}`);
	return html.slice(html.lastIndexOf("<a ", at), html.indexOf("</a>", at) + 4);
};
const groupIds = (html: string, id: string): string[] => {
	const start = html.indexOf(`id="col-${id}"`);
	const section = html.slice(start, html.indexOf("</section>", start));
	return [...section.matchAll(/<a class="card trow[^"]*"[^>]*data-row="([^"]+)"/g)].map((m) => m[1] ?? "");
};

const BRIEF = "너는 T-20261125-31 담당이다. 작업 디렉터리는 /srv/work 이다";
const MIXED_SNAPSHOT = snapshotOf([
	task("T-20261125-31", { status: "blocked", decision: { question: "A안으로 갈까요?" } }),
	task("T-20261125-32", {
		judge: "diff",
		progress: { status: "working", updated: "", current: "diff too large 반복", blockedReason: "" },
	}),
	task("T-20261125-33", { status: "review", land: "active" }),
	task("T-20261125-34", { herdr: { ok: true, status: "working" } }),
]);
const MIXED_BOARD = boardOf([
	card("p31", "idle", "idle", { taskId: "T-20261125-31", lastPrompt: { preview: BRIEF, at: NOW, kind: "start" } }),
	card("p32", "idle", "idle", { taskId: "T-20261125-32", lastPrompt: { preview: BRIEF, at: NOW, kind: "remind" } }),
	card("p33", "idle", "idle", { taskId: "T-20261125-33" }),
	card("p34", "working", "working", { taskId: "T-20261125-34" }),
	card("pd", "done", "done", { lastSay: "끝냈습니다." }),
	card("pi", "idle", "idle"),
]);

describe("the inbox draws turnOf only", () => {
	test("AC-2: a read 내 차례 question stays in 내 차례; reading only turns its unread dot off", () => {
		const unread = renderDashboardMain(MIXED_SNAPSHOT, MIXED_BOARD, NOW, { unread: ["p31"] });
		const read = renderDashboardMain(MIXED_SNAPSHOT, MIXED_BOARD, NOW, { unread: [] });
		expect(groupIds(unread, "mine")).toContain("p31");
		expect(groupIds(read, "mine")).toContain("p31");
		expect(rowHtml(unread, "p31")).toContain('class="unread-dot"');
		expect(rowHtml(read, "p31")).not.toContain("unread-dot");
		expect(rowHtml(read, "p31").replace(/ data-order="\d"|<span class="order-no">\d<\/span>/g, "")).toBe(
			rowHtml(unread, "p31")
				.replace(/<span class="unread-dot"[^>]*><\/span>/, "")
				.replace(/ data-order="\d"|<span class="order-no">\d<\/span>/g, ""),
		);
		expect(rowHtml(read, "p31")).toContain('<span class="t1"><span class="order-no">');
		expect(rowHtml(read, "p31")).toContain("A안으로 갈까요?</span>");
	});

	test("AC-3: the inbox and the list show the same groups and counts; 확인 필요 is the 내 차례 row count", () => {
		for (const unread of [[], ["pd"]]) {
			const inbox = renderDashboardMain(MIXED_SNAPSHOT, MIXED_BOARD, NOW, { unread });
			const list = renderDashboardMain(MIXED_SNAPSHOT, MIXED_BOARD, NOW, { view: "list", unread });
			const sumOf = (html: string): string => /<p class="badges group-sum">[\s\S]*?<\/p>/.exec(html)?.[0] ?? "";
			expect(sumOf(inbox)).not.toBe("");
			expect(sumOf(list)).toBe(sumOf(inbox));
			const listGroups = (group: string): string[] =>
				[...list.matchAll(new RegExp(`<tr data-row="([^"]+)"[^>]*class="is-${group}[ "]`, "g"))].map((m) => m[1] ?? "");
			for (const group of ["mine", "working", "read", "done"]) {
				const rows = groupIds(inbox, group);
				expect([group, listGroups(group).sort()]).toEqual([group, rows.slice().sort()]);
				expect(sumOf(inbox)).toContain(`href="#col-${group}">`);
				expect(sumOf(inbox)).toMatch(new RegExp(`#col-${group}">[^<]+ <b>${rows.length}</b>`));
			}
			const mine = groupIds(inbox, "mine").length;
			expect(mine).toBe(2);
			expect(inbox).toContain(`<span class="view-sum">확인 필요 <b>${mine}</b></span>`);
			expect(tabSignal(MIXED_SNAPSHOT, MIXED_BOARD, false).count).toBe(mine);
		}
		const read = renderDashboardMain(MIXED_SNAPSHOT, MIXED_BOARD, NOW, { unread: ["pd"] });
		expect(groupIds(read, "read")).toEqual(["pd"]);
		expect(groupIds(read, "done")).toEqual(["pi"]);
	});

	test("AC-4: no row renders a worker brief or the judge's 'diff too large'", () => {
		for (const view of ["inbox", "list"]) {
			const html = renderDashboardMain(MIXED_SNAPSHOT, MIXED_BOARD, NOW, { view, unread: ["pd"] });
			const rows = [...html.matchAll(/<(a|tr) [^>]*data-row="[^"]+"[\s\S]*?<\/\1>/g)].map((m) => m[0]).join("\n");
			expect(rows).toContain("T-20261125-32");
			expect(rows).not.toContain("diff too large");
			expect(rows).not.toContain("너는 T-");
			expect(html).not.toContain("diff too large");
			expect(html).not.toContain(BRIEF);
		}
		const stuck = rowHtml(renderDashboardMain(MIXED_SNAPSHOT, MIXED_BOARD, NOW), "p32");
		expect(stuck).toContain('<b class="tw">판정 막힘</b>');
	});
});

const row = (extra: Partial<TaskRow> = {}): TaskRow =>
	({
		taskId: "T-20261125-99",
		status: "working",
		repo: "local:/srv/work/demo-repo",
		createdAt: NOW - 3_600_000,
		notices: {},
		workerModel: null,
		gate: null,
		land: null,
		...extra,
	}) as TaskRow;
const judged = (reached: boolean, question = "") => ({
	reached,
	decision: { question, recommend: "", impact: "", fallbackOk: false },
});

describe("taskTurnFields: the ledger values behind judge, land and gate", () => {
	test("the diff-too-large unmet key is the one checkTask's judgement digests", async () => {
		const meta = {
			taskId: "T-20261125-99",
			hostLabel: "local",
			repo: "/w/repo",
			worktree: "/w/repo-T",
			branch: "task/T-20261125-99",
			agent: "t-20261125-99",
			threadLink: "x",
			registeredAt: 0,
			timezone: "Asia/Seoul",
		};
		const snapshot = acceptanceItems(["기준"]);
		const spec = renderSpec(
			meta,
			{ title: "t", risk: "L2", goal: "g", scope: [], exclusions: [], acceptance: [], repo: meta.repo },
			snapshot,
		).replaceAll("- [ ] AC-", "- [x] AC-");
		const progress = `---\ntask: ${meta.taskId}\nstatus: working\nupdated: 2026-11-25T10:00:00+09:00\ncurrent: S1\nnext: x\nblocked_reason: \n---\n# 단계\n- [x] S1: a | 완료 조건: b | 증거: test\n`;
		const judgement = await checkTask({
			snapshot,
			spec,
			progress,
			outcome: "## AC-1\n- test: bun test → 5 pass 0 fail\n",
			commitCheck: async (): Promise<CommitCheck> => "ok",
			integrity: async () => ({ error: "diff too large" }),
		});
		expect(`unmet:${digest(judgement.problems)}`).toBe(DIFF_TOO_LARGE_UNMET);
	});

	test("judge: diff from the last unmet since the nudge base, nudgecap, pending from a met judgement", () => {
		const at = NOW - 60_000;
		expect(taskTurnFields(row({ notices: { [DIFF_TOO_LARGE_UNMET]: at } }), judged(true)).judge).toBe("diff");
		const newer = { [DIFF_TOO_LARGE_UNMET]: at - 10, "unmet:000000000000": at };
		expect(taskTurnFields(row({ notices: newer }), judged(false)).judge).toBeUndefined();
		const resumed = { [DIFF_TOO_LARGE_UNMET]: at - 10, [`resume:${at}`]: at };
		expect(taskTurnFields(row({ notices: resumed }), judged(true)).judge).toBe("pending");
		const created = NOW - 3_600_000;
		expect(taskTurnFields(row({ notices: { [`nudgecap:${created}`]: at } }), judged(false)).judge).toBe("nudgecap");
		expect(taskTurnFields(row(), judged(true)).judge).toBe("pending");
		expect(taskTurnFields(row({ status: "blocked" }), judged(true)).judge).toBeUndefined();
	});

	test("repo, worker model, land state, decision question and a gate start newer than its receipt", () => {
		const review = row({
			status: "review",
			workerModel: "glm/glm-5.4:high",
			land: { state: "active" } as TaskRow["land"],
			notices: { "gate:abc123:rt0:review:1": NOW },
			gate: { review: { at: NOW - 10 } } as TaskRow["gate"],
		});
		expect(taskTurnFields(review, judged(true, "머지할까요?"))).toEqual({
			repo: "demo-repo",
			workerModel: "glm/glm-5.4:high",
			land: "active",
			decision: { question: "머지할까요?" },
			gate: "running",
		});
		const done = row({
			status: "review",
			notices: { "gate:abc123:rt0:review:1": NOW - 10 },
			gate: { review: { at: NOW } } as TaskRow["gate"],
		});
		expect(taskTurnFields(done, undefined).gate).toBeUndefined();
	});
});
