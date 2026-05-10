# ADR 0006: Tag websockets with clientID for per-mutation outcome routing

- **Status:** Accepted
- **Date:** 2026-05-10

## Context

ADR 0005 commits to a per-mutation outcome channel from server to client
carrying `auth | stale | gone | ok` per `(clientID, mutationID)`. The
client uses these events to decide which toast to render after an
inverse fires (`Cmd+Z` → "couldn't undo, your permissions changed" vs
"…the list/item changed since you made the change" vs "…that item no
longer exists"). The model is **per-tab**: outcomes for clientID `C`
must reach the tab that owns `C`, and only that tab. Two tabs of the
same account on the same list each have their own clientID and their
own undo stack; cross-tab leakage breaks the model.

The current websocket layer in the DO does not support this:

- **`handleWebSocket`** (`workers/src/list/durable_object.ts:646`)
  accepts an upgrade and calls `this.ctx.acceptWebSocket(server)`. No
  application-level identity is associated with the socket. The DO does
  not know which Replicache client this websocket belongs to.
- **`poke()`** (`durable_object.ts:783`) is the only outbound traffic.
  It calls `this.ctx.getWebSockets()` and broadcasts the fixed string
  `'pull pls'` to every attached socket. Many-to-many fan-out, no
  routing.
- **`clientID`** is a Replicache-protocol concept that the DO sees
  only inside `pushRequest.mutations[].clientID` (line 422), used to
  look up a persisted `ReplicacheClient` record for mutation-id
  tracking. It is not associated with any websocket.

The client side opens its websocket via `pages/src/lib/websocket.js` →
`partysocket.WebSocket(url)` with the URL `?l=<entity_id>` only. The
upgrade carries entity ID but no client identity.

The push transport (HTTP push) and the websocket transport (server →
client poke) are two separate paths into the same DO that have never
been correlated. To deliver an outcome event to the originating client
of a specific mutation, that correlation needs to exist.

## Decision

### Tag websockets with clientID at accept time

The client includes its Replicache `clientID` in the websocket upgrade
URL as a query-string parameter `?c=<clientID>`. The DO parses it in
`handleWebSocket`, validates the format, and calls
`this.ctx.acceptWebSocket(server, [clientID])`. Cloudflare's
hibernatable websocket API stores the tag against the socket; the
runtime owns the lifecycle, including across hibernation cycles.

To deliver an outcome event for mutation `M` from client `C`, the DO
calls `this.ctx.getWebSockets(clientID)` and sends the message to all
matching sockets (typically one; transiently multiple during reconnect,
which is harmless — dead sockets drop on send and the runtime reaps
them).

This is **Cloudflare-native unicast**: no manual `Map<clientID, WebSocket>`
in DO state, no broadcast-and-filter wasted bandwidth, no special
handling for hibernation. The runtime's tag/attachment system is the
source of truth for the mapping.

### Query-string `?c=`, not first-message handshake

The client puts `clientID` in the upgrade URL alongside the existing
`?l=`:

```
ws[s]://.../<list|template>/websocket?l=<entityId>&c=<clientID>
```

Single-letter parameter for symmetry with the existing `?l=`. The
parser binds it to a longhand local variable
(`const clientID = url.searchParams.get('c')`) so codebase greps for
`clientID` find the parse site naturally.

The DO validates `clientID` against a regex matching Replicache's
nanoid-shaped identifier format before attaching as a tag — guards
against log injection and accidental garbage. Format-invalid `c` is
treated as missing (see "accept untagged" below), not as a hard reject.

A first-message handshake (open eagerly, send `{type:'hello', clientID}`
as the first frame, server promotes from pending to attached) was
considered and rejected: clientID isn't sensitive, the async await is
short, and the handshake adds protocol surface for benefits that don't
apply at this scale.

### Wire format moves to typed JSON for both directions

The existing `'pull pls'` plain string is migrated to a typed JSON
envelope. New envelope:

```ts
type ServerToClientFrame =
  | { type: 'poke' }
  | { type: 'mutation_outcome'; mutationID: number; status: 'auth' | 'stale' | 'gone' };
```

The client branches on `frame.type` rather than string equality. The
existing constant in `workers/src/websocket/constants.ts`
(`WS_MESSAGE_PULL_PLS`) gets retired in favor of typed message
constructors.

`status: 'ok'` is **not** part of this envelope. Per ADR 0005, the
common case (mutation succeeded) is implicit — the client infers
success from cache convergence, not from an explicit acknowledgment.
Only failure outcomes flow over the channel. This keeps outcome
traffic rare-by-construction even though the channel exists.

Migration is in one PR, server and client together. The wire format
break is internal (no third-party clients) and the deploy is atomic
per environment.

### `poke()` stays broadcast

Pull-poke remains many-to-many: every websocket on the entity gets
`{type: 'poke'}` when state changes. The new tag mechanism is used
only by the per-mutation outcome channel.

The optimization "only poke the clients that haven't seen the new
version" is theoretically possible with tags but doesn't earn its
keep — pull-poke is already trivially cheap (clients pull on receive,
no-op if nothing has changed) and unicast routing would require
tracking per-client `lastModifiedVersion` against a moving target.
Out of scope.

### Backwards compatibility: accept untagged upgrades

A websocket upgrade with no `?c=` parameter (or an invalid one) is
accepted untagged. The socket attaches normally, receives broadcast
pokes, and is silently invisible to outcome routing.

Rationale:

- **Deploy window.** During rollout, old clients still connect without
  `?c=`. Rejecting them would break the page until refresh; accepting
  them keeps pull-poke working. Outcome events silently don't reach
  them — not a regression, since they had no outcome consumer before
  the rollout anyway.
- **Future non-Replicache consumers.** If anything ever attaches a
  websocket to the DO that isn't a Replicache client (a server-side
  monitor, a different protocol layer), it can omit `?c=` and still
  receive pokes. Progressive enhancement.

