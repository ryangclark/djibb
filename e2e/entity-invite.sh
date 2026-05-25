#!/usr/bin/env bash
# entity-invite.sh — Two-session end-to-end for ADR 0009 entity
# invitations.
#
# Greens as of 2026-05-25 against the local dev stack. Drove out a
# pile of intermediate-state bugs along the way; see
# `docs/handoffs/2026-05-25-invitation-flow-corners-cut.md` for the
# catalog (some real-bug fixes, some corners cut, all with cleanup
# paths).
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

# 21 chars of lowercase hex. The validator (workers/src/id/index.ts
# `ID_SUFFIX_RE`) requires exactly `ID_LENGTH = 21` characters drawn
# from nanoid's `urlAlphabet` (A-Za-z0-9_-); hex is a strict subset
# of that alphabet, so 21 hex chars is a valid suffix.
#
# `openssl rand -hex 11` emits 22 chars; bash slicing trims to 21
# without a pipe — avoids the classic `tr … | head -c N`
# SIGPIPE-under-pipefail trap (head closes pipe early, tr exits 141,
# `set -o pipefail` propagates).
list_suffix() {
    local hex
    hex="$(openssl rand -hex 11)"
    printf '%s' "${hex:0:21}"
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

# Close + reopen an agent-browser session. Session cookies persist
# (they're keyed by `--session <name>`), but the daemon process
# restarts. Used once after sign-in to clear cross-origin redirect
# state, mirroring magic-link.sh's one close+reopen between phases.
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

# Apply any pending D1 migrations to the local DB. ADR 0009 introduced
# `entity_invitations_index` (0007); without this the invitee's
# `acceptInvitation` push 500s on `no such table`. `wrangler dev`
# doesn't auto-apply migrations and the vitest suite manages its own
# schema, so this is on us. The CLI is idempotent — applying already-
# applied migrations is a no-op — so this is safe to run on every
# invocation.
log "preflight: applying any pending D1 migrations"
if ! (
    cd "$(dirname "$0")/../workers" && \
    npx wrangler d1 migrations apply DJIBB_AUTH --local \
        > /dev/null 2>&1
); then
    fail "failed to apply D1 migrations. Run \`cd workers && npx wrangler d1 migrations apply DJIBB_AUTH --local\` manually to see the error."
fi
ok "D1 migrations applied"

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

# Land on /accounts (not /workspaces) post-sign-in. /workspaces
# mounts a workspace-list Replicache client + websocket; the open
# CDP channel races those subscriptions and the very next `open`
# call returns "Resource temporarily unavailable (os error 35)".
# /accounts is a static signed-in destination — proven quiet by
# magic-link.sh — and we only need *a* signed-in session here,
# not a particular landing page.
inviter_landing="$(mint_landing_url "$INVITER_EMAIL" "/accounts")"
ok "minted inviter landing URL"

ab_inviter open "$inviter_landing" > /dev/null
ab_inviter wait --text "Sign in to djibb" > /dev/null
ab_inviter find role button click --name "Sign me in" > /dev/null
ab_inviter wait --text "Signed-in accounts" > /dev/null
ok "inviter signed in, landed on /accounts"

# ─── Step 2: Inviter creates a fresh list via direct navigation ───────────

log "step 2: inviter navigates to /l/${LIST_SUFFIX}/share (fires initList)"

# The share route's +page.svelte calls `initList` the same way
# /l/[id]/+page.svelte does. Visiting a fresh ID triggers the init
# mutation; the route renders the Share component once the entity
# loads.
ab_inviter open "${PAGES_BASE}/l/${LIST_SUFFIX}/share" > /dev/null
ab_inviter wait --text "Share list" > /dev/null
ok "share page rendered (list initialized)"

# ─── Step 3: Inviter sends the invitation ─────────────────────────────────

log "step 3: inviter fills the invite form for ${INVITEE_EMAIL}"

ab_inviter find label "Invite by email" fill "$INVITEE_EMAIL" > /dev/null
ab_inviter find role button click --name "Send invite" > /dev/null

# The form shows "Invitation sent." after success (Share.svelte
# `inviteSentAt` state). Then the pending-invite row should appear
# in the "Pending invitations" section once Replicache pulls back.
ab_inviter wait --text "Invitation sent" > /dev/null
ok "submit form returned success state"

# The pending invite renders with the invitee email in a <code>
# element under "Pending invitations". Wait on the email text
# directly — its presence in the DOM means the realtime
# pull/poke round-trip completed.
ab_inviter wait --text "$INVITEE_EMAIL" > /dev/null
ok "pending invite visible on inviter's share page"

# ─── Step 4: Invitee signs in ──────────────────────────────────────────────

log "step 4: invitee signs in via magic-link, redirected to accept URL"

# `next=/l/<suffix>?from_invite=1` rides through the magic-link
# consume's redirect. ADR 0010 + magic.ts `sanitizeNext` allow
# local paths including query strings; the recent
# magic-link.svelte change passes `next` through end-to-end.
invitee_landing="$(mint_landing_url "$INVITEE_EMAIL" "/l/${LIST_SUFFIX}?from_invite=1")"
ok "minted invitee landing URL"

ab_invitee open "$invitee_landing" > /dev/null
ab_invitee wait --text "Sign in to djibb" > /dev/null
ab_invitee find role button click --name "Sign me in" > /dev/null

# After consume → redirect to /l/<suffix>?from_invite=1 → page
# loads → InviteBanner renders. Wait on the banner's headline text.
ab_invitee wait --text "You've been invited" > /dev/null
ok "invitee landed on entity page, accept banner visible"

# ─── Step 5: Invitee accepts ──────────────────────────────────────────────

log "step 5: invitee clicks Accept"

# The banner's accept button label is exactly
# "Accept as <email>" (see InviteBanner.svelte). Match by name to
# avoid relying on ref numbers.
ab_invitee find role button click --name "Accept as ${INVITEE_EMAIL}" > /dev/null

# Post-accept: banner dismisses (alreadyAuthorized derives true
# from the new authorized_accounts entry), List component renders.
# Fresh list with no name shows "Untitled List" — that's our
# "role gate flipped + list rendered" signal.
ab_invitee wait --text "Untitled List" > /dev/null
ok "invitee can read the list (role gate promoted)"

# ─── Step 6: Inviter sees the pending invite drain in realtime ────────────

log "step 6: inviter's share page reflects acceptance (no reload)"

# The inviter's session never navigated away from /l/<suffix>/share.
# When the invitee's acceptInvitation commit emits, the inviter's
# websocket gets a poke, Replicache pulls, the pending invite
# tombstone propagates, and the "Pending invitations" section
# flips to its empty-state copy.
ab_inviter wait --text "No invitations are currently pending" > /dev/null
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
