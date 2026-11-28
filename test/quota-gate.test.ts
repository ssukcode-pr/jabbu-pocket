import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quotaCommand } from "../src/cli/quota";
import { ConfigError, type JabbuConfig, loadConfig } from "../src/config";
import { OriginRouter, openBotStore, sessionDirFor } from "../src/core/origin";
import type { DaemonContext } from "../src/daemon/daemon-context";
import { DaemonQuotaGate } from "../src/daemon/daemon-quota";
import { LIVE_FIELDS } from "../src/daemon/reload";
import { DiscordChannel } from "../src/discord/channel";
import type { ProcessRunner } from "../src/dispatch/omp";
import { LaneManager } from "../src/lanes/manager";
import { LaneInputError } from "../src/lanes/manager-constants";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import type { UsageResponse } from "../src/omp/usage-json";
import { IDLE_HOST_LOAD } from "../src/ops/host-resources";
import {
	clearQuotaLift,
	evaluateUsageResponse,
	FALLBACK_QUOTA_RELEASE_MS,
	ProviderQuotaGate,
	providerOfModel,
	quotaGatePath,
	readQuotaGateSnapshot,
	readQuotaLifts,
	usedPercentOfLimit,
	writeQuotaLift,
} from "../src/ops/quota-gate";
import { QUOTA_RECOVERY_CURSOR, QuotaRecoveryTracker } from "../src/ops/quota-recovery";
import { executeQuotaReset } from "../src/ops/quota-reset";
import { redact } from "../src/redact";
import { startTask, type TaskDispatchDeps } from "../src/tasks/dispatch";
import { createTaskHostOps, type TaskHostOps, type TaskResumeOps } from "../src/tasks/host";
import { TaskLedger } from "../src/tasks/ledger";
import { CHANNEL, makeHome, OWNER, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { runCliCapture } from "./helpers/daemon-process";
import { ROOMY_STATFS } from "./helpers/disk";
import { makeRepo } from "./helpers/git-fixtures";
import { removeRepoAndWorktrees } from "./helpers/lane-harness";

const BASE_NOW = Date.parse("2026-11-26T06:00:00Z");

let home: TestHome;
let repos: string[];
let tempDirs: string[];

beforeEach(() => {
	home = makeHome("jabbu-quota-");
	repos = [];
	tempDirs = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function writeHomeConfig(patch: Record<string, unknown>): void {
	const current = JSON.parse(readFileSync(home.config.configPath, "utf8")) as Record<string, unknown>;
	writeFileSync(home.config.configPath, JSON.stringify({ ...current, ...patch }), { mode: 0o600 });
}

function usagePayload(reports: UsageResponse["reports"]): UsageResponse {
	return { generatedAt: BASE_NOW, reports };
}

describe("providerOfModel and usedPercentOfLimit", () => {
	test("extracts normalized provider prefix and ignores models without a slash", () => {
		expect(providerOfModel("anthropic/claude-opus-5-5:high")).toBe("anthropic");
		expect(providerOfModel("  ZAI/glm-5.4:low  ")).toBe("zai");
		expect(providerOfModel("openai-codex/gpt-5")).toBe("openai-codex");
		expect(providerOfModel("claude-opus-5-5")).toBeUndefined();
		expect(providerOfModel("agy:gemini-pro")).toBeUndefined();
		expect(providerOfModel("/claude")).toBeUndefined();
		expect(providerOfModel("   ")).toBeUndefined();
		expect(providerOfModel(undefined)).toBeUndefined();
	});

	test("computes used percentage across all supported usage shapes", () => {
		expect(usedPercentOfLimit({ label: "5h", amount: { unit: "percent", usedFraction: 0.96 } })).toBeCloseTo(96);
		expect(usedPercentOfLimit({ label: "5h", amount: { unit: "percent", remainingFraction: 0.03 } })).toBeCloseTo(97);
		expect(usedPercentOfLimit({ label: "tokens", amount: { unit: "tokens", used: 950, limit: 1000 } })).toBeCloseTo(95);
		expect(usedPercentOfLimit({ label: "tokens", amount: { unit: "tokens", remaining: 10, limit: 200 } })).toBeCloseTo(
			95,
		);
		expect(usedPercentOfLimit({ label: "pct", amount: { unit: "percent", used: 92 } })).toBeCloseTo(92);
		expect(usedPercentOfLimit({ label: "pct", amount: { unit: "percent", remaining: 4 } })).toBeCloseTo(96);
		expect(
			usedPercentOfLimit({ label: "5h", status: "exhausted", amount: { unit: "percent", usedFraction: 0.5 } }),
		).toBe(100);
		expect(usedPercentOfLimit({ label: "bad", amount: { unit: "unknown" } })).toBeUndefined();
	});
});

describe("ProviderQuotaGate isolation, auto-release, and manual lifts", () => {
	test("holds only the provider at or above holdPct and keeps other providers open", () => {
		const gate = new ProviderQuotaGate();
		const resetAt = BASE_NOW + 3_600_000;
		const response = usagePayload([
			{
				provider: "anthropic",
				limits: [
					{
						label: "Claude 5h",
						amount: { unit: "percent", usedFraction: 0.96 },
						window: { id: "5h", label: "5h", resetsAt: resetAt },
					},
				],
			},
			{
				provider: "zai",
				limits: [
					{ label: "ZAI 1w", amount: { unit: "percent", usedFraction: 0.4 }, window: { id: "1w", label: "1w" } },
				],
			},
		]);
		const { opened, cleared } = gate.updateFromUsage(response, { holdPct: 95 }, BASE_NOW);
		expect(cleared).toEqual([]);
		expect(opened.map((entry) => entry.provider)).toEqual(["anthropic"]);

		expect(gate.checkModel("anthropic/claude-opus-5-5:high", BASE_NOW)).toBeDefined();
		expect(gate.checkModel("zai/glm-5.4", BASE_NOW)).toBeUndefined();
		expect(gate.checkModel("openai-codex/gpt-5", BASE_NOW)).toBeUndefined();
		expect(gate.checkModel("bare-model", BASE_NOW)).toBeUndefined();
	});

	test("auto-releases on recovery, reset timestamp expiry even across poll failures, and 5h fallback", () => {
		const gate = new ProviderQuotaGate();
		const resetAt = BASE_NOW + 30 * 60_000;

		// 1. Recovery when a new usage report drops below threshold.
		gate.updateFromUsage(
			usagePayload([
				{
					provider: "anthropic",
					limits: [
						{
							label: "5h",
							amount: { unit: "percent", usedFraction: 0.98 },
							window: { id: "5h", label: "5h", resetsAt: resetAt },
						},
					],
				},
			]),
			{ holdPct: 95 },
			BASE_NOW,
		);
		const recovered = gate.updateFromUsage(
			usagePayload([
				{
					provider: "anthropic",
					limits: [
						{
							label: "5h",
							amount: { unit: "percent", usedFraction: 0.2 },
							window: { id: "5h", label: "5h", resetsAt: resetAt },
						},
					],
				},
			]),
			{ holdPct: 95 },
			BASE_NOW + 60_000,
		);
		expect(recovered.cleared).toEqual(["anthropic"]);
		expect(gate.checkModel("anthropic/claude-opus-5-5", BASE_NOW + 60_000)).toBeUndefined();

		// 2. Poll failure never creates a hold (fail-open), and reset expiry still clears existing holds.
		gate.updateFromUsage(
			usagePayload([
				{
					provider: "anthropic",
					limits: [
						{
							label: "5h",
							amount: { unit: "percent", usedFraction: 0.99 },
							window: { id: "5h", label: "5h", resetsAt: resetAt },
						},
					],
				},
			]),
			{ holdPct: 95 },
			BASE_NOW,
		);
		expect(gate.notePollError("omp usage exited 1", BASE_NOW + 10_000)).toEqual([]);
		expect(gate.checkModel("anthropic/claude-opus-5-5", BASE_NOW + 10_000)).toBeDefined();
		expect(gate.notePollError("omp usage exited 1", resetAt)).toEqual(["anthropic"]);
		expect(gate.checkModel("anthropic/claude-opus-5-5", resetAt)).toBeUndefined();

		// 3. Fallback 5h release when resetsAt is omitted.
		gate.updateFromUsage(
			usagePayload([
				{
					provider: "zai",
					limits: [{ label: "5h", amount: { unit: "percent", usedFraction: 0.96 } }],
				},
			]),
			{ holdPct: 95 },
			BASE_NOW,
		);
		expect(gate.checkModel("zai/glm-5.4", BASE_NOW + FALLBACK_QUOTA_RELEASE_MS - 1)).toBeDefined();
		expect(gate.checkModel("zai/glm-5.4", BASE_NOW + FALLBACK_QUOTA_RELEASE_MS)).toBeUndefined();

		// 4. Filter by configured providers and ignore already-elapsed reset windows.
		const filtered = evaluateUsageResponse(
			usagePayload([
				{
					provider: "anthropic",
					limits: [
						{
							label: "5h",
							amount: { unit: "percent", usedFraction: 0.99 },
							window: { id: "5h", label: "5h", resetsAt: BASE_NOW - 1 },
						},
					],
				},
				{
					provider: "zai",
					limits: [{ label: "1w", amount: { unit: "percent", usedFraction: 0.99 } }],
				},
			]),
			{ holdPct: 95, providers: ["anthropic"] },
			BASE_NOW,
		);
		expect(filtered.size).toBe(0);
	});

	test("supports provider-specific and wildcard manual lifts with expiry and clear", () => {
		const gate = new ProviderQuotaGate();
		gate.updateFromUsage(
			usagePayload([
				{ provider: "anthropic", limits: [{ label: "5h", amount: { unit: "percent", usedFraction: 0.98 } }] },
				{ provider: "zai", limits: [{ label: "5h", amount: { unit: "percent", usedFraction: 0.98 } }] },
			]),
			{ holdPct: 95 },
			BASE_NOW,
		);

		writeQuotaLift(home.dir, { provider: "anthropic", untilMs: BASE_NOW + 60_000, now: BASE_NOW });
		let lifts = readQuotaLifts(home.dir, BASE_NOW);
		expect(gate.checkModel("anthropic/claude-opus-5-5", BASE_NOW, lifts)).toBeUndefined();
		expect(gate.checkModel("zai/glm-5.4", BASE_NOW, lifts)).toBeDefined();

		// Expired lift is ignored.
		lifts = readQuotaLifts(home.dir, BASE_NOW + 60_000);
		expect(gate.checkModel("anthropic/claude-opus-5-5", BASE_NOW + 60_000, lifts)).toBeDefined();

		// Wildcard lift overrides every provider until cleared.
		writeQuotaLift(home.dir, { provider: "*", untilMs: BASE_NOW + 120_000, now: BASE_NOW });
		lifts = readQuotaLifts(home.dir, BASE_NOW + 10_000);
		expect(gate.checkModel("zai/glm-5.4", BASE_NOW + 10_000, lifts)).toBeUndefined();
		expect(clearQuotaLift(home.dir, "*")).toBe(1);
		lifts = readQuotaLifts(home.dir, BASE_NOW + 10_000);
		expect(gate.checkModel("zai/glm-5.4", BASE_NOW + 10_000, lifts)).toBeDefined();
	});

	test("clearing all lifts counts only the lifts in the file, never a phantom one", () => {
		// No file at all: nothing cleared.
		expect(clearQuotaLift(home.dir)).toBe(0);
		// A file that exists but holds no lifts (empty or torn): still 0, and the file goes away.
		writeFileSync(join(home.dir, "quota-lift.json"), JSON.stringify({ lifts: {} }));
		expect(clearQuotaLift(home.dir)).toBe(0);
		expect(existsSync(join(home.dir, "quota-lift.json"))).toBe(false);
		writeFileSync(join(home.dir, "quota-lift.json"), "not json{");
		expect(clearQuotaLift(home.dir)).toBe(0);
		// Two real lifts: both counted.
		writeQuotaLift(home.dir, { provider: "anthropic", untilMs: BASE_NOW + 60_000, now: BASE_NOW });
		writeQuotaLift(home.dir, { provider: "zai", untilMs: BASE_NOW + 60_000, now: BASE_NOW });
		expect(clearQuotaLift(home.dir)).toBe(2);
	});

	test("keeps multi-account providers open while any account remains below holdPct", () => {
		const gate = new ProviderQuotaGate();
		const resetAt = BASE_NOW + 3_600_000;
		const partial = usagePayload([
			{
				provider: "anthropic",
				limits: [
					{
						label: "Claude 5h",
						amount: { unit: "percent", usedFraction: 0.99 },
						window: { id: "5h", label: "5h", resetsAt: resetAt },
					},
				],
			},
			{
				provider: "anthropic",
				limits: [
					{
						label: "Claude 5h",
						amount: { unit: "percent", usedFraction: 0.2 },
						window: { id: "5h", label: "5h", resetsAt: resetAt },
					},
				],
			},
		]);
		const first = gate.updateFromUsage(partial, { holdPct: 95 }, BASE_NOW);
		expect(first.opened).toEqual([]);
		expect(gate.checkModel("anthropic/claude-opus-5-5:high", BASE_NOW)).toBeUndefined();

		const allExhausted = usagePayload([
			{
				provider: "anthropic",
				limits: [
					{
						label: "Claude 5h",
						amount: { unit: "percent", usedFraction: 0.96 },
						window: { id: "5h", label: "5h", resetsAt: resetAt },
					},
				],
			},
			{
				provider: "anthropic",
				limits: [
					{
						label: "Claude 5h",
						amount: { unit: "percent", usedFraction: 0.98 },
						window: { id: "5h", label: "5h", resetsAt: resetAt },
					},
				],
			},
		]);
		const second = gate.updateFromUsage(allExhausted, { holdPct: 95 }, BASE_NOW + 60_000);
		expect(second.opened.map((entry) => entry.provider)).toEqual(["anthropic"]);
		expect(gate.checkModel("anthropic/claude-opus-5-5:high", BASE_NOW + 60_000)).toBeDefined();
	});
});

describe("config validation and live reload", () => {
	test("validates quotaGate fields and registers quotaGate as a LIVE_FIELD", () => {
		expect(LIVE_FIELDS).toContain("quotaGate");
		expect(loadConfig(home.dir).quotaGate).toBeUndefined();

		writeHomeConfig({
			quotaGate: { holdPct: 90, pollMinutes: 3, providers: ["Anthropic", "zai", "anthropic"], mode: "warn" },
		});
		expect(loadConfig(home.dir).quotaGate).toEqual({
			holdPct: 90,
			pollMinutes: 3,
			providers: ["anthropic", "zai"],
			mode: "warn",
		});

		writeHomeConfig({ quotaGate: { mode: "hold" } });
		expect(loadConfig(home.dir).quotaGate).toEqual({ mode: "hold" });

		for (const [field, bad] of [
			["quotaGate", 95],
			["quotaGate.extra", { holdPct: 95, extra: 1 }],
			["quotaGate.holdPct", { holdPct: 0 }],
			["quotaGate.holdPct", { holdPct: 101 }],
			["quotaGate.pollMinutes", { pollMinutes: 0 }],
			["quotaGate.pollMinutes", { pollMinutes: 61 }],
			["quotaGate.providers", { providers: [] }],
			["quotaGate.providers", { providers: ["-bad"] }],
			["quotaGate.mode", { mode: "invalid" }],
		] as const) {
			writeHomeConfig({ quotaGate: bad });
			let caught: unknown;
			try {
				loadConfig(home.dir);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ConfigError);
			expect((caught as ConfigError).code).toBe("config_invalid");
			expect((caught as ConfigError).message).toContain(`field=${field}`);
		}
	});
});

describe("LaneManager and startTask integration", () => {
	test("LaneManager refuses held provider starts, allows other providers, force, and reuseOpen", async () => {
		const repo = makeRepo(repos);
		const now = BASE_NOW;
		const clock = { now: () => now };
		const store = openBotStore(join(home.dir, "jabbu.db"), clock, "Asia/Seoul");
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: CHANNEL, type: 0, guildId: "400000000000000001" });
		const sessions = new FakeSessionStore();
		const sessionsRoot = join(home.dir, "sessions");
		const logs: string[] = [];
		const log = createLogger({ sink: (line) => logs.push(line), clock, redact });
		let held = false;

		let manager!: LaneManager;
		const router = new OriginRouter({
			timezone: "Asia/Seoul",
			store,
			clock,
			log,
			sessionsRoot,
			statusProvider: () => "",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true }),
		});
		manager = new LaneManager({
			timezone: "Asia/Seoul",
			store,
			channels: registryOf(new DiscordChannel(transport, { ownerUserId: OWNER })),
			clock,
			log,
			sessionsRoot,
			route: (record) => router.route(record),
			stopWhenIdle: (origin) => router.mailbox(origin).stopWhenIdle(),
			pauseTurn: (origin) => router.mailbox(origin).pauseTurn(),
			resumePending: (origin) => router.mailbox(origin).resumePending(),
			sessionDirFor: (origin) => sessionDirFor(sessionsRoot, origin, 1),
			session: router.sessionOps(),
			hostLoad: IDLE_HOST_LOAD,
			statfs: ROOMY_STATFS,
			laneModels: () => ({ high: "anthropic/claude-opus-5-5:high", low: "zai/glm-5.4" }),
			quotaRefusal: (model) =>
				held && providerOfModel(model) === "anthropic" ? "프로바이더 쿼터 보류(anthropic: 5시간 96% 사용)" : undefined,
			// The harness models an owner-confirmed force: the forced start passes its card.
			requestApproval: async () => "approved",
		});

		try {
			// Open a lane before hold, then verify reuseOpen still returns it after hold activates.
			const existing = await manager.start({
				title: "existing work",
				cwd: repo,
				channel: CHANNEL,
				parentOrigin: "discord/ch/300000000000000001",
				risk: "L3",
			});
			held = true;

			const reused = await manager.start({
				title: "existing work",
				cwd: repo,
				channel: CHANNEL,
				parentOrigin: "discord/ch/300000000000000001",
				risk: "L3",
				reuseOpen: true,
			});
			expect(reused.reused).toBe(true);
			expect(reused.name).toBe(existing.name);

			const refused = await manager
				.start({ title: "blocked high lane", cwd: repo, channel: CHANNEL, risk: "L3" })
				.catch((error: unknown) => error);
			expect(refused).toBeInstanceOf(LaneInputError);
			expect((refused as Error).message).toContain("프로바이더 쿼터 보류(anthropic:");

			const otherProvider = await manager.start({ title: "allowed low lane", cwd: repo, channel: CHANNEL, risk: "L1" });
			expect(otherProvider.meta.workerModel).toBe("zai/glm-5.4");

			const forced = await manager.start({
				title: "forced high lane",
				cwd: repo,
				channel: CHANNEL,
				parentOrigin: "discord/ch/300000000000000001",
				risk: "L3",
				force: true,
			});
			expect(forced.meta.workerModel).toBe("anthropic/claude-opus-5-5:high");
		} finally {
			await manager.stop();
			store.close();
		}
	});

	test("startTask blocks both local and remote new [TASK] on held provider and passes other/force", async () => {
		const db = new Database(":memory:", { strict: true });
		const ledger = new TaskLedger(db, { timezone: "Asia/Seoul", clock: { now: () => BASE_NOW } });
		const transport = new WaitingDiscordTransport();
		const hostOps: TaskHostOps & TaskResumeOps = {
			...createTaskHostOps(),
			pathExists: async () => ({ ok: true, value: false }),
			createWorktree: async () => ({ ok: true, value: null }),
			removeWorktree: async () => undefined,
			headOf: async () => ({ sha: "a".repeat(40), clean: true }),
			writeFile: async () => ({ ok: true, value: null }),
			readBytes: async () => ({ ok: true, value: undefined }),
			readFile: async () => ({ ok: true, value: undefined }),
			commitDocs: async () => ({ ok: true, value: "b".repeat(40) }),
			readPlan: async () => ({ ok: true, value: undefined }),
			removeRecords: async () => undefined,
		};
		const logs: string[] = [];
		const logFields: Array<{ event: string; fields: Record<string, unknown> | undefined }> = [];
		const deps: TaskDispatchDeps = {
			ledger,
			originKey: "discord/ch/111111111111111111/t/222222222222222222",
			threadRef: () => "111111111111111111:222222222222222222",
			rootText: () => "[TASK] quota check",
			channels: registryOf(new DiscordChannel(transport, { ownerUserId: OWNER })),
			now: () => BASE_NOW,
			timezone: "Asia/Seoul",
			workspaceDir: home.dir,
			dispatchHosts: { wsl: { ssh: "wsl-ssh", workDir: "/r" } },
			secretsDir: join(home.dir, "secrets"),
			hostOps: () => hostOps,
			hostLoad: IDLE_HOST_LOAD,
			diskHeadroom: () => ({ path: "/r", freeBytes: 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 }),
			run: async (cmd) => {
				if (cmd[1] === "agent" && cmd[2] === "list") {
					return { code: 0, stdout: JSON.stringify({ result: { agents: [] } }), timedOut: false };
				}
				if (cmd[1] === "workspace" && cmd[2] === "list") {
					return { code: 0, stdout: JSON.stringify({ result: { workspaces: [] } }), timedOut: false };
				}
				if ((cmd[1] === "workspace" || cmd[1] === "tab") && cmd[2] === "create") {
					return {
						code: 0,
						stdout: JSON.stringify({
							result: { workspace: { workspace_id: "W1" }, tab: { tab_id: "T1" }, root_pane: { pane_id: "P1" } },
						}),
						timedOut: false,
					};
				}
				return { code: 0, stdout: "{}", timedOut: false };
			},
			log: {
				info: (event, fields) => {
					logs.push(event);
					logFields.push({ event, fields });
				},
				warn: (event, fields) => {
					logs.push(event);
					logFields.push({ event, fields });
				},
			},
			quotaRefusal: (model) =>
				providerOfModel(model) === "anthropic" ? "프로바이더 쿼터 보류(anthropic: 5시간 96% 사용)" : undefined,
			// The owner's confirmation for a forced start (the card the dispatch tool asks on).
			confirmForce: async () => true,
		};
		const spec = {
			title: "쿼터 테스트",
			risk: "L3" as const,
			goal: "목표",
			scope: ["src/a.ts"],
			exclusions: [],
			acceptance: ["통과"],
			repo: "/r/repo",
			background: "배경",
		};

		const localBlocked = await startTask(deps, {
			spec,
			task: "구현",
			host: null,
			worker: { tier: "high", tierReason: "L3", model: "anthropic/claude-opus-5-5" },
		});
		expect(localBlocked).toContain("시작 거부: 프로바이더 쿼터 보류(anthropic:");

		const remoteBlocked = await startTask(deps, {
			spec,
			task: "구현",
			host: "wsl",
			worker: { tier: "high", tierReason: "L3", model: "anthropic/claude-opus-5-5" },
		});
		expect(remoteBlocked).toContain("시작 거부: 프로바이더 쿼터 보류(anthropic:");
		expect(ledger.listActive()).toHaveLength(0);
		expect(logs.filter((event) => event === "task_start_refused_quota")).toHaveLength(2);

		const otherAllowed = await startTask(deps, {
			spec: { ...spec, risk: "L1" },
			task: "구현",
			host: null,
			worker: { tier: "low", tierReason: "L1", model: "zai/glm-5.4" },
		});
		expect(otherAllowed).toContain("등록·시작했습니다");

		const forced = await startTask(deps, {
			spec,
			task: "강행",
			host: null,
			worker: { tier: "high", tierReason: "L3", model: "anthropic/claude-opus-5-5" },
			force: true,
		});
		expect(forced).toContain("등록·시작했습니다");
		expect(logFields.filter((entry) => entry.event === "task_start_forced")).toEqual([
			{ event: "task_start_forced", fields: { repo: "/r/repo", reason: "quota" } },
		]);

		// No confirmer, no force: the model's claim alone never passes a refusal.
		const unconfirmed = await startTask(
			{ ...deps, confirmForce: undefined },
			{
				spec,
				task: "강행",
				host: null,
				worker: { tier: "high", tierReason: "L3", model: "anthropic/claude-opus-5-5" },
				force: true,
			},
		);
		expect(unconfirmed).toContain("시작 거부: 프로바이더 쿼터 보류(anthropic:");
		expect(ledger.listActive()).toHaveLength(2);
		db.close();
	});
});

