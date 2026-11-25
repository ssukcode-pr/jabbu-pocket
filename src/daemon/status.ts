import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { type MonitorRow, type MonitorSql, nextFireOf, toMonitor } from "../monitors/ledger";
import type { AgyAccountsStatus } from "../omp/agy-account-pool";
import { type FreezeState, readFreeze } from "../ops/freeze";
import { assertRegularLedger, type ConfigGateOptions, collectGates } from "../ops/gates";
import type { HostLoadReader, StatfsReader } from "../ops/host-resources";
import { type HostSessionsInfo, hostSessionsInfo } from "../ops/host-sessions";
import { type DeliveryState, INBOUND_COUNT_SQL, type InboundState, type Store } from "../store/db";

export { renderStatusText } from "./status-render";

export interface OriginStatus {
	originKey: string;
	epoch: number;
	/** Pid of the live omp child; null when none is running. */
	ompPid: number | null;
	busy: boolean;
}

export interface StatusReport {
	ompVersion: string;
	/** The bot's zone (`config.timezone`) and whether the report came from the running daemon. */
	timezone: string;
	daemonRunning: boolean;
	origins: OriginStatus[];
	ledger: { pending: number; inflight: number; confirmed: number; ambiguous: number; expired: number };
	inbound: Record<Exclude<InboundState, "sending">, number>; // a `sending` row counts as dispatched (running)
	monitors: MonitorsStatus;
	/** Open health gates (the same projection as `jabbu-pocket gates`); empty when every gate is closed. */
	openGates: OpenGateSummary[];
	/** Present while `<home>/FROZEN` exists: no autonomous action runs, owner conversation continues. */
	frozen?: FreezeState;
	/** Present while `jabbu-pocket drain` holds new work back for a restart: what is still unfinished. */
	drain?: DrainCounts;
	/** Running omp RPC sessions on this host and ceiling (0 = off). */
	hostSessions?: HostSessionsInfo;
	/** Active and blocked aliases of the `agy` account pool, when enabled. */
	agyAccounts?: AgyAccountsStatus;
}

/** Unfinished work a restart drain waits for; the drain completes when all three are 0. */
export interface DrainCounts {
	turns: number;
	hostTools: number;
	approvals: number;
}

export interface OpenGateSummary {
	name: string;
	detail: string;
}

export interface MonitorsStatus {
	count: number;
	/** The soonest fire among enabled monitors; `at` is an ISO instant. */
	next: { name: string; at: string } | null;
}

export function summarizeMonitors(rows: MonitorRow[]): MonitorsStatus {
	let next: { name: string; at: number } | null = null;
	for (const row of rows) {
		const at = nextFireOf(row);
		if (at !== null && (next === null || at < next.at)) next = { name: row.name, at };
	}
	return { count: rows.length, next: next === null ? null : { name: next.name, at: new Date(next.at).toISOString() } };
}

const emptyInbound = (): StatusReport["inbound"] => ({
	pending: 0,
	dispatched: 0,
	answered: 0,
	failed_notified: 0,
	discarded: 0,
	uncertain: 0,
});

function ledgerFrom(counts: Partial<Record<DeliveryState, number>>): StatusReport["ledger"] {
	return {
		pending: counts.pending ?? 0,
		inflight: counts.inflight ?? 0,
		confirmed: counts.confirmed ?? 0,
		ambiguous: counts.failed_ambiguous ?? 0,
		expired: counts.expired ?? 0,
	};
}

export interface LiveOrigin {
	ompPid: number | null;
	busy: boolean;
}

export function frozenField(homeDir: string): { frozen?: FreezeState } {
	const frozen = readFreeze(homeDir);
	return frozen === undefined ? {} : { frozen };
}

/** Open gates of a home, as the status lines list them; the daemon and the CLI fallback use the same projection. */
export function openGateSummary(
	dbPath: string,
	now = Date.now(),
	/** `gateOptionsFromConfig(config)`: the same gates the daemon's sweep judges. */
	gateOptions: ConfigGateOptions = {},
	/** Test seam for `host_pressure` (default this machine's readings). */
	hostLoad?: Partial<HostLoadReader>,
	/** Test seam for `disk_low` (default `statfsSync`). */
	statfs?: StatfsReader,
): OpenGateSummary[] {
	return collectGates({
		homeDir: dirname(dbPath),
		now,
		...gateOptions,
		...(hostLoad === undefined ? {} : { hostLoad }),
		...(statfs === undefined ? {} : { statfs }),
	})
		.filter((gate) => gate.state === "open")
		.map((gate) => ({ name: gate.name, detail: gate.detail }));
}

