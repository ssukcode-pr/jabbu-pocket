import { join } from "node:path";
import { isTaskOrigin } from "../lanes/status";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { alreadySent, closingAnswer, interimOf, NO_ANSWER, turnAnswerParts } from "../omp/answers";
import {
	OmpDriverError,
	type OmpEvent,
	type OmpExitInfo,
	type OmpFinal,
	type OmpSessionDriver,
	type OmpState,
} from "../omp/driver";
import { TAIL_WAIT_END_EVENT, TAIL_WAIT_START_EVENT } from "../omp/rpc-driver";
import { type HealedSessionModel, healSessionModelFile, newestSessionFile } from "../omp/session-heal";
import {
	CACHE_MISS_NOTIFY_MS,
	CACHE_MISS_NOTIFY_TOKENS,
	type CacheBaseline,
	CacheMonitor,
	cacheCallOf,
	isColdCache,
} from "../ops/cache-monitor";
import { COST_CAP_STOP_PREFIX, messageCost } from "../ops/cost-cap";
import { captureHeads, captureTrees, recordTurn } from "../ops/turn-snapshot";
import { byteLength, redact } from "../redact";
import { injectionWarning, scanForInjection } from "../safety/injection";
import { peerTouchedTurnNotice } from "../safety/prompt";
import type { InboundRow, OriginRow } from "../store/db-rows";
import type { UncertainReason } from "../store/transitions";
import { typicalTurnDuration } from "../store/turn-duration";
import { classifyFailure } from "./failure-kind";
import { type IdleKeepDeps, IdleKeeper, type IdleSweepContext } from "./idle-keep";
import { newActiveTurn } from "./mailbox-active-turn";
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
import { purposeBlockOf, runPurposeCommand, setHome } from "./mailbox-purpose";
import { beginSend, parkInterruptedSends, REFUSED_OP_PREFIX, settleFailedSend } from "./mailbox-sending";
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
import {
	type ActiveTurn,
	DEFAULT_ESCALATE_AFTER,
	failureSign,
	isAutonomousRow,
	isModelFailureSign,
	isProviderLimit,
	MAX_STEERS,
	type MailboxDeps,
	type MailboxHost,
	type MailboxState,
	minutes,
	openOriginSession,
	type PauseCheck,
	RECENT_TOOLS,
	type SessionOpenCheck,
	type StallEscalation,
	sessionToResume,
	todoProgress,
} from "./mailbox-types";
import { startUndo } from "./mailbox-undo";
import { parseThreadRef, TOP_LEVEL_TS } from "./normalize";
import { parseChatOrigin } from "./origin-key";
import { buildRecallBlock } from "./recall";
import { epochDirIsFresh } from "./sessions";
import { stuckCancelReason, stuckSteerText } from "./stuck";
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
	TurnUndoDeps,
} from "./mailbox-types";
export { isAutonomousRow, isProviderLimit, openOriginSession, sessionToResume } from "./mailbox-types";

/**
 * Serial actor for one origin. Every inbound message, driver final and driver exit is processed on one
 * promise chain, so the ledger writes never interleave. It talks to omp only through the injected driver and
 * to the chat never: replies become delivery rows in the store.
 */
export class OriginMailbox {
	readonly #deps: MailboxDeps & IdleKeepDeps;
	readonly #idle: IdleKeeper;
	readonly #host: MailboxHost;
	readonly #idleStopMs: number;
	#tail: Promise<unknown> = Promise.resolve();
	#driver: OmpSessionDriver | undefined;
	readonly #context = new ContextMemory();
	#unsubscribe: Array<() => void> = [];
	#turn: ActiveTurn | undefined;
	/** `#startTurn` calls in flight: the child spawn and ready wait come before `#turn` is set. */
	#starting = 0;
	/** Incremented when a turn starts: `!undo` compares it to refuse a restore after a new turn began. */
	#turnGeneration = 0;
	/**
	 * The repositories the origin's most recent settled turn could not snapshot (`turn.opRef` + reasons), kept in memory
	 * only: a later turn overwrites it. `!undo` uses it to refuse reverting an older turn of such a repository.
	 */
	#lastUndoFailures: { opRef: string; failed: ReadonlyMap<string, string> } | undefined;
	#lastActivityAt: number;
	#lastEventAt = 0;
	/** When the running turn's last event was written to the ledger (throttled by EVENT_PERSIST_MS). */
	#eventPersistedAt = 0;
	#stalled = false;
	/** True until the first prompt of a freshly created session (`openSession` resumed=false): the one turn that may carry injected thread context. */
	#freshSession = false;
	/** The driver dropped a full conversation after the last turn (agy rotation): the next prompt re-feeds the thread. */
	#rotatedSession = false;
	/**
	 * Whether the live child needs no peer-taint notice: it was started after a peer bot wrote here (reduced host tools,
	 * told in its system prompt), it has no host tools (`hostTools`), or a prompt carrying `peerTouchedTurnNotice` went
	 * through. A child started before keeps its full tool list; the daemon refuses the restricted ones when they run.
	 */
	#skipPeerNotice = false;
	/** Host tool calls (approval wait, upload, dispatch) running for this origin's child; no omp events come meanwhile. */
	#hostToolsRunning = 0;
	#stopAfterTurn = false; // set by `stopWhenIdle()` while a turn runs: the child is stopped once that turn has settled
	#redrain = false; // set by `/queue retry`: the command's end runs a drain so the row it made pending goes out
	readonly #turnEndWaiters: Array<() => void> = []; // `whenTurnEnds` callers, woken where the turn is dropped (final, exit, `/new`)
	#acceptingDispatch = true; // cleared at shutdown (`stopDispatching`): pending rows stay pending, the drain awaits running turns only
	#consecFailures = 0; // failed turns in a row; a completed turn resets it
	/** Epochs whose session mismatch was already passed to `onSessionMismatch` (memory only: a restart may tell again). */
	readonly #mismatchNoticed = new Set<number>();
	/**
	 * Prompt cache state of this origin's session (re-seeded from the session after a restart); a session change
	 * (`/new`, `/resume`, a monitor fire's new epoch) starts a fresh one, so its first call is not judged on the old prefix.
	 */
	#cache = new CacheMonitor();
	/** When `onCacheMiss` last fired (memory only: a restart may tell once more). */
	#cacheNoticedAt: number | undefined;
	/** The baseline the cold-cache warning was last given for (memory only). */
	#coldWarned: CacheBaseline | undefined;

