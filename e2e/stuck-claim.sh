#!/usr/bin/env bash
# stuck-claim.sh — End-to-end for GH #45: a stuck ledger claim on a
# shared device must not block anonymous editing of that entity.
#
# This is the #45 repro itself, driven against a real browser, a real
# worker, and a real DB.
#
#   1. Create a list ANONYMOUSLY (so an anonymous visitor can read and
#      edit it — a list A created while signed in is not readable by
#      anyone else, and "anonymous editing" of it was never on offer).
#      Then sign in as A, open it, and sync an edit as A.
#   2. Destroy A's session cookie, then edit again. The push claims A,
#      the DO refuses it (no session), the mutation queues in `A:<list>`
#      and the ledger claims it. This is the #6/#43 shape: work that is
#      safe but stuck, waiting for A to sign back in.
#   3. Reload. Now we ARE the anonymous visitor from #45: no session, a
#      ledger claim for A on this entity. `resolveEffectiveAccount` falls
#      back to the ledger — correctly, that is what keeps A's work
#      reachable — so the client acts as A, pushes as A, is refused, and
#      raises the non-dismissible "Session expired" banner. Before the
#      fix, that was the end of the road for anyone who is not A: shown
#      a banner about someone else's work, told to sign in as someone
#      they are not, unable to edit the list anonymously until A returns.
#
#      The ledger cannot tell "A came back" from "someone else is here"
#      — only the person in front of the screen knows. So the fix is not
#      a smarter rule; it is an explicit escape hatch: "Not you? Discard
#      and continue."
#   4. Take it. Assert the whole chain: the banner clears, the claim is
#      gone from the ledger, A's IndexedDB store is gone (not merely
#      unclaimed — a claim deleted alone would leave the mutations
#      rotting in a store nothing opens), the page shows the SERVER's
#      copy of the list rather than the discarded local edit, and an
#      anonymous edit now syncs with no banner.
#   5. Reload again and require silence: the resolution rule must now
#      land on anonymous durably, not just until the next load.
#
# What it doesn't cover (intentionally):
#   - The predicate deciding WHEN the hatch is offered, pinned directly
#     by unit tests (`canDisownAuthBlock`, packages/client).
#   - The signed-in-as-B variant, which the stranded-work banner already
#     covers with its own discard (e2e/stranded-work.sh, GH #46).
#
# Exit non-zero on any failure (set -e + explicit assertions).

set -euo pipefail

# ─── Configuration ─────────────────────────────────────────────────────────

PAGES_BASE="${PAGES_BASE:-http://localhost:5173}"
API_BASE="${API_BASE:-http://localhost:8787}"
SESSION="${AGENT_BROWSER_SESSION:-djibb-e2e-stuck-claim}"

STAMP="$(date +%s)-$$"
EMAIL="stuck-claim-${STAMP}@example.com"

# ─── Helpers (shared shape with stranded-work.sh) ──────────────────────────

ab() { agent-browser --session "$SESSION" "$@"; }

# agent-browser's daemon intermittently answers "Resource temporarily
# unavailable" on a command issued right after a heavy one. Reserved for
# commands whose *effect* is idempotent — never for assertions.
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

# innerText, trimmed; an absent element reads as "" (see stranded-work.sh
# for why `get text` won't do here).
read_text() {
    ab eval "document.querySelector('$1')?.innerText ?? ''" 2>/dev/null |
        tr -d '"' | tr '\n' ' ' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}
indicator() { read_text '[data-testid=sync-indicator]'; }
banner()    { read_text '[data-testid=session-expired-banner]'; }

# The ledger's claim for the list, raw. "" when there is none.
claim() {
    ab eval "localStorage.getItem('djibb.unflushed.${list_id}') ?? ''" 2>/dev/null |
        tr -d '"' | tr -d '\n'
}

# agent-browser does not scroll before clicking and reports success
# anyway. Scroll first, always. (See sync-status.sh for the autopsy.)
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

# Everything here polls: Replicache pushes on its own schedule.
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

rename_list() {
    local current="$1" next="$2" ref=""

    wait_body "$current" "list heading \"${current}\" is on the page" > /dev/null

    for _ in 1 2 3; do
        click_button "$current"
        sleep 1
        ref="$(ab snapshot -i -c | grep -m1 textbox | sed -nE 's/.*ref=(e[0-9]+).*/\1/p' || true)"
        [[ -n "$ref" ]] && break
    done
    [[ -n "$ref" ]] || fail "rename: no textbox appeared after clicking \"${current}\""

    ab fill "@${ref}" "$next" > /dev/null
    ab press Enter > /dev/null
}

# Magic-link dev seam; called once, so the per-email cooldown never bites.
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

# ─── Preflight ─────────────────────────────────────────────────────────────

log "preflight: checking dev servers"
curl -sf -o /dev/null "${PAGES_BASE}/accounts" ||
    fail "pages dev server not reachable at ${PAGES_BASE}"
