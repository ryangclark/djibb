# Handoff: `/l/<id>/share` wedges on "Loading list…"

**Discovered:** 2026-05-18, while building `e2e/entity-invite.sh`
(two-session E2E for ADR 0009 entity invitations).

**Severity:** real user-facing bug, not test-only. Anyone opening
`/l/<id>/share` after the list has been initialized hits it. Currently
the only working path into the share UI is the keyboard shortcut from
the list page — which *also* fails after this bug surfaces, per the
repro below.

**Status:** root cause not identified. `e2e/entity-invite.sh` is
checked in but marked BLOCKED in its top-of-file comment; it'll pass
as-written once this is fixed.

## Symptom

`/l/<id>/share` (and presumably `/t/<id>/share`) renders the global
layout chrome plus `<p class="loading">Loading list…</p>`. The
`{#if list && mutators}` guard in
`pages/src/routes/l/[id]/share/+page.svelte` never trips. The Share
component never mounts. State at T+15s is identical to T+0.

## Reproduction

### Manual (real browser)

1. Sign in to djibb (any method).
2. Click `+ New list` in the header nav. SvelteKit `goto`s to
   `/l/<newid>`. The list page renders; you see "Untitled List".
3. Press <kbd>Cmd+Shift+S</kbd> (or <kbd>Ctrl+Shift+S</kbd>). The URL
   changes to `/l/<newid>/share`. **The page shows "Loading list…"
   indefinitely.**

Expected: the Share component renders within a second or two,
showing the invite form and rules editor.

### Via agent-browser

The same flow reproduces under agent-browser (v0.27.0 verified). The
issue was first surfaced because the failing `wait --text` against
the share page reported "daemon may be busy" — that turned out to be
the daemon retrying internally against a page whose accessibility
tree was stuck on "Loading list…" the whole time. The daemon wasn't
broken; the page genuinely never updated.

Direct URL nav reproduces it too:

```bash
# After magic-link sign-in:
agent-browser open "http://localhost:5173/l/<fresh-suffix>/share"
sleep 15
agent-browser snapshot  # → "Loading list…" still visible
```

Direct URL nav was the original entry path in
`e2e/entity-invite.sh` step 2; the in-app `+ New list` →
<kbd>Cmd+Shift+S</kbd> flow was tried as a workaround. Both wedge.

## Code paths involved

| File | Notes |
| --- | --- |
| `pages/src/routes/l/[id]/share/+page.svelte` | The route. `$effect` mounts a fresh Replicache client via `initList()` (line ~50). Renders Share iff `{#if list && mutators}`. |
| `pages/src/routes/t/[id]/share/+page.svelte` | Template share route. Same pattern as the list share route; almost certainly hits the same bug. |
| `pages/src/lib/replicache/index.svelte.js` | `initList()` (line 36) — creates the client, sets up `experimentalWatch` with `initialValuesInFirstDiff: true`, fires `mutate.initList` iff `tx.isEmpty()`. |
| `pages/src/routes/l/[id]/+page.svelte` | The list route itself. Same `initList()` call. **Works fine** when navigated to. The difference between this and the share route's mount is what we need to find. |
| `pages/src/lib/components/Share.svelte` | The component. Receives `list` as a prop; never mounts because the guard above it fails. Probably innocent. |

## What's been ruled out

- **Not an agent-browser version issue.** `e2e/magic-link.sh` and
  `e2e/rate-limit.sh` pass cleanly on 0.27.0. The wedge reproduces
  with hand-driven CLI commands.
- **Not a session-load race.** The user is fully authenticated when
  the wedge occurs — confirmed by visible workspace switcher
  ("`<name>`'s space ▾") in the header. `sessionState.currentAccountId`
  is set, the user owns the list (initList created with them as owner
  in the prior `/l/<id>` mount).
- **Not a server-side init issue.** The DO and D1 row exist (the
  `/l/<id>` page rendered the list before the share-route nav).
  Pull from the share page should hydrate the local store
  immediately.
- **Not a missing personal workspace.** Magic-link sign-in atomically
  creates a personal workspace alongside the Account
  (`workers/src/account/service.ts:51`, `buildPersonalWorkspaceStatements`).

## Open hypotheses

In rough order of likelihood:

1. **`experimentalWatch` doesn't deliver an initial diff for a
   pre-existing IDB store.** The share page mounts a new Replicache
   client with the same `name: ${accountId}:${listId}` as the list
   page's client. The list page closed its client in cleanup
   (`replicacheList.client.close()`) before SPA-nav. If `close()`
   leaves the IDB in a state where the next `experimentalWatch`
   subscriber doesn't get `initialValuesInFirstDiff: true` semantics
   (e.g. because Replicache thinks no "new" data has arrived yet),
   `listData` stays empty and the guard fails.

   *Quick test:* in the share route, log every diff received by the
   watch callback. If no diffs ever arrive, this is it.

