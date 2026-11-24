// Request guards of the dashboard server against a browser page reaching it from another origin.
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/** The host name of a `Host` header value (no port, no IPv6 brackets, lower case); undefined when absent or malformed. */
export function hostNameOf(header: string | null): string | undefined {
	if (header === null) return undefined;
	const match = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+))(?::\d{1,5})?$/i.exec(header.trim());
	const name = match?.[1] ?? match?.[2];
	return name === undefined ? undefined : name.toLowerCase().replace(/\.$/, "");
}

/** A config `allowedHosts` value: an array of bare host names (no scheme, port, path or spaces). */
export function validAllowedHosts(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.every((host) => typeof host === "string" && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host))
	);
}

/** The host names a request may carry: loopback plus the configured extras (a tunnel's public name). */
export function hostAllowlist(extra: readonly string[] = []): ReadonlySet<string> {
	return new Set([...LOOPBACK_HOSTS, ...extra.map((host) => host.toLowerCase())]);
}

/**
 * The refusal for a request, or undefined to serve it. 421 for a `Host` outside the allowlist: DNS rebinding makes a page on
 * another name reach this address, but the browser still sends that name as `Host`. 403 for a cross-site request that is not
 * a navigation (a script's fetch); a link click or address-bar navigation from another site still opens the page.
 */
export function guardRequest(
	request: Request,
	allowed: ReadonlySet<string>,
	headers: Record<string, string>,
): Response | undefined {
	const refuse = (status: number, text: string) =>
		new Response(`${text}\n`, { status, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
	const host = hostNameOf(request.headers.get("host"));
	if (host === undefined || !allowed.has(host)) return refuse(421, "misdirected request");
	if (request.headers.get("sec-fetch-site") === "cross-site" && request.headers.get("sec-fetch-mode") !== "navigate") {
		return refuse(403, "forbidden");
	}
	return undefined;
}
