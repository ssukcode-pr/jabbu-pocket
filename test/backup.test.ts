import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BACKUP_FILE_PATTERN,
	BUNDLE_FILE_PATTERN,
	readStamp,
	retentionDoomed,
	runBackup,
	STAMP_FILE,
} from "../src/ops/backup";
import { dailyBackupNames, seedDb } from "./helpers/backup-fixtures";

const sha256OfFile = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const REPO_ROOT = join(import.meta.dir, "..");

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-backup-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("runBackup", () => {
	test("writes a verified daily backup, a stamp, and keeps WAL mode untouched", () => {
		seedDb(home);
		const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });

		expect(result.file.endsWith("jabbu-20261023-043000.db")).toBe(true);
		expect(existsSync(result.file)).toBe(true);
		expect(result.bytes).toBeGreaterThan(0);
		expect(existsSync(`${result.file}-wal`)).toBe(false);
		expect(existsSync(`${result.file}-shm`)).toBe(false);
		expect(result.removed).toEqual([]);
		// The copy holds the seeded row.
		const copy = new Database(result.file, { readonly: true, strict: true });
		const row = copy.query("SELECT epoch FROM origins WHERE origin_key = 'discord/dm/200000000000000001'").get() as {
			epoch: number;
		};
		copy.close();
		expect(row.epoch).toBe(1);

		const stamp = readStamp(join(home, "backups"));
		expect(stamp).toBeDefined();
		expect(stamp?.file).toBe("jabbu-20261023-043000.db");
		expect(stamp?.bytes).toBe(result.bytes);
		expect(stamp?.sha256).toBe(result.sha256);
	});

	test("refuses to overwrite an existing target and cleans up temp files", () => {
		seedDb(home);
		const now = new Date(2026, 9, 23, 4, 30, 0);
		runBackup({ homeDir: home, now });
		expect(() => runBackup({ homeDir: home, now })).toThrow(/target_exists/);
		const leftovers = readdirSync(join(home, "backups")).filter((name) => name.includes(".tmp-"));
		expect(leftovers).toEqual([]);
	});

	test("fails without a stamp when the database is missing", () => {
		expect(() => runBackup({ homeDir: home })).toThrow(/db_missing/);
		expect(existsSync(join(home, "backups", STAMP_FILE))).toBe(false);
	});

	test("a FIFO in the ledger's place fails as missing instead of blocking the open", () => {
		expect(Bun.spawnSync(["mkfifo", join(home, "jabbu.db")]).exitCode).toBe(0);
		expect(() => runBackup({ homeDir: home })).toThrow(/db_missing/);
		expect(existsSync(join(home, "backups", STAMP_FILE))).toBe(false);
	});

	test("prunes only timestamped daily files past --keep, never the stamp or other names", () => {
		seedDb(home);
		const backupsDir = join(home, "backups");
		mkdirSync(backupsDir, { recursive: true });
		// Five old daily backups: names sort chronologically.
		const dailies = [
			"jabbu-20261020-043000.db",
			"jabbu-20261021-043000.db",
			"jabbu-20261022-043000.db",
			"jabbu-20261023-043000.db",
			"jabbu-20261024-043000.db",
		];
		for (const name of dailies) writeFileSync(join(backupsDir, name), "x");
		// Files the prune pattern must never touch.
		writeFileSync(join(backupsDir, "jabbu-pre-upgrade-20261019T000000Z.db"), "x");
		writeFileSync(join(backupsDir, "config.json.bak-20261020"), "x");
		writeFileSync(join(backupsDir, STAMP_FILE), "ts=old\n");

		const result = runBackup({ homeDir: home, keep: 2, now: new Date(2026, 9, 25, 4, 30, 0) });

		// keep=2: the new backup plus the newest old one survive.
		expect(dailyBackupNames(home)).toEqual(["jabbu-20261024-043000.db", "jabbu-20261025-043000.db"]);
		expect(existsSync(join(backupsDir, "jabbu-pre-upgrade-20261019T000000Z.db"))).toBe(true);
		expect(existsSync(join(backupsDir, "config.json.bak-20261020"))).toBe(true);
		expect(result.removed).toHaveLength(4);
		// The stamp was overwritten by the new successful backup, not left at "ts=old".
		expect(readStamp(backupsDir)?.file).toBe("jabbu-20261025-043000.db");
	});

	test("keep=0 disables pruning", () => {
		seedDb(home);
		const backupsDir = join(home, "backups");
		mkdirSync(backupsDir, { recursive: true });
		writeFileSync(join(backupsDir, "jabbu-20260101-000000.db"), "x");
		runBackup({ homeDir: home, keep: 0, now: new Date(2026, 9, 23, 4, 30, 0) });
		expect(dailyBackupNames(home)).toEqual(["jabbu-20260101-000000.db", "jabbu-20261023-043000.db"]);
	});

	test("stamp content is grep-stable and the mtime fallback parses", () => {
		seedDb(home);
		const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });
		const text = readFileSync(join(home, "backups", STAMP_FILE), "utf8");
		expect(text).toContain(`file=jabbu-20261023-043000.db`);
		expect(text).toContain(`sha256=${result.sha256}`);
		expect(text).toContain("integrity=ok");
		expect(readStamp(join(home, "backups"))?.ts.getTime()).toBeGreaterThan(0);
	});
});

