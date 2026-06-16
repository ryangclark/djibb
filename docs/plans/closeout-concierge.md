# Plan: closeout concierge

**Status:** Not started. Captured here so it doesn't get lost.

The first concrete build of the self-improvement loop (ADR 0017) over a
sidecar Agent runtime (ADR 0018). This plan is the *delivery* mechanism;
the *meaning* of the loop (the `amend`/`carryover`/`canon` durability axis,
`slot: 'carryover'`) lives in ADR 0017 and is assumed here.

## Why

After an instance is spent (the trip happened, the event passed), there's
a brief window where the user knows exactly what to fix for next time —
and no surface that asks them. The concierge is that surface: a scheduled,
async prompt that harvests the learning and routes it through the loop.
Email first, because email is where people already are; the address is
also the auth, which makes an LLM pointed at the inbox an authorized
`djibb` client.

## Shape

A **concierge Agent DO** (Agents SDK, sidecar per ADR 0018) that:

1. **Schedules the prompt.** `this.schedule(fire_at, 'sendCloseout')` —
   `fire_at` = the instance's event horizon + a grace window.
2. **Sends it** via the existing `EMAIL` binding, with a reply address
   carrying a capability token (below).
3. **Receives the reply** (`onEmail`), validates the token, resolves the
   entity, runs a model to produce `CloseoutProposal[]` (ADR 0017), and
   issues them to `DjibbList` over RPC.
4. **Confirms** with `replyToEmail` ("✅ added bug spray to next time").

```
Concierge Agent DO (ADR 0018)            DjibbList DO (ADR 0011, untouched)
  schedule(fire_at,'sendCloseout') ─┐
  onEmail() ← reply                 │  RPC: applyCloseoutProposals(...)
  model → CloseoutProposal[]  ──────┴───  amend → this instance
  replyToEmail('✅ …')                     carryover/canon → upstream item-write
                                            into the right Template group (ADR 0017 §B)
```

## Pieces to build

### Lifecycle state (on the instance entity's `meta`)

```jsonc
meta.closeout = {
    state: 'scheduled', // scheduled → prompted → awaiting_reply → resolved | snoozed | skipped
    fire_at: 0,         // event horizon + grace
    token: '…',         // capability secret for the reply address
    thread_id: null,    // correlate inbound replies
}
```

1:1 with the entity, so it rides the existing `meta` blob (ADR 0011 §5),
no new table.

### Capability-token email address (Craigslist model)

The secret is the **token in the To-address**, never the `From` header
(spoofable). `buenavista-<token>@in.djibb.com` resolves — via the SDK's
`createAddressBasedEmailResolver` — to the concierge instance bound to
that entity. The token *is* the capability; later it can encode scope
(read-only vs contribute vs owner), which is the edit-token model deferred
in the anon→authed work.

### The RPC seam

`DjibbList.applyCloseoutProposals(proposals)` — one entry point. `amend`
proposals mutate this instance; `carryover` / `canon` are upstream writes
to the Template (`forked_from_id`) landing in the carryover group vs a
canon group respectively (the `contribute`/`promote` rails, ADR 0017 §B).
The agent never writes `list_elements` directly (ADR 0018 §B).

## v1 scope

- Gain/lose items + freeform notes. **No** reconciliation-learning
  (quantitative Template tuning) — that's a later ADR.
- Carryover arrives at the next mint as **one undivided "↩ from last
  time" triage group**; no per-item target-group memory.
- Email only. Slack / webhooks / "cc the List" come later (ADR 0018's
  pattern already covers them).

## Open questions

- **Auto-apply vs draft.** Do `amend` proposals apply immediately on a
  valid (token-authenticated) reply, or wait for review in djibb.com?
  Leaning: `amend` may auto-apply; `canon` — which affects every future
  instance — **always** lands in a review queue, never auto-applied from a
  parsed email.
- **What fires the closeout.** Explicit "trip complete" gesture, all items
  checked, or a parsed/declared event date (`meta.event_at`)? Likely all
  three feeding one `fire_at`.
- **Concierge ↔ entity binding & GC.** One concierge instance per entity,
  per account, or per closeout session? Lifecycle when the entity is
  archived / hard-deleted (cf. the reconcile-on-deleted-DO terminal case).
- **Snooze / no-reply.** What happens to `state` when the prompt is
  ignored — one nudge, then `skipped`? Does an unspent instance ever
  re-prompt?

## Later (same runtime, same pattern)

- **cc-the-List capture** — `buenavista-<token>@in.djibb.com` cc'd on a
  real human thread; the concierge quietly extracts action items.
- **Forward-with-directive** — forward any email + "add this" → an intake
  proposal.
- If these land, the concierge has outgrown "closeout" and ADR 0018's
  open question (does the SDK adoption / concierge deserve to be split
  into its own feature ADR) should be revisited.
