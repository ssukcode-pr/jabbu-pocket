import { StringDecoder } from "node:string_decoder";

// Writing a reply to a socket that takes only part of it, and the per-connection state of the IPC server
// (moved out of ipc.ts unchanged, then grown with the pipelining fix).
/** Bytes still to go out on a socket whose `write` took only part of them. */
export interface Outgoing {
	rest: Buffer;
}

/** Writes what the socket takes now; the `drain` handler calls it again for the rest. */
export function pump(socket: Bun.Socket<unknown>, out: Outgoing): void {
	if (out.rest.length > 0) out.rest = out.rest.subarray(Math.max(0, socket.write(out.rest)));
}

/** Per-connection state of the IPC server: the line buffer, the byte cap, and the reply queue. */
export interface ServerConnection {
	/** Decodes across chunk boundaries, so a multibyte character split between two chunks stays whole. */
	decoder: StringDecoder;
	buffer: string;
	/** Bytes of the request line so far, and whether it went over the cap. */
	bytes: number;
	dropped: boolean;
	out: Outgoing;
	/** Requests chained but not yet answered, in arrival order. */
	pending: number;
	/** Serializes the per-line answers so a slow first request keeps its reply. */
	queue: Promise<void>;
}

/** Fresh per-connection state: an empty line buffer and an empty reply. */
export function newConnection(): ServerConnection {
	return {
		decoder: new StringDecoder("utf8"),
		buffer: "",
		bytes: 0,
		dropped: false,
		out: { rest: Buffer.alloc(0) },
		pending: 0,
		queue: Promise.resolve(),
	};
}

/** The longest request line (bytes, newline excluded) a connection may send; the largest real request is far below it. */
export const IPC_MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Counts the bytes of the request line chunk by chunk and says whether it went over `max`, whether or not its newline has
 * arrived yet. Once over, every later chunk of the connection is over as well. Bytes after a newline in the same
 * chunk count toward the next line, so a pipelined line cannot slip past the cap on the previous line's credit.
 */
export function overCap(state: { bytes: number; dropped: boolean }, chunk: Uint8Array, max: number): boolean {
	if (state.dropped) return true;
	let start = 0;
	let carried = state.bytes;
	for (;;) {
		const newline = chunk.indexOf(10, start);
		if (newline === -1) {
			// No newline left: the rest belongs to the next (partial) line, so it counts toward that line's cap.
			const total = carried + (chunk.length - start);
			state.bytes = total;
			state.dropped = total > max;
			return state.dropped;
		}
		const total = carried + (newline - start);
		if (total > max) {
			state.dropped = true;
			state.bytes = 0;
			return true;
		}
		carried = 0;
		start = newline + 1;
	}
}

/**
 * Answers one request line on `socket`: the handler's answer, or `{ ok: false, error }` when the line is not
 * JSON or the handler throws (a reply is always attempted, so a bad line never hangs the client). The answer is
 * appended behind any reply still draining, so a slow first request's remainder is never overwritten by the next
 * one. The socket closes in {@link endWhenIdle} once this was the last waiting answer.
 */
export async function answerLine(
	socket: Bun.Socket<ServerConnection>,
	line: string,
	handler: (request: unknown) => Promise<unknown>,
): Promise<void> {
	try {
		const response = await handler(JSON.parse(line));
		socket.data.out.rest = Buffer.concat([socket.data.out.rest, Buffer.from(`${JSON.stringify(response)}\n`)]);
	} catch (error) {
		socket.data.out.rest = Buffer.concat([
			socket.data.out.rest,
			Buffer.from(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`),
		]);
	} finally {
		pump(socket, socket.data.out);
		socket.data.pending -= 1;
		endWhenIdle(socket);
	}
}

/**
 * Ends the socket once the last queued answer drained and no line waits: the per-connection close. A partial
 * line still in the buffer means the client is mid-request, so the socket stays open for the rest of it; a
 * client that wants to send more after its answers must reconnect, as before.
 */
export function endWhenIdle(socket: Bun.Socket<ServerConnection>): void {
	const data = socket.data;
	if (data.pending === 0 && data.out.rest.length === 0 && data.buffer === "") socket.end();
}
