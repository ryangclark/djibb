import { Google, OAuth2Tokens } from 'arctic';
import { generateCodeVerifier, generateState } from 'arctic';
import { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { CookieOptions } from 'hono/utils/cookie';
import { z } from 'zod';

import { NotFoundError, UnexpectedError, ValidationError } from '../errors';
import {
    CreateAccount,
    GetAccountByEmail,
    GetAccountByGoogleId,
} from '../account/service';
import { CreateSession } from './session';
import {
    BaseSessionCookieAttributes,
    CookieNames,
    OAUTH_PROVIDER,
    OAUTH_REDIRECT_URI,
} from './constants';
import { FlagRouter, MOCK_AUTH_MODE } from '../flags';
import { HonoEnv } from '..';
import { AcceptInvitation } from '../workspace/invitations';

export async function handleGetMockSession(c: Context<HonoEnv>) {
    if (!FlagRouter.featureIsEnabled(MOCK_AUTH_MODE)) {
        throw new NotFoundError();
    }

    let session = c.get('session');
    if (session) {
        // Could add the mock account to the session, but
        // for now we'll leave it like this.
        return c.json(session);
    }

    // Create a new account, to which we'll add the session.
    // TODO: we'll only need to do this once, right?
    let account;

    try {
        account = await CreateAccount(c.env, {
            id: '',
            display_name: 'Dry Dock',
            email: '',
            email_verified: false,
            flags: null,
            image: '',
            provider_name: OAUTH_PROVIDER.enum.djibb,
            provider_client_id: 'mock-user-01',
            user_name: null,
            time_created: new Date(),
            time_deleted: null,
            time_updated: new Date(),
        });
    } catch (error) {
        throw new UnexpectedError();
    }

    // Create a new session.
    try {
        // Create the session, adding the account immediately.
        session = await CreateSession(c.env.DJIBB_AUTH, {
            accounts: [account],
            ip_country: '',
        });
    } catch (error) {
        throw new UnexpectedError();
    }

    setCookie(c, CookieNames.Session, session.id, BaseSessionCookieAttributes);

    return c.json(session);
}

/**
 * Handle request to initialize Google OAuth flow.
 * The user will be prompted to sign in with Google. If successful,
 * Google will redirect the user to our `/verify` route, at which point
 * we will validate Google's authorization code.
 */
export async function handleInitOAuthGoogle(c: Context<HonoEnv>) {
    const baseState = generateState();
    const codeVerifier = generateCodeVerifier();

    // Pending invite token: read from `?invite=<token>`. We carry it
    // through OAuth two ways for defense-in-depth: a cookie (primary,
    // wins on the callback) and appended to `state` (fallback, in case
    // cookies aren't reliably available on the return trip — the
    // `state` round-trips through Google).
    const inviteToken = c.req.query('invite') ?? null;
    const state = inviteToken
        ? `${baseState}.${encodeURIComponent(inviteToken)}`
        : baseState;

    const google = new Google(
        c.env.OAUTH_GOOGLE_CLIENT_ID,
        c.env.OAUTH_GOOGLE_CLIENT_SECRET,
        OAUTH_REDIRECT_URI.base(c) + OAUTH_REDIRECT_URI.google
    );

    const SCOPES = ['profile', 'email']; // "openid" always included

    const url: URL = google.createAuthorizationURL(state, codeVerifier, SCOPES);

    // These may need to be updated at some point idk.
    const cookieOpts: CookieOptions = {
        httpOnly: true,
        maxAge: 60 * 10, // 10 min
        path: '/',
        secure: c.env.ENV !== 'dev', // set to false in localhost
    };

    // Store the OAuth state in a cookie.
    setCookie(c, CookieNames.GoogleState, state, cookieOpts);

    // Set a cookie for the request's referer. We'll use this to create
    // a redirect back into the requesting app upon successful
    // authentication. This will allow us to eventually have multiple
    // authorized frontend domains.
    //
    // NOTE: We use `referer` because we open the OAuth flow in a new
    // window, which means this request comes as a referral, I think?
    let refererOrigin = c.req.header('referer');

    // Remove any trailing slash for a `referer` header.
    if (refererOrigin?.endsWith('/')) {
        refererOrigin = refererOrigin.slice(0, refererOrigin.length - 1);
    }

    if (
        refererOrigin &&
        c.env.AUTHORIZED_DOMAINS.split(';').includes(`${refererOrigin}`)
    ) {
        setCookie(c, CookieNames.RefererOrigin, refererOrigin, cookieOpts);
    } else {
        console.warn(
            '`handleInitOAuthGoogle()` warning: could not set RefererOrigin cookie to "%s"',
            refererOrigin
        );

        throw new UnexpectedError();
    }

    // Store code verifier as cookie.
    setCookie(c, CookieNames.GoogleCodeVerifier, codeVerifier, cookieOpts);

    // Store the pending invite token (if any) as its own cookie.
    if (inviteToken) {
        setCookie(c, CookieNames.PendingInvite, inviteToken, cookieOpts);
    }

    return c.redirect(url.toString());
}

/**
 * Handles the second step of OAuth flow for Google: verifying Google's
 * response, then updating the session in the DB and setting appropriate
 * Cookies.
 */
export async function handleVerifyOAuthGoogle(c: Context<HonoEnv>) {
    const code = c.req.query('code');
    const state = c.req.query('state');

    const storedState = getCookie(c, CookieNames.GoogleState);
    const storedCodeVerifier = getCookie(c, CookieNames.GoogleCodeVerifier);

    // Ensure everything checks out.
    if (!code || !storedState || !storedCodeVerifier || state !== storedState) {
        console.log('`/google/verify` validation error!', {
            code: Boolean(code),
            storedState: Boolean(storedState),
            storedCodeVerifier: Boolean(storedCodeVerifier),
            stateMatchesStoredState: state === storedState,
        });

        throw new ValidationError('Invalid Request!');
    }

    let tokens: OAuth2Tokens;

    try {
        const google = new Google(
            c.env.OAUTH_GOOGLE_CLIENT_ID,
            c.env.OAUTH_GOOGLE_CLIENT_SECRET,
            OAUTH_REDIRECT_URI.base(c) + OAUTH_REDIRECT_URI.google
        );

        tokens = await google.validateAuthorizationCode(
            code,
            storedCodeVerifier
        );
    } catch (err) {
        console.error(
            '`/google/verify` unexpected error validating auth code:',
            err
        );

        throw new UnexpectedError();
    }

    // Get user info using the token.
    const response = await fetch(
        'https://openidconnect.googleapis.com/v1/userinfo',
        {
            headers: {
                Authorization: `Bearer ${tokens.accessToken()}`,
            },
        }
    );

    const googleUserClaims: GoogleUserClaims = await response.json();

    const parseResult = GoogleUserClaimsSchema.safeParse(googleUserClaims);

    if (!parseResult.success) {
        console.error('`/google/verify` parse error:', parseResult.error);
        throw new UnexpectedError();
    }

    // Account resolution (ADR 0010 option C): email-match first, then
    // provider-sub fallback, then create.
    //
    // - Email-first catches the cross-method case: a user who first
    //   signed in via magic-link (`provider_name='djibb'`) and is now
    //   adding Google as a sign-in method. We route them to the same
    //   Account rather than minting a duplicate.
    // - Sub-fallback catches the Google-side email-change case: a
    //   Google-home Account whose primary email changed at Google
    //   still resolves to the same djibb Account because `sub` is
    //   provider-stable.
    // - Only when neither matches do we create a new Account.
    //
    // Google's `email_verified` is trusted unconditionally for the
    // `profile email` scopes (see existing comment in the create path
    // below). When additional providers land, gate the email-first
    // lookup on a provider-specific verification check.
    let account =
        (await GetAccountByEmail(c.env.DJIBB_AUTH, googleUserClaims.email)) ??
        (await GetAccountByGoogleId(c.env.DJIBB_AUTH, googleUserClaims.sub));

    if (!account) {
        const newAccount = {
            id: '',
            display_name: googleUserClaims.name,
            email: googleUserClaims.email,
            // Google's userinfo endpoint returns `email_verified: true`
            // for the standard scopes; we trust that signal here. If we
            // ever add providers that don't guarantee verified email,
            // gate this on `googleUserClaims.email_verified`.
            email_verified: true,
            flags: null,
            image: googleUserClaims.picture,
            provider_name: OAUTH_PROVIDER.enum.google,
            provider_client_id: googleUserClaims.sub,
            user_name: null,
            time_created: new Date(),
            time_deleted: null,
            time_updated: new Date(),
        };

        try {
            account = await CreateAccount(c.env, newAccount);
        } catch (error) {
            throw new UnexpectedError();
        }
    }

    let session = c.get('session');

    // @TODO: Need to rate limit this stuff.
    // Perhaps by using CF's new service, with key of something like
    // `${getCurrentRoute()}::${getRequestIPAddress()}` or something.

    try {
        // Create the session, replacing any existing ID.
        session = await CreateSession(
            c.env.DJIBB_AUTH,
            {
                accounts: [account],
                ip_country: c.req.header('CF-IPCountry') || '',
            },
            session?.id
        );
    } catch (error) {
        throw new UnexpectedError();
    }

    setCookie(c, CookieNames.Session, session.id, BaseSessionCookieAttributes);

    // Pending-invite handling: cookie wins, fall back to token appended
    // to `state` (after the first `.`). Either way, we attempt the
    // accept and bias the redirect toward the workspace; failures here
    // don't block the login (we still land them on /accounts/verified).
    let pendingInviteToken = getCookie(c, CookieNames.PendingInvite) ?? null;
    if (!pendingInviteToken && state && state.includes('.')) {
        const idx = state.indexOf('.');
        try {
            pendingInviteToken = decodeURIComponent(state.slice(idx + 1));
        } catch {
            pendingInviteToken = null;
        }
    }
    deleteCookie(c, CookieNames.PendingInvite);

    let acceptedSlug: string | null = null;
    if (pendingInviteToken) {
        try {
            const result = await AcceptInvitation(
                c.env.DJIBB_AUTH,
                account.id,
                pendingInviteToken
            );
            acceptedSlug = result.workspace_slug;
        } catch (err) {
            console.warn(
                'Pending invite accept failed; continuing with login:',
                err
            );
        }
    }

    const redirectOrigin = getCookie(c, CookieNames.RefererOrigin);

    if (
        redirectOrigin &&
        c.env.AUTHORIZED_DOMAINS.split(';').includes(redirectOrigin)
    ) {
        const url = acceptedSlug
            ? new URL(`${redirectOrigin}/w/${acceptedSlug}`)
            : new URL(`${redirectOrigin}/accounts/verified`);
        if (!acceptedSlug) {
            url.searchParams.set('account_id', account.id);
        }
        return c.redirect(url.toString());
    } else {
        console.error(
            'Redirect error: unable to redirect to "%s". Authorized Domains:',
            redirectOrigin,
            c.env.AUTHORIZED_DOMAINS.split(';')
        );

        throw new UnexpectedError();
    }
}

/**
 * Google User Info as provided from Identity Platform.
 * @see: https://cloud.google.com/identity-platform/docs/reference/rest/v1/UserInfo
 */
const GoogleUserClaimsSchema = z.object({
    name: z.string(),
    email: z.string(),
    picture: z.string(),
    sub: z.string(),
});

type GoogleUserClaims = z.TypeOf<typeof GoogleUserClaimsSchema>;
