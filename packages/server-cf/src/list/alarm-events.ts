/**
 * Multi-event alarm dispatcher event names (ADR 0011 §Step 10a.2 /
 * ADR 0008). One per kind of scheduled work the DO does:
 *
 *   - reconcile        : ADR 0007 D1 drift check (every DO, every day)
 *   - cascade-archive  : Workspace DO sweeps children on
 *                        `softDeleteWorkspace` (10a.4)
 *   - cascade-restore  : Workspace DO sweeps children on
 *                        `restoreWorkspace` (10a.5)
 *   - harddelete       : per-DO self-destruct 30d after soft delete
 *                        (10a.6 / 10b)
 *
 * Adding a new event: extend this union, register a case in the DO's
 * `runAlarmEvent`, schedule via `scheduleEvent(name, dueAt)`.
 *
 * Lives in its own module (not `durable_object.ts`) so the workspace
 * cascade module (`workspace/cascade.ts`) and the DO both import the
 * type with no import cycle (ADR 0026 §Decision).
 */
export type AlarmEventName =
    | 'reconcile'
    | 'cascade-archive'
    | 'cascade-restore'
    | 'harddelete';
