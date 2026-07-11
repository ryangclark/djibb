import * as Effect from 'effect/Effect';
import { describe, expect, it } from 'vitest';

import {
    EmailSendError,
    EmailSender,
    EmailSenderCapture,
    runEmailSend,
    transientEmailRetry,
    type OutboundEmail,
} from '../../src/effect/email';
import {
    buildEntityInvitationEmail,
    buildMagicLinkEmail,
    buildOwnershipTransferEmail,
    buildOwnershipTransferReceiptEmail,
} from '../../src/email';

/**
 * Phase 2 payoff (docs/plans/effect-adoption.md): the email paths are
 * assertable in plain vitest — no workers pool, no EMAIL binding.
 * Message construction is pure (`build*Email`), and the send channel
 * is a service (`EmailSender`) a test Layer can capture.
 */

const FROM = 'no-reply@djibb.com';

describe('email message builders (pure)', () => {
    it('invitation: subject and copy carry inviter and entity name', () => {
        const msg = buildEntityInvitationEmail(FROM, {
            to: 'bob@example.com',
            entityTypeLabel: 'list',
            entityName: 'Weekend BBQ',
            inviterName: 'Alice',
            acceptUrl: 'https://djibb.com/l/abc?from_invite=1',
        });
        expect(msg.to).toBe('bob@example.com');
        expect(msg.from).toEqual({ email: FROM, name: 'djibb invites' });
        expect(msg.subject).toBe(
            'Alice shared Weekend BBQ with you on djibb',
        );
        expect(msg.text).toContain('https://djibb.com/l/abc?from_invite=1');
    });

    it('invitation: falls back for empty inviter/entity names', () => {
        const msg = buildEntityInvitationEmail(FROM, {
            to: 'bob@example.com',
            entityTypeLabel: 'template',
            entityName: '  ',
            inviterName: '',
            acceptUrl: 'https://djibb.com/t/abc',
        });
        expect(msg.subject).toBe(
            'Someone shared a template with you on djibb',
        );
    });

    it('invitation: escapes html in names and strips header newlines', () => {
        const msg = buildEntityInvitationEmail(FROM, {
            to: 'bob@example.com',
            entityTypeLabel: 'list',
            entityName: '<script>x</script>',
            inviterName: 'Alice\r\nBcc: evil@x.com',
            acceptUrl: 'https://djibb.com/l/abc?a=1&b="2"',
        });
        expect(msg.subject).not.toMatch(/[\r\n]/);
        expect(msg.html).toContain('&lt;script&gt;');
        expect(msg.html).toContain('&amp;b=&quot;2&quot;');
        expect(msg.html).not.toContain('<script>x</script>');
    });

    it('transfer + receipt: notification names the former owner, receipt the new one', () => {
        const transfer = buildOwnershipTransferEmail(FROM, {
            to: 'new@example.com',
            entityTypeLabel: 'workspace',
            entityName: 'Team Space',
            formerOwnerName: 'Alice',
            entityUrl: 'https://djibb.com/w/team-space',
        });
        expect(transfer.subject).toBe(
            "You're now the owner of Team Space on djibb",
        );
        expect(transfer.text).toContain('Alice transferred ownership');

        const receipt = buildOwnershipTransferReceiptEmail(FROM, {
            to: 'alice@example.com',
            entityTypeLabel: 'workspace',
            entityName: 'Team Space',
            newOwnerName: 'Bob',
            entityUrl: 'https://djibb.com/w/team-space',
        });
        expect(receipt.subject).toBe(
            'You transferred ownership of Team Space on djibb',
        );
        expect(receipt.text).toContain('to Bob on djibb');
    });

    it('magic link: generic body, no personalization, carries TTL + URL', () => {
        const msg = buildMagicLinkEmail(FROM, {
            to: 'bob@example.com',
            landingUrl: 'https://api.djibb.com/auth/magic/land?token=t',
            ttlMinutes: 15,
        });
        expect(msg.subject).toBe('Sign in to djibb');
        expect(msg.text).toContain('expires in 15 minutes');
        expect(msg.html).toContain(
            'https://api.djibb.com/auth/magic/land?token=t',
        );
    });
});

describe('EmailSender service', () => {
    const message: OutboundEmail = {
        from: { email: FROM, name: 'djibb' },
        to: 'bob@example.com',
        subject: 's',
        html: '<p>h</p>',
        text: 't',
    };

    it('capture layer records sends without a binding', async () => {
        const captured: OutboundEmail[] = [];
        await Effect.runPromise(
            Effect.flatMap(EmailSender, sender => sender.send(message)).pipe(
                Effect.provide(EmailSenderCapture(captured)),
            ),
        );
        expect(captured).toEqual([message]);
    });

    it('transient retry recovers within the bound', async () => {
        let attempts = 0;
        const flaky = Effect.suspend(() => {
            attempts += 1;
            return attempts < 3
                ? Effect.fail(
                      new EmailSendError({ to: message.to, cause: 'blip' }),
                  )
                : Effect.succeed('sent');
        });
        const result = await Effect.runPromise(
            Effect.retry(flaky, transientEmailRetry),
        );
        expect(result).toBe('sent');
        expect(attempts).toBe(3);
    });

    it('runEmailSend rejects with the typed EmailSendError after retries exhaust', async () => {
        let attempts = 0;
        const binding = {
            send: async () => {
                attempts += 1;
                throw new Error('provider down');
            },
        } as unknown as SendEmail;
        await expect(runEmailSend(binding, message)).rejects.toBeInstanceOf(
            EmailSendError,
        );
        expect(attempts).toBe(3); // initial attempt + 2 retries
    });

    it('runEmailSend resolves when a retry succeeds', async () => {
        let attempts = 0;
        const binding = {
            send: async () => {
                attempts += 1;
                if (attempts < 2) throw new Error('blip');
            },
        } as unknown as SendEmail;
        await expect(runEmailSend(binding, message)).resolves.toBeUndefined();
        expect(attempts).toBe(2);
    });
});
