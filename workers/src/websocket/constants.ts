export const WS_MESSAGE_PULL_PLS = 'pull pls';

// TODO: probably move this to its own home. It doesn't really belong
// in `list`...
//
// @see https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/readyState
export const WS_STATE = {
	CONNECTING: 0, // The connection is not yet open.
	OPEN: 1, // The connection is open and ready to communicate.
	CLOSING: 2, // The connection is in the process of closing.
	CLOSED: 3, // The connection is closed or couldn't be opened.
};
