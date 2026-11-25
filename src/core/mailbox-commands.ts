import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { type OmpCompactResult, OmpDriverError } from "../omp/driver";
import type { InboundRow } from "../store/db-rows";
/** Injected so tests use `FakeOmpDriver`; production builds an `RpcOmpDriver` for (origin, sessionDir). */
import { chargeSessionWindow } from "./mailbox-cost";
import { briefingReason, pickOption } from "./mailbox-helpers";
import { failedNotice } from "./mailbox-notices";
import { UNCERTAIN_REASON_TEXT } from "./mailbox-sending";
import { MAX_LISTED, type MailboxDeps, type MailboxHost, minutes, preview } from "./mailbox-types";
import { platformOfThreadRef } from "./normalize";
import { listSavedSessions, pickSession } from "./sessions";
import { COMMAND_TEXT, type ParsedCommand, parseCommand, RESTART_DRAINING_TEXT, RESTART_REFUSED_TEXT } from "./types";

/** Answer text of a command; throws when omp refuses it (the caller turns that into a `[turn failed]` notice). */
export async function commandReply(
	host: MailboxHost,
	{ kind, arg }: ParsedCommand,
	opRef: string,
	threadRef: string,
): Promise<string> {
	const busyText = `⏳ 작업 중에는 쓸 수 없습니다. 끝난 뒤 다시 보내거나 \`${COMMAND_TEXT.queue}\`로 확인하세요.`;
	switch (kind) {
		case "status":
			return await host.deps.statusProvider(host.deps.originKey);
		case "usage":
			if (host.deps.usageProvider === undefined) return "사용량 집계가 연결되지 않았습니다";
			return await host.deps.usageProvider(host.deps.originKey);
		case "distill":
			if (host.deps.distillProvider === undefined) return "스킬 리뷰가 연결되지 않았습니다";
			return await host.deps.distillProvider(host.deps.originKey);
		case "budget":
			if (host.deps.budgetProvider === undefined) return "비용 장부가 연결되지 않았습니다";
			return await host.deps.budgetProvider();
		case "btw":
			// A question with a turn and a capable driver was started by `#runCommand`; without a turn it never
			// reaches here (it becomes a plain message).
			if (arg !== "") return "이 대화의 에이전트는 곁질문을 지원하지 않습니다.";
			return "사용법: `!btw <질문>` — 진행 중인 작업에 끼워 넣지 않고 그 질문에만 바로 답합니다. 작업 중이 아니면 일반 메시지로 보냅니다.";
		case "queue":
			return await queueCommand(host, arg, opRef);
		case "followup":
			return `사용법: \`${COMMAND_TEXT.followup} <메시지>\` — 진행 중인 작업에 끼워 넣지 않고 끝난 뒤 다음 작업으로 보냅니다.`;
		case "model":
			if (arg !== "" && host.turn()) return busyText;
			return await modelCommand(host, arg, threadRef);
		case "thinking":
			if (arg !== "" && host.turn()) return busyText;
			return await thinkingCommand(host, arg, threadRef);
		case "compact":
			if (host.turn()) return busyText;
			return await compactCommand(host, arg, opRef, threadRef);
		case "resume":
			if (arg !== "" && host.turn()) return busyText;
			return await resumeCommand(host, arg, threadRef);
		case "new":
			throw new Error("unreachable: /new is handled by #newEpoch");
		case "undo":
			throw new Error("unreachable: undo is handled by #startUndo");
		case "brief":
			throw new Error("unreachable: brief is handled by #startBrief");
		case "stop":
			throw new Error("unreachable: stop is handled by #stopTurn");
		case "restart":
			return await restartCommand(host, threadRef);
	}
}

/**
 * `!restart` never touches the driver or a turn: a drain already running answers at once, a non-Discord or
 * monitor origin is refused, and otherwise the daemon's provider launches the detached apply (or says why not).
 */
