import { esc } from "./text";

/** Where a number's change is bad news: a count that grew (`up`) or a remaining share that fell (`down`). */
type RollBad = "up" | "down";

/** One header number that changed between two draws. */
interface RollChange {
	key: string;
	from: number;
	to: number;
	delta: number;
}

/**
 * Header number roll: the keys whose value differs from the last draw, with the step. `prev` is the page's memory of
 * the last values (never read back from the DOM); `next` is the memory to keep. The first draw (empty `prev`) changes
 * nothing, and a key that was not there before is not a change. Self-contained (shipped to the page).
 */
export function rollDiff(
	prev: Map<string, number>,
	items: Array<{ key: string; value: number }>,
): { changes: RollChange[]; next: Map<string, number> } {
	const next = new Map<string, number>();
	const changes: RollChange[] = [];
	for (const item of items) {
		next.set(item.key, item.value);
		const from = prev.get(item.key);
		if (prev.size === 0 || from === undefined || from === item.value) continue;
		changes.push({ key: item.key, from, to: item.value, delta: item.value - from });
	}
	return { changes, next };
}

/** The effects the page plays for `changes`: none when the reader asked for less motion (it draws the final numbers). Self-contained. */
export function rollEffects(changes: RollChange[], reduced: boolean): RollChange[] {
	return reduced ? [] : changes;
}

/** A change's step as shown (`+2`, `−1`) and its tone: `bad` when it moved the way `bad` names. Self-contained. */
export function rollLabel(change: RollChange, bad: RollBad | undefined): { text: string; tone: "good" | "bad" } {
	const up = change.delta > 0;
	return {
		text: `${up ? "+" : "−"}${Math.abs(change.delta)}`,
		tone: bad === undefined ? "good" : (bad === "up") === up ? "bad" : "good",
	};
}

/** An inbox row the owner should see arrive in 내 차례. */
interface FreshCard {
	id: string;
	kind: "card" | "task";
	title: string;
}

/**
 * New event cards: of `entries`, those in 내 차례 (`col` `mine`) that were not there in the last draw (`prev`: id →
 * group memory) — once per stay, however its reason changes; out and back in counts again. The first draw (empty
 * `prev`) and `quiet` (the read marks' first visit) give none. `next` is the memory to keep. Self-contained (shipped).
 */
export function freshCards(
	prev: Map<string, string>,
	entries: Array<{ id: string; kind: "card" | "task"; col: string; title: string }>,
	quiet: boolean,
): { cards: FreshCard[]; next: Map<string, string> } {
	const next = new Map<string, string>();
	const cards: FreshCard[] = [];
	for (const entry of entries) {
		next.set(entry.id, entry.col);
		if (prev.size === 0 || quiet || entry.col !== "mine" || prev.get(entry.id) === "mine") continue;
		cards.push({ id: entry.id, kind: entry.kind, title: entry.title });
	}
	return { cards, next };
}

/** A card on the event stack. */
export interface StackCard extends FreshCard {
	at: number;
}

/** The stack after `fresh` cards arrive: newest first, one card per arrival (a row back in 내 차례 again is a new one), at most six kept. Self-contained. */
export function pushStack(list: StackCard[], fresh: FreshCard[], now: number): StackCard[] {
	return [...fresh.map((card) => ({ ...card, at: now })).reverse(), ...list].slice(0, 6);
}

/**
 * The stack after untouched time: the oldest card goes once `ttl` has passed since the later of its arrival and
 * `since` (the last touch or the last card that went), one card per call. Nothing goes when the reader asked for less
 * motion — the cards then stay until closed. Self-contained.
 */
export function expireStack(list: StackCard[], now: number, since: number, ttl: number, reduced: boolean): StackCard[] {
	const oldest = list[list.length - 1];
	if (reduced || oldest === undefined || now - Math.max(since, oldest.at) < ttl) return list;
	return list.slice(0, -1);
}

/** The stack's cards as HTML (front card first, three shown) and its one-line announcement. Self-contained. */
export function stackHtml(list: StackCard[]): { html: string; say: string } {
	const shown = list.slice(0, 3);
	const cards = shown.map((card, i) => {
		const kind = card.kind === "task" ? "task" : "card";
		return `<a class="es-card is-attention" style="--i:${i}" href="?${kind}=${esc(
			encodeURIComponent(card.id),
		)}" data-${kind}="${esc(card.id)}" data-es-card="${esc(card.id)}"><span class="es-tag">내 차례</span><span class="es-title">${esc(card.title)}</span></a>`;
	});
	const first = list[0];
	const say = first === undefined ? "" : `내 차례: ${first.title}${list.length > 1 ? ` 외 ${list.length - 1}건` : ""}`;
	return {
		html:
			list.length === 0
				? ""
				: `<div class="es-list" style="--n:${shown.length}">${cards.join("")}</div><button type="button" class="es-x" data-es-close aria-label="알림 닫기">×</button>`,
		say,
	};
}

/**
 * How a card's state pill moves when its state key (`column:card status:TASK status`) changes: `ok` (check draw) when
 * the new status is done or delivered, `bad` (shake) when failed or gone, else empty (the plain flash). No previous
 * key or the same key gives empty. Self-contained.
 */
export function pillMotion(prev: string | undefined, next: string): "ok" | "bad" | "" {
	if (prev === undefined || prev === next) return "";
	const parts = next.split(":");
	const status = parts[2] || parts[1] || "";
	if (new Set(["done", "done-claimed", "delivered", "answered", "approved"]).has(status)) return "ok";
	if (new Set(["failed", "failed_no_retry", "gone", "dead", "denied"]).has(status)) return "bad";
	return "";
}

/**
 * Live steps: a key per finished step (`name`, `summary`, time and failure, counted when they repeat) and the keys not
 * seen before. `seen` null is the first look at a block: nothing is new. Self-contained.
 */
export function freshSteps(
	seen: Set<string> | null,
	steps: Array<{ name?: unknown; summary?: unknown; ms?: unknown; failed?: unknown }>,
): { keys: string[]; fresh: number[] } {
	const counts = new Map<string, number>();
	const keys = steps.map((step) => {
		const base = [step.name, step.summary, step.ms, step.failed === true].join("\u0000");
		const n = (counts.get(base) ?? 0) + 1;
		counts.set(base, n);
		return `${base}#${n}`;
	});
	return { keys, fresh: seen === null ? [] : keys.flatMap((key, i) => (seen.has(key) ? [] : [i])) };
}
