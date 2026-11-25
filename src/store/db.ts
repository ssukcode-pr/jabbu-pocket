import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mentionToken } from "../channel/port";
import { cutCodePointSafe } from "../channel/text";
import { parseThreadRef, platformOfThreadRef, THREAD_LINK_PREFIX, TOP_LEVEL_TS, threadRefOf } from "../core/normalize";
import {
	type ChatPlatform,
	chatOriginKey,
	chatPlatformOf,
	parseChatOrigin,
	platformOfConversationId,
} from "../core/origin-key";
import { COMMAND_OP_REF, PEER_FAILURE_MARK, parseCommand, parsePurposeCommand } from "../core/types";
import { previewLine } from "../dashboard/preview-line";
import type { LaneReservation, ReservationState } from "../lanes/reservations";
import {
	assertLaneTransition,
	isTaskOrigin,
	LANE_ORIGIN_PREFIX,
	type LaneHistoryEntry,
	type LaneMeta,
	type LaneRow,
	type LaneStatus,
} from "../lanes/status";
import { countIncident, resolveIncidents } from "../monitors/incidents";
import {
	type CheckErrorAlert,
	MONITOR_ORIGIN_PREFIX,
	MonitorLedger,
	type MonitorRow,
	monitorOrigin,
	withoutMarkerLines,
} from "../monitors/ledger";
import type { ApprovalDetail, ApprovalInput, AutoChoiceInput, ExpiredApproval } from "../safety/approval";
import { TaskLedger } from "../tasks/ledger";
import { type CardAnswerVerdict, insertCardAnswer, judgeCardAnswer } from "./card-answers";
import {
	type ApprovalRow,
	type ApprovalSql,
	type DeliveryRow,
	type DeliverySql,
	type HerdrPromptInput,
	type InboundRow,
	type InboundSql,
	type LaneBoardCursor,
	type LaneBoardPost,
	type LaneBoardPostSql,
	type LaneReservationSql,
	type LaneSql,
	type OriginRow,
	type OriginSettings,
	type OriginSql,
	type RecallCandidate,
	type TurnSnapshotInput,
	type TurnSnapshotRow,
	type TurnSnapshotSql,
	toDelivery,
	toInbound,
	toLane,
	toLaneBoardPost,
	toLaneReservation,
	toOrigin,
	toTurnSnapshot,
	toWikiTurn,
	type WikiTurnInput,
	type WikiTurnRow,
	type WikiTurnSql,
} from "./db-rows";
import {
	APPROVALS_DDL,
	INBOUND_THREAD_INDEX_DDL,
	LANE_BOARD_TEXT_MAX,
	LANES_DDL,
	PEER_CALL_KEEP_MS,
	SCHEMA,
} from "./db-schema";
import { migrateInbound } from "./db-sending";
import { laneDurationSamples, TURN_SAMPLE_LIMIT, TURN_SAMPLE_WINDOW_MS } from "./lane-duration";
import { migrateOldNames } from "./rename-migration";
import { checkSchemaVersion, stampSchemaVersion } from "./schema-version";
import {
	assertInboundTransition,
	type DeliveryEvent,
	type DeliveryFacts,
	type DeliveryState,
	FRESHNESS_MS,
	type InboundState,
	StoreError,
	transitionDelivery,
	type UncertainReason,
} from "./transitions";

/** Words a placeholder answer uses when omp returned no text (mailbox writes it); a monitor treats it as a failure. */
const EMPTY_ANSWER = "(응답 없음)";

/** Op ref suffix of the copy delivery of a completion report / monitor event (same origin, distinct unique key). */
export const LOG_COPY_SUFFIX = ":log-copy";
const MONITOR_COPY_SUFFIX = ":copy";
/** Op ref infix of the pointer a steered message's own thread gets (`<opRef>:steer:<n>`). */
const STEER_NOTICE_SUFFIX = ":steer:";
const STEER_NOTICE_HEAD = "↪ 이 요청은 진행 중이던 작업에 합쳐져서 답을 다른 스레드에 올렸어";
/** Op ref infix of a text a running turn sent before its end (`<opRef>:interim:<n>`); it never finishes the status. */
export const INTERIM_INFIX = ":interim:";
/** Head of a failed-turn notice delivery (`failedNotice` in the mailbox); never recall material. */
const TURN_FAILED_HEAD = "[turn failed]";
/** How far back recall candidates reach. */
const RECALL_WINDOW_MS = 90 * 24 * 60 * 60_000;
/** Expired rows kept for `takeExpired` at most (a platform without an adapter never takes its rows). */
const EXPIRED_HANDOFF_MAX = 200;
/** Origin-key prefixes of every chat platform (`chatPlatformOf`): the turns typical durations are read from. */
const CHAT_ORIGIN_PREFIXES = Object.keys({
	discord: true,
} satisfies Record<ChatPlatform, true>).map((platform) => `${platform}/%`);
/** First line of a chat answer that closes a task: only these are copied to the log channel. */
const COMPLETION_MARKER = /^(?:✅|:white_check_mark:) 완료/;

/** The same alert scope+sign stays quiet for this long after an owner notice (monitor incident cadence). */
export const ALERT_INCIDENT_REPEAT_MS = 24 * 60 * 60_000;

/** Outcome of counting one alert occurrence: whether to notify the owner now, and how the condition has stood. */
interface AlertIncident {
	notify: boolean;
	/** Occurrences counted in this alert period (first alert included). */
	count: number;
	/** When this alert period started; `now - firstAt` is how long the condition has stood. */
	firstAt: number;
	/**
	 * True when this same condition had already alerted the owner and never resolved — the row's standing state
	 * before this occurrence. A daemon restart reads it to keep "an alerted open must report its recovery" true
	 * across processes (the in-memory gate bookkeeping starts empty).
	 */
	standing: boolean;
}

export type { DeliveryState, InboundState, UncertainReason } from "./transitions";
export { StoreError } from "./transitions";

/** Inbound rows per state; a `sending` row (mid-send) counts as `dispatched`, the running turn it starts or joins. */
export const INBOUND_COUNT_SQL =
	"SELECT CASE state WHEN 'sending' THEN 'dispatched' ELSE state END AS state, COUNT(*) AS n FROM inbound GROUP BY 1";

interface StoreClock {
	now(): number;
}

/** The #log channel of each platform that has one (Discord: `channels.discord.logChannelId`). */
export interface LogChannels {
	discord?: string | undefined;
}

/** Op ref prefix of a peer silence alert (`peer-silence:<first call_id>`); it never finishes a thread's status. */
export const PEER_SILENCE_OP_PREFIX = "peer-silence:";
/** Op ref prefix of the one owner notice a held delivery gets (`ambiguous-notice:<delivery_id>`); like a peer alert it never finishes a thread's status. */
export const AMBIGUOUS_NOTICE_OP_PREFIX = "ambiguous-notice:";

/**
 * When a confirmed delivery is a call a peer bot must answer (`peer_calls`) and how its silence is reported
 *. Absent: the alert is off, no call is recorded.
 */
export interface PeerCallPolicy {
	/** Discord peer bots (`channels.discord.peerBots`): a thread post mentioning one is a call to it. */
	peers: ReadonlyArray<{ userId: string; name: string }>;
	/** Conversations whose posts are no calls (the Discord #log channel). */
	skipConversations: readonly string[];
	/** The Discord owner the alert mentions. */
	ownerUserId: string;
	/** Silence after the call before the alert; positive. */
	silenceMs: number;
}

export interface StoreOptions {
	path: string;
	clock: StoreClock;
	/** The bot's zone (`config.timezone`): task ids are dated in it. */
	timezone: string;
	/** Applied to every body / text / error string before it is stored. */
	redact: (text: string) => string;
	/**
	 * The #log ledger channel of each platform: a completion report is copied to the one of its own platform; a platform
	 * without one gets no copies.
	 */
	logChannel?: LogChannels | undefined;
	hooks?: {
		afterInboundAnswered?: () => void; // inside the answer transaction after inbound rows became `answered`, before delivery rows exist
		/** Observes every delivery state change (`from` is "new" for a freshly inserted row). Must not throw. */
		onDeliveryState?: (change: { deliveryId: number; from: DeliveryState | "new"; to: DeliveryState }) => void;
		onInboundConflict?: (info: InboundConflict) => void; // a message id came again with other content (the first row stays); must not throw
		onOwnerNoticeUnroutable?: (info: { originKey: string; opRef: string }) => void; // an owner notice had no destination and was not recorded; must not throw
	};
}

/** What a re-received message id shows of the two texts: a digest prefix and the length of each. */
export interface InboundConflict {
	platformMessageId: string;
	originKey: string;
	storedSha: string;
	newSha: string;
	storedLength: number;
	newLength: number;
}

