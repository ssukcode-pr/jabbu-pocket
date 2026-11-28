import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { MAX_INBOUND_FILES, MAX_INBOUND_IMAGE_BYTES, sniffImageMime } from "../channel/attachments";
import { protectedDirs, realOrSelf } from "../safety/forbidden-paths";
import { isInside } from "../safety/inside";

/** Maximum uploaded file size on web chat (25 MiB per file, matching `MAX_INBOUND_IMAGE_BYTES`). */
export const WEB_UPLOAD_MAX_BYTES = MAX_INBOUND_IMAGE_BYTES;
const MULTIPART_OVERHEAD_BYTES = 512 * 1024;
/** Total wall time allowed for reading one upload body: a trickling head must not wedge later uploads forever. */
const UPLOAD_READ_TIMEOUT_MS = 60_000;
const CONTROL_CHARS = /\p{Cc}/u;

const FORBIDDEN_PATH_TOKENS =
	/(?:^|[/\\])(?:\.\.|secrets|\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.agy-accounts|\.gemini|\.git-credentials|\.netrc|\.npmrc)(?:$|[/\\])/i;

export interface UploadedWebFile {
	path: string;
	name: string;
	bytes: number;
	mime: string;
}

export type WebUploadOutcome =
	| { ok: true; path: string; files: UploadedWebFile[] }
	| { ok: false; status: 400 | 403 | 408 | 413; error: string };

/** Directory holding inbound attachments uploaded via `/api/web/upload`. */
export function webUploadRoot(homeDir: string): string {
	return join(homeDir, "media", "inbound", "web");
}

/** True when `realPath` resolves inside `<homeDir>/secrets` or any user credential store. */
export function isForbiddenSecretPath(realPath: string, homeDir: string, userHome = homedir()): boolean {
	return protectedDirs(homeDir, userHome).some((dir) => isInside(realPath, dir));
}

function ensureSafeDir(dirPath: string): void {
	const stat = lstatSync(dirPath, { throwIfNoEntry: false });
	if (stat?.isSymbolicLink()) throw new UploadRefusedError(403, "forbidden_path");
	if (stat === undefined) {
		mkdirSync(dirPath, { mode: 0o700 });
		return;
	}
	if (!stat.isDirectory()) throw new UploadRefusedError(403, "forbidden_path");
}

class UploadRefusedError extends Error {
	constructor(
		readonly status: 400 | 403 | 408 | 413,
		readonly code: string,
	) {
		super(code);
	}
}

function resolveUploadDir(homeDir: string, userHome = homedir()): string {
	for (const part of [homeDir, join(homeDir, "media"), join(homeDir, "media", "inbound"), webUploadRoot(homeDir)]) {
		ensureSafeDir(part);
	}
	const realRoot = realpathSync(webUploadRoot(homeDir));
	const realHome = realpathSync(homeDir);
	if (!isInside(realRoot, realHome) || isForbiddenSecretPath(realRoot, homeDir, userHome)) {
		throw new UploadRefusedError(403, "forbidden_path");
	}
	return realRoot;
}

function checkRequestedName(rawName: string | null | undefined): string {
	if (rawName === undefined || rawName === null || rawName === "") return "upload.bin";
	if (CONTROL_CHARS.test(rawName) || rawName.includes("\0")) throw new UploadRefusedError(400, "invalid_filename");
	if (
		rawName.startsWith("/") ||
		rawName.startsWith("~") ||
		rawName.includes("\\") ||
		FORBIDDEN_PATH_TOKENS.test(rawName)
	) {
		throw new UploadRefusedError(403, "forbidden_path");
	}
	const base = basename(rawName).trim();
	if (base === "" || base === "." || base === "..") throw new UploadRefusedError(400, "invalid_filename");
	return base;
}

function safeExtension(filename: string, mime: string): string {
	const fromName = /\.([a-z0-9]{1,8})$/i.exec(filename)?.[1]?.toLowerCase();
	if (fromName !== undefined) return fromName;
	if (mime === "image/png") return "png";
	if (mime === "image/jpeg") return "jpg";
	if (mime === "image/webp") return "webp";
	if (mime === "image/gif") return "gif";
	if (mime === "application/pdf") return "pdf";
	if (mime.startsWith("text/")) return "txt";
	return "bin";
}

