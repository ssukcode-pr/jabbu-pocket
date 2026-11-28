import { join } from "node:path";
import { errorFields } from "../channel/text";
import { isTaskOrigin } from "../lanes/status";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { alreadySent, closingAnswer, interimOf, NO_ANSWER, turnAnswerParts } from "../omp/answers";
import {
	OmpDriverError,
	type OmpEntry,
	type OmpEvent,
	type OmpExitInfo,
	type OmpFinal,
	type OmpSessionDriver,
	type OmpState,
} from "../omp/driver";
import { TAIL_WAIT_END_EVENT, TAIL_WAIT_START_EVENT } from "../omp/rpc-driver";
import { type HealedSessionModel, healSessionModelFile, newestSessionFile } from "../omp/session-heal";
import { childRestartCause, type SpawnSnapshot, spawnSnapshot } from "../ops/cache-miss-cause";
import {
	CACHE_MISS_NOTIFY_MS,
	CACHE_MISS_NOTIFY_TOKENS,
	type CacheBaseline,
	type CacheCall,
	CacheMonitor,
	cacheCallOf,
} from "../ops/cache-monitor";
import { COST_CAP_STOP_PREFIX, messageCost } from "../ops/cost-cap";
import { captureHeads } from "../ops/turn-heads";
import { byteLength, redact } from "../redact";
import { injectionWarning, scanForInjection } from "../safety/injection";
import { peerTouchedTurnNotice } from "../safety/prompt";
import type { InboundRow } from "../store/db-rows";
import { typicalTurnDuration } from "../store/turn-duration";
import { classifyFailure } from "./failure-kind";
import { type IdleKeepDeps, IdleKeeper, type IdleSweepContext } from "./idle-keep";
import { newActiveTurn } from "./mailbox-active-turn";
import {
	coldResumeContextBlock,
	noticeColdResumeRotated,
	rotateOnColdResume,
	warnColdCache,
} from "./mailbox-cold-resume";
import { askBtw, commandReply, startBrief, waitingRows } from "./mailbox-commands";
import { ContextMemory, type LiveViewWithContext } from "./mailbox-context";
import { judgeTurnCost, recordDailyCost, refreshSubAgentCost } from "./mailbox-cost";
import { toolActivityText } from "./mailbox-helpers";
import {
	failedNotice,
	NO_MODEL_NOTICE,
	NO_MODEL_SIGN,
	NOTHING_TO_STOP_TEXT,
	OWNER_STOP_ERROR,
	OWNER_STOPPED_TEXT,
	STEER_BEFORE_ANSWER_SEEN_NOTE,
	turnPeerOf,
} from "./mailbox-notices";
import { markOrPark, parkUncertain } from "./mailbox-park";
import { purposeBlockOf, runPurposeCommand, setHome } from "./mailbox-purpose";
import {
	beginSend,
	parkInterruptedSends,
	REFUSED_OP_PREFIX,
	settleFailedSend,
	settleTimedOutSend,
} from "./mailbox-sending";
import {
	applyOriginSettings,
	effectiveOriginSettings,
	healStaleSessionModel,
	isPickerCommand,
	runPickerCommand,
} from "./mailbox-settings";
import {
	OWN_ANSWER_LINE,
	ownerThreadRootBlock,
	peerThreadContextBlock,
	RECALL_CANDIDATE_LIMIT,
	rotationContextBlock,
	THREAD_ANSWER_LINE,
	THREAD_CONTEXT_TIMEOUT_MS,
	type ThreadSource,
	threadContextBlock,
} from "./mailbox-thread-context";
import type {
	ActiveTurn,
	MailboxDeps,
	MailboxHost,
	MailboxState,
	PauseCheck,
	SessionOpenCheck,
	StallEscalation,
} from "./mailbox-types";
import {
	DEFAULT_ESCALATE_AFTER,
	failureSign,
	isAutonomousRow,
	isModelFailureSign,
	isProviderLimit,
	MAX_STEERS,
	minutes,
	openOriginSession,
	RECENT_TOOLS,
	sessionToResume,
	todoProgress,
} from "./mailbox-types";
import { parseThreadRef, TOP_LEVEL_TS } from "./normalize";
import { parseChatOrigin } from "./origin-key";
import { buildRecallBlock } from "./recall";
import { epochDirIsFresh } from "./sessions";
import { stuckCancelReason, stuckSteerText } from "./stuck";
import { readLastAssistantEntry, tryCloseToolFreeFromFile } from "./tool-free-recovery";
import {
	composeTurnPrompt,
	EVENT_PERSIST_MS,
	IDLE_STOP_MS,
	type InboundRecord,
	isHomeCommand,
	MONITOR_IDLE_STOP_MS,
	MONITOR_STALL_ABORT_MS,
	type ParsedCommand,
	parseCommand,
	parsePurposeCommand,
	STALL_MS,
	STALL_NOTIFY_COUNT,
	STALL_NOTIFY_MS,
	STALL_RELEASE_MS,
} from "./types";

export type {
	BoardNotice,
	CacheMissInfo,
	ColdCacheInfo,
	DriverFactory,
	MailboxDeps,
	PauseCheck,
	ProviderLimitInfo,
	RecentTool,
	SessionMismatchInfo,
	StallEscalation,
	StuckLoopInfo,
	TurnFailureEscalation,
	TurnProgress,
	TurnSettledInfo,
} from "./mailbox-types";
export { isAutonomousRow, isProviderLimit, openOriginSession, sessionToResume } from "./mailbox-types";

/** `cacheCallOf` for a session entry, or `undefined` when it carries no usable call. */
function seedCallOf(entry: OmpEntry | undefined): CacheCall | undefined {
	const stamp = entry?.timestamp;
	const at = typeof stamp === "string" ? Date.parse(stamp) : typeof stamp === "number" ? stamp : Number.NaN;
	return Number.isNaN(at) ? undefined : cacheCallOf(entry?.message, at);
}

/** Head + tail of a long failure reason, with an explicit marker for the dropped middle: the head names the failing
 * call, the tail carries the cause. Short text passes through unchanged; the 8 KiB log-line cap (`src/log.ts`) is
 * the bound, so callers do not slice further. Classification still uses the full text (`classifyReason`). */
const REASON_HEAD_CHARS = 1000;
const REASON_TAIL_CHARS = 1000;
/**
 * Ledger cursor holding the epoch whose driver rotation is still owed its context: the durable half of
 * `#rotatedSession`, so a daemon restart between the rotation and the next turn keeps the flag.
 */
const ROTATION_CURSOR_PREFIX = "rotation:";
const rotationCursorKey = (originKey: string): string => `${ROTATION_CURSOR_PREFIX}${originKey}`;

function headTailReason(text: string): string {
	const chars = [...text];
	if (chars.length <= REASON_HEAD_CHARS + REASON_TAIL_CHARS) return text;
	const dropped = chars.length - REASON_HEAD_CHARS - REASON_TAIL_CHARS;
	return `${chars.slice(0, REASON_HEAD_CHARS).join("")}…[truncated ${dropped} chars]…${chars.slice(-REASON_TAIL_CHARS).join("")}`;
}

/** Serial actor per origin: processes inbound messages, driver finals, and exits on one promise chain. */
export class OriginMailbox {
	readonly #deps: MailboxDeps & IdleKeepDeps;
	readonly #idle: IdleKeeper;
	readonly #host: MailboxHost;
	readonly #idleStopMs: number;
	#tail: Promise<unknown> = Promise.resolve();
	#driver: OmpSessionDriver | undefined;
	#activeModel: string | undefined;
	readonly #context = new ContextMemory();
	#unsubscribe: Array<() => void> = [];
	#turn: ActiveTurn | undefined;
	/** `#startTurn` calls in flight: the child spawn and ready wait come before `#turn` is set. */
	#starting = 0;
	#lastActivityAt: number;
	#lastEventAt = 0;
	/** When the running turn's last event was written to the ledger (throttled by EVENT_PERSIST_MS). */
	#eventPersistedAt = 0;
	#stalled = false;
	/** True until the first prompt of a freshly created session (`openSession` resumed=false): the one turn that may carry injected thread context. */
	#freshSession = false;
	/** The driver dropped a full conversation after the last turn (agy rotation): the next prompt re-feeds the thread. */
	#rotatedSession = false;
	/** Whether the live child already knows about peer taint or has no host tools. */
	#skipPeerNotice = false;
	/** Host tool calls (approval wait, upload, dispatch) running for this origin's child; no omp events come meanwhile. */
	#hostToolsRunning = 0;
	#stopAfterTurn = false; // set by `stopWhenIdle()` while a turn runs: the child is stopped once that turn has settled
	#redrain = false; // set by `/queue retry`: the command's end runs a drain so the row it made pending goes out
	readonly #turnEndWaiters: Array<() => void> = []; // `whenTurnEnds` callers, woken where the turn is dropped (final, exit, `/new`)
	#acceptingDispatch = true; // cleared at shutdown (`stopDispatching`): pending rows stay pending, the drain awaits running turns only
	#consecFailures = 0; // failed turns in a row; a completed turn resets it
	readonly #mismatchNoticed = new Set<number>();
	#cache = new CacheMonitor();
	#cacheNoticedAt: number | undefined;
	#coldWarned: CacheBaseline | undefined;
	/** Set by a cold-resume rotation: the turn's first prompt re-feeds the previous epoch (`coldResumeContextBlock`). */
	#coldResume: { previousEpoch: number; previousFile: string | undefined } | undefined;
	/** The session file's digests when the live child was spawned: `child_restart` misses name their cause from it. */
	#spawn: SpawnSnapshot | undefined;

