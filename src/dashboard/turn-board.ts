import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TOP_LEVEL_TS } from "../core/normalize";
import { COMMAND_TEXT, parseCommand } from "../core/types";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { INBOUND_STARVATION_MS } from "../ops/gates";
import { redact } from "../redact";
import type { ContextLoad } from "./context-load";
import type { PeerInstall } from "./peers";
import { previewLine } from "./preview-line";
import type { SessionModel } from "./session-model";

const TURN_LIMIT = 200;
/** A thread with no open turn stays on the board this long after its last activity. */
const THREAD_WINDOW_MS = 24 * 3_600_000;
const THREAD_LIMIT = 200;
const THREAD_RECENT = 20;
const AUTO_FOLLOWUP_PREFIX = "[자동 후속";
const ERROR_CHARS = 200;

const TURN_COLUMNS = `inbound_id, platform_message_id, origin_key, text_ref, thread_ref, created_at, dispatched_at,
	last_event_at, CASE state WHEN 'sending' THEN 'dispatched' ELSE state END AS state`;

export interface TurnInfo {
	inboundId: number;
	originKey: string;
	threadRef: string | null;
	state: string;
	createdAt: string;
	ageMs: number;
	/** Dispatched turns: time since the last event, else since dispatch (`inbound_starved`'s measure); null for pending. */
	silentMs: number | null;
	/**
	 * `inbound_starved`'s rule for this turn: dispatched, silent past {@link INBOUND_STARVATION_MS}, and its origin is
	 * not waiting on a live approval card (pending, `expires_at` not passed).
	 */
	stalled: boolean;
	kind: TurnKind;
	/** The request in one masked line of at most `PREVIEW_CHARS` chars; null for monitor turns. */
	preview: string | null;
	/** Why a pending row waits; null once dispatched. */
	waitReason: TurnWaitReason | null;
	/** A dispatched turn a restart drain is waiting for. */
	blocksRestart: boolean;
	/** Posted at the top level of its conversation (thread ref `<channel>:-`), not inside a thread. */
	topLevel: boolean;
	/** Typed as a slash command (`slash:` platform message id). */
	slash: boolean;
	/** Peer install name (`dashboard.peerHomes`); absent for the dashboard's own turns. */
	install?: string;
}

export type TurnKind = "message" | "command" | "auto" | "monitor";
export type TurnWaitReason = "restart" | "frozen" | "followup" | "behind" | "queued";

/** A thread's turn-board column: someone should look · a turn is open · every turn has ended. */
type ThreadColumn = "attention" | "working" | "done";

/** One turn of a thread as its detail lists it. */
interface ThreadTurn {
	inboundId: number;
	state: string;
	createdAt: string;
	/** The request in one masked line of at most `PREVIEW_CHARS` chars; null for monitor turns. */
	preview: string | null;
}

/**
 * One conversation of the turn board (origin = chat thread = omp session): open turns or activity in the last
 * {@link THREAD_WINDOW_MS}. Of message bodies only masked one-line previews are here.
 */
export interface ThreadInfo {
	originKey: string;
	threadRef: string | null;
	/** The last turn's kind. */
	kind: TurnKind;
	/** The thread's first turn as one masked line; a monitor's name for monitor threads. */
	title: string;
	/** attention: an open turn is stalled, or none is open and the last failed · working: a turn is open · done. */
	column: ThreadColumn;
	latest: ThreadTurn & Pick<TurnInfo, "ageMs" | "silentMs" | "stalled" | "waitReason">;
	/** Turns open or active within {@link THREAD_WINDOW_MS}. */
	turnCount: number;
	/** pending + dispatched turns. */
	openCount: number;
	/**
	 * omp runs behind the dispatched turns: messages steered into a running turn share its `op_ref`, so three rows
	 * can be one run.
	 */
	runCount: number;
	/** Open turns still pending (not handed to omp yet). */
	pendingCount: number;
	/** Open turns {@link TurnInfo.stalled} marks. */
	stalledCount: number;
	/** Last activity: the newest `COALESCE(last_event_at, dispatched_at, created_at)` of its turns. */
	updatedAt: string;
	/** Newest first, at most {@link THREAD_RECENT}. */
	recent: ThreadTurn[];
	/** Active running job names (`ok` or `stale`) whose `thread` matches `threadRef`, newest `updatedAt` first. */
	jobs?: string[];
	/** The model and thinking its omp session runs with ({@link SessionModel}); absent when unknown (no chip). */
	model?: SessionModel;
	/** Its session's context use ({@link ContextLoad}); absent when unknown (no bar). */
	context?: ContextLoad;
	/** Peer install name (`dashboard.peerHomes`); absent for the dashboard's own threads. */
	install?: string;
}

