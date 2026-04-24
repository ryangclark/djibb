import { Hono } from 'hono';
import { HonoEnv } from '..';
import { HandleSession } from '../auth/middleware';

export const AccountApp = new Hono<HonoEnv>();

AccountApp.use('/:id/*', HandleSession);

// TODO: GET /:id/workspaces — re-add when the workspace module lands
// (was removed to keep this chunk buildable without workspace/service).
