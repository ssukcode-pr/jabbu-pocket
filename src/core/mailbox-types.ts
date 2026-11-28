import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ConversationContext } from "../channel/port";
import { isTaskOrigin } from "../lanes/status";
import type { Logger } from "../log";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { OmpDriverError, type OmpFinal, type OmpSessionDriver, type TodoPhase } from "../omp/driver";
import { newestSessionFile } from "../omp/session-heal";
import type { CacheMiss } from "../ops/cache-monitor";
import type { SubAgentCostCache } from "../ops/cost-cap";
import type { GitRunner } from "../ops/turn-heads";
import type { Store } from "../store/db";
import type { InboundRow, OriginRow } from "../store/db-rows";
import type { TypicalDuration } from "../store/turn-duration";
import { PROVIDER_LIMIT } from "./failure-kind";
import type { LiveTurn } from "./live-turn";
import type { TurnPeer } from "./mailbox-notices";
import type { ThreadSource } from "./mailbox-thread-context";
import type { ChatPlatform } from "./origin-key";
import type { StuckDetector } from "./stuck";
import { CONTINUE_ID_PREFIX, type MailboxClock, type RestartProvider, type StatusProvider } from "./types";

/** Commands that offer an interactive SelectMenu picker when invoked without arguments on Discord. */
export type PickerCommandKind = "model" | "thinking" | "fast" | "usage-reset";

/** What the mailbox (`OriginMailbox`) needs from the daemon. */
export type DriverFactory = (originKey: string, sessionDir: string) => OmpSessionDriver;

/** Consecutive failed turns (dispatch, failed final, mid-turn exit) before the owner escalation fires. */
export const DEFAULT_ESCALATE_AFTER = 3;

/**
 * Failure signs that mean the session's model is gone (a provider removed it while the child was running, the
 * 2026-10-24 outage): the live driver gets an immediate re-heal, not only on the next session open.
 */
export const MODEL_FAILURE_SIGN = /could not restore model|model not found|unknown model|no such model/i;

/** Whether a failure sign names a missing model and is therefore worth an immediate `#healStaleModel` run. */
export function isModelFailureSign(sign: string): boolean {
	return MODEL_FAILURE_SIGN.test(sign);
}

/** The message a failure carries into sign matching and failure records. */
export function failureSign(error: unknown): string {
	return error instanceof OmpDriverError ? error.message : String(error);
}

/** A provider usage-limit hit seen in omp's retry events; at most once per turn. */
export interface ProviderLimitInfo {
	originKey: string;
	threadRef: string;
	attempt: number;
	/** 0 when the limit arrived on `auto_retry_end` (no `auto_retry_start` carried it). */
	maxAttempts: number;
	/** Raw provider error text; redact before it reaches the chat. */
	errorMessage: string;
}

/** A large prompt cache miss of a conversation turn (`src/ops/cache-monitor.ts`). */
export interface CacheMissInfo extends CacheMiss {
	originKey: string;
	threadRef: string; // thread of the turn whose call missed
	model: string;
}

/** A conversation resumed after its cache expired: what the new turn will likely rewrite. */
export interface ColdCacheInfo {
	originKey: string;
	threadRef: string; // thread of the new turn
	prefixTokens: number;
	idleMs: number; // time since the baseline call
	estimatedCost?: number; // dollars to rewrite the prefix at the last known cache write price; absent when unknown
}

/**
 * Work the bot starts by itself, not at the owner's word: a peer bot's message, a monitor or [TASK] origin's row, a lane's
 * automatic instruction (`lane:<name>:<kind>:<seq>`). A frozen bot holds exactly these. A resume row
 * (`cut-<original id>`) is classed by its original id.
 */
export function isAutonomousRow(originKey: string, row: Pick<InboundRow, "peerUserId" | "platformMessageId">): boolean {
	const id = row.platformMessageId.startsWith(CONTINUE_ID_PREFIX)
		? row.platformMessageId.slice(CONTINUE_ID_PREFIX.length)
		: row.platformMessageId;
	return (
		row.peerUserId !== null ||
		isTaskOrigin(originKey) ||
		originKey.startsWith(MONITOR_ORIGIN_PREFIX) ||
		id.startsWith("lane:")
	);
}

export function isProviderLimit(message: string): boolean {
	return PROVIDER_LIMIT.test(message);
}

/**
 * Fired when consecutive failed turns reach `escalateAfter` and on every failure past it (repeat suppression is the
 * caller's — the daemon counts incidents in the store). Called on the actor chain, so it must never await the platform.
 */
