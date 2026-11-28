import { describe, expect, test } from "bun:test";
import { DeliveryPump, type DeliverySender, type DeliverySendResult, finishDeliveryStatus } from "../src/channel/pump";
import type { DeliveryItem, DeliveryRetry, DeliverySource } from "../src/channel/types";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";

const NOW = 1_800_000_000_000;
const clock = { now: () => NOW };

function item(deliveryId: number, extra: Partial<DeliveryItem> = {}): DeliveryItem {
	return {
		deliveryId,
		originKey: "discord/dm/200000000000000001",
		threadRef: "200000000000000001:700000000000000001",
		body: `답 ${deliveryId}`,
		redelivered: false,
		...extra,
	};
}

/** One shared call log across the fake source and sender, so the order of their calls is visible. */
function harness(
	items: DeliveryItem[],
	results: Map<number, DeliverySendResult>,
	/** `gaveUp`: definitive failures the ledger expires (retries spent); `expired`: rows the ledger swept meanwhile. */
	ledger: { gaveUp?: ReadonlySet<number>; expired?: DeliveryItem[] } = {},
) {
	const calls: string[] = [];
	const lines: string[] = [];
	let blocked = false;
	const { expired } = ledger;
	const source: DeliverySource = {
		claimDue: () => {
			calls.push("claimDue");
			return items;
		},
		confirm: (id) => void calls.push(`confirm:${id}`),
		fail: (id, error, outcome, sentParts) => {
			calls.push(`fail:${id}:${error}:${outcome}:${sentParts}`);
			return ledger.gaveUp?.has(id) === true;
		},
		defer: (id, error, retry: DeliveryRetry) => void calls.push(`defer:${id}:${error}:${JSON.stringify(retry)}`),
		...(expired === undefined
			? {}
			: {
					takeExpired: () => {
						calls.push("takeExpired");
						return expired.splice(0);
					},
				}),
	};
	const sender: DeliverySender = {
		isBlocked: () => blocked,
		blockedUntil: () => NOW + 30_000,
		blockedReason: () => "chat.postMessage",
		send: async (d) => {
			calls.push(`send:${d.deliveryId}`);
			const result = results.get(d.deliveryId) ?? { kind: "sent", parts: 1 };
			if (result.kind === "deferred") blocked = true;
			return result;
		},
		afterSent: async (d) => void calls.push(`afterSent:${d.deliveryId}`),
		afterUndelivered: async (d) => void calls.push(`undelivered:${d.deliveryId}`),
	};
	const pump = new DeliveryPump({
		source,
		sender,
		clock,
		log: createLogger({ sink: (line) => lines.push(line), clock, redact }),
	});
	return {
		pump,
		calls,
		lines,
		block: () => {
			blocked = true;
		},
	};
}

