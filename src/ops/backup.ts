import { Database } from "bun:sqlite";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { BackupError } from "./backup-error";
import { fsyncFile, fsyncPath, placeFile, sha256File } from "./backup-files";
import { refuseSecretHardLink, secretInodes, treeBytes } from "./backup-tree";
import { parseStampFields, parseStampTs, writeAtomic0600 } from "./stamp";

export { fsyncPath, sha256File };

/** Daily backup files live at `<home>/backups/jabbu-YYYYMMDD-HHMMSS.db`; the stamp sits next to them. */
export const BACKUP_FILE_PATTERN = /^jabbu-\d{8}-\d{6}\.db$/;
/** Daily bundle files live next to the db snapshots with the same timestamp: `jabbu-bundle-YYYYMMDD-HHMMSS.tar.gz`. */
export const BUNDLE_FILE_PATTERN = /^jabbu-bundle-\d{8}-\d{6}\.tar\.gz$/;
export const STAMP_FILE = "last-backup.ok";
export const DEFAULT_KEEP = 14;
/**
 * What the daily bundle carries next to the ledger: the omp session originals (the bot's conversation memory), the
 * config, and the non-git `workspace/` (persona, retros) and `scripts/` (monitor collectors). `<home>/secrets` is deliberately NOT on this list — backups must never grow a copy of the tokens.
 * Exported so `jabbu-pocket doctor` can tell "nothing to bundle" (a ledger-only home) from "should have bundled".
 */
export const BUNDLE_SOURCES = ["sessions", "config.json", "workspace", "scripts"] as const;
/** Combined size ceiling of the bundle sources (sessions measured 88MB on 2026-11-03, workspace/ + scripts/ ~120KB; 512MB is two orders of headroom). */
export const DEFAULT_MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

export interface BackupOptions {
	homeDir: string;
	/**
	 * How many days of daily backups to keep, per kind: every file of this run's day, the latest file of each other
	 * day (see `retentionDoomed`). 0 disables pruning. Default 14.
	 */
	keep?: number;
	/** Timestamp used for the file name (tests inject this). */
	now?: Date;
	/** Combined size ceiling of the bundle sources (tests inject this). Default 512MB. */
	maxBundleBytes?: number;
	/** The tar binary (tests inject this). Default `tar` on PATH. */
	tarBin?: string;
	/**
	 * Snapshot the db only (`apply`'s pre-restart backup): no bundle, and the stamp is left as it is - a stamp without a
	 * bundle would fail doctor's `backup bundle` check, and the daily backup keeps the stamp and its bundle fresh.
	 */
	skipBundle?: boolean;
}