export interface TurnFailureEscalation {
	originKey: string;
	threadRef: string; // thread of the last failed turn
	failures: number; // consecutive failures counted when this fired
	reason: string; // last failure sign (raw error text); redact before it reaches the chat
	modelHealed: boolean; // the live session's stale model was just switched because the sign matched a removed model
}

/** A turn that ended through the final path (`MailboxDeps.onTurnSettled`). */
export interface TurnSettledInfo {
	originKey: string;
	/**
	 * Why the turn did not end normally: omp's error, `lane_paused`, a stall/stuck/cost-cap stop reason, or the status
	 * (`aborted`/`error`) when omp named none. Absent = the turn completed.
	 */
	error?: string;
	/** The turn's final assistant text (`""` when there is none). */
	text: string;
	/** Owner dialogs (ask cards) of the origin still waiting when the turn ended. */
	openDialogs: number;
}

/** A turn aborted because the same tool call kept returning the same result (`src/core/stuck.ts`). */
export interface StuckLoopInfo {
	originKey: string;
	threadRef: string;
	opRef: string;
	toolName: string;
	/** Identical calls of the turn when it was stopped. */
	count: number;
}

export interface StallEscalation {
	originKey: string;
	threadRef: string;
	opRef: string;
	/** `notify`: a conversation turn keeps running, the owner decides; `abort`: a monitor turn was aborted and failed. */
	kind: "notify" | "abort";
	/** Stalls of this turn so far. */
	count: number;
	/** Accumulated silence of this turn (finished stalls plus the one running now). */
	totalSilentMs: number;
}

/** The lane board's head line for a turn prompt and the cursor move to run once that prompt reached the driver. */
export interface BoardNotice {
	block: string;
	commit(): void;
}

