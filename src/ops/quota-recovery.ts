// 공급자 한도 오류로 멈춘 대화방 대기열을 `omp usage --json` 실제 여유 회복 확인 뒤 자동 해제한다.
import type { UsageResponse } from "../omp/usage-json";
import { FALLBACK_QUOTA_RELEASE_MS, type QuotaLiftEntry, usedPercentOfLimit } from "./quota-gate";

export const QUOTA_RECOVERY_CURSOR = "quota_recovery:holds";
export const UNMETERED_QUOTA_HOLD_MS = 5 * 60_000;
export const RECOVERY_PROBE_MAX_MS = 2 * 60_000;
const MAX_FUTURE_RESET_MS = 30 * 86_400_000;

export interface RuntimeQuotaHold {
	provider: string;
	reason: string;
	hitAt: number;
	resetAt?: number;
	origins: string[];
}

export interface QuotaReleaseEvent {
	provider: string;
	origins: string[];
	reason: "headroom_recovered" | "manual_lift" | "unmetered_elapsed" | "safety_timeout";
}

interface InternalHold {
	provider: string;
	reason: string;
	hitAt: number;
	resetAt?: number;
	origins: Set<string>;
}

const UNIT_MS: Record<string, number> = {
	ms: 1,
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

function wallPartsInZone(
	utcMs: number,
	timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } | undefined {
	try {
		const fmt = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		const map: Record<string, number> = {};
		for (const part of fmt.formatToParts(new Date(utcMs))) {
			if (part.type !== "literal") map[part.type] = Number(part.value);
		}
		if (
			map.year === undefined ||
			map.month === undefined ||
			map.day === undefined ||
			map.hour === undefined ||
			map.minute === undefined ||
			map.second === undefined
		) {
			return undefined;
		}
		return {
			year: map.year,
			month: map.month,
			day: map.day,
			hour: map.hour === 24 ? 0 : map.hour,
			minute: map.minute,
			second: map.second,
		};
	} catch {
		return undefined;
	}
}

function zonedWallTimeToUtcMs(
	wall: { year: number; month: number; day: number; hour: number; minute: number; second: number },
	timezone: string,
): number | undefined {
	const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
	const p1 = wallPartsInZone(guess, timezone);
	if (p1 === undefined) return undefined;
	const apparent1 = Date.UTC(p1.year, p1.month - 1, p1.day, p1.hour, p1.minute, p1.second);
	const refined = guess - (apparent1 - guess);
	const p2 = wallPartsInZone(refined, timezone);
	if (p2 === undefined) return refined;
	const apparent2 = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, p2.second);
	return refined - (apparent2 - guess);
}

