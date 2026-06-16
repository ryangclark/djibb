import { serializeError, type SerializedDjibbError } from '@djibb/protocol/errors';

// Types for the result object with discriminated union
type Success<T> = {
    data: T;
    error: null;
};

type Failure<E> = {
    data: null;
    error: E;
};

export type Result<T, E = Error> = Success<T> | Failure<E>;

/**
 * Wrapper to make try/catch blocks a function call.
 * Serializes errors.
 *
 * Adapted from @see https://gist.github.com/t3dotgg/a486c4ae66d32bf17c09c73609dacc5b
 * @param fn Callback function
 */
export function tryCatch<T, E = Error>(
    fn: () => T
): Result<T, SerializedDjibbError> {
    try {
        const data = fn();
        // if (data instanceof Promise) {...} // if you want to handle promises, this might be a good start?
        return { data, error: null };
    } catch (error) {
        return { data: null, error: serializeError(error) };
    }
}

/**
 * The original function from Theo, but I dont want everything async.
 * For this function, you pass a returned promise rather than a callback,
 * which is a better API but...
 * @see https://gist.github.com/t3dotgg/a486c4ae66d32bf17c09c73609dacc5b
 * @param promise
 * @returns
 */
export async function tryCatchAsync<T>(
    promise: Promise<T>
): Promise<Result<T, SerializedDjibbError>> {
    try {
        const data = await promise;
        return { data, error: null };
    } catch (error) {
        return { data: null, error: serializeError(error) };
    }
}
