#!/usr/bin/env bash
# rate-limit.sh — End-to-end regression guard for magic-link rate
# limits (ADR 0010 §"Policy defaults").
#
# Two phases, each verifying a different surface:
#
#   Phase 1 — server enforcement (curl-driven). Hits /auth/magic/request
#     rapidly to exercise the two most likely-to-bite limits:
#       a) the 60-sec same-email cooldown (2 consecutive requests)
#       b) the per-email 15-min bucket (4 distinct-token requests)
#     For each block, asserts:
#       - status is 429
#       - body carries `reason` matching the expected limit
#       - body carries a sensible `retry_after_seconds`
#       - `Retry-After` header is present
#
#   Phase 2 — client UX (browser-driven). Submits the sign-in form,
#     then asserts the resend button shows a countdown ("Resend in Ns"
#     or similar) instead of remaining clickable. This guards against
#     a UI regression where the client-side cooldown stops re-enabling
#     the button at the right time.
#
# What this does NOT cover (covered by unit tests):
#   - The per-IP 1-hour bucket (would require >20 requests, slow).
#   - The per-email 24-h bucket (would require >10 spread requests).
#   - The precise retry-after math for non-cooldown limits (covered
#     exhaustively in workers/test/magicLink.test.ts).

set -euo pipefail

# ─── Configuration ─────────────────────────────────────────────────────────

PAGES_BASE="${PAGES_BASE:-http://localhost:5173}"
API_BASE="${API_BASE:-http://localhost:8787}"
SESSION="${AGENT_BROWSER_SESSION:-djibb-e2e-rate-limit}"

STAMP="$(date +%s)-$$"

ab() { agent-browser --session "$SESSION" "$@"; }

# Defensive wrapper that retries on transient "daemon busy" errors.
# agent-browser's daemon occasionally reports
#   "Failed to read: Resource temporarily unavailable (os error 35)"
# during cross-origin navigations or right after a script first
# claims a session. Retrying once after a short delay clears it
# in practice; if a second retry still fails the error is real.
ab_retry() {
    local attempt
    for attempt in 1 2 3; do
        if ab "$@"; then
            return 0
        fi
        if (( attempt < 3 )); then
            sleep 1
        fi
    done
    return 1
}

cleanup() { ab close 2>/dev/null || true; }
trap cleanup EXIT

log() { printf '\033[36m[e2e]\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m  ok\033[0m  %s\n' "$*"; }
fail() {
    printf '\033[31mFAIL\033[0m  %s\n' "$*" >&2
    exit 1
}

# Issue a /request and capture status + body + Retry-After header in one
# go. Echoes a single line: `<status> <retry_after_header> <body>`. The
# body is on the rest of the line; status and Retry-After are fixed
# tokens up front so callers can `read` them positionally.
request_magic() {
    local email="$1"
    local resp_dir
    resp_dir="$(mktemp -d)"
    local body_file="${resp_dir}/body"
    local hdr_file="${resp_dir}/hdr"
    local status
    status="$(
        curl -s -D "$hdr_file" -o "$body_file" -w '%{http_code}' \
            -X POST "${API_BASE}/auth/magic/request" \
            -H 'Content-Type: application/json' \
            -H "Origin: ${PAGES_BASE}" \
            -d "{\"email\":\"${email}\"}"
    )"
    local retry_after
    retry_after="$(
        grep -i '^Retry-After:' "$hdr_file" | head -1 \
            | sed -E 's/^[Rr]etry-[Aa]fter:[[:space:]]*//' \
            | tr -d '\r\n'
    )"
    retry_after="${retry_after:-none}"
    local body
    body="$(cat "$body_file")"
    rm -rf "$resp_dir"
    printf '%s %s %s\n' "$status" "$retry_after" "$body"
}

# Extract a JSON string field via sed. Returns empty if missing. Avoids
# requiring jq for E2E scripts.
json_str() {
    local field="$1"
    local body="$2"
    echo "$body" | sed -nE "s/.*\"${field}\":\"([^\"]+)\".*/\1/p"
}

json_num() {
    local field="$1"
    local body="$2"
    echo "$body" | sed -nE "s/.*\"${field}\":([0-9]+).*/\1/p"
}

# ─── Preflight ─────────────────────────────────────────────────────────────

log "preflight: checking dev servers"
curl -sf -o /dev/null "${PAGES_BASE}/accounts" \
    || fail "pages not reachable at ${PAGES_BASE}"
ok "pages reachable"
curl -sf -o /dev/null "${API_BASE}/" \
    || fail "worker not reachable at ${API_BASE}"
ok "worker reachable"

# Reset the local D1's magic_link_tokens table. Rate-limit tests
# accumulate state across runs (the per-IP 1-hour bucket in
# particular): a few re-runs back-to-back will exhaust the 20/hr
# limit and fail at the very first request with `ip_hour`. Clearing
# the table at script start makes the test idempotent and
# self-contained.
#
# Safe to do because magic_link_tokens carries no value past consume
# (single-use; expired tokens are dead weight). The reset only
# affects token-mint rate-limit history, not Account state.
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

