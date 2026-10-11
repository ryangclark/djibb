# Can existing mutators and roles express Claims and an identity-free taken ledger?

- **Ticket:** GH #78 (map: GH #76, Secret Santa client, Christmas 2026 v1)
- **Date:** 2026-10-11, against `main` at `46b78d844`
- **Method:** reading source, ADRs and tests in this repo. Nothing was executed:
  no test run, no request against a worker. Every claim marked *verified* was
  read in the cited code; claims marked *inferred* follow from that code but
  were not exercised.
- **Location note:** the repo had no convention for research notes, so this
  starts `docs/research/`.

Paths are relative to the repo root. `mutators/` means
`packages/protocol/src/list/mutators/`, `DO` means
`packages/server-cf/src/list/durable_object.ts`, `sql.ts` means
`packages/server-cf/src/list/sql.ts`, `fetch.ts` means
`packages/server-cf/src/list/fetch.ts`.

## Answer

1. **A per-group Claims entity (identity-bearing, hidden from the giftee) can be
   built today with no core change.** Givers hold `editor` on it, append claims
   with `createListItem`, and the giftee holds no role. The view floor that
   hides it is shipped and enforced.
2. **`checker` is not "check off only" in code.** It is in `EDIT_ROLES` and can
   call every mutator an `editor` can. The narrowing is written down as deferred
   to this build (ADR 0021). So on Claims, any giver can edit, archive or
   reattribute anyone's claim, and archive the whole entity.
3. **The identity-free ledger of ADR 0027 §5 does not exist and cannot be
   assembled from existing parts.** There is no `markTaken`, no per-entity
   mutator allowlist, and no role that reads but has only a narrow write. Every
   role that can write can write free text. The "zero new core code" claim holds
   for Claims and fails for §5 as written.
4. **What the server already gives for free:** nothing in a pull attributes a
   row to an account. Any existing entity is already actor-anonymous to its
   ordinary readers, as far as server-delivered data goes. It is not anonymous
   to its `owner`/`admin`, who can read the mutation log.
5. **Rate limits and the submitter cap do not bite. The invitation caps do.**

## 1. The mutator list and who may call each

The registry holds 41 mutators (`mutators/index.ts:90-132`). Dispatch gates on
one thing only: the caller's resolved role must appear in the mutator's
`requiredRole` (`mutators/index.ts:282-290`), then the args must parse
(`mutators/index.ts:292-299`). There is no other gate between a role and a
mutator.

Role sets (`mutators/_shared.ts`):

| Set | Members | Lines |
|---|---|---|
| `EDIT_ROLES` | admin, **checker**, editor, owner, ownerless | 19-25 |
| `APPEND_ROLES` | `EDIT_ROLES` + submitter | 38-41 |
| `OWNER_ROLES` | admin, owner | 72-75 |
| `SYSTEM_ROLES` | system | 91-93 |

