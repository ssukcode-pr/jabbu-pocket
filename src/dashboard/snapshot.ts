import { Database } from "bun:sqlite";
import {
	closeSync,
	type Dirent,
	existsSync,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import type { JabbuConfig } from "../config";
import { parseChatOrigin } from "../core/origin-key";
import { readSweepHeartbeat } from "../daemon/heartbeat";
import { pidAlive } from "../daemon/lock";
import {
	type DrainCounts,
	type MonitorsStatus,
	type OpenGateSummary,
	readStatusFromDb,
	type StatusReport,
} from "../daemon/status";
import { boardCardLink } from "../dispatch/board";
import {
	type HerdrAgentStatus,
	herdrAgentStatus,
	herdrSshArgv,
	type ProcessRunner,
	type RunProcessResult,
} from "../dispatch/omp";
import { type FlowTransition, type TaskStage, taskFlowStatus, taskStage } from "../flow/task-flow";
import { heavyRunPaths, readHeavyRunStates } from "../heavy-run";
import { type MonitorRow, type MonitorSql, monitorOrigin, nextFireOf, toMonitor } from "../monitors/ledger";
import type { MonitorDeliver, MonitorOverlap, MonitorTrigger } from "../monitors/spec";
import { type AssistantTail, pendingToolCall, readLastAssistant, sessionPathOf } from "../omp/session-tail";
import { isRecord } from "../omp/type-guards";
import { parseSystemctlShow, parseUnixTimestamp, readLockStartedAt } from "../ops/apply";
import { readStamp } from "../ops/backup";
import type { FreezeState } from "../ops/freeze";
import { collectGates, type Gate, type GateState, type GatesOptions, gateOptionsFromConfig } from "../ops/gates";
import { OFFSITE_STAMP_FILE } from "../ops/offsite";
import { redact } from "../redact";
import { laneDurationSamples, TURN_SAMPLE_LIMIT, TURN_SAMPLE_WINDOW_MS } from "../store/lane-duration";
import { type TypicalDuration, typicalDuration } from "../store/turn-duration";
import type { TaskRisk } from "../tasks/docs";
import { evaluateTask } from "../tasks/evaluate";
import type { TaskHostOps } from "../tasks/host";
import { type ReadTask, readTaskSql, type TaskRow, type TaskSql, type TaskStatus } from "../tasks/ledger";
import { headlessStatusFromLedger } from "../tasks/runtime";
import { formatLocal, localIso } from "../time";
import { type BoardPromptRef, type BoardState, type BoardSummary, type BoardTaskRef, summarizeBoard } from "./board";
import { withContextLoad } from "./context-load";
import { type CostLedgerInfo, readCostLedger } from "./cost-ledger";
import { discordThreadHref } from "./detail";
import { type OverlapView, readEditOverlaps } from "./edit-overlap";
import { type HostChecksInfo, readHostChecks } from "./host-checks";
import type { PeerInstall } from "./peers";
import { previewLine } from "./preview-line";
import { createSessionModelReader } from "./session-model";
import { isStatusResponse, sharedFetch } from "./snapshot-fetch";
import { type TaskTurnFields, taskTurnFields } from "./turn";
import { buildTurnsSection, type PeerTurnError, rows, type ThreadInfo, type TurnInfo } from "./turn-board";
import { readUsageLimits, type UsageLimitsInfo } from "./usage-limits";

/** A snapshot is reused this long: IPC, herdr, ssh and git are not asked again inside it. */
export const SNAPSHOT_TTL_MS = 10_000;
/** A snapshot build still running after this is given up (answered as a failed snapshot). */
const SNAPSHOT_BUILD_TIMEOUT_MS = 30_000;
const IPC_TIMEOUT_MS = 10_000;
const HERDR_LOCAL_TIMEOUT_MS = 10_000;
const HERDR_SSH_TIMEOUT_MS = 15_000;
const TASK_EVAL_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 5_000;
const CLOSED_TASK_DAYS = 7;
const CLOSED_TASK_LIMIT = 20;
const ERROR_CHARS = 200;

/** Every section either carries its data or says why it could not; one failed section never breaks the others. */
export interface HeavyRunInfo {
	running: { label: string; ageMs: number } | null;
	/** Longest waiting first (`since` order; the real lock order is not guaranteed). */
	waiting: Array<{ label: string; waitedMs: number }>;
}

export type Section<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface DaemonInfo {
	/** True when the daemon answered over its socket; false = the numbers come from the database file. */
	running: boolean;
	ompVersion: string;
	origins: number;
	busy: number;
	ledger: StatusReport["ledger"];
	inbound: StatusReport["inbound"];
	monitors: MonitorsStatus;
	openGates: OpenGateSummary[];
	frozen?: FreezeState;
	drain?: DrainCounts;
	heartbeat?: {
		at: string;
		ageMs: number;
		loopMs?: number;
		/** Discord gateway; absent on an install without Discord. */
		discord?: { state: "up" | "down"; since: string };
		draining?: boolean;
	};
	/** `git rev-parse --short HEAD` of the checkout this process runs from; absent when git cannot tell. */
	commit?: string;
	/** When the running daemon took `jabbu.lock`; absent while it is down or the lock is unreadable. */
	started?: { at: string; ageMs: number };
	/** Running omp RPC sessions on this host and the ceiling a lane/[TASK] start is judged against (0 = off). */
	hostSessions?: StatusReport["hostSessions"];
}

export type { PeerTurnError, ThreadInfo, TurnInfo, TurnKind, TurnWaitReason } from "./turn-board";

type HerdrState = { ok: true; status: HerdrAgentStatus } | { ok: false; error: string };

export interface TaskInfo extends TaskTurnFields {
	taskId: string;
	title: string;
	risk: TaskRisk;
	status: TaskStatus;
	/** `local` = the bot's own machine, otherwise the `dispatchHosts` name. */
	host: string;
	agent: string;
	branch: string;
	open: boolean;
	updatedAt: string;
	closedAt?: string;
	acChecked?: number;
	acTotal: number;
	stepsDone?: number;
	stepsTotal?: number;
	progress?: { status: string; updated: string; current: string; blockedReason: string };
	/** Registered acceptance items with their spec.md checkbox; open TASKs whose documents were judged. */
	acceptance?: Array<{ id: string; text: string; checked: boolean }>;
	/** PROGRESS.md steps; open TASKs whose documents were judged. */
	steps?: Array<{ id: string; text: string; done: boolean }>;
	herdr?: HerdrState;
	/** herdr board card of the task's pane (the board root when the card cannot be resolved). */
	link?: string;
	overlap?: string; // the first 겹침 hint ({@link OverlapView}) of the TASK worker's session
	error?: string; // why the task documents could not be judged, and/or which JSON column of the row is damaged (`… 손상`)
	/** Registration to first review of past TASKs ({@link taskDurationSamples}); `working` TASKs with enough samples only. */
	typical?: TypicalDuration;
	elapsedMs?: number; // since registration; set together with `typical`
}

/** Threads in the flow view: a TASK registered in this window, or any open TASK. */
export const FLOW_WINDOW_MS = 7 * 86_400_000;
const FLOW_NOW_MSG_CHARS = 70;

/** One TASK box of a flow, built from the flow's own row (not cut to the snapshot's closed-TASK limit). */
export interface FlowStepInfo {
	taskId: string;
	title: string;
	status: TaskStatus;
	risk: TaskRisk;
	host: string;
	branch: string;
	createdAt: string;
	closedAt?: string;
	acTotal: number;
	stage: TaskStage;
	typical?: TypicalDuration; // as on {@link TaskInfo}: `working` TASKs with enough samples only
	elapsedMs?: number;
}

/** One request thread: its request line and its TASKs in registration order. */
export interface FlowChainInfo {
	threadRef: string;
	originKey: string;
	/** `DM`, `채널 <C> 스레드`, … of the origin key. */
	place: string | null;
	/** The thread's first inbound as one masked line, or `(원문 없음)`. */
	title: string;
	requestedAt: string | null;
	/** Newest TASK `updated_at`. */
	updatedAt: string;
	done: number;
	total: number;
	/** The TASK to look at next: the first blocked open one, else the earliest open one; null when all are closed. */
	here: string | null;
	now: string;
	tasks: FlowStepInfo[];
	/** The request thread on Discord ({@link discordThreadHref}); "" when it is not a Discord thread with a link. */
	discordHref: string;
}

export interface LaneInfo {
	name: string;
	/** The lane session's origin: a conversation of the turn board with this key is the lane's. */
	originKey: string;
	title: string;
	status: string;
	cwd: string;
	updatedAt: string;
	/** Inputs of the lane's session parked as `uncertain` (they may have been read): the owner decides with `/queue`. */
	uncertainCount: number;
	/** Open-to-close of past lanes ({@link laneDurationSamples}); `working` lanes with enough samples only. */
	typical?: TypicalDuration;
	/** Since the lane opened; set together with `typical`. */
	elapsedMs?: number;
	/** The file the latest milestone report named as evidence and its sha256 (the lane row's tooltip); absent when none. */
	evidence?: { file: string; sha256: string };
}

export interface HerdrAgentInfo {
	name: string;
	agent: string;
	agentStatus: string;
	cwd: string;
	paneId: string;
	terminalTitle: string;
	taskId?: string;
	/** The pane's omp session jsonl (`agent_session` kind `path`): local host only, absolute, `.jsonl`. */
	sessionPath?: string;
	question?: string;
	options?: string[];
	asks?: AskInfo[];
	blocked?: string;
	lastSay?: string;
	sayError?: string;
}

interface AskInfo {
	question: string;
	options: string[];
}

/**
 * What a local blocked/done omp pane last said, read from its session jsonl (masked): a blocked pane's pending `ask`
 * (`question`: the first question, ` 외 N개` with more; `options`: its choices; `asks`: every question), else why it
 * is blocked (`blocked`: 도구 실행 승인 대기 / 프로바이더 오류); a done pane's last answer, first sentence (`lastSay`).
 * `sayError`: the session file could not be read. Every field is optional: nothing found means nothing shown.
 */
export interface PaneSay {
	status: "blocked" | "done";
	question?: string;
	options?: string[];
	asks?: AskInfo[];
	blocked?: string;
	lastSay?: string;
	sayError?: string;
}

/** A {@link PaneSay} with its pane: the page merges it into the board card of the same host and pane. */
type HerdrSay = PaneSay & { host: string; paneId: string };

type HerdrHostInfo = { host: string } & Section<{ agents: HerdrAgentInfo[] }>;

export interface ApprovalInfo {
	approvalId: string;
	summary: string;
	createdAt: string;
	expiresAt: string;
	originKey: string | null;
	/** The asking conversation's ref (`<channel>:<thread>`); the Discord thread link is built from it. */
	originThreadRef: string | null;
	/** The summary's first sentence (of its first line), at most 80 characters. */
	title: string;
	/** The card's sections (할 일·이유·영향·되돌릴 수 없는 이유); null for rows without them or with a broken value. */
	detail: { action?: string; why?: string; impact?: string; rollback?: string } | null;
	/** `https://` permalinks of the card and of the asking thread; anything else is null. */
	cardUrl: string | null;
	originUrl: string | null;
	/** Until the card times out (counts as denied); never below 0. */
	remainingMs: number;
	/** `DM`, `채널 <C> 스레드`, `채널 <C> 메인` or the raw origin key. */
	originLabel: string | null;
}

type ApprovalOutcomeStatus = "approved" | "denied" | "expired" | "replied";

/** A settled approval, as the 최근 결정 list shows it; the fields it shares with {@link ApprovalInfo} read the same. */
export interface ApprovalDecision {
	approvalId: string;
	summary: string;
	title: string;
	status: ApprovalOutcomeStatus;
	createdAt: string;
	/** null on a row settled without a time. */
	decidedAt: string | null;
	/** Card up to its settling (`decided_at − created_at`, ≥ 0); null without `decidedAt`. */
	tookMs: number | null;
	originKey: string | null;
	originThreadRef: string | null;
	originLabel: string | null;
	detail: ApprovalInfo["detail"];
	cardUrl: string | null;
	originUrl: string | null;
}

/** Approvals settled in the last {@link APPROVAL_STATS_DAYS} days, by outcome. */
interface ApprovalStats {
	days: number;
	approved: number;
	denied: number;
	expired: number;
	replied: number;
	/** Median card-to-answer time of the owner's answers (approved, denied, replied); null without any. */
	medianAnswerMs: number | null;
}

/** One `ask` question the deadline answered, as the approvals view lists it. */
export interface AutoChoiceInfo {
	at: string;
	originKey: string | null;
	threadRef: string | null;
	question: string;
	chosen: string;
}

/** `ask` questions the deadline answered in the last {@link AUTO_CHOICE_DAYS} days (newest first, cut to {@link AUTO_CHOICE_LINES}). */
interface AutoChoices {
	days: number;
	items: AutoChoiceInfo[];
	/** How many of the last 24 hours, for the morning briefing line. */
	last24h: number;
}

/** A monitor's ended events of the last {@link MONITOR_STATS_DAYS} days, by outcome. */
interface MonitorStats {
	days: number;
	delivered: number;
	quiet: number;
	failed: number;
	skipped: number;
	/** Median slot-to-settle time (retry waits included) of the delivered and quiet scheduled runs; null without any. */
	medianMs: number | null;
}

/** A file a monitor uses, by name only (never its directory). */
interface MonitorFile {
	kind: "procedure" | "script";
	name: string;
}

/** One monitor event as the list shows its last run. */
interface MonitorRun {
	stage: string;
	at: string;
	slotAt: string;
	/** {@link monitorDurationMs}: slot to settle for an ended event; null while it runs. */
	durationMs: number | null;
	attempts: number;
	manual: boolean;
}

/** One enabled monitor. Of its instruction only {@link MonitorInfo.summary}; event answers and payloads never. */
export interface MonitorInfo {
	/** The detail key (`?item=`, `api/monitor/detail?id=`). */
	id: string;
	name: string;
	kind: string;
	/** When it fires in words (`매일 07:30`, `평일 09:00`, `한 번 · 11-07 09:30`, …); an odd cron stays `cron <expr>`. */
	schedule: string;
	/** A cron's expression and time zone (`30 7 * * * (Europe/Berlin)`); null for other triggers. */
	cron: string | null;
	/** The instruction's first sentence as one masked line of at most `PREVIEW_CHARS` chars. */
	summary: string;
	/** Where the answer goes: `오너 DM`, `로그 채널`, `에스컬레이션 채널` or `채널 <ID>`. */
	destination: string;
	/** Where the copy goes, named like `destination`; null without a copy channel. */
	copyTo: string | null;
	/** null = the default model. */
	model: string | null;
	thinking: string | null;
	deliver: MonitorDeliver;
	overlap: MonitorOverlap;
	/** Its procedure files and the scripts its instruction names, at most {@link MONITOR_FILES}. */
	files: MonitorFile[];
	nextFireAt: string | null;
	lastStage: string | null;
	lastAt: string | null;
	openIncidents: number;
	/** The last {@link MONITOR_RECENT} events, oldest first. */
	recent: Array<{ stage: string; manual: boolean; at: string }>;
	/** The newest event; null before the first. */
	lastRun: MonitorRun | null;
	/** Whether any scheduled (not manual) event exists, beyond {@link recent} too. */
	scheduledRun: boolean;
	/** Its conversation's origin key (`monitor/<id>`), as the turn board lists it; null for a peer install's monitor. */
	originKey: string | null;
	/** The peer install it belongs to (`id` is then `<install>:<id>`, `name` starts with `<install> · `); absent for this install's own. */
	install?: string;
	/** Whether the newest event is still on its way (not in {@link ENDED_STAGES}). */
	running: boolean;
	/** How many of the newest events in a row failed (`failed`, `failed_no_retry`), counted over {@link recent}. */
	failStreak: number;
	stats: MonitorStats;
}

const MONITOR_RECENT = 7;
const MONITOR_STATS_DAYS = 30;
const APPROVAL_STATS_DAYS = 7;
const AUTO_CHOICE_DAYS = 7;
const AUTO_CHOICE_LINES = 20;
const APPROVAL_RECENT = 20;
const MONITOR_FILES = 4;
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토", "일"];
/** Stages after which an event is over (the rest are still on their way). */
const ENDED_STAGES: Record<string, true> = {
	delivered: true,
	no_report: true,
	failed: true,
	failed_no_retry: true,
	skipped: true,
};
/** A script path in an instruction; no backtick, quote or Hangul in the set, so `` `…/x.py`를 `` gives `…/x.py`. */
const SCRIPT_PATH = /[A-Za-z0-9_.~/-]+\.(?:py|sh|ts|js)(?![A-Za-z0-9_])/g;
/** A Korean sentence end: a syllable, then `.`/`?`/`!` before a space or the line end (`README.md 의` is not one). */
const SENTENCE_END = /[가-힣][.?!](?=\s|$)/;

/** Slot to settle (`updated_at − slot_at`, ≥ 0, retry waits included) of an ended event; null while running. */
export function monitorDurationMs(stage: string, slotAt: number, updatedAt: number): number | null {
	return ENDED_STAGES[stage] === true ? Math.max(0, updatedAt - slotAt) : null;
}

/** The middle value (the mean of the two middle ones for an even count), rounded; null for none. */
function median(values: number[]): number | null {
	const sorted = values.slice().sort((a, b) => a - b);
	const upper = sorted[sorted.length >> 1];
	if (upper === undefined) return null;
	return sorted.length % 2 === 1 ? upper : Math.round(((sorted[(sorted.length >> 1) - 1] ?? upper) + upper) / 2);
}

/** One monitor's ended events slotted since `now − MONITOR_STATS_DAYS`, by outcome. */
function monitorStats(db: Database, monitorId: string, now: number): MonitorStats {
	const stats: MonitorStats = {
		days: MONITOR_STATS_DAYS,
		delivered: 0,
		quiet: 0,
		failed: 0,
		skipped: 0,
		medianMs: null,
	};
	const events = rows<{ stage: string; manual: number; slot_at: number; updated_at: number }>(
		db,
		"SELECT stage, manual, slot_at, updated_at FROM monitor_events WHERE monitor_id = ? AND slot_at >= ?",
		monitorId,
		now - MONITOR_STATS_DAYS * 86_400_000,
	);
	const took: number[] = [];
	for (const event of events) {
		if (event.stage === "failed" || event.stage === "failed_no_retry") stats.failed++;
		else if (event.stage === "skipped") stats.skipped++;
		else if (event.stage === "delivered" || event.stage === "no_report") {
			if (event.stage === "delivered") stats.delivered++;
			else stats.quiet++;
			if (event.manual === 0) took.push(Math.max(0, event.updated_at - event.slot_at));
		}
	}
	stats.medianMs = median(took);
	return stats;
}

/** A cron expression in words, in the monitor's own time zone (named when not the bot's zone); else `cron <expr>`. */
function cronWords(schedule: string, timezone: string, botTimezone: string): string {
	const fields = schedule.trim().split(/\s+/);
	const [minute = "", hour = "", dom, month, dow = ""] = fields;
	const upTo = (field: string, max: number): boolean => /^\d{1,2}$/.test(field) && Number(field) <= max;
	const pad = (field: string): string => field.padStart(2, "0");
	let words: string | undefined;
	if (fields.length === 5 && dom === "*" && month === "*") {
		if (upTo(minute, 59) && upTo(hour, 23)) {
			const time = `${pad(hour)}:${pad(minute)}`;
			if (dow === "*") words = `매일 ${time}`;
			else if (dow === "1-5") words = `평일 ${time}`;
			else if (/^[0-7](?:,[0-7])*$/.test(dow)) {
				words = `매주 ${[...new Set(dow.split(",").map((day) => WEEKDAYS[Number(day)]))].join("·")} ${time}`;
			}
		} else if (hour === "*" && dow === "*") {
			if (upTo(minute, 59)) words = `매시 ${pad(minute)}분`;
			else if (/^\*\/[1-9]\d?$/.test(minute)) words = `${Number(minute.slice(2))}분마다`;
		}
	}
	const label = words ?? `cron ${schedule}`;
	return timezone === botTimezone ? label : `${label} (${timezone})`;
}

function monitorSchedule(trigger: MonitorTrigger, timezone: string): string {
	switch (trigger.kind) {
		case "cron":
			return cronWords(trigger.schedule, trigger.timezone, timezone);
		case "at":
			return `한 번 · ${formatLocal(Date.parse(trigger.at), timezone).slice(5, 16)}`;
		case "script": {
			const every = trigger.intervalMs;
			return `조건 감시 · ${every % 60_000 === 0 ? `${every / 60_000}분` : `${every / 1000}초`}마다`;
		}
		case "webhook":
			return "외부 호출 때";
		case "watcher":
			return "파일 바뀔 때";
	}
}

/** The first sentence ({@link SENTENCE_END}) of the masked instruction's first line, as a `previewLine`. */
function monitorSummary(instruction: string): string {
	const line = redact(instruction).trim().split("\n")[0] ?? "";
	const end = SENTENCE_END.exec(line);
	return previewLine(end === null ? line : line.slice(0, end.index + 2));
}

/** File names of the procedure files, then of the scripts the instruction names; no directories, no repeats. */
function monitorFiles(row: MonitorRow): MonitorFile[] {
	const files: MonitorFile[] = [];
	const paths: Array<[MonitorFile["kind"], string]> = [
		...row.procedureFiles.map((path): [MonitorFile["kind"], string] => ["procedure", path]),
		...Array.from(row.instruction.matchAll(SCRIPT_PATH), (match): [MonitorFile["kind"], string] => [
			"script",
			match[0],
		]),
	];
	for (const [kind, path] of paths) {
		const name = redact(path.slice(path.lastIndexOf("/") + 1));
		if (name !== "" && !files.some((file) => file.name === name)) files.push({ kind, name });
	}
	return files.slice(0, MONITOR_FILES);
}

/**
 * A channel as the owner knows it: the DM, the config's Discord log, escalation or alert channel, else its id.
 */
function channelName(channel: string | null, config: DashboardConfig | undefined): string {
	if (channel === null) return "오너 DM";
	if (channel === config?.channels?.discord?.logChannelId) return "로그 채널";
	if (channel === config?.channels?.discord?.escalationChannelId) return "에스컬레이션 채널";
	if (channel === config?.channels?.discord?.alertChannelId) return "경보 채널";
	return `채널 ${channel}`;
}

interface AlertInfo {
	scope: string;
	signature: string;
	count: number;
	lastAt: string;
	incidentId: number;
	firstAt: string;
	status: string;
	/** `gate:<name>` rows only: that gate in this snapshot's `gates`; `unknown` when gates failed or lack it. */
	gateState?: GateState | "unknown";
}

/** A backup stamp's time and age. */
interface StampAge {
	at: string;
	ageMs: number;
}

interface BackupInfo {
	/** `<home>/backups/last-backup.ok`; absent when no backup has stamped yet. */
	local?: StampAge;
	/** `null` when config has no `offsite`; absent when it has one but no `offsite.ok` stamp exists. */
	offsite?: StampAge | null;
}

/** `<home>/jobs/<name>.json` names the dashboard reads; any other entry of the directory is skipped unread. */
export const JOB_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const JOB_LIMIT = 50;
/** A running job whose `updatedAt` is older than this reads as `stale`. */
const JOB_STALE_MS = 10 * 60_000;
/**
 * A `done` or `stopped` job, or a `running` one whose `pid` is gone (`dead`: its writer died without a final state),
 * leaves the list once its `updatedAt` is older than this.
 */
const JOB_DONE_KEEP_MS = 24 * 3_600_000;
/** A `failed` job stays longer to be looked at, then leaves once its `updatedAt` is older than this. */
const JOB_FAILED_KEEP_MS = 7 * 24 * 3_600_000;
const JOB_TITLE_CHARS = 120;
const JOB_DETAIL_CHARS = 200;
const JOB_FIELD_CHARS = 200;
const PROGRESS_MAX_BYTES = 64 * 1024;
const PROGRESS_TAIL_LINES = 40;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export type JobState = "running" | "done" | "stopped" | "failed";
/**
 * ok: running and updated within {@link JOB_STALE_MS}, or done, or stopped on purpose · stale: running, not updated since · dead: running, its
 * `pid` is gone · failed: `state: "failed"` · invalid: the file is not JSON or lacks `state`/`updatedAt`.
 */
export type JobHealth = "ok" | "stale" | "dead" | "failed" | "invalid";

/** One long-running job's progress file (`<home>/jobs/<name>.json`), read and never written by the dashboard. */
export interface JobInfo {
	name: string;
	/** Masked, at most 120 chars; the file name for an `invalid` file. */
	title: string;
	/** null for an `invalid` file. */
	state: JobState | null;
	/** `done`/`total` only when both are integers ≥ 0 with `done ≤ total`. */
	done?: number;
	total?: number;
	unit?: string;
	/** `done/total` in percent, one decimal; absent when `total` is 0 or the counts are absent. */
	percent?: number;
	startedAt?: string;
	/** The file's `updatedAt` (its modification time for an `invalid` file), in the bot's zone. */
	updatedAt: string;
	ageMs: number;
	pid?: number;
	/** Conversation the job was started from (`<channel>:<ts>`); shown as text only. */
	thread?: string;
	/** Masked, at most 200 chars; what was wrong for an `invalid` file. */
	detail?: string;
	/** Log path as text; the file is never opened. */
	log?: string;
	/** Progress file path as text; opened only when under allowed roots without a `secrets` path component. */
	progress?: string;
	/** Masked last 40 lines from the tail 64 KiB of `progress`; absent when unread or disallowed. */
	progressLines?: string[];
	/** Working directory path as text; used to locate the job's omp session folder when under allowed roots. */
	cwd?: string;
	health: JobHealth;
}

export interface DashboardSnapshot {
	/** Build time as an ISO string with the offset of `timezone`, like every other time in the snapshot. */
	generatedAt: string;
	/** The bot's zone (`config.timezone`): the page shows and groups times in it. */
	timezone: string;
	daemon: Section<DaemonInfo>;
	/** `peerErrors`: one line per peer install whose open turns could not be read; absent without any. */
	turns: Section<{ items: TurnInfo[]; threads: ThreadInfo[]; peerErrors?: PeerTurnError[] }>;
	tasks: Section<{ items: TaskInfo[] }>;
	/** Always built; optional only so snapshots made before the flow view still type. */
	flows?: Section<{ items: FlowChainInfo[] }>;
	lanes: Section<{ items: LaneInfo[] }>;
	/**
	 * `herdr agent list` per host; while the agent board is live, its column counts instead (`hosts` empty). `says`: what
	 * the local blocked/done omp panes said (only when there is any), merged into the board cards by the page.
	 */
	herdr: Section<{ hosts: HerdrHostInfo[]; board?: BoardSummary; says?: HerdrSay[] }>;
	/** `items`: the pending ones, oldest first; `recent`: the last settled ones, newest first. */
	approvals: Section<{ items: ApprovalInfo[]; recent: ApprovalDecision[]; stats: ApprovalStats }>;
	/** The `ask` questions the deadline answered; optional so hand-made snapshots still type. */
	autoChoices?: Section<AutoChoices>;
	/** `peerErrors`: one line per peer install whose monitors could not be read in full; absent without any. */
	monitors: Section<{ items: MonitorInfo[]; peerErrors?: Array<{ install: string; error: string }> }>;
	alerts: Section<{ items: AlertInfo[] }>;
	/** Every health gate, as `jabbu-pocket gates` lists them. */
	gates: Section<{ items: Gate[] }>;
	backup: Section<BackupInfo>;
	/** Progress files of long-running jobs outside the bot (`<home>/jobs/*.json`), newest update first. */
	jobs: Section<{ items: JobInfo[] }>;
	/**
	 * How a terminal runs this checkout's CLI, word by word (`bun`, `<repoDir>/src/main.ts`): the 터미널에서 보기 panels
	 * show commands with it for the owner to paste — the dashboard never runs them. Always built; optional only so
	 * hand-made snapshots still type.
	 */
	jabbuCli?: string[];
	/**
	 * The one Discord server (config `channels.discord.guildIds` with exactly one id) the turn panels' 디스코드에서
	 * 답하기 link needs for server channels and lanes; null otherwise (DM links do not need it). Optional like `jabbuCli`.
	 */
	discordGuild?: string | null;
	/** The top-bar test chip: the full test run holding this host's heavy-run lock and those queued behind it. Read fresh every time. */
	heavyRun?: Section<HeavyRunInfo>;
	/** The "호스트 점검" card: only with config `dashboard.opsStatus` (absent otherwise, and in hand-made snapshots). */
	hostChecks?: Section<HostChecksInfo>;
	/** Config `dashboard.opsStatus.url`: the card head links it. */
	hostChecksUrl?: string;
	/** "모델 한도" (also needs config `dashboard.usageLimits`) and "7일 비용" cards: only with `SnapshotDeps.usageLimits`. */
	usageLimits?: Section<UsageLimitsInfo>;
	costLedger?: Section<CostLedgerInfo>;
	/** 겹침 marks ({@link OverlapView}); absent when nothing overlaps and no agy session exists. */
	overlaps?: OverlapView;
}

export type DashboardConfig = Partial<
	Pick<
		JabbuConfig,
		| "agent"
		| "ompExecutable"
		| "ompProfile"
		| "offsite"
		| "herdr"
		| "dispatchHosts"
		| "herdrBoard"
		| "costCap"
		| "hostSessionCeiling"
		| "dashboard"
	>
> & {
	/**
	 * Only the server ids are read, for the Discord links of the turn panels, the Discord peer bots, for the flow's
	 * review node, and the Discord log, escalation and board channels, for the monitor channel labels.
	 */
	channels?: {
		discord?: {
			guildIds?: string[];
			peerBots?: Array<{ userId: string; name: string }>;
			logChannelId?: string;
			escalationChannelId?: string;
			alertChannelId?: string;
		};
	};
};

export interface SnapshotDeps {
	homeDir: string;
	/** Checkout whose short HEAD is shown. */
	repoDir: string;
	/** Absent for a home without config.json: no herdr, no board, local tasks only. */
	config: DashboardConfig | undefined;
	/** The bot's zone (`config.timezone`; the host zone for a home without config.json): every time is written in it. */
	timezone: string;
	now(): number;
	callDaemon(socketPath: string, request: unknown, timeoutMs: number): Promise<unknown>;
	/** herdr, ssh and git calls. */
	run: ProcessRunner;
	/** omp version line for the database fallback (the daemon reports its own). */
	ompVersion(): Promise<string>;
	/** Peer installs whose monitors are listed read-only (config `dashboard.peerHomes`); absent = none. */
	peers?: PeerInstall[];
	/** File and git access of a task's host (`null` = local); throws for an unknown host. */
	hostOps(host: string | null): TaskHostOps;
	/** fetch used to resolve board card links. */
	fetch?: typeof fetch;
	/** The live agent board (config has `herdrBoard`); undefined before its first list or while it is down. */
	board?: () => BoardState | undefined;
	/** The health gates; default {@link collectGates}. */
	collectGates?: (options: GatesOptions) => Gate[];
	/** Whether a job's `pid` still runs; default {@link pidAlive}. */
	isAlive?: (pid: number) => boolean;
	/** User home for allowed job roots (`$HOME/work`, `$HOME/.jabbu-*`); defaults to `process.env.HOME ?? homedir()`. */
	userHome?: string;
	/** Dashboard server only (default false), never the daemon's `!brief`: the model limit commands, the cost ledger, live context. */
	usageLimits?: boolean;
}

const sharedSessionModel = createSessionModelReader();

const message = (error: unknown): string =>
	redact(error instanceof Error ? error.message : String(error)).slice(0, ERROR_CHARS);

/** An install's enabled monitors with the next fire time; `install` marks a peer's (id, name and origin set apart). */
function monitorInfos(
	handle: Database,
	opts: {
		/** The monitor's own install zone, for the schedule words. */
		timezone: string;
		config: DashboardConfig | undefined;
		iso: (ms: number) => string;
		now: number;
		install?: string;
	},
): Array<{ next: number | null; info: MonitorInfo }> {
	const { timezone, config, iso, install, now } = opts;
	return rows<MonitorSql>(handle, "SELECT * FROM monitors WHERE enabled = 1").map((sql) => {
		const monitor = toMonitor(sql);
		const next = nextFireOf(monitor);
		// Newest first; `recent` turns them around.
		const events = rows<{ stage: string; slot_at: number; updated_at: number; attempts: number; manual: number }>(
			handle,
			"SELECT stage, slot_at, updated_at, attempts, manual FROM monitor_events WHERE monitor_id = ? ORDER BY event_id DESC LIMIT ?",
			monitor.id,
			MONITOR_RECENT,
		);
		const last = events[0];
		const firstNotFailed = events.findIndex((event) => event.stage !== "failed" && event.stage !== "failed_no_retry");
		const incidents = rows<{ n: number }>(
			handle,
			"SELECT COUNT(*) AS n FROM monitor_incidents WHERE monitor_id = ? AND status = 'alerted'",
			monitor.id,
		)[0];
		const { trigger } = monitor;
		const info: MonitorInfo = {
			id: install === undefined ? monitor.id : `${install}:${monitor.id}`,
			name: install === undefined ? redact(monitor.name) : `${install} · ${redact(monitor.name)}`,
			kind: trigger.kind,
			schedule: monitorSchedule(trigger, timezone),
			cron: trigger.kind === "cron" ? `${trigger.schedule} (${trigger.timezone})` : null,
			summary: monitorSummary(monitor.instruction),
			destination: channelName(monitor.channel, config),
			copyTo: monitor.copyChannel === null ? null : channelName(monitor.copyChannel, config),
			model: monitor.model,
			thinking: monitor.thinking,
			deliver: monitor.deliver,
			overlap: monitor.overlap,
			files: monitorFiles(monitor),
			nextFireAt: next === null ? null : iso(next),
			lastStage: last?.stage ?? null,
			lastAt: last === undefined ? null : iso(last.updated_at),
			openIncidents: incidents?.n ?? 0,
			recent: events
				.map((event) => ({ stage: event.stage, manual: event.manual === 1, at: iso(event.updated_at) }))
				.reverse(),
			lastRun:
				last === undefined
					? null
					: {
							stage: last.stage,
							at: iso(last.updated_at),
							slotAt: iso(last.slot_at),
							durationMs: monitorDurationMs(last.stage, last.slot_at, last.updated_at),
							attempts: last.attempts,
							manual: last.manual === 1,
						},
			scheduledRun:
				rows<{ n: number }>(
					handle,
					"SELECT EXISTS(SELECT 1 FROM monitor_events WHERE monitor_id = ? AND manual = 0) AS n",
					monitor.id,
				)[0]?.n === 1,
			originKey: install === undefined ? monitorOrigin(monitor.id) : null,
			...(install === undefined ? {} : { install }),
			running: last !== undefined && ENDED_STAGES[last.stage] !== true,
			failStreak: firstNotFailed < 0 ? events.length : firstNotFailed,
			stats: monitorStats(handle, monitor.id, now),
		};
		return { next, info };
	});
}

async function section<T>(build: () => T | Promise<T>): Promise<Section<T>> {
	try {
		return { ok: true, ...(await build()) };
	} catch (error) {
		return { ok: false, error: message(error) };
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const { promise: timeout, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const APPROVAL_TITLE_CHARS = 80;

/** First sentence (`.`/`!`/`?` before a space, or `。`) of the first line, cut to 80 characters with `…`. */
function approvalTitle(summary: string): string {
	const line = summary.split("\n")[0]?.trim() ?? "";
	const sentence = (/^.*?(?:[.!?](?=\s)|。)/.exec(line)?.[0] ?? line).trim();
	const title = sentence === "" ? summary.trim() : sentence;
	if (title.length <= APPROVAL_TITLE_CHARS) return title;
	const last = title.charCodeAt(APPROVAL_TITLE_CHARS - 2);
	const cut = last >= 0xd800 && last <= 0xdbff ? APPROVAL_TITLE_CHARS - 2 : APPROVAL_TITLE_CHARS - 1;
	return `${title.slice(0, cut)}…`;
}

/** The stored card sections, masked again; null when absent, unparsable or empty. */
function approvalDetail(json: string | null): ApprovalInfo["detail"] {
	if (json === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const fields = new Map<string, unknown>(Object.entries(parsed));
	const detail: NonNullable<ApprovalInfo["detail"]> = {};
	for (const key of ["action", "why", "impact", "rollback"] as const) {
		const value = fields.get(key);
		if (typeof value === "string" && value.trim() !== "") detail[key] = redact(value);
	}
	return Object.keys(detail).length === 0 ? null : detail;
}

/**
 * Registration to first `working → review` move (ms) of every TASK that made one in the last 30 days (by that move),
 * newest move first, at most 200: the window and cap of chat turn samples. TASKs never sent to review are not samples.
 */
export function taskDurationSamples(db: Database, now: number): number[] {
	return rows<{ ms: number }>(
		db,
		`SELECT MIN(tr.at) - t.created_at AS ms FROM task_transitions tr JOIN tasks t ON t.task_id = tr.task_id
		WHERE tr.from_status = 'working' AND tr.to_status = 'review'
		GROUP BY tr.task_id HAVING MIN(tr.at) >= ? ORDER BY MIN(tr.at) DESC LIMIT ?`,
		now - TURN_SAMPLE_WINDOW_MS,
		TURN_SAMPLE_LIMIT,
	).map((row) => row.ms);
}

/** The approvals settled since `now − APPROVAL_STATS_DAYS` (by `decided_at`, else `created_at`), by outcome. */
function approvalStats(db: Database, now: number): ApprovalStats {
	const settled = rows<{ status: ApprovalOutcomeStatus; created_at: number; decided_at: number | null }>(
		db,
		"SELECT status, created_at, decided_at FROM approvals WHERE status != 'pending' AND COALESCE(decided_at, created_at) >= ?",
		now - APPROVAL_STATS_DAYS * 86_400_000,
	);
	const stats: ApprovalStats = {
		days: APPROVAL_STATS_DAYS,
		approved: 0,
		denied: 0,
		expired: 0,
		replied: 0,
		medianAnswerMs: null,
	};
	const answers: number[] = [];
	for (const row of settled) {
		stats[row.status]++;
		if (row.status !== "expired" && row.decided_at !== null) answers.push(Math.max(0, row.decided_at - row.created_at));
	}
	stats.medianAnswerMs = median(answers);
	return stats;
}

/** `DM` for any platform's owner DM; a channel by its id, named after its platform when that is Discord (a removed `slack/` row keeps its plain label). */
function originLabel(originKey: string | null): string | null {
	if (originKey === null) return null;
	if (parseChatOrigin(originKey)?.kind === "dm") return "DM";
	const channel = /^(slack|discord)\/ch\/([^/]+)(\/t\/[^/]+)?$/.exec(originKey);
	if (channel === null) return originKey;
	const platform = channel[1] === "discord" ? "Discord " : "";
	return `${platform}채널 ${channel[2]} ${channel[3] === undefined ? "메인" : "스레드"}`;
}

/** Identical commands inside one snapshot share one process (one `herdr agent list` per host). */
function sharedRunner(run: ProcessRunner): ProcessRunner {
	const calls = new Map<string, Promise<RunProcessResult>>();
	return (cmd, opts) => {
		const key = JSON.stringify(cmd);
		let call = calls.get(key);
		if (call === undefined) {
			call = run(cmd, opts);
			calls.set(key, call);
		}
		return call;
	};
}

function summarizeStatus(report: StatusReport): Omit<DaemonInfo, "heartbeat" | "commit"> {
	return {
		running: report.daemonRunning,
		ompVersion: report.ompVersion,
		origins: report.origins.length,
		busy: report.origins.filter((origin) => origin.busy).length,
		ledger: report.ledger,
		inbound: report.inbound,
		monitors: report.monitors,
		openGates: report.openGates,
		...(report.frozen === undefined ? {} : { frozen: { ...report.frozen, reason: redact(report.frozen.reason) } }),
		...(report.drain === undefined ? {} : { drain: report.drain }),
		...(report.hostSessions === undefined ? {} : { hostSessions: report.hostSessions }),
	};
}

interface HerdrTarget {
	/** `local` or the `dispatchHosts` name. */
	host: string;
	herdrBin: string;
	sshTarget?: string;
	timeoutMs: number;
}

type HerdrListing = { ok: true; agents: HerdrAgentInfo[] } | { ok: false; error: string };

function herdrTargets(config: DashboardConfig | undefined): HerdrTarget[] {
	if (config?.herdr === undefined) return [];
	const targets: HerdrTarget[] = [
		{ host: "local", herdrBin: config.herdr.bin ?? "herdr", timeoutMs: HERDR_LOCAL_TIMEOUT_MS },
	];
	for (const [host, entry] of Object.entries(config.dispatchHosts ?? {})) {
		targets.push({ host, herdrBin: entry.herdrBin ?? "herdr", sshTarget: entry.ssh, timeoutMs: HERDR_SSH_TIMEOUT_MS });
	}
	return targets;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** One `herdr agent list` of a host, parsed at this boundary (outside-controlled JSON). */
async function listHerdrAgents(target: HerdrTarget, run: ProcessRunner): Promise<HerdrListing> {
	const args = ["agent", "list"];
	const cmd =
		target.sshTarget === undefined ? [target.herdrBin, ...args] : herdrSshArgv(target.sshTarget, target.herdrBin, args);
	const result = await run(cmd, { timeoutMs: target.timeoutMs });
	if (result.code !== 0 || result.timedOut) {
		const detail = result.timedOut
			? "timed out"
			: result.stderr?.trim() || result.stdout.trim() || `exit ${result.code}`;
		return { ok: false, error: `agent list failed: ${message(detail)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return { ok: false, error: "agent list output is not JSON" };
	}
	const agents = (parsed as { result?: { agents?: unknown } } | null)?.result?.agents;
	if (!Array.isArray(agents)) return { ok: false, error: "agent list output has no agents" };
	// Session files are read on this machine only: a remote host's path never leaves its listing.
	const local = target.host === "local";
	return {
		ok: true,
		agents: agents.map((entry: Record<string, unknown>) => {
			const sessionPath = local ? sessionPathOf(entry?.agent_session) : undefined;
			return {
				name: str(entry?.name),
				agent: str(entry?.agent),
				agentStatus: str(entry?.agent_status),
				cwd: str(entry?.cwd),
				paneId: str(entry?.pane_id),
				terminalTitle: redact(str(entry?.terminal_title)),
				...(sessionPath === undefined ? {} : { sessionPath }),
			};
		}),
	};
}

/** At most this many panes' files are read per snapshot, all of them within {@link SAY_READ_BUDGET_MS}. */
const SAY_PANES = 12;
const SAY_READ_BUDGET_MS = 1_500;
/** A last answer, an error line: one sentence or line of at most this many characters. */
const SAY_TEXT_CHARS = 120;
/** A question or choice is kept whole up to this many characters (a page is no place for a whole essay). */
const SAY_QUESTION_CHARS = 400;
const SAY_CACHE_LIMIT = 64;

/** Per session file: what it said at that mtime and size, so an unchanged file is not read again. */
const sayCache = new Map<string, { mtimeMs: number; size: number; status: PaneSay["status"]; say: PaneSay }>();

/** Masked, whitespace folded, cut to `limit` characters (the last one `…` when cut). */
function sayText(text: string, limit: number): string {
	const chars = Array.from(redact(text).replace(/\s+/g, " ").trim());
	return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : chars.join("");
}

/** The first sentence (up to its `.`/`!`/`?` or the line end) of a text, masked, at most {@link SAY_TEXT_CHARS}. */
function firstSentence(text: string): string {
	const line = redact(text).trim().split("\n")[0] ?? "";
	const end = /[.!?。](?=\s|$)/.exec(line);
	return sayText(end === null ? line : line.slice(0, end.index + 1), SAY_TEXT_CHARS);
}

/** The questions of an `ask` call's arguments (`questions[].question`, `options[].label`); unreadable ones are left out. */
function asksOf(args: unknown): AskInfo[] {
	const questions = isRecord(args) && Array.isArray(args.questions) ? args.questions : [];
	return questions.flatMap((entry): AskInfo[] => {
		if (!isRecord(entry) || typeof entry.question !== "string" || entry.question.trim() === "") return [];
		const options = (Array.isArray(entry.options) ? entry.options : [])
			.map((option) => (isRecord(option) && typeof option.label === "string" ? option.label : ""))
			.filter((label) => label.trim() !== "")
			.map((label) => sayText(label, SAY_QUESTION_CHARS));
		return [{ question: sayText(entry.question, SAY_QUESTION_CHARS), options }];
	});
}

/**
 * What the pane's last assistant message says. Blocked: the first tool call without a result after it — an `ask`
 * gives its questions, any other tool `도구 실행 승인 대기: <name>` — else an error end `프로바이더 오류: <first line>`.
 * Done: the first sentence of its text.
 */
function sayOf(found: AssistantTail, status: PaneSay["status"]): PaneSay {
	if (status === "done") {
		const content = Array.isArray(found.message.content) ? found.message.content.filter(isRecord) : [];
		const text = content.find((block) => block.type === "text" && typeof block.text === "string" && block.text.trim());
		const lastSay = text === undefined ? "" : firstSentence(text.text as string);
		return lastSay === "" ? { status } : { status, lastSay };
	}
	const pending = pendingToolCall(found);
	if (pending !== undefined) {
		const asks = pending.name === "ask" ? asksOf(pending.arguments) : [];
		const [first] = asks;
		if (first !== undefined) {
			const more = asks.length > 1 ? ` 외 ${asks.length - 1}개` : "";
			return { status, question: `${first.question}${more}`, options: first.options, asks };
		}
		if (pending.name !== "ask") {
			return { status, blocked: `도구 실행 승인 대기: ${sayText(str(pending.name) || "?", SAY_TEXT_CHARS)}` };
		}
		return { status };
	}
	const error = typeof found.message.errorMessage === "string" ? found.message.errorMessage : "";
	if (found.message.stopReason === "error" || error !== "") {
		const line = sayText(error.trim().split("\n")[0] ?? "", SAY_TEXT_CHARS);
		return { status, blocked: `프로바이더 오류: ${line || "알 수 없음"}` };
	}
	return { status };
}

/** One pane's say, from the cache while its file keeps its mtime and size; a read failure stays on this pane. */
function paneSay(path: string, status: PaneSay["status"]): PaneSay {
	try {
		const stat = statSync(path);
		const cached = sayCache.get(path);
		if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.status === status) return cached.say;
		const found = readLastAssistant(path);
		const say = found === undefined ? { status } : sayOf(found, status);
		sayCache.delete(path);
		sayCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, status, say });
		if (sayCache.size > SAY_CACHE_LIMIT) {
			const oldest = sayCache.keys().next().value;
			if (oldest !== undefined) sayCache.delete(oldest);
		}
		return say;
	} catch (error) {
		return { status, sayError: sayText(`세션 파일을 읽지 못했습니다: ${message(error)}`, ERROR_CHARS) };
	}
}

/**
 * The says of the local blocked/done omp panes with a session file, blocked ones first (then in the given order): at
 * most {@link SAY_PANES} files, and no new file once {@link SAY_READ_BUDGET_MS} has passed (the rest wait for the next
 * snapshot, mostly from the cache then).
 */
function localSays(agents: HerdrAgentInfo[], now: () => number): HerdrSay[] {
	const wanted = agents
		.filter(
			(agent) =>
				agent.agent === "omp" &&
				agent.sessionPath !== undefined &&
				(agent.agentStatus === "blocked" || agent.agentStatus === "done"),
		)
		.sort((a, b) => Number(b.agentStatus === "blocked") - Number(a.agentStatus === "blocked"))
		.slice(0, SAY_PANES);
	const started = now();
	const says: HerdrSay[] = [];
	for (const [index, agent] of wanted.entries()) {
		if (index > 0 && now() - started > SAY_READ_BUDGET_MS) break;
		const say = paneSay(agent.sessionPath as string, agent.agentStatus as PaneSay["status"]);
		says.push({ host: "local", paneId: agent.paneId, ...say });
	}
	return says;
}

/** Masked and cut to `limit` chars (the last one `…` when cut); undefined for a missing or blank value. */
function jobText(value: unknown, limit: number): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const chars = Array.from(redact(value));
	return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : chars.join("");
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

const underRoot = (root: string, path: string): boolean =>
	path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export const hasSecretsSegment = (path: string): boolean => path.split(/[\\/]/).includes("secrets");

/** Allowed real directories for job `progress` and `cwd` paths: `<jabbu home>`, `$HOME/work`, `$HOME/.jabbu-*`. */
export function jobAllowedRoots(homeDir: string, userHome: string): string[] {
	const candidates = [homeDir, join(userHome, "work")];
	try {
		for (const entry of readdirSync(userHome, { withFileTypes: true })) {
			if (entry.name.startsWith(".jabbu-")) candidates.push(join(userHome, entry.name));
		}
	} catch {
		// unreadable userHome: keep homeDir and work only
	}
	const roots: string[] = [];
	for (const candidate of candidates) {
		try {
			const real = realpathSync(candidate);
			if (statSync(real).isDirectory()) roots.push(real);
		} catch {
			// missing or inaccessible root
		}
	}
	return roots;
}

/** Resolves a job `progress` file only if it is an absolute regular file inside `roots` with no `secrets` segment. */
function resolveAllowedProgressFile(rawPath: string, roots: readonly string[]): string | undefined {
	if (!isAbsolute(rawPath) || hasSecretsSegment(rawPath)) return undefined;
	let real: string;
	try {
		real = realpathSync(rawPath);
	} catch {
		return undefined;
	}
	if (hasSecretsSegment(real) || !roots.some((root) => underRoot(root, real))) return undefined;
	try {
		if (!statSync(real).isFile()) return undefined;
	} catch {
		return undefined;
	}
	return real;
}

/** Checks whether a job `cwd` is an absolute path inside `roots` (or its nearest existing ancestor is) with no `secrets` segment. */
export function isAllowedJobCwd(rawPath: string, roots: readonly string[]): boolean {
	if (!isAbsolute(rawPath) || hasSecretsSegment(rawPath)) return false;
	let probe = rawPath;
	while (true) {
		if (hasSecretsSegment(probe)) return false;
		try {
			const real = realpathSync(probe);
			if (hasSecretsSegment(real) || !roots.some((root) => underRoot(root, real))) return false;
			return statSync(real).isDirectory();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") return false;
			const parent = dirname(probe);
			if (parent === probe) return false;
			probe = parent;
		}
	}
}

/** Reads up to the last 64 KiB of an allowed regular `progress` file, masks secrets before splitting, and returns at most 40 lines. */
function readProgressTail(rawPath: string, roots: readonly string[]): string[] | undefined {
	const real = resolveAllowedProgressFile(rawPath, roots);
	if (real === undefined) return undefined;
	let fd: number;
	try {
		fd = openSync(real, "r");
	} catch {
		return undefined;
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) return undefined;
		const start = Math.max(0, st.size - PROGRESS_MAX_BYTES);
		const length = st.size - start;
		if (length === 0) return [];
		const buf = Buffer.allocUnsafe(length);
		let offset = 0;
		while (offset < length) {
			const n = readSync(fd, buf, offset, length - offset, start + offset);
			if (n === 0) break;
			offset += n;
		}
		const rawText = buf.subarray(0, offset).toString("utf8");
		const clean = start > 0 ? rawText.replace(/^\uFFFD+/, "") : rawText;
		const masked = redact(clean).replace(/\r?\n$/, "");
		if (masked === "") return [];
		return masked.split(/\r?\n/).slice(-PROGRESS_TAIL_LINES);
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/** One job file plus its unmasked `cwd` when present; a file that cannot be read as a job comes back `invalid`. */
function readJobEntry(
	dir: string,
	file: string,
	now: number,
	isAlive: (pid: number) => boolean,
	timezone: string,
	allowedRoots?: readonly string[],
): { job: JobInfo; rawCwd?: string } {
	const name = file.slice(0, -".json".length);
	const path = join(dir, file);
	const invalid = (why: string): { job: JobInfo } => {
		let modified = now;
		try {
			modified = statSync(path).mtimeMs;
		} catch {
			modified = now; // removed since the listing: its age is unknown
		}
		return {
			job: {
				name,
				title: file,
				state: null,
				updatedAt: localIso(modified, timezone),
				ageMs: now - modified,
				detail: jobText(why, JOB_DETAIL_CHARS) ?? "",
				health: "invalid",
			},
		};
	};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return invalid(`읽기 실패: ${message(error)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return invalid("JSON 객체가 아님");
	const fields = parsed as Record<string, unknown>;
	const state = fields.state;
	if (state !== "running" && state !== "done" && state !== "stopped" && state !== "failed") {
		return invalid("state가 없거나 running·done·stopped·failed가 아님");
	}
	const updatedMs =
		typeof fields.updatedAt === "string" && ISO_8601.test(fields.updatedAt) ? Date.parse(fields.updatedAt) : Number.NaN;
	if (Number.isNaN(updatedMs)) return invalid("updatedAt이 없거나 ISO 8601 시각이 아님");
	const startedMs =
		typeof fields.startedAt === "string" && ISO_8601.test(fields.startedAt) ? Date.parse(fields.startedAt) : Number.NaN;
	const { done, total } = fields;
	const counts = isCount(done) && isCount(total) && done <= total;
	const pid = Number.isSafeInteger(fields.pid) && (fields.pid as number) > 0 ? (fields.pid as number) : undefined;
	const ageMs = now - updatedMs;
	const health: JobHealth =
		state === "failed"
			? "failed"
			: state === "done" || state === "stopped"
				? "ok"
				: pid !== undefined && !isAlive(pid)
					? "dead"
					: ageMs > JOB_STALE_MS
						? "stale"
						: "ok";
	const unit = jobText(fields.unit, JOB_FIELD_CHARS);
	const thread = jobText(fields.thread, JOB_FIELD_CHARS);
	const detail = jobText(fields.detail, JOB_DETAIL_CHARS);
	const log = jobText(fields.log, JOB_FIELD_CHARS);
	const progress = jobText(fields.progress, JOB_FIELD_CHARS);
	const progressLines =
		typeof fields.progress === "string" && fields.progress.trim() !== "" && allowedRoots !== undefined
			? readProgressTail(fields.progress, allowedRoots)
			: undefined;
	const cwd = jobText(fields.cwd, JOB_FIELD_CHARS);
	const rawCwd = typeof fields.cwd === "string" && fields.cwd.trim() !== "" ? fields.cwd : undefined;
	return {
		job: {
			name,
			title: jobText(fields.title, JOB_TITLE_CHARS) ?? name,
			state,
			...(counts ? { done, total } : {}),
			...(counts && total > 0 ? { percent: Math.round((done / total) * 1000) / 10 } : {}),
			...(unit === undefined ? {} : { unit }),
			...(Number.isNaN(startedMs) ? {} : { startedAt: localIso(startedMs, timezone) }),
			updatedAt: localIso(updatedMs, timezone),
			ageMs,
			...(pid === undefined ? {} : { pid }),
			...(thread === undefined ? {} : { thread }),
			...(detail === undefined ? {} : { detail }),
			...(log === undefined ? {} : { log }),
			...(progress === undefined ? {} : { progress }),
			...(progressLines === undefined ? {} : { progressLines }),
			...(cwd === undefined ? {} : { cwd }),
			health,
		},
		...(rawCwd === undefined ? {} : { rawCwd }),
	};
}

/** Reads one `<homeDir>/jobs/<name>.json` entry for on-demand trace lookup; returns undefined if absent or invalid name. */
export function readJobFile(
	homeDir: string,
	name: string,
	now: number,
	isAlive: (pid: number) => boolean,
	timezone: string,
): { job: JobInfo; rawCwd?: string } | undefined {
	if (!JOB_NAME.test(name)) return undefined;
	const dir = join(homeDir, "jobs");
	const file = `${name}.json`;
	if (!existsSync(join(dir, file))) return undefined;
	return readJobEntry(dir, file, now, isAlive, timezone);
}

/**
 * `<home>/jobs/<name>.json` files whose name passes {@link JOB_NAME}: newest update first, at most {@link JOB_LIMIT},
 * `done`, `stopped` and `dead` jobs only for {@link JOB_DONE_KEEP_MS}, `failed` ones for {@link JOB_FAILED_KEEP_MS}. No directory means no jobs. Reads only; never creates or removes.
 */
function readJobs(
	homeDir: string,
	now: number,
	isAlive: (pid: number) => boolean,
	timezone: string,
	allowedRoots: readonly string[],
): JobInfo[] {
	const dir = join(homeDir, "jobs");
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json") && JOB_NAME.test(entry.name.slice(0, -5)))
		.map((entry) => readJobEntry(dir, entry.name, now, isAlive, timezone, allowedRoots).job)
		.filter((job) =>
			job.state === "failed"
				? job.ageMs <= JOB_FAILED_KEEP_MS
				: !((job.state === "done" || job.state === "stopped" || job.health === "dead") && job.ageMs > JOB_DONE_KEEP_MS),
		)
		.sort((a, b) => a.ageMs - b.ageMs)
		.slice(0, JOB_LIMIT);
}

/** Running `systemd-run --user --unit=jabbu-<name>` work is a job even without a progress file. */
const UNIT_JOB_PREFIXES = ["jabbu-"];
/** `jabbu-job-*` units only write a job file for another unit: listing them too would show that work twice. */
const UNIT_HELPER_PREFIX = "jabbu-job-";
const UNIT_TIMEOUT_MS = 5_000;
const UNIT_PROPERTIES = ["Id", "Description", "Transient", "ActiveState", "ActiveEnterTimestamp", "MainPID"];

/**
 * The user's running transient `jabbu-*.service` units (`systemd-run`), as `running` jobs named
 * without the prefix. A unit that a job file or an earlier unit already shows (same name or pid) or a helper unit is left
 * out. A host without `systemctl` has none; any other failure comes back as one `invalid` row so the files still show.
 */
async function readUnitJobs(run: ProcessRunner, files: JobInfo[], now: number, timezone: string): Promise<JobInfo[]> {
	const result = await run(
		[
			"systemctl",
			"--user",
			"show",
			`--property=${UNIT_PROPERTIES.join(",")}`,
			"--timestamp=unix",
			...UNIT_JOB_PREFIXES.map((prefix) => `${prefix}*.service`),
		],
		{ timeoutMs: UNIT_TIMEOUT_MS },
	);
	if (result.code === null && !result.timedOut && result.stdout.startsWith("spawn failed")) return [];
	if (result.code !== 0 || result.timedOut) {
		const why = result.timedOut ? "timed out" : result.stderr?.trim() || result.stdout.trim() || `exit ${result.code}`;
		return [
			{
				name: "systemd",
				title: "systemd 유닛 목록",
				state: null,
				updatedAt: localIso(now, timezone),
				ageMs: 0,
				detail: jobText(`systemctl --user show 실패: ${why}`, JOB_DETAIL_CHARS) ?? "",
				health: "invalid",
			},
		];
	}
	const known = new Set(files.map((job) => job.name));
	const knownPids = new Set(files.flatMap((job) => (job.pid === undefined ? [] : [job.pid])));
	const jobs: JobInfo[] = [];
	for (const unit of parseSystemctlShow(result.stdout)) {
		const id = unit.get("Id") ?? "";
		if (unit.get("Transient") !== "yes" || unit.get("ActiveState") !== "active") continue;
		const prefix = UNIT_JOB_PREFIXES.find((candidate) => id.startsWith(candidate));
		if (prefix === undefined || id.startsWith(UNIT_HELPER_PREFIX) || !id.endsWith(".service")) continue;
		const name = id.slice(prefix.length, -".service".length);
		const pid = Number(unit.get("MainPID"));
		if (!JOB_NAME.test(name) || known.has(name) || knownPids.has(pid)) continue;
		known.add(name);
		const started = parseUnixTimestamp(unit.get("ActiveEnterTimestamp") ?? "");
		jobs.push({
			name,
			title: jobText(unit.get("Description"), JOB_TITLE_CHARS) ?? name,
			state: "running",
			...(started === undefined ? {} : { startedAt: localIso(started, timezone) }),
			updatedAt: localIso(now, timezone),
			ageMs: 0,
			...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
			detail: `systemd 유닛 ${id}`,
			health: "ok",
		});
	}
	return jobs;
}

/**
 * One read-only picture of the bot. Never opens a `Store` or the task ledger (both write on open: the store re-queues
 * inflight deliveries); every table is read through a `readonly` handle. Of message bodies only the turns of the board's
 * threads are read (open ones, and the last {@link THREAD_WINDOW_MS}'s), and only their masked one-line preview leaves
 * this function.
 */
export async function buildSnapshot(deps: SnapshotDeps): Promise<DashboardSnapshot> {
	const now = deps.now();
	const run = sharedRunner(deps.run);
	const machinesFetch = sharedFetch(deps.fetch ?? fetch);
	const { config, timezone } = deps;
	const guildIds = config?.channels?.discord?.guildIds;
	const discordGuild = guildIds?.length === 1 ? (guildIds[0] ?? null) : null;
	const iso = (ms: number): string => localIso(ms, timezone);
	const dbPath = join(deps.homeDir, "jabbu.db");
	const db = existsSync(dbPath) ? new Database(dbPath, { readonly: true, strict: true }) : undefined;
	try {
		const needDb = (): Database => {
			if (db === undefined) throw new Error(`no database at ${dbPath}`);
			return db;
		};

		const opsStatus = config?.dashboard?.opsStatus;
		const hostChecks = opsStatus === undefined ? undefined : readHostChecks(opsStatus.command, deps.run, deps.now);
		const usageConfig = deps.usageLimits === true ? config?.dashboard?.usageLimits : undefined;
		const samples = { home: deps.homeDir, timezone: deps.timezone };
		const usageLimits = usageConfig && readUsageLimits(usageConfig, deps.run, deps.now, samples);

		const targets = herdrTargets(config);
		// Run on first use only: with a live board and no open TASK on a host, that host's `herdr agent list` is not needed.
		const listings = new Map<string, Promise<HerdrListing>>();
		const listingOf = (host: string): Promise<HerdrListing> | undefined => {
			const target = targets.find((candidate) => candidate.host === host);
			if (target === undefined) return undefined;
			const listing =
				listings.get(host) ??
				listHerdrAgents(target, run).catch((error: unknown) => ({ ok: false as const, error: message(error) }));
			listings.set(host, listing);
			return listing;
		};

		const daemon = section(async (): Promise<DaemonInfo> => {
			let report: StatusReport | undefined;
			try {
				const response = await deps.callDaemon(join(deps.homeDir, "jabbu.sock"), { op: "status" }, IPC_TIMEOUT_MS);
				if (isStatusResponse(response)) report = { ...response.status, daemonRunning: true };
			} catch {
				report = undefined; // no daemon answering: the database file tells the rest
			}
			if (report === undefined) {
				needDb();
				report = readStatusFromDb(dbPath, await deps.ompVersion(), timezone, gateOptionsFromConfig(config, timezone));
			}
			const info: DaemonInfo = summarizeStatus(report);
			const beat = readSweepHeartbeat(deps.homeDir);
			if (beat !== undefined) {
				info.heartbeat = {
					at: iso(beat.ts.getTime()),
					ageMs: now - beat.ts.getTime(),
					...(beat.loopMs === undefined ? {} : { loopMs: beat.loopMs }),
					...(beat.discord === undefined
						? {}
						: { discord: { state: beat.discord.state, since: iso(beat.discord.since.getTime()) } }),
					...(beat.draining === undefined ? {} : { draining: beat.draining }),
				};
			}
			const head = await run(["git", "-C", deps.repoDir, "rev-parse", "--short", "HEAD"], {
				timeoutMs: GIT_TIMEOUT_MS,
			});
			const commit = head.stdout.trim();
			if (head.code === 0 && !head.timedOut && /^[0-9a-f]{4,40}$/.test(commit)) info.commit = commit;
			const startedAt = info.running ? readLockStartedAt(deps.homeDir) : undefined;
			if (startedAt !== undefined) info.started = { at: iso(startedAt), ageMs: now - startedAt };
			return info;
		});

		const jobs = section(async () => {
			const userHome = deps.userHome ?? process.env.HOME ?? homedir();
			const allowedRoots = jobAllowedRoots(deps.homeDir, userHome);
			const files = readJobs(deps.homeDir, now, deps.isAlive ?? pidAlive, timezone, allowedRoots);
			const units = await readUnitJobs(run, files, now, timezone);
			return { items: [...units, ...files].slice(0, JOB_LIMIT) };
		});

		// No cache and no config: the state directory is read on every snapshot.
		const heavyRun = section((): HeavyRunInfo => {
			const states = readHeavyRunStates(heavyRunPaths());
			const running = states.find((state) => state.state === "running");
			return {
				running: running === undefined ? null : { label: running.label, ageMs: Math.max(0, now - running.since) },
				waiting: states
					.filter((state) => state.state === "waiting")
					.map((state) => ({ label: state.label, waitedMs: Math.max(0, now - state.since) })),
			};
		});

		const turns = section(async () => {
			const handle = needDb();
			// A failed daemon section leaves drain and freeze unknown: the other wait reasons still apply.
			const status = await daemon;
			const jobSection = await jobs;
			const built = buildTurnsSection(handle, {
				now,
				iso,
				draining: status.ok && (status.drain !== undefined || status.heartbeat?.draining === true),
				frozen: status.ok && status.frozen !== undefined,
				activeJobs: jobSection.ok
					? jobSection.items
							.filter(
								(job) =>
									job.state === "running" &&
									(job.health === "ok" || job.health === "stale") &&
									job.thread !== undefined,
							)
							.slice()
							.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
					: [],
				...(deps.peers === undefined ? {} : { peers: deps.peers }),
				sessionModel: sharedSessionModel,
			});
			return withContextLoad(built, handle, deps);
		});
		const editOverlaps = turns.then((t) =>
			readEditOverlaps({ db, now, peers: deps.peers ?? [], threads: t.ok ? t.threads : [], listing: listingOf }),
		);

		const herdrStateOf = async (row: TaskRow): Promise<HerdrState> => {
			if (row.runtime === "headless") return { ok: true, status: headlessStatusFromLedger(needDb(), row) };
			if (config?.herdr === undefined) return { ok: false, error: "herdr is not configured" };
			const target = targets.find((candidate) => candidate.host === (row.host ?? "local"));
			if (target === undefined) return { ok: false, error: `unknown host: ${row.host}` };
			return herdrAgentStatus(row.agent, {
				herdrBin: target.herdrBin,
				timeoutMs: target.timeoutMs,
				run,
				...(target.sshTarget === undefined ? {} : { sshTarget: target.sshTarget }),
			});
		};

		const linkOf = async (row: TaskRow): Promise<string | undefined> => {
			const board = config?.herdrBoard;
			if (board === undefined || row.runtime === "headless") return undefined;
			const listing = await listingOf(row.host ?? "local");
			const paneId =
				listing?.ok === true ? listing.agents.find((agent) => agent.name === row.agent)?.paneId : undefined;
			return boardCardLink(board, row.host, paneId, { fetch: machinesFetch });
		};

		let taskTypical: { value: TypicalDuration | undefined } | undefined;
		/** `typical` and `elapsedMs` of a `working` TASK; neither for another status or under 10 samples. */
		const durationOf = (row: TaskRow): { typical?: TypicalDuration; elapsedMs?: number } => {
			if (row.status !== "working") return {};
			taskTypical ??= { value: typicalDuration(taskDurationSamples(needDb(), now)) };
			const typical = taskTypical.value;
			return typical === undefined ? {} : { typical, elapsedMs: Math.max(0, now - row.createdAt) };
		};

		const describeOpen = async ({ row, broken }: ReadTask): Promise<TaskInfo> => {
			const info: TaskInfo = { ...baseTask({ row, broken }, timezone), ...durationOf(row) };
			const [evaluation, herdr, link] = await Promise.all([
				withTimeout(
					(async () => evaluateTask(row, deps.hostOps(row.host)))(),
					TASK_EVAL_TIMEOUT_MS,
					`${row.taskId} evaluation`,
				).catch((error: unknown) => ({ ok: false as const, error: message(error) })),
				// One row's herdr failure shows as that row's herdr error, never as a missing tasks section.
				herdrStateOf(row).catch((error: unknown): HerdrState => ({ ok: false, error: message(error) })),
				linkOf(row),
			]);
			if (evaluation.ok) {
				const j = evaluation.judgement;
				info.acChecked = j.acChecked;
				info.stepsDone = j.stepsDone;
				info.stepsTotal = j.stepsTotal;
				info.progress = {
					status: j.status,
					updated: j.updatedAt,
					current: redact(j.current),
					blockedReason: redact(j.blockedReason),
				};
				info.acceptance = j.acceptance.map((item) => ({ ...item, text: redact(item.text) }));
				info.steps = j.steps.map((step) => ({ ...step, text: redact(step.text) }));
			} else info.error = [info.error ?? [], message(evaluation.error)].flat().join(" · ");
			info.herdr = herdr.ok ? herdr : { ok: false, error: message(herdr.error) };
			if (link !== undefined) info.link = link;
			info.overlap = (await editOverlaps).overlaps?.hints[`task:${row.taskId}`];
			return Object.assign(info, taskTurnFields(row, evaluation.ok ? evaluation.judgement : undefined));
		};

		const tasks = section(async () => {
			const handle = needDb();
			const open = rows<TaskSql>(
				handle,
				"SELECT * FROM tasks WHERE status IN ('working','blocked','review') ORDER BY task_id",
			).map(readTaskSql);
			const closed = rows<TaskSql>(
				handle,
				"SELECT * FROM tasks WHERE status IN ('done','cancelled') AND closed_at >= ? ORDER BY closed_at DESC LIMIT ?",
				now - CLOSED_TASK_DAYS * 86_400_000,
				CLOSED_TASK_LIMIT,
			).map(readTaskSql);
			return {
				items: [...(await Promise.all(open.map(describeOpen))), ...closed.map((read) => baseTask(read, timezone))],
			};
		});

		const flows = section(() => {
			const handle = needDb();
			const since = now - FLOW_WINDOW_MS;
			const scope =
				"thread_ref IN (SELECT thread_ref FROM tasks WHERE created_at >= ? OR status IN ('working','blocked','review'))";
			const read = rows<TaskSql>(handle, `SELECT * FROM tasks WHERE ${scope} ORDER BY created_at, task_id`, since).map(
				(r) => readTaskSql(r).row,
			);
			const transitions = rows<FlowTransition>(
				handle,
				`SELECT task_id AS taskId, from_status AS fromStatus, to_status AS toStatus, actor, reason, at
				FROM task_transitions WHERE task_id IN (SELECT task_id FROM tasks WHERE ${scope}) ORDER BY transition_id`,
				since,
			);
			// The spec review node shows when Discord has a peer bot (`channels.discord.peerBots`).
			const peerReview = (config?.channels?.discord?.peerBots?.length ?? 0) > 0;
			const statuses = taskFlowStatus(read, transitions, peerReview);
			const threads = new Map<string, TaskRow[]>();
			for (const row of read) threads.set(row.threadRef, [...(threads.get(row.threadRef) ?? []), row]);
			const chains = [...threads].map(([threadRef, list]) => {
				const steps = list.map((row): FlowStepInfo => {
					const stage = taskStage(row, statuses, timezone);
					return {
						taskId: row.taskId,
						title: redact(row.title),
						status: row.status,
						risk: row.risk,
						host: row.host ?? "local",
						branch: row.branch,
						createdAt: iso(row.createdAt),
						...(row.closedAt === null ? {} : { closedAt: iso(row.closedAt) }),
						acTotal: row.acceptance.length,
						stage: { ...stage, msg: redact(stage.msg) },
						...durationOf(row),
					};
				});
				const open = list.filter((row) => row.status !== "done" && row.status !== "cancelled");
				const here = open.find((row) => row.status === "blocked") ?? open[0];
				const updatedAt = Math.max(...list.map((row) => row.updatedAt));
				let line: string;
				if (here === undefined) {
					const closedAt = Math.max(...list.map((row) => row.closedAt ?? row.updatedAt));
					line = `모두 끝남 · 마지막 close ${iso(closedAt).slice(5, 16).replace("T", " ")}`;
				} else {
					const stage = steps.find((step) => step.taskId === here.taskId)?.stage;
					const msg = Array.from((stage?.msg ?? "").replace(/\s+/g, " ").trim());
					const cut =
						msg.length > FLOW_NOW_MSG_CHARS ? `${msg.slice(0, FLOW_NOW_MSG_CHARS - 1).join("")}…` : msg.join("");
					line = `${here.taskId} ${stage?.label ?? ""}${cut === "" ? "" : ` · ${cut}`}${
						open.length > 1 ? ` · 외 열림 ${open.length - 1}` : ""
					}`;
				}
				const request = rows<{ text_ref: string; created_at: number }>(
					handle,
					"SELECT text_ref, created_at FROM inbound WHERE thread_ref = ? ORDER BY inbound_id LIMIT 1",
					threadRef,
				)[0];
				// Link markup in the stored text: `<url|label>` reads as the label, `<url>` as host/path.
				const text = request?.text_ref
					.replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
					.replace(/<https?:\/\/([^>]+)>/g, "$1");
				const originKey = list[0]?.originKey ?? "";
				const info: FlowChainInfo = {
					threadRef,
					originKey,
					place: originLabel(originKey),
					title: text === undefined ? "(원문 없음)" : previewLine(text, list[0]?.title),
					requestedAt: request === undefined ? null : iso(request.created_at),
					updatedAt: iso(updatedAt),
					done: list.filter((row) => row.status === "done").length,
					total: list.length,
					here: here?.taskId ?? null,
					now: line,
					tasks: steps,
					discordHref: discordThreadHref(discordGuild, originKey, threadRef),
				};
				return { open: open.length > 0, updatedAt, info };
			});
			chains.sort((a, b) => Number(b.open) - Number(a.open) || b.updatedAt - a.updatedAt);
			return { items: chains.map((chain) => chain.info) };
		});

		const lanes = section(() => {
			const laneTypical = typicalDuration(laneDurationSamples(needDb(), now));
			return {
				items: rows<{
					name: string;
					origin_key: string;
					title: string;
					status: string;
					cwd: string;
					created_at: number;
					updated_at: number;
					uncertain_count: number;
					evidence_file: string | null;
					evidence_sha256: string | null;
				}>(
					needDb(),
					`SELECT name, origin_key, title, status, cwd, created_at, updated_at,
					CASE WHEN json_valid(meta) THEN json_extract(meta, '$.milestoneEvidence.file') END AS evidence_file,
					CASE WHEN json_valid(meta) THEN json_extract(meta, '$.milestoneEvidence.sha256') END AS evidence_sha256,
					(SELECT COUNT(*) FROM inbound WHERE inbound.origin_key = lanes.origin_key AND inbound.state = 'uncertain') AS uncertain_count
					FROM lanes WHERE status != 'closed' ORDER BY updated_at DESC`,
				).map((r) => ({
					name: r.name,
					originKey: r.origin_key,
					title: redact(r.title),
					status: r.status,
					cwd: r.cwd,
					updatedAt: iso(r.updated_at),
					uncertainCount: r.uncertain_count,
					...(r.evidence_file === null || r.evidence_sha256 === null
						? {}
						: { evidence: { file: redact(r.evidence_file), sha256: r.evidence_sha256 } }),
					...(laneTypical === undefined || r.status !== "working"
						? {}
						: { typical: laneTypical, elapsedMs: Math.max(0, now - r.created_at) }),
				})),
			};
		});

		const herdr = section(async () => {
			const live = deps.board?.();
			if (live !== undefined) {
				// The board hides the agent list; the local one is still asked when a local pane is blocked or done, for its session file.
				const asking = live.cards.some((card) => card.local && (card.status === "blocked" || card.status === "done"));
				const listing = asking ? await listingOf("local") : undefined;
				const says = listing?.ok ? localSays(listing.agents, deps.now) : [];
				return {
					hosts: [] as HerdrHostInfo[],
					board: summarizeBoard(live),
					...(says.length === 0 ? {} : { says }),
				};
			}
			const owners =
				db === undefined
					? []
					: rows<{ task_id: string; agent: string; host: string | null }>(db, "SELECT task_id, agent, host FROM tasks");
			if (targets.length === 0) {
				return { hosts: [{ host: "local", ok: false as const, error: "herdr is not configured" }] };
			}
			const says: HerdrSay[] = [];
			const hosts = await Promise.all(
				targets.map(async (target): Promise<HerdrHostInfo> => {
					const listing = (await listingOf(target.host)) as HerdrListing;
					if (!listing.ok) return { host: target.host, ok: false, error: listing.error };
					const own = target.host === "local" ? localSays(listing.agents, deps.now) : [];
					says.push(...own);
					return {
						host: target.host,
						ok: true,
						agents: listing.agents.map((agent) => {
							const owner = owners.find((task) => task.agent === agent.name && (task.host ?? "local") === target.host);
							const found = own.find((say) => say.paneId === agent.paneId);
							const {
								host: _host,
								paneId: _pane,
								status: _status,
								...said
							} = found ?? { host: "", paneId: "", status: "" };
							return { ...agent, ...said, ...(owner === undefined ? {} : { taskId: owner.task_id }) };
						}),
					};
				}),
			);
			return { hosts, ...(says.length === 0 ? {} : { says }) };
		});

		const approvals = section(() => {
			const handle = needDb();
			// A daemon still on the old code has not added the dashboard columns yet: read them as NULL.
			const present = new Set(rows<{ name: string }>(handle, "PRAGMA table_info(approvals)").map((c) => c.name));
			const optional = ["detail_json", "card_url", "origin_url"]
				.map((column) => (present.has(column) ? column : `NULL AS ${column}`))
				.join(", ");
			return {
				items: rows<{
					approval_id: string;
					summary: string;
					created_at: number;
					expires_at: number;
					origin_key: string | null;
					origin_thread_ref: string | null;
					detail_json: string | null;
					card_url: string | null;
					origin_url: string | null;
				}>(
					handle,
					`SELECT approval_id, summary, created_at, expires_at, origin_key, origin_thread_ref, ${optional} FROM approvals WHERE status = 'pending' ORDER BY created_at`,
				).map((r): ApprovalInfo => {
					const summary = redact(r.summary);
					return {
						approvalId: r.approval_id,
						summary,
						createdAt: iso(r.created_at),
						expiresAt: iso(r.expires_at),
						originKey: r.origin_key,
						originThreadRef: r.origin_thread_ref,
						title: approvalTitle(summary),
						detail: approvalDetail(r.detail_json),
						cardUrl: r.card_url?.startsWith("https://") ? r.card_url : null,
						originUrl: r.origin_url?.startsWith("https://") ? r.origin_url : null,
						remainingMs: Math.max(0, r.expires_at - now),
						originLabel: originLabel(r.origin_key),
					};
				}),
				recent: rows<{
					approval_id: string;
					summary: string;
					status: ApprovalOutcomeStatus;
					created_at: number;
					decided_at: number | null;
					origin_key: string | null;
					origin_thread_ref: string | null;
					detail_json: string | null;
					card_url: string | null;
					origin_url: string | null;
				}>(
					handle,
					`SELECT approval_id, summary, status, created_at, decided_at, origin_key, origin_thread_ref, ${optional} FROM approvals
					WHERE status != 'pending' ORDER BY COALESCE(decided_at, created_at) DESC, created_at DESC LIMIT ?`,
					APPROVAL_RECENT,
				).map((r): ApprovalDecision => {
					const summary = redact(r.summary);
					return {
						approvalId: r.approval_id,
						summary,
						title: approvalTitle(summary),
						status: r.status,
						createdAt: iso(r.created_at),
						decidedAt: r.decided_at === null ? null : iso(r.decided_at),
						tookMs: r.decided_at === null ? null : Math.max(0, r.decided_at - r.created_at),
						originKey: r.origin_key,
						originThreadRef: r.origin_thread_ref,
						originLabel: originLabel(r.origin_key),
						detail: approvalDetail(r.detail_json),
						cardUrl: r.card_url?.startsWith("https://") ? r.card_url : null,
						originUrl: r.origin_url?.startsWith("https://") ? r.origin_url : null,
					};
				}),
				stats: approvalStats(handle, now),
			};
		});

		const autoChoices = section((): AutoChoices => {
			const handle = needDb();
			// A daemon still on the old code has not created the table yet: nothing was recorded.
			const present = rows<{ name: string }>(handle, "SELECT name FROM sqlite_master WHERE name = 'auto_choices'");
			if (present.length === 0) return { days: AUTO_CHOICE_DAYS, items: [], last24h: 0 };
			const items = rows<{
				created_at: number;
				origin_key: string | null;
				thread_ref: string | null;
				question: string;
				chosen: string;
			}>(
				handle,
				"SELECT created_at, origin_key, thread_ref, question, chosen FROM auto_choices WHERE created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?",
				now - AUTO_CHOICE_DAYS * 86_400_000,
				AUTO_CHOICE_LINES,
			).map(
				(r): AutoChoiceInfo => ({
					at: iso(r.created_at),
					originKey: r.origin_key,
					threadRef: r.thread_ref,
					question: redact(r.question),
					chosen: redact(r.chosen),
				}),
			);
			const [{ n = 0 } = {}] = rows<{ n: number }>(
				handle,
				"SELECT COUNT(*) AS n FROM auto_choices WHERE created_at >= ?",
				now - 86_400_000,
			);
			return { days: AUTO_CHOICE_DAYS, items, last24h: n };
		});

		const monitors = section(() => {
			const listed = monitorInfos(needDb(), { timezone, config, iso, now });
			const peerErrors: Array<{ install: string; error: string }> = [];
			for (const peer of deps.peers ?? []) {
				const problems = peer.configError === undefined ? [] : [peer.configError];
				const peerDbPath = join(peer.home, "jabbu.db");
				if (existsSync(peerDbPath)) {
					let peerDb: Database | undefined;
					try {
						peerDb = new Database(peerDbPath, { readonly: true, strict: true });
						listed.push(
							...monitorInfos(peerDb, { timezone: peer.timezone, config: undefined, iso, now, install: peer.name }),
						);
					} catch (error) {
						problems.push(`db를 읽지 못함: ${message(error)}`);
					} finally {
						peerDb?.close();
					}
				} else {
					problems.push("jabbu.db가 없음");
				}
				if (problems.length > 0)
					peerErrors.push({ install: peer.name, error: redact(problems.join("; ")).slice(0, ERROR_CHARS) });
			}
			// Next to fire first, monitors with no next fire last, then by name.
			listed.sort(
				(a, b) =>
					(a.next ?? Number.POSITIVE_INFINITY) - (b.next ?? Number.POSITIVE_INFINITY) ||
					a.info.name.localeCompare(b.info.name, "ko"),
			);
			return { items: listed.map(({ info }) => info), ...(peerErrors.length === 0 ? {} : { peerErrors }) };
		});

		const gates = await section(() => ({
			items: (deps.collectGates ?? collectGates)({
				homeDir: deps.homeDir,
				now,
				...gateOptionsFromConfig(config, timezone),
			}).map((gate) => ({ ...gate, detail: redact(gate.detail) })),
		}));

		const backup = section((): BackupInfo => {
			const dir = join(deps.homeDir, "backups");
			const age = (name?: string): StampAge | undefined => {
				const ts = readStamp(dir, name)?.ts.getTime();
				return ts === undefined ? undefined : { at: iso(ts), ageMs: now - ts };
			};
			const local = age();
			const offsite = config?.offsite === undefined ? null : age(OFFSITE_STAMP_FILE);
			return { ...(local === undefined ? {} : { local }), ...(offsite === undefined ? {} : { offsite }) };
		});

		const alerts = section(() => ({
			items: rows<{
				incident_id: number;
				scope: string;
				signature: string;
				status: string;
				count: number;
				first_at: number;
				last_at: number;
			}>(
				needDb(),
				"SELECT incident_id, scope, signature, status, count, first_at, last_at FROM alert_incidents WHERE status = 'alerted' ORDER BY last_at DESC",
			).map((r): AlertInfo => {
				const info: AlertInfo = {
					scope: r.scope,
					signature: redact(r.signature),
					count: r.count,
					lastAt: iso(r.last_at),
					incidentId: r.incident_id,
					firstAt: iso(r.first_at),
					status: r.status,
				};
				if (r.scope.startsWith("gate:")) {
					const name = r.scope.slice("gate:".length);
					info.gateState = (gates.ok ? gates.items.find((gate) => gate.name === name)?.state : undefined) ?? "unknown";
				}
				return info;
			}),
		}));

		return {
			generatedAt: iso(now),
			timezone,
			daemon: await daemon,
			turns: await turns,
			tasks: await tasks,
			flows: await flows,
			lanes: await lanes,
			herdr: await herdr,
			approvals: await approvals,
			autoChoices: await autoChoices,
			monitors: await monitors,
			alerts: await alerts,
			gates,
			backup: await backup,
			jobs: await jobs,
			heavyRun: await heavyRun,
			jabbuCli: ["bun", join(deps.repoDir, "src", "main.ts")],
			discordGuild,
			...(hostChecks === undefined ? {} : { hostChecks: await hostChecks }),
			...(opsStatus?.url === undefined ? {} : { hostChecksUrl: opsStatus.url }),
			...(usageLimits === undefined ? {} : { usageLimits: await usageLimits }),
			...(deps.usageLimits === true ? { costLedger: await readCostLedger(deps.homeDir, deps.now, timezone) } : {}),
			...(await editOverlaps),
		};
	} finally {
		db?.close();
	}
}

/**
 * Open TASKs (working, blocked, review) the board cards are matched against, through a read-only handle. A home
 * without a database or a tasks table has none.
 */
export function readBoardTasks(homeDir: string): BoardTaskRef[] {
	const dbPath = join(homeDir, "jabbu.db");
	if (!existsSync(dbPath)) return [];
	const db = new Database(dbPath, { readonly: true, strict: true });
	try {
		return rows<{ task_id: string; agent: string; worktree: string }>(
			db,
			"SELECT task_id, agent, worktree FROM tasks WHERE status IN ('working','blocked','review') ORDER BY task_id",
		).map((r) => ({ taskId: r.task_id, agent: r.agent, worktree: r.worktree }));
	} finally {
		db.close();
	}
}

/**
 * The newest recorded herdr prompt of every (host, agent) through a read-only handle, for the board cards'
 * 마지막 지시; none without a database or before the daemon created the table.
 */
export function readBoardPrompts(homeDir: string): BoardPromptRef[] {
	const dbPath = join(homeDir, "jabbu.db");
	if (!existsSync(dbPath)) return [];
	const db = new Database(dbPath, { readonly: true, strict: true });
	try {
		const table = rows<{ n: number }>(
			db,
			"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'herdr_prompts'",
		);
		if ((table[0]?.n ?? 0) === 0) return [];
		return rows<BoardPromptRef>(
			db,
			`SELECT id, host, agent, kind, preview, at FROM herdr_prompts
				WHERE id IN (SELECT MAX(id) FROM herdr_prompts GROUP BY host, agent)`,
		);
	} finally {
		db.close();
	}
}

function baseTask({ row, broken }: ReadTask, timezone: string): TaskInfo {
	const open = row.status !== "done" && row.status !== "cancelled";
	return {
		taskId: row.taskId,
		title: redact(row.title),
		risk: row.risk,
		status: row.status,
		host: row.host ?? "local",
		agent: row.agent,
		branch: row.branch,
		open,
		updatedAt: localIso(row.updatedAt, timezone),
		...(row.closedAt === null ? {} : { closedAt: localIso(row.closedAt, timezone) }),
		acTotal: row.acceptance.length,
		...(broken.length === 0 ? {} : { error: `${broken.join("·")} 손상` }),
	};
}

/**
 * The snapshot behind every request: reused for `ttlMs` after it was built, and requests that arrive while one is
 * being built wait for that same build. A failed build is not kept, and neither is one still running after
 * `buildTimeoutMs`: its waiters are rejected and the next request starts a new build.
 */
export function createSnapshotCache(
	build: () => Promise<DashboardSnapshot>,
	now: () => number,
	ttlMs: number = SNAPSHOT_TTL_MS,
	buildTimeoutMs: number = SNAPSHOT_BUILD_TIMEOUT_MS,
): () => Promise<DashboardSnapshot> {
	let cached: { at: number; snapshot: DashboardSnapshot } | undefined;
	let pending: Promise<DashboardSnapshot> | undefined;
	return () => {
		if (cached !== undefined) {
			const age = now() - cached.at;
			if (age >= 0 && age < ttlMs) return Promise.resolve(cached.snapshot);
		}
		if (pending === undefined) {
			pending = withTimeout(build(), buildTimeoutMs, "snapshot build")
				.then((snapshot) => {
					cached = { at: now(), snapshot };
					return snapshot;
				})
				.finally(() => {
					pending = undefined;
				});
		}
		return pending;
	};
}
