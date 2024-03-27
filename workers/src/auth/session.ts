export const SESSION_ID_LENGTH = 22;

const SESSION_KEY_PREFIX = `sid/`;

export function sessionKey(sessionId: string) {
	return `${SESSION_KEY_PREFIX}${sessionId}`;
}

export type Session = {
	user_id: string | null;
    // I don't know what else needs to go in here.
};
