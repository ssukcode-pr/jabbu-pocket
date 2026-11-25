import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBotStore } from "../src/core/origin";
import type { InboundState, Store } from "../src/store/db";
import { assertInboundTransition, INBOUND_TRANSITIONS, StoreError } from "../src/store/transitions";

const STATES: InboundState[] = [
	"pending",
	"sending",
	"dispatched",
	"answered",
	"failed_notified",
	"discarded",
	"uncertain",
];

let dir: string;
let store: Store;
let counter = 0;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-sending-"));
	store = openBotStore(join(dir, "jabbu.db"), { now: () => 1_000_000 }, "Asia/Seoul");
	store.ensureOrigin("o1", join(dir, "s1"));
	store.ensureOrigin("o2", join(dir, "s2"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function row(originKey = "o1"): string {
	const id = `m${++counter}`;
	store.recordInbound({ originKey, platformMessageId: id, textRef: `text ${id}` });
	return id;
}

function sending(originKey = "o1"): string {
	const id = row(originKey);
	store.markSending(id, `cursor-${id}`);
	return id;
}

const invalid = (fn: () => unknown) => expect(fn).toThrow(StoreError);

describe("inbound transitions with sending", () => {
	test("pending -> sending -> dispatched | uncertain | pending; every other move into or out of sending is refused", () => {
		expect([...INBOUND_TRANSITIONS.sending].sort()).toEqual(["dispatched", "pending", "uncertain"]);
		for (const from of STATES) {
			for (const to of STATES) {
				const allowed = INBOUND_TRANSITIONS[from].includes(to);
				if (from === "sending") expect(allowed).toBe(["dispatched", "uncertain", "pending"].includes(to));
				else if (to === "sending") expect(allowed).toBe(from === "pending");
				if (allowed) assertInboundTransition(from, to);
				else invalid(() => assertInboundTransition(from, to));
			}
		}
	});

	test("markSending writes the state and the cursor; only from pending", () => {
		const id = row();
		expect(store.markSending(id, "leaf-7")).toMatchObject({ state: "sending", entryCursor: "leaf-7", opRef: null });
		invalid(() => store.markSending(id, "again"));
		const dispatched = row();
		store.markDispatched(dispatched, { opRef: "op", entryCursor: null });
		invalid(() => store.markSending(dispatched, null));
		const parked = row();
		store.markUncertain(parked, "steer_threw");
		invalid(() => store.markSending(parked, null));
	});

	test("a sending row ends as dispatched, uncertain or pending", () => {
		const sent = sending();
		expect(store.markDispatched(sent, { opRef: "op-1", entryCursor: "c" })).toMatchObject({ state: "dispatched" });
		const timedOut = sending();
		expect(store.markUncertain(timedOut, "prompt_timeout")).toMatchObject({
			state: "uncertain",
			uncertainReason: "prompt_timeout",
		});
		const unsent = sending();
		expect(store.releaseSending(unsent).state).toBe("pending");
	});

	test("a sending row cannot be discarded or retried as uncertain; release needs sending", () => {
		const id = sending();
		invalid(() => store.discard(id));
		invalid(() => store.retryUncertain(id));
		expect(store.getInbound(id)?.state).toBe("sending");
		invalid(() => store.releaseSending(row()));
		const parked = row();
		store.markUncertain(parked, "steer_threw");
		invalid(() => store.releaseSending(parked));
		expect(store.retryUncertain(parked).state).toBe("pending");
	});

	test("parkSending parks one origin's sending rows (or all) as send_interrupted and leaves the rest", () => {
		const a = sending("o1");
		const b = sending("o2");
		const waiting = row("o1");
		expect(store.parkSending("o1").map((parked) => parked.platformMessageId)).toEqual([a]);
		expect(store.getInbound(a)).toMatchObject({ state: "uncertain", uncertainReason: "send_interrupted" });
		expect(store.getInbound(b)?.state).toBe("sending");
		expect(store.getInbound(waiting)?.state).toBe("pending");
		expect(store.parkSending().map((parked) => parked.platformMessageId)).toEqual([b]);
		expect(store.parkSending()).toEqual([]);
	});

	test("counts: a sending row counts as dispatched (running)", () => {
		sending();
		const dispatched = row();
		store.markDispatched(dispatched, { opRef: "op", entryCursor: null });
		row();
		expect(store.countInboundByState()).toEqual({ dispatched: 2, pending: 1 });
	});
});
