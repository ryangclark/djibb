# ADR 0016: Licensing and repository structure — open-core in a public monorepo

- **Status:** Accepted
- **Date:** 2026-06-14
- **Accepted:** 2026-06-16 — applied at the ADR-0014 split: Apache-2.0 on
  `packages/*` (protocol, client, server-cloudflare), PolyForm Shield 1.0.0
  on `apps/djibb-com`; root NOTICE enumerates the matrix; a
  `licenses:check` gate (`scripts/check-licenses.mjs` + CI workflow)
  asserts it can't drift.

## Context

The repo is licensed Apache-2.0 over everything, with no `license` field in
any `package.json`. The root `NOTICE` already does two useful things that
survive this ADR: it carves Replicache out (Rocicorp ToS, not Apache —
"not covered by this NOTICE or the LICENSE file"), and it reserves "djibb"
and the logo as trademarks ("the Apache license does not grant rights to
use these marks").

ADR 0014 splits the codebase into `@djibb/protocol` (pure contract),
`@djibb/client` (framework-agnostic runtime), `@djibb/server-cloudflare`
(authoritative backend), and `apps/*` (frontends). That package boundary is
*also* a natural licensing boundary, and the two goals pull in opposite
directions on purpose:

- The **protocol** wants the widest possible adoption — frontends,
  alternative backends, and LLM-authored apps all targeting it freely. For
  a thing called a "protocol," openness *is* the strategy.
- The **frontends** are the products (djibb.com first, then others). That's
  where retained value lives.

The owner's calls, made explicitly when this ADR was scoped:

1. **Frontends are *source-available*, not source-hidden** — visible, but
   licensed to restrict competing commercial use. This keeps everything in
   one public repo and lets djibb.com serve as the reference frontend an
   agent learns from.
2. **The protocol *and the client* are *truly open* (permissive, Apache-2.0)**
   — accepting that a permissive license allows closed forks, in exchange
   for frictionless adoption. Weak copyleft (MPL-2.0) was considered and
   consciously declined. Opening the client (not just the protocol) is a
   deliberate widening: the runtime others mount is open too.

3. **Hosting is not the value; the frontend is.** Standalone sync-hosting is
   not a business djibb is protecting — so closing the backend reserves
   nothing. `@djibb/server-cloudflare` is therefore **Apache-2.0 too**: the
   whole engine (protocol + client + server) is open, and the retained value
   lives entirely in the frontend products (`apps/*`). The frontend bundles
   the hosting, and *the bundle is the product*.
4. **The frontend tier is *PolyForm Shield 1.0.0*, not BSL — no flip-date
   commitment.** The owner is not ready to promise an eventual open-source
   conversion, and BSL *requires* a Change Date (≤ 4 years per version).
   PolyForm Shield is source-available with the same "no competing use"
   protection but **no mandated conversion**; because the owner holds all
   copyright, voluntarily open-sourcing any version later stays fully at the
   owner's discretion rather than being contractually forced. (BSL and
   Elastic License v2 were considered — see §Alternatives.)
5. **Licenses are applied *at the ADR 0014 package split*, not now.** The
   Apache/source-available line falls exactly on the `packages/` vs `apps/`
   boundary, which does not physically exist yet. The engine is already
   Apache-2.0 today; the frontend tier is applied in one clean pass when the
   split lands, so the boundary is drawn precisely (rather than temporarily
   over-restricting future-`@djibb/client` code that currently lives in
   `pages/src/lib`).

## Decision

### A. One public monorepo, licensed per directory — no repo split

Keep a single repository of record. Do **not** split protocol/client/
backend/frontends into separate git or GitHub repos. Different licenses
coexist in one repo via a per-package `LICENSE` file plus a `license` field
in each `package.json`. Repo separation buys nothing here and reintroduces
exactly the cross-repo version-coordination friction ADR 0014's shared-code
design removes. Splitting later (when the protocol stabilizes and external
consumers exist) is a cheap, reversible `git subtree split` — deferred
until a concrete need.

### B. The license matrix

| Package | License | Rationale |
|---|---|---|
| `@djibb/protocol` | **Apache-2.0** | Truly open, permissive, with an explicit patent grant (important for a protocol others standardize on). Permissive = closed forks allowed; accepted deliberately as the adoption strategy. |
| `@djibb/client` | **Apache-2.0** | The runtime frontends mount; same openness logic. **Caveat:** encumbered by Replicache (Decision E). |
| `@djibb/server-cloudflare` | **Apache-2.0** | The reference backend. Since standalone hosting isn't the moat, closing it reserves nothing — so it's open too. This makes the *entire engine* (protocol + client + server) Apache, and gives the strongest "portable off Cloudflare / self-host anywhere" signal (ADR 0014). Retained value lives entirely in the frontends. |
| `apps/djibb-com` + future frontends | **PolyForm Shield 1.0.0** (source-available) | The products — the *only* closed-er tier. Visible (reference frontend for agents), with a single clean restriction: *use it for anything except building something that competes with djibb*. No change date, no forced conversion; the owner can still open any version later at their discretion. |

