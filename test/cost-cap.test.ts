import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TurnFailureEscalation } from "../src/core/mailbox";
import { OriginRouter } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import { OmpDriverError, type OmpEvent, type OmpTurnUsage } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { EntryNotFoundError, sessionWindowCost } from "../src/ops/cost-cap";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";
import { localDay } from "../src/time";

const ORIGIN = "discord/dm/200000000000000009";

class FakeClock {
	t = Date.UTC(2026, 10, 10, 12, 0, 0);
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

/** A `message_end` carrying one assistant call's cost, as omp reports it inside a turn. */
const usageEvent = (total: number): OmpEvent => ({
	type: "message_end",
	message: { role: "assistant", content: [], usage: { input: 10, output: 1, cost: { total } } },
});

let dir: string;
let clock: FakeClock;
let store: Store;
let router: OriginRouter;
let drivers: FakeOmpDriver[];
let logLines: string[];
let escalations: TurnFailureEscalation[];
let capWarnings: Array<{ originKey: string; threadRef: string; text: string }>;
let costCap: { turnUsd?: number; dailyUsd?: number } | undefined;
let escalateAfter: number | undefined;
let sessionStore: FakeSessionStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-cost-cap-"));
	clock = new FakeClock();
	store = openStore({ timezone: "Asia/Seoul", path: join(dir, "jabbu.db"), clock, redact });
	drivers = [];
	logLines = [];
	escalations = [];
	capWarnings = [];
	costCap = undefined;
	escalateAfter = undefined;
	sessionStore = new FakeSessionStore();
	router = buildRouter();
});

/** A router over the current store/clock; `beforeEach` builds one, and a test may build another before routing. */
function buildRouter(options: { sessionFile?: string; turnUsage?: () => OmpTurnUsage } = {}): OriginRouter {
	return new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
		sessionsRoot: join(dir, "sessions"),
		statusProvider: () => "status: ok",
		costCap: () => costCap,
		...(escalateAfter === undefined ? {} : { escalateAfter }),
		onEscalate: (info) => escalations.push(info),
		onTurnCostCap: (info) => capWarnings.push(info),
		driverFactory: (_origin, sessionDir) => {
			const driver = new FakeOmpDriver({
				holdTurns: true,
				sessionDir,
				store: sessionStore,
				...(options.sessionFile === undefined ? {} : { sessionFile: options.sessionFile }),
				...(options.turnUsage === undefined ? {} : { turnUsage: options.turnUsage }),
			});
			drivers.push(driver);
			return driver;
		},
	});
}

