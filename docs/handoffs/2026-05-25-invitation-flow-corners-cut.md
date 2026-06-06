# Corners cut during ADR 0009 E2E shakedown — 2026-05-25

Hand-off note for the next pass on the invitation flow. While
getting `e2e/entity-invite.sh` to green we surfaced a stack of
intermediate-state edges that we patched in the shortest way that
worked. None of them are pure test-artifacts; all of them are
real-user behavior — just behavior that humans haven't reported
because the failure windows are sub-second.

These corners shrink (or vanish) once the deferred ADR 0009 pieces
land: in-app pending-invite inbox, "shared with me," and the
`account_authorizations` D1 derived index. Document them now so the
cleanup is mechanical when we get there.

## Real bugs squashed along the way (not corners)

Two of the fixes shipped in this arc aren't corners — they're
unambiguous latent bugs that the E2E surfaced. Both have impact
beyond the invitation flow.

### A. `_handlePull` cookie shape was rejected by Replicache V1

**Where:** `workers/src/replicache/keyspaces.ts` — `encodePullCookie`.

**Was:** Our pull responses returned `cookie: {v: number, r: AuthorizationRole | null}`.
Replicache's V1 protocol validator (`en()` in the bundled
`replicache/out/chunk-*.js`) accepts object cookies only when they
have an `order` field of type `string | number`. With no `order`,
every pull response failed the puller validator and was discarded
with `Invalid puller result`.

**How it presented:** Owners' apps "worked" because their **first**
pull (request cookie = `null`) was valid, the data landed in IDB,
and the UI rendered from there. Every subsequent pull silently
failed — so any incremental change from another client wouldn't
sync until the client reloaded and replayed the full pull from v0.
For invitees the failure was louder: post-accept they need a
re-pull to see the role-promoted view, and that re-pull never
landed because the validator rejected it.

**Now:** `encodePullCookie` adds `order: cookie.v` to the encoded
shape. Wire-only field; the parser ignores extras. Replicache
accepts the cookie and incremental sync works as designed.

**Worth re-checking elsewhere:** any code path that relies on
incremental pull (live updates from other clients, undo redo with
server reconciliation) was effectively running with a degraded
"every-pull-is-from-scratch" cookie. That's now fixed but it's
worth a second look at performance/behavior in places we'd have
assumed cookie-based diffing was working.

### B. Missing `+page.js` for share routes — original bug

**Where:** `pages/src/routes/l/[id]/share/+page.js`,
`pages/src/routes/t/[id]/share/+page.js` (new files).

**Was:** Both share routes read `data.list_id`, but SvelteKit
doesn't propagate parent `+page.js` data to child routes (only
`+layout.js` does). So `data.list_id` was undefined and
`initList()` threw `Missing List Id!` silently inside the mount
`$effect`, wedging the page on "Loading list…" indefinitely.

**Now:** Both share routes have their own `+page.js` that
reconstructs the prefixed entity ID from `params.id`, mirroring
the parent route pattern.

**This was the original symptom that kicked off the whole arc** —
documented under a separate handoff note that was deleted once
fixed. Listed here for the record.

## Map of corners

### 1. `sessionState.hasLoaded` gate on entity-route effects

**Where:** `pages/src/lib/session.svelte.js` (new flag),
`pages/src/routes/l/[id]/+page.svelte`,
`pages/src/routes/t/[id]/+page.svelte`,
`pages/src/routes/l/[id]/share/+page.svelte`,
`pages/src/routes/t/[id]/share/+page.svelte`.

