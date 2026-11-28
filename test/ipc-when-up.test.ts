// `callDaemonWhenUp`: a request that found nobody listening is sent again while the daemon restarts; a request that
// went out is never repeated.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	callDaemon,
	callDaemonWhenUp,
	DAEMON_RETRY_MS,
	IPC_MAX_LINE_BYTES,
	IpcNoResponse,
	IpcNotListening,
	startIpcServer,
} from "../src/daemon/ipc";
import { overCap } from "../src/daemon/ipc-pump";

/** A fake clock the fake sleep moves. */
function clock() {
	let at = 0;
	const sleeps: number[] = [];
	return {
		sleeps,
		now: () => at,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			at += ms;
		},
	};
}

describe("callDaemonWhenUp", () => {
	test("nobody listening twice, then the new daemon answers: three attempts, two pauses", async () => {
		const c = clock();
		let calls = 0;
		const call = async () => {
			calls += 1;
			if (calls < 3) throw new IpcNotListening("Failed to connect");
			return { ok: true };
		};
		expect(await callDaemonWhenUp("/sock", {}, 60_000, { call, ...c })).toEqual({ ok: true });
		expect(calls).toBe(3);
		expect(c.sleeps).toEqual([DAEMON_RETRY_MS, DAEMON_RETRY_MS]);
	});

	test("a request that went out (no answer) is not sent again", async () => {
		const c = clock();
		let calls = 0;
		const call = async () => {
			calls += 1;
			throw new IpcNoResponse("ipc timeout");
		};
		await expect(callDaemonWhenUp("/sock", {}, 60_000, { call, ...c })).rejects.toBeInstanceOf(IpcNoResponse);
		expect(calls).toBe(1);
	});

	test("still nobody at the deadline: the last IpcNotListening is thrown", async () => {
		const c = clock();
		let calls = 0;
		const call = async () => {
			calls += 1;
			throw new IpcNotListening("Failed to connect");
		};
		await expect(callDaemonWhenUp("/sock", {}, 5 * DAEMON_RETRY_MS, { call, ...c })).rejects.toBeInstanceOf(
			IpcNotListening,
		);
		expect(calls).toBe(6);
	});

	test("callDaemon rejects with IpcNotListening on a socket nobody serves, and answers once a server is up", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-ipc-up-"));
		const path = join(dir, "jabbu.sock");
		try {
			await expect(callDaemon(path, { op: "x" })).rejects.toBeInstanceOf(IpcNotListening);
			const server = startIpcServer(path, async () => ({ ok: true }));
			try {
				expect(await callDaemon(path, { op: "x" })).toEqual({ ok: true });
			} finally {
				server.stop();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("startIpcServer socket path", () => {
	test("a directory at the socket path refuses with a remove-it-by-hand error and stays put", () => {
		const dir = mkdtempSync(join(tmpdir(), "ipc-dir-"));
		const path = join(dir, "jabbu.sock");
		mkdirSync(path);
		try {
			expect(() => startIpcServer(path, async () => ({ ok: true }))).toThrow(
				/ipc socket path .* is not a regular file \(remove or move it by hand\)/,
			);
			expect(statSync(path).isDirectory()).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a symlink at the socket path is unlinked and the server answers; the target is untouched", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ipc-link-"));
		const target = join(dir, "target");
		const path = join(dir, "jabbu.sock");
		writeFileSync(target, "stale");
		symlinkSync(target, path);
		const server = startIpcServer(path, async () => ({ ok: true }));
		try {
			expect(await callDaemon(path, { op: "x" })).toEqual({ ok: true });
			expect(readFileSync(target, "utf8")).toBe("stale");
		} finally {
			server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a live socket at the path is unlinked and the new server answers (a restart in the same home)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ipc-sock-"));
		const path = join(dir, "jabbu.sock");
		const first = startIpcServer(path, async () => ({ ok: "first" }));
		try {
			const second = startIpcServer(path, async () => ({ ok: "second" }));
			try {
				expect(await callDaemon(path, { op: "x" })).toEqual({ ok: "second" });
			} finally {
				second.stop();
			}
		} finally {
			first.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("startIpcServer input cap", () => {
	const CAP = IPC_MAX_LINE_BYTES;

	/** Sends `payload` to a fresh server and reports what the handler saw and whether the server closed first. */
	async function send(payload: Buffer): Promise<{ handled: unknown[]; reply: string; closedWithoutReply: boolean }> {
		const dir = mkdtempSync(join(tmpdir(), "ipc-cap-"));
		const path = join(dir, "s.sock");
		const handled: unknown[] = [];
		const server = startIpcServer(path, async (request) => {
			handled.push(request);
			return { ok: true };
		});
		try {
			let reply = "";
			const gone = Promise.withResolvers<void>();
			let rest = payload;
			const write = (s: Bun.Socket<undefined>): void => {
				if (rest.length > 0) rest = rest.subarray(s.write(rest));
			};
			await Bun.connect({
				unix: path,
				socket: {
					open: write,
					drain: write,
					data(_s, chunk) {
						reply += chunk.toString();
					},
					close() {
						gone.resolve();
					},
					error() {
						gone.resolve();
					},
				},
			});
			await Promise.race([gone.promise, Bun.sleep(5000)]); // sleep-ok: upper bound on waiting for the close
			return { handled, reply, closedWithoutReply: reply === "" };
		} finally {
			server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	}

	/** One JSON line of exactly `bytes` bytes (newline not counted): `unit` repeated, topped up with ASCII, then the newline. */
	function line(bytes: number, unit = "a"): Buffer {
		const pad = bytes - Buffer.byteLength('{"p":""}');
		const units = Math.floor(pad / Buffer.byteLength(unit));
		const rest = pad - units * Buffer.byteLength(unit);
		return Buffer.from(`{"p":"${unit.repeat(units)}${"a".repeat(rest)}"}\n`);
	}

	test("a line of exactly the cap is handled; one byte more is dropped, newline in the same chunk or not", async () => {
		const ok = await send(line(CAP));
		expect(ok.handled).toHaveLength(1);
		expect(ok.reply).toContain('"ok":true');
		const over = await send(line(CAP + 1));
		expect(over.handled).toHaveLength(0);
		expect(over.closedWithoutReply).toBe(true);
	});

	test("the cap counts bytes, not characters: a multibyte line over the cap is dropped though it is under it in characters", async () => {
		// 3-byte characters: CAP / 3 + 1 of them is more than CAP bytes but fewer than CAP characters.
		const over = await send(line(CAP + 2, "가"));
		expect(line(CAP + 2, "가").length - 1).toBe(CAP + 2);
		expect(over.handled).toHaveLength(0);
		expect(over.closedWithoutReply).toBe(true);
		const ok = await send(line(CAP - 1, "가"));
		expect(ok.handled).toHaveLength(1);
	});

	test("a line over the cap that never gets its newline is dropped and the server keeps serving", async () => {
		const over = await send(Buffer.alloc(CAP + 1024 * 1024, "a"));
		expect(over.handled).toHaveLength(0);
		expect(over.closedWithoutReply).toBe(true);
		expect((await send(Buffer.from('{"op":"ping"}\n'))).handled).toEqual([{ op: "ping" }]);
	});
});

describe("startIpcServer pipelining", () => {
	/** A server whose first request is slow; the test resolves once two reply lines arrived. */
	async function pipelined(send: (s: Bun.Socket<undefined>) => void): Promise<{ handled: unknown[]; replies: string }> {
		const dir = mkdtempSync(join(tmpdir(), "ipc-pipe-"));
		const path = join(dir, "s.sock");
		const handled: unknown[] = [];
		const server = startIpcServer(path, async (request) => {
			handled.push(request);
			const op = (request as { op?: string }).op;
			// sleep-ok: the first handler must still be running when the second line arrives, so order proves serialization.
			if (op === "slow") await Bun.sleep(100);
			return { op };
		});
		try {
			const chunks: string[] = [];
			const done = Promise.withResolvers<void>();
			const finish = () => {
				if (
					chunks
						.join("")
						.split("\n")
						.filter((line) => line !== "").length >= 2
				)
					done.resolve();
			};
			await Bun.connect({
				unix: path,
				socket: {
					open: send,
					data(_s, chunk) {
						chunks.push(chunk.toString());
						finish();
					},
					close() {
						done.resolve();
					},
					error() {
						done.resolve();
					},
				},
			});
			// sleep-ok: upper bound on waiting for the pipelined replies.
			await Promise.race([done.promise, Bun.sleep(5000)]);
			return { handled, replies: chunks.join("") };
		} finally {
			server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("two lines in one chunk are both answered, in order, even when the first handler is slow", async () => {
		const { handled, replies } = await pipelined((s) => {
			s.write(Buffer.from('{"op":"slow"}\n{"op":"fast"}\n'));
		});
		expect(handled).toEqual([{ op: "slow" }, { op: "fast" }]);
		expect(replies).toBe('{"op":"slow"}\n{"op":"fast"}\n');
	});

	test("a second line sent while the first is still running is answered after it, not instead of it", async () => {
		const { handled, replies } = await pipelined((s) => {
			s.write(Buffer.from('{"op":"slow"}\n'));
			// sleep-ok: the second line must arrive while the first handler still runs (100ms).
			setTimeout(() => s.write(Buffer.from('{"op":"fast"}\n')), 10);
		});
		expect(handled).toEqual([{ op: "slow" }, { op: "fast" }]);
		expect(replies).toBe('{"op":"slow"}\n{"op":"fast"}\n');
	});
});

describe("overCap across pipelined lines", () => {
	test("bytes after the first newline count toward the next line's cap", () => {
		const state = { bytes: 0, dropped: false };
		expect(overCap(state, Buffer.from("abc\n12345678"), 10)).toBe(false);
		expect(state.bytes).toBe(8);
		expect(overCap(state, Buffer.from("901\n"), 10)).toBe(true);
	});

	test("several complete lines in one chunk are each capped on their own", () => {
		const state = { bytes: 0, dropped: false };
		expect(overCap(state, Buffer.from("abc\ndef\n"), 10)).toBe(false);
		expect(state.bytes).toBe(0);
		expect(overCap(state, Buffer.from("12345678901\n"), 10)).toBe(true);
	});
});
