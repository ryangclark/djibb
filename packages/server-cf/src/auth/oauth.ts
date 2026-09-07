import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { CookieOptions } from 'hono/utils/cookie';

import { NotFoundError, UnexpectedError, ValidationError } from '@djibb/protocol/errors';
import { CreateAccount } from '../account/service';
import { exchangeGoogleCode, type GoogleUserClaims } from '../effect/oauth';
import { GetAccountByEmail, GetAccountByGoogleId } from './d1';
import { CreateSession } from './d1';
import { OAUTH_PROVIDER } from '@djibb/protocol/auth/constants';
import {
    sessionCookieAttributes,
    CookieNames,
    OAUTH_REDIRECT_URI,
} from './constants';
import {
    InsertPendingConnection,
    originIsAllowlisted,
    type ConnectCeremonyContext,
} from './connect';
import {
    createGoogleAuthorizationURL,
    generateGoogleCodeVerifier,
    generateGoogleState,
} from './google';
import { FlagRouter, MOCK_AUTH_MODE } from '../flags';
import type { HonoEnv } from '..';

export async function handleGetMockSession(c: Context<HonoEnv>) {
    if (!FlagRouter.featureIsEnabled(MOCK_AUTH_MODE)) {
        throw new NotFoundError();
    }

    const existing = c.get('principal');
    if (existing.kind === 'session') {
        // Could add the mock account to the session, but
        // for now we'll leave it like this.
        return c.json({ accounts: existing.accounts });
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
    let session;
    try {
        // Create the session, adding the account immediately.
        session = await CreateSession(c.env.DJIBB_AUTH, {
            accounts: [account],
            ip_country: '',
        });
    } catch (error) {
        throw new UnexpectedError();
    }

    setCookie(c, CookieNames.Session, session.id, sessionCookieAttributes(c));

    return c.json({ accounts: session.accounts });
}

/**
 * Handle request to initialize Google OAuth flow.
 * The user will be prompted to sign in with Google. If successful,
 * Google will redirect the user to our `/verify` route, at which point
 * we will validate Google's authorization code.
 */
export async function handleInitOAuthGoogle(c: Context<HonoEnv>) {
    const baseState = generateGoogleState();
    const codeVerifier = generateGoogleCodeVerifier();

    // Pending invite token: read from `?invite=<token>`. We carry it
    // through OAuth two ways for defense-in-depth: a cookie (primary,
    // wins on the callback) and appended to `state` (fallback, in case
    // cookies aren't reliably available on the return trip — the
    // `state` round-trips through Google).
    const inviteToken = c.req.query('invite') ?? null;
    const state = inviteToken
        ? `${baseState}.${encodeURIComponent(inviteToken)}`
        : baseState;

    const SCOPES = ['profile', 'email']; // "openid" always included

    const url: URL = await createGoogleAuthorizationURL({
        clientId: c.env.OAUTH_GOOGLE_CLIENT_ID,
        redirectUri: OAUTH_REDIRECT_URI.base(c) + OAUTH_REDIRECT_URI.google,
        state,
        codeVerifier,
        scopes: SCOPES,
    });

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
        originIsAllowlisted(c.env.AUTHORIZED_DOMAINS, refererOrigin)
    ) {
        setCookie(c, CookieNames.RefererOrigin, refererOrigin, cookieOpts);
    } else {
        console.warn(
            '`handleInitOAuthGoogle()` warning: could not set RefererOrigin cookie to "%s"',
            refererOrigin
        );

        throw new UnexpectedError();
    }

    // Connect ceremony (ADR 0024 §1): when the client requests a *credential*
    // rather than a cookie, it starts the flow with `?connect=1` and a PKCE
    // `code_challenge` (plus an optional `label`). We stash that context in a
    // short-lived httpOnly cookie — the ceremony completes in this same
    // browser, so the cookie is the right vessel (mirrors GoogleState). The
    // terminal handler reads it and mints a code instead of a session. The
    // origin is the already-allowlisted `refererOrigin` above.
    //
    // CRITICAL: like GoogleState/GoogleCodeVerifier, this cookie is (re)written
    // on *every* init — set in connect mode, **cleared otherwise**. Without the
    // clear, an abandoned connect ceremony would leave the cookie live for its
    // maxAge, and the next *ordinary* sign-in in this browser would be misread
    // as a connect terminal: no session set, and a credential-minting code
    // handed to the stale client origin. The clear makes the terminal form a
    // function of *this* flow, never a leftover.
    if (c.req.query('connect') === '1') {
        const codeChallenge = c.req.query('code_challenge');
        if (!codeChallenge) {
            console.warn(
                '`handleInitOAuthGoogle()` connect start missing code_challenge'
            );
            throw new ValidationError('missing code_challenge');
        }
        const connectCtx: ConnectCeremonyContext = {
            origin: refererOrigin,
            codeChallenge,
            // Bound to match the magic-link path's `z.string().max(200)` — the
            // same `label` column feeds both entry points.
            label: (c.req.query('label') ?? '').slice(0, 200) || null,
        };
        setCookie(
            c,
            CookieNames.Connect,
            JSON.stringify(connectCtx),
            cookieOpts
        );
    } else {
        deleteCookie(c, CookieNames.Connect);
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

    // Code-for-tokens exchange + userinfo claims fetch, as one named
    // operation on the GoogleIdentity service (`effect/oauth.ts`). The
    // typed error channel (`OAuthExchangeError` / `OAuthClaimsError`)
    // ends here: log the tagged cause, map to the HTTP-boundary
    // DjibbError — same 500 the old ad-hoc throws produced.
    let googleUserClaims: GoogleUserClaims;
    try {
        googleUserClaims = await exchangeGoogleCode(
            {
                clientId: c.env.OAUTH_GOOGLE_CLIENT_ID,
                clientSecret: c.env.OAUTH_GOOGLE_CLIENT_SECRET,
                redirectUri: OAUTH_REDIRECT_URI.base(c) + OAUTH_REDIRECT_URI.google,
            },
            code,
            storedCodeVerifier
        );
    } catch (err) {
        console.error('`/google/verify` identity exchange failed:', err);
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

    // Connect ceremony terminal (ADR 0024 §1, §3): if the flow was started as
    // a connect ceremony, do NOT create a session or set the `djibb-session`
    // cookie. Instead of minting the authorization code here, open a *pending
    // connection* and hand the user to the worker's disclosure page (§3): the
    // code — and so the credential — comes into being only if they approve
    // there. The two terminal forms stay cleanly separate (ADR 0024
    // §Negative): this branch returns before any session work below.
    const connectRaw = getCookie(c, CookieNames.Connect);
    if (connectRaw) {
        deleteCookie(c, CookieNames.Connect);
        let connectCtx: ConnectCeremonyContext;
        try {
            connectCtx = JSON.parse(connectRaw) as ConnectCeremonyContext;
        } catch {
            console.error('`/google/verify` malformed connect cookie');
            throw new ValidationError('Invalid Request!');
        }
        // Re-validate the origin at hand-off time (defense in depth): the
        // allowlist may have changed since ceremony start, and the pending
        // connection must only ever point at a known-good origin.
        if (
            !connectCtx.origin ||
            !connectCtx.codeChallenge ||
            !originIsAllowlisted(c.env.AUTHORIZED_DOMAINS, connectCtx.origin)
        ) {
            console.error(
                '`/google/verify` connect to unauthorized origin "%s"',
                connectCtx.origin
            );
            throw new UnexpectedError();
        }
        const { handle } = await InsertPendingConnection(c.env.DJIBB_AUTH, {
            accountId: account.id,
            accountDisplayName: account.display_name || null,
            clientOrigin: connectCtx.origin,
            codeChallenge: connectCtx.codeChallenge,
            label: connectCtx.label,
        });
        const url = new URL('/auth/connect/consent', OAUTH_REDIRECT_URI.base(c));
        url.searchParams.set('pending', handle);
        return c.redirect(url.toString());
    }

    // Merge into the current cookie session if there is one (multi-Account
    // per session). A bearer principal has no session to merge into.
    const principal = c.get('principal');
    const fromSessionId =
        principal.kind === 'session' ? principal.sessionId : undefined;

    // @TODO: Need to rate limit this stuff.
    // Perhaps by using CF's new service, with key of something like
    // `${getCurrentRoute()}::${getRequestIPAddress()}` or something.

    let session;
    try {
        // Create the session, replacing any existing ID.
        session = await CreateSession(
            c.env.DJIBB_AUTH,
            {
                accounts: [account],
                ip_country: c.req.header('CF-IPCountry') || '',
            },
            fromSessionId
        );
    } catch (error) {
        throw new UnexpectedError();
    }

    setCookie(c, CookieNames.Session, session.id, sessionCookieAttributes(c));

    // Pending-invite handling: cookie wins, fall back to token appended
    // to `state` (after the first `.`). Either way, we attempt the
    // accept and bias the redirect toward the workspace; failures here
    // don't block the login (we still land them on /accounts/verified).
    // ADR 0011 §7b.3: the legacy `PendingInvite` cookie / token-state
    // accept path is gone with the rest of the token-based invitation
    // system. Pending invites for new-signup flows are now handled by
    // the magic-link `next` plumbing (ADR 0009 slice 3) — OAuth users
    // landing here just go to the verified landing.
    deleteCookie(c, CookieNames.PendingInvite);

    const redirectOrigin = getCookie(c, CookieNames.RefererOrigin);

    if (
        redirectOrigin &&
        originIsAllowlisted(c.env.AUTHORIZED_DOMAINS, redirectOrigin)
    ) {
        const url = new URL(`${redirectOrigin}/accounts/verified`);
        url.searchParams.set('account_id', account.id);
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
