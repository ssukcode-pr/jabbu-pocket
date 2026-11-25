import { CARD_ANSWERS_DDL } from "./card-answers";
import { LEGACY_FEEDBACK_DDL } from "./legacy-ddl";

/**
 * Approval card ledger. `origin_key`/`origin_thread_ref` map a card back to the conversation that asked (NULL on rows
 * from before the mapping existed), `reply_ts`/`reply_text` hold the owner's thread reply that settled it as `replied`.
 * `detail_json` holds the card's redacted, cut structured sections and `card_url`/`origin_url` the card and asking-thread
 * permalinks, for the dashboard (all NULL on older rows, when absent or when the permalink lookup failed).
 * `mirror_ref` (`<channel>:<ts>`, added by `migrate`) is the card's copy in the asking thread, NULL without one.
 */
export const APPROVALS_DDL = `CREATE TABLE IF NOT EXISTS approvals (
	approval_id TEXT PRIMARY KEY,
	channel TEXT NOT NULL,
	message_ts TEXT NOT NULL,
	summary TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending','approved','denied','expired','replied')),
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	decided_at INTEGER,
	origin_key TEXT,
	origin_thread_ref TEXT,
	reply_ts TEXT,
	reply_text TEXT,
	detail_json TEXT,
	card_url TEXT,
	origin_url TEXT
);`;

export const LANES_DDL = `CREATE TABLE IF NOT EXISTS lanes (
	name TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	thread_ref TEXT NOT NULL UNIQUE,
	origin_key TEXT NOT NULL UNIQUE,
	cwd TEXT NOT NULL,
	session_dir TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'working'
		CHECK (status IN ('working','done-claimed','not-done','paused','closed')),
	history TEXT NOT NULL DEFAULT '[]',
	meta TEXT NOT NULL DEFAULT '{}',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);`;

/** Lane start reservations; `notice` and `lane_name` are the ledger's own bookkeeping. */
const LANE_RESERVATIONS_DDL = `CREATE TABLE IF NOT EXISTS lane_reservations (
	id INTEGER PRIMARY KEY,
	origin_key TEXT NOT NULL,
	thread_ref TEXT NOT NULL,
	repo TEXT NOT NULL,
	after_json TEXT NOT NULL,
	start_args_json TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'waiting'
		CHECK (state IN ('waiting','ready','started','cancelled','expired')),
	notice TEXT,
	lane_name TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lane_reservations_state ON lane_reservations(state);`;

/**
 * Turn snapshot ledger for `!undo`: one row per repository a conversation turn changed, with
 * the git trees before and after it. `reverted_at` marks a turn already put back (NULL = still undoable).
 */
const TURN_SNAPSHOTS_DDL = `CREATE TABLE IF NOT EXISTS turn_snapshots (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	origin_key TEXT NOT NULL,
	op_ref TEXT NOT NULL,
	repo TEXT NOT NULL,
	head_before TEXT NOT NULL,
	tree_before TEXT NOT NULL,
	head_after TEXT NOT NULL,
	tree_after TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	ended_at INTEGER NOT NULL,
	reverted_at INTEGER
);
CREATE INDEX IF NOT EXISTS turn_snapshots_origin ON turn_snapshots(origin_key, id);
CREATE INDEX IF NOT EXISTS turn_snapshots_ended ON turn_snapshots(ended_at);`;

/**
 * Wiki result notes (`src/wiki`). `wiki_notes`: one row per note `source_id`, a `draft` (collected before a landing
 * removes its worktree and branch) until the note is written, then `sent`: a unit is written once, restarts included.
 * `wiki_turn_notes`: one row per committing conversation turn and repository, kept here because `turn_snapshots` keeps
 * 20 rows per origin and is gc'd; the grouping into one note per thread and day is made when the day is over.
 */
const WIKI_NOTES_DDL = `CREATE TABLE IF NOT EXISTS wiki_notes (
	source_id TEXT PRIMARY KEY,
	state TEXT NOT NULL CHECK (state IN ('draft','sent')),
	draft TEXT,
	at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wiki_turn_notes (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	origin_key TEXT NOT NULL,
	op_ref TEXT NOT NULL,
	repo TEXT NOT NULL,
	thread_ref TEXT NOT NULL,
	group_key TEXT NOT NULL,
	day TEXT NOT NULL,
	inbound TEXT NOT NULL,
	conclusion TEXT NOT NULL,
	commits_json TEXT NOT NULL,
	ended_at INTEGER NOT NULL,
	sent_at INTEGER,
	UNIQUE (origin_key, op_ref, repo)
);
CREATE INDEX IF NOT EXISTS wiki_turn_notes_unsent ON wiki_turn_notes(sent_at, day);`;