	constructor(deps: MailboxDeps & IdleKeepDeps) {
		this.#deps = deps;
		this.#host = {
			deps,
			turn: () => this.#turn,
			driver: () => this.#driver,
			turnGeneration: () => this.#turnGeneration,
			lastUndoFailures: () => this.#lastUndoFailures,
			serial: (task) => this.#serial(task),
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
				try {
					await driver.abort();
				} catch (error) {
					log.warn("pause_abort_failed", { origin: originKey, opRef: turn?.opRef, error: String(error) });
				}
				if (turn !== undefined && this.#turn === turn && this.#driver === driver) {
					await this.#onFinal(driver, {
						opRef: turn.opRef,
						status: "aborted",
						text: "",
						error: "lane_paused",
					});
				}
			}
			const settled = this.#driver === undefined || (await this.#driver.state()).settled !== false;
			return { busy: this.#turn !== undefined, settled };
		});
	}

	/**
	 * Startup recovery: dispatch rows that are already in the ledger as `pending` (their thread comes from the row).
	 * A `sending` row (a send cut before its outcome was recorded) is parked as `uncertain`, never sent again.
	 * Resolves when the drain has finished.
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
	 * Reports a running turn that has emitted no omp event for `STALL_MS`. Synchronous and clock-driven, so the daemon
	 * sweep and tests with a fake clock both call it. Returns whether a new stall just began.
	 * Never while a host tool runs: the child waits on jabbu (an approval click, an upload), not on its model. Never
	 * while the turn waits for its unsettled session's late runs either (`tailWaiting`): that wait is expected.
	 *
	 * Stalls of one turn merge: the first logs `stall_alert` and shows the stalled status text; later ones log
	 * `stall_repeat` (count, totalSilentMs) and leave the text alone until `STALL_RELEASE_MS` of calm. Every call also
	 * judges the turn's accumulated silence: a conversation turn past the count/time threshold asks the owner once
	 * (never aborted), a monitor turn past its threshold is aborted and failed.
	 */
	checkStall(): boolean {
		const turn = this.#turn;
		if (!turn || this.#hostToolsRunning > 0 || turn.tailWaiting) return false;
		const { originKey, log, onStall, clock } = this.#deps;
		const now = clock.now();
		let began = false;
		if (!this.#stalled) {
			const silentMs = now - this.#lastEventAt;
			if (silentMs >= STALL_MS) {
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
			} else if (turn.stallShown && now - turn.stallClearedAt >= STALL_RELEASE_MS) {
				turn.stallShown = false;
				log.info("stall_released", { origin: originKey, opRef: turn.opRef, count: turn.stallCount });
				onStall?.({ originKey, threadRef: turn.threadRef, stalled: false, silentMs });
			}
		}
		this.#judgeStall(turn, now);
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
	 * Monitor turn that stayed silent too long: abort the child and settle the turn as failed through the normal
	 * failure path (`recordTurnFailure` → monitor event failed with retry/backoff). The child is stopped afterwards —
	 * it was wedged, and a monitor's next fire starts a fresh session anyway. A real `aborted` final that wins the race
	 * settles the turn first; this then does nothing.
	 */
	async #abortStalled(turn: ActiveTurn, totalSilentMs: number): Promise<void> {
		const driver = this.#driver;
		if (!driver || this.#turn !== turn) return;
		const { originKey, log } = this.#deps;
		try {
			await driver.abort();
		} catch (error) {
			log.warn("stall_abort_failed", { origin: originKey, opRef: turn.opRef, error: String(error) });
		}
		if (this.#turn !== turn || this.#driver !== driver) return;
		await this.#onFinal(
			driver,
			{
				opRef: turn.opRef,
				status: "aborted",
				text: "",
				error: `stall_abort silent=${minutes(totalSilentMs)}`,
			},
			true,
		);
	}

	/**
	 * Turn caught in a tool repeat loop: abort the child and settle the turn as failed (`stuck-loop: …`) through the
	 * normal failure path. The child is kept — it is not wedged, and its session holds the conversation — unless the
	 * abort itself failed: then it is stopped before the drain. A final that
	 * settled the turn first wins; this then does nothing (no notice either).
	 */
	async #abortStuck(turn: ActiveTurn, toolName: string, count: number): Promise<void> {
		const driver = this.#driver;
		if (!driver || this.#turn !== turn) return;
		const { originKey, log } = this.#deps;
		log.warn("stuck_loop_cancel", { origin: originKey, opRef: turn.opRef, tool: toolName, count });
		this.#deps.onStuckLoop?.({ originKey, threadRef: turn.threadRef, opRef: turn.opRef, toolName, count });
		let abortFailed = false;
		try {
			await driver.abort();
		} catch (error) {
			abortFailed = true;
			log.warn("stuck_abort_failed", { origin: originKey, opRef: turn.opRef, error: String(error) });
		}
		if (this.#turn !== turn || this.#driver !== driver) return;
		// An abort that failed may leave the child running: stop it, so no answer arrives after the failure notice.
		await this.#onFinal(
			driver,
			{
				opRef: turn.opRef,
				status: "aborted",
				text: "",
				error: stuckCancelReason(toolName, count),
			},
			abortFailed,
		);
	}

	/**
	 * Adds one assistant call's price to the running turn, judges the turn with what is known now, and re-reads the
	 * turn's sub-agent transcripts off the actor's chain (a sub-agent may be spending while this session is quiet).
	 * The judgement is repeated after that read, so a total that only crosses the ceiling through sub-agents still
	 * warns and still stops at the multiple.
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
			// Real omp starts a run when steered while idle: only steer the turn that is still running.
			if (this.#turn !== turn || !this.#driver) return;
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
		log.warn("provider_limit_hit", { origin: originKey, attempt, error: redact(errorMessage).slice(0, 200) });
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
		this.#turn?.live.feed(event);
		if (this.#onRetryEvent(event)) return;
		const waiting = event.type === TAIL_WAIT_START_EVENT;
		const tailTurn = this.#turn;
		if (tailTurn !== undefined && tailTurn.opRef === event.opRef && (waiting || event.type === TAIL_WAIT_END_EVENT)) {
			tailTurn.tailWaiting = waiting;
			// A nudge after the wait must not count the silence from before it.
			if (!waiting) tailTurn.stallClearedAt = this.#deps.clock.now();
		}
		if (event.type === "auto_compaction_end") this.#cache.markCompacted();
		if (event.type === "message_end") this.#observeCache(event.message);
		if (event.type === "message_end" && this.#turn) this.#accrueTurnCost(this.#turn, event.message);
		// A `task` result is where sub-agent spend lands: re-read before the turn goes on, so the cap sees it.
		if (event.type === "tool_execution_end" && event.toolName === "task" && this.#turn) {
			refreshSubAgentCost(this.#host, this.#turn);
		}
		if (this.#turn && (event.type === "tool_execution_start" || event.type === "tool_execution_end")) {
			this.#observeTool(this.#turn, event);
		}
		if (this.#turn) this.#sendInterimOf(this.#turn, event);
		if (event.type === "tool_execution_start") {
			const tool = typeof event.toolName === "string" ? event.toolName : undefined;
			this.#deps.log.info("tool_start", { origin: this.#deps.originKey, tool });
			// Held (a paused lane) and no turn of ours: a queued message omp started on its own — work while paused.
			if (tool !== undefined && this.#turn === undefined && this.#deps.isHeld?.()) {
				this.#deps.onHeldWork?.({ originKey: this.#deps.originKey });
				return;
			}
			const turn = this.#turn;
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
		if (event.type === "tool_execution_end" && typeof event.toolCallId === "string" && this.#turn) {
			const entry = this.#turn.progress.recentTools.find((tool) => tool.callId === event.toolCallId);
			if (entry !== undefined) {
				entry.state = event.isError === true ? "error" : "ok";
				entry.endedAt = this.#deps.clock.now();
				this.#reportProgress(this.#turn);
			}
		}
		if (event.type === "tool_execution_end" && event.toolName === "todo" && event.isError !== true && this.#turn) {
			const todo = todoProgress(event.result);
			if (todo !== undefined) {
				this.#turn.progress.todo = todo;
				this.#reportProgress(this.#turn);
			}
		}
		const now = this.#deps.clock.now();
		const silentMs = now - this.#lastEventAt;
		this.#lastEventAt = now;
		const turn = this.#turn;
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
	async #seedCache(driver: OmpSessionDriver): Promise<void> {
		if (this.#cache.baseline !== undefined) return;
		try {
			const last = (await driver.entriesSince()).entries.findLast((entry) => entry.message?.role === "assistant");
			const stamp = last?.timestamp;
			const at = typeof stamp === "string" ? Date.parse(stamp) : typeof stamp === "number" ? stamp : Number.NaN;
			const call = Number.isNaN(at) ? undefined : cacheCallOf(last?.message, at);
			if (call !== undefined) this.#cache.seed(call);
		} catch (error) {
			this.#deps.log.warn("cache_seed_failed", { origin: this.#deps.originKey, error: String(error) });
		}
	}

	/** One line to the new turn's thread when it resumes a large conversation whose cache has expired. */
	#warnColdCache(threadRef: string): void {
		const { originKey, clock, log } = this.#deps;
		if (originKey.startsWith(MONITOR_ORIGIN_PREFIX)) return;
		const baseline = this.#cache.baseline;
		const now = clock.now();
		if (baseline === undefined || baseline === this.#coldWarned || !isColdCache(baseline, now)) return;
		this.#coldWarned = baseline;
		const price = this.#cache.writeCostPerToken;
		const idleMs = now - baseline.at;
		log.info("cold_cache_warned", { origin: originKey, prefix: baseline.prefix, idleSec: Math.round(idleMs / 1000) });
		this.#deps.onColdCache?.({
			originKey,
			threadRef,
			prefixTokens: baseline.prefix,
			idleMs,
			...(price === undefined ? {} : { estimatedCost: price * baseline.prefix }),
		});
	}

	/**
	 * Interim delivery of a running conversation turn (never a monitor's: its answer is machine-read at the turn end).
	 * A note next to a `wait` call goes out at its `message_end`. A stop-ended answer waits for the next message or
	 * tool call — proof the turn goes on (rule-guards continuation, incomplete-items reminder) — so a turn's last
	 * answer still goes out at the turn end under the turn's op ref. The start of the wait for an unsettled session
	 * (`tail_wait_start`) is such proof too: the prompt's answer goes out now, not after the background work.
	 */
	#sendInterimOf(turn: ActiveTurn, event: OmpEvent): void {
		if (this.#deps.originKey.startsWith(MONITOR_ORIGIN_PREFIX) || isTaskOrigin(this.#deps.originKey)) return;
		const flushes = ["message_start", "message_end", "tool_execution_start", TAIL_WAIT_START_EVENT];
		if (!flushes.includes(event.type)) return;
		const pending = turn.pendingAnswer;
		turn.pendingAnswer = undefined;
		if (pending !== undefined && this.#recordInterim(turn, pending)) {
			turn.lastInterimDeliveredAt = this.#deps.clock.now();
		}
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
		if (this.#turn !== undefined) return;
		for (const wake of this.#turnEndWaiters.splice(0)) wake();
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
			this.#deps.log.error(event, { origin: this.#deps.originKey, error: String(error) });
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
		if (command?.kind === "restart") {
			// Before the drain and attach deferrals: a held `!restart` would run again in the next process.
			await this.#runCommand(row, command);
			return;
		}
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

	/**
	 * Dispatch pending rows in arrival order; a row that cannot be steered stays pending and blocks the ones behind it.
	 * A `followup` row is never steered: it waits (without blocking later messages) until no turn runs, then starts one.
	 */
	async #drain(): Promise<void> {
		const { store, originKey } = this.#deps;
		// A restart drain: rows wait for the next process (or the cancel). A paused lane: rows wait for the owner's
		// resume. Either way a `!restart` is answered now: held over a drain, the next process would run it once more.
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
				// A peer bot's request is never steered into a running turn (that turn's child may hold owner-grade
				// tools) and never answers a dialog or runs as a command: it waits like a followup for an idle origin.
				if (this.#turn) continue;
				if (!(await this.#dispatch(row))) break;
				continue;
			}
			if (isHomeCommand(row.textRef)) {
				setHome(this.#deps, row);
				continue;
			}
			const command = parseCommand(row.textRef);
			if (command?.kind === "followup" && command.arg !== "") {
				if (this.#turn) continue;
				if (!(await this.#dispatch(row, command.arg))) break;
				continue;
			}
			if (command?.kind === "btw" && command.arg !== "" && !this.#turn) {
				// No turn to ask beside: the question itself (without the command word) starts a turn.
				if (!(await this.#dispatch(row, command.arg))) break;
				continue;
			}
			if (command) {
				await this.#runCommand(row, command);
				continue;
			}
			// The one place a plain message can answer an open dialog: every path (enqueue, the daemon's
			// recordInbound + resumePending, the sweep retry) drains here. A restart drain returned above, so its rows
			// wait; the card's own deadline bounds that wait, no deadlock.
			if (await this.#answerDialog(row)) continue;
			// A turn at its steer cap leaves the row pending for the next turn; rows behind it (commands, a card's
			// answer) are not blocked, so this is a `continue`, not a `break`.
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

	/**
	 * The steer went out but its outcome is unknown (it threw, the turn ended around it, or the ledger write failed):
	 * the row is parked as `uncertain` instead of replayed, so no input runs twice. Resolves true — this row is done,
	 * later rows still go out; the owner closes or retries it with `/queue`.
	 */
	#parkUncertain(row: InboundRow, reason: UncertainReason, error?: unknown): boolean {
		const { store, log, originKey } = this.#deps;
		store.markUncertain(row.platformMessageId, reason);
		log.warn("inbound_uncertain", {
			origin: originKey,
			id: row.platformMessageId,
			reason,
			...(error === undefined ? {} : { error: String(error) }),
		});
		return true;
	}

	/** Records a delivered row as dispatched; a failed ledger write parks it as `uncertain` (never re-sent): false. */
	#markOrPark(row: InboundRow, input: { opRef: string; entryCursor: string | null }): boolean {
		try {
			this.#deps.store.markDispatched(row.platformMessageId, input);
			return true;
		} catch (error) {
			return !this.#parkUncertain(row, "dispatch_record_failed", error);
		}
	}

	/** Returns false when the row was left pending (nothing was sent). */
	async #dispatch(row: InboundRow, text: string = row.textRef): Promise<boolean> {
		const { store, log, originKey } = this.#deps;
		if (this.#deps.isHeld?.()) return false; // a paused lane: the row stays pending for the resume
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
			let late: "settled" | "final" | undefined;
			let entryCursor: string | null;
			try {
				entryCursor = await driver.leafId();
				late = ended();
			} catch (error) {
				log.warn("steer_failed", {
					origin: originKey,
					id: row.platformMessageId,
					action: "defer",
					error: String(error),
				});
				return false;
			}
			if (late !== undefined) {
				log.info("steer_turn_ended", { origin: originKey, id: row.platformMessageId, opRef: turn.opRef, late });
				return late === "settled" ? this.#dispatch(row, text) : false;
			}
			if (!beginSend(this.#deps, row, entryCursor)) return false;
			try {
				await driver.steer(composeTurnPrompt(blocks, text, false));
			} catch (error) {
				return this.#parkUncertain(row, "steer_threw", error);
			}
			if (ended() !== undefined) return this.#parkUncertain(row, "turn_ended_after_steer");
			if (!this.#markOrPark(row, { opRef: turn.opRef, entryCursor })) return true;
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
		if (sent === "parked") {
			// The child may hold the prompt: stopped, so no run goes on untracked; the owner decides with `/queue`.
			await this.#stopDriver().catch(() => undefined);
			return true;
		}
		const rawReason = failureSign(failure);
		const code = failure instanceof OmpDriverError ? failure.code : "dispatch_error";
		log.error("dispatch_failed", { origin: originKey, id: row.platformMessageId, code, error: String(failure) });
		this.#logTurnFailed(rawReason);
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
		await this.#noteTurnFailure(row.threadRef, rawReason);
		return true;
	}

	/**
	 * The work trees as they are before this turn's prompt. Only conversation origins of a chat platform and only the
	 * configured repositories: a monitor turn or a lane turn (its own worktree and branch) has nothing to undo here, and
	 * without `turnUndo` (or with no repository configured) no git is ever started.
	 */
	async #captureUndoBefore(originKey: string): Promise<ActiveTurn["undoBefore"]> {
		const turnUndo = this.#deps.turnUndo;
		if (turnUndo === undefined || parseChatOrigin(originKey) === undefined) return undefined;
		const repos = turnUndo.repos();
		if (repos.length === 0) return undefined;
		// Stamped before the capture starts: a turn that ends while the capture runs still overlaps.
		const startedAt = this.#deps.clock.now();
		const captured = await captureTrees(repos, { run: turnUndo.run, log: this.#deps.log });
		// Every repository failing still matters: `!undo` must say so instead of walking back to an older turn.
		if (captured.trees.size === 0 && captured.failed.size === 0) return undefined;
		return { startedAt, before: captured.trees, failed: captured.failed };
	}

	/**
	 * Without snapshots (`turnUndo.repos()` empty): the HEADs of `turnUndo.headRepos()` before this conversation turn, so
	 * a commit still reaches the wiki turn notes. Same origins as the snapshots; no list = no git.
	 */
	async #captureHeadsBefore(originKey: string): Promise<ActiveTurn["headsBefore"]> {
		const turnUndo = this.#deps.turnUndo;
		if (turnUndo === undefined || parseChatOrigin(originKey) === undefined || turnUndo.repos().length > 0)
			return undefined;
		const repos = turnUndo.headRepos?.() ?? [];
		if (repos.length === 0) return undefined;
		const heads = await captureHeads(repos, { run: turnUndo.run, log: this.#deps.log });
		return heads.size === 0 ? undefined : heads;
	}

	/** The heads after a turn captured by `#captureHeadsBefore`: the repositories it committed in go to `onCommitted`. */
	async #recordHeadsAfter(turn: ActiveTurn): Promise<void> {
		const before = turn.headsBefore;
		const turnUndo = this.#deps.turnUndo;
		if (before === undefined || turnUndo?.onCommitted === undefined) return;
		const { originKey, log } = this.#deps;
		try {
			const after = await captureHeads([...before.keys()], { run: turnUndo.run, log });
			const endedAt = this.#deps.clock.now();
			const rows = [...before].flatMap(([repo, headBefore]) => {
				const headAfter = after.get(repo);
				return headAfter === undefined || headAfter === headBefore ? [] : [{ repo, headBefore, headAfter, endedAt }];
			});
			if (rows.length > 0)
				await turnUndo.onCommitted({ originKey, opRef: turn.opRef, threadRef: turn.threadRef, rows });
		} catch (error) {
			log.warn("turn_head_failed", { origin: originKey, opRef: turn.opRef, error: String(error) });
		}
	}

	/**
	 * The after-state of a settled turn, recorded as one ledger row per changed repository so `!undo` can put exactly
	 * those files back. Runs after the answer is stored: a slow or failing git never costs the owner the answer. A
	 * repository that could not be captured is remembered for `!undo`, which must not mistake an older turn for it.
	 */
	async #recordUndoAfter(turn: ActiveTurn): Promise<void> {
		const captured = turn.undoBefore;
		const turnUndo = this.#deps.turnUndo;
		if (captured === undefined || turnUndo === undefined) return;
		const { store, originKey, log } = this.#deps;
		try {
			// Only the repositories captured before are compared: a reload in between must not invent a before-state.
			const live = turnUndo.repos().filter((repo) => captured.before.has(repo));
			const failed = new Map(captured.failed);
			if (live.length === 0) {
				this.#lastUndoFailures = { opRef: turn.opRef, failed };
				return;
			}
			const after = await captureTrees(live, { run: turnUndo.run, log });
			for (const [repo, reason] of after.failed) failed.set(repo, reason);
			this.#lastUndoFailures = { opRef: turn.opRef, failed };
			const capture = {
				startedAt: captured.startedAt,
				endedAt: this.#deps.clock.now(),
				before: captured.before,
				after: after.trees,
			};
			const written = await recordTurn({ store, originKey, opRef: turn.opRef, capture, run: turnUndo.run, log });
			if (written > 0) log.info("turn_snapshot", { origin: originKey, opRef: turn.opRef, repos: written });
			const committed = written === 0 ? [] : store.listTurnSnapshots({ originKey, opRef: turn.opRef });
			const heads = committed.filter((row) => row.headBefore !== row.headAfter);
			if (heads.length > 0) {
				await turnUndo.onCommitted?.({ originKey, opRef: turn.opRef, threadRef: turn.threadRef, rows: heads });
			}
		} catch (error) {
			log.warn("turn_snapshot_failed", { origin: originKey, opRef: turn.opRef, error: String(error) });
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

	async #openTurn(row: InboundRow, text: string): Promise<boolean> {
		const { store, log, originKey } = this.#deps;
		const driver = await this.#ensureDriver(row.threadRef);
		// A child started before a peer bot wrote here is kept: it is told once, in front of its next prompt.
		const peerNotice = !this.#skipPeerNotice && store.originHasPeerInbound(originKey);
		this.#warnColdCache(row.threadRef);
		// Only a lane's first prompt has anything to check; every other turn goes on without an extra await.
		const refusal = this.#freshSession ? this.#deps.launchRefusal?.(driver) : undefined;
		if (refusal !== undefined && (await this.#refuseLaunch(row, await refusal))) return true;
		// Before `#firstTurnPrompt` clears the fresh flag: a continued session already has its todos.
		if (this.#freshSession) await this.#plantTodos(driver);
		// Read the cursor right before the prompt: extensions append entries after open.
		const entryCursor = await driver.leafId();
		// Before the prompt, not after: the first tool call would otherwise race the capture and land in no turn's diff.
		const undoBefore = await this.#captureUndoBefore(originKey);
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
			recorded = this.#markOrPark(row, { opRef, entryCursor });
		} finally {
			if (!recorded) await this.#stopDriver().catch(() => undefined);
		}
		if (!recorded) return true;
		this.#turnGeneration += 1;
		this.#turn = newActiveTurn(this.#deps.clock, row, { opRef, entryCursor, undoBefore, headsBefore });
		this.#lastEventAt = this.#deps.clock.now();
		this.#eventPersistedAt = this.#lastEventAt;
		this.#stalled = false;
		log.info("turn_start", { origin: originKey, epoch: row.epoch, opRef });
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
			log.error("launch_refused_failed", { origin: originKey, error: String(error) });
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
		const blocks: string[] = peerNotice ? [peerTouchedTurnNotice(originKey)] : [];
		// The rotation block already holds the thread head the fresh-session block would give.
		const context = rotated
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
				candidates: store.listRecallCandidates(channel, row.threadRef, RECALL_CANDIDATE_LIMIT),
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
		const findings = scanForInjection(answers.join("\n"), where);
		const warning = injectionWarning(findings);
		if (warning === null) return block;
		this.#deps.log.info("injection_flagged", {
			origin: this.#deps.originKey,
			where,
			kinds: findings.map((f) => f.kind),
		});
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

	/**
	 * Session-file heal for a restore-model failure (no live driver — `#healStaleModel` cannot run): the file
	 * omp resumes (`/resume-jabbu`'s pin, else the newest of the session dir — the rule `openOriginSession`
	 * binds) has the `model_change` omp restores from (the last one; after a `role: "fallback"` retry hop, the last
	 * one whose role is default) rewritten to the fallback, the same chain `#healStaleModel` uses:
	 * `#effectiveSettings` → `defaultModel`. The original is backed up under the origin's backup dir first;
	 * nothing is touched when there is no fallback, no file, or nothing to rewrite (already the fallback).
	 */
	async #healSessionFile(): Promise<HealedSessionModel | undefined> {
		const { store, log, originKey, defaultModel, sessionBackupsRoot } = this.#deps;
		if (sessionBackupsRoot === undefined) return undefined;
		const origin = store.getOrigin(originKey);
		if (origin === undefined) return undefined;
		const fallback = this.#effectiveSettings(origin).model ?? defaultModel;
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
		// Freshness must be read before the child exists: a spawned omp child (and the fake driver's `start()`)
		// already holds the newest session of the directory, so `openSession()` reports `resumed` even for a
		// session created moments ago at startup. An epoch dir with no session file is the only trustworthy
		// "this session will be the first" signal — the one moment thread context may be injected.
		this.#freshSession = epochDirIsFresh(origin.sessionDir);
		const expected = sessionToResume(origin);
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
		await this.#applySettings(driver, origin);
		await this.#seedCache(driver);
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

	/**
	 * Effective chat-chosen settings. A thread origin (`…/t/<ts>`) with no choice of its own inherits the parent
	 * channel's choice, so a new thread follows the channel's `/model-jabbu`·`/thinking-jabbu` until the thread
	 * sets its own. Every other origin kind never inherits.
	 */
	#effectiveSettings(origin: OriginRow): { model: string | null; thinking: string | null } {
		const { originKey, store } = this.#deps;
		if (originKey.startsWith(MONITOR_ORIGIN_PREFIX)) {
			// A monitor's own pinned model/thinking beat the origin row field by field; an unpinned field (or a removed
			// monitor) falls back to the origin row.
			const monitor = store.monitors.getMonitor(originKey.slice(MONITOR_ORIGIN_PREFIX.length));
			return { model: monitor?.model ?? origin.model, thinking: monitor?.thinking ?? origin.thinking };
		}
		const threadMark = originKey.indexOf("/t/");
		if (threadMark === -1 || (origin.model !== null && origin.thinking !== null)) {
			return { model: origin.model, thinking: origin.thinking };
		}
		const parent = store.getOrigin(originKey.slice(0, threadMark));
		if (parent === undefined) return { model: origin.model, thinking: origin.thinking };
		return { model: origin.model ?? parent.model, thinking: origin.thinking ?? parent.thinking };
	}

	/**
	 * Re-applies the model and thinking level chosen in chat each time a child opens the session (after idle release, a
	 * restart, `/new-jabbu` or `/resume-jabbu`). A setting omp no longer accepts is logged and left out, never fatal.
	 */
	async #applySettings(driver: OmpSessionDriver, origin: OriginRow): Promise<void> {
		const { log, originKey } = this.#deps;
		const { model, thinking } = this.#effectiveSettings(origin);
		// One model list for the chosen-model check and the heal below; a failed read falls back to the old
		// attempt-and-warn behavior for both.
		const models = await driver.availableModels().catch((error: unknown) => {
			log.warn("models_list_failed", { origin: originKey, error: String(error) });
			return undefined;
		});
		if (model !== null) {
			if (models !== undefined && !models.includes(model)) {
				// The provider removed the chat-chosen model: skip the doomed `setModel` (it would only warn on
				// every child open) and keep the choice in origin settings — it applies again once the model returns.
				log.warn("model_apply_unavailable", { origin: originKey, model });
			} else {
				await driver.setModel(model).catch((error: unknown) => {
					log.warn("model_apply_failed", { origin: originKey, model, error: String(error) });
				});
			}
		}
		if (thinking !== null) {
			await driver.setThinking(thinking).catch((error: unknown) => {
				log.warn("thinking_apply_failed", { origin: originKey, thinking, error: String(error) });
			});
		}
		await this.#healStaleModel(driver, origin, models).catch((error: unknown) => {
			log.warn("model_heal_failed", { origin: originKey, error: String(error) });
		});
	}

	/**
	 * A session restored with a model omp no longer knows (removed provider) fails every turn with
	 * `Could not restore model` until something switches it. When the session's active model is missing from omp's
	 * list, switch to the chat-chosen model if that still exists, else to the config default. Never fatal.
	 * `models` reuses a list `#applySettings` already read for the same child; omitted, it reads its own.
	 */
	async #healStaleModel(
		driver: OmpSessionDriver,
		origin: OriginRow,
		models?: string[],
	): Promise<"noop" | "replaced" | "no_fallback"> {
		const { log, originKey, defaultModel } = this.#deps;
		const active = (await driver.state()).model;
		if (active === undefined) return "noop";
		const listed = models ?? (await driver.availableModels());
		if (listed.includes(active)) return "noop";
		const inherited = this.#effectiveSettings(origin).model;
		const fallback =
			inherited !== null && listed.includes(inherited)
				? inherited
				: defaultModel !== undefined && listed.includes(defaultModel)
					? defaultModel
					: undefined;
		if (fallback === undefined) {
			log.warn("model_stale_no_fallback", { origin: originKey, model: active });
			return "no_fallback";
		}
		await driver.setModel(fallback);
		log.warn("model_stale_replaced", { origin: originKey, from: active, to: fallback });
		return "replaced";
	}

	/**
	 * Counts the failed turn. A model-shaped sign re-heals the live driver right away — the session-open heal cannot
	 * help a child whose model vanished while it ran, and waiting for `escalateAfter` would burn the outage's first
	 * user messages on failures the very first one could already have fixed. `onEscalate` reports the run to the
	 * owner at `escalateAfter` consecutive failures (and on every failure past it). A completed turn resets the count.
	 */
	async #noteTurnFailure(threadRef: string, reason: string): Promise<void> {
		this.#consecFailures += 1;
		const { originKey, log, onEscalate } = this.#deps;
		let modelHealed = false;
		if (this.#driver !== undefined && isModelFailureSign(reason)) {
			const origin = this.#deps.store.getOrigin(originKey);
			if (origin) {
				const healed = await this.#healStaleModel(this.#driver, origin).catch((error: unknown) => {
					log.warn("model_heal_failed", { origin: originKey, error: String(error) });
					return "error" as const;
				});
				modelHealed = healed === "replaced";
			}
		}
		const threshold = this.#deps.escalateAfter ?? DEFAULT_ESCALATE_AFTER;
		if (threshold <= 0 || this.#consecFailures < threshold) return;
		log.error("turn_failures_escalated", {
			origin: originKey,
			failures: this.#consecFailures,
			modelHealed,
			reason: reason.replace(/\s+/g, " ").slice(0, 160),
		});
		onEscalate?.({ originKey, threadRef, failures: this.#consecFailures, reason, modelHealed });
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

	/** `stopFirst`: the wedged child is stopped before the drain, so a queued next row starts on a fresh child. */
	async #onFinal(driver: OmpSessionDriver, final: OmpFinal, stopFirst = false): Promise<void> {
		const { store, originKey, log } = this.#deps;
		const turn = this.#turn;
		if (driver !== this.#driver || !turn || turn.opRef !== final.opRef) {
			log.info("final_ignored", { origin: originKey, opRef: final.opRef });
			return;
		}
		this.#turn = undefined;
		this.#wakeTurnEndWaiters();
		this.#lastActivityAt = this.#deps.clock.now();
		if (final.usage?.rotated === true) this.#rotatedSession = true;
		await recordDailyCost(this.#deps, driver, turn, stopFirst, final.usage);
		const base = { originKey, opRef: turn.opRef, threadRef: turn.threadRef };
		if (final.status === "completed") {
			const answer = await this.#turnAnswer(driver, turn, final.text);
			store.recordAnswer({ ...base, parts: [answer.body], answer: answer.whole });
			if (isTaskOrigin(originKey))
				log.info("task_turn_output_dropped", { origin: originKey, chars: answer.whole.length });
			this.#consecFailures = 0;
		} else if (final.error === OWNER_STOP_ERROR) {
			// The owner's `!stop`: its answer (the `stop:` op, which took over the turn's rows) is the one message —
			// no notice, no failure count.
			log.info("owner_stop_settled", { origin: originKey, opRef: turn.opRef });
		} else if (final.error === "lane_paused") {
			// The owner's own hold, not a failure: no notice, no failure count — one short line in the thread.
			store.recordAnswer({
				...base,
				parts: ["⏸ 이 턴은 오너 멈춤 요청으로 중단됐습니다(레인 일시정지). 재개는 오너만 합니다."],
			});
		} else if ((final.error ?? "").startsWith(COST_CAP_STOP_PREFIX)) {
			// A spend brake, not a breakage: the notice carries the reason, the failure run stays as it was.
			const rawReason = final.error ?? final.status;
			this.#logTurnFailed(rawReason);
			store.recordTurnFailure({
				...base,
				notice: failedNotice(rawReason, turn.peer, this.#threadSource()),
			});
		} else {
			const rawReason = final.error ?? final.status;
			this.#logTurnFailed(rawReason);
			store.recordTurnFailure({
				...base,
				notice: failedNotice(rawReason, turn.peer, this.#threadSource()),
			});
			await this.#noteTurnFailure(turn.threadRef, rawReason);
		}
		const error = final.error ?? (final.status === "completed" ? undefined : final.status);
		this.#deps.onTurnSettled?.({
			originKey,
			text: final.text,
			openDialogs: this.#deps.dialogs?.open(originKey) ?? 0,
			...(error === undefined ? {} : { error }),
		});
		if (stopFirst) await this.#stopDriver();
		// After the answer is stored and before the next row starts: the drain below may open the next turn, and its
		// before-state must already include this turn's files.
		await this.#recordUndoAfter(turn);
		await this.#recordHeadsAfter(turn);
		await this.#drain();
		if (this.#stopAfterTurn && !this.#turn) {
			this.#stopAfterTurn = false;
			await this.#stopDriver();
		}
	}

	/**
	 * Every stop-ended answer since the turn's start cursor, ending with `finalText` (the session's last assistant text
	 * is never dropped), minus what the turn's interim deliveries already sent (`closingAnswer`: the closing mark when
	 * nothing is left; `whole` keeps every part). A monitor answer stays the last text only: its NO_REPORT/[SILENT]
	 * markers are read from the first and last line. When the cursor cannot be read the parts are `finalText` alone.
	 */
	async #turnAnswer(
		driver: OmpSessionDriver,
		turn: ActiveTurn,
		finalText: string,
	): Promise<{ body: string; whole: string }> {
		const { store, originKey, log } = this.#deps;
		if (originKey.startsWith(MONITOR_ORIGIN_PREFIX)) {
			return { body: finalText === "" ? NO_ANSWER : finalText, whole: finalText };
		}
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
			...(info.stderr === "" ? {} : { stderr: redact(info.stderr.slice(-300)) }),
		});
		const turn = this.#turn;
		this.#turn = undefined;
		this.#wakeTurnEndWaiters();
		// The dispatched rows of the dead turn are answered with one notice; the prompt is never resent.
		if (turn) {
			// The dead child spent money too: charge the day as `#onFinal` does (its live total when the state is gone).
			await recordDailyCost(this.#deps, driver, turn);
			const codeReason = `omp_exited code=${info.code ?? "null"}`;
			const stderrTail = info.stderr.trim();
			const classifyReason = stderrTail === "" ? codeReason : `${codeReason}: ${stderrTail}`;
			const logReason = stderrTail === "" ? codeReason : `${codeReason}: ${stderrTail.slice(-300)}`;
			this.#logTurnFailed(logReason, classifyReason);
			store.recordTurnFailure({
				originKey,
				opRef: turn.opRef,
				threadRef: turn.threadRef,
				notice: failedNotice(codeReason, turn.peer, this.#threadSource(), classifyReason),
			});
			await this.#noteTurnFailure(turn.threadRef, codeReason);
		}
		await this.#drain();
	}

	#logTurnFailed(rawReason: string, classifyReason = rawReason): void {
		const { kind } = classifyFailure(classifyReason);
		this.#deps.log.error("turn_failed", {
			origin: this.#deps.originKey,
			kind,
			reason: redact(rawReason).slice(0, 300),
		});
	}

	async #runCommand(row: InboundRow, command: ParsedCommand): Promise<void> {
		const { store, originKey, log } = this.#deps;
		const threadRef = row.threadRef;
		const opRef = `${command.kind}:${row.platformMessageId}`;
		if (command.kind === "new") {
			await this.#newEpoch(opRef, threadRef);
			return;
		}
		if (command.kind === "stop") {
			await this.#stopTurn(row, opRef);
			return;
		}
		// Mark first so a failing command can never leave its text pending for a later prompt.
		store.markDispatched(row.platformMessageId, { opRef, entryCursor: null });
		if (command.kind === "btw" && command.arg !== "" && this.#driver?.btw !== undefined) {
			askBtw(this.#deps, this.#driver.btw(command.arg), row.platformMessageId, opRef, threadRef);
			return;
		}
		if (command.kind === "undo") {
			// The card waits minutes: it must not hold the serial chain, or the next inbound could not start a turn.
			startUndo(this.#host, opRef, threadRef);
			return;
		}
		if (command.kind === "brief") {
			// Two chromium runs (up to 2x20s): like `!undo`, it must not hold the serial chain, so a message that comes
			// while the picture is drawn still starts its turn.
			startBrief(this.#deps, row.platformMessageId, opRef, threadRef);
			return;
		}
		let text: string;
		try {
			text = await commandReply(this.#host, command, opRef, threadRef);
		} catch (error) {
			const reason = error instanceof OmpDriverError ? error.message : String(error);
			log.error("command_failed", { origin: originKey, command: command.kind, error: reason });
			const notice = NO_MODEL_SIGN.test(reason) ? NO_MODEL_NOTICE : failedNotice(`${command.kind}: ${reason}`);
			store.recordTurnFailure({ originKey, opRef, threadRef, notice });
			return;
		}
		store.recordAnswer({ originKey, opRef, threadRef, parts: [text] });
		// `/queue retry` made a row pending after any drain listed its rows: send it now. An enclosing drain skips rows
		// that are no longer pending, so the nesting cannot send anything twice.
		if (this.#redrain) {
			this.#redrain = false;
			await this.#drain();
		}
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

	/**
	 * `!stop`: stops the running turn but keeps the session — no new epoch, the
	 * child stays. First the rows that waited before this command (a steer-blocked message, a `!followup`) are
	 * cancelled: the stopped turn's final drains, and they must not start the next turn. Then the turn is aborted with
	 * omp's own queue emptied, so a steered message does not run once more. The turn's rows move to the command op (as
	 * `/new` does), so the command's one answer finishes their threads' status as 🚫 취소됨 and the turn posts nothing.
	 * A child whose abort throws — or that still holds queued messages when no queue-clearing abort exists — is stopped;
	 * the next message reopens the same session directory.
	 */
	async #stopTurn(row: InboundRow, opRef: string): Promise<void> {
		const { store, originKey, log } = this.#deps;
		const pendingIds = store.listInbound({ originKey, state: "pending" }).map((pending) => pending.platformMessageId);
		const earlier = new Set(pendingIds.slice(0, Math.max(pendingIds.indexOf(row.platformMessageId), 0)));
		const cancelled = waitingRows(this.#host).filter((waiting) => earlier.has(waiting.row.platformMessageId));
		store.markDispatched(row.platformMessageId, { opRef, entryCursor: null });
		for (const waiting of cancelled) store.discard(waiting.row.platformMessageId, opRef);
		const note = cancelled.length === 0 ? "" : ` 대기 ${cancelled.length}개를 취소했습니다.`;
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
		let stopChild = false;
		try {
			if (driver.abortAndClearQueue !== undefined) await driver.abortAndClearQueue();
			else {
				await driver.abort();
				stopChild = (await driver.state()).queuedMessageCount > 0;
			}
		} catch (error) {
			stopChild = true;
			log.warn("owner_stop_abort_failed", { origin: originKey, opRef: turn.opRef, error: String(error) });
		}
		log.info("owner_stop", { origin: originKey, opRef: turn.opRef, cancelled: cancelled.length, stopChild });
		const settles = this.#turn === turn && this.#driver === driver;
		if (settles) {
			for (const dispatched of store.listInbound({ originKey, state: "dispatched" })) {
				if (dispatched.opRef === turn.opRef) store.discard(dispatched.platformMessageId, opRef);
			}
		}
		answer(OWNER_STOPPED_TEXT);
		if (settles) {
			const final: OmpFinal = { opRef: turn.opRef, status: "aborted", text: "", error: OWNER_STOP_ERROR };
			await this.#onFinal(driver, final, stopChild);
		}
	}

	/**
	 * /new: abort the running turn, charge what it spent, stop the child (the next dispatch opens the bumped epoch's
	 * empty session), bump the epoch (discards pending rows, this command included) and drop the old turn. A wedged
	 * child whose abort throws — when /new is needed most — is still stopped and the owner still gets the answer.
	 */
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
		// Rows dispatched into the aborted turn belong to the old epoch: their output must never be delivered.
		// They are linked to the command op so the command's delivery also finishes their status messages.
		for (const dispatched of store.listInbound({ originKey, state: "dispatched" })) {
			store.discard(dispatched.platformMessageId, opRef);
		}
		this.#deps.log.info("epoch_new", { origin: originKey, epoch });
		store.recordAnswer({ originKey, opRef, threadRef, parts: ["🆕 새 대화를 시작했습니다."] });
	}
}
