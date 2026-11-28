import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboardServer } from "../src/dashboard/server";
import type { DashboardSnapshot } from "../src/dashboard/snapshot";
import type { JwkKey } from "../src/web/auth";
import { resolveWebBots } from "../src/web/bots";
import { type WebDashboardOptions, webDashboardOptionsFor } from "../src/web/routes";

const TOKEN = "web-task-test-token";
const TASK = "T-20261126-01";
const AUD = "aud-task";
const TEAM = "team.cloudflareaccess.com";
const WEB_CONFIG = { enabled: true, ownerEmails: ["owner@example.com"], accessTeamDomain: TEAM, accessAud: AUD };
const STUB_SNAPSHOT: DashboardSnapshot = {
	generatedAt: "2026-11-26T00:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: { ok: false, error: "daemon_down" },
	turns: { ok: false, error: "no_db" },
	tasks: { ok: false, error: "no_db" },
	lanes: { ok: false, error: "no_db" },
	herdr: { ok: false, error: "off" },
	approvals: { ok: false, error: "no_db" },
	monitors: { ok: false, error: "no_db" },
	alerts: { ok: false, error: "no_db" },
	gates: { ok: false, error: "no_db" },
	backup: { ok: false, error: "no_db" },
	jobs: { ok: false, error: "no_db" },
};

interface Call {
	path: string;
	request: unknown;
	timeoutMs: number | undefined;
}

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A dashboard server whose web options come from `webDashboardOptionsFor` and whose daemon is `answer`. */
function start(
	options: { web?: boolean; peer?: boolean; keys?: JwkKey[]; answer?: (request: unknown) => unknown } = {},
) {
	const home = mkdtempSync(join(tmpdir(), "jabbu-web-task-"));
	dirs.push(home);
	mkdirSync(join(home, "state"), { mode: 0o700 });
	writeFileSync(join(home, "state", "web-local.token"), `${TOKEN}\n`, { mode: 0o600 });
	const calls: Call[] = [];
	const callDaemon = async (path: string, request: unknown, timeoutMs?: number) => {
		calls.push({ path, request, timeoutMs });
		return options.answer === undefined ? { ok: true, text: "됐습니다" } : options.answer(request);
	};
	const built = webDashboardOptionsFor(home, options.web === false ? undefined : WEB_CONFIG, callDaemon);
	const peerHome = join(home, "peer");
	const web: WebDashboardOptions | undefined =
		built === undefined
			? undefined
			: {
					...built,
					auth: { ...built.auth, fetchJwks: async () => ({ keys: options.keys ?? [] }) },
					...(options.peer === true
						? {
								bots: [
									{ id: "main", name: "송박", homeDir: home, callDaemon: built.callDaemon },
									{
										id: "seopak",
										name: "서팍",
										homeDir: peerHome,
										callDaemon: (request, timeoutMs) => callDaemon(join(peerHome, "jabbu.sock"), request, timeoutMs),
									},
								],
							}
						: {}),
				};
	const server = startDashboardServer({ port: 0, hostname: "127.0.0.1", web, snapshot: async () => STUB_SNAPSHOT });
	stops.push(() => server.stop(true));
	const base = `http://127.0.0.1:${server.port}`;
	const auth = { authorization: `Bearer ${TOKEN}` };
	return {
		home,
		base,
		calls,
		/** The CSRF token an authenticated GET hands out (what the panel reads on open). */
		async csrf(): Promise<string> {
			const res = await fetch(`${base}/api/web/conversations`, { headers: auth });
			expect(res.status).toBe(200);
			return res.headers.get("x-jabbu-csrf") ?? "";
		},
		async post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response> {
			const token = headers === undefined ? await this.csrf() : "";
			return fetch(`${base}${path}`, {
				method: "POST",
				headers: headers ?? {
					...auth,
					"sec-fetch-site": "same-origin",
					cookie: `jabbu_csrf=${token}`,
					"x-jabbu-csrf": token,
					"content-type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		},
		/** POST with a streamed body (chunked, no Content-Length): the cap must be enforced while reading. */
		async postStream(path: string, body: string): Promise<Response> {
			const token = await this.csrf();
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(body));
					controller.close();
				},
			});
			return fetch(`${base}${path}`, {
				method: "POST",
				headers: {
					...auth,
					"sec-fetch-site": "same-origin",
					cookie: `jabbu_csrf=${token}`,
					"x-jabbu-csrf": token,
					"content-type": "application/json",
				},
				body: stream,
				duplex: "half",
			});
		},
	};
}