2. **Race between the old client's `close()` and the new client's
   open.** SvelteKit's `$effect` cleanup runs synchronously on
   unmount, but Replicache's close may complete async. If the new
   client opens the IDB while the old one is mid-tearing-down, the
   new client could end up in a "this name is busy" state and either
   silently drop watchers or never pull.

   *Quick test:* add a `setTimeout(..., 200)` before calling
   `initList()` in the share route. If the bug disappears, this is
   it.

3. **The new client's pull never fires.** Replicache normally pulls
   on mount. If the share-page client never pulls — maybe because
   the puller hasn't been registered yet, or the websocket isn't
   connected — and the local IDB is somehow empty for that name (vs.
   the list-page's client), there'd be no data to watch over.

   *Quick test:* network tab during the wedge — is a `/pull` request
   fired? What does it return?

4. **Two effect runs in dev mode (StrictMode-equivalent) cause
   double-init.** Svelte's runes don't have a React-StrictMode-style
   double-fire by default, but Vite HMR or the layout's `onMount`
   might cause the share-page effect to fire twice quickly. The
   first creates a client; the second's cleanup of the first races
   the second's own setup. Less likely than #2 but related.

   *Quick test:* log effect start/cleanup count. If the share
   route's effect fires more than once on cold nav, investigate.

## Suggested investigation path

1. **Add logging.** In `pages/src/lib/replicache/index.svelte.js`,
   log every diff received by `replicacheExperimentalWatchCallback`,
   plus the count of diffs in each `for` iteration. Log when the
   `mutate.initList(...)` branch fires vs. when `isEmpty()` returns
   false.
2. **Repro fresh.** Magic-link sign-in fresh email → `+ New list` →
   wait for render → Cmd+Shift+S → observe logs.
3. **Compare to the list page's mount.** Same logging path is shared
   (both routes call `initList`), so the logs from a successful list
   mount can be diffed against a wedged share mount. The diff is
   what `experimentalWatch` is or isn't doing.
4. **Bisect: list-page mount vs. share-page mount.** If logs show
   `experimentalWatch` *does* deliver diffs in both cases but
   `listData` doesn't update on the share page, the bug is in how
   the share route's `$effect` consumes `replicacheList.list`. If
   logs show diffs only on the list page, the bug is in
   Replicache's behavior across client teardown + re-open.

## Where this hurts

| Surface | Impact |
| --- | --- |
| `e2e/entity-invite.sh` | Step 2 wedges. Whole script blocked. |
| Real users opening share via Cmd+Shift+S | Wedged share view; can't change rules or see pending invites. |
| Real users opening share via deep link / bookmark | Same wedge. |
| `setListAuthRules` mutator | Has no UI today, but when one ships it'll live on the share page — every Share-UI feature is downstream of this fix. |
| ADR 0009 invitee inbox (deferred) | Same Replicache-after-SPA-nav pattern; might hit the same bug when built. |

## Adjacent context

- **ADR 0009 (entity invitations) is functionally landed.** Slices
  1, 2, 2.5, 3, 3a, 3b, 3-redo, plus email-send wiring (commit
  `7315890`) and the invitee accept banner (commit `acba7b8`) are
  shipped. The workers vitest suite (294 tests, all passing) covers
  the server-side end-to-end. This bug is what stopped the
  browser-driven E2E from going green.
- **Test surfaces.** See `docs/testing.md` for the service-level
  vs. E2E split. `e2e/magic-link.sh` and `e2e/rate-limit.sh` are
  the working precedents; `e2e/entity-invite.sh` is the parked one.
- **The session race exists in theory but isn't this bug.**
  `/l/[id]/share/+page.svelte` calls `initList({ accountId:
  sessionState.currentAccountId, ... })` in an effect. If the
  effect fires before session resolves, accountId is null and
  the resulting Replicache client has a different IDB name
  (`null:<listId>`). When session resolves and the effect re-fires,
  cleanup closes the null-named client; a new client opens the
  proper-named store. This race exists but was ruled out as the
  cause here — repro held with session fully resolved before
  the share-route effect fired.
- **One unblock workaround that would shrink the test scope.** If
  the share page can be reached only via direct URL post-fix, the
  test script needs no special handling. If the route stays
  SPA-only post-fix, the E2E may need a small UI affordance
  (visible "Share" button on the list page) to drive it
  click-by-click rather than relying on keyboard shortcuts that
  agent-browser has to issue with `press`.
