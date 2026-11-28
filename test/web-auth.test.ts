import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac, type webcrypto } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboardServer } from "../src/dashboard/server";
import type { DashboardSnapshot } from "../src/dashboard/snapshot";
import { createWebAuthState, issueCsrfCookie, verifyWebCsrf } from "../src/web/auth";
import type { WebDashboardOptions } from "../src/web/routes";

type Jwk = webcrypto.JsonWebKey & { kid?: string; use?: string; alg?: string };

const TEAM_DOMAIN = "team.cloudflareaccess.com";
const AUD = "cf-access-aud-123";
const OWNER_EMAIL = "owner@example.com";
const CSRF_SECRET = Buffer.from("0123456789abcdef0123456789abcdef");

let home = "";
const servers: Array<() => void> = [];

function toBase64Url(input: Buffer | Uint8Array | string): string {
	return Buffer.from(input).toString("base64url");
}

async function generateSigningKey(
	alg: "RS256" | "ES256",
	kid: string,
): Promise<{ privateKey: webcrypto.CryptoKey; publicJwk: Jwk }> {
	const pair =
		alg === "RS256"
			? await crypto.subtle.generateKey(
					{
						name: "RSASSA-PKCS1-v1_5",
						modulusLength: 2048,
						publicExponent: new Uint8Array([1, 0, 1]),
						hash: "SHA-256",
					},
					true,
					["sign", "verify"],
				)
			: await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk;
	return {
		privateKey: pair.privateKey,
		publicJwk: { ...jwk, kid, use: "sig", alg },
	};
}

async function signJwt(
	privateKey: webcrypto.CryptoKey,
	alg: "RS256" | "ES256" | "none",
	kid: string,
	payload: Record<string, unknown>,
): Promise<string> {
	const header = toBase64Url(JSON.stringify({ alg, typ: "JWT", kid }));
	const body = toBase64Url(JSON.stringify(payload));
	const unsigned = `${header}.${body}`;
	if (alg === "none") return `${unsigned}.`;
	const sigAlg = alg === "RS256" ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash: "SHA-256" };
	const sig = await crypto.subtle.sign(sigAlg, privateKey, new TextEncoder().encode(unsigned));
	return `${unsigned}.${toBase64Url(new Uint8Array(sig))}`;
}

