#!/usr/bin/env bash
# stranded-work.sh — End-to-end for GH #46: another signed-in account
# must not strand the first's unflushed work behind "All changes saved".
#
# This is the #46 repro itself, driven against a real browser, a real
# worker, and a real DB.
#
#   1. Sign in as A and B — sessions here are multi-account, which is
#      the whole premise of the bug.
#   2. As A, edit a list with the network down. The mutations queue in
#      `A:<list>` and the ledger claims it. Genuinely offline; nothing
#      mocked.
#   3. Make B the current account *while still offline* (the current
#      account is workspace-derived, so this is a workspace switch), then
#      reconnect and open the list.
#
#      This is the state #46 is about. `resolveEffectiveAccount` hands
#      back B — correctly; a ledger claim must never outrank a live
#      session, or a genuinely different user on a shared device gets
#      pulled into A's store and pushes as them. So we open `B:<list>`: a
#      different store, an empty queue, pushes that succeed. Before the
#      fix, the indicator said **All changes saved** over A's stranded
#      work, which is the exact illusion #43 exists to kill.
#
#      So the assertions here are the two halves of the lie: the banner
#      must appear, AND the indicator must not claim saved. The second is
#      the regression guard that matters — a missing banner is a gap, but
#      an app asserting the opposite is a trap.
#   4. Take the banner's own advice ("Switch to that account") and prove
#      it is not merely reassuring: A becomes current, `A:<list>` reopens,
#      the queue drains, the banner clears — and the DO's own copy of the
#      list, read without touching IndexedDB, has the edit. So "saved" is
#      a claim about the server rather than about optimistic local state.
#
# What it doesn't cover (intentionally):
#   - The claim/resolution/scoped-discard logic itself, which is pinned
#     directly by unit tests in packages/client/src/unflushed.test.js.
#   - The banner's "Discard them" branch: it drops the IndexedDB store,
#     and (like the destructive sign-out branch in sync-status.sh) is
#     deliberately left out of the automated pass.
#
# Exit non-zero on any failure (set -e + explicit assertions).

set -euo pipefail

# ─── Configuration ─────────────────────────────────────────────────────────

PAGES_BASE="${PAGES_BASE:-http://localhost:5173}"
API_BASE="${API_BASE:-http://localhost:8787}"
SESSION="${AGENT_BROWSER_SESSION:-djibb-e2e-stranded}"

STAMP="$(date +%s)-$$"
# Two accounts, one device — the shape of the bug. Distinct addresses, so
# neither trips the other's per-email magic-link cooldown.
EMAIL_A="stranded-a-${STAMP}@example.com"
EMAIL_B="stranded-b-${STAMP}@example.com"

# ─── Helpers ───────────────────────────────────────────────────────────────

ab() { agent-browser --session "$SESSION" "$@"; }

# agent-browser's daemon intermittently answers "Resource temporarily
# unavailable" on a command issued right after a heavy one (an offline
# toggle, a cross-origin nav). Reserved for commands whose *effect* is
# idempotent — toggles and navigations — never for assertions.
ab_retry() {
    for attempt in 1 2 3; do
        if ab "$@" > /dev/null 2>&1; then return 0; fi
        sleep 2
    done
    fail "agent-browser command kept failing (daemon busy?): $*"
}

cleanup() {
    ab close 2>/dev/null || true
}
trap cleanup EXIT

log() { printf '\033[36m[e2e]\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m  ok\033[0m  %s\n' "$*"; }
fail() {
    printf '\033[31mFAIL\033[0m  %s\n' "$*" >&2
    exit 1
}

# Both banners and the indicator contain nested links, and `get text`
# returns only the innermost match — so read innerText. An absent element
# yields `""`, which collapses to whitespace rather than emptiness unless
# trimmed, and the "no banner" assertions turn on exactly that
# distinction.
read_text() {
    ab eval "document.querySelector('$1')?.innerText ?? ''" 2>/dev/null |
        tr -d '"' | tr '\n' ' ' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}
indicator() { read_text '[data-testid=sync-indicator]'; }
stranded_banner() { read_text '[data-testid=stranded-work-banner]'; }

