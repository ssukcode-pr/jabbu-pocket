import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type AgyMcpServer, agyMcpServersOf, workerAgyOf } from "./config-agy";
import { SLACK_KEYS } from "./config-removed-keys";
import {
	asRecord,
	ConfigError,
	type ConfigWarning,
	checkLaneLandRemotes,
	checkLaneModels,
	dispatchHostsOf,
	gateTimeoutMs,
	invalid,
	isRecordsPath,
	type LaneLandRepoConfig,
	laneLandOf,
	optionalArgList,
	optionalInt,
	optionalString,
	requiredString,
} from "./config-validate";
import { validAllowedHosts } from "./dashboard/host-guard";
import type { LaneModelTiers } from "./model-tiers";
import type { LaneReviewConfident } from "./tasks/auto-land-policy";
import { TASK_RISKS, type TaskRisk } from "./tasks/docs";
import { hostTimezone, isTimezone } from "./time";

export { ConfigError } from "./config-validate";
/** Which child process powers a conversation: omp's RPC child (default) or the Antigravity CLI (`agy`). */
export type AgentKind = "omp" | "agy";

/** `channels.discord`: present → the daemon also talks on Discord (Gateway + REST with the bot token). */
export interface DiscordChannelConfig {
	/** The owner's Discord user id (snowflake); only this user's messages are taken. */
	ownerUserId: string;
	/** Absolute, resolved against the config directory; one line, mode 0600. */
	botTokenFile: string;
	applicationId: string;
	/** Servers whose messages are taken; absent: every server the bot is in. DMs are not affected. */
	guildIds?: string[];
	/** Channel ids where the owner's root messages are answered without a mention. */
	mentionFreeChannels?: string[];
	/** In a server channel only a mention addresses the bot. Default false. */
	requireMention?: boolean;
	/** Server text channel where lanes asked for from the Discord DM open (a DM has no threads); absent: no DM lanes. */
	laneChannelId?: string;
	/**
	 * Server text channel of the Discord #log ledger: completion reports of Discord conversations and lanes are copied
	 * there and nothing said there (or in its threads) becomes a turn. Never a lane, escalation or mention-free channel.
	 */
	logChannelId?: string;
	/** Server text channel that receives the approval cards of Discord requests; absent: the asking conversation. */
	escalationChannelId?: string;
	/**
	 * Server text channel for the owner alerts (gate open/close, failing or stalled turns, stuck dispatch, provider
	 * limits, failed monitors) instead of the owner home (DM); absent: the owner home. Never the log channel.
	 */
	alertChannelId?: string;
	/**
	 * Applied once at daemon start as the bot's global display name (`PATCH /users/@me`): what DMs and nickname-less
	 * servers show instead of the ASCII username. 1-32 characters. A server nickname still wins over it.
	 */
	displayName?: string;
	/**
	 * Peer bots (other ompbot instances) whose server channel messages that mention this bot are taken as review
	 * requests. Changing it needs a restart (`channels` is a restart key).
	 */
	peerBots?: Array<{ userId: string; name: string }>;
}

/** Per-platform chat settings: who the owner is on the platform the bot talks on. Discord is the only one. */
export interface ChannelsConfig {
	discord?: DiscordChannelConfig;
}

/**
 * The owner id core-authored mentions use when no platform is implied: the Discord owner. A loaded config always has
 * it (`config_invalid field=channels` otherwise).
 */
export function primaryOwnerUserId(channels: ChannelsConfig): string {
	const owner = channels.discord?.ownerUserId;
	if (owner === undefined) throw new Error("no chat channel is configured");
	return owner;
}

/** `peerSilenceAlert.minutes` when the key is left out, and the largest value it takes (one day). */
export const PEER_SILENCE_DEFAULT_MINUTES = 10;
const PEER_SILENCE_MAX_MINUTES = 1440;

/** Minutes a peer may stay silent after a call before the owner hears of it; 0: the alert is off. */
export function peerSilenceMinutes(config: Pick<OmpbotConfig, "peerSilenceAlert">): number {
	return config.peerSilenceAlert?.minutes ?? PEER_SILENCE_DEFAULT_MINUTES;
}

function slackRemoved(configPath: string, field: string): never {
	throw new ConfigError("config_invalid", configPath, `field=${field} (Slack 채널은 제거됨: discord만)`);
}

/** omp's own profile name rule (`OMP_PROFILE`); `ompProfile` must match it. */
const OMP_PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Top-level keys `loadConfig` reads; any other one is reported as a `ConfigWarning`, not refused. */
const ROOT_KEYS = new Set([
	"schemaVersion",
	"channels",
	"ompExecutable",
	"ompProfile",
	"ompConfigOverlay",
	"workspaceDir",
	"agent",
	"agyExecutable",
	"agyMcpServers",
	"model",
	"thinking",
	"sessionRetentionDays",
	"maxBundleBytes",
	"offsite",
	"idleTimeoutMinutes",
	"idleKeepResident",
	"skillReviewTurns",
	"ownerSilenceFallbackMinutes",
	"peerHopLimit",
	"peerSilenceAlert",
	"hostSessionCeiling",
	"costCap",
	"herdr",
	"workerOmpArgs",
	"workerAgy",
	"dispatchHosts",
	"recordsRepo",
	"herdrBoard",
	"taskAutoLand",
	"restartNotice",
	"recallEnabled",
	"watcherRoots",
	"turnSnapshot",
	"wikiNotes",
	"webhook",
	"dashboard",
	"briefing",
	"lanes",
	"candidates",
	"timezone",
	"apply",
]);

/**
 * `apply.codeRollback`: `push` makes a revert commit with the head.last-good tree on main and pushes it (the owner's
 * repository); `detach` leaves main alone and checks out head.last-good detached (a checkout following a public main);
 * `off` reverts nothing and only names the revert command.
 */
const CODE_ROLLBACK_MODES = ["push", "detach", "off"] as const;
export type CodeRollbackMode = (typeof CODE_ROLLBACK_MODES)[number];
const DEFAULT_CODE_ROLLBACK: CodeRollbackMode = "detach";

/** A commit identity email (`taskAutoLand.commitEmails`): one `@`, no blanks around it. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

/** The code rollback mode of a home's config (`DEFAULT_CODE_ROLLBACK` without config or setting). */
export function codeRollbackMode(config: Pick<OmpbotConfig, "apply"> | undefined): CodeRollbackMode {
	return config?.apply?.codeRollback ?? DEFAULT_CODE_ROLLBACK;
}

/** One `dispatchHosts` entry: ssh target, remote work directory, remote herdr binary, worker omp extra arguments. */
export interface DispatchHostConfig {
	ssh: string;
	workDir?: string;
	herdrBin?: string;
	ompArgs?: string[];
	recordsDir?: string;
}

export interface WorkerAgyConfig {
	model: string;
}