Apache-2.0 over MIT for the open packages specifically for the patent
grant. MIT was not chosen; it omits the patent clause that a protocol
wants. PolyForm Shield over BSL/Elastic-v2 for the frontends: it protects
against competing use without forcing an eventual-open commitment the owner
isn't ready to make (§Alternatives).

### C. Mechanism

- Each `packages/*` and `apps/*` gets its own `LICENSE` file and a
  `license` field in its `package.json` (SPDX identifier:
  `Apache-2.0`, or `PolyForm-Shield-1.0.0` for the frontends).
- The **root `LICENSE`** stays Apache-2.0 as the repository default and the
  protocol's license. The **root `NOTICE`** is updated to enumerate the
  per-package licenses, keep the Replicache carve-out, and keep the
  trademark reservation.
- PolyForm Shield needs only the **Licensor** identity filled (Ryan Lark) —
  no Change Date, no Additional Use Grant wording to draft; the "no
  competing use" boundary is baked into the standard license text. Drop in
  the upstream PolyForm Shield 1.0.0 text verbatim.
- **Applied at the ADR 0014 split, in one pass** (owner's call §5). Until
  then the repo stays wholly Apache-2.0 (status quo); the engine's license
  does not change at the split, only the frontends gain their own LICENSE.
- A "source-available, not open source" note belongs in each frontend's
  README — PolyForm Shield is not an OSI-approved open-source license, and
  the frontends must not be described as "open source" (only the engine is).

### D. Trademark stays reserved — open the code, not the brand

Unchanged from today's `NOTICE`. Apache / PolyForm Shield grant rights to
the *source*, not to "djibb" or the logo. A fork must rename. This is the standard
open-core posture and is already in place; this ADR preserves it across the
per-package split.

### E. Replicache encumbrance is disclosed at the client boundary

`@djibb/protocol` only touches Replicache *types*, so it is genuinely,
cleanly open — an alternative client could be written against the protocol
with no Replicache dependency at all. `@djibb/client`, however, depends on
Replicache at runtime (Rocicorp ToS). That means "Apache-2.0" on the client
is real for djibb's *own* code but a consumer still inherits Replicache's
terms. This is documented prominently in `@djibb/client`'s README and
NOTICE so "open client" is not oversold. (If Replicache's licensing ever
becomes a blocker for the open-client promise, the protocol's
Replicache-light boundary is the escape hatch — a different sync client can
be built without relicensing the protocol.)

### F. Inbound=outbound; relicensing optionality

Contributions to the open packages are accepted **inbound=outbound** under
Apache-2.0 (the Apache-2.0 §5 default), so external contributions don't
fragment the license. Whether to additionally require a lightweight CLA/DCO
— to retain the option to dual-license or relicense the open core later —
is left open (below); not needed before the first external contributor.

## Pros and cons against alternatives

### What public-monorepo open-core wins

- **License seam = package seam.** ADR 0014's boundary does double duty;
  no new structure to maintain.
- **One repo of record.** Atomic cross-layer PRs while the protocol churns;
  no npm-publish-and-bump dance pre-1.0.
- **djibb.com stays a readable reference frontend** for humans and agents —
  the source-available choice serves the "agents whip off frontends" goal
  directly.
- **Genuinely open protocol** maximizes the odds it becomes the thing
  others build on; the patent grant makes it safe to adopt.

### What separate repos would have won

- **Hard source isolation** of closed frontends (if they were
  source-hidden). Moot — frontends are source-available (owner's call).
- **Independent release cadence** per package. Real eventually; premature
  now, and recoverable via subtree split when it matters.

Rejected: the isolation isn't needed (source-available), and the cost
(cross-repo coordination of shared code) is exactly what ADR 0014 exists to
avoid.

### What MPL-2.0 on the protocol would have won

- **Protocol stays open through forks** (per-file copyleft) while still
  allowing closed frontends — the tightest license-expression of "open
  protocol, closed frontend."

Consciously declined by the owner in favor of truly-permissive openness.
MPL would slightly raise adoption friction and signal less-than-fully-open;
the deliberate trade is to accept closed forks as the price of maximum
adoption. Recorded as the fallback if closed-fork competition ever becomes
a concrete problem — the protocol could move Apache→MPL for *new* versions
without unwinding anything already shipped.

### What BSL 1.1 / Elastic License v2 would have won (vs PolyForm Shield) for the frontends

- **BSL 1.1** — the freeform Additional Use Grant can express any carve-out,
  and the mandatory Change Date converts each version to open source within
  ≤ 4 years, which is real goodwill. **Rejected:** that Change Date is
  *required*, and the owner is not ready to promise an eventual-open flip.
  Recorded as the option to revisit if the eventual-open promise is ever
  wanted as a feature. (Voluntary open-sourcing later is always available
  under PolyForm Shield too, just not contractually forced.)
- **Elastic License v2** — source-available, no change date, very short.
  **Rejected:** its core restriction is anti-"provide as a managed/hosted
  service," which is tuned for infrastructure (the AWS-hosts-my-database
  threat). For a consumer frontend the threat is a competing *product* built
  from the source, which ELv2's wording does not cleanly cover. PolyForm
  Shield's "no competing use" boundary is the right shape for a frontend.

### What keeping one Apache-2.0 over everything would have won

- **Zero change.** But it gives the *frontends* away under a permissive
  license — the opposite of retaining product value. Rejected.

## Consequences

**Positive:**

- Clear, conventional open-core posture that maps onto the package split.
- Protocol is safe and frictionless to adopt; products are protected;
  everything stays in one repo.
- Trademark and Replicache carve-outs carry over intact.

**Negative:**

- Multiple licenses in one repo is a small ongoing discipline (every new
  package must declare its `license` field and `LICENSE` file; CI should
  assert this).
- "Source-available" (PolyForm Shield) is not "open source" and will prompt
  questions; the frontend READMEs must state the distinction plainly and not
  call the apps open source.
- The Apache-2.0-on-`@djibb/client` claim carries an asterisk (Replicache);
  it must be disclosed honestly to avoid overselling.
- No eventual-open commitment on the frontends (PolyForm Shield has no
  Change Date). Accepted deliberately; the trade is owner discretion over
  any future opening, at the cost of the automatic-goodwill BSL would give.
- Permissive protocol licensing means a closed competitor *could* fork the
  protocol. Accepted by deliberate choice.

## Open questions

- **Test coverage as a separately-licensed asset — "the SQLite model."**
  Proposed direction (tentative): the high-value E2E / coverage suite is
  arguably where the moat now lives — not in the code, but in proven
  behavior under test. SQLite is the precedent: its code is public-domain
  (open), but its exhaustive test harness (**TH3**, 100% MC/DC coverage) is
  *proprietary and sold separately*. Emulating it faithfully means:
  - **Baseline tests stay WITH their package, under that package's
    license.** Open packages (`@djibb/protocol`, `@djibb/client`) keep their
    unit/integration tests open — otherwise "open" code is untestable by
    adopters, which guts the openness. SQLite itself ships a large *open*
    test suite; TH3 is an *additional* premium tier, not a replacement.
  - **The premium full-product E2E suite (today's `e2e/`) becomes the
    closed asset** — its own private repo (or a BSL/proprietary package),
    the "TH3 equivalent." It exercises the running bundle, so it naturally
    sits above the open-package line.
  - **Cost to weigh:** a separate test repo drifts from the code, complicates
    CI (the private suite must stand up the app to run), and stops external
    contributors from running full E2E locally. SQLite absorbs this because
    TH3 is a deliberate commercial product with staff behind it. Decide
    whether the moat is real enough to pay that tax, or whether keeping E2E
    in-monorepo-but-BSL captures most of the value with far less friction.
  - **Status: deliberately deferred — recorded as a future product line, not
    a near-term action.** djibb is nowhere near the stage where this earns
    its keep. Think of the premium coverage suite as its own *product line*
    that would need real, staffed investment to exist (TH3 is a commercial
    product with people behind it) — captured here only as a closed door
    pointing at a future possibility, so the option isn't forgotten. If ever
    pursued, it is the *one* sanctioned exception to Decision A's "no repo
    split" and earns its own ADR; it would touch `docs/testing.md` and the
    existing `e2e/` suite.
- **CLA/DCO.** Whether to require a DCO sign-off or a CLA on the open
  packages to retain relicensing/dual-licensing optionality. Decide when
  the first external contributor appears; inbound=outbound Apache-2.0 is
  the default until then.
- **SPDX + license-check CI.** Add a CI gate asserting every package has a
  `license` field matching its `LICENSE` file, so the matrix can't silently
  drift as packages are added.

## References

- ADR 0014 — Protocol/client/backend package split. The package boundary
  this ADR licenses along.
- `LICENSE` — current repo-wide Apache-2.0 (becomes the protocol's license
  + repo default).
- `NOTICE` — existing Replicache carve-out and trademark reservation, both
  preserved and extended to enumerate per-package licenses.
- ADR 0015 — Effect as backend spine. Effect's own license (MIT) is
  compatible with whatever the backend package adopts; no conflict.
