import type { ReadonlyJSONValue } from 'replicache';
import { z } from 'zod';

const datelike = z.union([z.number(), z.string(), z.date()]);

/**
 * Coerces datelike input into a Date.
 *
 * Taken from Zod documentation: https://zod.dev/?id=pipe
 * Use it until it breaks, I guess.
 */
export const DatelikeToDateSchema = datelike.pipe(z.coerce.date());

/**
 * Attempt to make Replicache's `ReadonlyJSONValue` type as a Zod schema.
 *
 * @See https://zod.dev/?id=json-type
 */
// First make a schema for any of JavaScript's literal values.
const literalSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
// type Literal = z.infer<typeof literalSchema>;

// Now, we do some recursion cleverness.
// I hard-coded the type as Replicache's `ReadonlyJSONValue`, but
// I'm not 100% confident in the overlap of the Zod result here and
// the type. Should be fine most likely.
export const ReadonlyJSONValueSchema: z.ZodType<ReadonlyJSONValue> = z.lazy(
    () =>
        z.union([
            literalSchema,
            z.array(ReadonlyJSONValueSchema),
            z.record(z.string(), ReadonlyJSONValueSchema),
        ])
);
