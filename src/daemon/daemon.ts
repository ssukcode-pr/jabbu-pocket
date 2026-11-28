import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChannelAdapter } from "../channel/adapter";
import { ChannelRegistry } from "../channel/registry";
import { cutCodePointSafe, errorFields, escapeMrkdwn } from "../channel/text";
import { type JabbuConfig, loadConfig, primaryOwnerUserId, WEB_OWNER_USER_ID } from "../config";
import { idleKeepOptions } from "../core/idle-keep";
import { coldResumeTokens, formatColdResumeNotice } from "../core/mailbox-cold-resume";
import type { ThreadSource } from "../core/mailbox-thread-context";
import { TOP_LEVEL_TS, threadRefOf } from "../core/normalize";
import { OriginRouter, sessionDirFor } from "../core/origin";
import { type ChatPlatform, parseChatOrigin, REMOVED_PLATFORM_PREFIXES } from "../core/origin-key";
import { COMMAND_OP_REF, type MailboxClock } from "../core/types";
import { snapshotReader } from "../dashboard/snapshot-assembly";
import { escapeDiscordMarkdown } from "../discord/format";
import { createDispatchAudit, installProcessAudit } from "../dispatch/audit";
import { realProcessRunner, setLocalHerdrBin } from "../dispatch/omp";
import { boardNoticeFor } from "../lanes/board";
import { createLaneLander, type LandLane } from "../lanes/land";
import { LaneManager } from "../lanes/manager";
import { landModeOf } from "../lanes/manager-pr-land";
import { createGateSlot } from "../lanes/qa";
import { isLaneOrigin } from "../lanes/status";
import type { Logger } from "../log";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { MonitorScheduler } from "../monitors/scheduler";
import { latestRotationContext } from "../omp/agy-quota";
import type { OmpDialogAnswerer, OmpSessionDriver } from "../omp/driver";
import {
	applyPathEnv,
	isExecutableFile,
	isReportOrigin,
	readAutoLandHold,
	readConfigText,
	recordLastGoodConfig,
	reportThreadPattern,
	spawnRunner,
} from "../ops/apply";
import { readStamp } from "../ops/backup";
import { formatCacheMissNotice, formatColdCacheNotice } from "../ops/cache-monitor";
import { type DailyBudgetState, dailyBudgetState, ledgerDay, renderBudget } from "../ops/cost-cap";
import { createFreezeProbe, type FreezeState } from "../ops/freeze";
import { gateOptionsFromConfig } from "../ops/gates";
import { HERDR_HEALTH_CHECK_MS, type HerdrHealthProbe } from "../ops/herdr-health";
import { resolvedCeiling } from "../ops/host-resources";
import { hostSessionsInfo } from "../ops/host-sessions";
import { sweepMedia } from "../ops/media-prune";
import { redact } from "../redact";
import { ApprovalBroker } from "../safety/approval";
import type { HostToolDef } from "../safety/host-tools";
import { buildFloorsPrompt, type FloorsSurface } from "../safety/prompt";
import type { Store } from "../store/db";
import type { TaskCheckRunner } from "../tasks/check-runner";
import { docsDirOf } from "../tasks/docs";
import { type TaskGateHooks, TaskGateRunner } from "../tasks/gate";
import { resolveTaskHost } from "../tasks/host";
import type { TaskLandOutcome } from "../tasks/land";
import { repoMatchesTask } from "../tasks/land-remote";
import type { TaskRow } from "../tasks/ledger";
import { TASK_SWEEP_MS, type TaskSweeper } from "../tasks/sweeper";
import { notifyWebOwnerTurn } from "../web/notify";
import { turnNoteRepos, WikiNotes } from "../wiki/notes";
import { type BootBackupHandle, startBootBackup } from "./boot-backup";
import { readBotUsageSummary } from "./bot-driver";
import { uploadBriefing } from "./briefing-upload";
import { DIALOG_AMBIGUOUS_NOTICE, MEDIA_SWEEP_INTERVAL_MS, STOP_DRAIN_MS, WIKI_FLUSH_MS } from "./daemon-constants";
import {
	adapterOfThread,
	autoLandPolicy,
	type DaemonContext,
	dispatchPending,
	ownerTarget,
	postThreadNotices,
} from "./daemon-context";
import { answerDialogsFor, cwdFor, floorsSurfaceFor, hostToolsFor, peerTouched } from "./daemon-host-tools";
import { handleIpc } from "./daemon-ipc";
import { DaemonOpsPanel } from "./daemon-ops-panel";
import { escalateTurnFailures, notifyProviderLimit } from "./daemon-owner-post";
import { DaemonCommandPicker } from "./daemon-picker";
import { DaemonQuotaGate } from "./daemon-quota";
import { DaemonSkillReview } from "./daemon-review";
import { DaemonInbound, deliverySources } from "./daemon-sink";
import { DaemonStore, peerCallPolicyOf } from "./daemon-store";
import { GateSweep, PendingDispatchSweep } from "./daemon-sweeps";
import { DaemonTaskLanding } from "./daemon-task-land";
import { ingestOwnerText } from "./daemon-task-land-entry";
import { noteAgyTaskLimit, type TaskRpcEnv, taskDriver, taskHeld } from "./daemon-task-resume";
import { createTaskSweep } from "./daemon-task-sweep";
import type { DaemonOptions, InjectRequest, InjectResult } from "./daemon-types";
import { sweepDeliveries } from "./delivery-sweep";
import { discordPolicyOf } from "./discord-policy";
import { DEFAULT_SWEEP_MS, EVENT_LOOP_WARN_MS, SweepHeartbeatWriter } from "./heartbeat";
import { type IpcServer, startIpcServer } from "./ipc";
import { pidAlive } from "./lock";
import { formatSessionMismatchNotice, formatStallNotice } from "./notices";
import { NamespacedDriver } from "./opref";
import { type RestartCutEntry, recoverDispatched, writeRestartCut } from "./recovery";
import { planReload, type ReloadResult } from "./reload";
import { NOTIFY_OP_PREFIX, RestartLauncher } from "./restart";
import {
	pickRestartThreads,
	RESTART_NOTICE_ACTIVE_MS,
	RESTART_NOTICE_MAX,
	RESTART_NOTICE_STALE_MS,
	RESTART_NOTICE_TEXT,
	takeRestartMarker,
	writeRestartMarker,
} from "./restart-notice";
import { buildStatus, type DrainCounts, frozenField, openGateSummary, type StatusReport } from "./status";
import { renderContextLine, renderStatusText } from "./status-render";

