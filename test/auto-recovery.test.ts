import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { OriginMailbox } from "../src/core/mailbox";
import { openBotStore, sessionDirFor } from "../src/core/origin";
import { proveToolFreeFailure, readSessionEntriesSince, TOOL_FREE_OP_PREFIX } from "../src/core/tool-free-recovery";
import { composeTurnPrompt, type InboundRecord } from "../src/core/types";
import { Daemon } from "../src/daemon/daemon";
import { PENDING_ALERT_AFTER } from "../src/daemon/daemon-constants";
import { recoverDispatched } from "../src/daemon/recovery";
import type { ProcessRunner } from "../src/dispatch/omp";
import { createLogger, type Logger } from "../src/log";
import type { OmpEntry, OmpFinal } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import type { UsageResponse } from "../src/omp/usage-json";
import { FALLBACK_QUOTA_RELEASE_MS, writeQuotaLift } from "../src/ops/quota-gate";
import {
	parseResetAtMs,
	providerHeadroomStatus,
	QUOTA_RECOVERY_CURSOR,
	QuotaRecoveryTracker,
	UNMETERED_QUOTA_HOLD_MS,
} from "../src/ops/quota-recovery";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";
import {
	CHANNEL,
	discordBinding,
	GUILD,
	makeHome,
	OWNER_DM,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";
import { daemonTestOptions } from "./helpers/disk";
import { SendFaultDriver } from "./helpers/send-fault-driver";

const BASE_NOW = Date.parse("2026-11-27T01:00:00Z");

function writeJsonl(path: string, rows: readonly unknown[], brokenTail?: string): void {
	const lines = rows.map((row) => JSON.stringify(row));
	if (brokenTail !== undefined) lines.push(brokenTail);
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

class ControllableDriver extends FakeOmpDriver {
	readonly #prompts: Array<{ text: string; opRef: string }> = [];
	readonly #waiters: Array<(entry: { text: string; opRef: string }) => void> = [];
	readonly #forcedErrors = new Map<string, string>();

	override onFinal(listener: (final: OmpFinal) => void): () => void {
		return super.onFinal((final) => {
			const forced = this.#forcedErrors.get(final.opRef);
			if (forced !== undefined) {
				this.#forcedErrors.delete(final.opRef);
				listener({ opRef: final.opRef, status: "error", text: "", error: forced });
				return;
			}
			listener(final);
		});
	}

	override async prompt(text: string): Promise<string> {
		const opRef = await super.prompt(text);
		const entry = { text, opRef };
		this.#prompts.push(entry);
		for (const waiter of this.#waiters.splice(0)) waiter(entry);
		return opRef;
	}

	waitPrompt(substr: string): Promise<string> {
		const existing = this.#prompts.find((entry) => entry.text.includes(substr));
		if (existing !== undefined) return Promise.resolve(existing.opRef);
		return new Promise<string>((resolve) => {
			const onEntry = (entry: { text: string; opRef: string }) => {
				if (entry.text.includes(substr)) resolve(entry.opRef);
				else this.#waiters.push(onEntry);
			};
			this.#waiters.push(onEntry);
		});
	}

	async failPrompt(substr: string, error: string): Promise<void> {
		const opRef = await this.waitPrompt(substr);
		this.#forcedErrors.set(opRef, error);
		await this.abort();
	}

	async releasePrompt(substr: string): Promise<void> {
		await this.waitPrompt(substr);
		this.release();
	}
}

describe("tool-free session journal proof", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "jabbu-toolfree-unit-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("proves error/aborted/errorMessage tool-free failures including wrapped prompts and model_change entries", () => {
		const file = join(tmpDir, "session.jsonl");
		const wrapped = composeTurnPrompt(["[맥락] 이전 요약"], "배포 상태를 확인해 줘");
		writeJsonl(file, [
			{ id: "e1", parentId: null, type: "session", version: 3 },
			{ id: "e2", parentId: "e1", type: "model_change", model: "anthropic/claude-opus-5-5" },
			{
				id: "e3",
				parentId: "e2",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: wrapped }] },
			},
			{
				id: "e4",
				parentId: "e3",
				type: "message",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "429 usage limit exhausted. resets in 15m",
				},
			},
		]);

		const entries = readSessionEntriesSince(file, "e2");
		expect(entries).toBeDefined();
		const proof = proveToolFreeFailure(entries ?? [], "배포 상태를 확인해 줘");
		expect(proof).toEqual({
			reason: "429 usage limit exhausted. resets in 15m",
			failureKind: "provider_limit",
			assistantEntryId: "e4",
		});

		const abortedEntries: OmpEntry[] = [
			{ id: "u1", type: "message", message: { role: "user", content: "안녕" } },
			{ id: "s1", type: "thinking_level_change" },
			{ id: "a1", type: "message", message: { role: "assistant", content: [], stopReason: "aborted" } },
		];
		expect(proveToolFreeFailure(abortedEntries, "안녕")).toEqual({
			reason: "aborted",
			failureKind: "unknown",
			assistantEntryId: "a1",
		});
	});

	test("rejects toolCall, tool_use, toolResult, bashExecution, completed stop, missing/empty tail, and torn JSONL", () => {
		const cases: Array<{ name: string; entries: OmpEntry[] }> = [
			{
				name: "toolUse stopReason",
				entries: [
					{ id: "u1", type: "message", message: { role: "user", content: "run" } },
					{
						id: "a1",
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
							stopReason: "toolUse",
						},
					},
				],
			},
			{
				name: "tool_use block even with stopReason error",
				entries: [
					{ id: "u1", type: "message", message: { role: "user", content: "run" } },
					{
						id: "a1",
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "tool_use", id: "c1", name: "bash" }],
							stopReason: "error",
							errorMessage: "429",
						} as OmpEntry["message"],
					},
				],
			},
			{
				name: "toolResult message",
				entries: [
					{ id: "u1", type: "message", message: { role: "user", content: "run" } },
					{ id: "r1", type: "message", message: { role: "toolResult", content: [] } },
					{ id: "a1", type: "message", message: { role: "assistant", content: [], stopReason: "error" } },
				],
			},
			{
				name: "non-whitelisted bashExecution entry",
				entries: [
					{ id: "u1", type: "message", message: { role: "user", content: "run" } },
					{ id: "b1", type: "bashExecution" },
					{ id: "a1", type: "message", message: { role: "assistant", content: [], stopReason: "error" } },
				],
			},
			{
				name: "completed stop answer",
				entries: [
					{ id: "u1", type: "message", message: { role: "user", content: "run" } },
					{
						id: "a1",
						type: "message",
						message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
					},
				],
			},
			{
				name: "empty tail after user prompt",
				entries: [{ id: "u1", type: "message", message: { role: "user", content: "run" } }],
			},
			{
				name: "missing prompt",
				entries: [{ id: "u1", type: "message", message: { role: "user", content: "other" } }],
			},
		];
		for (const item of cases) {
			expect(proveToolFreeFailure(item.entries, "run")).toBeUndefined();
		}

		// Unknown since cursor or torn tail fails closed.
		const file = join(tmpDir, "torn.jsonl");
		writeJsonl(
			file,
			[
				{ id: "e1", type: "session" },
				{ id: "e2", type: "message", message: { role: "user", content: "run" } },
				{ id: "e3", type: "message", message: { role: "assistant", content: [], stopReason: "error" } },
			],
			'{"id":"e4","type":"mess',
		);
		expect(readSessionEntriesSince(file, "e1")).toBeUndefined();
		expect(readSessionEntriesSince(file, "missing-cursor")).toBeUndefined();
	});
});

