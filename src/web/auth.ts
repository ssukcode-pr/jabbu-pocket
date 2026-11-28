import { createHmac, randomBytes, timingSafeEqual, type webcrypto } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

export type JwkKey = webcrypto.JsonWebKey & { kid?: string; use?: string; alg?: string };

export interface WebAuthConfig {
	ownerEmails: readonly string[];
	accessTeamDomain: string;
	accessAud: string;
	localTokenPath: string;
	now?: (() => number) | undefined;
	fetchJwks?: ((url: string) => Promise<{ keys: webcrypto.JsonWebKey[] }>) | undefined;
	csrfSecret?: Buffer | undefined;
}

export interface WebAuthState {
	config: WebAuthConfig;
	csrfSecret: Buffer;
	jwksCache?: { keys: webcrypto.JsonWebKey[]; fetchedAt: number };
	lastForcedFetchAt: number;
}

export type AuthOutcome =
	| { ok: true; kind: "access"; email: string }
	| { ok: true; kind: "local" }
	| { ok: false; status: 401 | 403; error: string };

const JWKS_TTL_MS = 10 * 60_000;
const JWKS_FORCE_COOLDOWN_MS = 10_000;
const CLOCK_SKEW_SEC = 60;
/** An Access JWT must not live longer than this: a stolen token stays usable until its `exp` otherwise. */
const MAX_JWT_LIFETIME_SEC = 24 * 60 * 60;
const CSRF_COOKIE_NAME = "jabbu_csrf";
/** A CSRF token stays usable this long after it is minted; older tokens are rejected and replaced. */
const CSRF_MAX_AGE_SEC = 24 * 60 * 60;
const CSRF_TOKEN_PATTERN = /^([0-9a-f]{32})\.([0-9a-f]{64})$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export function createWebAuthState(config: WebAuthConfig): WebAuthState {
	return {
		config,
		csrfSecret: config.csrfSecret ?? randomBytes(32),
		lastForcedFetchAt: -Infinity,
	};
}

function decodeBase64Url(segment: string): Buffer | undefined {
	if (!BASE64URL_PATTERN.test(segment)) return undefined;
	try {
		return Buffer.from(segment, "base64url");
	} catch {
		return undefined;
	}
}

function constantTimeEquals(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	return left.length === right.length && timingSafeEqual(left, right);
}

function verifyLocalToken(tokenPath: string, provided: string): boolean {
	try {
		const stat = lstatSync(tokenPath);
		if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) return false;
		const expected = readFileSync(tokenPath, "utf8").trim();
		if (expected === "" || /[\r\n]/.test(expected)) return false;
		return constantTimeEquals(provided.trim(), expected);
	} catch {
		return false;
	}
}

async function defaultFetchJwks(url: string): Promise<{ keys: webcrypto.JsonWebKey[] }> {
	const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
	if (!response.ok) throw new Error(`jwks fetch failed: ${response.status}`);
	const data = (await response.json()) as { keys?: unknown };
	if (!Array.isArray(data.keys)) throw new Error("jwks missing keys");
	return { keys: data.keys as webcrypto.JsonWebKey[] };
}

type NamedJwk = JwkKey;

async function loadJwks(state: WebAuthState, forceRefresh: boolean): Promise<NamedJwk[]> {
	const now = (state.config.now ?? Date.now)();
	const cache = state.jwksCache;
	if (!forceRefresh && cache !== undefined && now - cache.fetchedAt < JWKS_TTL_MS) {
		return cache.keys as NamedJwk[];
	}
	if (forceRefresh && now - state.lastForcedFetchAt < JWKS_FORCE_COOLDOWN_MS && cache !== undefined) {
		return cache.keys as NamedJwk[];
	}
	if (forceRefresh) state.lastForcedFetchAt = now;
	const url = `https://${state.config.accessTeamDomain}/cdn-cgi/access/certs`;
	const fetchImpl = state.config.fetchJwks ?? defaultFetchJwks;
	const { keys } = await fetchImpl(url);
	state.jwksCache = { keys, fetchedAt: now };
	return keys as NamedJwk[];
}

