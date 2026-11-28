import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgyAccountEntry } from "./agy-account-pool";
import {
	type AcpConfigOption,
	AgyAcpClient,
	acpSessionParams,
	acpUsageOf,
	configOptionsOf,
	resolveAgyExecutable,
} from "./agy-acp-client";
import { promptImageBlocks } from "./agy-images";
import { appendTurnChunk, resetTurnText } from "./agy-notice";
import {
	allAccountsExhaustedError,
	clearAgyPointer,
	parseAgySessionStem,
	prependRotationContext,
	QUIET_UPDATES,
	readAgyPointer,
	recordFinalQuotaNotice,
	recordQuotaFailure,
	setQuotaNotice,
	writeAgyPointer,
} from "./agy-quota";
import {
	type AgyOmpDriverOptions,
	addAgyUsage,
	applyAgyConfig,
	applyAgyToolUpdate,
	createPendingTurn,
	handleAgyQuotaSwitch,
	type PendingTurn,
	pushAgyAssistantEntry,
	selectLaunchAccount,
	shouldSwitchAgyAccount,
} from "./agy-switch";
import { AgyToolKeepalive } from "./agy-tool-keepalive";
import { isTrajectoryLoss, noteDroppedSteers, promptReplyEnd, withDroppedSteers } from "./agy-trajectory";
import {
	type OmpCommand,
	type OmpCompactResult,
	OmpDriverError,
	type OmpEntries,
	type OmpEntry,
	type OmpEvent,
	type OmpExitInfo,
	type OmpFinal,
	type OmpOpenResult,
	type OmpSessionDriver,
	type OmpState,
	type OmpTurnUsage,
	type TodoPhase,
} from "./driver";
import { buildChildEnv } from "./env";
import { isRecord } from "./type-guards";

export type { AgyOmpDriverOptions };
// Antigravity CLI ACP child (`agy acp`) boundary per origin: initialize/load|new, prompt/update -> OmpFinal, rotate on usage_update.
export const AGY_PROVIDER = "agy";
/** `thought_level` values of agy 1.5.16; a model may offer fewer, or none. */
export const AGY_THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
/** Share of the context window at which a conversation is rotated after its turn ends. */
export const AGY_ROTATE_RATIO = 0.7;

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const STOP_GRACE_MS = 5_000;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const recordOf = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);
const isThinkingLevel = (level: string): boolean => (AGY_THINKING_LEVELS as readonly string[]).includes(level);

/** The final's `usage`: absent when the turn neither called the model nor rotated. */
const usageField = (turn: PendingTurn): { usage?: OmpTurnUsage } =>
	turn.usage.calls === 0 && !turn.usage.rotated ? {} : { usage: { ...turn.usage } };

export class AgyOmpDriver implements OmpSessionDriver {
	readonly #options: AgyOmpDriverOptions;
	readonly #pointerPath: string;
	readonly #toolKeepalive: AgyToolKeepalive;
	#started = false;
	#stopping = false;
	#client: AgyAcpClient | undefined;
	#account: AgyAccountEntry | undefined;
	#switchedBeforePrompt = false;
	/** The child being started: its death fails the start instead of reaching `onExit`. */
	#launching: AgyAcpClient | undefined;
	/** True while `session/load` replays the conversation: its updates are history, not this turn (omp: `#loading`). */
	#loading = false;
	/** Children this driver ended on purpose: their exit is no crash. */
	readonly #ended = new WeakSet<AgyAcpClient>();
	/** Entries of the CURRENT child only: cleared on every (re)spawn, cursors before it become `unknown_since`. */
	#entries: OmpEntry[] = [];
	#entrySeq = 0;
	#turn: PendingTurn | undefined;
	/** Steered texts held until the running prompt's reply; sent together as the turn's next prompt. */
	#queued: string[] = [];
	#sessionId: string | undefined;
	/** True while the live child resumed the session it was asked to (what `openSession().resumed` reports). */
	#resumedCurrent = false;
	#loadedUnanswered = false; // live session came from session/load, not answered yet: a lost trajectory reopens once
	#imageInput = false; // the live child's initialize offered promptCapabilities.image
	/** Default model from config; unset = agy's own default. */
	#defaultModel: string | undefined;
	/** Default thinking level from config. */
	#defaultThinking: string | undefined;
	/** Model explicitly chosen via `/model` (persists across rotations, switches, and restarts). */
	#userModel: string | undefined;
	/** Thinking level explicitly chosen via `/thinking`. */
	#userThinking: string | undefined;
	#configOptions: AcpConfigOption[] = [];
	/** Latest `usage_update` of the live session. */
	#context: { used: number; size: number } | undefined;
	/** A `usage_update` arrived for the live turn; without one rotation judges on the previous turn's numbers. */
	#usageUpdatedThisTurn = false;
	/** This blindness episode already warned once (a later update clears it). */
	#contextBlindWarned = false;
	/** Tool calls of the live child: open until their `completed|failed` update. */
	readonly #tools = new Map<string, "open" | "done">();
	readonly #unknownUpdates = new Set<string>();
	readonly #finalListeners = new Set<(final: OmpFinal) => void>();
	readonly #eventListeners = new Set<(event: OmpEvent) => void>();
	readonly #exitListeners = new Set<(info: OmpExitInfo) => void>();
	/** Set while `#spawn` replaces the child: a prompt meanwhile waits for the new child instead of spawning its own. */
	#respawning: Promise<void> | undefined;