describe("DeliveryPump", () => {
	test("a sent delivery is confirmed, then finished by the sender; the count is the confirmed ones", async () => {
		const { pump, calls, lines } = harness([item(1)], new Map([[1, { kind: "sent", parts: 2, path: "markdown" }]]));
		expect(await pump.pump()).toBe(1);
		expect(calls).toEqual(["claimDue", "send:1", "confirm:1", "afterSent:1"]);
		expect(lines.filter((line) => line.includes("event=delivery_sent"))).toHaveLength(1);
		expect(lines.find((line) => line.includes("event=delivery_sent"))).toContain("parts=2");
	});

	test("deferred: only defer(id, error, retry) — no confirm, no fail, no afterSent", async () => {
		const retry = { at: NOW + 5_000, sentParts: 1, replyTs: "9.9" };
		const { pump, calls, lines } = harness(
			[item(2)],
			new Map([[2, { kind: "deferred", error: new Error("ratelimited"), retry }]]),
		);
		expect(await pump.pump()).toBe(0);
		expect(calls).toEqual(["claimDue", "send:2", `defer:2:ratelimited:${JSON.stringify(retry)}`]);
		expect(lines.filter((line) => line.includes("event=delivery_deferred"))).toHaveLength(1);
	});

	test("failed definitive and failed ambiguous: only fail(id, error, outcome)", async () => {
		const { pump, calls, lines } = harness(
			[item(3), item(4)],
			new Map<number, DeliverySendResult>([
				[3, { kind: "failed", error: "channel_not_found", outcome: "definitive", sentParts: 0 }],
				[4, { kind: "failed", error: "socket hang up", outcome: "ambiguous", sentParts: 1 }],
			]),
		);
		expect(await pump.pump()).toBe(0);
		expect(calls).toEqual([
			"claimDue",
			"send:3",
			"fail:3:channel_not_found:definitive:0",
			"send:4",
			"fail:4:socket hang up:ambiguous:1",
			"undelivered:4",
		]);
		expect(lines.filter((line) => line.includes("event=delivery_failed"))).toHaveLength(2);
	});

	test("an ambiguous fail and a definitive fail that spent its retries finish the status as undelivered; a retried fail and a defer do not", async () => {
		const retry = { at: NOW + 5_000, sentParts: 0 };
		const { pump, calls } = harness(
			[item(3), item(4), item(5), item(6)],
			new Map<number, DeliverySendResult>([
				[3, { kind: "failed", error: "channel_not_found", outcome: "definitive", sentParts: 0 }],
				[4, { kind: "failed", error: "socket hang up", outcome: "ambiguous", sentParts: 1 }],
				[5, { kind: "failed", error: "channel_not_found", outcome: "definitive", sentParts: 0 }],
				[6, { kind: "deferred", error: new Error("ratelimited"), retry }],
			]),
			{ gaveUp: new Set([5]) },
		);
		expect(await pump.pump()).toBe(0);
		expect(calls).toEqual([
			"claimDue",
			"send:3",
			"fail:3:channel_not_found:definitive:0",
			"send:4",
			"fail:4:socket hang up:ambiguous:1",
			"undelivered:4",
			"send:5",
			"fail:5:channel_not_found:definitive:0",
			"undelivered:5",
			"send:6",
			`defer:6:ratelimited:${JSON.stringify(retry)}`,
		]);
	});

	test("rows the ledger expired meanwhile are finished as undelivered, even while posting is blocked", async () => {
		const { pump, calls, block } = harness([item(7)], new Map(), { expired: [item(8), item(9)] });
		block();
		expect(await pump.pump()).toBe(0);
		expect(calls).toEqual(["takeExpired", "undelivered:8", "undelivered:9"]);
	});

	test("a send that throws is failed as ambiguous and the batch goes on; nothing stays claimed", async () => {
		const items = [item(11, { sentParts: 1 }), item(12)];
		const calls: string[] = [];
		const lines: string[] = [];
		const pump = new DeliveryPump({
			source: {
				claimDue: () => {
					calls.push("claimDue");
					return items;
				},
				confirm: (id) => void calls.push(`confirm:${id}`),
				fail: (id, error, outcome, sentParts) => void calls.push(`fail:${id}:${error}:${outcome}:${sentParts}`),
				defer: (id) => void calls.push(`defer:${id}`),
			},
			sender: {
				isBlocked: () => false,
				blockedUntil: () => NOW,
				blockedReason: () => "chat.postMessage",
				send: async (d) => {
					calls.push(`send:${d.deliveryId}`);
					if (d.deliveryId === 11) throw new Error("render boom");
					return { kind: "sent", parts: 1 };
				},
				afterSent: async (d) => void calls.push(`afterSent:${d.deliveryId}`),
				afterUndelivered: async (d) => void calls.push(`undelivered:${d.deliveryId}`),
			},
			clock,
			log: createLogger({ sink: (line) => lines.push(line), clock, redact }),
		});
		expect(await pump.pump()).toBe(1);
		expect(calls).toEqual([
			"claimDue",
			"send:11",
			"fail:11:render boom:ambiguous:1",
			"undelivered:11",
			"send:12",
			"confirm:12",
			"afterSent:12",
		]);
		const failed = lines.find((line) => line.includes("event=delivery_failed")) ?? "";
		expect(failed).toContain("sent_parts=1");
		expect(failed).toContain("outcome=ambiguous");
	});

	test("an afterSent that throws keeps the confirm (it was sent) and the batch goes on", async () => {
		const calls: string[] = [];
		const lines: string[] = [];
		const pump = new DeliveryPump({
			source: {
				claimDue: () => [item(13), item(14)],
				confirm: (id) => void calls.push(`confirm:${id}`),
				fail: (id) => void calls.push(`fail:${id}`),
				defer: (id) => void calls.push(`defer:${id}`),
			},
			sender: {
				isBlocked: () => false,
				blockedUntil: () => NOW,
				blockedReason: () => "chat.postMessage",
				send: async (d) => {
					calls.push(`send:${d.deliveryId}`);
					return { kind: "sent", parts: 2 };
				},
				afterSent: async (d) => {
					calls.push(`afterSent:${d.deliveryId}`);
					if (d.deliveryId === 13) throw new Error("status boom");
				},
				afterUndelivered: async (d) => void calls.push(`undelivered:${d.deliveryId}`),
			},
			clock,
			log: createLogger({ sink: (line) => lines.push(line), clock, redact }),
		});
		expect(await pump.pump()).toBe(2);
		expect(calls).toEqual(["send:13", "confirm:13", "afterSent:13", "send:14", "confirm:14", "afterSent:14"]);
		expect(lines.some((line) => line.includes("event=delivery_after_sent_failed"))).toBe(true);
	});

	test("blocked before the claim: nothing is claimed, nothing is sent", async () => {
		const { pump, calls, block } = harness([item(5), item(6)], new Map());
		block();
		expect(await pump.pump()).toBe(0);
		expect(calls).toEqual([]);
	});

	test("isBlocked true for claimed deliveries: none is sent, all are deferred to blockedUntil", async () => {
		const calls: string[] = [];
		let blocked = false;
		const items = [item(7, { sentParts: 2 }), item(8)];
		const pump = new DeliveryPump({
			source: {
				claimDue: () => {
					calls.push("claimDue");
					blocked = true;
					return items;
				},
				confirm: (id) => void calls.push(`confirm:${id}`),
				fail: (id) => void calls.push(`fail:${id}`),
				defer: (id, error, retry) => void calls.push(`defer:${id}:${error}:${JSON.stringify(retry)}`),
			},
			sender: {
				isBlocked: () => blocked,
				blockedUntil: () => NOW + 30_000,
				blockedReason: () => "chat.postMessage",
				send: async (d) => {
					calls.push(`send:${d.deliveryId}`);
					return { kind: "sent", parts: 1 };
				},
				afterSent: async (d) => void calls.push(`afterSent:${d.deliveryId}`),
				afterUndelivered: async (d) => void calls.push(`undelivered:${d.deliveryId}`),
			},
			clock,
			log: createLogger({ sink: () => undefined, clock, redact }),
		});
		expect(await pump.pump()).toBe(0);
		expect(calls).toEqual([
			"claimDue",
			`defer:7:chat.postMessage:${JSON.stringify({ at: NOW + 30_000, sentParts: 2 })}`,
			`defer:8:chat.postMessage:${JSON.stringify({ at: NOW + 30_000, sentParts: 0 })}`,
		]);
	});

	test("a deferred send blocks the rest of the batch: they go back unsent", async () => {
		const retry = { at: NOW + 1_000, sentParts: 0 };
		const { pump, calls } = harness(
			[item(9), item(10)],
			new Map([[9, { kind: "deferred", error: new Error("ratelimited"), retry }]]),
		);
		expect(await pump.pump()).toBe(0);
		expect(calls).toEqual([
			"claimDue",
			"send:9",
			`defer:9:ratelimited:${JSON.stringify(retry)}`,
			`defer:10:chat.postMessage:${JSON.stringify({ at: NOW + 30_000, sentParts: 0 })}`,
		]);
	});
});

