// `reloadOnSighup`: a throw inside `reloadConfig` is logged, never a fatal exit.
import { expect, test } from "bun:test";
import type { Daemon } from "../src/daemon/daemon";
import { reloadOnSighup } from "../src/daemon/run";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";

/** A daemon whose reload either throws (a closed or busy store) or succeeds, over a capturing log. */
function harness(reloadConfig: () => unknown): {
	daemon: Daemon;
	lines: string[];
	log: ReturnType<typeof createLogger>;
} {
	const lines: string[] = [];
	const log = createLogger({ sink: (line) => lines.push(line), clock: { now: () => 0 }, redact });
	return { daemon: { reloadConfig } as unknown as Daemon, lines, log };
}

test("a throw inside reloadConfig is logged as config_reload_failed, not thrown", () => {
	const { daemon, lines, log } = harness(() => {
		throw new Error("db is closed");
	});
	expect(() => reloadOnSighup(daemon, log)).not.toThrow();
	const failed = lines.filter((line) => line.includes("event=config_reload_failed"));
	expect(failed).toHaveLength(1);
	expect(failed[0]).toContain("trigger=sighup");
	expect(failed[0]).toContain("db is closed");
});

test("a clean reload logs no config_reload_failed", () => {
	const { daemon, lines, log } = harness(() => ({ ok: true, changed: [], restartRequired: [], cli: [] }));
	reloadOnSighup(daemon, log);
	expect(lines.some((line) => line.includes("event=config_reload_failed"))).toBe(false);
});
