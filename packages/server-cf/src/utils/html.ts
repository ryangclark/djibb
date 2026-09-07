/**
 * HTML escaping for the worker-rendered auth pages (magic-link landing,
 * connect-ceremony disclosure). One home for the escaper so the security-
 * critical transform can't drift between surfaces: a future change (adding
 * a character, say) lands everywhere at once.
 *
 * Escapes the five characters that matter in both element text and
 * double-quoted attribute context, so a single function is safe for both.
 */
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