export interface MailboxDeps {
	originKey: string;
	store: Store;
	driverFactory: DriverFactory;
	clock: MailboxClock;
	/** The bot's zone (`config.timezone`): the daily cost ledger day and recalled rows' dates. */
	timezone: string;
	statusProvider: StatusProvider;
	/**
	 * `/usage-jabbu` answer for an origin: the token and cost totals from jabbu's own session files, then the account
	 * limits of `omp usage` (src/omp/usage-json.ts) as one block under them. Without it the command says it is not wired.
	 */
	usageProvider?: (originKey: string) => Promise<string>;
	/** `!distill` answer for an origin: starts a skill review of its session and says so (or why not); absent = not wired. */
	distillProvider?: (originKey: string) => Promise<string>;
	/**
	 * `!budget` answer: today's ledger total, top origins and both ceilings; absent = not wired.
	 */
	budgetProvider?: () => Promise<string>;
	/** Read on every new turn: whether its prompt may carry channel-scoped recall. Absent = never. */
	recallEnabled?: () => boolean;
	/** Read when a child starts: whether it gets jabbu host tools (an omp child; agy gets none). Absent = yes. */
	hostTools?: () => boolean;
	/**
	 * Live `costCap` from config, read per assistant call: `turnUsd` steers a turn at the ceiling and stops it at
	 * 3x. Absent, or a key absent, = that ceiling is off. `dailyUsd` is not read here (`src/ops/cost-cap.ts`).
	 */
	costCap?: () => { turnUsd?: number; dailyUsd?: number } | undefined;
	/**
	 * Thread readers per platform, for the context a peer request or an owner's first reply to a bot post needs; a
	 * platform without one (or no map) gets none.
	 */
	threadSource?: ReadonlyMap<ChatPlatform, ThreadSource>;
	log: Logger;
	/** Session directory for an origin epoch; epoch 1 is used when the origin is first created. */
	sessionDirFor: (originKey: string, epoch: number) => string;
	/** Config default model (`provider/id`); fallback when a restored session's model no longer exists. */
	defaultModel?: string;
	/**
	 * Root of pre-heal session backups (`<root>/<originKey encoded>/<UTC timestamp>.jsonl`); the daemon always
	 * sets it. A session-file heal (restore failed on a removed model) is skipped without it.
	 */
	sessionBackupsRoot?: string;
	idleStopMs?: number;
	/** Consecutive failed turns that fire `onEscalate` (default 3); 0 disables escalation. */
	escalateAfter?: number;
	/** Owner escalation of a stalled turn: at most once per turn (`opRef`). */
	onStallEscalate?: (info: StallEscalation) => void;
	/** Status text switches to stalled on first stall and back after `STALL_RELEASE_MS` without another stall. */
	onStall?: (info: { originKey: string; threadRef: string; stalled: boolean; silentMs: number }) => void;
	/**
	 * The running turn's progress changed (a tool started, a to-do list result, a steer delivered, a model retry); `progress`
	 * is a snapshot of the whole summary. Raw texts: redact before they reach the chat.
	 */
	onProgress?: (info: { originKey: string; threadRef: string; progress: TurnProgress }) => void;
	/** Owner escalation for a run of failed turns: the bot reporting "나 망가짐" by itself. */
	onEscalate?: (info: TurnFailureEscalation) => void;
	/** A turn's omp retry reported a provider usage limit; once per turn, on the actor chain (never await the platform). */
	onProviderLimit?: (info: ProviderLimitInfo) => void;
	/** Turn/send failed with a provider quota/rate-limit error; daemon tracks recovery and holds queued turns. */
	onQuotaError?: (info: { originKey: string; threadRef: string; model?: string; reason: string }) => void;
	/** Prompt cache miss notice for conversation turns (never monitors). */
	onCacheMiss?: (info: CacheMissInfo) => void;
	/** A new conversation turn starts on a cold cache (`isColdCache`); once per baseline, never for a monitor. */
	onColdCache?: (info: ColdCacheInfo) => void;
	/** Tokens from which resuming a cold-cache conversation starts a new epoch, read per turn (0 or absent: never). */
	coldResumeRotateTokens?: () => number;
	/** A conversation turn started a new session at resume (cold cache, `shouldRotateOnColdResume`); once per rotation. */
	onColdResumeRotated?: (info: ColdCacheInfo) => void;
	/** True while a restart drain runs: messages are recorded `pending` only — no new turn, no steer, no command. */
	isDraining?: () => boolean;
	/** True while held (paused lane): pending rows wait until resumed (`!` commands still run). */
	isHeld?: () => boolean;
	/** Reason queued turns are held by a provider quota limit; absent when open. */
	quotaHoldReason?: () => string | undefined;
	/** True while frozen (`FROZEN`): autonomous rows wait; owner rows still run. */
	isFrozen?: () => boolean;
	/** True while attached to a terminal omp: no child or `!` command runs until detached. */
	isAttached?: () => boolean;
	/**
	 * The held origin's driver started working on its own (a queued message omp began without the mailbox: a
	 * `tool_execution_start` outside any turn). Once per pause is the caller's (the lane warns and re-aborts).
	 */
	onHeldWork?: (info: { originKey: string }) => void;
	/** A child opened another session file than the one to resume; once per (origin, epoch), never blocks the turn. */
	onSessionMismatch?: (info: SessionMismatchInfo) => void;
	/**
	 * A turn is being aborted for a tool repeat loop; at most once per turn, only when the abort still owns the turn
	 * (a final that settled it first sends nothing). Called on the actor chain, so it must never await the platform.
	 */
	onStuckLoop?: (info: StuckLoopInfo) => void;
	/**
	 * A turn first reached `costCap.turnUsd` (once per turn): a warning for the turn's thread, the turn keeps running.
	 * Called on the actor chain, so it must never await the platform.
	 */
	onTurnCostCap?: (info: { originKey: string; threadRef: string; text: string }) => void;
	/** omp dialogs (select/confirm/input/editor/ask cards) waiting on the owner; absent: messages never answer one. */
	dialogs?: OpenDialogs;
	/**
	 * Task-list phases planted with `set_todos` right before the first prompt of a freshly created session (never on a
	 * continued session). Only the lane wiring sets it; `undefined` plants nothing. A failure is a warning only.
	 */
	initialTodos?: () => TodoPhase[] | undefined;
	/**
	 * Read right before the first prompt of a freshly created session (never a continued one): a returned reason
	 * means the prompt is not sent. Only the lane wiring sets it.
	 */
	launchRefusal?: (driver: OmpSessionDriver) => Promise<string | undefined> | undefined;
	/** A refused first prompt (`launchRefusal`): its child is already stopped; the lane wiring closes the lane. */
	onLaunchRefused?: (reason: string) => Promise<void>;
	/**
	 * Read for every new turn prompt (never a steer): the lane board's head line for new posts, put in the prompt's
	 * context blocks, and the cursor move `commit` the mailbox runs only once the prompt reached the driver (a failed
	 * prompt announces again). Absent or undefined = no line.
	 */
	boardNotice?: () => BoardNotice | undefined;
	/** Read for every new turn prompt: the channel name, topic and thread name the platform cached; Discord chats only. */
	conversationContext?: () => ConversationContext | undefined;
	/**
	 * Every turn that ended through the final path (completed, failed, paused, aborted), after its answer or failure
	 * was recorded and before the next queued row starts. Called on the actor chain: it must never await.
	 */
	onTurnSettled?: (info: TurnSettledInfo) => void;
	/** The repository HEADs around a conversation turn (wiki turn notes); absent = no git is started. */
	turnHeads?: TurnHeadsDeps;
	/**
	 * `!brief`: draws a one-page status picture and uploads it to `threadRef` (skipped when `isDiscarded` says a `!new`
	 * discarded the row). Resolving = the image is in the thread; throwing = nothing was uploaded. Absent = not wired.
	 */
	briefingProvider?: (originKey: string, threadRef: string, isDiscarded?: () => boolean) => Promise<void>;
	/** `!restart`: called with the row's origin and thread, its line becomes the answer. Absent = not wired. */
	restartProvider?: RestartProvider;
	/** `/usage-reset-jabbu`: resets quota holds/usage blocks; absent = not wired. */
	usageResetProvider?: (arg: string, originKey: string) => Promise<string>;
	/** Interactive command picker for bare commands (`/model`, `/thinking`, `/fast`, `/usage-reset`). */
	commandPicker?: (info: {
		kind: PickerCommandKind;
		originKey: string;
		threadRef: string;
		busy: boolean;
		ensureDriver: () => Promise<OmpSessionDriver>;
	}) => Promise<boolean>;
}

