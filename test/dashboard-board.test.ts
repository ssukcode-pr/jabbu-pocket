import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BoardCard,
	type BoardPromptRef,
	BoardSource,
	type BoardTaskRef,
	type BoardView,
	boardView,
	deepLink,
} from "../src/dashboard/board";
import { renderConversation, renderDetailHead, renderDetailTabs, renderPlan } from "../src/dashboard/detail";
import { SCRIPT } from "../src/dashboard/html";
import { renderDashboardMain } from "../src/dashboard/main-view";
import { renderMarkdown } from "../src/dashboard/markdown";
import { type DashboardBoardOptions, startDashboardServer } from "../src/dashboard/server";
import { buildSnapshot, type DashboardSnapshot, readBoardPrompts, readBoardTasks } from "../src/dashboard/snapshot";
import { readCardTrace, type TurnTrace } from "../src/dashboard/trace";
import { ompSessionDirFor } from "../src/omp/session-dir";
import { openStore } from "../src/store/db";
import { makeHome, type TestHome } from "./helpers/bot-home";

/** How long any awaited event may take before the test fails (a bound, not a sleep). */
const WAIT_MS = 5_000;
const LOCAL_CWD = "/srv/work/repo-t-20261104-07";
const SSH_CWD = "/home/u/work/side";

