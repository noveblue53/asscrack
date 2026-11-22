// The IPC of the room window. Each handler checks that the call comes from the main frame of the room window.
// handle: a call from another frame gets an error.
// on: a message from another frame is ignored.
// query: for a read-only call. A call from a window that closes (for example at Quit) gets null and no error line in
// the terminal (OI2).
export function createRoomIpc(ipc, isRoomFrame) {
    return {
        handle(channel, handler) {
            ipc.handle(channel, (event, ...args) => {
                if (!isRoomFrame(event)) throw new Error('Unknown room window');
                return handler(event, ...args);
            });
        },
        on(channel, listener) {
            ipc.on(channel, (event, ...args) => {
                if (isRoomFrame(event)) listener(event, ...args);
            });
        },
        query(channel, handler) {
            ipc.handle(channel, (event, ...args) => isRoomFrame(event) ? handler(event, ...args) : null);
        }
    };
}