/** What the turn HEAD reading needs from the daemon (the mailbox only decides when to read). */
export interface TurnHeadsDeps {
	/**
	 * Read on every conversation turn (a config reload changes it without a restart): the repositories whose HEAD is
	 * read before and after the turn. Empty = no git at all.
	 */
	headRepos: () => readonly string[];
	/** Git runner (tests inject one that counts or fails); absent = the real git. */
	run?: GitRunner;
	/** Commits observed around a turn (`src/wiki` turns); must not throw. */
	onCommitted?: (turn: {
		originKey: string;
		opRef: string;
		threadRef: string;
		rows: readonly TurnHeads[];
	}) => Promise<void>;
}

/** A repository's head before and after one turn. */
export interface TurnHeads {
	repo: string;
	headBefore: string;
	headAfter: string;
	endedAt: number;
}

/** The owner-facing omp dialogs of each origin (`ApprovalBroker.choose` cards), as the mailbox sees them. */
export interface OpenDialogs {
	/** Dialogs of the origin still waiting for an answer. */
	open(originKey: string): number;
	/**
	 * Gives the owner's text to the origin's one open dialog. Resolves true once the dialog read it; false when there
	 * was not exactly one open or it closed before reading the text (the message must then take the normal path).
	 */
	answer(originKey: string, text: string): Promise<boolean>;
	/** A plain message arrived while 2+ dialogs wait: tell the owner where to answer (never awaits the platform). */
	ambiguous(info: { originKey: string; threadRef: string }): void;
}

/** One tool call of a turn: its `toolActivityText`, and whether it still runs, succeeded or failed. */
export interface RecentTool {
	text: string;
	/** `toolCallId` of the start event; the end event finds its entry by it. */
	callId?: string;
	state: "running" | "ok" | "error";
	startedAt: number;
	endedAt?: number;
}

/** What the running status message shows of a turn besides its elapsed time. */
export interface TurnProgress {
	/** `tool_execution_start` events of the turn. */
	tools: number;
	/** The newest tool calls, oldest first, at most `RECENT_TOOLS`. */
	recentTools: RecentTool[];
	/** From the last state-changing to-do list result: completed/total tasks (abandoned ones excluded) and the first in-progress task. */
	todo?: { done: number; total: number; current?: string };
	/** Owner messages steered into the turn. */
	steers: number;
	/** The turn reached `MAX_STEERS` and a message was held back for the next turn. */
	steerCapped?: true;
	/** omp's model retry attempt (`auto_retry_start.attempt`); 0 without retries. */
	retries: number;
	/** How long this origin's turns usually take (chat origins with enough past turns only). */
	typical?: TypicalDuration;
}

/** Tool lines a status message lists. */
export const RECENT_TOOLS = 3;