	constructor(deps: MailboxDeps & IdleKeepDeps) {
		this.#deps = deps;
		this.#host = {
			deps,
			turn: () => this.#turn,
			driver: () => this.#driver,
			background: (event, task) => this.#background(event, task),
			onFinal: (driver, final, stopFirst) => this.#onFinal(driver, final, stopFirst),
			ensureDriver: (threadRef) => this.#ensureDriver(threadRef),
			stopDriver: () => this.#stopDriver(),
			resetCache: () => {
				this.#cache = new CacheMonitor();
			},
			markCompacted: () => this.#cache.markCompacted(),
			frozenHold: (row) => this.#frozenHold(row),
			requestRedrain: () => {
				this.#redrain = true;
			},
			quotaHoldReason: () => deps.quotaHoldReason?.(),
		};
		const idleStopMs = deps.idleStopMs ?? IDLE_STOP_MS;
		// A monitor child is released after MONITOR_IDLE_STOP_MS (or the shorter configured value); 0 still disables.
		this.#idleStopMs =
			deps.originKey.startsWith(MONITOR_ORIGIN_PREFIX) && idleStopMs > 0
				? Math.min(idleStopMs, MONITOR_IDLE_STOP_MS)
				: idleStopMs;
		this.#lastActivityAt = deps.clock.now();
		this.#idle = new IdleKeeper(deps, {
			due: () =>
				!!this.#driver &&
				!this.#turn &&
				this.#idleStopMs > 0 &&
				deps.clock.now() - this.#lastActivityAt >= this.#idleStopMs,
			since: () => this.#lastActivityAt,
			state: () => this.#driver?.state(),
			stop: () => this.#stopDriver(),
		});
	}

	/** A turn runs, or its child is still being opened and prompted (a restart drain waits for both). */
	get turnPending(): boolean {
		return this.#turn !== undefined || this.#starting > 0;
	}

	get state(): MailboxState {
		const turn = this.#turn;
		return {
			originKey: this.#deps.originKey,
			driverRunning: this.#driver !== undefined,
			busy: turn !== undefined,
			...(turn === undefined ? {} : { threadRef: turn.threadRef }),
		};
	}

	/** Record the message (idempotent on platformMessageId) and dispatch it. Resolves when it has been handled. */
	enqueue(record: InboundRecord): Promise<void> {
		return this.#serial(() => this.#handle(record));
	}

	/**
	 * Stops the origin's running turn for an owner hold (a paused lane): the child is aborted and the turn settles
	 * through the normal final path with `error: "lane_paused"` (no failure notice, no failure count). Safe to call
	 * again — a turn that survived the first abort or a queued message omp started on its own is aborted once more.
	 * Resolves with the re-read state, which is all the owner is told on.
	 */
	pauseTurn(): Promise<PauseCheck> {
		return this.#serial(async () => {
			const { originKey, log } = this.#deps;
			const driver = this.#driver;
			if (driver !== undefined) {
				const turn = this.#turn;
				// An abort that failed may leave the run going: stop the child before the drain, like
				// `#abortTurnWith` does, so the next turn never starts on the wedged child.
				let abortFailed = false;
				try {
					await driver.abort();
				} catch (error) {
					abortFailed = true;
					log.warn("pause_abort_failed", { origin: originKey, opRef: turn?.opRef, error: String(error) });
				}
				if (turn !== undefined && this.#turn === turn && this.#driver === driver) {
					const final: OmpFinal = { opRef: turn.opRef, status: "aborted", text: "", error: "lane_paused" };
					await this.#onFinal(driver, final, abortFailed);
				}
			}
			const settled = this.#driver === undefined || (await this.#driver.state()).settled !== false;
			return { busy: this.#turn !== undefined, settled };
		});
	}

	/**
	 * Startup recovery: dispatch rows already in the ledger as `pending` (their thread comes from the row); a `sending`
	 * row (a send cut before its outcome was recorded) is parked as `uncertain`, never sent again. Resolves when drained.
	 */
	resumePending(): Promise<void> {
		return this.#serial(() => {
			this.#deps.store.ensureOrigin(this.#deps.originKey, this.#deps.sessionDirFor(this.#deps.originKey, 1));
			parkInterruptedSends(this.#deps.store, this.#deps.log, this.#deps.originKey);
			this.#lastActivityAt = this.#deps.clock.now();
			this.#stopAfterTurn = false;
			return this.#drain();
		});
	}

	/** Stop the omp child when it has rested for `idleStopMs` and `IdleKeeper` finds a reason to (`idle-keep.ts`). */
	sweepIdle(ctx: IdleSweepContext = {}): Promise<boolean> {
		return this.#serial(() => this.#idle.sweep(ctx));
	}

	/** `since` of a due conversation child the router may release under host pressure; `undefined` otherwise (a read). */
	idleCandidate(): number | undefined {
		return this.#idle.candidate();
	}

	/** Stops a child that is still a pressure candidate. Returns whether it stopped. */
	stopForPressure(): Promise<boolean> {
		return this.#serial(() => this.#idle.pressureStop());
	}

	/**
	 * Reports a running turn that has emitted no omp event for `STALL_MS`, and re-reads its sub-agent transcripts so a quiet turn whose sub-agent is spending still gets judged against the turn cap. Synchronous and clock-driven, so the daemon
	 * sweep and fake-clock tests both call it; returns whether a new stall just began. Never while a host tool runs
	 * (the child waits on jabbu, not its model) and never during a `tailWaiting` wait (that wait is expected).
	 * Stalls of one turn merge: the first logs `stall_alert` and shows the stalled text; later ones log `stall_repeat`
	 * (count, totalSilentMs) and leave the text alone until `STALL_RELEASE_MS` of calm. Every call also judges the
	 * accumulated silence: a conversation turn past the threshold asks the owner once (never aborted), a monitor turn
	 * past its threshold is aborted and failed.
	 */
	checkStall(): boolean {
		const turn = this.#turn;
		if (!turn || this.#hostToolsRunning > 0 || turn.tailWaiting) return false;
		const { originKey, log, onStall, clock } = this.#deps;
		const now = clock.now();
		const silentMs = now - this.#lastEventAt;
		let began = false;
		if (!this.#stalled && silentMs >= STALL_MS) {
			this.#stalled = true;
			began = true;
			turn.stallCount += 1;
			if (turn.stallCount === 1) log.warn("stall_alert", { origin: originKey, silentMs, opRef: turn.opRef });
			else {
				log.info("stall_repeat", {
					origin: originKey,
					silentMs,
					opRef: turn.opRef,
					count: turn.stallCount,
					totalSilentMs: turn.stallSilentMs + silentMs,
				});
			}
			if (!turn.stallShown) {
				turn.stallShown = true;
				onStall?.({ originKey, threadRef: turn.threadRef, stalled: true, silentMs });
			}
		} else if (!this.#stalled && turn.stallShown && now - turn.stallClearedAt >= STALL_RELEASE_MS) {
			turn.stallShown = false;
			log.info("stall_released", { origin: originKey, opRef: turn.opRef, count: turn.stallCount });
			onStall?.({ originKey, threadRef: turn.threadRef, stalled: false, silentMs });
		}
		this.#judgeStall(turn, now);
		refreshSubAgentCost(this.#host, turn);
		return began;
	}

	/** Owner DM (conversation) or abort (monitor) once a turn's stalls pass the configured threshold; once per turn. */
	#judgeStall(turn: ActiveTurn, now: number): void {
		if (turn.stallEscalated || turn.stallCount === 0) return;
		const { originKey, log, onStallEscalate } = this.#deps;
		const totalSilentMs = turn.stallSilentMs + (this.#stalled ? now - this.#lastEventAt : 0);
		const monitor = originKey.startsWith(MONITOR_ORIGIN_PREFIX);
		const over = monitor
			? totalSilentMs >= MONITOR_STALL_ABORT_MS
			: turn.stallCount >= STALL_NOTIFY_COUNT || totalSilentMs >= STALL_NOTIFY_MS;
		if (!over) return;
		turn.stallEscalated = true;
		const kind = monitor ? "abort" : "notify";
		const info: StallEscalation = {
			originKey,
			threadRef: turn.threadRef,
			opRef: turn.opRef,
			kind,
			count: turn.stallCount,
			totalSilentMs,
		};
		log.warn("stall_escalated", { origin: originKey, opRef: turn.opRef, kind, count: info.count, totalSilentMs });
		onStallEscalate?.(info);
		// driver.abort() failures are caught inside (`stall_abort_failed`); what escapes is settling the turn.
		if (monitor) this.#background("stall_abort_settle_failed", () => this.#abortStalled(turn, totalSilentMs));
	}

	/**
	 * Aborts the turn's child and settles the turn as failed with `error` through the normal failure path
	 * (`recordTurnFailure` → monitor event failed with retry/backoff); a final that settled the turn first wins, this
	 * then does nothing. `stopFirst` stops the child before the drain; an abort that failed may leave it running, so
	 * that also stops it, before an answer could arrive after the failure notice. `warnEvent` names a refused abort.
	 */
	async #abortTurnWith(turn: ActiveTurn, error: string, stopFirst: boolean, warnEvent: string): Promise<void> {
		const driver = this.#driver;
		if (!driver || this.#turn !== turn) return;
		let abortFailed = false;
		try {
			await driver.abort();
		} catch (abortError) {
			abortFailed = true;
			this.#deps.log.warn(warnEvent, { origin: this.#deps.originKey, opRef: turn.opRef, error: String(abortError) });
		}
		if (this.#turn !== turn || this.#driver !== driver) return;
		await this.#onFinal(driver, { opRef: turn.opRef, status: "aborted", text: "", error }, stopFirst || abortFailed);
	}

	/**
	 * Monitor turn that stayed silent too long: abort the child and settle the turn as failed. The child is stopped
	 * afterwards — it was wedged, and a monitor's next fire starts a fresh session anyway.
	 */
	async #abortStalled(turn: ActiveTurn, totalSilentMs: number): Promise<void> {
		await this.#abortTurnWith(turn, `stall_abort silent=${minutes(totalSilentMs)}`, true, "stall_abort_failed");
	}

	/**
	 * Turn caught in a tool repeat loop: abort the child and settle the turn as failed (`stuck-loop: ...`). The child is
	 * kept — not wedged, its session holds the conversation — unless the abort itself failed: then it is stopped
	 * before the drain.
	 */
	async #abortStuck(turn: ActiveTurn, toolName: string, count: number): Promise<void> {
		if (!this.#driver || this.#turn !== turn) return;
		const { originKey, log } = this.#deps;
		log.warn("stuck_loop_cancel", { origin: originKey, opRef: turn.opRef, tool: toolName, count });
		this.#deps.onStuckLoop?.({ originKey, threadRef: turn.threadRef, opRef: turn.opRef, toolName, count });
		await this.#abortTurnWith(turn, stuckCancelReason(toolName, count), false, "stuck_abort_failed");
	}

	/**
	 * Adds one assistant call's price to the running turn, judges the turn with what is known now, and re-reads the
	 * turn's sub-agent transcripts off the actor's chain (a sub-agent may be spending while this session is quiet). The
	 * judgement is repeated after that read, so a total crossing the ceiling only through sub-agents still warns and stops.
	 */
	#accrueTurnCost(turn: ActiveTurn, message: unknown): void {
		turn.costUsd += messageCost(message);
		judgeTurnCost(this.#host, turn);
		refreshSubAgentCost(this.#host, turn);
	}

	/**
	 * Feeds a tool event to the turn's loop detector. Only `tool_execution_end` carries the result, so a driver that
	 * reports `tool_execution_start` only never trips it.
	 */
	#observeTool(turn: ActiveTurn, event: OmpEvent): void {
		const { originKey, log } = this.#deps;
		let hit: ReturnType<typeof turn.stuck.observe>;
		try {
			hit = turn.stuck.observe(event);
		} catch (error) {
			// A detector that cannot read an event must not turn a healthy turn into a protocol failure.
			log.warn("stuck_observe_failed", { origin: originKey, opRef: turn.opRef, error: String(error) });
			return;
		}
		if (hit === null) return;
		if (hit.action === "cancel") {
			this.#background("stuck_abort_settle_failed", () => this.#abortStuck(turn, hit.toolName, hit.count));
			return;
		}
		log.info("stuck_loop_steer", { origin: originKey, opRef: turn.opRef, tool: hit.toolName, count: hit.count });
		this.#background("stuck_steer_failed", async () => {
			// Real omp starts a run when steered while idle: only steer the turn that is still running. A turn
			// whose final already arrived is idle too — the final's own settlement may still be queued behind us.
			if (this.#turn !== turn || !this.#driver || turn.finalArrived) return;
			await this.#driver.steer(stuckSteerText(hit.toolName, hit.count));
		});
	}

	/** Host tool calls of this origin's child running now. */
	get hostToolsRunning(): number {
		return this.#hostToolsRunning;
	}

	/**
	 * Runs one host tool call of this origin's child: stall detection rests while it runs, and its end counts as turn
	 * activity, so the silence measured afterwards starts when the tool returned.
	 */
	async trackHostTool<T>(run: () => Promise<T>): Promise<T> {
		this.#hostToolsRunning += 1;
		try {
			return await run();
		} finally {
			this.#hostToolsRunning -= 1;
			this.#lastEventAt = this.#deps.clock.now();
		}
	}

	/**
	 * omp's retry/fallback session events. They return before the stall clock is touched: a retry loop that never
	 * produces output must still count as silence (2026-11-02: six hours of retries hid behind a refreshed clock).
	 */
	#onRetryEvent(event: OmpEvent): boolean {
		const { log, originKey } = this.#deps;
		if (event.type === "retry_fallback_applied") {
			const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
			log.info("retry_fallback_applied", {
				origin: originKey,
				from: text(event.from),
				to: text(event.to),
				reason: text(event.reason),
			});
			return true;
		}
		let errorMessage: unknown;
		let maxAttempts = 0;
		if (event.type === "auto_retry_start") {
			errorMessage = event.errorMessage;
			maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : 0;
			const retrying = this.#turn;
			if (retrying && typeof event.attempt === "number" && event.attempt > retrying.progress.retries) {
				retrying.progress.retries = event.attempt;
				this.#reportProgress(retrying);
			}
		} else if (event.type === "auto_retry_end") {
			errorMessage = event.success === false ? event.finalError : undefined;
		} else {
			return false;
		}
		const turn = this.#turn;
		if (typeof errorMessage !== "string" || !isProviderLimit(errorMessage) || !turn || turn.providerLimitSeen)
			return true;
		turn.providerLimitSeen = true;
		const attempt = typeof event.attempt === "number" ? event.attempt : 0;
		log.warn("provider_limit_hit", { origin: originKey, attempt, error: headTailReason(redact(errorMessage)) });
		this.#deps.onProviderLimit?.({ originKey, threadRef: turn.threadRef, attempt, maxAttempts, errorMessage });
		return true;
	}

	/** The running turn's opRef; undefined between turns. */
	get turnOpRef(): string | undefined {
		return this.#turn?.opRef;
	}

	/** What the running turn is writing now (dashboard `live` op); null without a turn or with nothing in flight. */
	liveView(): LiveViewWithContext | null {
		return this.#context.attach(this.#turn?.live.view() ?? null);
	}

	/**
	 * The session file the running child reports as open (`jabbu-pocket lanes watch`); undefined without a child or when it
	 * reports none. Only reads `state()`: never queued behind the running turn, never starts a child.
	 */
	async openSessionFile(): Promise<string | undefined> {
		const driver = this.#driver;
		return driver === undefined ? undefined : (await driver.state()).sessionFile;
	}

	/**
	 * The live child's state for `!status` (context use); undefined without a child. Off the serial chain like
	 * `openSessionFile`: `!status` asks from inside it, and `get_state` changes nothing while a turn runs.
	 */
	driverState(): Promise<OmpState | undefined> {
		return this.#driver?.state() ?? Promise.resolve(undefined);
	}

	#onDriverEvent(event: OmpEvent): void {
		const turn = this.#turn;
		turn?.live.feed(event);
		if (this.#onRetryEvent(event)) return;
		const waiting = event.type === TAIL_WAIT_START_EVENT;
		if (turn !== undefined && turn.opRef === event.opRef && (waiting || event.type === TAIL_WAIT_END_EVENT)) {
			turn.tailWaiting = waiting;
			// A nudge after the wait must not count the silence from before it.
			if (!waiting) turn.stallClearedAt = this.#deps.clock.now();
		}
		if (event.type === "auto_compaction_end") this.#cache.markCompacted();
		if (event.type === "message_end") this.#observeCache(event.message);
		if (event.type === "message_end" && turn) this.#accrueTurnCost(turn, event.message);
		// A `task` result is where sub-agent spend lands: re-read before the turn goes on, so the cap sees it.
		if (event.type === "tool_execution_end" && event.toolName === "task" && turn) refreshSubAgentCost(this.#host, turn);
		if (turn && (event.type === "tool_execution_start" || event.type === "tool_execution_end")) {
			this.#observeTool(turn, event);
		}
		if (turn) this.#sendInterimOf(turn, event);
		if (event.type === "tool_execution_start") {
			const tool = typeof event.toolName === "string" ? event.toolName : undefined;
			this.#deps.log.info("tool_start", { origin: this.#deps.originKey, tool });
			// Held (a paused lane) and no turn of ours: a queued message omp started on its own — work while paused.
			if (tool !== undefined && turn === undefined && this.#deps.isHeld?.()) {
				this.#deps.onHeldWork?.({ originKey: this.#deps.originKey });
				return;
			}
			if (tool !== undefined && turn) {
				turn.progress.tools += 1;
				turn.progress.recentTools = [
					...turn.progress.recentTools,
					{
						text: toolActivityText(tool, event.args, event.intent),
						...(typeof event.toolCallId === "string" ? { callId: event.toolCallId } : {}),
						state: "running" as const,
						startedAt: this.#deps.clock.now(),
					},
				].slice(-RECENT_TOOLS);
				this.#reportProgress(turn);
			}
		}
		if (event.type === "tool_execution_end" && typeof event.toolCallId === "string" && turn) {
			const entry = turn.progress.recentTools.find((tool) => tool.callId === event.toolCallId);
			if (entry !== undefined) {
				entry.state = event.isError === true ? "error" : "ok";
				entry.endedAt = this.#deps.clock.now();
				this.#reportProgress(turn);
			}
		}
		if (event.type === "tool_execution_end" && event.toolName === "todo" && event.isError !== true && turn) {
			const todo = todoProgress(event.result);
			if (todo !== undefined) {
				turn.progress.todo = todo;
				this.#reportProgress(turn);
			}
		}
		const now = this.#deps.clock.now();
		const silentMs = now - this.#lastEventAt;
		this.#lastEventAt = now;
		if (turn && now - this.#eventPersistedAt >= EVENT_PERSIST_MS) {
			this.#eventPersistedAt = now;
			this.#deps.store.touchDispatched(this.#deps.originKey, turn.opRef);
		}
		if (!this.#stalled || !turn) return;
		this.#stalled = false;
		turn.stallSilentMs += silentMs;
		turn.stallClearedAt = now;
		this.#deps.log.info("stall_cleared", {
			origin: this.#deps.originKey,
			silentMs,
			opRef: turn.opRef,
			count: turn.stallCount,
		});
	}

	/**
	 * Classifies one assistant call's prompt cache use. Every miss is logged; a large restart-caused or unexplained miss
	 * of a conversation turn is told to the owner once per origin per `CACHE_MISS_NOTIFY_MS`.
	 */
	#observeCache(message: unknown): void {
		const { originKey, log, clock } = this.#deps;
		const call = cacheCallOf(message, clock.now());
		if (call === undefined) return;
		const miss = this.#cache.observe(call);
		if (miss === undefined) return;
		log.info("cache_miss", {
			origin: originKey,
			reason: miss.reason,
			missed: miss.missedTokens,
			cacheWrite: miss.cacheWrite,
			costCacheWrite: miss.costCacheWrite,
			gapSec: Math.round(miss.gapMs / 1000),
			model: call.model,
			...(miss.reason === "child_restart" && this.#spawn !== undefined ? childRestartCause(this.#spawn) : {}),
		});
		const turn = this.#turn;
		if (
			turn === undefined ||
			originKey.startsWith(MONITOR_ORIGIN_PREFIX) ||
			(miss.reason !== "child_restart" && miss.reason !== "unexplained") ||
			miss.missedTokens < CACHE_MISS_NOTIFY_TOKENS ||
			(this.#cacheNoticedAt !== undefined && call.at - this.#cacheNoticedAt < CACHE_MISS_NOTIFY_MS)
		) {
			return;
		}
		this.#cacheNoticedAt = call.at;
		this.#deps.onCacheMiss?.({ ...miss, originKey, threadRef: turn.threadRef, model: call.model });
	}

	/** Seeds an empty cache baseline from the session's last assistant entry (a new mailbox after a daemon restart). */
	async #seedCache(driver: OmpSessionDriver, sessionFile?: string): Promise<void> {
		if (this.#cache.baseline !== undefined) return;
		try {
			// The session file's tail holds the same last assistant entry the full history would give, without the transfer.
			const tail = sessionFile === undefined ? undefined : readLastAssistantEntry(sessionFile);
			const last =
				tail ?? (await driver.entriesSince()).entries.findLast((entry) => entry.message?.role === "assistant");
			const call = seedCallOf(last);
			if (call !== undefined) this.#cache.seed(call);
		} catch (error) {
			this.#deps.log.warn("cache_seed_failed", { origin: this.#deps.originKey, error: String(error) });
		}
	}

	/**
	 * Interim delivery of a running conversation turn (never a monitor's: its answer is machine-read at the turn end).
	 * A note next to a `wait` call goes out at its `message_end`. A stop-ended answer waits for the next message or tool
	 * call — proof the turn goes on (rule-guards continuation, incomplete-items reminder) — so a turn's last answer
	 * still goes out at the turn end under the turn's op ref. The wait-start for an unsettled session (`tail_wait_start`)
	 * is such proof too: the prompt's answer goes out now, not after the background work.
	 */
	#sendInterimOf(turn: ActiveTurn, event: OmpEvent): void {
		if (this.#deps.originKey.startsWith(MONITOR_ORIGIN_PREFIX) || isTaskOrigin(this.#deps.originKey)) return;
		const flushes = ["message_start", "message_end", "tool_execution_start", TAIL_WAIT_START_EVENT];
		if (!flushes.includes(event.type)) return;
		const pending = turn.pendingAnswer;
		turn.pendingAnswer = undefined;
		if (pending !== undefined && this.#recordInterim(turn, pending))
			turn.lastInterimDeliveredAt = this.#deps.clock.now();
		if (event.type !== "message_end") return;
		const interim = interimOf(event.message);
		if (interim?.kind === "answer") turn.pendingAnswer = interim.text;
		else if (interim?.kind === "waitNote") this.#recordInterim(turn, interim.text);
	}

	/**
	 * One interim delivery, unless the turn already sent this text (equal up to whitespace or nearly the same).
	 * Returns whether a delivery row was recorded now.
	 */
	#recordInterim(turn: ActiveTurn, text: string): boolean {
		const { store, originKey, log } = this.#deps;
		if (alreadySent(text, turn.interim)) return false;
		const index = turn.interim.length;
		try {
			store.recordInterim({ originKey, opRef: turn.opRef, threadRef: turn.threadRef, index, body: text });
		} catch (error) {
			// The text is still part of the turn-end answer, which leaves out only what was recorded here.
			log.warn("interim_record_failed", { origin: originKey, opRef: turn.opRef, index, error: String(error) });
			return false;
		}
		turn.interim.push(text);
		log.info("interim_recorded", { origin: originKey, opRef: turn.opRef, index, chars: text.length });
		return true;
	}

	#reportProgress(turn: ActiveTurn): void {
		const { progress } = turn;
		this.#deps.onProgress?.({
			originKey: this.#deps.originKey,
			threadRef: turn.threadRef,
			progress: {
				...progress,
				recentTools: progress.recentTools.map((tool) => ({ ...tool })),
				...(progress.todo ? { todo: { ...progress.todo } } : {}),
			},
		});
	}

	/** Daemon shutdown: stop the child without aborting the turn. */
	close(): Promise<void> {
		return this.#serial(() => this.#stopDriver());
	}

	/**
	 * Shutdown drain mode: no pending row is dispatched anymore. Without it, a turn settling during the drain would
	 * fire the trailing `#drain` into a fresh turn that the imminent child stop kills mid-flight — that row would
	 * come back as `interrupted_by_restart` (an owner resend at the whole session's cost) instead of the clean
	 * rule-(1) re-dispatch a pending row gets on the next boot. Already-running turns keep running and are awaited.
	 */
	stopDispatching(): void {
		this.#acceptingDispatch = false;
	}

	/**
	 * Stops the child without cutting a running turn short (a closed lane's last turn still reports back). A message
	 * that arrives before the child stopped keeps it alive.
	 */
	stopWhenIdle(): Promise<void> {
		return this.#serial(async () => {
			if (this.#turn) this.#stopAfterTurn = true;
			else await this.#stopDriver();
		});
	}

	#serial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.#tail.then(task);
		this.#tail = run.catch(() => undefined);
		return run;
	}

	#wakeTurnEndWaiters(): void {
		if (this.#turn === undefined) for (const wake of this.#turnEndWaiters.splice(0)) wake();
	}

	/**
	 * Resolves once no turn runs (at once when none does). Does not hold new turns back: the caller holds the origin
	 * first (a paused lane), so the turn running now is the last one (`jabbu-pocket lanes attach --wait`).
	 */
	whenTurnEnds(): Promise<void> {
		if (this.#turn === undefined) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#turnEndWaiters.push(resolve);
		return promise;
	}

	/** Events from the driver have nobody to reject to: errors are logged, never dropped silently. */
	#background(event: string, task: () => Promise<void>): void {
		this.#serial(task).catch((error: unknown) => {
			this.#deps.log.error(event, { origin: this.#deps.originKey, ...errorFields(error) });
		});
	}

	async #handle(record: InboundRecord): Promise<void> {
		const { store, originKey, log } = this.#deps;
		store.ensureOrigin(originKey, this.#deps.sessionDirFor(originKey, 1));
		this.#lastActivityAt = this.#deps.clock.now();
		this.#stopAfterTurn = false;
		const { inserted, row } = store.recordInbound({
			originKey,
			platformMessageId: record.platformMessageId,
			textRef: record.text,
			threadRef: record.threadRef,
			injected: record.injected === true,
		});
		if (!inserted) {
			log.info("inbound_duplicate", { origin: originKey, id: record.platformMessageId });
			return;
		}
		const command = parseCommand(record.text);
		// Before the drain and attach deferrals: a held `!restart` would run again in the next process.
		if (command?.kind === "restart") return this.#runCommand(row, command);
		if (this.#deps.isDraining?.()) {
			log.info("drain_deferred", { origin: originKey, id: record.platformMessageId });
			return;
		}
		// A `btw` with no turn to ask beside is a plain message: it stays pending and the drain starts a turn with it.
		const viaDrain = command?.kind === "followup" || (command?.kind === "btw" && command.arg !== "" && !this.#turn);
		if (command && !viaDrain && this.#deps.isAttached?.()) {
			// The session is open in a terminal omp: the command waits for it like a held message (the drain runs it).
			log.info("attached_command_deferred", { origin: originKey, id: record.platformMessageId });
			return;
		}
		if (command && !viaDrain) await this.#runCommand(row, command);
		else await this.#drain();
	}

	/**
	 * A plain owner message while the running turn waits on exactly one owner dialog: it becomes that dialog's answer
	 * (never a steer) and rides the turn's opRef, so the turn's final settles it as answered. With 2+ open dialogs the
	 * owner is told to answer in a card's thread and the message takes the normal path. An `injected` row (`jabbu
	 * inject`, which anyone with the socket can send) never answers a card: it takes the normal path, the card open.
	 */
	async #answerDialog(row: InboundRow): Promise<boolean> {
		const { dialogs, store, originKey, log } = this.#deps;
		const turn = this.#turn;
		const driver = this.#driver;
		if (dialogs === undefined || turn === undefined || driver === undefined || row.injected) return false;
		if (turn.capDeferred.has(row.platformMessageId)) return false;
		const open = dialogs.open(originKey);
		if (open === 0) return false;
		if (open > 1) {
			log.info("dialog_reply_ambiguous", { origin: originKey, id: row.platformMessageId, open });
			dialogs.ambiguous({ originKey, threadRef: row.threadRef });
			return false;
		}
		if (!(await dialogs.answer(originKey, row.textRef))) {
			// The card closed under the message (a click a moment earlier): it is steered or starts the next turn.
			log.info("dialog_reply_unconsumed", { origin: originKey, id: row.platformMessageId });
			return false;
		}
		let entryCursor: string | null = null;
		try {
			entryCursor = await driver.leafId();
		} catch (error) {
			log.warn("dialog_answer_cursor_failed", { origin: originKey, id: row.platformMessageId, error: String(error) });
		}
		store.markDispatched(row.platformMessageId, { opRef: turn.opRef, entryCursor });
		log.info("dialog_answered", { origin: originKey, id: row.platformMessageId, opRef: turn.opRef });
		return true;
	}

	/** Dispatch pending rows in arrival order; unsteerable rows wait and block later ones (`followup` waits for idle). */
	async #drain(): Promise<void> {
		const { store, originKey } = this.#deps;
		// Restart drain or paused lane: pending rows wait, while `!restart` still runs now.
		if (this.#deps.isDraining?.() || this.#deps.isHeld?.()) {
			for (const row of store.listInbound({ originKey, state: "pending" })) {
				const command = row.peerUserId === null ? parseCommand(row.textRef) : undefined;
				if (command?.kind === "restart") await this.#runCommand(row, command);
			}
			return;
		}
		for (const listed of store.listInbound({ originKey, state: "pending" })) {
			// Checked per row so a drain already mid-loop stops too when shutdown flips the flag.
			if (!this.#acceptingDispatch) return;
			const row = store.getInbound(listed.platformMessageId);
			if (row?.state !== "pending") continue;
			// A frozen bot's autonomous rows wait without blocking the owner's rows behind them.
			if (this.#frozenHold(row)) continue;
			const purpose = parsePurposeCommand(row.textRef);
			if (purpose !== undefined) {
				runPurposeCommand(this.#deps, row, purpose.arg);
				continue;
			}
			if (row.peerUserId !== null) {
				// Peer bot requests never steer a running turn or consume commands; they wait for idle like followup.
				if (this.#turn || this.#deps.quotaHoldReason?.() !== undefined) continue;
				if (!(await this.#dispatch(row))) break;
				continue;
			}
			if (isHomeCommand(row.textRef)) {
				setHome(this.#deps, row);
				continue;
			}
			const command = parseCommand(row.textRef);
			if (command?.kind === "followup" && command.arg !== "") {
				if (this.#turn || this.#deps.quotaHoldReason?.() !== undefined) continue;
				if (!(await this.#dispatch(row, command.arg))) break;
				continue;
			}
			if (command?.kind === "btw" && command.arg !== "" && !this.#turn) {
				// No turn to ask beside: the question itself (without the command word) starts a turn.
				if (this.#deps.quotaHoldReason?.() !== undefined) continue;
				if (!(await this.#dispatch(row, command.arg))) break;
				continue;
			}
			if (command) {
				if (command.kind === "btw" && command.arg !== "" && this.#deps.quotaHoldReason?.() !== undefined) continue;
				await this.#runCommand(row, command);
				continue;
			}
			// Dialog answer path before steering: every pending drain hits here; drain return above bounds card timeout.
			if (await this.#answerDialog(row)) continue;
			if (this.#deps.quotaHoldReason?.() !== undefined) continue;
			// A turn at its steer cap leaves the row pending for the next turn without blocking commands or dialog answers.
			const turn = this.#turn;
			if (turn && turn.progress.steers >= MAX_STEERS) {
				if (!turn.capDeferred.has(row.platformMessageId)) {
					turn.capDeferred.add(row.platformMessageId);
					this.#deps.log.info("steer_capped", { origin: originKey, id: row.platformMessageId, opRef: turn.opRef });
				}
				if (!turn.progress.steerCapped) {
					turn.progress.steerCapped = true;
					this.#reportProgress(turn);
				}
				continue;
			}
			if (!(await this.#dispatch(row))) break;
		}
	}

	/** Whether the bot is frozen and `row` is autonomous work that must not start a turn now. */
	#frozenHold(row: InboundRow): boolean {
		// Autonomy first: an owner row never reads the (cached) freeze probe.
		return isAutonomousRow(this.#deps.originKey, row) && this.#deps.isFrozen?.() === true;
	}

	/** Returns false when the row was left pending (nothing was sent). */
	async #dispatch(row: InboundRow, text: string = row.textRef): Promise<boolean> {
		const { store, log, originKey } = this.#deps;
		if (this.#deps.isHeld?.() || this.#deps.quotaHoldReason?.() !== undefined) return false;
		if (this.#frozenHold(row)) return false; // frozen: an autonomous row stays pending for the unfreeze
		const turn = this.#turn;
		if (turn && this.#driver) {
			// The owner's first reply in a thread opened by this bot carries that root even when it is steered: the
			// thread's later replies no longer qualify, so this is its only chance. Peer rows are never steered.
			const context = row.peerUserId === null ? await this.#threadContextBlock(row) : null;
			// The fetch awaited: the turn may have ended meanwhile, and steering an idle child would start a run.
			if (this.#turn !== turn || !this.#driver) return this.#dispatch(row, text);
			// Written before the turn's last answer reached the owner (still pending, or its interim delivery came after
			// the row): the model is told the answer already went out. No time window — a row written after the delivery
			// (a quick "취소해" right after reading it) is steered as is.
			const beforeAnswerSeen =
				row.peerUserId === null &&
				(turn.pendingAnswer !== undefined ||
					(turn.lastInterimDeliveredAt !== undefined && row.createdAt < turn.lastInterimDeliveredAt));
			const blocks = [
				...(beforeAnswerSeen ? [STEER_BEFORE_ANSWER_SEEN_NOTE] : []),
				...(context === null ? [] : [context]),
			];
			// Busy: steer ONLY while a turn runs (real omp starts a run when steered while idle). Each await below may see
			// the turn end: a turn already settled is re-dispatched like above; a final that arrived but still waits on
			// the actor's chain leaves the row pending for the drain that `#onFinal` runs.
			const driver = this.#driver;
			const ended = (): "settled" | "final" | undefined =>
				this.#turn !== turn || this.#driver !== driver ? "settled" : turn.finalArrived ? "final" : undefined;
			// Before the steer nothing was sent, so a throw or an ended turn leaves the row pending (safe to retry). From
			// the steer on the child may have read it: such a row is parked as `uncertain` and never prompted again.
			let entryCursor: string | null;
			try {
				entryCursor = await driver.leafId();
			} catch (error) {
				log.warn("steer_failed", {
					origin: originKey,
					id: row.platformMessageId,
					action: "defer",
					error: String(error),
				});
				return false;
			}
			const late = ended();
			if (late !== undefined) {
				log.info("steer_turn_ended", { origin: originKey, id: row.platformMessageId, opRef: turn.opRef, late });
				return late === "settled" ? this.#dispatch(row, text) : false;
			}
			if (!beginSend(this.#deps, row, entryCursor)) return false;
			try {
				await driver.steer(composeTurnPrompt(blocks, text, false));
			} catch (error) {
				return parkUncertain(this.#deps, row, "steer_threw", error);
			}
			if (ended() !== undefined) return parkUncertain(this.#deps, row, "turn_ended_after_steer");
			if (!markOrPark(this.#deps, row, { opRef: turn.opRef, entryCursor })) return true;
			log.info("steer_delivered", {
				origin: originKey,
				id: row.platformMessageId,
				opRef: turn.opRef,
				...(beforeAnswerSeen ? { beforeAnswerSeen: true } : {}),
			});
			turn.progress.steers += 1;
			this.#reportProgress(turn);
			return true;
		}
		let failure: unknown;
		// A try that throws settles its write-ahead first: only an `unsent` row may be tried again (mailbox-sending.ts).
		const attempt = async () => {
			try {
				return await this.#startTurn(row, text);
			} catch (error) {
				failure = error;
				return settleFailedSend(this.#deps, row, error);
			}
		};
		let sent = await attempt();
		// A session restored with a model omp no longer knows fails before any driver exists (2026-10-27 사고):
		// rewrite the session file's last model_change to the fallback and retry the same dispatch once.
		if (sent === "unsent" && this.#driver === undefined && isModelFailureSign(failureSign(failure))) {
			if ((await this.#healSessionFile()) !== undefined) sent = await attempt();
		}
		// A driver stopped under us (an unreadable stdout line stops the child right after the failing final) answers
		// `not_started`, and a child that stopped answering requests `request_timeout`: drop it and retry the same
		// dispatch once on a new one — only while nothing may have reached the child.
		if (
			sent === "unsent" &&
			this.#driver !== undefined &&
			failure instanceof OmpDriverError &&
			(failure.code === "not_started" || failure.code === "request_timeout")
		) {
			await this.#stopDriver();
			sent = await attempt();
		}
		if (typeof sent === "boolean") return sent;
		if (sent === "timeout_sending" || sent === "parked") {
			const model = this.#turnModel();
			const origin = store.getOrigin(originKey);
			const sessionFile = origin === undefined ? undefined : sessionToResume(origin);
			// The child may hold the prompt: stopped, so no run goes on untracked; close if proven tool-free.
			await this.#stopDriver().catch(() => undefined);
			if (sent === "timeout_sending") settleTimedOutSend(this.#deps, row, failure, sessionFile, model);
			return true;
		}
		const rawReason = failureSign(failure);
		const code = failure instanceof OmpDriverError ? failure.code : "dispatch_error";
		log.error("dispatch_failed", { origin: originKey, id: row.platformMessageId, code, ...errorFields(failure) });
		this.#logTurnFailed(rawReason, undefined, failure);
		const opRef = `failed:${row.platformMessageId}`;
		store.markDispatched(row.platformMessageId, { opRef, entryCursor: null });
		const peer = turnPeerOf(row);
		store.recordTurnFailure({
			originKey,
			opRef,
			threadRef: row.threadRef,
			notice:
				peer === undefined && NO_MODEL_SIGN.test(rawReason)
					? NO_MODEL_NOTICE
					: failedNotice(code, peer, this.#threadSource(), rawReason),
		});
		this.#noteQuotaErrorIfLimit(row.threadRef, rawReason);
		await this.#noteTurnFailure(row.threadRef, rawReason);
		return true;
	}

	/**
	 * The HEADs of `turnHeads.headRepos()` before this conversation turn, so a commit reaches the wiki turn notes. Only
	 * conversation origins of a chat platform: a monitor turn or a lane turn (its own worktree and branch) is left out,
	 * and with no repository listed no git is ever started.
	 */
	async #captureHeadsBefore(originKey: string): Promise<ActiveTurn["headsBefore"]> {
		const turnHeads = this.#deps.turnHeads;
		if (turnHeads === undefined || parseChatOrigin(originKey) === undefined) return undefined;
		const repos = turnHeads.headRepos();
		if (repos.length === 0) return undefined;
		const heads = await captureHeads(repos, { run: turnHeads.run, log: this.#deps.log });
		return heads.size === 0 ? undefined : heads;
	}

	/** The heads after a turn captured by `#captureHeadsBefore`: the repositories it committed in go to `onCommitted`. */
	async #recordHeadsAfter(turn: ActiveTurn): Promise<void> {
		const before = turn.headsBefore;
		const turnHeads = this.#deps.turnHeads;
		if (before === undefined || turnHeads?.onCommitted === undefined) return;
		const { originKey, log } = this.#deps;
		try {
			const after = await captureHeads([...before.keys()], { run: turnHeads.run, log });
			const endedAt = this.#deps.clock.now();
			const rows = [...before].flatMap(([repo, headBefore]) => {
				const headAfter = after.get(repo);
				return headAfter === undefined || headAfter === headBefore ? [] : [{ repo, headBefore, headAfter, endedAt }];
			});
			if (rows.length > 0)
				await turnHeads.onCommitted({ originKey, opRef: turn.opRef, threadRef: turn.threadRef, rows });
		} catch (error) {
			log.warn("turn_head_failed", { origin: originKey, opRef: turn.opRef, error: String(error) });
		}
	}

	/**
	 * Opens the origin's session in a driver and starts one turn for the row; nothing is recorded on failure. False: the
	 * `sending` write-ahead failed, so nothing was sent and the row stays pending.
	 */
	async #startTurn(row: InboundRow, text: string): Promise<boolean> {
		this.#starting += 1;
		try {
			return await this.#openTurn(row, text);
		} finally {
			this.#starting -= 1;
		}
	}

	/** Cold-resume rotation (`rotateOnColdResume`): a new epoch for the turn about to start; the row moves with it. */
	async #coldResumeRotate(row: InboundRow): Promise<InboundRow> {
		const rotation = this.#turn === undefined ? rotateOnColdResume(this.#deps, this.#cache.baseline, row) : undefined;
		if (rotation === undefined) return row;
		await this.#stopDriver();
		this.#cache = new CacheMonitor();
		this.#coldResume = rotation;
		noticeColdResumeRotated(this.#deps, row.threadRef, rotation);
		return rotation.row;
	}

	async #openTurn(startRow: InboundRow, text: string): Promise<boolean> {
		const { store, log, originKey } = this.#deps;
		const row = await this.#coldResumeRotate(startRow);
		const driver = await this.#ensureDriver(row.threadRef);
		// A child started before a peer bot wrote here is kept: it is told once, in front of its next prompt.
		const peerNotice = !this.#skipPeerNotice && store.originHasPeerInbound(originKey);
		// Only a lane's first prompt has anything to check; every other turn goes on without an extra await.
		const refusal = this.#freshSession ? this.#deps.launchRefusal?.(driver) : undefined;
		if (refusal !== undefined && (await this.#refuseLaunch(row, await refusal))) return true;
		// Before `#firstTurnPrompt` clears the fresh flag: a continued session already has its todos.
		if (this.#freshSession) await this.#plantTodos(driver);
		// Read the cursor right before the prompt: extensions append entries after open.
		const entryCursor = await driver.leafId();
		// Before the prompt, not after: the first tool call would otherwise race the capture and land in no turn's note.
		const headsBefore = await this.#captureHeadsBefore(originKey);
		const board = this.#deps.boardNotice?.();
		const prompt = await this.#firstTurnPrompt(row, text, peerNotice, board?.block);
		// The write-ahead: a failed write sends nothing; the stopped child reopens with the same first-prompt context.
		if (!beginSend(this.#deps, row, entryCursor)) {
			await this.#stopDriver().catch(() => undefined);
			return false;
		}
		const opRef = await driver.prompt(prompt);
		// Only once the prompt went through: a failed one leaves the notices for the next turn.
		if (peerNotice) this.#skipPeerNotice = true;
		board?.commit();
		// The child already runs this turn: a failed ledger write stops it, so no run goes on untracked.
		let recorded = false;
		try {
			recorded = markOrPark(this.#deps, row, { opRef, entryCursor });
		} finally {
			if (!recorded) await this.#stopDriver().catch(() => undefined);
		}
		if (!recorded) return true;
		this.#turn = newActiveTurn(this.#deps.clock, row, { opRef, entryCursor, headsBefore });
		const turnModel = this.#turnModel();
		if (turnModel !== undefined) this.#turn.model = turnModel;
		this.#lastEventAt = this.#deps.clock.now();
		this.#eventPersistedAt = this.#lastEventAt;
		this.#stalled = false;
		log.info("turn_start", { origin: originKey, epoch: row.epoch, opRef });
		try {
			this.#coldWarned = warnColdCache(this.#deps, this.#cache, this.#coldWarned, row.threadRef);
		} catch (error) {
			log.warn("cold_cache_warn_failed", { origin: originKey, error: String(error) });
		}
		// Reported at once: a turn without tool calls would otherwise never show what is usual.
		const typical = typicalTurnDuration(store, originKey, log);
		if (typical !== undefined) {
			this.#turn.progress.typical = typical;
			this.#reportProgress(this.#turn);
		}
		return true;
	}

	/**
	 * A `launchRefusal` reason for the first prompt of a fresh session discards the row without a turn, stops the
	 * child and hands the reason to `onLaunchRefused` (it closes the lane); true = nothing was prompted.
	 */
	async #refuseLaunch(row: InboundRow, reason: string | undefined): Promise<boolean> {
		const { store, log, originKey, onLaunchRefused } = this.#deps;
		if (reason === undefined) return false;
		log.warn("launch_refused", { origin: originKey, id: row.platformMessageId, reason });
		// Closed, not left dispatched: a dispatched row would be cut by a drain and resumed by the next boot.
		store.discard(row.platformMessageId, `${REFUSED_OP_PREFIX}${row.platformMessageId}`);
		await this.#stopDriver();
		try {
			await onLaunchRefused?.(reason);
		} catch (error) {
			log.error("launch_refused_failed", { origin: originKey, ...errorFields(error) });
		}
		return true;
	}

	/** `initialTodos` into a fresh session; a driver that refuses them leaves the turn to go on without (warning only). */
	async #plantTodos(driver: OmpSessionDriver): Promise<void> {
		const { originKey, log } = this.#deps;
		const phases = this.#deps.initialTodos?.();
		if (phases === undefined) return;
		try {
			await driver.setTodos(phases);
			log.info("lane_set_todos", { origin: originKey, phases: phases.length });
		} catch (error) {
			log.warn("lane_set_todos_failed", { origin: originKey, error: String(error) });
		}
	}

	/**
	 * Prompt of a new turn (never a steer): the first prompt of a freshly created thread session is preceded by the
	 * thread context it never saw, and a chat conversation's turn by channel-scoped recall when `buildRecallBlock`
	 * finds the text points at the past (or a fresh session shares rare words). Bot answers quoted in either block
	 * are scanned for instruction-like passages; a hit puts a warning line in front of that block. `peerNotice` puts
	 * the peer-taint notice first: a block, so the prompt still ends with the request (`isTurnPromptFor`). `boardLine`
	 * (the lane board's new-post head line) is the last block, right above the request.
	 */
	async #firstTurnPrompt(
		row: InboundRow,
		text: string,
		peerNotice: boolean,
		boardLine: string | undefined,
	): Promise<string> {
		const { store, originKey, log } = this.#deps;
		const fresh = this.#freshSession;
		this.#freshSession = false;
		const rotated = this.#rotatedSession;
		this.#rotatedSession = false;
		if (rotated) store.deleteCursor(rotationCursorKey(originKey));
		const coldResume = this.#coldResume;
		this.#coldResume = undefined;
		const blocks: string[] = peerNotice ? [peerTouchedTurnNotice(originKey)] : [];
		// The rotation block already holds the thread head the fresh-session block would give.
		const context = coldResume
			? coldResumeContextBlock(this.#deps, row, coldResume)
			: rotated
				? rotationContextBlock(store, originKey, row)
				: fresh
					? threadContextBlock(store, originKey, row)
					: null;
		if (context !== null) {
			const answers = context
				.split("\n")
				.filter((line) => line.startsWith(THREAD_ANSWER_LINE) || line.startsWith(OWN_ANSWER_LINE));
			blocks.push(this.#withInjectionWarning(context, answers, "스레드 맥락의 봇 답"));
		}
		const threadContext = await this.#threadContextBlock(row);
		if (threadContext !== null) blocks.push(threadContext);
		const purposeBlock = purposeBlockOf(this.#deps);
		if (purposeBlock !== null) blocks.push(purposeBlock);
		const channel = parseChatOrigin(originKey)?.conversationId;
		// A peer bot's request never pulls recall: its fixed header would match other peer rows as rare words.
		if (channel !== undefined && row.peerUserId === null && this.#deps.recallEnabled?.() === true) {
			const recall = buildRecallBlock({
				text,
				candidates: () => store.listRecallCandidates(channel, row.threadRef, RECALL_CANDIDATE_LIMIT),
				freshSession: fresh,
				channel,
				timezone: this.#deps.timezone,
			});
			if (recall.block !== null) {
				log.info("recall_injected", {
					origin: originKey,
					trigger: recall.trigger,
					hits: recall.hits,
					bytes: byteLength(recall.block),
				});
				// Scan what the block shows of each bot answer (its line, truncated like the block), not the full row.
				const shown = recall.block.split("\n").slice(1);
				const answers = recall.items.flatMap((item, i) => (item.kind === "delivery" ? [shown[i] ?? ""] : []));
				blocks.push(this.#withInjectionWarning(recall.block, answers, "이전 대화 회상의 봇 답"));
			}
		}
		if (boardLine !== undefined) blocks.push(boardLine);
		return composeTurnPrompt(blocks, text);
	}

	/** `block` with the injection warning in front when the bot-authored lines it shows (`answers`) carry one. */
	#withInjectionWarning(block: string, answers: readonly string[], where: string): string {
		const { originKey, log } = this.#deps;
		const findings = scanForInjection(answers.join("\n"), where);
		const warning = injectionWarning(findings);
		if (warning === null) return block;
		log.info("injection_flagged", { origin: originKey, where, kinds: findings.map((f) => f.kind) });
		return `${warning}\n${block}`;
	}

	/** The thread reader of this origin's chat platform; none for other origins or a platform without one. */
	#threadSource(): ThreadSource | undefined {
		const platform = parseChatOrigin(this.#deps.originKey)?.platform;
		return platform === undefined ? undefined : this.#deps.threadSource?.get(platform);
	}

	/** The thread context of `row` ready to prepend (injection-scanned), or null. */
	async #threadContextBlock(row: InboundRow): Promise<string | null> {
		const context = await this.#threadContext(row);
		if (context === null) return null;
		const answers = context.split("\n").filter((line) => line.startsWith(THREAD_ANSWER_LINE));
		return this.#withInjectionWarning(context, answers, "스레드 맥락의 봇 글");
	}

	/**
	 * Platform-side thread context of a turn, read through `threadSource`: for a peer bot's request the root plus
	 * what followed this bot's last post; for the owner's first reply in a thread (no earlier inbound row of the
	 * thread, in any origin) the root when it is this bot's own post. A platform failure or a read slower than
	 * `THREAD_CONTEXT_TIMEOUT_MS` is logged and the turn goes on without context.
	 */
	async #threadContext(row: InboundRow): Promise<string | null> {
		const { store, originKey, log } = this.#deps;
		const threadSource = this.#threadSource();
		if (threadSource === undefined) return null;
		const ref = parseThreadRef(row.threadRef);
		if (ref === undefined || ref.threadTs === TOP_LEVEL_TS || row.threadRef === row.platformMessageId) return null;
		const peer = row.peerUserId !== null;
		if (!peer && store.hasInboundThreadBefore(row.threadRef, row.platformMessageId)) return null;
		const self = threadSource.botUserId();
		if (self === undefined) return null;
		// The platform client retries a failing call for up to ~30 minutes; this runs inside the origin's serial chain, so
		// a slow fetch gives up and the turn goes on without context.
		const timeoutMs = threadSource.timeoutMs ?? THREAD_CONTEXT_TIMEOUT_MS;
		const { promise: deadline, reject } = Promise.withResolvers<never>();
		const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
		try {
			const messages = await Promise.race([
				threadSource.replies(ref.channel, ref.threadTs, peer ? undefined : 1),
				deadline,
			]);
			if (peer) {
				const currentTs = row.platformMessageId.slice(row.platformMessageId.indexOf(":") + 1);
				return peerThreadContextBlock(messages, self, currentTs, row.threadRef);
			}
			const root = messages[0];
			return root === undefined || root.ts !== ref.threadTs || root.user !== self
				? null
				: ownerThreadRootBlock(root, row.threadRef);
		} catch (error) {
			log.warn("thread_context_failed", { origin: originKey, thread: row.threadRef, error: String(error) });
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	/** Rewrites a removed session model to the fallback after backing up the original session file. */
	async #healSessionFile(): Promise<HealedSessionModel | undefined> {
		const { store, log, originKey, defaultModel, sessionBackupsRoot } = this.#deps;
		if (sessionBackupsRoot === undefined) return undefined;
		const origin = store.getOrigin(originKey);
		if (origin === undefined) return undefined;
		const fallback = effectiveOriginSettings(store, originKey, origin).model ?? defaultModel;
		if (fallback === undefined) return undefined;
		const file = origin.sessionFile ?? newestSessionFile(origin.sessionDir);
		if (file === undefined) return undefined;
		try {
			const healed = healSessionModelFile(file, fallback, join(sessionBackupsRoot, encodeURIComponent(originKey)));
			if (healed !== undefined) {
				log.warn("model_file_healed", { origin: originKey, from: healed.from, to: healed.to, file });
			}
			return healed;
		} catch (error) {
			log.warn("model_file_heal_failed", { origin: originKey, file, error: String(error) });
			return undefined;
		}
	}

	/** The running child, or a new one bound to the origin's session; `threadRef` is where a session mismatch is told. */
	async #ensureDriver(threadRef: string): Promise<OmpSessionDriver> {
		if (this.#driver) return this.#driver;
		const { store, originKey, driverFactory, log } = this.#deps;
		// Two omp processes writing one session file tangle its history: none starts while a terminal holds it.
		if (this.#deps.isAttached?.())
			throw new OmpDriverError("not_started", `${originKey} is attached to a terminal omp`);
		const origin = store.getOrigin(originKey);
		if (!origin) throw new OmpDriverError("not_started", `unknown origin ${originKey}`);
		// Freshness must be read before the child exists: an empty epoch dir means this session is brand-new.
		this.#freshSession = epochDirIsFresh(origin.sessionDir);
		// The marker the rotation wrote is the only durable record of it: the session dir alone cannot tell a first
		// session from a post-rotation restart, and an epoch bump (`/new`, cold-resume) leaves the marker stale.
		if (store.getCursor(rotationCursorKey(originKey)) === String(origin.epoch)) {
			this.#freshSession = false;
			this.#rotatedSession = true;
		}
		const expected = sessionToResume(origin);
		this.#spawn = spawnSnapshot(origin.sessionDir, expected);
		const peerTouched = store.originHasPeerInbound(originKey);
		const spawnIdentity = this.#idle.identity();
		const driver = driverFactory(originKey, origin.sessionDir);
		await driver.start();
		let check: SessionOpenCheck;
		try {
			check = await openOriginSession(driver, origin, expected);
		} catch (error) {
			await driver.stop();
			throw error;
		}
		if (check.mismatch) {
			log.warn("session_resume_mismatch", { origin: originKey, expected: check.expected, actual: check.actual });
			if (!this.#mismatchNoticed.has(origin.epoch)) {
				this.#mismatchNoticed.add(origin.epoch);
				this.#deps.onSessionMismatch?.({ originKey, threadRef, expected: check.expected, actual: check.actual });
			}
		}
		this.#activeModel = await applyOriginSettings({
			driver,
			store,
			originKey,
			origin,
			defaultModel: this.#deps.defaultModel,
			log,
		});
		await this.#seedCache(driver, expected);
		this.#cache.markChildRestart();
		this.#unsubscribe = [
			driver.onFinal((final) => {
				if (driver === this.#driver && this.#turn?.opRef === final.opRef) this.#turn.finalArrived = true;
				this.#background("final_failed", () => this.#onFinal(driver, final));
			}),
			driver.onExit((info) => this.#background("exit_failed", () => this.#onExit(driver, info))),
			driver.onEvent((event) => this.#onDriverEvent(event)),
		];
		this.#driver = this.#context.watch(driver);
		this.#idle.spawned(spawnIdentity);
		// A child without host tools has nothing to be told about them.
		this.#skipPeerNotice = peerTouched || this.#deps.hostTools?.() === false;
		return driver;
	}

	/** Counts failed turns, immediately heals missing models, and escalates once `escalateAfter` hits. */
	async #noteTurnFailure(threadRef: string, reason: string): Promise<void> {
		this.#consecFailures += 1;
		const { originKey, log, onEscalate } = this.#deps;
		let modelHealed = false;
		if (this.#driver !== undefined && isModelFailureSign(reason)) {
			const origin = this.#deps.store.getOrigin(originKey);
			if (origin) {
				const healed = await healStaleSessionModel({
					driver: this.#driver,
					store: this.#deps.store,
					originKey,
					origin,
					defaultModel: this.#deps.defaultModel,
					log,
				}).catch((error: unknown) => {
					log.warn("model_heal_failed", { origin: originKey, error: String(error) });
					return undefined;
				});
				if (healed?.activeModel !== undefined) this.#activeModel = healed.activeModel;
				modelHealed = healed?.outcome === "replaced";
			}
		}
		const threshold = this.#deps.escalateAfter ?? DEFAULT_ESCALATE_AFTER;
		if (threshold <= 0 || this.#consecFailures < threshold) return;
		log.error("turn_failures_escalated", {
			origin: originKey,
			failures: this.#consecFailures,
			modelHealed,
			reason: headTailReason(redact(reason).replace(/\s+/g, " ")),
		});
		onEscalate?.({ originKey, threadRef, failures: this.#consecFailures, reason, modelHealed });
	}

	#turnModel(): string | undefined {
		const { store, originKey, defaultModel } = this.#deps;
		const origin = store.getOrigin(originKey);
		const configured = origin === undefined ? undefined : effectiveOriginSettings(store, originKey, origin).model;
		return this.#activeModel ?? configured ?? defaultModel;
	}

	#noteQuotaErrorIfLimit(threadRef: string, rawReason: string, model = this.#turnModel()): void {
		if (classifyFailure(rawReason).kind !== "provider_limit") return;
		this.#deps.onQuotaError?.({
			originKey: this.#deps.originKey,
			threadRef,
			...(model === undefined ? {} : { model }),
			reason: rawReason,
		});
	}

	#sweepToolFreeUncertain(): void {
		const { store, originKey, log } = this.#deps;
		const uncertain = store.listInbound({ originKey, state: "uncertain" }).filter((row) => row.entryCursor !== null);
		if (uncertain.length === 0) return;
		const origin = store.getOrigin(originKey);
		const sessionFile = origin === undefined ? undefined : sessionToResume(origin);
		if (sessionFile === undefined) return;
		const model = this.#turnModel();
		for (const row of uncertain) {
			const proof = tryCloseToolFreeFromFile(store, log, row, sessionFile, "post_turn");
			if (proof?.failureKind === "provider_limit") this.#noteQuotaErrorIfLimit(row.threadRef, proof.reason, model);
		}
	}

	async #stopDriver(): Promise<void> {
		const driver = this.#driver;
		this.#detach();
		await driver?.stop();
	}

	#detach(): void {
		for (const off of this.#unsubscribe) off();
		this.#unsubscribe = [];
		this.#driver = undefined;
	}

	/** `stopFirst`: the wedged child is stopped before the drain, so a queued next row starts on a fresh child. A ledger write that throws still runs the tail: the error surfaces as `final_failed`, but queued rows drain. A `completed` final that arrives after a 3x crossing was found settles as that `cost_cap` reason instead (the abort lost the FIFO race to it). */
	async #onFinal(driver: OmpSessionDriver, final: OmpFinal, stopFirst = false): Promise<void> {
		const { store, originKey, log } = this.#deps;
		const turn = this.#turn;
		if (driver !== this.#driver || !turn || turn.opRef !== final.opRef)
			return log.info("final_ignored", { origin: originKey, opRef: final.opRef });
		if (final.status === "completed" && turn.costStopReason !== undefined)
			final = { ...final, status: "aborted", text: "", error: turn.costStopReason };
		this.#turn = undefined;
		this.#wakeTurnEndWaiters();
		this.#lastActivityAt = this.#deps.clock.now();
		try {
			if (final.usage?.rotated === true) {
				// Persist the epoch so a restart before the next turn still re-feeds the rotation context.
				this.#rotatedSession = true;
				const epoch = store.getOrigin(originKey)?.epoch;
				if (epoch !== undefined) store.setCursor(rotationCursorKey(originKey), String(epoch));
			}
			await recordDailyCost(this.#deps, driver, turn, stopFirst, final.usage);
			const base = { originKey, opRef: turn.opRef, threadRef: turn.threadRef };
			if (final.status === "completed") {
				const answer = await this.#turnAnswer(driver, turn, final.text);
				store.recordAnswer({ ...base, parts: [answer.body], answer: answer.whole });
				log.info("turn_completed", {
					origin: originKey,
					opRef: turn.opRef,
					ms: this.#deps.clock.now() - turn.startedAt,
					chars: answer.whole.length,
				});
				if (isTaskOrigin(originKey))
					log.info("task_turn_output_dropped", { origin: originKey, chars: answer.whole.length });
				this.#consecFailures = 0;
			} else if (final.error === OWNER_STOP_ERROR) {
				// The owner's `!stop`: its answer (the `stop:` op) is the one message — no notice, no failure count.
				log.info("owner_stop_settled", { origin: originKey, opRef: turn.opRef });
			} else if (final.error === "lane_paused") {
				// The owner's own hold, not a failure: no notice, no failure count — one short line in the thread.
				store.recordAnswer({
					...base,
					parts: ["⏸ 이 턴은 오너 멈춤 요청으로 중단됐습니다(레인 일시정지). 재개는 오너만 합니다."],
				});
			} else {
				const rawReason = final.error ?? final.status;
				this.#logTurnFailed(rawReason);
				store.recordTurnFailure({ ...base, notice: failedNotice(rawReason, turn.peer, this.#threadSource()) });
				// A spend brake, not a breakage: the notice carries the reason, the failure run stays as it was.
				if (!rawReason.startsWith(COST_CAP_STOP_PREFIX)) {
					this.#noteQuotaErrorIfLimit(turn.threadRef, rawReason, turn.model);
					await this.#noteTurnFailure(turn.threadRef, rawReason);
				}
			}
			this.#deps.onTurnSettled?.({
				originKey,
				text: final.text,
				openDialogs: this.#deps.dialogs?.open(originKey) ?? 0,
				...(final.status === "completed" && final.error === undefined ? {} : { error: final.error ?? final.status }),
			});
		} finally {
			if (stopFirst) await this.#stopDriver();
			// Record heads after saving answer and before draining so any newly opened turn sees this turn's commits.
			await this.#recordHeadsAfter(turn);
			this.#sweepToolFreeUncertain();
			await this.#drain();
			if (this.#stopAfterTurn && !this.#turn) {
				this.#stopAfterTurn = false;
				await this.#stopDriver();
			}
		}
	}

	/** Collects every stop-ended answer since start cursor ending with `finalText`, minus interim deliveries. */
	async #turnAnswer(
		driver: OmpSessionDriver,
		turn: ActiveTurn,
		finalText: string,
	): Promise<{ body: string; whole: string }> {
		const { store, originKey, log } = this.#deps;
		if (originKey.startsWith(MONITOR_ORIGIN_PREFIX))
			return { body: finalText === "" ? NO_ANSWER : finalText, whole: finalText };
		let parts: string[] = [];
		try {
			parts = turnAnswerParts((await driver.entriesSince(turn.entryCursor ?? undefined)).entries);
		} catch (error) {
			log.warn("answer_entries_failed", { origin: originKey, opRef: turn.opRef, error: String(error) });
		}
		if (finalText.trim() !== "" && parts.at(-1)?.trim() !== finalText.trim()) parts.push(finalText);
		return closingAnswer(parts, store.interimBodies(originKey, turn.opRef));
	}

	async #onExit(driver: OmpSessionDriver, info: OmpExitInfo): Promise<void> {
		const { store, originKey, log } = this.#deps;
		if (driver !== this.#driver) return;
		this.#detach();
		log.warn("omp_exit", {
			origin: originKey,
			code: info.code,
			expected: info.expected,
			...(info.stderr === "" ? {} : { stderr: headTailReason(redact(info.stderr)) }),
		});
		const turn = this.#turn;
		this.#turn = undefined;
		this.#wakeTurnEndWaiters();
		try {
			// The dispatched rows of the dead turn are answered with one notice; the prompt is never resent.
			if (turn) {
				// The dead child spent money too: charge the day as `#onFinal` does (its live total when the state is gone).
				await recordDailyCost(this.#deps, driver, turn);
				const codeReason = `omp_exited code=${info.code ?? "null"}`;
				const classifyReason = info.stderr.trim() === "" ? codeReason : `${codeReason}: ${info.stderr.trim()}`;
				// Full text: #logTurnFailed keeps the head + tail — a pre-cut copy would miscount the dropped chars.
				this.#logTurnFailed(classifyReason);
				store.recordTurnFailure({
					originKey,
					opRef: turn.opRef,
					threadRef: turn.threadRef,
					notice: failedNotice(codeReason, turn.peer, this.#threadSource(), classifyReason),
				});
				this.#noteQuotaErrorIfLimit(turn.threadRef, classifyReason, turn.model);
				await this.#noteTurnFailure(turn.threadRef, codeReason);
			}
		} finally {
			this.#sweepToolFreeUncertain();
			await this.#drain();
		}
	}

	#logTurnFailed(rawReason: string, classifyReason = rawReason, error?: unknown): void {
		const { kind } = classifyFailure(classifyReason);
		this.#deps.log.error("turn_failed", {
			origin: this.#deps.originKey,
			kind,
			reason: headTailReason(redact(rawReason)),
			...(error === undefined ? {} : errorFields(error)),
		});
	}

	async #runCommand(row: InboundRow, command: ParsedCommand): Promise<void> {
		const { store, originKey, log } = this.#deps;
		const threadRef = row.threadRef;
		const opRef = `${command.kind}:${row.platformMessageId}`;
		if (command.kind === "new") return this.#newEpoch(opRef, threadRef);
		if (command.kind === "stop") return this.#stopTurn(row, opRef);
		// Mark first so a failing command can never leave its text pending for a later prompt.
		store.markDispatched(row.platformMessageId, { opRef, entryCursor: null });
		if (command.arg === "" && this.#deps.commandPicker !== undefined && isPickerCommand(command.kind)) {
			const kind = command.kind;
			const handled = await this.#deps
				.commandPicker({
					kind,
					originKey,
					threadRef,
					busy: this.#turn !== undefined,
					ensureDriver: () => this.#ensureDriver(threadRef),
				})
				.catch((error: unknown) => {
					log.warn("command_picker_failed", { origin: originKey, command: kind, error: String(error) });
					return false;
				});
			if (handled) {
				store.discard(row.platformMessageId, opRef);
				return;
			}
		}
		if (command.kind === "btw" && command.arg !== "" && this.#driver?.btw !== undefined) {
			askBtw(this.#deps, this.#driver.btw(command.arg), row.platformMessageId, opRef, threadRef);
			return;
		}
		if (command.kind === "brief") {
			// Two chromium runs (up to 2x20s): it must not hold the serial chain, so a message that comes
			// while the picture is drawn still starts its turn.
			startBrief(this.#deps, row.platformMessageId, opRef, threadRef);
			return;
		}
		let text: string;
		try {
			text = await commandReply(this.#host, command, opRef, threadRef);
		} catch (error) {
			const reason = error instanceof OmpDriverError ? error.message : String(error);
			log.error("command_failed", { origin: originKey, command: command.kind, ...errorFields(error) });
			const notice = NO_MODEL_SIGN.test(reason) ? NO_MODEL_NOTICE : failedNotice(`${command.kind}: ${reason}`);
			store.recordTurnFailure({ originKey, opRef, threadRef, notice });
			return;
		}
		if (command.kind === "model") this.#activeModel = undefined;
		store.recordAnswer({ originKey, opRef, threadRef, parts: [text] });
		// `/queue retry` made a row pending after any drain listed its rows: send it now. An enclosing drain skips rows
		// that are no longer pending, so the nesting cannot send anything twice.
		if (this.#redrain) {
			this.#redrain = false;
			await this.#drain();
		}
	}

	/** Applies one confirmed SelectMenu picker choice on this origin's serial actor chain. */
	applyPickerCommand(
		command: ParsedCommand,
		threadRef: string,
	): Promise<{ ok: boolean; busy?: boolean; text: string }> {
		return this.#serial(() =>
			runPickerCommand(
				this.#host,
				command,
				(cmd, opRef) => commandReply(this.#host, cmd, opRef, threadRef),
				async () => {
					this.#activeModel = undefined;
					if (!this.#redrain) return;
					this.#redrain = false;
					await this.#drain();
				},
			),
		);
	}

	/**
	 * A monitor fire starts a fresh session unless a turn runs: every fire would otherwise pay the session's whole
	 * accumulated context again, and a monitor's directive keeps its state in files and script output, never in the
	 * session. Same mechanism as `#newEpoch` minus the answer: a live but idle child is stopped, so the next dispatch
	 * opens the bumped epoch's empty session. Resolves false when a turn runs (the fire follows the queue/steer path
	 * in the current session) or the origin has no row yet (its first fire opens epoch 1 with a fresh session anyway).
	 */
	newEpochIfIdle(): Promise<boolean> {
		return this.#serial(async () => {
			if (this.#turn) return false;
			const { store, originKey } = this.#deps;
			const origin = store.getOrigin(originKey);
			if (!origin) return false;
			if (this.#driver) await this.#stopDriver();
			const epoch = origin.epoch + 1;
			store.newEpoch(originKey, this.#deps.sessionDirFor(originKey, epoch));
			this.#cache = new CacheMonitor();
			this.#deps.log.info("epoch_new", { origin: originKey, epoch, reason: "monitor_fire" });
			return true;
		});
	}

	/** Stops running turn while keeping the session; cancels earlier waiting rows and settles the turn on the stop op. */
	async #stopTurn(row: InboundRow, opRef: string): Promise<void> {
		const { store, originKey, log } = this.#deps;
		const pendingIds = store.listInbound({ originKey, state: "pending" }).map((pending) => pending.platformMessageId);
		const earlier = new Set(pendingIds.slice(0, Math.max(pendingIds.indexOf(row.platformMessageId), 0)));
		const cancelled = waitingRows(this.#host).filter((waiting) => earlier.has(waiting.row.platformMessageId));
		store.markDispatched(row.platformMessageId, { opRef, entryCursor: null });
		for (const waiting of cancelled) store.discard(waiting.row.platformMessageId, opRef);
		let note = cancelled.length === 0 ? "" : ` 대기 ${cancelled.length}개를 취소했습니다.`;
		const answer = (text: string): void => {
			store.recordAnswer({ originKey, opRef, threadRef: row.threadRef, parts: [`${text}${note}`] });
		};
		const turn = this.#turn;
		const driver = this.#driver;
		if (turn === undefined || driver === undefined) {
			log.info("owner_stop_idle", { origin: originKey, cancelled: cancelled.length });
			answer(NOTHING_TO_STOP_TEXT);
			return;
		}
		let stopChild = false,
			droppedSteers = 0;
		try {
			if (driver.abortAndClearQueue !== undefined) await driver.abortAndClearQueue();
			else {
				const off = driver.onFinal((final) => {
					if (final.opRef === turn.opRef) droppedSteers = final.droppedSteers ?? 0;
				});
				await driver.abort().finally(off);
				stopChild = (await driver.state()).queuedMessageCount > 0;
			}
		} catch (error) {
			stopChild = true;
			log.warn("owner_stop_abort_failed", { origin: originKey, opRef: turn.opRef, error: String(error) });
		}
		if (droppedSteers > 0) note += ` 아직 모델에 전달되지 않은 steer ${droppedSteers}건도 취소했습니다.`;
		log.info("owner_stop", { origin: originKey, opRef: turn.opRef, cancelled: cancelled.length, stopChild });
		const settles = this.#turn === turn && this.#driver === driver;
		if (settles) {
			for (const dispatched of store.listInbound({ originKey, state: "dispatched" })) {
				if (dispatched.opRef === turn.opRef) store.discard(dispatched.platformMessageId, opRef);
			}
		}
		answer(OWNER_STOPPED_TEXT);
		if (!settles) return;
		const final: OmpFinal = { opRef: turn.opRef, status: "aborted", text: "", error: OWNER_STOP_ERROR };
		await this.#onFinal(driver, final, stopChild);
	}

	/** Aborts running turn, charges spent cost, stops child, bumps epoch (discarding pending rows), and resets cache. */
	async #newEpoch(opRef: string, threadRef: string): Promise<void> {
		const { store, originKey, log } = this.#deps;
		const turn = this.#turn;
		this.#turn = undefined;
		this.#wakeTurnEndWaiters();
		const driver = this.#driver;
		if (driver) {
			try {
				await driver.abort();
			} catch (error) {
				log.warn("new_abort_failed", { origin: originKey, error: String(error) });
			}
			if (turn) await recordDailyCost(this.#deps, driver, turn);
			await this.#stopDriver();
		}
		const origin = store.getOrigin(originKey);
		if (!origin) throw new OmpDriverError("not_started", `unknown origin ${originKey}`);
		const epoch = origin.epoch + 1;
		store.newEpoch(originKey, this.#deps.sessionDirFor(originKey, epoch), opRef);
		this.#cache = new CacheMonitor();
		this.#coldResume = undefined;
		// Rows dispatched into the aborted turn belong to the old epoch: their output must never be delivered.
		// They are linked to the command op so the command's delivery also finishes their status messages.
		for (const dispatched of store.listInbound({ originKey, state: "dispatched" })) {
			store.discard(dispatched.platformMessageId, opRef);
		}
		this.#deps.log.info("epoch_new", { origin: originKey, epoch });
		store.recordAnswer({ originKey, opRef, threadRef, parts: ["🆕 새 대화를 시작했습니다."] });
	}
}