export interface PeerTurnError {
	install: string;
	error: string;
}

interface TurnSql {
	inbound_id: number;
	platform_message_id: string;
	origin_key: string;
	text_ref: string;
	thread_ref: string | null;
	state: string;
	created_at: number;
	dispatched_at: number | null;
	last_event_at: number | null;
}

export interface ActiveJobRef {
	name: string;
	state: string | null;
	health: string;
	thread?: string;
	updatedAt: string;
}

export interface TurnsSectionDeps {
	now: number;
	iso: (ms: number) => string;
	draining: boolean;
	frozen: boolean;
	activeJobs: ActiveJobRef[];
	peers?: PeerInstall[];
	sessionModel: (origin: {
		sessionDir: string;
		sessionFile: string | null;
		model: string | null;
		thinking: string | null;
	}) => SessionModel | undefined;
}

/** Rows of a read-only query; a database that predates the table simply has none. */
export function rows<T>(db: Database, sql: string, ...params: Array<string | number>): T[] {
	try {
		return db.query(sql).all(...params) as T[];
	} catch (error) {
		if (error instanceof Error && /no such table/.test(error.message)) return [];
		throw error;
	}
}

function readInstallTurns(
	handle: Database,
	opts: Omit<TurnsSectionDeps, "peers"> & { install?: string },
): { items: TurnInfo[]; threads: ThreadInfo[] } {
	const { now, iso, draining, frozen, activeJobs, sessionModel, install } = opts;
	const isPeer = install !== undefined;
	// `sending` (the write-ahead before a prompt or steer) counts as running: TURN_COLUMNS reads it as `dispatched`.
	const openStates = isPeer ? "('pending','sending','dispatched')" : "('pending','sending','dispatched','uncertain')";
	const open = rows<TurnSql>(
		handle,
		`SELECT ${TURN_COLUMNS} FROM inbound WHERE state IN ${openStates} ORDER BY created_at, inbound_id LIMIT ?`,
		TURN_LIMIT,
	);
	// Origins waiting on a live approval card, as `inbound_starved` counts them: a card past `expires_at` waits
	// on nobody even while its row still reads `pending`.
	const approvalColumns = new Set(
		rows<{ name: string }>(handle, "PRAGMA table_info(approvals)").map((column) => column.name),
	);
	const waitingOnOwner = new Set(
		approvalColumns.has("origin_key")
			? rows<{ origin_key: string }>(
					handle,
					`SELECT DISTINCT origin_key FROM approvals WHERE status = 'pending' AND origin_key IS NOT NULL${
						approvalColumns.has("expires_at") ? " AND expires_at > ?" : ""
					}`,
					...(approvalColumns.has("expires_at") ? [now] : []),
				).map((r) => r.origin_key)
			: [],
	);
	const running = new Set(open.filter((r) => r.state === "dispatched").map((r) => r.origin_key));
	const turnOf = (r: TurnSql): TurnInfo => {
		const slash = r.platform_message_id.startsWith("slash:");
		const command = parseCommand(r.text_ref);
		const kind: TurnKind = r.origin_key.startsWith(MONITOR_ORIGIN_PREFIX)
			? "monitor"
			: command !== undefined || slash
				? "command"
				: r.text_ref.trimStart().startsWith(AUTO_FOLLOWUP_PREFIX)
					? "auto"
					: "message";
		const request =
			command === undefined
				? r.text_ref
				: `${COMMAND_TEXT[command.kind]}${command.arg === "" ? "" : ` ${command.arg}`}`;
		let waitReason: TurnWaitReason | null = null;
		if (r.state === "pending") {
			if (!isPeer && draining) waitReason = "restart";
			else if (!isPeer && frozen) waitReason = "frozen";
			else if (command?.kind === "followup") waitReason = "followup";
			else if (running.has(r.origin_key)) waitReason = "behind";
			else waitReason = "queued";
		}
		const lastSign = r.state === "dispatched" ? (r.last_event_at ?? r.dispatched_at) : null;
		const silentMs = lastSign === null ? null : now - lastSign;
		return {
			inboundId: r.inbound_id,
			originKey: r.origin_key,
			threadRef: r.thread_ref,
			state: r.state,
			createdAt: iso(r.created_at),
			ageMs: now - r.created_at,
			silentMs,
			stalled:
				r.dispatched_at !== null &&
				silentMs !== null &&
				silentMs > INBOUND_STARVATION_MS &&
				!waitingOnOwner.has(r.origin_key),
			kind,
			preview: kind === "monitor" ? null : previewLine(request),
			waitReason,
			blocksRestart: !isPeer && draining && r.state === "dispatched",
			topLevel: r.thread_ref?.endsWith(`:${TOP_LEVEL_TS}`) === true,
			slash,
			...(install === undefined ? {} : { install }),
		};
	};
	const brief = (turn: TurnInfo): ThreadTurn => ({
		inboundId: turn.inboundId,
		state: turn.state,
		createdAt: turn.createdAt,
		preview: turn.preview,
	});
	const since = now - THREAD_WINDOW_MS;
	const ACTIVE = "COALESCE(last_event_at, dispatched_at, created_at)";
	const threadModel = (key: string): SessionModel | undefined => {
		try {
			const [origin] = rows<{
				session_dir: string;
				session_file: string | null;
				model: string | null;
				thinking: string | null;
			}>(handle, "SELECT session_dir, session_file, model, thinking FROM origins WHERE origin_key = ?", key);
			return origin === undefined
				? undefined
				: sessionModel({
						sessionDir: origin.session_dir,
						sessionFile: origin.session_file,
						model: origin.model,
						thinking: origin.thinking,
					});
		} catch {
			return undefined;
		}
	};
	const monitorNames = new Map(
		rows<{ id: string; name: string }>(handle, "SELECT id, name FROM monitors").map((m) => [m.id, m.name]),
	);
	const activeThreads = [...new Set(activeJobs.map((job) => job.thread as string))];
	const jobSelect =
		activeThreads.length === 0
			? "0 AS has_job"
			: `MAX(CASE WHEN thread_ref IN (${activeThreads.map(() => "?").join(",")}) THEN 1 ELSE 0 END) AS has_job`;
	const having = isPeer ? "open > 0" : "open > 0 OR active >= ? OR has_job > 0";
	const threadRows = rows<{ origin_key: string; active: number }>(
		handle,
		`SELECT origin_key, MAX(${ACTIVE}) AS active, SUM(CASE WHEN state IN ${openStates} THEN 1 ELSE 0 END) AS open, ${jobSelect} FROM inbound
			GROUP BY origin_key HAVING ${having} ORDER BY (open > 0 OR has_job > 0) DESC, active DESC LIMIT ?`,
		...activeThreads,
		...(isPeer ? [] : [since]),
		THREAD_LIMIT,
	);
	const threads = threadRows.flatMap((thread): ThreadInfo[] => {
		const key = thread.origin_key;
		const recent = rows<TurnSql>(
			handle,
			`SELECT ${TURN_COLUMNS} FROM inbound WHERE origin_key = ? ORDER BY created_at DESC, inbound_id DESC LIMIT ?`,
			key,
			THREAD_RECENT,
		).map(turnOf);
		const [first] = rows<TurnSql>(
			handle,
			`SELECT ${TURN_COLUMNS} FROM inbound WHERE origin_key = ? ORDER BY created_at, inbound_id LIMIT 1`,
			key,
		).map(turnOf);
		const latest = recent[0];
		if (latest === undefined || first === undefined) return [];
		const openTurns = rows<TurnSql>(
			handle,
			`SELECT ${TURN_COLUMNS} FROM inbound WHERE origin_key = ? AND state IN ${openStates}`,
			key,
		).map(turnOf);
		const [count] = rows<{ n: number }>(
			handle,
			`SELECT COUNT(*) AS n FROM inbound WHERE origin_key = ? AND (state IN ${openStates} OR ${ACTIVE} >= ?)`,
			key,
			since,
		);
		const [runs] = rows<{ n: number }>(
			handle,
			`SELECT COUNT(DISTINCT COALESCE(op_ref, 'row:' || inbound_id)) AS n FROM inbound
				WHERE origin_key = ? AND state = 'dispatched'`,
			key,
		);
		const stalledCount = openTurns.filter((turn) => turn.stalled).length;
		const threadRef = latest.threadRef ?? first.threadRef;
		const threadJobs =
			threadRef === null ? [] : activeJobs.filter((job) => job.thread === threadRef).map((job) => job.name);
		const column: ThreadColumn =
			stalledCount > 0 ||
			openTurns.some((turn) => turn.state === "uncertain") ||
			(openTurns.length === 0 && latest.state === "failed_notified")
				? "attention"
				: openTurns.length > 0 || threadJobs.length > 0
					? "working"
					: "done";
		const monitor = key.startsWith(MONITOR_ORIGIN_PREFIX)
			? (monitorNames.get(key.slice(MONITOR_ORIGIN_PREFIX.length)) ?? key)
			: undefined;
		const model = threadModel(key);
		return [
			{
				originKey: install === undefined ? key : `${install}:${key}`,
				threadRef,
				kind: latest.kind,
				title: `${install === undefined ? "" : `${install} · `}${monitor ?? first.preview ?? key}`,
				column,
				latest: {
					...brief(latest),
					ageMs: latest.ageMs,
					silentMs: latest.silentMs,
					stalled: latest.stalled,
					waitReason: latest.waitReason,
				},
				turnCount: count?.n ?? 0,
				openCount: openTurns.length,
				runCount: runs?.n ?? 0,
				pendingCount: openTurns.filter((turn) => turn.state === "pending").length,
				stalledCount,
				updatedAt: iso(thread.active),
				recent: recent.map(brief),
				...(threadJobs.length === 0 ? {} : { jobs: threadJobs }),
				...(model === undefined ? {} : { model }),
				...(install === undefined ? {} : { install }),
			},
		];
	});
	return { items: open.map(turnOf), threads };
}

