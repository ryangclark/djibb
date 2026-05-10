// @see https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/readyState
export const WS_STATE = {
    CONNECTING: 0, // The connection is not yet open.
    OPEN: 1, // The connection is open and ready to communicate.
    CLOSING: 2, // The connection is in the process of closing.
    CLOSED: 3, // The connection is closed or couldn't be opened.
};

/**
 * Per-mutation failure status surfaced over the outcome channel
 * (ADR 0005 / 0006).
 *
 *   - `auth`  — the mutation was rejected at the role gate (the
 *               role lost permission between the optimistic write
 *               and the server roundtrip).
 *   - `stale` — set-family CAS pre-check failed; another client
 *               moved the field between the snapshot and apply.
 *   - `gone`  — the target row was missing (soft-deleted / never
 *               existed).
 *
 * Success is implicit — only failures flow over the channel. The
 * client treats the absence of an outcome as success after pull
 * arrives. ADR 0005 §"Outcome channel."
 */
export type MutationOutcomeStatus = 'auth' | 'stale' | 'gone';

/**
 * Typed wire format. Replaces the plain-string `'pull pls'` poke per
 * ADR 0006. Both directions: server → client only today; if/when
 * client → server messages are added, this discriminated union
 * extends to cover them.
 */
export type WSMessage =
    | { type: 'poke' }
    | {
          type: 'mutation_outcome';
          mutationID: number;
          status: MutationOutcomeStatus;
      };

/**
 * Wire-format helpers — the constants in this module are the
 * single source of truth for JSON shapes; route handlers and
 * mutator runtime parse / serialize through these.
 */
export function encodeWSMessage(msg: WSMessage): string {
    return JSON.stringify(msg);
}

export function decodeWSMessage(raw: unknown): WSMessage | null {
    if (typeof raw !== 'string') return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && 'type' in parsed) {
            return parsed as WSMessage;
        }
    } catch {
        // fall through
    }
    return null;
}

/** Query-string key the client uses to tag its websocket with its
 *  Replicache clientID. ADR 0006. */
export const WS_QUERY_CLIENT_ID = 'c';
