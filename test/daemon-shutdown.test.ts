import { expect, test } from "bun:test";
import { createShutdown } from "../src/daemon/shutdown";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";

const clock = { now: () => Date.now() };

/** A handler over a fake log and a fake process exit, so the signal paths are proven without a child process. */
function harness(
	stop: () => Promise<void>,
	env: Record<string, string | undefined> = {},
): {
	handle: (signal: string) => void;
	stopping: () => boolean;
	signal: () => string | undefined;
	lines: string[];
	exits: number[];
	/** Resolves with the first exit code (never when the handler never force-exits). */
	onExit: Promise<number>;
	exited: Promise<number>;
} {
	const lines: string[] = [];
	const log = createLogger({ sink: (line) => lines.push(line), clock, redact });
	const exits: number[] = [];
	const exitDeferred = Promise.withResolvers<number>();
	const exited = Promise.withResolvers<number>();
	const shutdown = createShutdown({
		stop,
		log,
		env,
		exited,
		exit: (code) => {
			exits.push(code);
			exitDeferred.resolve(code);
		},
	});
	return {
		handle: shutdown.handle,
		stopping: () => shutdown.stopping,
		signal: () => shutdown.signal,
		lines,
		exits,
		onExit: exitDeferred.promise,
		exited: exited.promise,
	};
}

/** A stop that never settles: a pump hung on a dead network. */
const neverStop = (): Promise<void> => new Promise<void>(() => {});

test("a second signal while the stop runs force-exits 1 at once (stop_forced, no exit 0)", async () => {
	const h = harness(neverStop);
	expect(h.stopping()).toBe(false);
	expect(h.signal()).toBe(undefined);

	h.handle("SIGTERM");
	expect(h.stopping()).toBe(true);
	expect(h.signal()).toBe("SIGTERM");
	expect(h.lines.some((line) => line.includes("event=signal signal=SIGTERM"))).toBe(true);

	h.handle("SIGTERM");
	expect(h.exits).toEqual([1]);
	expect(await h.onExit).toBe(1);
	expect(h.lines.some((line) => line.includes("event=stop_forced signal=SIGTERM"))).toBe(true);
	expect(h.lines.filter((line) => line.includes("event=signal"))).toHaveLength(2);
	let exitedCode: number | undefined;
	void h.exited.then((code) => {
		exitedCode = code;
	});
	await Bun.sleep(0);
	expect(exitedCode).toBe(undefined);
});

test("a stop that outlives the bound force-exits 1 with stop_timeout", async () => {
	const h = harness(neverStop, { JABBU_TEST_HOOKS: "1", JABBU_TEST_SHUTDOWN_TIMEOUT_MS: "50" });
	h.handle("SIGTERM");
	// The exit event resolves the race; the sleep is only the failure bound, never the wait itself.
	const boundMs = 5_000;
	const code = await Promise.race([h.onExit, Bun.sleep(boundMs).then(() => -1)]);
	expect(code).toBe(1);
	expect(h.lines.some((line) => line.includes("event=stop_timeout boundMs=50"))).toBe(true);
	let exitedCode: number | undefined;
	void h.exited.then((c) => {
		exitedCode = c;
	});
	await Bun.sleep(0);
	expect(exitedCode).toBe(undefined);
});

test("a clean stop resolves exited 0 and never logs stop_timeout", async () => {
	const h = harness(async () => {}, { JABBU_TEST_HOOKS: "1", JABBU_TEST_SHUTDOWN_TIMEOUT_MS: "50" });
	h.handle("SIGTERM");
	expect(await h.exited).toBe(0);
	expect(h.exits).toEqual([]);
	// sleep-ok: the bound was cleared on settle; only waiting past it proves no late stop_timeout fires.
	await Bun.sleep(120);
	expect(h.lines.some((line) => line.includes("event=stop_timeout"))).toBe(false);
});

test("a stop that rejects resolves exited 1 with stop_failed", async () => {
	const h = harness(async () => {
		throw new Error("close failed");
	});
	h.handle("SIGINT");
	expect(await h.exited).toBe(1);
	expect(h.lines.some((line) => line.includes("event=stop_failed"))).toBe(true);
	expect(h.exits).toEqual([]);
});

test("a second signal after the stop settled is ignored, never force-exits 1", async () => {
	const h = harness(async () => {});
	h.handle("SIGTERM");
	expect(await h.exited).toBe(0);
	h.handle("SIGTERM");
	expect(h.exits).toEqual([]);
	expect(h.lines.some((line) => line.includes("event=signal_after_stop signal=SIGTERM"))).toBe(true);
	// sleep-ok: the handler force-exits synchronously; waiting past a tick proves no late exit comes.
	await Bun.sleep(50);
	expect(h.exits).toEqual([]);
});

test("a second signal after a failed stop settled is ignored too, the exited 1 stands", async () => {
	const h = harness(async () => {
		throw new Error("close failed");
	});
	h.handle("SIGTERM");
	expect(await h.exited).toBe(1);
	h.handle("SIGTERM");
	expect(h.exits).toEqual([]);
	expect(h.lines.some((line) => line.includes("event=signal_after_stop signal=SIGTERM"))).toBe(true);
});
