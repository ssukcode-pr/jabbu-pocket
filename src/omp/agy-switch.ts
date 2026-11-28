import type { AgyMcpServer } from "../config-agy";
import type { Logger } from "../log";
import type { AgyAccountEntry, AgyAccountPool } from "./agy-account-pool";
import { type AgyAcpClient, resolveAgyExecutable, toolOutputOf } from "./agy-acp-client";
import { type NoticeScanState, resetTurnText } from "./agy-notice";
import {
	allAccountsExhaustedError,
	DEFAULT_QUOTA_BLOCK_MS,
	EFFORT_SUFFIX,
	formatQuotaExhaustedError,
	prependRotationContext,
	QUOTA_RESET_BUFFER_MS,
} from "./agy-quota";
import type { AgyToolKeepalive, AgyToolKeepaliveOptions } from "./agy-tool-keepalive";
import type { OmpEntry, OmpEvent, OmpFinal, OmpTurnUsage, OmpUsage } from "./driver";
import { OmpDriverError } from "./driver";
import { buildChildEnv } from "./env";

export interface AgyOmpDriverOptions {
	/** Path or name of the agy CLI; names resolve on the child PATH. */
	agyExecutable: string;
	cwd: string;
	/** jabbu-owned per-origin-epoch directory; holds the `agy-conversation.json` resume pointer. */
	sessionDir: string;
	/** agy model id without provider prefix; an effort suffix agy's options lack is cut and read as the thinking level. */
	model?: string;
	/** `thought_level` to set (`low|medium|high|xhigh`); other values are ignored. */
	thinking?: string;
	/** Extra child env; `SLACK_`/`JABBU_` keys are rejected like every driver. */
	env?: Record<string, string>;
	/** Floors + persona text, appended to agy's system prompt of every session. */
	systemPrompt?: string;
	/** MCP servers each `session/new|resume` passes; read at every start (a reload applies from the next one). */
	mcpServers?: () => readonly AgyMcpServer[] | undefined;
	/** Parent environment source (tests); default `process.env`. */
	baseEnv?: Record<string, string | undefined>;
	/** How long each start request (`initialize`, session, config) may take. */
	startupTimeoutMs?: number;
	/** How long an abort waits for agy's `cancelled` reply before killing the child. */
	cancelTimeoutMs?: number;
	/** Where an unsupported `setTodos`, a rotation and the ACP lifecycle are reported; absent → not reported. */
	log?: Logger;
	/** Origin the driver serves; named in its log events. */
	originKey?: string;
	/** Tool-execution keepalive timer overrides (tests); defaults to 60 s interval up to 8 min. */
	toolKeepalive?: AgyToolKeepaliveOptions;
	/** `<homeDir>/media/inbound`: attached images under it go with the prompt as image blocks (`agy-images.ts`). */
	inboundRoot?: string;
	/** Shared account pool (`--app-data-dir` isolation + seamless pre-tool retry on 429). */
	accounts?: AgyAccountPool;
	/** Provides thread/exchange context when switching to a fresh account session. */
	rotationContext?: () => string | null;
	timezone?: string;
	now?: () => number;
}

export interface PendingTurn extends NoticeScanState {
	opRef: string;
	originalPrompt: string;
	abortRequested: boolean;
	hadToolCall: boolean;
	quotaSwitches: number;
	/** Token sums over the turn's prompts (one model call each), steered follow-ups included. */
	usage: OmpTurnUsage;
	/** Resolves when the turn ended (its final went out, or its child died). */
	settled: PromiseWithResolvers<void>;
	/** Resolves when the current `session/prompt` reply arrives (so `#cancel` can hand off to retry). */
	promptReplied: PromiseWithResolvers<void>;
	finished: boolean;
	switching: boolean;
	switchingClient?: AgyAcpClient;
	/** The running `#cancel`, once one started. */
	cancelling?: Promise<void>;
	/** Set when agy reported a quota retry: the turn is cancelled and switches or ends as a 429. */
	rateLimit?: string;
	rateLimitDetail?: string;
	rateLimitResetMs?: number;
	droppedSteers?: number;
}