# agent-browser does not scroll before clicking, and reports success
# anyway — a click below the fold dispatches into empty space and still
# prints "✓ Done". Scroll first, always. (See sync-status.sh for the
# full autopsy.)
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

# Everything here polls: Replicache pushes on its own schedule and
# retries with backoff, so a fixed sleep would be either flaky or slow.
# $1 = probe function, $2 = substring to wait for, $3 = label
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

wait_body() {
    local want="$1" label="$2"
    for _ in $(seq 1 30); do
        if ab eval "document.body.innerText.includes('${want}')" 2>/dev/null |
            grep -q true; then
            ok "$label"
            return 0
        fi
        sleep 1
    done
    fail "${label} — timed out waiting for body text \"${want}\""
}

# Opens the list's name field and commits a new name. A rename is a
# mutation like any other, which is all the ledger and the tracker care
# about.
rename_list() {
    local current="$1" next="$2" ref=""

    wait_body "$current" "list heading \"${current}\" is on the page" > /dev/null

    # Opening the inline editor is a render, so the click can race it.
    # Retrying is safe — clicking the heading twice re-opens the same
    # editor.
    for _ in 1 2 3; do
        click_button "$current"
        sleep 1
        # `|| true`: under `set -o pipefail` a grep that matches nothing
        # kills the script with no message at all.
        ref="$(ab snapshot -i -c | grep -m1 textbox | sed -nE 's/.*ref=(e[0-9]+).*/\1/p' || true)"
        [[ -n "$ref" ]] && break
    done
    [[ -n "$ref" ]] || fail "rename: no textbox appeared after clicking \"${current}\""

    ab fill "@${ref}" "$next" > /dev/null
    ab press Enter > /dev/null
}

# Signs in through the magic-link dev seam (the same seam magic-link.sh
# uses — no inbox required). Called once per address; the two are
# distinct, so the 60s per-email cooldown never bites.
#
# Signing in a second account ADDS it to the session rather than
# replacing it — that multi-account session is the precondition for #46.
sign_in() {
    local email="$1" body status response landing

    body="$(mktemp)"
    status="$(
        curl -s -o "$body" -w '%{http_code}' \
            -X POST "${API_BASE}/auth/magic/request" \
            -H 'Content-Type: application/json' \
            -H "Origin: ${PAGES_BASE}" \
            -d "{\"email\":\"${email}\",\"_dev\":true,\"next\":\"/accounts\"}"
    )"
    response="$(cat "$body")"
    rm -f "$body"

    [[ "$status" == "200" ]] ||
        fail "magic/request(${email}) got HTTP ${status}. body: ${response}"

    landing="$(echo "$response" | sed -nE 's/.*"landing_url":"([^"]+)".*/\1/p')"
    [[ -n "$landing" ]] || fail "200 but no landing_url. body: ${response}"

    ab open "$landing" > /dev/null
    ab wait --text "Sign in to djibb" > /dev/null
    click_button "Sign me in"
    ab wait --text "Signed-in accounts" > /dev/null
}

# The personal-workspace slug for an account, by email.
#
# Read from the API rather than the workspace-switcher dropdown on
# purpose: every account's personal workspace renders with the same label
# ("Your space"), so the menu cannot tell A's from B's — the one thing
# this test needs to do. Navigating to `/w/<slug>` is also how the app
# itself changes the current account (`/w/[slug]/+layout.svelte` calls
# `setActiveWorkspace`, which resolves the account), so this drives the
# real mechanism.
workspace_slug_for() {
    local email="$1"
    ab eval "(async () => {
        const session = await (await fetch('${API_BASE}/auth/session', {
            credentials: 'include'
        })).json();
        const account = session.accounts.find(a => a.email === '${email}');
        if (!account) return '';
        const spaces = await (await fetch(
            '${API_BASE}/' + account.id + '/workspaces',
            { credentials: 'include' }
        )).json();
        return spaces[0]?.workspace?.slug ?? '';
    })()" 2>/dev/null | tr -d '"' | tr -d '\n'
}

