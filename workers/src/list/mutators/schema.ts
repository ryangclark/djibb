import { z } from 'zod';

import { DatelikeToDateSchema } from '../../schema';
import { ID_LENGTH, IdTypes } from '../../id';

/**
 * Use `.passthrough()` to keep unrecognized keys during parsing:
 *
 *      DjibbList.mutationArgsSchema.passthrough().parse(...)
 */
export const MutationArgsSchema = z.object({
    accountId: z
        .string()
        .length(ID_LENGTH + IdTypes['account'].length + 1)
        .nullable(),
    timestamp_client: DatelikeToDateSchema.nullable(),
});

export type MutationArgs = z.TypeOf<typeof MutationArgsSchema>;

/**
 * This schema extends the Replicache `MutationV1` type:
 *
 *      type MutationV1 = {
 *          readonly id: number;
 *          readonly name: string;
 *          readonly args: ReadonlyJSONValue;
 *          readonly timestamp: number;
 *          readonly clientID: ClientID;
 *      };
 *
 * with our own properties.
 */
export const MutationSchema = z.object({
    args: MutationArgsSchema.passthrough(),
    clientID: z.string(),
    id: z.number(),
    name: z.string(),
    status: z.enum(['error', 'skipped', 'succeeded', 'unknown']).optional(),
    timestamp_server: DatelikeToDateSchema.optional(),
});

export type Mutation = z.TypeOf<typeof MutationSchema>;
