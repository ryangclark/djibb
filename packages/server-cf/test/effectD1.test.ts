/**
 * The `effect/d1` support module (docs/plans/effect-adoption.md
 * Phase 1) — the one place `runPromise` ceremony lives for the D1
 * owner modules. Runs in the workers pool so the Effect runtime and
 * the @effect/sql-d1 driver are exercised under workerd, replacing
 * the Phase 0 spike test as the standing runtime proof.
 */
import { SqlError } from '@effect/sql/SqlError';
import * as Effect from 'effect/Effect';
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

import { UnexpectedError } from '@djibb/protocol/errors';

import { d1Try, runD1 } from '../src/effect/d1';

describe('effect/d1 support module', () => {
    it('runs an Effect sql program against D1 and returns rows', async () => {
        const rows = await runD1(
            env.DJIBB_AUTH,
            'test-query',
            sql => sql<{ answer: number }>`SELECT 1 + 1 AS answer`,
        );
        expect(rows[0]?.answer).toBe(2);
    });

    it('binds interpolated values as parameters', async () => {
        const rows = await runD1(
            env.DJIBB_AUTH,
            'test-params',
            sql =>
                sql<{ v: string }>`SELECT ${"it's -- not; injected"} AS v`,
        );
        expect(rows[0]?.v).toBe("it's -- not; injected");
    });

    it('maps SQL failures to UnexpectedError at the boundary', async () => {
        await expect(
            runD1(
                env.DJIBB_AUTH,
                'test-failure',
                sql => sql`SELECT * FROM no_such_table_ever`,
            ),
        ).rejects.toBeInstanceOf(UnexpectedError);
    });

    it('d1Try lifts raw D1 rejections into the SqlError channel', async () => {
        await expect(
            runD1(env.DJIBB_AUTH, 'test-d1try', () =>
                d1Try(() =>
                    env.DJIBB_AUTH.prepare(
                        'SELECT * FROM no_such_table_ever',
                    ).run(),
                ),
            ),
        ).rejects.toBeInstanceOf(UnexpectedError);
    });

    it('retry: true re-runs a transiently failing program to success', async () => {
        let attempts = 0;
        const result = await runD1(
            env.DJIBB_AUTH,
            'test-retry',
            () =>
                Effect.suspend(() => {
                    attempts += 1;
                    return attempts < 3
                        ? Effect.fail(
                              new SqlError({
                                  cause: new Error('transient'),
                                  message: 'transient',
                              }),
                          )
                        : Effect.succeed('recovered');
                }),
            { retry: true },
        );
        expect(result).toBe('recovered');
        expect(attempts).toBe(3);
    });

    it('retry is bounded: persistent failure still surfaces after 2 retries', async () => {
        let attempts = 0;
        await expect(
            runD1(
                env.DJIBB_AUTH,
                'test-retry-bounded',
                () =>
                    Effect.suspend(() => {
                        attempts += 1;
                        return Effect.fail(
                            new SqlError({
                                cause: new Error('persistent'),
                                message: 'persistent',
                            }),
                        );
                    }),
                { retry: true },
            ),
        ).rejects.toBeInstanceOf(UnexpectedError);
        expect(attempts).toBe(3); // initial attempt + 2 retries
    });
});
