// T-20261125-08 item 2: sessions that edit the same file (15 min) or the same checkout (10 min).
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findOverlaps,
	type OverlapSession,
	overlapView,
	readEditOverlaps,
	readWrites,
} from "../src/dashboard/edit-overlap";
import { SCRIPT } from "../src/dashboard/html";
import { inboxAttention } from "../src/dashboard/inbox";
import { renderDashboardMain } from "../src/dashboard/main-view";
import type { DashboardSnapshot, TaskInfo, ThreadInfo } from "../src/dashboard/snapshot";
import { turnOf } from "../src/dashboard/turn";

const NOW = Date.parse("2026-11-25T03:00:00Z");
const MIN = 60_000;

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "edit-overlap-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

type Call = { tool: string; at: number; path?: string; paths?: string[]; command?: string };

/** A session jsonl whose assistant messages hold one tool call each, as omp writes them. */
function session(name: string, calls: Call[]): string {
	const file = join(root, `${name}.jsonl`);
	const lines = calls.map((call, index) =>
		JSON.stringify({
			type: "message",
			id: `${name}${index}`,
			timestamp: new Date(call.at).toISOString(),
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: `c${index}`,
						name: call.tool,
						arguments: call.command === undefined ? { path: call.path, paths: call.paths } : { command: call.command },
					},
				],
			},
		}),
	);
	writeFileSync(file, `${lines.join("\n")}\n`);
	utimesSync(file, NOW / 1000, NOW / 1000); // the fake clock: the file was last written "now"
	return file;
}

/** A plain checkout (`.git` directory) or a linked worktree (`.git` file) holding `src/`. */
function checkout(name: string, worktree: boolean): string {
	const dir = join(root, name);
	mkdirSync(join(dir, "src"), { recursive: true });
	if (worktree) writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
	else mkdirSync(join(dir, ".git"));
	return dir;
}

const turn = (id: string, file: string, kind: OverlapSession["kind"] = "turn"): OverlapSession => ({
	id,
	kind,
	name: `n-${id}`,
	file,
});

describe("findOverlaps", () => {
	test("the same path written by two sessions within 15 minutes is a file overlap", () => {
		const repo = checkout("repo", false);
		const path = join(repo, "src/a.ts");
		const a = session("a", [{ tool: "edit", at: NOW - 14 * MIN, path }]);
		const b = session("b", [{ tool: "write", at: NOW - MIN, path }]);
		const found = findOverlaps([turn("a", a), turn("b", b)], NOW);
		expect(found.find((o) => o.kind === "file")).toMatchObject({ key: path });
		expect(found.find((o) => o.kind === "file")?.sessions.map((s) => s.id)).toEqual(["a", "b"]);
	});

	test("a write 16 minutes ago is no overlap", () => {
		const repo = checkout("repo", false);
		const path = join(repo, "src/a.ts");
		const a = session("a", [{ tool: "edit", at: NOW - 16 * MIN, path }]);
		const b = session("b", [{ tool: "edit", at: NOW - MIN, path }]);
		expect(findOverlaps([turn("a", a), turn("b", b)], NOW)).toEqual([]);
	});

	test("different worktrees are no repository overlap, even for the same relative file", () => {
		const one = checkout("wt1", true);
		const two = checkout("wt2", true);
		const a = session("a", [{ tool: "edit", at: NOW - MIN, path: join(one, "src/a.ts") }]);
		const b = session("b", [{ tool: "edit", at: NOW - MIN, path: join(two, "src/a.ts") }]);
		expect(findOverlaps([turn("a", a, "lane"), turn("b", b, "lane")], NOW)).toEqual([]);
	});

	test("two sessions in the same checkout overlap by repository, within 10 minutes only", () => {
		const repo = checkout("repo", false);
		const a = session("a", [{ tool: "edit", at: NOW - 9 * MIN, path: join(repo, "src/a.ts") }]);
		const b = session("b", [{ tool: "ast_edit", at: NOW - MIN, paths: [join(repo, "src/b.ts")] }]);
		const late = session("c", [{ tool: "edit", at: NOW - 11 * MIN, path: join(repo, "src/c.ts") }]);
		const found = findOverlaps([turn("a", a), turn("b", b), turn("c", late)], NOW);
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ kind: "repo", key: repo });
		expect(found[0]?.sessions.map((s) => s.id)).toEqual(["a", "b"]);
	});

	test("bash and relative paths are not counted; a group of TASKs only is left to the sweeper", () => {
		const repo = checkout("repo", false);
		const path = join(repo, "src/a.ts");
		const a = session("a", [
			{ tool: "bash", at: NOW - MIN, command: `echo > ${path}` },
			{ tool: "edit", at: NOW - MIN, path: "src/a.ts" },
		]);
		const b = session("b", [{ tool: "edit", at: NOW - MIN, path }]);
		const c = session("c", [{ tool: "edit", at: NOW - MIN, path }]);
		expect(findOverlaps([turn("a", a), turn("b", b)], NOW)).toEqual([]);
		expect(findOverlaps([turn("t1", b, "task"), turn("t2", c, "task")], NOW)).toEqual([]);
		expect(findOverlaps([turn("t1", b, "task"), turn("l", c, "lane")], NOW).length).toBeGreaterThan(0);
	});

	test("the git calls are injectable", () => {
		const fake = { writesOf: () => [{ path: "/x/y.ts", at: NOW }], checkoutOf: () => "/x" };
		const found = findOverlaps([turn("a", "/a"), turn("b", "/b")], NOW, fake);
		expect(found.map((o) => [o.kind, o.key])).toEqual([
			["file", "/x/y.ts"],
			["repo", "/x"],
		]);
	});

	test("readWrites skips a file untouched since the window and a missing file", () => {
		const path = join(root, "src.ts");
		const file = session("a", [{ tool: "edit", at: NOW - MIN, path }]);
		expect(readWrites(file, NOW + 24 * 60 * MIN)).toEqual([]);
		expect(readWrites(join(root, "nope.jsonl"), 0)).toEqual([]);
		expect(readWrites(file, 0)).toEqual([{ path, at: NOW - MIN }]);
	});
});