function mintLocalToken(path: string, value = "local-secret-token-xyz"): string {
	writeFileSync(path, `${value}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return value;
}

function startAuthServer(overrides: {
	keys: Jwk[];
	nowMs?: () => number;
	onJwksFetch?: (url: string) => void;
	daemonCalls?: unknown[];
}): { baseUrl: string; localTokenPath: string } {
	home = mkdtempSync(join(tmpdir(), "jabbu-web-auth-"));
	mkdirSync(join(home, "state"), { mode: 0o700 });
	const localTokenPath = join(home, "state", "web-local.token");
	mintLocalToken(localTokenPath);

	const web: WebDashboardOptions = {
		homeDir: home,
		auth: {
			ownerEmails: [OWNER_EMAIL],
			accessTeamDomain: TEAM_DOMAIN,
			accessAud: AUD,
			localTokenPath,
			now: overrides.nowMs,
			csrfSecret: CSRF_SECRET,
			fetchJwks: async (url) => {
				overrides.onJwksFetch?.(url);
				return { keys: overrides.keys };
			},
		},
		callDaemon: async (req) => {
			overrides.daemonCalls?.push(req);
			return { ok: true, forwarded: req };
		},
	};
	const server = startDashboardServer({
		port: 0,
		hostname: "127.0.0.1",
		web,
		snapshot: async (): Promise<DashboardSnapshot> => ({
			generatedAt: "2026-11-25T12:00:00+09:00",
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
		}),
	});
	servers.push(() => server.stop(true));
	return { baseUrl: `http://127.0.0.1:${server.port}`, localTokenPath };
}

beforeEach(() => {
	home = "";
});

afterEach(() => {
	while (servers.length > 0) servers.pop()?.();
	if (home !== "") rmSync(home, { recursive: true, force: true });
});

describe("AC-2: web authentication, loopback enforcement, local token, and CSRF", () => {
	test("unauthenticated loopback requests to /api/web/* and ?view=chat always return 401", async () => {
		const rsa = await generateSigningKey("RS256", "kid-rsa-1");
		const { baseUrl } = startAuthServer({ keys: [rsa.publicJwk] });

		for (const [method, path] of [
			["GET", "/api/web/conversations"],
			["GET", "/api/web/messages?c=w_abcd1234"],
			["GET", "/api/web/stream"],
			["GET", "/?view=chat"],
			["POST", "/api/web/new"],
			["POST", "/api/web/send"],
		] as const) {
			const res = await fetch(`${baseUrl}${path}`, { method });
			expect(res.status).toBe(401);
		}
		// Existing dashboard view remains readable without Access JWT in server layer (delegated to edge tunnel).
		expect((await fetch(`${baseUrl}/`)).status).toBe(200);
	});

	test("Access JWT validates RS256/ES256, rejects invalid sig/alg/exp/aud/iss/email, and handles kid rotation", async () => {
		let nowMs = 1_700_000_000_000;
		const nowSec = () => Math.floor(nowMs / 1000);
		const rsa1 = await generateSigningKey("RS256", "kid-rsa-1");
		const rsaOther = await generateSigningKey("RS256", "kid-rsa-1");
		const ec1 = await generateSigningKey("ES256", "kid-ec-1");
		const keys: Jwk[] = [rsa1.publicJwk];
		const jwksUrls: string[] = [];
		const { baseUrl } = startAuthServer({
			keys,
			nowMs: () => nowMs,
			onJwksFetch: (url) => jwksUrls.push(url),
		});

		const baseClaims = () => ({
			aud: AUD,
			iss: `https://${TEAM_DOMAIN}`,
			exp: nowSec() + 300,
			iat: nowSec() - 10,
			nbf: nowSec() - 5,
			email: "Owner@Example.com",
		});

		// Valid RS256 JWT + CSRF cookie/header issuance
		const okJwt = await signJwt(rsa1.privateKey, "RS256", "kid-rsa-1", { ...baseClaims(), aud: ["other", AUD] });
		const okRes = await fetch(`${baseUrl}/api/web/conversations`, {
			headers: { "cf-access-jwt-assertion": okJwt },
		});
		expect(okRes.status).toBe(200);
		expect(jwksUrls).toEqual([`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`]);
		const setCookie = okRes.headers.get("set-cookie") ?? "";
		const csrfHeader = okRes.headers.get("x-jabbu-csrf") ?? "";
		expect(setCookie).toContain(`jabbu_csrf=${csrfHeader}`);
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("Secure");
		expect(setCookie).toContain("SameSite=Strict");
		const okBody = (await okRes.json()) as { conversations: unknown[]; csrfToken: string };
		expect(okBody.csrfToken).toBe(csrfHeader);

		// ?view=chat works with Access JWT and also sets CSRF cookie
		const pageRes = await fetch(`${baseUrl}/?view=chat`, {
			headers: { "cf-access-jwt-assertion": okJwt },
		});
		expect(pageRes.status).toBe(200);
		expect(pageRes.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Strict");

		// Rejection matrix
		const cases: Array<[string, Promise<string>, number, string]> = [
			["bad_sig", signJwt(rsaOther.privateKey, "RS256", "kid-rsa-1", baseClaims()), 401, "invalid_jwt_signature"],
			["alg_none", signJwt(rsa1.privateKey, "none", "kid-rsa-1", baseClaims()), 401, "invalid_jwt_alg"],
			["unknown_kid", signJwt(rsa1.privateKey, "RS256", "kid-missing", baseClaims()), 401, "unknown_jwt_kid"],
			[
				"expired",
				signJwt(rsa1.privateKey, "RS256", "kid-rsa-1", { ...baseClaims(), exp: nowSec() - 1 }),
				401,
				"jwt_expired",
			],
			[
				"missing_iat",
				signJwt(rsa1.privateKey, "RS256", "kid-rsa-1", { ...baseClaims(), iat: undefined }),
				401,
				"jwt_invalid_iat",
			],
			[
				"future_iat",
				signJwt(rsa1.privateKey, "RS256", "kid-rsa-1", { ...baseClaims(), iat: nowSec() + 3600 }),
				401,
				"jwt_not_yet_valid",
			],
			[
				"lifetime_too_long",
				signJwt(rsa1.privateKey, "RS256", "kid-rsa-1", {
					...baseClaims(),
					exp: nowSec() + 24 * 60 * 60 + 600,
				}),
				401,
				"jwt_lifetime_too_long",
			],
			[
				"wrong_aud",
				signJwt(rsa1.privateKey, "RS256", "kid-rsa-1", { ...baseClaims(), aud: "wrong-aud" }),
				403,
				"invalid_aud",
			],
			[
				"wrong_iss",
				signJwt(rsa1.privateKey, "RS256", "kid-rsa-1", { ...baseClaims(), iss: "https://evil.com" }),
				403,
				"invalid_iss",
			],
			[
				"missing_iss",
				signJwt(rsa1.privateKey, "RS256", "kid-rsa-1", { ...baseClaims(), iss: undefined }),
				403,
				"invalid_iss",
			],
			[
				"non_string_iss",
				signJwt(rsa1.privateKey, "RS256", "kid-rsa-1", { ...baseClaims(), iss: 123 }),
				403,
				"invalid_iss",
			],
			[
				"bad_email",
				signJwt(rsa1.privateKey, "RS256", "kid-rsa-1", { ...baseClaims(), email: "attacker@example.com" }),
				403,
				"forbidden_email",
			],
		];
		for (const [_name, tokenPromise, expectedStatus, expectedError] of cases) {
			const res = await fetch(`${baseUrl}/api/web/conversations`, {
				headers: { "cf-access-jwt-assertion": await tokenPromise },
			});
			expect(res.status).toBe(expectedStatus);
			expect(await res.json()).toEqual({ error: expectedError });
		}

		// A token living exactly 24 h is still accepted.
		const edgeJwt = await signJwt(rsa1.privateKey, "RS256", "kid-rsa-1", {
			...baseClaims(),
			exp: nowSec() - 10 + 24 * 60 * 60,
		});
		const edgeRes = await fetch(`${baseUrl}/api/web/conversations`, {
			headers: { "cf-access-jwt-assertion": edgeJwt },
		});
		expect(edgeRes.status).toBe(200);

		// Key rotation after cooldown passes using ES256
		nowMs += 15_000;
		keys.push(ec1.publicJwk);
		const esJwt = await signJwt(ec1.privateKey, "ES256", "kid-ec-1", baseClaims());
		const rotatedRes = await fetch(`${baseUrl}/api/web/conversations`, {
			headers: { "cf-access-jwt-assertion": esJwt },
		});
		expect(rotatedRes.status).toBe(200);
	});

	test("0600 local bearer token authenticates GET and ?view=chat, rejecting wrong token, 0644, or symlink", async () => {
		const rsa = await generateSigningKey("RS256", "kid-rsa-1");
		const { baseUrl, localTokenPath } = startAuthServer({ keys: [rsa.publicJwk] });
		const token = "local-secret-token-xyz";

		expect(
			(await fetch(`${baseUrl}/api/web/conversations`, { headers: { authorization: `Bearer ${token}` } })).status,
		).toBe(200);
		expect((await fetch(`${baseUrl}/?view=chat`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

		expect(
			(await fetch(`${baseUrl}/api/web/conversations`, { headers: { authorization: "Bearer wrong-token" } })).status,
		).toBe(401);

		chmodSync(localTokenPath, 0o644);
		expect(
			(await fetch(`${baseUrl}/api/web/conversations`, { headers: { authorization: `Bearer ${token}` } })).status,
		).toBe(401);

		rmSync(localTokenPath);
		const target = join(home, "state", "real-token");
		mintLocalToken(target, token);
		symlinkSync(target, localTokenPath);
		expect(
			(await fetch(`${baseUrl}/api/web/conversations`, { headers: { authorization: `Bearer ${token}` } })).status,
		).toBe(401);
	});

	test("a stale Bearer token falls through to the Access JWT instead of short-circuiting with 401", async () => {
		const rsa = await generateSigningKey("RS256", "kid-rsa-1");
		const rsaOther = await generateSigningKey("RS256", "kid-rsa-1");
		const { baseUrl } = startAuthServer({ keys: [rsa.publicJwk] });
		const claims = {
			aud: AUD,
			iss: `https://${TEAM_DOMAIN}`,
			exp: Math.floor(Date.now() / 1000) + 300,
			iat: Math.floor(Date.now() / 1000) - 10,
			email: OWNER_EMAIL,
		};
		const validJwt = await signJwt(rsa.privateKey, "RS256", "kid-rsa-1", claims);
		const badJwt = await signJwt(rsaOther.privateKey, "RS256", "kid-rsa-1", claims);

		// Stale local token + valid JWT: the JWT authenticates.
		expect(
			(
				await fetch(`${baseUrl}/api/web/conversations`, {
					headers: { authorization: "Bearer stale-token", "cf-access-jwt-assertion": validJwt },
				})
			).status,
		).toBe(200);

		// Stale local token + invalid JWT: the JWT's own error is reported, not invalid_token.
		const badRes = await fetch(`${baseUrl}/api/web/conversations`, {
			headers: { authorization: "Bearer stale-token", "cf-access-jwt-assertion": badJwt },
		});
		expect(badRes.status).toBe(401);
		expect(await badRes.json()).toEqual({ error: "invalid_jwt_signature" });

		// Stale local token alone: still 401 invalid_token, not auth_required.
		const aloneRes = await fetch(`${baseUrl}/api/web/conversations`, {
			headers: { authorization: "Bearer stale-token" },
		});
		expect(aloneRes.status).toBe(401);
		expect(await aloneRes.json()).toEqual({ error: "invalid_token" });
	});

	test("POST requires Sec-Fetch-Site: same-origin and signed CSRF cookie matching X-Jabbu-Csrf", async () => {
		const rsa = await generateSigningKey("RS256", "kid-rsa-1");
		const daemonCalls: unknown[] = [];
		const { baseUrl } = startAuthServer({ keys: [rsa.publicJwk], daemonCalls });
		const jwt = await signJwt(rsa.privateKey, "RS256", "kid-rsa-1", {
			aud: AUD,
			iss: `https://${TEAM_DOMAIN}`,
			exp: Math.floor(Date.now() / 1000) + 300,
			iat: Math.floor(Date.now() / 1000) - 10,
			email: OWNER_EMAIL,
		});
		const localHeaders = { authorization: "Bearer local-secret-token-xyz" };

		const initRes = await fetch(`${baseUrl}/api/web/conversations`, { headers: localHeaders });
		expect(initRes.status).toBe(200);
		const csrfToken = initRes.headers.get("x-jabbu-csrf") ?? "";
		expect(csrfToken).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{64}$/);
		const tamperedToken = `${csrfToken.slice(0, 32)}.${createHmac("sha256", Buffer.from("wrong-key")).update(csrfToken.slice(0, 32)).digest("hex")}`;

		// Missing / cross-site Sec-Fetch-Site -> 403
		for (const site of [undefined, "cross-site", "same-site"] as const) {
			const res = await fetch(`${baseUrl}/api/web/new`, {
				method: "POST",
				headers: {
					...localHeaders,
					...(site === undefined ? {} : { "sec-fetch-site": site }),
					cookie: `jabbu_csrf=${csrfToken}`,
					"x-jabbu-csrf": csrfToken,
					"content-type": "application/json",
				},
				body: JSON.stringify({ title: "blocked" }),
			});
			expect(res.status).toBe(403);
		}

		// CSRF mismatch / tampered cookie -> 403 even with same-origin
		for (const [cookie, header] of [
			["", csrfToken],
			[`jabbu_csrf=${csrfToken}`, ""],
			[`jabbu_csrf=${csrfToken}`, "other"],
			[`jabbu_csrf=${tamperedToken}`, tamperedToken],
		] as const) {
			const res = await fetch(`${baseUrl}/api/web/new`, {
				method: "POST",
				headers: {
					"cf-access-jwt-assertion": jwt,
					"sec-fetch-site": "same-origin",
					...(cookie ? { cookie } : {}),
					...(header ? { "x-jabbu-csrf": header } : {}),
					"content-type": "application/json",
				},
				body: JSON.stringify({ title: "csrf fail" }),
			});
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: "csrf_mismatch" });
		}

		// Valid POST /api/web/upload succeeds after auth+CSRF pass
		const uploadRes = await fetch(`${baseUrl}/api/web/upload`, {
			method: "POST",
			headers: {
				...localHeaders,
				"sec-fetch-site": "same-origin",
				cookie: `jabbu_csrf=${csrfToken}`,
				"x-jabbu-csrf": csrfToken,
				"content-type": "text/plain",
				"x-filename": "csrf-ok.txt",
			},
			body: "ok-payload",
		});
		expect(uploadRes.status).toBe(200);
		expect(await uploadRes.json()).toMatchObject({ ok: true, path: expect.stringContaining("/media/inbound/web/") });

		// Valid POST /api/web/new forwards to callDaemon for both local token and Access JWT
		const newRes = await fetch(`${baseUrl}/api/web/new`, {
			method: "POST",
			headers: {
				"cf-access-jwt-assertion": jwt,
				"sec-fetch-site": "same-origin",
				cookie: `jabbu_csrf=${csrfToken}`,
				"x-jabbu-csrf": csrfToken,
				"content-type": "application/json",
			},
			body: JSON.stringify({ title: "합법 새 대화" }),
		});
		expect(newRes.status).toBe(200);
		expect(daemonCalls).toEqual([{ op: "web_new", title: "합법 새 대화" }]);
	});

	test("CSRF tokens carry an issued-at and expire after 24 h", async () => {
		let nowMs = 1_700_000_000_000;
		const state = createWebAuthState({
			ownerEmails: [OWNER_EMAIL],
			accessTeamDomain: TEAM_DOMAIN,
			accessAud: AUD,
			localTokenPath: "unused",
			now: () => nowMs,
			csrfSecret: CSRF_SECRET,
		});
		const { token } = issueCsrfCookie(new Request("http://x/"), state);
		expect(token).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{64}$/);
		const post = () =>
			verifyWebCsrf(
				new Request("http://x/api/web/new", {
					method: "POST",
					headers: {
						"sec-fetch-site": "same-origin",
						cookie: `jabbu_csrf=${token}`,
						"x-jabbu-csrf": token,
					},
				}),
				state,
			);
		expect(post()).toEqual({ ok: true });
		// Reused while still fresh, and still valid at exactly 24 h.
		const again = new Request("http://x/", { headers: { cookie: `jabbu_csrf=${token}` } });
		expect(issueCsrfCookie(again, state).token).toBe(token);
		nowMs += 24 * 60 * 60 * 1000;
		expect(post()).toEqual({ ok: true });
		// One second past the window it no longer verifies, and issue mints a fresh token instead.
		nowMs += 1000;
		expect(post()).toEqual({ ok: false, error: "csrf_mismatch" });
		expect(issueCsrfCookie(again, state).token).not.toBe(token);
	});
});