/** Report from the daemon's own store; `live` supplies the per-origin process facts only the daemon knows. */
export function buildStatus(
	store: Store,
	ompVersion: string,
	timezone: string,
	live: (originKey: string) => LiveOrigin,
	openGates: OpenGateSummary[] = [],
): StatusReport {
	const counts = store.countInboundByState();
	const inbound = emptyInbound();
	for (const state of Object.keys(inbound) as Array<keyof typeof inbound>) inbound[state] = counts[state] ?? 0;
	const deliveryCounts = store.countDeliveriesByState();
	const origins: OriginStatus[] = [];
	for (const originKey of store.distinctInboundOrigins()) {
		const origin = store.getOrigin(originKey);
		if (origin) origins.push({ originKey, epoch: origin.epoch, ...live(originKey) });
	}
	return {
		ompVersion,
		timezone,
		daemonRunning: true,
		origins,
		ledger: ledgerFrom(deliveryCounts),
		inbound,
		monitors: summarizeMonitors(store.monitors.listMonitors()),
		openGates,
	};
}

/** Read-only fallback when no daemon answers: never opens a `Store`, because opening one re-queues inflight deliveries. */
export function readStatusFromDb(
	dbPath: string,
	ompVersion: string,
	timezone: string,
	gateOptions: ConfigGateOptions = {},
	hostLoad?: Partial<HostLoadReader>,
): StatusReport {
	const openGates = (): OpenGateSummary[] => openGateSummary(dbPath, Date.now(), gateOptions, hostLoad);
	let db: Database | undefined;
	let counts: Pick<StatusReport, "inbound" | "ledger" | "origins" | "monitors">;
	try {
		assertRegularLedger(dbPath);
		db = new Database(dbPath, { readonly: true, strict: true });
		counts = readCoreCounts(db);
	} catch (error) {
		// A 0-byte, corrupt or table-less ledger still emits a report naming the open `ledger_unreadable` gate.
		const reason = error instanceof Error ? error.message : String(error);
		const gates = openGates();
		return {
			ompVersion,
			timezone,
			daemonRunning: false,
			origins: [],
			ledger: ledgerFrom({}),
			inbound: emptyInbound(),
			monitors: { count: 0, next: null },
			openGates: gates.some((gate) => gate.name === "ledger_unreadable")
				? gates
				: [{ name: "ledger_unreadable", detail: `error=${reason.replace(/\s+/g, " ").slice(0, 120)}` }, ...gates],
			...frozenField(dirname(dbPath)),
		};
	} finally {
		db?.close();
	}
	return {
		ompVersion,
		timezone,
		daemonRunning: false,
		...counts,
		openGates: openGates(),
		...hostSessionsInfo(gateOptions.hostSessionCeiling),
		...frozenField(dirname(dbPath)),
	};
}

/** Inbound and delivery counts, origins and monitors of a read-only handle; throws on an unreadable ledger. */
function readCoreCounts(db: Database): Pick<StatusReport, "inbound" | "ledger" | "origins" | "monitors"> {
	// No prototype: a stored state named `__proto__` is counted like any other, not swallowed by the setter (qa-l #11).
	const inbound = Object.assign(Object.create(null) as Record<InboundState, number>, emptyInbound());
	for (const row of db.query(INBOUND_COUNT_SQL).all() as Array<{
		state: InboundState;
		n: number;
	}>) {
		inbound[row.state] = row.n;
	}
	const deliveryCounts: Partial<Record<DeliveryState, number>> = {};
	for (const row of db.query("SELECT state, COUNT(*) AS n FROM deliveries GROUP BY state").all() as Array<{
		state: DeliveryState;
		n: number;
	}>) {
		deliveryCounts[row.state] = row.n;
	}
	const origins = (
		db.query("SELECT origin_key, epoch FROM origins ORDER BY origin_key").all() as Array<{
			origin_key: string;
			epoch: number;
		}>
	).map((row) => ({ originKey: row.origin_key, epoch: row.epoch, ompPid: null, busy: false }));
	return { inbound, ledger: ledgerFrom(deliveryCounts), origins, monitors: readMonitorsStatus(db) };
}

/** Monitor count and next fire from a read-only handle; a database that predates monitors has none. */
function readMonitorsStatus(db: Database): MonitorsStatus {
	try {
		const rows = db.query("SELECT * FROM monitors ORDER BY created_at, id").all() as MonitorSql[];
		// A bad row still counts as a monitor without next fire, matching `gates`.
		const readable: MonitorRow[] = [];
		for (const raw of rows) {
			try {
				const row = toMonitor(raw);
				nextFireOf(row);
				readable.push(row);
			} catch {
				// counted below, not scheduled
			}
		}
		return { ...summarizeMonitors(readable), count: rows.length };
	} catch (error) {
		if (error instanceof Error && /no such table/.test(error.message)) return { count: 0, next: null };
		throw error;
	}
}
