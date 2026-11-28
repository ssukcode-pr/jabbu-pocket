import type { OmpSessionDriver, OmpTurnUsage } from "../omp/driver";
import {
	EntryNotFoundError,
	ledgerDay,
	type SubAgentCostCache,
	sessionWindowCost,
	subAgentWindowCost,
	type WindowCost,
} from "../ops/cost-cap";
import { chargedCursorKey, parseChargedCursor } from "./mailbox-helpers";
import type { ActiveTurn, MailboxDeps } from "./mailbox-types";

/** In-window sub-agent spend from a known session file, without asking the driver; 0 when the file is unknown. */
async function subAgentSpend(input: {
	file: string | undefined;
	from: number;
	to: number;
	cache?: SubAgentCostCache;
	onReadError: (file: string, error: unknown) => void;
}): Promise<{ cost: number; calls: number }> {
	if (input.file === undefined) return { cost: 0, calls: 0 };
	try {
		return await subAgentWindowCost({
			sessionFile: input.file,
			from: input.from,
			to: input.to,
			cache: input.cache,
			onReadError: input.onReadError,
		});
	} catch (error) {
		input.onReadError(input.file, error);
		return { cost: 0, calls: 0 };
	}
}

/**
 * Adds the finished turn's priced cost (its own session after the `charged:` cursor or start cursor plus in-window
 * sub-agent transcripts) to `usage_daily`. When the session file cannot be read the fallback is the turn's live
 * `costUsd` plus the sub-agent transcripts re-read from the cached session file when it is known (separate files,
 * windowed by timestamp, so they cannot double-count the uncharged main window); with no known file the sub-agent
 * part is dropped and the miss is logged as `usage_daily_failed`. A missing `sessionFile`
 * (no session yet) is not error: there is no transcript to read and nothing was spent. `wedged`: the child is being
 * stopped as unresponsive, so its state is not asked again (another RPC timeout); the live total is charged plus
 * the sub-agent transcripts from the cached file when known, and the cursor is still deleted.
 * `usage`: the final's own report from a driver without a session file (agy) — its calls are counted at cost 0 and
 * its tokens logged.
 */
export async function recordDailyCost(
	deps: MailboxDeps,
	driver: OmpSessionDriver,
	turn: ActiveTurn,
	wedged = false,
	usage?: OmpTurnUsage,
): Promise<void> {
	if (turn.costRecorded) return;
	turn.costRecorded = true;
	const { originKey, log } = deps;
	if (usage !== undefined) {
		addDailyUsage(deps, turn.opRef, 0, usage.calls);
		log.info("agy_usage", {
			origin: originKey,
			opRef: turn.opRef,
			calls: usage.calls,
			input: usage.input,
			cacheRead: usage.cacheRead,
			output: usage.output,
			contextTokens: usage.contextTokens,
			rotated: usage.rotated,
		});
		return;
	}
	if (wedged) {
		// The child is being stopped, so its state is not asked again — but the sub-agent transcripts are local
		// files: charge their in-window spend too, or the wedged turn drops it for good (no later turn re-charges
		// a closed window). The live own total stays as pinned (mailbox.test.ts AC-4).
		const sub = await subAgentSpend({
			file: turn.subAgentSessionFile,
			from: turn.startedAt,
			to: deps.clock.now(),
			cache: turn.subAgentCache,
			onReadError: (path, error) =>
				log.warn("usage_daily_failed", { origin: originKey, opRef: turn.opRef, file: path, error: String(error) }),
		});
		log.info("usage_daily_live", { origin: originKey, opRef: turn.opRef, reason: "child_stopped" });
		addDailyUsage(deps, turn.opRef, turn.costUsd + sub.cost, 1 + sub.calls, {
			key: chargedCursorKey(originKey),
			value: null,
		});
		return;
	}
	await chargeSessionWindow(deps, {
		driver,
		opRef: turn.opRef,
		fallbackAfterEntryId: turn.entryCursor,
		from: turn.startedAt,
		fallbackCost: turn.costUsd,
		sessionFile: turn.subAgentSessionFile,
	});
}

