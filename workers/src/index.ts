import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { verifyRequestOrigin } from 'lucia';

import { DjibbList, list_app } from './list/fetch';

/**
 * Associate bindings declared in wrangler.toml with TypeScript types.
 */
export type Env = {
    AUTHORIZED_DOMAINS: string;
    DJIBB_AUTH: D1Database;
    DJIBB_LIST: DurableObjectNamespace;
    KV_AUTH: KVNamespace;
};

// We must export the Durable Object class from `index.ts`.
export { DjibbList };

const app = new Hono<{
    Bindings: Env;
}>();

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

        // CORS middleware.
        // Note that we have to call this function as the return because
        // we're faking things out here.
        return cors({
            allowHeaders: [
                'Authorization',
                'Content-Type',
                'x-replicache-requestid',
            ],
            origin: '*', // TODO: update this to not a wildcard.
        })(c, next);
    },
    // CSRF middleware
    async (c, next) => {
        if (c.req.method === 'GET') {
            return next();
        }
        const originHeader = c.req.header('Origin');
        // NOTE: You may need to use `X-Forwarded-Host` instead

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
        return next();
    }
);

// TODO: check if this is the best thing to return here.
app.get('/', c => c.text('djibb'));

app.route('/list', list_app);

export default app;