The "accept untagged" posture means clientID-tagging is a *capability*,
not a *requirement*. Clients that supply it get outcome routing;
clients that don't get the existing pull-poke behavior unchanged.

### Client-side: await Replicache's clientID before opening

Replicache's `client.clientID` is `Promise<string>` — minted on first
run or restored from IndexedDB. The websocket open path awaits it:

```js
const replicacheList = initList({ accountId, listId });
const clientID = await replicacheList.client.clientID;
const ws = initWebsocket(listId, clientID);
```

The await is brief (single tick after Replicache initialization). The
existing `$effect` in `+page.svelte` becomes async-aware. Cleanup
ordering is unchanged — the cleanup still runs on `$effect` teardown.

## Pros and cons against alternatives

### What tag-at-accept wins (vs broadcast + client-side filter)

- **Bandwidth proportional to failures, not viewers.** Broadcast
  routes every outcome to every viewer; with N viewers and one bad
  inverse, N copies fly. Unicast sends one.
- **No data leakage between tabs of the same account.** With
  broadcast-filter, all tabs see all outcome events with all clientIDs.
  Filtering is correct but the data was visible in transit. Unicast
  doesn't deliver it in the first place.
- **Honesty.** A `mutation_outcome` event arriving on a websocket means
  "this is for you." Filtering "is this for me?" is the kind of
  client-side discipline that drifts.

### What broadcast + filter would have won

- **Zero new server infrastructure.** No tag at accept, no parameter
  parsing, no async-await on the client.
- **Works for clients that omit `?c=`.** They could still filter on
  the broadcast.

The bandwidth and leakage costs are concrete and grow with viewer
count; broadcast-and-filter's win is "less code today." Cloudflare's
tag API makes the unicast path nearly as cheap as broadcast, so the
"less code" advantage is small.

### What in-DO `Map<clientID, WebSocket>` would have won (vs Cloudflare tags)

- **Nothing.** Manual maps don't survive DO hibernation cleanly,
  require manual lifecycle code on attach/close, and duplicate what
  the runtime already provides. Strictly dominated.

### What first-message handshake would have won (vs `?c=` query string)

- **Identity not in URL.** clientID stays out of logs, browser
  history, Referer headers.
- **Late-bound identity.** Useful if clientID isn't known at upgrade.

clientID isn't sensitive, Replicache's clientID is essentially
synchronous after init, and validation can happen at upgrade time. The
handshake's benefits don't apply at this scale.

### What keeping `'pull pls'` plain would have won

- **No wire format break.** Existing client and server keep working
  unchanged.

The string-vs-JSON inconsistency would persist forever; outcome events
would need their own wire format anyway, so the inconsistency is
load-bearing. One-PR migration removes the inconsistency at
near-zero cost.

