// Room music (MU-6, P10): the player script of YouTube (the signature and n functions that youtubei.js cuts from it)
// runs in a hidden sandboxed window, not in the main process. The page has no Node, no preload API except the job
// channel, and a CSP with no network (connect-src 'none'). The main process sends the code and gets back two strings.
// The window has its own in-memory session (partition): thus it never shares a renderer process with the room window,
// and a script that does not end stops only its own process.
const JOB = 'asscrack:music-eval';
const RESULT = 'asscrack:music-evaluated';
// The largest script and result.
const MAX_CODE = 4 * 1024 * 1024;
const MAX_RESULT = 64 * 1024;

// BrowserWindow, ipc: of Electron (a test gives fakes). page: the URL of music-eval.html. preload: the path of
// music-eval-preload.cjs. isFrame(win, event): the sender check. lock(webContents): the navigation lock.
// partition: the session of the window (main.js gives it the app scheme and no permissions). A job that takes longer
// than timeoutMs stops the renderer process (killProcess(pid)) and closes the window. The window closes after idleMs.
export function createMusicEval({ BrowserWindow, ipc, page, preload, isFrame, lock = () => {}, partition = undefined,
    timeoutMs = 5000, idleMs = 120000, setTimer = setTimeout, clearTimer = clearTimeout,
    killProcess = pid => process.kill(pid) } = {}) {
    let win = null, loaded = null, seq = 0, idle = null, disposed = false;
    const jobs = new Map();

    function finish(id, value) {
        const job = jobs.get(id);
        if (!job) return;
        jobs.delete(id);
        clearTimer(job.timer);
        job.resolve(value);
        if (!jobs.size) armIdle();
    }

    // hung: a job ran too long. The renderer of a hung script still runs after destroy(), and a new window of the
    // same page got the same process (measured in Electron 45). Thus the process stops first, by its ID.
    function close(hung = false) {
        clearTimer(idle);
        idle = null;
        const old = win;
        win = null;
        loaded = null;
        for (const id of [...jobs.keys()]) finish(id, null);
        if (old && !old.isDestroyed()) {
            if (hung) {
                try {
                    const pid = old.webContents.getOSProcessId();
                    if (Number.isInteger(pid) && pid > 0) killProcess(pid);
                } catch { /* the renderer is gone */ }
            }
            old.destroy();
        }
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
                backgroundThrottling: false, spellcheck: false, ...(partition ? { partition } : {}) } });
        const own = win;
        lock(own.webContents);
        own.webContents.on('render-process-gone', () => { if (win === own) close(); });
        own.on('closed', () => { if (win === own) { win = null; loaded = null; for (const id of [...jobs.keys()]) finish(id, null); } });
        loaded = own.loadURL(page).then(() => true, () => { if (win === own) close(); return false; });
        return loaded;
    }

    // The result of the page: a JSON text { sig?, n? } with string fields only.
    function parse(textValue) {
        if (typeof textValue !== 'string' || textValue.length > MAX_RESULT) return null;
        let value;
        try { value = JSON.parse(textValue); } catch { return null; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const out = {};
        for (const key of ['sig', 'n']) {
            if (value[key] === undefined || value[key] === null) continue;
            if (typeof value[key] !== 'string' || value[key].length > 4096) return null;
            out[key] = value[key];
        }
        return out;
    }

    ipc.on(RESULT, (event, id, textValue) => {
        if (!win || !isFrame(win, event) || !jobs.has(id)) return;
        finish(id, parse(textValue));
    });

    // Gives { sig, n } or null.
    async function run(code) {
        if (disposed || typeof code !== 'string' || !code || code.length > MAX_CODE) return null;
        clearTimer(idle);
        const id = ++seq;
        const result = new Promise(resolve => {
            const timer = setTimer(() => { finish(id, null); close(true); }, timeoutMs);
            timer?.unref?.();
            jobs.set(id, { resolve, timer });
        });
        if (!await open() || !jobs.has(id) || !win) { finish(id, null); return result; }
        win.webContents.send(JOB, id, code);
        return result;
    }

    function dispose() {
        disposed = true;
        close();
    }

    return { run, close, dispose };
}
