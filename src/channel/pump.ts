// The delivery loop every adapter shares: claim → send → confirm/fail/defer → finish the thread's status once sent,
// or once the ledger gave up on it (ambiguous, retries spent, expired). The platform part (how one delivery is posted,
// whether its post path is rate limited) is the `DeliverySender`; `finishDeliveryStatus` is the status finish they share.
import type { Logger } from "../log";
import { failureNoticeBody } from "./failure-notice";
import type { RetryAfterGate } from "./retry";
import { errorFields, errorText, type FinalOutcome } from "./text";
import type { AdapterClock, DeliveryItem, DeliveryRetry, DeliverySource } from "./types";

export type DeliverySendResult =
	| { kind: "sent"; parts: number; path?: string }
	| { kind: "deferred"; error: unknown; retry: DeliveryRetry }
	/** `sentParts`: messages already posted before the failure; `replyTs`: a top-level answer's part 1, kept for a resend. */
	| { kind: "failed"; error: string; outcome: "definitive" | "ambiguous"; sentParts: number; replyTs?: string };

/**
 * The failed-send block every adapter's send returns on a post error: the outcome is `definitive` only when nothing
 * of the answer is out yet (`sent === 0`) and the platform's own error test (`isDefinitive`: its CallError class with
 * `kind === "definitive"`, default none) calls the refusal definitive — anything else may have left a partial answer, so it is
 * never resent blindly.
 */
export function failedDelivery(
	err: unknown,
	sent: number,
	isDefinitive: (err: unknown) => boolean = () => false,
	replyTs?: string,
): Extract<DeliverySendResult, { kind: "failed" }> {
	return {
		kind: "failed",
		error: errorText(err),
		outcome: sent === 0 && isDefinitive(err) ? "definitive" : "ambiguous",
		sentParts: sent,
		...(replyTs === undefined ? {} : { replyTs }),
	};
}

export interface DeliverySender {
	/** Whether this platform's post path is rate limited right now; `delivery` narrows it to that delivery's destination. */
	isBlocked(delivery?: DeliveryItem): boolean;
	/** When the current block ends (the retry time of a delivery deferred by it). */
	blockedUntil(delivery?: DeliveryItem): number;
	/** The error text a delivery deferred by the block carries. */
	blockedReason(): string;
	send(delivery: DeliveryItem): Promise<DeliverySendResult>;
	/** After the confirm: the thread's status message and reactions are finished. */
	afterSent(delivery: DeliveryItem): Promise<void>;
	/** The answer will not be sent (ambiguous, retries spent, expired): the status ends as undelivered. Never for a defer. */
	afterUndelivered(delivery: DeliveryItem): Promise<void>;
}

/** An adapter's status finish (`finishStatus`), and whether it tracks a running status of an origin in a thread. */
export interface StatusFinisher {
	finishStatus(threadRef: string, originKey: string, outcome: FinalOutcome, action: "delete" | "update"): Promise<void>;
	/** Absent: every thread of the delivery is finished, tracked or not. */
	tracks?(threadRef: string, originKey: string): boolean;
	/** Whether an earlier delivery for this thread is held (`failed_ambiguous`). Absent: the finish never downgrades. */
	hasHeld?(threadRef: string, beforeDeliveryId: number): boolean | Promise<boolean>;
}

/**
 * The status finish every adapter's `afterSent`/`afterUndelivered` runs: the answer's thread and every thread its op
 * closed (steered messages sit in their own threads) end ✅/⚠️ (`sent`) or `⚠️ 답을 보내지 못했습니다` (`undelivered`);
 * threads of rows the op discarded end 🚫 취소됨. Only the thread holding a sent answer (and its footer) drops the status
 * message; the others keep the label. An interim delivery leaves the running status alone. Only the delivery's origin's.
 */
