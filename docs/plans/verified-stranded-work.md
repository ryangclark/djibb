# Verified stranded work — make the store, not the ledger, the authority

> Follow-up to GH #46 / PR #47, which shipped the disclosure
> (`StrandedWorkBanner`: *"Another account has unsaved changes on this
> list"*). That banner is driven by `strandedClaims`, i.e. by the
> **ledger**. The ledger is a guess, and this plan is about replacing the
> guess with the fact that is sitting on disk the whole time.
>
> Not an ADR: no architectural decision is being reversed. The ledger's
> role narrows — from *the thing we assert* to *the thing that tells us
> where to look* — and that narrowing is the whole plan.

## The problem #47 left behind

The ledger over-claims **by construction**, and that is not a defect to
be fixed at the source. Claims are stamped *synchronously, before* each
mutation fires (`wrapMutators`), because stamping afterwards leaves a
window in which a mutation is durable but unclaimed — a tab closed in
that window strands it forever. Under-claiming costs data; over-claiming
costs a store name. We over-claim, and we should keep over-claiming.

The trouble is what #47 then does with a claim: it **shows it to a
human**. And a claim can outlive its work —

- the tab died between the stamp and the mutate;
- a push landed before the tracker observed the drain;
- a `discardUnflushed` timed out, kept the claim (correctly — the work
  was still there), and the blocked `deleteDatabase` landed later once
  the other tab closed.

A stale claim can only be retired by a client **acting as the
claimant** (that's the only client that ever opens the store and sees
the empty queue). Which is precisely the account that, by definition,
is *not* here. So on the #46 path a stale claim is not merely possible —
it is unretirable, and it now renders as an alarming banner about work
that does not exist.

That is a *new* failure mode introduced by #47, and it is the mirror
image of the one #47 fixed: instead of the app falsely claiming
everything is saved, the app falsely claims something isn't.

## The fact is already on disk

`A:<entity>` is a real Replicache store. Replicache can say exactly how
many mutations are pending in it. We simply have never asked, because
the only code that opens that store is a client **acting as A** — and
doing that is the one thing we must never do while B is current (it
would push as A: the exact shared-device hazard that makes the
resolution rule in `resolveEffectiveAccount` non-negotiable).

The insight is that **opening the store and acting as the account are
separable**. Open `A:<entity>` with a *deliberately inert transport* —
a pusher and a puller that contact nothing — read
`experimentalPendingMutations()`, close it. No network, therefore no
push, therefore none of the hazard. The only cost is an IndexedDB open,
and only on the rare load where a claim exists at all.

The ledger stops being the authority and becomes an **index**: it tells
us which stores are worth opening. That is a much smaller job, and one
an over-claiming structure is perfectly suited to.

## What this buys

1. **The false positive disappears.** A probe returning zero means the
   claim is stale — so retire it, from *this* client, and say nothing.
   This is the first time a non-claimant can heal a claim, which is
   exactly the gap that made stale claims permanent.
2. **The banner gets honest numbers.** *"Another account has 3 unsaved
   changes on this list"* — the same standard of evidence the sync
   indicator already meets for the current account. Today's banner is
   the only assertion in this area that is unquantified, and that is not
   a coincidence: it's the only one not reading a real queue.
3. **The sync indicator's stranded state gets a count** for free.
4. **`discardUnflushed` gets a precondition worth having**: we can tell
   the user what they are about to destroy before they destroy it.

## Slice 0 — RUN, and it PASSED (with one design-changing catch)

> `packages/client/src/probe.spike.test.js`, real Replicache against real
> IndexedDB (`fake-indexeddb`). Both assertions green.

**The premise holds.** A second Replicache client, opened on the same
store name, **does** see the first client's pending mutations — and
probing with an inert pusher that reports HTTP 200 does **not** consume,
confirm, or corrupt them: reopen with a working pusher afterwards and the
mutation is still pending and still flushes. Confirmation really does
arrive only via a pull's `lastMutationID`, as hoped. The plan is alive.

Two things the spike taught that were not in the design:

**1. The probe must await readiness, and must not swallow the throw.**
`experimentalPendingMutations()` on a freshly-constructed client throws
`Error: Missing head main` rather than returning empty. A probe that
`try`/`catch`es its way to `0` would retire a **live** claim. Await
`clientID` and a trivial `query()` first; let any throw propagate as
"unknown", never as "nothing here".

**2. The probe cannot see *unpersisted* mutations — and this kills the
self-heal.** Replicache moves mutations from the in-memory dag to the
persistent one on its own schedule; there is no public `persist()`. The
spike's first version closed the writing client immediately, read **0
pending**, and looked exactly like proof that the whole plan was dead.
It wasn't — the store was genuinely, correctly empty, because nothing
had been persisted yet.

The consequence is asymmetric and it matters:

- A probe reading `n > 0` is **trustworthy**. Those mutations are on
  disk. We can shout about them, and count them.
- A probe reading `0` is **not** trustworthy. It means "nothing durable
  here *yet*" — which is honest if the claimant's tab is gone (an
  unpersisted mutation dies with its tab; there is nothing to strand),
  but wrong if the claimant is live in another tab right now with work
  in flight.

