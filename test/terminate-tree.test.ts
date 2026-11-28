import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	captureTree,
	killTree,
	linuxProc,
	type ProcessTree,
	type ProcSource,
	type ProcStat,
	parseStat,
	signalTree,
} from "../src/core/terminate-tree";
import { GitOutputCapError, gitRunner } from "../src/lanes/verify";
import { runScript } from "../src/monitors/script";
import { spawnProcessGroup } from "../src/omp/rpc-client";

const root = mkdtempSync(join(tmpdir(), "jabbu-terminate-tree-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `/proc` as a test lays it out; setting `table` anew changes what the same source answers (a pid dying, its number reused). */
function fakeProc(initial: ProcStat[]): ProcSource & { table: ProcStat[] } {
	const source: ProcSource & { table: ProcStat[] } = {
		table: initial,
		list: () => [...source.table],
		get: (pid) => source.table.find((stat) => stat.pid === pid),
	};
	return source;
}

/** What a recording `process.kill` was asked: the pid (negative: a process group) and the signal. */
type KillCall = [pid: number, signal: string | number | undefined];

/**
 * `signalTree` on `tree` as read from `proc`, under a recording `process.kill` (restored whatever happens) that
 * answers ESRCH when `gone`; the calls it made, in order.
 */
function recorded(proc: ProcSource, tree: ProcessTree, signal: NodeJS.Signals, gone = false): KillCall[] {
	const calls: KillCall[] = [];
	const spy = spyOn(process, "kill").mockImplementation((pid, name) => {
		calls.push([pid, name]);
		if (gone) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
		return true;
	});
	try {
		signalTree(tree, signal, proc);
	} finally {
		spy.mockRestore();
	}
	return calls;
}

describe("reading /proc", () => {
	test("parseStat counts the fields from the last `)`, so a comm with spaces or parentheses is fine", () => {
		// Fields 3 to 22 as `/proc/<pid>/stat` writes them; `987654` is the start time (field 22).
		const fields = "S 1 4242 4242 0 -1 4194560 9 0 0 0 12 3 0 0 20 0 4 0 987654";
		expect(parseStat(4242, `4242 (Helper (Renderer) (3)) ${fields} 0 0\n`)).toEqual({
			pid: 4242,
			ppid: 1,
			starttime: "987654",
		});
		expect(parseStat(1, "not a stat line")).toBeUndefined();
	});

	test("linuxProc: this process with its parent and a start time where `/proc` is, nothing where it is not", () => {
		const mine = linuxProc.get(process.pid);
		if (process.platform !== "linux") {
			// No `/proc` here: the empty source that makes the callers signal the group alone.
			expect(mine).toBeUndefined();
			expect(linuxProc.list()).toEqual([]);
			return;
		}
		expect(mine).toMatchObject({ pid: process.pid, ppid: process.ppid });
		expect(mine?.starttime).toMatch(/^\d+$/);
		expect(linuxProc.list().some((stat) => stat.pid === process.pid)).toBe(true);
	});
});

describe("captureTree", () => {
	test("takes every descendant, through grandparents and whatever their group; not the leader or a stranger", () => {
		const proc = fakeProc([
			{ pid: 1, ppid: 0, starttime: "1" },
			{ pid: 10, ppid: 1, starttime: "10" }, // the leader
			{ pid: 11, ppid: 1, starttime: "11" }, // a stranger
			{ pid: 21, ppid: 10, starttime: "21" },
			{ pid: 22, ppid: 21, starttime: "22" }, // a grandchild, reached through 21
			{ pid: 23, ppid: 10, starttime: "23" },
			{ pid: 31, ppid: 21, starttime: "31" },
		]);
		const tree = captureTree(10, proc);
		expect(tree.leaderPid).toBe(10);
		expect(tree.members.map((member) => member.pid)).toEqual([21, 22, 31, 23]);
	});

	test("a table that loops (a pid its own ancestor) ends the walk instead of hanging", () => {
		const proc = fakeProc([
			{ pid: 10, ppid: 12, starttime: "10" },
			{ pid: 11, ppid: 10, starttime: "11" },
			{ pid: 12, ppid: 11, starttime: "12" },
		]);
		expect(captureTree(10, proc).members.map((member) => member.pid)).toEqual([11, 12]);
	});

	test("nothing to read (no `/proc`) is an empty tree, not an error", () => {
		expect(captureTree(10, { list: () => [], get: () => undefined })).toEqual({ leaderPid: 10, members: [] });
	});
});

describe("signalTree", () => {
	test("the group first, then every recorded member by pid, each with the signal given", () => {
		const proc = fakeProc([
			{ pid: 10, ppid: 1, starttime: "10" },
			{ pid: 11, ppid: 10, starttime: "11" },
			{ pid: 12, ppid: 10, starttime: "12" },
		]);
		expect(recorded(proc, captureTree(10, proc), "SIGTERM")).toEqual([
			[-10, "SIGTERM"],
			[11, "SIGTERM"],
			[12, "SIGTERM"],
		]);
	});

	test("a recorded pid that now is another process (another start time) gets no signal, and a gone one neither (AC-3)", () => {
		const proc = fakeProc([
			{ pid: 10, ppid: 1, starttime: "10" },
			{ pid: 11, ppid: 10, starttime: "101" },
			{ pid: 12, ppid: 10, starttime: "102" },
			{ pid: 13, ppid: 10, starttime: "103" },
		]);
		const tree = captureTree(10, proc);
		// pid 11 died and its number went to a process started later; pid 12 is the recorded one; pid 13 is gone.
		proc.table = [
			{ pid: 10, ppid: 1, starttime: "10" },
			{ pid: 11, ppid: 1, starttime: "999" },
			{ pid: 12, ppid: 10, starttime: "102" },
		];
		expect(recorded(proc, tree, "SIGKILL")).toEqual([
			[-10, "SIGKILL"],
			[12, "SIGKILL"],
		]);
	});

	test("nothing to read: the group signal alone, and no exception (AC-4)", () => {
		const nothing: ProcSource = { list: () => [], get: () => undefined };
		const calls: KillCall[] = [];
		const spy = spyOn(process, "kill").mockImplementation((pid, signal) => {
			calls.push([pid, signal]);
			return true;
		});
		try {
			expect(() => killTree(10, "SIGTERM", nothing)).not.toThrow();
		} finally {
			spy.mockRestore();
		}
		expect(calls).toEqual([[-10, "SIGTERM"]]);
	});

	test("a group already gone (ESRCH) costs nothing: no exception, the members still get theirs", () => {
		const proc = fakeProc([
			{ pid: 10, ppid: 1, starttime: "10" },
			{ pid: 11, ppid: 10, starttime: "11" },
		]);
		expect(recorded(proc, captureTree(10, proc), "SIGKILL", true)).toEqual([
			[-10, "SIGKILL"],
			[11, "SIGKILL"],
		]);
	});
});

// ---- real processes ----

/** The real `/proc`, `setsid`, `sh` and `sleep`: a test with a live tree needs all of them. */
const liveTree =
	process.platform === "linux" &&
	Bun.which("setsid") !== null &&
	Bun.which("sh") !== null &&
	Bun.which("sleep") !== null;

/**
 * `sh` text for a leader: one sleeper started with `setsid` (its own session, so out of the leader's process group)
 * that ignores SIGTERM, its pid written to the file `$1` names; then the leader stays alive.
 */
const LEADER = 'setsid sh -c \'trap "" TERM; exec sleep 300\' & echo $! > "$1"; exec sleep 300';
const CHILD_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
/** A failure deadline, never a wait for time to pass. */
const LIMIT_MS = 5_000;
/** The test timeout, leaving room for one bounded wait after a failure. */
const TEST_TIMEOUT_MS = 20_000;

/** Resolves when `ready` holds, checked between event-loop hops; rejects when it never does within `ms`. */
async function until(ready: () => boolean, what: string, ms: number): Promise<void> {
	const end = performance.now() + ms;
	while (!ready()) {
		if (performance.now() > end) throw new Error(`never happened within ${ms}ms: ${what}`);
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	}
}

/** Rejects when `promise` has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`timeout after ${ms}ms waiting for ${what}`)), ms);
	return Promise.race([promise, deadline.promise]).finally(() => clearTimeout(timer));
}

/** AC-1's "dead": no such pid any more, or a zombie (dead, waiting to be reaped). */
function gone(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return true;
	}
	try {
		// `pid (comm) S …`: the state follows the last `)`.
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
	} catch {
		return true;
	}
}

/** True once `pid` leads a process group of its own: the sleeper's `setsid` is done, it left the leader's group. */
function leadsOwnGroup(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readPid(pidFile: string): number {
	try {
		return Number(readFileSync(pidFile, "utf8").trim());
	} catch {
		return 0;
	}
}

/** Resolves with the sleeper `pidFile` names, once it left its leader's group. */
async function sleeperOf(pidFile: string): Promise<number> {
	await until(() => readPid(pidFile) > 0, "the sleeper's pid file", LIMIT_MS);
	const sleeper = readPid(pidFile);
	await until(() => leadsOwnGroup(sleeper), "the sleeper leaving the leader's group", LIMIT_MS);
	return sleeper;
}

/**
 * Runs `body` with the sleeper `pidFile` names. A run that fails ends it, unless it died already: a dead pid is
 * never signalled again, it may be another process by then.
 */
async function withSleeper(pidFile: string, body: (sleeper: number) => Promise<void>): Promise<void> {
	const sleeper = await sleeperOf(pidFile);
	try {
		await body(sleeper);
	} finally {
		killIfAlive(sleeper);
	}
}

/**
 * SIGKILLs `pid` unless it is gone. The check and the kill are two steps, so the sleeper can die between them: that
 * ESRCH is the state wanted, not a failure. Any other error is still thrown. `isGone` and `kill` are injectable so the
 * race can be forced.
 */
function killIfAlive(
	pid: number,
	isGone: (pid: number) => boolean = gone,
	kill: (pid: number, signal: "SIGKILL") => void = (target, signal) => void process.kill(target, signal),
): void {
	if (isGone(pid)) return;
	try {
		kill(pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

describe("killIfAlive (the cleanup of a real-tree test)", () => {
	const errno = (code: string): Error => Object.assign(new Error(code), { code });

	test("a sleeper that dies between the check and the kill (ESRCH) is not an error", () => {
		const signalled: number[] = [];
		killIfAlive(
			4242,
			() => false,
			(pid) => {
				signalled.push(pid);
				throw errno("ESRCH");
			},
		);
		expect(signalled).toEqual([4242]);
	});

	test("any other kill error is still thrown", () => {
		expect(() =>
			killIfAlive(
				4242,
				() => false,
				() => {
					throw errno("EPERM");
				},
			),
		).toThrow("EPERM");
	});

	test("a live sleeper is signalled once with SIGKILL, a gone one never", () => {
		const calls: Array<[number, string]> = [];
		killIfAlive(
			7,
			() => false,
			(pid, signal) => void calls.push([pid, signal]),
		);
		killIfAlive(
			8,
			() => true,
			(pid, signal) => void calls.push([pid, signal]),
		);
		expect(calls).toEqual([[7, "SIGKILL"]]);
	});
});

describe("a real tree", () => {
	// Not skipped: on a host that cannot build the tree these tests fail instead of passing unrun.
	beforeAll(() => {
		if (!liveTree) throw new Error("a live tree needs Linux `/proc`, `setsid`, `sh` and `sleep` on the PATH");
	});

	test(
		"killTree ends a descendant that left the leader's process group (AC-1)",
		async () => {
			const pidFile = join(root, "kill.pid");
			const leader = Bun.spawn(["sh", "-c", LEADER, "leader", pidFile], {
				cwd: root,
				env: CHILD_ENV,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				detached: true,
			});
			await withSleeper(pidFile, async (sleeper) => {
				killTree(leader.pid, "SIGKILL");
				await within(leader.exited, LIMIT_MS, "the leader's exit");
				await until(() => gone(sleeper), "the sleeper's death", LIMIT_MS);
			});
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'spawnProcessGroup().signal("SIGTERM") then signal("SIGKILL") ends it as well: the second wave reuses what was read before the first (AC-2)',
		async () => {
			const pidFile = join(root, "waves.pid");
			const child = spawnProcessGroup(["sh", "-c", LEADER, "leader", pidFile], { cwd: root, env: CHILD_ENV });
			await withSleeper(pidFile, async (sleeper) => {
				// stop()'s two waves: the leader dies on the SIGTERM, the sleeper ignores it and outlives the leader.
				child.signal("SIGTERM");
				await within(child.exited, LIMIT_MS, "the leader's exit");
				child.signal("SIGKILL");
				await until(() => gone(sleeper), "the sleeper's death", LIMIT_MS);
			});
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a watch script aborted mid-run takes the sleeper down with it",
		async () => {
			const scripts = join(root, "scripts");
			mkdirSync(scripts, { recursive: true });
			const pidFile = join(root, "script.pid");
			const script = join(scripts, "leaver.sh");
			writeFileSync(script, `#!/bin/sh\n${LEADER}\nexec sleep 300\n`);
			chmodSync(script, 0o755);
			const controller = new AbortController();
			const run = runScript([script, pidFile], { scriptsRoot: scripts, cwd: root, signal: controller.signal });
			try {
				await withSleeper(pidFile, async (sleeper) => {
					controller.abort();
					const result = await within(run, LIMIT_MS, "the run's end");
					expect(result).toMatchObject({ fired: false, aborted: true, timedOut: false });
					await until(() => gone(sleeper), "the sleeper's death", LIMIT_MS);
				});
			} finally {
				// A failed run must not leave the script to its timeout.
				controller.abort();
				await run;
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"git output past the runner's cap ends a sleeper the git call left outside its group",
		async () => {
			const pidFile = join(root, "git.pid");
			const go = join(root, "go");
			// The git call waits for `go` before it prints past the cap, and stays alive after it: the sleeper is out
			// of the group and the tree still whole when the kill comes.
			const hang = `!setsid sh -c 'trap "" TERM; exec sleep 300' & echo $! > '${pidFile}'; while [ ! -e '${go}' ]; do sleep 0.05; done; head -c 4096 /dev/zero; exec sleep 300`;
			const run = gitRunner(30_000, 1024)(["-c", `alias.hang=${hang}`, "hang"]);
			run.catch(() => undefined); // its rejection is judged below, wherever it comes
			try {
				await withSleeper(pidFile, async (sleeper) => {
					writeFileSync(go, "");
					await expect(run).rejects.toThrow(GitOutputCapError);
					await until(() => gone(sleeper), "the sleeper's death", LIMIT_MS);
				});
			} finally {
				// The call ends on its cap once `go` is there, a failed run included; it must not sit out its timeout.
				writeFileSync(go, "");
				await run.catch(() => undefined);
			}
		},
		TEST_TIMEOUT_MS,
	);
});
