// @ts-check
import { describe, expect, it } from 'vitest';
import { createTransport, DjibbHttpError } from './transport.js';

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
		await createTransport({ baseUrl: 'http://h:8787/', fetch: a.fetch }).get('/entities');
		expect(a.calls[0]?.url).toBe('http://h:8787/entities');

		const b = stubFetch(json({}));
		await createTransport({ baseUrl: 'http://h:8787', fetch: b.fetch }).get('entities');
		expect(b.calls[0]?.url).toBe('http://h:8787/entities');
	});

	it('always sends credentials: include', async () => {
		const { fetch, calls } = stubFetch(json({}));
		await createTransport({ baseUrl: 'http://h', fetch }).get('/x');
		expect(calls[0]?.init.credentials).toBe('include');
	});

	it('sends the active-account header only when provided', async () => {
		const withAcct = stubFetch(json({}));
		await createTransport({ baseUrl: 'http://h', fetch: withAcct.fetch }).get('/x', {
			activeAccount: 'a/123'
		});
		expect(new Headers(withAcct.calls[0]?.init.headers).get('X-Djibb-Active-Account')).toBe(
			'a/123'
		);

		const without = stubFetch(json({}));
		await createTransport({ baseUrl: 'http://h', fetch: without.fetch }).get('/x');
		expect(new Headers(without.calls[0]?.init.headers).has('X-Djibb-Active-Account')).toBe(false);
	});

	it('encodes a JSON body and sets Content-Type', async () => {
		const { fetch, calls } = stubFetch(json({ ok: true }));
		await createTransport({ baseUrl: 'http://h', fetch }).post('/x', { json: { a: 1 } });
		expect(calls[0]?.init.body).toBe('{"a":1}');
		expect(new Headers(calls[0]?.init.headers).get('Content-Type')).toBe('application/json');
	});

	it('parses a JSON response body', async () => {
		const { fetch } = stubFetch(json({ hello: 'world' }));
		const body = await createTransport({ baseUrl: 'http://h', fetch }).get('/x');
		expect(body).toEqual({ hello: 'world' });
	});

	it('returns undefined for 204 and for non-JSON bodies', async () => {
		const empty = stubFetch(new Response(null, { status: 204 }));
		expect(await createTransport({ baseUrl: 'http://h', fetch: empty.fetch }).post('/x')).toBe(
			undefined
		);

		const text = stubFetch(new Response('ok', { status: 200 }));
		expect(await createTransport({ baseUrl: 'http://h', fetch: text.fetch }).post('/x')).toBe(
			undefined
		);
	});

	it('maps 404 to null only when notFoundAsNull is set', async () => {
		const asNull = stubFetch(new Response('nope', { status: 404 }));
		expect(
			await createTransport({ baseUrl: 'http://h', fetch: asNull.fetch }).get('/x', {
				notFoundAsNull: true
			})
		).toBe(null);

		const thrown = stubFetch(new Response('nope', { status: 404 }));
		await expect(
			createTransport({ baseUrl: 'http://h', fetch: thrown.fetch }).get('/x')
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
		const err = await createTransport({ baseUrl: 'http://h', fetch })
			.post('/x')
			.catch((/** @type {unknown} */ e) => e);
		expect(err).toBeInstanceOf(DjibbHttpError);
		const httpErr = /** @type {DjibbHttpError} */ (err);
		expect(httpErr.status).toBe(429);
		expect(httpErr.bodyText).toBe('slow down');
		expect(httpErr.headers.get('Retry-After')).toBe('42');
	});
});
