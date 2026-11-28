import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventStreamFn, handleWebStream, type WebStreamConfig } from "../src/web/stream";

let home = "";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-web-stream-cap-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("web stream cap", () => {
	test("the 33rd concurrent stream per bot is refused with 429, and closing one frees a slot", async () => {
		// Polls never run in this test: the streams stay open without touching the DB.
		const config: WebStreamConfig = { streamSchedule: () => () => {} };
		const target = { id: "b", homeDir: home } as never;
		const closes: Array<() => void> = [];
		const eventStream: EventStreamFn = (_req, _keepAliveMs, subscribe) => {
			closes.push(subscribe(() => {}));
			return new Response("");
		};
		const open = () =>
			handleWebStream(
				new Request("http://x/api/web/stream"),
				new URL("http://x/api/web/stream?after=0&afterEdited=0"),
				config,
				target,
				false,
				{},
				eventStream,
			);
		for (let i = 0; i < 32; i++) expect(open().status).toBe(200);
		const refused = open();
		expect(refused.status).toBe(429);
		expect(await refused.json()).toEqual({ error: "too_many_web_streams" });
		closes[0]?.();
		expect(open().status).toBe(200);
		for (const close of closes.slice(1)) close?.();
	});
});