describe("DaemonQuotaGate and CLI quota command", () => {
	test("DaemonQuotaGate polls usage, respects manual lifts, and clears when live config removes quotaGate", async () => {
		let now = BASE_NOW;
		const logs: string[] = [];
		let currentConfig: JabbuConfig = { ...home.config, quotaGate: { holdPct: 95, pollMinutes: 5 } };
		const ctx = {
			get options() {
				return { config: currentConfig };
			},
			clock: { now: () => now },
			log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => now }, redact }),
		} as unknown as DaemonContext;

		let usedFraction = 0.97;
		const runner: ProcessRunner = async () => ({
			code: 0,
			timedOut: false,
			stdout: JSON.stringify(
				usagePayload([
					{
						provider: "anthropic",
						limits: [
							{
								label: "Claude 5h",
								amount: { unit: "percent", usedFraction },
								window: { id: "5h", label: "5h", resetsAt: now + 3_600_000 },
							},
						],
					},
				]),
			),
		});

		const daemonQuota = new DaemonQuotaGate(ctx, runner);
		await daemonQuota.pollNow();

		expect(daemonQuota.refusalFor("anthropic/claude-opus-5-5")).toContain("프로바이더 쿼터 보류(anthropic:");
		expect(daemonQuota.refusalFor("zai/glm-5.4")).toBeUndefined();
		expect(logs.some((line) => line.includes("quota_gate_opened"))).toBe(true);
		expect(readQuotaGateSnapshot(home.dir, now).held.map((entry) => entry.provider)).toEqual(["anthropic"]);

		// Manual lift hides refusal after cache window.
		writeQuotaLift(home.dir, { provider: "anthropic", untilMs: now + 600_000, now });
		now += 3_000;
		expect(daemonQuota.refusalFor("anthropic/claude-opus-5-5")).toBeUndefined();

		// Removing lift re-exposes hold, then lower usage clears it.
		clearQuotaLift(home.dir, "anthropic");
		now += 3_000;
		expect(daemonQuota.refusalFor("anthropic/claude-opus-5-5")).toContain("프로바이더 쿼터 보류");

		usedFraction = 0.35;
		await daemonQuota.pollNow();
		expect(daemonQuota.refusalFor("anthropic/claude-opus-5-5")).toBeUndefined();
		expect(logs.some((line) => line.includes("quota_gate_cleared"))).toBe(true);

		// Re-hold then disable via live reload: maybePoll clears holds immediately.
		usedFraction = 0.99;
		await daemonQuota.pollNow();
		expect(daemonQuota.refusalFor("anthropic/claude-opus-5-5")).toBeDefined();
		currentConfig = { ...home.config };
		daemonQuota.maybePoll();
		expect(daemonQuota.refusalFor("anthropic/claude-opus-5-5")).toBeUndefined();
		expect(readQuotaGateSnapshot(home.dir, now).held).toEqual([]);
	});

	test("DaemonQuotaGate.maybePoll re-polls immediately when quotaGate config changes before pollMinutes", async () => {
		const now = BASE_NOW;
		const logs: string[] = [];
		let currentConfig: JabbuConfig = { ...home.config, quotaGate: { holdPct: 95, pollMinutes: 10 } };
		const ctx = {
			get options() {
				return { config: currentConfig };
			},
			clock: { now: () => now },
			log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => now }, redact }),
		} as unknown as DaemonContext;

		let calls = 0;
		let resolveNext: (() => void) | undefined;
		const waitNextPoll = (): Promise<void> =>
			new Promise((resolve) => {
				resolveNext = resolve;
			});

		const runner: ProcessRunner = async () => {
			calls += 1;
			resolveNext?.();
			resolveNext = undefined;
			return {
				code: 0,
				timedOut: false,
				stdout: JSON.stringify(
					usagePayload([
						{
							provider: "anthropic",
							limits: [{ label: "5h", amount: { unit: "percent", usedFraction: 0.92 } }],
						},
					]),
				),
			};
		};

		const daemonQuota = new DaemonQuotaGate(ctx, runner);
		const p1 = waitNextPoll();
		daemonQuota.maybePoll();
		await p1;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(calls).toBe(1);
		expect(daemonQuota.refusalFor("anthropic/claude-opus-5-5")).toBeUndefined();

		// Same pollMinutes window, same config: maybePoll does not trigger a second poll.
		daemonQuota.maybePoll();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(calls).toBe(1);

		// Live reload lowers holdPct: maybePoll triggers an immediate re-poll without waiting 10m.
		currentConfig = { ...home.config, quotaGate: { holdPct: 90, pollMinutes: 10 } };
		const p2 = waitNextPoll();
		daemonQuota.maybePoll();
		await p2;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(calls).toBe(2);
		expect(daemonQuota.refusalFor("anthropic/claude-opus-5-5")).toContain("프로바이더 쿼터 보류(anthropic:");
	});

	test("quota CLI handles status --json, lift, clear, and invalid arguments", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "jabbu-quota-cli-"));
		tempDirs.push(tmp);
		mkdirSync(tmp, { recursive: true });
		const liveNow = Date.now();
		writeFileSync(
			quotaGatePath(tmp),
			JSON.stringify({
				updatedAt: liveNow,
				held: [
					{
						provider: "anthropic",
						causes: [{ provider: "anthropic", label: "5시간", usedPct: 97, releaseAt: liveNow + 3_600_000 }],
					},
				],
			}),
			{ mode: 0o600 },
		);

		expect(quotaCommand(["lift", "anthropic", "--minutes", "30"], tmp, () => liveNow)).toBe(0);
		expect(readQuotaLifts(tmp, liveNow).get("anthropic")?.untilMs).toBe(liveNow + 30 * 60_000);

		const statusRes = await runCliCapture(tmp, ["quota", "status", "--json"]);
		expect(statusRes.code).toBe(0);
		const parsed = JSON.parse(statusRes.stdout) as {
			held: Array<{ provider: string }>;
			lifts: Array<{ provider: string }>;
		};
		expect(parsed.held.map((entry) => entry.provider)).toEqual(["anthropic"]);
		expect(parsed.lifts.some((lift) => lift.provider === "anthropic")).toBe(true);

		const clearRes = await runCliCapture(tmp, ["quota", "clear", "anthropic"]);
		expect(clearRes.code).toBe(0);
		expect(clearRes.stdout).toContain("quota_cleared provider=anthropic count=1");
		expect(readQuotaLifts(tmp, liveNow).size).toBe(0);

		const badVerb = await runCliCapture(tmp, ["quota", "unknown"]);
		expect(badVerb.code).toBe(2);

		const badMinutes = await runCliCapture(tmp, ["quota", "lift", "anthropic", "--minutes", "0"]);
		expect(badMinutes.code).toBe(2);
	});

	test("quota status lists runtime holds restored from the store cursor", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "jabbu-quota-runtime-"));
		tempDirs.push(tmp);
		const liveNow = Date.now();
		const tracker = new QuotaRecoveryTracker();
		tracker.recordQuotaError({
			provider: "anthropic",
			originKey: "discord/dm/1",
			reason: "429",
			resetAt: liveNow + 3_600_000,
			now: liveNow,
		});
		// A hold whose safety window already elapsed is not blocking anymore, so status omits it.
		tracker.recordQuotaError({
			provider: "zai",
			originKey: "discord/dm/2",
			reason: "429",
			now: liveNow - 6 * 3_600_000,
		});
		const db = new Database(join(tmp, "jabbu.db"));
		db.exec(
			"CREATE TABLE slack_cursors (cursor_key TEXT PRIMARY KEY, last_ts TEXT NOT NULL, updated_at INTEGER NOT NULL)",
		);
		db.query("INSERT INTO slack_cursors (cursor_key, last_ts, updated_at) VALUES (?, ?, ?)").run(
			QUOTA_RECOVERY_CURSOR,
			tracker.serialize(),
			liveNow,
		);
		db.close();

		const statusJson = await runCliCapture(tmp, ["quota", "status", "--json"]);
		expect(statusJson.code).toBe(0);
		const parsed = JSON.parse(statusJson.stdout) as {
			runtimeHolds: Array<{ provider: string; origins: string[]; resetAt?: number }>;
		};
		expect(parsed.runtimeHolds.map((hold) => hold.provider)).toEqual(["anthropic"]);
		expect(parsed.runtimeHolds[0]?.origins).toEqual(["discord/dm/1"]);
		expect(parsed.runtimeHolds[0]?.resetAt).toBe(liveNow + 3_600_000);

		const statusPlain = await runCliCapture(tmp, ["quota", "status"]);
		expect(statusPlain.code).toBe(0);
		expect(statusPlain.stdout).toContain("runtime_held=1");
		expect(statusPlain.stdout).toContain("runtime_hold provider=anthropic origins=1");
	});

	test("single-provider reset saves the snapshot and re-polls at once", () => {
		const tmp = mkdtempSync(join(tmpdir(), "jabbu-quota-reset-"));
		tempDirs.push(tmp);
		const now = BASE_NOW;
		const gate = new ProviderQuotaGate();
		gate.updateFromUsage(
			usagePayload([
				{ provider: "anthropic", limits: [{ label: "5h", amount: { unit: "percent", usedFraction: 0.97 } }] },
			]),
			{ holdPct: 95 },
			now,
		);
		expect(gate.hasHolds).toBe(true);
		const recovery = new QuotaRecoveryTracker();
		let saved = 0;
		let polled = 0;
		let liftsCleared = 0;
		const result = executeQuotaReset({
			rawArg: "anthropic",
			homeDir: tmp,
			now,
			isAgy: false,
			agyPool: undefined,
			recovery,
			gate,
			log: createLogger({ sink: () => {}, clock: { now: () => now }, redact }),
			resetSnapshot: () => ({ providers: [], holdCount: 0, liftCount: 0, isAgy: false }),
			onClearLifts: () => {
				liftsCleared += 1;
			},
			onReleaseEvents: () => {},
			onSaveSnapshot: () => {
				saved += 1;
			},
			onPollNow: () => {
				polled += 1;
			},
		});
		expect(result).toContain("게이트 1시간 수동 해제(anthropic)");
		expect(readQuotaLifts(tmp, now).has("anthropic")).toBe(true);
		expect(liftsCleared).toBe(1);
		expect(saved).toBe(1);
		expect(polled).toBe(1);
	});

	test("DaemonQuotaGate.resetUsage for one provider re-polls at once, so a recovered provider clears now", async () => {
		const now = BASE_NOW;
		const logs: string[] = [];
		const currentConfig: JabbuConfig = { ...home.config, quotaGate: { holdPct: 95, pollMinutes: 60 } };
		const ctx = {
			get options() {
				return { config: currentConfig };
			},
			clock: { now: () => now },
			log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => now }, redact }),
		} as unknown as DaemonContext;

		let usedFraction = 0.97;
		const runner: ProcessRunner = async () => ({
			code: 0,
			timedOut: false,
			stdout: JSON.stringify(
				usagePayload([{ provider: "anthropic", limits: [{ label: "5h", amount: { unit: "percent", usedFraction } }] }]),
			),
		});

		const daemonQuota = new DaemonQuotaGate(ctx, runner);
		await daemonQuota.pollNow();
		expect(daemonQuota.refusalFor("anthropic/claude-opus-5-5")).toBeDefined();
		expect(readQuotaGateSnapshot(home.dir, now).held.map((entry) => entry.provider)).toEqual(["anthropic"]);

		// The owner resets one provider; usage has since recovered, so the immediate re-poll clears the hold now
		// instead of up to `pollMinutes` later.
		usedFraction = 0.35;
		const result = await daemonQuota.resetUsage("anthropic");
		expect(result).toContain("게이트 1시간 수동 해제(anthropic)");
		await daemonQuota.idle();
		expect(daemonQuota.refusalFor("anthropic/claude-opus-5-5")).toBeUndefined();
		expect(readQuotaGateSnapshot(home.dir, now).held).toEqual([]);
	});

	test("quotaGate mode=warn records snapshot and logs without blocking starts, and switches live to hold", async () => {
		const now = BASE_NOW;
		const logs: string[] = [];
		let currentConfig: JabbuConfig = { ...home.config, quotaGate: { holdPct: 95, pollMinutes: 5, mode: "warn" } };
		const ctx = {
			get options() {
				return { config: currentConfig };
			},
			clock: { now: () => now },
			log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => now }, redact }),
		} as unknown as DaemonContext;

		const runner: ProcessRunner = async () => ({
			code: 0,
			timedOut: false,
			stdout: JSON.stringify(
				usagePayload([
					{
						provider: "anthropic",
						limits: [
							{
								label: "Claude 5h",
								amount: { unit: "percent", usedFraction: 0.98 },
								window: { id: "5h", label: "5h", resetsAt: now + 3_600_000 },
							},
						],
					},
				]),
			),
		});

		const daemonQuota = new DaemonQuotaGate(ctx, runner);
		await daemonQuota.pollNow();

		expect(daemonQuota.refusalFor("anthropic/claude-opus-5-5")).toBeUndefined();
		expect(logs.some((line) => line.includes("quota_gate_opened") && line.includes("mode=warn"))).toBe(true);
		const snap = readQuotaGateSnapshot(home.dir, now);
		expect(snap.mode).toBe("warn");
		expect(snap.held.map((entry) => entry.provider)).toEqual(["anthropic"]);

		const statusJson = await runCliCapture(home.dir, ["quota", "status", "--json"]);
		expect(statusJson.code).toBe(0);
		expect((JSON.parse(statusJson.stdout) as { mode?: string }).mode).toBe("warn");

		const statusPlain = await runCliCapture(home.dir, ["quota", "status"]);
		expect(statusPlain.code).toBe(0);
		expect(statusPlain.stdout).toContain("mode=warn");

		currentConfig = { ...home.config, quotaGate: { holdPct: 95, pollMinutes: 5, mode: "hold" } };
		expect(daemonQuota.refusalFor("anthropic/claude-opus-5-5")).toContain("프로바이더 쿼터 보류(anthropic:");
	});
});
