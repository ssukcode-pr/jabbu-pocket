// Parking an inbound row whose delivery outcome is unknown (`uncertain`, never replayed, so no input runs twice)
// and the dispatch-ledger write that shares it. The mailbox delegates with its own deps (`ParkDeps` is a slice of them).
import type { Logger } from "../log";
import type { Store } from "../store/db";
import type { InboundRow } from "../store/db-rows";
import type { UncertainReason } from "../store/transitions";

/** The slice of the mailbox's deps the park helpers read (`store`, `log`, `originKey`). */
export interface ParkDeps {
	store: Pick<Store, "markDispatched" | "markUncertain">;
	log: Logger;
	originKey: string;
}

/**
 * The steer went out but its outcome is unknown (it threw, the turn ended around it, or the ledger write failed):
 * the row is parked as `uncertain` instead of replayed, so no input runs twice. Returns true — this row is done,
 * later rows still go out; the owner closes or retries it with `/queue`.
 */
export function parkUncertain(deps: ParkDeps, row: InboundRow, reason: UncertainReason, error?: unknown): boolean {
	deps.store.markUncertain(row.platformMessageId, reason);
	deps.log.warn("inbound_uncertain", {
		origin: deps.originKey,
		id: row.platformMessageId,
		reason,
		...(error === undefined ? {} : { error: String(error) }),
	});
	return true;
}

/** Records a delivered row as dispatched; a failed ledger write parks it as `uncertain` (never re-sent): false. */
export function markOrPark(
	deps: ParkDeps,
	row: InboundRow,
	input: { opRef: string; entryCursor: string | null },
): boolean {
	try {
		deps.store.markDispatched(row.platformMessageId, input);
		return true;
	} catch (error) {
		return !parkUncertain(deps, row, "dispatch_record_failed", error);
	}
}