describe("QuotaRecoveryTracker and reset parsing", () => {
	test("parses relative, ISO, and local reset timestamps", () => {
		expect(parseResetAtMs("3h51m29s 뒤", BASE_NOW, "Asia/Seoul")).toBe(BASE_NOW + (3 * 3600 + 51 * 60 + 29) * 1000);
		expect(parseResetAtMs("15m 뒤", BASE_NOW, "Asia/Seoul")).toBe(BASE_NOW + 15 * 60_000);
		expect(parseResetAtMs("2026-11-27T04:30:00Z", BASE_NOW, "Asia/Seoul")).toBe(Date.parse("2026-11-27T04:30:00Z"));
		// Asia/Seoul is UTC+9: 2026-11-27 12:00:00 KST == 2026-11-27 03:00:00Z
		expect(parseResetAtMs("2026-11-27 12:00:00", BASE_NOW, "Asia/Seoul")).toBe(Date.parse("2026-11-27T03:00:00Z"));
		// BASE_NOW is 10:00 KST; "14:00" resolves to today 14:00 KST (05:00Z); "09:00" rolls to tomorrow 09:00 KST
		expect(parseResetAtMs("14:00", BASE_NOW, "Asia/Seoul")).toBe(Date.parse("2026-11-27T05:00:00Z"));
		expect(parseResetAtMs("09:00", BASE_NOW, "Asia/Seoul")).toBe(Date.parse("2026-11-28T00:00:00Z"));

		// Out-of-range wall times are not reset times (Date.UTC would silently normalize them).
		expect(parseResetAtMs("25:00", BASE_NOW, "Asia/Seoul")).toBeUndefined();
		expect(parseResetAtMs("14:60", BASE_NOW, "Asia/Seoul")).toBeUndefined();
		expect(parseResetAtMs("23:59:60", BASE_NOW, "Asia/Seoul")).toBeUndefined();
		expect(parseResetAtMs("2026-11-27 25:00:00", BASE_NOW, "Asia/Seoul")).toBeUndefined();
		expect(parseResetAtMs("2026-13-01 12:00:00", BASE_NOW, "Asia/Seoul")).toBeUndefined();
		expect(parseResetAtMs("23:59", BASE_NOW, "Asia/Seoul")).toBe(Date.parse("2026-11-27T14:59:00Z"));
		expect(parseResetAtMs("9:00", BASE_NOW, "Asia/Seoul")).toBe(Date.parse("2026-11-28T00:00:00Z"));
	});

	test("checks multi-account headroom and blocks premature release until actual headroom, lift, or fallback", () => {
		const multi: UsageResponse = {
			reports: [
				{ provider: "anthropic", limits: [{ label: "5h", amount: { unit: "percent", usedFraction: 0.99 } }] },
				{ provider: "anthropic", limits: [{ label: "5h", amount: { unit: "percent", usedFraction: 0.35 } }] },
				{
					provider: "zai",
					limits: [{ label: "5h", status: "exhausted", amount: { unit: "percent", usedFraction: 0.1 } }],
				},
			],
		};
		expect(providerHeadroomStatus(multi, "anthropic", 95)).toBe("recovered");
		expect(providerHeadroomStatus(multi, "zai", 95)).toBe("exhausted");
		expect(providerHeadroomStatus(multi, "openai-codex", 95)).toBe("unmetered");

		const tracker = new QuotaRecoveryTracker();
		tracker.recordQuotaError({
			provider: "anthropic",
			originKey: "discord/dm/1",
			reason: "429",
			resetAt: BASE_NOW + 60_000,
			now: BASE_NOW,
		});
		// Even after resetAt passes, exhausted usage report MUST NOT release the hold.
		const stillExhausted: UsageResponse = {
			reports: [{ provider: "anthropic", limits: [{ label: "5h", amount: { unit: "percent", usedFraction: 0.99 } }] }],
		};
		expect(tracker.evaluateUsageRecovery(stillExhausted, 95, BASE_NOW + 120_000)).toEqual([]);
		expect(tracker.holdForProvider("anthropic", BASE_NOW + 120_000)).toBeDefined();

		// Round-trip serialization preserves hold across restarts.
		const restored = new QuotaRecoveryTracker();
		restored.restore(tracker.serialize());
		expect(restored.listHolds()).toEqual(tracker.listHolds());

		// Recovered headroom releases cleanly.
		expect(restored.evaluateUsageRecovery(multi, 95, BASE_NOW + 180_000)).toEqual([
			{ provider: "anthropic", origins: ["discord/dm/1"], reason: "headroom_recovered" },
		]);
		expect(restored.hasHolds).toBe(false);

		// Unmetered provider releases after UNMETERED_QUOTA_HOLD_MS.
		restored.recordQuotaError({ provider: "custom", originKey: "discord/dm/2", reason: "429", now: BASE_NOW });
		expect(restored.evaluateUsageRecovery(multi, 95, BASE_NOW + UNMETERED_QUOTA_HOLD_MS - 1)).toEqual([]);
		expect(restored.evaluateUsageRecovery(multi, 95, BASE_NOW + UNMETERED_QUOTA_HOLD_MS)).toEqual([
			{ provider: "custom", origins: ["discord/dm/2"], reason: "unmetered_elapsed" },
		]);
	});

	test("a hold with a known future resetAt is not released by the 5h safety timeout", () => {
		const tracker = new QuotaRecoveryTracker();
		const resetAt = BASE_NOW + 7 * 24 * 3_600_000; // weekly window
		tracker.recordQuotaError({
			provider: "anthropic",
			originKey: "discord/dm/1",
			reason: "429",
			resetAt,
			now: BASE_NOW,
		});
		// Past the 5h fallback the weekly hold still blocks and emits no safety_timeout release.
		expect(tracker.holdForProvider("anthropic", BASE_NOW + FALLBACK_QUOTA_RELEASE_MS)).toBeDefined();
		expect(tracker.checkLiftsAndExpiry(BASE_NOW + FALLBACK_QUOTA_RELEASE_MS)).toEqual([]);
		expect(tracker.holdForProvider("anthropic", BASE_NOW + FALLBACK_QUOTA_RELEASE_MS)).toBeDefined();
		// Once the known reset itself passes, the safety timeout may release it.
		expect(tracker.checkLiftsAndExpiry(resetAt + 1)).toEqual([
			{ provider: "anthropic", origins: ["discord/dm/1"], reason: "safety_timeout" },
		]);
		expect(tracker.holdForProvider("anthropic", resetAt + 1)).toBeUndefined();
	});

	test("a hold without a known resetAt still releases on the 5h safety timeout", () => {
		const tracker = new QuotaRecoveryTracker();
		tracker.recordQuotaError({ provider: "zai", originKey: "discord/dm/1", reason: "429", now: BASE_NOW });
		expect(tracker.holdForProvider("zai", BASE_NOW + FALLBACK_QUOTA_RELEASE_MS - 1)).toBeDefined();
		expect(tracker.checkLiftsAndExpiry(BASE_NOW + FALLBACK_QUOTA_RELEASE_MS - 1)).toEqual([]);
		expect(tracker.checkLiftsAndExpiry(BASE_NOW + FALLBACK_QUOTA_RELEASE_MS)).toEqual([
			{ provider: "zai", origins: ["discord/dm/1"], reason: "safety_timeout" },
		]);
		expect(tracker.holdForProvider("zai", BASE_NOW + FALLBACK_QUOTA_RELEASE_MS)).toBeUndefined();
	});
});

