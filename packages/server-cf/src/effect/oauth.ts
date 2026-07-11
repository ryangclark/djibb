import { Google } from 'arctic';
import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { z } from 'zod';

/**
 * GoogleIdentity Effect service (ADR 0015, docs/plans/effect-adoption.md
 * Phase 2): the OAuth callback's external interaction — arctic's
 * code-for-tokens exchange plus the userinfo claims fetch — as one
 * named operation with a typed error channel, replacing the ad-hoc
 * try/catch + unguarded fetch in `auth/oauth.ts`.
 *
 * The Hono handler stays a plain async handler: it calls
 * `exchangeGoogleCode` (Promise-side, the runPromise ceremony lives
 * here) and maps any typed failure to `UnexpectedError` at the HTTP
 * boundary. Tests can provide a stub Layer instead of Google.
 */

/**
 * Google User Info as provided from Identity Platform.
 * @see: https://cloud.google.com/identity-platform/docs/reference/rest/v1/UserInfo
 */
export const GoogleUserClaimsSchema = z.object({
    name: z.string(),
    email: z.string(),
    picture: z.string(),
    sub: z.string(),
});

export type GoogleUserClaims = z.TypeOf<typeof GoogleUserClaimsSchema>;

/** The code-for-tokens exchange failed (bad/expired code, bad verifier). */
export class OAuthExchangeError extends Data.TaggedError('OAuthExchangeError')<{
    readonly cause: unknown;
}> {}

/** The userinfo fetch failed or returned claims we couldn't parse. */
export class OAuthClaimsError extends Data.TaggedError('OAuthClaimsError')<{
    readonly cause: unknown;
}> {}

export class GoogleIdentity extends Context.Tag('server-cf/GoogleIdentity')<
    GoogleIdentity,
    {
        readonly exchangeCode: (
            code: string,
            codeVerifier: string,
        ) => Effect.Effect<
            GoogleUserClaims,
            OAuthExchangeError | OAuthClaimsError
        >;
    }
>() {}

export type GoogleOAuthConfig = {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
};

/** Live Layer: arctic against real Google endpoints. */
export const GoogleIdentityLive = (
    config: GoogleOAuthConfig,
): Layer.Layer<GoogleIdentity> =>
    Layer.succeed(GoogleIdentity, {
        exchangeCode: (code, codeVerifier) =>
            Effect.gen(function* () {
                const google = new Google(
                    config.clientId,
                    config.clientSecret,
                    config.redirectUri,
                );
                const tokens = yield* Effect.tryPromise({
                    try: () =>
                        google.validateAuthorizationCode(code, codeVerifier),
                    catch: cause => new OAuthExchangeError({ cause }),
                });
                const claims = yield* Effect.tryPromise({
                    try: async () => {
                        const response = await fetch(
                            'https://openidconnect.googleapis.com/v1/userinfo',
                            {
                                headers: {
                                    Authorization: `Bearer ${tokens.accessToken()}`,
                                },
                            },
                        );
                        return (await response.json()) as unknown;
                    },
                    catch: cause => new OAuthClaimsError({ cause }),
                });
                const parsed = GoogleUserClaimsSchema.safeParse(claims);
                if (!parsed.success) {
                    return yield* Effect.fail(
                        new OAuthClaimsError({ cause: parsed.error }),
                    );
                }
                return parsed.data;
            }),
    });

/**
 * Promise-side entry for the OAuth callback handler. Rejects with the
 * typed error (unwrapped, not a FiberFailure) so the handler can log
 * the tagged cause before mapping to its HTTP-boundary DjibbError.
 */
export function exchangeGoogleCode(
    config: GoogleOAuthConfig,
    code: string,
    codeVerifier: string,
): Promise<GoogleUserClaims> {
    const program = Effect.flatMap(GoogleIdentity, identity =>
        identity.exchangeCode(code, codeVerifier),
    ).pipe(Effect.provide(GoogleIdentityLive(config)));
    return Effect.runPromise(Effect.either(program)).then(result => {
        if (result._tag === 'Left') throw result.left;
        return result.right;
    });
}
