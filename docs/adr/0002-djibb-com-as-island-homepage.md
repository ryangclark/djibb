# ADR 0002: djibb.com homepage — Minted List for guests, Island map for members

- **Status:** Accepted (design); **not yet built**. The decision stands, but
  the Island map is unimplemented as of 2026-06-14: the authed homepage
  (`pages/src/routes/+page.svelte`) is a `TEMP` account-info stub and the
  workspace view (`pages/src/routes/w/[slug]/+page.svelte`) is an explicit
  TODO placeholder. The guest-side Minted List flow is the built half.
- **Date:** 2026-04-28
- **Layer:** client/djibb.com

## Context

djibb.com is the first client of the broader djibb protocol, but the protocol is intended to be client-agnostic (LLM agents, CLIs, mobile apps, etc.). djibb.com itself is opinionated — a personal expression that is not trying to be the universal frontend. Its design framing is "pull, not push": an accessory sail, not the main one. The site should twinkle at the user rather than nag them.

The homepage is the load-bearing surface of that posture. Existing precedent (Notion, Linear, Things, etc.) defaults to either a marketing splash for unauthed visitors or a list-of-lists dashboard for authed users. Both are rejected here on aesthetic and product grounds: marketing splashes push, and a list-of-lists is a boring frame for a tool whose central concept is *remixable lists*.

This ADR pins the surprising, hard-to-reverse commitments behind that homepage. Visual minutiae (terrain art, pan/zoom, exact hex shading) are deliberately left out — they're implementation details that should be free to evolve.

## Decision

### Unauthed: bare `djibb.com` mints a real List

A first-time unauthed visitor to bare `djibb.com` is silently handed a real, ownerless List — created on the fly, seeded by copying a randomly chosen Template from a small hand-curated **Seed Pool** — and the URL is rewritten to `/l/<id>`. The List is a full citizen: own DO, Replicache sync, shareable URL, collaboratively editable. A device-local pointer (e.g. localStorage) is set so subsequent bare-`djibb.com` visits *from that device* redirect back to the same List. Explicit `/l/<id>` visits never read or write the pointer; sharing the URL with a friend does not bounce them anywhere.

Marketing copy and "what is djibb?" surfaces are not on bare `djibb.com`. The List itself is the answer.

### Sign-in adopts in place

When a visitor sitting on their Minted List signs in, the existing List is **adopted** into their personal Workspace — same ID, same URL, same Replicache state. Existing collaborators on the link are downgraded (not locked out). Forking is rejected because it splits the user's mental model into two Lists at the moment they're claiming ownership of one. URL stability across the unauthed → authed boundary is a contract.

### Authed: bare `djibb.com` renders the personal Workspace as an Island

A signed-in visitor to bare `djibb.com` sees the **Island**: a hex map representation of their personal Workspace's Lists, where each hex is one List. List-of-lists is rejected as the primary view. Team Workspaces eventually get their own Islands at `/w/<slug>`; Workspace membership is the user's lever for grouping (rather than manual placement on a single map).

### The Island has invariants, not preferences

Three properties are promised and protected:

