import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveWebUpload, webUploadRoot } from "../src/web/upload";

let home = "";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-web-upload-timeout-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function uploadRequest(body: Uint8Array | ReadableStream<Uint8Array>): Request {
	return new Request("http://x/api/web/upload", {
		method: "POST",
		headers: { "content-type": "application/octet-stream", "x-filename": "a.bin" },
		body,
		duplex: "half",
	});
}

describe("web upload body reads time out", () => {
	test("a body that stalls mid-stream fails 408 and frees the queue for the next upload", async () => {
		// Delivers one chunk, then never delivers another byte: the second read stalls until the deadline.
		const stalledBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("x"));
			},
			pull() {
				// Never enqueues again.
			},
		});

		const stalled = await saveWebUpload(uploadRequest(stalledBody), home, undefined, { readTimeoutMs: 50 });
		expect(stalled).toEqual({ ok: false, status: 408, error: "upload_timeout" });
		expect(readdirSync(webUploadRoot(home))).toEqual([]);

		// The stuck head is gone: a later upload runs at once.
		const next = await saveWebUpload(uploadRequest(new TextEncoder().encode("y")), home);
		expect(next.ok).toBe(true);
		expect(readdirSync(webUploadRoot(home))).toHaveLength(1);
	});
});