/** Allocates a fresh `PendingTurn` record for a new `prompt()` invocation. */
export function createPendingTurn(opRef: string, originalPrompt: string): PendingTurn {
	return {
		opRef,
		originalPrompt,
		abortRequested: false,
		hadToolCall: false,
		quotaSwitches: 0,
		usage: { calls: 0, input: 0, cacheRead: 0, output: 0, rotated: false },
		text: "",
		lastNewline: -1,
		quotaScanFrom: 0,
		quotaLineDead: false,
		settled: Promise.withResolvers<void>(),
		promptReplied: Promise.withResolvers<void>(),
		finished: false,
		switching: false,
	};
}

export interface QuotaSwitchHost {
	readonly options: AgyOmpDriverOptions;
	readonly started: () => boolean;
	readonly activeTurn: () => PendingTurn | undefined;
	readonly activeClient: () => AgyAcpClient | undefined;
	readonly currentAccount: () => AgyAccountEntry | undefined;
	readonly now: () => number;
	readonly dropSession: (markSwitched?: boolean) => void;
	readonly retireChild: () => void;
	readonly endClient: (client: AgyAcpClient) => Promise<void>;
	readonly launch: (executable: string, env: Record<string, string>) => Promise<void>;
	readonly sendPrompt: (client: AgyAcpClient, turn: PendingTurn, text: string, entry?: string) => void;
	readonly finish: (turn: PendingTurn, final: Omit<OmpFinal, "usage">) => void;
	readonly withRespawnLock: (fn: () => Promise<void>) => Promise<void>;
}

/** Resolves effective model id and thinking level (`user` overrides `account`, which overrides `default`). */
export function resolveAgyConfigTarget(params: {
	overrideModel?: string;
	userModel?: string;
	accountModel?: string;
	defaultModel?: string;
	userThinking?: string;
	defaultThinking?: string;
	modelValues: readonly string[];
}): { modelId?: string; thinking?: string } {
	const { overrideModel, userModel, accountModel, defaultModel, userThinking, defaultThinking, modelValues } = params;
	let level = userThinking ?? defaultThinking;
	const configured = overrideModel ?? userModel ?? accountModel ?? defaultModel;
	if (configured === undefined) return { ...(level === undefined ? {} : { thinking: level }) };
	let id = configured;
	const bare = id.replace(EFFORT_SUFFIX, "");
	const fromAccount = overrideModel === undefined && userModel === undefined && accountModel !== undefined;
	if (!modelValues.includes(id) && bare !== id && modelValues.includes(bare)) {
		const suffix = EFFORT_SUFFIX.exec(id)?.[1];
		level = userThinking !== undefined ? userThinking : fromAccount ? (suffix ?? level) : (level ?? suffix);
		id = bare;
	}
	return { modelId: id, ...(level === undefined ? {} : { thinking: level }) };
}

/** Applies the resolved model and (when supported) thought_level onto the live session. */
export async function applyAgyConfig(params: {
	overrideModel?: string;
	userModel?: string;
	accountModel?: string;
	defaultModel?: string;
	userThinking?: string;
	defaultThinking?: string;
	modelValues: readonly string[];
	option: (id: string) => { currentValue?: string } | undefined;
	setOption: (configId: string, value: string) => Promise<void>;
	log?: Logger;
	originKey?: string;
}): Promise<void> {
	const target = resolveAgyConfigTarget(params);
	const previousModel = params.option("model")?.currentValue;
	if (target.modelId !== undefined) await params.setOption("model", target.modelId);
	if (target.thinking === undefined) return;
	if (params.option("thought_level") === undefined) {
		params.log?.info("agy.acp.thinking_unsupported", {
			origin: params.originKey,
			model: params.option("model")?.currentValue,
			level: target.thinking,
		});
		return;
	}
	await params.setOption("thought_level", target.thinking).catch(async (error: unknown) => {
		if (previousModel !== undefined && previousModel !== target.modelId)
			await params.setOption("model", previousModel).catch(() => {});
		throw error;
	});
}

