// 메일박스 TLA+ 모델의 게이트 스크립트: tla-check의 Java 없음 처리와 판정, tla-covered의 blob 대조, README 규칙 표.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	distinctStates,
	expectedViolation,
	judgeRun,
	MAX_DISTINCT_STATES,
	MODEL_DIR,
	modelConfigs,
	temporalNames,
} from "../scripts/tla-check";
import { BLOBS_FILE, COVERED, changedFiles, formatBlobs, parseBlobs } from "../scripts/tla-covered";

const REPO = join(import.meta.dir, "..");
const MODEL = join(REPO, MODEL_DIR);
const scratch: string[] = [];
afterAll(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratch.push(dir);
	return dir;
}

function run(script: string, args: string[], options: { cwd: string; env: Record<string, string> }) {
	const p = Bun.spawnSync([process.execPath, join(REPO, "scripts", script), ...args], {
		cwd: options.cwd,
		env: options.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("tla-check without Java", () => {
	// PATH에는 java가 없는 빈 디렉터리만 둔다. CI 러너의 CI=true가 새지 않게 env를 통째로 만든다.
	const noJava = (extra: Record<string, string> = {}) => ({
		PATH: tempDir("tla-nojava-"),
		HOME: tempDir("tla-home-"),
		...extra,
	});

	test("locally it skips with exit 0", () => {
		const result = run("tla-check.ts", [], { cwd: REPO, env: noJava() });
		expect(result.out).toContain("skip: java 없음");
		expect(result.code).toBe(0);
	});

	test("with CI set it fails with exit 1", () => {
		const result = run("tla-check.ts", [], { cwd: REPO, env: noJava({ CI: "true" }) });
		expect(result.err).toContain("fail: java 없음");
		expect(result.code).toBe(1);
	});

	test("with --strict it fails with exit 1", () => {
		const result = run("tla-check.ts", ["--strict"], { cwd: REPO, env: noJava() });
		expect(result.err).toContain("fail: java 없음");
		expect(result.code).toBe(1);
	});
});

describe("tla-check verdicts", () => {
	const passCfg = "SPECIFICATION Spec\nINVARIANTS\n    DispatchAtMostOnce\nPROPERTIES\n    NoLostRow\n";
	const brokenInv = "\\* 깬 판\n\\* expect: DispatchAtMostOnce\nINVARIANTS\n    DispatchAtMostOnce\n";
	const brokenProp = "\\* expect: NoLostRow\nPROPERTIES\n    NoLostRow\n";
	const ok =
		"Model checking completed. No error has been found.\n12 states generated, 5 distinct states found, 0 states left on queue.";

	test("the pass model needs exit 0, the no-error line and a state count under the cap", () => {
		expect(judgeRun("Mailbox.cfg", passCfg, { exitCode: 0, output: ok })).toBeNull();
		expect(judgeRun("Mailbox.cfg", passCfg, { exitCode: 13, output: ok })).toContain("Mailbox.cfg");
		const big = `Model checking completed. No error has been found.\n${MAX_DISTINCT_STATES + 1} distinct states found`;
		expect(judgeRun("Mailbox.cfg", passCfg, { exitCode: 0, output: big })).toContain("상한");
	});

	test("a broken invariant model passes only when that invariant is reported violated (exit 12)", () => {
		const hit = { exitCode: 12, output: "Error: Invariant DispatchAtMostOnce is violated." };
		expect(judgeRun("broken-a.cfg", brokenInv, hit)).toBeNull();
		expect(
			judgeRun("broken-a.cfg", brokenInv, { exitCode: 12, output: "Error: Invariant OriginFifo is violated." }),
		).not.toBeNull();
		expect(judgeRun("broken-a.cfg", brokenInv, { exitCode: 0, output: ok })).not.toBeNull();
		// 문법 오류(150번대) 같은 다른 실패를 위반 검출로 세지 않는다.
		expect(judgeRun("broken-a.cfg", brokenInv, { exitCode: 150, output: hit.output })).not.toBeNull();
	});

	test("a broken temporal model passes on a temporal violation (exit 13)", () => {
		expect(temporalNames(brokenProp)).toEqual(["NoLostRow"]);
		expect(
			judgeRun("broken-b.cfg", brokenProp, { exitCode: 13, output: "Error: Temporal properties were violated." }),
		).toBeNull();
		expect(
			judgeRun("broken-b.cfg", brokenProp, { exitCode: 12, output: "Error: Invariant NoLostRow is violated." }),
		).not.toBeNull();
	});

	test("state counts read the last progress line", () => {
		expect(distinctStates("1,234 distinct states found\n564,300 distinct states found, 0 left")).toBe(564300);
		expect(distinctStates("nothing")).toBeUndefined();
	});
});

/** Mailbox.cfg의 INVARIANTS·PROPERTIES 이름(TypeOK 제외). */
function checkedRules(): string[] {
	const names: string[] = [];
	let inList = false;
	for (const raw of readFileSync(join(MODEL, "Mailbox.cfg"), "utf8").split("\n")) {
		const line = raw.replace(/\\\*.*$/, "").trim();
		if (line === "") continue;
		if (/^[A-Z_]+$/.test(line)) {
			inList = ["INVARIANT", "INVARIANTS", "PROPERTY", "PROPERTIES"].includes(line);
			continue;
		}
		if (inList) names.push(...line.split(/\s+/).filter((name) => name !== "TypeOK"));
	}
	return names.sort();
}

/** README.md `## 규칙` 표 첫 칸의 규칙 이름. */
function readmeRules(): string[] {
	const text = readFileSync(join(MODEL, "README.md"), "utf8");
	const section = text.split("## 규칙\n")[1]?.split("\n## ")[0] ?? "";
	return [...section.matchAll(/^\| `(\w+)` \|/gm)].map((match) => match[1] ?? "").sort();
}

describe("the mailbox model files", () => {
	test("the README rule table names exactly the five rules Mailbox.cfg checks, each defined in Mailbox.tla", () => {
		const tla = readFileSync(join(MODEL, "Mailbox.tla"), "utf8");
		const rules = readmeRules();
		expect(rules).toHaveLength(5);
		expect(rules).toEqual(checkedRules());
		for (const rule of rules) expect(tla).toMatch(new RegExp(`^${rule} ==`, "m"));
	});

	test("there are at least five broken models and every rule has one", () => {
		const broken = readdirSync(MODEL).filter((name) => name.startsWith("broken-") && name.endsWith(".cfg"));
		expect(broken.length).toBeGreaterThanOrEqual(5);
		const expected = broken.map((name) => expectedViolation(readFileSync(join(MODEL, name), "utf8")));
		expect([...new Set(expected)].sort()).toEqual(readmeRules());
	});

	test("the pass model runs first and is the only cfg without an expected violation", () => {
		const cfgs = modelConfigs(MODEL);
		expect(cfgs[0]).toBe("Mailbox.cfg");
		const withoutExpect = cfgs.filter(
			(name) => expectedViolation(readFileSync(join(MODEL, name), "utf8")) === undefined,
		);
		expect(withoutExpect).toEqual(["Mailbox.cfg"]);
	});
});

describe("tla-covered", () => {
	test("parse and format round-trip in COVERED order", () => {
		const blobs = new Map(COVERED.map((path, i) => [path, i.toString(16).padStart(40, "0")]));
		expect(parseBlobs(formatBlobs(blobs))).toEqual(blobs);
		expect(changedFiles(blobs, blobs)).toEqual([]);
		const moved = new Map(blobs).set("src/store/db.ts", "f".repeat(40));
		expect(changedFiles(blobs, moved)).toEqual(["src/store/db.ts"]);
		expect(() => parseBlobs("zz  src/x.ts")).toThrow("읽을 수 없는 줄");
	});

	test("a temp git repo: same → 0, one line changed → 1 naming the file, --record → 0", () => {
		const repo = tempDir("tla-covered-");
		const env = { PATH: process.env.PATH ?? "", HOME: tempDir("tla-home-"), GIT_CONFIG_NOSYSTEM: "1" };
		expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo, env }).exitCode).toBe(0);
		for (const path of COVERED) {
			mkdirSync(join(repo, path, ".."), { recursive: true });
			writeFileSync(join(repo, path), `// ${path}\n`);
		}
		mkdirSync(join(repo, BLOBS_FILE, ".."), { recursive: true });

		expect(run("tla-covered.ts", ["--record"], { cwd: repo, env }).code).toBe(0);
		const same = run("tla-covered.ts", [], { cwd: repo, env });
		expect(same.code).toBe(0);

		writeFileSync(join(repo, "src/store/db.ts"), "// src/store/db.ts\n// one more line\n");
		const changed = run("tla-covered.ts", [], { cwd: repo, env });
		expect(changed.code).toBe(1);
		expect(changed.err).toContain("바뀜: src/store/db.ts");
		expect(changed.err).not.toContain("바뀜: src/core/mailbox.ts");
		expect(changed.err).toContain("--record");

		expect(run("tla-covered.ts", ["--record"], { cwd: repo, env }).code).toBe(0);
		expect(run("tla-covered.ts", [], { cwd: repo, env }).code).toBe(0);
	});
});
