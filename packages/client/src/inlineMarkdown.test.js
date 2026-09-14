import { describe, it, expect } from 'vitest';

import { renderInlineMarkdown } from './inlineMarkdown.js';

/**
 * Inline-markdown display renderer (GH #4). The security-critical half is the
 * XSS block: these fields are world-editable on `ownerless` entities, so the
 * input is treated as hostile and the output feeds Svelte `{@html …}`.
 */
describe('renderInlineMarkdown — supported subset', () => {
	it('renders **bold** (the WHO item-name symptom)', () => {
		expect(renderInlineMarkdown('**Is essential imaging displayed?**')).toBe(
			'<strong>Is essential imaging displayed?</strong>'
		);
		expect(renderInlineMarkdown('Does the patient have a **known allergy**?')).toBe(
			'Does the patient have a <strong>known allergy</strong>?'
		);
	});

	it('renders *italic* and _italic_', () => {
		expect(renderInlineMarkdown('*soon*')).toBe('<em>soon</em>');
		expect(renderInlineMarkdown('_soon_')).toBe('<em>soon</em>');
	});

	it('renders `code`', () => {
		expect(renderInlineMarkdown('use `npm test`')).toBe('use <code>npm test</code>');
	});

	it('renders an external [link](url) with safe rel/target (the WHO description symptom)', () => {
		const out = renderInlineMarkdown(
			'the WHO Surgical Safety [checklist](https://www.who.int/x.pdf) cut deaths'
		);
		expect(out).toBe(
			'the WHO Surgical Safety ' +
				'<a href="https://www.who.int/x.pdf" target="_blank" rel="noopener noreferrer nofollow">checklist</a>' +
				' cut deaths'
		);
	});

	it('renders a mailto: link', () => {
		expect(renderInlineMarkdown('[me](mailto:a@b.com)')).toContain(
			'<a href="mailto:a@b.com"'
		);
	});

	it('preserves a query string with & as a valid href entity', () => {
		expect(renderInlineMarkdown('[q](https://x.com/?a=1&b=2)')).toContain(
			'href="https://x.com/?a=1&amp;b=2"'
		);
	});

	it('leaves plain text untouched', () => {
		expect(renderInlineMarkdown('just a normal name')).toBe('just a normal name');
	});

	it('returns empty string for null/undefined', () => {
		expect(renderInlineMarkdown(null)).toBe('');
		expect(renderInlineMarkdown(undefined)).toBe('');
	});
});

describe('renderInlineMarkdown — XSS is neutralized', () => {
	it('escapes raw HTML tags to inert text', () => {
		const out = renderInlineMarkdown('<script>alert(1)</script>');
		expect(out).not.toContain('<script>');
		expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
	});

	it('escapes an <img onerror> injection to an inert tag', () => {
		const out = renderInlineMarkdown('<img src=x onerror=alert(1)>');
		// No live tag: the delimiters are escaped, so `onerror` survives only
		// as harmless text inside `&lt;img …&gt;`, never as an attribute.
		expect(out).not.toContain('<img');
		expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
	});

	it('refuses a javascript: link scheme (renders as literal text)', () => {
		const out = renderInlineMarkdown('[click](javascript:alert(1))');
		// The real property: no anchor and the scheme never reaches an href.
		expect(out).not.toContain('<a ');
		expect(out).not.toContain('href="javascript');
	});

	it('refuses a data: link scheme', () => {
		const out = renderInlineMarkdown('[x](data:text/html,<script>alert(1)</script>)');
		expect(out).not.toContain('<a ');
		expect(out).not.toContain('<script>');
	});

	it('cannot break out of the href attribute via quotes', () => {
		const out = renderInlineMarkdown('[x](https://a"onmouseover="alert(1))');
		// Either it did not render a link at all, or the quote is escaped —
		// never a raw attribute-breaking quote.
		expect(out).not.toContain('onmouseover="alert');
		expect(out).not.toContain('a"onmouseover');
	});

	it('does not interpret markup inside a `code` span', () => {
		const out = renderInlineMarkdown('`**not bold** [nope](https://x.com)`');
		expect(out).toBe('<code>**not bold** [nope](https://x.com)</code>');
	});

	it('strips the NUL sentinel so code-span placeholders cannot be forged', () => {
		const nul = String.fromCharCode(0);
		const out = renderInlineMarkdown(`${nul}0${nul}`);
		expect(out).not.toContain('<code>');
	});
});