describe("mailbox & recovery tool-free auto-closure", () => {
	const ORIGIN = "discord/ch/300000000000000001/t/100000000000000001";
	let dir: string;
	let clock: { now(): number };
	let store: Store;
	let log: Logger;
	let logs: string[];
	let counter = 0;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jabbu-toolfree-mb-"));
		clock = { now: () => BASE_NOW };
		store = openBotStore(join(dir, "jabbu.db"), clock, "Asia/Seoul");
		logs = [];
		log = createLogger({ sink: (line) => logs.push(line), clock, redact });
		counter = 0;
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function msg(text: string): InboundRecord {
		const id = `tf-${++counter}`;
		return {
			platformMessageId: id,
			originKey: ORIGIN,
			ownerVerified: true,
			text,
			threadRef: `300000000000000001:${id}`,
		};
	}

	test("runtime prompt_timeout closes tool-free failure as failed_notified without uncertain, while toolCall stays uncertain", async () => {
		const sessions = new FakeSessionStore();
		const sDir = sessionDirFor(join(dir, "sessions"), ORIGIN, 1);
		mkdirSync(sDir, { recursive: true });
		const sessionFile = join(sDir, "2026-11-27.jsonl");

		class FileTimeoutDriver extends SendFaultDriver {
			toolCallOnTimeout = false;
			override async prompt(text: string): Promise<string> {
				writeJsonl(sessionFile, [
					{ id: "e1", parentId: null, type: "model_change" },
					{ id: "e2", parentId: "e1", type: "thinking_level_change" },
					{ id: "e3", parentId: "e2", type: "message", message: { role: "user", content: [{ type: "text", text }] } },
					{
						id: "e4",
						parentId: "e3",
						type: "message",
						message: this.toolCallOnTimeout
							? {
									role: "assistant",
									content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }],
									stopReason: "toolUse",
								}
							: {
									role: "assistant",
									content: [],
									stopReason: "error",
									errorMessage: "429 usage limit exhausted",
								},
					},
				]);
				this.timeoutAfterDelivery = true;
				return super.prompt(text);
			}
		}

		let nextHasToolCall = false;
		const quotaErrors: string[] = [];
		const mailbox = new OriginMailbox({
			timezone: "Asia/Seoul",
			originKey: ORIGIN,
			store,
			clock,
			log,
			statusProvider: () => "ok",
			sessionDirFor: (k, e) => sessionDirFor(join(dir, "sessions"), k, e),
			onQuotaError: (info) => quotaErrors.push(info.reason),
			driverFactory: (_o, sd) => {
				const drv = new FileTimeoutDriver({ holdTurns: true, sessionDir: sd, store: sessions });
				drv.toolCallOnTimeout = nextHasToolCall;
				return drv;
			},
		});

		const first = msg("실패할 요청");
		await mailbox.enqueue(first);
		expect(store.getInbound(first.platformMessageId)?.state).toBe("failed_notified");
		expect(store.listInbound({ state: "uncertain" })).toHaveLength(0);
		expect(quotaErrors).toEqual(["429 usage limit exhausted"]);
		expect(store.listDeliveries({ originKey: ORIGIN }).at(-1)?.body).toContain("도구 실행 전 실패로 안전 종료");

		nextHasToolCall = true;
		const second = msg("도구 쓴 요청");
		await mailbox.enqueue(second);
		expect(store.getInbound(second.platformMessageId)).toMatchObject({
			state: "uncertain",
			uncertainReason: "prompt_timeout",
		});
		await mailbox.close();
	});

	test("boot recovery settles tool-free sending rows from .jsonl and FakeOmpDriver without resending", async () => {
		const sDir = sessionDirFor(join(dir, "sessions"), ORIGIN, 1);
		mkdirSync(sDir, { recursive: true });
		store.ensureOrigin(ORIGIN, sDir);
		const sessionFile = join(sDir, "boot.jsonl");

		const r1 = msg("부팅 전 도구 미호출 실패");
		const r2 = msg("부팅 전 미확인");
		store.recordInbound({
			originKey: ORIGIN,
			platformMessageId: r1.platformMessageId,
			textRef: r1.text,
			threadRef: r1.threadRef,
		});
		store.markSending(r1.platformMessageId, "e2");
		store.recordInbound({
			originKey: ORIGIN,
			platformMessageId: r2.platformMessageId,
			textRef: r2.text,
			threadRef: r2.threadRef,
		});
		store.markSending(r2.platformMessageId, "e4");

		writeJsonl(sessionFile, [
			{ id: "e1", type: "model_change" },
			{ id: "e2", type: "thinking_level_change" },
			{ id: "e3", type: "message", message: { role: "user", content: [{ type: "text", text: r1.text }] } },
			{
				id: "e4",
				type: "message",
				message: { role: "assistant", content: [], stopReason: "error", errorMessage: "rate_limit" },
			},
			{ id: "e5", type: "message", message: { role: "user", content: [{ type: "text", text: r2.text }] } },
		]);

		const res1 = await recoverDispatched({
			store,
			driverFactory: (_o, sd) => new FakeOmpDriver({ sessionDir: sd, store: new FakeSessionStore() }),
			log,
		});
		expect(res1).toEqual({ answered: 0, interrupted: 0, continued: 0, toolFreeClosed: 1 });
		expect(store.getInbound(r1.platformMessageId)).toMatchObject({
			state: "failed_notified",
			opRef: `${TOOL_FREE_OP_PREFIX}${r1.platformMessageId}`,
		});
		expect(store.getInbound(r2.platformMessageId)).toMatchObject({
			state: "uncertain",
			uncertainReason: "send_interrupted",
		});

		// Also verify in-memory FakeOmpDriver fallback (no .jsonl on disk) + post-turn uncertain auto-close.
		const memOrigin = "discord/dm/200000000000000099";
		const memDir = sessionDirFor(join(dir, "sessions"), memOrigin, 1);
		store.ensureOrigin(memOrigin, memDir);
		const memRow = {
			platformMessageId: "mem-1",
			originKey: memOrigin,
			textRef: "메모리 실패",
			threadRef: "200000000000000099:mem-1",
		};
		store.recordInbound(memRow);
		store.markSending("mem-1", "e2");

		const memSessions = new FakeSessionStore();
		const opened = memSessions.open(memDir);
		opened.entries.push(
			{
				id: "e3",
				parentId: "e2",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "메모리 실패" }] },
			},
			{ id: "e4", parentId: "e3", type: "message", message: { role: "assistant", content: [], stopReason: "aborted" } },
		);
		const res2 = await recoverDispatched({
			store,
			driverFactory: (_o, sd) => new FakeOmpDriver({ sessionDir: sd, store: memSessions }),
			log,
		});
		expect(res2.toolFreeClosed).toBe(1);
		expect(store.getInbound("mem-1")?.state).toBe("failed_notified");

		// Post-turn uncertain row proven tool-free on disk auto-closes as discarded after next turn settles.
		writeJsonl(sessionFile, [
			{ id: "e1", type: "model_change" },
			{ id: "e2", type: "thinking_level_change" },
			{ id: "e3", type: "message", message: { role: "user", content: [{ type: "text", text: r1.text }] } },
			{
				id: "e4",
				type: "message",
				message: { role: "assistant", content: [], stopReason: "error", errorMessage: "rate_limit" },
			},
			{ id: "e5", type: "message", message: { role: "user", content: [{ type: "text", text: r2.text }] } },
			{
				id: "e6",
				type: "message",
				message: { role: "assistant", content: [], stopReason: "error", errorMessage: "late failure" },
			},
		]);
		const settled = Promise.withResolvers<void>();
		const mb = new OriginMailbox({
			timezone: "Asia/Seoul",
			originKey: ORIGIN,
			store,
			clock,
			log,
			statusProvider: () => "ok",
			sessionDirFor: (k, e) => sessionDirFor(join(dir, "sessions"), k, e),
			driverFactory: (_o, sd) => new FakeOmpDriver({ sessionDir: sd, store: new FakeSessionStore() }),
			onTurnSettled: () => settled.resolve(),
		});
		await mb.enqueue(msg("후속 턴"));
		await settled.promise;
		await mb.close();
		expect(store.getInbound(r2.platformMessageId)?.state).toBe("discarded");
	});
});