/**
 * The last instructions given to herdr agents, for the dashboard card's 마지막 지시 line
 *: one masked one-line preview per prompt, never the text itself.
 * `host` is '' for local herdr.
 */
const HERDR_PROMPTS_DDL = `CREATE TABLE IF NOT EXISTS herdr_prompts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	host TEXT NOT NULL,
	agent TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('start','followup','remind')),
	preview TEXT NOT NULL,
	origin_key TEXT,
	at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS herdr_prompts_agent ON herdr_prompts(agent, id);`;

/**
 * One peer bot mentioned by one confirmed delivery: `pending` until a post of that
 * peer in the thread (`answered`), the silence alert (`alerted`) or the alert switched off (`skipped`). UNIQUE keeps
 * a re-confirmed delivery from adding a second call.
 */
const PEER_CALLS_DDL = `CREATE TABLE IF NOT EXISTS peer_calls (
	call_id INTEGER PRIMARY KEY,
	thread_ref TEXT NOT NULL,
	peer_user_id TEXT NOT NULL,
	delivery_id INTEGER NOT NULL,
	called_at INTEGER NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','answered','alerted','skipped')),
	settled_at INTEGER,
	UNIQUE (delivery_id, peer_user_id)
);
CREATE INDEX IF NOT EXISTS peer_calls_state_called ON peer_calls(state, called_at);
CREATE INDEX IF NOT EXISTS peer_calls_thread_peer ON peer_calls(thread_ref, peer_user_id, state);`;
/** Settled calls are kept this long (the sweep prunes older ones). */
export const PEER_CALL_KEEP_MS = 30 * 24 * 60 * 60_000;

/**
 * The lane board: posts of lanes and owner conversations by channel (`general`,
 * `repo:<path>`), and per reader and channel the last post read and the last post a turn prompt announced.
 */
/**
 * Same message id re-received with other content (`Store.recordInbound`): the first row stays, this table only counts
 * the re-receipts for the ops view (`jabbu-pocket gates`, `inbound_identity_conflicts`).
 */
const INBOUND_CONFLICTS_DDL = `CREATE TABLE IF NOT EXISTS inbound_conflicts (
	conflict_id INTEGER PRIMARY KEY AUTOINCREMENT,
	platform_message_id TEXT NOT NULL,
	origin_key TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inbound_conflicts_at ON inbound_conflicts(created_at);`;

const LANE_BOARD_DDL = `CREATE TABLE IF NOT EXISTS board_posts (
	id INTEGER PRIMARY KEY,
	channel TEXT NOT NULL,
	author_origin TEXT NOT NULL,
	author_label TEXT NOT NULL,
	text TEXT NOT NULL,
	reply_to INTEGER,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS board_posts_channel_id ON board_posts(channel, id);
CREATE TABLE IF NOT EXISTS board_reads (
	origin_key TEXT NOT NULL,
	channel TEXT NOT NULL,
	last_read INTEGER NOT NULL DEFAULT 0,
	last_noticed INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (origin_key, channel)
);`;
/** Longest stored board post (UTF-16 units), cut after redaction. */
export const LANE_BOARD_TEXT_MAX = 2_000;

/**
 * The inbound ledger. `sending` is written right before a prompt or steer; `uncertain` parks an input that may already
 * have reached the omp child (`uncertain_reason`, `uncertain_at`). A ledger without either is rebuilt (`db-sending.ts`).
 * `injected` is 1 for a row `jabbu-pocket inject` put in (`OwnerIngest.injected`): it may not answer an ask card.
 */
export const INBOUND_DDL = `CREATE TABLE IF NOT EXISTS inbound (
	inbound_id INTEGER PRIMARY KEY AUTOINCREMENT,
	platform_message_id TEXT NOT NULL UNIQUE,
	origin_key TEXT NOT NULL REFERENCES origins(origin_key),
	epoch INTEGER NOT NULL,
	text_ref TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending'
		CHECK (state IN ('pending','sending','dispatched','answered','failed_notified','discarded','uncertain')),
	created_at INTEGER NOT NULL,
	dispatched_at INTEGER,
	op_ref TEXT,
	entry_cursor TEXT,
	thread_ref TEXT,
	last_event_at INTEGER,
	peer_user_id TEXT,
	uncertain_reason TEXT,
	uncertain_at INTEGER,
	injected INTEGER NOT NULL DEFAULT 0
);`;