export interface BackupResult {
	/** Absolute path of the verified backup file. */
	file: string;
	bytes: number;
	sha256: string;
	/** Absolute path of the sessions+config bundle, when the home had sources to bundle. */
	bundle: string | undefined;
	bundleBytes: number | undefined;
	bundleSha256: string | undefined;
	/** Path of the success stamp this run wrote; `undefined` with `skipBundle` (the stamp was left alone). */
	stamp: string | undefined;
	kept: string[];
	removed: string[];
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** Local-time stamp like `20261023-043000`, so file names sort chronologically. */
export function backupStamp(date: Date): string {
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Atomic 0600 write: temp file + rename, so a half-written stamp is never observable. */
export function writeStampAtomic(backupsDir: string, content: string, name: string = STAMP_FILE): string {
	return writeAtomic0600(join(backupsDir, name), content);
}

interface PendingBundle {
	tmp: string;
	target: string;
}

/** GNU tar's only warning that still leaves a complete archive: a file (a live session log) grew while it was read. */
const FILE_CHANGED_WARNING = /^tar: .+: file changed as we read it$/;

/** `tar -c` exit 0, or exit 1 whose every stderr line is the file-changed warning; anything else is a failure. */
function tarCreateSucceeded(exitCode: number | null, stderr: string): boolean {
	if (exitCode === 0) return true;
	if (exitCode !== 1) return false;
	const lines = stderr.split("\n").filter((line) => line.trim() !== "");
	return lines.length > 0 && lines.every((line) => FILE_CHANGED_WARNING.test(line));
}

/**
 * Tars the bundle sources (`sessions/`, `config.json`, `workspace/`, `scripts/`) of `<homeDir>` into a temp file and verifies the archive
 * lists every source. `undefined` when the home has no sources at all (a ledger-only home has nothing to bundle).
 * Anything that goes wrong fails the whole backup: a stamp must never claim a bundle that was not verified.
 */
function createPendingBundle(
	homeDir: string,
	backupsDir: string,
	stamp: string,
	maxBytes: number,
	tarBin: string,
): PendingBundle | undefined {
	// lstat, not existsSync: a dangling or cyclic top-level link is a source that must fail, not one to skip.
	const sources = BUNDLE_SOURCES.filter((name) => lstatSync(join(homeDir, name), { throwIfNoEntry: false }));
	if (sources.length === 0) return undefined;
	let tmp: string | undefined;
	try {
		const secretsDir = join(homeDir, "secrets");
		const secretsReal = existsSync(secretsDir) ? realpathSync(secretsDir) : secretsDir;
		const secrets = secretInodes(secretsReal);
		/** Top-level symlinked sources and their real targets: only that one link is followed, never links inside it. */
		const linked = new Map<string, string>();
		/** Real path of every source seen so far, plain ones included: a link into a plain source would archive it twice. */
		const reals = new Map<string, string>();
		const homeReal = realpathSync(homeDir);
		/** Directory sources that had entries before tar ran: their archive must carry at least one member below them. */
		const nonEmpty = new Set<string>();
		let bytes = 0;
		for (const source of sources) {
			const path = join(homeDir, source);
			let stat = lstatSync(path);
			let real = path;
			if (stat.isSymbolicLink()) {
				try {
					real = realpathSync(path);
				} catch (error) {
					throw new BackupError("bundle_failed", `${source} link does not resolve: ${(error as Error).message}`);
				}
				if (isWithin(real, secretsReal) || isWithin(secretsReal, real)) {
					throw new BackupError("bundle_failed", `${source} links to or around secrets/`);
				}
				stat = statSync(real);
				// A linked source must be what the plain one would be: config.json a file, the rest directories.
				if (stat.isDirectory() !== (source !== "config.json")) {
					throw new BackupError("bundle_failed", `${source} links to the wrong kind of file`);
				}
				linked.set(source, real);
			} else if (stat.isDirectory() !== (source !== "config.json")) {
				throw new BackupError("bundle_failed", `${source} is the wrong kind of file`);
			}
			const here = linked.get(source) ?? join(homeReal, source);
			for (const [other, otherReal] of reals) {
				if (isWithin(here, otherReal) || isWithin(otherReal, here)) {
					throw new BackupError("bundle_failed", `${source} and ${other} link to overlapping paths`);
				}
			}
			// secrets/ may itself be a link: one that lands inside a source would put the tokens into the bundle.
			if (isWithin(secretsReal, here)) {
				throw new BackupError("bundle_failed", `secrets/ resolves inside ${source}`);
			}
			reals.set(source, here);
			if (stat.isDirectory()) {
				bytes += treeBytes(real, source, secrets);
				// tar skips sockets ("socket ignored"): a source holding only those archives no member below itself.
				if (readdirSync(real, { withFileTypes: true }).some((entry) => !entry.isSocket())) nonEmpty.add(source);
			} else {
				refuseSecretHardLink(stat, source, secrets);
				bytes += stat.size;
			}
		}
		if (bytes > maxBytes) throw new BackupError("bundle_too_large", `${bytes} > ${maxBytes}`);

		const target = join(backupsDir, `jabbu-bundle-${stamp}.tar.gz`);
		if (existsSync(target)) throw new BackupError("target_exists", target);
		tmp = `${target}.tmp-${crypto.randomUUID()}`;
		// No global -h: that would follow links inside the sources too (out of home, into secrets/). A linked source is
		// archived from / as `./<real path>` - a name no plain source under -C home can carry - and GNU tar's
		// --transform (global, not positional) renames it back to the source name; S leaves symlink targets alone.
		const transforms = [...linked].map(
			([source, real]) =>
				`--transform=s,^\\./${real.slice(1).replace(/[\\.[\]*^$,]/g, "\\$&")}\\(/\\|$\\),${source}\\1,S`,
		);
		const plain = sources.filter((source) => !linked.has(source));
		const create = Bun.spawnSync([
			tarBin,
			"-czf",
			tmp,
			// GNU tar unquotes backslash escapes in member names given on the command line: a literal `\` in a real path must stay one.
			"--no-unquote",
			...transforms,
			...(plain.length > 0 ? ["-C", homeDir, ...plain] : []),
			...(linked.size > 0 ? ["-C", "/", ...[...linked.values()].map((real) => `.${real}`)] : []),
		]);
		if (!tarCreateSucceeded(create.exitCode, create.stderr.toString())) {
			throw new BackupError("bundle_failed", create.stderr.toString().trim().slice(0, 200));
		}
		const list = Bun.spawnSync([tarBin, "-tzf", tmp]);
		if (list.exitCode !== 0) {
			throw new BackupError("bundle_failed", list.stderr.toString().trim().slice(0, 200));
		}
		const entries = list.stdout.toString().split("\n");
		for (const source of sources) {
			const listed = entries.some((line) => line === source || line.startsWith(`${source}/`));
			if (!listed) throw new BackupError("bundle_failed", `archive is missing ${source}`);
			if (
				nonEmpty.has(source) &&
				!entries.some((line) => line.startsWith(`${source}/`) && line.length > source.length + 1)
			) {
				throw new BackupError("bundle_failed", `archive is missing the contents of ${source}`);
			}
		}
		chmodSync(tmp, 0o600);
		return { tmp, target };
	} catch (error) {
		if (tmp !== undefined) rmSync(tmp, { force: true });
		if (error instanceof BackupError) throw error;
		throw new BackupError("bundle_failed", error instanceof Error ? error.message : String(error));
	}
}

/**
 * Creates a consistent single-file snapshot of `<homeDir>/jabbu.db` and verifies it before it counts, then bundles
 * `sessions/`, `config.json`, `workspace/` and `scripts/` (conversation memory, persona, collectors) into a verified tar.gz next to it.
 *
 * The snapshot is made with SQLite `VACUUM INTO` from a read-only connection, so the live WAL/SHM sidecars are never
 * copied and the daemon does not have to be involved (or even running). The copy is written to a temp name, checked
 * with `PRAGMA quick_check`, and only then linked into place - a failed backup never leaves a newest-mtime file
 * behind that a freshness check could mistake for a good one. The bundle is built and listed before either link,
 * so a bundle failure leaves no partial backup at all. The success stamp (`last-backup.ok`, including the bundle's
 * name and sha256) is written last, and pruning runs only after the new backup is on disk. `skipBundle` makes and
 * verifies the db snapshot alone and writes no stamp.
 */
export function runBackup(options: BackupOptions): BackupResult {
	const keep = options.keep ?? DEFAULT_KEEP;
	const homeDir = options.homeDir;
	const dbPath = join(homeDir, "jabbu.db");
	// A FIFO in the ledger's place would block the read-only open forever: it counts as missing.
	if (!existsSync(dbPath) || !statSync(dbPath).isFile()) throw new BackupError("db_missing", dbPath);

	const backupsDir = join(homeDir, "backups");
	// A file or dangling link in the directory's place would die in mkdir with a raw EEXIST.
	if (
		!statSync(backupsDir, { throwIfNoEntry: false })?.isDirectory() &&
		lstatSync(backupsDir, { throwIfNoEntry: false })
	) {
		throw new BackupError("backups_not_a_directory", backupsDir);
	}
	mkdirSync(backupsDir, { recursive: true, mode: 0o700 });

	const now = options.now ?? new Date();
	const stamp = backupStamp(now);
	const target = join(backupsDir, `jabbu-${stamp}.db`);
	if (existsSync(target)) throw new BackupError("target_exists", target);
	const tmp = `${target}.tmp-${crypto.randomUUID()}`;

	let bundle: PendingBundle | undefined;
	// Targets this run linked into place: only those are this run's to remove on failure.
	let placedDb = false;
	let placedBundle = false;
	try {
		const source = new Database(dbPath, { readonly: true, strict: true });
		try {
			source.run("PRAGMA busy_timeout=5000");
			try {
				source.query("VACUUM INTO ?").run(tmp);
			} catch (error) {
				throw new BackupError("vacuum_failed", error instanceof Error ? error.message : String(error));
			}
		} finally {
			source.close();
		}
		chmodSync(tmp, 0o600);
		fsyncFile(tmp);

		const sidecar = ["-wal", "-shm"].map((suffix) => `${tmp}${suffix}`).find((path) => existsSync(path));
		if (sidecar !== undefined) throw new BackupError("not_self_contained", sidecar);

		const copy = new Database(tmp, { readonly: true, strict: true });
		let check: string;
		try {
			const row = copy.query("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
			check = row?.quick_check ?? "";
		} finally {
			copy.close();
		}
		if (check !== "ok") throw new BackupError("integrity_check_failed", `quick_check=${check}`);

		bundle =
			options.skipBundle === true
				? undefined
				: createPendingBundle(
						homeDir,
						backupsDir,
						stamp,
						options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES,
						options.tarBin ?? "tar",
					);
		placeFile(tmp, target);
		placedDb = true;
		if (bundle !== undefined) {
			placeFile(bundle.tmp, bundle.target);
			placedBundle = true;
		}
		fsyncPath(backupsDir);
	} catch (error) {
		rmSync(tmp, { force: true });
		rmSync(`${tmp}-wal`, { force: true });
		rmSync(`${tmp}-shm`, { force: true });
		if (bundle !== undefined) rmSync(bundle.tmp, { force: true });
		// A placed target without its bundle or stamp is a newest-mtime file that would fake a good backup, so
		// this run's own placed files go too — but never a target another run placed.
		if (placedDb) rmSync(target, { force: true });
		if (bundle !== undefined && placedBundle) rmSync(bundle.target, { force: true });
		throw error;
	}

	// A concurrent run can no longer delete this run's placed targets, but a prune (or an operator) still could:
	// a vanished target is a BackupError, never a raw ENOENT, and no stamp is written for a missing file.
	if (!existsSync(target) || (bundle !== undefined && !existsSync(bundle.target)))
		throw new BackupError("backup_vanished", target);
	const bytes = statSync(target).size;
	const sha256 = sha256File(target);
	const bundleBytes = bundle === undefined ? undefined : statSync(bundle.target).size;
	const bundleSha256 = bundle === undefined ? undefined : sha256File(bundle.target);
	const bundleName = bundle === undefined ? undefined : bundle.target.split("/").pop();
	let stampPath: string | undefined;
	if (options.skipBundle !== true) {
		try {
			stampPath = writeStampAtomic(
				backupsDir,
				`ts=${now.toISOString()} file=${target.split("/").pop()} bytes=${bytes} sha256=${sha256} integrity=ok check=quick_check${
					bundle === undefined ? "" : ` bundle=${bundleName} bundle_bytes=${bundleBytes} bundle_sha256=${bundleSha256}`
				}\n`,
			);
		} catch (error) {
			// Without their stamp only this run's own placed files are leftovers, never another run's backup.
			if (placedDb) rmSync(target, { force: true });
			if (bundle !== undefined && placedBundle) rmSync(bundle.target, { force: true });
			throw error;
		}
	}

	const removed =
		keep > 0 ? pruneBackups(backupsDir, keep, bundle === undefined ? target : [target, bundle.target]) : [];
	const kept = readdirSync(backupsDir)
		.filter((name) => BACKUP_FILE_PATTERN.test(name))
		.sort()
		.reverse()
		.map((name) => join(backupsDir, name));

	return {
		file: target,
		bytes,
		sha256,
		bundle: bundle?.target,
		bundleBytes,
		bundleSha256,
		stamp: stampPath,
		kept,
		removed,
	};
}

/**
 * Day retention for one kind of daily file (`pattern`), shared by the local prune and the off-site pass. A day is
 * the `YYYYMMDD` of the name's stamp (no time zone conversion). The base day is the day of the `protect` names (the
 * files this run made) - or, without one, the newest stamp's day - and every file of it stays; the other `keep - 1`
 * newest days keep only their latest file, so a clock that stepped back (future-dated names) cannot shrink the run's
 * own day. Returns the names to delete, newest name first; names outside `pattern` and `protect` are never in it.
 */
export function retentionDoomed(
	names: readonly string[],
	keep: number,
	protect: readonly string[],
	pattern: RegExp,
): string[] {
	const daily = names
		.filter((name) => pattern.test(name))
		.sort()
		.reverse();
	const dayOf = (name: string) => name.match(/(\d{8})-\d{6}/)?.[1] ?? "";
	const baseDays = new Set(protect.filter((name) => pattern.test(name)).map(dayOf));
	if (baseDays.size === 0 && daily[0] !== undefined) baseDays.add(dayOf(daily[0]));
	const otherDays = [...new Set(daily.map(dayOf))].filter((day) => !baseDays.has(day));
	const keptDays = new Set(otherDays.slice(0, Math.max(0, keep - baseDays.size)));
	const doomed: string[] = [];
	for (const name of daily) {
		const day = dayOf(name);
		// a protected name's day is a base day, so protect is never doomed
		if (baseDays.has(day)) continue;
		// daily is newest-first, so the first name seen of a kept day is its latest
		if (keptDays.delete(day)) continue;
		doomed.push(name);
	}
	return doomed;
}

/**
 * Applies `retentionDoomed` to the db snapshots and the bundles separately (`keep` days per kind, `protect` = the
 * absolute paths this run made), deleting newest-first by name. The patterns only match the timestamped daily
 * names, so manual copies (`jabbu-pre-upgrade-…db`, `.bak-…`) and the stamp are never touched.
 */
export function pruneBackups(backupsDir: string, keep: number, protect: string | readonly string[]): string[] {
	const guarded = (typeof protect === "string" ? [protect] : protect).map((path) => basename(path));
	const names = readdirSync(backupsDir, { withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => e.name);
	const removed: string[] = [];
	for (const kind of [BACKUP_FILE_PATTERN, BUNDLE_FILE_PATTERN]) {
		for (const name of retentionDoomed(names, keep, guarded, kind)) {
			const path = join(backupsDir, name);
			try {
				rmSync(path, { force: true });
				removed.push(path);
			} catch {
				// retention is best effort: the new backup is already verified and stamped
			}
		}
	}
	return removed;
}

export interface StampInfo {
	/** ISO timestamp parsed from the stamp content; falls back to the file mtime. */
	ts: Date;
	file: string | undefined;
	bytes: number | undefined;
	sha256: string | undefined;
	/** Bundle fields (present once a backup also wrote a verified sessions+config bundle). */
	bundle: string | undefined;
	bundleBytes: number | undefined;
	bundleSha256: string | undefined;
}

/** `child` is `parent` or below it (`/` as parent holds everything: `${parent}/` would be `//`). */
function isWithin(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent === "/" ? "/" : `${parent}/`);
}

/** Reads the success stamp written by `runBackup`; `undefined` when it does not exist or is unreadable. */
export function readStamp(backupsDir: string, name: string = STAMP_FILE): StampInfo | undefined {
	const stampPath = join(backupsDir, name);
	let text: string;
	try {
		// A FIFO in the stamp's place would block the read forever.
		if (!statSync(stampPath).isFile()) return undefined;
		text = readFileSync(stampPath, "utf8");
	} catch {
		return undefined;
	}
	const fields = parseStampFields(text);
	const ts = parseStampTs(fields);
	if (ts === undefined) return undefined;
	return {
		ts,
		file: fields.get("file"),
		bytes: fields.get("bytes") === undefined ? undefined : Number(fields.get("bytes")),
		sha256: fields.get("sha256"),
		bundle: fields.get("bundle"),
		bundleBytes: fields.get("bundle_bytes") === undefined ? undefined : Number(fields.get("bundle_bytes")),
		bundleSha256: fields.get("bundle_sha256"),
	};
}