describe("backup bundle (sessions + config.json)", () => {
	/** A home that looks lived-in: a session file, a config, and a secret that must never be bundled. */
	function seedSources(): void {
		mkdirSync(join(home, "sessions", "discord-dm-200000000000000001", "e1"), { recursive: true });
		writeFileSync(
			join(home, "sessions", "discord-dm-200000000000000001", "e1", "s.jsonl"),
			'{"message":{"role":"user","content":"안녕"}}\n',
		);
		writeFileSync(join(home, "config.json"), '{"schemaVersion":1}\n', { mode: 0o600 });
		mkdirSync(join(home, "secrets"), { recursive: true });
		writeFileSync(join(home, "secrets", "discord-bot-token"), "TEST-discord-0\n", { mode: 0o600 });
	}

	/**
	 * A `tar` that does the real work, then — for the create call only — prints `stderr` and exits 1, like GNU tar
	 * does when a session file grows while it is archived.
	 */
	function warningTar(stderr: string): string {
		const realTar = Bun.which("tar");
		if (realTar === null) throw new Error("tar not on PATH");
		const bin = join(home, "fake-bin");
		mkdirSync(bin);
		const script = join(bin, "tar");
		writeFileSync(
			script,
			`#!/bin/sh\n"${realTar}" "$@" || exit $?\nif [ "$1" = "-czf" ]; then printf '%s\\n' '${stderr}' >&2; exit 1; fi\n`,
			{ mode: 0o755 },
		);
		return script;
	}

	test("tar exit 1 with only 'file changed as we read it' still yields a verified bundle", () => {
		seedDb(home);
		seedSources();
		const result = runBackup({
			homeDir: home,
			now: new Date(2026, 9, 23, 4, 30, 0),
			tarBin: warningTar("tar: sessions/discord-dm-200000000000000001/e1/s.jsonl: file changed as we read it"),
		});
		expect(existsSync(result.bundle as string)).toBe(true);
		expect(readStamp(join(home, "backups"))?.bundle).toBe("jabbu-bundle-20261023-043000.tar.gz");
	});

	test("tar exit 1 with any other message fails the whole backup", () => {
		seedDb(home);
		seedSources();
		const tarBin = warningTar("tar: sessions/discord-dm-200000000000000001/e1/s.jsonl: Cannot open: Permission denied");
		expect(() => runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0), tarBin })).toThrow(/bundle_failed/);
		expect(readStamp(join(home, "backups"))).toBeUndefined();
	});

	test("a verified tar.gz lands next to the db and the stamp records its name and sha256", () => {
		seedDb(home);
		seedSources();
		const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });

		expect(result.bundle?.endsWith("jabbu-bundle-20261023-043000.tar.gz")).toBe(true);
		expect(existsSync(result.bundle as string)).toBe(true);
		expect(result.bundleBytes).toBeGreaterThan(0);
		expect(result.bundleSha256).toBe(sha256OfFile(result.bundle as string));

		const stamp = readStamp(join(home, "backups"));
		expect(stamp?.bundle).toBe("jabbu-bundle-20261023-043000.tar.gz");
		expect(stamp?.bundleSha256).toBe(result.bundleSha256);
		expect(readFileSync(join(home, "backups", STAMP_FILE), "utf8")).toContain("bundle=");

		// The archive holds the session original and the config, and never the secrets directory.
		const list = Bun.spawnSync(["tar", "-tzf", result.bundle as string]);
		expect(list.exitCode).toBe(0);
		const entries = list.stdout.toString().split("\n");
		expect(entries.some((e) => e === "config.json")).toBe(true);
		expect(entries.some((e) => e.startsWith("sessions/") && e.endsWith("s.jsonl"))).toBe(true);
		expect(entries.some((e) => e.startsWith("secrets"))).toBe(false);
	});

	test("skipBundle: a verified db, no bundle, and the bundled stamp before it stays the stamp", () => {
		seedDb(home);
		seedSources();
		const backupsDir = join(home, "backups");
		runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });
		const stampBefore = readFileSync(join(backupsDir, STAMP_FILE), "utf8");

		const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 9, 0, 0), skipBundle: true });

		expect(result.file.endsWith("jabbu-20261023-090000.db")).toBe(true);
		expect(result.sha256).toBe(sha256OfFile(result.file));
		const copy = new Database(result.file, { readonly: true, strict: true });
		const check = copy.query("PRAGMA quick_check").get() as { quick_check: string };
		copy.close();
		expect(check.quick_check).toBe("ok");
		expect(result.bundle).toBeUndefined();
		expect(result.bundleBytes).toBeUndefined();
		expect(result.bundleSha256).toBeUndefined();
		expect(result.stamp).toBeUndefined();
		expect(readdirSync(backupsDir).filter((name) => BUNDLE_FILE_PATTERN.test(name))).toEqual([
			"jabbu-bundle-20261023-043000.tar.gz",
		]);
		expect(readFileSync(join(backupsDir, STAMP_FILE), "utf8")).toBe(stampBefore);
	});

	test("skipBundle prunes the db snapshots without a stamp and leaves the bundles to the daily backup", () => {
		seedDb(home);
		seedSources();
		const backupsDir = join(home, "backups");
		mkdirSync(backupsDir, { recursive: true });
		for (const day of ["20261020", "20261021", "20261022"]) {
			writeFileSync(join(backupsDir, `jabbu-${day}-043000.db`), "x");
			writeFileSync(join(backupsDir, `jabbu-bundle-${day}-043000.tar.gz`), "x");
		}
		runBackup({ homeDir: home, now: new Date(2026, 9, 23, 9, 0, 0), keep: 2, skipBundle: true });
		expect(existsSync(join(backupsDir, STAMP_FILE))).toBe(false);
		expect(dailyBackupNames(home)).toEqual(["jabbu-20261022-043000.db", "jabbu-20261023-090000.db"]);
		expect(
			readdirSync(backupsDir)
				.filter((name) => BUNDLE_FILE_PATTERN.test(name))
				.sort(),
		).toEqual(["jabbu-bundle-20261021-043000.tar.gz", "jabbu-bundle-20261022-043000.tar.gz"]);
	});

	test("workspace/ and scripts/ are bundled; secrets/ is not; a home without scripts/ still backs up", () => {
		seedDb(home);
		seedSources();
		mkdirSync(join(home, "workspace"), { recursive: true });
		writeFileSync(join(home, "workspace", "persona.md"), "persona\n");
		mkdirSync(join(home, "scripts"), { recursive: true });
		writeFileSync(join(home, "scripts", "x.py"), "print(1)\n");
		const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });
		const list = Bun.spawnSync(["tar", "-tzf", result.bundle as string]);
		expect(list.exitCode).toBe(0);
		const entries = list.stdout.toString().split("\n");
		expect(entries).toContain("workspace/persona.md");
		expect(entries).toContain("scripts/x.py");
		expect(entries.some((e) => e.startsWith("secrets"))).toBe(false);

		// Same home minus scripts/: only existing sources are bundled and the backup succeeds.
		rmSync(join(home, "scripts"), { recursive: true });
		const second = runBackup({ homeDir: home, now: new Date(2026, 9, 24, 4, 30, 0) });
		const entries2 = Bun.spawnSync(["tar", "-tzf", second.bundle as string])
			.stdout.toString()
			.split("\n");
		expect(entries2).toContain("workspace/persona.md");
		expect(entries2.some((e) => e.startsWith("scripts"))).toBe(false);
	});

	describe("sessions as a symlink (B-1)", () => {
		const now = new Date(2026, 10, 11, 4, 30, 0);

		test("the link target's contents are bundled under sessions/, inner links stay links", () => {
			seedDb(home);
			writeFileSync(join(home, "config.json"), "{}\n");
			mkdirSync(join(home, "secrets"));
			writeFileSync(join(home, "secrets", "discord-bot-token"), "TEST-discord-0\n");
			const real = join(home, "elsewhere", "real-sessions");
			mkdirSync(join(real, "discord-dm-200000000000000001"), { recursive: true });
			writeFileSync(join(real, "discord-dm-200000000000000001", "s.jsonl"), '{"memory":true}\n');
			nodeFs.symlinkSync(join(home, "secrets", "discord-bot-token"), join(real, "inner-link"));
			nodeFs.symlinkSync(real, join(home, "sessions"));

			const result = runBackup({ homeDir: home, now });
			const entries = Bun.spawnSync(["tar", "-tzf", result.bundle as string])
				.stdout.toString()
				.split("\n");
			expect(entries).toContain("sessions/discord-dm-200000000000000001/s.jsonl");
			expect(entries).toContain("config.json");
			expect(entries.some((e) => e.includes("real-sessions") || e.startsWith("elsewhere"))).toBe(false);
			// Only the top-level link is followed: the inner link is archived as a link, never as the secret's bytes.
			const verbose = Bun.spawnSync(["tar", "-tvzf", result.bundle as string]).stdout.toString();
			const inner = verbose.split("\n").find((line) => line.includes("sessions/inner-link"));
			expect(inner?.startsWith("l")).toBe(true);
			expect(readStamp(join(home, "backups"))?.bundle).toBe("jabbu-bundle-20261111-043000.tar.gz");
		});

		test("the size cap measures the link target", () => {
			seedDb(home);
			const real = join(home, "elsewhere");
			mkdirSync(real);
			writeFileSync(join(real, "big.bin"), Buffer.alloc(64 * 1024));
			nodeFs.symlinkSync(real, join(home, "sessions"));
			expect(() => runBackup({ homeDir: home, now, maxBundleBytes: 1024 })).toThrow(/bundle_too_large/);
			expect(readStamp(join(home, "backups"))).toBeUndefined();
		});

		test("a link into secrets/, to a file, dangling or cyclic fails as bundle_failed without a stamp", () => {
			const cases: Array<[string, (link: string) => void]> = [
				[
					"secrets",
					(link) => {
						mkdirSync(join(home, "secrets", "sub"), { recursive: true });
						writeFileSync(join(home, "secrets", "sub", "t"), "TEST-discord-0\n");
						nodeFs.symlinkSync(join(home, "secrets", "sub"), link);
					},
				],
				[
					"file",
					(link) => {
						writeFileSync(join(home, "a-file"), "x\n");
						nodeFs.symlinkSync(join(home, "a-file"), link);
					},
				],
				[
					"around-secrets",
					(link) => {
						mkdirSync(join(home, "secrets"));
						nodeFs.symlinkSync(home, link);
					},
				],
				["dangling", (link) => nodeFs.symlinkSync(join(home, "nowhere"), link)],
				[
					"cyclic",
					(link) => {
						nodeFs.symlinkSync(join(home, "loop-b"), join(home, "loop-a"));
						nodeFs.symlinkSync(join(home, "loop-a"), join(home, "loop-b"));
						nodeFs.symlinkSync(join(home, "loop-a"), link);
					},
				],
			];
			for (const [name, setup] of cases) {
				rmSync(home, { recursive: true, force: true });
				mkdirSync(home);
				seedDb(home);
				setup(join(home, "sessions"));
				let error: unknown;
				try {
					runBackup({ homeDir: home, now });
				} catch (caught) {
					error = caught;
				}
				expect(`${name}: ${String(error)}`).toContain("bundle_failed");
				expect(readStamp(join(home, "backups"))).toBeUndefined();
				expect(readdirSync(join(home, "backups")).some((n) => BUNDLE_FILE_PATTERN.test(n))).toBe(false);
			}
		});

		test("qa-l #17: a secrets/ link into another bundle source (workspace/, scripts/) fails as bundle_failed", () => {
			for (const source of ["workspace", "scripts"]) {
				rmSync(home, { recursive: true, force: true });
				mkdirSync(home);
				seedDb(home);
				mkdirSync(join(home, source, "tokens"), { recursive: true });
				writeFileSync(join(home, source, "tokens", "t"), "TEST-discord-0\n");
				nodeFs.symlinkSync(join(home, source, "tokens"), join(home, "secrets"));
				expect(() => runBackup({ homeDir: home, now })).toThrow(/bundle_failed.*secrets\//);
				expect(readStamp(join(home, "backups"))).toBeUndefined();
			}
		});

		test("a link to an empty directory (fresh install) still backs up", () => {
			seedDb(home);
			mkdirSync(join(home, "empty-sessions"));
			nodeFs.symlinkSync(join(home, "empty-sessions"), join(home, "sessions"));
			const result = runBackup({ homeDir: home, now });
			expect(
				Bun.spawnSync(["tar", "-tzf", result.bundle as string])
					.stdout.toString()
					.split("\n"),
			).toContain("sessions/");
		});
	});

	test("a ledger-only home (no sessions, no config.json) writes no bundle and no bundle fields", () => {
		seedDb(home);
		const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });
		expect(result.bundle).toBeUndefined();
		expect(readStamp(join(home, "backups"))?.bundle).toBeUndefined();
		expect(readFileSync(join(home, "backups", STAMP_FILE), "utf8")).not.toContain("bundle=");
	});

	test("sources past the size cap fail the whole backup: no stamp, no db file, no residue", () => {
		seedDb(home);
		seedSources();
		expect(() => runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0), maxBundleBytes: 10 })).toThrow(
			/bundle_too_large/,
		);
		const backupsDir = join(home, "backups");
		expect(existsSync(join(backupsDir, STAMP_FILE))).toBe(false);
		expect(readdirSync(backupsDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
		expect(readdirSync(backupsDir).some((name) => BUNDLE_FILE_PATTERN.test(name))).toBe(false);
	});

	test("a bundle placement failure after the db placement leaves no newest-mtime file behind", async () => {
		seedDb(home);
		seedSources();
		// The db link (call 1) lands, the bundle link (call 2) fails: the catch must remove this run's own placed
		// db or a newest-mtime file survives that a freshness check could mistake for a good backup.
		const original = { ...nodeFs };
		let links = 0;
		await mock.module("node:fs", () => ({
			...original,
			linkSync: (existingPath: string, newPath: string) => {
				links += 1;
				if (links === 2) throw new Error(`link #2 failed (injected): ${existingPath} -> ${newPath}`);
				return original.linkSync(existingPath, newPath);
			},
		}));
		try {
			expect(() => runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) })).toThrow(/link #2 failed/);
		} finally {
			await mock.module("node:fs", () => original);
		}
		const backupsDir = join(home, "backups");
		expect(existsSync(join(backupsDir, STAMP_FILE))).toBe(false);
		expect(readdirSync(backupsDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
		expect(readdirSync(backupsDir).some((name) => BACKUP_FILE_PATTERN.test(name))).toBe(false);
		expect(readdirSync(backupsDir).some((name) => BUNDLE_FILE_PATTERN.test(name))).toBe(false);
	});

	test("bundles prune with the same keep policy as the db snapshots", () => {
		seedDb(home);
		seedSources();
		const backupsDir = join(home, "backups");
		mkdirSync(backupsDir, { recursive: true });
		writeFileSync(join(backupsDir, "jabbu-bundle-20200101-000000.tar.gz"), "old");
		writeFileSync(join(backupsDir, "jabbu-bundle-pre-upgrade.tar.gz"), "manual"); // not a daily name

		const result = runBackup({ homeDir: home, keep: 1, now: new Date(2026, 9, 25, 4, 30, 0) });
		const bundles = readdirSync(backupsDir)
			.filter((name) => BUNDLE_FILE_PATTERN.test(name))
			.sort();
		expect(bundles).toEqual(["jabbu-bundle-20261025-043000.tar.gz"]);
		expect(result.removed).toContain(join(backupsDir, "jabbu-bundle-20200101-000000.tar.gz"));
		expect(existsSync(join(backupsDir, "jabbu-bundle-pre-upgrade.tar.gz"))).toBe(true);
		// The daily db file of the same run is kept too.
		expect(readdirSync(backupsDir).some((name) => name === "jabbu-20261025-043000.db")).toBe(true);
	});

	test("keep counts days: every file of the run's day, the latest of each other day, nothing past keep days", () => {
		seedDb(home);
		seedSources();
		const backupsDir = join(home, "backups");
		mkdirSync(backupsDir, { recursive: true });
		const stamps = [
			"20261025-010000", // the run's day, earlier applies
			"20261025-020000",
			"20301010-000000", // future-dated (clock stepped back): another day, its latest only
			"20301010-120000",
			"20261024-010000",
			"20261024-230000",
			"20261023-120000",
			"20261022-120000",
		];
		for (const stamp of stamps) {
			writeFileSync(join(backupsDir, `jabbu-${stamp}.db`), "x");
			writeFileSync(join(backupsDir, `jabbu-bundle-${stamp}.tar.gz`), "x");
		}
		const manual = [
			"jabbu-pre-upgrade-20261001T000000Z.db",
			"jabbu-20261001-000000.db.bak-1",
			"config.json.bak-20261001",
		];
		for (const name of manual) writeFileSync(join(backupsDir, name), "x");

		const result = runBackup({ homeDir: home, keep: 3, now: new Date(2026, 9, 25, 4, 30, 0) });

		// keep=3 days: the run's day (all three) + the two newest other days (2030-10-10, 2026-10-24), one each.
		const survivors = ["20261024-230000", "20261025-010000", "20261025-020000", "20261025-043000", "20301010-120000"];
		expect(dailyBackupNames(home)).toEqual(survivors.map((s) => `jabbu-${s}.db`));
		expect(
			readdirSync(backupsDir)
				.filter((name) => BUNDLE_FILE_PATTERN.test(name))
				.sort(),
		).toEqual(survivors.map((s) => `jabbu-bundle-${s}.tar.gz`));
		const gone = ["20301010-000000", "20261024-010000", "20261023-120000", "20261022-120000"];
		expect(result.removed).toEqual([
			...gone.map((s) => join(backupsDir, `jabbu-${s}.db`)),
			...gone.map((s) => join(backupsDir, `jabbu-bundle-${s}.tar.gz`)),
		]);
		for (const name of manual) expect(existsSync(join(backupsDir, name))).toBe(true);
		expect(existsSync(join(backupsDir, STAMP_FILE))).toBe(true);
		// kept = every daily .db left after retention, newest name first (bundles are not counted).
		expect(result.kept).toEqual([...survivors].reverse().map((s) => join(backupsDir, `jabbu-${s}.db`)));
	});

	test("without a protected file the newest day is the base day, kept whole", () => {
		const names = [
			"jabbu-20261024-010000.db",
			"jabbu-20261024-020000.db",
			"jabbu-20261023-010000.db",
			"jabbu-20261023-020000.db",
			"jabbu-20261022-010000.db",
			"jabbu-pre-upgrade-20261001T000000Z.db",
			"jabbu-bundle-20261024-010000.tar.gz",
		];
		expect(retentionDoomed(names, 2, [], BACKUP_FILE_PATTERN)).toEqual([
			"jabbu-20261023-010000.db",
			"jabbu-20261022-010000.db",
		]);
		// A protected name pins its day as the base day even when it is not the newest.
		expect(retentionDoomed(names, 1, ["jabbu-20261023-010000.db"], BACKUP_FILE_PATTERN)).toEqual([
			"jabbu-20261024-020000.db",
			"jabbu-20261024-010000.db",
			"jabbu-20261022-010000.db",
		]);
	});

	test("a hard link to a secrets/ file inside a bundle source fails the backup (J-1/J-5)", () => {
		seedDb(home);
		seedSources();
		mkdirSync(join(home, "workspace"), { recursive: true });
		nodeFs.linkSync(join(home, "secrets", "discord-bot-token"), join(home, "workspace", "notes.md"));
		expect(() => runBackup({ homeDir: home, now: new Date(2026, 9, 26, 4, 30, 0) })).toThrow(
			/bundle_failed: workspace\/notes\.md is a hard link to a secrets\/ file/,
		);
		expect(readStamp(join(home, "backups"))).toBeUndefined();
		expect(readdirSync(join(home, "backups")).some((n) => BUNDLE_FILE_PATTERN.test(n))).toBe(false);

		// config.json itself hard-linked to a secret is refused too; an unrelated hard link is fine.
		rmSync(join(home, "workspace", "notes.md"));
		rmSync(join(home, "config.json"));
		nodeFs.linkSync(join(home, "secrets", "discord-bot-token"), join(home, "config.json"));
		expect(() => runBackup({ homeDir: home, now: new Date(2026, 9, 26, 4, 31, 0) })).toThrow(
			/config\.json is a hard link to a secrets\/ file/,
		);
		rmSync(join(home, "config.json"));
		writeFileSync(join(home, "workspace", "a.md"), "plain\n");
		nodeFs.linkSync(join(home, "workspace", "a.md"), join(home, "workspace", "b.md"));
		expect(runBackup({ homeDir: home, now: new Date(2026, 9, 26, 4, 32, 0) }).bundle).toBeDefined();
	});
});

