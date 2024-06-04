import { StatusCode } from 'hono/utils/http-status';

export enum CoreErrorCode {
    FailedPrecondition = 'core/failed-precondition',
    NotFound = 'core/not-found',
    ParseError = 'core/parse-error',
    UnexpectedError = 'core/unexpected-error',
    ValidationError = 'core/validation-error',
    // Add more error codes as needed
}

/**
 * Custom Djibb error class that extends the built-in `Error` class.
 */
export class DjibbError extends Error {
    public code: string;
    public httpStatusCode: StatusCode = 500;

    constructor(message: string, code: string, statusCode: StatusCode) {
        super(message);
        this.code = code;
        this.httpStatusCode = statusCode;

        this.name = this.constructor.name;
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
    constructor(message: string) {
        super(message, CoreErrorCode.NotFound, 404);
    }
}

export class ParseError extends DjibbError {
    constructor(message: string = 'parse error') {
        super(message, CoreErrorCode.ParseError, 400);
    }
}

export class ValidationError extends DjibbError {
    constructor(message: string = 'validation error') {
        super(message, CoreErrorCode.ValidationError, 400);
    }
}

export class UnexpectedError extends DjibbError {
    constructor(message: string = 'Internal Server Error') {
        super(message, CoreErrorCode.UnexpectedError, 500);
    }
}
