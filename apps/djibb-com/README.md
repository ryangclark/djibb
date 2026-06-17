# djibb
Building beautiful, remixable checklists.

## License — source-available, not open source

`@djibb/djibb-com` (this app) is **source-available, not open source**. It
is licensed under the **PolyForm Shield License 1.0.0** (see [`LICENSE`](./LICENSE)):
you may read, use, modify, and redistribute it for any purpose **except
building a product that competes with djibb**. PolyForm Shield is not an
OSI-approved open-source license — please don't describe this app as "open
source."

The *engine* underneath is genuinely open: `@djibb/protocol`,
`@djibb/client`, and `@djibb/server-cloudflare` are all **Apache-2.0**. Only
the frontend products in `apps/*` carry the source-available license. See
ADR-0016 (`docs/adr/0016-licensing-and-repository-structure.md`) for the
rationale, and the repository-root `NOTICE` for the Replicache carve-out and
the "djibb" trademark reservation (a fork must rename).