describe("concurrent same-second runBackup runs (r20 F2)", () => {
	/** A ledger big enough that `VACUUM INTO` takes ~1.3s: both children are past the pre-check before either places its target. */
	function seedLargeDb(): void {
		seedDb(home);
		const db = new Database(join(home, "jabbu.db"), { create: true, strict: true });
		db.run("CREATE TABLE pad (id INTEGER PRIMARY KEY, data BLOB NOT NULL)");
		const insert = db.prepare("INSERT INTO pad (data) VALUES (zeroblob(65536))");
		db.transaction(() => {
			for (let i = 0; i < 2048; i++) insert.run();
		})();
		db.close();
	}

	function seedBundleSources(): void {
		mkdirSync(join(home, "sessions", "discord-dm-200000000000000001", "e1"), { recursive: true });
		writeFileSync(
			join(home, "sessions", "discord-dm-200000000000000001", "e1", "s.jsonl"),
			'{"message":{"role":"user","content":"안녕"}}\n',
		);
		writeFileSync(join(home, "config.json"), '{"schemaVersion":1}\n', { mode: 0o600 });
	}

	/** A child that runs one `runBackup` and prints its result as JSON, or its error on stderr with exit 1. */
	function writeChildScript(): string {
		const script = join(home, "child-backup.ts");
		writeFileSync(
			script,
			[
				`import { runBackup } from ${JSON.stringify(join(REPO_ROOT, "src/ops/backup.ts"))};`,
				"const [homeDir, nowMs, skipBundle] = process.argv.slice(2);",
				"try {",
				'	const result = runBackup({ homeDir, now: new Date(Number(nowMs)), skipBundle: skipBundle === "1" });',
				"	console.log(JSON.stringify({ file: result.file, sha256: result.sha256, bundle: result.bundle ?? null }));",
				"} catch (error) {",
				"	console.error(error instanceof Error ? error.message : String(error));",
				"	process.exit(1);",
				"}",
				"",
			].join("\n"),
		);
		return script;
	}

	interface ChildOutcome {
		code: number;
		stdout: string;
		stderr: string;
	}

	async function runChild(script: string, now: Date, skipBundle: boolean): Promise<ChildOutcome> {
		const proc = Bun.spawn(["bun", script, home, String(now.getTime()), skipBundle ? "1" : "0"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	}

	/** Two children with the same stamp, the second started while the first is mid-VACUUM; returns [winner, loser]. */
	async function runConcurrent(script: string, now: Date, skipBundle: boolean): Promise<[ChildOutcome, ChildOutcome]> {
		const first = runChild(script, now, skipBundle);
		// Stagger the starts so the first child is mid-VACUUM when the second passes its pre-check; the second's
		// VACUUM then ends after the first placed its target.
		await Bun.sleep(300); // sleep-ok: stagger for the race window, not waiting on an event
		const second = runChild(script, now, skipBundle);
		const [a, b] = await Promise.all([first, second]);
		return a.code === 0 ? [a, b] : [b, a];
	}

	test("the loser fails target_exists at placement and the winner's db survives", async () => {
		seedLargeDb();
		const script = writeChildScript();
		const now = new Date(2026, 9, 23, 4, 30, 0);
		const [winner, loser] = await runConcurrent(script, now, true);

		expect(winner.code).toBe(0);
		expect(loser.code).toBe(1);
		expect(loser.stderr).toMatch(/target_exists/);
		const result = JSON.parse(winner.stdout) as { file: string; sha256: string; bundle: string | null };
		expect(result.bundle).toBeNull();
		expect(existsSync(result.file)).toBe(true);
		expect(sha256OfFile(result.file)).toBe(result.sha256);
		expect(readdirSync(join(home, "backups")).filter((name) => name.includes(".tmp-"))).toEqual([]);
	}, 120000);

	test("with a bundle the loser never deletes the winner's verified backup", async () => {
		seedLargeDb();
		seedBundleSources();
		const script = writeChildScript();
		const now = new Date(2026, 9, 23, 4, 30, 0);
		const [winner, loser] = await runConcurrent(script, now, false);

		expect(winner.code).toBe(0);
		expect(loser.code).toBe(1);
		expect(loser.stderr).toMatch(/target_exists/);
		const result = JSON.parse(winner.stdout) as { file: string; sha256: string; bundle: string | null };
		expect(result.bundle).not.toBeNull();
		expect(existsSync(result.file)).toBe(true);
		expect(sha256OfFile(result.file)).toBe(result.sha256);
		expect(existsSync(result.bundle as string)).toBe(true);
		const stamp = readStamp(join(home, "backups"));
		expect(stamp?.file).toBe(result.file.split("/").pop());
		expect(stamp?.sha256).toBe(result.sha256);
		expect(stamp?.bundle).toBe((result.bundle as string).split("/").pop());
		expect(readdirSync(join(home, "backups")).filter((name) => name.includes(".tmp-"))).toEqual([]);
	}, 120000);
});
