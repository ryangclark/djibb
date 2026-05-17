#!/usr/bin/env bash
# magic-link.sh — End-to-end happy-path for magic-link sign-in (ADR 0010).
#
# What this exercises (real browser, real worker, real DB):
#
#   1. UI side: the /accounts page renders the magic-link form, the
#      form submits cleanly, and the "check your inbox" message
#      appears. (Different email per flow so the cooldown doesn't
#      bite.)
#   2. Consume side: a freshly-minted token's landing URL renders
#      the click-through interstitial, the user clicks "Sign me in",
#      the worker mints a session, and the browser redirects to the
#      configured `next` target.
#   3. Cross-page state: the new Account is signed in on a fresh
#      page load.
#
# What it doesn't cover (intentionally):
#   - Email delivery itself. The dev seam (`_dev: true` in
#     /auth/magic/request) lets us grab the landing URL without
#     waiting on an inbox. Real-email staging E2E is future work.
#   - Rate-limit / error paths. The unit tests in
#     workers/test/magicLink.test.ts cover these exhaustively.
#
# Exit non-zero on any failure (set -e + explicit assertions).

set -euo pipefail

# ─── Configuration ─────────────────────────────────────────────────────────

PAGES_BASE="${PAGES_BASE:-http://localhost:5173}"
API_BASE="${API_BASE:-http://localhost:8787}"
SESSION="${AGENT_BROWSER_SESSION:-djibb-e2e-magic-link}"

# Two distinct emails so the per-email cooldown (60s, ADR 0010)
# doesn't make the form-submission step's request collide with the
# consume-flow step's request.
STAMP="$(date +%s)-$$"
FORM_EMAIL="form-${STAMP}@example.com"
SIGNIN_EMAIL="signin-${STAMP}@example.com"

# Each `agent-browser` invocation uses the same isolated session so
# cookies/localStorage carry between steps.
ab() {
    agent-browser --session "$SESSION" "$@"
}

cleanup() {
    # Close the browser session on exit, success or failure, so a
    # repeated run doesn't accumulate orphan Chromium processes.
    ab close 2>/dev/null || true
}
trap cleanup EXIT

log() { printf '\033[36m[e2e]\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m  ok\033[0m  %s\n' "$*"; }
fail() {
    printf '\033[31mFAIL\033[0m  %s\n' "$*" >&2
    exit 1
}

# ─── Preflight ─────────────────────────────────────────────────────────────

log "preflight: checking dev servers"

if ! curl -sf -o /dev/null "${PAGES_BASE}/accounts"; then
    fail "pages dev server not reachable at ${PAGES_BASE} — run \`cd pages && npm run dev\`"
fi
ok "pages reachable at ${PAGES_BASE}"

if ! curl -sf -o /dev/null "${API_BASE}/"; then
    fail "worker dev server not reachable at ${API_BASE} — run \`cd workers && npm run dev\`"
fi
ok "worker reachable at ${API_BASE}"

# Confirm the dev seam is wired. A POST without _dev should yield 200
# with an empty body; a POST with _dev should yield JSON containing
# `landing_url`. If the seam is off (or anything else is wrong with
# the worker's /request handler) abort early with the actual response
# body + status so the failure mode is visible — `set -e` + `curl -f`
# would otherwise exit silently on any 4xx/5xx.
log "preflight: confirming dev seam is open"

# Use a temp file for the body so we can see both status and content
# without curl swallowing one or the other. `-s` silences progress,
# `-o` writes body, `-w` prints status to stdout — no `-f` so HTTP
# errors don't trip `set -e` before we can report them.
probe_body_file="$(mktemp)"
probe_status="$(
    curl -s -o "$probe_body_file" -w '%{http_code}' \
        -X POST "${API_BASE}/auth/magic/request" \
        -H 'Content-Type: application/json' \
        -H "Origin: ${PAGES_BASE}" \
        -d "{\"email\":\"probe-${STAMP}@example.com\",\"_dev\":true,\"next\":\"/accounts\"}"
)"
probe_response="$(cat "$probe_body_file")"
rm -f "$probe_body_file"

if [[ "$probe_status" != "200" ]]; then
    fail "dev-seam probe got HTTP ${probe_status}. body: ${probe_response}"
fi

