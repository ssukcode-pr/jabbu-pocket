// Writing a reply to a socket that takes only part of it (moved out of ipc.ts unchanged).
/** Bytes still to go out on a socket whose `write` took only part of them. */
export interface Outgoing {
	rest: Buffer;
	/** Close the socket once the last byte is out. */
	endWhenDone: boolean;
}

/** Writes what the socket takes now; the `drain` handler calls it again for the rest. */
export function pump(socket: Bun.Socket<unknown>, out: Outgoing): void {
	if (out.rest.length > 0) out.rest = out.rest.subarray(Math.max(0, socket.write(out.rest)));
	if (out.rest.length === 0 && out.endWhenDone) socket.end();
}

/** The longest request line (bytes, newline excluded) a connection may send; the largest real request is far below it. */
export const IPC_MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Counts the bytes of the request line chunk by chunk and says whether it went over `max`, whether or not its newline has
 * arrived yet. Once over, every later chunk of the connection is over as well.
 */
export function overCap(state: { bytes: number; dropped: boolean }, chunk: Uint8Array, max: number): boolean {
	if (state.dropped) return true;
	const newline = chunk.indexOf(10);
	const total = state.bytes + (newline === -1 ? chunk.length : newline);
	state.bytes = newline === -1 ? total : 0;
	state.dropped = total > max;
	return state.dropped;
}
