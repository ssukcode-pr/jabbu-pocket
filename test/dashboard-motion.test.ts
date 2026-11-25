import { describe, expect, test } from "bun:test";
import { renderDashboardPage, SCRIPT } from "../src/dashboard/html";
import {
	expireStack,
	freshCards,
	freshSteps,
	pillMotion,
	pushStack,
	rollDiff,
	rollEffects,
	rollLabel,
	type StackCard,
	stackHtml,
} from "../src/dashboard/motion";
import type { DashboardSnapshot } from "../src/dashboard/snapshot";
import { STYLE } from "../src/dashboard/style";

const off = { ok: false as const, error: "not in this test" };
const EMPTY: DashboardSnapshot = {
	generatedAt: "2026-11-16T10:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: {
		ok: true,
		running: true,
		ompVersion: "1",
		origins: 1,
		busy: 0,
		ledger: { pending: 0, inflight: 0, confirmed: 0, ambiguous: 0, expired: 0 },
		inbound: { pending: 0, dispatched: 0, answered: 0, failed_notified: 0, discarded: 0, uncertain: 0 },
		monitors: { count: 0, next: null },
		openGates: [{ name: "g", since: "2026-11-16T09:00:00+09:00" } as never],
	},
	turns: off,
	tasks: { ok: true, items: [] },
	lanes: off,
	herdr: { ok: true, hosts: [] },
	approvals: off,
	monitors: off,
	alerts: off,
	gates: off,
	backup: off,
	jobs: off,
};

describe("header number roll", () => {
	test("AC-2: the first draw changes nothing, later draws name the changed keys with their step", () => {
		const first = rollDiff(new Map(), [{ key: "gate", value: 1 }]);
		expect(first.changes).toEqual([]);
		expect([...first.next]).toEqual([["gate", 1]]);
		const next = rollDiff(first.next, [
			{ key: "gate", value: 3 },
			{ key: "lim:x:5h", value: 40 },
		]);
		expect(next.changes).toEqual([{ key: "gate", from: 1, to: 3, delta: 2 }]);
		expect(rollDiff(next.next, [{ key: "gate", value: 3 }]).changes).toEqual([]);
	});

	test("AC-2: the step reads +n or −n and is bad in the direction the key names", () => {
		const up = { key: "gate", from: 1, to: 3, delta: 2 };
		const down = { key: "lim", from: 50, to: 40, delta: -10 };
		expect(rollLabel(up, "up")).toEqual({ text: "+2", tone: "bad" });
		expect(rollLabel(down, "down")).toEqual({ text: "−10", tone: "bad" });
		expect(rollLabel(down, "up")).toEqual({ text: "−10", tone: "good" });
		expect(rollLabel(up, undefined).tone).toBe("good");
	});

	test("AC-3: with reduced motion no effect is played, so the final numbers stay", () => {
		const changes = [{ key: "gate", from: 1, to: 3, delta: 2 }];
		expect(rollEffects(changes, true)).toEqual([]);
		expect(rollEffects(changes, false)).toEqual(changes);
	});
});