**Was:** Page-level `$effect` fired immediately on mount with
`sessionState.currentAccountId === null` (session fetch hadn't
resolved yet from the layout's `onMount`). The first call to
`initList()` therefore opened a Replicache client named
`null:<entityId>`, pushed `initList` with `accountId: null`, and
the server happily created an **ownerless entity**. Session would
then resolve, the effect would re-fire, and a second Replicache
client would open under the real account name — but the entity
on the server was already wrong.

**Now:** Page effects bail out early until `hasLoaded` flips true
(after the first `fetchSession()` completes, success OR 401).

**Cleanup path:** Move session into a `+layout.js` universal load
so it's available before any page effect runs. The flag becomes
moot. Probably the right move whenever Workspace-as-DO lands.

### 2. `hasLoaded` gate on InviteBanner render

**Where:** `pages/src/routes/l/[id]/+page.svelte`,
`pages/src/routes/t/[id]/+page.svelte` — the `{#if … from_invite ===
'1' && sessionState.hasLoaded}` guard.

**Was:** A magic-link-redirected invitee landed on
`/l/<id>?from_invite=1` and saw the **wrong banner variant** for
~200ms — `sessionAccounts.length === 0` was momentarily true while
the layout's session fetch resolved, so the "Sign in to accept"
link rendered before flipping to "Accept as you@…".

**Now:** Banner doesn't render until `hasLoaded` is true. Briefly
no banner, then the correct banner.

**Cleanup path:** Same as #1 — universal session load removes the
race.

### 3. `skipClientInit` flag on `initList()` for `?from_invite=1`

**Where:** `pages/src/lib/replicache/index.svelte.js` (the new
option), plumbed through both `l` and `t` entity routes.

**Was:** Per the design principle "fire `initList` on local empty
because ID collisions are rare," an invitee with an empty IDB
(fresh account = fresh IDB even for an existing entity) fired the
optimistic `initList` client mutator. That writes the invitee as
owner into local Replicache state. `alreadyAuthorized` derived
`true`, the InviteBanner hid itself, and the server-side 403 +
eventual pull reconciliation didn't reliably flip the banner back
on. End result: the Accept button was unreachable.

**Now:** When the URL carries `?from_invite=1` we tell `initList()`
to skip the local empty-fires-init shortcut. The entity is known
to exist; we just wait for pull.

**Cleanup path:** Once the pending-invite-aware client state
(see below) lands, the InviteBanner's `alreadyAuthorized` can
derive from confirmed server state instead of local mutated state
— or the page can know it's in "pending-invite" mode from data,
not from a URL param, and the optimistic init gets gated naturally.

### 4. Worker websocket handler accepts upgrades pre-init

**Where:** `workers/src/list/fetch.ts` — the `app.get('/websocket')`
handler.

**Was:** `if (!c.get('entity')) throw new NotFoundError()`. The
share/list page mounts Replicache and opens the websocket in the
same `$effect`. On a fresh ID the WS upgrade raced the `initList`
push, partysocket retried 4-5 times before the D1 row landed, and
those failed handshakes flooded CDP enough to wedge agent-browser
(and noised up the network panel for real users).

**Now:** Mirrors `/push`'s pre-init posture — when `entity` is null
we forward to the DO unconditionally. The DO accepts the upgrade;
once `initList` commits, pokes flow normally over the connection.
No security loss — mutations still go through `/push` with its own
gates.

**Cleanup path:** Probably stays. This is the architecturally
correct shape (DO is the connection authority; D1 is a derived
index used as a fast-path). The handler's "fast-path role check"
remains for the entity-exists branch.

### 5. acceptInvitation client mutator tolerates missing local entity

**Where:** `workers/src/list/mutators/acceptInvitation.ts` — the
client mutator's `if (!raw) return` (was `throw NotFoundError`).

**Was:** An invitee with restricted role couldn't pull (see #6),
so their local IDB had no entity row. When they clicked Accept,
the client mutator's `tx.get(listId)` returned null and it threw
`NotFoundError` before the push could fire.

**Now:** No local entity → skip the optimistic write, return,
let the push proceed. Server has authoritative data; the next pull
(after role promotion) lands the real entity in local state.

**Cleanup path:** Real fix is the pending-invite-aware data shape
— the invitee should have *some* local data (an invitation row,
not the entity itself) so they can act on it without a missing-
entity branch. Once that exists, this branch becomes dead code we
can delete.

### 6. Restricted role can pull

**Where:** `workers/src/list/durable_object.ts` —
`_handlePull` previously threw `UnauthorizedError` for restricted
roles; that check is now elided.

**Was:** Invitees arriving at `/l/<id>?from_invite=1` had role
`restricted` until they clicked Accept. Pulls 403'd in a retry
loop, flooding network events, hiding the entity name in the
InviteBanner, and contributing to the agent-browser CDP wedge.

**Now:** Restricted users can pull the entity. The role-gated
keyspaces (`pending_invites/*`, etc.) still filter what they see.
The per-mutator `requiredRole` gates remain the authoritative
write gate.

**Cleanup path:** This is the *biggest* corner cut. Right now,
anyone with a URL + a session can pull any entity's full
contents — items, names, descriptions. The current shape leans
on URL unguessability (21-char nanoid). For an
invitation-preview tier ("see name and a brief description, but
not items") we'd need a *role-aware pull projection* in
`_handlePull`. ADR 0009 alluded to this; spelling it out as a
follow-up is the right move.

## What the right architecture probably looks like

A pending-invite-aware client state, drawn loosely:

1. Account-level keyspace surfaces `invitations/<entity_id>`
   entries for every pending invite addressed to a verified
   identity of the active account. This is the "invitees inbox"
   piece from ADR 0009.
2. A pending invite carries enough metadata to render an
   invitation card *without* pulling the entity:
   `{ entity_name, entity_description?, role_offered,
   invited_by_account, time_invited }`.
3. The InviteBanner reads from `invitations/<entity_id>` (not from
   URL params) and shows the card *before* any entity pull is
   attempted. `?from_invite=1` becomes a deep-link convenience,
   not a state signal.
4. Clicking Accept fires `acceptInvitation` (server side already
   handles all of this). After commit, the account's role on the
   entity is now `viewer`/`editor`/whatever and the normal pull
   path takes over — no special restricted-pull case needed.
5. Clicking Decline fires a new `declineInvitation` mutator (not
   yet built) that tombstones the pending invite without granting
   access.

That eliminates corners 3, 5, and 6 outright, and makes 1 + 2
redundant once layout-level session resolution lands.

## Adjacent context

- `e2e/entity-invite.sh` is the test that surfaced this whole
  pile. Its top-of-file comment was updated to reflect each layer
  as it was peeled; final state once green is "test passes."
- Magic-link sign-in (ADR 0010) is the canonical entry path; the
  test exercises both inviter and invitee through it.
- Workers vitest suite (294 tests) covers the server-side logic
  for invitations end-to-end. The corners cut here are all on
  the page/client side or in the worker's HTTP boundary, not in
  the DO's mutator semantics.
- A separate, pre-existing DO bug surfaced in worker logs while
  iterating: `webSocketClose` (`workers/src/list/durable_object.ts:1626`)
  calls `ws.close()` on an already-closed socket with code 1006
  (which isn't a valid sendable close code), throwing an Uncaught
  Error in every close handler. Loud in logs, no behavioral
  impact, but worth a one-line fix when convenient.
- Another worker-log oddity, observed once during iteration:
  `processing mutation #1: initList ... Mutation from the past!
  Expected "2" Got "1"` followed by `POST /list/push 500 Internal
  Server Error`. Looks like a mutation-replay/version race when
  an inviter's session re-pushes `initList` alongside
  `inviteByIdentity` in one batch. Didn't block the E2E once the
  upstream layers were sorted, but worth investigating.

## Addendum 2026-06-06 — workspace invitations (ADR 0011 §10d)

Workspace invites now ride the same flow (workspaces are DjibbLists).
Relevant to the corners above:

- **Corner #6 is still open and now also applies to workspaces.** A
  restricted-role caller can still pull an entity's full contents; for
  workspaces the "URL" is a *human-guessable slug*, not an unguessable
  nanoid, which widens the exposure. The pre-membership accept surface
  deliberately does **not** ship a bare slug→id lookup — the
  `/workspace-invite/:slug` resolver
  (`workers/src/workspace/inviteResolver.ts` →
  `ResolveInvitedWorkspaceBySlug`) only answers when the caller holds a
  pending invite. That contains the *discovery* angle but not the
  underlying pull exposure; the real fix is still the role-aware pull
  projection flagged in corner #6.
- The deferred **in-app pending-invite inbox / "shared with me"** (the
  "what the right architecture looks like" section) would subsume the
  slug→id resolver: an inbox entry already carries `entity_id`, so the
  invitee wouldn't need to resolve a slug at all. Until then the
  resolver is the workspace analogue of the `?from_invite=1` deep-link
  entry point.
