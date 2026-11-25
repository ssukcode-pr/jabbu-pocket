import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMonitorLedger } from "../src/monitors/ledger";
import { gcSessions } from "../src/ops/gc";
import { RestoreError, runRestore } from "../src/ops/restore";
import { openStore } from "../src/store/db";
import { NewerSchemaError, readSchemaVersion, SCHEMA_VERSION } from "../src/store/schema-version";
import { openTaskLedger } from "../src/tasks/ledger";

let home: string;
let path: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-schema-"));
	chmodSync(home, 0o700);
	path = join(home, "jabbu.db");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const clock = { now: () => 1_700_000_000_000 };
const open = () => openStore({ path, clock, timezone: "Asia/Seoul", redact: (text: string) => text });

function userVersion(file: string): number {
	const db = new Database(file, { readonly: true });
	try {
		return readSchemaVersion(db);
	} finally {
		db.close();
	}
}

function setVersion(file: string, version: number): void {
	const db = new Database(file);
	db.run(`PRAGMA user_version = ${version}`);
	db.close();
}

/** A ledger written by the current code, stamped with a version this code has not seen. */
function newerLedger(): number {
	open().close();
	const newer = SCHEMA_VERSION + 1;
	setVersion(path, newer);
	return newer;
}

describe("schema version stamp", () => {
	test("a new database ends up at SCHEMA_VERSION", () => {
		open().close();
		expect(userVersion(path)).toBe(SCHEMA_VERSION);
	});

	test("an old-shaped database at user_version 0 is migrated and stamped", () => {
		open().close();
		const old = new Database(path);
		old.run("ALTER TABLE origins DROP COLUMN thinking");
		old.run("ALTER TABLE deliveries DROP COLUMN reply_ts");
		old.run("PRAGMA user_version = 0");
		old.close();
		open().close();
		expect(userVersion(path)).toBe(SCHEMA_VERSION);
		const db = new Database(path, { readonly: true });
		const columns = (db.query("PRAGMA table_info(origins)").all() as Array<{ name: string }>).map((c) => c.name);
		db.close();
		expect(columns).toContain("thinking");
	});
});

