import { z } from 'zod';
import type { MutatorDefs, ReadonlyJSONValue, WriteTransaction } from 'replicache';

import type { AuthorizationRules } from '../../auth/rules';
import { MutationEnvelopeArgsSchema } from './_shared';
import type {
    ClientMutator,
    ClientMutatorCtx,
    MutatorModule,
    ServerMutator,
    ServerMutatorCtx,
} from './_shared';

import * as acceptInvitation from './acceptInvitation';
import * as archiveList from './archiveList';
import * as archiveListGroup from './archiveListGroup';
import * as archiveListGroups from './archiveListGroups';
import * as archiveListItem from './archiveListItem';
import * as archiveListItems from './archiveListItems';
import * as cascadeArchiveList from './cascadeArchiveList';
import * as cascadeRestoreList from './cascadeRestoreList';
import * as changeMemberRole from './changeMemberRole';
import * as createWorkspace from './createWorkspace';
import * as leaveMember from './leaveMember';
import * as removeMember from './removeMember';
import * as initList from './initList';
import * as createListItem from './createListItem';
import * as initFromTemplate from './initFromTemplate';
import * as inviteByIdentity from './inviteByIdentity';
import * as renameList from './renameList';
import * as renameWorkspace from './renameWorkspace';
import * as revokeInvitation from './revokeInvitation';
import * as reorderListGroup from './reorderListGroup';
import * as reorderListItem from './reorderListItem';
import * as setDescription from './setDescription';
import * as setGroupFields from './setGroupFields';
import * as setGroupsAtomic from './setGroupsAtomic';
import * as setItemFields from './setItemFields';
import * as setItemsAtomic from './setItemsAtomic';
import * as setItemQuantity from './setItemQuantity';
import * as setListAuthRules from './setListAuthRules';
import * as setWorkspaceImage from './setWorkspaceImage';
import * as setWorkspaceSlug from './setWorkspaceSlug';
import * as transferOwnership from './transferOwnership';
import * as unarchiveList from './unarchiveList';
import * as unarchiveListGroup from './unarchiveListGroup';
import * as unarchiveListGroups from './unarchiveListGroups';
import * as unarchiveListItem from './unarchiveListItem';
import * as unarchiveListItems from './unarchiveListItems';

export {
    EDIT_ROLES,
    FRICTION_TIER_MUTATORS,
    isFrictionTier,
} from './_shared';
export type {
    ServerMutatorCtx,
    ClientMutatorCtx,
    Inverse,
    CapturePreState,
    PreState,
    FrictionTier,
} from './_shared';

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
    [acceptInvitation.name]: acceptInvitation,
    [archiveList.name]: archiveList,
    [archiveListGroup.name]: archiveListGroup,
    [archiveListGroups.name]: archiveListGroups,
    [archiveListItem.name]: archiveListItem,
    [archiveListItems.name]: archiveListItems,
    [cascadeArchiveList.name]: cascadeArchiveList,
    [cascadeRestoreList.name]: cascadeRestoreList,
    [changeMemberRole.name]: changeMemberRole,
    [createWorkspace.name]: createWorkspace,
    [leaveMember.name]: leaveMember,
    [removeMember.name]: removeMember,
    [initList.name]: initList,
    [createListItem.name]: createListItem,
    [initFromTemplate.name]: initFromTemplate,
    [inviteByIdentity.name]: inviteByIdentity,
    [renameList.name]: renameList,
    [renameWorkspace.name]: renameWorkspace,
    [revokeInvitation.name]: revokeInvitation,
    [reorderListGroup.name]: reorderListGroup,
    [reorderListItem.name]: reorderListItem,
    [setDescription.name]: setDescription,
    [setGroupFields.name]: setGroupFields,
    [setGroupsAtomic.name]: setGroupsAtomic,
    [setItemFields.name]: setItemFields,
    [setItemsAtomic.name]: setItemsAtomic,
    [setItemQuantity.name]: setItemQuantity,
    [setListAuthRules.name]: setListAuthRules,
    [setWorkspaceImage.name]: setWorkspaceImage,
    [setWorkspaceSlug.name]: setWorkspaceSlug,
    [transferOwnership.name]: transferOwnership,
    [unarchiveList.name]: unarchiveList,
    [unarchiveListGroup.name]: unarchiveListGroup,
    [unarchiveListGroups.name]: unarchiveListGroups,
    [unarchiveListItem.name]: unarchiveListItem,
    [unarchiveListItems.name]: unarchiveListItems,
} as const satisfies Record<string, MutatorModule<any>>;

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

export type MutationStatus = 'error' | 'skipped' | 'succeeded' | 'unknown';

/**
 * Server-internal envelope. The wire format (Replicache forces it)
 * crams `accountId` and `timestamp_client` into `args`; the envelope
 * is what the rest of the system consumes after parsing. The mutation
 * log persists envelope fields to dedicated columns; body args are
 * stored as opaque JSON.
 */
export type MutationEnvelope = {
    clientID: string;
    id: number;
    name: string;
    accountId: string | null;
    timestamp_client: Date | null;
};