async function resolveSigningKey(
	state: WebAuthState,
	kid: string,
	alg: "RS256" | "ES256",
): Promise<NamedJwk | undefined> {
	const expectedKty = alg === "RS256" ? "RSA" : "EC";
	const matches = (keys: NamedJwk[]) =>
		keys.find((key) => key.kid === kid && key.kty === expectedKty && (key.use === undefined || key.use === "sig"));
	let keys = await loadJwks(state, false);
	let hit = matches(keys);
	if (hit === undefined) {
		keys = await loadJwks(state, true);
		hit = matches(keys);
	}
	return hit;
}

async function verifyJwtSignature(
	headerB64: string,
	payloadB64: string,
	sigBytes: Buffer,
	alg: "RS256" | "ES256",
	jwk: NamedJwk,
): Promise<boolean> {
	try {
		const importAlg =
			alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } : { name: "ECDSA", namedCurve: "P-256" };
		const verifyAlg = alg === "RS256" ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash: "SHA-256" };
		const key = await crypto.subtle.importKey("jwk", jwk, importAlg, false, ["verify"]);
		const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
		return await crypto.subtle.verify(verifyAlg, key, new Uint8Array(sigBytes), data);
	} catch {
		return false;
	}
}

async function verifyAccessJwt(jwt: string, state: WebAuthState): Promise<AuthOutcome> {
	const parts = jwt.split(".");
	if (parts.length !== 3) return { ok: false, status: 401, error: "invalid_jwt" };
	const [headerB64 = "", payloadB64 = "", sigB64 = ""] = parts;
	const headerBuf = decodeBase64Url(headerB64);
	const payloadBuf = decodeBase64Url(payloadB64);
	const sigBuf = decodeBase64Url(sigB64);
	if (headerBuf === undefined || payloadBuf === undefined || sigBuf === undefined) {
		return { ok: false, status: 401, error: "invalid_jwt" };
	}

	let header: { alg?: unknown; kid?: unknown };
	let payload: { exp?: unknown; iat?: unknown; nbf?: unknown; aud?: unknown; iss?: unknown; email?: unknown };
	try {
		header = JSON.parse(headerBuf.toString("utf8")) as { alg?: unknown; kid?: unknown };
		payload = JSON.parse(payloadBuf.toString("utf8")) as typeof payload;
	} catch {
		return { ok: false, status: 401, error: "invalid_jwt" };
	}
	if (header.alg !== "RS256" && header.alg !== "ES256") {
		return { ok: false, status: 401, error: "invalid_jwt_alg" };
	}
	if (typeof header.kid !== "string" || header.kid === "") {
		return { ok: false, status: 401, error: "invalid_jwt_kid" };
	}

	let jwk: NamedJwk | undefined;
	try {
		jwk = await resolveSigningKey(state, header.kid, header.alg);
	} catch {
		return { ok: false, status: 401, error: "jwks_unavailable" };
	}
	if (jwk === undefined) return { ok: false, status: 401, error: "unknown_jwt_kid" };
	if (!(await verifyJwtSignature(headerB64, payloadB64, sigBuf, header.alg, jwk))) {
		return { ok: false, status: 401, error: "invalid_jwt_signature" };
	}

	const nowSec = Math.floor((state.config.now ?? Date.now)() / 1000);
	if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= nowSec) {
		return { ok: false, status: 401, error: "jwt_expired" };
	}
	if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
		return { ok: false, status: 401, error: "jwt_invalid_iat" };
	}
	if (payload.iat > nowSec + CLOCK_SKEW_SEC) {
		return { ok: false, status: 401, error: "jwt_not_yet_valid" };
	}
	if (payload.exp - payload.iat > MAX_JWT_LIFETIME_SEC) {
		return { ok: false, status: 401, error: "jwt_lifetime_too_long" };
	}
	if (
		payload.nbf !== undefined &&
		(typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf) || payload.nbf > nowSec + CLOCK_SKEW_SEC)
	) {
		return { ok: false, status: 401, error: "jwt_not_yet_valid" };
	}

	const audOk =
		typeof payload.aud === "string"
			? payload.aud === state.config.accessAud
			: Array.isArray(payload.aud) && payload.aud.includes(state.config.accessAud);
	if (!audOk) return { ok: false, status: 403, error: "invalid_aud" };

	const expectedIss = `https://${state.config.accessTeamDomain}`;
	if (typeof payload.iss !== "string" || (payload.iss !== expectedIss && payload.iss !== `${expectedIss}/`)) {
		return { ok: false, status: 403, error: "invalid_iss" };
	}

	if (typeof payload.email !== "string") return { ok: false, status: 403, error: "forbidden_email" };
	const email = payload.email.trim().toLowerCase();
	const allowed = state.config.ownerEmails.some((owner) => owner.toLowerCase() === email);
	if (!allowed) return { ok: false, status: 403, error: "forbidden_email" };
	return { ok: true, kind: "access", email };
}