describe("inbound uncertain migration", () => {
	const INDEXES = [
		"inbound_origin_state",
		"inbound_state",
		"inbound_origin_op",
		"inbound_origin_created",
		"inbound_created",
		"inbound_state_dispatched",
		"inbound_thread",
	];
	const indexNames = (db: Database) =>
		(
			db
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'inbound' AND name NOT LIKE 'sqlite_autoindex%'",
				)
				.all() as Array<{
				name: string;
			}>
		).map((row) => row.name);

	test("SCHEMA_VERSION is 11", () => {
		expect(SCHEMA_VERSION).toBe(11);
	});

	test("a version-10 inbound table (no 'sending') is rebuilt: every column kept, uncertain rows too, sending accepted", () => {
		open().close();
		const old = new Database(path);
		old.run("PRAGMA foreign_keys = OFF");
		const table = old.query("SELECT sql FROM sqlite_master WHERE name = 'inbound'").get();
		const ddl = table !== null && typeof table === "object" && "sql" in table ? String(table.sql) : "";
		expect(ddl).toContain("'sending'");
		old.run("ALTER TABLE inbound RENAME TO inbound_new");
		for (const name of INDEXES) old.run(`DROP INDEX IF EXISTS ${name}`);
		old.run(ddl.replace("'pending','sending',", "'pending',"));
		old.run("DROP TABLE inbound_new");
		old.run("CREATE INDEX inbound_state ON inbound(state)");
		old.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES ('o1', 1, '/s/o1', 1)");
		old.run(
			"INSERT INTO inbound (inbound_id, platform_message_id, origin_key, epoch, text_ref, state, created_at, entry_cursor, thread_ref, uncertain_reason, uncertain_at, injected) VALUES (4, 'm4', 'o1', 1, 'r4', 'uncertain', 5, 'c4', 't4', 'steer_threw', 6, 1), (5, 'm5', 'o1', 1, 'r5', 'pending', 7, NULL, 't5', NULL, NULL, 0)",
		);
		expect(() => old.run("UPDATE inbound SET state = 'sending' WHERE inbound_id = 5")).toThrow();
		old.run("PRAGMA user_version = 10");
		old.close();

		const store = open();
		const parked = store.getInbound("m4");
		expect(parked).toMatchObject({ state: "uncertain", uncertainReason: "steer_threw", uncertainAt: 6 });
		expect(parked).toMatchObject({ entryCursor: "c4", threadRef: "t4", injected: true });
		expect(store.markSending("m5", "c5")).toMatchObject({ state: "sending", entryCursor: "c5" });
		store.close();

		const db = new Database(path, { readonly: true });
		expect(indexNames(db).sort()).toEqual([...INDEXES].sort());
		expect(db.query("SELECT name FROM sqlite_master WHERE name = 'inbound_old'").all()).toEqual([]);
		db.close();
		expect(userVersion(path)).toBe(11);
	});

	test("a pre-uncertain inbound table is rebuilt: rows, inbound_id, all 7 indexes kept, uncertain accepted", () => {
		open().close();
		// Recreate the version-1 shape: CHECK without 'uncertain', no uncertain_* columns, same indexes.
		const old = new Database(path);
		old.run("PRAGMA foreign_keys = OFF");
		old.run("ALTER TABLE inbound RENAME TO inbound_new");
		for (const name of INDEXES) old.run(`DROP INDEX IF EXISTS ${name}`);
		old.run(`CREATE TABLE inbound (
			inbound_id INTEGER PRIMARY KEY AUTOINCREMENT,
			platform_message_id TEXT NOT NULL UNIQUE,
			origin_key TEXT NOT NULL REFERENCES origins(origin_key),
			epoch INTEGER NOT NULL,
			text_ref TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'pending'
				CHECK (state IN ('pending','dispatched','answered','failed_notified','discarded')),
			created_at INTEGER NOT NULL,
			dispatched_at INTEGER,
			op_ref TEXT,
			entry_cursor TEXT,
			thread_ref TEXT,
			last_event_at INTEGER,
			peer_user_id TEXT
		)`);
		old.run("DROP TABLE inbound_new");
		old.run("CREATE INDEX inbound_origin_state ON inbound(origin_key, state)");
		old.run("CREATE INDEX inbound_state ON inbound(state)");
		old.run("CREATE INDEX inbound_origin_op ON inbound(origin_key, op_ref)");
		old.run("CREATE INDEX inbound_origin_created ON inbound(origin_key, created_at)");
		old.run("CREATE INDEX inbound_created ON inbound(created_at)");
		old.run("CREATE INDEX inbound_state_dispatched ON inbound(state, dispatched_at)");
		old.run("CREATE INDEX inbound_thread ON inbound(thread_ref)");
		old.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES ('o1', 1, '/s/o1', 1)");
		old.run(
			"INSERT INTO inbound (inbound_id, platform_message_id, origin_key, epoch, text_ref, state, created_at, thread_ref) VALUES (7, 'm7', 'o1', 1, 'r7', 'pending', 5, 't7'), (9, 'm9', 'o1', 1, 'r9', 'answered', 6, 't9')",
		);
		// A row whose origin was deleted long ago (old ledgers hold hundreds): the rebuild must keep it, not abort.
		old.run(
			"INSERT INTO inbound (inbound_id, platform_message_id, origin_key, epoch, text_ref, state, created_at) VALUES (8, 'm8', 'gone', 1, 'r8', 'answered', 5)",
		);
		old.run("PRAGMA user_version = 1");
		old.close();

		const store = open();
		expect(store.getInbound("m7")?.state).toBe("pending");
		expect(store.getInbound("m9")?.state).toBe("answered");
		expect(store.getInbound("m7")?.threadRef).toBe("t7");
		store.markUncertain("m7", "steer_threw");
		expect(store.getInbound("m7")?.state).toBe("uncertain");
		const next = store.recordInbound({ originKey: "o1", platformMessageId: "m10", textRef: "r10" });
		expect(next.inserted).toBe(true);
		store.close();

		const db = new Database(path, { readonly: true });
		const ids = (
			db.query("SELECT inbound_id FROM inbound ORDER BY inbound_id").all() as Array<{ inbound_id: number }>
		).map((row) => row.inbound_id);
		expect(ids).toEqual([7, 8, 9, 10]); // inbound_id kept (the orphan too), sequence carries on
		expect(db.query("PRAGMA foreign_key_check(inbound)").all()).toHaveLength(1);
		expect(indexNames(db).sort()).toEqual([...INDEXES].sort());
		expect(db.query("SELECT name FROM sqlite_master WHERE name = 'inbound_old'").all()).toEqual([]);
		db.close();
		expect(userVersion(path)).toBe(SCHEMA_VERSION);
	});

	test("a current database is not rebuilt again", () => {
		open().close();
		const db = new Database(path, { readonly: true });
		expect(indexNames(db).sort()).toEqual([...INDEXES].sort());
		db.close();
	});
});