export interface OmpbotConfig {
	schemaVersion: 1;
	homeDir: string;
	configPath: string;
	channels: ChannelsConfig;
	/**
	 * Settings the file has that load but do nothing or cannot work (the daemon warns about them at startup, field
	 * names only): an unknown top-level key, a `dispatchHosts` name with control characters, an `offsite.remoteDir`
	 * that is only slashes. Absent when there are none.
	 */
	warnings?: ConfigWarning[];
	ompExecutable: string;
	/**
	 * omp profile of the bot's own omp children (`OMP_PROFILE`): their agent dir becomes
	 * `~/.omp/profiles/<name>/agent`, filled by `ompbot omp sync`. Unset → the inherited agent dir, as before.
	 */
	ompProfile?: string;
	/**
	 * Absolute path of an omp `--config` overlay every omp child of this install gets (RPC children of every origin and
	 * the simple `ompbot_dispatch` run): the file's value resolved against the home, an existing file. Its contents are
	 * read by each new child; unset → no `--config`, as before.
	 */
	ompConfigOverlay?: string;
	workspaceDir: string;
	/**
	 * IANA time zone of every day boundary, displayed time and default monitor zone (`Europe/Berlin`). Always set on a
	 * loaded config: the file's value, else the host zone (`UTC` when the host reports none).
	 */
	timezone: string;
	/** Child agent behind chat origins: omp (`omp --mode rpc`) or the Antigravity CLI. Default "omp". */
	agent?: AgentKind;
	/** Absolute agy CLI path for `agent: "agy"`; default resolves `agy` on the child PATH. */
	agyExecutable?: string;
	/** stdio MCP servers each agy conversation gets on `session/new|resume` (`config-agy.ts`); absent = none. */
	agyMcpServers?: AgyMcpServer[];
	model?: string;
	thinking?: string;
	sessionRetentionDays?: number;
	/**
	 * Combined size ceiling of the backup bundle sources (sessions + config.json) in bytes; `ompbot backup
	 * --max-bundle-bytes` overrides it per run. A positive integer; unset means the 512MB default.
	 */
	maxBundleBytes?: number;
	/**
	 * Off-site copy of the newest backup + bundle (`ompbot backup` runs it after a good local backup; running
	 * `ompbot backup` again retries it). `ssh` is an ssh alias or `user@host` (BatchMode, key auth); `remoteDir` an
	 * absolute path or `~/…` on that host; `keep` the days of daily files per kind kept there - every file of the
	 * uploaded day, the latest of each other day (default 14). Unset → no off-site copy.
	 */
	offsite?: { ssh: string; remoteDir: string; keep?: number };
	/** Minutes after which an idle omp child becomes a candidate to stop (the session stays); 0 disables. Default 30. */
	idleTimeoutMinutes?: number;
	/**
	 * A conversation child past `idleTimeoutMinutes` stays unless its context use is 50% or more, the omp executable
	 * changed, or the host is under session/memory pressure; `false` stops it at the idle time as before. Default true.
	 */
	idleKeepResident?: boolean;
	/** Owner DM turns between background skill reviews; 0 disables. Default 10 (each review costs tokens). */
	skillReviewTurns?: number;
	/** Minutes a reversible owner question (lane `reversible`+`recommend`, TASK `fallback_ok: yes`+`recommend`) waits before the recommendation goes ahead; 0 disables. Default 30. */
	ownerSilenceFallbackMinutes?: number;
	/** Peer input cap per thread: more than `turns` peer messages within `windowMinutes` are dropped. Default 3 per 30. */
	peerHopLimit?: { turns: number; windowMinutes: number };
	/** Host-wide ceiling of running omp RPC sessions (`omp --mode rpc`·`rpc-ui`, all users): a lane or [TASK] start refuses at or above it (`force` passes). Default 8; 0 disables. Applies from the next daemon boot. */
	hostSessionCeiling?: number;
	/**
	 * Peer silence alert: a confirmed post in a Discord thread that mentions a `channels.discord.peerBots` entry, left
	 * without any post of that peer in the thread for `minutes`, gets one owner-mentioning notice there. 0 disables
	 * (no call is recorded). Default {@link PEER_SILENCE_DEFAULT_MINUTES}.
	 */
	peerSilenceAlert?: { minutes: number };
	/**
	 * Cost ceiling in dollars as omp prices it (`usage.cost.total`, not the real bill): a turn that reaches `turnUsd`
	 * gets a thread warning and one that reaches 3x is stopped; a day (in `timezone`) whose session-file total passes
	 * `dailyUsd` only opens the `cost_cap` gate (an owner notice, nothing stops). Each key off when absent or not positive.
	 */
	costCap?: { turnUsd?: number; dailyUsd?: number };
	/**
	 * herdr switch: present (`{}`) → `ompbot_dispatch` offers herdr/taskSpec and the [TASK] sweep runs; absent → simple
	 * dispatch only. `bin` is the absolute path of the local herdr (default: `herdr` on PATH).
	 */
	herdr?: { bin?: string };
	/**
	 * Extra arguments for the local herdr worker omp (`herdr agent start … -- <args>`), e.g. `["--prewalk"]`. Not
	 * applied to `omp -p` simple dispatch nor to remote hosts (those use `dispatchHosts.<h>.ompArgs`).
	 */
	workerOmpArgs?: string[];
	/**
	 * The agy (Antigravity CLI) [TASK] worker trial (`taskSpec.worker: "agy"`): `model` is
	 * the agy model id, `args` extra agy arguments after the bot's own. Absent → `worker: "agy"` runs on omp instead.
	 */
	workerAgy?: WorkerAgyConfig;
	/**
	 * Remote dispatch targets for `ompbot_dispatch host=…`: herdr runs on that host over ssh. Needs `herdr`.
	 * `ompArgs`: extra arguments for that host's herdr worker omp, resolved by that host's omp settings.
	 */
	dispatchHosts?: Record<string, DispatchHostConfig>;
	/** Records checkout (absolute): [TASK] records go to its `docs/tasks/<id>` (remote: the host's plain `recordsDir`). */
	recordsRepo?: string;
	/**
	 * herdr-web-ui task board: `url` is the public board page (card links `<url>?card=<key>` go into dispatch reports),
	 * `api` the web UI origin reachable from this host (default `http://127.0.0.1:7317`). Unset → no board links.
	 * Needs `herdr`.
	 */
	herdrBoard?: { url: string; api?: string };
	/**
	 * Auto-merge of [TASK]s and work lanes: a local task (never a `dispatchHosts` one) or a closed lane whose
	 * repository shares its git common directory with one of `repos` (absolute, trailing slash dropped), whose risk is
	 * at most `maxRisk` (default L2), and whose outcome stands on at least one passing re-run check without warnings
	 * is merged without a question — a task gets "머지해" from the bot, a lane is landed by the core
	 * (`src/lanes/land.ts`). Unset → every reached task and closed lane waits for the owner. Works without `herdr`
	 * (lanes); the [TASK] sweep itself only runs with it. `review` (lanes, and [TASK]s in the `confident` band): before an auto-merge a fresh read-only
	 * `omp -p --model <model>` reviews the claim commit's diff against the lane's spec, and only its `CLEAR` receipt
	 * for that commit lets the lane merge unasked (`timeoutMs` default 600000, at most 1800000). Unset → no review.
	 * `review.confident` (`{ maxRisk, minConfidence }`): a lane whose explicit risk is above `maxRisk` and at most
	 * `confident.maxRisk` (which must be above `maxRisk`) is reviewed too, and merges unasked when its `CLEAR` receipt
	 * carries a confidence of at least `minConfidence` (0 < x ≤ 1). A lane without a risk is never in that band. A local
	 * [TASK] in that band gets the same review of its branch tip, then `qa`, then the core's landing
	 * (src/tasks/gate.ts); a task at or below `maxRisk` is never reviewed.
	 * Turn `review` on alone first and watch the confidences for two weeks, then add `confident`.
	 * `qa` (`{ minRisk, overlay, model, timeoutMs }`): a reviewed lane or banded [TASK] at `minRisk` (default L3) or above is
	 * also run once by `omp -p --model <model>` under the `overlay` omp yml (absolute, an existing file) in a detached
	 * copy of its claim commit, and only that commit's `PASS` receipt lets it merge unasked (`timeoutMs` default
	 * 600000, at most 1800000). Unset → no QA.
	 */
	taskAutoLand?: {
		repos: string[];
		maxRisk?: TaskRisk;
		review?: { model: string; timeoutMs?: number; confident?: LaneReviewConfident };
		qa?: { minRisk?: TaskRisk; overlay: string; model: string; timeoutMs?: number };
		/** Per repository (absolute path): the author/committer emails a lane's commits may carry (case-insensitive). */
		commitEmails?: Record<string, string[]>;
	};
	/**
	 * Work lanes. `models`: the model (`provider/id`) of each tier the session may pick when it starts a lane
	 * (`ompbot_work_start` `model`); a tier left out cannot be picked. `land`: how each repository's lanes land.
	 */
	lanes?: { models?: LaneModelTiers; land?: Record<string, LaneLandRepoConfig> };
	/**
	 * Post "재시작 중" / "다시 연결됨" / "재시작 취소" notices to recently active conversations around a drain restart.
	 * Default true.
	 */
	restartNotice?: boolean;
	/** Prepend channel-scoped recall of earlier conversation rows to a turn prompt that points at the past. Default true. */
	recallEnabled?: boolean;
	/** Absolute directories a `watcher` monitor may watch (its root must sit inside one, symlinks resolved). */
	watcherRoots?: string[];
	/**
	 * Git work trees whose changes a conversation turn snapshots for `!undo` (absolute paths; each must be a git work
	 * tree). Absent or empty = the feature is off and no git is ever run.
	 */
	turnSnapshot?: { repos: string[] };
	/**
	 * Work-unit result notes for the wiki (`src/wiki`): `client` is the wiki client root holding
	 * `integrations/omp/omp-wiki-session-note.py`, `agentDir` the omp agent dir whose `wiki-outbox/` it drains
	 * (default `~/.omp/agent`), `repos` limits the notes to work in those repositories. Absent = no note is written.
	 */
	wikiNotes?: { client: string; agentDir?: string; repos?: string[] };
	/**
	 * Loopback listener for `webhook` monitor triggers (POST /hook/<id> with a bearer token). Absent = no server and
	 * webhook triggers cannot be created. `bind` must be a loopback address; the default is 127.0.0.1.
	 */
	webhook?: { port: number; bind?: "127.0.0.1" | "::1" };
	/**
	 * Read-only status page of `ompbot dashboard` (a separate process; `--port`/`--bind` override). `bind` must be a
	 * loopback address; the default is 127.0.0.1. Absent = the command needs `--port`. `herdrWebUrl` is herdr-web-ui's
	 * address for the agent board's "herdr에서 답하기" links (absent = no link). `opsStatus` is a command printing the
	 * ops-status JSON for the system view's "호스트 점검" card and a `!brief` line (absent = no card, no command run);
	 * `url` links the card head. `usageLimits` lists the commands of the "모델 한도" card (`omp`: argv per provider, `agy`: one argv, `agyAccount`: argv printing the agy account label; absent = no card, no command run). `peerHomes`: other installs on this host (`name` one word, no `:`; `home` absolute)
	 * whose enabled monitors the monitors view lists read-only beside this install's own.
	 */
	dashboard?: {
		port: number;
		bind?: "127.0.0.1" | "::1";
		herdrWebUrl?: string;
		/** Extra `Host` names the page answers (a tunnel's public name); `localhost`, `127.0.0.1` and `::1` always pass. */
		allowedHosts?: string[];
		opsStatus?: { command: string[]; url?: string };
		usageLimits?: { omp?: string[][]; agy?: string[]; agyAccount?: string[] };
		peerHomes?: Array<{ name: string; home: string }>;
	};
	/**
	 * `ompbot apply` (read on every run, never by the daemon). `codeRollback`: what a failed apply whose config rollback
	 * also failed does with the code — see `CodeRollbackMode`; absent = `DEFAULT_CODE_ROLLBACK`.
	 */
	apply?: { codeRollback?: CodeRollbackMode };
	/**
	 * `!brief`: the chromium that draws the picture. `chromium` is a name on PATH or an absolute path
	 * (default `chromium`). No existence check at load: a missing browser is reported by the briefing's failure line.
	 */
	briefing?: { chromium?: string };
	/**
	 * Improvement-candidate ledger (`<workspace>/candidates.jsonl`): a problem the self-retro saw on `minDays` distinct
	 * days within `windowDays` is raised as a #log line (`mode` "log", default) or an owner approval card ("card", at
	 * most `maxOpenCards` at once); a candidate noticed or rejected once comes back after `snoozeDays`. Unset fields
	 * take the defaults in `src/review/candidates.ts` (enabled, log, 3, 14, 1, 7).
	 */
	candidates?: {
		enabled?: boolean;
		mode?: "log" | "card";
		minDays?: number;
		windowDays?: number;
		maxOpenCards?: number;
		snoozeDays?: number;
	};
}