/** Authenticates a web chat request via local 0600 bearer token or Cloudflare Access JWT (no loopback bypass). */
export async function authenticateWebRequest(request: Request, state: WebAuthState): Promise<AuthOutcome> {
	const auth = request.headers.get("authorization");
	let bearerInvalid = false;
	if (auth !== null) {
		const bearer = /^Bearer\s+(\S+)$/i.exec(auth.trim());
		if (bearer?.[1] !== undefined) {
			if (verifyLocalToken(state.config.localTokenPath, bearer[1])) {
				return { ok: true, kind: "local" };
			}
			// A stale local token must not mask a valid Access JWT: fall through to the JWT check below.
			bearerInvalid = true;
		}
	}
	const jwt = request.headers.get("cf-access-jwt-assertion")?.trim();
	if (!jwt) return { ok: false, status: 401, error: bearerInvalid ? "invalid_token" : "auth_required" };
	return verifyAccessJwt(jwt, state);
}

function readCookie(request: Request, name: string): string | undefined {
	const raw = request.headers.get("cookie");
	if (raw === null) return undefined;
	for (const part of raw.split(";")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

function signCsrfNonce(nonce: string, secret: Buffer): string {
	return `${nonce}.${createHmac("sha256", secret).update(nonce).digest("hex")}`;
}

/**
 * Mints a CSRF nonce whose first 8 hex digits are the issued-at second, so the token carries its own expiry
 * while keeping the established 32-hex-char nonce shape.
 */
function mintCsrfNonce(nowMs: number): string {
	return `${Math.floor(nowMs / 1000)
		.toString(16)
		.padStart(8, "0")}${randomBytes(12).toString("hex")}`;
}

function validCsrfToken(token: string | undefined, secret: Buffer, nowMs: number): boolean {
	if (token === undefined) return false;
	const match = CSRF_TOKEN_PATTERN.exec(token);
	if (match?.[1] === undefined) return false;
	if (!constantTimeEquals(token, signCsrfNonce(match[1], secret))) return false;
	const issued = Number.parseInt(match[1].slice(0, 8), 16);
	if (!Number.isFinite(issued)) return false;
	const nowSec = Math.floor(nowMs / 1000);
	return issued <= nowSec + CLOCK_SKEW_SEC && nowSec - issued <= CSRF_MAX_AGE_SEC;
}

/** Issues (or reuses) an HMAC-signed CSRF token and formats its `HttpOnly; Secure; SameSite=Strict` cookie. */
export function issueCsrfCookie(request: Request, state: WebAuthState): { token: string; cookie: string } {
	const existing = readCookie(request, CSRF_COOKIE_NAME);
	const nowMs = (state.config.now ?? Date.now)();
	const token = validCsrfToken(existing, state.csrfSecret, nowMs)
		? (existing as string)
		: signCsrfNonce(mintCsrfNonce(nowMs), state.csrfSecret);
	return {
		token,
		cookie: `${CSRF_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`,
	};
}

/** Requires `Sec-Fetch-Site: same-origin` and matching signed CSRF cookie + `X-Jabbu-Csrf` header on POSTs. */
export function verifyWebCsrf(request: Request, state: WebAuthState): { ok: true } | { ok: false; error: string } {
	if (request.headers.get("sec-fetch-site") !== "same-origin") {
		return { ok: false, error: "cross_site_forbidden" };
	}
	const cookieToken = readCookie(request, CSRF_COOKIE_NAME);
	const headerToken = request.headers.get("x-jabbu-csrf")?.trim();
	const nowMs = (state.config.now ?? Date.now)();
	if (!validCsrfToken(cookieToken, state.csrfSecret, nowMs) || headerToken === undefined) {
		return { ok: false, error: "csrf_mismatch" };
	}
	return constantTimeEquals(cookieToken as string, headerToken) ? { ok: true } : { ok: false, error: "csrf_mismatch" };
}