/**
 * The domain noun: a mutation as the system works with it after
 * parsing. The wire shape (`MutationSchema`'s inferred type) is a
 * Replicache-imposed transport detail — kept inside the parser, not
 * surfaced as an exported type, so call sites can't accidentally
 * reach back into raw `args` for envelope fields.
 */
export type Mutation = {
    envelope: MutationEnvelope;
    /** Body args after envelope fields are split off. Not yet validated
     *  against the per-mutator argsSchema — that happens in
     *  `executeServerMutation`. */
    rawBody: Record<string, unknown>;
};

export type EnvelopeParseResult =
    | { ok: true; mutation: Mutation }
    | { ok: false; reason: string };

/**
 * Parse the wire envelope and split body args off envelope metadata.
 * Does not run the mutator and does not check role — those are
 * `executeServerMutation`'s job. Surfaced so callers (the DO push
 * handler) can do envelope-level pre-checks (e.g. cross-account auth)
 * against a parsed shape rather than re-fishing fields out of raw args.
 */
export function parseMutationEnvelope(
    rawMutation: unknown
): EnvelopeParseResult {
    const envelopeParse = MutationSchema.safeParse(rawMutation);
    if (!envelopeParse.success) {
        return {
            ok: false,
            reason: `envelope parse: ${z.prettifyError(envelopeParse.error)}`,
        };
    }

    const mutation = envelopeParse.data;
    const { accountId, timestamp_client, ...rawBody } =
        mutation.args as Record<string, unknown>;

    const envelope: MutationEnvelope = {
        clientID: mutation.clientID,
        id: mutation.id,
        name: mutation.name,
        accountId: (accountId as string | null | undefined) ?? null,
        timestamp_client:
            timestamp_client instanceof Date
                ? timestamp_client
                : timestamp_client
                ? new Date(timestamp_client as string)
                : null,
    };

    return { ok: true, mutation: { envelope, rawBody } };
}

/**
 * Execute a parsed mutation against the DO sql. Validates body args
 * against the per-mutator argsSchema, gates by role, and invokes the
 * server mutator with envelope fields surfaced via ctx.
 */
/**
 * Result of attempting to execute a parsed mutation. The `outcome`
 * field carries the structured per-mutation status surfaced over the
 * outcome channel (ADR 0006):
 *
 *  - `applied`     — write landed.
 *  - `stale`       — set-family CAS pre-check failed; whole envelope
 *                    no-op (ADR 0005 §"Defensive conflict policy").
 *  - `gone`        — target row missing.
 *  - `unauthorized`— role gate denied.
 *  - `skipped`     — args parse failed or unknown mutator.
 *
 * Successes (`applied`) don't flow over the outcome channel — only
 * failures (stale | gone | unauthorized). `skipped` is server-side
 * envelope-level diagnostic, not a per-mutation outcome.
 */
export type ExecuteResult =
    | { ok: true; status: 'succeeded'; outcome: 'applied' | 'stale' | 'gone' }
    | { ok: false; status: 'skipped'; reason: string }
    | { ok: false; status: 'unauthorized'; reason: string };

export function executeServerMutation(
    mutation: Mutation,
    ctxBase: Pick<ServerMutatorCtx, 'sql' | 'role' | 'nextVersion'>
): ExecuteResult {
    const { envelope, rawBody } = mutation;
    const entry = (Mutations as Record<string, (typeof Mutations)[MutationName]>)[
        envelope.name
    ];
    if (!entry) {
        return {
            ok: false,
            status: 'skipped',
            reason: `unknown mutator "${envelope.name}"`,
        };
    }

    // The union-narrowed type of `entry.requiredRole` is the
    // intersection of every concrete mutator's `requiredRole` tuple
    // (some are `readonly ['owner']`, some are SYSTEM_ROLES, etc.), so
    // .includes() over the union won't accept the broad
    // `AuthorizationRole` directly. The runtime check is a plain
    // string-in-array test; cast to widen.
    if (
        !(entry.requiredRole as readonly string[]).includes(ctxBase.role)
    ) {
        return {
            ok: false,
            status: 'unauthorized',
            reason: `role "${ctxBase.role}" not in requiredRole for "${envelope.name}"`,
        };
    }

    const bodyParse = entry.argsSchema.safeParse(rawBody);
    if (!bodyParse.success) {
        return {
            ok: false,
            status: 'skipped',
            reason: `args parse for "${envelope.name}": ${z.prettifyError(bodyParse.error)}`,
        };
    }

    const ctx: ServerMutatorCtx = {
        ...ctxBase,
        accountId: envelope.accountId,
        timestamp_client: envelope.timestamp_client,
    };

    const outcome = (entry.server as ServerMutator<unknown>)(
        bodyParse.data,
        ctx
    );

    // Mutators that return undefined / void are implicitly 'applied'.
    // CAS-aware mutators return `{status: 'stale' | 'gone'}` to surface
    // a no-op result to the runtime's outcome channel.
    const status =
        outcome && typeof outcome === 'object' && 'status' in outcome
            ? outcome.status
            : 'applied';

    return { ok: true, status: 'succeeded', outcome: status };
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
