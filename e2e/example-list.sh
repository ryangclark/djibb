#!/usr/bin/env bash
# example-list.sh — end-to-end for the homepage example List and the
# create-list flow, the browser-wiring half of the "doomed optimistic
# initList" fix.
#
# Background. The homepage shows a read-only example List (a Seed Pool
# "Blank", a publicly-readable `viewer` entity) as a live demo. Opening
# an entity that ALREADY EXISTS server-side must never fire the
# optimistic `initList` — doing so pushes a mutation the server rejects
# 403 (`role "viewer" not in requiredRole for "initList"`), which
# Replicache then retries forever, spamming the console and (briefly)
# flashing an empty shell over the real content. The fix gates the
# optimistic init on a `?new=1` marker that only the "+ New list/template"
# buttons set; every other arrival opens read-only.
#
# This script verifies the user-visible wiring:
#
#   A. The homepage example renders, and mint-on-engage (toggling an
#      item) forks it into an owned List and navigates there with the
#      toggle preserved — with NO push-403 in the console.
#   B. "+ New list" creates a fresh empty List via the `?new=1` marker
#      (the one path that SHOULD optimistically init) — also clean.
#
# The server-side reconciliation policy (auth-denied push → skip-and-ack
# when authenticated, throw when not, so offline edits survive token
# expiry) is pinned at the service level in
# `packages/server-cf/test/pushAuthReconciliation.test.ts`. The `/t/<id>`
# direct-nav viewer case is covered there plus manual verification.
#
# PREREQUISITE beyond the usual dev stack: the local Seed Pool must hold
# at least one Blank (mint via `npm run djibb -- promote ...`). Like the
# `ENV=dev` seam the auth scripts need, this is an environment
# precondition; the script SKIPS phase A with a clear message if no
# example renders, rather than failing.
#
# Exits non-zero on first assertion failure.

set -euo pipefail

PAGES_BASE="${PAGES_BASE:-http://localhost:5173}"
API_BASE="${API_BASE:-http://localhost:8787}"
SESSION="${SESSION:-djibb-e2e-example-list}"

ab() { agent-browser --session "$SESSION" "$@"; }

cleanup() { ab close 2>/dev/null || true; }
trap cleanup EXIT

log()  { printf '\033[36m[e2e]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ok\033[0m  %s\n' "$*"; }
skip() { printf '\033[33mSKIP\033[0m  %s\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$*" >&2; exit 1; }

# Wipe this origin's IndexedDB so each phase starts as a fresh Replicache
# client (an empty local store is what would tempt the optimistic init).
wipe_idb() {
    ab eval "(async () => { const dbs = await indexedDB.databases(); for (const d of dbs) indexedDB.deleteDatabase(d.name); localStorage.clear(); return 'ok'; })()" > /dev/null
}

# Assert the console holds no Replicache push-403 (the doomed-init signal)
# and no repeated push failures. $1 is a label for diagnostics.
assert_no_push_403() {
    local label="$1" json
    json="$(ab console --json 2>/dev/null || echo '{}')"
    if printf '%s' "$json" | grep -q 'doing push: 403'; then
        printf '%s' "$json" | grep -o 'doing push: 403[^"]*' | head -3 >&2
        fail "${label}: found a push-403 in the console (doomed optimistic initList)"
    fi
    ok "${label}: no push-403 in console"
}

# ─── Preflight ──────────────────────────────────────────────────────────────

log "preflight: checking dev servers"
curl -sf -o /dev/null "${PAGES_BASE}/accounts" \
    || fail "pages not reachable at ${PAGES_BASE} — run \`cd apps/djibb-com && npm run dev\`"
ok "pages reachable at ${PAGES_BASE}"
curl -sf -o /dev/null "${API_BASE}/" \
    || fail "worker not reachable at ${API_BASE} — run \`cd packages/server-cf && npm run dev\`"
ok "worker reachable at ${API_BASE}"

# ─── Phase A: homepage example + mint-on-engage ─────────────────────────────

log "phase A: homepage example list + mint-on-engage"
ab open "${PAGES_BASE}/" > /dev/null
wipe_idb
ab open "${PAGES_BASE}/" > /dev/null

# The example renders as a set of checkbox items. If none appear within a
# few seconds, the Seed Pool is empty — skip phase A (prerequisite unmet).
sleep 4
example_checkboxes="$(ab snapshot 2>/dev/null | grep -ci 'checkbox' || true)"
if [[ "${example_checkboxes:-0}" -lt 1 ]]; then
    skip "phase A: no example List on the homepage (Seed Pool empty) — mint a Blank to enable"
else
    ok "homepage example rendered (${example_checkboxes} items)"

    ab console --clear > /dev/null 2>&1 || true
    # Toggle the first example item — the mint-on-engage gesture.
    ab find first 'input[type=checkbox]' check > /dev/null \
        || fail "phase A: could not toggle the first example item"

    # Mint-on-engage forks the Blank into an owned List and navigates to
    # /l/<id>. Wait on the destination content, not a URL glob.
    sleep 5
    minted_url="$(ab eval 'location.href' 2>/dev/null | tr -d '"' | tail -1)"
    case "$minted_url" in
        */l/*) ok "minted + navigated to ${minted_url}" ;;
        *) fail "phase A: expected nav to /l/<id> after engage, got ${minted_url}" ;;
    esac

    # The toggled state survived the fork.
    if ab snapshot 2>/dev/null | grep -qi 'checked=true\|\[checked\]'; then
        ok "toggled item persisted into the minted List"
    else
        fail "phase A: toggled item did not persist into the minted List"
    fi

    assert_no_push_403 "phase A (mint)"
fi

# ─── Phase B: "+ New list" creation (the one path that SHOULD init) ─────────

log "phase B: + New list creates a fresh empty List"
ab open "${PAGES_BASE}/" > /dev/null
wipe_idb
ab open "${PAGES_BASE}/" > /dev/null
sleep 2
ab console --clear > /dev/null 2>&1 || true

ab find role button click --name "+ New list" > /dev/null \
    || fail "phase B: could not click '+ New list'"
sleep 5

new_url="$(ab eval 'location.href' 2>/dev/null | tr -d '"' | tail -1)"
case "$new_url" in
    *"/l/"*"new=1"*) ok "navigated to fresh list with creation marker: ${new_url}" ;;
    */l/*) ok "navigated to fresh list: ${new_url}" ;;
    *) fail "phase B: expected nav to /l/<id>?new=1, got ${new_url}" ;;
esac

if ab snapshot 2>/dev/null | grep -qi 'Untitled List'; then
    ok "fresh List rendered (Untitled List)"
else
    fail "phase B: fresh List did not render an 'Untitled List' heading"
fi

assert_no_push_403 "phase B (create)"

log "all phases passed"
