import { z } from 'zod';

export const WORKSPACE_ID_LENGTH = 22;

// @TODO: will need safeguards for Creation/Updates to an Workspace's
// members. For instance, a workspace must always have at least one
// member with the Admin/Owner role.
const Workspace_Member_Schema = z.object({
    account_id: z.string(),
    role: z.string(),
    permissions: z.array(z.string()),
});

export type Workspace_Member = z.TypeOf<typeof Workspace_Member_Schema>;

/** */
const Workspace_Schema = z.object({
    id: z.string().length(WORKSPACE_ID_LENGTH),
    name: z.string(),
    members: z.array(Workspace_Member_Schema).min(1),
    time_created: z.string().datetime(),
    time_deleted: z.string().datetime().nullable(),
    time_updated: z.string().datetime(),
});

export type Workspace = z.TypeOf<typeof Workspace_Schema>;