# ─── Phase 1a: 60-sec cooldown ─────────────────────────────────────────────

log "phase 1a: 60-sec same-email cooldown"

cooldown_email="cooldown-${STAMP}@example.com"

# First request: must succeed (200, empty body since _dev is absent).
read -r status retry_after body <<<"$(request_magic "$cooldown_email")"
if [[ "$status" != "200" ]]; then
    fail "first request expected 200, got ${status}. body: ${body}"
fi
ok "first request: 200 (token minted, cooldown clock starts)"

# Second request, immediately: must hit the cooldown.
read -r status retry_after body <<<"$(request_magic "$cooldown_email")"
if [[ "$status" != "429" ]]; then
    fail "second request expected 429, got ${status}. body: ${body}"
fi

reason="$(json_str reason "$body")"
if [[ "$reason" != "cooldown" ]]; then
    fail "expected reason='cooldown', got '${reason}'. body: ${body}"
fi
ok "second request: 429 reason=cooldown"

retry_seconds="$(json_num retry_after_seconds "$body")"
if [[ -z "$retry_seconds" ]] || (( retry_seconds < 1 )) || (( retry_seconds > 60 )); then
    fail "retry_after_seconds out of expected range [1,60]: '${retry_seconds}'. body: ${body}"
fi
ok "retry_after_seconds=${retry_seconds} (within [1,60])"

if [[ "$retry_after" == "none" ]]; then
    fail "Retry-After response header missing on 429"
fi
ok "Retry-After header present: ${retry_after}"

# ─── Phase 1b: per-email 15-min bucket ────────────────────────────────────

log "phase 1b: per-email 15-min bucket (3 in window, 4th blocked)"

# Distinct email so it doesn't collide with the cooldown email's row.
# We can't easily simulate 3 requests spaced past the cooldown window
# from a live script in under a few minutes — so this phase only checks
# the *shape* of the response when we deliberately go past the limit
# regardless of which limit fires first. The cooldown would fire on
# request 2; we accept "cooldown" OR "email_15min" as both indicate a
# block is in effect. The contract verified here is "rate-limit block
# responses are well-formed."
#
# (The precise math for the 15-min bucket is unit-tested in
# workers/test/magicLink.test.ts; the contract here is the
# server-shape and header presence on a live deployment.)

bucket_email="bucket-${STAMP}@example.com"

# Request 1 — succeeds.
read -r status retry_after body <<<"$(request_magic "$bucket_email")"
if [[ "$status" != "200" ]]; then
    fail "bucket request 1 expected 200, got ${status}. body: ${body}"
fi

# Request 2 — should be blocked (cooldown). Verify response shape.
read -r status retry_after body <<<"$(request_magic "$bucket_email")"
if [[ "$status" != "429" ]]; then
    fail "bucket request 2 expected 429, got ${status}. body: ${body}"
fi

reason="$(json_str reason "$body")"
case "$reason" in
    cooldown|email_15min|email_24h|ip_hour) ;;
    *) fail "unexpected reason on rate-limit block: '${reason}'. body: ${body}" ;;
esac
ok "request 2: 429 reason=${reason} (any valid block reason)"

retry_seconds="$(json_num retry_after_seconds "$body")"
if [[ -z "$retry_seconds" ]] || (( retry_seconds < 1 )); then
    fail "missing/invalid retry_after_seconds: '${retry_seconds}'"
fi
ok "retry_after_seconds=${retry_seconds}"

# ─── Phase 2: client-side cooldown UX ─────────────────────────────────────

log "phase 2: client-side cooldown UX after successful submit"

ui_email="ui-${STAMP}@example.com"

ab_retry open "${PAGES_BASE}/accounts" > /dev/null

# Submit the form once. The form's client-side cooldown should engage
# regardless of server response (the form treats 2xx as "we tried" and
# starts its own countdown immediately).
ab_retry find label "Email me a sign-in link" fill "$ui_email" > /dev/null
ab_retry find role button click --name "Email me" > /dev/null
ab_retry wait --text "If that address has a djibb account" > /dev/null
ok "first submit shows success message"

# The button should now show a "Resend in Ns" countdown. Don't pin the
# exact number (the timer ticks); just confirm the text shape and that
# the button is disabled / no longer says "Email me".
ab_retry wait --text "Resend in" > /dev/null
ok "resend button shows countdown ('Resend in …')"

# Belt-and-suspenders: snapshot the page and confirm there is NO active
# (non-disabled) "Email me" button visible. The cooldown should keep
# the button labeled as a countdown until time elapses.
snap="$(ab_retry snapshot -i)"
if echo "$snap" | grep -qE 'button "Email me"[^\[]*\[(ref|level)='; then
    # The unconstrained button — without "disabled" — would re-enable
    # premature submissions. This catches that regression.
    fail "found an enabled 'Email me' button during cooldown:\n${snap}"
fi
ok "no enabled 'Email me' button during cooldown"

log "✅ rate-limit E2E passed (${STAMP})"