async function readBoundedBody(request: Request, maxBytes: number, readTimeoutMs: number): Promise<Uint8Array> {
	const rawLength = request.headers.get("content-length");
	if (rawLength !== null) {
		const declared = Number(rawLength);
		if (Number.isFinite(declared) && declared > maxBytes) throw new UploadRefusedError(413, "file_too_large");
	}
	if (request.body === null) throw new UploadRefusedError(400, "empty_upload");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	// A client trickling bytes must not hold the upload queue forever: the whole body read has one deadline.
	const deadline = Date.now() + readTimeoutMs;
	try {
		for (;;) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				await reader.cancel().catch(() => undefined);
				throw new UploadRefusedError(408, "upload_timeout");
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			const next = await Promise.race([
				reader.read(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new UploadRefusedError(408, "upload_timeout")), remaining);
				}),
			]).catch(async (error) => {
				await reader.cancel().catch(() => undefined);
				throw error;
			});
			clearTimeout(timer);
			if (next.done) break;
			if (next.value.byteLength === 0) continue;
			total += next.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new UploadRefusedError(413, "file_too_large");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	if (total === 0) throw new UploadRefusedError(400, "empty_upload");
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function writeAtomicUpload(root: string, name: string, mime: string, bytes: Uint8Array): UploadedWebFile {
	if (bytes.byteLength === 0) throw new UploadRefusedError(400, "empty_upload");
	if (bytes.byteLength > WEB_UPLOAD_MAX_BYTES) throw new UploadRefusedError(413, "file_too_large");
	if (mime.startsWith("image/") && sniffImageMime(bytes.subarray(0, 12)) === undefined) {
		throw new UploadRefusedError(400, "not_an_image");
	}
	const ext = safeExtension(name, mime);
	const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
	const prefix = mime.startsWith("image/") ? "img" : "doc";
	const dest = join(root, `${prefix}_${hash}_${randomBytes(3).toString("hex")}.${ext}`);
	const tmp = join(root, `.tmp-${randomBytes(8).toString("hex")}`);
	try {
		writeFileSync(tmp, bytes, { mode: 0o600 });
		renameSync(tmp, dest);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
	return { path: dest, name, bytes: bytes.byteLength, mime };
}

/**
 * Copies a file the bot sends into the chat (already vetted by the host tool: protected directories, token scan) into the
 * served upload root, so the web file route can serve it later whatever happens to the source. Returns the copy's path, or
 * `undefined` when it cannot be taken over (missing, not a regular file, over the serve cap, unsafe root): the message then
 * keeps the original path and the chat shows the file without a download.
 */
export function adoptWebFile(sourcePath: string, homeDir: string, userHome = homedir()): string | undefined {
	try {
		const stat = lstatSync(sourcePath);
		if (!stat.isFile() || stat.size === 0 || stat.size > WEB_UPLOAD_MAX_BYTES) return undefined;
		const root = resolveUploadDir(homeDir, userHome);
		const bytes = readFileSync(sourcePath);
		const mime = sniffImageMime(bytes.subarray(0, 12)) ?? "application/octet-stream";
		return writeAtomicUpload(root, basename(sourcePath), mime, bytes).path;
	} catch {
		return undefined;
	}
}

/** Uploads run one at a time: each buffers up to ~150 MiB in memory (whole body + form parse + file copies), so concurrent uploads would multiply the peak. */
let uploadQueue: Promise<unknown> = Promise.resolve();

/** Validates, size-caps (25 MiB), and stores uploaded files from `/api/web/upload` under `<home>/media/inbound/web/`. */
export async function saveWebUpload(
	request: Request,
	homeDir: string,
	userHome = homedir(),
	options: { readTimeoutMs?: number | undefined } = {},
): Promise<WebUploadOutcome> {
	const run = uploadQueue.then(() =>
		saveWebUploadInner(request, homeDir, userHome, options.readTimeoutMs ?? UPLOAD_READ_TIMEOUT_MS),
	);
	// A refused upload must not break the chain for later ones.
	uploadQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

async function saveWebUploadInner(
	request: Request,
	homeDir: string,
	userHome = homedir(),
	readTimeoutMs: number = UPLOAD_READ_TIMEOUT_MS,
): Promise<WebUploadOutcome> {
	try {
		const root = resolveUploadDir(homeDir, userHome);
		const contentType = request.headers.get("content-type") ?? "";
		const isMultipart = contentType.toLowerCase().includes("multipart/form-data");
		const streamCap = isMultipart
			? MAX_INBOUND_FILES * WEB_UPLOAD_MAX_BYTES + MULTIPART_OVERHEAD_BYTES
			: WEB_UPLOAD_MAX_BYTES;
		const body = await readBoundedBody(request, streamCap, readTimeoutMs);
		const saved: UploadedWebFile[] = [];

		if (isMultipart) {
			let form: Awaited<ReturnType<Response["formData"]>>;
			try {
				form = await new Response(body, { headers: { "content-type": contentType } }).formData();
			} catch {
				throw new UploadRefusedError(400, "invalid_multipart");
			}
			for (const field of ["dir", "path", "target"]) {
				const raw = form.get(field);
				if (typeof raw === "string" && raw.trim() !== "") throw new UploadRefusedError(403, "forbidden_path");
			}
			const candidates = [...form.getAll("file"), ...form.getAll("files")].filter(
				(entry): entry is Exclude<typeof entry, string> =>
					typeof entry === "object" && entry !== null && "arrayBuffer" in entry,
			);
			if (candidates.length === 0) throw new UploadRefusedError(400, "empty_upload");
			if (candidates.length > MAX_INBOUND_FILES) throw new UploadRefusedError(400, "too_many_files");
			for (const file of candidates) {
				const safeName = checkRequestedName(file.name);
				if (file.size > WEB_UPLOAD_MAX_BYTES) throw new UploadRefusedError(413, "file_too_large");
				const bytes = new Uint8Array(await file.arrayBuffer());
				const mime = (file.type || "application/octet-stream").split(";")[0]?.trim() || "application/octet-stream";
				saved.push(writeAtomicUpload(root, safeName, mime, bytes));
			}
		} else {
			const safeName = checkRequestedName(request.headers.get("x-filename"));
			const mime =
				contentType !== ""
					? contentType.split(";")[0]?.trim() || "application/octet-stream"
					: "application/octet-stream";
			saved.push(writeAtomicUpload(root, safeName, mime, body));
		}

		const first = saved[0];
		if (first === undefined) throw new UploadRefusedError(400, "empty_upload");
		return { ok: true, path: first.path, files: saved };
	} catch (error) {
		if (error instanceof UploadRefusedError) {
			return { ok: false, status: error.status, error: error.code };
		}
		return { ok: false, status: 400, error: "upload_failed" };
	}
}

/** Refuses `web_send` attachment paths pointing outside `<home>/media/inbound/web/` or into any secret directory. */
export function validateWebAttachmentPath(
	rawPath: string,
	homeDir: string,
	userHome = homedir(),
): { ok: true; path: string } | { ok: false; error: string } {
	if (rawPath === "" || CONTROL_CHARS.test(rawPath) || !isAbsolute(rawPath)) {
		return { ok: false, error: "forbidden_file_path" };
	}
	let stat: ReturnType<typeof lstatSync>;
	let real: string;
	try {
		stat = lstatSync(rawPath);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			return { ok: false, error: "forbidden_file_path" };
		}
		real = realpathSync(rawPath);
	} catch {
		return { ok: false, error: "file_not_found" };
	}
	if (isForbiddenSecretPath(real, homeDir, userHome)) {
		return { ok: false, error: "forbidden_file_path" };
	}
	const realRoot = realOrSelf(webUploadRoot(homeDir));
	if (!isInside(real, realRoot)) {
		return { ok: false, error: "forbidden_file_path" };
	}
	if (stat.size > WEB_UPLOAD_MAX_BYTES) {
		return { ok: false, error: "file_too_large" };
	}
	return { ok: true, path: real };
}