So **`0` must mean silence, not retirement.** The original Slice 2
retired the claim on a zero probe, and that would have re-introduced #43
by hand: retire the pointer, let the other tab persist a second later,
and the work is durable, unclaimed, and unreachable — the exact orphan
the ledger exists to prevent.

Which, happily, makes the plan *smaller*:

> The ledger stays the index and keeps its current retirement rule (only
> a client acting as the claimant retires a claim). The probe gates every
> **user-visible assertion** — banner, count, sign-out prompt. Silence,
> not deletion, is what fixes the false positive.

A stale claim then survives invisibly, which costs nothing: nothing
renders off a claim any more, and `resolveEffectiveAccount` adopting a
stale claim on a dead session just opens an empty store, exactly as it
does today.

### The original spike brief (kept for the record)

**Do this first. Everything below is void if it fails.**

`experimentalPendingMutations()` must report mutations enqueued by a
**different client** in the same store. If it is scoped to the calling
client only, a freshly-opened probe client sees an empty queue no matter
what, the probe always returns zero, and the whole approach inverts into
the worst possible bug (silently retiring live claims and deleting real
work).

Existing evidence says it is client-*group* scoped, and it is strong but
circumstantial: #43's e2e reloads the page — a new Replicache client —
and the indicator still reads "1 pending" from the previous client's
queue. That is the same question. But "strong and circumstantial" is not
the standard for code whose failure mode is *deletes the user's work*.

Pin it directly, in `@djibb/client`, against the real Replicache:

- open store `X`, enqueue a mutation with a pusher that cannot succeed;
- close the instance;
- open a **second** instance on the same name with an inert transport;
- assert `experimentalPendingMutations()` still reports it;
- close, reopen with a real (working) transport, assert it **still
  flushes** — i.e. the probe did not consume, confirm, or corrupt it.

That last assertion is the load-bearing one, and it is a claim about
someone else's library, so it must be a test and not a comment.

**If the spike fails**, stop. The fallback is not a cleverer probe — it
is to soften the banner's copy to match its actual evidence ("may have
unsaved changes") and leave the ledger as the authority. Say so in the
issue; don't improvise.

## Slice 1 — `probeUnflushed` in `@djibb/client`

```
probeUnflushed({ accountId, entityId, mutators }) -> Promise<number>
```

- Builds a Replicache on `storeName(accountId, entityId)` /
  `SCHEMA_VERSION` — **shared with the create and drop paths**, exactly
  as `discardUnflushed` already shares them, so the probe cannot drift
  away from the store it is supposed to be probing.
- **Inert pusher and puller.** Neither touches the network. This is the
  safety property of the entire design and deserves the loudest comment
  in the file: a probe that pushes is a probe that acts as an account
  the user did not choose, on a device they may not own.
- **The real mutator set must be registered.** Replicache replays
  pending mutations on open; an unknown mutator name throws. This is a
  seam the caller supplies, not something `@djibb/client` reaches for.
- **`pullInterval: null`**, and close in a `finally`. A probe that leaks
  an open connection would block a later `dropDatabase` — i.e. break
  "Discard them", the very button the banner offers.
- Returns 0 (not a throw) when the store does not exist. "No store" and
  "empty store" are the same answer to the question being asked.

