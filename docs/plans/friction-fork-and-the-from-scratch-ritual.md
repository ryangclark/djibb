# Plan: the friction fork & the from-scratch ritual

**Status:** Vibe capture — not a commitment, not an ADR. A product-feel
direction worth not losing. The *technical* home, if/when this firms up,
is ADR 0017's open questions (the instance→instance series edge); this doc
is the *why it would feel good*. Captured here so it doesn't get lost.

## The seed

A tweet: *"immense spiritual difference between a company with a Jira
backlog and a company with a backlog of stuff we'd love to get around to."*

It named a thing we already do: after every big project we sit down and
ask "what's next?" — and we **re-derive the list from scratch** rather than
reopen a saved backlog. Drawing up the product roadmap fresh each time is
not a failure to remember. It's the valuable part. You re-decide what
matters *now*, and the stuff that doesn't make the cut gets left on the
table on purpose.

But we're also leaving real signal on the table. The same idea resurfaces
three planning sessions running and nobody notices it's the same idea. The
question this doc holds: **how do we keep the from-scratch ritual intact
and still connect the dots across each instance of almost-the-same-thing?**

## What it already maps onto

This is ADR 0017's instance→Template loop, felt from the product side
rather than the type side:

- The roadmap session is a **Template**. Each from-scratch draw is a fresh
  **instance** minted off it (`forked_from_id`).
- `carryover` (the default in 0017) is the anti-Jira-backlog: a learning
  surfaces in the *next* instance exactly once, then is consumed unless you
  deliberately graduate it to `canon`. **Dropping is the default;
  permanence is the deliberate gesture.** That's the whole spiritual
  difference from the tweet, already encoded.

What's *not* in 0017, and is the actual content of this doc, is the
**texture of the re-fork** and the **across-instances view**.

## The friction fork (the load-bearing idea)

**There is no "fork this Template" button that fills the page for you.**
Copy-paste is the enemy, because a pre-filled page is a dead page — it's
the Jira backlog by another name. Pulling something forward must cost a
little:

- **You re-type the line.** In the re-typing you reword it, abbreviate it,
  notice it's stale, or notice it's the same thing you wrote last time.
  The friction is doing cognitive work — you're laying down the pathway as
  you go, not inheriting a frozen one.
- **Voice counts.** "Pull items one, two, and three" is enough friction —
  you still had to read, decide, and say each one. Dictation is a
  first-class re-fork input, not a fallback.
- **Handwriting later.** The ideal end of this gradient is handwriting the
  carried-forward items (max pathway, max friction-as-feature). That's a
  someday-app, noted so the gradient is on record: *type → speak →
  handwrite*, increasing embodiment, all of them legitimate, none of them
  copy-paste.

The rule in one line: **you may carry an idea forward, but you may not
carry the *keystrokes* forward.**

## Side-by-side

While you draft the new instance from scratch, the spent instance (and/or
the Template) sits **next to it**, readable but not copyable. You compare,
you cherry-pick by re-entering, you see what you dropped last time and
decide again. The old page is a reference you read, never a clipboard you
paste from.

## The recurrence callout (the delight)

When you add an item, djibb quietly notices it's the same item you added
the last two times and never finished — and *celebrates the recurrence*
rather than silently pre-filling it:

> *"Third roadmap running you've written this. Time to do something
> about it?"*

The feel is a game announcement, not a nag — DOTA-2-ultimate energy, an
achievement banner, not a Clippy. The recurrence **count is signal**: a
thing that keeps coming back in carryover and never graduates to `canon`
and never gets done is either *secretly important — promote it* or *a lie
we keep telling ourselves — kill it.* The callout is the moment that forces
the choice, and it only fires *because* you re-typed it (the system saw you
choose it again, deliberately).

This is why friction and signal are the same feature: the re-type is both
the cognitive pathway **and** the event the recurrence detector counts.

## The series view (connecting the dots over time)

The above is per-mint. The wider want is to look across the *whole series*
of roadmap instances and see the through-lines: which ideas bubbled up and
were deferred N times, which dropped clean and stayed dropped, which
graduated to `canon`. This is ADR 0017's deferred **instance→instance
series edge**, viewed as a product surface — the dots drawn *alongside* the
from-scratch page, never pre-filled *into* it.

## Open / vibe questions

- **What counts as "the same item" for recurrence?** Fuzzy match on
  re-typed text? An explicit "this is the one from last time" gesture
  during the side-by-side? Embedding similarity? The friction rule says we
  can't rely on a copied id, so sameness has to be *inferred or declared*,
  not inherited — which is the interesting constraint.
- **Where's the line between helpful friction and annoying friction?**
  Voice is in; copy-paste is out; what about autocomplete on a line you've
  started typing? (Probably out — it's copy-paste with extra steps.)
- **Does the recurrence callout ever feel like surveillance?** It works
  because it's a delight and a prompt-to-decide, not an accusation. Tone is
  the whole feature; get it wrong and it's a Jira nag.
- **Series view as its own thing vs. a lens on the carryover group.** Does
  "see all instances of this Template over time" deserve a real surface, or
  is it just rendering the `forked_from_id` chain?

## Relationship to existing docs

- **ADR 0017** — the durability axis (`amend`/`carryover`/`canon`) and the
  `slot: 'carryover'` group this rides on; the series edge lives in its
  open questions. The technical decisions land there if this matures.
- **closeout-concierge.md** — the *async harvest* side (how learnings get
  in after an instance is spent). This doc is the *re-fork* side (how they
  come back out at the next mint). Two halves of the same loop.
- **CONTEXT.md "djibb uses itself"** — the obvious dogfood is a "Quarterly
  Roadmap" Template we re-fork, by hand, every planning session.
