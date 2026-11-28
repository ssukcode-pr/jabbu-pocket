// The skill review vs shutdown: the fence in `stop()` and the `idle()` wait for a running review.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GATE_SWEEP_MS } from "../src/daemon/daemon-constants";
import type { DaemonContext } from "../src/daemon/daemon-context";
import { DaemonSkillReview } from "../src/daemon/daemon-review";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { OWNER_DM } from "./helpers/bot-home";

const DM = `discord/dm/${OWNER_DM}`;
const NOW = Date.parse("2026-11-12T00:00:00Z");

let dir: string;
let sessionDir: string;
let now: number;
let answered: number;
let lines: string[];
let built: Array<{ origin: string; sessionDir: string; driver: FakeOmpDriver }>;
let sessions: FakeSessionStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-review-stop-"));
	sessionDir = join(dir, "sessions", "dm");
	mkdirSync(sessionDir, { recursive: true });
	// One answered DM turn's session, so `!distill` has a digest to read.
	writeFileSync(
		join(sessionDir, "s.jsonl"),
		`${JSON.stringify({ message: { role: "user", content: "릴리스 절차를 또 물어봤다" } })}\n`,
	);
	now = NOW;
	answered = 5;
	lines = [];
	built = [];
	sessions = new FakeSessionStore();
});

afterEach(() => {
	for (const b of built) b.driver.release();
	rmSync(dir, { recursive: true, force: true });
});

function makeCtx(): DaemonContext {
	const store = {
		ownerHome: () => ({ platform: "discord", conversationId: OWNER_DM }),
		ownerDmOrigin: () => DM,
		countAnswered: () => answered,
		getOrigin: () => ({ sessionDir }),
	};
	return {
		options: {
			config: {
				skillReviewTurns: 1,
				homeDir: dir,
				workspaceDir: dir,
				timezone: "UTC",
				channels: {},
				candidates: undefined,
				ompProfile: undefined,
			},
		},
		clock: { now: () => now },
		log: createLogger({ sink: (line) => lines.push(line), clock: { now: () => now }, redact }),
		adapters: new Map([["discord", {}]]),
		frozen: () => undefined,
		store,
		router: undefined,
	} as unknown as DaemonContext;
}

function makeReview(holdReview: boolean): DaemonSkillReview {
	return new DaemonSkillReview(makeCtx(), (origin, sd) => {
		const driver = new FakeOmpDriver({ sessionDir: sd, store: sessions, holdTurns: holdReview });
		built.push({ origin, sessionDir: sd, driver });
		return driver;
	});
}

/** Resolves once `done()` holds, or after 100 macrotask hops (the work is a few microtasks plus sync file IO). */
async function untilDone(done: () => boolean): Promise<boolean> {
	for (let i = 0; i < 100; i++) {
		if (done()) return true;
		await Bun.sleep(0);
	}
	return done();
}

/** One `seen` ledger line for `key` on `day`. */
function seen(key: string, day: string): string {
	return JSON.stringify({
		v: 1,
		ts: `${day}T14:30:00Z`,
		key,
		event: "seen",
		day,
		kind: "fix",
		evidence: `reflections/${day}.md#문제1`,
		summary: `${key} 반복`,
	});
}

describe("skill review vs shutdown", () => {
	test("idle() waits for a running review and resolves once it finishes", async () => {
		const review = makeReview(true);
		review.maybeReviewSkills(); // first look: the count is the baseline, no review yet
		expect(built).toHaveLength(0);
		answered = 6;
		review.maybeReviewSkills();
		expect(built).toHaveLength(1);
		expect(review.reviewing).toBe(true);

		const idling = review.idle();
		// sleep-ok: the review is held, so idle() must still be pending after this window.
		expect(await Promise.race([idling.then(() => "done"), Bun.sleep(100).then(() => "waiting")])).toBe("waiting");
		built[0]?.driver.release();
		await idling;
		expect(review.reviewing).toBe(false);
		expect(lines.some((line) => line.includes("event=skill_review_no_proposal"))).toBe(true);
	});

	test("after stop(), a due review does not start and !distill refuses", async () => {
		const review = makeReview(false);
		review.maybeReviewSkills();
		answered = 6;
		review.maybeReviewSkills();
		expect(built).toHaveLength(1);
		await review.idle();
		expect(review.reviewing).toBe(false);

		review.stop();
		answered = 7;
		review.maybeReviewSkills();
		expect(built).toHaveLength(1);
		expect(await review.distill(DM)).toContain("종료 중");
		expect(built).toHaveLength(1);
	});

	test("after stop(), the candidate pass does not run, while a fresh review still would", async () => {
		const ledger = join(dir, "candidates.jsonl");
		writeFileSync(ledger, ["2026-11-09", "2026-11-10", "2026-11-11"].map((day) => seen("fix-a", day)).join("\n"));
		const review = makeReview(false);
		review.maybeProposeCandidates();
		expect(
			await untilDone(() => lines.some((line) => line.includes("candidate_proposed") && line.includes("fix-a"))),
		).toBe(true);

		appendFileSync(
			ledger,
			`\n${["2026-11-09", "2026-11-10", "2026-11-11"].map((day) => seen("fix-b", day)).join("\n")}`,
		);
		now += DEFAULT_GATE_SWEEP_MS + 1;
		review.stop();
		review.maybeProposeCandidates();
		for (let i = 0; i < 10; i++) await Bun.sleep(0);
		expect(lines.some((line) => line.includes("candidate_proposed") && line.includes("fix-b"))).toBe(false);

		const control = makeReview(false);
		control.maybeProposeCandidates();
		expect(
			await untilDone(() => lines.some((line) => line.includes("candidate_proposed") && line.includes("fix-b"))),
		).toBe(true);
	});
});
