import type { Database } from "bun:sqlite";
import { INBOUND_DDL, INBOUND_INDEX_NAMES, INBOUND_INDEXES_DDL, INBOUND_THREAD_INDEX_DDL } from "./db-schema";

function columnsOf(db: Database, table: string): string[] {
	return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

/**
 * The `uncertain` and `sending` states widen a CHECK constraint, which SQLite cannot ALTER: an inbound table without
 * `sending` is rebuilt (rename, create, copy, drop) in one transaction. A RENAME keeps the old table's indexes under
 * their names, so they are dropped first and all seven recreated on the new table. Every column both tables have is
 * copied as is (`inbound_id` too, so the AUTOINCREMENT sequence carries on); columns the old table lacks stay NULL or
 * default. `inbound.origin_key` references `origins`, and a long-lived ledger holds rows whose origin is gone
 * (2026-11-20: 522 answered rows of removed Slack threads), so the copy runs with `foreign_keys` off, as SQLite's
 * table-rebuild procedure prescribes; the pragma is a no-op inside a transaction, so it is switched around it. The rows
 * keep exactly the references they had.
 */
export function migrateInbound(db: Database): void {
	const current = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbound'").get() as {
		sql: string;
	} | null;
	if (current === null || current.sql.includes("'sending'")) return;
	db.run("PRAGMA foreign_keys = OFF");
	try {
		db.transaction(() => {
			db.run("ALTER TABLE inbound RENAME TO inbound_old");
			for (const name of INBOUND_INDEX_NAMES) db.run(`DROP INDEX IF EXISTS ${name}`);
			db.run(INBOUND_DDL);
			const fresh = new Set(columnsOf(db, "inbound"));
			const kept = columnsOf(db, "inbound_old")
				.filter((name) => fresh.has(name))
				.join(", ");
			db.run(`INSERT INTO inbound (${kept}) SELECT ${kept} FROM inbound_old`);
			db.run("DROP TABLE inbound_old");
			db.run(INBOUND_INDEXES_DDL);
			db.run(INBOUND_THREAD_INDEX_DDL);
		})();
	} finally {
		db.run("PRAGMA foreign_keys = ON");
	}
}