afterEach(async () => {
	await router.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function msg(text: string): InboundRecord {
	const id = `m${++counter}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: id };
}

/** Starts a held turn; `route` resolves once the mailbox recorded it and prompted the (fake, held) child. */
async function startTurn(text: string): Promise<FakeOmpDriver> {
	await router.route(msg(text));
	const driver = drivers.at(-1);
	if (driver === undefined) throw new Error("the mailbox started no driver");
	return driver;
}

/** Lets a held turn finish and waits for the mailbox's final path (the ledger write happens inside it). */
async function finishTurn(driver: FakeOmpDriver): Promise<void> {
	const settled = Promise.withResolvers<void>();
	const off = driver.onFinal(() => {
		off();
		settled.resolve();
	});
	driver.release();
	await settled.promise;
	await router.mailbox(ORIGIN).sweepIdle();
}

const bodies = (): string[] => store.listDeliveries({ originKey: ORIGIN }).map((row) => row.body);

describe("AC-1: per-turn cost cap", () => {
	test("turnUsd=1: $0.6+$0.5 warns the thread once, never steers, and the turn goes on past 1.5x", async () => {
		costCap = { turnUsd: 1 };
		const driver = await startTurn("비싼 작업");
		driver.emitTestEvent(usageEvent(0.6));
		expect(capWarnings).toHaveLength(0);
		driver.emitTestEvent(usageEvent(0.5));
		expect(capWarnings).toHaveLength(1);
		expect(capWarnings[0]).toMatchObject({ originKey: ORIGIN });
		expect(capWarnings[0]?.threadRef).toBe(`m${counter}`);
		expect(capWarnings[0]?.text).toContain("턴 상한 $1.00");
		expect(capWarnings[0]?.text).toContain("$3.00에서 멈춥니다");
		// $1.1 -> $2.0 is past 1.5x and still below 3x: no second warning, no steer, no abort.
		driver.emitTestEvent(usageEvent(0.9));
		await router.mailbox(ORIGIN).sweepIdle();
		expect(capWarnings).toHaveLength(1);
		expect(driver.calls.filter((call) => call.startsWith("steer:"))).toHaveLength(0);
		expect(driver.calls).not.toContain("abort");
		expect(logLines.some((line) => line.includes("event=cost_cap_turn_soft"))).toBe(true);
		driver.release();
		await router.mailbox(ORIGIN).sweepIdle();
	});

	test("reaching 3x aborts the turn: one `cost_cap` failure notice, no consecutive-failure escalation", async () => {
		costCap = { turnUsd: 1 };
		// With escalateAfter=1 any counted failure escalates at once: the exclusion is what keeps this at zero.
		// It is read when a mailbox is built, so the router is rebuilt before the first message is routed.
		escalateAfter = 1;
		await router.close();
		router = buildRouter();
		const driver = await startTurn("폭주하는 작업");
		const settled = Promise.withResolvers<void>();
		const off = driver.onFinal(() => {
			off();
			settled.resolve();
		});
		driver.emitTestEvent(usageEvent(3.2));
		await settled.promise;
		await router.mailbox(ORIGIN).sweepIdle();
		expect(driver.calls).toContain("abort");
		expect(bodies()).toHaveLength(1);
		expect(bodies()[0]).toContain("비용 상한 $1.00의 3배를 넘어 턴을 멈췄습니다");
		expect(bodies()[0]).toContain("이번 턴 $3.20");
		expect(escalations).toHaveLength(0);
		expect(logLines.some((line) => line.includes("event=turn_failures_escalated"))).toBe(false);
	});

	test("a 3x abort whose abort throws still settles as cost_cap and stops the child", async () => {
		costCap = { turnUsd: 1 };
		const driver = await startTurn("폭주하는 작업");
		driver.abort = async () => {
			driver.calls.push("abort-rejected");
			throw new OmpDriverError("rpc_error", "abort timed out");
		};
		driver.emitTestEvent(usageEvent(3.2));
		await router.mailbox(ORIGIN).sweepIdle();
		expect(driver.calls).toContain("abort-rejected");
		expect(router.mailbox(ORIGIN).state.driverRunning).toBe(false);
		expect(bodies()).toHaveLength(1);
		expect(bodies()[0]).toContain("비용 상한 $1.00의 3배를 넘어 턴을 멈췄습니다");
		// The next message opens a fresh driver instead of prompting the wedged one.
		await router.route(msg("다음 작업"));
		expect(drivers).toHaveLength(2);
	});

	test("without `costCap` a turn never warns nor aborts", async () => {
		const driver = await startTurn("평범한 작업");
		driver.emitTestEvent(usageEvent(9.9));
		driver.emitTestEvent(usageEvent(9.9));
		expect(capWarnings).toHaveLength(0);
		expect(driver.calls.filter((call) => call.startsWith("steer:"))).toHaveLength(0);
		expect(driver.calls).not.toContain("abort");
		driver.release();
		await router.mailbox(ORIGIN).sweepIdle();
	});
});

/**
 * Sub-agent spend inside the turn window is part of the turn's total for `costCap.turnUsd`: the session's own
 * assistant calls alone can stay under the ceiling while a `task` child spends past it.
 */
describe("AC-3: sub-agent cost in the turn total", () => {
	/** A session path whose `<stem>/` directory holds one sub-agent transcript written by `lines`. */
	function sessionWithSubAgent(name: string, lines: string[]): string {
		const sessionFile = join(dir, "sessions", `${name}.jsonl`);
		const subFile = join(dir, "sessions", name, "sub-1.jsonl");
		mkdirSync(dirname(subFile), { recursive: true });
		writeFileSync(subFile, `${lines.join("\n")}\n`);
		return sessionFile;
	}

	const usageLine = (ms: number, total: number): string =>
		JSON.stringify({ type: "model_usage", timestamp: new Date(ms).toISOString(), usage: { cost: { total } } });

	test("own $0.5 stays under turnUsd=1, but + in-window sub-agent $0.6 crosses it: one warning with the summed total", async () => {
		costCap = { turnUsd: 1 };
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const turnStart = clock.now();
		router = buildRouter({ sessionFile: sessionWithSubAgent("sub-warn", [usageLine(turnStart + 2_000, 0.6)]) });
		const driver = await startTurn("하위를 돌리는 턴");
		clock.advance(5_000);
		driver.emitTestEvent(usageEvent(0.5));
		expect(capWarnings).toHaveLength(0);
		await router.mailbox(ORIGIN).sweepIdle();
		expect(capWarnings).toHaveLength(1);
		expect(capWarnings[0]?.text).toContain("이번 턴 비용 $1.10");
		expect(capWarnings[0]?.text).toContain("턴 상한 $1.00");
		expect(driver.calls).not.toContain("abort");
		driver.release();
		await router.mailbox(ORIGIN).sweepIdle();
	});

	test("own $0.2 + in-window sub-agent $3.0 reaches 3x turnUsd=1: the turn stops as cost_cap", async () => {
		costCap = { turnUsd: 1 };
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const turnStart = clock.now();
		router = buildRouter({ sessionFile: sessionWithSubAgent("sub-stop", [usageLine(turnStart + 2_000, 3)]) });
		const driver = await startTurn("폭주하는 하위를 돌리는 턴");
		const settled = Promise.withResolvers<void>();
		const off = driver.onFinal(() => {
			off();
			settled.resolve();
		});
		clock.advance(5_000);
		driver.emitTestEvent(usageEvent(0.2));
		await settled.promise;
		await router.mailbox(ORIGIN).sweepIdle();
		expect(driver.calls).toContain("abort");
		expect(bodies()).toHaveLength(1);
		expect(bodies()[0]).toContain("비용 상한 $1.00의 3배를 넘어 턴을 멈췄습니다");
		expect(bodies()[0]).toContain("이번 턴 $3.20");
	});

	test("a sub-agent record from before the turn start is not added: own $0.5 + in-window $0.1 stays under", async () => {
		costCap = { turnUsd: 1 };
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const turnStart = clock.now();
		router = buildRouter({
			sessionFile: sessionWithSubAgent("sub-before", [
				usageLine(turnStart - 7_200_000, 5),
				usageLine(turnStart + 2_000, 0.1),
			]),
		});
		const driver = await startTurn("앞선 턴의 하위 기록이 있는 턴");
		clock.advance(5_000);
		driver.emitTestEvent(usageEvent(0.5));
		await router.mailbox(ORIGIN).sweepIdle();
		expect(capWarnings).toHaveLength(0);
		expect(driver.calls).not.toContain("abort");
		driver.release();
		await router.mailbox(ORIGIN).sweepIdle();
	});

	test("a `task` tool result re-reads the sub-agents: the warning lands without a later assistant message", async () => {
		costCap = { turnUsd: 1 };
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const turnStart = clock.now();
		// The transcript holds only a pre-turn record at first, so the message alone leaves the turn under the cap.
		const sessionFile = sessionWithSubAgent("sub-task-end", [usageLine(turnStart - 7_200_000, 5)]);
		router = buildRouter({ sessionFile });
		const driver = await startTurn("하위 결과를 기다리는 턴");
		clock.advance(5_000);
		driver.emitTestEvent(usageEvent(0.4));
		await router.mailbox(ORIGIN).sweepIdle();
		expect(capWarnings).toHaveLength(0);
		// The child's spend lands in the transcript; only the `task` result re-reads it before the next message.
		writeFileSync(join(dir, "sessions", "sub-task-end", "sub-1.jsonl"), `${usageLine(turnStart + 2_000, 0.7)}\n`, {
			flag: "a",
		});
		driver.emitTestEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "task", result: "ok" });
		await router.mailbox(ORIGIN).sweepIdle();
		expect(capWarnings).toHaveLength(1);
		expect(capWarnings[0]?.text).toContain("이번 턴 비용 $1.10");
		driver.release();
		await router.mailbox(ORIGIN).sweepIdle();
	});

	test("usage_daily counts the sub-agent part once: own $1 + in-window $2 with the cap judging the same $3", async () => {
		costCap = { turnUsd: 10 };
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const turnStart = clock.now();
		const sessionFile = sessionWithSubAgent("sub-ledger", [usageLine(turnStart + 2_000, 2)]);
		// The turn's own call sits in its session file after the cursor the fake store reports as its leaf (`e2`).
		writeFileSync(
			sessionFile,
			`${[
				{ id: "e1", type: "model_change", timestamp: new Date(turnStart - 60_000).toISOString() },
				{ id: "e2", type: "thinking_level_change", timestamp: new Date(turnStart - 30_000).toISOString() },
				{
					id: "a1",
					type: "message",
					timestamp: new Date(turnStart + 1_000).toISOString(),
					message: { role: "assistant", usage: { cost: { total: 1 } } },
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		router = buildRouter({ sessionFile });
		const driver = await startTurn("장부를 두 번 세지 않는 턴");
		clock.advance(5_000);
		driver.emitTestEvent(usageEvent(1));
		await router.mailbox(ORIGIN).sweepIdle();
		expect(capWarnings).toHaveLength(0);
		await finishTurn(driver);

		const day = localDay(clock.now(), "Asia/Seoul");
		expect(store.dailyCost(day, ORIGIN)).toBeCloseTo(3, 6);
	});

	test("a 3x crossing found after the final was queued still settles as cost_cap", async () => {
		costCap = { turnUsd: 1 };
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const turnStart = clock.now();
		router = buildRouter({ sessionFile: sessionWithSubAgent("sub-race", [usageLine(turnStart + 2_000, 3)]) });
		const driver = await startTurn("마지막에 끝나는 하위 턴");
		const settled = Promise.withResolvers<void>();
		const off = driver.onFinal(() => {
			off();
			settled.resolve();
		});
		clock.advance(5_000);
		driver.emitTestEvent(usageEvent(0.2));
		// The child finishes while the sub-agent re-read is still in flight: the final queues behind the refresh.
		driver.release();
		await settled.promise;
		await router.mailbox(ORIGIN).sweepIdle();
		// The abort lost the race (the settlement already happened) — but the settlement carries the reason.
		expect(driver.calls).not.toContain("abort");
		expect(bodies()).toHaveLength(1);
		expect(bodies()[0]).toContain("비용 상한 $1.00의 3배를 넘어 턴을 멈췄습니다");
		expect(bodies()[0]).toContain("이번 턴 $3.20");
	});

	test("a turn whose sub-agent spends while the child is quiet is stopped by the sweep", async () => {
		costCap = { turnUsd: 1 };
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const turnStart = clock.now();
		router = buildRouter({ sessionFile: sessionWithSubAgent("sub-quiet", [usageLine(turnStart + 2_000, 3)]) });
		const driver = await startTurn("조용히 하위를 돌리는 턴");
		const settled = Promise.withResolvers<void>();
		const off = driver.onFinal(() => {
			off();
			settled.resolve();
		});
		clock.advance(5_000);
		// No omp event at all: the sub-agent works while the child is silent, so only the sweep can judge.
		expect(router.sweepStalls()).toBe(0);
		await settled.promise;
		await router.mailbox(ORIGIN).sweepIdle();
		expect(driver.calls).toContain("abort");
		expect(bodies()).toHaveLength(1);
		expect(bodies()[0]).toContain("비용 상한 $1.00의 3배를 넘어 턴을 멈췄습니다");
		expect(bodies()[0]).toContain("이번 턴 $3.00");
	});

	test("a wedged turn still charges in-window sub-agent spend from the cached session file", async () => {
		costCap = { turnUsd: 10 };
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const turnStart = clock.now();
		const sessionFile = sessionWithSubAgent("sub-wedged", [usageLine(turnStart + 2_000, 2)]);
		router = buildRouter({ sessionFile });
		const driver = await startTurn("하위 지출이 있는 멈춘 턴");
		clock.advance(5_000);
		driver.emitTestEvent(usageEvent(0.5));
		await router.mailbox(ORIGIN).sweepIdle(); // the refresh caches the session file and reads sub-agent $2
		// The owner's !stop aborts, and the abort throws: the turn settles wedged.
		driver.abort = async () => {
			driver.calls.push("abort-rejected");
			throw new OmpDriverError("rpc_error", "abort timed out");
		};
		await router.route(msg("!stop"));
		await router.mailbox(ORIGIN).sweepIdle();
		const day = localDay(clock.now(), "Asia/Seoul");
		expect(store.dailyCost(day, ORIGIN)).toBeCloseTo(2.5, 6); // live $0.5 + sub-agent $2
		expect(store.getCursor(`charged:${ORIGIN}`)).toBeUndefined();
	});

	test("a state-read failure still charges in-window sub-agent spend from the cached session file", async () => {
		costCap = { turnUsd: 10 };
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const turnStart = clock.now();
		const sessionFile = sessionWithSubAgent("sub-state-failed", [usageLine(turnStart + 2_000, 2)]);
		router = buildRouter({ sessionFile });
		const driver = await startTurn("상태 조회가 실패하는 턴");
		clock.advance(5_000);
		driver.emitTestEvent(usageEvent(0.5));
		await router.mailbox(ORIGIN).sweepIdle(); // the refresh caches the session file and reads sub-agent $2
		// The settlement's state() read now fails: the fallback charges the live total plus the sub-agent files.
		driver.state = async () => {
			throw new OmpDriverError("rpc_error", "state failed");
		};
		await finishTurn(driver);
		const day = localDay(clock.now(), "Asia/Seoul");
		expect(store.dailyCost(day, ORIGIN)).toBeCloseTo(2.5, 6); // live $0.5 + sub-agent $2
		expect(store.getCursor(`charged:${ORIGIN}`)).toBeUndefined();
	});
});

describe("AC-2: daily ledger", () => {
	test("addDailyUsage accumulates one row per day and origin, and KST midnight starts a new row", () => {
		// 2026-11-10T14:59:00Z is 23:59 KST; one minute later is the next KST day (same UTC date).
		clock.t = Date.parse("2026-11-10T14:59:00Z");
		const late = localDay(clock.now(), "Asia/Seoul");
		store.addDailyUsage({ day: late, originKey: ORIGIN, cost: 1.5, calls: 2 });
		store.addDailyUsage({ day: late, originKey: ORIGIN, cost: 0.5, calls: 1 });
		store.addDailyUsage({ day: late, originKey: "monitor/daily", cost: 2, calls: 1 });
		expect(store.dailyCost(late)).toBe(4);
		expect(store.dailyCost(late, ORIGIN)).toBe(2);
		expect(store.topDailyOrigins(late, 3)).toEqual([
			{ originKey: ORIGIN, cost: 2 },
			{ originKey: "monitor/daily", cost: 2 },
		]);

		clock.advance(60_000);
		const next = localDay(clock.now(), "Asia/Seoul");
		expect(next).not.toBe(late);
		expect(store.dailyCost(next)).toBe(0);
		store.addDailyUsage({ day: next, originKey: ORIGIN, cost: 3, calls: 1 });
		expect(store.dailyCost(next)).toBe(3);
		expect(store.dailyCost(late)).toBe(4);
	});

	test("a finished turn adds its session-window cost: own $1 + in-window sub-agent $2, out-of-window $5 skipped", async () => {
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const turnStart = clock.now();
		const sessionFile = join(dir, "sessions", "session.jsonl");
		mkdirSync(dirname(sessionFile), { recursive: true });
		// The turn's own call sits after the start cursor; the pre-cursor call is an earlier turn's spend.
		const before = [
			{ id: "e1", type: "model_change", timestamp: new Date(turnStart - 60_000).toISOString() },
			{
				id: "e2",
				type: "message",
				timestamp: new Date(turnStart - 30_000).toISOString(),
				message: { role: "assistant", usage: { cost: { total: 7 } } },
			},
			{ id: "e3", type: "message", timestamp: new Date(turnStart).toISOString(), message: { role: "user" } },
			{
				id: "e4",
				type: "message",
				timestamp: new Date(turnStart + 1_000).toISOString(),
				message: { role: "assistant", usage: { cost: { total: 1 } } },
			},
		];
		writeFileSync(sessionFile, `${before.map((record) => JSON.stringify(record)).join("\n")}\n`);
		// Sub-agent transcripts beside the session: one record inside the turn window, one from hours earlier.
		const subFile = join(dir, "sessions", "session", "sub-1.jsonl");
		mkdirSync(dirname(subFile), { recursive: true });
		writeFileSync(
			subFile,
			`${[
				{ type: "model_usage", timestamp: new Date(turnStart + 2_000).toISOString(), usage: { cost: { total: 1.5 } } },
				{
					type: "message",
					timestamp: new Date(turnStart + 3_000).toISOString(),
					message: { role: "assistant", usage: { cost: { total: 0.5 } } },
				},
				{
					type: "model_usage",
					timestamp: new Date(turnStart - 7_200_000).toISOString(),
					usage: { cost: { total: 5 } },
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		sessionStore = new FakeSessionStore();
		router = buildRouter({ sessionFile });
		const driver = await startTurn("하위 에이전트를 쓰는 턴");
		driver.emitTestEvent(usageEvent(1));
		clock.advance(10_000);
		await finishTurn(driver);

		const day = localDay(turnStart, "Asia/Seoul");
		expect(store.dailyCost(day, ORIGIN)).toBeCloseTo(3, 6);
		expect(logLines.some((line) => line.includes("event=usage_daily_failed"))).toBe(false);
	});

	test("depth 2 sub-agents count once each: own $1 + child $1 + grandchild $2 = $4, past the depth cap skipped", async () => {
		const t0 = Date.parse("2026-11-10T12:00:00Z");
		const at = (ms: number): string => new Date(t0 + ms).toISOString();
		const usageLine = (ms: number, total: number): string =>
			`${JSON.stringify({ type: "model_usage", timestamp: at(ms), usage: { cost: { total } } })}\n`;
		const sessionFile = join(dir, "sessions", "session.jsonl");
		const stem = join(dir, "sessions", "session");
		mkdirSync(join(stem, "sub-a", "nested-b"), { recursive: true });
		writeFileSync(
			sessionFile,
			`${[
				{ id: "u0", type: "message", timestamp: at(-1_000), message: { role: "user" } },
				{
					id: "a1",
					type: "message",
					timestamp: at(1_000),
					message: { role: "assistant", usage: { cost: { total: 1 } } },
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		writeFileSync(join(stem, "sub-a.jsonl"), usageLine(2_000, 1));
		writeFileSync(join(stem, "sub-a", "nested-b.jsonl"), usageLine(3_000, 2));
		writeFileSync(join(stem, "sub-a", "nested-b", "too-deep.jsonl"), usageLine(4_000, 8));

		const got = await sessionWindowCost({ sessionFile, afterEntryId: "u0", from: t0, to: t0 + 10_000 });
		expect(got).toEqual({ cost: 4, calls: 3, lastEntryId: "a1" });
	});

	test("sessionWindowCost returns lastEntryId across non-usage entries, ignores session headers, and throws EntryNotFoundError", async () => {
		const t0 = Date.parse("2026-11-10T12:00:00Z");
		const at = (ms: number): string => new Date(t0 + ms).toISOString();
		const sessionFile = join(dir, "sessions", "last-id.jsonl");
		mkdirSync(dirname(sessionFile), { recursive: true });
		writeFileSync(
			sessionFile,
			`${[
				{ type: "session", id: "sess-hdr", timestamp: at(-5_000) },
				{ id: "u0", type: "message", timestamp: at(0), message: { role: "user" } },
				{
					id: "mu1",
					type: "model_usage",
					timestamp: at(1_000),
					purpose: "compaction:soft",
					usage: { cost: { total: 0.5 } },
				},
				{ id: "c1", type: "compaction", timestamp: at(2_000) },
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		expect(await sessionWindowCost({ sessionFile, afterEntryId: "u0", from: t0, to: t0 + 10_000 })).toEqual({
			cost: 0.5,
			calls: 1,
			lastEntryId: "c1",
		});
		expect(await sessionWindowCost({ sessionFile, afterEntryId: "c1", from: t0, to: t0 + 10_000 })).toEqual({
			cost: 0,
			calls: 0,
			lastEntryId: "c1",
		});
		await expect(
			sessionWindowCost({ sessionFile, afterEntryId: "missing", from: t0, to: t0 + 10_000 }),
		).rejects.toThrow(EntryNotFoundError);

		const headerOnly = join(dir, "sessions", "header-only.jsonl");
		writeFileSync(headerOnly, `${JSON.stringify({ type: "session", id: "sess-hdr", timestamp: at(0) })}\n`);
		expect(await sessionWindowCost({ sessionFile: headerOnly, afterEntryId: null, from: t0, to: t0 + 10_000 })).toEqual(
			{
				cost: 0,
				calls: 0,
			},
		);
	});

	test("sessionWindowCost defers usage past the last id-bearing record and charges it once on the next call", async () => {
		const t0 = Date.parse("2026-11-10T12:00:00Z");
		const at = (ms: number): string => new Date(t0 + ms).toISOString();
		const sessionFile = join(dir, "sessions", "trailing-usage.jsonl");
		mkdirSync(dirname(sessionFile), { recursive: true });
		writeFileSync(
			sessionFile,
			`${[
				{ id: "u0", type: "message", timestamp: at(0), message: { role: "user" } },
				{
					id: "a1",
					type: "message",
					timestamp: at(1000),
					message: { role: "assistant", usage: { cost: { total: 1 } } },
				},
				{ type: "model_usage", timestamp: at(2000), usage: { cost: { total: 0.5 } } },
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		expect(await sessionWindowCost({ sessionFile, afterEntryId: "u0", from: t0, to: t0 + 10_000 })).toEqual({
			cost: 1,
			calls: 1,
			lastEntryId: "a1",
		});
		appendFileSync(
			sessionFile,
			`${JSON.stringify({
				id: "a2",
				type: "message",
				timestamp: at(3000),
				message: { role: "assistant", usage: { cost: { total: 0.25 } } },
			})}\n`,
		);
		expect(await sessionWindowCost({ sessionFile, afterEntryId: "a1", from: t0, to: t0 + 10_000 })).toEqual({
			cost: 0.75,
			calls: 2,
			lastEntryId: "a2",
		});
	});

	test("a child dying mid-turn still adds the turn's live total to the day, once (#49)", async () => {
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const driver = await startTurn("도중에 죽는 턴");
		driver.emitTestEvent(usageEvent(1.25));
		driver.crash(137);
		await router.mailbox(ORIGIN).sweepIdle();
		// A second exit of the same child finds no turn left to charge.
		driver.crash(137);
		await router.mailbox(ORIGIN).sweepIdle();

		const day = localDay(clock.now(), "Asia/Seoul");
		expect(store.dailyCost(day, ORIGIN)).toBeCloseTo(1.25, 6);
		expect(bodies()).toEqual(["[turn failed] omp_exited code=137 — 다시 보내 주세요"]);
	});

	test("a turn settled by its final and then exiting is charged once (#49)", async () => {
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		router = buildRouter({ sessionFile: join(dir, "gone", "session.jsonl") });
		const driver = await startTurn("끝난 뒤 죽는 턴");
		driver.emitTestEvent(usageEvent(0.75));
		await finishTurn(driver);
		driver.crash(137);
		await router.mailbox(ORIGIN).sweepIdle();

		expect(store.dailyCost(localDay(clock.now(), "Asia/Seoul"), ORIGIN)).toBeCloseTo(0.75, 6);
	});

	test("an unreadable session file falls back to the turn's live total and logs usage_daily_failed", async () => {
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const sessionFile = join(dir, "gone", "session.jsonl");
		router = buildRouter({ sessionFile });
		const driver = await startTurn("세션 파일이 사라진 턴");
		driver.emitTestEvent(usageEvent(1.25));
		await finishTurn(driver);

		const day = localDay(clock.now(), "Asia/Seoul");
		expect(store.dailyCost(day, ORIGIN)).toBeCloseTo(1.25, 6);
		expect(logLines.some((line) => line.includes("event=usage_daily_failed"))).toBe(true);
	});

	test("a failing charge transaction drops the charge, still settles the turn, and the next turn charges the window once", async () => {
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const sessionFile = join(dir, "sessions", "session.jsonl");
		mkdirSync(dirname(sessionFile), { recursive: true });
		const seed = (records: readonly Record<string, unknown>[]): void => {
			appendFileSync(sessionFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		};
		const at = (ms: number): string => new Date(clock.now() + ms).toISOString();
		writeFileSync(
			sessionFile,
			`${[
				{ id: "e1", type: "model_change", timestamp: at(0) },
				{ id: "e2", type: "thinking_level_change", timestamp: at(0) },
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		router = buildRouter({ sessionFile });
		const day = localDay(clock.now(), "Asia/Seoul");
		// A cursor from an earlier turn: the failed charge must not advance it, so the next turn re-reads the window.
		store.setCursor(`charged:${ORIGIN}`, `${sessionFile}\te2`);
		const origCharge = store.chargeDailyUsage.bind(store);
		store.chargeDailyUsage = () => {
			throw new Error("SQLITE_BUSY: database is locked");
		};
		const driver1 = await startTurn("첫 턴");
		seed([
			{ id: "e3", type: "message", timestamp: at(1000), message: { role: "user" } },
			{
				id: "e4",
				type: "message",
				timestamp: at(2000),
				message: { role: "assistant", usage: { cost: { total: 1 } } },
			},
		]);
		driver1.emitTestEvent(usageEvent(1));
		await finishTurn(driver1);
		expect(logLines.some((line) => line.includes("event=usage_daily_failed"))).toBe(true);
		expect(store.dailyCost(day, ORIGIN)).toBe(0);
		expect(store.getCursor(`charged:${ORIGIN}`)).toBe(`${sessionFile}\te2`);
		expect(bodies()).toHaveLength(1);
		store.chargeDailyUsage = origCharge;
		const driver2 = await startTurn("둘째 턴");
		seed([
			{ id: "e5", type: "message", timestamp: at(3000), message: { role: "user" } },
			{
				id: "e6",
				type: "message",
				timestamp: at(4000),
				message: { role: "assistant", usage: { cost: { total: 0.5 } } },
			},
		]);
		driver2.emitTestEvent(usageEvent(0.5));
		await finishTurn(driver2);
		expect(store.dailyCost(day, ORIGIN)).toBeCloseTo(1.5, 6);
		expect(store.getCursor(`charged:${ORIGIN}`)).toBe(`${sessionFile}\te6`);
		expect(bodies()).toHaveLength(2);
	});

	test("a trailing id-less model_usage is charged once across two turns, not twice", async () => {
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const sessionFile = join(dir, "sessions", "session.jsonl");
		mkdirSync(dirname(sessionFile), { recursive: true });
		const seed = (records: readonly Record<string, unknown>[]): void => {
			appendFileSync(sessionFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		};
		const at = (ms: number): string => new Date(clock.now() + ms).toISOString();
		writeFileSync(
			sessionFile,
			`${[
				{ id: "e1", type: "model_change", timestamp: at(0) },
				{ id: "e2", type: "thinking_level_change", timestamp: at(0) },
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		router = buildRouter({ sessionFile });
		const day = localDay(clock.now(), "Asia/Seoul");
		store.setCursor(`charged:${ORIGIN}`, `${sessionFile}\te2`);
		const driver1 = await startTurn("첫 턴");
		seed([
			{ id: "e3", type: "message", timestamp: at(1000), message: { role: "user" } },
			{
				id: "e4",
				type: "message",
				timestamp: at(2000),
				message: { role: "assistant", usage: { cost: { total: 1 } } },
			},
			{ type: "model_usage", timestamp: at(2500), usage: { cost: { total: 0.5 } } },
		]);
		driver1.emitTestEvent(usageEvent(1));
		await finishTurn(driver1);
		expect(store.dailyCost(day, ORIGIN)).toBeCloseTo(1, 6);
		expect(store.getCursor(`charged:${ORIGIN}`)).toBe(`${sessionFile}\te4`);
		const driver2 = await startTurn("둘째 턴");
		seed([
			{ id: "e5", type: "message", timestamp: at(3000), message: { role: "user" } },
			{
				id: "e6",
				type: "message",
				timestamp: at(4000),
				message: { role: "assistant", usage: { cost: { total: 0.25 } } },
			},
		]);
		driver2.emitTestEvent(usageEvent(0.25));
		await finishTurn(driver2);
		expect(store.dailyCost(day, ORIGIN)).toBeCloseTo(1.75, 6);
		expect(store.getCursor(`charged:${ORIGIN}`)).toBe(`${sessionFile}\te6`);
	});
});

describe("agy turns in the daily ledger", () => {
	const AGY_TURN: OmpTurnUsage = {
		calls: 3,
		input: 3000,
		cacheRead: 207_000,
		output: 30,
		contextTokens: 70_000,
		rotated: false,
	};

	/** The origin's ledger row read straight from the database file (the store has no calls reader). */
	function ledgerRow(day: string): { cost: number; calls: number } | null {
		const db = new Database(join(dir, "jabbu.db"), { readonly: true });
		try {
			return db.query("SELECT cost, calls FROM usage_daily WHERE day = ? AND origin_key = ?").get(day, ORIGIN) as {
				cost: number;
				calls: number;
			} | null;
		} finally {
			db.close();
		}
	}

	test("an agy turn adds its model calls at cost 0 and logs agy_usage; the cost caps judge as before", async () => {
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		costCap = { turnUsd: 1, dailyUsd: 10 };
		router = buildRouter({ turnUsage: () => AGY_TURN });
		const day = localDay(clock.now(), "Asia/Seoul");

		await finishTurn(await startTurn("서팍 검토 한 번"));
		expect(ledgerRow(day)).toEqual({ cost: 0, calls: 3 });
		await finishTurn(await startTurn("두 번째 턴"));
		expect(ledgerRow(day)).toEqual({ cost: 0, calls: 6 });

		expect(store.dailyCost(day, ORIGIN)).toBe(0);
		expect(capWarnings).toEqual([]);
		expect(drivers.flatMap((driver) => driver.calls).filter((call) => call.startsWith("steer:"))).toEqual([]);
		const usage = logLines.filter((line) => line.includes("event=agy_usage"));
		expect(usage).toHaveLength(2);
		for (const field of [`origin=${ORIGIN}`, "input=3000", "cacheRead=207000", "output=30", "contextTokens=70000"]) {
			expect(usage[0]).toContain(field);
		}
		expect(logLines.some((line) => line.includes("event=usage_daily_failed"))).toBe(false);
	});
});