describe("overlapView", () => {
	test("hover lists the path and the others; a TASK keeps one line; agy ids are carried", () => {
		const s = [turn("a", "/a"), turn("t", "/t", "task"), turn("b", "/b", "lane")];
		const view = overlapView(
			[
				{ kind: "file", key: "/r/f.ts", sessions: s },
				{ kind: "repo", key: "/r", sessions: s },
			],
			["agy1"],
		);
		expect(view?.hints.a).toBe("파일 겹침 /r/f.ts ↔ n-t, n-b\n저장소 겹침 /r ↔ n-t, n-b");
		expect(view?.hints.t).toBe("파일 겹침 /r/f.ts ↔ n-a, n-b");
		expect(view?.lines).toEqual(["파일 겹침 /r/f.ts · n-a ↔ n-t ↔ n-b", "저장소 겹침 /r · n-a ↔ n-t ↔ n-b"]);
		expect(view?.agy).toEqual(["agy1"]);
		expect(overlapView([], [])).toBeUndefined();
	});
});

describe("readEditOverlaps", () => {
	test("maps origins, lanes, agy sessions and TASK workers to sessions", async () => {
		const repo = checkout("repo", false);
		const path = join(repo, "src/a.ts");
		const lane = session("lane", [{ tool: "edit", at: NOW - MIN, path }]);
		const chat = session("chat", [{ tool: "edit", at: NOW - 2 * MIN, path }]);
		const worker = session("worker", [{ tool: "write", at: NOW - 3 * MIN, path }]);
		const agyDir = join(root, "agy-dir");
		mkdirSync(agyDir);
		writeFileSync(join(agyDir, "agy-conversation.json"), "{}");
		const db = new Database(join(root, "jabbu.db"), { strict: true });
		db.run("CREATE TABLE origins (origin_key TEXT, session_dir TEXT, session_file TEXT, updated_at INTEGER)");
		db.run("CREATE TABLE lanes (origin_key TEXT, name TEXT, status TEXT)");
		db.run("CREATE TABLE tasks (task_id TEXT, agent TEXT, host TEXT, status TEXT)");
		db.run("INSERT INTO origins VALUES ('slack/dm/1', ?, ?, 2)", [root, chat]);
		db.run("INSERT INTO origins VALUES ('lane/x', ?, ?, 3)", [root, lane]);
		db.run("INSERT INTO origins VALUES ('slack/dm/agy', ?, NULL, 1)", [agyDir]);
		db.run("INSERT INTO lanes VALUES ('lane/x', 'x', 'working')");
		db.run("INSERT INTO tasks VALUES ('T-1', 'w1', NULL, 'working')");
		try {
			const { overlaps } = await readEditOverlaps({
				db,
				now: NOW,
				peers: [],
				threads: [{ originKey: "slack/dm/1", title: "고쳐 줘" }],
				listing: async (host) =>
					host === "local" ? { ok: true, agents: [{ name: "w1", sessionPath: worker }] } : { ok: false },
			});
			expect(overlaps?.agy).toEqual(["slack/dm/agy"]);
			expect(overlaps?.hints["lane/x"]).toContain(`파일 겹침 ${path}`);
			expect(overlaps?.hints["lane/x"]).toContain("고쳐 줘");
			expect(overlaps?.hints["lane/x"]).toContain("TASK T-1");
			expect(overlaps?.hints["task:T-1"]).toContain("레인 x");
			expect(overlaps?.hints["slack/dm/1"]).toContain("레인 x");
			expect(overlaps?.lines.some((line) => line.startsWith(`저장소 겹침 ${repo} `))).toBe(true);
		} finally {
			db.close();
		}
	});

	test("without a database there is nothing to show", async () => {
		expect(
			await readEditOverlaps({ db: undefined, now: NOW, peers: [], threads: [], listing: () => undefined }),
		).toEqual({});
	});
});