export async function restartCommand(host: MailboxHost, threadRef: string): Promise<string> {
	const { originKey, restartProvider } = host.deps;
	if (host.deps.isDraining?.()) return RESTART_DRAINING_TEXT;
	const platform = platformOfThreadRef(threadRef);
	if (originKey.startsWith(MONITOR_ORIGIN_PREFIX) || platform !== "discord") return RESTART_REFUSED_TEXT;
	if (restartProvider === undefined) return "재시작이 연결되지 않았습니다";
	return await restartProvider(originKey, threadRef);
}

export async function modelCommand(host: MailboxHost, arg: string, threadRef: string): Promise<string> {
	const driver = await host.ensureDriver(threadRef);
	const models = await driver.availableModels();
	if (arg === "") {
		const state = await driver.state();
		const listed = models
			.slice(0, MAX_LISTED)
			.map((model, i) => `${i + 1}. ${model}${model === state.model ? " ◀" : ""}`);
		const more = models.length > MAX_LISTED ? [`… 외 ${models.length - MAX_LISTED}개 (이름 일부로 지정)`] : [];
		return [
			`현재 모델: ${state.model ?? "(알 수 없음)"}`,
			...listed,
			...more,
			`바꾸기: \`${COMMAND_TEXT.model} <번호|provider/id|이름 일부>\``,
		].join("\n");
	}
	const picked = pickOption(models, arg);
	if (picked === undefined) {
		const needle = arg.toLowerCase();
		const candidates = models.filter((model) => model.toLowerCase().includes(needle)).slice(0, MAX_LISTED);
		return [
			`모델을 하나로 고를 수 없습니다: ${arg}`,
			...(candidates.length > 0 ? ["후보:", ...candidates] : [`\`${COMMAND_TEXT.model}\`로 목록을 보세요.`]),
		].join("\n");
	}
	const applied = await driver.setModel(picked);
	host.deps.store.setOriginSettings(host.deps.originKey, { model: applied });
	host.deps.log.info("model_set", { origin: host.deps.originKey, model: applied });
	return `🔀 모델을 ${applied}(으)로 바꿨습니다. 이 대화방의 다음 작업부터 적용됩니다.`;
}

export async function thinkingCommand(host: MailboxHost, arg: string, threadRef: string): Promise<string> {
	const driver = await host.ensureDriver(threadRef);
	const levels = await driver.thinkingLevels();
	if (arg === "") {
		const state = await driver.state();
		return [
			`현재 thinking: ${state.configuredThinking === undefined ? (state.thinking ?? "(알 수 없음)") : `${state.configuredThinking} (실효 ${state.thinking ?? "알 수 없음"})`} · 모델 ${state.model ?? "?"}`,
			`가능: ${levels.join(", ")}`,
			`바꾸기: \`${COMMAND_TEXT.thinking} <수준>\``,
		].join("\n");
	}
	const level = arg.toLowerCase();
	if (!levels.includes(level)) return `지금 모델은 thinking ${arg}을(를) 지원하지 않습니다. 가능: ${levels.join(", ")}`;
	await driver.setThinking(level);
	host.deps.store.setOriginSettings(host.deps.originKey, { thinking: level });
	host.deps.log.info("thinking_set", { origin: host.deps.originKey, thinking: level });
	return `🧠 thinking을 ${level}(으)로 바꿨습니다.`;
}

export async function compactCommand(
	host: MailboxHost,
	instructions: string,
	opRef: string,
	threadRef: string,
): Promise<string> {
	const driver = await host.ensureDriver(threadRef);
	const compactStartedAt = host.deps.clock.now();
	let leafBefore: string | null = null;
	try {
		leafBefore = await driver.leafId();
	} catch {
		// A dead child fails `compact()` next; otherwise the charge falls back to the `[compactStartedAt, now]` window.
	}
	let result: OmpCompactResult;
	try {
		result = await driver.compact(instructions === "" ? undefined : instructions);
	} catch (error) {
		// omp refuses a short session ("Nothing to compact (session too small)"): an answer, not a failure.
		if (error instanceof Error && /nothing to compact/i.test(error.message)) {
			return "🗜 아직 압축할 만큼 대화가 길지 않습니다.";
		}
		// A driver without compaction (agy) refuses by name: tell the owner, a resend would not help.
		if (error instanceof OmpDriverError && /compact를 지원하지 않습니다/.test(error.message)) {
			return `🗜 ${error.message}.`;
		}
		throw error;
	}
	host.markCompacted();
	host.deps.log.info("compacted", { origin: host.deps.originKey, tokens_before: result.tokensBefore });
	await chargeSessionWindow(host.deps, {
		driver,
		opRef,
		fallbackAfterEntryId: leafBefore,
		from: compactStartedAt,
	});
	const summary = preview(result.summary);
	return `🗜 컨텍스트를 압축했습니다 (압축 전 약 ${result.tokensBefore.toLocaleString("en-US")} 토큰).${summary === "" ? "" : `\n요약: ${summary}`}`;
}

