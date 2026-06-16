import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * Whole-replace of the entity's authorization_rules. The simpler
 * primitive — field-level deltas (e.g. "add this account as editor")
 * can be added later as separate mutators if the UI needs them.
 *
 * No "do not lock yourself out" guard. The UI is responsible for
 * preventing nonsensical rules (e.g. removing the only owner). If
 * bricked, the list is recoverable via direct DO sql edit. Worth
 * adding a server-side guard later — TODO.
 */
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    authorization_rules: z.ZodObject<{
        authorized_accounts: z.ZodRecord<z.ZodString, z.ZodObject<{
            role: z.ZodEnum<{
                admin: "admin";
                checker: "checker";
                editor: "editor";
                owner: "owner";
                viewer: "viewer";
            }>;
        }, z.core.$strip>>;
        default_role: z.ZodEnum<{
            checker: "checker";
            editor: "editor";
            ownerless: "ownerless";
            restricted: "restricted";
            viewer: "viewer";
        }>;
        set_by: z.ZodEnum<{
            defaults: "defaults";
            user: "user";
            workspace: "workspace";
        }>;
    }, z.core.$strip>;
    expected: z.ZodOptional<z.ZodObject<{
        authorization_rules: z.ZodObject<{
            authorized_accounts: z.ZodRecord<z.ZodString, z.ZodObject<{
                role: z.ZodEnum<{
                    admin: "admin";
                    checker: "checker";
                    editor: "editor";
                    owner: "owner";
                    viewer: "viewer";
                }>;
            }, z.core.$strip>>;
            default_role: z.ZodEnum<{
                checker: "checker";
                editor: "editor";
                ownerless: "ownerless";
                restricted: "restricted";
                viewer: "viewer";
            }>;
            set_by: z.ZodEnum<{
                defaults: "defaults";
                user: "user";
                workspace: "workspace";
            }>;
        }, z.core.$strip>;
    }, z.core.$strict>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "setListAuthRules";
/**
 * Tighter than EDIT_ROLES — only admin or owner can re-grant access.
 * Editors and checkers can mutate list state but cannot change who
 * else gets in. `ownerless` is excluded by design; claim flow is
 * separate (and yet-unbuilt).
 */
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const capturePreState: CapturePreState<Args>;
export declare const inverse: Inverse<Args>;
