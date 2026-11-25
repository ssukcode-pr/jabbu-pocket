import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OriginMailbox } from "../src/core/mailbox";
import { openBotStore, sessionDirFor } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { recoverDispatched, writeRestartCut } from "../src/daemon/recovery";
import { buildSnapshot } from "../src/dashboard/snapshot";
import { createLogger, type Logger } from "../src/log";
import type { OmpSessionDriver } from "../src/omp/driver";
import { FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";
import { SendFaultDriver } from "./helpers/send-fault-driver";

const ORIGIN = "discord/ch/300000000000000001/t/100000000000000001";

type Faults = Partial<
	Pick<SendFaultDriver, "timeoutAfterDelivery" | "notStartedNext" | "cutAfterDelivery" | "cutBeforeSend">
>;

let dir: string;
let clock: { now(): number };
let store: Store;
let log: Logger;
let sessions: FakeSessionStore;
let opened: SendFaultDriver[];
/** Faults of the next drivers the factory builds, in order. */
let faults: Faults[];
/** Resolves when a driver's send is cut (the old process stops there for good). */
let cut: PromiseWithResolvers<void>;
let counter = 0;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-mailbox-sending-"));
	clock = { now: () => 1_700_000_000_000 };
	store = openBotStore(join(dir, "jabbu.db"), clock, "Asia/Seoul");
	log = createLogger({ sink: () => undefined, clock, redact });
	sessions = new FakeSessionStore();
	opened = [];
	faults = [];
	cut = Promise.withResolvers<void>();
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function driverFactory(_origin: string, sessionDir: string): OmpSessionDriver {
	const driver = new SendFaultDriver({ holdTurns: true, sessionDir, store: sessions });
	Object.assign(driver, faults.shift() ?? {});
	driver.onCut = () => cut.resolve();
	opened.push(driver);
	return driver;
}

/** One daemon process's mailbox of {@link ORIGIN}; a new one over the same ledger is the next process. */
function makeMailbox(): OriginMailbox {
	return new OriginMailbox({
		timezone: "Asia/Seoul",
		originKey: ORIGIN,
		store,
		clock,
		log,
		statusProvider: () => "status: ok",
		sessionDirFor: (key, epoch) => sessionDirFor(join(dir, "sessions"), key, epoch),
		driverFactory,
	});
}

function msg(text: string): InboundRecord {
	const id = `s${++counter}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: `300000000000000001:${id}` };
}

/** Every prompt / steer any child got, across all drivers (the process restart's too). */
const sent = (kind: "prompt" | "steer") => opened.flatMap((d) => d.calls.filter((c) => c.startsWith(`${kind}:`)));

/** The next process: boot recovery (`recoverDispatched`) and the origin's `resumePending`, as the daemon runs them. */
async function nextProcess(): Promise<OriginMailbox> {
	await recoverDispatched({ store, driverFactory, log, homeDir: dir, now: () => clock.now() });
	const mailbox = makeMailbox();
	await mailbox.resumePending();
	return mailbox;
}

describe("gap 2: request_timeout after the child got the prompt", () => {
	test("the prompt is not sent again: the row is uncertain (prompt_timeout) and the child is stopped", async () => {
		faults = [{ timeoutAfterDelivery: true }];
		const mailbox = makeMailbox();
		const row = msg("배포 커밋 만들어 줘");
		await mailbox.enqueue(row);
		expect(sent("prompt")).toHaveLength(1);
		expect(opened).toHaveLength(1);
		expect(store.getInbound(row.platformMessageId)).toMatchObject({
			state: "uncertain",
			uncertainReason: "prompt_timeout",
		});
		expect(mailbox.turnPending).toBe(false);
		expect(mailbox.state.driverRunning).toBe(false);
		// The next message starts its own turn; the parked one stays out of it.
		const next = msg("다음 일");
		await mailbox.enqueue(next);
		expect(sent("prompt")).toHaveLength(2);
		expect(sent("prompt")[1]).toContain("다음 일");
		expect(sent("prompt")[1]).not.toContain("배포 커밋");
		expect(store.getInbound(row.platformMessageId)?.state).toBe("uncertain");
	});

	test("not_started (the child never got it) is retried once on a new driver, with the write-ahead written again", async () => {
		faults = [{ notStartedNext: true }];
		const marks: string[] = [];
		const markSending = store.markSending.bind(store);
		store.markSending = (id, cursor) => {
			marks.push(id);
			return markSending(id, cursor);
		};
		const mailbox = makeMailbox();
		const row = msg("한 번만 실행할 일");
		await mailbox.enqueue(row);
		expect(opened).toHaveLength(2);
		expect(opened[0]?.calls.filter((c) => c.startsWith("prompt:"))).toEqual([]);
		expect(sent("prompt")).toHaveLength(1);
		expect(marks).toEqual([row.platformMessageId, row.platformMessageId]);
		expect(store.getInbound(row.platformMessageId)?.state).toBe("dispatched");
	});
});

describe("gap 1: the process is cut while a send is in flight", () => {
	for (const withCutRecord of [false, true]) {
		test(`cut during the prompt (sending${withCutRecord ? ", cut record on disk" : ", kill -9"}): the next process parks the row, never prompts it again`, async () => {
			faults = [{ cutAfterDelivery: true }];
			const row = msg("푸시까지 해 줘");
			void makeMailbox().enqueue(row);
			await cut.promise;
			expect(store.getInbound(row.platformMessageId)?.state).toBe("sending");
			if (withCutRecord) {
				writeRestartCut(dir, {
					at: clock.now(),
					applyStamp: "apply-1",
					opRefs: [{ originKey: ORIGIN, opRef: "fake_req_1" }],
				});
			}
			await nextProcess();
			expect(store.getInbound(row.platformMessageId)).toMatchObject({
				state: "uncertain",
				uncertainReason: "send_interrupted",
			});
			expect(sent("prompt")).toHaveLength(1);
			expect(store.listDeliveries({ originKey: ORIGIN })).toEqual([]);
		});
	}

	test("cut during a steer (sending): parked on the next process, never steered or prompted again", async () => {
		const first = makeMailbox();
		const lead = msg("긴 작업");
		await first.enqueue(lead);
		const driver = opened[0] as SendFaultDriver;
		driver.cutAfterDelivery = true;
		const steered = msg("그리고 태그도 달아 줘");
		void first.enqueue(steered);
		await cut.promise;
		expect(store.getInbound(steered.platformMessageId)?.state).toBe("sending");
		await nextProcess();
		expect(store.getInbound(steered.platformMessageId)).toMatchObject({
			state: "uncertain",
			uncertainReason: "send_interrupted",
		});
		expect(sent("steer")).toEqual(["steer:그리고 태그도 달아 줘"]);
		expect(sent("prompt")).toHaveLength(1);
	});

	test("cut before the write-ahead (still pending): the next process prompts the row once", async () => {
		faults = [{ cutBeforeSend: true }];
		const row = msg("아직 안 보낸 일");
		void makeMailbox().enqueue(row);
		await cut.promise;
		expect(store.getInbound(row.platformMessageId)?.state).toBe("pending");
		expect(sent("prompt")).toEqual([]);
		await nextProcess();
		expect(sent("prompt")).toHaveLength(1);
		expect(sent("prompt")[0]).toContain("아직 안 보낸 일");
		expect(store.getInbound(row.platformMessageId)?.state).toBe("dispatched");
	});
});

describe("the owner sees a send-interrupted row where uncertain rows already show", () => {
	test("turn board 'attention' column and the /queue 전달 불확실 line", async () => {
		faults = [{ cutAfterDelivery: true }];
		const row = msg("두 번 돌면 안 되는 일");
		void makeMailbox().enqueue(row);
		await cut.promise;
		const mailbox = await nextProcess();
		expect(store.getInbound(row.platformMessageId)?.state).toBe("uncertain");

		const snapshot = await buildSnapshot({
			homeDir: dir,
			repoDir: dir,
			timezone: "Asia/Seoul",
			config: undefined,
			now: () => clock.now(),
			callDaemon: async () => {
				throw new Error("no daemon");
			},
			run: async () => ({ code: 1, stdout: "", timedOut: false }),
			ompVersion: async () => "omp-stub 0.0.0",
			hostOps: () => {
				throw new Error("no hosts");
			},
			collectGates: () => [],
		});
		if (!snapshot.turns.ok) throw new Error(`turns section failed: ${snapshot.turns.error}`);
		expect(snapshot.turns.items.map((turn) => [turn.state, turn.preview])).toEqual([
			["uncertain", "두 번 돌면 안 되는 일"],
		]);
		expect(snapshot.turns.threads.find((thread) => thread.originKey === ORIGIN)?.column).toBe("attention");

		const queue = msg("!queue");
		await mailbox.enqueue(queue);
		const reply = store
			.listDeliveries({ originKey: ORIGIN })
			.filter((delivery) => delivery.threadRef === queue.threadRef)
			.map((delivery) => delivery.body)
			.join("\n");
		expect(reply).toContain("⚠ 전달 불확실");
		expect(reply).toContain("1. [전송 중 재시작·중단 · 불확실] 두 번 돌면 안 되는 일");
		expect(sent("prompt")).toHaveLength(1);
	});
});