/** Signature parameters of an attachment URL (Discord CDN `ex`·`is`·`hm`) change on every delivery of the same file. */
const SIGNED_URL_PARAM = /([?&](?:ex|is|hm)=)[^&\s"'<>)\]]*/g;

/** A message id's text without attachment URL signatures or quote fence ids (random per `normalizeInbound` wrap). */
function inboundIdentity(text: string): string {
	return text.replace(SIGNED_URL_PARAM, "$1").replace(/^(<<<(?:end-)?quoted-)[0-9a-f]+>>>$/gm, "$1>>>");
}

const sha12 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** Where owner notices go when nothing else names a conversation (`Store.ownerHome()`). */
interface OwnerHome {
	platform: ChatPlatform;
	conversationId: string;
}

/** Rows kept per origin: an old turn's `!undo` target stops being reachable long before `gc` runs. */
const TURN_SNAPSHOT_ROWS_KEPT = 20;

/** Rows kept per agent. */
const HERDR_PROMPT_ROWS_KEPT = 20;
/** Rows older than this are dropped on the next record. */
const HERDR_PROMPT_KEEP_MS = 30 * 24 * 60 * 60_000;
/** Longest stored preview. */
export const HERDR_PROMPT_PREVIEW_CHARS = 120;

/** The registry keeps the newest entries only; a lane that lives for weeks must not grow without bound. */
const MAX_LANE_HISTORY = 200;

export class Store {
	private readonly db: Database;
	private readonly clock: StoreClock;
	private readonly redact: (text: string) => string;
	private readonly hooks: NonNullable<StoreOptions["hooks"]>;
	/** Deliveries that were inflight when the previous process died; re-queued with redelivered=1 at open. */
	readonly recoveredInflight: number;
	/** Monitor definitions, slots and events; shares this connection so answers settle in the same transaction. */
	readonly monitors: MonitorLedger;
	/** [TASK] registry; shares this connection. */
	readonly tasks: TaskLedger;
	private logChannels: LogChannels = {};
	private alertChannels: LogChannels = {};
	/** Rows `sweepExpired` expired that no adapter took yet (`takeExpired`); memory only, like the statuses they end. */
	private expiredUnfinished: DeliveryRow[] = [];
	private peerCallPolicy: PeerCallPolicy | undefined;

	/**
	 * Start and config reload: confirmed deliveries from now on are recorded as peer calls under `policy`. `undefined`
	 * switches the alert off: nothing is recorded and the calls still pending are `skipped`, so switching it back on
	 * never reports an old silence.
	 */
	setPeerCallPolicy(policy: PeerCallPolicy | undefined): void {
		this.peerCallPolicy = policy;
		if (policy !== undefined) return;
		this.db
			.query("UPDATE peer_calls SET state = 'skipped', settled_at = ? WHERE state = 'pending'")
			.run(this.clock.now());
	}

	/** Config reload: answers recorded from now on copy to the new #log channels. */
	setLogChannel(channel: LogChannels | undefined): void {
		this.logChannels = { ...channel };
	}

	/** Start and config reload: monitor failure notices go to the Discord alert channel when set, else the owner home. */
	setAlertChannel(channel: LogChannels | undefined): void {
		this.alertChannels = { ...channel };
	}

	constructor(options: StoreOptions) {
		this.clock = options.clock;
		this.setLogChannel(options.logChannel);
		this.redact = options.redact;
		this.hooks = options.hooks ?? {};
		this.db = new Database(options.path, { create: true, strict: true });
		try {
			checkSchemaVersion(this.db);
		} catch (error) {
			this.db.close();
			throw error;
		}
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run("PRAGMA synchronous = NORMAL");
		this.db.run("PRAGMA foreign_keys = ON");
		this.db.run("PRAGMA busy_timeout = 5000");
		this.db.run(SCHEMA);
		try {
			this.migrate();
		} catch (error) {
			this.db.close();
			throw error;
		}
		this.monitors = new MonitorLedger(this.db, {
			clock: options.clock,
			redact: options.redact,
			onCheckErrorAlert: (alert) => this.postCheckErrorNotice(alert),
			canAlert: (monitorId) => this.ownerHome() !== undefined || this.noteUnroutableCheckError(monitorId),
		});
		this.tasks = new TaskLedger(this.db, { clock: options.clock, timezone: options.timezone });
		stampSchemaVersion(this.db);
		this.recoveredInflight = this.db
			.query("UPDATE deliveries SET state = 'pending', redelivered = 1, next_at = ? WHERE state = 'inflight'")
			.run(this.clock.now()).changes;
	}

	close(): void {
		this.db.close();
	}

	// ---- origins ----

	ensureOrigin(originKey: string, sessionDir: string): OriginRow {
		const now = this.clock.now();
		this.db
			.query(
				"INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT DO NOTHING",
			)
			.run(originKey, sessionDir, now);
		return this.requireOrigin(originKey);
	}

	getOrigin(originKey: string): OriginRow | undefined {
		const row = this.db.query("SELECT * FROM origins WHERE origin_key = ?").get(originKey) as OriginSql | null;
		return row ? toOrigin(row) : undefined;
	}

	/** Backfill watermark for a target (`ch:<channel>` / `thr:<channel>:<rootTs>`); undefined before the first pass. */
	getCursor(cursorKey: string): string | undefined {
		const row = this.db.query("SELECT last_ts FROM slack_cursors WHERE cursor_key = ?").get(cursorKey) as
			| { last_ts: string }
			| undefined;
		return row?.last_ts;
	}

	/** Advances a backfill watermark (INSERT OR REPLACE); callers only move it forward. */
	setCursor(cursorKey: string, lastTs: string): void {
		this.db
			.query(
				"INSERT INTO slack_cursors (cursor_key, last_ts, updated_at) VALUES (?, ?, ?) ON CONFLICT(cursor_key) DO UPDATE SET last_ts = excluded.last_ts, updated_at = excluded.updated_at",
			)
			.run(cursorKey, lastTs, this.clock.now());
	}

	deleteCursor(cursorKey: string): void {
		this.db.query("DELETE FROM slack_cursors WHERE cursor_key = ?").run(cursorKey);
	}

	/** Stored backfill cursor keys starting with `prefix` (compared literally, no LIKE wildcards), sorted. */
	listCursorKeys(prefix: string): string[] {
		const rows = this.db
			.query("SELECT cursor_key FROM slack_cursors WHERE substr(cursor_key, 1, length(?1)) = ?1 ORDER BY cursor_key")
			.all(prefix) as Array<{ cursor_key: string }>;
		return rows.map((row) => row.cursor_key);
	}

	createApproval(input: ApprovalInput): void {
		const detail: ApprovalDetail = {};
		for (const key of ["action", "why", "impact", "rollback"] as const) {
			const value = input.detail?.[key];
			if (value !== undefined && value.trim() !== "") detail[key] = this.redact(value);
		}
		this.db
			.query(
				"INSERT INTO approvals (approval_id, channel, message_ts, summary, status, created_at, expires_at, origin_key, origin_thread_ref, detail_json, card_url, origin_url) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				input.approvalId,
				input.channel,
				input.messageTs,
				this.redact(input.summary),
				input.createdAt,
				input.expiresAt,
				input.originKey ?? null,
				input.originThreadRef ?? null,
				Object.keys(detail).length === 0 ? null : JSON.stringify(detail),
				input.cardUrl ?? null,
				input.originUrl ?? null,
			);
	}

	getApproval(approvalId: string): ApprovalRow | undefined {
		const row = this.db.query("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId) as ApprovalSql | null;
		return row === null
			? undefined
			: {
					approvalId: row.approval_id,
					channel: row.channel,
					messageTs: row.message_ts,
					status: row.status,
					originKey: row.origin_key,
					originThreadRef: row.origin_thread_ref,
					replyTs: row.reply_ts,
					replyText: row.reply_text,
					summary: row.summary,
					mirrorRef: row.mirror_ref ?? null,
				};
	}

	/** Records the mirror card of a still-pending approval; false when the row is gone or already settled. */
	setApprovalMirrorRef(approvalId: string, mirrorRef: string): boolean {
		return (
			this.db
				.query("UPDATE approvals SET mirror_ref = ? WHERE approval_id = ? AND status = 'pending'")
				.run(mirrorRef, approvalId).changes === 1
		);
	}

	/**
	 * Settles a pending, not-yet-due approval as `replied` with the owner's thread reply. Same `status = 'pending'`
	 * guard as a click, so a reply racing a click, the sweeper or a timeout reports `false`.
	 */
	replyApproval(approvalId: string, replyTs: string, text: string, now: number): boolean {
		return (
			this.db
				.query(
					"UPDATE approvals SET status = 'replied', decided_at = ?, reply_ts = ?, reply_text = ? WHERE approval_id = ? AND status = 'pending' AND expires_at > ?",
				)
				.run(now, replyTs, this.redact(text), approvalId, now).changes === 1
		);
	}

	judgeCardAnswer(cardId: string, answerId: string, value: string, now: number): CardAnswerVerdict {
		return judgeCardAnswer(this.db, this.getApproval(cardId)?.status, cardId, answerId, value, now);
	}

	recordCardAnswer(cardId: string, answerId: string, value: string, now: number): void {
		insertCardAnswer(this.db, "accepted", cardId, answerId, value, now);
	}

	/**
	 * Resolves a pending approval; the `WHERE status = 'pending'` guard makes the second click (or a click racing the
	 * sweeper) a no-op that reports `false`, replacing the in-memory map's atomic pop.
	 */
	decideApproval(approvalId: string, status: "approved" | "denied" | "expired", now: number): boolean {
		// A due-but-unswept row is expired by contract: a late click must not approve it (the sweeper would have
		// refused). Marking it `expired` is always allowed — that is the sweeper's own honest outcome.
		const guard = status === "expired" ? "" : " AND expires_at > ?";
		const params = status === "expired" ? [status, now, approvalId] : [status, now, approvalId, now];
		return (
			this.db
				.query(`UPDATE approvals SET status = ?, decided_at = ? WHERE approval_id = ? AND status = 'pending'${guard}`)
				.run(...params).changes === 1
		);
	}

	/**
	 * Expires every still-pending approval that is due (or all of them when `due` is false — the boot sweep). The
	 * summary comes back so the broker can tell a choice card (its body) from an approval when rewriting the card.
	 */
	expirePendingApprovals(now: number, due = true): ExpiredApproval[] {
		return this.db.transaction((): ExpiredApproval[] => {
			const rows = this.db
				.query(
					`SELECT approval_id, channel, message_ts, summary, origin_thread_ref, mirror_ref FROM approvals
					 WHERE status = 'pending' AND (${due ? "expires_at <= ?" : "1 = 1"})`,
				)
				.all(...(due ? [now] : [])) as Array<{
				approval_id: string;
				channel: string;
				message_ts: string;
				summary: string;
				origin_thread_ref: string | null;
				mirror_ref: string | null;
			}>;
			if (rows.length === 0) return [];
			this.db
				.query(
					`UPDATE approvals SET status = 'expired', decided_at = ?
					 WHERE status = 'pending' AND (${due ? "expires_at <= ?" : "1 = 1"})`,
				)
				.run(...(due ? [now, now] : [now]));
			return rows.map((row) => ({
				approvalId: row.approval_id,
				channel: row.channel,
				messageTs: row.message_ts,
				summary: row.summary,
				originThreadRef: row.origin_thread_ref,
				mirrorRef: row.mirror_ref,
			}));
		})();
	}

	/** Answered owner turns on one origin (the skill-review cadence counts these). */
	countAnswered(originKey: string): number {
		const row = this.db
			.query("SELECT COUNT(*) AS n FROM inbound WHERE origin_key = ? AND state = 'answered'")
			.get(originKey) as { n: number } | null;
		return row?.n ?? 0;
	}

	/** Origin keys of one chat platform (`<platform>/dm/<id>`, `<platform>/ch/<id>[/t/<id>]`) — backfill targets. */
	listOrigins(platform: ChatPlatform): string[] {
		const rows = this.db
			.query("SELECT origin_key FROM origins WHERE origin_key LIKE ? ORDER BY origin_key")
			.all(`${platform}/%`) as Array<{ origin_key: string }>;
		return rows.map((row) => row.origin_key);
	}

	/**
	 * Threads the bot answered in recently on one chat platform's origins (deliveries carry `<channel>:<rootTs>`),
	 * newest first — backfill thread targets. The 7-day window and cap mirror the upstream participated-thread
	 * tracking. Top-level posts (`<channel>:-`: slash-command answers, log-channel copies) have no thread to read, so
	 * they are never targets.
	 */
	listThreadTargets(platform: ChatPlatform, since: number, limit: number): Array<{ channel: string; rootTs: string }> {
		const rows = this.db
			.query(
				`SELECT origin_key, thread_ref, MAX(created_at) AS last FROM deliveries
				 WHERE thread_ref IS NOT NULL AND thread_ref NOT LIKE ? AND origin_key LIKE ? AND created_at >= ?
				 GROUP BY origin_key, thread_ref ORDER BY last DESC LIMIT ?`,
			)
			.all(`%:${TOP_LEVEL_TS}`, `${platform}/%`, since, limit) as Array<{ origin_key: string; thread_ref: string }>;
		const targets: Array<{ channel: string; rootTs: string }> = [];
		for (const row of rows) {
			const parsed = parseThreadRef(row.thread_ref);
			if (parsed === undefined) continue;
			targets.push({ channel: parsed.channel, rootTs: parsed.threadTs });
		}
		return targets;
	}

	/**
	 * `/new`: bump the epoch, switch session dir, discard still-pending inbound of the old epoch. With `opRef` the
	 * discarded rows are linked to that op, so the command's delivery also finishes their thread status messages.
	 */
	newEpoch(originKey: string, sessionDir: string, opRef?: string, sessionFile?: string): OriginRow {
		this.db.transaction(() => {
			this.requireOrigin(originKey);
			this.db
				.query(
					"UPDATE origins SET epoch = epoch + 1, session_dir = ?, session_file = ?, updated_at = ? WHERE origin_key = ?",
				)
				.run(sessionDir, sessionFile ?? null, this.clock.now(), originKey);
			this.db
				.query(
					"UPDATE inbound SET state = 'discarded', op_ref = COALESCE(?, op_ref) WHERE origin_key = ? AND state = 'pending'",
				)
				.run(opRef ?? null, originKey);
		})();
		return this.requireOrigin(originKey);
	}

	/**
	 * Pins the session file the origin's next child resumes (`sessionToResume`) without a new epoch: the session dir,
	 * the pending rows and the epoch stay as they are. A lane handed back from a terminal omp keeps writing the file the
	 * terminal wrote, whatever else appeared in its session dir.
	 */
	pinSessionFile(originKey: string, sessionFile: string): OriginRow {
		this.requireOrigin(originKey);
		this.db
			.query("UPDATE origins SET session_file = ?, updated_at = ? WHERE origin_key = ?")
			.run(sessionFile, this.clock.now(), originKey);
		return this.requireOrigin(originKey);
	}

	/** `null` clears a setting (back to the omp default); `undefined` leaves it unchanged. */
	setOriginSettings(originKey: string, settings: Partial<OriginSettings>): OriginRow {
		const origin = this.requireOrigin(originKey);
		this.db
			.query("UPDATE origins SET model = ?, thinking = ?, updated_at = ? WHERE origin_key = ?")
			.run(
				settings.model === undefined ? origin.model : settings.model,
				settings.thinking === undefined ? origin.thinking : settings.thinking,
				this.clock.now(),
				originKey,
			);
		return this.requireOrigin(originKey);
	}

	// ---- inbound ----

	/** Whether an owner message was recorded in this thread (a channel thread the bot is already part of). */
	hasInboundThread(threadRef: string): boolean {
		return this.db.query("SELECT 1 FROM inbound WHERE thread_ref = ? LIMIT 1").get(threadRef) !== null;
	}

	/** Whether the thread has an inbound row recorded before the given one (any origin, owner or peer). */
	hasInboundThreadBefore(threadRef: string, platformMessageId: string): boolean {
		return (
			this.db
				.query(
					"SELECT 1 FROM inbound WHERE thread_ref = ? AND inbound_id < (SELECT inbound_id FROM inbound WHERE platform_message_id = ?) LIMIT 1",
				)
				.get(threadRef, platformMessageId) !== null
		);
	}

	/** Whether any peer bot's message was recorded for this origin: its omp child runs with the reduced host tools. */
	originHasPeerInbound(originKey: string): boolean {
		return (
			this.db
				.query("SELECT 1 FROM inbound WHERE origin_key = ? AND peer_user_id IS NOT NULL LIMIT 1")
				.get(originKey) !== null
		);
	}

	/** Peer rows recorded in a thread at or after `sinceMs` (the hop cap's window). */
	countPeerInboundSince(threadRef: string, sinceMs: number): number {
		const row = this.db
			.query("SELECT COUNT(*) AS n FROM inbound WHERE thread_ref = ? AND peer_user_id IS NOT NULL AND created_at >= ?")
			.get(threadRef, sinceMs) as { n: number };
		return row.n;
	}

	/** Idempotent on platform_message_id: a second insert of the same id returns the existing row. */
	recordInbound(input: {
		originKey: string;
		platformMessageId: string;
		textRef: string;
		threadRef?: string;
		/** Set only for a peer bot's row (taints the origin: see `originHasPeerInbound`). */
		peerUserId?: string | null;
		/** A `jabbu-pocket inject` row (`InboundRow.injected`). */
		injected?: boolean;
	}): {
		inserted: boolean;
		row: InboundRow;
		/** The id was already recorded with other content (a duplicate either way: the first row stays). */
		conflict: boolean;
	} {
		const origin = this.requireOrigin(input.originKey);
		const text = this.redact(input.textRef);
		const result = this.db
			.query(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, created_at, thread_ref, peer_user_id, injected) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(platform_message_id) DO NOTHING",
			)
			.run(
				input.platformMessageId,
				input.originKey,
				origin.epoch,
				text,
				this.clock.now(),
				input.threadRef ?? input.platformMessageId,
				input.peerUserId ?? null,
				input.injected === true ? 1 : 0,
			);
		const row = this.requireInbound(input.platformMessageId);
		if (result.changes === 1) return { inserted: true, row, conflict: false };
		if (inboundIdentity(row.textRef) === inboundIdentity(text)) return { inserted: false, row, conflict: false };
		this.db
			.query("INSERT INTO inbound_conflicts (platform_message_id, origin_key, created_at) VALUES (?, ?, ?)")
			.run(input.platformMessageId, input.originKey, this.clock.now());
		try {
			this.hooks.onInboundConflict?.({
				platformMessageId: input.platformMessageId,
				originKey: input.originKey,
				storedSha: sha12(row.textRef),
				newSha: sha12(text),
				storedLength: row.textRef.length,
				newLength: text.length,
			});
		} catch {
			// observer only; the duplicate is already recorded
		}
		return { inserted: false, row, conflict: true };
	}

	getInbound(platformMessageId: string): InboundRow | undefined {
		const row = this.db
			.query("SELECT * FROM inbound WHERE platform_message_id = ?")
			.get(platformMessageId) as InboundSql | null;
		return row ? toInbound(row) : undefined;
	}

	/**
	 * Inbound rows in arrival order. Each filter combination has its own fixed SQL: an `(? IS NULL OR …)` predicate
	 * cannot use an index, so the 15-second pending sweep would scan the whole table.
	 */
	listInbound(filter: { originKey?: string; state?: InboundState } = {}): InboundRow[] {
		const { originKey, state } = filter;
		const rows = (
			originKey !== undefined && state !== undefined
				? this.db
						.query("SELECT * FROM inbound WHERE origin_key = ? AND state = ? ORDER BY inbound_id")
						.all(originKey, state)
				: originKey !== undefined
					? this.db.query("SELECT * FROM inbound WHERE origin_key = ? ORDER BY inbound_id").all(originKey)
					: state !== undefined
						? this.db.query("SELECT * FROM inbound WHERE state = ? ORDER BY inbound_id").all(state)
						: this.db.query("SELECT * FROM inbound ORDER BY inbound_id").all()
		) as InboundSql[];
		return rows.map(toInbound);
	}

	/** Per-state inbound row counts (`GROUP BY`, `sending` counted as dispatched); /status counts without loading rows. */
	countInboundByState(): Partial<Record<InboundState, number>> {
		const counts: Partial<Record<InboundState, number>> = {};
		for (const row of this.db.query(INBOUND_COUNT_SQL).all() as Array<{
			state: InboundState;
			n: number;
		}>) {
			counts[row.state] = row.n;
		}
		return counts;
	}

	/**
	 * Distinct origin keys of inbound rows, in first-appearance order (`MIN(inbound_id)`) — the /status origin list,
	 * computed in SQL so the ledger can grow without the report growing with it.
	 */
	distinctInboundOrigins(): string[] {
		const rows = this.db
			.query("SELECT origin_key FROM inbound GROUP BY origin_key ORDER BY MIN(inbound_id)")
			.all() as Array<{ origin_key: string }>;
		return rows.map((row) => row.origin_key);
	}

	/** pending -> dispatched. Records the op_ref and the omp leafId cursor taken just before dispatch. */
	markDispatched(platformMessageId: string, input: { opRef: string; entryCursor: string | null }): InboundRow {
		const current = this.requireInbound(platformMessageId);
		assertInboundTransition(current.state, "dispatched");
		this.db
			.query(
				"UPDATE inbound SET state = 'dispatched', dispatched_at = ?, op_ref = ?, entry_cursor = ? WHERE platform_message_id = ?",
			)
			.run(this.clock.now(), input.opRef, input.entryCursor, platformMessageId);
		return this.requireInbound(platformMessageId);
	}

	/** pending -> sending: the write-ahead right before a prompt or steer, with the leafId cursor taken before it. */
	markSending(platformMessageId: string, entryCursor: string | null): InboundRow {
		assertInboundTransition(this.requireInbound(platformMessageId).state, "sending");
		this.db
			.query("UPDATE inbound SET state = 'sending', entry_cursor = ? WHERE platform_message_id = ?")
			.run(entryCursor, platformMessageId);
		return this.requireInbound(platformMessageId);
	}

	/** Every `sending` row (of one origin, or all) -> uncertain: a send that never got its outcome is never repeated. */
	parkSending(originKey?: string): InboundRow[] {
		const rows = this.listInbound({ originKey, state: "sending" });
		return rows.map((row) => this.markUncertain(row.platformMessageId, "send_interrupted"));
	}

	/** pending|sending -> uncertain: the input may already have reached the omp child, so nothing replays it until the owner decides. */
	markUncertain(platformMessageId: string, reason: UncertainReason): InboundRow {
		const current = this.requireInbound(platformMessageId);
		assertInboundTransition(current.state, "uncertain");
		this.db
			.query(
				"UPDATE inbound SET state = 'uncertain', uncertain_reason = ?, uncertain_at = ? WHERE platform_message_id = ?",
			)
			.run(reason, this.clock.now(), platformMessageId);
		return this.requireInbound(platformMessageId);
	}

	/** uncertain -> pending: the owner's explicit retry; the next drain sends it from scratch. */
	retryUncertain(platformMessageId: string): InboundRow {
		return this.backToPending(platformMessageId, "uncertain");
	}

	/** sending -> pending: the omp child certainly never got the input (`not_started`), so it may be sent again. */
	releaseSending(platformMessageId: string): InboundRow {
		return this.backToPending(platformMessageId, "sending");
	}

	private backToPending(platformMessageId: string, from: "uncertain" | "sending"): InboundRow {
		const { state } = this.requireInbound(platformMessageId);
		if (state !== from) throw new StoreError("invalid_transition", `inbound ${state} -> pending (expected ${from})`);
		this.db.query("UPDATE inbound SET state = 'pending' WHERE platform_message_id = ?").run(platformMessageId);
		return this.requireInbound(platformMessageId);
	}

	/** pending|dispatched|uncertain -> discarded. With `opRef` the row is re-linked to that op (see `newEpoch`). */
	discard(platformMessageId: string, opRef?: string): InboundRow {
		const current = this.requireInbound(platformMessageId);
		assertInboundTransition(current.state, "discarded");
		this.db
			.query("UPDATE inbound SET state = 'discarded', op_ref = COALESCE(?, op_ref) WHERE platform_message_id = ?")
			.run(opRef ?? null, platformMessageId);
		return this.requireInbound(platformMessageId);
	}

	/** The op's running turn just emitted an omp event: stamps every still-dispatched row of it (steered rows too). */
	touchDispatched(originKey: string, opRef: string): void {
		this.db
			.query("UPDATE inbound SET last_event_at = ? WHERE origin_key = ? AND op_ref = ? AND state = 'dispatched'")
			.run(this.clock.now(), originKey, opRef);
	}

	/** Distinct threads of every inbound row that belongs to the op (the whole steered batch, not only the lead). */
	threadsOfOp(originKey: string, opRef: string): string[] {
		const rows = this.db
			.query("SELECT DISTINCT thread_ref FROM inbound WHERE origin_key = ? AND op_ref = ? ORDER BY thread_ref")
			.all(originKey, opRef) as Array<{ thread_ref: string }>;
		return rows.map((row) => row.thread_ref);
	}

	/**
	 * Earliest inbound row of a thread other than the given message — normally the thread root, which was
	 * dispatched to the parent channel's origin and is therefore invisible to the thread-reply session.
	 */
	getThreadRootInbound(threadRef: string, excludeMessageId: string): InboundRow | undefined {
		const row = this.db
			.query("SELECT * FROM inbound WHERE thread_ref = ? AND platform_message_id != ? ORDER BY inbound_id LIMIT 1")
			.get(threadRef, excludeMessageId) as InboundSql | null;
		return row === null ? undefined : toInbound(row);
	}

	/**
	 * Durations (ms) of answered turns of the last 30 days, newest first, at most 200: the turn's first answer part
	 * minus its earliest dispatch, one sample per turn however many messages were steered into it. Turns of
	 * `originKey` only, or of every chat origin when it is omitted (monitor and lane turns never count).
	 */
	turnDurationSamples(originKey?: string): number[] {
		const scope =
			originKey === undefined
				? `(${CHAT_ORIGIN_PREFIXES.map((_, i) => `i.origin_key LIKE $p${i}`).join(" OR ")})`
				: "i.origin_key = $origin";
		const rows = this.db
			.query(
				`SELECT d.created_at - MIN(i.dispatched_at) AS ms
				 FROM inbound i JOIN deliveries d ON d.origin_key = i.origin_key AND d.op_ref = i.op_ref AND d.part = 0
				 WHERE i.state = 'answered' AND i.dispatched_at >= $since AND ${scope}
				 GROUP BY i.origin_key, i.op_ref
				 ORDER BY MIN(i.dispatched_at) DESC LIMIT $limit`,
			)
			.all({
				...(originKey === undefined
					? Object.fromEntries(CHAT_ORIGIN_PREFIXES.map((prefix, i) => [`$p${i}`, prefix]))
					: { $origin: originKey }),
				$since: this.clock.now() - TURN_SAMPLE_WINDOW_MS,
				$limit: TURN_SAMPLE_LIMIT,
			}) as Array<{ ms: number }>;
		return rows.map((row) => row.ms);
	}

	/**
	 * Recall candidates of one conversation space (its platform read from the id), newest first: owner messages and confirmed first-part bot
	 * answers of the last 90 days whose origin AND thread both belong to `channel` (a DM origin's steer pointer into
	 * a channel thread is excluded by the origin test), other than the `excludeThreadRef` thread and top-level posts.
	 * Chat commands, command answers, failure notices and steer pointers are dropped after the query.
	 */
	listRecallCandidates(channel: string, excludeThreadRef: string, limit: number): RecallCandidate[] {
		const platform = platformOfConversationId(channel);
		if (platform === undefined) return [];
		const chEsc = channel.replace(/[\\%_]/g, (c) => `\\${c}`);
		const scope = `(origin_key = $dm OR origin_key = $chKey OR origin_key LIKE $threads ESCAPE '\\')
			AND thread_ref LIKE $chEsc || ':%' ESCAPE '\\' AND thread_ref <> $ch || ':-' AND thread_ref <> $exclude
			AND created_at >= $since`;
		const rows = this.db
			.query(
				`SELECT 'inbound' AS kind, origin_key, thread_ref, created_at, substr(text_ref, 1, 1200) AS text, op_ref
				 FROM inbound WHERE ${scope} AND state <> 'discarded' AND peer_user_id IS NULL
				 UNION ALL
				 SELECT 'delivery' AS kind, origin_key, thread_ref, created_at, substr(body, 1, 1200) AS text, op_ref
				 FROM deliveries WHERE ${scope} AND state = 'confirmed' AND part = 0
				 ORDER BY created_at DESC LIMIT $limit`,
			)
			.all({
				$dm: `${platform}/dm/${channel}`,
				$chKey: `${platform}/ch/${channel}`,
				$threads: `${platform}/ch/${chEsc}/t/%`,
				$ch: channel,
				$chEsc: chEsc,
				$exclude: excludeThreadRef,
				$since: this.clock.now() - RECALL_WINDOW_MS,
				$limit: limit,
			}) as Array<{
			kind: RecallCandidate["kind"];
			origin_key: string;
			thread_ref: string;
			created_at: number;
			text: string;
			op_ref: string | null;
		}>;
		const candidates: RecallCandidate[] = [];
		for (const row of rows) {
			const bookkeeping =
				row.kind === "inbound"
					? parseCommand(row.text) !== undefined || parsePurposeCommand(row.text) !== undefined
					: (row.op_ref !== null && COMMAND_OP_REF.test(row.op_ref)) ||
						row.text.startsWith(STEER_NOTICE_HEAD) ||
						row.text.startsWith(TURN_FAILED_HEAD);
			if (bookkeeping) continue;
			candidates.push({
				kind: row.kind,
				originKey: row.origin_key,
				threadRef: row.thread_ref,
				createdAt: row.created_at,
				text: row.text,
				opRef: row.op_ref,
			});
		}
		return candidates;
	}

	/**
	 * Distinct threads of the op's `discarded` rows — a `/queue-jabbu drop` target, re-linked to the command's op
	 * by `discard()`. The delivery carrying the op finishes these threads' ⏳ status as `🚫 취소됨` instead of ✅/⚠️.
	 */
	discardedThreadsOfOp(originKey: string, opRef: string): string[] {
		const rows = this.db
			.query(
				"SELECT DISTINCT thread_ref FROM inbound WHERE origin_key = ? AND op_ref = ? AND state = 'discarded' ORDER BY thread_ref",
			)
			.all(originKey, opRef) as Array<{ thread_ref: string }>;
		return rows.map((row) => row.thread_ref);
	}

	/**
	 * Conversations with an inbound message since `since`, each with the thread of its newest message (newest
	 * first, at most `limit`) — the restart notice targets. Monitor origins never take inbound from people.
	 */
	recentConversations(since: number, limit: number): Array<{ originKey: string; threadRef: string }> {
		const rows = this.db
			.query(
				`SELECT i.origin_key, i.thread_ref FROM inbound i
				 JOIN (SELECT origin_key, MAX(inbound_id) AS last FROM inbound WHERE created_at >= ? AND thread_ref IS NOT NULL
				       AND origin_key NOT LIKE 'monitor/%' GROUP BY origin_key) r ON r.last = i.inbound_id
				 ORDER BY i.inbound_id DESC LIMIT ?`,
			)
			.all(since, limit) as Array<{ origin_key: string; thread_ref: string }>;
		return rows.map((row) => ({ originKey: row.origin_key, threadRef: row.thread_ref }));
	}

	/** Newest recorded thread of an origin (its current conversation); where a file upload lands by default. */
	latestInboundThread(originKey: string): string | undefined {
		const row = this.db
			.query("SELECT thread_ref FROM inbound WHERE origin_key = ? ORDER BY inbound_id DESC LIMIT 1")
			.get(originKey) as { thread_ref: string } | undefined;
		return row?.thread_ref;
	}

	/**
	 * One transaction: every dispatched inbound row of the op becomes `answered` and the delivery rows are created.
	 * Any throw in between rolls both back. Re-recording the same (origin, op_ref, part) is a no-op. `answer` is the
	 * turn's whole answer when `parts` leave out what interim deliveries already sent: the log-channel copy and the
	 * steered-thread pointers are judged on it (default: `parts`). A [TASK] origin's turn makes no delivery.
	 */
	recordAnswer(input: {
		originKey: string;
		opRef: string;
		threadRef: string;
		parts: readonly string[];
		answer?: string;
	}): DeliveryRow[] {
		if (input.parts.length === 0) throw new StoreError("invalid_argument", "recordAnswer needs at least one part");
		if (input.originKey.startsWith(MONITOR_ORIGIN_PREFIX)) return this.recordMonitorAnswer(input);
		return this.db.transaction(() => {
			const steered = this.steeredThreads(input);
			this.closeDispatched(input.originKey, input.opRef, "answered");
			this.hooks.afterInboundAnswered?.();
			const rows = isTaskOrigin(input.originKey)
				? []
				: input.parts.map((b, part) => this.insertDelivery(input, part, b));
			const whole = input.answer ?? input.parts.join("\n");
			this.notifySteeredThreads(input, steered, whole);
			this.copyCompletion(input, whole);
			return rows;
		})();
	}

	/**
	 * A text a still-running turn sends right away (a finished answer, a note next to `wait`): one delivery under
	 * `<opRef>:interim:<index>`. Inbound rows stay `dispatched`, and no log-channel copy or steered-thread pointer is
	 * made — the turn end does those. Re-recording the same index is a no-op.
	 */
	recordInterim(input: {
		originKey: string;
		opRef: string;
		threadRef: string;
		index: number;
		body: string;
	}): DeliveryRow {
		return this.insertDelivery({ ...input, opRef: `${input.opRef}${INTERIM_INFIX}${input.index}` }, 0, input.body);
	}

	/** Bodies of the op's interim deliveries in the order they were recorded (stored, so redacted). */
	interimBodies(originKey: string, opRef: string): string[] {
		const prefix = `${opRef}${INTERIM_INFIX}`;
		// "Starts with prefix" as a range the (origin_key, op_ref, part) key can seek: the infix ends in ASCII ':', so
		// bumping that last character gives the first string past every one carrying the prefix.
		const end = `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;
		const rows = this.db
			.query("SELECT body FROM deliveries WHERE origin_key = ? AND op_ref >= ? AND op_ref < ? ORDER BY delivery_id")
			.all(originKey, prefix, end) as Array<{ body: string }>;
		return rows.map((row) => row.body);
	}

	/**
	 * Other threads of a chat turn's still-dispatched rows: messages steered into a turn another thread started. Read
	 * before the rows close, so a replayed answer (rows already answered) finds none and notifies nothing twice.
	 */
	private steeredThreads(input: { originKey: string; opRef: string; threadRef: string }): string[] {
		if (chatPlatformOf(input.originKey) === undefined) return [];
		const rows = this.db
			.query(
				"SELECT DISTINCT thread_ref FROM inbound WHERE origin_key = ? AND op_ref = ? AND state = 'dispatched' AND thread_ref != ? ORDER BY thread_ref",
			)
			.all(input.originKey, input.opRef, input.threadRef) as Array<{ thread_ref: string }>;
		return rows.map((row) => row.thread_ref);
	}

	/**
	 * One pointer per steered thread: the answer (or failure notice) went to the turn's thread, so the other thread
	 * gets its first line and a `{{thread-link:…}}` the adapter turns into a permalink. Op ref `<opRef>:steer:<n>`.
	 */
	private notifySteeredThreads(
		input: { originKey: string; opRef: string; threadRef: string },
		threads: readonly string[],
		body: string,
	): void {
		if (threads.length === 0) return;
		const first = cutCodePointSafe((body.split("\n").find((line) => line.trim() !== "") ?? "").trim(), 200);
		const answered = parseThreadRef(input.threadRef);
		const link =
			answered === undefined || answered.threadTs === TOP_LEVEL_TS
				? ""
				: `${THREAD_LINK_PREFIX}${answered.channel}:${answered.threadTs}}}`;
		threads.forEach((threadRef, n) => {
			this.insertDelivery(
				{ originKey: input.originKey, opRef: `${input.opRef}${STEER_NOTICE_SUFFIX}${n}`, threadRef },
				0,
				`${STEER_NOTICE_HEAD}\n> ${first}${link}`,
			);
		});
	}

	/**
	 * The single choke point where chat answers become deliveries also writes the log-channel copy of a completion
	 * report: a Discord chat or work-lane answer (never commands) whose first non-empty line starts with
	 * `✅ 완료`. It goes to the #log channel of the answer's own platform (a lane: its thread's), never another
	 * platform's. The copy is one delivery on `<logChannel>:-` under `<opRef>:log-copy`, so a replayed answer inserts
	 * nothing new.
	 */
	private copyCompletion(input: { originKey: string; opRef: string; threadRef: string }, body: string): void {
		if (COMMAND_OP_REF.test(input.opRef)) return;
		const lane = input.originKey.startsWith(LANE_ORIGIN_PREFIX);
		const platform = lane ? platformOfThreadRef(input.threadRef) : chatPlatformOf(input.originKey);
		const logChannel = platform === "discord" ? this.logChannels.discord : undefined;
		if (logChannel === undefined) return;
		const first = body.split("\n").find((line) => line.trim() !== "");
		if (first === undefined || !COMPLETION_MARKER.test(first.trim())) return;
		const requested = parseThreadRef(input.threadRef);
		const channel = requested?.channel ?? "";
		const where = lane
			? `작업 레인 ${input.originKey.slice(LANE_ORIGIN_PREFIX.length)}`
			: parseChatOrigin(input.originKey)?.kind === "dm"
				? "DM"
				: `<#${channel}>`;
		const link =
			requested === undefined || requested.threadTs === TOP_LEVEL_TS
				? ""
				: `${THREAD_LINK_PREFIX}${requested.channel}:${requested.threadTs}}}`;
		this.insertDelivery(
			{
				originKey: input.originKey,
				opRef: `${input.opRef}${LOG_COPY_SUFFIX}`,
				threadRef: threadRefOf(logChannel, TOP_LEVEL_TS),
			},
			0,
			`📒 완료 보고 사본 · ${where}${link}\n${body}`,
		);
	}

	/**
	 * One transaction: dispatched inbound of the op -> `failed_notified` plus a single notice delivery (part 0).
	 * A monitor origin has no notice: the event retries with backoff, and only the final failure notifies the owner,
	 * so this returns `undefined` for it until then.
	 */
	recordTurnFailure(input: {
		originKey: string;
		opRef: string;
		threadRef: string;
		notice: string;
	}): DeliveryRow | undefined {
		if (input.originKey.startsWith(MONITOR_ORIGIN_PREFIX)) return this.recordMonitorFailure(input);
		return this.db.transaction(() => {
			const steered = this.steeredThreads(input);
			this.closeDispatched(input.originKey, input.opRef, "failed_notified");
			const row = isTaskOrigin(input.originKey) ? undefined : this.insertDelivery(input, 0, input.notice);
			this.notifySteeredThreads(input, steered, input.notice);
			return row;
		})();
	}

	/**
	 * One transaction: the resume row of a turn a planned restart cut (`pending`, in the same thread, with the cut
	 * row's `peerUserId` and `injected` so it is held and answers cards exactly like it; idempotent on its
	 * `platformMessageId`) and the cut turn closed like `recordTurnFailure` with `notice`.
	 */
	recordContinuation(input: {
		originKey: string;
		opRef: string;
		threadRef: string;
		notice: string;
		platformMessageId: string;
		textRef: string;
		/** The cut row's. */
		peerUserId: string | null;
		injected: boolean;
	}): { inserted: boolean } {
		return this.db.transaction(() => {
			const { inserted } = this.recordInbound({
				originKey: input.originKey,
				platformMessageId: input.platformMessageId,
				textRef: input.textRef,
				threadRef: input.threadRef,
				peerUserId: input.peerUserId,
				injected: input.injected,
			});
			this.recordTurnFailure(input);
			return { inserted };
		})();
	}

	// ---- monitors ----

	/**
	 * The owner's live DM origin key on `platform` (`<platform>/dm/<id>`), newest by updated_at — undefined before the
	 * owner ever DM'd there.
	 */
	ownerDmOrigin(platform: ChatPlatform): string | undefined {
		const row = this.db
			.query("SELECT origin_key FROM origins WHERE origin_key LIKE ? ORDER BY updated_at DESC LIMIT 1")
			.get(`${platform}/dm/%`) as { origin_key: string } | null;
		return row?.origin_key;
	}

	/** `!home`: the conversation owner notices go to from now on, ahead of every fallback of `ownerHome()`. */
	setOwnerHome(home: OwnerHome): void {
		this.db
			.query(
				`INSERT INTO owner_home (id, platform, conversation_id, set_at) VALUES (1, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET platform = excluded.platform, conversation_id = excluded.conversation_id,
				 set_at = excluded.set_at`,
			)
			.run(home.platform, home.conversationId, this.clock.now());
	}

	/** `!용도`: the purpose memo of a channel (`<platform>:<conversationId>`) or thread (`<platform>:<threadRef>`). */
	setPurpose(scopeKey: string, text: string): void {
		this.db
			.query(
				`INSERT INTO conversation_purposes (scope_key, text, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(scope_key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
			)
			.run(scopeKey, text, this.clock.now());
	}

	getPurpose(scopeKey: string): string | undefined {
		const row = this.db.query("SELECT text FROM conversation_purposes WHERE scope_key = ?").get(scopeKey) as {
			text: string;
		} | null;
		return row?.text;
	}

	/** True when a memo existed. */
	clearPurpose(scopeKey: string): boolean {
		return this.db.query("DELETE FROM conversation_purposes WHERE scope_key = ?").run(scopeKey).changes > 0;
	}

	/**
	 * Where daemon-level owner notices and channel-less monitor reports go: ① the home registered with `!home`, ② the
	 * owner's newest 1:1 conversation on any platform, ③ the conversation the owner last wrote in. `undefined` before
	 * any of them exists (a fresh install whose owner has not written yet): callers warn and never post to an empty id.
	 */
	ownerHome(): OwnerHome | undefined {
		const registered = this.db.query("SELECT platform, conversation_id FROM owner_home WHERE id = 1").get() as {
			platform: string;
			conversation_id: string;
		} | null;
		if (registered !== null) {
			const ref = parseChatOrigin(`${registered.platform}/ch/${registered.conversation_id}`);
			if (ref !== undefined) return { platform: ref.platform, conversationId: ref.conversationId };
		}
		const dms = this.db
			.query("SELECT origin_key FROM origins WHERE origin_key LIKE '%/dm/%' ORDER BY updated_at DESC")
			.all() as Array<{ origin_key: string }>;
		for (const { origin_key } of dms) {
			const ref = parseChatOrigin(origin_key);
			if (ref?.kind === "dm") return { platform: ref.platform, conversationId: ref.conversationId };
		}
		// Owner rows only (a peer bot's request carries its user id); monitor and lane origins are not conversations.
		const spoken = this.db
			.query(
				`SELECT origin_key FROM inbound WHERE peer_user_id IS NULL AND origin_key LIKE 'discord/%'
				 ORDER BY inbound_id DESC LIMIT 50`,
			)
			.all() as Array<{ origin_key: string }>;
		for (const { origin_key } of spoken) {
			const ref = parseChatOrigin(origin_key);
			if (ref !== undefined) return { platform: ref.platform, conversationId: ref.conversationId };
		}
		return undefined;
	}

	/** Top-level thread ref in `ownerHome()`; `undefined` (and the unroutable hook) when there is none. */
	private ownerTopLevelThreadRef(input: { originKey: string; opRef: string }): string | undefined {
		const home = this.ownerHome();
		if (home !== undefined) return threadRefOf(home.conversationId, TOP_LEVEL_TS);
		this.hooks.onOwnerNoticeUnroutable?.(input);
		return undefined;
	}

	/** Top-level thread ref of an owner alert: the Discord alert channel when set, else `ownerTopLevelThreadRef`. */
	private ownerAlertThreadRef(input: { originKey: string; opRef: string }): string | undefined {
		const alert = this.alertChannels.discord;
		return alert === undefined ? this.ownerTopLevelThreadRef(input) : threadRefOf(alert, TOP_LEVEL_TS);
	}

	/** Monitor event ids of the dispatched inbound rows of an op (message ids are `monitor:<id>:<event>:<attempt>`). */
	private monitorEventsOfOp(originKey: string, opRef: string): number[] {
		const rows = this.db
			.query("SELECT platform_message_id FROM inbound WHERE origin_key = ? AND op_ref = ? AND state = 'dispatched'")
			.all(originKey, opRef) as Array<{ platform_message_id: string }>;
		const ids: number[] = [];
		for (const row of rows) {
			const match = /^monitor:[^:]+:(\d+):\d+$/.exec(row.platform_message_id);
			if (match?.[1] !== undefined) ids.push(Number(match[1]));
		}
		return ids;
	}

	private recordMonitorAnswer(input: { originKey: string; opRef: string; parts: readonly string[] }): DeliveryRow[] {
		return this.db.transaction(() => {
			const eventIds = this.monitorEventsOfOp(input.originKey, input.opRef);
			this.closeDispatched(input.originKey, input.opRef, "answered");
			this.hooks.afterInboundAnswered?.();
			const text = input.parts.join("\n");
			const delivered: DeliveryRow[] = [];
			for (const [part, eventId] of eventIds.entries()) {
				if (text.trim() === EMPTY_ANSWER) {
					this.failMonitorEvent(eventId, "[turn failed] empty_answer");
					continue;
				}
				const settled = this.monitors.settleAnswered(eventId, text);
				if (settled === undefined) continue;
				// A monitor that ran to a normal answer is healthy: its open incidents resolve.
				this.monitors.resolveMonitorIncidents(settled.event.monitorId);
				const monitor = this.monitors.getMonitor(settled.event.monitorId);
				if (!settled.report) {
					// Every settled event of a copy-channel monitor also lands there once, whether or not it was reported.
					this.insertMonitorCopy(
						input,
						part,
						monitor,
						`⏰ ${settled.monitorName}\n${withoutMarkerLines(text) || "알릴 내용 없음"}`,
					);
					continue;
				}
				const report = this.postMonitorReport(input, part, eventId, settled.monitorName, monitor, text);
				if (report !== undefined) delivered.push(report);
			}
			return delivered;
		})();
	}

	/**
	 * Settles one waiting event of a `verbatim` monitor in one transaction, without a turn or an inbound row: its stored
	 * payload is the answer and is posted exactly like a turn's report; an empty payload ends as `no_report` with no
	 * post and no copy. With `output` (a cron command's stdout, see `MonitorLedger.settleVerbatim`) that is the answer.
	 * Returns false when the event was not waiting to run.
	 */
	deliverMonitorVerbatim(eventId: number, opRef: string, output?: string): boolean {
		return this.db.transaction((): boolean => {
			const settled = this.monitors.settleVerbatim(eventId, opRef, output);
			if (settled === undefined) return false;
			this.monitors.resolveMonitorIncidents(settled.event.monitorId);
			if (!settled.report) return true;
			const originKey = monitorOrigin(settled.event.monitorId);
			const monitor = this.monitors.getMonitor(settled.event.monitorId);
			this.postMonitorReport(
				{ originKey, opRef },
				0,
				eventId,
				settled.monitorName,
				monitor,
				settled.event.answer ?? "",
			);
			return true;
		})();
	}

	/**
	 * The report of one settled monitor event, shared by the turn and verbatim paths: `⏰ <name>\n<text>` at the top
	 * level of the monitor's channel (the owner DM when it has none), linked to the event, plus its copy.
	 */
	private postMonitorReport(
		input: { originKey: string; opRef: string },
		part: number,
		eventId: number,
		monitorName: string,
		monitor: MonitorRow | undefined,
		text: string,
	): DeliveryRow | undefined {
		const channel = monitor?.channel;
		const body = `⏰ ${monitorName}\n${text}`;
		// The scheduler holds channel-less events while there is no owner home, so this is only a home lost meanwhile.
		const threadRef = channel ? threadRefOf(channel, TOP_LEVEL_TS) : this.ownerTopLevelThreadRef(input);
		const row =
			threadRef === undefined
				? undefined
				: this.insertDelivery({ originKey: input.originKey, opRef: input.opRef, threadRef }, part, body);
		if (row !== undefined) this.monitors.attachDelivery(eventId, row.deliveryId);
		this.insertMonitorCopy(input, part, monitor, body);
		return row;
	}

	/** A top-level copy (`<opRef>:copy`) of a settled monitor event in the monitor's copy channel, if it has one. */
	private insertMonitorCopy(
		input: { originKey: string; opRef: string },
		part: number,
		monitor: MonitorRow | undefined,
		body: string,
	): void {
		if (!monitor?.copyChannel) return;
		this.insertDelivery(
			{
				originKey: input.originKey,
				opRef: `${input.opRef}${MONITOR_COPY_SUFFIX}`,
				threadRef: threadRefOf(monitor.copyChannel, TOP_LEVEL_TS),
			},
			part,
			body,
		);
	}

	private recordMonitorFailure(input: { originKey: string; opRef: string; notice: string }): DeliveryRow | undefined {
		return this.db.transaction(() => {
			const eventIds = this.monitorEventsOfOp(input.originKey, input.opRef);
			this.closeDispatched(input.originKey, input.opRef, "failed_notified");
			let notice: DeliveryRow | undefined;
			for (const eventId of eventIds) notice = this.failMonitorEvent(eventId, input.notice) ?? notice;
			return notice;
		})();
	}

	/**
	 * Counts one failed attempt; the final failure (retries spent, or the first one with `retry: false`) posts a single
	 * notice to the owner DM.
	 */
	failMonitorEvent(eventId: number, error: string, options: { retry?: boolean } = {}): DeliveryRow | undefined {
		return this.db.transaction(() => {
			const settled = this.monitors.settleFailed(eventId, error, options);
			if (!settled?.terminal) return undefined;
			// Without an owner destination the incident is not consumed: a later failure must still alert.
			const target = { originKey: monitorOrigin(settled.event.monitorId), opRef: `monitor-notice:${eventId}` };
			const threadRef = this.ownerAlertThreadRef(target);
			if (threadRef === undefined) return undefined;
			// Same monitor + same normalized error inside the repeat window stays quiet (hermes incident dedup).
			const incident = this.monitors.recordMonitorIncident(settled.event.monitorId, error, this.clock.now());
			if (!incident.notify) return undefined;
			const reason = error.replace(/^\[(?:turn|command) failed\]\s*/, "").replace(/\s+—.*$/, "");
			const repeat = incident.count > 1 ? ` · 반복 ${incident.count}회차` : "";
			return this.insertDelivery(
				{ ...target, threadRef },
				0,
				`⏰ ${settled.monitorName}\n⚠️ 모니터 실행이 ${settled.event.attempts}번 실패해 재시도를 멈췄습니다 (failed_no_retry${repeat}): ${reason}`,
			);
		})();
	}

	/** Reports a check-error alert that has no owner destination; always false so `canAlert` can chain it. */
	private noteUnroutableCheckError(monitorId: string): false {
		this.hooks.onOwnerNoticeUnroutable?.({
			originKey: monitorOrigin(monitorId),
			opRef: `monitor-check-error:${this.clock.now()}`,
		});
		return false;
	}

	/** A script check or watch that keeps failing: one notice at the top of the owner home, like a failed_no_retry one. */
	private postCheckErrorNotice(alert: CheckErrorAlert): void {
		const now = this.clock.now();
		const target = { originKey: monitorOrigin(alert.monitorId), opRef: `monitor-check-error:${now}` };
		const threadRef = this.ownerAlertThreadRef(target);
		if (threadRef === undefined) return;
		const repeat = alert.count > 1 ? ` · 반복 ${alert.count}회차` : "";
		this.insertDelivery(
			{ ...target, threadRef },
			0,
			`⏰ ${alert.monitorName}\n⚠️ 모니터 점검이 ${alert.streak}번 연속 실패했습니다${repeat}: ${alert.error}`,
		);
	}

	// ---- daily cost ledger (`costCap`, src/ops/cost-cap.ts) ----

	/** Adds one finished turn's priced cost to the day's row of its origin (`day` keyed in the bot's zone). */
	addDailyUsage(input: { day: string; originKey: string; cost: number; calls: number }): void {
		this.db
			.query(
				`INSERT INTO usage_daily (day, origin_key, cost, calls) VALUES (?, ?, ?, ?)
				 ON CONFLICT(day, origin_key) DO UPDATE SET cost = cost + excluded.cost, calls = calls + excluded.calls`,
			)
			.run(input.day, input.originKey, input.cost, input.calls);
	}

	/** The day's total cost, or the sum of its rows when `originKey` is given. */
	dailyCost(day: string, originKey?: string): number {
		const row = (
			originKey === undefined
				? this.db.query("SELECT COALESCE(SUM(cost), 0) AS cost FROM usage_daily WHERE day = ?").get(day)
				: this.db
						.query("SELECT COALESCE(SUM(cost), 0) AS cost FROM usage_daily WHERE day = ? AND origin_key = ?")
						.get(day, originKey)
		) as { cost: number } | null;
		return row?.cost ?? 0;
	}

	/** The day's biggest spenders, largest first. */
	topDailyOrigins(day: string, limit: number): Array<{ originKey: string; cost: number }> {
		const rows = this.db
			.query("SELECT origin_key, cost FROM usage_daily WHERE day = ? ORDER BY cost DESC, origin_key LIMIT ?")
			.all(day, limit) as Array<{ origin_key: string; cost: number }>;
		return rows.map((row) => ({ originKey: row.origin_key, cost: row.cost }));
	}

	// ---- `ask` questions the deadline answered (src/safety/choice.ts) ----

	/** Records one `ask` question that closed unanswered and what omp's fallback picked for it. */
	addAutoChoice(input: AutoChoiceInput): void {
		this.db
			.query("INSERT INTO auto_choices (origin_key, thread_ref, question, chosen, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(input.originKey ?? null, input.threadRef ?? null, input.question, input.chosen, input.createdAt);
	}

	// ---- alert incidents (owner-notice repeat suppression) ----

	/**
	 * Counts one occurrence of an alert condition and decides whether the owner should be told (the shared incident
	 * state machine — see `monitors/incidents`): the first occurrence alerts, the same (scope, normalized sign) within
	 * `repeatMs` stays quiet, a still-standing condition re-alerts after `repeatMs`, and a resolved condition that
	 * comes back reopens loudly (monitor incident semantics, used by the turn-failure escalation and the daemon's
	 * gate sweep). `standing` reports the row's pre-call state, so a restarting daemon can rebuild "the owner was
	 * already alerted" from the ledger alone.
	 */
	recordAlertIncident(scope: string, sign: string, now: number, repeatMs = ALERT_INCIDENT_REPEAT_MS): AlertIncident {
		return countIncident(this.db, "alert_incidents", scope, sign, now, repeatMs);
	}

	/** Marks the scope's open incidents resolved, so the same condition re-alerts when it comes back. */
	resolveAlertIncidents(scope: string): void {
		resolveIncidents(this.db, "alert_incidents", scope);
	}

	// ---- herdr prompts (dashboard 마지막 지시) ----

	/**
	 * Records one prompt herdr took as a masked one-line preview, then keeps the agent's newest
	 * `HERDR_PROMPT_ROWS_KEPT` rows and drops every row older than `HERDR_PROMPT_KEEP_MS`.
	 */
	recordHerdrPrompt(input: HerdrPromptInput): void {
		const now = this.clock.now();
		this.db.transaction(() => {
			this.db
				.query("INSERT INTO herdr_prompts (host, agent, kind, preview, origin_key, at) VALUES (?, ?, ?, ?, ?, ?)")
				.run(
					input.host ?? "",
					input.agent,
					input.kind,
					previewLine(input.text, undefined, HERDR_PROMPT_PREVIEW_CHARS),
					input.originKey,
					now,
				);
			this.db
				.query(
					"DELETE FROM herdr_prompts WHERE agent = ? AND id NOT IN (SELECT id FROM herdr_prompts WHERE agent = ? ORDER BY id DESC LIMIT ?)",
				)
				.run(input.agent, input.agent, HERDR_PROMPT_ROWS_KEPT);
			this.db.query("DELETE FROM herdr_prompts WHERE at < ?").run(now - HERDR_PROMPT_KEEP_MS);
		})();
	}

	// ---- turn snapshots (`!undo`) ----

	/**
	 * Appends one turn snapshot and keeps only the newest `TURN_SNAPSHOT_ROWS_KEPT` rows of that origin. The rows dropped
	 * by that bound come back as `pruned` so the caller can delete their refs.
	 */
	recordTurnSnapshot(input: TurnSnapshotInput): { id: number; pruned: TurnSnapshotRow[] } {
		const inserted = this.db
			.query(
				`INSERT INTO turn_snapshots (origin_key, op_ref, repo, head_before, tree_before, head_after, tree_after, started_at, ended_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.originKey,
				input.opRef,
				input.repo,
				input.headBefore,
				input.treeBefore,
				input.headAfter,
				input.treeAfter,
				input.startedAt,
				input.endedAt,
			);
		const id = Number(inserted.lastInsertRowid);
		const overflow = this.db
			.query(
				`SELECT * FROM turn_snapshots WHERE origin_key = ?
				 ORDER BY id DESC LIMIT -1 OFFSET ?`,
			)
			.all(input.originKey, TURN_SNAPSHOT_ROWS_KEPT) as TurnSnapshotSql[];
		const pruned = overflow.map(toTurnSnapshot);
		const drop = this.db.query("DELETE FROM turn_snapshots WHERE id = ?");
		for (const row of pruned) drop.run(row.id);
		return { id, pruned };
	}

	/** Rows newest first; every filter is optional and compared literally. */
	listTurnSnapshots(
		filter: { originKey?: string; repo?: string; opRef?: string; undoable?: boolean } = {},
	): TurnSnapshotRow[] {
		const rows = this.db
			.query(
				`SELECT * FROM turn_snapshots
				 WHERE (?1 IS NULL OR origin_key = ?1) AND (?2 IS NULL OR repo = ?2) AND (?3 IS NULL OR op_ref = ?3)
				   AND (?4 = 0 OR reverted_at IS NULL)
				 ORDER BY id DESC`,
			)
			.all(
				filter.originKey ?? null,
				filter.repo ?? null,
				filter.opRef ?? null,
				filter.undoable === true ? 1 : 0,
			) as TurnSnapshotSql[];
		return rows.map(toTurnSnapshot);
	}

	/**
	 * The origin's most recent turn that can still be undone: its newest `op_ref` among rows with no `reverted_at`.
	 * Returns every repository row of that turn (oldest first), or `[]` when nothing changed or all was undone.
	 */
	latestUndoableTurn(originKey: string): TurnSnapshotRow[] {
		const newest = this.listTurnSnapshots({ originKey, undoable: true })[0];
		if (newest === undefined) return [];
		const rows = this.listTurnSnapshots({ originKey, opRef: newest.opRef, undoable: true });
		return rows.reverse();
	}

	/** Marks a turn's rows as undone at `at`; returns how many rows changed. */
	markTurnReverted(originKey: string, opRef: string, at: number): number {
		return this.db
			.query("UPDATE turn_snapshots SET reverted_at = ? WHERE origin_key = ? AND op_ref = ? AND reverted_at IS NULL")
			.run(at, originKey, opRef).changes;
	}

	// ---- wiki result notes ----

	/** The note's state: its draft JSON, `"sent"`, or `undefined` for a unit never seen. */
	wikiNoteState(sourceId: string): { state: "draft"; draft: string } | { state: "sent" } | undefined {
		const row = this.db.query("SELECT state, draft FROM wiki_notes WHERE source_id = ?").get(sourceId) as {
			state: "draft" | "sent";
			draft: string | null;
		} | null;
		if (row === null) return undefined;
		return row.state === "sent" ? { state: "sent" } : { state: "draft", draft: row.draft ?? "" };
	}

	/** Keeps (or replaces) the unit's draft; a unit already `sent` stays so. */
	saveWikiDraft(sourceId: string, draft: string): void {
		this.db
			.query(
				`INSERT INTO wiki_notes (source_id, state, draft, at) VALUES (?, 'draft', ?, ?)
				 ON CONFLICT(source_id) DO UPDATE SET draft = excluded.draft, at = excluded.at WHERE state = 'draft'`,
			)
			.run(sourceId, draft, this.clock.now());
	}

	dropWikiDraft(sourceId: string): void {
		this.db.query("DELETE FROM wiki_notes WHERE source_id = ? AND state = 'draft'").run(sourceId);
	}

	markWikiNoteSent(sourceId: string): void {
		this.db
			.query(
				`INSERT INTO wiki_notes (source_id, state, draft, at) VALUES (?, 'sent', NULL, ?)
				 ON CONFLICT(source_id) DO UPDATE SET state = 'sent', draft = NULL, at = excluded.at`,
			)
			.run(sourceId, this.clock.now());
	}

	/** Records a committing turn once per repository (a turn is never recorded twice); `true` = a new row. */
	addWikiTurn(input: WikiTurnInput): boolean {
		return (
			this.db
				.query(
					`INSERT INTO wiki_turn_notes (origin_key, op_ref, repo, thread_ref, group_key, day, inbound, conclusion, commits_json, ended_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(origin_key, op_ref, repo) DO NOTHING`,
				)
				.run(
					input.originKey,
					input.opRef,
					input.repo,
					input.threadRef,
					input.groupKey,
					input.day,
					this.redact(input.inbound),
					this.redact(input.conclusion),
					JSON.stringify(input.commits),
					input.endedAt,
				).changes > 0
		);
	}

	/** Turns not yet part of a written note, oldest first. */
	listUnsentWikiTurns(): WikiTurnRow[] {
		return (
			this.db.query("SELECT * FROM wiki_turn_notes WHERE sent_at IS NULL ORDER BY ended_at, id").all() as WikiTurnSql[]
		).map(toWikiTurn);
	}

	markWikiTurnsSent(ids: readonly number[]): void {
		const mark = this.db.query("UPDATE wiki_turn_notes SET sent_at = ? WHERE id = ?");
		const now = this.clock.now();
		this.db.transaction(() => {
			for (const id of ids) mark.run(now, id);
		})();
	}

	/** Drops sent turn rows and `sent` notes older than `before`, and unsent rows that never went out for as long. */
	pruneWikiNotes(before: number): void {
		this.db.query("DELETE FROM wiki_turn_notes WHERE COALESCE(sent_at, ended_at) < ?").run(before);
		this.db.query("DELETE FROM wiki_notes WHERE at < ?").run(before);
	}

	/**
	 * What a turn was asked and how it ended: the first inbound of the op (`text_ref` is already redacted) and the
	 * body of its last delivery part (both `""` when the rows are gone).
	 */
	turnTexts(originKey: string, opRef: string): { inbound: string; conclusion: string } {
		const inbound = this.db
			.query("SELECT text_ref FROM inbound WHERE origin_key = ? AND op_ref = ? ORDER BY inbound_id LIMIT 1")
			.get(originKey, opRef) as { text_ref: string } | null;
		const delivery = this.db
			.query("SELECT body FROM deliveries WHERE origin_key = ? AND op_ref = ? ORDER BY part DESC LIMIT 1")
			.get(originKey, opRef) as { body: string } | null;
		return { inbound: inbound?.text_ref ?? "", conclusion: delivery?.body ?? "" };
	}

	// ---- deliveries ----

	getDelivery(deliveryId: number): DeliveryRow | undefined {
		const row = this.db.query("SELECT * FROM deliveries WHERE delivery_id = ?").get(deliveryId) as DeliverySql | null;
		return row ? toDelivery(row) : undefined;
	}

	listDeliveries(filter: { originKey?: string; state?: DeliveryState } = {}): DeliveryRow[] {
		const rows = this.db
			.query(
				"SELECT * FROM deliveries WHERE (?1 IS NULL OR origin_key = ?1) AND (?2 IS NULL OR state = ?2) ORDER BY delivery_id",
			)
			.all(filter.originKey ?? null, filter.state ?? null) as DeliverySql[];
		return rows.map(toDelivery);
	}

	/**
	 * Confirmed first-part deliveries other origins posted into a thread, oldest first — answers the
	 * thread's own session has never seen (the root's answers come from the parent channel's origin).
	 */
	listThreadForeignDeliveries(threadRef: string, excludeOriginKey: string, limit: number): DeliveryRow[] {
		const rows = this.db
			.query(
				`SELECT * FROM deliveries
				 WHERE thread_ref = ? AND origin_key != ? AND state = 'confirmed' AND part = 0
				 ORDER BY delivery_id DESC LIMIT ?`,
			)
			.all(threadRef, excludeOriginKey, limit) as DeliverySql[];
		return rows.map(toDelivery).reverse();
	}

	/**
	 * The origin's newest answered exchanges of `epoch`, oldest first: each confirmed first answer part with the first
	 * message of the turn it answered (a rotated agy conversation is re-fed these).
	 */
	listOriginExchanges(
		originKey: string,
		epoch: number,
		limit: number,
	): Array<{ question: string; askedAt: number; answer: string; answeredAt: number }> {
		const rows = this.db
			.query(
				`SELECT i.text_ref AS question, i.created_at AS asked_at, d.body AS answer, d.created_at AS answered_at
				 FROM deliveries d JOIN inbound i ON i.inbound_id = (
					SELECT MIN(inbound_id) FROM inbound WHERE origin_key = d.origin_key AND op_ref = d.op_ref AND epoch = ?
				 )
				 WHERE d.origin_key = ? AND d.state = 'confirmed' AND d.part = 0
				 ORDER BY d.delivery_id DESC LIMIT ?`,
			)
			.all(epoch, originKey, limit) as Array<{
			question: string;
			asked_at: number;
			answer: string;
			answered_at: number;
		}>;
		return rows
			.map((row) => ({
				question: row.question,
				askedAt: row.asked_at,
				answer: row.answer,
				answeredAt: row.answered_at,
			}))
			.reverse();
	}

	/** Per-state delivery row counts (`GROUP BY`); lets /status count without loading every body. */
	countDeliveriesByState(): Partial<Record<DeliveryState, number>> {
		const counts: Partial<Record<DeliveryState, number>> = {};
		for (const row of this.db.query("SELECT state, COUNT(*) AS n FROM deliveries GROUP BY state").all() as Array<{
			state: DeliveryState;
			n: number;
		}>) {
			counts[row.state] = row.n;
		}
		return counts;
	}

	/**
	 * Expires pending rows older than 24h. failed_ambiguous rows are never touched. Each expired row waits for its
	 * platform's adapter in `takeExpired` (its thread's status is finished there). Returns how many expired.
	 */
	sweepExpired(): number {
		const now = this.clock.now();
		const expired = this.db.transaction(() =>
			this.selectDeliveries("state = 'pending' AND created_at <= ?", [now - FRESHNESS_MS])
				.map((row) => this.applyEvent(row, "expire_check", now))
				.filter((row) => row.state === "expired"),
		)();
		// Rows of a platform no adapter takes would wait forever: only the newest are kept.
		this.expiredUnfinished.push(...expired);
		this.expiredUnfinished.splice(0, Math.max(0, this.expiredUnfinished.length - EXPIRED_HANDOFF_MAX));
		return expired.length;
	}

	/** The rows `sweepExpired` expired whose thread ref posts to `platform` (all without one), each handed over once. */
	takeExpired(platform?: ChatPlatform): DeliveryRow[] {
		const taken: DeliveryRow[] = [];
		const kept: DeliveryRow[] = [];
		for (const row of this.expiredUnfinished) {
			(platform === undefined || platformOfThreadRef(row.threadRef) === platform ? taken : kept).push(row);
		}
		this.expiredUnfinished = kept;
		return taken;
	}

	/**
	 * Sweeps stale rows, then moves up to `limit` due pending deliveries (next_at <= now) to inflight and returns them.
	 * With `platform` only the rows whose thread ref posts to that platform are taken (monitor and lane answers
	 * included: their thread ref is a chat conversation like any other); the rest stay pending for their adapter.
	 */
	claimDue(limit = 20, platform?: ChatPlatform): DeliveryRow[] {
		const now = this.clock.now();
		this.sweepExpired();
		return this.db.transaction(() =>
			this.selectDeliveries("state = 'pending' AND next_at <= ? ORDER BY delivery_id", [now])
				.filter((row) => platform === undefined || platformOfThreadRef(row.threadRef) === platform)
				.slice(0, limit)
				.map((row) => this.applyEvent(row, "claim", now)),
		)();
	}

	/** The send went out; in the same transaction the peer bots it mentions become calls (`recordPeerCalls`). */
	confirmDelivery(deliveryId: number): DeliveryRow {
		return this.db.transaction(() => {
			const now = this.clock.now();
			const row = this.requireDelivery(deliveryId);
			const confirmed = this.applyEvent(row, "confirmed", now);
			if (row.state !== "confirmed" && confirmed.state === "confirmed") this.recordPeerCalls(confirmed, now);
			return confirmed;
		})();
	}

	// ---- peer calls ----

	/**
	 * A post of `peerUserId` in the thread at `at` (its own time, so a backfilled one counts as when it was written)
	 * answers every pending call to that peer made there before it. Returns how many calls it answered.
	 */
	notePeerSeen(seen: { threadRef: string; peerUserId: string; at: number }): number {
		return this.db
			.query(
				"UPDATE peer_calls SET state = 'answered', settled_at = ? WHERE thread_ref = ? AND peer_user_id = ? AND state = 'pending' AND called_at <= ?",
			)
			.run(this.clock.now(), seen.threadRef, seen.peerUserId, seen.at).changes;
	}

	/**
	 * The calls left unanswered past the policy's silence, one alert per thread and peer: every pending call of that
	 * pair becomes `alerted` and one delivery (`peer-silence:<first call_id>`, so a replay inserts nothing) mentions the
	 * owner in the thread. One transaction. Returns the alerts.
	 */
	alertSilentPeers(): number {
		const policy = this.peerCallPolicy;
		if (policy === undefined) return 0;
		const now = this.clock.now();
		return this.db.transaction(() => {
			this.db.query("DELETE FROM peer_calls WHERE state != 'pending' AND settled_at < ?").run(now - PEER_CALL_KEEP_MS);
			const due = this.db
				.query(
					`SELECT thread_ref, peer_user_id, MIN(call_id) AS first_id, MIN(called_at) AS first_at FROM peer_calls
					 WHERE state = 'pending' GROUP BY thread_ref, peer_user_id HAVING MIN(called_at) <= ? ORDER BY first_id`,
				)
				.all(now - policy.silenceMs) as Array<{
				thread_ref: string;
				peer_user_id: string;
				first_id: number;
				first_at: number;
			}>;
			let alerts = 0;
			for (const group of due) {
				this.db
					.query(
						"UPDATE peer_calls SET state = 'alerted', settled_at = ? WHERE thread_ref = ? AND peer_user_id = ? AND state = 'pending'",
					)
					.run(now, group.thread_ref, group.peer_user_id);
				const thread = parseThreadRef(group.thread_ref);
				const platform = platformOfThreadRef(group.thread_ref);
				if (thread === undefined || platform === undefined) continue;
				const name = policy.peers.find((peer) => peer.userId === group.peer_user_id)?.name ?? group.peer_user_id;
				const minutes = Math.floor((now - group.first_at) / 60_000);
				this.insertDelivery(
					{
						originKey: chatOriginKey({
							platform,
							kind: "ch",
							conversationId: thread.channel,
							threadId: thread.threadTs,
						}),
						opRef: `${PEER_SILENCE_OP_PREFIX}${group.first_id}`,
						threadRef: group.thread_ref,
					},
					0,
					`<@${policy.ownerUserId}> ⚠️ ${name} 무응답 ${minutes}분 — 재시작·VM 교체 뒤 복원 중일 수 있습니다`,
				);
				alerts += 1;
			}
			return alerts;
		})();
	}

	/**
	 * A confirmed Discord thread post (not a channel root, DM, #log or board post, log copy or peer failure notice)
	 * that mentions a policy peer (`<@id>`, `<@!id>` or the core's mention token) is one pending call per peer.
	 */
	private recordPeerCalls(row: DeliveryRow, now: number): void {
		const policy = this.peerCallPolicy;
		if (policy === undefined || row.opRef.endsWith(LOG_COPY_SUFFIX) || row.body.includes(PEER_FAILURE_MARK)) return;
		const thread = parseThreadRef(row.threadRef);
		if (thread === undefined || thread.threadTs === TOP_LEVEL_TS) return;
		if (platformOfThreadRef(row.threadRef) !== "discord" || policy.skipConversations.includes(thread.channel)) return;
		if (parseChatOrigin(row.originKey)?.kind === "dm") return;
		const insert = this.db.query(
			"INSERT INTO peer_calls (thread_ref, peer_user_id, delivery_id, called_at) VALUES (?, ?, ?, ?) ON CONFLICT(delivery_id, peer_user_id) DO NOTHING",
		);
		for (const peer of policy.peers) {
			const tokens = [`<@${peer.userId}>`, `<@!${peer.userId}>`, mentionToken(peer.userId)];
			if (tokens.some((token) => row.body.includes(token))) insert.run(row.threadRef, peer.userId, row.deliveryId, now);
		}
	}

	/** A send that definitely did not happen: backoff, or expired after 5 failures / 24h. */
	failDelivery(deliveryId: number, error: string): DeliveryRow {
		return this.applyEvent(this.requireDelivery(deliveryId), "definitive_failure", this.clock.now(), error);
	}

	/**
	 * The platform refused the send for now (429, or the method still blocked): back to `pending` at `retry.at` without
	 * counting an attempt; `sentParts`/`replyTs` record how far a multi-message answer got, so the resume posts only
	 * the rest. Still expires past the freshness window.
	 */
	deferDelivery(
		deliveryId: number,
		error: string,
		retry: { at: number; sentParts: number; replyTs?: string | undefined },
	): DeliveryRow {
		return this.db.transaction(() => {
			const row = this.applyEvent(this.requireDelivery(deliveryId), "rate_limited", this.clock.now(), error, retry.at);
			if (row.state !== "pending") return row;
			this.db
				.query("UPDATE deliveries SET sent_parts = ?, reply_ts = COALESCE(?, reply_ts) WHERE delivery_id = ?")
				.run(retry.sentParts, retry.replyTs ?? null, deliveryId);
			return this.requireDelivery(deliveryId);
		})();
	}

	/**
	 * A send whose outcome is unknown. Sticky; never resent or expired automatically (the owner resolves it with
	 * `jabbu-pocket deliveries ack|resend`). `sentParts` records how much of a multi-message answer was already out, so a
	 * `resend` continues after them instead of posting them twice, and `replyTs` (the first part's id of a top-level
	 * answer) is kept so the resent parts reply under it.
	 */
	markAmbiguous(deliveryId: number, error: string, sentParts = 0, replyTs?: string): DeliveryRow {
		return this.db.transaction(() => {
			const row = this.applyEvent(this.requireDelivery(deliveryId), "ambiguous", this.clock.now(), error);
			if (row.state !== "failed_ambiguous" || sentParts === 0) return row;
			this.db
				.query("UPDATE deliveries SET sent_parts = ?, reply_ts = COALESCE(?, reply_ts) WHERE delivery_id = ?")
				.run(sentParts, replyTs ?? null, deliveryId);
			return this.requireDelivery(deliveryId);
		})();
	}

	/**
	 * Startup recovery only: a `failed_ambiguous` delivery younger than the freshness window goes back to `pending`
	 * with redelivered=1, so the owner gets it again with the "중복 가능" header. Returns how many were requeued.
	 */
	requeueAmbiguous(): number {
		const now = this.clock.now();
		return this.db
			.query(
				"UPDATE deliveries SET state = 'pending', redelivered = 1, next_at = ? WHERE state = 'failed_ambiguous' AND ? - created_at < ?",
			)
			.run(now, now, FRESHNESS_MS).changes;
	}

	// ---- owner resolution of held deliveries (`jabbu-pocket deliveries`) ----

	/** The held rows waiting for the owner, oldest id first. */
	listAmbiguous(): DeliveryRow[] {
		return listAmbiguousDeliveries(this.db);
	}

	/**
	 * `ack` closes a held row as arrived; `resend` puts it back in the queue now with the duplicate-warning header and
	 * keeps `sentParts`/`replyTs`, so the resend posts only what never went out. Anything else throws `invalid_transition`.
	 */
	resolveAmbiguous(deliveryId: number, how: "ack" | "resend"): DeliveryRow {
		return this.db.transaction(() => this.applyEvent(this.requireDelivery(deliveryId), how, this.clock.now()))();
	}

	/**
	 * Tells the owner once that a row is held: one `ambiguous-notice:<id>` delivery into the held row's own thread,
	 * naming both commands (plus an owner mention outside a 1:1). A notice that is held itself gets none — the owner
	 * already knows — and a repeated call inserts nothing. Returns whether a notice was inserted.
	 */
	noticeAmbiguous(deliveryId: number, ownerUserId: string | undefined): boolean {
		return this.db.transaction(() => {
			const held = this.requireDelivery(deliveryId);
			if (held.state !== "failed_ambiguous" || held.opRef.startsWith(AMBIGUOUS_NOTICE_OP_PREFIX)) return false;
			const opRef = `${AMBIGUOUS_NOTICE_OP_PREFIX}${deliveryId}`;
			const seen = this.db
				.query("SELECT 1 AS seen FROM deliveries WHERE origin_key = ? AND op_ref = ? AND part = 0")
				.get(held.originKey, opRef);
			if (seen !== null) return false;
			const dm = parseChatOrigin(held.originKey)?.kind === "dm";
			const at = dm || ownerUserId === undefined ? "" : `${mentionToken(ownerUserId)} `;
			this.insertDelivery(
				{ originKey: held.originKey, opRef, threadRef: held.threadRef },
				0,
				`${at}⚠️ 전달 불확실 — 답장이 나갔는지 확인할 수 없습니다. 이미 도착했다면 \`jabbu-pocket deliveries ack ${deliveryId}\`, 다시 보내려면 \`jabbu-pocket deliveries resend ${deliveryId}\``,
			);
			return true;
		})();
	}

	// ---- lane board (lane and owner-conversation posts) ----

	/**
	 * Stores one lane board post. The text is redacted first and cut to {@link LANE_BOARD_TEXT_MAX} after: cut first, a
	 * secret split at the limit would no longer match its shape and its head would stay.
	 */
	addLaneBoardPost(input: {
		channel: string;
		authorOrigin: string;
		authorLabel: string;
		text: string;
		replyTo?: number | undefined;
	}): LaneBoardPost {
		const text = cutCodePointSafe(this.redact(input.text), LANE_BOARD_TEXT_MAX);
		const row = this.db
			.query(
				"INSERT INTO board_posts (channel, author_origin, author_label, text, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
			)
			.get(
				input.channel,
				input.authorOrigin,
				input.authorLabel,
				text,
				input.replyTo ?? null,
				this.clock.now(),
			) as LaneBoardPostSql;
		return toLaneBoardPost(row);
	}

	getLaneBoardPost(id: number): LaneBoardPost | undefined {
		const row = this.db.query("SELECT * FROM board_posts WHERE id = ?").get(id) as LaneBoardPostSql | null;
		return row === null ? undefined : toLaneBoardPost(row);
	}

	/** Posts of `channel` after id `after`, oldest first, at most `limit`; `excludeAuthor`'s own posts left out. */
	listLaneBoardPosts(channel: string, after: number, limit: number, excludeAuthor?: string): LaneBoardPost[] {
		const rows = this.db
			.query(
				"SELECT * FROM board_posts WHERE channel = ?1 AND id > ?2 AND (?3 IS NULL OR author_origin != ?3) ORDER BY id LIMIT ?4",
			)
			.all(channel, after, excludeAuthor ?? null, limit) as LaneBoardPostSql[];
		return rows.map(toLaneBoardPost);
	}

	/** How many posts of `channel` after id `after` others than `excludeAuthor` wrote, and the newest id among them. */
	countLaneBoardPosts(channel: string, after: number, excludeAuthor: string): { count: number; maxId: number } {
		const row = this.db
			.query(
				"SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS max_id FROM board_posts WHERE channel = ? AND id > ? AND author_origin != ?",
			)
			.get(channel, after, excludeAuthor) as { n: number; max_id: number };
		return { count: row.n, maxId: row.max_id };
	}

	laneBoardCursor(originKey: string, channel: string): LaneBoardCursor {
		const row = this.db
			.query("SELECT last_read, last_noticed FROM board_reads WHERE origin_key = ? AND channel = ?")
			.get(originKey, channel) as { last_read: number; last_noticed: number } | null;
		return { lastRead: row?.last_read ?? 0, lastNoticed: row?.last_noticed ?? 0 };
	}

	/** Moves `originKey`'s read cursor of `channel` up to `id` (never back). */
	markLaneBoardRead(originKey: string, channel: string, id: number): void {
		this.db
			.query(
				"INSERT INTO board_reads (origin_key, channel, last_read) VALUES (?, ?, ?) ON CONFLICT (origin_key, channel) DO UPDATE SET last_read = MAX(last_read, excluded.last_read)",
			)
			.run(originKey, channel, id);
	}

	/** Moves `originKey`'s announced cursor of `channel` up to `id` (never back). */
	markLaneBoardNoticed(originKey: string, channel: string, id: number): void {
		this.db
			.query(
				"INSERT INTO board_reads (origin_key, channel, last_noticed) VALUES (?, ?, ?) ON CONFLICT (origin_key, channel) DO UPDATE SET last_noticed = MAX(last_noticed, excluded.last_noticed)",
			)
			.run(originKey, channel, id);
	}

	// ---- lanes (work lane registry) ----

	/** New lane in `working`; its origin row is created in the same transaction. Name, thread and origin are unique. */
	insertLane(input: {
		name: string;
		title: string;
		threadRef: string;
		originKey: string;
		cwd: string;
		sessionDir: string;
		meta: LaneMeta;
	}): LaneRow {
		const now = this.clock.now();
		const history: LaneHistoryEntry[] = [{ at: now, event: "created" }];
		this.db.transaction(() => {
			this.ensureOrigin(input.originKey, input.sessionDir);
			this.db
				.query(
					"INSERT INTO lanes (name, title, thread_ref, origin_key, cwd, session_dir, history, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					input.name,
					this.redact(input.title),
					input.threadRef,
					input.originKey,
					input.cwd,
					input.sessionDir,
					JSON.stringify(history),
					JSON.stringify(input.meta),
					now,
					now,
				);
		})();
		return this.requireLane(input.name);
	}

	getLane(name: string): LaneRow | undefined {
		const row = this.db.query("SELECT * FROM lanes WHERE name = ?").get(name) as LaneSql | null;
		return row ? toLane(row) : undefined;
	}

	getLaneByThread(threadRef: string): LaneRow | undefined {
		const row = this.db.query("SELECT * FROM lanes WHERE thread_ref = ?").get(threadRef) as LaneSql | null;
		return row ? toLane(row) : undefined;
	}

	getLaneByOrigin(originKey: string): LaneRow | undefined {
		const row = this.db.query("SELECT * FROM lanes WHERE origin_key = ?").get(originKey) as LaneSql | null;
		return row ? toLane(row) : undefined;
	}

	listLanes(filter: { status?: LaneStatus } = {}): LaneRow[] {
		const rows = this.db
			.query("SELECT * FROM lanes WHERE (?1 IS NULL OR status = ?1) ORDER BY created_at, name")
			.all(filter.status ?? null) as LaneSql[];
		return rows.map(toLane);
	}

	/** Durations (ms) of recently closed lanes ({@link laneDurationSamples}). */
	laneDurationSamples(): number[] {
		return laneDurationSamples(this.db, this.clock.now());
	}

	/** Lanes that still occupy a slot of the concurrency cap (everything but `closed`). */
	countOpenLanes(): number {
		const row = this.db.query("SELECT COUNT(*) AS n FROM lanes WHERE status != 'closed'").get() as { n: number };
		return row.n;
	}

	/** Changes the status (validated against the lane state machine) and appends a history entry in one write. */
	transitionLane(
		name: string,
		to: LaneStatus,
		entry: Omit<LaneHistoryEntry, "at">,
		metaPatch: Partial<LaneMeta> = {},
	): LaneRow {
		const current = this.requireLane(name);
		assertLaneTransition(current.status, to);
		return this.writeLane(current, to, entry, metaPatch);
	}

	/** Appends history and/or merges meta without a status change. */
	patchLane(name: string, entry: Omit<LaneHistoryEntry, "at"> | undefined, metaPatch: Partial<LaneMeta>): LaneRow {
		const current = this.requireLane(name);
		return this.writeLane(current, current.status, entry, metaPatch);
	}

	private writeLane(
		current: LaneRow,
		status: LaneStatus,
		entry: Omit<LaneHistoryEntry, "at"> | undefined,
		metaPatch: Partial<LaneMeta>,
	): LaneRow {
		const now = this.clock.now();
		const history = entry
			? [
					...current.history,
					{ ...entry, ...(entry.detail === undefined ? {} : { detail: this.redact(entry.detail) }), at: now },
				].slice(-MAX_LANE_HISTORY)
			: current.history;
		const meta = { ...current.meta, ...metaPatch };
		this.db
			.query("UPDATE lanes SET status = ?, history = ?, meta = ?, updated_at = ? WHERE name = ?")
			.run(status, JSON.stringify(history), JSON.stringify(meta), now, current.name);
		return this.requireLane(current.name);
	}

	private requireLane(name: string): LaneRow {
		const lane = this.getLane(name);
		if (!lane) throw new StoreError("not_found", `lane ${name}`);
		return lane;
	}

	// ---- lane reservations ----

	/** A new reservation in `waiting`; `startArgs` is stored as given (the caller has redacted it). */
	insertLaneReservation(input: {
		originKey: string;
		threadRef: string;
		repo: string;
		after: readonly string[];
		startArgs: Record<string, unknown>;
		expiresAt: number;
	}): LaneReservation {
		const row = this.db
			.query(
				"INSERT INTO lane_reservations (origin_key, thread_ref, repo, after_json, start_args_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
			)
			.get(
				input.originKey,
				input.threadRef,
				input.repo,
				JSON.stringify(input.after),
				JSON.stringify(input.startArgs),
				this.clock.now(),
				input.expiresAt,
			) as LaneReservationSql;
		return toLaneReservation(row);
	}

	getLaneReservation(id: number): LaneReservation | undefined {
		const row = this.db.query("SELECT * FROM lane_reservations WHERE id = ?").get(id) as LaneReservationSql | null;
		return row ? toLaneReservation(row) : undefined;
	}

	/** Reservations in any of `states`, oldest first. */
	listLaneReservations(states: readonly ReservationState[]): LaneReservation[] {
		const marks = states.map(() => "?").join(",");
		const rows = this.db
			.query(`SELECT * FROM lane_reservations WHERE state IN (${marks}) ORDER BY id`)
			.all(...states) as LaneReservationSql[];
		return rows.map(toLaneReservation);
	}

	/**
	 * Moves a reservation to `to` only while it is in one of `from` (a double click or a tick racing a button changes
	 * it once); `patch` sets the notice signature and the lane it opened. False when it was not in `from`.
	 */
	moveLaneReservation(
		id: number,
		from: readonly ReservationState[],
		to: ReservationState,
		patch: { notice?: string | null; laneName?: string } = {},
	): boolean {
		const marks = from.map(() => "?").join(",");
		const result = this.db
			.query(
				`UPDATE lane_reservations SET state = ?, notice = CASE WHEN ? THEN ? ELSE notice END, lane_name = COALESCE(?, lane_name) WHERE id = ? AND state IN (${marks})`,
			)
			.run(to, "notice" in patch ? 1 : 0, patch.notice ?? null, patch.laneName ?? null, id, ...from);
		return result.changes > 0;
	}

	// ---- internals ----

	/**
	 * Adds `inbound.thread_ref` (backfilled from platform_message_id), `inbound.last_event_at` and the `origins`
	 * session/model columns to databases created before they existed. The `inbound_thread` index lives here too:
	 * it must be created after the `thread_ref` column may have been added above, so a pre-migration ledger can
	 * still be opened. The `approvals_status` index lives here for the same reason: it must be created after the
	 * approvals rebuild may have replaced the table.
	 */
	private migrate(): void {
		const originColumns = this.db.query("PRAGMA table_info(origins)").all() as Array<{ name: string }>;
		for (const column of ["session_file", "model", "thinking"]) {
			if (!originColumns.some((existing) => existing.name === column)) {
				this.db.run(`ALTER TABLE origins ADD COLUMN ${column} TEXT`);
			}
		}
		const columns = this.db.query("PRAGMA table_info(inbound)").all() as Array<{ name: string }>;
		if (!columns.some((column) => column.name === "thread_ref")) {
			this.db.run("ALTER TABLE inbound ADD COLUMN thread_ref TEXT");
		}
		if (!columns.some((column) => column.name === "last_event_at")) {
			this.db.run("ALTER TABLE inbound ADD COLUMN last_event_at INTEGER");
		}
		if (!columns.some((column) => column.name === "peer_user_id")) {
			this.db.run("ALTER TABLE inbound ADD COLUMN peer_user_id TEXT");
		}
		if (!columns.some((column) => column.name === "injected")) {
			this.db.run("ALTER TABLE inbound ADD COLUMN injected INTEGER NOT NULL DEFAULT 0");
		}
		const deliveryColumns = this.db.query("PRAGMA table_info(deliveries)").all() as Array<{ name: string }>;
		if (!deliveryColumns.some((column) => column.name === "sent_parts")) {
			this.db.run("ALTER TABLE deliveries ADD COLUMN sent_parts INTEGER");
		}
		if (!deliveryColumns.some((column) => column.name === "reply_ts")) {
			this.db.run("ALTER TABLE deliveries ADD COLUMN reply_ts TEXT");
		}
		// Schema 7: the removed Teams channel's tables (namespace `teams_`) go with their index; rows were only Teams state.
		const teamsTables = this.db
			.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'teams[_]*'")
			.all() as Array<{ name: string }>;
		for (const { name } of teamsTables) this.db.run(`DROP TABLE IF EXISTS "${name}"`);
		this.db.run("UPDATE inbound SET thread_ref = platform_message_id WHERE thread_ref IS NULL");
		this.db.run(INBOUND_THREAD_INDEX_DDL);
		migrateInbound(this.db);
		this.migrateApprovals();
		this.migrateLanes();
		// After the rebuild (which already creates the dashboard columns): a 'replied'-era table lacks them, and every
		// table lacks `mirror_ref` until this adds it.
		const approvalColumns = this.db.query("PRAGMA table_info(approvals)").all() as Array<{ name: string }>;
		for (const column of ["detail_json", "card_url", "origin_url", "mirror_ref"]) {
			if (!approvalColumns.some((existing) => existing.name === column)) {
				this.db.run(`ALTER TABLE approvals ADD COLUMN ${column} TEXT`);
			}
		}
		// The approvals status index lives here, not in SCHEMA: the rebuild above drops the old table's indexes, so a
		// pre-'replied' ledger would end this open without it; run on every open, the 'pending' scan stays indexed.
		this.db.run("CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status)");
		migrateOldNames(this.db);
	}

	/**
	 * The `replied` status widens a CHECK constraint, which SQLite cannot ALTER: an approvals table without it is
	 * rebuilt (rename, create, copy, drop) in one transaction. Old rows keep their data; the new columns are NULL.
	 */
	private migrateApprovals(): void {
		const current = this.db
			.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approvals'")
			.get() as {
			sql: string;
		} | null;
		if (current === null || current.sql.includes("'replied'")) return;
		this.db.transaction(() => {
			this.db.run("ALTER TABLE approvals RENAME TO approvals_old");
			this.db.run(APPROVALS_DDL);
			this.db.run(
				"INSERT INTO approvals (approval_id, channel, message_ts, summary, status, created_at, expires_at, decided_at) SELECT approval_id, channel, message_ts, summary, status, created_at, expires_at, decided_at FROM approvals_old",
			);
			this.db.run("DROP TABLE approvals_old");
		})();
	}

	/**
	 * The `paused` status widens a CHECK constraint, which SQLite cannot ALTER: a lanes table without it is
	 * rebuilt (rename, create, copy, drop) in one transaction. Existing rows keep their data.
	 */
	private migrateLanes(): void {
		const current = this.db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lanes'").get() as {
			sql: string;
		} | null;
		if (current === null || current.sql.includes("'paused'")) return;
		this.db.transaction(() => {
			this.db.run("ALTER TABLE lanes RENAME TO lanes_old");
			this.db.run(LANES_DDL);
			this.db.run(
				"INSERT INTO lanes (name, title, thread_ref, origin_key, cwd, session_dir, status, history, meta, created_at, updated_at) SELECT name, title, thread_ref, origin_key, cwd, session_dir, status, history, meta, created_at, updated_at FROM lanes_old",
			);
			this.db.run("DROP TABLE lanes_old");
		})();
	}

	private requireOrigin(originKey: string): OriginRow {
		const origin = this.getOrigin(originKey);
		if (!origin) throw new StoreError("unknown_origin", originKey);
		return origin;
	}

	private requireInbound(platformMessageId: string): InboundRow {
		const row = this.getInbound(platformMessageId);
		if (!row) throw new StoreError("not_found", `inbound ${platformMessageId}`);
		return row;
	}

	private requireDelivery(deliveryId: number): DeliveryRow {
		const row = this.getDelivery(deliveryId);
		if (!row) throw new StoreError("not_found", `delivery ${deliveryId}`);
		return row;
	}

	private selectDeliveries(where: string, params: (string | number)[]): DeliveryRow[] {
		return (this.db.query(`SELECT * FROM deliveries WHERE ${where}`).all(...params) as DeliverySql[]).map(toDelivery);
	}

	private closeDispatched(originKey: string, opRef: string, to: "answered" | "failed_notified"): void {
		assertInboundTransition("dispatched", to);
		this.db
			.query("UPDATE inbound SET state = ? WHERE origin_key = ? AND op_ref = ? AND state = 'dispatched'")
			.run(to, originKey, opRef);
	}

	private insertDelivery(
		input: { originKey: string; opRef: string; threadRef: string },
		part: number,
		body: string,
	): DeliveryRow {
		const now = this.clock.now();
		const inserted = this.db
			.query(
				"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(origin_key, op_ref, part) DO NOTHING",
			)
			.run(input.originKey, input.opRef, part, input.threadRef, this.redact(body), now, now);
		const row = toDelivery(
			this.db
				.query("SELECT * FROM deliveries WHERE origin_key = ? AND op_ref = ? AND part = ?")
				.get(input.originKey, input.opRef, part) as DeliverySql,
		);
		if (inserted.changes === 1) this.emitDeliveryState(row.deliveryId, "new", row.state);
		return row;
	}

	private applyEvent(
		row: DeliveryRow,
		event: DeliveryEvent,
		now: number,
		error?: string,
		retryAt?: number,
	): DeliveryRow {
		const facts: DeliveryFacts = {
			state: row.state,
			attempts: row.attempts,
			nextAt: row.nextAt,
			redelivered: row.redelivered,
			createdAt: row.createdAt,
		};
		const next = transitionDelivery(facts, event, now, retryAt);
		if (next === facts) return row;
		applyDeliveryFacts(this.db, row.deliveryId, next, error === undefined ? null : this.redact(error));
		this.emitDeliveryState(row.deliveryId, row.state, next.state);
		return this.requireDelivery(row.deliveryId);
	}

	/** A failing observer (e.g. a full disk under the logger) must never abort or roll back a ledger transition. */
	private emitDeliveryState(deliveryId: number, from: DeliveryState | "new", to: DeliveryState): void {
		try {
			this.hooks.onDeliveryState?.({ deliveryId, from, to });
		} catch {
			// observers only; the transition itself is already durable
		}
	}
}

