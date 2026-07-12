#!/usr/bin/env bash
# sync-status.sh — End-to-end for the sync-status indicator (#7) and the
# session-expired banner (#6).
#
# What this exercises (real browser, real worker, real DB):
#
#   1. Offline → pending → drain. An edit made with the network down
#      shows as "1 pending"; reconnecting drains it to "All changes
#      saved". No mocking — the browser is genuinely offline.
#   2. Expired session → banner. A signed-in edit syncs; the session
#      cookie is then destroyed mid-session; the next edit's push is
#      rejected 403 by the real worker, and the banner appears naming
#      the unsaved-change count.
#   3. Re-auth → flush, no data loss. Signing back in as the same
#      account flushes the queued mutation. Proven against the server,
#      not local state: a *fresh* client (empty IndexedDB, same
#      cookies) pulls the edit back down.
#
# Why the cookie is destroyed rather than the push mocked: the whole
# point of #6 is that an expired session's push throws at the DO's
# envelope cross-account check (`UnauthorizedError` → 403). Mocking a
# 403 would test our own mock. Clearing the cookie makes the real
# worker produce the real status.
#
# What it doesn't cover (intentionally):
#   - The transient-vs-persistent auth threshold (a single 401/403 must
#     not flash the banner). That's timing-sensitive and precisely
#     pinned by unit tests in packages/client/src/syncStatus.test.js.
#
# Exit non-zero on any failure (set -e + explicit assertions).

set -euo pipefail

# ─── Configuration ─────────────────────────────────────────────────────────

PAGES_BASE="${PAGES_BASE:-http://localhost:5173}"
API_BASE="${API_BASE:-http://localhost:8787}"
SESSION="${AGENT_BROWSER_SESSION:-djibb-e2e-sync-status}"

# The fresh-client check (step 3) needs a second, IndexedDB-empty
# browser session holding the *same* cookies.
FRESH_SESSION="${SESSION}-fresh"
STATE_FILE="$(mktemp -t djibb-sync-state).json"

STAMP="$(date +%s)-$$"
EMAIL="sync-${STAMP}@example.com"

# ─── Helpers ───────────────────────────────────────────────────────────────

ab() { agent-browser --session "$SESSION" "$@"; }

# agent-browser's daemon intermittently answers "Resource temporarily
# unavailable (os error 35) — daemon may be busy" on a command issued
# right after a heavy one (an offline toggle, a cross-origin nav).
# magic-link.sh hits the same flake and works around it by restarting
# the session. Retrying is cheaper and keeps the browser state we need.
# Reserved for commands whose *effect* is idempotent — toggles and
# navigations — never for assertions.
ab_retry() {
    for attempt in 1 2 3; do
        if ab "$@" > /dev/null 2>&1; then return 0; fi
        sleep 2
    done
    fail "agent-browser command kept failing (daemon busy?): $*"
}

cleanup() {
    ab close 2>/dev/null || true
    agent-browser --session "$FRESH_SESSION" close 2>/dev/null || true
    rm -f "$STATE_FILE"
}
trap cleanup EXIT

log() { printf '\033[36m[e2e]\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m  ok\033[0m  %s\n' "$*"; }
fail() {
    printf '\033[31mFAIL\033[0m  %s\n' "$*" >&2
    exit 1
}

# The indicator and banner are read via innerText rather than
# `get text`: both contain a nested "Sign in" link, and `get text`
# returns only the innermost match.
#
# `eval` prints a JSON-quoted value, and an absent element prints `""`
# — which collapses to whitespace, not emptiness, unless trimmed. The
# "no banner yet" assertion below turns on exactly that distinction,
# so trim before returning.
read_text() {
    ab eval "document.querySelector('$1')?.innerText ?? ''" 2>/dev/null |
        tr -d '"' | tr '\n' ' ' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}
indicator() { read_text '[data-testid=sync-indicator]'; }
banner() { read_text '[data-testid=session-expired-banner]'; }

