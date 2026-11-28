import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Logger } from "../log";

/**
 * The improvement-candidate ledger (`<workspace>/candidates.jsonl`): one JSON line per event, appended by the
 * self-retro (`seen`) and by the daemon pass (`proposed`/`approved`/`rejected`). This module owns the ledger
 * format — parsing and compaction — so the pass in `./candidates.ts` never re-reads history that can no longer
 * become due.
 */

export type CandidateKind = "rule" | "fix" | "persona";

export type LedgerEvent =
	| {
			v: 1;
			ts: string;
			key: string;
			event: "seen";
			day: string;
			kind: CandidateKind;
			evidence: string;
			summary: string;
	  }
	| { v: 1; ts: string; key: string; event: "proposed"; via: "log" | "card"; ref?: string }
	| { v: 1; ts: string; key: string; event: "approved"; experiment: string }
	| { v: 1; ts: string; key: string; event: "rejected" };

export const DAY_MS = 86_400_000;
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: Record<string, true> = { rule: true, fix: true, persona: true };

const str = (value: unknown): value is string => typeof value === "string";

/** One line to an event, or undefined for anything malformed (wrong `v`, unknown event, missing field). */
function parseLine(line: string): LedgerEvent | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (r.v !== 1 || !str(r.ts) || Number.isNaN(Date.parse(r.ts)) || !str(r.key) || !KEY.test(r.key)) return undefined;
	const base = { v: 1 as const, ts: r.ts, key: r.key };
	switch (r.event) {
		case "seen":
			if (!str(r.day) || !DAY.test(r.day) || Number.isNaN(Date.parse(`${r.day}T00:00:00Z`))) return undefined;
			if (!str(r.kind) || KINDS[r.kind] !== true || !str(r.summary)) return undefined;
			if (r.evidence !== undefined && !str(r.evidence)) return undefined;
			return {
				...base,
				event: "seen",
				day: r.day,
				kind: r.kind as CandidateKind,
				evidence: r.evidence ?? "",
				summary: r.summary,
			};
		case "proposed":
			if (r.via !== "log" && r.via !== "card") return undefined;
			return { ...base, event: "proposed", via: r.via, ...(str(r.ref) ? { ref: r.ref } : {}) };
		case "approved":
			if (!str(r.experiment)) return undefined;
			return { ...base, event: "approved", experiment: r.experiment };
		case "rejected":
			return { ...base, event: "rejected" };
		default:
			return undefined;
	}
}

/** The ledger text to events in file order; blank, broken and other-version lines are skipped, never thrown. */
export function parseLedger(text: string): LedgerEvent[] {
	const events: LedgerEvent[] = [];
	for (const line of text.split("\n")) {
		const event = line.trim() === "" ? undefined : parseLine(line);
		if (event !== undefined) events.push(event);
	}
	return events;
}

/** A ledger over this many bytes is abnormal (a healthy one is a few KiB); worth a warn, not a refusal. */
export const MAX_LEDGER_BYTES = 1_048_576;

/**
 * Compacts the candidate ledger in place and returns the events that remain, in file order.
 *
 * The ledger is append-only and every pass re-reads it whole, so without pruning it grows forever and each
 * 5-minute sweep pays O(ledger). A line is kept only if it can still change a future fold:
 * - `seen` whose day is inside the window (plus one day of margin for clock skew), plus the latest `seen` per
 *   key even when old — the fold takes kind/summary/evidence from it, so dropping it would change the note text;
 * - the latest `proposed` per key — dropping it would end a snooze early (a key proposed, then rejected twice,
 *   is due again after the snooze only because its status is still `proposed`);
 * - the latest `approved` per key — approved is final, and dropping it would re-raise the key from its `seen`;
 * - every `rejected` — denials are owner-paced and few, and the count decides whether a key can ever return
 *   (twice-rejected never does).
 * Blank and malformed lines are dropped; they are skipped by the fold anyway. Kept lines are written back
 * byte-identical (the raw line, not a re-serialisation), so fields the parser does not know survive.
 *
 * The live file stays append-only in spirit: the compacted content is written to a temp file in the same
 * directory and atomically renamed over it, so a crash mid-write never leaves a torn ledger. If the write fails
 * the old file is left alone and the pass continues on the parsed events with a warn; a read failure still
 * throws, exactly as a plain read of the ledger would.
 */
export function compactLedger(path: string, now: number, cfg: { windowDays: number }, log: Logger): LedgerEvent[] {
	const text = readFileSync(path, "utf8");
	const bytesBefore = Buffer.byteLength(text);
	if (bytesBefore > MAX_LEDGER_BYTES) log.warn("candidate_ledger_large", { bytes: bytesBefore });
	const rawLines = text === "" ? [] : text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
	// A `seen` counts while its day is inside `now − windowDays`; one extra day of margin keeps a line whose
	// day crossed the cutoff only because the clock moved since the last pass.
	const cutoff = now - (cfg.windowDays + 1) * DAY_MS;
	const latestSeen = new Map<string, number>();
	const latestProposed = new Map<string, number>();
	const latestApproved = new Map<string, number>();
	const parsed = rawLines.map((line) => (line.trim() === "" ? undefined : parseLedger(line)[0]));
	parsed.forEach((event, index) => {
		if (event === undefined) return;
		if (event.event === "seen") latestSeen.set(event.key, index);
		else if (event.event === "proposed") latestProposed.set(event.key, index);
		else if (event.event === "approved") latestApproved.set(event.key, index);
	});
	const kept: LedgerEvent[] = [];
	const keptLines: string[] = [];
	let dropped = 0;
	parsed.forEach((event, index) => {
		const line = rawLines[index];
		if (line === undefined) return;
		const keep =
			event !== undefined &&
			(event.event === "rejected" ||
				(event.event === "seen" &&
					(Date.parse(`${event.day}T00:00:00Z`) >= cutoff || latestSeen.get(event.key) === index)) ||
				(event.event === "proposed" && latestProposed.get(event.key) === index) ||
				(event.event === "approved" && latestApproved.get(event.key) === index));
		if (keep) {
			kept.push(event);
			keptLines.push(line);
		} else {
			dropped += 1;
		}
	});
	if (dropped === 0) return kept;
	const compacted = keptLines.length === 0 ? "" : `${keptLines.join("\n")}\n`;
	const tmp = `${path}.compact-${process.pid}-${randomUUID()}`;
	try {
		writeFileSync(tmp, compacted);
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		log.warn("candidate_ledger_compact_failed", { error: String(error) });
		return kept;
	}
	log.info("candidate_ledger_compacted", {
		kept: kept.length,
		dropped,
		bytesBefore,
		bytesAfter: Buffer.byteLength(compacted),
	});
	return kept;
}
