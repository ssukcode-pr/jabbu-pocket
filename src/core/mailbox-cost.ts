import { subAgentWindowCost, TURN_STOP_RATIO, turnCapStopReason, turnCapWarnText } from "../ops/cost-cap";

/** Injected so tests use `FakeOmpDriver`; production builds an `RpcOmpDriver` for (origin, sessionDir). */
import type { ActiveTurn, MailboxHost } from "./mailbox-types";

// The ledger half (a finished turn's `usage_daily` charge) lives in `./mailbox-ledger`; these re-exports keep
// the existing importers (`mailbox.ts`, `mailbox-commands.ts`) stable.
export { chargeSessionWindow, recordDailyCost } from "./mailbox-ledger";

/**
 * Applies `costCap.turnUsd` to the turn's total (its own assistant calls plus the in-window sub-agent
 * transcripts): on reaching the ceiling the thread gets one warning (the turn goes on), on reaching 3x it is
 * aborted and settled as `cost_cap`. Nothing runs without a ceiling or for a settled turn.
 */
export function judgeTurnCost(host: MailboxHost, turn: ActiveTurn): void {
	if (host.turn() !== turn) return;
	const cap = host.deps.costCap?.()?.turnUsd;
	if (cap === undefined) return;
	const spent = turn.costUsd + turn.subAgentUsd;
	if (spent <= 0 || turn.costStopReason !== undefined) return;
	if (spent >= cap * TURN_STOP_RATIO) {
		// The reason is kept on the turn: the final this abort causes settles with it (`#onFinal`).
		turn.costStopReason = turnCapStopReason(cap, spent);
		host.background("cost_cap_stop_failed", () => abortCostCap(host, turn, cap));
		return;
	}
	if (turn.costSoftSent || spent < cap) return;
	turn.costSoftSent = true;
	const { log, originKey } = host.deps;
	log.info("cost_cap_turn_soft", { origin: originKey, opRef: turn.opRef, cost: spent, cap });
	host.deps.onTurnCostCap?.({ originKey, threadRef: turn.threadRef, text: turnCapWarnText(cap, spent) });
}

/**
 * Re-reads the turn's sub-agent transcripts and judges again. Off the actor's chain because it reads files; a
 * read failure is logged as `turn_subagent_cost_failed` and the turn keeps the sub-agent total it had.
 */
export function refreshSubAgentCost(host: MailboxHost, turn: ActiveTurn): void {
	if (host.deps.costCap?.()?.turnUsd === undefined) return;
	host.background("turn_subagent_cost_failed", async () => {
		if (host.turn() !== turn) return;
		const { originKey, log, clock } = host.deps;
		let file = turn.subAgentSessionFile;
		if (file === undefined) {
			const driver = host.driver();
			if (driver === undefined) return;
			try {
				file = (await driver.state()).sessionFile;
			} catch (error) {
				log.warn("turn_subagent_cost_failed", { origin: originKey, opRef: turn.opRef, error: String(error) });
				return;
			}
			if (file === undefined || file === "") return;
			turn.subAgentSessionFile = file;
		}
		const window = await subAgentWindowCost({
			sessionFile: file,
			from: turn.startedAt,
			to: clock.now(),
			cache: turn.subAgentCache,
			onReadError: (path, error) =>
				log.warn("turn_subagent_cost_failed", {
					origin: originKey,
					opRef: turn.opRef,
					file: path,
					error: String(error),
				}),
		});
		if (host.turn() !== turn) return;
		turn.subAgentUsd = window.cost;
		judgeTurnCost(host, turn);
	});
}

/**
 * Aborts a turn that passed 3x its ceiling and settles it through the normal final path with the `cost_cap`
 * reason (a failure notice to the thread, but no failure count: `#onFinal` skips `#noteTurnFailure`). A final that
 * settled the turn first wins; this then does nothing. An abort that failed stops the child before the drain.
 */
export async function abortCostCap(host: MailboxHost, turn: ActiveTurn, cap: number): Promise<void> {
	const driver = host.driver();
	if (!driver || host.turn() !== turn) return;
	const { originKey, log } = host.deps;
	const spent = turn.costUsd + turn.subAgentUsd;
	const reason = turn.costStopReason ?? turnCapStopReason(cap, spent);
	log.warn("cost_cap_turn_stop", { origin: originKey, opRef: turn.opRef, cost: spent, cap });
	let stopFirst = false;
	try {
		await driver.abort();
	} catch (error) {
		stopFirst = true;
		log.warn("cost_cap_abort_failed", { origin: originKey, opRef: turn.opRef, error: String(error) });
	}
	if (host.turn() !== turn || host.driver() !== driver) return;
	await host.onFinal(driver, { opRef: turn.opRef, status: "aborted", text: "", error: reason }, stopFirst);
}