describe("newer schema refusal", () => {
	test("Store refuses, names both versions and the restore remedy, and leaves the file untouched", () => {
		const newer = newerLedger();
		const before = readFileSync(path);
		expect(() => open()).toThrow(NewerSchemaError);
		try {
			open();
		} catch (error) {
			const message = (error as Error).message;
			expect((error as NewerSchemaError).code).toBe("newer_schema");
			expect(message).toContain(String(newer));
			expect(message).toContain(String(SCHEMA_VERSION));
			expect(message).toContain("jabbu-pocket restore");
		}
		expect(readFileSync(path).equals(before)).toBe(true);
		expect(userVersion(path)).toBe(newer);
	});

	test("the standalone ledgers refuse a write open but open read-only", () => {
		const newer = newerLedger();
		expect(() => openTaskLedger(path, "Asia/Seoul", clock)).toThrow(NewerSchemaError);
		expect(() => openMonitorLedger(path, clock)).toThrow(NewerSchemaError);
		openTaskLedger(path, "Asia/Seoul", clock, { readonly: true }).close();
		expect(userVersion(path)).toBe(newer);
	});

	test("a ledger made on a bare file is not altered by the refused open", () => {
		const bare = new Database(path, { create: true });
		bare.run("PRAGMA user_version = 99");
		bare.close();
		expect(() => open()).toThrow(NewerSchemaError);
		const db = new Database(path, { readonly: true });
		const tables = db.query("SELECT name FROM sqlite_master").all();
		db.close();
		expect(tables).toEqual([]);
	});

	test("gc refuses a write connection but a dry run still counts", () => {
		const newer = newerLedger();
		mkdirSync(join(home, "sessions"), { recursive: true });
		const opts = { homeDir: home, retentionDays: 30, now: clock.now() };
		expect(() => gcSessions(opts)).toThrow(NewerSchemaError);
		expect(() => gcSessions({ ...opts, dryRun: true })).not.toThrow();
		expect(userVersion(path)).toBe(newer);
	});

	test("restore refuses a copy written by newer code and keeps the live ledger", async () => {
		open().close();
		const backup = join(home, "newer-copy.db");
		const db = new Database(path);
		db.run(`VACUUM INTO '${backup}'`);
		db.close();
		setVersion(backup, SCHEMA_VERSION + 1);
		const live = readFileSync(path);
		const error = await runRestore({
			homeDir: home,
			source: backup,
			yes: true,
			probeDaemon: () => Promise.reject(new Error("ENOENT")),
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RestoreError);
		expect((error as RestoreError).code).toBe("newer_schema");
		expect(readFileSync(path).equals(live)).toBe(true);
	});
});
