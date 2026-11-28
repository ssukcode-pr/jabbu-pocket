import { chmodSync, lstatSync, rmSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
	answerLine,
	endWhenIdle,
	IPC_MAX_LINE_BYTES,
	newConnection,
	type Outgoing,
	overCap,
	pump,
	type ServerConnection,
} from "./ipc-pump";

/** The largest delay `setTimeout` keeps; a longer one is cut to 1 ms with a warning. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export { IPC_MAX_LINE_BYTES };

/** JSON request lines in, one JSON response line out per request, then the connection closes once the lines received are answered. */
export type IpcHandler = (request: unknown) => Promise<unknown>;

export interface IpcServer {
	stop(): void;
}

export function startIpcServer(path: string, handler: IpcHandler): IpcServer {
	// A non-file at the socket path is never ours to remove (like the lock's notFile refusal); a symlink is unlinked as before,
	// and so is a socket: a previous daemon's live socket (a restart in the same home) is stale once the lock is held.
	const st = lstatSync(path, { throwIfNoEntry: false });
	if (st !== undefined && !st.isFile() && !st.isSymbolicLink() && !st.isSocket())
		throw new Error(`ipc socket path ${path} is not a regular file (remove or move it by hand)`);
	rmSync(path, { force: true }); // the single-instance lock is held, so a leftover socket file is stale
	// Created under umask 0177 so the socket is never visible with wider permissions, then pinned to 0600.
	const previousUmask = process.umask(0o177);
	let server: Bun.UnixSocketListener<ServerConnection>;
	try {
		server = Bun.listen<ServerConnection>({
			unix: path,
			socket: {
				open(socket) {
					socket.data = newConnection();
				},
				drain(socket) {
					pump(socket, socket.data.out);
					endWhenIdle(socket);
				},
				data(socket, chunk) {
					if (overCap(socket.data, chunk, IPC_MAX_LINE_BYTES)) {
						socket.data.buffer = "";
						socket.end();
						return;
					}
					socket.data.buffer += socket.data.decoder.write(chunk);
					// One request per line, answered in arrival order: the chain keeps a slow first request's
					// reply (a second line used to overwrite it, or be dropped with the rest of the buffer).
					for (;;) {
						const newline = socket.data.buffer.indexOf("\n");
						if (newline === -1) return;
						const line = socket.data.buffer.slice(0, newline);
						socket.data.buffer = socket.data.buffer.slice(newline + 1);
						socket.data.pending += 1;
						socket.data.queue = socket.data.queue.then(() => answerLine(socket, line, handler)).catch(() => undefined);
					}
				},
			},
		});
	} finally {
		process.umask(previousUmask);
	}
	chmodSync(path, 0o600);
	return {
		stop() {
			server.stop(true);
			rmSync(path, { force: true });
		},
	};
}

/** The daemon took the request but gave no answer (timeout, or it closed first): it may still be acting on it. */
export class IpcNoResponse extends Error {}

/** Nothing listened on the socket: the request never went out, so sending it again cannot repeat it. */
export class IpcNotListening extends Error {}

/** Pause between connection attempts of {@link callDaemonWhenUp}. */
export const DAEMON_RETRY_MS = 2_000;

/**
 * {@link callDaemon}, tried again every {@link DAEMON_RETRY_MS} while nothing listens (a restart between two daemons),
 * for up to `waitMs`; any other failure, and the last `IpcNotListening`, is thrown as it is.
 */
export async function callDaemonWhenUp(
	path: string,
	request: unknown,
	waitMs: number,
	deps: { call?: typeof callDaemon; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<unknown> {
	const { call = callDaemon, sleep = Bun.sleep, now = Date.now } = deps;
	const deadline = now() + waitMs;
	for (;;) {
		try {
			return await call(path, request);
		} catch (error) {
			if (!(error instanceof IpcNotListening) || now() + DAEMON_RETRY_MS > deadline) throw error;
		}
		await sleep(DAEMON_RETRY_MS);
	}
}

/**
 * Sends one request to the daemon socket and resolves with its response; rejects when nothing is listening, and with
 * `IpcNoResponse` when the request went out but no answer came.
 */
export async function callDaemon(path: string, request: unknown, timeoutMs = 120_000): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const decoder = new StringDecoder("utf8");
	const out: Outgoing = { rest: Buffer.from(`${JSON.stringify(request)}\n`) };
	let buffer = "";
	let settled = false;
	const timer = setTimeout(
		() => finish(new IpcNoResponse(`ipc timeout after ${timeoutMs}ms`)),
		Math.min(timeoutMs, MAX_TIMER_MS),
	);
	function finish(error: Error | undefined, value?: unknown): void {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (error) reject(error);
		else resolve(value);
	}
	const socket = await Bun.connect({
		unix: path,
		socket: {
			open: (s) => pump(s, out),
			drain: (s) => pump(s, out),
			data(_s, chunk) {
				buffer += decoder.write(chunk);
				const newline = buffer.indexOf("\n");
				if (newline === -1) return;
				try {
					finish(undefined, JSON.parse(buffer.slice(0, newline)));
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			},
			close() {
				finish(new IpcNoResponse("ipc connection closed without a response"));
			},
			error(_s, error) {
				finish(error);
			},
		},
	}).catch((error: unknown) => {
		clearTimeout(timer);
		throw new IpcNotListening(error instanceof Error ? error.message : String(error));
	});
	try {
		return await promise;
	} finally {
		socket.end();
	}
}