/** An ssh alias or `user@host`: never starts with `-` (no option injection), no spaces or shell characters. */
export const OFFSITE_SSH = /^([A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Absolute or `~/` path of plain characters, so it can sit unquoted in the remote shell command. */
export const OFFSITE_DIR = /^(\/|~\/)[A-Za-z0-9._+=@%:/-]+$/;

/**
 * The one `offsite.remoteDir` predicate for config load and the off-site run: `OFFSITE_DIR`, no `..` segment
 * (`a..b` is a plain name), and something left besides `/` or `~` once repeated and trailing slashes go.
 */
export function isOffsiteDir(dir: string): boolean {
	if (!OFFSITE_DIR.test(dir) || dir.split("/").some((part) => part === "..")) return false;
	const collapsed = dir.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
	return collapsed !== "" && collapsed !== "~";
}

export const HOME_MODE = 0o700;
export const SECRET_MODE = 0o600;
/** `taskAutoLand.review.timeoutMs`: default and upper bound of one lane review run. */
export const LANE_REVIEW_TIMEOUT_MS = 600_000;

export function defaultHomeDir(env: Record<string, string | undefined> = process.env): string {
	// An empty value is "unset", never "" (which `resolve` would turn into the current directory).
	return env.OMPBOT_HOME || join(homedir(), ".ompbot");
}

function modeString(mode: number): string {
	return `0${(mode & 0o777).toString(8)}`;
}

/**
 * `channels`: only `discord` is accepted (a leftover `channels.slack`, top-level Slack key or `channels.teams` is
 * refused with the removal note), and it must be there.
 */
function parseChannels(configPath: string, root: Record<string, unknown>, home: string): ChannelsConfig {
	for (const key of SLACK_KEYS) {
		if (root[key] !== undefined) slackRemoved(configPath, key === "slack" ? "channels.slack" : key);
	}
	let discord: DiscordChannelConfig | undefined;
	if (root.channels !== undefined) {
		const channels = asRecord(root.channels);
		if (channels === undefined) invalid(configPath, "channels");
		for (const key of Object.keys(channels)) {
			if (key === "slack") slackRemoved(configPath, "channels.slack");
			if (key === "teams") {
				throw new ConfigError("config_invalid", configPath, "field=channels.teams (Teams 채널은 제거됨: discord만)");
			}
			if (key !== "discord") invalid(configPath, `channels.${key}`);
		}
		if (channels.discord !== undefined) discord = parseDiscordChannel(configPath, channels.discord, home);
	}
	if (discord === undefined) invalid(configPath, "channels");
	return { discord };
}

/** A Discord id (snowflake): 17–20 digits. */
const SNOWFLAKE = /^[0-9]{17,20}$/;
const DISCORD_KEYS: Record<string, true> = {
	ownerUserId: true,
	botTokenFile: true,
	applicationId: true,
	guildIds: true,
	mentionFreeChannels: true,
	requireMention: true,
	laneChannelId: true,
	logChannelId: true,
	escalationChannelId: true,
	alertChannelId: true,
	displayName: true,
	peerBots: true,
};

function parseDiscordChannel(configPath: string, value: unknown, home: string): DiscordChannelConfig {
	const record = asRecord(value);
	if (record === undefined) invalid(configPath, "channels.discord");
	for (const key of Object.keys(record)) {
		if (!Object.hasOwn(DISCORD_KEYS, key)) invalid(configPath, `channels.discord.${key}`);
	}
	const snowflake = (key: string): string => {
		const id = record[key];
		if (typeof id !== "string" || !SNOWFLAKE.test(id)) invalid(configPath, `channels.discord.${key}`);
		return id;
	};
	const snowflakes = (key: string): string[] | undefined => {
		const ids = record[key];
		if (ids === undefined) return undefined;
		if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !SNOWFLAKE.test(id))) {
			invalid(configPath, `channels.discord.${key}`);
		}
		return [...(ids as string[])];
	};
	const ownerUserId = snowflake("ownerUserId");
	const botTokenFile = resolve(
		home,
		requiredString(configPath, record, "botTokenFile", "channels.discord.botTokenFile"),
	);
	const applicationId = snowflake("applicationId");
	const guildIds = snowflakes("guildIds");
	const mentionFreeChannels = snowflakes("mentionFreeChannels");
	const laneChannelId = record.laneChannelId === undefined ? undefined : snowflake("laneChannelId");
	const logChannelId = record.logChannelId === undefined ? undefined : snowflake("logChannelId");
	const escalationChannelId = record.escalationChannelId === undefined ? undefined : snowflake("escalationChannelId");
	const alertChannelId = record.alertChannelId === undefined ? undefined : snowflake("alertChannelId");
	// Inbound in the log channel is dropped, so it cannot also be where cards are answered, lanes open, chats run or
	// alerts are answered.
	if (
		logChannelId !== undefined &&
		(logChannelId === escalationChannelId ||
			logChannelId === alertChannelId ||
			logChannelId === laneChannelId ||
			mentionFreeChannels?.includes(logChannelId) === true)
	) {
		invalid(configPath, "channels.discord.logChannelId");
	}
	const requireMention = record.requireMention;
	if (requireMention !== undefined && typeof requireMention !== "boolean")
		invalid(configPath, "channels.discord.requireMention");
	const displayName = record.displayName;
	if (
		displayName !== undefined &&
		(typeof displayName !== "string" || displayName.length < 1 || displayName.length > 32)
	) {
		invalid(configPath, "channels.discord.displayName");
	}
	const peerBotsRaw = record.peerBots;
	let peerBots: Array<{ userId: string; name: string }> | undefined;
	if (peerBotsRaw !== undefined) {
		if (!Array.isArray(peerBotsRaw)) invalid(configPath, "channels.discord.peerBots");
		peerBots = peerBotsRaw.map((entry, i) => {
			const peer = asRecord(entry);
			const field = `channels.discord.peerBots.${i}`;
			// The owner is never a peer: a peer message carries no owner authority, so listing the owner would only shadow it.
			if (
				peer === undefined ||
				typeof peer.userId !== "string" ||
				!SNOWFLAKE.test(peer.userId) ||
				peer.userId === ownerUserId
			) {
				invalid(configPath, `${field}.userId`);
			}
			if (typeof peer.name !== "string" || peer.name.length < 1 || peer.name.length > 32) {
				invalid(configPath, `${field}.name`);
			}
			for (const key of Object.keys(peer))
				if (key !== "userId" && key !== "name") invalid(configPath, `${field}.${key}`);
			return { userId: peer.userId, name: peer.name };
		});
	}
	return {
		ownerUserId,
		botTokenFile,
		applicationId,
		...(guildIds === undefined ? {} : { guildIds }),
		...(mentionFreeChannels === undefined ? {} : { mentionFreeChannels }),
		...(requireMention === undefined ? {} : { requireMention }),
		...(laneChannelId === undefined ? {} : { laneChannelId }),
		...(logChannelId === undefined ? {} : { logChannelId }),
		...(escalationChannelId === undefined ? {} : { escalationChannelId }),
		...(alertChannelId === undefined ? {} : { alertChannelId }),
		...(displayName === undefined ? {} : { displayName }),
		...(peerBots === undefined ? {} : { peerBots }),
	};
}