Mutators by gate (each file's `requiredRole` export):

| Gate | Mutators |
|---|---|
| `APPEND_ROLES` | `createListItem` (`createListItem.ts:21`) |
| `EDIT_ROLES` (23) | `initList`, `initFromTemplate`, `mintFromBlank`, `createWorkspace`, `renameList`, `setDescription`, `archiveList`, `unarchiveList`, `setItemQuantity`, `setItemFields`, `setItemsAtomic`, `reorderListItem`, `archiveListItem`, `archiveListItems`, `unarchiveListItem`, `unarchiveListItems`, `setGroupFields`, `setGroupsAtomic`, `reorderListGroup`, `archiveListGroup`, `archiveListGroups`, `unarchiveListGroup`, `unarchiveListGroups` |
| `OWNER_ROLES` (10) | `setListAuthRules`, `inviteByIdentity`, `revokeInvitation`, `changeMemberRole`, `removeMember`, `moveList`, `startFresh`, `renameWorkspace`, `setWorkspaceImage`, `setWorkspaceSlug` |
| `owner` only | `transferOwnership` (`transferOwnership.ts:81`) |
| `ownerless` only | `claimEntity` (`claimEntity.ts:68`) |
| `SYSTEM_ROLES` | `cascadeArchiveList`, `cascadeRestoreList`, `relinquishOwnershipOnPurge` |
| every role | `leaveMember` (`leaveMember.ts:54-55`), `acceptInvitation` (`acceptInvitation.ts:65-66`) |

What the three roles in the question can actually do:

- **`editor`**: all 24 append and edit mutators. Cannot change membership.
- **`checker`**: exactly the same 24. *Verified:* the only places `checker`
  appears in non-test source are the enum, `EDIT_ROLES`, the owner-succession
  order and the readable-roles set; nothing narrows it. `CONTEXT.md:49` and the
  ADR 0021 table (`docs/adr/0021-role-gated-reads-and-read-write-role-lattice.md:62`)
  describe the intended role, not the built one. ADR 0021 says so itself: the
  role "is currently latent, in `EDIT_ROLES`, so indistinguishable from
  `editor`", and the narrowing "is deferred to the Secret Santa build"
  (same file, lines 101-106).
- **`submitter`**: `createListItem` only, and cannot read (below the view
  floor). It is not grantable to an account: `AccountRoleEnum` is admin,
  checker, editor, owner, viewer (`packages/protocol/src/auth/rules.ts:46-52`).
  It is reachable only as an entity's `default_role`
  (`rules.ts:82-92`), so it means "anyone who is not a listed member".

Two consequences worth stating plainly:

- `archiveList` is in `EDIT_ROLES` on purpose (`archiveList.ts:16-22`). Any
  giver on a Claims entity can archive the whole entity, which starts its
  30-day hard-delete clock.
- No mutator creates a group inside an existing entity. Groups are written only
  at creation, by `initList` (`initList.ts:172-174`) and `mintFromBlank`
  (`mintFromBlank.ts:134`). A Claims design that wants "one group per wishlist
  item" or "one group per giver" cannot add groups later. This also touches
  wishlist categories, which is outside this ticket.

## 2. Can Claims be built from existing mutators?

Yes. The pieces:

**Creating it hidden.** `initList` by a signed-in account yields the creator as
`owner` and `default_role: 'restricted'` (`initList.ts:97-112`). That is the
shape ADR 0027 wants, with no extra step. (`defaultRole` and `slot` on
`initList` are operator-only, `initList.ts:128-132`; the client does not need
them.)

**Membership.** `setListAuthRules` is a whole-replace of the rules by
owner/admin (`setListAuthRules.ts:24-26, 50, 74-78`), so the organizer can
write the roster directly given account ids. `inviteByIdentity` invites by
email.

**The claim row.** An item has these fields and no others: `description`, `id`,
`name`, `parent_element_ref`, `references_entity_id`, three timestamps, `type`,
`value`, `version` (`packages/protocol/src/list/index.ts:307-324`). There is no
`meta` bag on items (it exists on entity rows only, `index.ts:129`) and no
account column in storage (`sql.ts:569-588`).

- **Pointer to an item in another entity.** `references_entity_id` is
  `z.string().nullable()` with no prefix or format check, in the schema
  (`index.ts:317`), in `setItemFields` (`setItemFields.ts:28`), and at the SQL
  write (`sql.ts:1747-1770`, `sql.ts:1509-1512`). The rule in `CONTEXT.md:25`
  that only `l/` and `t/` ids are valid targets is documentation; code does not
  enforce it. So there are three workable encodings:
  1. Doc-compliant: `references_entity_id` = the wishlist's `l/…` id, and the
     target item id carried in `name` or `description`.
  2. Code-permitted but against `CONTEXT.md`: `references_entity_id` = the
     wishlist item's `item/…` id. *Inferred risk:* djibb.com renders this field
     as an entity link (`apps/djibb-com/src/lib/components/List.svelte:695-696`),
     so a generic client would show a broken link.
  3. No pointer field at all: give the claim row the same `item/…` id as the
     wishlist item it claims. Ids are client-chosen and unique per DO only
     (`sql.ts:570`), and `insertListItem` is `INSERT OR IGNORE`
     (`sql.ts:1747-1749`). *Inferred, not tested.* This gives one claim per
     wishlist item, so it does not fit items several givers buy toward.
- **Claimed-by.** No field holds it. It has to go in `name` or `description` as
  text. It is client-asserted: any writer can put any name there, and the server
  checks nothing. The only server-attested record of who acted is the mutation
  log (section 3), readable by owner/admin.

**Marking.** `setItemQuantity` on the claim row (`setItemQuantity.ts:14-28`), or
appending a row per claim. Both work.

**A defect to design around.** *Verified by reading:* `insertListItem` writes
`id, name, parent_element_ref, references_entity_id, time_created,
time_updated, type, value, version` and omits `description`
(`sql.ts:1747-1770`). `createListItem` passes the whole item to it
(`createListItem.ts:43`). So a `description` sent with `createListItem` is kept
by the optimistic client write and dropped by the server; the next pull blanks
it. A claim that carries data in `description` needs a following
`setItemFields`, or should use `name`.

**Trust level of the result.** Because `checker` equals `editor`, Claims built
today is a fully collaborative list among givers: any giver can alter, reassign
or archive any claim. That is the party-grade level ADR 0027 already accepts
("acceptable for a gift game, not a vault",
`docs/adr/0027-read-secrecy-via-entity-decomposition.md:97-100`), but the map
should record it as a choice.

**One placement rule the client must obey.** Role resolution is: explicit grant,
then workspace membership, then `default_role`
(`packages/server-cf/src/auth/resolver.ts:61-74`). If Claims sits in a workspace
the giftee is a member of, the giftee resolves to their workspace role and reads
it. An explicit entry cannot push them below the floor, because `restricted` is
not an account role (`resolver.ts:46-53`). Claims must live in a workspace the
giftee does not belong to.

## 3. What the server stores about who acted, and who can read it

| Stored | Where | Delivered to other members? |
|---|---|---|
| Account id per mutation, credential id, mutation name, full body args, client and server timestamps, client id | `mutations` table, `sql.ts:601-612`; written at `sql.ts:1972-2018` | Only through `GET /audit`, gated to owner/admin (`fetch.ts:259-263`). Not in pulls. |
| Account id on element rows | none: `list_elements` has no account column (`sql.ts:569-588`) | n/a |
| `time_created`, `time_updated`, `version` on each row | `list_elements` | Yes, in every reader's pull (`DO:604-616`). `time_created` on an item is client-supplied (`sql.ts:1764`); `time_updated` is server time on edits (`sql.ts:1517`). |
| Client group to account link | column exists (`sql.ts:632-637`) but is always written `null` (`DO:1083-1087`, `sql.ts:2154-2165`) | No |
| Per-client last mutation id | `replicache_clients`, `sql.ts:640-646` | Only for the client group id named in the request (`DO:499-527`) |
| Member roster with roles | `authorization_rules` on the entity row | Yes, to every reader: the pull emits the entity row whole (`DO:604-616`) |
| Pending invites (emails, inviter id) | `pending_invites/*` keyspace | owner/admin only (`packages/server-cf/src/list/pull.ts:29-42`) |

A pull is built from `SELECT * FROM list_elements WHERE version > ?`
(`sql.ts:421-430`) and each row is emitted as-is (`DO:604-616`).

**So, is any existing entity anonymous to its readers?** For `viewer`, `checker`
and `editor`: yes, in the sense that the server sends them nothing saying which
account wrote a row. What they do get is the roster (who could have), timestamps
(when), and whatever text a writer chose to put in the row. For `owner` and
`admin`: no. The audit log names the account on each mutation.

Two qualifications on the audit log. The envelope `accountId` is optional: the
server only checks that, if present, it is one of the caller's accounts
(`DO:1427-1432`), so it can be null for a signed-in caller. `credential_id` is
server-resolved (`fetch.ts:542-544`), and an off-domain client always acts
through a credential, so its mutations are attributable to an account
regardless. *Inferred* from those two facts.

## 4. Is there a per-entity restriction of the mutator set?

No. *Verified:* dispatch reads `requiredRole` from the mutator and the role from
the request (`mutators/index.ts:260-290`, `DO:1481-1490`); nothing consults the
entity. The only per-entity lever is which role each member holds on that
entity, and the available write bundles are "everything" (`editor`/`checker`),
"append only and blind" (`submitter`, as a default role), and "nothing"
(`viewer`).

That means ADR 0027 §5's guarantee, "even a malicious client cannot inject who"
(`0027…md:110-118`), is not available today:

- A ledger whose members are `editor`/`checker` lets each of them call
  `setItemFields` with any `name` or `description`.
- A ledger with `default_role: 'submitter'` lets anyone append a full item with
  free-text `name` (`createListItem.ts:11-13`), and submitters cannot read it,
  which defeats a ledger whose purpose is to be read.
- `setItemQuantity` has no name or description field, but `QuantitySchema.unit`
  is a free string (`index.ts:259`), so it is not strictly identity-free either.

`docs/creating-a-client.md:232-236` forbids a client-specific mutator gate and
says a need for one "is actually a protocol change, write the ADR first".

### Options for the shared taken ledger, smallest first

**A. No core change: anonymity by first-party convention.** Ledger members are
`editor`; the client writes taken marks with `setItemQuantity` and never writes
identity. The server delivers no actor identity to those readers (section 3).
The residual risk is a modified client writing a name into a row, or vandalising
it. ADR 0027 rejected "anonymity by client convention" (`0027…md:253-255`), so
choosing this is a recorded departure from §5, defensible for two known
families and a first-party client.

**B. No core change: a service identity is the only writer.** Members are
`viewer`; the client's own backend, acting as an issued-credentials account,
writes taken marks. This is ADR 0027's vault-grade model (`0027…md:101-106`).
It needs a client backend, which the map does not currently assume.

**C. Small core change: do the deferred `checker` narrowing.** Remove `checker`
from `EDIT_ROLES` (`_shared.ts:19-25`) and add it to `setItemQuantity`'s gate
only, as ADR 0021 already specifies (`0021…md:101-106`). Ledger members hold
`checker`; the owner pre-creates one row per wishlist item. To make it strictly
identity-free, `setItemQuantity` should also, for a `checker`, accept a change
to `value` only. Cost: one constant, one mutator's gate and a guard, tests, and
the `CONTEXT.md` and ADR 0021 status lines. It changes behaviour for any
existing `checker` grant; *not checked* whether production has any. It needs a
writer with `editor` or above to mirror wishlist items into the ledger.

**D. Core change as §5 literally describes: add `markTaken`.** A new mutator
file with args `{ item_ref }`, registered in `Mutations`, following
`docs/adding-a-mutator.md`. It only delivers the guarantee together with C,
because without the narrowing a writer can still call `setItemFields`. What it
adds over C: create-if-absent keyed by the reference, so nobody has to pre-seed
rows, and no `unit` string. For the guarantee to hold the server should derive
the row id from `item_ref` and stamp its own time, since a client-chosen id or
timestamp is a side channel.

In C and D the ledger's owner/admin still sees the account on each mutation in
the audit log (section 3). Full anonymity there needs the owner to be a service
identity, or further core work to keep the account out of the log for that
mutator.

ADR 0027 itself lists "full multi-group cross-registry dedup" as out of scope
for its v1 (`0027…md:235-237`) and says a cross-group ledger has no natural
human owner (`0027…md:211-216`). The map (#76) puts shared taken-ness across
groups in the client's v1, so the choice among A to D is a real open decision.

## 5. Rate limits and the live-item cap

- **Request rate limit: does not bite.** *Verified:* 600 requests per 60 s per
  signed-in account (`packages/server-cf/wrangler.toml:44-47`), charged only on
  `/push` and `/websocket` (`fetch.ts:135-164`); pulls are not counted. A push
  carries a batch of mutations as one request. *Inferred:* a giver whose client
  opens 15 wishlists, 15 Claims entities and a ledger spends about 31 websocket
  upgrades at load. The anonymous cap of 60 per minute per IP
  (`wrangler.toml:39-42`) does not apply to signed-in members.
- **Submitter live-item cap: does not apply.** The 5000-item ceiling
  (`_shared.ts:61`) is checked only when the caller's role is `submitter`
  (`createListItem.ts:35-42`, `sql.ts:401-416`). Claims members are `editor` or
  `checker`.
- **Invitation caps: these do bite.** Per inviter, across all entities: 10
  invitations per hour and 25 outstanding
  (`packages/server-cf/src/list/invitations.ts:302, 310, 404-425`). A giftee
  inviting a dozen relatives to a wishlist hits the hourly cap; an organizer
  inviting a family to one Claims entity per giftee hits both. Two existing ways
  around it: `setListAuthRules` writes the roster directly and has no preflight
  (`DO:124-130` lists the preflighted mutators; it is not among them), and
  workspace membership grants a role on every entity in the workspace with one
  invite per person (`resolver.ts:61-74`), subject to the placement rule in
  section 2.

## 6. Is the view floor enforced for `restricted`?

**On pull: yes.** *Verified in code and covered by tests.*

- The role is resolved server-side from the entity's rules on every request
  (`fetch.ts:186-217`) and passed into the DO (`fetch.ts:418-424`).
- `canRead` admits owner, admin, editor, checker, viewer, ownerless and system;
  `restricted` and `submitter` are excluded (`resolver.ts:203-221`).
- `_handlePull` emits content only when `canRead` is true, emits `del` for every
  key on demotion, and otherwise emits nothing (`DO:562-636`).
- `GET` on the entity returns 404 below the floor (`fetch.ts:219-225`,
  `resolver.ts:251-254`).
- Tests: `packages/server-cf/test/viewFloor.test.ts:177-201` (restricted and
  submitter get no content keys), `:226-262` (demotion evicts, promotion
  full-syncs). These call the DO's `handlePull` with a role; the HTTP path was
  read, not run.

ADR 0027's "hard prerequisite" line that a restricted member "still reads
everything today" (`0027…md:201-203`) is stale. So is gap 1 in
`docs/creating-a-client.md:258-265`, as the map already notes.

**On the websocket: there is no role gate, and none is needed for content.**
`GET /websocket` forwards to the DO for any caller (`fetch.ts:574-595`), and the
DO accepts without a role check (`DO:1675-1768`). The only broadcast frame is
`{ type: 'poke' }` with no payload (`DO:2391-2401`,
`packages/protocol/src/websocket/constants.ts:82`). The poked client then
pulls, and the pull applies the floor. Per-mutation outcome frames go only to
sockets tagged with the originating client id (`DO:2415-2437`).

Residual signals a `restricted` principal can get, all of which require already
knowing the hidden entity's id (a 21-character random suffix,
`packages/protocol/src/id/index.ts:4`, which the wishlist never carries):

- **Existence.** `/pull` returns 200 for an entity that exists and 404 for one
  that does not (`fetch.ts:400-401`), where the plain `GET` hides existence.
- **Activity count.** The pull cookie returned to a below-floor caller carries
  the entity version (`DO:656-659`), which rises by one per applied mutation
  (`DO:1162, 1241-1242`).
- **Activity timing.** An open socket receives a poke on every push
  (`DO:1366`).
- A socket is tagged with whatever client id the caller supplies
  (`DO:1753-1759`), so outcome frames are private only while client ids stay
  secret. They carry a mutation id and a status, never content.

None of these leaks content or identity. *Inferred:* they matter only if the
client or a member reveals a Claims id to the giftee.

## Other things the map should know

- **Owner purge.** If the Claims owner's account is purged, ownership passes to
  the most senior remaining admin, then editor, then checker; the entity turns
  world-readable `ownerless` only when no such member remains
  (`_shared.ts:419-423, 486-499`). With givers as `editor`, the orphan hazard in
  ADR 0027 (`0027…md:204-210`) does not arise while one giver remains.
- **Roster visibility.** Every reader of an entity sees every member's account
  id and role (section 3). On the wishlist, the giftee sees who their givers
  are. On a cross-group ledger, strangers from each group see each other's
  account ids.

## Verified versus inferred

Verified by reading the cited code: the mutator and role tables; `checker` equal
to `editor`; absence of any per-entity mutator gate; the item schema and the
missing validation on `references_entity_id`; storage columns and what a pull
emits; the audit gate; the rate-limit and cap constants and where they are
charged; the view-floor gate on pull and the ungated, payload-free websocket;
`description` omitted from `insertListItem`.

Inferred, not exercised: the same-id join for claims; the per-load request
arithmetic; attributability through `credential_id`; the practical weight of the
existence, count and timing signals; behaviour of a generic client shown a
non-entity `references_entity_id`.

Not checked: whether any production entity grants `checker` today; the
workspace-level invitation path and its caps; D1 projection lag between a
membership change and the next role resolution.
