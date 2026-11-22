// L7: the image previews of peer images are decoded in a hidden sandboxed window, not in the main process. A bug in an
// image decoder of Chromium then runs in a sandboxed renderer with no Node and no preload API except the job channel.
// The main process gives the bytes and gets a PNG back. room-media.mjs checks that PNG (inspectImage, wire rules) and
// does not decode it.
const JOB = 'asscrack:image-decode';
const RESULT = 'asscrack:image-decoded';

// BrowserWindow, ipc: of Electron (a test gives fakes). page: the URL of image-decoder.html. preload: the path of
// image-decoder-preload.cjs. isFrame(win, event): the sender check (isDesktopFrame of desktop-boundary.mjs).
// lock(webContents): the navigation lock. The window closes after idleMs with no job.
export function createImageDecoder({ BrowserWindow, ipc, page, preload, isFrame, lock = () => {}, timeoutMs = 5000,
    idleMs = 60000, maxBytes = 16 * 1024 * 1024, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let win = null, loaded = null, seq = 0, idle = null, disposed = false;
    const jobs = new Map(); // id -> { resolve, timer }

    function finish(id, value) {
        const job = jobs.get(id);
        if (!job) return;
        jobs.delete(id);
        clearTimer(job.timer);
        job.resolve(value);
        if (!jobs.size) armIdle();
    }

    function close() {
        clearTimer(idle);
        idle = null;
        const old = win;
        win = null;
        loaded = null;
        for (const id of [...jobs.keys()]) finish(id, null);
        if (old && !old.isDestroyed()) old.destroy();
    }

    function armIdle() {
        clearTimer(idle);
        idle = setTimer(() => { if (!jobs.size) close(); }, idleMs);
        idle?.unref?.();
    }

    function open() {
        if (win && !win.isDestroyed()) return loaded;
        win = new BrowserWindow({ show: false, width: 64, height: 64, skipTaskbar: true, focusable: false,
            webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
                backgroundThrottling: false, spellcheck: false } });
        const own = win;
        lock(own.webContents);
        own.webContents.on('render-process-gone', () => { if (win === own) close(); });
        own.on('closed', () => { if (win === own) { win = null; loaded = null; for (const id of [...jobs.keys()]) finish(id, null); } });
        loaded = own.loadURL(page).then(() => true, () => { if (win === own) close(); return false; });
        return loaded;
    }

    ipc.on(RESULT, (event, id, bytes) => {
        if (!win || !isFrame(win, event)) return;
        if (!jobs.has(id)) return;
        finish(id, bytes instanceof Uint8Array && bytes.length > 0 ? Buffer.from(bytes) : null);
    });

    // info: { bytes, width, height } of inspectImage. limit: the PNG size limit. Gives the PNG bytes or null.
    async function decode(info, limit) {
        if (disposed || !info?.bytes?.length || info.bytes.length > maxBytes) return null;
        clearTimer(idle);
        const id = ++seq;
        const result = new Promise(resolve => {
            const timer = setTimer(() => { finish(id, null); close(); }, timeoutMs);
            timer?.unref?.();
            jobs.set(id, { resolve, timer });
        });
        if (!await open() || !jobs.has(id) || !win) { finish(id, null); return result; }
        win.webContents.send(JOB, id, new Uint8Array(info.bytes), { width: info.width, height: info.height, limit });
        return result;
    }

    function dispose() {
        disposed = true;
        close();
    }

    return { decode, close, dispose };
}