describe("display", () => {
	const thread = (originKey: string, title: string): ThreadInfo => ({
		originKey,
		threadRef: null,
		kind: "message",
		title,
		column: "working",
		latest: {
			inboundId: 1,
			state: "dispatched",
			createdAt: "2026-11-25T11:50:00+09:00",
			preview: title,
			ageMs: 1000,
			silentMs: 1000,
			stalled: false,
			waitReason: null,
		},
		turnCount: 1,
		openCount: 1,
		runCount: 1,
		pendingCount: 0,
		stalledCount: 0,
		updatedAt: "2026-11-25T11:59:00+09:00",
		recent: [],
	});
	const off = { ok: false as const, error: "not in this test" };
	const snapshot: DashboardSnapshot = {
		generatedAt: "2026-11-25T12:00:00+09:00",
		timezone: "Asia/Seoul",
		daemon: off,
		turns: {
			ok: true,
			items: [],
			threads: [thread("k1", "겹치는 턴"), thread("k2", "agy 턴"), thread("k3", "조용한 턴")],
		},
		tasks: off,
		lanes: {
			ok: true,
			items: [
				{
					name: "x",
					originKey: "lane/x",
					title: "레인 제목",
					status: "working",
					cwd: "/w/x",
					updatedAt: "2026-11-25T11:59:00+09:00",
					uncertainCount: 0,
				},
			],
		},
		herdr: { ok: true, hosts: [] },
		approvals: off,
		monitors: off,
		alerts: { ok: true, items: [] },
		gates: off,
		backup: off,
		jobs: off,
		overlaps: {
			hints: { k1: "파일 겹침 /r/a.ts ↔ 레인 x", "lane/x": "파일 겹침 /r/a.ts ↔ 겹치는 턴" },
			lines: ["파일 겹침 /r/a.ts · 겹치는 턴 ↔ 레인 x"],
			agy: ["k2"],
		},
	};
	const client = new Function("document", "setInterval", `${SCRIPT}\nreturn renderDashboardMain;`)(
		{ getElementById: () => ({}) },
		() => 0,
	) as typeof renderDashboardMain;

	test("turn cards and lane rows carry the badge and hover; agy cards say they are not checked", () => {
		const turns = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
		const card = (key: string): string =>
			new RegExp(`<article[^>]*data-row="${key}"[\\s\\S]*?</article>`).exec(turns)?.[0] ?? "";
		expect(card("k1")).toContain('<span title="파일 겹침 /r/a.ts ↔ 레인 x">겹침</span>');
		expect(card("k2")).toContain(' title="agy 세션은 검사 안 함"');
		expect(card("k2")).not.toContain("겹침</span>");
		expect(card("k3")).not.toContain("겹침");
		const lanes = renderDashboardMain(snapshot, undefined, NOW, { view: "lanes" });
		expect(lanes).toContain('<span title="파일 겹침 /r/a.ts ↔ 겹치는 턴">겹침</span>');
		const agyLanes = renderDashboardMain(
			{ ...snapshot, overlaps: { hints: {}, lines: [], agy: ["lane/x"] } },
			undefined,
			NOW,
			{
				view: "lanes",
			},
		);
		expect(agyLanes).toContain('<span title="agy 세션은 검사 안 함">/w/x</span>');
		const alerts = renderDashboardMain(snapshot, undefined, NOW, { view: "alerts" });
		expect(alerts).toContain("파일 겹침 /r/a.ts · 겹치는 턴 ↔ 레인 x");
		expect(alerts).not.toContain("열린 알림이 없어요");
	});

	test("the page script renders the same marks without an exception", () => {
		for (const view of ["turns", "lanes", "alerts"]) {
			const ui = { view };
			expect(() => client(snapshot, undefined, NOW, ui)).not.toThrow();
			expect(client(snapshot, undefined, NOW, ui)).toBe(renderDashboardMain(snapshot, undefined, NOW, ui));
		}
	});

	test("a TASK's inbox reason gets the overlap line; nothing else is added to the inbox", () => {
		const task: TaskInfo = {
			taskId: "T-1",
			title: "t",
			risk: "L2",
			status: "blocked",
			host: "local",
			agent: "w1",
			branch: "task/T-1",
			open: true,
			updatedAt: "2026-11-25T11:59:00+09:00",
			acTotal: 1,
			progress: { status: "blocked", updated: "2026-11-25T11:59:00+09:00", current: "", blockedReason: "입력 필요" },
			overlap: "파일 겹침 /r/a.ts ↔ 레인 x",
		};
		const withTask = { ...snapshot, tasks: { ok: true as const, items: [task] } };
		const [entry, ...rest] = inboxAttention(withTask);
		expect(rest).toEqual([]);
		expect(entry && turnOf(entry).reason).toBe("입력 필요");
		expect(renderDashboardMain(withTask, undefined, NOW)).toContain(
			'<span class="next-why">입력 필요 · 파일 겹침 /r/a.ts ↔ 레인 x · local · task/T-1</span>',
		);
	});
});