	constructor(options: AgyOmpDriverOptions) {
		this.#options = options;
		this.#pointerPath = join(resolve(options.sessionDir), "agy-conversation.json");
		this.#toolKeepalive = new AgyToolKeepalive((event) => {
			if (this.#client !== undefined && this.#turn !== undefined) this.#emit(event);
		}, options.toolKeepalive);
		this.#defaultModel = options.model === "" ? undefined : options.model;
		this.#defaultThinking =
			options.thinking !== undefined && isThinkingLevel(options.thinking) ? options.thinking : undefined;
	}

	/** Pid of the live child (for leftover-process checks); undefined when not running. */
	get pid(): number | undefined {
		return this.#client?.pid;
	}

	#now(): number {
		return this.#options.now?.() ?? Date.now();
	}

	async start(): Promise<void> {
		if (this.#started) throw new OmpDriverError("already_started", "driver already started");
		resolveAgyExecutable(this.#options.agyExecutable, buildChildEnv(this.#options.env, this.#options.baseEnv));
		for (const dir of [this.#options.cwd, this.#options.sessionDir]) mkdirSync(resolve(dir), { recursive: true });
		this.#started = true;
		await this.#bindPinnedConversation();
	}

	async prompt(text: string): Promise<string> {
		this.#requireStarted();
		if (this.#turn) throw new OmpDriverError("rpc_error", "a turn is already running");
		await this.#ensureChild();
		const client = this.#client;
		if (client === undefined) throw new OmpDriverError("rpc_error", "agy child is not running");
		if (this.#turn) throw new OmpDriverError("rpc_error", "a turn is already running");
		const switched = this.#switchedBeforePrompt;
		this.#switchedBeforePrompt = false;
		const promptText = switched ? prependRotationContext(text, this.#options.rotationContext?.() ?? null) : text;
		const opRef = `agy-${Date.now().toString(36)}-${++this.#entrySeq}`;
		const turn = createPendingTurn(opRef, text);
		this.#turn = turn;
		this.#usageUpdatedThisTurn = false;
		this.#sendPrompt(client, turn, promptText);
		return opRef;
	}

	/** Text written mid-turn is held and sent as the next `session/prompt` once the running one replies (same opRef). */
	async steer(text: string): Promise<void> {
		this.#requireStarted();
		if (this.#turn === undefined) throw new OmpDriverError("rpc_error", "no turn is running to steer");
		this.#queued.push(text);
	}

	/** Cancels the running turn (`#cancel`); no turn runs once this returns. */
	async abort(): Promise<void> {
		this.#requireStarted();
		const turn = this.#turn;
		if (!turn) return;
		turn.abortRequested = true;
		const client = this.#client;
		if (client && !turn.switching) await this.#cancel(turn, client);
		await turn.settled.promise;
	}

	/**
	 * `session/cancel`, then the prompt's reply (`cancelled`) ends the turn and agy keeps running. No reply within
	 * `cancelTimeoutMs` (omp's CANCEL_TIMEOUT_MS): the child's process group gets SIGKILL like omp's `close()`, without
	 * an `onExit`, and the next prompt restarts it on the same session.
	 */
	#cancel(turn: PendingTurn, client: AgyAcpClient): Promise<void> {
		this.#toolKeepalive.clear();
		const keepQueued = turn.rateLimit !== undefined && !turn.hadToolCall && this.#options.accounts !== undefined;
		if (!keepQueued && this.#queued.length > 0) turn.droppedSteers = (turn.droppedSteers ?? 0) + this.#queued.length;
		if (!keepQueued) this.#queued = [];
		turn.cancelling ??= (async () => {
			try {
				client.notify("session/cancel", { sessionId: this.#sessionId });
			} catch {
				// a closed stdin: the kill below ends the turn
			}
			const unanswered = Promise.withResolvers<false>();
			const ms = this.#options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
			const timer = setTimeout(() => unanswered.resolve(false), ms);
			const answered = await Promise.race([
				Promise.race([turn.settled.promise, turn.promptReplied.promise]).then(() => true),
				unanswered.promise,
			]);
			clearTimeout(timer);
			if (answered) return;
			this.#options.log?.warn("agy.acp.abort_killed", { origin: this.#options.originKey, pid: client.pid });
			if (this.#client === client) this.#client = undefined;
			this.#ended.add(client);
			client.kill("SIGKILL");
			await client.gone;
			if (turn.rateLimit !== undefined) {
				await this.#handleQuotaSwitch(turn, client);
				return;
			}
			this.#abortTurn(turn, "cancel unanswered; agy killed");
		})();
		return turn.cancelling;
	}

	/** `/new`: drop the resume pointer and restart on a new session. */
	async newSession(): Promise<{ cancelled: boolean }> {
		this.#requireStarted();
		this.#dropSession(false);
		this.#switchedBeforePrompt = false;
		if (this.#client) await this.#spawn(undefined, "new session");
		return { cancelled: false };
	}

	async openSession(): Promise<OmpOpenResult> {
		this.#requireStarted();
		await this.#bindPinnedConversation();
		return { resumed: this.#resumedCurrent, sessionId: this.#sessionId ?? "" };
	}

	/** Binds the session the pointer names: restarts on it when the live child holds another one. */
	async #bindPinnedConversation(): Promise<void> {
		const pointer = readAgyPointer(this.#pointerPath);
		if (pointer !== undefined && (pointer.conversationId !== this.#sessionId || !this.#client))
			return this.#spawn(pointer.conversationId, "conversation rebind", pointer.account);
		await this.#ensureChild();
	}

	/** Resumes the agy session named by `sessionFile` (a session id, or a path ending in one). */
	async switchSession(sessionFile: string): Promise<{ cancelled: boolean }> {
		this.#requireStarted();
		const stem = parseAgySessionStem(sessionFile);
		this.#switchedBeforePrompt = false;
		await this.#spawn(stem, "session switch");
		return { cancelled: false };
	}

	/** The live session's `model` option values, as `agy/<id>`. */
	async availableModels(): Promise<string[]> {
		if (this.#started && this.#turn === undefined) await this.#ensureChild();
		return (this.#option("model")?.values ?? []).map((id) => `${AGY_PROVIDER}/${id}`);
	}

	/** `session/set_config_option model` on the live session (no restart); the thinking level is set again after it. */
	async setModel(model: string): Promise<string> {
		this.#requireStarted();
		const slash = model.indexOf("/");
		if (slash <= 0 || slash === model.length - 1)
			throw new OmpDriverError("rpc_error", `model must be provider/id: ${model}`);
		if (model.slice(0, slash) !== AGY_PROVIDER || !(await this.availableModels()).includes(model)) {
			throw new OmpDriverError("rpc_error", `Model not found: ${model}`);
		}
		const id = model.slice(slash + 1);
		const client = this.#client;
		if (client !== undefined) await this.#applyConfig(client, id);
		this.#userModel = id;
		return `${AGY_PROVIDER}/${id}`;
	}

	/** The levels the live model offers (`thought_level`); none for a model without it. */
	async thinkingLevels(): Promise<string[]> {
		if (this.#started && this.#turn === undefined) await this.#ensureChild();
		return [...(this.#option("thought_level")?.values ?? [])];
	}

	/** An agy conversation has no omp extension commands. */
	availableCommands(): Promise<OmpCommand[]> {
		return Promise.resolve([]);
	}

	/** agy has no omp task list: nothing is planted (a lane's prompt still carries its acceptance criteria). */
	async setTodos(phases: TodoPhase[]): Promise<void> {
		this.#options.log?.info("set_todos_unsupported", { driver: "agy", phases: phases.length });
	}

	/** `session/set_config_option thought_level` on the live session (no restart). */
	async setThinking(level: string): Promise<void> {
		this.#requireStarted();
		if (!isThinkingLevel(level)) throw new OmpDriverError("rpc_error", `Model not found: thinking ${level}`);
		await this.#ensureChild();
		const client = this.#client;
		if (client === undefined) throw new OmpDriverError("rpc_error", "agy child is not running");
		if (!this.#option("thought_level")?.values.includes(level)) {
			const msg = `agy model ${this.#option("model")?.currentValue ?? "?"} does not offer it`;
			throw new OmpDriverError("rpc_error", `Model not found: thinking ${level} (${msg})`);
		}
		await this.#setOption(client, "thought_level", level);
		this.#userThinking = level;
	}

	compact(): Promise<OmpCompactResult> {
		return Promise.reject(new OmpDriverError("rpc_error", "agy 세션은 compact를 지원하지 않습니다"));
	}

	async state(): Promise<OmpState> {
		const model = this.#option("model")?.currentValue ?? this.#userModel ?? this.#account?.model ?? this.#defaultModel;
		const thinking = this.#option("thought_level")?.currentValue;
		const c = this.#sessionId === undefined ? undefined : this.#context;
		return {
			sessionId: this.#sessionId ?? "",
			idle: this.#turn === undefined,
			settled: this.#turn === undefined,
			queuedMessageCount: this.#queued.length,
			messageCount: this.#entries.length,
			...(model === undefined ? {} : { model: `${AGY_PROVIDER}/${model}` }),
			...(thinking === undefined ? {} : { thinking }),
			...(c && c.size > 0 ? { context: { tokens: c.used, window: c.size, percent: (c.used / c.size) * 100 } } : {}),
		};
	}

	async leafId(): Promise<string | null> {
		return this.#entries.at(-1)?.id ?? null;
	}

	async entriesSince(since?: string): Promise<OmpEntries> {
		const leafId = this.#entries.at(-1)?.id ?? null;
		const index = since === undefined ? -1 : this.#entries.findIndex((entry) => entry.id === since);
		if (since !== undefined && index === -1) throw new OmpDriverError("unknown_since", `no such entry: ${since}`);
		return { entries: since === undefined ? [...this.#entries] : this.#entries.slice(index + 1), leafId };
	}

	onFinal(listener: (final: OmpFinal) => void): () => void {
		this.#finalListeners.add(listener);
		return () => this.#finalListeners.delete(listener);
	}

	onEvent(listener: (event: OmpEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	onExit(listener: (info: OmpExitInfo) => void): () => void {
		this.#exitListeners.add(listener);
		return () => this.#exitListeners.delete(listener);
	}

	async stop(): Promise<void> {
		this.#started = false;
		this.#toolKeepalive.clear();
		const turn = this.#turn;
		if (turn !== undefined) {
			turn.finished = true;
			turn.promptReplied.resolve();
			turn.settled.resolve();
		}
		noteDroppedSteers(this.#options, "agy.acp.stop_steers_dropped", turn, this.#queued);
		this.#turn = undefined;
		this.#queued = [];
		if (this.#launching !== undefined) await this.#endClient(this.#launching, STOP_GRACE_MS); // else #respawning waits out its timeouts
		await this.#respawning;
		const client = this.#client;
		this.#stopping = true;
		this.#client = undefined;
		if (client) await this.#endClient(client, STOP_GRACE_MS);
	}

	/** Ends a child on purpose (its exit is no crash): SIGTERM to its group, SIGKILL after `graceMs`. */
	#endClient(client: AgyAcpClient, graceMs: number): Promise<void> {
		this.#ended.add(client);
		return client.end(graceMs);
	}

	// ---- child lifecycle ----

	#requireStarted(): void {
		if (!this.#started) throw new OmpDriverError("not_started", "driver not started");
	}

	#abortTurn(turn: PendingTurn, error = "cancelled"): void {
		this.#finish(turn, { opRef: turn.opRef, status: "aborted", text: "", error });
	}

	#dropSession(markSwitched = false): void {
		clearAgyPointer(this.#pointerPath);
		this.#sessionId = undefined;
		if (markSwitched) this.#switchedBeforePrompt = true;
	}

	async #dropClient(client: AgyAcpClient): Promise<void> {
		if (this.#client === client) this.#client = undefined;
		await this.#endClient(client, KILL_GRACE_MS);
	}

	async #withRespawnLock<T>(fn: () => Promise<T>): Promise<T> {
		while (this.#respawning) await this.#respawning;
		const done = Promise.withResolvers<void>();
		this.#respawning = done.promise;
		try {
			return await fn();
		} finally {
			if (this.#respawning === done.promise) this.#respawning = undefined;
			done.resolve();
		}
	}

	/** Starts a child when none is live, or switches to a better/unblocked pool account before prompting. */
	async #ensureChild(): Promise<void> {
		while (this.#respawning) await this.#respawning;
		if (this.#turn !== undefined) return;
		const accounts = this.#options.accounts;
		if (accounts !== undefined) {
			const now = this.#now();
			const wanted = accounts.selectAvailable(now);
			if (wanted === null) throw allAccountsExhaustedError(accounts, now, this.#options.timezone);
			if (this.#client && shouldSwitchAgyAccount(this.#account, wanted, accounts, now)) {
				this.#dropSession(true);
				return this.#spawn(undefined, "account switch");
			}
		}
		if (this.#client) return;
		const account = this.#account?.name ?? readAgyPointer(this.#pointerPath)?.account;
		await this.#spawn(this.#sessionId, "child restart", account);
	}

	/**
	 * Ends the current child (if any) and waits for its exit, so two agy processes never hold one session, then starts
	 * a new one on `resume` (or a new session). A turn still running ends `aborted` (`reason` in the error) once the new
	 * child is up or failed to start, so a prompt sent on that final reaches the new child.
	 */
	async #spawn(resume: string | undefined, reason: string, resumeAccount?: string): Promise<void> {
		const env = buildChildEnv(this.#options.env, this.#options.baseEnv);
		const executable = resolveAgyExecutable(this.#options.agyExecutable, env);
		let cut: PendingTurn | undefined;
		let dropped = 0;
		try {
			await this.#withRespawnLock(async () => {
				const previous = this.#client;
				cut = this.#turn;
				dropped = this.#queued.length;
				this.#turn = undefined;
				this.#queued = [];
				if (previous) await this.#dropClient(previous);
				// `stop()` while waiting (a retire or the old child's exit) must not be undone by a child launched after it.
				if (!this.#started) throw new OmpDriverError("not_started", "driver stopped while agy restarted");
				await this.#launch(executable, env, resume, resumeAccount, reason !== "session switch");
			});
		} finally {
			if (cut !== undefined)
				this.#abortTurn(cut, `agy restarted (${reason})${dropped > 0 ? ` (steer ${dropped}건 미전달)` : ""}`);
		}
	}

	async #launch(
		executable: string,
		env: Record<string, string>,
		resume?: string,
		resumeAccount?: string,
		verifyAccount = true,
	): Promise<void> {
		const options = this.#options;
		const picked = selectLaunchAccount(options, this.#now());
		this.#account = picked.account;
		this.#entries = [];
		this.#tools.clear();
		this.#configOptions = [];
		this.#context = undefined;
		this.#contextBlindWarned = false;
		this.#resumedCurrent = false;
		this.#loadedUnanswered = false;
		this.#imageInput = false;
		this.#stopping = false;
		const client: AgyAcpClient = new AgyAcpClient(
			{
				executable,
				cwd: resolve(options.cwd),
				env,
				log: options.log,
				originKey: options.originKey,
				...(picked.appDataDir === undefined ? {} : { appDataDir: picked.appDataDir }),
			},
			{
				onNotification: (method, params) => {
					if (client === this.#client && method === "session/update") this.#onUpdate(params);
				},
				onRequest: (method) => options.log?.info("agy.acp.agent_request", { origin: options.originKey, method }),
				onExit: (code, stderr) => this.#onChildExit(client, code, stderr),
			},
		);
		this.#client = client;
		this.#launching = client;
		const timeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
		try {
			const init = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, timeoutMs);
			this.#requireStarted();
			this.#imageInput = recordOf(recordOf(init.agentCapabilities)?.promptCapabilities)?.image === true;
			const accountMismatch = resume !== undefined && verifyAccount && resumeAccount !== this.#account?.name;
			if (accountMismatch) {
				this.#dropSession(true);
				options.log?.info("agy.acp.account_pointer_reset", {
					origin: options.originKey,
					from: resumeAccount ?? "default",
					to: this.#account?.name ?? "default",
				});
			}
			await this.#openConversation(client, accountMismatch ? undefined : resume);
			this.#requireStarted();
			options.log?.info("agy.acp.started", {
				origin: options.originKey,
				pid: client.pid,
				sessionId: this.#sessionId,
				resumed: this.#resumedCurrent,
				...(this.#account === undefined ? {} : { account: this.#account.name }),
			});
		} catch (error) {
			await this.#dropClient(client);
			this.#account = undefined;
			const stderr = client.stderrTail.trim().slice(-400);
			throw new OmpDriverError("rpc_error", `agy acp start failed: ${String(error)}${stderr ? ` | ${stderr}` : ""}`, {
				cause: error,
			});
		} finally {
			this.#loading = false;
			if (this.#launching === client) this.#launching = undefined;
		}
	}

	/** `session/load` of `resume` (replay ignored), else or when refused `session/new`; then pointer and config. */
	async #openConversation(client: AgyAcpClient, resume: string | undefined): Promise<void> {
		const timeoutMs = this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
		const params = acpSessionParams(this.#options);
		let opened: Record<string, unknown> | undefined;
		this.#loadedUnanswered = false;
		if (resume !== undefined) {
			try {
				this.#loading = true;
				opened = await client.request("session/load", { sessionId: resume, ...params }, timeoutMs);
				this.#sessionId = resume;
				this.#resumedCurrent = true;
				this.#loadedUnanswered = true;
			} catch (error) {
				const fields = { origin: this.#options.originKey, sessionId: resume, error: String(error) };
				this.#options.log?.warn("agy.acp.load_failed", fields);
			}
		}
		this.#loading = false;
		if (opened === undefined) {
			opened = await client.request("session/new", params, timeoutMs);
			const sessionId = str(opened.sessionId);
			if (sessionId === undefined) throw new OmpDriverError("rpc_error", "agy session/new without a sessionId");
			this.#sessionId = sessionId;
		}
		writeAgyPointer(this.#options.sessionDir, this.#pointerPath, this.#sessionId ?? "", this.#account?.name);
		this.#configOptions = configOptionsOf(opened.configOptions) ?? [];
		await this.#applyConfig(client);
	}
	#option(id: string): AcpConfigOption | undefined {
		return this.#configOptions.find((option) => option.id === id);
	}

	/** Sets the chosen model, then the thinking level when the model offers `thought_level`. */
	async #applyConfig(client: AgyAcpClient, overrideModel?: string): Promise<void> {
		await applyAgyConfig({
			...(overrideModel === undefined ? {} : { overrideModel }),
			...(this.#userModel === undefined ? {} : { userModel: this.#userModel }),
			...(this.#account?.model === undefined ? {} : { accountModel: this.#account.model }),
			...(this.#defaultModel === undefined ? {} : { defaultModel: this.#defaultModel }),
			...(this.#userThinking === undefined ? {} : { userThinking: this.#userThinking }),
			...(this.#defaultThinking === undefined ? {} : { defaultThinking: this.#defaultThinking }),
			modelValues: this.#option("model")?.values ?? [],
			option: (id) => this.#option(id),
			setOption: (configId, value) => this.#setOption(client, configId, value),
			...(this.#options.log === undefined ? {} : { log: this.#options.log }),
			...(this.#options.originKey === undefined ? {} : { originKey: this.#options.originKey }),
		});
	}

	/** `session/set_config_option`; a reply whose `currentValue` is not `value` counts as refused. */
	async #setOption(client: AgyAcpClient, configId: string, value: string): Promise<void> {
		const result = await client.request(
			"session/set_config_option",
			{ sessionId: this.#sessionId, configId, value },
			this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
		);
		this.#configOptions = configOptionsOf(result.configOptions) ?? this.#configOptions;
		const current = this.#option(configId)?.currentValue;
		if (current !== value)
			throw new OmpDriverError("rpc_error", `agy did not apply ${configId}=${value} (now ${current ?? "unset"})`);
	}

	#onChildExit(client: AgyAcpClient, code: number, stderr: string): void {
		if (this.#ended.has(client) || this.#launching === client || this.#client !== client) return;
		this.#client = undefined;
		this.#toolKeepalive.clear();
		// The dead turn gets no final (the mailbox fails it on `onExit`); an abort waiting on it returns.
		const turn = this.#turn;
		if (turn !== undefined) {
			turn.finished = true;
			turn.settled.resolve();
		}
		noteDroppedSteers(this.#options, "agy.acp.child_died_steers_dropped", turn, this.#queued);
		this.#turn = undefined;
		this.#queued = [];
		if (!this.#stopping) for (const listener of this.#exitListeners) listener({ code, expected: false, stderr });
	}

	// ---- session updates ----

	#onUpdate(params: Record<string, unknown>): void {
		if (this.#loading || params.sessionId !== this.#sessionId) return;
		const update = recordOf(params.update) ?? {};
		const kind = str(update.sessionUpdate) ?? "";
		switch (kind) {
			case "agent_message_chunk": {
				const content = recordOf(update.content);
				const turn = this.#turn;
				const client = this.#client;
				if (!turn || turn.cancelling || !client || content?.type !== "text" || typeof content.text !== "string") return;
				// agy retrying a quota failure: stop its retry loop and switch or end as a 429.
				const { quota, shown } = appendTurnChunk(turn, content.text);
				if (quota !== undefined) {
					setQuotaNotice(turn, quota);
					void this.#cancel(turn, client);
					return;
				}
				this.#emit({
					type: "message_update",
					message: { role: "assistant", content: [{ type: "text", text: shown }] },
				});
				return;
			}
			case "tool_call":
			case "tool_call_update":
				this.#onTool(update);
				return;
			case "usage_update": {
				const used = num(update.used);
				const size = num(update.size);
				if (used === undefined || size === undefined) return;
				this.#context = { used, size };
				this.#usageUpdatedThisTurn = true;
				this.#contextBlindWarned = false;
				return;
			}
			case "config_option_update": {
				this.#configOptions = configOptionsOf(update.configOptions) ?? this.#configOptions;
				return;
			}
			// The `-p` driver emitted no thinking either.
			case "agent_thought_chunk":
				return;
			default:
				if (QUIET_UPDATES[kind] || this.#unknownUpdates.has(kind)) return;
				this.#unknownUpdates.add(kind);
				this.#options.log?.debug("agy.acp.unknown_update", { origin: this.#options.originKey, kind });
		}
	}

	/** Tool calls become omp-style toolCall/toolResult entries and tool events (the mailbox's status lines). */
	#onTool(update: Record<string, unknown>): void {
		if (this.#turn === undefined) return;
		this.#turn.hadToolCall = true;
		applyAgyToolUpdate({
			update,
			entries: this.#entries,
			nextSeq: () => ++this.#entrySeq,
			tools: this.#tools,
			toolKeepalive: this.#toolKeepalive,
			model: this.#option("model")?.currentValue,
			provider: AGY_PROVIDER,
			emit: (event) => this.#emit(event),
		});
	}

	// ---- prompts ----

	/** Records the user entry (text only), then sends `session/prompt` with the attached images the child takes. */
	#sendPrompt(client: AgyAcpClient, turn: PendingTurn, text: string, entry: string = text): void {
		this.#entries.push({ id: `ag-${++this.#entrySeq}`, type: "message", message: { role: "user", content: entry } });
		const prompt: Array<Record<string, unknown>> = [{ type: "text", text }];
		const { inboundRoot, log, originKey } = this.#options;
		if (!this.#imageInput || inboundRoot === undefined) this.#request(client, turn, prompt);
		else
			void promptImageBlocks(text, inboundRoot, log, originKey).then((images) => {
				if (this.#turn !== turn) return;
				if (!turn.abortRequested) return this.#request(client, turn, [...prompt, ...images]);
				this.#abortTurn(turn);
			});
	}

	#request(client: AgyAcpClient, turn: PendingTurn, prompt: Array<Record<string, unknown>>): void {
		resetTurnText(turn);
		turn.promptReplied = Promise.withResolvers<void>();
		client.request("session/prompt", { sessionId: this.#sessionId, prompt }).then(
			(result) => this.#onPromptReply(client, turn, prompt, result, undefined),
			(error: unknown) => this.#onPromptReply(client, turn, prompt, undefined, error),
		);
	}

	#onPromptReply(
		client: AgyAcpClient,
		turn: PendingTurn,
		prompt: Array<Record<string, unknown>>,
		result: Record<string, unknown> | undefined,
		failure: unknown,
	): void {
		// A child ended on purpose (abort kill, restart) leaves the turn's end to whoever ended it.
		if (this.#turn !== turn || this.#ended.has(client)) return;
		turn.promptReplied.resolve();
		this.#toolKeepalive.clear();
		const stopReason = str(result?.stopReason);
		recordQuotaFailure(turn, failure);
		recordFinalQuotaNotice(turn, stopReason, turn.text);
		if (turn.rateLimit !== undefined) {
			void this.#handleQuotaSwitch(turn, client);
			return;
		}
		if (this.#loadedUnanswered && !turn.abortRequested && isTrajectoryLoss(result, failure)) {
			void this.#reopenLostTrajectory(client, turn, prompt);
			return;
		}
		const usage = acpUsageOf(result?.usage);
		addAgyUsage(turn.usage, usage);
		const succeeded = stopReason === "end_turn";
		if (succeeded) this.#loadedUnanswered = false;
		pushAgyAssistantEntry({
			entries: this.#entries,
			nextSeq: () => ++this.#entrySeq,
			text: turn.text,
			succeeded,
			provider: AGY_PROVIDER,
			model: this.#option("model")?.currentValue,
			usage,
		});
		// Steered text is answered as part of the same turn: the opRef stays open until that answer arrives.
		if (succeeded && !turn.abortRequested && this.#queued.length > 0 && this.#client === client) {
			this.#sendPrompt(client, turn, this.#queued.splice(0).join("\n\n"));
			return;
		}
		const dropped = (turn.droppedSteers ?? 0) + this.#queued.length;
		const end = promptReplyEnd({ ...turn, stopReason, failure, dropped });
		if (this.#context !== undefined && this.#usageUpdatedThisTurn) turn.usage.contextTokens = this.#context.used;
		// Before the final: a prompt sent on it must already find the conversation dropped.
		turn.usage.rotated = this.#rotateIfFull(turn.usage.calls);
		this.#finish(turn, { opRef: turn.opRef, text: turn.text, ...end });
	}

	/**
	 * agy loaded the resumed session but cannot prompt it (`trajectory not found`): drop the pointer, open a new session
	 * on the same child and send the same prompt once more. A failure there ends the turn as error, an abort as aborted.
	 */
	async #reopenLostTrajectory(client: AgyAcpClient, turn: PendingTurn, prompt: Array<Record<string, unknown>>) {
		const { log, originKey: origin } = this.#options;
		log?.warn("agy.acp.trajectory_reset", { origin, sessionId: this.#sessionId });
		this.#dropSession(false);
		this.#resumedCurrent = false;
		try {
			await this.#openConversation(client, undefined);
		} catch (cause) {
			const error = `agy session reopen failed: ${cause instanceof Error ? cause.message : String(cause)}`;
			if (this.#turn === turn) this.#finish(turn, { opRef: turn.opRef, status: "error", text: "", error });
			return;
		}
		if (this.#turn !== turn || this.#client !== client) return;
		if (!turn.abortRequested) return this.#request(client, turn, prompt);
		this.#abortTurn(turn);
	}

	async #handleQuotaSwitch(turn: PendingTurn, client: AgyAcpClient): Promise<void> {
		await handleAgyQuotaSwitch(
			{
				options: this.#options,
				started: () => this.#started,
				activeTurn: () => this.#turn,
				activeClient: () => this.#client,
				currentAccount: () => this.#account,
				now: () => this.#now(),
				dropSession: (markSwitched) => this.#dropSession(markSwitched),
				retireChild: () => this.#retireChild(),
				endClient: (old) => this.#dropClient(old),
				launch: (executable, env) => this.#launch(executable, env, undefined),
				sendPrompt: (client, turn, text, entry) => this.#sendPrompt(client, turn, text, entry),
				finish: (activeTurn, final) => this.#finish(activeTurn, final),
				withRespawnLock: (fn) => this.#withRespawnLock(fn),
			},
			turn,
			client,
		);
	}

	/** Ends `turn` once (a turn a restart cut off too): clears it and the queue, sends its final, wakes an abort. */
	#finish(turn: PendingTurn, final: Omit<OmpFinal, "usage">): void {
		if (turn.finished) return;
		turn.finished = true;
		turn.promptReplied.resolve();
		const dropped = (turn.droppedSteers ?? 0) + (this.#turn === turn ? this.#queued.length : 0);
		if (this.#turn === turn) [this.#turn, this.#queued] = [undefined, []];
		const out = final.status === "completed" ? final : withDroppedSteers(final, dropped);
		for (const listener of this.#finalListeners) listener({ ...out, ...usageField(turn) });
		turn.settled.resolve();
	}

	/**
	 * Between turns only: a session at or over the rotation share of its window drops its pointer, its id and its
	 * child, so `#ensureChild` starts the next turn on a new session. `usage_update` is the only source of the
	 * window: a turn that called the model without one leaves rotation blind (no reading, or the previous turn's),
	 * so it warns once per episode instead of silently never rotating.
	 */
	#rotateIfFull(calls: number): boolean {
		const context = this.#context;
		if ((context === undefined || !this.#usageUpdatedThisTurn) && calls > 0 && !this.#contextBlindWarned) {
			this.#contextBlindWarned = true;
			this.#options.log?.warn("agy_rotation_blind", { origin: this.#options.originKey, calls });
		}
		if (context === undefined || context.size <= 0 || context.used < context.size * AGY_ROTATE_RATIO) return false;
		this.#options.log?.info("agy_conversation_rotated", {
			origin: this.#options.originKey,
			conversationId: this.#sessionId,
			contextTokens: context.used,
			window: context.size,
		});
		this.#dropSession(false);
		this.#retireChild();
		return true;
	}

	/** Ends the live child without a replacement; a prompt meanwhile waits for its exit, then starts a new one. */
	#retireChild(): void {
		this.#toolKeepalive.clear();
		const client = this.#client;
		if (!client) return;
		this.#client = undefined;
		const retired: Promise<void> = this.#endClient(client, KILL_GRACE_MS).finally(() => {
			if (this.#respawning === retired) this.#respawning = undefined;
		});
		this.#respawning = retired;
	}

	#emit(event: OmpEvent): void {
		for (const listener of this.#eventListeners) listener(event);
	}
}
