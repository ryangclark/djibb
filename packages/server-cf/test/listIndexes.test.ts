import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

import { DjibbList } from '../src/list/durable_object';
import { ensureListElementIndexes } from '../src/list/sql';
import { IdTypes } from '@djibb/protocol/id';

// GH #39: the entity DO's SQLite tables carry indexes matching this
// module's real query shapes. `ensureListElementIndexes` runs in the DO
// constructor's `blockConcurrencyWhile`, so simply accessing a stub and
// reading `sqlite_master` proves the forward-migration lands on load —
// for both fresh DOs and (idempotently) ones that predate it.
//
// GH #68 is the enabling change: the row-found assertions read `changes()`
// rather than `SqlStorage.rowsWritten`, which index-page writes inflate.
// The 672-test suite running green with these indexes present is the
// broader proof that the two changes hold together; this file just pins
// the index set so it can't silently regress.

function getListStub(suffix: string) {
    const prefixed = `${IdTypes.list}/${suffix.padEnd(21, 'a').slice(0, 21)}`;
    const id = env.DJIBB_LIST.idFromName(prefixed);
    return env.DJIBB_LIST.get(id) as DurableObjectStub<DjibbList>;
}

async function indexNames(
    stub: DurableObjectStub<DjibbList>,
): Promise<Set<string>> {
    const rows = await runInDurableObject(stub, (_i, state) =>
        state.storage.sql
            .exec(
                `SELECT name FROM sqlite_master WHERE type = 'index'
                 AND name LIKE 'idx_%';`,
            )
            .toArray(),
    );
    return new Set((rows as { name: string }[]).map(r => r.name));
}

describe('entity DO indexes (GH #39)', () => {
    it('creates the expected indexes on DO load', async () => {
        const stub = getListStub('index-fresh');
        const names = await indexNames(stub);

        expect(names).toContain('idx_list_elements_type_time_deleted');
        expect(names).toContain('idx_list_elements_version');
        expect(names).toContain('idx_replicache_clients_group');
    });

    it('is idempotent — re-running the migration does not throw or duplicate', async () => {
        const stub = getListStub('index-idem');
        // Constructor already ran the migration once; run it again by hand.
        await runInDurableObject(stub, (_i, state) =>
            ensureListElementIndexes(state.storage.sql),
        );
        await runInDurableObject(stub, (_i, state) =>
            ensureListElementIndexes(state.storage.sql),
        );

        const names = await indexNames(stub);
        expect(names).toContain('idx_list_elements_type_time_deleted');
        expect(names).toContain('idx_list_elements_version');
        expect(names).toContain('idx_replicache_clients_group');
    });
});