export async function resumeCommand(host: MailboxHost, arg: string, threadRef: string): Promise<string> {
	const { store, originKey, log } = host.deps;
	const sessions = listSavedSessions(dirname(host.deps.sessionDirFor(originKey, 1)));
	const driver = host.driver();
	const current = driver ? (await driver.state()).sessionFile : undefined;
	// agy keeps its conversation in agy itself (a pointer file here), never an omp `.jsonl`: there is no list to show.
	const sessionDir = store.getOrigin(originKey)?.sessionDir;
	if (sessions.length === 0 && sessionDir !== undefined && existsSync(join(sessionDir, "agy-conversation.json"))) {
		return `agy 세션은 저장된 세션 목록·이어가기를 지원하지 않습니다. 새로 시작하려면 \`${COMMAND_TEXT.new}\`를 쓰세요.`;
	}
	if (arg === "") {
		if (sessions.length === 0) return "저장된 세션이 없습니다.";
		const lines = sessions.slice(0, 10).map((session, i) => {
			const when = new Date(session.modifiedAt).toISOString().slice(0, 16).replace("T", " ");
			const mark = session.file === current ? " ◀ 현재" : "";
			return `${i + 1}. ${session.id.slice(0, 8)} · ${when}Z · ${session.preview || "(메시지 없음)"}${mark}`;
		});
		return [...lines, `이어가기: \`${COMMAND_TEXT.resume} <번호|세션 ID 앞부분>\``].join("\n");
	}
	const picked = pickSession(sessions, arg);
	if (!picked) return `세션을 찾지 못했습니다: ${arg} — \`${COMMAND_TEXT.resume}\`로 목록을 보세요.`;
	if (picked.file === current) return `이미 이 세션입니다: ${picked.id.slice(0, 8)}`;
	await host.stopDriver();
	store.newEpoch(originKey, dirname(picked.file), undefined, picked.file);
	host.resetCache();
	log.info("session_resumed", { origin: originKey, session: picked.id });
	await host.ensureDriver(threadRef);
	return `▶️ 세션 ${picked.id.slice(0, 8)}을(를) 이어갑니다. ${picked.preview}`;
}

/** Waiting rows the queue list numbers: queued followups and plain messages a failed steer left pending. */
export function waitingRows(
	host: MailboxHost,
): Array<{ row: InboundRow; command: ParsedCommand | undefined; label: string }> {
	return host.deps.store
		.listInbound({ originKey: host.deps.originKey, state: "pending" })
		.filter((row) => !host.frozenHold(row))
		.map((row) => ({ row, command: parseCommand(row.textRef) }))
		.filter(({ command }) => command === undefined || command.kind === "followup")
		.map(({ row, command }) => ({ row, command, label: command ? "다음 작업" : "끼워넣기 대기" }));
}

/** Rows parked as `uncertain` (listed after the waiting ones, numbering continues). */
export function uncertainRows(host: MailboxHost): InboundRow[] {
	return host.deps.store.listInbound({ originKey: host.deps.originKey, state: "uncertain" });
}

