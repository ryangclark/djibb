import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schedule from 'effect/Schedule';

/**
 * EmailSender Effect service (ADR 0015, docs/plans/effect-adoption.md
 * Phase 2). The live Layer wraps the Worker's `EMAIL` send_email
 * binding, keeping the thin interface the email-provider choice wants
 * (the provider is beta — "good enough until it burns us" — so every
 * caller goes through this seam, never the binding directly).
 *
 * Callers outside the email module never see Effect: `src/email` keeps
 * its `(env, params) => Promise<void>` send functions and runs its
 * programs through `runEmailSend` below — the email counterpart of
 * `runD1`'s runPromise ceremony.
 */

/**
 * The builder-form message shape the `send_email` binding accepts
 * (the subset our senders use). Kept structural so a test Layer can
 * capture messages without any Cloudflare types in scope.
 */
export type OutboundEmail = {
    readonly from: { readonly email: string; readonly name: string };
    readonly to: string;
    readonly subject: string;
    readonly html: string;
    readonly text: string;
};

/** Typed failure for the send channel; `cause` is the binding's error. */
export class EmailSendError extends Data.TaggedError('EmailSendError')<{
    readonly to: string;
    readonly cause: unknown;
}> {}

export class EmailSender extends Context.Tag('server-cf/EmailSender')<
    EmailSender,
    {
        readonly send: (
            message: OutboundEmail,
        ) => Effect.Effect<void, EmailSendError>;
    }
>() {}

/**
 * Bounded retry for transient send failures: 2 retries with jittered
 * exponential backoff. Email sends are not idempotent — a "failure"
 * after the provider actually accepted the message double-sends on
 * retry — so this stays small and bounded: a duplicate invite email is
 * a nuisance, a silently dropped one is a lost invitation. The DO send
 * loops (`fireInvitationEmails` / `fireOwnershipTransferEmails`) keep
 * their best-effort catch-and-log posture around this.
 */
export const transientEmailRetry = Schedule.intersect(
    Schedule.jittered(Schedule.exponential('100 millis')),
    Schedule.recurs(2),
);

/** Live Layer over the Worker's `EMAIL` binding. */
export const EmailSenderLive = (
    binding: SendEmail,
): Layer.Layer<EmailSender> =>
    Layer.succeed(EmailSender, {
        send: message =>
            Effect.tryPromise({
                try: async () => {
                    await binding.send(message);
                },
                catch: cause => new EmailSendError({ to: message.to, cause }),
            }),
    });

/**
 * Test Layer: capture messages into `captured` instead of sending.
 * Lets the email paths be asserted in plain vitest, no workers pool.
 */
export const EmailSenderCapture = (
    captured: OutboundEmail[],
): Layer.Layer<EmailSender> =>
    Layer.succeed(EmailSender, {
        send: message =>
            Effect.sync(() => {
                captured.push(message);
            }),
    });

/**
 * Run one send through the EmailSender service with the transient
 * retry. Rejects with the typed {@link EmailSendError} (unwrapped, not
 * a FiberFailure) so Promise-side callers keep a meaningful error to
 * log; they already treat sends as best-effort.
 */
export function runEmailSend(
    binding: SendEmail,
    message: OutboundEmail,
): Promise<void> {
    const program = Effect.flatMap(EmailSender, sender =>
        sender.send(message),
    ).pipe(
        Effect.retry(transientEmailRetry),
        Effect.provide(EmailSenderLive(binding)),
    );
    return Effect.runPromise(Effect.either(program)).then(result => {
        if (result._tag === 'Left') throw result.left;
    });
}
