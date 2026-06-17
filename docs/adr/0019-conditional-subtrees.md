# ADR 0019: Conditional subtrees (stub — future work)

- **Status:** Stub (interested, not designed, not implemented)
- **Date:** 2026-06-17

## Context

Real-world checklists gate items on answers. The WHO Surgical Safety
checklist (see `seed/contributed/WHO-surgical-safety.md`, ADR 0012 §F) is the
forcing example: *"Does the patient have a difficult airway or aspiration
risk? — **If yes**, is equipment/assistance available?"* The follow-up only
matters when the parent is answered a certain way. djibb has no way to
express this today: `ListItem` is a leaf (no `child_element_refs`), so on
import these sub-items collapse into the parent item's description and lose
their checkbox (a characterized limitation, not a feature).

We are interested in **conditional subtrees** — an item that owns child items
revealed/required by the parent's state — but have **not** thought it through
or implemented it. This stub exists so the idea is recorded, not lost, and so
ADR 0012 §F (subgroups) and the package model have a forward pointer.

## Decision

None yet. Deliberately deferred. The subgroup work (ADR 0012 §F: C now → B
nested groups later) is the prerequisite track; conditionals build on top of
real nesting, not before it.

## Food for thought (unresolved)

- **Primitive.** Is a "conditional" a new element type, or a flag/behaviour on
  a general *subtree* primitive that also expresses subgroups (B)? A single
  "element with children" substrate could serve both — `ListGroup` already
  carries `parent_element_ref` + `child_element_refs`; `ListItem` does not.
- **The gate.** What triggers reveal/requirement — a boolean check, a quantity
  threshold, an enum answer? Where does the predicate live (on the parent, on
  the child, on the edge)?
- **Completion semantics.** Does a hidden/ungated child count toward parent or
  list completion? This collides with the universal rule (`value ===
  target_value`, ADR 0012 §C / CONTEXT.md) and must compose cleanly with it.
- **Markdown projection.** What's the canonical spelling of a conditional in
  the lossy Markdown encoding (ADR 0012)? Indented sub-bullets are the
  natural author surface but currently parse to description text.
- **DAG, not tree.** `child_element_refs` is a DAG; conditionals may want to
  reuse a subtree from multiple gates. Worth deciding whether to allow sharing
  or force a tree.

## Related

- ADR 0012 §F — subgroups (C → B), the prerequisite.
- ADR 0011 — DjibbList as universal entity substrate (where a subtree
  primitive would live).