/** herdr-web-ui's machines list: its own machine and one it reaches over ssh. */
const MACHINES = [
	{
		id: "local",
		name: "oci",
		kind: "local",
		state: "connected",
		snapshot: {
			workspaces: [
				{ workspace_id: "w1", label: "main" },
				{ workspace_id: "w2", label: "jabbu · t-20261104-09" },
			],
			tabs: [
				{ tab_id: "w1:t1", label: "t-20261104-07" },
				{ tab_id: "w2:t1", label: "omp" },
			],
			panes: [
				{
					pane_id: "w1:p1",
					workspace_id: "w1",
					tab_id: "w1:t1",
					agent: "omp",
					agent_status: "working",
					name: "t-20261104-07",
					terminal_title_stripped: "π ⠋ 보드 통합",
					cwd: LOCAL_CWD,
				},
				{ pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", agent: "omp", agent_status: "blocked" },
				{ pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: "thinking-hard" },
				{ pane_id: "w1:p4", workspace_id: "w1", tab_id: "w1:t1", agent: null, agent_status: null },
				{ pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", agent: "omp", agent_status: "working" },
			],
		},
	},
	{
		id: "m-ssh",
		name: "wsl",
		kind: "ssh",
		state: "connected",
		snapshot: {
			workspaces: [{ workspace_id: "w9", label: "dev" }],
			tabs: [{ tab_id: "w9:t1", label: "main" }],
			panes: [
				{ pane_id: "w9:p1", workspace_id: "w9", tab_id: "w9:t1", agent: "omp", agent_status: "idle", cwd: SSH_CWD },
				{ pane_id: "w9:p2", workspace_id: "w9", tab_id: "w9:t1", agent: "omp", agent_status: "done" },
			],
		},
	},
];

const CONVERSATION = {
	history_id: "h1",
	source: "session",
	cursor: "c-older",
	turns: [{ role: "user", ts: "2026-11-04T00:00:00Z", parts: [{ kind: "text", text: "hello" }] }],
};

/** A herdr-web-ui stand-in on a temporary loopback port; it records every request it gets. */
class FakeHerdrWeb {
	readonly requests: Array<{ method: string; path: string }> = [];
	private streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
	private opened: Array<() => void> = [];
	private server: ReturnType<typeof Bun.serve> | undefined;
	port = 0;
	/** Machines streams opened so far. */
	connections = 0;

	start(port = 0): void {
		this.server = Bun.serve({
			port,
			hostname: "127.0.0.1",
			idleTimeout: 0,
			fetch: (request) => {
				const url = new URL(request.url);
				this.requests.push({ method: request.method, path: `${url.pathname}${url.search}` });
				if (url.pathname === "/api/machines/events") {
					let mine: ReadableStreamDefaultController<Uint8Array> | undefined;
					const body = new ReadableStream<Uint8Array>({
						start: (controller) => {
							mine = controller;
							this.connections += 1;
							this.streams.add(controller);
							for (const resolve of this.opened.splice(0)) resolve();
						},
						cancel: () => {
							if (mine !== undefined) this.streams.delete(mine);
						},
					});
					return new Response(body, { headers: { "content-type": "text/event-stream" } });
				}
				const pane = url.searchParams.get("pane_id");
				if (pane === "w9:p2") return new Response("boom", { status: 500 });
				if (url.pathname.endsWith("/plan"))
					return Response.json({ plan: { steps: [{ label: "s1", status: "completed" }] } });
				return Response.json({ ...CONVERSATION, echo: `${url.pathname}${url.search}` });
			},
		});
		this.port = this.server.port as number;
	}

	get origin(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** Resolves once a machines stream is open (at once if one is). */
	streamOpen(): Promise<void> {
		if (this.streams.size > 0) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.opened.push(resolve);
		return promise;
	}

	/** Resolves once `count` machines streams have been opened in all; rejects after WAIT_MS. */
	async connected(count: number): Promise<void> {
		const deadline = AbortSignal.timeout(WAIT_MS);
		while (this.connections < count) {
			if (deadline.aborted) throw new Error(`timed out waiting for connection ${count} (have ${this.connections})`);
			const { promise, resolve } = Promise.withResolvers<void>();
			this.opened.push(resolve);
			deadline.addEventListener("abort", () => resolve(), { once: true });
			await promise;
		}
	}

	/** A comment line (herdr-web-ui's `: heartbeat`) on every open stream. */
	comment(): void {
		const chunk = new TextEncoder().encode(": heartbeat\n\n");
		for (const stream of this.streams) stream.enqueue(chunk);
	}

	send(event: unknown): void {
		const chunk = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
		for (const stream of this.streams) stream.enqueue(chunk);
	}

	/** Ends every stream and stops listening (herdr-web-ui going down). */
	stop(): void {
		for (const stream of this.streams) stream.close();
		this.streams.clear();
		this.server?.stop(true);
	}
}

/** Resolves when `check` holds after a board change (checked once at once too); rejects after WAIT_MS. */
function boardWhen(source: BoardSource, check: () => boolean, what: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (check()) return Promise.resolve();
	const timer = setTimeout(() => {
		off();
		reject(new Error(`timed out waiting for ${what}`));
	}, WAIT_MS);
	const off = source.onChange(() => {
		if (!check()) return;
		clearTimeout(timer);
		off();
		resolve();
	});
	return promise;
}

const SNAPSHOT: DashboardSnapshot = {
	generatedAt: "2026-11-04T09:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: { ok: false, error: "no daemon" },
	turns: { ok: true, items: [], threads: [] },
	tasks: {
		ok: true,
		items: [
			{
				taskId: "T-20261104-07",
				title: "보드 통합",
				risk: "L2",
				status: "working",
				host: "local",
				agent: "t-20261104-07",
				branch: "task/T-20261104-07",
				open: true,
				updatedAt: "2026-11-04T09:00:00+09:00",
				acChecked: 3,
				acTotal: 13,
			},
		],
	},
	lanes: { ok: true, items: [] },
	herdr: { ok: true, hosts: [{ host: "local", ok: true, agents: [] }] },
	approvals: {
		ok: true,
		items: [],
		recent: [],
		stats: { days: 7, approved: 0, denied: 0, expired: 0, replied: 0, medianAnswerMs: null },
	},
	monitors: { ok: true, items: [] },
	alerts: { ok: true, items: [] },
	gates: { ok: true, items: [] },
	backup: { ok: true, offsite: null },
	jobs: { ok: true, items: [] },
};

let upstream: FakeHerdrWeb | undefined;
let source: BoardSource | undefined;
let dashboard: ReturnType<typeof startDashboardServer> | undefined;
let home: TestHome | undefined;

afterEach(() => {
	dashboard?.stop(true);
	source?.stop();
	upstream?.stop();
	home?.remove();
	dashboard = undefined;
	source = undefined;
	upstream = undefined;
	home = undefined;
});

/** Fake herdr-web-ui, a board source on it and a dashboard on a temporary port; the machines list is sent. */
async function setup(
	options: {
		tasks?: BoardTaskRef[];
		prompts?: BoardPromptRef[];
		herdrWebUrl?: string;
		sendList?: boolean;
		cardTrace?: (card: BoardCard) => TurnTrace;
	} = {},
): Promise<{ base: string; upstream: FakeHerdrWeb; source: BoardSource }> {
	const fake = new FakeHerdrWeb();
	fake.start();
	upstream = fake;
	const board = new BoardSource({ origin: fake.origin, retryMs: 10 });
	source = board;
	const boardOptions: DashboardBoardOptions = {
		source: board,
		tasks: () => options.tasks ?? [],
		...(options.prompts === undefined ? {} : { prompts: () => options.prompts ?? [] }),
		...(options.herdrWebUrl === undefined ? {} : { herdrWebUrl: options.herdrWebUrl }),
	};
	dashboard = startDashboardServer({
		port: 0,
		hostname: "127.0.0.1",
		snapshot: async () => SNAPSHOT,
		board: boardOptions,
		...(options.cardTrace === undefined ? {} : { cardTrace: options.cardTrace }),
	});
	board.start();
	await fake.streamOpen();
	if (options.sendList !== false) {
		fake.send({ type: "machines", machines: MACHINES });
		await boardWhen(board, () => board.current() !== undefined, "the first machines list");
	}
	return { base: `http://127.0.0.1:${dashboard.port}`, upstream: fake, source: board };
}

/** Reads `api/board/events` until a snapshot event satisfies `check`; bounded by WAIT_MS. */
async function eventWhere(
	reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> },
	state: { buffer: string },
	check: (view: BoardView) => boolean,
): Promise<BoardView> {
	const decoder = new TextDecoder();
	const deadline = AbortSignal.timeout(WAIT_MS);
	while (!deadline.aborted) {
		let end = state.buffer.indexOf("\n\n");
		while (end >= 0) {
			const frame = state.buffer.slice(0, end);
			state.buffer = state.buffer.slice(end + 2);
			const data = /^data: (.*)$/m.exec(frame)?.[1];
			if (/^event: snapshot$/m.test(frame) && data !== undefined) {
				const view = JSON.parse(data) as BoardView;
				if (view.ok && check(view)) return view;
			}
			end = state.buffer.indexOf("\n\n");
		}
		const { value, done } = await reader.read();
		if (done) throw new Error("board event stream ended");
		state.buffer += decoder.decode(value, { stream: true });
	}
	throw new Error("timed out waiting for a board snapshot event");
}

describe("agent board", () => {
	test("AC-1: api/board has both machines' cards, keyed and columned like the herdr task board", async () => {
		const { base } = await setup();
		const response = await fetch(`${base}/api/board`);
		expect(response.status).toBe(200);
		const view = (await response.json()) as BoardView;
		expect(view.machines).toEqual([
			{ id: "local", name: "oci", connected: true },
			{ id: "m-ssh", name: "wsl", connected: true },
		]);
		const columns = Object.fromEntries(view.cards.map((card) => [card.key, card.column]));
		expect(columns).toEqual({
			"w1:p1": "working",
			"w2:p1": "working",
			"w1:p2": "attention",
			"w1:p3": "attention",
			"m-ssh:w9:p1": "idle",
			"m-ssh:w9:p2": "done",
		});
		const first = view.cards.find((card) => card.key === "w1:p1");
		expect(first).toMatchObject({
			machineName: "oci",
			workspaceLabel: "main",
			tabLabel: "t-20261104-07",
			paneLabel: "보드 통합",
			status: "working",
		});
		expect(view.cards.find((card) => card.key === "w1:p3")).toMatchObject({ unknown: true, status: "thinking-hard" });
		// Prefixed path, same answer.
		expect((await fetch(`${base}/jabbu/api/board`)).status).toBe(200);
	});

	test("AC-2: a pane-status patch reaches api/board/events subscribers; pane-exited drops the card", async () => {
		const { base, upstream } = await setup();
		const response = await fetch(`${base}/api/board/events`);
		expect(response.headers.get("content-type")).toStartWith("text/event-stream");
		if (response.body === null) throw new Error("no event stream body");
		const reader = response.body.getReader();
		const state = { buffer: "" };
		await eventWhere(reader, state, (view) => view.cards.some((card) => card.key === "m-ssh:w9:p1"));

		upstream.send({
			type: "machine-message",
			machine_id: "m-ssh",
			message: { type: "pane-status", pane_id: "w9:p1", agent_status: "blocked" },
		});
		const patched = await eventWhere(reader, state, (view) =>
			view.cards.some((card) => card.key === "m-ssh:w9:p1" && card.status === "blocked"),
		);
		expect(patched.cards.find((card) => card.key === "m-ssh:w9:p1")?.column).toBe("attention");

		upstream.send({ type: "machine-message", machine_id: "local", message: { type: "pane-exited", pane_id: "w1:p2" } });
		const exited = await eventWhere(reader, state, (view) => !view.cards.some((card) => card.key === "w1:p2"));
		expect(exited.cards.map((card) => card.key)).toContain("w1:p1");
		await reader.cancel();
	});

	test("AC-3: 503 before the first list (snapshot 200), and the board reconnects on its own", async () => {
		const { base, upstream, source } = await setup({ sendList: false });
		const before = await fetch(`${base}/api/board`);
		expect(before.status).toBe(503);
		expect(await before.json()).toEqual({ error: "herdr_unreachable" });
		expect((await fetch(`${base}/api/snapshot`)).status).toBe(200);

		upstream.send({ type: "machines", machines: MACHINES });
		await boardWhen(source, () => source.current() !== undefined, "the first list");
		expect((await fetch(`${base}/api/board`)).status).toBe(200);

		// herdr-web-ui goes down: the board says so, then comes back on the same port without any help.
		const port = upstream.port;
		upstream.stop();
		await boardWhen(source, () => source.current() === undefined, "the stream loss");
		expect((await fetch(`${base}/api/board`)).status).toBe(503);
		upstream.start(port);
		await upstream.streamOpen();
		upstream.send({ type: "machines", machines: MACHINES });
		await boardWhen(source, () => source.current() !== undefined, "the reconnect");
		expect((await fetch(`${base}/api/board`)).status).toBe(200);
		expect(upstream.requests.filter((request) => request.path === "/api/machines/events").length).toBeGreaterThan(1);
	});

	test("AC-4: conversation and plan go to the card's machine path with before; unknown 404, upstream 500 → 502", async () => {
		const { base, upstream } = await setup();
		const local = await fetch(`${base}/api/pane/conversation?card=${encodeURIComponent("w1:p1")}&before=c9&junk=x`);
		expect(local.status).toBe(200);
		const localBody = (await local.json()) as typeof CONVERSATION & { echo: string };
		expect(localBody.echo).toBe("/api/pane/conversation?pane_id=w1%3Ap1&before=c9");
		expect(localBody.turns).toEqual(CONVERSATION.turns);

		const ssh = await fetch(`${base}/api/pane/conversation?card=${encodeURIComponent("m-ssh:w9:p1")}`);
		expect(((await ssh.json()) as { echo: string }).echo).toBe("/api/machines/m-ssh/pane/conversation?pane_id=w9%3Ap1");

		const plan = await fetch(`${base}/api/pane/plan?card=${encodeURIComponent("m-ssh:w9:p1")}&before=c9`);
		expect(plan.status).toBe(200);
		expect(await plan.json()).toEqual({ plan: { steps: [{ label: "s1", status: "completed" }] } });
		expect(upstream.requests.at(-1)?.path).toBe("/api/machines/m-ssh/pane/plan?pane_id=w9%3Ap1");
		const localPlan = await fetch(`${base}/api/pane/plan?card=${encodeURIComponent("w1:p1")}`);
		expect(localPlan.status).toBe(200);
		expect(upstream.requests.at(-1)?.path).toBe("/api/pane/plan?pane_id=w1%3Ap1");

		for (const kind of ["conversation", "plan"]) {
			const unknown = await fetch(`${base}/api/pane/${kind}?card=nope:p1`);
			expect(unknown.status).toBe(404);
			expect(await unknown.json()).toEqual({ error: "unknown_pane" });
			const failed = await fetch(`${base}/api/pane/${kind}?card=${encodeURIComponent("m-ssh:w9:p2")}`);
			expect(failed.status).toBe(502);
			expect(await failed.json()).toMatchObject({ error: "upstream" });
		}
	});

	test("api/pane/trace: a local omp card's last turn from its worktree's newest session; the rest 404", async () => {
		const root = mkdtempSync(join(tmpdir(), "jabbu-card-trace-"));
		try {
			const sessionsRoot = join(root, "sessions");
			const dir = ompSessionDirFor(LOCAL_CWD, root, sessionsRoot);
			mkdirSync(dir, { recursive: true });
			const file = join(dir, "s.jsonl");
			const base0 = Date.parse("2026-11-18T01:00:00Z");
			const at = (ms: number) => new Date(base0 + ms).toISOString();
			const user = (id: string, ms: number) => ({
				type: "message",
				id,
				timestamp: at(ms),
				message: { role: "user", content: [] },
			});
			const model = (id: string, from: number, to: number) => ({
				type: "message",
				id,
				timestamp: at(to),
				message: {
					role: "assistant",
					model: "opus",
					timestamp: base0 + from,
					completedAt: base0 + to,
					stopReason: "stop",
					content: [],
				},
			});
			for (const entry of [user("u1", 0), model("a1", 100, 900), user("u2", 5_000), model("a2", 5_100, 5_900)]) {
				appendFileSync(file, `${JSON.stringify(entry)}\n`);
			}
			const { base } = await setup({
				cardTrace: (card) => readCardTrace(card, { userHome: root, sessionsRoot, now: base0 + 60_000 }),
			});
			const ok = await fetch(`${base}/api/pane/trace?card=${encodeURIComponent("w1:p1")}`);
			expect(ok.status).toBe(200);
			const body = (await ok.json()) as Extract<TurnTrace, { ok: true }>;
			// Only the second user message's turn: one model span, counted from that message.
			expect(body).toMatchObject({ ok: true, live: true, startedAt: base0 + 5_000 });
			expect(body.root.children?.map((span) => [span.id, span.start, span.end])).toEqual([["a2", 100, 900]]);
			const no = async (card: string) => {
				const response = await fetch(`${base}/api/pane/trace?card=${encodeURIComponent(card)}`);
				return [response.status, await response.json()];
			};
			expect(await no("nope:p1")).toEqual([404, { error: "unknown_pane" }]);
			expect(await no("w1:p3")).toEqual([404, { ok: false, error: "unsupported_card" }]);
			expect(await no("m-ssh:w9:p1")).toEqual([404, { ok: false, error: "unsupported_card" }]);
			expect(await no("w1:p2")).toEqual([404, { ok: false, error: "no_session" }]);
			// A session folder with no user message has no turn either.
			writeFileSync(file, `${JSON.stringify(model("a1", 100, 900))}\n`);
			expect(await no("w1:p1")).toEqual([404, { ok: false, error: "no_session" }]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("api/pane/trace without a trace option is 404 trace_disabled", async () => {
		const { base } = await setup();
		const off = await fetch(`${base}/api/pane/trace?card=w1:p1`);
		expect([off.status, await off.json()]).toEqual([404, { error: "trace_disabled" }]);
	});

	test("the 트레이스 tab is only in a local omp card's tab strip", () => {
		expect(renderDetailTabs("card", "head")).not.toContain("트레이스");
		const withTrace = renderDetailTabs("card", "head", true);
		expect(withTrace.match(/data-tab="/g)?.length).toBe(4);
		expect(withTrace).toContain('data-tab="trace"');
	});

	test("the server-drawn page has the 트레이스 tab on a local omp card only", async () => {
		const { base } = await setup();
		const strip = async (card: string) =>
			/<div id="detail-tabs"[^>]*>([\s\S]*?)<\/div>/.exec(
				await (await fetch(`${base}/?card=${encodeURIComponent(card)}`)).text(),
			)?.[1];
		expect(await strip("w1:p1")).toContain('data-tab="trace"');
		expect(await strip("w1:p3")).not.toContain('data-tab="trace"');
		expect(await strip("m-ssh:w9:p1")).not.toContain('data-tab="trace"');
	});

	test("AC-5: every request the dashboard sends upstream is a GET", async () => {
		const { base } = await setup();
		for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
			expect((await fetch(`${base}/api/pane/conversation?card=w1:p1`, { method })).status).toBe(405);
		}
		await fetch(`${base}/api/pane/conversation?card=w1:p1`);
		await fetch(`${base}/api/pane/plan?card=${encodeURIComponent("m-ssh:w9:p1")}`);
		await fetch(`${base}/api/pane/conversation?card=w1:p1`, { method: "HEAD" });
		await fetch(`${base}/api/board`);
		expect(upstream?.requests.length).toBeGreaterThanOrEqual(4);
		expect(new Set(upstream?.requests.map((request) => request.method))).toEqual(new Set(["GET"]));
	});

	test("AC-6: /?card= opens the detail panel; the reply link only with herdrWebUrl; unknown keys get a notice", async () => {
		const { base } = await setup({ herdrWebUrl: "https://herdr.example.test/" });
		const ssh = await (await fetch(`${base}/?card=${encodeURIComponent("m-ssh:w9:p1")}`)).text();
		expect(ssh).toContain('<aside id="detail" class="detail is-open"');
		expect(ssh).toContain("herdr에서 답하기");
		expect(ssh).toContain('href="https://herdr.example.test/?machine=m-ssh&amp;ws=w9&amp;pane=w9%3Ap1&amp;view=chat"');
		const local = await (await fetch(`${base}/?card=${encodeURIComponent("w1:p1")}`)).text();
		expect(local).toContain('href="https://herdr.example.test/?ws=w1&amp;pane=w1%3Ap1&amp;view=chat"');
		expect(local).toContain("보드 통합");
		const unknown = await (await fetch(`${base}/?card=gone:p1`)).text();
		expect(unknown).toContain('class="detail is-open"');
		expect(unknown).toContain("지금 보드에 없는 패널");
		const closed = await (await fetch(`${base}/`)).text();
		expect(closed).toContain('<aside id="detail" class="detail" aria-label="카드 상세" hidden>');

		dashboard?.stop(true);
		source?.stop();
		upstream?.stop();
		const bare = await setup();
		const noLink = await (await fetch(`${bare.base}/?card=${encodeURIComponent("m-ssh:w9:p1")}`)).text();
		expect(noLink).toContain('class="detail is-open"');
		expect(noLink).not.toContain("herdr에서 답하기");
		expect(deepLink("https://h.test/x?y=1", { local: false, machineId: "m", workspaceId: "", paneId: "p" })).toBe(
			"https://h.test/x?machine=m&pane=p&view=chat",
		);
	});

	test("AC-7: a card gets the TASK whose agent is its name or whose worktree is its cwd", async () => {
		home = makeHome("jabbu-board-");
		const dbPath = join(home.dir, "jabbu.db");
		openStore({ timezone: "Asia/Seoul", path: dbPath, clock: { now: () => 0 }, redact: (text) => text }).close();
		const db = new Database(dbPath, { strict: true });
		const task = (id: string, agent: string, worktree: string, status: string) =>
			db.run(
				`INSERT INTO tasks (task_id, title, risk, origin_key, thread_ref, host, repo, worktree, branch, agent, status,
					acceptance_json, created_at, updated_at)
				 VALUES (?, 't', 'L2', 'o', 'C1:1.0', NULL, '/srv/work/repo', ?, 'b', ?, ?, '[]', 0, 0)`,
				[id, worktree, agent, status],
			);
		task("T-20261104-07", "t-20261104-07", "/nowhere", "working");
		task("T-20261104-08", "someone-else", SSH_CWD, "review");
		task("T-20261104-09", "t-20261104-09", "/elsewhere", "blocked");
		task("T-20261103-01", "old", LOCAL_CWD, "done");
		db.close();
		const tasks = readBoardTasks(home.dir);
		expect(tasks.map((item) => item.taskId)).toEqual(["T-20261104-07", "T-20261104-08", "T-20261104-09"]);

		const { base } = await setup({ tasks });
		const view = (await (await fetch(`${base}/api/board`)).json()) as BoardView;
		const byKey = Object.fromEntries(view.cards.map((card) => [card.key, card.taskId]));
		expect(byKey).toEqual({
			"w1:p1": "T-20261104-07",
			"w2:p1": "T-20261104-09",
			"w1:p2": undefined,
			"w1:p3": undefined,
			"m-ssh:w9:p1": "T-20261104-08",
			"m-ssh:w9:p2": undefined,
		});
		const page = await (await fetch(`${base}/`)).text();
		const row = page.slice(page.indexOf('data-card="w1:p1" data-row="w1:p1">'));
		expect(row.slice(0, row.indexOf("</a>"))).toMatch(/<span class="t2"><span>(?:[^<]* · )?T-20261104-07<\/span>/);
	});

	test("마지막 지시: a card gets its name's newest prompt (local cards local rows only); only the detail panel draws it", async () => {
		home = makeHome("jabbu-board-");
		const dbPath = join(home.dir, "jabbu.db");
		expect(readBoardPrompts(home.dir)).toEqual([]);
		let now = Date.parse("2026-11-12T01:00:00Z");
		const store = openStore({
			timezone: "Asia/Seoul",
			path: dbPath,
			clock: { now: () => now },
			redact: (text) => text,
		});
		const record = (host: string | null, agent: string, kind: "start" | "followup" | "remind", text: string) => {
			store.recordHerdrPrompt({ host, agent, kind, text, originKey: null });
			now += 60_000;
		};
		record(null, "t-20261104-07", "start", "첫 지시");
		record(null, "t-20261104-07", "followup", "로컬 후속 지시");
		record("wsl", "t-20261104-07", "start", "같은 이름의 원격 지시");
		record("wsl", "t-20261104-09", "remind", "원격 리마인더");
		record("wsl", "side-1", "followup", "원격 첫 지시");
		record("remote1", "side-1", "remind", "원격 다른 호스트 리마인더");
		store.close();
		const prompts = readBoardPrompts(home.dir);
		expect(prompts).toHaveLength(5);

		const { base } = await setup({ prompts });
		const view = (await (await fetch(`${base}/api/board`)).json()) as BoardView;
		const byKey = Object.fromEntries(view.cards.map((card) => [card.key, card.lastPrompt]));
		const at0 = Date.parse("2026-11-12T01:00:00Z");
		expect(byKey).toEqual({
			"w1:p1": { preview: "로컬 후속 지시", at: at0 + 60_000, kind: "followup" },
			"w2:p1": undefined,
			"w1:p2": undefined,
			"w1:p3": undefined,
			"m-ssh:w9:p1": undefined,
			"m-ssh:w9:p2": undefined,
		});
		const remote = view.cards.find((card) => card.key === "m-ssh:w9:p1");
		if (remote === undefined) throw new Error("no remote card");
		const named = boardView({ machines: [], cards: [{ ...remote, name: "side-1" }] }, { tasks: [], prompts, now })
			.cards[0];
		expect(named?.lastPrompt).toEqual({ preview: "원격 다른 호스트 리마인더", at: at0 + 5 * 60_000, kind: "remind" });

		// The worker brief is no part of the inbox row (two lines: title, then state and reason).
		const html = renderDashboardMain(SNAPSHOT, view, at0 + 4 * 60_000);
		expect(html).not.toContain("로컬 후속 지시");
		expect(html).not.toContain("마지막 지시");
		const local = view.cards.find((card) => card.key === "w1:p1");
		expect(renderDetailHead("w1:p1", local, undefined, at0 + 4 * 60_000)).toContain(
			'<section class="detail-say" aria-label="마지막 지시"><h3 class="h3">마지막 지시</h3><p class="lead">로컬 후속 지시</p><p class="note-sub">3분 전</p></section>',
		);
		expect(
			renderDetailHead(
				"w2:p1",
				view.cards.find((card) => card.key === "w2:p1"),
				undefined,
				now,
			),
		).not.toContain("마지막 지시");
		const remind = renderDashboardMain(
			SNAPSHOT,
			{ ...view, cards: [{ ...remote, lastPrompt: named?.lastPrompt }] },
			now,
		);
		expect(remind).not.toContain("원격 다른 호스트 리마인더");
	});

	test("AC-9: without a board the page keeps the herdr agent list block and no board block", async () => {
		const html = renderDashboardMain(SNAPSHOT);
		expect(html).toContain("herdr 에이전트");
		expect(html).not.toContain("에이전트 보드");
		const server = startDashboardServer({ port: 0, hostname: "127.0.0.1", snapshot: async () => SNAPSHOT });
		dashboard = server;
		const base = `http://127.0.0.1:${server.port}`;
		expect((await fetch(`${base}/api/board`)).status).toBe(404);
		expect(await (await fetch(`${base}/`)).text()).toContain('data-board="0"');
		// buildSnapshot without a board source runs `herdr agent list` as before.
		home = makeHome("jabbu-board-");
		const calls: string[][] = [];
		const snapshot = await buildSnapshot({
			homeDir: home.dir,
			repoDir: "/srv/jabbu",
			timezone: "Asia/Seoul",
			config: { herdr: {} },
			now: () => 0,
			callDaemon: async () => Promise.reject(new Error("no daemon")),
			run: async (cmd) => {
				calls.push(cmd);
				return { code: 0, stdout: JSON.stringify({ result: { agents: [] } }), timedOut: false };
			},
			ompVersion: async () => "omp 0",
			hostOps: () => {
				throw new Error("unused");
			},
		});
		expect(snapshot.herdr).toEqual({ ok: true, hosts: [{ host: "local", ok: true, agents: [] }] });
		expect(calls).toContainEqual(["herdr", "agent", "list"]);
	});

	test("live board: the snapshot's herdr section carries column counts and the page draws the board", async () => {
		const { base, source } = await setup();
		home = makeHome("jabbu-board-");
		const snapshot = await buildSnapshot({
			homeDir: home.dir,
			repoDir: "/srv/jabbu",
			timezone: "Asia/Seoul",
			config: { herdr: {} },
			now: () => 0,
			callDaemon: async () => Promise.reject(new Error("no daemon")),
			run: async () => ({ code: 0, stdout: JSON.stringify({ result: { agents: [] } }), timedOut: false }),
			ompVersion: async () => "omp 0",
			hostOps: () => {
				throw new Error("unused");
			},
			board: () => source.current(),
		});
		expect(snapshot.herdr).toEqual({
			ok: true,
			hosts: [],
			board: { machines: 2, cards: 6, columns: { attention: 2, working: 2, idle: 1, done: 1 } },
		});
		const page = await (await fetch(`${base}/`)).text();
		expect(page).toContain("에이전트 인박스");
		expect(page).toContain('href="?card=m-ssh%3Aw9%3Ap1" data-card="m-ssh:w9:p1"');
		expect(page).not.toContain("herdr 에이전트");
	});
});

describe("board stream watchdog", () => {
	/** A board source with a short idle limit on a fresh fake herdr-web-ui, after its first machines list. */
	async function watched(idleMs: number, now?: () => number): Promise<{ fake: FakeHerdrWeb; board: BoardSource }> {
		const fake = new FakeHerdrWeb();
		fake.start();
		upstream = fake;
		const board = new BoardSource({ origin: fake.origin, retryMs: 10, idleMs, now });
		source = board;
		board.start();
		await fake.connected(1);
		fake.send({ type: "machines", machines: MACHINES });
		await boardWhen(board, () => board.current() !== undefined, "the first machines list");
		return { fake, board };
	}

	test("a stream silent past idleMs drops the board, tells listeners and opens a second connection", async () => {
		const { fake, board } = await watched(100);
		let heard = 0;
		board.onChange(() => {
			heard += 1;
		});
		await boardWhen(board, () => board.current() === undefined, "the idle drop");
		expect(heard).toBeGreaterThan(0);
		await fake.connected(2);
		expect(fake.connections).toBeGreaterThanOrEqual(2);
	});

	/** Waits (bounded macrotask hops, no clock) for `check`; silent chunks fire no board change to listen on. */
	async function hopsUntil(check: () => boolean, what: string, hops = 400): Promise<void> {
		for (let hop = 0; hop < hops && !check(); hop += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
		if (!check()) throw new Error(`the board never reached ${what}`);
	}

	test("comment lines inside idleMs keep the stream and the board", async () => {
		let t = Date.parse("2026-11-11T07:00:00Z");
		const { fake, board } = await watched(200, () => t);
		let dropped = false;
		board.onChange(() => {
			if (board.current() === undefined) dropped = true;
		});
		// The heartbeats are the traffic under test: 24 of them 25 clock-ms apart span three idle limits. Each beat is
		// awaited until the watchdog has counted its chunk, and the idle decision reads the injected clock, so a busy
		// event loop cannot cut the stream between beats.
		for (let beats = 0; beats < 24; beats += 1) {
			t += 25;
			fake.comment();
			await hopsUntil(() => board.trafficAt === t, `heartbeat ${beats + 1}`);
		}
		expect([dropped, board.current() !== undefined, fake.connections]).toEqual([false, true, 1]);
	});
});

describe("board since file", () => {
	const T0 = Date.parse("2026-11-11T07:00:00Z");
	const HOUR = 3_600_000;
	const DAY = 24 * HOUR;
	type Saved = Record<string, { status: string; since: number; gone?: number }>;

	/** A board source on its own fake herdr-web-ui, the given since file and a fixed clock, after the machines list. */
	async function restarted(
		file: string,
		at: number,
		machines: unknown[] = MACHINES,
	): Promise<{ fake: FakeHerdrWeb; board: BoardSource }> {
		const fake = new FakeHerdrWeb();
		fake.start();
		const board = new BoardSource({ origin: fake.origin, retryMs: 10, sinceFile: file, now: () => at });
		board.start();
		await fake.connected(1);
		fake.send({ type: "machines", machines });
		await boardWhen(board, () => board.current() !== undefined, "the first machines list");
		return { fake, board };
	}
	const sinceOf = (board: BoardSource, key: string): number | undefined =>
		board.current()?.cards.find((card) => card.key === key)?.since;
	const saved = (file: string): Saved => JSON.parse(readFileSync(file, "utf8")) as Saved;

	test("AC-1: a new board source keeps a same-status card's since from the file; a live change starts now", async () => {
		home = makeHome("jabbu-board-since-");
		const file = join(home.dir, "dashboard-board-since.json");
		writeFileSync(
			file,
			JSON.stringify({
				"w1:p1": { status: "working", since: T0 - 5 * HOUR },
				"w1:p2": { status: "working", since: T0 - 4 * HOUR },
				"m-ssh:w9:p2": { status: "done", since: T0 - 3 * HOUR },
				gone7: { status: "done", since: T0 - 9 * DAY, gone: T0 - 8 * DAY },
				gone1: { status: "done", since: T0 - 2 * DAY, gone: T0 - DAY },
			}),
		);
		const first = await restarted(file, T0);
		upstream = first.fake;
		source = first.board;
		expect(sinceOf(first.board, "w1:p1")).toBe(T0 - 5 * HOUR);
		expect(sinceOf(first.board, "m-ssh:w9:p2")).toBe(T0 - 3 * HOUR);
		// Saved working, now blocked: the change happened while no board was watching, so its time is unknown.
		expect(sinceOf(first.board, "w1:p2")).toBe(0);
		// A pane the file does not know, seen in its machine's first list: unknown too.
		expect(sinceOf(first.board, "w2:p1")).toBe(0);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(Object.keys(saved(file))).not.toContain("gone7");
		expect(saved(file).gone1).toEqual({ status: "done", since: T0 - 2 * DAY, gone: T0 - DAY });

		first.fake.send({
			type: "machine-message",
			machine_id: "local",
			message: { type: "pane-status", pane_id: "w1:p1", agent_status: "done" },
		});
		await boardWhen(
			first.board,
			() => first.board.current()?.cards.find((card) => card.key === "w1:p1")?.status === "done",
			"w1:p1 done",
		);
		expect(sinceOf(first.board, "w1:p1")).toBe(T0);
		expect(saved(file)["w1:p1"]).toEqual({ status: "done", since: T0 });
		first.board.stop();
		first.fake.stop();

		// The restart: a new source an hour later reads the file the first one left; w1:p1 is still done.
		const local = MACHINES[0] as (typeof MACHINES)[number];
		const stillDone = [
			{
				...local,
				snapshot: {
					...local.snapshot,
					panes: local.snapshot.panes.map((pane) =>
						pane.pane_id === "w1:p1" ? { ...pane, agent_status: "done" } : pane,
					),
				},
			},
			MACHINES[1],
		];
		const second = await restarted(file, T0 + HOUR, stillDone);
		upstream = second.fake;
		source = second.board;
		expect(sinceOf(second.board, "w1:p1")).toBe(T0);
		expect(sinceOf(second.board, "m-ssh:w9:p2")).toBe(T0 - 3 * HOUR);
		expect(sinceOf(second.board, "w2:p1")).toBe(0);
	});

	test("AC-1: with no file or a broken one every first-seen card is since 0, and the file is written", async () => {
		home = makeHome("jabbu-board-since-");
		const file = join(home.dir, "dashboard-board-since.json");
		for (const content of [undefined, "{not json"]) {
			if (content !== undefined) writeFileSync(file, content);
			const run = await restarted(file, T0);
			upstream = run.fake;
			source = run.board;
			expect(run.board.current()?.cards.map((card) => card.since)).toEqual([0, 0, 0, 0, 0, 0]);
			expect(Object.values(saved(file)).map((entry) => entry.since)).toEqual([0, 0, 0, 0, 0, 0]);
			run.fake.send({
				type: "machine-message",
				machine_id: "m-ssh",
				message: { type: "pane-status", pane_id: "w9:p1", agent_status: "working" },
			});
			await boardWhen(
				run.board,
				() => run.board.current()?.cards.find((card) => card.key === "m-ssh:w9:p1")?.status === "working",
				"w9:p1 working",
			);
			expect(sinceOf(run.board, "m-ssh:w9:p1")).toBe(T0);
			run.board.stop();
			run.fake.stop();
			rmSync(file, { force: true });
		}
	});
});

describe("detail rendering", () => {
	const HOSTILE =
		"<script>alert(1)</script>\n\n![x](https://evil/x.png)\n\n[ok](https://example.test/a) [bad](javascript:alert(1))";

	test("AC-8: message markdown never yields a running script or a remote image", () => {
		const html = renderMarkdown(HOSTILE);
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/<img/i);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain('<a href="https://example.test/a" target="_blank" rel="noopener noreferrer">ok</a>');
		expect(html).not.toContain('href="javascript');
		const conversation = renderConversation(
			{
				turns: [
					{
						role: "assistant",
						ts: 0,
						parts: [
							{ kind: "text", text: HOSTILE },
							{ kind: "tool", name: "<b>x</b>", summary: "<img src=x>", output: "<script>1</script>" },
							{ kind: "image", ref: "https://evil/x.png" },
						],
					},
				],
				cursor: '"><script>',
			},
			"<i>omp</i>",
			renderMarkdown,
			0,
		);
		expect(conversation).not.toMatch(/<script|<img|<i>omp/i);
		expect(renderPlan({ plan: { steps: [{ label: "<script>x</script>", status: "in_progress" }] } })).not.toMatch(
			/<script/i,
		);
		expect(renderMarkdown("```\n<script>x</script>\n```\n| a | <b> |\n|---|---|\n| 1 | 2 |")).not.toMatch(
			/<script|<b>/,
		);
	});

	test("the page's inline script ships the same renderers the server uses", async () => {
		const { base } = await setup({ herdrWebUrl: "https://herdr.example.test/" });
		const view = (await (await fetch(`${base}/api/board`)).json()) as BoardView;
		const script = SCRIPT;
		const client = new Function(
			"document",
			"setInterval",
			`${script}\nreturn { renderDashboardMain, renderDetailHead, renderConversation, renderPlan, renderMarkdown };`,
		)({ getElementById: () => ({}) }, () => 0) as {
			renderDashboardMain: typeof renderDashboardMain;
			renderDetailHead: typeof renderDetailHead;
			renderConversation: typeof renderConversation;
			renderPlan: typeof renderPlan;
			renderMarkdown: typeof renderMarkdown;
		};
		expect(client.renderDashboardMain(SNAPSHOT, view, 0)).toBe(renderDashboardMain(SNAPSHOT, view, 0));
		const card = view.cards[0];
		expect(client.renderDetailHead("w1:p1", card, undefined, 0)).toBe(renderDetailHead("w1:p1", card, undefined, 0));
		expect(client.renderMarkdown(HOSTILE)).toBe(renderMarkdown(HOSTILE));
		expect(client.renderConversation(CONVERSATION, "omp", client.renderMarkdown, 0)).toBe(
			renderConversation(CONVERSATION, "omp", renderMarkdown, 0),
		);
		expect(client.renderPlan({ plan: { steps: [{ label: "a", status: "pending" }] } })).toBe(
			renderPlan({ plan: { steps: [{ label: "a", status: "pending" }] } }),
		);
	});
});
