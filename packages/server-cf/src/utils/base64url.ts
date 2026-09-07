/**
 * base64url (RFC 4648 §5, no padding) helpers over Web Crypto.
 *
 * One home for the base64url encoding so the two PKCE `S256` sites — the
 * challenge *builder* (`auth/google.ts`, generate side) and the challenge
 * *verifier* (`auth/connect.ts`, exchange side) — share a single crypto
 * implementation and can never disagree on the transform.
 */

/** base64url-encode raw bytes (no `=` padding, `+/` → `-_`). */
export function base64UrlEncode(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * base64url (no padding) of SHA-256(input). This is the PKCE `S256`
 * transform: `code_challenge = BASE64URL(SHA256(code_verifier))`.
 */
export async function base64UrlSha256(input: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(input),
    );
    return base64UrlEncode(new Uint8Array(digest));
}