export async function queueText(host: MailboxHost): Promise<string> {
	const { clock } = host.deps;
	const turn = host.turn();
	const lines: string[] = [];
	if (turn) lines.push(`▶ 진행 중 · ${minutes(clock.now() - turn.startedAt)} 경과`);
	else lines.push(host.driver() ? "▶ 진행 중인 작업 없음" : "▶ 진행 중인 작업 없음 · omp 프로세스 쉬는 중(세션 유지)");
	const waiting = waitingRows(host);
	waiting.forEach(({ row, command, label }, i) => {
		lines.push(`${i + 1}. [${label}] ${preview(command ? command.arg : row.textRef)}`);
	});
	if (waiting.length === 0) lines.push("대기열 비어 있음");
	if (waiting.length > 0) lines.push(`취소하기: \`${COMMAND_TEXT.queue} drop <번호>\``);
	const uncertain = uncertainRows(host);
	if (uncertain.length > 0) {
		lines.push("⚠ 전달 불확실 — 이미 처리됐을 수 있어 자동으로 다시 보내지 않습니다");
		uncertain.forEach((row, i) => {
			const reason = row.uncertainReason === null ? "" : `${UNCERTAIN_REASON_TEXT[row.uncertainReason]} · `;
			lines.push(`${waiting.length + i + 1}. [${reason}불확실] ${preview(row.textRef)}`);
		});
		lines.push(
			`다시 보내지 않고 닫기: \`${COMMAND_TEXT.queue} close <번호>\` · 한 번 다시 보내기: \`${COMMAND_TEXT.queue} retry <번호>\``,
		);
	}
	const driver = host.driver();
	if (turn && driver) {
		const state = await driver.state();
		if (state.queuedMessageCount > 0) lines.push(`omp 안에서 처리 대기 중인 끼워넣기 ${state.queuedMessageCount}건`);
	}
	return lines.join("\n");
}

/**
 * `/queue-jabbu`: no argument lists the queue; `drop <번호>` cancels exactly one waiting row (pending ->
 * discarded), so it is never prompted or steered. Allowed while a turn runs — that is when the queue builds up.
 */
export async function queueCommand(host: MailboxHost, arg: string, opRef: string): Promise<string> {
	if (arg === "") return await queueText(host);
	const sub = /^(drop|close|retry)\s+(\S+)$/.exec(arg);
	if (!sub) {
		return `사용법: \`${COMMAND_TEXT.queue} drop <번호>\` — 대기 항목 하나를 취소합니다. 전달 불확실 항목은 \`close <번호>\`(다시 보내지 않고 닫기)나 \`retry <번호>\`(한 번 다시 보내기)를 쓰세요. \`${COMMAND_TEXT.queue}\`로 목록을 보세요.`;
	}
	const verb = sub[1];
	const number = sub[2] ?? "";
	const waiting = waitingRows(host);
	const index = /^\d+$/.test(number) ? Number(number) - 1 : -1;
	if (verb === "close" || verb === "retry") return resolveUncertain(host, verb, number, index - waiting.length, opRef);
	const picked = waiting[index];
	if (picked === undefined) {
		if (uncertainRows(host)[index - waiting.length] !== undefined) {
			return `${number}번은 전달 불확실 항목입니다. \`${COMMAND_TEXT.queue} close ${number}\`(다시 보내지 않고 닫기)나 \`${COMMAND_TEXT.queue} retry ${number}\`(한 번 다시 보내기)를 쓰세요.`;
		}
		return `대기 ${number}번이 없습니다. \`${COMMAND_TEXT.queue}\`로 목록을 보세요.`;
	}
	// Linked to this command's op like #newEpoch does: the command's delivery also finishes the dropped
	// thread's ⏳ status message (as 🚫 취소됨), and the row is never dispatched afterwards.
	host.deps.store.discard(picked.row.platformMessageId, opRef);
	host.deps.log.info("queue_dropped", {
		origin: host.deps.originKey,
		id: picked.row.platformMessageId,
		number: Number(number),
	});
	return `🚫 대기 ${number}번을 취소했습니다: [${picked.label}] ${preview(picked.command ? picked.command.arg : picked.row.textRef)}`;
}

/**
 * `close <번호>` discards an uncertain row without replaying it; `retry <번호>` makes it pending again and the drain
 * sends it once more from scratch (it may then answer twice). `slot` indexes the uncertain list (negative = a
 * waiting row's number, which these two never touch).
 */
