import { DjibbError } from '../errors';

export enum AuthErrorCode {
    Unauthenticated = 'auth/unauthenticated',
    Unauthorized = 'auth/unauthorized',
}

/**
 * The client must authenticate itself to get the requested response.
 */
export class UnauthenticatedError extends DjibbError {
    constructor(message: string = 'unauthenticated') {
        super(message, AuthErrorCode.Unauthenticated, 401);
    }
}

/**
 * The client, whose identity is known to the server, does not have
 * access rights to the requested content or operation.
 */
export class UnauthorizedError extends DjibbError {
    constructor(message: string = 'unauthorized') {
        super(message, AuthErrorCode.Unauthorized, 403);
    }
}
