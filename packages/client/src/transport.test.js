// @ts-check
import { describe, expect, it } from 'vitest';
import {
	anonymous,
	bearerToken,
	createTransport,
	DjibbHttpError,
	sessionCookie
} from './transport.js';

/**
 * Build a stub `fetch` that records its calls and returns `response`. The
 * transport takes `fetch` by injection precisely so it can be driven like
 * this — no network, no DOM.
 *
 * @param {Response} response
 */
function stubFetch(response) {
	/** @type {{ url: string, init: RequestInit }[]} */
	const calls = [];
	/** @type {typeof globalThis.fetch} */
	const fetchStub = async (url, init) => {
		calls.push({ url: String(url), init: init ?? {} });
		return response;
	};
	return { fetch: fetchStub, calls };
}

/** @param {unknown} body @param {ResponseInit} [init] */
function json(body, init) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
		...init
	});
}

describe('createTransport', () => {
	it('joins base and path with a single slash, absolute or bare', async () => {
		const a = stubFetch(json({}));
		await createTransport({ credential: sessionCookie(), baseUrl: 'http://h:8787/', fetch: a.fetch }).get('/entities');
		expect(a.calls[0]?.url).toBe('http://h:8787/entities');

		const b = stubFetch(json({}));
		await createTransport({ credential: sessionCookie(), baseUrl: 'http://h:8787', fetch: b.fetch }).get('entities');
		expect(b.calls[0]?.url).toBe('http://h:8787/entities');
	});

	it('applies the credential to every request', async () => {
		const { fetch, calls } = stubFetch(json({}));
		await createTransport({ credential: sessionCookie(), baseUrl: 'http://h', fetch }).get('/x');
		expect(calls[0]?.init.credentials).toBe('include');
	});

	it('sends the active-account header only when provided', async () => {
		const withAcct = stubFetch(json({}));
		await createTransport({ credential: sessionCookie(), baseUrl: 'http://h', fetch: withAcct.fetch }).get('/x', {
			activeAccount: 'a/123'
		});
		expect(new Headers(withAcct.calls[0]?.init.headers).get('X-Djibb-Active-Account')).toBe(
			'a/123'
		);

		const without = stubFetch(json({}));
		await createTransport({ credential: sessionCookie(), baseUrl: 'http://h', fetch: without.fetch }).get('/x');
		expect(new Headers(without.calls[0]?.init.headers).has('X-Djibb-Active-Account')).toBe(false);
	});

	it('encodes a JSON body and sets Content-Type', async () => {
		const { fetch, calls } = stubFetch(json({ ok: true }));
		await createTransport({ credential: sessionCookie(), baseUrl: 'http://h', fetch }).post('/x', { json: { a: 1 } });
		expect(calls[0]?.init.body).toBe('{"a":1}');
		expect(new Headers(calls[0]?.init.headers).get('Content-Type')).toBe('application/json');
	});

	it('parses a JSON response body', async () => {
		const { fetch } = stubFetch(json({ hello: 'world' }));
		const body = await createTransport({ credential: sessionCookie(), baseUrl: 'http://h', fetch }).get('/x');
		expect(body).toEqual({ hello: 'world' });
	});

	it('returns undefined for 204/205 without parsing', async () => {
		for (const status of [204, 205]) {
			const { fetch } = stubFetch(new Response(null, { status }));
			expect(await createTransport({ credential: sessionCookie(), baseUrl: 'http://h', fetch }).post('/x')).toBe(undefined);
		}
	});

	it("returns undefined for a 200 with no body when parse: 'none'", async () => {
		// `/auth/magic/request` soft-200s with an empty body to avoid
		// disclosing whether the Account exists.
		const { fetch } = stubFetch(new Response(null, { status: 200 }));
		expect(
			await createTransport({ credential: sessionCookie(), baseUrl: 'http://h', fetch }).post('/x', { parse: 'none' })
		).toBe(undefined);
	});

	it('throws — not silently undefined — on a 200 that should be JSON but is not', async () => {
		// A read path promising `SharedEntity[]` must fail loudly here, not
		// hand back `undefined` that explodes later at the caller's `.map()`.
		const { fetch } = stubFetch(new Response('<html>oops</html>', { status: 200 }));
		await expect(createTransport({ credential: sessionCookie(), baseUrl: 'http://h', fetch }).get('/x')).rejects.toThrow();
	});

	it('extra headers cannot clobber the active-account authz header', async () => {
		const { fetch, calls } = stubFetch(json({}));
		await createTransport({ credential: sessionCookie(), baseUrl: 'http://h', fetch }).get('/x', {
			activeAccount: 'a/real',
			headers: { 'X-Djibb-Active-Account': 'a/spoofed', 'X-Trace': '1' }
		});
		const sent = new Headers(calls[0]?.init.headers);
		expect(sent.get('X-Djibb-Active-Account')).toBe('a/real');
		expect(sent.get('X-Trace')).toBe('1');
	});

	it('maps 404 to null on non-GET verbs too', async () => {
		const { fetch } = stubFetch(new Response('nope', { status: 404 }));
		expect(
			await createTransport({ credential: sessionCookie(), baseUrl: 'http://h', fetch }).post('/x', {
				notFoundAsNull: true
			})
		).toBe(null);
	});

	it('resolves globalThis.fetch per call, so later interceptors are honored', async () => {
		const original = globalThis.fetch;
		try {
			const transport = createTransport({ credential: sessionCookie(), baseUrl: 'http://h' }); // no fetch injected
			/** @type {string[]} */
			const seen = [];
			globalThis.fetch = /** @type {typeof globalThis.fetch} */ (
				async (/** @type {any} */ url) => {
					seen.push(String(url));
					return json({ intercepted: true });
				}
			);
			expect(await transport.get('/x')).toEqual({ intercepted: true });
			expect(seen).toEqual(['http://h/x']);
		} finally {
			globalThis.fetch = original;
		}
	});

	it('maps 404 to null only when notFoundAsNull is set', async () => {
		const asNull = stubFetch(new Response('nope', { status: 404 }));
		expect(
			await createTransport({ credential: sessionCookie(), baseUrl: 'http://h', fetch: asNull.fetch }).get('/x', {
				notFoundAsNull: true
			})
		).toBe(null);

		const thrown = stubFetch(new Response('nope', { status: 404 }));
		await expect(
			createTransport({ credential: sessionCookie(), baseUrl: 'http://h', fetch: thrown.fetch }).get('/x')
		).rejects.toBeInstanceOf(DjibbHttpError);
	});

	it('throws a DjibbHttpError carrying status, body text, and headers', async () => {
		const { fetch } = stubFetch(
			new Response('slow down', {
				status: 429,
				statusText: 'Too Many Requests',
				headers: { 'Retry-After': '42' }
			})
		);
		const err = await createTransport({ credential: sessionCookie(), baseUrl: 'http://h', fetch })
			.post('/x')
			.catch((/** @type {unknown} */ e) => e);
		expect(err).toBeInstanceOf(DjibbHttpError);
		const httpErr = /** @type {DjibbHttpError} */ (err);
		expect(httpErr.status).toBe(429);
		expect(httpErr.bodyText).toBe('slow down');
		expect(httpErr.headers.get('Retry-After')).toBe('42');
		expect(httpErr.url).toBe('http://h/x');
	});

	it('keeps the URL out of the error message (call sites render it to users)', async () => {
		const { fetch } = stubFetch(
			new Response('boom', { status: 500, statusText: 'Internal Server Error' })
		);
		const err = /** @type {DjibbHttpError} */ (
			await createTransport({ credential: sessionCookie(), baseUrl: 'https://api.djibb.com', fetch })
				.get('/workspace/connected?l=w/abc123')
				.catch((/** @type {unknown} */ e) => e)
		);
		expect(err.message).toBe('500 Internal Server Error');
		expect(err.message).not.toContain('api.djibb.com');
		expect(err.message).not.toContain('w/abc123');
	});
});