## Consequences

**Positive:**

- B.1's PR shape is clear: server tags + emits, client awaits + parses.
  No spike-driven uncertainty.
- The runtime's tag/attachment system handles hibernation,
  reconnection, and multi-tab routing without application code.
- Wire format is typed JSON with a discriminated union — extends
  cleanly when ADR 0003's "future event-bus fan-out" lands more event
  types.
- Outcome traffic is rare by construction (failures only), so the
  channel doesn't grow proportionally with mutation volume.

**Negative:**

- The websocket open path on the client becomes async. Trivial in
  practice (one `await`) but a discipline to enforce at every websocket
  call site if more get added.
- During deploy, old clients don't get outcome routing until they
  refresh. Acceptable per the "accept untagged" posture but worth
  flagging in the rollout plan.
- A clientID supplied in a query string is mildly more visible than
  one in a message body. Not sensitive in this codebase; could be
  revisited if the threat model changes.
- The mapping `clientID → WebSocket` is implicit (held by the runtime)
  rather than explicit (held by application code). Debugging an
  outcome-routing miss requires checking what tags a socket actually
  has via `getWebSockets(...)`, not a local variable.

## Alternatives considered

- **(a) In-DO `Map<clientID, WebSocket>` registry.** Manual lifecycle,
  doesn't survive hibernation, duplicates the runtime's tag system.
  Strictly dominated.
- **(b) Broadcast + client-side filter.** Simpler server, but
  bandwidth scales with viewer count and outcome events are visible
  cross-tab in transit. Acceptable at low viewer counts; rejected on
  the principle that the unicast path is essentially free.
- **(c) First-message handshake.** Identity in a message body rather
  than URL. Benefits don't apply at this scale; rejected for protocol
  simplicity.
- **(d) Custom HTTP header on upgrade.** Browsers don't reliably allow
  custom headers on websocket upgrades. Rejected on practicality.
- **(e) Keep `'pull pls'` plain, add JSON only for outcomes.** Mixed
  wire format leaves a permanent inconsistency. Rejected for the
  one-PR migration.
- **(f) Reject untagged upgrades.** Hard cutover during deploy
  window; breaks old clients until refresh. Rejected for the standard
  graceful-deploy posture.
- **(g) Emit `status: 'ok'` events explicitly.** ADR 0005 already
  treats the common case as implicit; explicit `ok` events would
  flood the channel for no client benefit.
- **(h) Per-tag pull-poke routing.** Possible but doesn't earn its
  keep; pull-poke is already cheap. Out of scope.

## Open questions

- **clientID validation regex.** Replicache's clientID format is
  documented as nanoid-shaped (~20 chars, URL-safe alphabet) but the
  exact pattern lives in Replicache internals. Pin the regex at
  implementation time and expose it as a constant alongside other
  validation patterns.
- **Outcome events with no recipient.** A mutation completes, the
  outcome is for clientID `C`, but `C`'s websocket isn't attached
  (initial-load race, tab closed mid-flight). Current decision: drop.
  Buffering doesn't earn its keep until evidence emerges.
- **Multiple websockets for one clientID.** Theoretically possible
  during reconnect. Current decision: send to all matches; dead
  sockets drop on send. If a leak is observed, narrow to a
  most-recent-only policy.
- **Symmetry for the non-list DO.** This ADR is written against
  `workers/src/list/durable_object.ts`. Other DOs (account, workspace)
  may eventually grow per-client outcome channels too; the same
  pattern applies. Not in scope here.

## References

- ADR 0003 — DO as authority. The mutation log lives in the DO; this
  ADR builds on its push handler.
- ADR 0005 — Undo via paired forward+inverse mutators. Defines the
  outcome channel this ADR routes.
- `workers/src/list/durable_object.ts` — current websocket attach and
  poke paths.
- `pages/src/lib/websocket.js` — current client websocket open path.
- `pages/src/routes/l/[id]/+page.svelte` — current websocket consumer
  in the route.
- `workers/src/websocket/constants.ts` — current `'pull pls'` string
  constant; retired by this ADR.
- Cloudflare Durable Objects — hibernatable websocket API:
  `acceptWebSocket(ws, tags)` and `getWebSockets(tag)`.
  https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