/** The one UPDATE every delivery transition writes; a null error keeps the row's stored one. */
function applyDeliveryFacts(db: Database, deliveryId: number, next: DeliveryFacts, error: string | null): void {
	db.query(
		"UPDATE deliveries SET state = ?, attempts = ?, next_at = ?, redelivered = ?, last_error = COALESCE(?, last_error) WHERE delivery_id = ?",
	).run(next.state, next.attempts, next.nextAt, next.redelivered ? 1 : 0, error, deliveryId);
}

const deliveryFactsOf = (row: DeliverySql): DeliveryFacts => ({
	state: row.state,
	attempts: row.attempts,
	nextAt: row.next_at,
	redelivered: row.redelivered === 1,
	createdAt: row.created_at,
});

/** The `failed_ambiguous` rows waiting for the owner, oldest id first (the `jabbu-pocket deliveries list` list). */
export function listAmbiguousDeliveries(db: Database): DeliveryRow[] {
	return (
		db.query("SELECT * FROM deliveries WHERE state = 'failed_ambiguous' ORDER BY delivery_id").all() as DeliverySql[]
	).map(toDelivery);
}

/**
 * The owner's manual resolution on a bare connection: `transitionDelivery` refuses any row that is not
 * `failed_ambiguous`, so the UPDATE only ever closes a held row. Shared by `Store.resolveAmbiguous` semantics; no
 * hooks fire on this path (the CLI process has none).
 */
