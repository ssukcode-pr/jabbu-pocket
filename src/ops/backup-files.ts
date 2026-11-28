import { createHash } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readSync, rmSync } from "node:fs";
import { errorCode } from "./apply-lock";
import { BackupError } from "./backup-error";

/** Bytes per readSync chunk when hashing a backup file: RAM stays at this size regardless of file size. */
const HASH_CHUNK_BYTES = 1024 * 1024;

export function sha256File(path: string): string {
	const hash = createHash("sha256");
	const buf = Buffer.alloc(HASH_CHUNK_BYTES);
	const fd = openSync(path, "r");
	try {
		let position = 0;
		for (;;) {
			const read = readSync(fd, buf, 0, HASH_CHUNK_BYTES, position);
			if (read === 0) break;
			hash.update(read === HASH_CHUNK_BYTES ? buf : buf.subarray(0, read));
			position += read;
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

export function fsyncFile(path: string): void {
	const fd = openSync(path, "r+");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** fsync through a read-only handle: works for a directory and for a file alike. */
export function fsyncPath(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * Links `tmp` into place as `target` and drops the temp name: unlike `renameSync`, a concurrent run that already
 * placed `target` fails with `target_exists` instead of overwriting the verified backup.
 */
export function placeFile(tmp: string, target: string): void {
	try {
		linkSync(tmp, target);
	} catch (error) {
		if (errorCode(error) === "EEXIST") throw new BackupError("target_exists", target);
		throw error;
	}
	rmSync(tmp, { force: true });
}
