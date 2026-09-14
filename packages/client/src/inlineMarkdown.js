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
 * Pass ordering matters (GH #4 review): links and code are extracted to
 * placeholders *before* any emphasis pass runs, so emphasis only ever scans
 * literal escaped text — never a generated `<a>` tag or a URL. Emitting an
 * anchor first and then running `/_(...)_/` over the whole string corrupts
 * `target="_blank"` and any URL containing `_`.
 *
 * @param {string | null | undefined} input
 * @returns {string} sanitized HTML
 */
export function renderInlineMarkdown(input) {
	if (input == null) return '';
	const key = String(input);
	const hit = CACHE.get(key);
	if (hit !== undefined) return hit;

	// Strip the sentinel up front: the placeholder scheme below is
	// SENTINEL-delimited, so a sentinel char in the source could forge one.
	const escaped = escapeHtml(key.split(SENTINEL).join(''));

	/** @type {string[]} Final HTML fragments, referenced by placeholder. */
	const tokens = [];
	/** @param {string} html */
	const stash = (html) => {
		tokens.push(html);
		return `${SENTINEL}${tokens.length - 1}${SENTINEL}`;
	};

	// 1. Extract `code` spans first (their contents, already escaped, must not
	//    be re-interpreted as emphasis or a link).
	let out = escaped.replace(/`([^`]+)`/g, (_m, code) => stash(`<code>${code}</code>`));

	// 2. Extract links. Both halves are already escaped, so `"` is `&quot;`
	//    (can't break out of the attribute) and `&` is `&amp;` (a valid href
	//    entity). The scheme test runs on the escaped url (`:`/`/` survive
	//    escaping); anything but http/https/mailto falls back to inert text.
	//    Emphasis is applied to the *link text* here, before stashing, so it
	//    never touches the href. The url pattern allows one level of balanced
	//    parens so `.../Foo_(bar)` isn't truncated.
	out = out.replace(LINK, (m, text, url) =>
		SAFE_LINK_SCHEME.test(url)
			? stash(
					`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${applyEmphasis(
						text
					)}</a>`
				)
			: m
	);

	// 3. Emphasis over what remains — pure escaped text plus placeholders
	//    (placeholders hold no `*`/`_`/backtick, so they're inert here).
	out = applyEmphasis(out);

	// 4. Restore placeholders. A link's stashed text may embed a code
	//    placeholder, so repeat until none remain (bounded by token count).
	for (let pass = 0; pass <= tokens.length && out.indexOf(SENTINEL) !== -1; pass++) {
		out = out.replace(RESTORE, (_m, i) => tokens[Number(i)] ?? '');
	}

	cacheSet(key, out);
	return out;
}

/**
 * Apply emphasis to already-escaped literal text that contains no generated
 * markup. Bold before italic so `**x**` isn't consumed by the single-`*` rule.
 * Underscore emphasis is word-boundary-gated per the CommonMark intraword rule:
 * a `_` flanked by alphanumerics/underscores does not open or close emphasis,
 * so `snake_case` and URLs with `_` are left literal (asterisks intentionally
 * are not gated — CommonMark treats intraword `*` as emphasis).
 *
 * @param {string} s
 */
function applyEmphasis(s) {
	return s
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\*([^*]+)\*/g, '<em>$1</em>')
		.replace(/(^|[^A-Za-z0-9_])_([^_\s](?:[^_]*[^_\s])?)_(?![A-Za-z0-9_])/g, '$1<em>$2</em>');
}

/**
 * NUL delimits placeholders between passes: it cannot appear in output (it is
 * stripped from the input) and never occurs in real text. Built at runtime so
 * no control byte lives in source.
 */
const SENTINEL = String.fromCharCode(0);
const RESTORE = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');

/**
 * `[text](url)`. `text` is any run without `]`; `url` is a run of non-space,
 * non-paren characters with one optional level of balanced `(...)` so URLs
 * like `en.wikipedia.org/wiki/Foo_(bar)` capture in full.
 */
const LINK = /\[([^\]]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)/g;

/**
 * Schemes permitted in a rendered link. Matched against the *escaped* url, so
 * scheme characters (`:` `/`) survive escaping unchanged.
 */
const SAFE_LINK_SCHEME = /^(https?:\/\/|mailto:)/i;

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
 * Memoize by raw input — output is a pure function of it, and the render path
 * re-invokes this for every element on each reactive render (GH #4 review).
 * FIFO-evict a single entry past the cap to bound memory.
 * @type {Map<string, string>}
 */
const CACHE = new Map();
const CACHE_MAX = 1000;
/** @param {string} k @param {string} v */
function cacheSet(k, v) {
	if (CACHE.size >= CACHE_MAX) {
		const oldest = CACHE.keys().next().value;
		if (oldest !== undefined) CACHE.delete(oldest);
	}
	CACHE.set(k, v);
}
