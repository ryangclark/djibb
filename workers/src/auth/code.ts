import { customAlphabet } from 'nanoid';

const CODE_LENGTH = 6;

const NO_LOOK_ALIKES_DICTIONARY = '346789ABCDEFGHJKLMNPQRTUVWXY';

export function createCode() {
    return customAlphabet(NO_LOOK_ALIKES_DICTIONARY, CODE_LENGTH);
}