Deliberately *not* merged into `strandedClaims`: that function is pure,
synchronous, and unit-tested, and it should stay that way. The probe is
I/O. Keep the reasoning separable from the disk.

## Slice 2 — the shell decides (REVISED by the spike: silence, not deletion)

`stranded.svelte.js` (the rune shell) grows an async pass:

1. `strandedClaims(...)` → candidate accounts (unchanged; still the
   index).
2. Probe each. Sequential, not parallel — these are IndexedDB opens on a
   path that is already rare, and N is ~1.
3. `count === 0` → **say nothing**, and *leave the claim alone*. See
   Slice 0: a zero probe cannot distinguish "stale claim" from "the
   claimant's other tab hasn't persisted yet", and deleting on that
   ambiguity re-creates #43 by hand.
4. `count > 0` → surface `{ accountId, count }` to the banner.
5. Probe **throws** → say nothing, and log. Unknown is not zero.

The banner renders **nothing** until the probe resolves. It is better to
be silent for 50ms than to shout and retract — a banner that appears and
vanishes is worse than either outcome, because it teaches the user that
this banner lies.

## Slice 3 — the copy earns its numbers

- Banner: *"Another account has **3 unsaved changes** on this list."*
- `SyncIndicator` stranded phase: *"3 unsaved changes from another
  account."*
- Discard confirm can now state the stakes concretely, which is the
  minimum for an irreversible action.

## Slice 4 — e2e

Extend `e2e/stranded-work.sh` rather than adding a fifth script; it
already builds the two-account session, which is the expensive part.

- **The stale-claim case, which is the whole reason for this plan.**
  Hand-write a bogus ledger entry via `localStorage` for an account with
  no store, load the entity, and assert the banner **never appears** and
  the claim is **gone from `localStorage`** afterwards. That second half
  is the self-heal, and it is invisible from the UI.
- **The real-claim case**: the existing #46 flow, plus an assertion on
  the *count* — which is what proves the probe read a real queue rather
  than defaulting to a truthy guess.
- Confirm non-vacuity the same way #47 did: revert the source with the
  script in place and watch it fail on the right line.

## Risks, ranked

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| ~~`experimentalPendingMutations()` is client-scoped~~ | — | **RETIRED by Slice 0**: it is client-*group* scoped. Pinned by a contract test. |
| ~~An inert pusher "confirms" mutations~~ | — | **RETIRED by Slice 0**: reopen-and-still-flushes asserts it doesn't. Pinned. |
| **A zero probe is not evidence of absence** (unpersisted mutations are invisible to it) | Acting on it — retiring the claim — orphans work that is about to become durable in another tab. This is #43, rebuilt by hand. | Slice 0's revision: zero ⇒ **silence, never deletion**. Retirement stays the claimant's job. |
| A probe that throws is read as zero | Same shape: `Missing head main` on a not-yet-ready client would become "nothing here". | Await `clientID` + a `query()`; let throws propagate as *unknown*. Pinned by the spike. |
| The probe leaks an open IDB connection | `dropDatabase` **blocks rather than rejects** on an open connection (see `discardUnflushed`'s timeout autopsy) — so a leak breaks "Discard them" and hangs it for 5s. | `close()` in a `finally`; assert in the discard e2e that a discard immediately after a probe still lands. |
| Probe cost on every entity load | It only runs when a claim exists, which is rare — but claims are also *stale* most often on exactly the cold-start path. | Measure before optimising. If it bites: probe once per (entity, account) per page load, not per render. |

## What does not change

- **`resolveEffectiveAccount` stays exactly as it is.** A live session
  keeps its unconditional win. This plan makes the *disclosure* truthful;
  it does not relitigate the resolution, and any future patch that finds
  itself tempted to let a claim outrank a session should re-read #46.
- **Claims are still stamped before the mutation fires.** We are not
  fixing the over-claim; we are declining to publish it unverified.
- Sign-out remains account-wide; the banner remains entity-scoped.

## Open question (decide during Slice 2, not a blocker)

Should the probe also run for the **current** account, replacing the
tracker's `onDrained` retirement? It would unify two mechanisms into
one. Instinct says no — the tracker watches a queue it already has open,
which is strictly cheaper and strictly more current than reopening a
store to ask the same thing — but the symmetry is worth a minute's
thought before it hardens.
