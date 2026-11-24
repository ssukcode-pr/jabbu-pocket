import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ConfigError,
	codeRollbackMode,
	defaultHomeDir,
	isOffsiteDir,
	loadConfig,
	PEER_SILENCE_DEFAULT_MINUTES,
	peerSilenceMinutes,
	readDiscordToken,
} from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import { CLI_FIELDS, LIVE_FIELDS, RESTART_FIELDS } from "../src/daemon/reload";
import { channelBindings } from "../src/daemon/run";
import { landModeOfRemote } from "../src/lanes/pr-land-remote";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";

let home: string;

function writeSecret(rel: string, content: string, mode = 0o600): string {
	const p = join(home, rel);
	writeFileSync(p, content);
	chmodSync(p, mode);
	return p;
}

const OWNER_ID = "123456789012345678"; // gitleaks:allow (fake snowflake)
const APP_ID = "234567890123456789"; // gitleaks:allow (fake snowflake)
// Not a real token: assembled at runtime so no token-shaped literal sits in the repo.
const TOKEN = ["TEST", "discord", "token"].join("-");

/** A valid `channels.discord` block; `overrides` replace or add keys. */
function discordBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { ownerUserId: OWNER_ID, botTokenFile: "secrets/discord.token", applicationId: APP_ID, ...overrides };
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		channels: { discord: discordBlock() },
		ompExecutable: "/usr/local/bin/omp",
		workspaceDir: "workspace",
		...overrides,
	};
}

function writeConfig(obj: unknown): void {
	writeFileSync(join(home, "config.json"), JSON.stringify(obj));
}

