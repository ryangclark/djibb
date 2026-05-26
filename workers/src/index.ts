import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { User, verifyRequestOrigin } from 'lucia';

import { CatalogApp } from './catalog/fetch';
import { list_app, template_app } from './list/fetch';
import { AuthorizationRole } from './auth/rules';
import { EntityRow } from './list/entity';
import { Session } from './auth/session';
import { Auth_App } from './auth/fetch';
import { DjibbError } from './errors';
import { DjibbList } from './list/durable_object';
import { AccountApp, UserApp } from './account/fetch';
import { WorkspaceApp } from './workspace/fetch';

/**
 * Associate bindings declared in wrangler.toml with TypeScript types.
 */
export type Bindings = {
    API_ORIGIN: string;
    AUTHORIZED_DOMAINS: string;
    ENV: string;
    DJIBB_AUTH: D1Database;
    DJIBB_LIST: DurableObjectNamespace<DjibbList>;
    KV_AUTH: KVNamespace;

    // OAuth
    OAUTH_GOOGLE_CLIENT_ID: string;
    OAUTH_GOOGLE_CLIENT_SECRET: string;

    // Email (Cloudflare Email Sending)
    EMAIL: SendEmail;
    EMAIL_FROM: string;
};

export type Variables = {
    authorized_role: AuthorizationRole;
    entity: EntityRow | null;
    entity_id: string;
    id: DurableObjectId;
    // lucia: Register['Lucia'];
    session: Session | null;
    list: DurableObjectStub<DjibbList>;
    user: User | null;
};

export interface HonoEnv {
    Bindings: Bindings;
    Variables: Variables;
}

// We must export the Durable Object class from `index.ts`.
export { DjibbList };

const app = new Hono<HonoEnv>();

// Middleware inits.
app.use(
    /**
     * This function acts as a controller to add CORS headers to the
     * `Response`s to most routes. We can't add those headers to the
     * WebSocket `Response`, though, because they're immutable.
     *
     * It seemed convenient enough to have the `cors()` middleware run
     * on all the routes, though, and find a way to have a negative
     * condition (positive conditions are easier, I think) in the `path`
     * param you can pass to Hono's `use()` function here.
     *
     * To get an exclusion condition for the WebSocket endpoint, I had
     * to hook things up a little funky. Ordinarily, you pass `cors()`
     * directly to `app.use()`, like `app.use(cors(myCorsConfig))`. To
     * get the conditional we need, though, we instead return a
     * middleware function that returns a middleware's result. It sounds
     * more complicated than it is. Just imagine what `app.use()` expects
     * to receive as a param, and it gets clearer – just get that function
     * what it needs, depending on the conditions.
     */
    (c, next) => {
        // Can't use CORS middleware for Websocket connections because CORS
        // changes the Response headers, and headers are immutable for WS.
        //
        // I tried for a while to get the Hono routing to use a negative
        // lookahead regexp, but couldn't get it to work. Oh well.
        // Could instead rearrange the middleware to occur AFTER the
        // handler for the websocket endpoint, BUT we are using the subrouter
        // pattern, so that doesn't quite work...
        if (c.req.path.includes('websocket')) return next();

        const originHeader = c.req.header('Origin') || '';
        const originVerified = verifyRequestOrigin(
            originHeader,
            c.env.AUTHORIZED_DOMAINS.split(';')
        );

        // CORS middleware.
        // Note that we have to call this function as the return because
        // we're faking things out here.
        return cors({
            allowHeaders: [
                'Authorization',
                'Content-Type',
                'x-replicache-requestid',
            ],
            credentials: originVerified,
            origin: originVerified ? originHeader : '*',
        })(c, next);
    },
    // CSRF middleware
    async (c, next) => {
        if (c.req.method === 'GET') {
            await next();
            return;
        }

        // Magic-link consume is exempt from the AUTHORIZED_DOMAINS
        // origin check (ADR 0010). The interstitial click-through
        // page is served from API_ORIGIN and POSTs same-origin, so
        // the inbound Origin will be API_ORIGIN — which isn't (and
        // shouldn't be) in AUTHORIZED_DOMAINS. CSRF defense for this
        // route is the bearer secret in the request body: only the
        // email recipient has it. See workers/src/auth/magic.ts.
        if (c.req.path === '/auth/magic/consume') {
            await next();
            return;
        }

        const originHeader = c.req.header('Origin');

        const hostHeader = c.req.header('Host');
        if (
            !originHeader ||
            !hostHeader ||
            !verifyRequestOrigin(
                originHeader,
                c.env.AUTHORIZED_DOMAINS.split(';')
            )
        ) {
            return c.body(null, 403);
        }
        await next();
    }
);

// TODO: check if this is the best thing to return here.
app.get('/', c => c.text('hello, djibb!'));

app.route('/a', AccountApp);
app.route('/auth', Auth_App);
app.route('/entities', CatalogApp);
// ADR 0011 §7b.3: `/invitations/*` (token-based legacy workspace
// invitations) is gone. Invites live on the entity DO via ADR 0009.
app.route('/list', list_app);
app.route('/template', template_app);
app.route('/u', UserApp);
app.route('/workspace', WorkspaceApp);

app.onError(err => {
    if (err instanceof DjibbError) {
        return new Response(err.message || '', { status: err.httpStatusCode });
    }

    console.error('Unexpected Top-Level Error:', err);

    return new Response('Unexpected Error', { status: 500 });
});

export default app;
