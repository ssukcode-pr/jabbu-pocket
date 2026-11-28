// `/usage-reset-jabbu` 명령의 스냅샷 집계·입력 검증·초기화 실행·응답 포매팅.
import { COMMAND_TEXT } from "../core/types";
import type { Logger } from "../log";
import type { AgyAccountPool, AgyAccountsStatus } from "../omp/agy-account-pool";
import { localIso } from "../time";
import {
	clearQuotaLift,
	type ProviderHold,
	type ProviderQuotaGate,
	type QuotaLiftEntry,
	writeQuotaLift,
} from "./quota-gate";
import type { QuotaRecoveryTracker, QuotaReleaseEvent, RuntimeQuotaHold } from "./quota-recovery";

export const VALID_RESET_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface QuotaResetProviderItem {
	id: string;
	summary: string;
}

export interface QuotaResetSnapshot {
	providers: QuotaResetProviderItem[];
	holdCount: number;
	liftCount: number;
	isAgy: boolean;
}

function formatHhMm(ms: number, timezone: string): string {
	return localIso(ms, timezone).slice(11, 16);
}

/** 현재 보류·차단·수동 해제 상태를 피커와 안내 문구용 스냅샷으로 모은다. */
export function buildQuotaResetSnapshot(input: {
	isAgy: boolean;
	agyStatus?: AgyAccountsStatus | undefined;
	runtimeHolds: readonly RuntimeQuotaHold[];
	gateHolds: readonly ProviderHold[];
	lifts: ReadonlyMap<string, QuotaLiftEntry>;
	timezone: string;
}): QuotaResetSnapshot {
	if (input.isAgy) {
		const providers = (input.agyStatus?.blocked ?? []).map((acct) => ({
			id: acct.name,
			summary: `차단 (~${formatHhMm(acct.until, input.timezone)})`,
		}));
		return { providers, holdCount: providers.length, liftCount: 0, isAgy: true };
	}

	const notes = new Map<string, string[]>();
	const heldSet = new Set<string>();
	const addNote = (id: string, note: string): void => {
		const list = notes.get(id) ?? [];
		list.push(note);
		notes.set(id, list);
	};

	for (const hold of input.runtimeHolds) {
		heldSet.add(hold.provider);
		const reset = hold.resetAt === undefined ? "" : ` · ~${formatHhMm(hold.resetAt, input.timezone)}`;
		addNote(hold.provider, `대기열 보류(${hold.origins.length}개 대화${reset})`);
	}
	for (const hold of input.gateHolds) {
		heldSet.add(hold.provider);
		const causes = hold.causes.map((c) => `${c.label} ${Math.round(c.usedPct)}%`).join(", ");
		addNote(hold.provider, `게이트 보류(${causes})`);
	}
	for (const lift of input.lifts.values()) {
		addNote(lift.provider, `수동 해제(~${formatHhMm(lift.untilMs, input.timezone)})`);
	}

	const providers = [...notes.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, parts]) => ({ id, summary: parts.join(" · ") }));
	return { providers, holdCount: heldSet.size, liftCount: input.lifts.size, isAgy: false };
}

/** 인자 없는 `/usage-reset-jabbu` 텍스트 응답을 만든다. */
export function formatUsageResetSummary(snapshot: QuotaResetSnapshot): string {
	const lines: string[] = [];
	if (snapshot.providers.length === 0) {
		lines.push(snapshot.isAgy ? "차단 중인 agy 계정이 없습니다." : "보류 중인 프로바이더나 수동 해제가 없습니다.");
	} else {
		lines.push(snapshot.isAgy ? "차단 중인 agy 계정:" : "현재 쿼터 보류·해제 상태:");
		for (const item of snapshot.providers) lines.push(`• ${item.id}: ${item.summary}`);
	}
	const cmd = COMMAND_TEXT["usage-reset"];
	const clearHint = !snapshot.isAgy && snapshot.liftCount > 0 ? ` · 수동 해제 제거: \`${cmd} clear-lifts\`` : "";
	lines.push(`초기화: \`${cmd} <all|프로바이더>\`${clearHint}`);
	return lines.join("\n");
}

/** `/usage-reset-jabbu` 실행 결과 메시지를 포맷한다. */
export function formatUsageResetResult(input: {
	target: string;
	isAgy: boolean;
	clearedAgy?: readonly string[];
	clearedRuntime: number;
	liftedGate: readonly string[];
}): string {
	if (input.isAgy) {
		const cleared = input.clearedAgy ?? [];
		if (cleared.length === 0) {
			return input.target === "all" ? "차단된 agy 계정이 없습니다." : `차단 중인 agy 계정이 아닙니다: ${input.target}`;
		}
		return `🔄 agy 계정 차단을 해제했습니다: ${cleared.join(", ")}`;
	}
	const parts: string[] = [];
	if (input.clearedRuntime > 0) parts.push(`대기열 보류 ${input.clearedRuntime}건 해제`);
	if (input.liftedGate.length > 0) parts.push(`게이트 1시간 수동 해제(${input.liftedGate.join(", ")})`);
	if (parts.length === 0) {
		return input.target === "all" ? "초기화할 보류 항목이 없습니다." : `보류 중인 항목이 없습니다: ${input.target}`;
	}
	return `🔄 쿼터 상태를 초기화했습니다: ${parts.join(" · ")}`;
}

