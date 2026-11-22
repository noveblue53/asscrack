// 1.0.1: the theme of the Friends window (friends-window.html). The same method as friend-chat.js: the window has the
// origin of the room window, thus it reads the theme of the View menu from localStorage and follows each change.
(function () {
    'use strict';
    const key = 'asscrack.theme.v1';
    try {
        const theme = localStorage.getItem(key);
        if (theme) document.documentElement.dataset.theme = theme;
    } catch { /* no saved theme */ }
    window.addEventListener('storage', event => {
        if (event.key === key && event.newValue) document.documentElement.dataset.theme = event.newValue;
    });
})();
