// `jabbu-pocket quota status|lift|clear` CLI 명령.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	clearQuotaLift,
	type QuotaLiftEntry,
	readQuotaGateSnapshot,
	readQuotaLifts,
	writeQuotaLift,
} from "../ops/quota-gate";
import { QUOTA_RECOVERY_CURSOR, QuotaRecoveryTracker, type RuntimeQuotaHold } from "../ops/quota-recovery";

export const QUOTA_USAGE = `  quota status [--json]          show active per-provider quota holds and manual lifts
  quota lift [provider] [--minutes N]    temporarily lift quota holds (default 60m; omit provider for all)
  quota clear [provider]         remove manual quota lift(s)
`;

const DEFAULT_LIFT_MINUTES = 60;
const MAX_LIFT_MINUTES = 1440;
const PROVIDER_ARG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Runtime quota holds the daemon restored from the store cursor (`quota_recovery:holds`), still blocking at `now`.
 * Gate holds live in `quota-gate.json`; this is the queue-blocking side `quota status` omitted. A missing DB,
 * missing cursor table, or unreadable cursor means none — status never fails over it.
 */
function readRuntimeQuotaHolds(
	homeDir: string,
	now: number,
	lifts: ReadonlyMap<string, QuotaLiftEntry>,
): RuntimeQuotaHold[] {
	const dbPath = join(homeDir, "jabbu.db");
	if (!existsSync(dbPath)) return [];
	let raw: string | undefined;
	try {
		const db = new Database(dbPath, { readonly: true, strict: true });
		try {
			const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'slack_cursors'").get();
			if (table === null) return [];
			const row = db.query("SELECT last_ts FROM slack_cursors WHERE cursor_key = ?").get(QUOTA_RECOVERY_CURSOR) as {
				last_ts: string;
			} | null;
			raw = row?.last_ts;
		} finally {
			db.close();
		}
	} catch {
		return [];
	}
	if (raw === undefined) return [];
	const tracker = new QuotaRecoveryTracker();
	tracker.restore(raw);
	return tracker.listHolds().filter((hold) => tracker.holdForProvider(hold.provider, now, lifts) !== undefined);
}

function validProviderArg(raw: string): boolean {
	return raw === "*" || PROVIDER_ARG.test(raw);
}

/** `jabbu-pocket quota <status|lift|clear>` 실행기. */
export function quotaCommand(args: string[], homeDir: string, now: () => number = Date.now): number {
	const [sub, ...rest] = args;
	if (sub === "status") {
		const { values, positionals } = parseArgs({
			args: rest,
			options: { json: { type: "boolean" } },
			allowPositionals: true,
		});
		if (positionals.length > 0) {
			process.stderr.write(`quota status: too many arguments\n${QUOTA_USAGE}`);
			return 2;
		}
		const at = now();
		const snapshot = readQuotaGateSnapshot(homeDir, at);
		const liftsMap = readQuotaLifts(homeDir, at);
		const lifts = [...liftsMap.values()].sort((a, b) => a.provider.localeCompare(b.provider));
		const runtimeHolds = readRuntimeQuotaHolds(homeDir, at, liftsMap);
		if (values.json === true) {
			process.stdout.write(`${JSON.stringify({ ...snapshot, lifts, runtimeHolds })}\n`);
			return 0;
		}
		const updated = snapshot.updatedAt === null ? "never" : new Date(snapshot.updatedAt).toISOString();
		const mode = snapshot.mode === "warn" ? " mode=warn" : "";
		const err = snapshot.lastError === undefined ? "" : ` last_error=${JSON.stringify(snapshot.lastError)}`;
		process.stdout.write(
			`quota_status held=${snapshot.held.length} runtime_held=${runtimeHolds.length} lifts=${lifts.length} updated=${updated}${mode}${err}\n`,
		);
		for (const hold of snapshot.held) {
			const causes = hold.causes
				.map((cause) => `${cause.label}:${Math.round(cause.usedPct)}%->${new Date(cause.releaseAt).toISOString()}`)
				.join(",");
			process.stdout.write(`hold provider=${hold.provider} causes=${causes}\n`);
		}
		for (const hold of runtimeHolds) {
			const reset = hold.resetAt === undefined ? "" : ` reset=${new Date(hold.resetAt).toISOString()}`;
			process.stdout.write(`runtime_hold provider=${hold.provider} origins=${hold.origins.length}${reset}\n`);
		}
		for (const lift of lifts) {
			process.stdout.write(`lift provider=${lift.provider} until=${new Date(lift.untilMs).toISOString()}\n`);
		}
		return 0;
	}
	if (sub === "lift") {
		const { values, positionals } = parseArgs({
			args: rest,
			options: { minutes: { type: "string" } },
			allowPositionals: true,
		});
		if (positionals.length > 1) {
			process.stderr.write(`quota lift: too many arguments\n${QUOTA_USAGE}`);
			return 2;
		}
		const rawProvider = positionals[0];
		if (rawProvider !== undefined && !validProviderArg(rawProvider)) {
			process.stderr.write(`quota lift: invalid provider ${rawProvider}\n${QUOTA_USAGE}`);
			return 2;
		}
		let minutes = DEFAULT_LIFT_MINUTES;
		if (values.minutes !== undefined) {
			minutes = /^\d+$/.test(values.minutes) ? Number(values.minutes) : Number.NaN;
			if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_LIFT_MINUTES) {
				process.stderr.write(`quota lift: --minutes must be an integer between 1 and ${MAX_LIFT_MINUTES}\n`);
				return 2;
			}
		}
		if (!existsSync(homeDir)) {
			process.stderr.write(`quota lift: home directory does not exist: ${homeDir}\n`);
			return 1;
		}
		const provider = rawProvider === undefined ? "*" : rawProvider.toLowerCase();
		const at = now();
		const entry = writeQuotaLift(homeDir, { provider, untilMs: at + minutes * 60_000, now: at });
		process.stdout.write(
			`quota_lifted provider=${entry.provider} minutes=${minutes} until=${new Date(entry.untilMs).toISOString()}\n`,
		);
		return 0;
	}
	if (sub === "clear") {
		const { positionals } = parseArgs({ args: rest, allowPositionals: true });
		if (positionals.length > 1) {
			process.stderr.write(`quota clear: too many arguments\n${QUOTA_USAGE}`);
			return 2;
		}
		const rawProvider = positionals[0];
		if (rawProvider !== undefined && !validProviderArg(rawProvider)) {
			process.stderr.write(`quota clear: invalid provider ${rawProvider}\n${QUOTA_USAGE}`);
			return 2;
		}
		const provider = rawProvider === undefined ? undefined : rawProvider.toLowerCase();
		const count = clearQuotaLift(homeDir, provider);
		process.stdout.write(`quota_cleared provider=${provider ?? "*"} count=${count}\n`);
		return 0;
	}
	process.stderr.write(`usage: jabbu-pocket quota <status|lift|clear>\n${QUOTA_USAGE}`);
	return 2;
}