/**
 * Owner messages steered into one turn at most; later ones wait for the next turn. The value follows
 * dinobot-labs/dinobot fc54718 (설계 참고, 코드 미복사).
 */
export const MAX_STEERS = 4;

/**
 * To-do summary of the omp to-do list tool's result (`details: {op, phases}`); undefined for `view` reads,
 * errors and shapes it does not know.
 */
export function todoProgress(result: unknown): TurnProgress["todo"] | undefined {
	if (typeof result !== "object" || result === null || !("details" in result)) return undefined;
	const details = result.details;
	if (typeof details !== "object" || details === null || !("phases" in details) || !Array.isArray(details.phases)) {
		return undefined;
	}
	if ("op" in details && details.op === "view") return undefined;
	let done = 0;
	let total = 0;
	let current: string | undefined;
	for (const phase of details.phases as unknown[]) {
		if (typeof phase !== "object" || phase === null || !("tasks" in phase) || !Array.isArray(phase.tasks))
			return undefined;
		for (const task of phase.tasks as unknown[]) {
			if (typeof task !== "object" || task === null || !("status" in task)) return undefined;
			if (task.status === "abandoned") continue;
			total += 1;
			if (task.status === "completed") done += 1;
			if (
				task.status === "in_progress" &&
				current === undefined &&
				"content" in task &&
				typeof task.content === "string"
			) {
				current = task.content;
			}
		}
	}
	return current === undefined ? { done, total } : { done, total, current };
}

export interface SessionMismatchInfo {
	originKey: string;
	threadRef: string; // thread of the message whose turn (or command) opened the session
	/** The file to resume: `/resume-jabbu`'s pin, else the newest session of the epoch dir before the child started. */
	expected: string;
	actual: string; // the file the child reported as open
}

/** Outcome of `openOriginSession`: `mismatch` only when both files are known and resolve to different paths. */
export type SessionOpenCheck =
	| { mismatch: true; expected: string; actual: string }
	| { mismatch: false; expected: string | undefined; actual: string | undefined };

export interface ActiveTurn {
	opRef: string;
	threadRef: string; // replies go to the thread of the message that started the turn
	/** Set when a peer bot's message started the turn: its failure notice goes back to that bot. */
	peer: TurnPeer | undefined;
	startedAt: number;
	/**
	 * Priced cost of this turn's own assistant calls so far. The turn ceiling judges `costUsd + subAgentUsd`; the
	 * daily ledger falls back to this own-session total alone, so the sub-agent part is counted once (from files).
	 */
	costUsd: number;
	/** Priced cost of the turn's sub-agent transcripts inside its window, re-read on messages and `task` ends. */
	subAgentUsd: number;
	/** `(size, mtimeMs)` and calls of those transcripts, so a re-read parses only what changed. */
	subAgentCache: SubAgentCostCache;
	/** The session file found for `subAgentUsd`, so later re-reads do not ask the driver again. */
	subAgentSessionFile: string | undefined;
	/** The turn reached `turnUsd` and its thread got the warning: once per turn. */
	costSoftSent: boolean;
	/**
	 * Set when the turn was aborted at 3x `turnUsd`: its own `aborted` final settles the turn with this reason
	 * (`cost_cap: …`) and no failure count. No second abort.
	 */
	costStopReason: string | undefined;
	/** The turn's spend is already in `usage_daily` (`#recordDailyCost`): a turn is charged once, by its final or its exit. */
	costRecorded: boolean;
	/** Leaf read right before the prompt; the turn's answers are the entries after it. */
	entryCursor: string | null;
	/** Child sent this turn's final while `#onFinal` waits on the actor chain; steers defer to next drain. */
	finalArrived: boolean;
	/** Stalls of this turn (one per silence); the first logs `stall_alert`, the rest `stall_repeat`. */
	stallCount: number;
	/** Silence of the turn's stalls that have ended (an event arrived); the running one is added on the fly. */
	stallSilentMs: number;
	/** `onStall(stalled: true)` was sent and not yet released. */
	stallShown: boolean;
	/** When the last stall ended; the status text is released `STALL_RELEASE_MS` after it without a new stall. */
	stallClearedAt: number;
	/** The owner was asked (or the abort was started) for this turn: never twice. */
	stallEscalated: boolean;
	/**
	 * The prompt yielded but its session is not settled: the turn waits for runs omp opens on its own (a background job
	 * finished). That silence is no stall; the driver caps it (`TAIL_WAIT_MS`).
	 */
	tailWaiting: boolean;
	/** `onProviderLimit` fired for this turn: never twice. */
	providerLimitSeen: boolean;
	/** Tool repeat-loop counts of this turn (reset per turn). */
	stuck: StuckDetector;
	/** What the status message shows (`onProgress`). */
	progress: TurnProgress;
	/** What the turn is writing right now (dashboard `live` op); goes with the turn object, so every turn end clears it. */
	live: LiveTurn;
	/** Texts this turn already sent as interim deliveries, in order (`<opRef>:interim:<index>`). */
	interim: string[];
	/**
	 * The HEADs of `turnHeads.headRepos()` right before the prompt (the wiki turn notes): absent when none is configured
	 * or this turn is not a conversation turn. The after-state is read in `#onFinal`.
	 */
	headsBefore?: ReadonlyMap<string, string>;
	pendingAnswer: string | undefined;
	/** Pending owner rows the drain held back because the turn is at `MAX_STEERS` (they never answer a dialog card). */
	capDeferred: Set<string>;
	/** Prompt cache miss notice timing; undefined until first miss. */
	lastInterimDeliveredAt: number | undefined;
	/** Effective `provider/id` model of this turn when known. */
	model?: string;
}