/** Selects the account for a new ACP launch (pool off = no account; throws when every account is blocked or the pool is configured but broken). */
export function selectLaunchAccount(
	options: AgyOmpDriverOptions,
	now: number,
): { account?: AgyAccountEntry; appDataDir?: string } {
	const accounts = options.accounts;
	if (accounts === undefined) return {};
	const picked = accounts.selectAvailable(now);
	if (picked === null) throw allAccountsExhaustedError(accounts, now, options.timezone);
	if (picked === undefined) {
		const err = accounts.status(now)?.error;
		if (err !== undefined) throw new OmpDriverError("rpc_error", `agy account pool unavailable: ${err}`);
		return {};
	}
	return { account: picked, appDataDir: accounts.prepareAccountDir(picked) };
}

/** True when a live idle child should switch to `wanted` (current blocked, or primary unblocked over fallback). */
export function shouldSwitchAgyAccount(
	current: AgyAccountEntry | undefined,
	wanted: AgyAccountEntry | undefined,
	accounts: AgyAccountPool,
	now: number,
): boolean {
	return (
		current !== undefined &&
		wanted !== undefined &&
		current.name !== wanted.name &&
		(accounts.isBlocked(current.name, now) || (wanted.tier === "primary" && current.tier === "fallback"))
	);
}

/** Records tool start/end entries and events for one `tool_call`/`tool_call_update` frame. */
export function applyAgyToolUpdate(params: {
	update: Record<string, unknown>;
	entries: OmpEntry[];
	nextSeq: () => number;
	tools: Map<string, "open" | "done">;
	toolKeepalive: AgyToolKeepalive;
	model: string | undefined;
	provider: string;
	emit: (event: OmpEvent) => void;
}): void {
	const { update, entries, nextSeq, tools, toolKeepalive, model, provider, emit } = params;
	const callId = typeof update.toolCallId === "string" ? update.toolCallId : `agy-tool-${nextSeq()}`;
	const name = typeof update.name === "string" ? update.name : typeof update.title === "string" ? update.title : "tool";
	const args = update.rawInput ?? update.args ?? {};
	if (!tools.has(callId)) {
		tools.set(callId, "open");
		entries.push({
			id: `ag-${nextSeq()}`,
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name, arguments: args }],
				stopReason: "toolUse",
				provider,
				...(model === undefined ? {} : { model }),
			},
		});
		toolKeepalive.start(callId, name);
		emit({ type: "tool_execution_start", toolCallId: callId, toolName: name, args });
	}
	const status = update.status;
	if (tools.get(callId) !== "open" || (status !== "completed" && status !== "failed")) return;
	tools.set(callId, "done");
	const output = toolOutputOf(update);
	entries.push({
		id: `ag-${nextSeq()}`,
		type: "message",
		toolCallId: callId,
		toolName: name,
		message: { role: "toolResult", content: [{ type: "text", text: output ?? "" }] },
	});
	toolKeepalive.end(callId);
	emit({
		type: "tool_execution_end",
		toolCallId: callId,
		toolName: name,
		result: output,
		...(status === "failed" ? { isError: true } : {}),
	});
}

/** Accumulates one prompt reply's token usage into the turn summary. */
export function addAgyUsage(target: OmpTurnUsage, usage: OmpUsage | undefined): void {
	if (usage === undefined) return;
	target.calls += 1;
	target.input += usage.input ?? 0;
	target.cacheRead += usage.cacheRead ?? 0;
	target.output += usage.output ?? 0;
}

/** Appends an assistant message entry when a prompt reply produced text or usage. */
export function pushAgyAssistantEntry(params: {
	entries: OmpEntry[];
	nextSeq: () => number;
	text: string;
	succeeded: boolean;
	provider: string;
	model: string | undefined;
	usage: OmpUsage | undefined;
}): void {
	const { entries, nextSeq, text, succeeded, provider, model, usage } = params;
	if (text.trim() === "" && usage === undefined) return;
	entries.push({
		id: `ag-${nextSeq()}`,
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: succeeded ? "stop" : "error",
			provider,
			...(model === undefined ? {} : { model }),
			...(usage === undefined ? {} : { usage }),
		},
	});
}