describe("Daemon quota error hold, isolation, model switch, lift, and restart auto-release", () => {
	let home: TestHome;
	let daemons: Daemon[];
	let now: number;
	let logs: string[];

	beforeEach(() => {
		home = makeHome("jabbu-quota-rec-");
		daemons = [];
		now = BASE_NOW;
		logs = [];
	});

	afterEach(async () => {
		for (const d of daemons) await d.stop();
		home.remove();
	});

	function writeHomeConfig(patch: Record<string, unknown>): void {
		const current = JSON.parse(readFileSync(home.config.configPath, "utf8")) as Record<string, unknown>;
		writeFileSync(home.config.configPath, JSON.stringify({ ...current, ...patch }), { mode: 0o600 });
	}

	test("holds failing provider queue, skips stuck dispatch alerts, isolates other provider, and releases on verified headroom / lift / model switch / restart", async () => {
		writeHomeConfig({
			model: "anthropic/claude-opus-5-5",
			quotaGate: { holdPct: 95, pollMinutes: 5 },
		});
		const config = loadConfig(home.dir, { checkTokens: false });
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
		transport.setChannel({ id: "910000000000000001", type: 11, parentId: CHANNEL, guildId: GUILD });
		const sessions = new FakeSessionStore();
		const clock = { now: () => now };

		let usageMode: "fail" | "exhausted" | "recovered" = "exhausted";
		const usageLimitsRun: ProcessRunner = async () => {
			if (usageMode === "fail") {
				return { code: 1, signal: null, timedOut: false, stdout: "", stderr: "network error" };
			}
			const usedFraction = usageMode === "recovered" ? 0.2 : 0.99;
			return {
				code: 0,
				signal: null,
				timedOut: false,
				stdout: JSON.stringify({
					reports: [
						{
							provider: "anthropic",
							limits: [
								{
									label: "5h",
									amount: { unit: "percent", usedFraction },
									window: { id: "5h", label: "5h", resetsAt: now + 30 * 60_000 },
								},
							],
						},
					],
				}),
				stderr: "",
			};
		};

		const startDaemon = async (): Promise<{
			daemon: Daemon;
			waitDriver: (originKey: string) => Promise<ControllableDriver>;
		}> => {
			const drivers = new Map<string, ControllableDriver>();
			const waiters = new Map<string, Array<(drv: ControllableDriver) => void>>();
			const daemon = new Daemon({
				...daemonTestOptions(),
				config,
				channels: [discordBinding(transport)],
				driverFactory: (originKey, sessionDir) => {
					const drv = new ControllableDriver({
						sessionDir,
						store: sessions,
						holdTurns: true,
						models: ["anthropic/claude-opus-5-5", "zai/glm-5.4"],
					});
					drivers.set(originKey, drv);
					for (const waiter of waiters.get(originKey) ?? []) waiter(drv);
					waiters.delete(originKey);
					return drv;
				},
				log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
				ompVersion: "0.0.0-test",
				bootId: "boot-rec",
				clock,
				sweepMs: 3_600_000,
				gateSweepMs: 0,
				taskSweepMs: 0,
				pendingRetryMs: 1,
				usageLimitsRun,
			});
			daemons.push(daemon);
			await daemon.start();
			const waitDriver = (originKey: string): Promise<ControllableDriver> => {
				const existing = drivers.get(originKey);
				if (existing !== undefined) return Promise.resolve(existing);
				return new Promise((resolve) => {
					const list = waiters.get(originKey) ?? [];
					list.push(resolve);
					waiters.set(originKey, list);
				});
			};
			return { daemon, waitDriver };
		};

		const ORIGIN_1 = `discord/dm/${OWNER_DM}`;
		const ORIGIN_2 = `discord/ch/${CHANNEL}/t/910000000000000001`;
		const { daemon: d1, waitDriver: waitD1 } = await startDaemon();

		// 1. Origin 1 fails with 429 while a followup is queued -> followup stays pending & hold notice is posted.
		await d1.inject({ origin: ORIGIN_1, asOwner: true, text: "첫 요청" });
		await d1.inject({ origin: ORIGIN_1, asOwner: true, text: "!followup 보류될 후속 요청" });
		const drv1 = await waitD1(ORIGIN_1);
		await drv1.failPrompt("첫 요청", "429 Usage limit reached. resets in 15m");
		await transport.waitForPosts((text) => text.includes("대기열을 보류했습니다"), 1);

		expect(d1.store.listInbound({ originKey: ORIGIN_1, state: "pending" })).toHaveLength(1);
		expect(d1.store.getCursor(QUOTA_RECOVERY_CURSOR)).toContain("anthropic");

		// `!queue` displays the quota hold notice.
		await d1.inject({ origin: ORIGIN_1, asOwner: true, text: "!queue" });
		await transport.waitForPosts((text) => text.includes("복구 대기 중"));

		// 2. PendingDispatchSweep skips quota-held origins (no stuck dispatch alert even after > PENDING_ALERT_AFTER sweeps),
		//    and poll failure or exhausted usage report keeps ORIGIN_1 held.
		usageMode = "fail";
		for (let i = 0; i < PENDING_ALERT_AFTER + 1; i++) {
			now += 150_000;
			await d1.sweep();
			await d1.quotaIdle();
		}
		usageMode = "exhausted";
		now += 150_000;
		await d1.sweep();
		await d1.quotaIdle();
		expect(d1.store.listInbound({ originKey: ORIGIN_1, state: "pending" })).toHaveLength(1);
		expect(logs.some((line) => line.includes("event=pending_dispatch_notified"))).toBe(false);

		// 3. Origin 2 configured on another provider (`zai/glm-5.4`) runs normally despite anthropic hold.
		d1.store.ensureOrigin(ORIGIN_2, sessionDirFor(join(home.dir, "sessions"), ORIGIN_2, 1));
		d1.store.setOriginSettings(ORIGIN_2, { model: "zai/glm-5.4" });
		await d1.inject({
			origin: `discord/ch/${CHANNEL}`,
			asOwner: true,
			text: "다른 프로바이더 작업",
			thread: "910000000000000001",
		});
		const drv2 = await waitD1(ORIGIN_2);
		await drv2.releasePrompt("다른 프로바이더 작업");
		await transport.waitForPosts((text) => text.includes("ECHO 다른 프로바이더 작업"));

		// 4. Restart daemon while ORIGIN_1 is held -> hold persists across restart and auto-releases when usage recovers.
		await d1.stop();
		const { daemon: d2, waitDriver: waitD2 } = await startDaemon();
		expect(d2.store.listInbound({ originKey: ORIGIN_1, state: "pending" })).toHaveLength(1);

		usageMode = "recovered";
		now += 150_000;
		await d2.sweep();
		await d2.quotaIdle();
		await transport.waitForPosts((text) => text.includes("대기열을 자동 재개합니다"), 1);
		const drv1After = await waitD2(ORIGIN_1);
		await drv1After.releasePrompt("보류될 후속 요청");
		await transport.waitForPosts((text) => text.includes("ECHO 보류될 후속 요청"));

		// 5. Verify model switch immediately drains a quota-held queue & manual lift releases a quota-held queue.
		usageMode = "exhausted";
		await d2.inject({ origin: ORIGIN_1, asOwner: true, text: "두번째 한도 오류" });
		await d2.inject({ origin: ORIGIN_1, asOwner: true, text: "!followup 모델 전환으로 바로 실행" });
		await drv1After.failPrompt("두번째 한도 오류", "429 usage limit exhausted");
		await transport.waitForPosts((text) => text.includes("대기열을 보류했습니다"), 2);
		await d2.inject({ origin: ORIGIN_1, asOwner: true, text: "!model zai/glm-5.4" });
		await transport.waitForPosts((text) => text.includes("모델을 zai/glm-5.4(으)로 바꿨습니다"));
		await drv1After.releasePrompt("모델 전환으로 바로 실행");
		await transport.waitForPosts((text) => text.includes("ECHO 모델 전환으로 바로 실행"));

		// Switch back to anthropic (still held) -> queue a followup -> manual lift releases it on sweep.
		await d2.inject({ origin: ORIGIN_1, asOwner: true, text: "!model anthropic/claude-opus-5-5" });
		await transport.waitForPosts((text) => text.includes("모델을 anthropic/claude-opus-5-5(으)로 바꿨습니다"));
		await d2.inject({ origin: ORIGIN_1, asOwner: true, text: "!followup 수동 해제로 실행" });
		expect(d2.store.listInbound({ originKey: ORIGIN_1, state: "pending" })).toHaveLength(1);
		writeQuotaLift(home.dir, { provider: "anthropic", untilMs: now + 600_000, now });
		now += 3_000;
		await d2.sweep();
		await d2.quotaIdle();
		await transport.waitForPosts((text) => text.includes("수동 해제로 보류 중이던 대기열을 자동 재개합니다"), 1);
		await drv1After.releasePrompt("수동 해제로 실행");
		await transport.waitForPosts((text) => text.includes("ECHO 수동 해제로 실행"));
	}, 30_000);

	test("skips quota hold on short-window rate_limited errors while holding billing exhaustion", async () => {
		writeHomeConfig({ model: "anthropic/claude-opus-5-5" });
		const config = loadConfig(home.dir, { checkTokens: false });
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
		const sessions = new FakeSessionStore();
		const clock = { now: () => now };
		const drivers = new Map<string, ControllableDriver>();
		const waiters = new Map<string, Array<(drv: ControllableDriver) => void>>();
		const daemon = new Daemon({
			...daemonTestOptions(),
			config,
			channels: [discordBinding(transport)],
			driverFactory: (originKey, sessionDir) => {
				const drv = new ControllableDriver({
					sessionDir,
					store: sessions,
					holdTurns: true,
					models: ["anthropic/claude-opus-5-5"],
				});
				drivers.set(originKey, drv);
				for (const waiter of waiters.get(originKey) ?? []) waiter(drv);
				waiters.delete(originKey);
				return drv;
			},
			log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
			ompVersion: "0.0.0-test",
			bootId: "boot-rl",
			clock,
			sweepMs: 3_600_000,
			gateSweepMs: 0,
			taskSweepMs: 0,
			pendingRetryMs: 1,
		});
		daemons.push(daemon);
		await daemon.start();
		const waitDriver = (originKey: string): Promise<ControllableDriver> => {
			const existing = drivers.get(originKey);
			if (existing !== undefined) return Promise.resolve(existing);
			return new Promise((resolve) => {
				const list = waiters.get(originKey) ?? [];
				list.push(resolve);
				waiters.set(originKey, list);
			});
		};

		const ORIGIN_1 = `discord/dm/${OWNER_DM}`;
		await daemon.inject({ origin: ORIGIN_1, asOwner: true, text: "속도 제한 요청" });
		await daemon.inject({ origin: ORIGIN_1, asOwner: true, text: "!followup 바로 이어질 작업" });
		const drv = await waitDriver(ORIGIN_1);
		await drv.failPrompt("속도 제한 요청", "429 Rate limit reached for requests per min (RPM): retry in 20s");
		await drv.releasePrompt("바로 이어질 작업");
		await transport.waitForPosts((text) => text.includes("ECHO 바로 이어질 작업"));
		expect(logs.some((line) => line.includes("event=quota_error_hold_skipped"))).toBe(true);
		expect(daemon.store.getCursor(QUOTA_RECOVERY_CURSOR)).toBeUndefined();
		expect(transport.posts((text) => text.includes("대기열을 보류했습니다"))).toHaveLength(0);

		await daemon.inject({ origin: ORIGIN_1, asOwner: true, text: "크레딧 소진 요청" });
		await daemon.inject({ origin: ORIGIN_1, asOwner: true, text: "!followup 보류될 요청" });
		await drv.failPrompt("크레딧 소진 요청", "402 Payment Required: insufficient credits");
		await transport.waitForPosts((text) => text.includes("대기열을 보류했습니다"), 1);
		expect(daemon.store.getCursor(QUOTA_RECOVERY_CURSOR)).toContain("anthropic");
		expect(daemon.store.listInbound({ originKey: ORIGIN_1, state: "pending" })).toHaveLength(1);
	}, 20_000);
});
