// Gap E1: the taskbar flash and the overlay dot for a mention or a private message. attention.js decides with
// wanted(target) and the flash setting. The flash is only for a window with no focus that is not hidden as Idle Peer.
// The focus ends it. Electron is not imported: main.js gives the window and makeDot (a nativeImage).
//
// A minimized window has no focus for the user. Windows can keep the activation on a minimized window (no other
// window took it): then isFocused() is true, and no new focus event comes at the restore. Thus the restore also
// ends the flash when the window is then in focus.
export function createTaskbarFlash({ getWindow, allowed, enabled, makeDot, log }) {
    let flashing = false;
    let dot = null;

    function inFocus(win) {
        return win.isFocused() && !win.isMinimized() && win.isVisible();
    }

    function start() {
        const win = getWindow();
        if (!win || win.isDestroyed() || !allowed() || !enabled() || inFocus(win)) return false;
        win.flashFrame(true);
        try {
            dot ??= makeDot();
            win.setOverlayIcon(dot, 'New mention or private message');
        } catch (err) {
            log('WARN', `Overlay icon not set: ${err?.message ?? err}`);
        }
        if (!flashing) log('EVENT', 'attention flash on');
        flashing = true;
        return true;
    }

    function stop() {
        if (!flashing) return;
        flashing = false;
        const win = getWindow();
        if (win && !win.isDestroyed()) {
            win.flashFrame(false);
            win.setOverlayIcon(null, '');
        }
        log('EVENT', 'attention flash off');
    }

    // The window events that end the flash.
    function attach(win) {
        win.on('focus', stop);
        win.on('restore', () => { if (inFocus(win)) stop(); });
    }

    return { start, stop, attach, isFlashing: () => flashing };
}