export function resolveAmbiguousDelivery(
	db: Database,
	now: number,
	deliveryId: number,
	how: "ack" | "resend",
): DeliveryRow {
	const raw = db.query("SELECT * FROM deliveries WHERE delivery_id = ?").get(deliveryId) as DeliverySql | null;
	if (raw === null) throw new StoreError("not_found", `delivery ${deliveryId}`);
	applyDeliveryFacts(db, deliveryId, transitionDelivery(deliveryFactsOf(raw), how, now), null);
	return toDelivery(db.query("SELECT * FROM deliveries WHERE delivery_id = ?").get(deliveryId) as DeliverySql);
}

export function openStore(options: StoreOptions): Store {
	return new Store(options);
}

/**
 * A second process's view of the ledger for `jabbu-pocket deliveries`: it resolves held rows the daemon owns without taking
 * over its work. The file must already exist (`create: false`), a newer schema is refused, and no boot recovery runs —
 * the daemon's inflight rows and its recovered ones are none of this connection's business.
 */
export class DeliveryLedger {
	readonly #db: Database;
	readonly #clock: StoreClock;

	constructor(db: Database, clock: StoreClock = { now: () => Date.now() }) {
		this.#db = db;
		this.#clock = clock;
	}

	listAmbiguous(): DeliveryRow[] {
		return listAmbiguousDeliveries(this.#db);
	}

	resolveAmbiguous(deliveryId: number, how: "ack" | "resend"): DeliveryRow {
		// IMMEDIATE: the resolve reads the row, then writes it. A deferred transaction that reads first fails at once with
		// SQLITE_BUSY (busy_timeout never applies) when the daemon commits in between; this one waits for the lock.
		return this.#db
			.transaction(() => resolveAmbiguousDelivery(this.#db, this.#clock.now(), deliveryId, how))
			.immediate();
	}

	close(): void {
		this.#db.close();
	}
}

/** Opens the ledger of an existing home for {@link DeliveryLedger}; missing file, bad schema and open errors throw. */
export function openDeliveryLedger(path: string, clock?: StoreClock): DeliveryLedger {
	const db = new Database(path, { create: false, strict: true });
	try {
		checkSchemaVersion(db);
		db.run("PRAGMA busy_timeout = 5000");
	} catch (error) {
		db.close();
		throw error;
	}
	return new DeliveryLedger(db, clock);
}