# ─── Preflight ─────────────────────────────────────────────────────────────

log "preflight: checking dev servers"
curl -sf -o /dev/null "${PAGES_BASE}/accounts" ||
    fail "pages dev server not reachable at ${PAGES_BASE}"
ok "pages reachable at ${PAGES_BASE}"
curl -sf -o /dev/null "${API_BASE}/" ||
    fail "worker dev server not reachable at ${API_BASE}"
ok "worker reachable at ${API_BASE}"

# ─── Step 1: two accounts on one session, a list owned by A ───────────────

log "step 1: sign in as A, create a list, sign in as B alongside"

sign_in "$EMAIL_A"
ok "signed in as A (${EMAIL_A})"

ab_retry open "${PAGES_BASE}/"
click_button "+ New list"
ab wait --text "Untitled List" > /dev/null
wait_for indicator "All changes saved" "fresh list reports all saved"

list_url="$(ab eval 'location.href' | tr -d '"' | tr -d '\n')"
[[ "$list_url" == *"/l/"* ]] || fail "expected to be on a list page, got ${list_url}"
# Strip the ?new=1 marker the route consumes on first load; re-arriving
# with it would only re-fire a doomed init.
list_url="${list_url%%\?*}"

rename_list "Untitled List" "Owned By A"
wait_for indicator "All changes saved" "A's edit reaches the server"

sign_in "$EMAIL_B"
ok "signed in as B (${EMAIL_B}) — both accounts now on the session"

slug_a="$(workspace_slug_for "$EMAIL_A")"
slug_b="$(workspace_slug_for "$EMAIL_B")"
[[ -n "$slug_a" && -n "$slug_b" ]] ||
    fail "could not resolve both workspace slugs (a='${slug_a}' b='${slug_b}')"
[[ "$slug_a" != "$slug_b" ]] || fail "A and B resolved to the same workspace"
ok "resolved both accounts' workspaces (a=${slug_a} b=${slug_b})"

# ─── Step 2: strand A's work — an offline edit that never reaches the server

log "step 2: queue an edit as A with the network down"

# Make A current again (signing B in may have left B's workspace active),
# then open the list as A.
ab_retry open "${PAGES_BASE}/w/${slug_a}"
ab_retry open "$list_url"
wait_for indicator "All changes saved" "list opens as A, all saved"

ab_retry set offline on
rename_list "Owned By A" "Stranded Edit"
wait_for indicator "1 pending" "A's offline edit is queued"

# ─── Step 3: B becomes current — the moment the bug bit ──────────────────

log "step 3: switch to B while offline, then reconnect and open the list"

# Load-bearing: switch *while still offline*. Reconnecting first would
# flush the very work we need to still be stuck — the queue drains
# whenever a client for that entity is open and the network is up.
#
# The navigation itself fails (offline, no document to fetch), which is
# fine: all we need is for A's client to be torn down and B's workspace
# to become the active one. `|| true` because a failed navigation is the
# expected outcome, not an error.
ab open "${PAGES_BASE}/w/${slug_b}" > /dev/null 2>&1 || true
ab_retry set offline off
ab_retry open "${PAGES_BASE}/w/${slug_b}"
ab_retry open "$list_url"

# B's own sync is *healthy* here — its store is empty, its pushes
# succeed. That is precisely why this used to read "All changes saved":
# every word of it was true about B and a lie about the list.
wait_for stranded_banner "1 unsaved change" \
    "the stranded-work banner counts the other account's queue (#46)"
[[ "$(stranded_banner)" == *"Another account has"* ]] ||
    fail "banner does not name the other account. saw: $(stranded_banner)"
ok "banner names the other account"

# The regression guard that matters. A missing banner would be a gap; an
# app actively asserting the opposite over stranded work is the trap #43
# and #46 both exist to close. Guard the lie directly.
[[ "$(indicator)" != *"All changes saved"* ]] ||
    fail "indicator claims 'All changes saved' while another account's work is stranded (#46)"
ok "indicator does not claim saved over the other account's work"