const b64url = (bytes: Uint8Array | string): string =>
	Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).toString("base64url");

/** An ES256 Access JWT for `email`, signed by a fresh key whose public JWK is returned for the JWKS. */
async function accessJwt(email: string): Promise<{ jwt: string; jwk: JwkKey }> {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "kid-task", alg: "ES256" };
	const head = b64url(JSON.stringify({ alg: "ES256", kid: "kid-task" }));
	const claims = {
		aud: AUD,
		iss: `https://${TEAM}`,
		exp: Math.floor(Date.now() / 1000) + 300,
		iat: Math.floor(Date.now() / 1000) - 10,
		email,
	};
	const payload = b64url(JSON.stringify(claims));
	const sig = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		pair.privateKey,
		new TextEncoder().encode(`${head}.${payload}`),
	);
	return { jwt: `${head}.${payload}.${b64url(new Uint8Array(sig))}`, jwk };
}

describe("dashboard 작업 내역: POST api/web/task/<id>/followup|pause|resume", () => {
	test("AC-2·AC-3·AC-6: the three ops reach the daemon as task_followup / tasks_pause·tasks_resume (source web) with a 60s IPC; other web ops keep 5s", async () => {
		const app = start();
		const followup = await app.post(`/api/web/task/${TASK}/followup`, { text: "이어서 해" });
		expect(followup.status).toBe(200);
		expect(await followup.json()).toEqual({ ok: true, text: "됐습니다" });
		expect((await app.post(`/api/web/task/${TASK}/pause`)).status).toBe(200);
		expect((await app.post(`/api/web/task/${TASK}/resume`, {})).status).toBe(200);
		expect((await app.post("/api/web/new", { title: "새 대화" })).status).toBe(200);
		const sock = join(app.home, "jabbu.sock");
		expect(app.calls).toEqual([
			{ path: sock, request: { op: "task_followup", id: TASK, text: "이어서 해" }, timeoutMs: 60_000 },
			{ path: sock, request: { op: "tasks_pause", id: TASK, source: "web" }, timeoutMs: 60_000 },
			{ path: sock, request: { op: "tasks_resume", id: TASK, source: "web" }, timeoutMs: 60_000 },
			{ path: sock, request: { op: "web_new", title: "새 대화" }, timeoutMs: 5_000 },
		]);
		// The bot targets the config builds keep the 5s default for every op that names none.
		const calls: Array<number | undefined> = [];
		const [main] = resolveWebBots(app.home, undefined, async (_path, _request, timeoutMs) => {
			calls.push(timeoutMs);
			return { ok: true };
		});
		await main?.callDaemon({ op: "web_send" });
		expect(calls).toEqual([5_000]);
	});

	test("AC-3: a refusal comes back 400 with the daemon's error and text; an unreachable daemon is 503", async () => {
		const refused = start({
			answer: () => ({ ok: false, error: "task_control_refused", text: `${TASK}는 review 상태라 멈추지 않았습니다` }),
		});
		const res = await refused.post(`/api/web/task/${TASK}/pause`);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "task_control_refused",
			text: `${TASK}는 review 상태라 멈추지 않았습니다`,
		});
		const down = start({
			answer: () => {
				throw new Error("ipc timeout");
			},
		});
		const timedOut = await down.post(`/api/web/task/${TASK}/followup`, { text: "이어서" });
		expect(timedOut.status).toBe(503);
		expect(await timedOut.json()).toEqual({ error: "daemon_unreachable" });
	});

	test("AC-3: unauthenticated 401, an Access user not on the owner list 403, missing CSRF 403 — the daemon is never called", async () => {
		const intruder = await accessJwt("intruder@example.com");
		const app = start({ keys: [intruder.jwk] });
		const path = `/api/web/task/${TASK}/pause`;
		expect((await app.post(path, undefined, {})).status).toBe(401);
		expect((await app.post(path, undefined, { authorization: "Bearer wrong-token" })).status).toBe(401);
		const forbidden = await app.post(path, undefined, { "cf-access-jwt-assertion": intruder.jwt });
		expect(forbidden.status).toBe(403);
		expect(await forbidden.json()).toEqual({ error: "forbidden_email" });
		const token = await app.csrf();
		const noCsrf = await app.post(path, undefined, {
			authorization: `Bearer ${TOKEN}`,
			"sec-fetch-site": "same-origin",
		});
		expect(noCsrf.status).toBe(403);
		expect(await noCsrf.json()).toEqual({ error: "csrf_mismatch" });
		const crossSite = await app.post(path, undefined, {
			authorization: `Bearer ${TOKEN}`,
			"sec-fetch-site": "cross-site",
			cookie: `jabbu_csrf=${token}`,
			"x-jabbu-csrf": token,
		});
		expect(crossSite.status).toBe(403);
		expect(app.calls).toEqual([]);
	});

	test("a POST body past 64KiB is 413 whether the length is declared or streamed — the daemon is never called", async () => {
		const app = start();
		const big = JSON.stringify({ text: "x".repeat(70 * 1024) });
		// Declared length: rejected before the body is read.
		const declared = await app.post(`/api/web/task/${TASK}/followup`, { text: "x".repeat(70 * 1024) });
		expect(declared.status).toBe(413);
		expect(await declared.json()).toEqual({ error: "body_too_large" });
		// Streamed (no Content-Length): the cap is enforced while reading, chunk by chunk.
		const streamed = await app.postStream(`/api/web/task/${TASK}/followup`, big);
		expect(streamed.status).toBe(413);
		expect(await streamed.json()).toEqual({ error: "body_too_large" });
		expect(app.calls).toEqual([]);
		// Just under the cap still goes through.
		const ok = await app.post(`/api/web/task/${TASK}/followup`, { text: "x".repeat(60 * 1024) });
		expect(ok.status).toBe(200);
		expect(app.calls).toHaveLength(1);
	});

	test("AC-3: a peer bot's TASK is refused invalid_bot 400 (body or query), the main bot named explicitly passes", async () => {
		const app = start({ peer: true });
		const viaBody = await app.post(`/api/web/task/${TASK}/followup`, { text: "이어서", bot: "seopak" });
		expect(viaBody.status).toBe(400);
		expect(await viaBody.json()).toEqual({ error: "invalid_bot" });
		expect((await app.post(`/api/web/task/${TASK}/pause?bot=seopak`)).status).toBe(400);
		expect(app.calls).toEqual([]);
		expect((await app.post(`/api/web/task/${TASK}/resume?bot=main`)).status).toBe(200);
		expect(app.calls.map((call) => call.path)).toEqual([join(app.home, "jabbu.sock")]);
	});

	test("AC-5: with web chat off every write endpoint is web_disabled 404; a malformed TASK id is not_found", async () => {
		const off = start({ web: false });
		for (const action of ["followup", "pause", "resume"]) {
			const res = await off.post(`/api/web/task/${TASK}/${action}`, undefined, {});
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({ error: "web_disabled" });
		}
		expect(off.calls).toEqual([]);
		const on = start();
		const bad = await on.post("/api/web/task/t-bad/followup", { text: "이어서" });
		expect(bad.status).toBe(404);
		expect(await bad.json()).toEqual({ error: "not_found" });
		expect(on.calls).toEqual([]);
	});
});