describe("event stack", () => {
	const row = (id: string, col: string) => ({ id, kind: "card" as const, col, title: `제목 ${id}` });

	test("AC-2: the first draw and the read marks' first visit give no card; later draws give rows that came into 내 차례", () => {
		expect(freshCards(new Map(), [row("a", "mine")], false).cards).toEqual([]);
		const prev = new Map([["a", "working"]]);
		expect(freshCards(prev, [row("a", "mine"), row("b", "mine")], true).cards).toEqual([]);
		const got = freshCards(prev, [row("a", "mine"), row("b", "mine"), row("c", "done")], false);
		// A new row or a moved one alike, but only into 내 차례; a row new in 확인함 rings nothing.
		expect(got.cards.map((card) => card.id)).toEqual(["a", "b"]);
		expect([...got.next]).toEqual([
			["a", "mine"],
			["b", "mine"],
			["c", "done"],
		]);
		expect(freshCards(got.next, [row("a", "mine"), row("b", "mine")], false).cards).toEqual([]);
	});

	test("AC-5: a row staying in 내 차례 while its reason changes is one stack card; out and back in is two", () => {
		const turnRow = (word: string, col: string) => ({ ...row("T-1", col), title: `질문 · ${word}` });
		let memory = new Map([["other", "working"]]);
		let list: StackCard[] = [];
		const draw = (col: string, word: string, at: number): void => {
			const got = freshCards(memory, [row("other", "working"), turnRow(word, col)], false);
			memory = got.next;
			list = pushStack(list, got.cards, at);
		};
		draw("mine", "판정 막힘", 1);
		draw("mine", "질문", 2);
		draw("mine", "막힘", 3);
		expect(list.map((card) => card.id)).toEqual(["T-1"]);
		draw("working", "진행 중", 4);
		draw("mine", "결정 대기", 5);
		expect(list.map((card) => [card.id, card.at])).toEqual([
			["T-1", 5],
			["T-1", 1],
		]);
	});

	test("AC-2: newest first, six kept, three drawn", () => {
		let list: StackCard[] = [];
		for (let i = 0; i < 8; i++) list = pushStack(list, [row(`c${i}`, "mine")], 1000 + i);
		expect(list.map((card) => card.id)).toEqual(["c7", "c6", "c5", "c4", "c3", "c2"]);
		const out = stackHtml(list);
		expect(out.html.match(/class="es-card/g)?.length).toBe(3);
		expect(out.say).toContain("내 차례: 제목 c7 외 5건");
	});

	test("AC-2: a card title is escaped and links to its detail", () => {
		const out = stackHtml([{ id: "k/1", kind: "card", title: "<img src=x>", at: 1 }]);
		expect(out.html).not.toContain("<img");
		expect(out.html).toContain('href="?card=k%2F1"');
		expect(out.html).toContain('data-card="k/1"');
		expect(stackHtml([]).html).toBe("");
	});

	test("AC-2: the oldest card goes after 6 s untouched, one at a time; touch delays it", () => {
		const list: StackCard[] = [
			{ id: "new", kind: "card", title: "n", at: 10_000 },
			{ id: "old", kind: "card", title: "o", at: 1_000 },
		];
		expect(expireStack(list, 6_999, 0, 6_000, false)).toBe(list);
		expect(expireStack(list, 7_000, 0, 6_000, false).map((card) => card.id)).toEqual(["new"]);
		expect(expireStack(list, 7_000, 5_000, 6_000, false)).toBe(list);
	});

	test("AC-3: with reduced motion the cards stay until they are closed", () => {
		const list: StackCard[] = [{ id: "a", kind: "card", title: "a", at: 0 }];
		expect(expireStack(list, 999_999, 0, 6_000, true)).toBe(list);
	});

	test("AC-2: #event-stack is a direct child of body, outside #main, beside the toast", () => {
		const page = renderDashboardPage(EMPTY);
		const stackAt = page.indexOf('id="event-stack"');
		expect(stackAt).toBeGreaterThan(0);
		const mainOpen = page.indexOf('id="main"');
		const search = page.indexOf('<div class="search">');
		expect(stackAt).toBeGreaterThan(search);
		expect(mainOpen).toBeLessThan(search);
		expect(page.indexOf('id="toast"')).toBeLessThan(stackAt);
		expect(page.slice(stackAt - 5, stackAt)).toBe("<div ");
		expect(page).toContain('aria-live="polite"');
	});
});

describe("state pill and live steps", () => {
	test("AC-2: a pill checks when the new status is done, shakes when failed, and is plain otherwise", () => {
		expect(pillMotion(undefined, "wait:done:")).toBe("");
		expect(pillMotion("wait:done:", "wait:done:")).toBe("");
		expect(pillMotion("working:working:", "wait:done:")).toBe("ok");
		expect(pillMotion("working::working", "wait::done-claimed")).toBe("ok");
		expect(pillMotion("working:working:", "attention:failed:")).toBe("bad");
		expect(pillMotion("working:working:", "attention:blocked:")).toBe("");
	});

	test("AC-2: the first look at a block pops nothing; a step seen before never pops again", () => {
		const a = { name: "read", summary: "x", ms: 10, failed: false };
		const b = { name: "read", summary: "x", ms: 10, failed: false };
		const first = freshSteps(null, [a]);
		expect(first.fresh).toEqual([]);
		const next = freshSteps(new Set(first.keys), [a, b]);
		expect(next.fresh).toEqual([1]);
		expect(new Set(next.keys).size).toBe(2);
		expect(freshSteps(new Set(next.keys), [a, b]).fresh).toEqual([]);
	});
});

describe("reduced motion", () => {
	const script = SCRIPT;

	test("AC-3: the global reduced-motion rule stops animations and transitions, and the new keyframes sit outside it", () => {
		const block = STYLE.slice(STYLE.indexOf("@media (prefers-reduced-motion: reduce)"));
		expect(block).toContain("animation-duration: 0s !important");
		expect(block).toContain("transition-duration: 0s !important");
		for (const name of ["pill-draw", "pill-pop", "pill-shake", "step-pop", "step-shimmer", "roll-delta", "es-in"]) {
			expect(STYLE).toContain(`@keyframes ${name}`);
			expect(block).not.toContain(`@keyframes ${name}`);
		}
		expect(STYLE).toContain("--ease-spring: cubic-bezier(0.34, 1.4, 0.64, 1)");
	});

	test("AC-3: the page script asks matchMedia before rolling, popping or timing the stack", () => {
		expect(script).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
		expect(script).toContain("rollEffects(result.changes, reducedMotion())");
		expect(script).toContain("expireStack(stack, now, Math.max(stackTouched, stackDropped), 6000, reducedMotion())");
		expect(script).toContain("if (!reducedMotion()) for (const i of result.fresh)");
	});
});

describe("header numbers carry roll keys", () => {
	test("AC-2: the gate count is a data-roll cell with its value and bad direction", () => {
		const page = renderDashboardPage(EMPTY);
		expect(page).toContain('data-roll="gate" data-roll-v="1" data-roll-bad="up"');
	});
});