function catchError(fn: () => unknown): ConfigError {
	try {
		fn();
	} catch (e) {
		if (e instanceof ConfigError) return e;
		throw e;
	}
	throw new Error("expected ConfigError");
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-cfg-"));
	chmodSync(home, 0o700);
	mkdirSync(join(home, "secrets"), { mode: 0o700 });
	writeSecret("secrets/discord.token", `${TOKEN}\n`);
	writeConfig(baseConfig());
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("loadConfig", () => {
	test("loads a valid config and resolves paths relative to the config dir", () => {
		const cfg = loadConfig(home);
		expect(cfg).toMatchObject({
			schemaVersion: 1,
			channels: {
				discord: { ownerUserId: OWNER_ID, botTokenFile: join(home, "secrets/discord.token"), applicationId: APP_ID },
			},
			ompExecutable: "/usr/local/bin/omp",
			workspaceDir: join(home, "workspace"),
		});
		expect(cfg.model).toBeUndefined();
	});

	test("optional fields: model, thinking, sessionRetentionDays, maxBundleBytes", () => {
		writeConfig(
			baseConfig({
				model: "some/model",
				thinking: "low",
				sessionRetentionDays: 30,
				maxBundleBytes: 268_435_456,
			}),
		);
		const cfg = loadConfig(home);
		expect(cfg).toMatchObject({ model: "some/model", thinking: "low", sessionRetentionDays: 30 });
		expect(cfg.maxBundleBytes).toBe(268_435_456);
	});

	test("timezone: absent → the host zone, given → that zone, unknown name → config error, restart-bound", () => {
		expect(loadConfig(home).timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
		// A fresh process started with TZ set proves "absent" really follows the host zone, not a fixed default.
		const probe = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`const { loadConfig } = await import(${JSON.stringify(join(import.meta.dir, "../src/config.ts"))}); console.log(loadConfig(${JSON.stringify(home)}).timezone);`,
			],
			{ env: { ...process.env, TZ: "Pacific/Auckland" } },
		);
		expect(probe.stdout.toString().trim()).toBe("Pacific/Auckland");

		writeConfig(baseConfig({ timezone: "America/New_York" }));
		expect(loadConfig(home).timezone).toBe("America/New_York");

		writeConfig(baseConfig({ timezone: "Mars/Base" }));
		const error = catchError(() => loadConfig(home));
		expect(error.code).toBe("config_invalid");
		expect(error.message).toContain("field=timezone");
		expect(RESTART_FIELDS).toContain("timezone");
	});

	test("ompConfigOverlay: absent → unset, relative → resolved against the home, absolute kept, no file → config error", () => {
		expect("ompConfigOverlay" in loadConfig(home)).toBe(false);
		writeFileSync(join(home, "glm.omp.yml"), "modelRoles:\n  default: zai/glm-5.3-flash\n");
		writeConfig(baseConfig({ ompConfigOverlay: "glm.omp.yml" }));
		expect(loadConfig(home).ompConfigOverlay).toBe(join(home, "glm.omp.yml"));
		writeConfig(baseConfig({ ompConfigOverlay: join(home, "glm.omp.yml") }));
		expect(loadConfig(home).ompConfigOverlay).toBe(join(home, "glm.omp.yml"));
		expect(loadConfig(home).warnings).toBeUndefined();
		for (const missing of ["nope.omp.yml", "secrets"]) {
			writeConfig(baseConfig({ ompConfigOverlay: missing }));
			const error = catchError(() => loadConfig(home));
			expect(error.code).toBe("config_invalid");
			expect(error.message).toContain("field=ompConfigOverlay");
		}
	});

	test("agent omp is accepted", () => {
		writeConfig(baseConfig({ agent: "omp" }));
		expect(loadConfig(home).agent).toBe("omp");
	});

	test("unknown agent value is rejected", () => {
		writeConfig(baseConfig({ agent: "gemini" }));
		const err = catchError(() => loadConfig(home));
		expect(err.message).toContain("field=agent");
	});

	test("agent claude (removed) is rejected as an agent error", () => {
		writeConfig(baseConfig({ agent: "claude" }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain("field=agent");
	});

	test("agent agy with an absolute agyExecutable is accepted", () => {
		writeConfig(
			baseConfig({ agent: "agy", agyExecutable: "/home/u/.local/bin/agy", model: "agy/gemini-3.8-flash-high" }),
		);
		const cfg = loadConfig(home);
		expect(cfg.agent).toBe("agy");
		expect(cfg.agyExecutable).toBe("/home/u/.local/bin/agy");
		expect(cfg.model).toBe("agy/gemini-3.8-flash-high");
	});

	test("agent agy without agyExecutable leaves it unset (resolved on PATH)", () => {
		writeConfig(baseConfig({ agent: "agy" }));
		const cfg = loadConfig(home);
		expect(cfg.agent).toBe("agy");
		expect(cfg.agyExecutable).toBeUndefined();
	});

	test("relative agyExecutable is rejected", () => {
		writeConfig(baseConfig({ agent: "agy", agyExecutable: "agy" }));
		const err = catchError(() => loadConfig(home));
		expect(err.message).toContain("field=agyExecutable");
	});

	test("home 0755 refuses to start", () => {
		chmodSync(home, 0o755);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("home_permissions");
		expect(err.message).toContain(home);
	});

	test("missing home and missing config", () => {
		expect(catchError(() => loadConfig(join(home, "nope"))).code).toBe("home_missing");
		rmSync(join(home, "config.json"));
		expect(catchError(() => loadConfig(home)).code).toBe("config_missing");
	});

	test("secret file with 0644 is rejected, naming only the path", () => {
		const p = writeSecret("secrets/discord.token", TOKEN, 0o644);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("secret_permissions");
		expect(err.path).toBe(p);
		expect(err.message).not.toContain(TOKEN);
	});

	test("missing token file", () => {
		rmSync(join(home, "secrets/discord.token"));
		expect(catchError(() => loadConfig(home)).code).toBe("secret_missing");
	});

	test("invalid JSON error does not echo file content", () => {
		writeFileSync(join(home, "config.json"), `{"channels": {"discord": {}}, oops ${TOKEN}`);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid_json");
		expect(err.message).not.toContain(TOKEN);
		expect(err.message).not.toContain("oops");
		expect(err.message).toContain("look for a trailing comma");
		writeFileSync(join(home, "config.json"), `{"schemaVersion": 1, "x": "${TOKEN}-1" "y": 2}`);
		expect(catchError(() => loadConfig(home)).message).not.toContain(`${TOKEN}-1`);
	});

	test.each([
		["schemaVersion", baseConfig({ schemaVersion: 2 })],
		["ompExecutable", baseConfig({ ompExecutable: "omp" })],
		["workspaceDir", baseConfig({ workspaceDir: undefined })],
		["sessionRetentionDays", baseConfig({ sessionRetentionDays: 0 })],
		["maxBundleBytes", baseConfig({ maxBundleBytes: 0 })],
		["maxBundleBytes", baseConfig({ maxBundleBytes: -1 })],
		["maxBundleBytes", baseConfig({ maxBundleBytes: 1.5 })],
		["maxBundleBytes", baseConfig({ maxBundleBytes: "512MB" })],
		["model", baseConfig({ model: 3 })],
		["recallEnabled", baseConfig({ recallEnabled: "false" })],
		["recallEnabled", baseConfig({ recallEnabled: 0 })],
		["idleKeepResident", baseConfig({ idleKeepResident: "false" })],
		["peerHopLimit", baseConfig({ peerHopLimit: 3 })],
		["peerHopLimit.turns", baseConfig({ peerHopLimit: { turns: 0, windowMinutes: 30 } })],
		["peerHopLimit.windowMinutes", baseConfig({ peerHopLimit: { turns: 3, windowMinutes: 1.5 } })],
		["peerHopLimit.windowMinutes", baseConfig({ peerHopLimit: { turns: 3 } })],
		["peerHopLimit.extra", baseConfig({ peerHopLimit: { turns: 3, windowMinutes: 30, extra: 1 } })],
		["peerSilenceAlert", baseConfig({ peerSilenceAlert: 10 })],
		["peerSilenceAlert.minutes", baseConfig({ peerSilenceAlert: {} })],
		["peerSilenceAlert.minutes", baseConfig({ peerSilenceAlert: { minutes: -1 } })],
		["peerSilenceAlert.minutes", baseConfig({ peerSilenceAlert: { minutes: 1441 } })],
		["peerSilenceAlert.minutes", baseConfig({ peerSilenceAlert: { minutes: 2.5 } })],
		["peerSilenceAlert.minutes", baseConfig({ peerSilenceAlert: { minutes: "10" } })],
		["peerSilenceAlert.channel", baseConfig({ peerSilenceAlert: { minutes: 10, channel: "x" } })],
		["costCap", baseConfig({ costCap: 20 })],
		["costCap.turnUsd", baseConfig({ costCap: { turnUsd: 0 } })],
		["costCap.turnUsd", baseConfig({ costCap: { turnUsd: -1 } })],
		["costCap.dailyUsd", baseConfig({ costCap: { dailyUsd: "300" } })],
		["costCap.dailyUsd", baseConfig({ costCap: { dailyUsd: Number.POSITIVE_INFINITY } })],
		["costCap.warnUsd", baseConfig({ costCap: { turnUsd: 20, dailyUsd: 300, warnUsd: 10 } })],
		["lanes", baseConfig({ lanes: 2 })],
		["lanes.maxNudges", baseConfig({ lanes: { maxNudges: 2 } })],
		["lanes.models", baseConfig({ lanes: { models: "high" } })],
		["lanes.models.top", baseConfig({ lanes: { models: { top: "a/b" } } })],
		["lanes.models.high", baseConfig({ lanes: { models: { high: "opus" } } })],
		["lanes.land", baseConfig({ lanes: { land: "pr" } })],
		["lanes.land.repo", baseConfig({ lanes: { land: { repo: { mode: "pr" } } } })],
		["lanes.land./r", baseConfig({ lanes: { land: { "/r": "pr" } } })],
		["lanes.land./r.mode", baseConfig({ lanes: { land: { "/r": { mode: "squash" } } } })],
		["lanes.land./r.auto", baseConfig({ lanes: { land: { "/r": { mode: "pr", auto: true } } } })],
		["lanes.land./r.remote", baseConfig({ lanes: { land: { "/r": { mode: "pr", remote: "-x" } } } })],
		["lanes.land./r.ciGraceMs", baseConfig({ lanes: { land: { "/r": { mode: "pr", ciGraceMs: 0 } } } })],
		["lanes.land./r.ciTimeoutMs", baseConfig({ lanes: { land: { "/r": { mode: "pr", ciTimeoutMs: "1h" } } } })],
		["lanes.land./r.requiredChecks", baseConfig({ lanes: { land: { "/r": { mode: "pr", requiredChecks: [""] } } } })],
	])("invalid field %s is reported by name", (field, cfg) => {
		writeConfig(cfg);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(`field=${field}`);
	});

	test("recallEnabled is optional and accepts a boolean", () => {
		expect(loadConfig(home).recallEnabled).toBeUndefined();
		writeConfig(baseConfig({ recallEnabled: false }));
		expect(loadConfig(home).recallEnabled).toBe(false);
		writeConfig(baseConfig({ recallEnabled: true }));
		expect(loadConfig(home).recallEnabled).toBe(true);
	});

	test("idleKeepResident is optional and accepts a boolean", () => {
		expect(loadConfig(home).idleKeepResident).toBeUndefined();
		writeConfig(baseConfig({ idleKeepResident: false }));
		expect(loadConfig(home).idleKeepResident).toBe(false);
	});

	test("peerHopLimit is optional and read as written", () => {
		expect(loadConfig(home).peerHopLimit).toBeUndefined();
		writeConfig(baseConfig({ peerHopLimit: { turns: 2, windowMinutes: 10 } }));
		expect(loadConfig(home).peerHopLimit).toEqual({ turns: 2, windowMinutes: 10 });
	});

	test("peerSilenceAlert AC-5: default 10 minutes, 0 and 1440 accepted, a live field", () => {
		const loaded = loadConfig(home);
		expect(loaded.peerSilenceAlert).toBeUndefined();
		expect(PEER_SILENCE_DEFAULT_MINUTES).toBe(10);
		expect(peerSilenceMinutes(loaded)).toBe(10);
		writeConfig(baseConfig({ peerSilenceAlert: { minutes: 0 } }));
		expect(loadConfig(home).peerSilenceAlert).toEqual({ minutes: 0 });
		expect(peerSilenceMinutes(loadConfig(home))).toBe(0);
		writeConfig(baseConfig({ peerSilenceAlert: { minutes: 1440 } }));
		expect(peerSilenceMinutes(loadConfig(home))).toBe(1440);
		expect(LIVE_FIELDS as readonly string[]).toContain("peerSilenceAlert");
		expect(RESTART_FIELDS as readonly string[]).not.toContain("peerSilenceAlert");
	});

	test("costCap is optional, keeps only the ceilings given, and reload treats it as live", () => {
		expect(loadConfig(home).costCap).toBeUndefined();
		writeConfig(baseConfig({ costCap: { turnUsd: 20 } }));
		expect(loadConfig(home).costCap).toEqual({ turnUsd: 20 });
		writeConfig(baseConfig({ costCap: { turnUsd: 20, dailyUsd: 300 } }));
		expect(loadConfig(home).costCap).toEqual({ turnUsd: 20, dailyUsd: 300 });
	});

	test("lanes.completionNudges was removed: any value loads with one config_key_ignored warning and is dropped", () => {
		for (const value of [0, 3, "2", -1]) {
			writeConfig(baseConfig({ lanes: { completionNudges: value } }));
			const loaded = loadConfig(home);
			expect(loaded.lanes).toEqual({});
			expect(loaded.warnings).toEqual([{ field: "lanes.completionNudges", reason: "config_key_ignored" }]);
		}
	});

	test("lanes is optional and reload treats it as live", () => {
		expect(loadConfig(home).lanes).toBeUndefined();
		expect(LIVE_FIELDS).toContain("lanes");
		writeConfig(baseConfig({ lanes: { models: { high: "anthropic/claude-opus-5-5", low: "zai/glm-5.3-flash" } } }));
		expect(loadConfig(home).lanes).toEqual({
			models: { high: "anthropic/claude-opus-5-5", low: "zai/glm-5.3-flash" },
		});
	});

	test("AC-2: lanes.land is keyed by absolute repo path; mode defaults to ff", () => {
		const land = {
			"/work/a/": { mode: "pr", remote: "origin", ciGraceMs: 300000, ciTimeoutMs: 3600000, requiredChecks: ["test"] },
			"/work/b": {},
			"/work/c": { mode: "ff" },
		};
		writeConfig(baseConfig({ lanes: { land } }));
		expect(loadConfig(home).lanes).toEqual({
			land: {
				"/work/a": { mode: "pr", remote: "origin", ciGraceMs: 300000, ciTimeoutMs: 3600000, requiredChecks: ["test"] },
				"/work/b": { mode: "ff" },
				"/work/c": { mode: "ff" },
			},
		});
	});

	describe("lanes.land remotes", () => {
		const dispatchHosts = { wsl: { ssh: "wsl-box" }, oci: { ssh: "me@oci" } };
		const landOf = (remotes: unknown, extra: Record<string, unknown> = {}) => ({
			"/work/a": { mode: "pr", remotes },
			...extra,
		});
		/** `lanes` is written BEFORE `dispatchHosts` and `herdr`: the host check must not depend on key order. */
		const writeLanesFirst = (land: unknown, hosts: unknown = dispatchHosts): void =>
			writeConfig({ ...baseConfig(), lanes: { land }, dispatchHosts: hosts, herdr: {}, recordsRepo: "/r/records" });

		test("remotes load as given (trailing slash dropped) and lanes may precede dispatchHosts", () => {
			writeLanesFirst(landOf({ wsl: "/home/me/repo/", oci: "/srv/repo" }));
			const cfg = loadConfig(home);
			expect(cfg.lanes?.land?.["/work/a"]).toEqual({
				mode: "pr",
				remotes: { wsl: "/home/me/repo", oci: "/srv/repo" },
			});
			expect(cfg.dispatchHosts).toEqual(dispatchHosts);
		});

		test("remotes naming a host that dispatchHosts lacks is invalid, whichever key comes first", () => {
			writeLanesFirst(landOf({ nope: "/srv/repo" }));
			expect(catchError(() => loadConfig(home)).message).toContain("field=lanes.land./work/a.remotes.nope");
			writeConfig({
				...baseConfig({ herdr: {}, dispatchHosts }),
				lanes: { land: landOf({ nope: "/srv/repo" }) },
			});
			expect(catchError(() => loadConfig(home)).message).toContain("field=lanes.land./work/a.remotes.nope");
			writeConfig({ ...baseConfig(), lanes: { land: landOf({ wsl: "/srv/repo" }) } });
			expect(catchError(() => loadConfig(home)).message).toContain("field=lanes.land./work/a.remotes.wsl");
		});

		test("remotes with a relative or unsafe path, or a non-object value, is invalid", () => {
			for (const remotes of [{ wsl: "repo" }, { wsl: "/srv/../repo" }, { wsl: "/srv/re po" }, { wsl: 7 }]) {
				writeLanesFirst(landOf(remotes));
				expect(catchError(() => loadConfig(home)).message).toContain("field=lanes.land./work/a.remotes.wsl");
			}
			for (const remotes of ["/srv/repo", ["/srv/repo"], null]) {
				writeLanesFirst(landOf(remotes));
				expect(catchError(() => loadConfig(home)).message).toContain("field=lanes.land./work/a.remotes");
			}
		});

		test("the same host and path under two lanes.land entries is invalid; the same path on another host is fine", () => {
			writeLanesFirst(landOf({ wsl: "/srv/repo" }, { "/work/b": { mode: "pr", remotes: { wsl: "/srv/repo/" } } }));
			expect(catchError(() => loadConfig(home)).message).toContain("field=lanes.land./work/b.remotes.wsl");
			writeLanesFirst(landOf({ wsl: "/srv/repo" }, { "/work/b": { mode: "pr", remotes: { oci: "/srv/repo" } } }));
			expect(loadConfig(home).lanes?.land?.["/work/b"]?.remotes).toEqual({ oci: "/srv/repo" });
		});

		test("landModeOfRemote finds the local repository key of a (host, path) and nothing for an unknown one", () => {
			writeLanesFirst(landOf({ wsl: "/srv/repo" }, { "/work/b": { mode: "ff", remotes: { oci: "/srv/repo" } } }));
			const cfg = loadConfig(home);
			expect(landModeOfRemote(cfg, "wsl", "/srv/repo")).toMatchObject({
				mode: "pr",
				localRepo: "/work/a",
				remoteRepo: "/srv/repo",
				ssh: "wsl-box",
				config: { mode: "pr" },
				denylistFile: "/r/records/release/denylist.txt",
			});
			expect(landModeOfRemote(cfg, "oci", "/srv/repo")).toMatchObject({
				mode: "ff",
				localRepo: "/work/b",
				ssh: "me@oci",
			});
			expect(landModeOfRemote(cfg, "wsl", "/srv/other")).toBeUndefined();
			expect(landModeOfRemote(cfg, "elsewhere", "/srv/repo")).toBeUndefined();
		});
	});
});

describe("channels", () => {
	const REMOVED = "Slack 채널은 제거됨";
	const REMOVED_TEAMS = "Teams 채널은 제거됨";
	const teamsBlock = () => ({
		appId: "0aaaaaaa-1111-2222-3333-444444444444",
		tenantId: "0aaaaaaa-1111-2222-3333-444444444444",
		clientSecretFile: "secrets/teams.secret",
		ownerAadObjectId: "0aaaaaaa-1111-2222-3333-444444444444",
	});

	test("a discord config loads as written: channels holds discord alone", () => {
		expect(loadConfig(home).channels).toEqual({
			discord: { ownerUserId: OWNER_ID, botTokenFile: join(home, "secrets/discord.token"), applicationId: APP_ID },
		});
	});

	test("channels.teams is refused with the removal note, alone or next to a valid discord block", () => {
		writeConfig(baseConfig({ channels: { discord: discordBlock(), teams: teamsBlock() } }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain("field=channels.teams");
		expect(err.message).toContain(REMOVED_TEAMS);
		writeConfig(baseConfig({ channels: { teams: teamsBlock() } }));
		const alone = catchError(() => loadConfig(home));
		expect(alone.message).toContain("field=channels.teams");
		expect(alone.message).toContain(REMOVED_TEAMS);
		// The discord block on its own still loads as before.
		writeConfig(baseConfig({ channels: { discord: discordBlock() } }));
		expect(loadConfig(home).channels.discord?.ownerUserId).toBe(OWNER_ID);
	});

	test("channels.slack is refused with the removal note, even next to a valid discord block", () => {
		writeConfig(baseConfig({ channels: { slack: { ownerUserId: "UOWNER0" }, discord: discordBlock() } }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain("field=channels.slack");
		expect(err.message).toContain(REMOVED);
		writeConfig(baseConfig({ channels: { slack: { ownerUserId: "UOWNER0" } } }));
		expect(catchError(() => loadConfig(home)).message).toContain("field=channels.slack");
	});

	test("a top-level slack token block is refused as channels.slack with the removal note", () => {
		writeConfig(baseConfig({ slack: { botTokenFile: "secrets/bot.token", appTokenFile: "secrets/app.token" } }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain("field=channels.slack");
		expect(err.message).toContain(REMOVED);
	});

	test.each([
		["mentionFreeChannels", ["456789012345678901"]],
		["peerBots", [{ userId: "678901234567890123", name: "떡" }]],
		["requireMention", true],
		["escalationChannel", "789012345678901234"],
		["logChannel", "678901234567890123"],
	])("the top-level %s is refused with the removal note (it lives under channels.discord now)", (key, value) => {
		writeConfig(baseConfig({ [key]: value }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(`field=${key} `);
		expect(err.message).toContain(REMOVED);
	});

	test("channels.discord's requireMention, mentionFreeChannels, peerBots, logChannelId and escalationChannelId load", () => {
		writeConfig(
			baseConfig({
				channels: {
					discord: discordBlock({
						requireMention: true,
						mentionFreeChannels: ["456789012345678901"],
						peerBots: [{ userId: "678901234567890123", name: "떡" }],
						logChannelId: "567890123456789012",
						escalationChannelId: "789012345678901234",
					}),
				},
			}),
		);
		expect(loadConfig(home).channels.discord).toMatchObject({
			requireMention: true,
			mentionFreeChannels: ["456789012345678901"],
			peerBots: [{ userId: "678901234567890123", name: "떡" }],
			logChannelId: "567890123456789012",
			escalationChannelId: "789012345678901234",
		});
	});

	test("there is no top-level copy of them on the loaded config", () => {
		writeConfig(baseConfig({ channels: { discord: discordBlock({ requireMention: true }) } }));
		const cfg = loadConfig(home) as unknown as Record<string, unknown>;
		for (const key of ["mentionFreeChannels", "peerBots", "requireMention", "escalationChannel", "logChannel"]) {
			expect(key in cfg).toBe(false);
		}
	});

	test.each([
		["no channels at all", baseConfig({ channels: undefined }), "field=channels"],
		["channels empty", baseConfig({ channels: {} }), "field=channels"],
		["channels not an object", baseConfig({ channels: ["discord"] }), "field=channels"],
		[
			"an unknown platform key",
			baseConfig({ channels: { discord: discordBlock(), matrix: {} } }),
			"field=channels.matrix",
		],
	])("%s is config_invalid", (_name, cfg, field) => {
		writeConfig(cfg);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});
});

describe("channels.discord", () => {
	const withDiscord = (overrides: Record<string, unknown> = {}) =>
		baseConfig({ channels: { discord: discordBlock(overrides) } });
	const without = (key: string) => {
		const { [key]: _, ...rest } = discordBlock();
		return baseConfig({ channels: { discord: rest } });
	};

	test("present: owner, application, absolute token path and the optional policy keys; never the token value", () => {
		writeConfig(
			withDiscord({
				guildIds: ["345678901234567890"],
				mentionFreeChannels: ["456789012345678901"],
				requireMention: true,
				laneChannelId: "567890123456789012",
				displayName: "송박",
			}),
		);
		const cfg = loadConfig(home);
		expect(cfg.channels.discord).toEqual({
			ownerUserId: OWNER_ID,
			botTokenFile: join(home, "secrets/discord.token"),
			applicationId: APP_ID,
			guildIds: ["345678901234567890"],
			mentionFreeChannels: ["456789012345678901"],
			requireMention: true,
			laneChannelId: "567890123456789012",
			displayName: "송박",
		});
		expect(JSON.stringify(cfg)).not.toContain(TOKEN);
		writeConfig(withDiscord());
		expect(loadConfig(home).channels.discord).toEqual({
			ownerUserId: OWNER_ID,
			botTokenFile: join(home, "secrets/discord.token"),
			applicationId: APP_ID,
		});
	});

	test("logChannelId, escalationChannelId and alertChannelId: snowflakes are taken", () => {
		writeConfig(
			withDiscord({
				logChannelId: "678901234567890123",
				escalationChannelId: "789012345678901234",
				alertChannelId: "890123456789012345",
			}),
		);
		const cfg = loadConfig(home);
		expect(cfg.channels.discord?.logChannelId).toBe("678901234567890123");
		expect(cfg.channels.discord?.escalationChannelId).toBe("789012345678901234");
		expect(cfg.channels.discord?.alertChannelId).toBe("890123456789012345");
	});

	test.each([
		["a non-snowflake logChannelId", { logChannelId: "C0LOGCHAN01" }, "channels.discord.logChannelId"],
		["a numeric logChannelId", { logChannelId: 678901234567890 }, "channels.discord.logChannelId"],
		[
			"a non-snowflake escalationChannelId",
			{ escalationChannelId: "C0ESCALATE1" },
			"channels.discord.escalationChannelId",
		],
		[
			"logChannelId equal to escalationChannelId",
			{ logChannelId: "678901234567890123", escalationChannelId: "678901234567890123" },
			"channels.discord.logChannelId",
		],
		[
			"logChannelId equal to laneChannelId",
			{ logChannelId: "678901234567890123", laneChannelId: "678901234567890123" },
			"channels.discord.logChannelId",
		],
		["a non-snowflake alertChannelId", { alertChannelId: "C0ALERT01" }, "channels.discord.alertChannelId"],
		[
			"logChannelId equal to alertChannelId",
			{ logChannelId: "678901234567890123", alertChannelId: "678901234567890123" },
			"channels.discord.logChannelId",
		],
		[
			"logChannelId among mentionFreeChannels",
			{ logChannelId: "678901234567890123", mentionFreeChannels: ["456789012345678901", "678901234567890123"] },
			"channels.discord.logChannelId",
		],
		// The Discord forum board is gone: a config that still names its forum does not start.
		["a leftover boardForumId", { boardForumId: "890123456789012345" }, "channels.discord.boardForumId"],
	])("%s is config_invalid", (_name, overrides, field) => {
		writeConfig(withDiscord(overrides));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(`field=${field}`);
	});

	test("readDiscordToken returns the one-line value", () => {
		writeConfig(withDiscord());
		expect(readDiscordToken(loadConfig(home))).toBe(TOKEN);
	});

	test.each([
		["no ownerUserId", without("ownerUserId"), "field=channels.discord.ownerUserId"],
		["no botTokenFile", without("botTokenFile"), "field=channels.discord.botTokenFile"],
		["no applicationId", without("applicationId"), "field=channels.discord.applicationId"],
		["a short ownerUserId", withDiscord({ ownerUserId: "1234" }), "field=channels.discord.ownerUserId"],
		["a non-snowflake ownerUserId", withDiscord({ ownerUserId: "UOWNER0" }), "field=channels.discord.ownerUserId"],
		["a numeric ownerUserId", withDiscord({ ownerUserId: 12345678901234 }), "field=channels.discord.ownerUserId"],
		[
			"a 21-digit applicationId",
			withDiscord({ applicationId: "123456789012345678901" }),
			"field=channels.discord.applicationId",
		],
		["an empty botTokenFile", withDiscord({ botTokenFile: "" }), "field=channels.discord.botTokenFile"],
		["guildIds not an array", withDiscord({ guildIds: "345678901234567890" }), "field=channels.discord.guildIds"],
		["guildIds with a non-number", withDiscord({ guildIds: ["C0123ABCD"] }), "field=channels.discord.guildIds"],
		[
			"mentionFreeChannels with a number value",
			withDiscord({ mentionFreeChannels: [45678901234567] }),
			"field=channels.discord.mentionFreeChannels",
		],
		["requireMention not a boolean", withDiscord({ requireMention: "yes" }), "field=channels.discord.requireMention"],
		[
			"a non-snowflake laneChannelId",
			withDiscord({ laneChannelId: "C0123ABCD" }),
			"field=channels.discord.laneChannelId",
		],
		[
			"a numeric laneChannelId",
			withDiscord({ laneChannelId: 45678901234567890 }),
			"field=channels.discord.laneChannelId",
		],
		["a numeric displayName", withDiscord({ displayName: 123 }), "field=channels.discord.displayName"],
		["an empty displayName", withDiscord({ displayName: "" }), "field=channels.discord.displayName"],
		["a 33-character displayName", withDiscord({ displayName: "가".repeat(33) }), "field=channels.discord.displayName"],
		["an unknown key", withDiscord({ botToken: "x" }), "field=channels.discord.botToken"],
		["discord not an object", baseConfig({ channels: { discord: true } }), "field=channels.discord"],
	])("%s is config_invalid", (_name, cfg, field) => {
		writeConfig(cfg);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
		expect(err.message).not.toContain(TOKEN);
	});

	test("token file: missing → secret_missing, not 0600 → secret_permissions", () => {
		writeConfig(withDiscord({ botTokenFile: "secrets/none.token" }));
		expect(catchError(() => loadConfig(home)).code).toBe("secret_missing");
		writeSecret("secrets/discord.token", `${TOKEN}\n`, 0o644);
		writeConfig(withDiscord());
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("secret_permissions");
		expect(err.message).not.toContain(TOKEN);
	});

	test.each([
		["empty", "\n"],
		["two lines", `${TOKEN}\n${TOKEN}\n`],
	])("token file %s → config_invalid without the value", (_name, content) => {
		writeSecret("secrets/discord.token", content);
		writeConfig(withDiscord());
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain("field=channels.discord.botTokenFile");
		expect(err.message).not.toContain(TOKEN);
	});

	test("checkTokens: false skips the token file", () => {
		writeConfig(withDiscord({ botTokenFile: "secrets/none.token" }));
		expect(loadConfig(home, { checkTokens: false }).channels.discord?.applicationId).toBe(APP_ID);
	});

	test("channels needs a restart on reload", () => {
		expect(RESTART_FIELDS as readonly string[]).toContain("channels");
	});

	test("peerBots: snowflake ids with a name load as written", () => {
		writeConfig(withDiscord({ peerBots: [{ userId: "678901234567890123", name: "떡" }] }));
		expect(loadConfig(home).channels.discord?.peerBots).toEqual([{ userId: "678901234567890123", name: "떡" }]);
		writeConfig(withDiscord());
		expect(loadConfig(home).channels.discord?.peerBots).toBeUndefined();
	});

	test.each([
		["peerBots not an array", { peerBots: { userId: "678901234567890123", name: "떡" } }, "channels.discord.peerBots"],
		[
			"a non-snowflake peer id",
			{ peerBots: [{ userId: "UPEER00001", name: "떡" }] },
			"channels.discord.peerBots.0.userId",
		],
		["a numeric peer id", { peerBots: [{ userId: 12345678901234, name: "떡" }] }, "channels.discord.peerBots.0.userId"],
		["the owner as peer", { peerBots: [{ userId: OWNER_ID, name: "떡" }] }, "channels.discord.peerBots.0.userId"],
		["an empty name", { peerBots: [{ userId: "678901234567890123", name: "" }] }, "channels.discord.peerBots.0.name"],
		[
			"a 33-character name",
			{ peerBots: [{ userId: "678901234567890123", name: "x".repeat(33) }] },
			"channels.discord.peerBots.0.name",
		],
		[
			"another key",
			{
				peerBots: [
					{ userId: "678901234567890123", name: "a" },
					{ userId: "789012345678901234", name: "b", token: "x" },
				],
			},
			"channels.discord.peerBots.1.token",
		],
	])("peerBots: %s is config_invalid", (_name, overrides, field) => {
		writeConfig(withDiscord(overrides));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(`field=${field})`);
	});
});

describe("offsite", () => {
	test("is optional; ssh alias / user@host and absolute or ~/ remoteDir are accepted, keep defaults off", () => {
		expect(loadConfig(home).offsite).toBeUndefined();
		writeConfig(baseConfig({ offsite: { ssh: "backup-box", remoteDir: "~/ompbot-backups" } }));
		expect(loadConfig(home).offsite).toEqual({ ssh: "backup-box", remoteDir: "~/ompbot-backups" });
		writeConfig(baseConfig({ offsite: { ssh: "ubuntu@10.0.0.5", remoteDir: "/srv/ompbot", keep: 7 } }));
		expect(loadConfig(home).offsite).toEqual({ ssh: "ubuntu@10.0.0.5", remoteDir: "/srv/ompbot", keep: 7 });
	});

	test.each([
		[{ ssh: "-oProxyCommand=x", remoteDir: "/srv/x" }, "offsite.ssh"],
		[{ ssh: "host name", remoteDir: "/srv/x" }, "offsite.ssh"],
		[{ ssh: "host;rm", remoteDir: "/srv/x" }, "offsite.ssh"],
		[{ remoteDir: "/srv/x" }, "offsite.ssh"],
		[{ ssh: "box", remoteDir: "relative/dir" }, "offsite.remoteDir"],
		[{ ssh: "box", remoteDir: "/srv/a b" }, "offsite.remoteDir"],
		[{ ssh: "box", remoteDir: "/srv/$(id)" }, "offsite.remoteDir"],
		[{ ssh: "box", remoteDir: "/srv/../etc" }, "offsite.remoteDir"],
		[{ ssh: "box", remoteDir: "~/" }, "offsite.remoteDir"],
		[{ ssh: "box", remoteDir: "/srv/x", keep: 0 }, "offsite.keep"],
		[{ ssh: "box", remoteDir: "/srv/x", keep: 1.5 }, "offsite.keep"],
	])("rejects %j", (offsite, field) => {
		writeConfig(baseConfig({ offsite }));
		expect(catchError(() => loadConfig(home)).message).toContain(field);
	});
});

describe("herdr", () => {
	const hosts = { wsl: { ssh: "wsl" } };
	const board = { url: "https://board.example.com/task/" };

	test("is optional (absent = off); {} and an absolute bin are accepted", () => {
		expect(loadConfig(home).herdr).toBeUndefined();
		writeConfig(baseConfig({ herdr: {} }));
		expect(loadConfig(home).herdr).toEqual({});
		writeConfig(baseConfig({ herdr: { bin: "/opt/herdr/bin/herdr" }, dispatchHosts: hosts, herdrBoard: board }));
		const cfg = loadConfig(home);
		expect(cfg.herdr).toEqual({ bin: "/opt/herdr/bin/herdr" });
		expect(cfg.dispatchHosts).toEqual(hosts);
		expect(cfg.herdrBoard).toEqual(board);
	});

	test.each([
		["dispatchHosts without herdr", baseConfig({ dispatchHosts: hosts }), "(field=herdr)"],
		["herdrBoard without herdr", baseConfig({ herdrBoard: board }), "(field=herdr)"],
		["relative herdr.bin", baseConfig({ herdr: { bin: "bin/herdr" } }), "(field=herdr.bin)"],
		["bare herdr.bin", baseConfig({ herdr: { bin: "herdr" } }), "(field=herdr.bin)"],
		["non-string herdr.bin", baseConfig({ herdr: { bin: 5 } }), "(field=herdr.bin)"],
		["non-object herdr", baseConfig({ herdr: true }), "(field=herdr)"],
	])("%s is rejected", (_name, cfg, field) => {
		writeConfig(cfg);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});

	test("workerOmpArgs and dispatchHosts.<h>.ompArgs load as given; absent stays absent", () => {
		writeConfig(baseConfig({ herdr: {}, dispatchHosts: hosts }));
		const plain = loadConfig(home);
		expect(plain.workerOmpArgs).toBeUndefined();
		expect(plain.dispatchHosts?.wsl).toEqual({ ssh: "wsl" });
		const withArgs = { wsl: { ssh: "wsl", ompArgs: ["--prewalk", "--thinking", "high"] } };
		writeConfig(baseConfig({ herdr: {}, dispatchHosts: withArgs, workerOmpArgs: ["--prewalk"] }));
		const cfg = loadConfig(home);
		expect(cfg.workerOmpArgs).toEqual(["--prewalk"]);
		expect(cfg.dispatchHosts).toEqual(withArgs);
	});

	test.each([
		["a string workerOmpArgs", { workerOmpArgs: "--prewalk" }, "(field=workerOmpArgs)"],
		["an empty-string workerOmpArgs element", { workerOmpArgs: ["--prewalk", ""] }, "(field=workerOmpArgs)"],
		["a blank workerOmpArgs element", { workerOmpArgs: ["  "] }, "(field=workerOmpArgs)"],
		["a non-string workerOmpArgs element", { workerOmpArgs: [1] }, "(field=workerOmpArgs)"],
		[
			"an object ompArgs",
			{ dispatchHosts: { wsl: { ssh: "wsl", ompArgs: { a: 1 } } } },
			"(field=dispatchHosts.wsl.ompArgs)",
		],
		[
			"an empty-string ompArgs element",
			{ dispatchHosts: { wsl: { ssh: "wsl", ompArgs: [""] } } },
			"(field=dispatchHosts.wsl.ompArgs)",
		],
	])("%s is rejected naming the key", (_name, extra, field) => {
		writeConfig(baseConfig({ herdr: {}, ...extra }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});

	test("recordsRepo and dispatchHosts.<h>.recordsDir load as given; absent stays absent", () => {
		writeConfig(baseConfig({ herdr: {}, dispatchHosts: hosts }));
		expect(loadConfig(home).recordsRepo).toBeUndefined();
		const withRecords = { wsl: { ssh: "wsl", recordsDir: "/home/u/ompbot-records" } };
		writeConfig(baseConfig({ herdr: {}, dispatchHosts: withRecords, recordsRepo: "/srv/kencrew-private" }));
		const cfg = loadConfig(home);
		expect(cfg.recordsRepo).toBe("/srv/kencrew-private");
		expect(cfg.dispatchHosts).toEqual(withRecords);
	});

	test.each([
		["a relative recordsRepo", { recordsRepo: "records" }, "(field=recordsRepo)"],
		["a recordsRepo with a control character", { recordsRepo: "/srv/rec\nords" }, "(field=recordsRepo)"],
		["a recordsRepo climbing out", { recordsRepo: "/srv/../etc" }, "(field=recordsRepo)"],
		["a non-string recordsRepo", { recordsRepo: 1 }, "(field=recordsRepo)"],
		[
			"a relative recordsDir",
			{ dispatchHosts: { wsl: { ssh: "wsl", recordsDir: "records" } } },
			"(field=dispatchHosts.wsl.recordsDir)",
		],
		[
			"a recordsDir with a control character",
			{ dispatchHosts: { wsl: { ssh: "wsl", recordsDir: "/rec\u0007ords" } } },
			"(field=dispatchHosts.wsl.recordsDir)",
		],
		[
			"an unknown dispatchHosts key next to recordsDir",
			{ dispatchHosts: { wsl: { ssh: "wsl", recordsDir: "/r", recordDir: "/r" } } },
			"(field=dispatchHosts.wsl.recordDir)",
		],
	])("%s is rejected naming the key", (_name, extra, field) => {
		writeConfig(baseConfig({ herdr: {}, ...extra }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});

	test("workerAgy loads as given; absent stays absent", () => {
		writeConfig(baseConfig({ herdr: {} }));
		expect(loadConfig(home).workerAgy).toBeUndefined();
		writeConfig(baseConfig({ herdr: {}, workerAgy: { model: "gemini-4-hydrogen-high" } }));
		expect(loadConfig(home).workerAgy).toEqual({ model: "gemini-4-hydrogen-high" });
	});

	test.each([
		["a string workerAgy", { workerAgy: "gemini" }, "(field=workerAgy)"],
		["a missing model", { workerAgy: {} }, "(field=workerAgy.model)"],
		["a model read as an option", { workerAgy: { model: "--yolo" } }, "(field=workerAgy.model)"],
	])("workerAgy: %s is rejected naming the key", (_name, extra, field) => {
		writeConfig(baseConfig({ herdr: {}, ...extra }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});
});

describe("taskAutoLand", () => {
	const withHerdr = (taskAutoLand: unknown) => baseConfig({ herdr: {}, taskAutoLand });

	test("AC-5: is optional; repos are kept with their trailing slash dropped, maxRisk when given", () => {
		writeConfig(baseConfig({ herdr: {} }));
		expect(loadConfig(home).taskAutoLand).toBeUndefined();
		writeConfig(withHerdr({ repos: ["/home/owner/work/ompbot/", "/home/owner/work/home-bot"] }));
		expect(loadConfig(home).taskAutoLand).toEqual({
			repos: ["/home/owner/work/ompbot", "/home/owner/work/home-bot"],
		});
		writeConfig(withHerdr({ repos: ["/srv/repo//"], maxRisk: "L1" }));
		expect(loadConfig(home).taskAutoLand).toEqual({ repos: ["/srv/repo"], maxRisk: "L1" });
	});

	test.each([
		["empty repos", withHerdr({ repos: [] }), "(field=taskAutoLand.repos)"],
		["repos not an array", withHerdr({ repos: "/srv/repo" }), "(field=taskAutoLand.repos)"],
		["a relative repo", withHerdr({ repos: ["/srv/a", "work/ompbot"] }), "(field=taskAutoLand.repos.1)"],
		["a non-string repo", withHerdr({ repos: [7] }), "(field=taskAutoLand.repos.0)"],
		["maxRisk outside L0~L4", withHerdr({ repos: ["/srv/a"], maxRisk: "L5" }), "(field=taskAutoLand.maxRisk)"],
		["a lower-case maxRisk", withHerdr({ repos: ["/srv/a"], maxRisk: "l2" }), "(field=taskAutoLand.maxRisk)"],
		["an undefined key", withHerdr({ repos: ["/srv/a"], hosts: ["wsl"] }), "(field=taskAutoLand.hosts)"],
		["a non-object", withHerdr(["/srv/a"]), "(field=taskAutoLand)"],
	])("AC-5: %s is rejected", (_name, cfg, field) => {
		writeConfig(cfg);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});

	test("lane parity AC-15: taskAutoLand alone is accepted without herdr (work lanes land without it)", () => {
		writeConfig(baseConfig({ taskAutoLand: { repos: ["/srv/a/"], maxRisk: "L1" } }));
		const cfg = loadConfig(home);
		expect(cfg.herdr).toBeUndefined();
		expect(cfg.taskAutoLand).toEqual({ repos: ["/srv/a"], maxRisk: "L1" });
	});

	test.each([
		["dispatchHosts", { dispatchHosts: { wsl: { ssh: "wsl" } } }],
		["herdrBoard", { herdrBoard: { url: "https://board.example.com/task/" } }],
	])("lane parity AC-15: %s beside taskAutoLand still needs herdr (field=herdr)", (_name, extra) => {
		writeConfig(baseConfig({ taskAutoLand: { repos: ["/srv/a"] }, ...extra }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain("(field=herdr)");
	});

	test("a removed taskAutoLand gate key is rejected like any unknown key", () => {
		// Assembled so the repository keeps no trace of the removed gate's name (the removal's grep check).
		const removed = `proven${"Red"}`;
		writeConfig(withHerdr({ repos: ["/srv/a"], [removed]: {} }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(`(field=taskAutoLand.${removed})`);
	});

	test("lane review AC-9: review is kept with its model and timeoutMs (timeoutMs optional)", () => {
		writeConfig(withHerdr({ repos: ["/srv/a"], review: { model: "anthropic/claude-sonnet-5-5:medium" } }));
		expect(loadConfig(home).taskAutoLand).toEqual({
			repos: ["/srv/a"],
			review: { model: "anthropic/claude-sonnet-5-5:medium" },
		});
		writeConfig(withHerdr({ repos: ["/srv/a"], review: { model: "m", timeoutMs: 1_800_000 } }));
		expect(loadConfig(home).taskAutoLand?.review).toEqual({ model: "m", timeoutMs: 1_800_000 });
	});

	test.each([
		["an empty model", { model: "" }, "(field=taskAutoLand.review.model)"],
		["a blank model", { model: "  " }, "(field=taskAutoLand.review.model)"],
		["no model", { timeoutMs: 1000 }, "(field=taskAutoLand.review.model)"],
		// lane review isolation AC-4: the reviewer's overlay disables the `cursor` provider.
		["a cursor/ model", { model: "cursor/gpt-5" }, "(field=taskAutoLand.review.model)"],
		["timeoutMs 0", { model: "m", timeoutMs: 0 }, "(field=taskAutoLand.review.timeoutMs)"],
		["a negative timeoutMs", { model: "m", timeoutMs: -1 }, "(field=taskAutoLand.review.timeoutMs)"],
		["timeoutMs 1800001", { model: "m", timeoutMs: 1_800_001 }, "(field=taskAutoLand.review.timeoutMs)"],
		["a fractional timeoutMs", { model: "m", timeoutMs: 1.5 }, "(field=taskAutoLand.review.timeoutMs)"],
		["an unknown key", { model: "m", tools: "read" }, "(field=taskAutoLand.review.tools)"],
		["a non-object", "m", "(field=taskAutoLand.review)"],
	])("lane review AC-9: %s is rejected", (_name, review, field) => {
		writeConfig(withHerdr({ repos: ["/srv/a"], review }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});

	test("review confidence AC-6: review.confident is kept as written", () => {
		writeConfig(
			withHerdr({ repos: ["/srv/a"], review: { model: "m", confident: { maxRisk: "L3", minConfidence: 0.85 } } }),
		);
		expect(loadConfig(home).taskAutoLand?.review).toEqual({
			model: "m",
			confident: { maxRisk: "L3", minConfidence: 0.85 },
		});
		writeConfig(
			withHerdr({
				repos: ["/srv/a"],
				maxRisk: "L1",
				review: { model: "m", confident: { maxRisk: "L2", minConfidence: 1 } },
			}),
		);
		expect(loadConfig(home).taskAutoLand?.review?.confident).toEqual({ maxRisk: "L2", minConfidence: 1 });
	});

	const confidentField = "(field=taskAutoLand.review.confident.";
	test.each([
		["confident.maxRisk equal to the default maxRisk L2", undefined, { maxRisk: "L2", minConfidence: 0.9 }, "maxRisk)"],
		["confident.maxRisk below maxRisk", "L3", { maxRisk: "L2", minConfidence: 0.9 }, "maxRisk)"],
		["confident.maxRisk equal to maxRisk", "L3", { maxRisk: "L3", minConfidence: 0.9 }, "maxRisk)"],
		["an unknown confident.maxRisk", undefined, { maxRisk: "L9", minConfidence: 0.9 }, "maxRisk)"],
		["no confident.maxRisk", undefined, { minConfidence: 0.9 }, "maxRisk)"],
		["minConfidence 0", undefined, { maxRisk: "L3", minConfidence: 0 }, "minConfidence)"],
		["minConfidence above 1", undefined, { maxRisk: "L3", minConfidence: 1.01 }, "minConfidence)"],
		["a negative minConfidence", undefined, { maxRisk: "L3", minConfidence: -0.5 }, "minConfidence)"],
		["a string minConfidence", undefined, { maxRisk: "L3", minConfidence: "0.9" }, "minConfidence)"],
		["no minConfidence", undefined, { maxRisk: "L3" }, "minConfidence)"],
		["an unknown confident key", undefined, { maxRisk: "L3", minConfidence: 0.9, floor: 1 }, "floor)"],
	])("review confidence AC-6: %s is rejected", (_name, maxRisk, confident, field) => {
		writeConfig(
			withHerdr({
				repos: ["/srv/a"],
				...(maxRisk === undefined ? {} : { maxRisk }),
				review: { model: "m", confident },
			}),
		);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(`${confidentField}${field}`);
	});

	test("review confidence AC-6: a non-object confident is rejected", () => {
		writeConfig(withHerdr({ repos: ["/srv/a"], review: { model: "m", confident: 0.9 } }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain("(field=taskAutoLand.review.confident)");
	});

	test("run QA (bot-org-risk-gates 단계 3): qa is kept as written (minRisk and timeoutMs optional)", () => {
		const overlay = join(home, "qa.omp.yml");
		writeFileSync(overlay, "modelRoles: {}\n");
		const qa = { minRisk: "L3" as const, overlay, model: "zai/glm-5.3-flash:high", timeoutMs: 1_200_000 };
		writeConfig(withHerdr({ repos: ["/srv/a"], qa }));
		expect(loadConfig(home).taskAutoLand?.qa).toEqual(qa);
		writeConfig(withHerdr({ repos: ["/srv/a"], qa: { overlay, model: "m" } }));
		expect(loadConfig(home).taskAutoLand?.qa).toEqual({ overlay, model: "m" });
	});

	test.each([
		["a relative overlay", { overlay: "qa.omp.yml", model: "m" }, "(field=taskAutoLand.qa.overlay)"],
		["a missing overlay file", { overlay: "/nonexistent/qa.omp.yml", model: "m" }, "field=taskAutoLand.qa.overlay"],
		["no overlay", { model: "m" }, "(field=taskAutoLand.qa.overlay)"],
		["no model", { overlay: "<file>" }, "(field=taskAutoLand.qa.model)"],
		["a cursor/ model", { overlay: "<file>", model: "cursor/x" }, "(field=taskAutoLand.qa.model)"],
		["minRisk outside L0~L4", { overlay: "<file>", model: "m", minRisk: "L5" }, "(field=taskAutoLand.qa.minRisk)"],
		["timeoutMs 1800001", { overlay: "<file>", model: "m", timeoutMs: 1_800_001 }, "(field=taskAutoLand.qa.timeoutMs)"],
		["an unknown key", { overlay: "<file>", model: "m", tools: "bash" }, "(field=taskAutoLand.qa.tools)"],
		["a non-object", "m", "(field=taskAutoLand.qa)"],
	])("run QA: %s is rejected", (_name, qa, field) => {
		const overlay = join(home, "qa.omp.yml");
		writeFileSync(overlay, "modelRoles: {}\n");
		const shaped =
			typeof qa === "string" ? qa : { ...qa, ...("overlay" in qa && qa.overlay === "<file>" ? { overlay } : {}) };
		writeConfig(withHerdr({ repos: ["/srv/a"], qa: shaped }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});

	test("AC-5: taskAutoLand is a live field (ompbot reload applies it without a restart)", () => {
		expect(LIVE_FIELDS).toContain("taskAutoLand");
	});
});

describe("apply.codeRollback (apply-rollback-mode AC-1, 7c)", () => {
	test("each mode loads; without the key or the setting the mode is detach", () => {
		for (const mode of ["push", "detach", "off"] as const) {
			writeConfig(baseConfig({ apply: { codeRollback: mode } }));
			expect(codeRollbackMode(loadConfig(home))).toBe(mode);
		}
		writeConfig(baseConfig({ apply: {} }));
		expect(codeRollbackMode(loadConfig(home))).toBe("detach");
		writeConfig(baseConfig());
		const config = loadConfig(home);
		expect(config.apply).toBeUndefined();
		expect(config.warnings).toBeUndefined();
		expect(codeRollbackMode(config)).toBe("detach");
		expect(codeRollbackMode(undefined)).toBe("detach");
	});

	test.each([
		[{ codeRollback: "revert" }, "field=apply.codeRollback"],
		[{ codeRollback: true }, "field=apply.codeRollback"],
		[{ codeRollback: "push", mode: "x" }, "field=apply.mode"],
		["detach", "field=apply)"],
	])("%j is config_invalid naming %s", (apply, field) => {
		writeConfig(baseConfig({ apply }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});

	test("apply is CLI-only: ompbot apply reads it on every run, the daemon never", () => {
		expect(CLI_FIELDS).toContain("apply");
		expect(LIVE_FIELDS).not.toContain("apply" as never);
		expect(RESTART_FIELDS).not.toContain("apply" as never);
	});
});

describe("dashboard", () => {
	test("port and loopback bind are accepted; bind defaults to unset", () => {
		writeConfig(baseConfig({ dashboard: { port: 7331 } }));
		expect(loadConfig(home).dashboard).toEqual({ port: 7331 });
		writeConfig(baseConfig({ dashboard: { port: 7331, bind: "::1" } }));
		expect(loadConfig(home).dashboard).toEqual({ port: 7331, bind: "::1" });
		writeConfig(baseConfig({ dashboard: { port: 7331, herdrWebUrl: "https://herdr.example.test/" } }));
		expect(loadConfig(home).dashboard).toEqual({ port: 7331, herdrWebUrl: "https://herdr.example.test/" });
		writeConfig(baseConfig({ dashboard: { port: 7331, allowedHosts: ["ompbot.example.com"] } }));
		expect(loadConfig(home).dashboard).toEqual({ port: 7331, allowedHosts: ["ompbot.example.com"] });
	});

	test.each([
		[{ port: 7331, bind: "0.0.0.0" }, "dashboard.bind"],
		[{ port: 0 }, "dashboard.port"],
		[{ port: 70000 }, "dashboard.port"],
		[{ bind: "127.0.0.1" }, "dashboard.port"],
		[{ port: 7331, token: "x" }, "dashboard.token"],
		[{ port: 7331, allowedHosts: ["bad host"] }, "dashboard.allowedHosts"],
		[{ port: 7331, allowedHosts: "ompbot.example.com" }, "dashboard.allowedHosts"],
		[{ port: 7331, allowedHosts: ["https://ompbot.example.com/"] }, "dashboard.allowedHosts"],
		[{ port: 7331, herdrWebUrl: "javascript:alert(1)" }, "dashboard.herdrWebUrl"],
		[{ port: 7331, herdrWebUrl: 7317 }, "dashboard.herdrWebUrl"],
		["7331", "field=dashboard"],
	])("AC-8: %j is a ConfigError naming %s", (dashboard, field) => {
		writeConfig(baseConfig({ dashboard }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});

	test("AC-5: peerHomes with absolute homes is accepted", () => {
		const dashboard = {
			port: 7331,
			peerHomes: [
				{ name: "서팍", home: "/h/seopak" },
				{ name: "ttungi", home: "/h/t" },
			],
		};
		writeConfig(baseConfig({ dashboard }));
		expect(loadConfig(home).dashboard).toEqual(dashboard);
	});

	test.each([
		[[{ name: "서팍", home: "rel/path" }], "dashboard.peerHomes.0.home"],
		[
			[
				{ name: "a", home: "/h/a" },
				{ name: "a", home: "/h/b" },
			],
			"dashboard.peerHomes.1.name",
		],
		[[{ name: "a:b", home: "/h/a" }], "dashboard.peerHomes.0.name"],
		[[{ name: "a b", home: "/h/a" }], "dashboard.peerHomes.0.name"],
		[[{ name: "", home: "/h/a" }], "dashboard.peerHomes.0.name"],
		[[{ name: "   ", home: "/h/a" }], "dashboard.peerHomes.0.name"],
		[[{ name: "a".repeat(21), home: "/h/a" }], "dashboard.peerHomes.0.name"],
		[[{ name: "a", home: "/h/a", extra: 1 }], "dashboard.peerHomes.0.extra"],
		["서팍", "field=dashboard.peerHomes"],
	])("AC-5: peerHomes %j is a ConfigError naming %s", (peerHomes, field) => {
		writeConfig(baseConfig({ dashboard: { port: 7331, peerHomes } }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});

	test("opsStatus with command and url is accepted", () => {
		const dashboard = {
			port: 7331,
			opsStatus: { command: ["ops-status", "--json"], url: "https://hub.example.test/" },
		};
		writeConfig(baseConfig({ dashboard }));
		expect(loadConfig(home).dashboard).toEqual(dashboard);
		writeConfig(baseConfig({ dashboard: { port: 7331, opsStatus: { command: ["ops-status"] } } }));
		expect(loadConfig(home).dashboard?.opsStatus).toEqual({ command: ["ops-status"] });
	});

	test.each([
		[{ command: [] }, "field=dashboard.opsStatus.command"],
		[{ command: ["ops-status", ""] }, "field=dashboard.opsStatus.command"],
		[{ command: "ops-status --json" }, "field=dashboard.opsStatus.command"],
		[{ command: ["ops-status", 1] }, "field=dashboard.opsStatus.command"],
		[{ url: "https://hub.example.test/" }, "field=dashboard.opsStatus.command"],
		[{ command: ["ops-status"], url: "javascript:alert(1)" }, "field=dashboard.opsStatus.url"],
		[{ command: ["ops-status"], url: "hub.example.test" }, "field=dashboard.opsStatus.url"],
		[{ command: ["ops-status"], timeoutMs: 5000 }, "field=dashboard.opsStatus.timeoutMs"],
		[["ops-status"], "field=dashboard.opsStatus"],
	])("AC-7: opsStatus %j is a ConfigError naming %s", (opsStatus, field) => {
		const dashboard = { port: 7331, opsStatus };
		writeConfig(baseConfig({ dashboard }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});

	test("checkTokens: false loads a config whose token files are missing", () => {
		rmSync(join(home, "secrets"), { recursive: true, force: true });
		expect(catchError(() => loadConfig(home)).code).toBe("secret_missing");
		expect(loadConfig(home, { checkTokens: false }).channels.discord?.ownerUserId).toBe(OWNER_ID);
	});
});

describe("Discord-only: no other platform configured", () => {
	test("AC-A1: a Discord-only config loads, binds Discord alone and the daemon starts with Discord alone", async () => {
		writeConfig(baseConfig());
		const config = loadConfig(home);
		expect(Object.keys(config.channels)).toEqual(["discord"]);
		expect(config.channels.discord?.ownerUserId).toBe(OWNER_ID);

		const logs: string[] = [];
		const log = createLogger({ sink: (line) => logs.push(line), clock: { now: () => Date.now() }, redact });
		const env = { OMPBOT_TEST_HOOKS: "1", OMPBOT_TEST_DISCORD_TRANSPORT: join(home, "discord-calls.jsonl") };
		const channels = channelBindings(config, env, log);
		expect(channels.map((binding) => binding.port.platform)).toEqual(["discord"]);

		const sessions = new FakeSessionStore();
		const daemon = new Daemon({
			config,
			channels,
			log,
			ompVersion: "omp-test 0",
			bootId: "boot",
			gateSweepMs: 0,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		try {
			await daemon.start();
		} finally {
			await daemon.stop();
		}
		const ready = logs.find((line) => line.includes("event=daemon_ready"));
		expect(ready).toContain("discord=on");
		expect(ready).not.toContain("teams=");
		expect(logs.some((line) => line.includes("secret_missing"))).toBe(false);
	});

	test("no platform at all is config_invalid field=channels", () => {
		const { channels: _channels, ...rest } = baseConfig();
		writeConfig(rest);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain("field=channels");
		writeConfig({ ...rest, channels: {} });
		expect(catchError(() => loadConfig(home)).message).toContain("field=channels");
	});

	test("channels.discord.logChannelId and escalationChannelId load", () => {
		writeConfig(
			baseConfig({
				channels: {
					discord: discordBlock({ logChannelId: "678901234567890123", escalationChannelId: "789012345678901234" }),
				},
			}),
		);
		const loaded = loadConfig(home);
		expect(loaded.channels.discord?.logChannelId).toBe("678901234567890123");
		expect(loaded.channels.discord?.escalationChannelId).toBe("789012345678901234");
	});

	test("channels.discord.peerBots and peerHopLimit load", () => {
		writeConfig(
			baseConfig({
				channels: { discord: discordBlock({ peerBots: [{ userId: "678901234567890123", name: "떡" }] }) },
				peerHopLimit: { turns: 2, windowMinutes: 10 },
			}),
		);
		const loaded = loadConfig(home);
		expect(loaded.channels.discord?.peerBots).toEqual([{ userId: "678901234567890123", name: "떡" }]);
		expect(loaded.peerHopLimit).toEqual({ turns: 2, windowMinutes: 10 });
	});
});

describe("qa50b lane I", () => {
	test("I-1: config.json that is a directory is config_unreadable, not config_missing", () => {
		rmSync(join(home, "config.json"));
		mkdirSync(join(home, "config.json"));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_unreadable");
		expect(err.message).toContain("EISDIR");
		rmSync(join(home, "config.json"), { recursive: true });
		expect(catchError(() => loadConfig(home)).code).toBe("config_missing");
	});

	test("I-2: a config.json starting with a UTF-8 BOM loads", () => {
		writeFileSync(join(home, "config.json"), `\ufeff${JSON.stringify(baseConfig())}`);
		expect(loadConfig(home).channels.discord?.ownerUserId).toBe(OWNER_ID);
	});

	test("I-3: unknown top-level keys load but are listed as warnings (key name only)", () => {
		writeConfig(baseConfig({ bogusKey: TOKEN }));
		const cfg = loadConfig(home);
		expect(cfg.warnings).toEqual([{ field: "bogusKey", reason: "unknown_key" }]);
		writeConfig(baseConfig());
		expect(loadConfig(home).warnings).toBeUndefined();
		writeConfig(baseConfig({ timezone: "Asia/Seoul" }));
		expect(loadConfig(home).warnings).toBeUndefined();
	});

	test("I-5/7/11/13: an empty OMPBOT_HOME means unset", () => {
		const fallback = defaultHomeDir({});
		expect(defaultHomeDir({ OMPBOT_HOME: "" })).toBe(fallback);
		expect(defaultHomeDir({ OMPBOT_HOME: "/x/home" })).toBe("/x/home");
	});

	test("I-6: a dispatchHosts name with control characters loads but is flagged", () => {
		writeConfig(baseConfig({ herdr: {}, dispatchHosts: { "wsl\nfake ok": { ssh: "wsl" }, "oci-2": { ssh: "oci" } } }));
		const cfg = loadConfig(home);
		expect(cfg.warnings).toEqual([{ field: "dispatchHosts", reason: "unsafe_name" }]);
		expect(Object.keys(cfg.dispatchHosts ?? {})).toContain("oci-2");
	});

	test("I-9: remoteDir slashes are collapsed; one that collapses to an empty dir is flagged", () => {
		writeConfig(baseConfig({ offsite: { ssh: "box", remoteDir: "~//backups//x/" } }));
		expect(loadConfig(home).offsite?.remoteDir).toBe("~/backups/x/");
		writeConfig(baseConfig({ offsite: { ssh: "box", remoteDir: "//" } }));
		const cfg = loadConfig(home);
		expect(cfg.warnings).toEqual([{ field: "offsite.remoteDir", reason: "unusable" }]);
		expect(isOffsiteDir(cfg.offsite?.remoteDir ?? "")).toBe(false);
	});

	test("I-10: isOffsiteDir agrees with the config check on `..` (segment only)", () => {
		writeConfig(baseConfig({ offsite: { ssh: "box", remoteDir: "/srv/a..b" } }));
		const dir = loadConfig(home).offsite?.remoteDir ?? "";
		expect(isOffsiteDir(dir)).toBe(true);
		expect(isOffsiteDir("/srv/../etc")).toBe(false);
		expect(isOffsiteDir("~/")).toBe(false);
		expect(isOffsiteDir("/")).toBe(false);
	});
});

describe("qa-l low config (#1 #2 #3 #19)", () => {
	test("#1: an ompConfigOverlay behind a symlink loop or a non-directory parent is a ConfigError, not a raw fs error", () => {
		symlinkSync("loop-b", join(home, "loop-a"));
		symlinkSync("loop-a", join(home, "loop-b"));
		writeFileSync(join(home, "plain"), "x");
		for (const overlay of ["loop-a", "plain/overlay.yml"]) {
			writeConfig(baseConfig({ ompConfigOverlay: overlay }));
			const error = catchError(() => loadConfig(home));
			expect(error.code).toBe("config_invalid");
			expect(error.message).toContain("field=ompConfigOverlay");
		}
	});

	test("#2: an ompConfigOverlay regular file that cannot be read is rejected", () => {
		writeConfig(baseConfig({ ompConfigOverlay: "/proc/self/mem" }));
		const error = catchError(() => loadConfig(home));
		expect(error.code).toBe("config_invalid");
		expect(error.message).toContain("field=ompConfigOverlay");
	});

	test("#3: a workspaceDir symlinked to itself is config_invalid", () => {
		symlinkSync("ws", join(home, "ws"));
		writeConfig(baseConfig({ workspaceDir: "ws" }));
		const error = catchError(() => loadConfig(home));
		expect(error.code).toBe("config_invalid");
		expect(error.message).toContain("field=workspaceDir");
	});

	test("#19: a turnSnapshot repo without any commit is rejected", async () => {
		const repo = join(home, "empty-repo");
		mkdirSync(repo);
		await Bun.spawn(["git", "init", "-q", repo]).exited;
		writeConfig(baseConfig({ turnSnapshot: { repos: [repo] } }));
		const error = catchError(() => loadConfig(home));
		expect(error.message).toContain("field=turnSnapshot.repos");
	});
});