/** `/usage-reset-jabbu` 요청을 검증·실행하고 결과 문구를 반환한다. */
export function executeQuotaReset(deps: {
	rawArg: string;
	homeDir: string;
	now: number;
	isAgy: boolean;
	agyPool: AgyAccountPool | undefined;
	recovery: QuotaRecoveryTracker;
	gate: ProviderQuotaGate;
	log: Logger;
	resetSnapshot: () => QuotaResetSnapshot;
	onClearLifts: () => void;
	onReleaseEvents: (events: readonly QuotaReleaseEvent[]) => void;
	onSaveSnapshot: () => void;
	onPollNow: () => void;
}): string {
	const arg = deps.rawArg.trim();
	if (arg === "") return formatUsageResetSummary(deps.resetSnapshot());

	const lower = arg.toLowerCase();
	if (lower === "clear-lifts") {
		if (deps.isAgy) return "agy 모드에서는 수동 쿼터 해제 목록을 쓰지 않습니다.";
		const count = clearQuotaLift(deps.homeDir);
		deps.onClearLifts();
		deps.log.info("quota_lifts_cleared", { count });
		deps.onPollNow();
		return count === 0
			? "지울 수동 쿼터 해제(quota lift)가 없습니다."
			: `🧹 수동 쿼터 해제 ${count}건을 지우고 사용량 재조회를 시작했습니다.`;
	}

	if (lower === "all" || lower === "*" || arg === "전체") {
		if (deps.isAgy) {
			const cleared = deps.agyPool?.clearBlocked("*", deps.now) ?? [];
			deps.log.info("quota_usage_reset", { agent: "agy", target: "all", cleared });
			return formatUsageResetResult({
				target: "all",
				isAgy: true,
				clearedAgy: cleared,
				clearedRuntime: 0,
				liftedGate: [],
			});
		}
		const events: QuotaReleaseEvent[] = [];
		for (const hold of deps.recovery.listHolds()) {
			const ev = deps.recovery.clearProvider(hold.provider);
			if (ev !== undefined) events.push({ ...ev, reason: "manual_lift" });
		}
		if (events.length > 0) deps.onReleaseEvents(events);
		const liftedGate: string[] = [];
		if (deps.gate.hasHolds) {
			writeQuotaLift(deps.homeDir, { provider: "*", untilMs: deps.now + 60 * 60_000, now: deps.now });
			deps.gate.clearAll();
			deps.onSaveSnapshot();
			deps.onClearLifts();
			liftedGate.push("*");
		}
		deps.log.info("quota_usage_reset", { target: "all", clearedRuntime: events.length, liftedGate });
		return formatUsageResetResult({ target: "all", isAgy: false, clearedRuntime: events.length, liftedGate });
	}

	if (!VALID_RESET_PROVIDER.test(arg)) {
		return `대상 이름이 올바르지 않습니다: ${arg} — \`all\` 또는 영문·숫자·._- 이름을 입력하세요.`;
	}
	if (deps.isAgy) {
		const cleared = deps.agyPool?.clearBlocked(arg, deps.now) ?? [];
		deps.log.info("quota_usage_reset", { agent: "agy", target: arg, cleared });
		return formatUsageResetResult({ target: arg, isAgy: true, clearedAgy: cleared, clearedRuntime: 0, liftedGate: [] });
	}
	const ev = deps.recovery.clearProvider(lower);
	if (ev !== undefined) deps.onReleaseEvents([{ ...ev, reason: "manual_lift" }]);
	const gateHeld = deps.gate.snapshot(deps.now).held.some((h) => h.provider === lower);
	const liftedGate = gateHeld ? [lower] : [];
	if (gateHeld) {
		writeQuotaLift(deps.homeDir, { provider: lower, untilMs: deps.now + 60 * 60_000, now: deps.now });
		deps.onClearLifts();
		// Like the `all` branch (snapshot) and `clear-lifts` (poll): the snapshot and the next usage
		// poll must reflect the lift at once, not up to `pollMinutes` later.
		deps.onSaveSnapshot();
		deps.onPollNow();
	}
	deps.log.info("quota_usage_reset", { target: lower, clearedRuntime: ev !== undefined ? 1 : 0, liftedGate });
	return formatUsageResetResult({
		target: lower,
		isAgy: false,
		clearedRuntime: ev !== undefined ? 1 : 0,
		liftedGate,
	});
}
