// Platform-neutral contract between an adapter and the core (inbound, verdicts, delivery ledger).
import type { CommandKind } from "../core/types";
import type { PeerInboundOutcome } from "./peer-outcome";

/** What the core receives for an accepted owner message. Structurally what the store's recordInbound needs, plus the thread. */
export interface InboundMessage {
	platformMessageId: string;
	originKey: string;
	text: string;
	threadRef: string;
	ownerVerified: true;
	/** Put in by `jabbu-pocket inject` (`OwnerIngest.injected`): the ledger keeps it, and such a row never answers an ask card. */
	injected?: boolean | undefined;
}

/**
 * What the core receives for an accepted peer bot message. Its own type, without `ownerVerified`: it can never be
 * passed where an owner message is expected.
 */
export interface PeerInboundMessage {
	platformMessageId: string;
	originKey: string;
	/** Header and fenced body (see `normalizePeerInbound`). */
	text: string;
	threadRef: string;
	peer: { userId: string; name: string };
}

type InboundResult = { duplicate?: boolean } | undefined;
/** The adapter's whole view of the core. Owner input arrives through `onInbound`, peer bot input through `onPeerInbound`. */
export interface CoreSink {
	/**
	 * A peer bot's request. The core decides what the adapter cannot see: a duplicate, a work lane's thread
	 * (`peer_in_lane_thread`) and the thread's hop cap (`peer_hop_cap`; `notice` is true exactly once per cap episode,
	 * the adapter then posts the cap notice).
	 */
	onPeerInbound?(message: PeerInboundMessage, hop: { turns: number; windowMs: number }): PeerInboundOutcome;
	/**
	 * A peer bot posted in `threadRef` at `at` (the post's own time), whether or not the bot takes the post (no mention,
	 * muted thread, hop cap): it answers this bot's earlier calls to that peer there (peer silence alert).
	 */
	onPeerSeen?(seen: { threadRef: string; peerUserId: string; at: number }): void;
	/** `duplicate: true` (redelivery of a message already recorded) suppresses the 👀 and the status message. */
	onInbound(message: InboundMessage): Promise<InboundResult> | InboundResult;
	/** Ephemeral reply text; `undefined` sends an empty ack because the answer is posted as its own message. */
	onCommand(command: {
		command: CommandKind;
		/** Text after the slash command (`""` when none). */
		arg: string;
		originKey: string;
		channel: string;
		userId: string;
	}): Promise<string | undefined> | string | undefined;
	onAction(action: {
		actionId: string;
		value?: string | undefined;
		values?: readonly string[] | undefined;
		userId: string;
		channel?: string | undefined;
		messageTs?: string | undefined;
		interactionId?: string | undefined;
		replyEphemeral?: ((text: string) => Promise<void>) | undefined;
	}): Promise<void> | void;
	/** Owner thread reply to an approval card: settled, duplicate, routed to asking origin, or injected_rejected. */
	onCardReply?(reply: {
		threadRef: string;
		platformMessageId: string;
		text: string;
		injected?: boolean | undefined;
	}):
		| { kind: "settled" }
		| { kind: "duplicate" }
		| { kind: "route"; originKey: string }
		| { kind: "injected_rejected" }
		| undefined;
	/** Whether the bot already takes part in this thread, so an unaddressed owner reply in a channel thread counts. */
	knowsThread?(threadRef: string): boolean;
	/** Whether this platform message id (`<conversation>:<message id>`) was recorded as inbound: an edit needs its original. */
	hasInbound?(platformMessageId: string): boolean;
	/** The text the inbound row of this platform message id was recorded with (`undefined`: no such row). */
	inboundText?(platformMessageId: string): string | undefined;
	/** The origin the inbound row was recorded under (a lane thread's: the lane's): its status is that origin's turn. */
	inboundOrigin?(platformMessageId: string): string | undefined;
	/** True while a restart drain holds dispatch: a message taken now waits for the next process (no typing shown). */
	isDraining?(): boolean;
}

export interface DeliveryItem {
	deliveryId: number;
	originKey: string;
	threadRef: string;
	body: string;
	redelivered: boolean;
	/** Other threads whose rows were closed by the same op (steered messages): their status is finished too. */
	finishThreadRefs?: readonly string[] | undefined;
	/** Threads of rows the same op discarded (`queue drop`): their ⏳ ends as `🚫 취소됨` instead of ✅/⚠️. */
	cancelThreadRefs?: readonly string[] | undefined;
	/**
	 * False for output nobody asked for in that thread (a work lane's own report): a thread without a running status
	 * entry is then left alone instead of getting the post-restart ✅ reaction. Default true.
	 */
	finishUntracked?: boolean | undefined;
	/**
	 * A text sent while its turn still runs (interim delivery): the thread's status message and progress keep going,
	 * and the answer gets no elapsed-time footer. Default false.
	 */
	keepStatus?: boolean | undefined;
	/** Messages of this answer a rate-limited earlier send already posted: the send resumes after them. */
	sentParts?: number | undefined;
	/** Top-level answer resumed after part 1: the ts parts 2+ reply under. */
	replyTs?: string | null | undefined;
}

/** Where a rate-limited send stopped and when the platform takes posts again. */
export interface DeliveryRetry {
	at: number;
	sentParts: number;
	replyTs?: string | undefined;
}

/** Implemented by the daemon on top of the store; the adapter never imports the mailbox or the store. */
export interface DeliverySource {
	claimDue(): Promise<DeliveryItem[]> | DeliveryItem[];
	confirm(deliveryId: number): Promise<void> | void;
	/**
	 * `definitive`: nothing was posted (backoff and retry). `ambiguous`: a message may exist (sticky, never auto-resent).
	 * True when a definitive failure spent the retries (the row expired): the answer will not be sent. `sentParts` is how
	 * many messages of the answer were already out when it failed: a held row keeps it, so an owner `resend` skips them,
	 * and `replyTs` (a top-level answer's first part) so the resent rest replies under it.
	 */
	fail(
		deliveryId: number,
		error: string,
		outcome: "definitive" | "ambiguous",
		sentParts: number,
		replyTs?: string,
	): Promise<boolean | undefined> | boolean | undefined;
	/** This platform's rows the ledger expired since the last call (past the window while pending), handed over once.
	 * Absent: expiry finishes nothing. */
	takeExpired?(): Promise<DeliveryItem[]> | DeliveryItem[];
	hasHeld?(threadRef: string, beforeDeliveryId: number): boolean | Promise<boolean>;
	repostIsIdempotent?: boolean; // a recovered repost cannot duplicate here (web keys its messages), so no hold is needed
	/** Rate limited (429 or still blocked): nothing more was posted; retry at `retry.at` without counting a failure. */
	defer(deliveryId: number, error: string, retry: DeliveryRetry): Promise<void> | void;
}

export interface AdapterClock {
	now(): number;
}

/** What a single inbound event ended up as (`ingestRecovered`/`ingestOwner` report this). */
export type IngestOutcome =
	| "recorded"
	| "duplicate"
	| "dropped"
	/** An injected owner message in an approval/choice card's thread: refused, the card untouched. */
	| "card_rejected";
