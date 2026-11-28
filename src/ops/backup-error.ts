export type BackupErrorCode =
	| "db_missing"
	| "target_exists"
	| "integrity_check_failed"
	| "not_self_contained"
	| "vacuum_failed"
	| "bundle_too_large"
	| "bundle_failed"
	| "backup_vanished"
	| "backups_not_a_directory";

export class BackupError extends Error {
	readonly code: BackupErrorCode;

	constructor(code: BackupErrorCode, detail: string) {
		super(`${code}: ${detail}`);
		this.name = "BackupError";
		this.code = code;
	}
}