1. **Algorithmic-but-stable placement.** Hex positions are deterministic from List ID / creation order — never user-arranged in v1. New Lists prefer adjacency to existing same-terrain hexes, with a deterministic spiral fallback when no same-terrain anchor exists. This produces *biomes* (recipes cluster, camping lists cluster) whose shape reflects actual usage. Spatial memory is the payoff.
2. **Growth-only with hole-as-ocean deletion.** The Island grows by one hex per List creation. When a List is deleted, its hex becomes water (ocean if perimeter, lake if interior); neighboring hexes never move. The Island carries the shape of both additions and removals. Archive is offered as a softer alternative to true deletion.
3. **Two-axis state encoding.** Each hex visibly reflects two universal state axes — completion and recency — using consistent semantics across all terrains. Terrain conveys identity (what kind of List); state conveys condition (how it's doing). The Island therefore functions as an ambient dashboard, not just a launcher.

Together these mean: **the Island reflects the user's usage, not their decorative taste.** That is the philosophy, and the placement / deletion / encoding rules are its concrete enforcement.

### The Island is the canvas; chrome is light

djibb.com (authed) is full-bleed Island. The only persistent chrome is a top-right cluster (account avatar, exposing workspace switcher and account menu). New-list creation is **not** a generic "+ New" button — it is a **Dock** affordance on the Island itself, where the new hex visibly grows from. In the empty-ocean state (a brand-new user with zero Lists), the Dock is the single visible affordance, providing exactly one entry point. The workspace switcher renders other Workspaces as thumbnails of *their* Islands, extending the metaphor.

## Consequences

**Positive:**

- **Coherent posture.** Pull-not-push, accessory-sail, twinkle-at-you all cash out into concrete rules instead of vibes.
- **Spatial memory is real.** Stable positions + biome clustering + non-moving neighbors = users can say "the recipes are over there" and be right months later.
- **The Island earns its keep.** Two-axis state encoding makes the homepage informational at a glance, not just decorative.
- **Onboarding has continuity.** The unauthed Minted List → Adopt-on-signin path means most new users land on a one-hex Island that already contains their work. The empty-ocean state is rare, and its starkness is intentional rather than apologetic.
- **Templates have a heartbeat from day one.** Every unauthed visit instantiates a Template. The protocol's central remix concept is the first thing a stranger touches.

**Negative:**

- **Placement is now a contract.** Once real users have Islands, the placement algorithm (terrain classification, spiral order, biome adjacency) cannot be changed without shuffling existing hexes and breaking spatial memory. Versioning the algorithm or freezing per-Workspace seed inputs may be needed before any future change.
- **Visual surface is large.** Each terrain needs both content-identity art *and* completion / recency state encodings. Multiplies design work.
- **Map view subscribes to List contents lazily, not just labels.** The hover/tap quick-tray on each hex needs item data, which has perf implications at high List counts. Not architecturally hard but not free.
- **No manual arrangement is a real opinion.** Some users will want it. The escape valve is "make a Workspace" rather than "drag this hex." That answer is acceptable but won't satisfy everyone.
- **The Seed Pool and terrain classifier are curatorial commitments.** Both require ongoing taste-driven maintenance. If the Pool gets stale or the terrain classifier mis-buckets common Lists, the homepage loses charm fast.

## Alternatives considered

- **(a) Marketing splash for unauthed, list-of-lists for authed.** The standard SaaS shape. Rejected: marketing pushes, list-of-lists is the boring frame, and the protocol's remix story has no surface to land on. djibb.com would be indistinguishable from the productivity-tool baseline it's trying to push against.
- **(b) Mint on unauthed, but fork on sign-in.** Cleaner separation between "demo list" and "your list." Rejected: forking creates two Lists at the exact moment the user is claiming ownership, breaks URL continuity, and leaves the original ownerless List as GC pressure forever.
- **(c) Authed homepage as a single cross-Workspace meta-map.** One Island, the whole world, with Workspaces as biomes. Rejected: workspace membership is fluid (joins, leaves, removals), so terrain assignments would shift as memberships change — destroying the spatial-memory promise the map is built on.
- **(d) Hex map with manual drag-to-place.** Lets users compose their Islands deliberately. Rejected: introduces a placement decision at every List creation (push, not pull), and the spatial memory it would enable is the kind of memory that's already covered by Workspaces. The Island is *meant* to be a function of usage, not a canvas.
- **(e) Pure inline expansion (no separate `/l/<id>` route).** The map is the only surface; clicking a hex expands it in place. Rejected: shareable URLs are core to the protocol (the Minted List depends on it), so the standalone List route exists anyway. Hiding it behind the map only creates two paths to the same data with no gain.

## References

- `CONTEXT.md` — List, Template, Workspace, Minted List, Seed Pool, Island, Dock
- ADR 0001 — entity metadata in D1; the catalog query that powers Island rendering
- Design conversation 2026-04-28 — domain-model interview that produced this design