/**
 * The realpath of `path`, or of its deepest existing ancestor with the missing rest appended (it may not exist yet).
 * `undefined` when a symlink loop (ELOOP) makes it unresolvable: such a path can never be created or used.
 */
function realOrPending(path: string): string | undefined {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") return undefined;
		const parent = dirname(absolute);
		if (parent === absolute) return absolute;
		const resolved = realOrPending(parent);
		return resolved === undefined ? undefined : join(resolved, basename(absolute));
	}
}

/** Whether `child` is `parent` or lies below it (both already resolved). */
function within(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Whether `workspaceDir` is the home, `config.json` or `secrets/` (or inside one), or holds the home or `secrets/`
 * below it, compared by realpath (qa-j #6/#1: a symlinked workspace or an ancestor of the home): the workspace root
 * would then hold the config or the token files (a procedure file under it could be a secret), or `mkdir` would
 * collide with config.json.
 */
export function workspaceOverlapsHome(homeDir: string, workspaceDir: string): boolean {
	const workspace = realOrPending(workspaceDir);
	const home = realOrPending(homeDir);
	const secrets = realOrPending(join(homeDir, "secrets"));
	const configFile = realOrPending(join(homeDir, "config.json"));
	// A symlink loop leaves nothing to compare (qa-l #3): the workspace cannot be created, so refuse it like an overlap.
	if (workspace === undefined || home === undefined || secrets === undefined || configFile === undefined) return true;
	return (
		within(workspace, home) || within(workspace, secrets) || within(configFile, workspace) || within(secrets, workspace)
	);
}

/** Why `overlay` cannot be handed to omp as `--config`: not a regular file or not readable (qa-l #1/#2), else undefined. */
function overlayProblem(overlay: string): string | undefined {
	try {
		if (!statSync(overlay).isFile()) return "not a file";
		// A procfs "regular file" like /proc/self/mem stats as a file but fails to read.
		const fd = openSync(overlay, "r");
		try {
			readSync(fd, Buffer.alloc(1), 0, 1, 0);
		} finally {
			closeSync(fd);
		}
		return undefined;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? "not a file" : `unreadable (${code ?? "error"})`;
	}
}

function checkHome(homeDir: string): void {
	let mode: number;
	try {
		const stat = statSync(homeDir);
		if (!stat.isDirectory()) throw new ConfigError("home_missing", homeDir, "not a directory");
		mode = stat.mode;
	} catch (error) {
		if (error instanceof ConfigError) throw error;
		throw new ConfigError("home_missing", homeDir);
	}
	if ((mode & 0o777) !== HOME_MODE) {
		throw new ConfigError("home_permissions", homeDir, `mode=${modeString(mode)} expected=${modeString(HOME_MODE)}`);
	}
}

/** A 0600 secret file's trimmed content (`secret_missing` / `secret_permissions` otherwise). */
function readSecretFile(path: string): string {
	let mode: number;
	try {
		const stat = statSync(path);
		// A FIFO or device in the file's place would block the read below for good.
		if (!stat.isFile()) throw new ConfigError("secret_missing", path, "not a regular file");
		mode = stat.mode;
	} catch (error) {
		if (error instanceof ConfigError) throw error;
		throw new ConfigError("secret_missing", path);
	}
	if ((mode & 0o777) !== SECRET_MODE) {
		throw new ConfigError("secret_permissions", path, `mode=${modeString(mode)} expected=${modeString(SECRET_MODE)}`);
	}
	let value: string;
	try {
		value = readFileSync(path, "utf8").trim();
	} catch {
		throw new ConfigError("secret_missing", path);
	}
	return value;
}

/**
 * Reads the Discord bot token file again (permission check included). Discord tokens carry no fixed prefix, so the
 * only shape check is one non-empty line; a wrong token shows up as gateway close 4004.
 */
export function readDiscordToken(config: OmpbotConfig): string {
	const discord = config.channels.discord;
	if (discord === undefined) throw new Error("channels.discord is not configured");
	const value = readSecretFile(discord.botTokenFile);
	if (value === "" || /[\r\n]/.test(value)) {
		throw new ConfigError("config_invalid", discord.botTokenFile, "field=channels.discord.botTokenFile");
	}
	return value;
}

/** A repository entry must be a git work tree with a commit now: a wrong path would otherwise fail mid-turn, long after startup. */
function requireGitRepo(configPath: string, repo: string, field: string): void {
	let workTree = false;
	try {
		workTree = statSync(join(repo, ".git")).isDirectory() || statSync(join(repo, ".git")).isFile();
	} catch {
		workTree = false;
	}
	if (!workTree) invalid(configPath, field);
	// A repo without a commit never yields a snapshot (qa-l #19): require HEAD to resolve.
	if (spawnSync("git", ["-C", repo, "rev-parse", "--verify", "-q", "HEAD"], { stdio: "ignore" }).status !== 0) {
		invalid(configPath, field);
	}
}

/**
 * Loads and validates `<homeDir>/config.json`. Credential-file and workspace paths resolve against the config dir.
 * `checkTokens: false` skips reading the token files — for processes that never talk to a chat platform (`ompbot dashboard`).
 */
/** A CLI's zone: the home's `config.timezone`, or the zone a config without the key gets when there is no usable one. */
export function timezoneOfHome(homeDir: string): string {
	try {
		return loadConfig(homeDir, { checkTokens: false }).timezone;
	} catch {
		return hostTimezone();
	}
}

export function loadConfig(homeDir: string = defaultHomeDir(), options: { checkTokens?: boolean } = {}): OmpbotConfig {
	const home = resolve(homeDir);
	checkHome(home);

	const configPath = join(home, "config.json");
	let raw: string;
	try {
		// A FIFO or device would block this synchronous read (the daemon's event loop on a reload) for good.
		const kind = statSync(configPath);
		if (!kind.isFile() && !kind.isDirectory()) {
			throw Object.assign(new Error("not a regular file"), { code: "ENOTREG" });
		}
		raw = readFileSync(configPath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new ConfigError("config_missing", configPath);
		throw new ConfigError("config_unreadable", configPath, code ?? "read failed");
	}
	let parsed: unknown;
	try {
		// A Windows editor may save a byte-order mark first; JSON.parse refuses it as an unnamed token.
		parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
	} catch (error) {
		// The parser names what it expected but not where; the usual culprits are named so the file can be scanned.
		// Quoted text in its message can be file content (a token pasted into the wrong place), so it is masked.
		const reason = (error instanceof Error ? error.message : String(error)).replace(/(["'])[^"']{2,}\1/g, "…");
		throw new ConfigError(
			"config_invalid_json",
			configPath,
			`${reason}; look for a trailing comma, a missing comma between keys, or unquoted keys`,
		);
	}

	const root = asRecord(parsed);
	if (!root) invalid(configPath, "<root>");
	if (root.schemaVersion !== 1) invalid(configPath, "schemaVersion");
	const warnings: ConfigWarning[] = [];
	for (const key of Object.keys(root)) if (!ROOT_KEYS.has(key)) warnings.push({ field: key, reason: "unknown_key" });

	const ompExecutable = requiredString(configPath, root, "ompExecutable");
	if (!isAbsolute(ompExecutable)) invalid(configPath, "ompExecutable");
	const workspaceDir = resolve(home, requiredString(configPath, root, "workspaceDir"));
	if (workspaceOverlapsHome(home, workspaceDir)) invalid(configPath, "workspaceDir");
	const ompProfile = optionalString(configPath, root, "ompProfile");
	if (ompProfile !== undefined && !OMP_PROFILE_PATTERN.test(ompProfile)) invalid(configPath, "ompProfile");
	const overlayValue = optionalString(configPath, root, "ompConfigOverlay");
	const ompConfigOverlay = overlayValue === undefined ? undefined : resolve(home, overlayValue);
	if (ompConfigOverlay !== undefined) {
		const problem = overlayProblem(ompConfigOverlay);
		if (problem !== undefined)
			throw new ConfigError("config_invalid", ompConfigOverlay, `field=ompConfigOverlay ${problem}`);
	}

	const agent = root.agent;
	if (agent !== undefined && agent !== "omp" && agent !== "agy") {
		throw new ConfigError("config_invalid", configPath, "field=agent (omp·agy만; claude 에이전트는 제거됨)");
	}
	const agyExecutable = optionalString(configPath, root, "agyExecutable");
	if (agyExecutable !== undefined && !isAbsolute(agyExecutable)) invalid(configPath, "agyExecutable");

	const timezoneRaw = optionalString(configPath, root, "timezone");
	if (timezoneRaw !== undefined && !isTimezone(timezoneRaw)) invalid(configPath, "timezone");

	const sessionRetentionDays = optionalInt(configPath, root, "sessionRetentionDays", 1);
	const maxBundleBytes = optionalInt(configPath, root, "maxBundleBytes", 1);
	const idleTimeoutMinutes = optionalInt(configPath, root, "idleTimeoutMinutes", 0);
	const idleKeepResident = root.idleKeepResident;
	if (idleKeepResident !== undefined && typeof idleKeepResident !== "boolean") invalid(configPath, "idleKeepResident");
	const skillReviewTurns = optionalInt(configPath, root, "skillReviewTurns", 0);
	const ownerSilenceFallbackMinutes = optionalInt(configPath, root, "ownerSilenceFallbackMinutes", 0);
	const hostSessionCeiling = optionalInt(configPath, root, "hostSessionCeiling", 0);

	const channels = parseChannels(configPath, root, home);

	const costCap = root.costCap;
	if (costCap !== undefined) {
		const record = asRecord(costCap);
		if (record === undefined) invalid(configPath, "costCap");
		for (const key of Object.keys(record)) {
			if (key !== "turnUsd" && key !== "dailyUsd") invalid(configPath, `costCap.${key}`);
			const value = record[key];
			if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
				invalid(configPath, `costCap.${key}`);
			}
		}
	}

	const lanes = root.lanes;
	const keptLanes: Record<string, unknown> = {};
	if (lanes !== undefined) {
		const record = asRecord(lanes);
		if (record === undefined) invalid(configPath, "lanes");
		for (const key of Object.keys(record)) {
			const value = record[key];
			if (key === "completionNudges") {
				// Removed (lanes no longer get automatic nudges): an old file still loads, the setting does nothing.
				warnings.push({ field: `lanes.${key}`, reason: "config_key_ignored" });
				continue;
			}
			if (key === "models") checkLaneModels(configPath, value);
			else if (key !== "land") invalid(configPath, `lanes.${key}`);
			keptLanes[key] = key === "land" ? laneLandOf(configPath, value) : value;
		}
	}

	const peerHopLimit = root.peerHopLimit;
	if (peerHopLimit !== undefined) {
		const record = asRecord(peerHopLimit);
		if (record === undefined) invalid(configPath, "peerHopLimit");
		for (const key of ["turns", "windowMinutes"]) {
			const value = record[key];
			if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(configPath, `peerHopLimit.${key}`);
		}
		for (const key of Object.keys(record)) {
			if (key !== "turns" && key !== "windowMinutes") invalid(configPath, `peerHopLimit.${key}`);
		}
	}
	let peerSilenceAlert: { minutes: number } | undefined;
	if (root.peerSilenceAlert !== undefined) {
		const record = asRecord(root.peerSilenceAlert);
		if (record === undefined) invalid(configPath, "peerSilenceAlert");
		for (const key of Object.keys(record)) {
			if (key !== "minutes") invalid(configPath, `peerSilenceAlert.${key}`);
		}
		const minutes = record.minutes;
		if (
			typeof minutes !== "number" ||
			!Number.isInteger(minutes) ||
			minutes < 0 ||
			minutes > PEER_SILENCE_MAX_MINUTES
		) {
			invalid(configPath, "peerSilenceAlert.minutes");
		}
		peerSilenceAlert = { minutes };
	}

	const dispatchHosts = dispatchHostsOf(configPath, root.dispatchHosts, warnings);
	checkLaneLandRemotes(configPath, keptLanes.land as Record<string, LaneLandRepoConfig> | undefined, dispatchHosts);
	if (root.recordsRepo !== undefined && !isRecordsPath(root.recordsRepo)) invalid(configPath, "recordsRepo");
	const workerOmpArgs = optionalArgList(configPath, root, "workerOmpArgs");
	const workerAgy = workerAgyOf(configPath, root.workerAgy);
	const agyMcpServers = agyMcpServersOf(configPath, root.agyMcpServers);

	const offsiteRaw = root.offsite;
	let offsite: OmpbotConfig["offsite"];
	if (offsiteRaw !== undefined) {
		const record = asRecord(offsiteRaw);
		if (record === undefined || typeof record.ssh !== "string" || !OFFSITE_SSH.test(record.ssh)) {
			invalid(configPath, "offsite.ssh");
		}
		if (
			typeof record?.remoteDir !== "string" ||
			!OFFSITE_DIR.test(record.remoteDir) ||
			record.remoteDir.split("/").some((part) => part === "..")
		) {
			invalid(configPath, "offsite.remoteDir");
		}
		// `~//x` would make scp's path absolute and `//` leave no directory: repeated slashes collapse here, and a
		// value that is only slashes still loads (it always did) but is flagged, and the off-site run refuses it.
		const remoteDir = (record.remoteDir as string).replace(/\/{2,}/g, "/");
		if (!isOffsiteDir(remoteDir)) warnings.push({ field: "offsite.remoteDir", reason: "unusable" });
		if (record?.keep !== undefined && (!Number.isSafeInteger(record.keep) || (record.keep as number) < 1)) {
			invalid(configPath, "offsite.keep");
		}
		for (const key of Object.keys(record ?? {})) {
			if (key !== "ssh" && key !== "remoteDir" && key !== "keep") invalid(configPath, `offsite.${key}`);
		}
		offsite = {
			ssh: record?.ssh as string,
			remoteDir,
			...(record?.keep === undefined ? {} : { keep: record.keep as number }),
		};
	}

	const herdrBoard = root.herdrBoard;
	if (herdrBoard !== undefined) {
		const record = asRecord(herdrBoard);
		if (record === undefined || typeof record.url !== "string" || !/^https?:\/\/\S+$/.test(record.url)) {
			invalid(configPath, "herdrBoard.url");
		}
		if (record?.api !== undefined && (typeof record.api !== "string" || !/^https?:\/\/\S+$/.test(record.api))) {
			invalid(configPath, "herdrBoard.api");
		}
		for (const key of Object.keys(record ?? {})) {
			if (key !== "url" && key !== "api") invalid(configPath, `herdrBoard.${key}`);
		}
	}

	let taskAutoLand: OmpbotConfig["taskAutoLand"];
	if (root.taskAutoLand !== undefined) {
		const record = asRecord(root.taskAutoLand);
		if (record === undefined) invalid(configPath, "taskAutoLand");
		const repos = record.repos;
		if (!Array.isArray(repos) || repos.length === 0) invalid(configPath, "taskAutoLand.repos");
		repos.forEach((repo, i) => {
			if (typeof repo !== "string" || !isAbsolute(repo)) invalid(configPath, `taskAutoLand.repos.${i}`);
		});
		const maxRisk = record.maxRisk;
		if (maxRisk !== undefined && !(TASK_RISKS as readonly unknown[]).includes(maxRisk)) {
			invalid(configPath, "taskAutoLand.maxRisk");
		}
		for (const key of Object.keys(record)) {
			if (key !== "repos" && key !== "maxRisk" && key !== "review" && key !== "qa" && key !== "commitEmails") {
				invalid(configPath, `taskAutoLand.${key}`);
			}
		}
		let commitEmails: Record<string, string[]> | undefined;
		if (record.commitEmails !== undefined) {
			const emailsRecord = asRecord(record.commitEmails);
			if (emailsRecord === undefined) invalid(configPath, "taskAutoLand.commitEmails");
			commitEmails = {};
			for (const [repo, emails] of Object.entries(emailsRecord)) {
				// A repository key is an absolute path (a wrong one would silently never match a lane's repository).
				if (!isAbsolute(repo)) invalid(configPath, `taskAutoLand.commitEmails.${repo}`);
				if (!Array.isArray(emails) || emails.length === 0) {
					invalid(configPath, `taskAutoLand.commitEmails.${repo}`);
				}
				const list = emails as unknown[];
				list.forEach((email, i) => {
					if (typeof email !== "string" || !EMAIL_SHAPE.test(email.trim())) {
						invalid(configPath, `taskAutoLand.commitEmails.${repo}.${i}`);
					}
				});
				commitEmails[repo.replace(/(?<=.)\/+$/, "")] = (list as string[]).map((email) => email.trim());
			}
		}
		let qa: NonNullable<OmpbotConfig["taskAutoLand"]>["qa"];
		if (record.qa !== undefined) {
			const qaRecord = asRecord(record.qa);
			if (qaRecord === undefined) invalid(configPath, "taskAutoLand.qa");
			for (const key of Object.keys(qaRecord)) {
				if (key !== "minRisk" && key !== "overlay" && key !== "model" && key !== "timeoutMs") {
					invalid(configPath, `taskAutoLand.qa.${key}`);
				}
			}
			const minRisk = qaRecord.minRisk;
			if (minRisk !== undefined && !(TASK_RISKS as readonly unknown[]).includes(minRisk)) {
				invalid(configPath, "taskAutoLand.qa.minRisk");
			}
			const overlay = qaRecord.overlay;
			if (typeof overlay !== "string" || !isAbsolute(overlay)) invalid(configPath, "taskAutoLand.qa.overlay");
			const overlayIssue = overlayProblem(overlay);
			if (overlayIssue !== undefined) {
				throw new ConfigError("config_invalid", overlay, `field=taskAutoLand.qa.overlay ${overlayIssue}`);
			}
			const model = qaRecord.model;
			// Like the reviewer: `cursor` is a discovery provider the isolation overlay disables.
			if (typeof model !== "string" || model.trim() === "" || model.trim().startsWith("cursor/")) {
				invalid(configPath, "taskAutoLand.qa.model");
			}
			const timeoutMs = gateTimeoutMs(configPath, qaRecord.timeoutMs, "taskAutoLand.qa.timeoutMs");
			qa = {
				overlay,
				model,
				...(minRisk === undefined ? {} : { minRisk: minRisk as TaskRisk }),
				...(timeoutMs === undefined ? {} : { timeoutMs }),
			};
		}
		let review: NonNullable<OmpbotConfig["taskAutoLand"]>["review"];
		if (record.review !== undefined) {
			const reviewRecord = asRecord(record.review);
			if (reviewRecord === undefined) invalid(configPath, "taskAutoLand.review");
			const model = reviewRecord.model;
			// `cursor` is in the reviewer's disabledProviders overlay (its discovery), which also disables that model provider.
			if (typeof model !== "string" || model.trim() === "" || model.trim().startsWith("cursor/")) {
				invalid(configPath, "taskAutoLand.review.model");
			}
			const timeoutMs = gateTimeoutMs(configPath, reviewRecord.timeoutMs, "taskAutoLand.review.timeoutMs");
			for (const key of Object.keys(reviewRecord)) {
				if (key !== "model" && key !== "timeoutMs" && key !== "confident") {
					invalid(configPath, `taskAutoLand.review.${key}`);
				}
			}
			let confident: LaneReviewConfident | undefined;
			if (reviewRecord.confident !== undefined) {
				const confidentRecord = asRecord(reviewRecord.confident);
				if (confidentRecord === undefined) invalid(configPath, "taskAutoLand.review.confident");
				const confidentRisk = confidentRecord.maxRisk;
				// The band starts above `maxRisk`: at or below it the lane already merges on a plain CLEAR.
				if (
					!(TASK_RISKS as readonly unknown[]).includes(confidentRisk) ||
					TASK_RISKS.indexOf(confidentRisk as TaskRisk) <= TASK_RISKS.indexOf((maxRisk ?? "L2") as TaskRisk)
				) {
					invalid(configPath, "taskAutoLand.review.confident.maxRisk");
				}
				const minConfidence = confidentRecord.minConfidence;
				if (
					typeof minConfidence !== "number" ||
					!Number.isFinite(minConfidence) ||
					minConfidence <= 0 ||
					minConfidence > 1
				) {
					invalid(configPath, "taskAutoLand.review.confident.minConfidence");
				}
				for (const key of Object.keys(confidentRecord)) {
					if (key !== "maxRisk" && key !== "minConfidence") invalid(configPath, `taskAutoLand.review.confident.${key}`);
				}
				confident = { maxRisk: confidentRisk as TaskRisk, minConfidence };
			}
			review = {
				model,
				...(timeoutMs === undefined ? {} : { timeoutMs }),
				...(confident === undefined ? {} : { confident }),
			};
		}
		taskAutoLand = {
			repos: (repos as string[]).map((repo) => repo.replace(/(?<=.)\/+$/, "")),
			...(maxRisk === undefined ? {} : { maxRisk: maxRisk as TaskRisk }),
			...(review === undefined ? {} : { review }),
			...(qa === undefined ? {} : { qa }),
			...(commitEmails === undefined ? {} : { commitEmails }),
		};
	}

	const herdrRaw = root.herdr;
	let herdr: OmpbotConfig["herdr"];
	if (herdrRaw !== undefined) {
		const record = asRecord(herdrRaw);
		if (record === undefined) invalid(configPath, "herdr");
		for (const key of Object.keys(record)) if (key !== "bin") invalid(configPath, `herdr.${key}`);
		const bin = optionalString(configPath, record, "bin", "herdr.bin");
		if (bin !== undefined && !isAbsolute(bin)) invalid(configPath, "herdr.bin");
		herdr = bin === undefined ? {} : { bin };
	} else if (dispatchHosts !== undefined || herdrBoard !== undefined) {
		// Both are herdr features: without the switch they would be silently dead, so refuse the file instead.
		// `taskAutoLand` is not one of them: work lanes land without herdr.
		invalid(configPath, "herdr");
	}

	const restartNotice = root.restartNotice;
	if (restartNotice !== undefined && typeof restartNotice !== "boolean") invalid(configPath, "restartNotice");
	const recallEnabled = root.recallEnabled;
	if (recallEnabled !== undefined && typeof recallEnabled !== "boolean") invalid(configPath, "recallEnabled");
	const watcherRoots = root.watcherRoots;
	if (
		watcherRoots !== undefined &&
		(!Array.isArray(watcherRoots) || watcherRoots.some((r) => typeof r !== "string" || !isAbsolute(r)))
	) {
		invalid(configPath, "watcherRoots");
	}

	const turnSnapshotRaw = root.turnSnapshot;
	let turnSnapshot: { repos: string[] } | undefined;
	if (turnSnapshotRaw !== undefined) {
		const record = asRecord(turnSnapshotRaw);
		if (record === undefined) invalid(configPath, "turnSnapshot");
		const repos = record.repos;
		if (
			repos !== undefined &&
			(!Array.isArray(repos) || repos.some((repo) => typeof repo !== "string" || !isAbsolute(repo)))
		) {
			invalid(configPath, "turnSnapshot.repos");
		}
		for (const key of Object.keys(record)) if (key !== "repos") invalid(configPath, `turnSnapshot.${key}`);
		for (const repo of (repos as string[] | undefined) ?? []) requireGitRepo(configPath, repo, "turnSnapshot.repos");
		turnSnapshot = { repos: (repos as string[] | undefined) ?? [] };
	}

	const wikiNotesRaw = root.wikiNotes;
	let wikiNotes: { client: string; agentDir?: string; repos?: string[] } | undefined;
	if (wikiNotesRaw !== undefined) {
		const record = asRecord(wikiNotesRaw);
		if (record === undefined) invalid(configPath, "wikiNotes");
		for (const key of Object.keys(record)) {
			if (key !== "client" && key !== "agentDir" && key !== "repos") invalid(configPath, `wikiNotes.${key}`);
		}
		const { client, agentDir, repos } = record;
		if (typeof client !== "string" || client.trim() === "" || /\p{Cc}/u.test(client)) {
			invalid(configPath, "wikiNotes.client");
		}
		if (
			agentDir !== undefined &&
			(typeof agentDir !== "string" || agentDir.trim() === "" || /\p{Cc}/u.test(agentDir))
		) {
			invalid(configPath, "wikiNotes.agentDir");
		}
		if (
			repos !== undefined &&
			(!Array.isArray(repos) ||
				repos.some((repo) => typeof repo !== "string" || repo.trim() === "" || /\p{Cc}/u.test(repo)))
		) {
			invalid(configPath, "wikiNotes.repos");
		}
		// Only `~` and `~/…` mean this user's home; `~other/x` must not be re-read as a directory under it.
		const home = (path: string, field: string): string => {
			if (path === "~" || path.startsWith("~/")) return resolve(join(homedir(), path.slice(1)));
			// A relative path would be read against the daemon's cwd, which is not the bot's home.
			if (path.startsWith("~") || !isAbsolute(path)) invalid(configPath, `wikiNotes.${field}`);
			return resolve(path);
		};
		wikiNotes = { client: home(client as string, "client") };
		if (agentDir !== undefined) wikiNotes.agentDir = home(agentDir as string, "agentDir");
		if (repos !== undefined) {
			wikiNotes.repos = (repos as string[]).map((repo) => home(repo, "repos"));
			for (const repo of wikiNotes.repos) requireGitRepo(configPath, repo, "wikiNotes.repos");
		}
	}

	const briefingRaw = root.briefing;
	let briefing: { chromium?: string } | undefined;
	if (briefingRaw !== undefined) {
		const record = asRecord(briefingRaw);
		if (record === undefined) invalid(configPath, "briefing");
		for (const key of Object.keys(record)) if (key !== "chromium") invalid(configPath, `briefing.${key}`);
		const chromium = optionalString(configPath, record, "chromium", "briefing.chromium");
		briefing = chromium === undefined ? {} : { chromium };
	}

	const applyRaw = root.apply;
	let apply: NonNullable<OmpbotConfig["apply"]> | undefined;
	if (applyRaw !== undefined) {
		const record = asRecord(applyRaw);
		if (record === undefined) invalid(configPath, "apply");
		for (const key of Object.keys(record)) if (key !== "codeRollback") invalid(configPath, `apply.${key}`);
		const mode = record.codeRollback;
		if (mode !== undefined && !CODE_ROLLBACK_MODES.some((known) => known === mode)) {
			invalid(configPath, "apply.codeRollback");
		}
		apply = mode === undefined ? {} : { codeRollback: mode as CodeRollbackMode };
	}

	const webhook = root.webhook;
	if (webhook !== undefined) {
		const record = asRecord(webhook);
		if (record === undefined) invalid(configPath, "webhook");
		if (!Number.isInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65535) {
			invalid(configPath, "webhook.port");
		}
		if (record.bind !== undefined && record.bind !== "127.0.0.1" && record.bind !== "::1") {
			invalid(configPath, "webhook.bind");
		}
		for (const key of Object.keys(record)) if (key !== "port" && key !== "bind") invalid(configPath, `webhook.${key}`);
	}

	const dashboard = root.dashboard;
	if (dashboard !== undefined) {
		const record = asRecord(dashboard);
		if (record === undefined) invalid(configPath, "dashboard");
		if (!Number.isInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65535) {
			invalid(configPath, "dashboard.port");
		}
		if (record.bind !== undefined && record.bind !== "127.0.0.1" && record.bind !== "::1") {
			invalid(configPath, "dashboard.bind");
		}
		if (
			record.herdrWebUrl !== undefined &&
			(typeof record.herdrWebUrl !== "string" || !/^https?:\/\/\S+$/.test(record.herdrWebUrl))
		) {
			invalid(configPath, "dashboard.herdrWebUrl");
		}
		if (record.allowedHosts !== undefined && !validAllowedHosts(record.allowedHosts)) {
			invalid(configPath, "dashboard.allowedHosts");
		}
		if (record.opsStatus !== undefined) {
			const ops = asRecord(record.opsStatus);
			if (ops === undefined) invalid(configPath, "dashboard.opsStatus");
			if (
				!Array.isArray(ops.command) ||
				ops.command.length === 0 ||
				!ops.command.every((part) => typeof part === "string" && part !== "")
			) {
				invalid(configPath, "dashboard.opsStatus.command");
			}
			if (ops.url !== undefined && (typeof ops.url !== "string" || !/^https?:\/\/\S+$/.test(ops.url))) {
				invalid(configPath, "dashboard.opsStatus.url");
			}
			for (const key of Object.keys(ops)) {
				if (key !== "command" && key !== "url") invalid(configPath, `dashboard.opsStatus.${key}`);
			}
		}
		if (record.usageLimits !== undefined) {
			const limits = asRecord(record.usageLimits);
			if (limits === undefined) invalid(configPath, "dashboard.usageLimits");
			const argvOk = (value: unknown): boolean =>
				Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part !== "");
			if (limits.omp !== undefined && !(Array.isArray(limits.omp) && limits.omp.every(argvOk))) {
				invalid(configPath, "dashboard.usageLimits.omp");
			}
			if (limits.agy !== undefined && !argvOk(limits.agy)) invalid(configPath, "dashboard.usageLimits.agy");
			if (limits.agyAccount !== undefined && !argvOk(limits.agyAccount)) {
				invalid(configPath, "dashboard.usageLimits.agyAccount");
			}
			for (const key of Object.keys(limits)) {
				if (key !== "omp" && key !== "agy" && key !== "agyAccount") invalid(configPath, `dashboard.usageLimits.${key}`);
			}
		}
		if (record.peerHomes !== undefined) {
			if (!Array.isArray(record.peerHomes)) invalid(configPath, "dashboard.peerHomes");
			const names = new Set<string>();
			record.peerHomes.forEach((entry: unknown, i: number) => {
				const peer = asRecord(entry);
				if (peer === undefined) invalid(configPath, `dashboard.peerHomes.${i}`);
				for (const key of Object.keys(peer)) {
					if (key !== "name" && key !== "home") invalid(configPath, `dashboard.peerHomes.${i}.${key}`);
				}
				const { name, home } = peer;
				if (typeof name !== "string" || name === "" || name.length > 20 || /[:\s]/.test(name) || names.has(name)) {
					invalid(configPath, `dashboard.peerHomes.${i}.name`);
				}
				names.add(name);
				if (typeof home !== "string" || !isAbsolute(home)) invalid(configPath, `dashboard.peerHomes.${i}.home`);
			});
		}
		const dashboardKeys = ["port", "bind", "herdrWebUrl", "allowedHosts", "opsStatus", "usageLimits", "peerHomes"];
		for (const key of Object.keys(record)) if (!dashboardKeys.includes(key)) invalid(configPath, `dashboard.${key}`);
	}

	// One address, one listener: a second bind on it fails at start (the daemon logs it and runs on without one).
	const listeners: Array<[string, string, number]> = [];
	const addressOf = (host: string): string => (host === "localhost" ? "127.0.0.1" : host);
	for (const [name, block] of [
		["webhook", webhook],
		["dashboard", dashboard],
	] as const) {
		const record = asRecord(block);
		if (record === undefined) continue;
		const address = addressOf((record.bind as string | undefined) ?? "127.0.0.1");
		const taken = listeners.some(([, host, port]) => host === address && port === record.port);
		if (taken) invalid(configPath, `${name}.port`);
		listeners.push([`${name}.port`, address, record.port as number]);
	}

	const candidatesRaw = root.candidates;
	let candidates: NonNullable<OmpbotConfig["candidates"]> | undefined;
	if (candidatesRaw !== undefined) {
		const record = asRecord(candidatesRaw);
		if (record === undefined) invalid(configPath, "candidates");
		candidates = {};
		for (const key of Object.keys(record)) {
			const value = record[key];
			if (key === "enabled") {
				if (typeof value !== "boolean") invalid(configPath, "candidates.enabled");
				candidates.enabled = value;
			} else if (key === "mode") {
				if (value !== "log" && value !== "card") invalid(configPath, "candidates.mode");
				candidates.mode = value;
			} else if (key === "minDays" || key === "windowDays" || key === "maxOpenCards" || key === "snoozeDays") {
				if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
					invalid(configPath, `candidates.${key}`);
				candidates[key] = value;
			} else {
				invalid(configPath, `candidates.${key}`);
			}
		}
	}

	const config: OmpbotConfig = {
		schemaVersion: 1,
		homeDir: home,
		configPath,
		channels,
		ompExecutable,
		workspaceDir,
		timezone: timezoneRaw ?? hostTimezone(),
	};
	if (warnings.length > 0) config.warnings = warnings;
	const model = optionalString(configPath, root, "model");
	const thinking = optionalString(configPath, root, "thinking");
	if (model !== undefined) config.model = model;
	if (thinking !== undefined) config.thinking = thinking;
	if (agent !== undefined) config.agent = agent;
	if (agyExecutable !== undefined) config.agyExecutable = agyExecutable;
	if (agyMcpServers !== undefined) config.agyMcpServers = agyMcpServers;
	if (ompProfile !== undefined) config.ompProfile = ompProfile;
	if (ompConfigOverlay !== undefined) config.ompConfigOverlay = ompConfigOverlay;
	if (sessionRetentionDays !== undefined) config.sessionRetentionDays = sessionRetentionDays;
	if (maxBundleBytes !== undefined) config.maxBundleBytes = maxBundleBytes;
	if (offsite !== undefined) config.offsite = offsite;
	if (idleTimeoutMinutes !== undefined) config.idleTimeoutMinutes = idleTimeoutMinutes;
	if (idleKeepResident !== undefined) config.idleKeepResident = idleKeepResident;
	if (skillReviewTurns !== undefined) config.skillReviewTurns = skillReviewTurns;
	if (ownerSilenceFallbackMinutes !== undefined) config.ownerSilenceFallbackMinutes = ownerSilenceFallbackMinutes;
	if (hostSessionCeiling !== undefined) config.hostSessionCeiling = hostSessionCeiling;
	if (peerHopLimit !== undefined) config.peerHopLimit = peerHopLimit as { turns: number; windowMinutes: number };
	if (peerSilenceAlert !== undefined) config.peerSilenceAlert = peerSilenceAlert;
	if (costCap !== undefined) {
		const { turnUsd, dailyUsd } = costCap as { turnUsd?: number; dailyUsd?: number };
		config.costCap = { ...(turnUsd === undefined ? {} : { turnUsd }), ...(dailyUsd === undefined ? {} : { dailyUsd }) };
	}
	if (restartNotice !== undefined) config.restartNotice = restartNotice;
	if (recallEnabled !== undefined) config.recallEnabled = recallEnabled;
	if (watcherRoots !== undefined) config.watcherRoots = (watcherRoots as string[]).map((r) => resolve(r));
	if (turnSnapshot !== undefined) config.turnSnapshot = { repos: turnSnapshot.repos.map((repo) => resolve(repo)) };
	if (wikiNotes !== undefined) config.wikiNotes = wikiNotes;
	if (briefing !== undefined) config.briefing = briefing;
	if (candidates !== undefined) config.candidates = candidates;
	if (apply !== undefined) config.apply = apply;
	if (webhook !== undefined) config.webhook = webhook as { port: number; bind?: "127.0.0.1" | "::1" };
	if (dashboard !== undefined) config.dashboard = dashboard as NonNullable<OmpbotConfig["dashboard"]>;
	if (herdr !== undefined) config.herdr = herdr;
	if (dispatchHosts !== undefined) config.dispatchHosts = dispatchHosts;
	if (workerOmpArgs !== undefined) config.workerOmpArgs = workerOmpArgs;
	if (workerAgy !== undefined) config.workerAgy = workerAgy;
	if (root.recordsRepo !== undefined) config.recordsRepo = root.recordsRepo as string;
	if (herdrBoard !== undefined) config.herdrBoard = herdrBoard as { url: string; api?: string };
	if (taskAutoLand !== undefined) config.taskAutoLand = taskAutoLand;
	if (lanes !== undefined) config.lanes = keptLanes as NonNullable<OmpbotConfig["lanes"]>;

	if (options.checkTokens !== false) {
		// Fail at startup on permissions/prefix/shape; values are discarded here.
		if (config.channels.discord !== undefined) readDiscordToken(config);
	}
	return config;
}