# Clicks a button by its visible label, scrolling it into view first.
#
# `agent-browser click` (0.27.0) does NOT scroll the element into view,
# and — worse — reports success anyway: clicking a button below the fold
# dispatches into empty space and still prints "✓ Done". A test that
# relied on the bare click would silently do nothing and then fail on
# some later assertion, or pass vacuously. Scroll first, always.
#
# (Verified: /accounts sign-out button at y=717 in a 577px viewport —
# `elementFromPoint` at its centre returns null, the click is a no-op,
# exit status 0. After a scroll, the identical click works.)
click_button() {
    local name="$1"
    ab eval "(() => {
        const b = [...document.querySelectorAll('button')]
            .find(x => x.textContent.trim() === '${name}');
        if (b) b.scrollIntoView({ block: 'center' });
        return !!b;
    })()" > /dev/null
    ab find role button click --name "$name" > /dev/null
}

# Replicache pushes on its own schedule and retries with backoff, so
# every assertion here polls rather than sleeping a fixed amount.
# $1 = shell function to call, $2 = substring to wait for, $3 = label
wait_for() {
    local probe="$1" want="$2" label="$3"
    for _ in $(seq 1 30); do
        if [[ "$($probe)" == *"$want"* ]]; then
            ok "$label"
            return 0
        fi
        sleep 1
    done
    fail "${label} — timed out waiting for \"${want}\". last saw: \"$($probe)\""
}

