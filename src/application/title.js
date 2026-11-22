// Gap E7: the window title. "ASSCRACK" on the login screen, "<room> – ASSCRACK" in a room, and
// "(n) <room> – ASSCRACK" when n > 0. n: the pending highlight rows of all channels (highlights.js) plus the unread
// whispers (whispers.js). Each of the two scripts gives one callback for a change of its count.
(function () {
    let room = null;
    let highlights = window.chatHighlights?.pendingCount?.() ?? 0;
    let whispers = window.whispers?.unreadCount?.() ?? 0;

    function render() {
        const n = highlights + whispers;
        document.title = !room ? 'ASSCRACK' : (n > 0 ? '(' + n + ') ' : '') + room + ' – ASSCRACK';
    }

    window.chatHighlights?.onCount?.(count => { highlights = count; render(); });
    window.whispers?.onCount?.(count => { whispers = count; render(); });
    window.roomTitle = {
        // renderer.js (showChat): the room name. null for the login screen.
        setRoom(name) {
            room = typeof name === 'string' && name ? name : null;
            render();
        }
    };
    render();
})();