/**
 * The session file the next child open should resume: the file pinned by `/resume-jabbu`, else the newest session of
 * the origin's session dir (undefined for an empty or missing dir). Read it before the child starts — a started child
 * may already have created a new file in the dir.
 */
export function sessionToResume(origin: OriginRow): string | undefined {
	if (origin.sessionFile !== null) return origin.sessionFile;
	return existsSync(origin.sessionDir) ? newestSessionFile(origin.sessionDir) : undefined;
}

/**
 * Binds the origin's session in a started driver: the file pinned by `/resume-jabbu`, else the newest session of the
 * origin's session dir. Recovery uses the same rule so it reads the session the turn ran in. Then compares the file
 * the child reports as open with `expected` (`sessionToResume`, read before start); no verdict when either is unknown.
 */
export async function openOriginSession(
	driver: OmpSessionDriver,
	origin: OriginRow,
	expected: string | undefined,
): Promise<SessionOpenCheck> {
	if (origin.sessionFile === null) {
		await driver.openSession();
	} else {
		const { cancelled } = await driver.switchSession(origin.sessionFile);
		if (cancelled) throw new OmpDriverError("rpc_error", `switch_session cancelled: ${origin.sessionFile}`);
	}
	const actual = (await driver.state()).sessionFile;
	if (expected !== undefined && actual !== undefined && resolve(expected) !== resolve(actual)) {
		return { mismatch: true, expected, actual };
	}
	return { mismatch: false, expected, actual };
}

export const MAX_LISTED = 30;
export const preview = (text: string): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 50 ? `${flat.slice(0, 50)}…` : flat;
};
export const minutes = (ms: number): string => `${Math.max(0, Math.round(ms / 60_000))}분`;

export interface MailboxState {
	originKey: string;
	driverRunning: boolean;
	busy: boolean;
	/** Thread of the running turn's lead message; absent when no turn runs. */
	threadRef?: string;
}

/** What `pauseTurn` re-read after stopping the turn: each false item is named in the owner's answer. */
export interface PauseCheck {
	/** The mailbox still had a turn when the check ran. */
	busy: boolean;
	/** The driver (when one is running) reported no streaming and no queued message left (`OmpState.settled`). */
	settled: boolean;
}

/**
 * What the moved mailbox parts (`mailbox-cost.ts`, `mailbox-commands.ts`) read and call on the
 * `OriginMailbox` that owns them; every accessor reads the mailbox's live field, so no state is copied.
 */
export interface MailboxHost {
	readonly deps: MailboxDeps;
	turn(): ActiveTurn | undefined;
	driver(): OmpSessionDriver | undefined;
	background(event: string, task: () => Promise<void>): void;
	onFinal(driver: OmpSessionDriver, final: OmpFinal, stopFirst?: boolean): Promise<void>;
	ensureDriver(threadRef: string): Promise<OmpSessionDriver>;
	stopDriver(): Promise<void>;
	/** A session change (`/resume`) starts a fresh prompt-cache monitor. */
	resetCache(): void;
	markCompacted(): void;
	frozenHold(row: InboundRow): boolean;
	/** `/queue retry`: the command's end runs a drain so the row it made pending goes out. */
	requestRedrain(): void;
	/** Reason queued turns are held by a provider quota limit; absent when open. */
	quotaHoldReason(): string | undefined;
}