/** Wires store, origin router, channel adapters, unix socket and timers; owns recovery on start and graceful stop. */
export class Daemon {
	readonly #options: DaemonOptions;
	readonly #clock: MailboxClock;
	/** `HH:MM` in the bot's zone (`config.timezone`), for a card's result line. */
	readonly #clockFormat: Intl.DateTimeFormat;
	readonly #log: Logger;
	readonly #drivers = new Map<string, NamespacedDriver>();
	/** Unique per Daemon instance; `bootId` is the kernel boot id and repeats across daemon restarts. */
	readonly #incarnation = randomUUID().slice(0, 8);
	#driverCount = 0;
	#store: DaemonStore | undefined;
	#router: OriginRouter | undefined;
	#monitors: MonitorScheduler | undefined;
	readonly #adapters = new Map<ChatPlatform, ChannelAdapter>(); // one adapter per bound platform, built at start
	#ipc: IpcServer | undefined;
	#timer: NodeJS.Timeout | undefined;
	#lastMediaSweep = 0;
	#taskSweeper: TaskSweeper | undefined;
	#wikiNotes: WikiNotes | undefined;
	#lastWikiFlushAt = 0;
	readonly #drainDeferNoticed = new Set<string>(); // threads told "재시작 뒤에 처리" for a message held by the current drain: once each
	#lastTaskSweepAt = 0;
	#lastHerdrHealthAt = 0;
	#taskSweeping = false;
	#taskSweepAgain = false; // a sweep was asked for while one ran (a check job ended): it runs once more right after
	readonly #taskSweepDue = new Set<string>(); // tasks whose check job just ended: the next sweep judges them whatever their cadence
	#checkRunner: TaskCheckRunner | undefined; // the `[check: …]` queue of local tasks: the sweep asks it for checks instead of running them
	#herdrHealth: HerdrHealthProbe | undefined; // local `herdr status server` check on the sweep cadence (herdr on only); feeds `herdr_unreachable`
	/** Background lane tick / mailbox idle sweep in flight: the sweep never awaits them, and never overlaps them. */
	readonly #bgSweeps = new Set<"lane" | "idle">();
	/** The peer silence sweep runs only once the startup Discord recovery pass has fed in the posts missed meanwhile. */
	#peerSilenceArmed = false;
	#pumping: Promise<void> = Promise.resolve();
	#stopped = false;
	#stopPromise: Promise<void> | undefined; // the in-flight shutdown; a re-entering stop() awaits it instead of returning
	#heartbeat: SweepHeartbeatWriter | undefined;
	#bootBackupWorker: BootBackupHandle | undefined;
	/** `<home>/FROZEN` re-read within seconds; autonomous paths (dispatch, monitors, lanes, task reminders) consult it. */
	readonly #frozen: () => FreezeState | undefined;
	#broker: ApprovalBroker | undefined;
	#lanes: LaneManager | undefined;
	/** Outbound posts of the core (approval cards, lanes, tasks, uploads, inject markers), redacted on the way. */
	readonly #channels: ChannelRegistry;
	#lander: LandLane | undefined; // the one lander of lanes and [TASK]s: landings of one repository never overlap
	#taskGates: TaskGateRunner | undefined; // the [TASK] review·QA gate (src/tasks/gate.ts); its running gates are the `#taskGating` of the spec
	/** The live view of this daemon's state that its parts in the sibling `daemon-*.ts` files read. */
	readonly #ctx: DaemonContext;
	readonly #inbound: DaemonInbound;
	readonly #landing: DaemonTaskLanding;
	readonly #review: DaemonSkillReview;
	readonly #gates: GateSweep;
	readonly #pending: PendingDispatchSweep;
	readonly #quota: DaemonQuotaGate;
	readonly #opsPanel: DaemonOpsPanel;
	readonly #picker: DaemonCommandPicker;

