import { DjibbError } from '../errors';

enum ReplicacheError {
    InvalidMutatorError = 'rep/invalid-mutator',
}

export class InvalidMutatorError extends DjibbError {
    constructor(mutatorName: string) {
        super(
            `invalid mutator "${mutatorName}"`,
            ReplicacheError.InvalidMutatorError,
            400
        );
    }
}