/** Handles a 429 rate-limit: marks exhausted, retries pre-tool on next account, or fails safely after tools. */
export async function handleAgyQuotaSwitch(
	host: QuotaSwitchHost,
	turn: PendingTurn,
	client: AgyAcpClient,
): Promise<void> {
	if (host.activeTurn() !== turn || turn.finished || turn.switchingClient === client) return;
	turn.switchingClient = client;
	const accounts = host.options.accounts;
	const current = host.currentAccount();
	if (accounts === undefined || current === undefined) {
		host.finish(turn, { opRef: turn.opRef, status: "error", text: "", error: turn.rateLimit });
		return;
	}
	const now = host.now();
	const resetMs = turn.rateLimitResetMs ?? DEFAULT_QUOTA_BLOCK_MS + QUOTA_RESET_BUFFER_MS;
	accounts.markExhausted(current.name, now + resetMs, turn.rateLimitDetail);
	if (turn.abortRequested || !host.started()) {
		host.dropSession(true);
		host.retireChild();
		turn.usage.rotated = true;
		host.finish(turn, { opRef: turn.opRef, status: "aborted", text: "", error: "cancelled" });
		return;
	}
	const next = accounts.selectAvailable(now);
	const canRetry =
		!turn.hadToolCall &&
		turn.usage.calls === 0 &&
		next !== null &&
		next !== undefined &&
		next.name !== current.name &&
		turn.quotaSwitches < accounts.size();
	if (!canRetry) {
		host.dropSession(true);
		host.retireChild();
		turn.usage.rotated = true;
		host.options.log?.warn("agy.account.switched", {
			origin: host.options.originKey,
			from: current.name,
			to: next?.name ?? "none",
			retry: false,
			hadToolCall: turn.hadToolCall,
		});
		const error = formatQuotaExhaustedError({
			detail: turn.rateLimitDetail ?? turn.rateLimit ?? "429",
			hadToolCall: turn.hadToolCall,
			nextAccount: next?.name,
			soonest: accounts.soonestReset(now),
			timezone: host.options.timezone,
		});
		host.finish(turn, { opRef: turn.opRef, status: "error", text: "", error });
		return;
	}
	turn.quotaSwitches += 1;
	resetTurnText(turn);
	turn.rateLimit = undefined;
	turn.rateLimitDetail = undefined;
	turn.rateLimitResetMs = undefined;
	turn.cancelling = undefined;
	turn.switching = true;
	turn.promptReplied = Promise.withResolvers<void>();
	host.dropSession(false);
	await host.withRespawnLock(async () => {
		try {
			if (host.activeClient() === client) await host.endClient(client);
			if (!host.started() || turn.abortRequested) {
				turn.usage.rotated = true;
				host.dropSession(true);
				host.finish(turn, { opRef: turn.opRef, status: "aborted", text: "", error: "cancelled" });
				return;
			}
			const env = buildChildEnv(host.options.env, host.options.baseEnv);
			const executable = resolveAgyExecutable(host.options.agyExecutable, env);
			await host.launch(executable, env);
			const nextClient = host.activeClient();
			if (!host.started() || turn.abortRequested || !nextClient) {
				if (nextClient !== undefined) await host.endClient(nextClient);
				host.dropSession(true);
				turn.usage.rotated = true;
				host.finish(turn, { opRef: turn.opRef, status: "aborted", text: "", error: "cancelled" });
				return;
			}
			host.options.log?.info("agy.account.switched", {
				origin: host.options.originKey,
				from: current.name,
				to: host.currentAccount()?.name,
				retry: true,
				attempt: turn.quotaSwitches,
			});
			turn.switching = false;
			const retryPrompt = prependRotationContext(turn.originalPrompt, host.options.rotationContext?.() ?? null);
			host.sendPrompt(nextClient, turn, retryPrompt, turn.originalPrompt);
		} catch (error) {
			host.dropSession(true);
			turn.usage.rotated = true;
			host.finish(turn, {
				opRef: turn.opRef,
				status: "error",
				text: "",
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			turn.switching = false;
		}
	});
}