if ! echo "$probe_response" | grep -q '"landing_url"'; then
    fail "dev seam returned 200 but no landing_url. Is ENV set to 'dev' (any case) in workers/.dev.vars? body: ${probe_response}"
fi
ok "dev seam returns landing_url"

# ─── Step 1: UI form renders and submits ──────────────────────────────────

log "step 1: open /accounts, submit the magic-link form"

ab open "${PAGES_BASE}/accounts" > /dev/null

# Use semantic locators (find label / find role) rather than snapshot
# grepping. The accessibility tree's element labels are more stable
# across UI tweaks than ref numbers or HTML attributes.
#
# Note: the "Email me" submit button is `[disabled]` until the email
# field is filled (the Svelte form's `submitDisabled` derives from
# email-shape validity). Filling first re-enables it; agent-browser's
# `find role button click` will succeed once it's enabled.
ab find label "Email me a sign-in link" fill "$FORM_EMAIL" > /dev/null
ab find role button click --name "Email me" > /dev/null
ab wait --text "If that address has a djibb account" > /dev/null
ok "form submission shows success message"

# ─── Step 2: Mint a landing URL via the dev seam ──────────────────────────

log "step 2: mint a signin link for ${SIGNIN_EMAIL} via dev seam"

response="$(
    curl -sf -X POST "${API_BASE}/auth/magic/request" \
        -H 'Content-Type: application/json' \
        -H "Origin: ${PAGES_BASE}" \
        -d "{\"email\":\"${SIGNIN_EMAIL}\",\"_dev\":true,\"next\":\"/accounts\"}"
)"

# Extract landing_url with a portable pattern. (jq would be cleaner
# but we don't want to require it for E2E.)
landing_url="$(echo "$response" | sed -nE 's/.*"landing_url":"([^"]+)".*/\1/p')"

if [[ -z "$landing_url" ]]; then
    fail "could not extract landing_url from response: $response"
fi
ok "got landing url"

# ─── Step 3: Open the interstitial, click through, expect redirect ────────

log "step 3: drive the interstitial click-through"

# Diagnostic: surface the URL we're about to navigate to in case the
# subsequent step fails — debugging a missing token is much easier
# with the URL visible.
log "  landing url: ${landing_url}"

# Close and reopen the agent-browser session between phases. Reusing
# the same session across a cross-origin navigation (pages → worker)
# right after a form submission has surfaced intermittent
# "daemon busy / Resource temporarily unavailable" errors. Step 1
# did not establish any session state we need to preserve (the form
# was submitted with a throwaway email; consume is what creates the
# real session in step 3), so a clean restart is harmless and makes
# the flow robust.
ab close > /dev/null
ab open "$landing_url" > /dev/null
# Wait for the interstitial to fully render before reaching for its
# button. Best practice from agent-browser core: never act on a page
# until something you expect on it is visible.
ab wait --text "Sign in to djibb" > /dev/null

# The interstitial page contains a "Sign me in" submit button. Click
# it; the inline JS POSTs to /consume and `window.location.replace`s
# the redirect target.
#
# We deliberately wait on destination-page content ("Signed-in
# accounts" heading) rather than `wait --url`: the URL-polling form
# has surfaced intermittent daemon-busy errors during the cross-
# origin redirect (worker → pages). Content-waiting is the more
# reliable signal that we actually arrived AND the page rendered.
ab find role button click --name "Sign me in" > /dev/null
ab wait --text "Signed-in accounts" > /dev/null
ok "redirected to /accounts after consume"

# ─── Step 4: Verify the new Account is signed in ──────────────────────────

log "step 4: verify ${SIGNIN_EMAIL} appears in the signed-in list"

# The /accounts page lists currently-signed-in accounts. After consume,
# the new Account's display_name (defaulted to the email's local part)
# should appear. Use the local-part because the AccountRow may not
# render the full email — adjust if the component changes.
expected="$(echo "$SIGNIN_EMAIL" | cut -d@ -f1)"

# Reload to ensure we're seeing fresh state from the worker, not a
# stale render from before consume completed.
ab open "${PAGES_BASE}/accounts" > /dev/null
ab wait --text "$expected" > /dev/null
ok "account row visible: ${expected}"

log "✅ magic-link E2E passed (${STAMP})"