export async function finishDeliveryStatus(
	delivery: DeliveryItem,
	result: "sent" | "undelivered",
	finisher: StatusFinisher,
): Promise<void> {
	if (delivery.keepStatus) return;
	const outcome: FinalOutcome =
		result === "undelivered" ? "undelivered" : failureNoticeBody(delivery.body) ? "failed" : "done";
	const cancelled = new Set(delivery.cancelThreadRefs ?? []);
	// One thread's failed finish must not abandon the rest: the delivery is already settled in the ledger, so
	// no later pump retries this finish. The first error still surfaces to the caller's per-delivery catch.
	let firstError: unknown;
	for (const threadRef of new Set([delivery.threadRef, ...(delivery.finishThreadRefs ?? [])])) {
		if (delivery.finishUntracked === false && finisher.tracks?.(threadRef, delivery.originKey) === false) continue;
		// A sent answer must not stamp ✅ on a thread whose earlier delivery is still held: the turn is not whole.
		const held = outcome === "done" && (await finisher.hasHeld?.(threadRef, delivery.deliveryId)) === true;
		const final = cancelled.has(threadRef) ? "cancelled" : held ? "failed" : outcome;
		const action = threadRef === delivery.threadRef && (final === "done" || final === "failed") ? "delete" : "update";
		await finisher.finishStatus(threadRef, delivery.originKey, final, action).catch((error) => {
			firstError ??= error;
		});
	}
	if (firstError !== undefined) throw firstError;
}

/**
 * The sender half every adapter shares around its own `send`: the post route's block (one `RetryAfterGate` key) and
 * the status finish after a confirm or once the answer is given up.
 */
export function deliverySender(options: {
	gate: RetryAfterGate;
	/**
	 * The gate key the post path is parked under: one fixed key, or one per delivery (`chat.postMessage`, `post:<channelId>`).
	 * A per-delivery key gets `undefined` for the pump's pre-batch check and must answer a key that is never parked.
	 */
	key: string | ((delivery: DeliveryItem | undefined) => string);
	/** The error text a delivery deferred by the block carries (the platform's own wording). */
	blockedReason: string;
	send(delivery: DeliveryItem): Promise<DeliverySendResult>;
	/** `sent`: the answer is out; `undelivered`: the ledger gave up on it. */
	finish(delivery: DeliveryItem, result: "sent" | "undelivered"): Promise<void>;
}): DeliverySender {
	const { gate, key, send, finish } = options;
	return {
		isBlocked: (delivery) => gate.isBlocked(typeof key === "function" ? key(delivery) : key),
		blockedUntil: (delivery) => gate.untilOf(typeof key === "function" ? key(delivery) : key) ?? gate.clock.now(),
		blockedReason: () => options.blockedReason,
		send,
		afterSent: (delivery) => finish(delivery, "sent"),
		afterUndelivered: (delivery) => finish(delivery, "undelivered"),
	};
}

/**
 * The footer an answer carries in place of its thread's `⏳` status message: none for an interim delivery (the status
 * keeps running) or a thread the same op cancelled, otherwise the platform's own `footerOf` for the answer's thread.
 */
export function answerFooter(
	delivery: DeliveryItem,
	footerOf: (threadRef: string, originKey: string, outcome: "done" | "failed") => string | undefined,
): string | undefined {
	if (delivery.keepStatus === true || (delivery.cancelThreadRefs ?? []).includes(delivery.threadRef)) return undefined;
	return footerOf(delivery.threadRef, delivery.originKey, failureNoticeBody(delivery.body) ? "failed" : "done");
}

export interface DeliveryPumpOptions {
	source: DeliverySource;
	sender: DeliverySender;
	clock: AdapterClock;
	log: Logger;
}

export class DeliveryPump {
	readonly #options: DeliveryPumpOptions;

	constructor(options: DeliveryPumpOptions) {
		this.#options = options;
	}