# Polls for text anywhere in the page body.
#
# `agent-browser wait --text` is the natural tool, but it's the command
# that most reliably trips the daemon's "Resource temporarily
# unavailable" flake when issued right after an offline toggle or a
# client-side nav. `eval` has been solid in the same spots, so poll with
# that instead.
wait_body() {
    local want="$1" label="$2"
    for _ in $(seq 1 30); do
        if [[ "$(ab eval "(() => document.body.innerText.includes('${want}'))()" 2>/dev/null | tr -d '"' | tr -d '\n')" == "true" ]]; then
            ok "$label"
            return 0
        fi
        sleep 1
    done
    fail "${label} — timed out waiting for body text \"${want}\""
}

# Opens the list's name field and commits a new name. The list surface
# is keyboard-driven; the heading button is the one stable affordance
# that opens an editable textbox, and a rename is a mutation like any
# other — which is all the sync tracker cares about.
rename_list() {
    local current="$1" next="$2" ref=""

    # Wait for the heading to actually be on the page before reaching for
    # it — a click issued mid-render lands on nothing, and (see
    # `click_button`) agent-browser will happily report success anyway.
    wait_body "$current" "list heading \"${current}\" is on the page" > /dev/null

    # Retry the open-the-editor click. Opening the inline editor is a
    # render, so a click can race it; the click itself is idempotent
    # (clicking the heading twice just re-opens the same editor).
    for _ in 1 2 3; do
        click_button "$current"
        sleep 1
        # `|| true`: under `set -o pipefail` a grep that matches nothing
        # kills the script with no message at all. Let the explicit check
        # below do the reporting, so the failure says what went wrong.
        ref="$(ab snapshot -i -c | grep -m1 textbox | sed -nE 's/.*ref=(e[0-9]+).*/\1/p' || true)"
        [[ -n "$ref" ]] && break
    done
    [[ -n "$ref" ]] || fail "rename: no textbox appeared after clicking \"${current}\""

    ab fill "@${ref}" "$next" > /dev/null
    ab press Enter > /dev/null
}

# Signs in as $EMAIL through the magic-link dev seam (same seam
# magic-link.sh uses — no inbox required) and lands on /accounts.
#
# This runs twice against the *same* address, and it has to: re-auth is
# only a flush if it restores the same account id, because the
# Replicache store is named `<accountId>:<listId>`. Signing back in as
# someone else would point the tab at a different store and the queued
# mutation would simply not be there. So the 60s per-email cooldown
# (MAGIC_RATE_LIMITS.PER_EMAIL_COOLDOWN_SEC) can't be dodged by
# switching emails — it has to be waited out.
last_magic_request_at=0

sign_in() {
    local now elapsed remaining body status landing

    now="$(date +%s)"
    if [[ "$last_magic_request_at" -gt 0 ]]; then
        elapsed=$(( now - last_magic_request_at ))
        remaining=$(( 61 - elapsed ))
        if [[ "$remaining" -gt 0 ]]; then
            log "  waiting ${remaining}s for the per-email magic-link cooldown"
            sleep "$remaining"
        fi
    fi

    # No `-f`: a rate-limited request must surface its status and body
    # rather than tripping `set -e` with an empty message.
    body="$(mktemp)"
    status="$(
        curl -s -o "$body" -w '%{http_code}' \
            -X POST "${API_BASE}/auth/magic/request" \
            -H 'Content-Type: application/json' \
            -H "Origin: ${PAGES_BASE}" \
            -d "{\"email\":\"${EMAIL}\",\"_dev\":true,\"next\":\"/accounts\"}"
    )"
    last_magic_request_at="$(date +%s)"
    response="$(cat "$body")"
    rm -f "$body"

    [[ "$status" == "200" ]] ||
        fail "magic/request got HTTP ${status}. body: ${response}"

    landing="$(echo "$response" | sed -nE 's/.*"landing_url":"([^"]+)".*/\1/p')"
    [[ -n "$landing" ]] || fail "200 but no landing_url. body: ${response}"

    ab open "$landing" > /dev/null
    ab wait --text "Sign in to djibb" > /dev/null
    click_button "Sign me in"
    ab wait --text "Signed-in accounts" > /dev/null
}

# ─── Preflight ─────────────────────────────────────────────────────────────

log "preflight: checking dev servers"
curl -sf -o /dev/null "${PAGES_BASE}/accounts" ||
    fail "pages dev server not reachable at ${PAGES_BASE}"
ok "pages reachable at ${PAGES_BASE}"
curl -sf -o /dev/null "${API_BASE}/" ||
    fail "worker dev server not reachable at ${API_BASE}"
ok "worker reachable at ${API_BASE}"

# ─── Step 1: offline edit shows as pending, reconnect drains it (#7) ───────

log "step 1: offline → pending → drain (anonymous list)"

ab open "${PAGES_BASE}/" > /dev/null
click_button "+ New list"
ab wait --text "Untitled List" > /dev/null
wait_for indicator "All changes saved" "fresh list reports all saved"

ab_retry set offline on
rename_list "Untitled List" "Offline Groceries"
wait_for indicator "1 pending" "offline edit shows as pending"

ab_retry set offline off
wait_for indicator "All changes saved" "reconnect drains the queue"

# ─── Step 2: expired session raises the banner (#6) ────────────────────────

log "step 2: expired session → banner (owned list)"

sign_in
ok "signed in as ${EMAIL}"

click_button "+ New list"
ab wait --text "Untitled List" > /dev/null
list_url="$(ab get url | tail -1)"

rename_list "Untitled List" "Owned While Authed"
wait_for indicator "All changes saved" "authed edit syncs"

# Destroy the session cookie without touching the page. The tab keeps
# its in-memory account id, so the next push still claims that account
# — which is exactly the case the DO rejects, and exactly the case a
# silently-expired session produces.
ab cookies clear > /dev/null
[[ "$(banner)" == "" ]] ||
    fail "banner appeared before any push failed — it must only trip on persistent failure"
ok "no banner yet (nothing has failed)"

rename_list "Owned While Authed" "Edited After Expiry"
wait_for banner "Session expired" "banner appears on persistent push 403"
wait_for banner "1 unsaved change" "banner names the pending count"
wait_for indicator "Can't sync" "indicator flips to can't-sync"

# ─── Step 3: a reload must not strand the queue (#43) ──────────────────────

log "step 3: reload during an expired session keeps the queue visible (#43)"

# The regression this guards: the Replicache store is named
# `<accountId>:<listId>`, and the page used to read that account id from
# *live session state*. On reload with a dead session it read `null`,
# opened a `null:<listId>` store, and left the queued mutation stranded
# in a store nobody was looking at — while the (empty, anonymous) new
# store pushed successfully and the indicator reported "All changes
# saved" over the top of work that was going nowhere.
#
# The unflushed-work ledger is what survives the reload. If it ever
# stops doing so, this assertion is what says so.
ab_retry reload
# Don't start asserting until the reloaded page is actually up. An `eval`
# against a torn-down execution context comes back empty, and an empty
# read is indistinguishable from "the banner isn't there" — which is the
# very thing under test. Wait for the indicator to exist (it mounts with
# the list, before any push has had a chance to fail), then assert.
wait_body "Edited After Expiry" "reloaded page has rendered"
wait_for banner "Session expired" "banner survives the reload"
wait_for banner "1 unsaved change" "the pending count survives the reload"

# The failure mode was not just a missing banner — it was the app
# actively asserting the opposite. Guard the lie directly.
[[ "$(indicator)" != *"All changes saved"* ]] ||
    fail "indicator claims 'All changes saved' while a mutation is stranded (#43)"
ok "indicator does not claim saved while work is stranded"

# ─── Step 4: re-auth flushes the queue, and the server has the edit ───────

log "step 4: re-auth → flush → confirm server-side (no data loss)"

sign_in
ab open "$list_url" > /dev/null
wait_for indicator "All changes saved" "queued mutation flushes after re-auth"
[[ "$(banner)" == "" ]] || fail "banner still showing after successful re-auth flush"
ok "banner cleared"

# "All changes saved" alone would also be true of a client that simply
# dropped its queue, so prove the edit reached the *server*: a second
# browser session with the same cookies but an empty IndexedDB has no
# choice but to pull it down.
ab state save "$STATE_FILE" > /dev/null
agent-browser --session "$FRESH_SESSION" --state "$STATE_FILE" open "$list_url" > /dev/null
agent-browser --session "$FRESH_SESSION" wait --text "Edited After Expiry" > /dev/null ||
    fail "fresh client could not pull the post-expiry edit — the mutation was lost"
ok "fresh client pulled the post-expiry edit from the server"

# ─── Step 5: signing out with unflushed work warns, and keeps it ──────────

log "step 5: sign-out with unflushed work prompts, and keeps it by default"

# Queue work that can't drain, then leave the entity *while still
# offline* — the queue only flushes when a client for that entity is
# open, so navigating away offline is what leaves it genuinely stuck.
# This is the realistic shape of the case: edit on a train, close the
# tab, come back online later, sign out from /accounts without
# revisiting the list.
ab_retry set offline on
rename_list "Edited After Expiry" "Unsynced At Signout"
wait_for indicator "1 pending" "work is queued before leaving the list"

# Leave the list page *while still offline*. This is the load-bearing
# step: the queue only drains while a client for that entity is open, so
# going online first would flush the very work we need to still be stuck.
#
# The navigation itself fails (we're offline — there's no document to
# fetch), and that's fine: all we need is for the list page, and its
# Replicache client, to be torn down. Then reconnect and load /accounts
# for real. `|| true` because a failed navigation is the expected
# outcome here, not an error.
ab open "${PAGES_BASE}/accounts" > /dev/null 2>&1 || true
ab_retry set offline off
ab_retry open "${PAGES_BASE}/accounts"
wait_body "Signed-in accounts" "back on /accounts, online, still signed in"

claims() {
    ab eval "(() => Object.keys(localStorage).filter(k => k.startsWith('djibb.unflushed')).length)()" |
        tr -d '"' | tr -d '\n'
}
[[ "$(claims)" == "1" ]] ||
    fail "expected one unflushed-work claim before sign-out, saw $(claims)"

click_button "Sign out"
wait_body "unsaved changes" "sign-out warns about the unsaved changes"

# The default is non-destructive: the work outlives the session, which
# is the entire premise of the ledger. (The "remove unsaved changes"
# branch is the destructive one and is deliberately not exercised here —
# it drops the IndexedDB store.)
click_button "Sign out, keep changes"
sleep 2
[[ "$(claims)" == "1" ]] ||
    fail "signing out discarded the unflushed-work claim — it must be kept by default"
ok "the claim survives sign-out (work stays recoverable)"

log "✅ sync-status E2E passed (${STAMP})"
