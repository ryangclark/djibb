#!/usr/bin/env bash
# entity-invite.sh — Two-session end-to-end for ADR 0009 entity
# invitations.
#
# ─── STATUS: BLOCKED ──────────────────────────────────────────────
#
# This script is parked, NOT currently passing. Initial runs
# (2026-05-18, agent-browser 0.27.0) wedged on Step 2: the
# /l/<id>/share page persists "Loading list…" indefinitely after
# a fresh List has been initialized. Same wedge via direct URL nav
# AND via in-app SPA flow (`+ New list` → Meta+Shift+S). Full
# diagnosis, code paths, hypotheses, and suggested debugging
# approach live in:
#
#   docs/handoffs/2026-05-18-share-page-loading-wedge.md
#
# Re-enabling: once that bug is fixed and the manual repro at the
# top of the handoff doc reliably succeeds, re-run this script.
# Iterate on any remaining test-side flakes — the script body
# below is intended to pass as-is post-fix.
#
# ──────────────────────────────────────────────────────────────────
#
# Drives a real browser through the full happy path:
#
#   1. Inviter session (magic-link sign-in) creates a fresh List
#      and sends an email invite to the invitee.
#   2. Invitee session (magic-link sign-in as the invited email)
#      lands on /l/<id>?from_invite=1, sees the accept banner, and
#      clicks "Accept as <email>".
#   3. Verify: invitee can now view the List (role gate flipped).
#   4. Verify: inviter's Share page transitions from "1 pending" to
#      "no invitations pending" — the cross-session pull/poke
#      delivered the tombstone live (no manual reload assumed).
#
# Email content itself is NOT inspected here — the workers vitest
# suite asserts the send call shape (`workers/test/entityInvitations.test.ts`).
# This script exercises the user-visible wiring: form submission,
# realtime sync, accept-side banner + role flip. The accept URL is
# constructed deterministically from the list ID the script just
# created; no email-capture seam needed.
#
# Sessions are kept isolated via two distinct `--session` flags so
# cookies / Replicache state don't leak between inviter and invitee.
#
# Exits non-zero on first assertion failure.

set -euo pipefail

# ─── Configuration ─────────────────────────────────────────────────────────

PAGES_BASE="${PAGES_BASE:-http://localhost:5173}"
API_BASE="${API_BASE:-http://localhost:8787}"
INVITER_SESSION="${INVITER_SESSION:-djibb-e2e-invite-inviter}"
INVITEE_SESSION="${INVITEE_SESSION:-djibb-e2e-invite-invitee}"

STAMP="$(date +%s)-$$"
INVITER_EMAIL="inviter-${STAMP}@example.com"
INVITEE_EMAIL="invitee-${STAMP}@example.com"

# 22 chars of lowercase hex. Avoids the classic `tr … | head -c 22`
# SIGPIPE-under-pipefail trap (head closes the pipe early, tr
# exits 141, `set -o pipefail` propagates). `openssl rand -hex 11`
# produces exactly 22 characters in one shot. The DO ID is just
# a stable string; the validator accepts anything matching the
# prefix + suffix shape — hex is a narrower alphabet than nanoid
# but plenty wide enough for per-run uniqueness.
list_suffix() {
    openssl rand -hex 11
}
LIST_SUFFIX="$(list_suffix)"
LIST_ID="l/${LIST_SUFFIX}"
ACCEPT_URL="${PAGES_BASE}/l/${LIST_SUFFIX}?from_invite=1"

# ─── Helpers ───────────────────────────────────────────────────────────────

ab_inviter() {
    agent-browser --session "$INVITER_SESSION" "$@"
}
ab_invitee() {
    agent-browser --session "$INVITEE_SESSION" "$@"
}

# Retry wrapper for transient daemon errors during cross-origin
# navigations. Five attempts with 2s spacing — this script does
# more cross-origin work than magic-link.sh / rate-limit.sh (two
# sign-ins, each crossing worker → pages), and a tighter retry
# budget surfaced false-fail daemon-busy errors in step 2 during
# initial development.
retry() {
    local attempt
    for attempt in 1 2 3 4 5; do
        if "$@"; then return 0; fi
        if (( attempt < 5 )); then sleep 2; fi
    done
    return 1
}