/**
 * Own open turns and recent threads, plus each peer install's open (`pending`/`dispatched`) turns read-only.
 * A missing or unreadable peer database records one masked line in `peerErrors` without failing the own turns.
 */
export function buildTurnsSection(
	handle: Database,
	opts: TurnsSectionDeps,
): { items: TurnInfo[]; threads: ThreadInfo[]; peerErrors?: PeerTurnError[] } {
	const own = readInstallTurns(handle, opts);
	const items = [...own.items];
	const threads = [...own.threads];
	const peerErrors: PeerTurnError[] = [];
	for (const peer of opts.peers ?? []) {
		const peerDbPath = join(peer.home, "jabbu.db");
		if (!existsSync(peerDbPath)) {
			peerErrors.push({ install: peer.name, error: "jabbu.db가 없음" });
			continue;
		}
		let peerDb: Database | undefined;
		try {
			peerDb = new Database(peerDbPath, { readonly: true, strict: true });
			const peerTurns = readInstallTurns(peerDb, {
				...opts,
				draining: false,
				frozen: false,
				activeJobs: [],
				install: peer.name,
			});
			items.push(...peerTurns.items);
			threads.push(...peerTurns.threads);
		} catch (error) {
			const detail = redact(error instanceof Error ? error.message : String(error))
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, ERROR_CHARS);
			peerErrors.push({ install: peer.name, error: `db를 읽지 못함: ${detail}` });
		} finally {
			peerDb?.close();
		}
	}
	return { items, threads, ...(peerErrors.length === 0 ? {} : { peerErrors }) };
}
