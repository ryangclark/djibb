/**
 * Cron / `scheduled` sweep dispatcher.
 *
 * The worker's default export is `{ fetch, scheduled }` (see `index.ts`);
 * this module owns what the `scheduled` handler actually does. Each
 * registered sweep runs inside its own try/catch so a single failing
 * sweep can't starve the others — the cron fires them all, every tick,
 * and each is individually idempotent + retry-safe.
 *
 * Registered sweeps:
 *   - **Account-deletion Phase 2** (GH #64) — hard-purge PII of accounts
 *     tombstoned past their grace window and relinquish the entities they
 *     own (`auth/d1.ts` `PurgeTombstonedAccounts`).
 *
 * This is deliberately the shared scheduling substrate GH #15 (orphaned
 * List/Template DO sweep) also wants: a new sweep plugs in here as
 * another isolated try/catch block rather than forking its own cron.
 */
import type { Bindings } from './index';
import { PurgeTombstonedAccounts } from './auth/d1';

export async function runScheduledSweeps(env: Bindings): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // Account-deletion Phase 2 (GH #64).
    try {
        const result = await PurgeTombstonedAccounts({
            d1: env.DJIBB_AUTH,
            listNs: env.DJIBB_LIST,
            now,
        });
        if (result.scanned > 0) {
            console.log('`scheduled` account purge:', JSON.stringify(result));
        }
    } catch (error) {
        console.error('`scheduled` account-purge sweep threw:', error);
    }

    // Seam for GH #15 (orphaned-DO sweep): add further sweeps here, each
    // in its own try/catch so one failure can't starve the rest.
}