# Close + reopen an agent-browser session. Session cookies persist
# (they're keyed by `--session <name>`), but the daemon process
# restarts — which clears the "daemon busy" state that recurs
# right after a cross-origin redirect (the magic-link consume's
# worker→pages 302 is one such case). Use between phases that
# would otherwise reuse the same daemon across a cross-origin
# boundary. Matches the pattern in magic-link.sh.
reset_inviter() {
    ab_inviter close > /dev/null 2>&1 || true
}
reset_invitee() {
    ab_invitee close > /dev/null 2>&1 || true
}

cleanup() {
    ab_inviter close 2>/dev/null || true
    ab_invitee close 2>/dev/null || true
}
trap cleanup EXIT

log()  { printf '\033[36m[e2e]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ok\033[0m  %s\n' "$*"; }
fail() {
    printf '\033[31mFAIL\033[0m  %s\n' "$*" >&2
    exit 1
}

# Mint a magic-link landing URL via the dev seam. Returns the URL
# on stdout. The seam (ADR 0010 supplement) requires `_dev: true`
# AND `ENV=dev` in workers/.dev.vars.
mint_landing_url() {
    local email="$1"
    local next="$2"
    local body_file status response landing_url
    body_file="$(mktemp)"
    status="$(
        curl -s -o "$body_file" -w '%{http_code}' \
            -X POST "${API_BASE}/auth/magic/request" \
            -H 'Content-Type: application/json' \
            -H "Origin: ${PAGES_BASE}" \
            -d "{\"email\":\"${email}\",\"_dev\":true,\"next\":\"${next}\"}"
    )"
    response="$(cat "$body_file")"
    rm -f "$body_file"
    if [[ "$status" != "200" ]]; then
        fail "mint_landing_url(${email}): HTTP ${status}. body: ${response}"
    fi
    landing_url="$(echo "$response" | sed -nE 's/.*"landing_url":"([^"]+)".*/\1/p')"
    if [[ -z "$landing_url" ]]; then
        fail "mint_landing_url(${email}): no landing_url in response: ${response}"
    fi
    echo "$landing_url"
}

# ─── Preflight ─────────────────────────────────────────────────────────────

log "preflight: checking dev servers"

curl -sf -o /dev/null "${PAGES_BASE}/accounts" \
    || fail "pages not reachable at ${PAGES_BASE} — run \`cd pages && npm run dev\`"
ok "pages reachable at ${PAGES_BASE}"

curl -sf -o /dev/null "${API_BASE}/" \
    || fail "worker not reachable at ${API_BASE} — run \`cd workers && npm run dev\`"
ok "worker reachable at ${API_BASE}"

# Reset magic_link_tokens so per-email/per-IP rate-limit buckets
# from a recent run don't bite when minting two landing URLs in
# quick succession. Same posture as rate-limit.sh.
log "preflight: resetting magic_link_tokens"
if ! (
    cd "$(dirname "$0")/../workers" && \
    npx wrangler d1 execute DJIBB_AUTH --local \
        --command "DELETE FROM magic_link_tokens" \
        > /dev/null 2>&1
); then
    fail "failed to reset magic_link_tokens. Is workers/.wrangler local D1 initialized?"
fi
ok "magic_link_tokens cleared"

log "preflight: this run"
log "  inviter: ${INVITER_EMAIL}"
log "  invitee: ${INVITEE_EMAIL}"
log "  list:    ${LIST_ID}"

# ─── Step 1: Inviter signs in ──────────────────────────────────────────────

log "step 1: inviter signs in via magic-link"

inviter_landing="$(mint_landing_url "$INVITER_EMAIL" "/workspaces")"
ok "minted inviter landing URL"

retry ab_inviter open "$inviter_landing" > /dev/null
retry ab_inviter wait --text "Sign in to djibb" > /dev/null
retry ab_inviter find role button click --name "Sign me in" > /dev/null
# Land on /workspaces (the configured `next` target). "Workspaces"
# is the page's h1 — content-wait is more reliable than url-glob
# across the cross-origin redirect (per docs/testing.md).
retry ab_inviter wait --text "Workspaces" > /dev/null
ok "inviter signed in, landed on /workspaces"

# Close the inviter daemon between phases. The just-completed
# magic-link consume crossed worker → pages, which surfaces
# "daemon busy" errors on the very next navigation if reused.
# Cookies survive (keyed on --session name); only the daemon
# process restarts.
reset_inviter
ok "inviter session reset (post-redirect cleanup)"

# ─── Step 2: Inviter creates a fresh list via direct navigation ───────────

log "step 2: inviter navigates to /l/${LIST_SUFFIX}/share (fires initList)"

# The share route's +page.svelte calls `initList` the same way
# /l/[id]/+page.svelte does. Visiting a fresh ID triggers the init
# mutation; the route renders the Share component once the entity
# loads.
retry ab_inviter open "${PAGES_BASE}/l/${LIST_SUFFIX}/share" > /dev/null
retry ab_inviter wait --text "Share list" > /dev/null
ok "share page rendered (list initialized)"

# ─── Step 3: Inviter sends the invitation ─────────────────────────────────

log "step 3: inviter fills the invite form for ${INVITEE_EMAIL}"

retry ab_inviter find label "Invite by email" fill "$INVITEE_EMAIL" > /dev/null
retry ab_inviter find role button click --name "Send invite" > /dev/null

# The form shows "Invitation sent." after success (Share.svelte
# `inviteSentAt` state). Then the pending-invite row should appear
# in the "Pending invitations" section once Replicache pulls back.
retry ab_inviter wait --text "Invitation sent" > /dev/null
ok "submit form returned success state"

# The pending invite renders with the invitee email in a <code>
# element under "Pending invitations". Wait on the email text
# directly — its presence in the DOM means the realtime
# pull/poke round-trip completed.
retry ab_inviter wait --text "$INVITEE_EMAIL" > /dev/null
ok "pending invite visible on inviter's share page"

# ─── Step 4: Invitee signs in ──────────────────────────────────────────────

log "step 4: invitee signs in via magic-link, redirected to accept URL"

# `next=/l/<suffix>?from_invite=1` rides through the magic-link
# consume's redirect. ADR 0010 + magic.ts `sanitizeNext` allow
# local paths including query strings; the recent
# magic-link.svelte change passes `next` through end-to-end.
invitee_landing="$(mint_landing_url "$INVITEE_EMAIL" "/l/${LIST_SUFFIX}?from_invite=1")"
ok "minted invitee landing URL"

retry ab_invitee open "$invitee_landing" > /dev/null
retry ab_invitee wait --text "Sign in to djibb" > /dev/null
retry ab_invitee find role button click --name "Sign me in" > /dev/null

# After consume → redirect to /l/<suffix>?from_invite=1 → page
# loads → InviteBanner renders. Wait on the banner's headline text.
retry ab_invitee wait --text "You've been invited" > /dev/null
ok "invitee landed on entity page, accept banner visible"

# ─── Step 5: Invitee accepts ──────────────────────────────────────────────

log "step 5: invitee clicks Accept"

# The banner's accept button label is exactly
# "Accept as <email>" (see InviteBanner.svelte). Match by name to
# avoid relying on ref numbers.
retry ab_invitee find role button click --name "Accept as ${INVITEE_EMAIL}" > /dev/null

# Post-accept: banner dismisses (alreadyAuthorized derives true
# from the new authorized_accounts entry), List component renders.
# Fresh list with no name shows "Untitled List" — that's our
# "role gate flipped + list rendered" signal.
retry ab_invitee wait --text "Untitled List" > /dev/null
ok "invitee can read the list (role gate promoted)"

# ─── Step 6: Inviter sees the pending invite drain in realtime ────────────

log "step 6: inviter's share page reflects acceptance (no reload)"

# The inviter's session never navigated away from /l/<suffix>/share.
# When the invitee's acceptInvitation commit emits, the inviter's
# websocket gets a poke, Replicache pulls, the pending invite
# tombstone propagates, and the "Pending invitations" section
# flips to its empty-state copy.
retry ab_inviter wait --text "No invitations are currently pending" > /dev/null
ok "pending invite drained on inviter side (live)"

# Sanity: the invitee email should NO LONGER appear in a pending
# invite row. The snapshot text won't have it under "Pending
# invitations" (it might still appear elsewhere if the People-
# with-access section ever surfaces emails, which it doesn't
# today — accounts are rendered by ID). For robustness, just
# confirm the pending-section empty-state text is the one that
# remains.

log "✅ entity-invite E2E passed (${STAMP})"
log "  inviter: ${INVITER_EMAIL}"
log "  invitee: ${INVITEE_EMAIL}"
log "  list:    ${LIST_ID}"