/** `extractResetAt`이 뽑은 상대 기간(`"3h51m29s 뒤"`) 또는 시각 문자열을 epoch ms로 변환한다. */
export function parseResetAtMs(resetAt: string | undefined, now: number, timezone: string): number | undefined {
	if (resetAt === undefined) return undefined;
	const trimmed = resetAt.trim();
	if (trimmed === "") return undefined;

	let target: number | undefined;
	if (trimmed.endsWith(" 뒤")) {
		const body = trimmed.slice(0, -" 뒤".length).trim();
		const tokenRe =
			/(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)(?![a-z])/gi;
		let totalMs = 0;
		let matched = false;
		const leftover = body.replace(tokenRe, (_all, numStr: string, unit: string) => {
			const n = Number(numStr);
			const factor = UNIT_MS[unit.toLowerCase()];
			if (Number.isFinite(n) && factor !== undefined) {
				totalMs += n * factor;
				matched = true;
			}
			return " ";
		});
		if (!matched || totalMs <= 0 || leftover.replace(/[,and\s]/gi, "") !== "") return undefined;
		target = now + Math.round(totalMs);
	} else if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
		const parsed = Date.parse(trimmed.includes(" ") ? trimmed.replace(" ", "T") : trimmed);
		if (Number.isFinite(parsed)) target = parsed;
	} else {
		// The hour/minute/second (and month/day) ranges are part of the patterns: Date.UTC would silently
		// normalize an out-of-range wall time ("25:00" → next-day 01:00) instead of rejecting it.
		const dtMatch = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[ T]([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(
			trimmed,
		);
		if (dtMatch !== null) {
			target = zonedWallTimeToUtcMs(
				{
					year: Number(dtMatch[1]),
					month: Number(dtMatch[2]),
					day: Number(dtMatch[3]),
					hour: Number(dtMatch[4]),
					minute: Number(dtMatch[5]),
					second: Number(dtMatch[6] ?? "0"),
				},
				timezone,
			);
		} else {
			const hmMatch = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(trimmed);
			const nowWall = hmMatch === null ? undefined : wallPartsInZone(now, timezone);
			if (hmMatch !== null && nowWall !== undefined) {
				const hour = Number(hmMatch[1]);
				const minute = Number(hmMatch[2]);
				const second = Number(hmMatch[3] ?? "0");
				const sameDay = zonedWallTimeToUtcMs(
					{ year: nowWall.year, month: nowWall.month, day: nowWall.day, hour, minute, second },
					timezone,
				);
				if (sameDay !== undefined) {
					if (sameDay > now) target = sameDay;
					else {
						const next = new Date(Date.UTC(nowWall.year, nowWall.month - 1, nowWall.day + 1));
						target = zonedWallTimeToUtcMs(
							{
								year: next.getUTCFullYear(),
								month: next.getUTCMonth() + 1,
								day: next.getUTCDate(),
								hour,
								minute,
								second,
							},
							timezone,
						);
					}
				}
			}
		}
	}

	if (target === undefined || !Number.isFinite(target) || target > now + MAX_FUTURE_RESET_MS) return undefined;
	return target;
}

/** `omp usage --json` 응답에서 특정 프로바이더의 실제 여유 회복 여부를 판정한다. */
export function providerHeadroomStatus(
	response: UsageResponse,
	provider: string,
	holdPct: number,
): "recovered" | "exhausted" | "unmetered" {
	const key = provider.trim().toLowerCase();
	const reports =
		key === "*" ? response.reports : response.reports.filter((report) => report.provider.trim().toLowerCase() === key);
	if (reports.length === 0) return "unmetered";
	for (const report of reports) {
		if (report.limits.length === 0) continue;
		const allBelow = report.limits.every((limit) => {
			if (limit.status === "exhausted") return false;
			const used = usedPercentOfLimit(limit);
			return used !== undefined && used < holdPct;
		});
		if (allBelow) return "recovered";
	}
	return "exhausted";
}

function isLifted(provider: string, now: number, lifts?: ReadonlyMap<string, QuotaLiftEntry>): boolean {
	if (lifts === undefined) return false;
	const all = lifts.get("*");
	if (all !== undefined && all.untilMs > now) return true;
	const own = lifts.get(provider);
	return own !== undefined && own.untilMs > now;
}

function toSnapshot(hold: InternalHold): RuntimeQuotaHold {
	return {
		provider: hold.provider,
		reason: hold.reason,
		hitAt: hold.hitAt,
		...(hold.resetAt === undefined ? {} : { resetAt: hold.resetAt }),
		origins: [...hold.origins].sort(),
	};
}

// A hold blocks until the later of the 5h safety window and a known reset: a weekly hold is not retried
// every 5h, while a hold past its reset still waits for a poll to confirm headroom.
function holdBlocks(hold: InternalHold, now: number): boolean {
	return now - hold.hitAt < FALLBACK_QUOTA_RELEASE_MS || (hold.resetAt !== undefined && now < hold.resetAt);
}

/** 공급자 한도 오류로 보류된 대화방과 복구 감시 상태를 추적한다. */
export class QuotaRecoveryTracker {
	readonly #holds = new Map<string, InternalHold>();

	get hasHolds(): boolean {
		return this.#holds.size > 0;
	}

	listHolds(): RuntimeQuotaHold[] {
		return [...this.#holds.values()].sort((a, b) => a.provider.localeCompare(b.provider)).map(toSnapshot);
	}

	recordQuotaError(input: { provider: string; originKey: string; reason: string; resetAt?: number; now: number }): {
		opened: boolean;
		originAdded: boolean;
		hold: RuntimeQuotaHold;
	} {
		const provider = input.provider.trim().toLowerCase() || "*";
		const existing = this.#holds.get(provider);
		if (existing === undefined) {
			const created: InternalHold = {
				provider,
				reason: input.reason,
				hitAt: input.now,
				...(input.resetAt === undefined ? {} : { resetAt: input.resetAt }),
				origins: new Set([input.originKey]),
			};
			this.#holds.set(provider, created);
			return { opened: true, originAdded: true, hold: toSnapshot(created) };
		}
		const hadOrigin = existing.origins.has(input.originKey);
		existing.origins.add(input.originKey);
		existing.reason = input.reason;
		if (input.resetAt !== undefined && (existing.resetAt === undefined || input.resetAt > existing.resetAt)) {
			existing.resetAt = input.resetAt;
		}
		return { opened: false, originAdded: !hadOrigin, hold: toSnapshot(existing) };
	}

	holdForProvider(
		provider: string | undefined,
		now: number,
		lifts?: ReadonlyMap<string, QuotaLiftEntry>,
		originKey?: string,
	): RuntimeQuotaHold | undefined {
		const normalized = provider?.trim().toLowerCase();
		if (normalized !== undefined && normalized !== "") {
			const exact = this.#holds.get(normalized);
			if (exact !== undefined && !isLifted(exact.provider, now, lifts) && holdBlocks(exact, now)) {
				return toSnapshot(exact);
			}
		}
		if (originKey !== undefined) {
			const wild = this.#holds.get("*");
			if (wild?.origins.has(originKey) && !isLifted("*", now, lifts) && holdBlocks(wild, now)) {
				return toSnapshot(wild);
			}
		}
		return undefined;
	}

	formatOriginHold(hold: RuntimeQuotaHold, timezone: string): string {
		let resetSuffix = "";
		if (hold.resetAt !== undefined) {
			const fmt = new Intl.DateTimeFormat("ko-KR", {
				timeZone: timezone,
				month: "numeric",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				hourCycle: "h23",
			});
			resetSuffix = ` (예상 초기화 ${fmt.format(new Date(hold.resetAt))})`;
		}
		const target = hold.provider === "*" ? "현재 모델" : hold.provider;
		return `공급자 한도(${target}) 복구 대기 중${resetSuffix} — 여유 회복 확인 시 자동 재개 (\`/model-jabbu\`로 즉시 전환)`;
	}

	evaluateUsageRecovery(response: UsageResponse, holdPct: number, now: number): QuotaReleaseEvent[] {
		const events: QuotaReleaseEvent[] = [];
		for (const [provider, hold] of this.#holds) {
			const status = providerHeadroomStatus(response, provider, holdPct);
			if (status === "recovered") {
				this.#holds.delete(provider);
				events.push({ provider, origins: [...hold.origins].sort(), reason: "headroom_recovered" });
				continue;
			}
			if (status === "unmetered") {
				const elapsed = hold.resetAt !== undefined ? now >= hold.resetAt : now - hold.hitAt >= UNMETERED_QUOTA_HOLD_MS;
				if (elapsed) {
					this.#holds.delete(provider);
					events.push({ provider, origins: [...hold.origins].sort(), reason: "unmetered_elapsed" });
				}
			}
		}
		return events;
	}

	checkLiftsAndExpiry(now: number, lifts?: ReadonlyMap<string, QuotaLiftEntry>): QuotaReleaseEvent[] {
		const events: QuotaReleaseEvent[] = [];
		for (const [provider, hold] of this.#holds) {
			if (isLifted(provider, now, lifts)) {
				this.#holds.delete(provider);
				events.push({ provider, origins: [...hold.origins].sort(), reason: "manual_lift" });
				continue;
			}
			if (!holdBlocks(hold, now)) {
				this.#holds.delete(provider);
				events.push({ provider, origins: [...hold.origins].sort(), reason: "safety_timeout" });
			}
		}
		return events;
	}

	shouldProbeNow(now: number, lastPollAt: number, pollMs: number): boolean {
		if (!this.hasHolds) return false;
		for (const hold of this.#holds.values()) {
			if (hold.resetAt !== undefined && hold.resetAt <= now && lastPollAt < hold.resetAt) return true;
		}
		return now - lastPollAt >= Math.min(pollMs, RECOVERY_PROBE_MAX_MS);
	}

	clearProvider(provider: string): QuotaReleaseEvent | undefined {
		const key = provider.trim().toLowerCase() || "*";
		const hold = this.#holds.get(key);
		if (hold === undefined) return undefined;
		this.#holds.delete(key);
		return { provider: key, origins: [...hold.origins].sort(), reason: "headroom_recovered" };
	}

	serialize(): string {
		return JSON.stringify({ version: 1, holds: this.listHolds() });
	}

	restore(raw: string | undefined): void {
		this.#holds.clear();
		if (raw === undefined) return;
		try {
			const parsed = JSON.parse(raw) as { version?: unknown; holds?: unknown };
			if (parsed?.version !== 1 || !Array.isArray(parsed.holds)) return;
			for (const item of parsed.holds) {
				if (typeof item !== "object" || item === null) continue;
				const rec = item as Partial<RuntimeQuotaHold>;
				if (typeof rec.provider !== "string" || typeof rec.reason !== "string") continue;
				if (typeof rec.hitAt !== "number" || !Number.isFinite(rec.hitAt)) continue;
				if (rec.resetAt !== undefined && (typeof rec.resetAt !== "number" || !Number.isFinite(rec.resetAt))) continue;
				const origins = Array.isArray(rec.origins)
					? rec.origins.filter((o): o is string => typeof o === "string" && o !== "")
					: [];
				const key = rec.provider.trim().toLowerCase() || "*";
				this.#holds.set(key, {
					provider: key,
					reason: rec.reason,
					hitAt: rec.hitAt,
					...(rec.resetAt === undefined ? {} : { resetAt: rec.resetAt }),
					origins: new Set(origins),
				});
			}
		} catch {
			this.#holds.clear();
		}
	}
}