export const INBOUND_INDEXES_DDL = `CREATE INDEX IF NOT EXISTS inbound_origin_state ON inbound(origin_key, state);
CREATE INDEX IF NOT EXISTS inbound_state ON inbound(state);
CREATE INDEX IF NOT EXISTS inbound_origin_op ON inbound(origin_key, op_ref);
CREATE INDEX IF NOT EXISTS inbound_origin_created ON inbound(origin_key, created_at);
CREATE INDEX IF NOT EXISTS inbound_created ON inbound(created_at);
CREATE INDEX IF NOT EXISTS inbound_state_dispatched ON inbound(state, dispatched_at);`;

/** Created by `migrate`, not `SCHEMA`: a pre-`thread_ref` ledger has no such column when `SCHEMA` runs. */
export const INBOUND_THREAD_INDEX_DDL = "CREATE INDEX IF NOT EXISTS inbound_thread ON inbound(thread_ref)";

export const INBOUND_INDEX_NAMES = [
	"inbound_origin_state",
	"inbound_state",
	"inbound_origin_op",
	"inbound_origin_created",
	"inbound_created",
	"inbound_state_dispatched",
	"inbound_thread",
] as const;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS origins (
	origin_key TEXT PRIMARY KEY,
	epoch INTEGER NOT NULL,
	session_dir TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
${INBOUND_DDL}
${INBOUND_INDEXES_DDL}
CREATE TABLE IF NOT EXISTS deliveries (
	delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,
	origin_key TEXT NOT NULL,
	op_ref TEXT NOT NULL,
	part INTEGER NOT NULL,
	thread_ref TEXT NOT NULL,
	body TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending'
		CHECK (state IN ('pending','inflight','confirmed','failed_ambiguous','expired')),
	attempts INTEGER NOT NULL DEFAULT 0,
	next_at INTEGER NOT NULL,
	redelivered INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	last_error TEXT,
	sent_parts INTEGER,
	reply_ts TEXT,
	UNIQUE (origin_key, op_ref, part)
);
CREATE INDEX IF NOT EXISTS deliveries_state_next ON deliveries(state, next_at);
CREATE INDEX IF NOT EXISTS deliveries_created ON deliveries(created_at);
CREATE INDEX IF NOT EXISTS deliveries_thread ON deliveries(thread_ref);
${LANES_DDL}
${LANE_RESERVATIONS_DDL}
CREATE TABLE IF NOT EXISTS slack_cursors (
	cursor_key TEXT PRIMARY KEY,
	last_ts TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
${APPROVALS_DDL}
CREATE TABLE IF NOT EXISTS alert_incidents (
	incident_id INTEGER PRIMARY KEY AUTOINCREMENT,
	scope TEXT NOT NULL,
	signature TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'alerted' CHECK (status IN ('alerted','resolved')),
	count INTEGER NOT NULL DEFAULT 1,
	first_at INTEGER NOT NULL,
	last_at INTEGER NOT NULL,
	alerted_at INTEGER NOT NULL,
	UNIQUE (scope, signature)
);
CREATE TABLE IF NOT EXISTS owner_home (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	platform TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	set_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_purposes (
	scope_key TEXT PRIMARY KEY,
	text TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_daily (
	day TEXT NOT NULL,
	origin_key TEXT NOT NULL,
	cost REAL NOT NULL,
	calls INTEGER NOT NULL,
	PRIMARY KEY(day, origin_key)
);
CREATE TABLE IF NOT EXISTS auto_choices (
	id INTEGER PRIMARY KEY,
	origin_key TEXT,
	thread_ref TEXT,
	question TEXT NOT NULL,
	chosen TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auto_choices_at ON auto_choices(created_at);
${LEGACY_FEEDBACK_DDL}
${TURN_SNAPSHOTS_DDL}
${WIKI_NOTES_DDL}
${HERDR_PROMPTS_DDL}
${PEER_CALLS_DDL}
${LANE_BOARD_DDL}
${INBOUND_CONFLICTS_DDL}
${CARD_ANSWERS_DDL}
`;