describe('credential strategies', () => {
	/** @param {import('./transport.js').Credential} credential */
	async function sendWith(credential) {
		const { fetch, calls } = stubFetch(json({}));
		await createTransport({ baseUrl: 'http://h', credential, fetch }).post('/x', {
			json: {}
		});
		return {
			credentials: calls[0]?.init.credentials,
			headers: new Headers(calls[0]?.init.headers)
		};
	}

	it('sessionCookie sends the cookie and never sets Origin (a browser-forbidden header)', async () => {
		const sent = await sendWith(sessionCookie());
		expect(sent.credentials).toBe('include');
		expect(sent.headers.has('Origin')).toBe(false);
		expect(sent.headers.has('Authorization')).toBe(false);
	});

	it('bearerToken sends Authorization + an explicit Origin, and no cookie', async () => {
		const sent = await sendWith(bearerToken('tok_123', { origin: 'https://djibb.com' }));
		expect(sent.credentials).toBe('omit');
		expect(sent.headers.get('Authorization')).toBe('Bearer tok_123');
		// Non-browser callers must clear the worker's CSRF gate themselves.
		expect(sent.headers.get('Origin')).toBe('https://djibb.com');
	});

	it('anonymous sends an Origin but no credential at all', async () => {
		const sent = await sendWith(anonymous({ origin: 'https://djibb.com' }));
		expect(sent.credentials).toBe('omit');
		expect(sent.headers.get('Origin')).toBe('https://djibb.com');
		expect(sent.headers.has('Authorization')).toBe(false);
	});

	it("a caller's extra headers cannot clobber the credential", async () => {
		const { fetch, calls } = stubFetch(json({}));
		await createTransport({
			baseUrl: 'http://h',
			credential: bearerToken('real', { origin: 'https://djibb.com' }),
			fetch
		}).post('/x', {
			headers: { Authorization: 'Bearer spoofed', Origin: 'https://evil.example' }
		});
		const sent = new Headers(calls[0]?.init.headers);
		expect(sent.get('Authorization')).toBe('Bearer real');
		expect(sent.get('Origin')).toBe('https://djibb.com');
	});
});
