// Web deliveries: error classification (a transient store error holds the row instead of burning a definitive
// attempt) and idempotency (a repost after a failed confirm is a no-op, not a visible duplicate).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryItem, DeliverySource } from "../src/channel/types";
import { TOP_LEVEL_TS, threadRefOf } from "../src/core/normalize";
import { chatOriginKey } from "../src/core/origin-key";
import { createLogger } from "../src/log";
import { openStore, type Store } from "../src/store/db";
import { readWebMessages, type WebMessageStore } from "../src/store/web-messages";
import { WebAdapter } from "../src/web/adapter";
import { WebChannel } from "../src/web/channel";

const CONV = "w_aaaaaaaa";
const refOf = threadRefOf(CONV, TOP_LEVEL_TS);
const originOf = chatOriginKey({ platform: "web", kind: "dm", conversationId: CONV });

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function open(dir: string, clock: { now(): number }): Store {
	const store = openStore({ path: join(dir, "jabbu.db"), timezone: "Asia/Seoul", clock, redact: (t) => t });
	stores.push(store);
	return store;
}

function sourceFor(store: Store, failed: Array<{ id: number; outcome: string }>, confirmThrows: { now: boolean }) {
	const deliveries: DeliverySource = {
		// The daemon wires the web source this way: a recovered repost cannot duplicate the answer.
		repostIsIdempotent: true,
		claimDue: () =>
			store.claimDue(undefined, "web").map(
				(r): DeliveryItem => ({
					deliveryId: r.deliveryId,
					originKey: r.originKey,
					threadRef: r.threadRef,
					body: r.body,
					redelivered: r.redelivered,
					sentParts: r.sentParts,
					replyTs: r.replyTs,
				}),
			),
		confirm: (id) => {
			if (confirmThrows.now) {
				confirmThrows.now = false;
				throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
			}
			store.confirmDelivery(id);
		},
		fail: (id, error, outcome, sentParts, replyTs) => {
			failed.push({ id, outcome });
			if (outcome === "definitive") return store.failDelivery(id, error).state === "expired";
			store.markAmbiguous(id, error, sentParts, replyTs);
			return true;
		},
		defer: (id, error, retry) => void store.deferDelivery(id, error, retry),
	};
	return deliveries;
}

function adapterFor(store: Store, channel: WebChannel, clock: { now(): number }, deliveries: DeliverySource) {
	return new WebAdapter({
		channel,
		webStore: store.web,
		core: { onInbound: async () => ({}) } as never,
		deliveries,
		clock,
		log: createLogger({ sink: () => undefined, clock, redact: (t) => t }),
	});
}

function setup(channel?: WebChannel) {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-web-delivery-"));
	dirs.push(dir);
	const clock = {
		t: 1_700_000_000_000,
		now() {
			return this.t;
		},
	};
	const store = open(dir, clock);
	const ch = channel ?? new WebChannel();
	if (channel === undefined) ch.attach(store.web);
	const failed: Array<{ id: number; outcome: string }> = [];
	const confirmThrows = { now: false };
	const deliveries = sourceFor(store, failed, confirmThrows);
	const adapter = adapterFor(store, ch, clock, deliveries);
	return { dir, clock, store, channel: ch, adapter, failed, confirmThrows, deliveries };
}

/** A web answer row in the ledger for the test conversation. */
function deliver(store: Store, body = "답입니다"): number {
	store.ensureOrigin(originOf, "/s/web");
	return store.recordAnswer({ originKey: originOf, opRef: `op-${body}`, threadRef: refOf, parts: [body] })[0]
		?.deliveryId as number;
}

describe("web delivery errors", () => {
	test("a transient store error holds the row instead of burning a definitive attempt (round 14 F3)", async () => {
		// The channel's store throws SQLITE_BUSY on insert, as a contended ledger does.
		const busy = {
			insert(): never {
				throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
			},
			edit: () => undefined,
		} as unknown as WebMessageStore;
		const channel = new WebChannel();
		channel.attach(busy);
		const { dir, store, adapter, failed } = setup(channel);
		const id = deliver(store);
		await adapter.pumpDeliveries();
		expect(failed).toEqual([{ id, outcome: "ambiguous" }]);
		expect(store.getDelivery(id)).toMatchObject({ state: "failed_ambiguous", attempts: 0 });
		// Nothing was posted: the row is held for the owner, not silently expired after retries.
		expect(readWebMessages(dir, CONV)).toHaveLength(0);
	});
});

describe("web delivery idempotency", () => {
	test("a repost after a failed confirm is a no-op: one row, then confirmed (round 14 F3)", async () => {
		const { dir, clock, store, adapter, confirmThrows } = setup();
		const id = deliver(store);
		confirmThrows.now = true;
		expect(await adapter.pumpDeliveries()).toBe(0);
		// The post landed, but the confirm threw: the row stays inflight and the message is already in the UI.
		expect(store.getDelivery(id)?.state).toBe("inflight");
		expect(readWebMessages(dir, CONV).filter((m) => m.role === "assistant")).toHaveLength(1);

		// A restart recovers the inflight row as pending with the redelivered mark; the repost must not duplicate it.
		stores.splice(stores.indexOf(store), 1);
		store.close();
		const reopened = open(dir, clock);
		const channel = new WebChannel();
		channel.attach(reopened.web);
		const restarted = adapterFor(reopened, channel, clock, sourceFor(reopened, [], { now: false }));
		expect(await restarted.pumpDeliveries()).toBe(1);
		expect(reopened.getDelivery(id)?.state).toBe("confirmed");
		const rows = readWebMessages(dir, CONV).filter((m) => m.role === "assistant");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.text).toBe("답입니다");
	});
});
