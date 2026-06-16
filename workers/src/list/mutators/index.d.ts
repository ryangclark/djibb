import { z } from 'zod';
import type { MutatorReturn, ReadonlyJSONValue, WriteTransaction } from 'replicache';
import type { AuthorizationRules } from '@djibb/protocol/auth/rules';
import type { ServerMutatorCtx } from './_shared';
import * as acceptInvitation from './acceptInvitation';
import * as archiveList from './archiveList';
import * as archiveListGroup from './archiveListGroup';
import * as archiveListGroups from './archiveListGroups';
import * as archiveListItem from './archiveListItem';
import * as archiveListItems from './archiveListItems';
import * as cascadeArchiveList from './cascadeArchiveList';
import * as cascadeRestoreList from './cascadeRestoreList';
import * as changeMemberRole from './changeMemberRole';
import * as claimEntity from './claimEntity';
import * as createWorkspace from './createWorkspace';
import * as leaveMember from './leaveMember';
import * as removeMember from './removeMember';
import * as initList from './initList';
import * as createListItem from './createListItem';
import * as initFromTemplate from './initFromTemplate';
import * as mintFromBlank from './mintFromBlank';
import * as inviteByIdentity from './inviteByIdentity';
import * as moveList from './moveList';
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
import * as startFresh from './startFresh';
import * as transferOwnership from './transferOwnership';
import * as unarchiveList from './unarchiveList';
import * as unarchiveListGroup from './unarchiveListGroup';
import * as unarchiveListGroups from './unarchiveListGroups';
import * as unarchiveListItem from './unarchiveListItem';
import * as unarchiveListItems from './unarchiveListItems';
export { EDIT_ROLES, FRICTION_TIER_MUTATORS, isFrictionTier, } from './_shared';
export type { ServerMutatorCtx, ClientMutatorCtx, Inverse, CapturePreState, PreState, FrictionTier, } from './_shared';
export declare const DEFAULT_LIST_AUTHORIZATION_RULES: AuthorizationRules;
export declare const DEFAULT_LIST_TITLE = "";
/**
 * Single source of truth for every mutation. Each entry pairs an args
 * schema with the matched client and server implementations and the
 * roles permitted to run it. Dispatch (DO + UI) reads from here; there
 * is no separate ServerMutators / ClientMutators registry to drift.
 */
export declare const Mutations: {
    readonly acceptInvitation: typeof acceptInvitation;
    readonly archiveList: typeof archiveList;
    readonly archiveListGroup: typeof archiveListGroup;
    readonly archiveListGroups: typeof archiveListGroups;
    readonly archiveListItem: typeof archiveListItem;
    readonly archiveListItems: typeof archiveListItems;
    readonly cascadeArchiveList: typeof cascadeArchiveList;
    readonly cascadeRestoreList: typeof cascadeRestoreList;
    readonly changeMemberRole: typeof changeMemberRole;
    readonly claimEntity: typeof claimEntity;
    readonly createWorkspace: typeof createWorkspace;
    readonly leaveMember: typeof leaveMember;
    readonly removeMember: typeof removeMember;
    readonly initList: typeof initList;
    readonly createListItem: typeof createListItem;
    readonly initFromTemplate: typeof initFromTemplate;
    readonly mintFromBlank: typeof mintFromBlank;
    readonly inviteByIdentity: typeof inviteByIdentity;
    readonly moveList: typeof moveList;
    readonly renameList: typeof renameList;
    readonly renameWorkspace: typeof renameWorkspace;
    readonly revokeInvitation: typeof revokeInvitation;
    readonly reorderListGroup: typeof reorderListGroup;
    readonly reorderListItem: typeof reorderListItem;
    readonly setDescription: typeof setDescription;
    readonly setGroupFields: typeof setGroupFields;
    readonly setGroupsAtomic: typeof setGroupsAtomic;
    readonly setItemFields: typeof setItemFields;
    readonly setItemsAtomic: typeof setItemsAtomic;
    readonly setItemQuantity: typeof setItemQuantity;
    readonly setListAuthRules: typeof setListAuthRules;
    readonly setWorkspaceImage: typeof setWorkspaceImage;
    readonly setWorkspaceSlug: typeof setWorkspaceSlug;
    readonly startFresh: typeof startFresh;
    readonly transferOwnership: typeof transferOwnership;
    readonly unarchiveList: typeof unarchiveList;
    readonly unarchiveListGroup: typeof unarchiveListGroup;
    readonly unarchiveListGroups: typeof unarchiveListGroups;
    readonly unarchiveListItem: typeof unarchiveListItem;
    readonly unarchiveListItems: typeof unarchiveListItems;
};
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
export declare const MutationSchema: z.ZodObject<{
    clientID: z.ZodString;
    id: z.ZodNumber;
    name: z.ZodString;
    args: z.ZodObject<{
        accountId: z.ZodNullable<z.ZodString>;
        timestamp_client: z.ZodNullable<z.ZodPipe<z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodDate]>, z.ZodCoercedDate<string | number | Date>>>;
    }, z.core.$loose>;
}, z.core.$strip>;
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
export type EnvelopeParseResult = {
    ok: true;
    mutation: Mutation;
} | {
    ok: false;
    reason: string;
};
/**
 * Parse the wire envelope and split body args off envelope metadata.
 * Does not run the mutator and does not check role — those are
 * `executeServerMutation`'s job. Surfaced so callers (the DO push
 * handler) can do envelope-level pre-checks (e.g. cross-account auth)
 * against a parsed shape rather than re-fishing fields out of raw args.
 */
export declare function parseMutationEnvelope(rawMutation: unknown): EnvelopeParseResult;
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
export type ExecuteResult = {
    ok: true;
    status: 'succeeded';
    outcome: 'applied' | 'stale' | 'gone';
} | {
    ok: false;
    status: 'skipped';
    reason: string;
} | {
    ok: false;
    status: 'unauthorized';
    reason: string;
};
export declare function executeServerMutation(mutation: Mutation, ctxBase: Pick<ServerMutatorCtx, 'store' | 'role' | 'nextVersion'>): ExecuteResult;
/**
 * Client-side mutators registered with Replicache. Wraps each per-mutator
 * `client` to extract envelope metadata into ctx, matching the server's
 * shape. The frontend does NOT enforce `requiredRole` — UI gating is the
 * presentation-layer concern; the server is the security boundary.
 */
export declare const mutators: Record<"archiveListItem" | "unarchiveListItem" | "archiveListItems" | "unarchiveListItems" | "archiveListGroup" | "unarchiveListGroup" | "archiveListGroups" | "unarchiveListGroups" | "setListAuthRules" | "initList" | "initFromTemplate" | "mintFromBlank" | "transferOwnership" | "reorderListItem" | "reorderListGroup" | "acceptInvitation" | "archiveList" | "unarchiveList" | "cascadeArchiveList" | "cascadeRestoreList" | "changeMemberRole" | "removeMember" | "claimEntity" | "createWorkspace" | "leaveMember" | "createListItem" | "inviteByIdentity" | "revokeInvitation" | "moveList" | "renameList" | "renameWorkspace" | "setDescription" | "setGroupFields" | "setGroupsAtomic" | "setItemFields" | "setItemsAtomic" | "setItemQuantity" | "setWorkspaceImage" | "setWorkspaceSlug" | "startFresh", (tx: WriteTransaction, args?: ReadonlyJSONValue) => MutatorReturn>;
/**
 * Backwards-compat re-export. The pages app imports from
 * `$djibb/list/mutators/client`.
 */
export { mutators as ClientMutators };