	constructor(options: DaemonOptions) {
		const daemon = this;
		this.#ctx = {
			get options() {
				return daemon.#options;
			},
			get clock() {
				return daemon.#clock;
			},
			get clockFormat() {
				return daemon.#clockFormat;
			},
			get log() {
				return daemon.#log;
			},
			get channels() {
				return daemon.#channels;
			},
			get adapters() {
				return daemon.#adapters;
			},
			get frozen() {
				return daemon.#frozen;
			},
			get store() {
				return daemon.#store;
			},
			get router() {
				return daemon.#router;
			},
			get lanes() {
				return daemon.#lanes;
			},
			get broker() {
				return daemon.#broker;
			},
			get wikiNotes() {
				return daemon.#wikiNotes;
			},
			get taskGates() {
				return daemon.#taskGates;
			},
			get lander() {
				return daemon.#lander;
			},
			get checkRunner() {
				return daemon.#checkRunner;
			},
			get taskSweeper() {
				return daemon.#taskSweeper;
			},
			requestIdleSweep: () => daemon.#startIdleSweep(),
			quotaRefusal: (model) => daemon.#quota.refusalFor(model),
			isQuotaHeld: (originKey) => daemon.#quota.holdReasonForOrigin(originKey) !== undefined,
		};
		this.#inbound = new DaemonInbound(this.#ctx);
		this.#landing = new DaemonTaskLanding(this.#ctx);
		this.#review = new DaemonSkillReview(this.#ctx, (originKey, sessionDir) => this.#makeDriver(originKey, sessionDir));
		this.#gates = new GateSweep(this.#ctx);
		this.#pending = new PendingDispatchSweep(this.#ctx);
		this.#quota = new DaemonQuotaGate(this.#ctx);
		this.#quota.setAgyPool(options.agyPool);
		this.#opsPanel = new DaemonOpsPanel(this.#ctx, { status: () => this.status() });
		this.#picker = new DaemonCommandPicker(this.#ctx, this.#quota);
		this.#options = options;
		const channels = new ChannelRegistry();
		for (const binding of options.channels) channels.register(binding.port);
		this.#channels = channels;
		this.#clock = options.clock ?? { now: () => Date.now() };
		this.#clockFormat = new Intl.DateTimeFormat("en-GB", {
			timeZone: options.config.timezone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		this.#log = options.log;
		this.#frozen = createFreezeProbe(options.config.homeDir);
	}

	peerTouched(originKey: string): boolean {
		return peerTouched(this.#ctx, originKey);
	}

	floorsSurfaceFor(originKey: string): FloorsSurface {
		return floorsSurfaceFor(this.#ctx, originKey);
	}

	hostToolsFor(originKey: string): HostToolDef[] {
		return hostToolsFor(this.#ctx, originKey);
	}

	answerDialogsFor(originKey: string): OmpDialogAnswerer | undefined {
		return answerDialogsFor(this.#ctx, originKey, () => this.pump());
	}

	cwdFor(originKey: string): string {
		return cwdFor(this.#ctx, originKey);
	}

	/** The child of a [TASK] worker origin (`driverFactory`): the agy print driver for an agy row, else omp RPC. */
	taskDriver(originKey: string, sessionDir: string, rpcEnv: TaskRpcEnv): OmpSessionDriver {
		return taskDriver(this.#ctx, originKey, sessionDir, rpcEnv);
	}

	rotationContextFor(originKey: string): string | null {
		return latestRotationContext(this.#store, originKey, this.#log);
	}

	controlTask(taskId: string, control: "pause" | "resume"): Promise<{ ok: boolean; text: string }> {
		return this.#inbound.controlTask(taskId, control);
	}

	autoLand(row: TaskRow, gate?: TaskGateHooks): Promise<TaskLandOutcome> {
		return this.#landing.autoLand(row, gate);
	}

	/** Per platform with a thread reader: what the mailbox reads a turn's thread context through. */
	#threadSources(): Map<ChatPlatform, ThreadSource> {
		const timeout =
			this.#options.threadContextTimeoutMs === undefined ? {} : { timeoutMs: this.#options.threadContextTimeoutMs };
		const sources = new Map<ChatPlatform, ThreadSource>();
		for (const binding of this.#options.channels) {
			const replies = binding.readThread;
			if (replies === undefined) continue;
			const platform = binding.port.platform;
			sources.set(platform, {
				...timeout,
				botUserId: () => this.#adapters.get(platform)?.botUserId,
				replies,
				mentionUser: (userId) => binding.port.mentionUser(userId),
			});
		}
		return sources;
	}

	get socketPath(): string {
		return join(this.#options.config.homeDir, "jabbu.sock");
	}

	get store(): Store {
		if (!this.#store) throw new Error("daemon not started");
		return this.#store;
	}

	get #approval(): ApprovalBroker {
		if (this.#broker === undefined) throw new Error("daemon not started");
		return this.#broker;
	}

	/** Raw factory output wrapped so opRefs are unique across driver instances (see `NamespacedDriver`). */
	#makeDriver(originKey: string, sessionDir: string): OmpSessionDriver {
		this.#driverCount += 1;
		const driver = new NamespacedDriver(
			this.#options.driverFactory(originKey, sessionDir),
			`${this.#incarnation}-${this.#driverCount}`,
		);
		this.#drivers.set(originKey, driver);
		return driver;
	}

	async start(): Promise<void> {
		if (this.#stopped) throw new Error("daemon stopped before start");
		const config = this.#options.config;
		// The text this boot runs on: recorded as last-good at ready only if nobody edited the file meanwhile.
		const bootConfigText =
			"bootConfigText" in this.#options ? this.#options.bootConfigText : readConfigText(config.homeDir);
		const log = this.#log;
		const crash = this.#options.crash ?? (() => undefined);
		this.#heartbeat = new SweepHeartbeatWriter(config.homeDir);
		installProcessAudit(createDispatchAudit({ homeDir: config.homeDir, log, now: () => this.#clock.now() }));
		const store = new DaemonStore(
			join(config.homeDir, "jabbu.db"),
			this.#clock,
			crash,
			() => this.#nudgePump(),
			log,
			{ discord: config.channels.discord?.logChannelId },
			config.timezone,
		);
		store.setPeerCallPolicy(peerCallPolicyOf(config));
		store.setAlertChannel({ discord: config.channels.discord?.alertChannelId });
		this.#store = store;
		// The wiki result notes; `config.wikiNotes` is read on every use, so a reload turns them on or off.
		const wikiNotes = new WikiNotes({
			config: () => this.#options.config.wikiNotes,
			store,
			log,
			clock: this.#clock,
			timezone: config.timezone,
			readTaskDoc: async (row, name) => {
				try {
					const read = await resolveTaskHost(row.host, this.#options.config.dispatchHosts).readFile(
						`${docsDirOf(row)}/${name}`,
					);
					return read.ok ? read.value : undefined;
				} catch {
					return undefined;
				}
			},
		});
		this.#wikiNotes = wikiNotes;
		this.#broker = new ApprovalBroker({
			channels: this.#channels,
			ownerUserId: primaryOwnerUserId(config.channels),
			platformOwners: {
				...(config.channels.discord === undefined ? {} : { discord: config.channels.discord.ownerUserId }),
				...(config.channels.web?.enabled === true ? { web: WEB_OWNER_USER_ID } : {}),
			},
			escalationChannel: { discord: config.channels.discord?.escalationChannelId },
			log,
			store,
			clock: this.#clock,
			timezone: config.timezone,
			onOwnerAnswered: ({ originKey, threadRef: ref }) =>
				this.#router?.mailbox(originKey).state.busy && adapterOfThread(this.#ctx, ref)?.resumeTyping?.(ref),
			onOwnerTurn: (info) => notifyWebOwnerTurn(this.#ctx, info),
			...(this.#options.approvalTimeoutMs === undefined ? {} : { timeoutMs: this.#options.approvalTimeoutMs }),
		});
		log.info("daemon_start", {
			boot: this.#options.bootId,
			pid: process.pid,
			omp_version: this.#options.ompVersion,
			recovered_inflight: store.recoveredInflight,
		});
		for (const { field, reason } of config.warnings ?? []) log.warn("config_warning", { field, reason });
		await this.#bootBackup();

		// Rows of a removed platform (`slack/…`, `teams/…`) have no adapter to answer on: close them without running a turn.
		for (const state of ["pending", "dispatched"] as const) {
			for (const row of store.listInbound({ state })) {
				if (!REMOVED_PLATFORM_PREFIXES.some((prefix) => row.originKey.startsWith(prefix))) continue;
				store.discard(row.platformMessageId);
				log.info("inbound_discarded", { reason: "platform_removed", id: row.platformMessageId, origin: row.originKey });
			}
		}
		for (const row of store.closeRemovedPlatformDeliveries(REMOVED_PLATFORM_PREFIXES)) {
			log.info("delivery_discarded", { reason: "platform_removed", id: row.deliveryId, origin: row.originKey });
		}

		// Rule (2): settle dispatched rows of the dead process before any new child is started.
		const recovered = await recoverDispatched({
			store,
			log,
			driverFactory: (origin, dir) => this.#makeDriver(origin, dir),
			homeDir: config.homeDir,
			now: () => this.#clock.now(),
			lockRepos: (originKey) => {
				try {
					return [this.cwdFor(originKey)];
				} catch {
					// an open lane without its worktree: nothing there to hold a lock
					return [];
				}
			},
		});
		log.info("recovery_done", {
			answered: recovered.answered,
			interrupted: recovered.interrupted,
			continued: recovered.continued,
		});

		const sessionsRoot = join(config.homeDir, "sessions");
		mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
		const restart = new RestartLauncher({
			homeDir: config.homeDir,
			// The checkout holding this file (src/daemon/daemon.ts → repo root): the one the daemon runs and apply loads.
			repoDir: resolve(import.meta.dir, "..", ".."),
			pathEnv: applyPathEnv(process.env),
			// As `apply --detach`: a daemon under a non-default home hands it to the unit.
			...(process.env.JABBU_HOME === undefined ? {} : { homeEnv: config.homeDir }),
			run: spawnRunner,
			isAlive: this.#options.pidAlive ?? pidAlive,
			isExecutable: isExecutableFile,
			now: () => this.#clock.now(),
			turnsRunning: () => (this.#router?.busyTurns() ?? 0) > 0,
			log,
			...this.#options.restart,
		});
		this.#router = new OriginRouter({
			store,
			clock: this.#clock,
			timezone: config.timezone,
			log,
			sessionsRoot,
			sessionBackupsRoot: join(config.homeDir, "session-backups"),
			statusProvider: (originKey) => this.#statusText(originKey),
			usageProvider: async (originKey) => {
				const sessionDir = store.getOrigin(originKey)?.sessionDir ?? sessionDirFor(sessionsRoot, originKey, 1);
				return readBotUsageSummary(this.#options.config, sessionDir, sessionsRoot);
			},
			// Read on every turn: a reload replaces this.#options.config, a captured local config would not follow it.
			recallEnabled: () => this.#options.config.recallEnabled !== false,
			// Same test as the driver factory (run.ts): only an omp child gets the host tools.
			hostTools: () => this.#options.config.agent !== "agy",
			// Only where the board tools are (`#hostToolSet`): an omp child of a lane or a peer-bot-free Discord conversation.
			boardNotice: (originKey) =>
				this.#options.config.agent === "agy" || this.peerTouched(originKey)
					? undefined
					: boardNoticeFor(store, originKey),
			costCap: () => this.#options.config.costCap,
			budgetProvider: () => this.#budgetCommand(),
			briefingProvider: (originKey, threadRef, isDiscarded) => this.#brief(originKey, threadRef, isDiscarded),
			restartProvider: (originKey, threadRef) => restart.request(originKey, threadRef),
			usageResetProvider: (arg) => this.#quota.resetUsage(arg),
			commandPicker: (info) => this.#picker.open(info),
			distillProvider: (originKey) => this.#review.distill(originKey),
			// Discord channels only (DMs, lanes and monitors have no cached place): the port's cache, no call.
			conversationContext: (originKey) => {
				const ref = parseChatOrigin(originKey);
				if (ref?.platform !== "discord" || ref.kind !== "ch") return undefined;
				return this.#options.channels
					.find((binding) => binding.port.platform === "discord")
					?.port.conversationContext?.(ref.conversationId, ref.threadId);
			},
			// Reloadable repository list; real git runs here (no test seam in production).
			turnHeads: {
				headRepos: () => turnNoteRepos(this.#options.config),
				onCommitted: (turn) => wikiNotes.recordTurn(turn),
			},
			threadSource: this.#threadSources(),
			idleStopMs: config.idleTimeoutMinutes === undefined ? undefined : config.idleTimeoutMinutes * 60_000,
			idleKeep: idleKeepOptions(config, gateOptionsFromConfig(config).hostSessionCeiling, this.#options.hostLoad),
			...(config.model === undefined ? {} : { defaultModel: config.model }),
			onStall: (info) =>
				void adapterOfThread(this.#ctx, info.threadRef)?.setStalled(info.threadRef, info.originKey, info.stalled),
			onProgress: ({ originKey, threadRef, progress }) =>
				void adapterOfThread(this.#ctx, threadRef)?.setProgress(threadRef, originKey, {
					...progress,
					recentTools: progress.recentTools.map((tool) => ({ ...tool, text: redact(tool.text) })),
					...(progress.todo?.current === undefined
						? {}
						: { todo: { ...progress.todo, current: redact(progress.todo.current) } }),
				}),
			onEscalate: (info) => escalateTurnFailures(this.#ctx, info),
			onProviderLimit: (info) => notifyProviderLimit(this.#ctx, info),
			onQuotaError: (info) => this.#quota.noteQuotaError(info),
			quotaHoldReason: (originKey) => this.#quota.holdReasonForOrigin(originKey),
			onCacheMiss: (info) => postThreadNotices(this.#ctx, [info.threadRef], formatCacheMissNotice(info)),
			onColdCache: (info) => postThreadNotices(this.#ctx, [info.threadRef], formatColdCacheNotice(info)),
			coldResumeRotateTokens: () => coldResumeTokens(this.#options.config),
			onColdResumeRotated: (info) => postThreadNotices(this.#ctx, [info.threadRef], formatColdResumeNotice(info)),
			onSessionMismatch: (info) => postThreadNotices(this.#ctx, [info.threadRef], formatSessionMismatchNotice(info)),
			// A monitor's turn has no thread to warn: the log line is its record.
			onTurnCostCap: (info) => {
				if (info.originKey.startsWith(MONITOR_ORIGIN_PREFIX)) return;
				postThreadNotices(this.#ctx, [info.threadRef], redact(info.text));
			},
			// The registry row is the lane's only hold: a paused lane or one the core is rebasing (not-ff landing) dispatches nothing.
			isFrozen: () => this.#frozen() !== undefined,
			// A [TASK] worker's only hold is the owner's pause (`taskHeld`); `resumeTask` and `계속` lift it.
			isHeld: (originKey) =>
				taskHeld(this.#store?.tasks, originKey) ||
				this.#store?.getLaneByOrigin(originKey)?.status === "paused" ||
				this.#lanes?.isCoreRebasing(originKey) === true,
			isAttached: (originKey) => this.#store?.getLaneByOrigin(originKey)?.meta.attach !== undefined,
			onHeldWork: (info) => this.#lanes?.onHeldWork(info.originKey),
			// A new lane session starts with its acceptance criteria as omp todos.
			initialTodos: (originKey) => (isLaneOrigin(originKey) ? this.#lanes?.initialTodos(originKey) : undefined),
			launchRefusal: (originKey, driver) =>
				isLaneOrigin(originKey) ? this.#lanes?.launchRefusal(originKey, driver) : undefined,
			onLaunchRefused: (originKey, reason) => this.#lanes?.failLaunch(originKey, reason) ?? Promise.resolve(),
			onTurnSettled: (info) => {
				this.#approval.dropInput(info.originKey, "turn_ended");
				noteAgyTaskLimit(this.#ctx, info); // a headless agy 429: blocked + one card, in the background
			},
			onStallEscalate: (info) => {
				const owner = ownerTarget(this.#ctx, "stall");
				void owner?.adapter.postNotice(owner.channel, formatStallNotice(info));
			},
			dialogs: {
				open: (originKey) => this.#approval.openDialogs(originKey),
				answer: (originKey, text) => this.#approval.answerDialog(originKey, text),
				ambiguous: (info) => postThreadNotices(this.#ctx, [info.threadRef], DIALOG_AMBIGUOUS_NOTICE),
			},
			driverFactory: (origin, dir) => this.#makeDriver(origin, dir),
		});
		const localOps = resolveTaskHost(null, undefined);
		const lander =
			this.#options.landLane ?? createLaneLander({ removeWorktree: (input) => localOps.removeWorktree(input) });
		this.#lander = lander;
		// The independent review before an auto-merge: a one-shot `omp -p` under the same safety floors.
		const reviewer = {
			ompBin: config.ompExecutable,
			...(config.ompProfile === undefined ? {} : { ompProfile: config.ompProfile }),
			systemPromptAppendix: buildFloorsPrompt(
				join(config.homeDir, "secrets"),
				undefined,
				false,
				false,
				false,
				{},
				false,
			),
			reviewsDir: join(config.homeDir, "reviews"),
			...(this.#options.laneReviewRun === undefined ? {} : { run: this.#options.laneReviewRun }),
		};
		const qaWorktreesDir = join(config.homeDir, "qa-worktrees");
		// One review or QA at a time, lanes and [TASK]s alike: a QA clears every copy in qa-worktrees when it starts.
		const gateSlot = createGateSlot();
		this.#taskGates = new TaskGateRunner({
			ledger: store.tasks,
			slot: gateSlot,
			reviewer,
			qaWorktreesDir,
			headOf: (worktree) => localOps.headOf(worktree),
			now: () => this.#clock.now(),
			log,
			land: (row) => this.#landing.landAuto(row),
		});
		this.#lanes = new LaneManager({
			wikiNotes,
			boardUrl: () => this.#options.config.herdrBoard?.url,
			recordsRepo: () => this.#options.config.recordsRepo,
			idStart: () => this.#options.config.idStart,
			landMode: (repo) => landModeOf(this.#options.config, repo),
			store,
			channels: this.#channels,
			clock: this.#clock,
			timezone: config.timezone,
			log,
			sessionsRoot,
			route: (record) => this.#router?.route(record) ?? Promise.resolve(),
			stopWhenIdle: (originKey) => this.#router?.mailbox(originKey).stopWhenIdle() ?? Promise.resolve(),
			pauseTurn: (originKey) =>
				this.#router?.mailbox(originKey).pauseTurn() ?? Promise.resolve({ busy: false, settled: true }),
			resumePending: (originKey) => this.#router?.mailbox(originKey).resumePending() ?? Promise.resolve(),
			sessionDirFor: (originKey) => sessionDirFor(sessionsRoot, originKey, 1),
			session: this.#router.sessionOps(),
			...(this.#options.pidAlive === undefined ? {} : { pidAlive: this.#options.pidAlive }),
			frozen: this.#frozen,
			approvals: { request: (channel, summary) => this.#approval.request(channel, summary) },
			// An external PR's approval goes through `ask` with the lane thread as origin (escalation channel, pointer).
			requestApproval: ({ channel, summary, detail, origin, signal }) =>
				this.#approval.ask(channel, summary, { signal, detail, origin }),
			// taskAutoLand is a live setting (`jabbu-pocket reload`); an apply code rollback holds auto-merge (`<home>/autoland.hold`).
			autoLandPolicy: () => autoLandPolicy(this.#ctx),
			autoLandHold: () => readAutoLandHold(config.homeDir),
			// Cards mention the owner on the platform of the lane's thread.
			ownerUserId: (platform) =>
				platform === "discord"
					? config.channels.discord?.ownerUserId
					: platform === "web"
						? WEB_OWNER_USER_ID
						: undefined,
			// A turn still starting counts as busy: `state.busy` is set only once the prompt resolves.
			laneBusy: (originKey) => this.#router?.mailbox(originKey).turnPending ?? false,
			laneModels: () => this.#options.config.lanes?.models,
			ownerSilenceConfig: () => this.#options.config,
			// A merged lane's non-blocking leftovers (`leftovers`) go to followups.jsonl; a closing lane's file evidence to lanes/.
			followupsFile: join(config.homeDir, "followups.jsonl"),
			lanesDir: join(config.homeDir, "lanes"),
			reviewer,
			// The run QA (`taskAutoLand.qa`) runs in detached copies here, under the reviewer's omp setup.
			qaWorktreesDir,
			gateSlot,
			...(this.#options.maxLanes === undefined ? {} : { maxLanes: this.#options.maxLanes }),
			hostSessions: {
				ceiling: resolvedCeiling(gateOptionsFromConfig(config).hostSessionCeiling),
				onPressure: () => this.#startIdleSweep(),
			},
			quotaRefusal: (model) => this.#quota.refusalFor(model),
			...(this.#options.hostLoad === undefined ? {} : { hostLoad: this.#options.hostLoad }),
			...(this.#options.statfs === undefined ? {} : { statfs: this.#options.statfs }),
			...(this.#options.verifyClaim === undefined ? {} : { verify: this.#options.verifyClaim }),
			land: lander,
		});
		this.#monitors = new MonitorScheduler({
			store,
			router: this.#router,
			clock: this.#clock,
			log,
			scriptsRoot: join(config.homeDir, "scripts"),
			workspaceDir: config.workspaceDir,
			homeDir: config.homeDir,
			frozen: this.#frozen,
		});
		this.#monitors.start();

		const core = this.#inbound.coreSink({
			store,
			sessionsRoot,
			drainDeferNoticed: this.#drainDeferNoticed,
			pending: this.#pending,
			landing: this.#landing,
			opsPanel: this.#opsPanel,
			picker: this.#picker,
			statusText: (originKey) => this.#statusText(originKey),
		});
		for (const binding of this.#options.channels) {
			const platform = binding.port.platform;
			const adapter = binding.createAdapter({
				core,
				deliveries: deliverySources(store, config, crash)(platform),
				clock: this.#clock,
				log,
				config,
				store,
				detach: (error) => void this.#dropAdapter(adapter, "adapter_detached", error),
			});
			this.#adapters.set(platform, adapter);
		}
		// One failed platform is stopped and dropped; pending rows stay for next boot unless all adapters fail.
		const started = [...this.#adapters.values()];
		const failed: string[] = [];
		await Promise.all(
			started.map((adapter) =>
				adapter.start().then(
					() => undefined,
					(error: unknown) =>
						this.#dropAdapter(adapter, "adapter_start_failed", error).then(() => failed.push(adapter.platform)),
				),
			),
		);
		if (started.length > 0 && failed.length === started.length)
			throw new Error(`every chat adapter failed to start: ${failed.join(", ")}`);

		// A waiting click cannot outlive the process: expire every pending card and say so on them.
		void this.#broker.expireStale(false).catch((error) => log.warn("approval_expire_failed", { error: String(error) }));

		// Missed messages since the last run: one recovery pass per platform now (each reconnect runs another).
		for (const adapter of this.#adapters.values()) adapter.recover();
		// A peer answer posted while down comes back with that pass (`onPeerSeen`): the silence sweep waits for it.
		void (this.#adapters.get("discord")?.recoveryIdle?.() ?? Promise.resolve()).then(() => {
			this.#peerSilenceArmed = true;
			log.info("peer_silence_armed");
		});

		setLocalHerdrBin(config.herdr?.bin);
		// herdr off: the sweep leaves the herdr rows alone (never read or reminded); say so once. Headless rows need no herdr.
		const orphaned = config.herdr === undefined ? store.tasks.listActive().filter((r) => r.runtime === "herdr") : [];
		if (orphaned.length > 0) log.warn("tasks_orphaned", { count: orphaned.length });
		const sweep = createTaskSweep(this.#ctx, {
			store,
			config,
			herdr: config.herdr,
			herdrRun: this.#options.herdrRun,
			requestTaskSweep: (taskId) => this.#requestTaskSweep(taskId),
			repoMatches: (row, repos) => this.repoMatches(row, repos),
			autoLand: (row, gate) => this.autoLand(row, gate),
			landReady: () => this.#landing.landReady(),
			pollTaskPrLand: (row) => this.#landing.pollPrLand(row),
			retryPrLand: (row) => this.#landing.retryPrLand(row),
		});
		this.#herdrHealth = sweep.herdrHealth;
		this.#checkRunner = sweep.checkRunner;
		this.#taskSweeper = sweep.taskSweeper;
		this.#ipc = startIpcServer(this.socketPath, (request) => handleIpc(this.#ctx, this, this.#landing, request));
		// "Back" is told once the process can be reached (an earlier failed start leaves the marker), before a recovered turn's post.
		this.#announceMarker("back");

		// Rule (1): rows still pending in the ledger are dispatched again (a frozen bot's mailboxes hold autonomous rows).
		this.#pending.noteFrozenHeld(store.listInbound({ state: "pending" }));
		for (const originKey of new Set(store.listInbound({ state: "pending" }).map((row) => row.originKey)))
			dispatchPending(this.#ctx, originKey);
		// A [TASK] closed `done` while the daemon was down gets its note now.
		await wikiNotes.backfillTasks();
		this.#timer = setInterval(() => void this.sweep(), this.#options.sweepMs ?? DEFAULT_SWEEP_MS);
		this.#nudgePump();
		// Proof of life from the very first moment: a fresh stamp means the sweep_stalled gate starts closed.
		this.#beat();
		log.info("daemon_ready", {
			socket: this.socketPath,
			driver: config.agent ?? "omp",
			herdr: config.herdr === undefined ? "off" : "on",
			discord: this.#adapters.has("discord") ? "on" : "off",
			web: this.#adapters.has("web") ? "on" : "off",
		});
		if (bootConfigText === undefined) log.warn("last_good_config_skipped", { reason: "config_unreadable" });
		else if (readConfigText(config.homeDir) === bootConfigText)
			recordLastGoodConfig(config.homeDir, (error) => log.warn("last_good_config_failed", { error }), bootConfigText);
		else log.warn("last_good_config_skipped", { reason: "config_changed_since_boot" });
	}

	/** Stops one detached/failed platform adapter while keeping the remaining platforms and daemon services up. */
	async #dropAdapter(
		adapter: ChannelAdapter,
		event: "adapter_start_failed" | "adapter_detached",
		error: unknown,
	): Promise<void> {
		this.#log.error(event, { platform: adapter.platform, ...errorFields(error) });
		if (this.#adapters.get(adapter.platform) === adapter) this.#adapters.delete(adapter.platform);
		await adapter
			.stop()
			.catch((stopError: unknown) =>
				this.#log.warn("adapter_stop_failed", { platform: adapter.platform, error: String(stopError) }),
			);
	}

	/** Rule (3) plus the periodic work: deliver due rows, update status messages, stop quiet omp children. */
	pump(): Promise<void> {
		this.#pumping = this.#pumping.then(async () => {
			if (this.#stopped) return;
			// One platform's failure leaves the others' deliveries and status upkeep running.
			for (const adapter of this.#adapters.values()) {
				try {
					await adapter.pumpDeliveries();
					await adapter.tick();
				} catch (error) {
					this.#log.error("pump_failed", { platform: adapter.platform, ...errorFields(error) });
				}
			}
		});
		return this.#pumping;
	}

	#nudgePump(): void {
		setImmediate(() => void this.pump());
	}

	/** One sweep of the interval chain; never rejects so a failed step only skips the beat and logs `sweep_failed`. */
	async sweep(): Promise<void> {
		// The step a failure is attributed to: the outer catch cannot tell pump from the media sweep from the beat.
		let step = "pump";
		const run = async (name: string, work: () => void) => {
			step = name;
			await work();
		};
		try {
			await run("pump", () => this.pump());
			await run("delivery_sweep", () => sweepDeliveries(this.#store, this.#log));
			await run("sweep_stalls", () => this.#router?.sweepStalls());
			await run("lane_tick", () => this.#startLaneTick());
			try {
				// A restart drain fires no monitor: due slots are claimed by the next process's catch-up.
				if (this.#router?.draining !== true) await this.#monitors?.tick();
			} catch (error) {
				this.#log.error("monitor_tick_failed", { ...errorFields(error) });
			}
			await run("idle_sweep", () => this.#startIdleSweep());
			await run("task_sweep", () => this.#maybeSweepTasks());
			await run("wiki_turns", () => this.#maybeFlushWikiTurns());
			await run("pending_sweep", () => this.#pending.sweep());
			await run("quota_poll", () => this.#quota.maybePoll());
			await run("ops_panel_tick", () => this.#opsPanel.maybeTick());
			await run("picker_prune", () => this.#picker.pruneExpired());
			try {
				await this.#gates.sweep();
			} catch (error) {
				this.#log.error("gate_sweep_failed", { ...errorFields(error) });
			}
			try {
				this.#sweepPeerSilence();
			} catch (error) {
				this.#log.warn("peer_silence_sweep_failed", { error: String(error) });
			}
			step = "approval_expire";
			void this.#broker
				?.expireStale()
				.catch((error: unknown) => this.#log.warn("approval_expire_failed", { error: String(error) }));
			await run("media_sweep", () => this.#sweepMedia());
			await run("review_skills", () => this.#review.maybeReviewSkills());
			await run("review_candidates", () => this.#review.maybeProposeCandidates());
			await run("beat", () => this.#beat());
		} catch (error) {
			this.#log.error("sweep_failed", { step, ...errorFields(error) });
		}
	}

	/** Run lane tick / idle sweep in the background without awaiting or overlapping them. */
	#runBgSweep(kind: "lane" | "idle", work: () => Promise<unknown>, errEvent: string): void {
		if (this.#bgSweeps.has(kind) || this.#stopped) return;
		this.#bgSweeps.add(kind);
		void work()
			.catch((error: unknown) => this.#log.error(errEvent, { ...errorFields(error) }))
			.finally(() => this.#bgSweeps.delete(kind));
	}

	#startLaneTick(): void {
		const lanes = this.#lanes;
		if (lanes !== undefined) this.#runBgSweep("lane", () => lanes.tick(), "lane_tick_failed");
	}

	#startIdleSweep(): void {
		const router = this.#router;
		if (router !== undefined) this.#runBgSweep("idle", () => router.sweepIdle(), "sweep_idle_failed");
	}

	/** Records a finished sweep in the heartbeat stamp; a stale stamp opens the `sweep_stalled` gate. */
	#beat(): void {
		if (this.#heartbeat === undefined) return;
		try {
			const loopMs = this.#heartbeat.beat(this.#clock.now(), {
				discord: this.#adapters.get("discord")?.connectionState(),
				draining: this.#router?.draining === true,
			});
			if (loopMs > EVENT_LOOP_WARN_MS) this.#log.warn("event_loop_blocked", { loop_ms: loopMs });
		} catch (error) {
			this.#log.warn("heartbeat_failed", { error: String(error) });
		}
	}

	/** First install without a backup stamp runs one boot backup before the first gate sweep. */
	async #bootBackup(): Promise<void> {
		if (readStamp(join(this.#options.config.homeDir, "backups")) !== undefined) return;
		// The daemon's clock keeps the gates fresh; a synchronous backup of a slow, large home would stall the watchdog beat and boot-loop.
		const worker = startBootBackup(this.#options.config, new Date(this.#clock.now()), this.#options.bootBackup);
		this.#bootBackupWorker = worker;
		try {
			const result = await worker.done;
			this.#log.info("boot_backup_done", { file: result.file, bundle: result.bundle ?? "none" });
		} catch (error) {
			this.#log.warn("boot_backup_failed", { error: String(error) });
		}
	}

	/** The day's cost state (ledger total, ceiling), read on every `!budget` so a reload or midnight needs no restart; none before the store. */
	#dailyBudget(now = this.#clock.now()): DailyBudgetState | undefined {
		if (this.#store === undefined) return undefined;
		return dailyBudgetState({
			store: this.#store,
			day: ledgerDay(now, this.#options.config.timezone),
			cap: this.#options.config.costCap?.dailyUsd,
		});
	}

	/** Peer silence alerts, from the first sweep after the startup recovery. */
	#sweepPeerSilence(): void {
		if (!this.#peerSilenceArmed) return;
		const alerts = this.#store?.alertSilentPeers() ?? 0;
		if (alerts === 0) return;
		this.#log.info("peer_silence_alerted", { count: alerts });
		this.#nudgePump();
	}

	/**
	 * `!brief`: the status the page shows, as one PNG uploaded to the asking thread — no model call. Assembled like the
	 * dashboard CLI's snapshot, except the daemon answers its own `status` op and no herdr board is started here.
	 */
	async #brief(originKey: string, threadRef: string, isDiscarded?: () => boolean): Promise<void> {
		if (this.#store === undefined) throw new Error("장부가 아직 열리지 않았습니다");
		const config = this.#options.config;
		const route = this.#channels.forThreadRef(threadRef);
		if (route === undefined) throw new Error("이 대화의 채널을 찾지 못했습니다");
		const now = this.#clock.now();
		// The daemon's own line to itself: the same shape the socket returns, so the snapshot sections read the same.
		const snapshot = await snapshotReader({
			homeDir: config.homeDir,
			config,
			now: () => this.#clock.now(),
			callDaemon: async () => ({ ok: true, status: this.status() }),
			// The snapshot's own herdr/ssh/git calls always use the real runner: `briefingRun` is the capture seam only.
			run: realProcessRunner,
		})();
		await uploadBriefing({
			config,
			snapshot,
			route,
			now,
			originKey,
			isDiscarded,
			log: this.#log,
			run: this.#options.briefingRun,
		});
	}

	/** `!budget`: today's totals, top origins and both ceilings. The ceilings only warn; nothing is stopped by them. */
	async #budgetCommand(): Promise<string> {
		// `#dailyBudget` is undefined exactly when the store is not open yet, so no separate store check.
		const state = this.#dailyBudget();
		if (state === undefined) return "비용 장부가 아직 열리지 않았습니다.";
		return renderBudget({
			day: state.day,
			total: state.cost,
			top: this.#store?.topDailyOrigins(state.day, 3) ?? [],
			turnCap: this.#options.config.costCap?.turnUsd,
			dailyCap: state.cap,
		});
	}

	/** Once a minute, in the background: the wiki notes of conversation turns whose day (or turn) is over. */
	#maybeFlushWikiTurns(): void {
		const now = this.#clock.now();
		if (this.#wikiNotes === undefined || now - this.#lastWikiFlushAt < WIKI_FLUSH_MS) return;
		this.#lastWikiFlushAt = now;
		void this.#wikiNotes.flushTurns();
	}

	/** Every `taskSweepMs`, in the background: remote reads can take seconds and must not stall the sweep chain. */
	#maybeSweepTasks(): void {
		const interval = this.#options.taskSweepMs ?? TASK_SWEEP_MS;
		const now = this.#clock.now();
		if (interval <= 0 || now - this.#lastTaskSweepAt < interval) return;
		this.#lastTaskSweepAt = now;
		void this.sweepTasks();
		if (now - this.#lastHerdrHealthAt >= HERDR_HEALTH_CHECK_MS) {
			this.#lastHerdrHealthAt = now;
			void this.checkHerdrHealth();
		}
	}

	/** One local herdr reachability check (herdr on, with or without tasks): writes the `herdr-health` stamp. */
	async checkHerdrHealth(): Promise<void> {
		if (this.#herdrHealth === undefined || this.#stopped) return;
		try {
			const health = await this.#herdrHealth.check();
			if (!health.ok) this.#log.warn("herdr_health_failed", { fails: health.fails, error: health.error });
		} catch (error) {
			this.#log.warn("herdr_health_check_failed", { error: String(error) });
		}
	}

	/** One [TASK] sweep (files and git only); overlapping calls collapse into the running one. */
	async sweepTasks(): Promise<void> {
		if (this.#taskSweeping || this.#taskSweeper === undefined || this.#stopped) return;
		this.#taskSweeping = true;
		try {
			do {
				this.#taskSweepAgain = false;
				const due = new Set(this.#taskSweepDue);
				this.#taskSweepDue.clear();
				try {
					await this.#taskSweeper.sweep(due);
				} catch (error) {
					this.#log.error("task_sweep_failed", { tasks: due.size, ...errorFields(error) });
				}
			} while (this.#taskSweepAgain && !this.#stopped);
		} finally {
			this.#taskSweeping = false;
		}
	}

	/** A check job of `taskId` ended: sweep now, or right after the sweep in flight; the next cadence is not waited for. */
	#requestTaskSweep(taskId: string): void {
		this.#taskSweepDue.add(taskId);
		if (this.#taskSweeping) this.#taskSweepAgain = true;
		else void this.sweepTasks();
	}

	/** Hourly, not per-sweep: inbound attachments are context for one turn, kept 24h, then deleted. */
	#sweepMedia(): void {
		const now = this.#clock.now();
		if (now - this.#lastMediaSweep < MEDIA_SWEEP_INTERVAL_MS) return;
		this.#lastMediaSweep = now;
		try {
			const removed = sweepMedia(join(this.#options.config.homeDir, "media"), now, this.#store?.web);
			if (removed > 0) this.#log.info("media_pruned", { removed });
		} catch (error) {
			this.#log.warn("media_prune_failed", { error: String(error) });
		}
	}

	/** The cheap counts the hourly `service_alive` log line carries. */
	aliveFields(): Record<string, number> {
		const inbound = this.#store?.countInboundByState();
		return {
			origins: this.#store?.distinctInboundOrigins().length ?? 0,
			busy: this.#router?.busyOrigins().length ?? 0,
			pending: inbound?.pending ?? 0,
			dispatched: inbound?.dispatched ?? 0,
		};
	}

	/** Unfinished work a restart drain waits for (a running skill review counts as a turn). */
	drainCounts(): DrainCounts {
		return {
			turns: (this.#router?.busyTurns() ?? 0) + (this.#review.reviewing ? 1 : 0),
			hostTools: this.#router?.hostToolsRunning() ?? 0,
			approvals: this.#broker?.pendingCount ?? 0,
		};
	}

	/** `jabbu-pocket drain`: hold new turns, steers, monitor fires and skill reviews back so a restart cuts nothing (inbound stays `pending`; memory only, the restart ends it, ending it early dispatches what waited). */
	setDraining(on: boolean): void {
		if (this.#router === undefined || this.#router.draining === on) return;
		this.#router.draining = on;
		this.#drainDeferNoticed.clear();
		this.#log.info(on ? "drain_started" : "drain_cancelled", { ...this.drainCounts() });
		if (on) {
			this.#announceDrain();
			return;
		}
		this.#announceMarker("cancelled");
		for (const originKey of new Set(this.store.listInbound({ state: "pending" }).map((row) => row.originKey)))
			dispatchPending(this.#ctx, originKey);
	}

	/**
	 * `apply` past its drain cut limit, right before its restart: records the op_ref of every dispatched turn (with the
	 * summary of the approval card its origin waits on) in `<home>/restart-cut.json` — the next process resumes those
	 * turns — then withdraws the pending approval cards. ok only once the file is durable; a failed write touches no card.
	 */
	async drainCut(
		applyStamp: string,
	): Promise<{ ok: true; opRefs: number; approvals: number } | { ok: false; error: string }> {
		const store = this.#store;
		const broker = this.#broker;
		if (this.#router?.draining !== true || store === undefined || broker === undefined)
			return { ok: false, error: "not draining" };
		const approvals = new Map<string, string>();
		for (const request of broker.pendingRequests()) {
			if (request.originKey !== undefined && !approvals.has(request.originKey))
				approvals.set(request.originKey, request.summary);
		}
		const opRefs: RestartCutEntry[] = [];
		const seen = new Set<string>();
		for (const row of store.listInbound({ state: "dispatched" })) {
			// A command op (lane landing, task bookkeeping, `/compact`) is not an omp turn to resume.
			if (row.opRef === null || COMMAND_OP_REF.test(row.opRef) || seen.has(row.opRef)) continue;
			seen.add(row.opRef);
			const approval = approvals.get(row.originKey);
			opRefs.push({ originKey: row.originKey, opRef: row.opRef, ...(approval === undefined ? {} : { approval }) });
		}
		try {
			writeRestartCut(this.#options.config.homeDir, { at: this.#clock.now(), applyStamp, opRefs });
		} catch (error) {
			this.#log.warn("drain_cut_failed", { apply: applyStamp, error: String(error) });
			return { ok: false, error: String(error) };
		}
		const cancelled = await broker.cancelForRestart();
		this.#log.info("drain_cut", { apply: applyStamp, op_refs: opRefs.length, approvals_cancelled: cancelled });
		return { ok: true, opRefs: opRefs.length, approvals: cancelled };
	}

	/**
	 * `jabbu-pocket reload` / SIGHUP: re-reads config.json and applies the live fields (see `LIVE_FIELDS`); restart-bound
	 * fields are reported, not applied. An unreadable or invalid file keeps the running config untouched.
	 */
	reloadConfig(trigger: "ipc" | "sighup"): ReloadResult {
		const current = this.#options.config;
		let fresh: JabbuConfig;
		const text = readConfigText(current.homeDir);
		try {
			fresh = loadConfig(current.homeDir);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#log.warn("config_reload_failed", { trigger, error: message });
			return { ok: false, error: message };
		}
		const plan = planReload(current, fresh);
		// `warnings` is no reload field: carry the new file's own, so a typo'd key is flagged on reload as at boot.
		if (fresh.warnings === undefined) delete plan.next.warnings;
		else plan.next.warnings = fresh.warnings;
		for (const { field, reason } of fresh.warnings ?? []) this.#log.warn("config_warning", { field, reason, trigger });
		this.#options.config = plan.next;
		// `channels` stays restart-bound apart from Discord's live policy keys, so these still carry the started values.
		this.#store?.setLogChannel({ discord: plan.next.channels.discord?.logChannelId });
		this.#store?.setAlertChannel({ discord: plan.next.channels.discord?.alertChannelId });
		if (plan.changed.includes("peerSilenceAlert")) this.#store?.setPeerCallPolicy(peerCallPolicyOf(plan.next));
		if (plan.changed.includes("quotaGate")) this.#quota.maybePoll();
		if (plan.changed.includes("opsPanel")) this.#opsPanel.maybeTick();
		this.#broker?.setEscalationChannel({ discord: plan.next.channels.discord?.escalationChannelId });
		// The reload-carried Discord policy: `channels.discord`'s connection keys plus the top-level peer hop cap.
		this.#adapters.get("discord")?.setChannelPolicy(discordPolicyOf(plan.next));
		this.#log.info("config_reloaded", {
			trigger,
			changed: plan.changed.join(",") || "-",
			restart_required: plan.restartRequired.join(",") || "-",
			cli: plan.cli.join(",") || "-",
		});
		// Only a file the running daemon fully applies is a rollback target: restart-bound fields were never booted on.
		if (plan.restartRequired.length > 0)
			this.#log.info("last_good_config_skipped", {
				reason: "restart_required",
				fields: plan.restartRequired.join(","),
			});
		else if (text === undefined || readConfigText(current.homeDir) !== text)
			this.#log.warn("last_good_config_skipped", { reason: "config_changed_during_reload" });
		else recordLastGoodConfig(current.homeDir, (error) => this.#log.warn("last_good_config_failed", { error }), text);
		return { ok: true, changed: plan.changed, restartRequired: plan.restartRequired, cli: plan.cli };
	}

	/** Drain start: tell the active conversations a restart is coming and remember them for the "back" notice. */
	#announceDrain(): void {
		const { config } = this.#options;
		const router = this.#router;
		const store = this.#store;
		if (config.restartNotice === false || router === undefined || store === undefined) return;
		const now = this.#clock.now();
		const threads = pickRestartThreads(
			router.busyOrigins().map((originKey) => router.mailbox(originKey).state.threadRef),
			store.recentConversations(now - RESTART_NOTICE_ACTIVE_MS, RESTART_NOTICE_MAX).map((c) => c.threadRef),
		);
		if (threads.length === 0) return;
		try {
			writeRestartMarker(config.homeDir, { at: now, threads });
		} catch (error) {
			this.#log.warn("restart_notice_marker_failed", { error: String(error) });
		}
		this.#log.info("restart_notice", { kind: "draining", threads: threads.length });
		postThreadNotices(this.#ctx, threads, RESTART_NOTICE_TEXT.draining);
	}

	/**
	 * Consumes the drain marker: "back" at the next start (a marker older than {@link RESTART_NOTICE_STALE_MS} is an
	 * unrelated leftover and is dropped silently), "cancelled" when the drain ends without a restart.
	 */
	#announceMarker(kind: "back" | "cancelled"): void {
		const { config } = this.#options;
		const marker = takeRestartMarker(config.homeDir, (reason) =>
			this.#log.info("restart_notice_dropped", { kind, reason }),
		);
		if (marker === undefined) return;
		const age = this.#clock.now() - marker.at;
		if (config.restartNotice === false || age > RESTART_NOTICE_STALE_MS) {
			this.#log.info("restart_notice_dropped", { kind, age_ms: age });
			return;
		}
		this.#log.info("restart_notice", { kind, threads: marker.threads.length });
		postThreadNotices(this.#ctx, marker.threads, RESTART_NOTICE_TEXT[kind]);
	}

	/** `!status` / `/status-jabbu`: the asking conversation's context line, then the daemon-wide status text. */
	async #statusText(originKey: string): Promise<string> {
		let state: Parameters<typeof renderContextLine>[0];
		try {
			state = (await this.#router?.driverState(originKey)) ?? "idle";
		} catch (error) {
			this.#log.warn("status_context_failed", { origin: originKey, error: String(error) });
			state = "unknown";
		}
		return `${renderContextLine(state)}\n${renderStatusText(this.status())}`;
	}

	status(): StatusReport {
		const router = this.#router;
		const report = buildStatus(
			this.store,
			this.#options.ompVersion,
			this.#options.config.timezone,
			(originKey) => {
				const state = router?.mailbox(originKey).state;
				return {
					ompPid: state?.driverRunning ? (this.#drivers.get(originKey)?.pid ?? null) : null,
					busy: state?.busy ?? false,
				};
			},
			openGateSummary(
				join(this.#options.config.homeDir, "jabbu.db"),
				this.#clock.now(),
				gateOptionsFromConfig(this.#options.config),
				this.#options.hostLoad,
				this.#options.statfs,
			),
		);
		const withFreeze = { ...report, ...frozenField(this.#options.config.homeDir) };
		withFreeze.hostSessions = hostSessionsInfo(gateOptionsFromConfig(this.#options.config).hostSessionCeiling);
		const agyAccounts = this.#options.agyStatus?.();
		if (agyAccounts !== undefined) withFreeze.agyAccounts = agyAccounts;
		return router?.draining ? { ...withFreeze, drain: this.drainCounts() } : withFreeze;
	}

	/**
	 * `jabbu-pocket inject`: the bot posts a `🧪 inject <nonce>` root message in the conversation and feeds the owner
	 * message through that platform adapter's own path (same normalizeInbound, same fencing of `quoted`), threaded under
	 * that root (with `thread`: a reply in that existing thread, and the owner message a reply of it).
	 */
	async inject(request: InjectRequest): Promise<InjectResult> {
		if (this.#adapters.size === 0) throw new Error("daemon not started");
		if (request.asOwner !== true) throw new Error("inject requires --as-owner");
		// Owner DM (`discord/dm/<id>`) or a channel the bot is in (`discord/ch/<id>`); no thread origins.
		const ref = parseChatOrigin(request.origin);
		if (ref === undefined || ref.platform !== "discord" || ref.threadId !== undefined)
			throw new Error(`inject origin must be discord/dm/<id> or discord/ch/<id>: ${request.origin}`);
		if (!this.#adapters.has(ref.platform)) throw new Error(`${ref.platform} is not configured`);
		const channel = ref.conversationId;
		// A Discord thread is a message id (snowflake).
		if (request.thread !== undefined && !/^\d{17,20}$/.test(request.thread))
			throw new Error(`inject thread is not a message id: ${request.thread}`);
		const nonce = randomBytes(6).toString("hex");
		// The marker carries the text's first line, masked before it is cut (a secret cut short no longer matches its pattern).
		const firstLine = redact(
			request.text
				.split("\n")
				.find((line) => line.trim() !== "")
				?.replace(/\s+/g, " ")
				.trim() ?? "",
		);
		const preview = firstLine.length > 120 ? `${cutCodePointSafe(firstLine, 120)}…` : firstLine;
		const { outcome, markerTs } = await ingestOwnerText(
			this.#ctx,
			{ channel, threadTs: request.thread, kind: ref.kind, injected: true },
			request.text,
			preview === ""
				? `🧪 inject ${nonce}`
				: `🧪 inject ${nonce}\n> ${ref.platform === "discord" ? escapeDiscordMarkdown(preview) : escapeMrkdwn(preview)}`,
			request.quoted === undefined ? undefined : [request.quoted],
		);
		// The marker stays up either way, so the owner sees what was tried.
		if (outcome === "card_rejected")
			throw new Error("inject_rejected: approval/choice card threads take only the owner's own reply");
		if (outcome === "dropped") throw new Error("inject_rejected: message was not accepted");
		return { nonce, threadRef: threadRefOf(channel, request.thread ?? markerTs) };
	}

	/**
	 * IPC `notify` (`apply --report-plain`): one bot post in `thread` (or at the top level) of a report origin, put on the
	 * delivery ledger like an answer under `notify:<stamp>` — no inbound row, no turn, no omp session; a same stamp no-ops.
	 */
	notify(request: {
		origin: string;
		text: string;
		thread?: string | undefined;
		stamp?: string | undefined;
	}): { ok: true; opRef: string } | { ok: false; error: string } {
		const store = this.#store;
		if (store === undefined) return { ok: false, error: "daemon not started" };
		const { origin, thread } = request;
		const ref = parseChatOrigin(origin);
		if (ref === undefined || !isReportOrigin(origin))
			return { ok: false, error: `notify origin must be discord/(dm|ch)/<id>: ${origin}` };
		if (thread !== undefined && !reportThreadPattern().test(thread))
			return { ok: false, error: `notify thread is not a message id: ${thread}` };
		if (!this.#adapters.has(ref.platform)) return { ok: false, error: `${ref.platform} is not configured` };
		const text = request.text.trim();
		if (text === "") return { ok: false, error: "notify needs a non-empty text" };
		const opRef = `${NOTIFY_OP_PREFIX}${request.stamp ?? randomBytes(6).toString("hex")}`;
		store.recordAnswer({
			originKey: origin,
			opRef,
			threadRef: threadRefOf(ref.conversationId, thread ?? TOP_LEVEL_TS),
			parts: [text],
		});
		this.#log.info("notify_recorded", { origin, opRef });
		return { ok: true, opRef };
	}

	/** Whether a task's repository (a task on a host: its local clone) is one of `repos` (the same git common directory). */
	repoMatches(row: TaskRow, repos: readonly string[]): Promise<boolean> {
		return repoMatchesTask(this.#options.config, row, repos);
	}

	/** `#ops` 패널 직렬 작업이 모두 끝날 때까지 기다린다(테스트·종료 동기화용). */
	opsPanelIdle(): Promise<void> {
		return this.#opsPanel.idle();
	}

	/** 진행 중인 쿼터 복구 폴링이 끝날 때까지 기다린다(테스트·종료 동기화용). */
	quotaIdle(): Promise<void> {
		return this.#quota.idle();
	}

	/** SIGTERM path: stop intake, drain bounded turns, wait for background sweeps/panel, stop children, and close store. */
	async stop(): Promise<void> {
		if (this.#stopPromise === undefined) {
			this.#stopped = true;
			this.#review.stop();
			this.#router?.stopDispatching();
			// Stop monitors before any await so an in-flight sweep cannot start a new cron command.
			this.#monitors?.stop();
			this.#stopPromise = this.#shutdown();
		}
		return this.#stopPromise;
	}

	async #shutdown(): Promise<void> {
		this.#bootBackupWorker?.terminate(); // a stop requested mid-backup ends the worker, so `start()` resumes
		clearInterval(this.#timer);
		this.#lanes?.stop();
		this.#landing.stop();
		await this.#taskGates?.stop();
		await this.#checkRunner?.stop();
		this.#heartbeat?.stop();
		this.#heartbeat = undefined;
		installProcessAudit(undefined);
		this.#ipc?.stop();
		for (const adapter of this.#adapters.values()) await adapter.stop();
		await this.#pumping;
		await this.#monitors?.idle();
		await this.#drainRunningTurns();
		await this.#reviewIdleBounded();
		await this.#opsPanel.idle();
		await this.#quota.idle();
		await this.#router?.close();
		this.#store?.close();
		this.#log.info("daemon_stop", { boot: this.#options.bootId });
	}

	/**
	 * The bounded wait for a running skill review: the fence in `stop()` starts nothing new, so this only waits out
	 * a review already in flight (still orphaned past the bound); a candidate pass waits on a click, its writes done.
	 */
	async #reviewIdleBounded(): Promise<void> {
		const boundMs = this.#options.stopDrainMs ?? STOP_DRAIN_MS;
		if (boundMs <= 0) return;
		const late = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => late.resolve(false), boundMs);
		const done = await Promise.race([this.#review.idle().then(() => true), late.promise]);
		clearTimeout(timer);
		if (!done) this.#log.warn("stop_review_timeout", { boundMs });
	}

	/** The bounded wait between intake stop and child stop; a no-op when nothing runs or the bound is 0. */
	async #drainRunningTurns(): Promise<void> {
		const boundMs = this.#options.stopDrainMs ?? STOP_DRAIN_MS;
		if (this.#router === undefined || boundMs <= 0) return;
		const busy = this.#router.busyOrigins();
		if (busy.length === 0) return;
		const startedAt = this.#clock.now();
		const stillBusy = await this.#router.drainRunning(boundMs);
		if (stillBusy.length > 0) this.#log.warn("stop_drain_timeout", { origins: stillBusy, boundMs });
		else this.#log.info("stop_drained", { origins: busy, drainMs: this.#clock.now() - startedAt });
	}
}