describe("finishDeliveryStatus", () => {
	test("one thread's failed finish does not abandon the delivery's other threads; the first error still surfaces", async () => {
		const finished: string[] = [];
		const delivery = item(9, {
			finishThreadRefs: ["200000000000000001:700000000000000002", "200000000000000001:700000000000000003"],
			cancelThreadRefs: ["200000000000000001:700000000000000003"],
		});
		const finisher = {
			finishStatus: async (threadRef: string, _originKey: string, outcome: string, action: string) => {
				if (threadRef.endsWith("0002")) throw new Error("status post down");
				finished.push(`${threadRef}:${outcome}:${action}`);
			},
		};
		await expect(finishDeliveryStatus(delivery, "sent", finisher)).rejects.toThrow("status post down");
		expect(finished).toEqual([
			"200000000000000001:700000000000000001:done:delete",
			"200000000000000001:700000000000000003:cancelled:update",
		]);
	});

	test("a sent delivery finishes as failed while an earlier delivery of the thread is held (round 14 F4)", async () => {
		const finished: string[] = [];
		const finisher = {
			finishStatus: async (threadRef: string, _originKey: string, outcome: string, action: string) => {
				finished.push(`${threadRef}:${outcome}:${action}`);
			},
			hasHeld: (threadRef: string, beforeId: number) =>
				threadRef === "200000000000000001:700000000000000001" && beforeId === 9,
		};
		await finishDeliveryStatus(item(9), "sent", finisher);
		expect(finished).toEqual(["200000000000000001:700000000000000001:failed:delete"]);
	});

	test("the hold is per thread: a held row in another thread leaves this thread done", async () => {
		const finished: string[] = [];
		const finisher = {
			finishStatus: async (threadRef: string, _originKey: string, outcome: string, action: string) => {
				finished.push(`${threadRef}:${outcome}:${action}`);
			},
			hasHeld: (threadRef: string, _beforeId: number) => threadRef.endsWith("0002"),
		};
		const delivery = item(9, {
			finishThreadRefs: ["200000000000000001:700000000000000002"],
		});
		await finishDeliveryStatus(delivery, "sent", finisher);
		expect(finished).toEqual([
			"200000000000000001:700000000000000001:done:delete",
			"200000000000000001:700000000000000002:failed:update",
		]);
	});
});

