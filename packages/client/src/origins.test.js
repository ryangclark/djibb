// @ts-check
import { describe, expect, it } from 'vitest';
import { deriveOrigins } from './origins.js';

describe('deriveOrigins', () => {
	it('derives an insecure local origin', () => {
		expect(deriveOrigins('http://localhost:8787')).toEqual({
			apiOrigin: 'http://localhost:8787',
			wsOrigin: 'ws://localhost:8787',
			replicacheHost: 'localhost:8787',
			replicacheSecure: false
		});
	});

	it('derives a secure production origin', () => {
		expect(deriveOrigins('https://api.djibb.com')).toEqual({
			apiOrigin: 'https://api.djibb.com',
			wsOrigin: 'wss://api.djibb.com',
			replicacheHost: 'api.djibb.com',
			replicacheSecure: true
		});
	});

	it('reads the scheme from the origin, not from a build mode', () => {
		// The bug the `dev` flag used to cause: a local build pointed at a
		// remote https worker got `ws://` + `secure: false`.
		const remote = deriveOrigins('https://api.djibb.com');
		expect(remote.wsOrigin).toBe('wss://api.djibb.com');
		expect(remote.replicacheSecure).toBe(true);
	});

	it('trims a trailing slash', () => {
		expect(deriveOrigins('https://api.djibb.com/').apiOrigin).toBe('https://api.djibb.com');
	});

	it('throws a named error when the origin is unset', () => {
		expect(() => deriveOrigins(undefined)).toThrow(/VITE_DJIBB_ORIGIN/);
		expect(() => deriveOrigins('')).toThrow(/VITE_DJIBB_ORIGIN/);
	});

	it('rejects a non-URL and a non-http scheme', () => {
		expect(() => deriveOrigins('api.djibb.com')).toThrow(/not a valid URL/);
		expect(() => deriveOrigins('ftp://api.djibb.com')).toThrow(/must be http/);
	});
});
