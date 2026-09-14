# ADR 0027: Read secrecy through entity decomposition — not item-level ACLs

- **Status:** Accepted; design only (no new core code). Depends on the
  ADR 0021 view-floor actually shipping (GH #13). Extends the "weird clients
  use entity-decomposition + role assignment" stance of ADR 0021 (Decision 3)
  from a one-line claim into a full model. Declares ADR 0019 (conditional
  subtrees) orthogonal-and-complementary. Names the account-purge interaction
  with ADR 0008 / the #64 cascade as an accepted hazard.
- **Date:** 2026-09-12
- **Layer:** protocol

## Context

GH #31 asks for **item-level read secrecy**: "hide these items (or this field)
from a specific member." The flagship is Secret Santa — a giftee must not see
who has claimed or purchased items on **their own** wishlist — and it is the
other half of Secret Santa's critical path alongside ADR 0024. The apparent
requirement is a finer authorization axis than ADR 0021's view-floor, which
gates **whole entities** by role and so cannot say "this item, not that one."

The requirement has a feature that breaks the naïve reading. **The excluded
member is usually the entity's `owner`** — the giftee owns their wishlist and
invites the family to it. So the thing to hide is hidden from the *most*
privileged principal, inverting the usual direction of an ACL. No amount of
role juggling on a single entity expresses "the owner sees everything except
this."

Two false starts have to be closed before the real decision, because both are
tempting and both are wrong:

1. **Client-side hiding.** "The Secret Santa client just doesn't render the
   claims." Fatal: djibb is a substrate for many clients. A giftee who opens
   the same list in a generic djibb.com client — or `curl`, or a hostile fork —
   hits the same Durable Object and receives the same bytes; only the special
   client chose to hide them. **Any secrecy a dumb client can bypass is not
   secrecy.** Withholding must happen at the server's pull, not in a renderer.
   (This is also why cross-client portability — a genuine djibb value — is only
   *safe* when the protocol, not the client, decides what a principal may read.)

2. **An item-/field-level ACL layer inside one entity.** This is what #31's
   title literally requests. Rejected on the same grounds ADR 0011 Decision C
   and ADR 0021 rejected a capability layer: it is a *second* authorization
   mechanism bolted beside roles, doubling the surface that has to be correct,
   revocable, and reflected through pull/CVR/push. We have already paid, in
   full, for one mechanism — `(Account, entity) → role` plus the view-floor.

## Decision

**Entity (list) access is the atomic unit of read authorization. djibb will not
grow a sub-entity authorization layer.** Every "hide part of this from that
person" requirement is met by **decomposition** — split the state across more
entities, each with one clean role table and the existing view-floor — reusing
ADR 0021 wholesale. This vindicates ADR 0021 Decision 3 ("weird clients bring
their own mutators / their own backend") instead of quietly walking it back.

Stated as the general rule the ADR is really about:

> **Read secrecy is a single configurable relationship — a principal's *role*
> on a *companion entity*, plus the *timing* of the grant — expressed entirely
> in the entity + role + view-floor model. It is never an attribute of an item
> or a field.**

The mechanical pieces:

1. **The secret lives in a separate entity.** The state to hide (claims,
   purchases, "who gave what") is its own List/Template DO with its own
   `authorization_rules`, `default_role: 'restricted'`. The principal to
   exclude is simply **not a member** of it (and, being unlisted, resolves to
   the `restricted` default). The excluded principal's pull against that DO
   returns an **empty content patch** (ADR 0021 empty-not-403), because the DO
   never emits it — **absence, not redaction**.

2. **The link points from the hidden side.** The companion entity references
   the visible one (claims → wishlist), **never the reverse.** If the visible
   entity pointed at the hidden one, the excluded owner would read their own
   entity and learn the hidden entity *exists* (id + title) — a metadata leak.
   With the pointer on the hidden side, the excluded member's pull contains
   their visible entity **and nothing else**: no content, no pointer, no
   existence signal. Members who *can* read the hidden entity discover the
   pairing from it and join the two client-side.

3. **Composition is client presentation; withholding is protocol.** A client
   may open N entities at once — `createReplicacheClient` builds one Replicache
   instance per `(account, entity)` with its own store and pull URL
   (`packages/client/src/replicache.js`), and nothing caps how many. A *smart*
   client opens both wishlist and claims and paints an overlay ("Bob claimed the
   scarf"); a *dumb* client shows two plain lists it doesn't know are related.
   The difference is **knowledge of the link and join logic — never access**.
   The server withholds identically for every client.

4. **The excluded principal must never be an administering authority of the
   hidden entity.** Changing membership on the hidden entity requires
   owner/admin *on it*. Since no client can be trusted to honor the adversarial
   link ("P owns wishlist X ⇒ P must be `restricted` on claims Y") — that
   invariant lives nowhere in `authorization_rules` — the hidden entity's
   membership must be administered by a **non-excluded authority**:
   - **Party-grade:** a non-giftee human owns it (a round-robin organizer; you
     never own the claims entity about gifts for *you*). Needs zero new
     primitive. Secrecy rests on that human's client not fat-fingering the
     giftee in — acceptable for a gift game, not a vault.
   - **Vault-grade:** a **service identity** owns it (the weird client's own
     backend, authenticating as an ADR 0024 issued-credentials account — the
     same shape `djibb promote` already uses to act as the operator). No human
     can touch its membership; the adversarial-link rule is the service's own
     server-side business logic, exactly the escape hatch ADR 0021 Decision 3
     licenses.

   Core mandates neither; it documents both and leaves the choice to the client.

5. **Anonymity, where wanted, is structural — a property of a mutator, not a
   client's manners.** A shared, cross-group "is this still available?" ledger
   is its own entity whose **only write mutator is `markTaken(item_ref)` — with
   no identity field in its args schema at all.** Even a malicious client cannot
   inject *who*; anonymity is a guarantee of that entity's mutator surface. The
   identity-bearing record ("who gave what") lives in a *different* entity (the
   per-group claims list), read by a different audience. Anonymity was never a
   property of "claims" in general — only of the specific entity built to be
   anonymous.

## Worked example 1 — Secret Santa (the exclusion case)

Object model:

- **Wishlist X** — a normal List, **owned by the giftee**. Givers are `viewer`.
  The giftee edits it freely; it is never mutated by any purchase action, so it
  stays pristine from the giftee's view.
- **Claims Y** — a separate List, `default_role: 'restricted'`, owned by a
  non-giftee authority (§Decision 4). Each claim is an item carrying
  `item_ref → X.item_id` and `claimed_by`. Y references X (link on the hidden
  side). Givers are `editor`/`checker` on Y. **The giftee holds no role on Y.**

Flows:

- A giver marks the scarf claimed → `setItemQuantity`/append on **Y**. Other
  givers, overlaying Y onto X in their client, see it is taken. **X is never
  touched**, so the giftee sees no "taken" marker anywhere.
- The giftee's pull: **X in full, Y empty (absence).** No pointer to Y exists on
  X, so the giftee has no signal Y exists. This is what leaks nothing: there is
  nothing to leak, because the DO emits nothing.
- Double-buy prevention lives entirely in giver-space (the overlay), never in
  giftee-space.

## Worked example 2 — reveal-later registry (the timing case)

A wedding/baby registry wants the **opposite** end state: the registrant
eventually *should* see "who gave me what" (thank-you notes) — but perhaps not
until after the shower. This is the *same substrate at a different setting of
the one dial* — the giftee's role on the companion entity, and **when** it is
granted:

| Product | Giftee's role on the claims entity |
|---|---|
| **Secret Santa** | `restricted` — **forever** |
| **Open registry** (dupe-avoidance, no surprise) | `viewer` — **from creation** (degenerate: no secrecy at all) |
| **Reveal-later registry** | `restricted` **until the event**, then flipped to `viewer` |

The reveal costs **no new mechanism.** Flipping the registrant
`restricted → viewer` is exactly ADR 0021's promotion path — "a role *gaining*
read access → full-sync from version 0" — which back-delivers the entire claims
history the instant the grant lands. Before the flip the view-floor genuinely
returns empty patches (no early spoiler); after, the registrant gets the whole
identity-bearing "who gave what" record. As in Secret Santa the couple cannot
own the claims entity (they are the giftees); a designated friend or the service
identity owns it and triggers the reveal.

The "who gave what" identity lives in the per-group claims entity, not in any
anonymous ledger — the two coexist because they are *different entities with
different mutators and different audiences* (§Decision 5).

## Reconciliation with ADR 0019 (conditional subtrees)

**Orthogonal and complementary — neither extends nor supersedes the other.**
Two things look like "a subtree" and only one hides anything, because **the
secrecy boundary is the *entity* boundary** (where `authorization_rules` and
the view-floor live):

- A subtree that is **its own child entity** (own DO, own role table), nested
  under a parent by reference, *is* decomposition wearing a nesting hat — a
  separate access domain, so it **carries secrecy**. This is the ergonomic form
  of this ADR's model.
- A subtree that is **nested elements inside one entity** shares that entity's
  single access domain, so it carries **no** secrecy. ADR 0019's *conditional*
  subtrees are this kind: reveal/requirement is gated by the item's **data
  state** ("if airway = difficult, show the follow-up"), **identically for
  every viewer**. The gate is data-driven, not identity-driven.

So: **ADR 0019 gates on data (audience-blind, intra-entity); this ADR gates on
audience (via the entity boundary).** A conditional subtree is *not* a secrecy
boundary and must never be used as one — doing so would put the secret inside
the visible entity's access domain and re-open false start #1 (a dumb client
pulls the bytes and merely chooses whether to render them). But 0019 makes
nesting expressive while this ADR makes an entity private, so a private child
entity presented as a conditional subtree is a legitimate, pleasant combination.

## Consequences

- **Zero new core code.** No `_handlePull` change, no CVR surgery, no push-authz
  rework: each entity independently applies the view-floor it already has. The
  entire feature is a client's choice of how many entities to draw and who is on
  each. This is the payoff of refusing a second authorization axis.
- **Hard prerequisite: the ADR 0021 view-floor must actually ship (GH #13).**
  Until reads are gated, decomposition hides nothing — a `restricted` member
  still reads everything today. This ADR is inert without #13.
- **The owning identity is load-bearing for secrecy; its lifecycle is part of
  the trust model.** A hidden `restricted` entity **orphaned to `ownerless`**
  (the ADR 0008 / GH #64 account-purge cascade) flips from *private* to
  *world-readable* (`ownerless` is URL-collaborative read/write) — private →
  public, not a subtle degradation. **Accepted, not fixed:** core forbids no
  orphaning; a weird client that needs durable secrecy must keep its owning
  (service) account alive. Documented so it is a known edge, not a surprise.
- **Multi-group dedup pushes toward vault-grade.** When one wishlist plugs into
  N independent groups (a friend and a sibling shouldn't double-buy), dedup
  needs a shared read domain and the groups are strangers to each other — there
  is no shared *human* organizer, so the shared ledger must be owned by a
  service identity. The party-grade human-owner model is a single-group
  affordance.
- **Benign residue:** a concurrent cross-actor double-claim optimistic window
  exists (two people grab the same item in the same instant); acceptable for a
  gift game. Cross-entity references can dangle if the giftee edits/deletes a
  wishlist item a claim points at; the giver's client resolves an orphan claim.

## Out of scope for v1

- **Per-member-per-item masks *within a single entity*.** Decomposition
  expresses per-*class* visibility cleanly (one hidden entity per visibility
  class) but not arbitrary "member A sees item 3, member B doesn't, both peers
  in the same list" without entity blow-up. No consumer needs it.
- **A single canonical interleaved order of hidden + visible items in one
  list.** Overlaying two entities is a client-side join; the substrate gives no
  cross-entity ordering guarantee. Sealed-bid/interleaved-position use cases are
  deferred.
- **Redaction / placeholders** ("[hidden item]"). We chose **absence**: the
  excluded member's pull simply lacks the content. Placeholders would leak
  existence and count.
- **Full multi-group cross-registry dedup UX.** The model composes to it
  (§Consequences) but the build is deferred; v1 demonstrates single-group
  secrecy (example 1) and the timing dial (example 2).
- **A first-class "service-owned entity" primitive.** Not required: a service
  is an ordinary ADR 0024 issued-credentials account that owns entities. If a
  sharper platform-owned-entity notion is ever wanted, it is its own ADR.

## Considered and rejected

- **Item-/field-level ACLs (the literal #31 title).** A second authorization
  mechanism beside roles; rejected for the reasons above and consistent with
  ADR 0011 Decision C / ADR 0021.
- **Client-side hiding.** Not secrecy at all (false start #1); any other client
  bypasses it.
- **A conditional subtree (ADR 0019) as the hiding mechanism.** Wrong layer:
  intra-entity, audience-blind, and would re-open client-side hiding.
- **Link on the visible side** (wishlist → claims). Leaks the hidden entity's
  existence to the excluded owner; the pointer lives on the hidden side instead.
- **Anonymity by client convention** (client omits identity from the ledger
  write). Re-introduces client-trust for anonymity; replaced by a mutator whose
  args schema structurally cannot carry identity.

## Related

- ADR 0021 — role-gated reads (view-floor) and the read/write lattice: the
  mechanism this ADR reuses; this ADR is the promised expansion of its
  Decision 3.
- ADR 0011 — `DjibbList` as universal entity substrate ("lists all the way
  down"): why decomposition is native.
- ADR 0019 — conditional subtrees: orthogonal-and-complementary (see above).
- ADR 0020 — push-time authorization reconciliation: write-side denials on the
  hidden entity ack-or-throw as usual.
- ADR 0024 — off-domain client sign-in: the issued-credentials account a
  vault-grade service identity uses to own hidden entities.
- ADR 0008 — cascade delete via workspace alarm / GH #64 account purge: the
  orphan-to-ownerless hazard for a secrecy-critical entity.
- GH #13 — view-floor read enforcement: the hard prerequisite.
- GH #31 — this issue.