describe("qa50b K-13: a throwing ledger call", () => {
	test("confirm, fail and defer that throw are logged and the rest of the batch still goes out", async () => {
		const items = [item(21), item(22), item(23), item(24)];
		const calls: string[] = [];
		const lines: string[] = [];
		const results = new Map<number, DeliverySendResult>([
			[22, { kind: "failed", error: "x", outcome: "definitive", sentParts: 0 }],
			[23, { kind: "deferred", error: "429", retry: { at: NOW + 1000, sentParts: 0 } }],
		]);
		const pump = new DeliveryPump({
			source: {
				claimDue: () => items,
				confirm: (id) => {
					calls.push(`confirm:${id}`);
					if (id === 21) throw new Error("SQLITE_FULL");
				},
				fail: (id) => {
					calls.push(`fail:${id}`);
					throw new Error("SQLITE_BUSY");
				},
				defer: (id) => {
					calls.push(`defer:${id}`);
					throw new Error("SQLITE_BUSY");
				},
			},
			sender: {
				isBlocked: () => false,
				blockedUntil: () => NOW,
				blockedReason: () => "chat.postMessage",
				send: async (d) => {
					calls.push(`send:${d.deliveryId}`);
					return results.get(d.deliveryId) ?? { kind: "sent", parts: 1 };
				},
				afterSent: async (d) => void calls.push(`afterSent:${d.deliveryId}`),
				afterUndelivered: async (d) => void calls.push(`undelivered:${d.deliveryId}`),
			},
			clock,
			log: createLogger({ sink: (line) => lines.push(line), clock, redact }),
		});
		expect(await pump.pump()).toBe(1);
		expect(calls).toEqual([
			"send:21",
			"confirm:21",
			"fail:21",
			"send:22",
			"fail:22",
			"send:23",
			"defer:23",
			"send:24",
			"confirm:24",
			"afterSent:24",
		]);
		expect(lines.filter((line) => line.includes("event=delivery_ledger_failed"))).toHaveLength(4);
	});

	test("a failed confirm holds the row as ambiguous instead of leaving it inflight for a resend", async () => {
		const items = [item(31), item(32)];
		const calls: string[] = [];
		const lines: string[] = [];
		const pump = new DeliveryPump({
			source: {
				claimDue: () => items,
				confirm: (id) => {
					calls.push(`confirm:${id}`);
					if (id === 31) throw new Error("SQLITE_BUSY");
				},
				fail: (id, error, outcome, sentParts) => {
					calls.push(`fail:${id}:${error}:${outcome}:${sentParts}`);
					return true;
				},
				defer: (id) => void calls.push(`defer:${id}`),
			},
			sender: {
				isBlocked: () => false,
				blockedUntil: () => NOW,
				blockedReason: () => "chat.postMessage",
				send: async (d) => {
					calls.push(`send:${d.deliveryId}`);
					return { kind: "sent", parts: 2 };
				},
				afterSent: async (d) => void calls.push(`afterSent:${d.deliveryId}`),
				afterUndelivered: async (d) => void calls.push(`undelivered:${d.deliveryId}`),
			},
			clock,
			log: createLogger({ sink: (line) => lines.push(line), clock, redact }),
		});
		expect(await pump.pump()).toBe(1);
		expect(calls).toEqual([
			"send:31",
			"confirm:31",
			"fail:31:SQLITE_BUSY:ambiguous:2",
			"undelivered:31",
			"send:32",
			"confirm:32",
			"afterSent:32",
		]);
		expect(lines.filter((line) => line.includes("event=delivery_ledger_failed"))).toHaveLength(1);
	});
});
