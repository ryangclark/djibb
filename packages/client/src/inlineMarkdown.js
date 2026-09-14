/**
 * Render a constrained inline-markdown subset to a sanitized HTML string.
 *
 * Display-only (GH #4). Item/group names and short descriptions on a
 * List/Template are stored as opaque strings and round-trip byte-stable
 * through the ADR 0012 markdown encoder. This renders a small *inline* subset
 * for presentation only; it never touches what is stored, and callers feed it
 * the same string on every render.
 *
 * Supported subset — these are names and one-line descriptions, not documents:
 *   - `**bold**`            -> <strong>
 *   - `*italic*` / `_italic_` -> <em>
 *   - `` `code` ``          -> <code>
 *   - `[text](url)`         -> <a> (http/https/mailto only)
 *
 * Deliberately NOT supported: block markdown (headings, lists, blockquotes,
 * images, tables) and raw HTML. Entity-to-entity linking stays on the
 * structured `references_entity_id` path; inline links are for external URLs.
 *
 * XSS safety by construction (these fields are world-editable on `ownerless`
 * entities, so the input is hostile): the whole string is HTML-escaped
 * *first*, so any markup in the source is inert text before a single tag is
 * emitted. The only tags this function ever produces are a fixed whitelist
 * (<strong>, <em>, <code>, <a>) that it writes itself, and <a href> is
 * restricted to safe schemes. There is no path by which attacker-controlled
 * text becomes a tag or an attribute value. The result is intended for
 * Svelte's `{@html ...}`.
 *
 * @param {string | null | undefined} input
 * @returns {string} sanitized HTML
 */
export function renderInlineMarkdown(input) {
	if (input == null) return '';
	// Strip the sentinel up front: the code-span pass below uses
	// SENTINEL-delimited placeholders, so a sentinel char in the source could
	// otherwise forge one.
	const escaped = escapeHtml(String(input).split(SENTINEL).join(''));

	// 1. Extract `code` spans first, replacing each with a placeholder, so
	//    their contents are never re-interpreted as emphasis or a link. The
	//    captured content is already HTML-escaped.
	/** @type {string[]} */
	const codes = [];
	let out = escaped.replace(/`([^`]+)`/g, (_m, code) => {
		codes.push(code);
		return `${SENTINEL}${codes.length - 1}${SENTINEL}`;
	});

	// 2. Links: [text](url). Both halves are already escaped, so `"` is
	//    `&quot;` (can't break out of the attribute) and `&` is `&amp;` (a
	//    valid href entity). The scheme test runs on the escaped url -- `:` and
	//    `/` aren't escaped, so a real https:// url still matches; anything
	//    else (javascript:, data:, relative, protocol-relative //) falls back
	//    to inert escaped text.
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) =>
		SAFE_LINK_SCHEME.test(url)
			? `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>`
			: m
	);

	// 3. Emphasis. Bold before italic so `**x**` isn't consumed by the
	//    single-delimiter rules. Delimited runs may not contain the delimiter.
	out = out
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\*([^*]+)\*/g, '<em>$1</em>')
		.replace(/_([^_]+)_/g, '<em>$1</em>');

	// 4. Restore code spans as <code>.
	out = out.replace(RESTORE_CODE, (_m, i) => `<code>${codes[Number(i)] ?? ''}</code>`);

	return out;
}

/**
 * NUL is used to delimit code-span placeholders between passes. It cannot
 * appear in rendered output (it is stripped from the input above) and never
 * occurs in real text. Built at runtime so no control byte lives in source.
 */
const SENTINEL = String.fromCharCode(0);
const RESTORE_CODE = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');

/** @type {Record<string, string>} */
const HTML_ESCAPES = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

/** @param {string} s */
function escapeHtml(s) {
	return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Schemes permitted in a rendered link. Matched against the *escaped* url, so
 * scheme characters (`:` `/`) survive escaping unchanged.
 */
const SAFE_LINK_SCHEME = /^(https?:\/\/|mailto:)/i;
