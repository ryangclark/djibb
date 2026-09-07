/**
 * Request-origin verification for the CORS/CSRF middleware.
 *
 * A faithful, dependency-free reimplementation of the one function we used
 * from `lucia` (`verifyRequestOrigin`), which is deprecated upstream (the
 * library became a learn-to-build-your-own-auth resource, not a maintained
 * package — GH #52). Same semantics: compare by **host** (hostname:port), so
 * an allowlist entry may be a full origin (`https://djibb.com`) or a bare
 * host (`djibb.com`), and only the host has to match — not the scheme.
 *
 * Distinct from `auth/connect.ts`'s `originIsAllowlisted`, which is an
 * *exact-origin* string match used to pick a safe redirect target. This one
 * is the laxer host-match the CSRF check has always used; keeping the two
 * separate preserves each call site's existing behavior.
 */

function safeUrlHost(value: string): string | null {
    try {
        return new URL(value).host;
    } catch {
        return null;
    }
}

/**
 * True iff `origin` (a request's `Origin` header value) has the same host as
 * one of `allowedDomains`. Returns false for a missing origin, an empty
 * allowlist, or an unparseable origin. Allowlist entries without a scheme
 * are treated as hosts (parsed under a synthetic `https://` prefix).
 */
export function verifyRequestOrigin(
    origin: string | null | undefined,
    allowedDomains: readonly string[],
): boolean {
    if (!origin || allowedDomains.length === 0) return false;

    const originHost = safeUrlHost(origin);
    if (!originHost) return false;

    for (const domain of allowedDomains) {
        if (!domain) continue;
        const domainHost =
            domain.startsWith('http://') || domain.startsWith('https://')
                ? safeUrlHost(domain)
                : safeUrlHost(`https://${domain}`);
        if (domainHost && originHost === domainHost) return true;
    }
    return false;
}