/**
 * Writes one `usage_daily` increment and logs `usage_daily_failed` instead of throwing so a ledger failure never
 * blocks an answer or queued work. Returns whether the write succeeded. With `cursor` the increment and the
 * charged-cursor move land in one transaction (`null` deletes it): a cursor write failing after the increment
 * landed would leave a stale cursor behind it, so the next charge counts the same window twice.
 */
export function addDailyUsage(
	deps: MailboxDeps,
	opRef: string,
	cost: number,
	calls: number,
	cursor?: { key: string; value: string | null },
): boolean {
	const { store, originKey, log, clock } = deps;
	try {
		const input = { day: ledgerDay(clock.now(), deps.timezone), originKey, cost, calls };
		if (cursor === undefined) store.addDailyUsage(input);
		else store.chargeDailyUsage(input, cursor.key, cursor.value);
		return true;
	} catch (error) {
		log.warn("usage_daily_failed", { origin: originKey, opRef, cost, calls, error: String(error) });
		return false;
	}
}

/**
 * Reads the session file from the saved `charged:<originKey>` cursor (when its file matches and its entry id is
 * still in the file) or `fallbackAfterEntryId` (`turn.entryCursor` or pre-compact `leafId`) and adds the cost to
 * `usage_daily`. Advances the cursor only when both reading and `addDailyUsage` succeed and `lastEntryId` exists;
 * clears the cursor on window-read or `driver.state()` failure (after a successful fallback charge when provided) so
 * the next charge starts from `fallbackAfterEntryId` instead of recounting from a stale marker.
 */
export async function chargeSessionWindow(
	deps: MailboxDeps,
	input: {
		driver: OmpSessionDriver;
		opRef: string;
		fallbackAfterEntryId: string | null;
		from: number;
		fallbackCost?: number;
		/** The turn's cached session file, for the sub-agent read when `driver.state()` fails. */
		sessionFile?: string;
	},
): Promise<void> {
	const { store, originKey, log, clock } = deps;
	const key = chargedCursorKey(originKey);
	const chargeFallback = async (): Promise<void> => {
		// The main window is uncharged, so the sub-agent transcripts (separate files, windowed by timestamp)
		// cannot double-count it: charge their in-window spend too when the file is known.
		const sub = await subAgentSpend({
			file: file ?? input.sessionFile,
			from: input.from,
			to: clock.now(),
			onReadError: (path, error) =>
				log.warn("usage_daily_failed", { origin: originKey, opRef: input.opRef, file: path, error: String(error) }),
		});
		const cost = (input.fallbackCost ?? 0) + sub.cost;
		try {
			if (input.fallbackCost === undefined && sub.cost === 0) store.deleteCursor(key);
			else addDailyUsage(deps, input.opRef, cost, 1 + sub.calls, { key, value: null });
		} catch (error) {
			// Nothing was charged, so a stale cursor only re-reads the window next time; never abort the settlement.
			log.warn("usage_daily_failed", { origin: originKey, opRef: input.opRef, error: String(error) });
		}
	};
	let file: string | undefined;
	try {
		file = (await input.driver.state()).sessionFile;
	} catch (error) {
		log.warn("usage_daily_failed", { origin: originKey, opRef: input.opRef, error: String(error) });
		await chargeFallback();
		return;
	}
	if (file === undefined || file === "") return;
	const to = clock.now();
	const saved = parseChargedCursor(store.getCursor(key));
	const preferred = saved !== undefined && saved.sessionFile === file ? saved.entryId : undefined;
	const readWindow = (afterEntryId: string | null): Promise<WindowCost> =>
		sessionWindowCost({ sessionFile: file, afterEntryId, from: input.from, to });
	let window: WindowCost;
	try {
		window =
			preferred === undefined
				? await readWindow(input.fallbackAfterEntryId)
				: await readWindow(preferred).catch((error: unknown) =>
						error instanceof EntryNotFoundError && preferred !== input.fallbackAfterEntryId
							? readWindow(input.fallbackAfterEntryId)
							: Promise.reject(error),
					);
	} catch (error) {
		log.warn("usage_daily_failed", { origin: originKey, opRef: input.opRef, file, error: String(error) });
		await chargeFallback();
		return;
	}
	const cursor = window.lastEntryId === undefined ? undefined : { key, value: `${file}\t${window.lastEntryId}` };
	addDailyUsage(deps, input.opRef, window.cost, window.calls, cursor);
}
