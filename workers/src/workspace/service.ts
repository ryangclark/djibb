import {
    type Workspace,
    Workspace_Member,
    WorkspaceByAccount,
    WorkspaceByAccountSchema,
    WorkspaceSchema,
} from './index';
import {
    FailedPreconditionError,
    NotFoundError,
    ParseError,
    UnexpectedError,
} from '../errors';
import { newId } from '../id';

export async function CreateWorkspace(d1: D1Database, workspace: Workspace) {
    const parseResult = WorkspaceSchema.safeParse(workspace);

    if (!parseResult.success) {
        console.log(
            '`CreateAccount()` parse error:',
            parseResult.error.format()
        );

        throw new ParseError();
    }

    // Ensure we have an owner.
    if (!workspace.members.some(member => member.role === 'owner')) {
        throw new FailedPreconditionError(
            'Cannot create workspace: at least one owner required'
        );
    }

    // Set creation values.
    workspace.id = newId('workspace');
    workspace.time_created = new Date();
    workspace.time_deleted = null;
    workspace.time_updated = workspace.time_created;

    const bindings = [
        workspace.id,
        workspace.name,
        Math.floor(workspace.time_created.getTime() / 1000),
        Math.floor(workspace.time_updated.getTime() / 1000),
    ];

    const stmtCreate = d1
        .prepare(
            `INSERT INTO workspaces (
                id,
                name,
                time_created,
                time_updated
            ) VALUES (
                ${new Array(bindings.length).fill('?').join(', ')}
            )`
        )
        .bind(...bindings);

    const preparedStatements: D1PreparedStatement[] = [stmtCreate];

    for (const member of workspace.members) {
        const stmtMember = d1
            .prepare(
                `INSERT INTO AccountWorkspace (
                    account_id,
                    permissions,
                    role,
                    workspace_id
                ) VALUES (?, ?, ?, ?)`
            )
            .bind(
                member.account_id,
                JSON.stringify(member.permissions),
                member.role,
                workspace.id
            );

        preparedStatements.push(stmtMember);
    }

    return d1
        .batch(preparedStatements)
        .then(() => workspace)
        .catch(err => {
            console.error('`CreateWorkspace()` query error:', err);
            throw new UnexpectedError();
        });
}

export async function GetWorkspacesByAccountId(
    d1: D1Database,
    accountId: string
): Promise<WorkspaceByAccount[]> {
    const workspaces: WorkspaceByAccount[] = [];

    let membersQueries = [];
    let workspacesQueryResult;

    // Query for workspaces by memberships.
    try {
        workspacesQueryResult = await d1
            .prepare(
                `SELECT
                    AccountWorkspace.account_id,
                    AccountWorkspace.permissions,
                    AccountWorkspace.role,
                    workspaces.id,
                    workspaces.name,
                    workspaces.flags,
                    workspaces.image,
                    workspaces.time_created,
                    workspaces.time_deleted,
                    workspaces.time_updated
                FROM workspaces
                JOIN AccountWorkspace
                    ON AccountWorkspace.workspace_id = workspaces.id
                WHERE AccountWorkspace.account_id = ?`
            )
            .bind(accountId)
            .all();

        if (!workspacesQueryResult.success) {
            // I don't know why it'd be unsuccessful.
            // I'm not familiar with the D1 API yet.
            if (!workspacesQueryResult.success) {
                console.error(
                    '`GetWorkspacesByAccountId()` workspaces query unsuccessful for ID "%s"',
                    accountId
                );
                throw new UnexpectedError();
            }
        }
    } catch (err) {
        console.error(
            '`GetWorkspacesByAccountId()` workspace query error:',
            err
        );

        throw new UnexpectedError();
    }

    // Shape the rows into Workspaces.
    for (const row of workspacesQueryResult.results as any) {
        const workspace: WorkspaceByAccount = {
            accountMembership: {
                account_id: row.account_id,
                permissions: row.permissions,
                role: row.role,
            },
            workspace: {
                id: row.id,
                members: [],
                name: row.name,
                time_created: new Date(row.time_created * 1000),
                time_deleted: row.time_deleted
                    ? new Date(row.time_deleted * 1000)
                    : null,
                time_updated: new Date(row.time_updated * 1000),
            },
        };

        const parseResult = WorkspaceByAccountSchema.safeParse(workspace);

        if (!parseResult.success) {
            console.error(
                '`GetWorkspacesByAccountId()` workspace parse error:',
                parseResult.error.format()
            );

            throw new ParseError();
        }

        workspaces.push(parseResult.data);

        // Get the workspace's members. Store the pending query
        // in the object so we can await all.
        membersQueries.push(
            GetWorkspaceMembersById(d1, parseResult.data.workspace.id)
        );
    }

    const resolvedMembersQueries = await Promise.all(membersQueries);

    for (let i = 0; i < workspaces.length; i++) {
        workspaces[i].workspace.members = resolvedMembersQueries[i];
    }

    return workspaces;
}

export async function GetWorkspaceMembersById(
    d1: D1Database,
    workspaceId: string
): Promise<Workspace_Member[]> {
    const members: Workspace_Member[] = [];

    try {
        const queryResult = await d1
            .prepare(
                `SELECT
                    account_id,
                    permissions,
                    role
                FROM AccountWorkspace
                WHERE workspace_id = ?`
            )
            .bind(workspaceId)
            .all();

        // I don't know why it'd be unsuccessful.
        // I'm not familiar with the D1 API yet.
        if (!queryResult.success) {
            console.error(
                '`GetWorkspaceMembersById()` members query unsuccessful for ID "%s"',
                workspaceId
            );
            throw new UnexpectedError();
        }

        for (const row of queryResult.results as any) {
            const member: Workspace_Member = {
                account_id: row.account_id,
                permissions: row.permissions ? JSON.parse(row.permissions) : [],
                role: row.role,
            };

            members.push(member);
        }
    } catch (err) {
        console.error('`GetWorkspaceMembersById()` members query error:', err);
        throw new UnexpectedError();
    }

    // Ensure we have members. Required for now.
    if (!members.length) {
        throw new FailedPreconditionError(
            'Invalid Workspace: at least one member with role "owner" required'
        );
    }

    return members;
}

export async function GetWorkspaceById(d1: D1Database, id: string) {
    let workspace;

    try {
        const row: any = await d1
            .prepare(`SELECT * FROM workspaces WHERE id = ?;`)
            .bind(id)
            .first();

        if (!row) throw new NotFoundError();

        const parseResult = WorkspaceSchema.safeParse({
            id: row.id,
            name: row.name,
            time_created: new Date(row.time_created * 1000),
            time_deleted: row.time_deleted
                ? new Date(row.time_deleted * 1000)
                : null,
            time_updated: new Date(row.time_updated * 1000),
        });

        if (!parseResult.success) {
            console.error(
                '`GetWorkspaceById()` parse error:',
                parseResult.error.format()
            );

            throw new ParseError();
        }

        workspace = parseResult.data;
    } catch (err) {
        if (err instanceof NotFoundError || err instanceof ParseError) {
            throw err;
        }
        console.error('`GetWorkspaceById()` workspace query error:', err);
        throw new UnexpectedError();
    }

    // Now, grab the workspace's members.
    workspace.members = await GetWorkspaceMembersById(d1, workspace.id);

    return workspace;
}
