import { z } from 'zod';
import type { MutatorDefs, ReadonlyJSONValue, WriteTransaction } from 'replicache';

import type { AuthorizationRules } from '../../auth/rules';
import { MutationEnvelopeArgsSchema } from './_shared';
import type {
    ClientMutator,
    ClientMutatorCtx,
    ServerMutator,
    ServerMutatorCtx,
} from './_shared';

import * as initList from './initList';
import * as createListItem from './createListItem';
import * as renameList from './renameList';
import * as setItem from './setItem';
import * as setItemQuantity from './setItemQuantity';

export { EDIT_ROLES } from './_shared';
export type { ServerMutatorCtx, ClientMutatorCtx } from './_shared';

export const DEFAULT_LIST_AUTHORIZATION_RULES: AuthorizationRules = {
    authorized_accounts: {},
    default_role: 'ownerless',
    set_by: 'defaults',
};
export const DEFAULT_LIST_TITLE = '';

/**
 * Single source of truth for every mutation. Each entry pairs an args
 * schema with the matched client and server implementations and the
 * roles permitted to run it. Dispatch (DO + UI) reads from here; there
 * is no separate ServerMutators / ClientMutators registry to drift.
 */
export const Mutations = {
    [initList.name]: initList,
    [createListItem.name]: createListItem,
    [renameList.name]: renameList,
    [setItem.name]: setItem,
    [setItemQuantity.name]: setItemQuantity,
} as const;

export type MutationName = keyof typeof Mutations;

/**
 * Discriminated union over the mutation wire shape. Names not in this
 * union fail to parse — there is no `.passthrough()` and no `string`
 * fallback. Dispatch handles parse failure by skip-and-ack.
 *
 * Replicache forces metadata into `args`, so on the wire `accountId`
 * and `timestamp_client` ride alongside the body args and are merged
 * into each variant's args schema here. Dispatch destructures them
 * back out into ctx.
 */
/**
 * Wire envelope. Validates the structural shape every mutation must
 * have — id, clientID, name, and the envelope metadata in `args`. The
 * body of `args` is left opaque here and validated per-name against
 * `Mutations[name].argsSchema` inside dispatch. This split avoids
 * synthesizing a deeply-nested discriminated union at compile time.
 */
export const MutationSchema = z.object({
    clientID: z.string(),
    id: z.number(),
    name: z.string(),
    args: z.looseObject(MutationEnvelopeArgsSchema.shape),
});

export type MutationWire = z.infer<typeof MutationSchema>;

export type Mutation = MutationWire & {
    status?: 'error' | 'skipped' | 'succeeded' | 'unknown';
    timestamp_server?: Date;
};

/**
 * Server dispatch helper. Validates wire shape, gates by role, splits
 * envelope metadata into ctx, and invokes the mutator. Returns a
 * descriptor for the caller to thread into mutation log + ack flow.
 */
export type DispatchResult =
    | { ok: true; status: 'succeeded' }
    | { ok: false; status: 'skipped'; reason: string }
    | { ok: false; status: 'unauthorized'; reason: string };

export function dispatchServerMutation(
    rawMutation: unknown,
    ctxBase: Pick<ServerMutatorCtx, 'sql' | 'role' | 'nextVersion'>
): DispatchResult {
    const envelopeParse = MutationSchema.safeParse(rawMutation);
    if (!envelopeParse.success) {
        return {
            ok: false,
            status: 'skipped',
            reason: `envelope parse: ${z.prettifyError(envelopeParse.error)}`,
        };
    }

    const mutation = envelopeParse.data;
    const entry = (Mutations as Record<string, (typeof Mutations)[MutationName]>)[
        mutation.name
    ];
    if (!entry) {
        return {
            ok: false,
            status: 'skipped',
            reason: `unknown mutator "${mutation.name}"`,
        };
    }

    if (!entry.requiredRole.includes(ctxBase.role)) {
        return {
            ok: false,
            status: 'unauthorized',
            reason: `role "${ctxBase.role}" not in requiredRole for "${mutation.name}"`,
        };
    }

    const { accountId, timestamp_client, ...rawBody } =
        mutation.args as Record<string, unknown>;
    const bodyParse = entry.argsSchema.safeParse(rawBody);
    if (!bodyParse.success) {
        return {
            ok: false,
            status: 'skipped',
            reason: `args parse for "${mutation.name}": ${z.prettifyError(bodyParse.error)}`,
        };
    }

    const ctx: ServerMutatorCtx = {
        ...ctxBase,
        accountId: (accountId as string | null | undefined) ?? null,
        timestamp_client:
            timestamp_client instanceof Date
                ? timestamp_client
                : timestamp_client
                ? new Date(timestamp_client as string)
                : null,
    };

    (entry.server as ServerMutator<unknown>)(bodyParse.data, ctx);

    return { ok: true, status: 'succeeded' };
}

/**
 * Client-side mutators registered with Replicache. Wraps each per-mutator
 * `client` to extract envelope metadata into ctx, matching the server's
 * shape. The frontend does NOT enforce `requiredRole` — UI gating is the
 * presentation-layer concern; the server is the security boundary.
 */
export const mutators: MutatorDefs = Object.fromEntries(
    Object.values(Mutations).map(m => [
        m.name,
        async (tx: WriteTransaction, args: ReadonlyJSONValue) => {
            const a = (args ?? {}) as any;
            const ctx: ClientMutatorCtx = {
                accountId: a.accountId ?? null,
                timestamp_client: a.timestamp_client
                    ? new Date(a.timestamp_client)
                    : null,
            };
            return (m.client as ClientMutator<any>)(tx, a, ctx);
        },
    ])
);

/**
 * Backwards-compat re-export. The pages app imports from
 * `$djibb/list/mutators/client`.
 */
export { mutators as ClientMutators };