wait_for indicator "1 unsaved change from another account" \
    "indicator counts whose work is unsaved"

# ─── Step 4: the banner's advice actually works ──────────────────────────

log "step 4: 'Switch to that account' → A's queue drains, server has the edit"

click_button "Switch to that account"

# Switching rebuilds the client as A, which reopens `A:<list>` — the
# store the mutations were in all along — and its queue drains on its own.
wait_for indicator "All changes saved" "A's stranded queue flushes after the switch"
[[ "$(stranded_banner)" == "" ]] ||
    fail "stranded-work banner still showing after the queue drained"
ok "banner clears itself once the work is saved"

# "All changes saved" would also be true of a client that simply dropped
# its queue on the floor, so the indicator cannot be the proof. Ask the
# *server* what it has.
#
# This deliberately does NOT go through Replicache: a read that touches
# IndexedDB at all could be answered from the very optimistic local state
# under suspicion. `GET /list?l=<id>` is the DO's own copy, so a match
# here is a statement about the server and nothing else.
#
# (sync-status.sh proves the same property with a second, IndexedDB-empty
# browser session. That works, but it leans on the agent-browser daemon
# honouring `--state` for a session it may already have running — it
# warns and ignores it if so, which would quietly weaken the check into a
# vacuous one. A direct read has no such failure mode.)
list_id="l/$(basename "$list_url")"
server_copy="$(
    ab eval "(async () => {
        const r = await fetch('${API_BASE}/list?l=${list_id}', {
            credentials: 'include'
        });
        return r.ok ? JSON.stringify(await r.json()) : 'HTTP ' + r.status;
    })()" 2>/dev/null
)"
[[ "$server_copy" == *"Stranded Edit"* ]] ||
    fail "the server does not have the once-stranded edit — the work was lost. server said: ${server_copy}"
ok "the server has the once-stranded edit (read straight from the DO, not IndexedDB)"

# ─── Step 5: a stale claim must produce SILENCE, not a false alarm ────────

log "step 5: a claim with no work behind it says nothing"

# The ledger over-claims BY DESIGN: claims are stamped before the mutation
# fires, and only a client acting as the claimant ever retires one — which,
# on the #46 path, is the one account that is not here. So a claim can
# outlive its work, and the banner would be shouting about nothing.
#
# The fix is not to trust the claim: open that account's store and count
# what is actually in it (`probeUnflushed`). Here we forge the worst case —
# a claim for an account with no store at all — and require silence.
#
# Note we forge a claim for the SIGNED-OUT-OF shape (an account id that
# owns nothing here), which is exactly what a stale claim looks like after
# a discard timed out or a tab died between the stamp and the mutate.
ab eval "localStorage.setItem(
    'djibb.unflushed.${list_id}',
    JSON.stringify(['acct_ghost'])
)" > /dev/null

ab_retry reload
wait_for indicator "All changes saved" "the page settles after the reload"

# Give a banner every chance to appear before declaring silence — an
# assertion that races the probe would pass for the wrong reason.
sleep 3
[[ "$(stranded_banner)" == "" ]] ||
    fail "banner appeared for a claim with no work behind it. saw: $(stranded_banner)"
ok "no banner for a claim with nothing behind it"

[[ "$(indicator)" == *"All changes saved"* ]] ||
    fail "indicator contradicted itself over a phantom claim. saw: $(indicator)"
ok "indicator still reports the truth (all saved)"

# And the claim is LEFT ALONE. A zero probe cannot tell a stale claim from
# a live tab whose mutation hasn't been persisted yet, so deleting on that
# ambiguity would orphan work about to become durable — GH #43, rebuilt by
# hand. Silence is the fix; deletion is not.
ghost="$(ab eval "localStorage.getItem('djibb.unflushed.${list_id}') ?? ''" |
    tr -d '"' | tr -d '\n')"
[[ "$ghost" == *"acct_ghost"* ]] ||
    fail "the phantom claim was deleted — a zero probe must not retire a claim (saw: '${ghost}')"
ok "the claim survives: silence, not deletion"

log "✅ stranded-work E2E passed (${STAMP})"