ok "pages reachable at ${PAGES_BASE}"
curl -sf -o /dev/null "${API_BASE}/" ||
    fail "worker dev server not reachable at ${API_BASE}"
ok "worker reachable at ${API_BASE}"

# ─── Step 1: an anonymous list that A then edits ─────────────────────────

log "step 1: create a list anonymously, then sign in as A and edit it"

ab_retry open "${PAGES_BASE}/"
click_button "+ New list"
ab wait --text "Untitled List" > /dev/null
wait_for indicator "All changes saved" "fresh anonymous list reports all saved"

list_url="$(ab eval 'location.href' | tr -d '"' | tr -d '\n')"
[[ "$list_url" == *"/l/"* ]] || fail "expected to be on a list page, got ${list_url}"
list_url="${list_url%%\?*}"
list_id="l/$(basename "$list_url")"

rename_list "Untitled List" "Made Anonymously"
wait_for indicator "All changes saved" "the anonymous edit reaches the server"

sign_in "$EMAIL"
ok "signed in as A (${EMAIL})"

ab_retry open "$list_url"
rename_list "Made Anonymously" "Saved By A"
wait_for indicator "All changes saved" "A's edit reaches the server"

# ─── Step 2: strand an edit behind a dead session ─────────────────────────

log "step 2: kill A's session, then edit — the push is refused and queues"

ab cookies clear > /dev/null
rename_list "Saved By A" "Stuck As A"
wait_for banner "Session expired" "banner appears on persistent push 403"
wait_for banner "1 unsaved change" "banner counts the stuck edit"

account_id="$(claim)"
[[ -n "$account_id" ]] || fail "expected a ledger claim for the stuck edit, saw none"
# The claim is a JSON array of ids; one claimant here.
account_id="$(echo "$account_id" | tr -d '[]\\')"
ok "the ledger claims the edit for A (${account_id})"

# ─── Step 3: the anonymous visitor arrives ────────────────────────────────

log "step 3: reload as the anonymous visitor — trapped behind A's claim (#45)"

ab_retry reload
wait_body "Stuck As A" "reloaded page has rendered (acting as A, from the ledger)"
wait_for banner "Session expired" "the visitor is shown A's session-expired banner"

# The fix: the banner must OFFER a way out. Before, it did not, and a
# visitor who is not A had no move at all.
wait_for banner "Not you?" "the banner asks the one question only the visitor can answer"
[[ "$(banner)" == *"Discard and continue"* ]] ||
    fail "no escape hatch on the banner. saw: $(banner)"
ok "the escape hatch is offered"

# ─── Step 4: take it ──────────────────────────────────────────────────────

log "step 4: 'Discard and continue' → claim gone, store gone, anonymous edit syncs"

click_button "Discard and continue"

# The client is rebuilt as anonymous and pulls the SERVER's copy — so the
# discarded local edit must give way to the last synced name. This is
# what proves we opened a different store rather than the same one with
# a cleared claim.
wait_body "Saved By A" "page shows the server's copy, not the discarded edit"
wait_for indicator "All changes saved" "anonymous client is healthy"
[[ "$(banner)" == "" ]] ||
    fail "session-expired banner still showing after the discard. saw: $(banner)"
ok "banner cleared"

[[ "$(claim)" == "" ]] ||
    fail "the ledger still claims the entity for A after the discard (saw: '$(claim)')"
ok "the claim is retired"

# Not merely unclaimed — GONE. A claim deleted on its own would leave the
# mutations rotting in a store nothing will ever open again.
store_survives="$(
    ab eval "(async () => {
        const dbs = await indexedDB.databases();
        return dbs.some(d => (d.name ?? '').includes('${account_id}:${list_id}'));
    })()" 2>/dev/null | tr -d '\n'
)"
[[ "$store_survives" == "false" ]] ||
    fail "A's IndexedDB store still exists after the discard (databases() reported: ${store_survives})"
ok "A's store is dropped"

# And the whole point: the visitor can now edit anonymously. The push is
# accepted (no 403, no banner) and the queue drains.
rename_list "Saved By A" "Edited Anonymously"
wait_for indicator "All changes saved" "an anonymous edit syncs"
[[ "$(banner)" == "" ]] ||
    fail "banner reappeared on an anonymous edit. saw: $(banner)"
ok "no banner on the anonymous edit"

# ─── Step 5: it sticks ────────────────────────────────────────────────────

log "step 5: a reload stays anonymous — the trap does not re-arm"

ab_retry reload
wait_for indicator "All changes saved" "reloaded page settles"
sleep 3
[[ "$(banner)" == "" ]] ||
    fail "session-expired banner came back after the reload. saw: $(banner)"
ok "no banner after the reload"
[[ "$(claim)" == "" ]] ||
    fail "a claim reappeared after the reload (saw: '$(claim)')"
ok "no claim after the reload"

log "✅ stuck-claim E2E passed (${STAMP})"
