import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcResult, ProcRunner } from "../src/lanes/pr";
import { defaultGit } from "../src/lanes/verify";
import { refreshTlaCovered } from "../src/tasks/land-tla-covered";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): string {
	const out = Bun.spawnSync(
		["git", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
		{ cwd },
	);
	if (out.exitCode !== 0) throw new Error(out.stderr.toString());
	return out.stdout.toString().trim();
}

/** A repository with the gate scripts and a covered record, committed. */
function repo(withGate = true): string {
	const dir = mkdtempSync(join(tmpdir(), "tla-refresh-"));
	dirs.push(dir);
	sh(dir, "init", "-q");
	// The commit under test runs a plain `git commit`: CI runners have no global identity.
	sh(dir, "config", "user.name", "t");
	sh(dir, "config", "user.email", "t@t");
	mkdirSync(join(dir, "scripts"));
	mkdirSync(join(dir, "spec", "tla", "mailbox"), { recursive: true });
	if (withGate) {
		writeFileSync(join(dir, "scripts", "tla-covered.ts"), "");
		writeFileSync(join(dir, "scripts", "tla-check.ts"), "");
	}
	writeFileSync(join(dir, "spec", "tla", "mailbox", "covered.blobs"), "old\n");
	sh(dir, "add", ".");
	sh(dir, "commit", "-q", "-m", "seed");
	return dir;
}

/** A fake bun: each script answers the exit code given; `--record` rewrites the record like the real script. */
function fakeRun(
	dir: string,
	codes: { covered: number; check?: number; record?: number },
): { run: ProcRunner; calls: string[] } {
	const calls: string[] = [];
	const run: ProcRunner = async (argv) => {
		calls.push(argv.join(" "));
		const done = (code: number): ProcResult => ({ code, stdout: "", stderr: code === 0 ? "" : "tlc 위반" });
		if (argv[0] === "scripts/tla-check.ts") return done(codes.check ?? 0);
		if (argv[1] === "--record") {
			if ((codes.record ?? 0) === 0) writeFileSync(join(dir, "spec", "tla", "mailbox", "covered.blobs"), "new\n");
			return done(codes.record ?? 0);
		}
		return done(codes.covered);
	};
	return { run, calls };
}

describe("refreshTlaCovered", () => {
	test("a repository without the gate is left alone", async () => {
		const dir = repo(false);
		const { run, calls } = fakeRun(dir, { covered: 1 });
		expect(await refreshTlaCovered(dir, defaultGit, run)).toEqual({ kind: "none" });
		expect(calls).toEqual([]);
	});

	test("a matching record runs no model check", async () => {
		const dir = repo();
		const { run, calls } = fakeRun(dir, { covered: 0 });
		expect(await refreshTlaCovered(dir, defaultGit, run)).toEqual({ kind: "none" });
		expect(calls).toEqual(["scripts/tla-covered.ts"]);
	});

	test("a stale record with a passing model is rewritten and committed", async () => {
		const dir = repo();
		const head = sh(dir, "rev-parse", "HEAD");
		const { run, calls } = fakeRun(dir, { covered: 1 });
		expect(await refreshTlaCovered(dir, defaultGit, run)).toEqual({
			kind: "recorded",
			files: ["spec/tla/mailbox/covered.blobs"],
		});
		expect(calls).toEqual([
			"scripts/tla-covered.ts",
			"scripts/tla-check.ts --strict",
			"scripts/tla-covered.ts --record",
		]);
		expect(sh(dir, "rev-parse", "HEAD^")).toBe(head);
		expect(sh(dir, "show", "HEAD:spec/tla/mailbox/covered.blobs")).toBe("new");
		expect(sh(dir, "status", "--porcelain")).toBe("");
	});

	test("a failing model goes back to the worker and records nothing", async () => {
		const dir = repo();
		const head = sh(dir, "rev-parse", "HEAD");
		const { run, calls } = fakeRun(dir, { covered: 1, check: 1 });
		const result = await refreshTlaCovered(dir, defaultGit, run);
		expect(result.kind).toBe("rework");
		if (result.kind === "rework") expect(result.notice).toContain("tlc 위반");
		expect(calls).not.toContain("scripts/tla-covered.ts --record");
		expect(sh(dir, "rev-parse", "HEAD")).toBe(head);
	});

	test("a gate that cannot run stops the landing", async () => {
		const dir = repo();
		const { run } = fakeRun(dir, { covered: 2 });
		expect((await refreshTlaCovered(dir, defaultGit, run)).kind).toBe("stop");
	});
});
