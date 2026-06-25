# ADR 0023: Recoverability over step-up for destructive actions

- **Status:** Accepted; the recoverability stance is largely already implemented
  (ADR 0005 inverse mutators, soft-delete, ADR 0007 reconcile). Re-defers the
  step-up/sensitive-action re-auth that ADR 0010 reserved but did not build.
  Relates to ADR 0021 (orthogonal to its no-capabilities stance).
- **Date:** 2026-06-22
- **Layer:** protocol

## Context

As non-djibb.com clients land (ADR 0022) a worry surfaces: a user replies "delete
the workspace" to an authenticated email, the LLM obliges, and a whole workspace
is gone. The reflex is to **gate destructive actions** — require a "real" sign-in,
or treat djibb.com as more trusted than email.

That reflex is wrong on inspection, for reasons that mostly argue *against*
building a guard at all:

1. **Gating by client is incoherent — they're all just clients.** djibb.com is
   not safer than email; its session is itself authenticated by email-control
   (ADR 0010). This is the same-coin inverse of ADR 0022's "a client never grows
   its own permissions": there, no client gets *more*; here, no client gets
   *less*. A client is a way in, not a trust tier. Distrusting one is theater.
2. **A guard implies a bypass.** The moment you build step-up you must build
   `--dangerously-skip-permissions`. The bypass then *is* the real security
   boundary, you maintain two paths, and the friction trains people to reach for
   the skip reflexively. A half-built step-up system is net-negative: real
   friction, real bypass surface, false confidence.
3. **"Trust the user to gate access" is already a sufficient authorization
   model.** Roles (ADR 0021) answer "who may." What they do not answer is "and
   this act was *deliberate*" — but that gap only bites when the action is
   **irreversible**.

The question is therefore not *guards vs. trust*. It is **reversibility**.

## Decision

### 1. Do not gate destructive actions by client

No action is permitted or denied based on the client it arrived through. Clients
are ways in (ADR 0022); authorization is ADR 0021's single model. There is no
"djibb.com-only" tier.

### 2. Destructive actions are recoverable by default, not gated

For any reversible destructive action the **recovery path is the guard**.
Destructive operations are soft-delete + undo (ADR 0005 inverse mutators,
soft-delete, ADR 0007 reconcile-alarm convergence). The email-LLM nukes a
workspace? If that was a soft-delete, it is a *restore*, not a catastrophe. We do
not gate the action; we make it not matter that it was not gated. Trust-the-user
becomes safe **by construction** — resting on undo, which exists — rather than on
the hope that no human fat-fingers and no LLM goes rogue.

**The guarantee is "recoverable-until-purged," not unbounded.** Soft-delete +
undo protects only within the grace window before hard-purge (§4; ADR 0008
hard-delete is terminal). This bound is deliberate and reasonable, but it is
sharpest for exactly the actor §Context worries about: an **unattended** client
(an email-LLM, a scheduled agent) can destroy something whose grace window then
elapses with no human noticing, at which point "recoverable" has silently become
"gone." The mitigation is not a gate — it is keeping the window generous and the
*notification* of a destructive act prompt (so a human can restore in time);
making the window a function of who-acted (longer for unattended actors) is a
clean later refinement, not a v1 requirement.

### 3. Step-up is deferred; it is not punted

We do not build sensitive-action re-auth / confirmation now. We *cannot* draw the
line well yet, on purpose: the right way to earn it is to wait until a genuinely
irreversible, high-blast-radius action *exists*, because that action defines the
line. Drawing it speculatively is how the line ends up wrong and the bypass ends
up load-bearing.

### 4. The honest residue: genuinely-irreversible actions

Recoverability cannot save a few actions. Named so this is a deferral, not an
oversight:

- **Transfer-ownership** — you hand over the keys and the new owner can lock you
  out; undo cannot reach across that. This is the real one.
- **Eventual hard-purge** — a soft-deleted entity genuinely gone after its grace
  window (ADR 0008 cascade-delete is terminal).

Neither is on the critical path. Step-up may earn its place *for these specific
actions* when they are built — at which point there is a concrete case in hand
and enough knowledge to draw the line.

**Ordering constraint (cheap insurance):** transfer-ownership must not become
reachable by a non-djibb.com client before its step-up exists. The deferral above
is safe only while the action is unreachable by the unattended clients §Context
worries about; ship the guard *with* client-reachability, never after it.

### 5. When step-up is built, the second factor must be unforgeable by the actor

Recorded for that future build, because it is the non-obvious part: a
confirmation like GitHub's "type the repo name to delete" works because **a human
is typing** — the friction lives in human hands. When the actor is an LLM/agent,
"reply with the slug" is theater: the agent already has the slug and will simply
generate it. The confused-deputy fires anyway. So an agent's step-up second
factor must route **outside the agent's own control loop** (a one-time code on a
different channel a human pastes; an approval that lands in a human-gated
surface). This is the *one* place a client's nature re-enters (ADR 0022 §3,
operate-an-existing-Account vs. own-Account) — **not** to change permissions
(roles still do that), only to pick an intent-proof the actor cannot self-issue.

## Consequences

**Positive:**

- No step-up code, and therefore no bypass flag and no two-path maintenance.
- Safety for the common case rests on undo (already built), not on guards.
- The hard question is deferred to the moment it becomes concrete and answerable.

**Negative / load-bearing:**

- "Destructive = recoverable" is **already compile-enforced for the mutator
  path**, not merely a review convention: ADR 0005 requires every mutator to
  declare an `inverse`, and "forgetting `inverse` is a build error"
  (`mutators/_shared.ts`). So a new mutator cannot ship with *no* inverse. What
  the compiler cannot check is that the inverse is *meaningful* (a no-op inverse
  type-checks), and that genuinely irreversible operations are not smuggled in as
  ordinary mutators. The intended seam for that residue: an explicit `terminal`
  marker (hard-purge, cascade hard-delete — ADR 0008) that places those few
  operations *outside* the inverse-required mutator path and into a small,
  audited set. Until that marker exists, terminal operations are the one place
  review vigilance still carries weight — a far narrower surface than "all
  destructive mutators."
- Transfer-ownership ships (if it ships before step-up) with no deliberateness
  guard. Acceptable while it is off the critical path; revisit per §4.

**Neutral:**

- Orthogonal to ADR 0021's no-capabilities stance: step-up is proof-of-*intent*
  for an already-authorized action, not a permission decision. It does not reopen
  ADR 0011 Decision C.

## Considered and rejected

- **Gate by client (djibb.com-trusted, email-untrusted).** Rejected: djibb.com is
  email-authenticated too; the distinction is theater (§Context 1).
- **Build step-up now.** Rejected: a guard implies a bypass that becomes the real
  boundary; we cannot draw the line well before a genuinely-irreversible action
  exists (§Decision 2–3).
- **"Type the slug to confirm" as the universal confirmation.** Rejected as the
  *general* mechanism — theater once an LLM is the typist (§Decision 5).

## Out of scope

- The eventual step-up protocol itself (pending-action token, satisfy step,
  per-client rendering) — designed *for* transfer-ownership when it lands, not
  built here.
- Per-action `requiresStepUp` flagging — a registry concern revisited with the
  first genuinely-irreversible action.