export function resolveUncertain(
	host: MailboxHost,
	verb: "close" | "retry",
	number: string,
	slot: number,
	opRef: string,
): string {
	const { store, originKey, log } = host.deps;
	const picked = slot >= 0 ? uncertainRows(host)[slot] : undefined;
	if (picked === undefined) {
		return `전달 불확실 ${number}번이 없습니다. \`${COMMAND_TEXT.queue}\`로 목록을 보세요.`;
	}
	const shown = preview(picked.textRef);
	if (verb === "close") {
		// Linked to this command's op like `drop`, so the thread's ⏳ status message ends as 🚫.
		store.discard(picked.platformMessageId, opRef);
		log.info("queue_uncertain_closed", { origin: originKey, id: picked.platformMessageId, number: Number(number) });
		return `🚫 전달 불확실 ${number}번을 다시 보내지 않고 닫았습니다: ${shown}`;
	}
	store.retryUncertain(picked.platformMessageId);
	host.requestRedrain();
	log.info("queue_uncertain_retried", { origin: originKey, id: picked.platformMessageId, number: Number(number) });
	return `🔁 전달 불확실 ${number}번을 다시 보냅니다: ${shown}\n이미 처리됐다면 답이 두 번 나올 수 있습니다.`;
}

/**
 * Records a side question's outcome when it settles. Deliberately NOT on the serial chain (`#serial`,
 * `#background`): the wait can last minutes, and inbound messages, `#onFinal` and `#onExit` must not queue behind
 * it. The store writes are synchronous, so recording from outside the chain is safe.
 */
export function askBtw(
	deps: MailboxDeps,
	pending: Promise<string>,
	messageId: string,
	opRef: string,
	threadRef: string,
): void {
	const { store, originKey, log } = deps;
	// `/new` discards the dispatched rows, this question included: nothing of the old epoch is delivered.
	const discarded = (): boolean => store.getInbound(messageId)?.state === "discarded";
	pending
		.then(
			(answer) => {
				if (discarded()) return;
				store.recordAnswer({ originKey, opRef, threadRef, parts: [`💬 곁질문: ${answer}`] });
			},
			(error: unknown) => {
				const reason = error instanceof OmpDriverError ? error.message : String(error);
				log.error("command_failed", { origin: originKey, command: "btw", error: reason });
				if (discarded()) return;
				store.recordTurnFailure({ originKey, opRef, threadRef, notice: failedNotice(`btw: ${reason}`) });
			},
		)
		.catch((error: unknown) => {
			log.error("btw_settle_failed", { origin: originKey, opRef, error: String(error) });
		});
}

/**
 * `!brief`: the origin's one-page status picture, uploaded to this thread. Outside
 * the serial chain for the same reason as `#askBtw`/`#startUndo` — the render takes seconds and the origin's next
 * message must not wait for it; the store writes here are synchronous. The row ends `discarded` (an upload instead
 * of a text answer, no delivery), so the restart settle never reports this success as a failed turn.
 */
export function startBrief(deps: MailboxDeps, platformMessageId: string, opRef: string, threadRef: string): void {
	const { store, originKey, log } = deps;
	const provider = deps.briefingProvider;
	if (provider === undefined) {
		store.recordAnswer({
			originKey,
			opRef,
			threadRef,
			parts: ["브리핑 이미지를 만들지 못했습니다: 브리핑이 연결되지 않았습니다"],
		});
		return;
	}
	const startedAt = Date.now();
	provider(originKey, threadRef)
		.then(
			() => {
				store.discard(platformMessageId, opRef);
				log.info("briefing_rendered", { origin: originKey, ms: Date.now() - startedAt });
			},
			(error: unknown) => {
				const reason = briefingReason(error);
				log.warn("briefing_failed", { origin: originKey, error: reason });
				store.recordAnswer({
					originKey,
					opRef,
					threadRef,
					parts: [`브리핑 이미지를 만들지 못했습니다: ${reason}`],
				});
			},
		)
		.catch((error: unknown) => {
			log.error("briefing_settle_failed", { origin: originKey, opRef, error: String(error) });
		});
}
