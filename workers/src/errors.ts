import { StatusCode } from 'hono/utils/http-status';

export enum CoreErrorCode {
    AlreadyInitialized = 'core/already-initialized',
    BadMutation = 'core/bad-mutation',
    BadRequest = 'core/bad-request',
    FailedPrecondition = 'core/failed-precondition',
    NotFound = 'core/not-found',
    ParseError = 'core/parse-error',
    ValidationError = 'core/validation-error',
    UnexpectedError = 'core/unexpected-error',
    UnauthenticatedError = 'core/unauthenticated-error',
    UnauthorizedError = 'core/unauthorized-error',
    // Add more error codes as needed
}

export interface SerializedDjibbError {
    name: string;
    message: string;
    code: CoreErrorCode;
    httpStatusCode: StatusCode;
    stack?: string;
}

/**
 * Custom Djibb error class that extends the built-in `Error` class.
 */
export class DjibbError extends Error {
    public code: CoreErrorCode;
    public httpStatusCode: StatusCode = 500;

    constructor(message: string, code: CoreErrorCode, statusCode: StatusCode) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.code = code;
        this.httpStatusCode = statusCode;

        this.name = this.constructor.name;
    }

    toJSON(): SerializedDjibbError {
        return {
            name: this.name,
            message: this.message,
            code: this.code,
            httpStatusCode: this.httpStatusCode,
            stack: this.stack,
        };
    }
}

export class BadMutationError extends DjibbError {
    constructor(message: string = 'Bad Mutation') {
        super(message, CoreErrorCode.BadMutation, 400);
    }
}

export class BadRequestError extends DjibbError {
    constructor(message: string = 'Bad Request') {
        super(message, CoreErrorCode.BadRequest, 400);
    }
}

// FailedPrecondition indicates operation was rejected because the
// system is not in a state required for the operation's execution.
// For example, updating the quantity of a deleted item.
export class FailedPreconditionError extends DjibbError {
    constructor(message: string) {
        super(message, CoreErrorCode.FailedPrecondition, 412);
    }
}

export class NotFoundError extends DjibbError {
    constructor(message: string = 'Resource Not Found') {
        super(message, CoreErrorCode.NotFound, 404);
    }
}

export class ParseError extends DjibbError {
    constructor(message: string = 'Parse Error') {
        super(message, CoreErrorCode.ParseError, 400);
    }
}

export class TablesAlreadyInitializedError extends DjibbError {
    constructor(message: string = 'tables already initialized') {
        super(message, CoreErrorCode.AlreadyInitialized, 412);
    }
}

export class ValidationError extends DjibbError {
    constructor(message: string = 'Validation Error') {
        super(message, CoreErrorCode.ValidationError, 400);
    }
}

export class UnauthenticatedError extends DjibbError {
    constructor(message: string = 'Unauthenticated') {
        super(message, CoreErrorCode.UnauthenticatedError, 401);
    }
}

export class UnauthorizedError extends DjibbError {
    constructor(message: string = 'Unauthorized') {
        super(message, CoreErrorCode.UnauthorizedError, 403);
    }
}

export class UnexpectedError extends DjibbError {
    constructor(message: string = 'Internal Server Error') {
        super(message, CoreErrorCode.UnexpectedError, 500);
    }
}

/**
 * Turns a serialized error back into a real instance
 * (e.g., for logging, analytics, or rethrowing)
 */
export function deserializeDjibbError(e: SerializedDjibbError): DjibbError {
    const err = new DjibbError(e.message, e.code, e.httpStatusCode);
    err.name = e.name;
    if (e.stack) err.stack = e.stack;
    return err;
}

/**
 * Explicit helper for safety and clarity
 */
export function serializeError(e: unknown): SerializedDjibbError {
    if (e instanceof DjibbError) return e.toJSON();
    if (e instanceof Error) {
        return {
            name: e.name,
            message: e.message,
            code: CoreErrorCode.UnexpectedError,
            httpStatusCode: 500,
            stack: e.stack,
        };
    }

    return new UnexpectedError(
        'serialization error: unexpected instanceof'
    ).toJSON();
}

