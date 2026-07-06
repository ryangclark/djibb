# Cloudflare backend context

The one djibb backend: Durable Objects as entity authority, D1 as glue, Replicache push/pull, auth enforcement. Terms here are server-cf-specific; shared domain language lives in the root [`CONTEXT.md`](../../CONTEXT.md).

## Language

**Derived Index**:
The D1 projection of DO-authoritative entity state — memberships, workspace catalog rows, and the invitations index. Written only by DO snapshot emits (ADR 0003), reconciled by the sweeper (ADR 0007), and regenerable from the DOs at any time.
_Avoid_: cache, mirror, "the D1 tables"

**Auth substrate**:
The D1 tables where D1 itself is authoritative rather than derived: accounts, sessions, magic-link tokens, issued credentials, usernames. The counterpart family to the Derived Index (ADR 0025).
_Avoid_: user tables, auth DB
