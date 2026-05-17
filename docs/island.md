# Island

The hex-map UI surface for a Workspace's Lists on `djibb.com` (authed
view). Each hex is one List. This doc captures the design intent for
the surface — invariants future contributors should preserve, and the
deliberate non-features (manual rearrange, list-of-lists, etc.).

The glossary entry in `CONTEXT.md` keeps a short stub; the depth lives
here.

## What it is

The visual representation of a Workspace's Lists for an authed visitor
— a hex map where each hex is one List. Bare `djibb.com` (authed)
renders the **personal** Workspace's Island; team Workspaces
eventually get their own Islands at `/w/<slug>`. List-of-lists views
are explicitly rejected as the primary view.

## Growth, not composition

The Island grows as Lists are created — one new hex per new List, no
pre-sized board, no empty hexes. Hex position is algorithmic and
stable (deterministic from List ID / creation order), not user-placed.
There is no manual drag-to-rearrange in v1. This is intentionally
"pull, not push": the user doesn't decide where a List goes; the
Island reflects their usage rather than their decorative taste.
Spatial memory still works because positions are stable, the same way
Catan boards are randomized but memorable once set.

## Terrain reflects content, not preference

Each hex's terrain (biome, color, art) is a function of its List's
properties (seed Template, age, tags, group count, etc.) locked in at
hex-creation time. Terrain is therefore *legible* — recipes cluster as
one biome, camping lists as another — not arbitrary decoration.
Fallback terrain is required for content-poor Lists ("Untitled, zero
items").

## Workspaces become the organizing tool

Because each Workspace has its own Island and the user can't manually
arrange, the way to make your maps reflect a meaningful grouping is to
create Workspaces for those groupings. The composition lever is at the
Workspace layer, not the hex layer.

## Hex visuals carry two state axes, locked-in semantics

Beyond identity (terrain = content type, label = name), a hex visibly
reflects two universal state axes: **completion** (% of items done)
and **recency** (how long since last touched). The encoding is
consistent across every terrain — e.g. completion always reads the
same way, recency always reads the same way — so the map functions as
an ambient dashboard rather than just a navigation surface. Other axes
(collaborator count, etc.) are deferred; two channels keeps the
visual language legible. State and terrain are separate channels: a
recipe looks like a recipe whether 0% or 100% done.

## Chrome is light edge-only; creation is an Island gesture

djibb.com (authed) is full-bleed Island. The only persistent chrome is
a top-right cluster with the account avatar (which exposes workspace
switcher and account menu). Creating a new List is *not* a top-bar
button — it's a dedicated **Dock** affordance on the Island itself (a
lighthouse-like hex on the perimeter), which physicalizes the Island's
growth: tapping the Dock spawns a new hex adjacent to it. The Dock is
the single visible affordance in the empty-ocean state, giving a
brand-new user exactly one thing pulling them in. The workspace
switcher renders other Workspaces as thumbnails of *their* Islands,
extending the map metaphor to the picker.

## Hex interaction is hybrid: quick-tray + full view

Hover (or first tap on mobile) opens an inline tray on the hex showing
title, status, and a short stack of unchecked items that can be
checked off without leaving the map — this is the "mark one thing
done in passing" path that fits djibb.com's accessory-sail frame. A
click on the hex's open affordance routes to `/l/<id>` for the full
List view, which remains the canonical, shareable surface. Pure
inline-only is rejected because shareable URLs require a standalone
route to exist anyway. Implication: the map lazily subscribes to the
contents of visible Lists (not just labels) — affects perf at high
List counts.

## Hexes cluster by terrain, with a spiral fallback

A new List's hex prefers an open slot adjacent to an existing hex of
the *same* terrain (i.e. same content type). When no same-terrain
neighbor exists yet, the hex falls back to the next slot in a
deterministic spiral anchored at the origin hex. The first hex ever
sits at origin. The rule composes with terrain-from-content to produce
*biomes* — recipe regions, camping regions, etc. — whose existence on
the Island reflects actual usage. Lakes (interior holes from
deletions) are preferentially paved over by same-terrain successors,
which lets the Island self-heal without ever moving an existing hex.
Terrain classification must be coarse enough (a small fixed set of
biomes) for clustering to do real work.

## Deletion is hole-as-ocean

When a List is deleted, its hex becomes water — ocean if on the
perimeter (the Island shrinks on that edge), a lake if interior.
Neighboring hexes never move. This preserves spatial memory absolutely
and gives the Island a shape that records the user's history of
removals, not just additions. Archive is offered alongside delete as a
softer alternative (hex stays, low-saturation/fogged, restorable);
true deletion is reserved for the user who actually wants the List
gone.

## Empty ocean for zero-List users

A brand-new authed user with no Lists sees a deliberately empty ocean
— beautiful, ambient, with at most a single unobtrusive create
affordance. No starter hex. The "your Island reflects your usage"
invariant is preserved by refusing to seed it with anything the user
didn't make. The expected onboarding path makes this rare: bare
`djibb.com` unauthed → Minted List → Adopt on sign-in means most new
users land on a one-hex Island that already feels theirs.