	/**
	 * Claims due deliveries and sends them. Does nothing while the post path is blocked; a block that starts mid-batch
	 * (a 429) sends the rest of the batch back unsent to wait for it. Returns how many were confirmed.
	 */
	async pump(): Promise<number> {
		const { source, sender, log } = this.#options;
		// Finishing a status does not post an answer, so expired rows are finished even while posting is blocked.
		await this.#finishExpired();
		if (sender.isBlocked()) return 0;
		let confirmed = 0;
		for (const delivery of await source.claimDue()) {
			if (sender.isBlocked(delivery)) {
				const retry = { at: sender.blockedUntil(delivery), sentParts: delivery.sentParts ?? 0 };
				await this.#defer(delivery, sender.blockedReason(), retry);
				continue;
			}
			// The claim holds it in flight; a send that throws may have posted some parts, so it is ambiguous (never resent blindly).
			const result = await sender.send(delivery).catch((err: unknown) => failedDelivery(err, delivery.sentParts ?? 0));
			if (result.kind === "deferred") await this.#defer(delivery, errorText(result.error), result.retry);
			if (result.kind === "failed") await this.#fail(delivery, result);
			if (result.kind !== "sent") continue;
			const confirmError = await this.#ledger(delivery, "confirm", () => source.confirm(delivery.deliveryId));
			if (confirmError !== null && source.repostIsIdempotent !== true) {
				await this.#fail(delivery, failedDelivery(confirmError, result.parts));
				continue;
			}
			if (confirmError === null) {
				log.info("delivery_sent", {
					id: delivery.deliveryId,
					parts: result.parts,
					...(result.path === undefined ? {} : { path: result.path }),
					redelivered: delivery.redelivered,
				});
				confirmed += 1;
			}
			try {
				await sender.afterSent(delivery);
			} catch (err) {
				// The answer is out and confirmed with its parts; only the status finish failed.
				log.warn("delivery_after_sent_failed", { id: delivery.deliveryId, parts: result.parts, error: errorText(err) });
			}
		}
		return confirmed;
	}

	/**
	 * A failed send: an ambiguous one, or a definitive one whose ledger write says its retries are spent, ends the
	 * thread's status as undelivered. A definitive failure with retries left waits for them.
	 */
	async #fail(delivery: DeliveryItem, failed: Extract<DeliverySendResult, { kind: "failed" }>): Promise<void> {
		const { error, outcome, sentParts, replyTs } = failed;
		const { source, log } = this.#options;
		log.warn("delivery_failed", { id: delivery.deliveryId, sent_parts: sentParts, outcome, error });
		let gaveUp = outcome === "ambiguous";
		const written = await this.#ledger(delivery, "fail", async () => {
			if ((await source.fail(delivery.deliveryId, error, outcome, sentParts, replyTs)) === true) gaveUp = true;
		});
		if (written === null && gaveUp) await this.#undelivered(delivery);
	}

	/** Rows the ledger expired since the last pump: their threads' statuses end as undelivered. */
	async #finishExpired(): Promise<void> {
		const { source, log } = this.#options;
		if (source.takeExpired === undefined) return;
		const expired = await Promise.resolve(source.takeExpired()).catch((err) => {
			log.error("delivery_take_expired_failed", { ...errorFields(err) });
			return [];
		});
		for (const delivery of expired) {
			log.warn("delivery_expired", { id: delivery.deliveryId });
			await this.#undelivered(delivery);
		}
	}

	/** The answer is not going out: a status finish that throws is one warn line, never a stop of the batch. */
	async #undelivered(delivery: DeliveryItem): Promise<void> {
		try {
			await this.#options.sender.afterUndelivered(delivery);
		} catch (err) {
			this.#options.log.warn("delivery_undelivered_finish_failed", { id: delivery.deliveryId, error: errorText(err) });
		}
	}

	/** Back to pending until the block ends; `retry.sentParts` messages of it are already posted. */
	async #defer(delivery: DeliveryItem, error: string, retry: DeliveryRetry): Promise<void> {
		const { source, clock, log } = this.#options;
		log.warn("delivery_deferred", {
			id: delivery.deliveryId,
			sent_parts: retry.sentParts,
			error,
			retry_in_ms: Math.max(0, retry.at - clock.now()),
		});
		await this.#ledger(delivery, "defer", () => source.defer(delivery.deliveryId, error, retry));
	}

	/** One ledger write (confirm/fail/defer): a throw (SQLITE_FULL/BUSY) is logged and the batch goes on; the row
	 * stays in flight as claimed, which the next start recovers. Null when it wrote, the error when it threw. */
	async #ledger(delivery: DeliveryItem, call: string, write: () => Promise<unknown> | unknown): Promise<unknown> {
		try {
			await write();
			return null;
		} catch (err) {
			this.#options.log.error("delivery_ledger_failed", { id: delivery.deliveryId, call, ...errorFields(err) });
			return err;
		}
	}
}
