// Small Windows helpers with no new dependency: one powershell.exe process that compiles a few lines of C# (Add-Type)
// and then runs a loop in that C# code. The process writes one line to stdout for each state. It exits by itself when
// the parent process (this app) ends. Electron is not imported: main.js gives spawn, so that a test can use a fake.
//
// - The window guard (screen share of a window that fills a screen): the foreground window, the minimized state, the
//   rectangle of the window and of its monitor. A WinEvent hook wakes the loop at each foreground change; a poll each
//   250 ms finds the other changes (minimize, close, size).
// - The notification state (optional automatic Do not disturb): SHQueryUserNotificationState each 2 s.
//
// The script text goes to powershell.exe with -EncodedCommand. A .ps1 file in the asar is not readable by
// powershell.exe. The values in the script are numbers only.
import path from 'node:path';

export const GUARD_POLL_MS = 250;
// A guard line comes at each change and at least each HEARTBEAT_MS. No line for STALE_MS is a failure.
export const GUARD_HEARTBEAT_MS = 500;
export const QUNS_POLL_MS = 2000;

const GUARD_CS = `
using System; using System.Runtime.InteropServices;
public static class AsscrackGuard {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern uint MsgWaitForMultipleObjects(uint n, IntPtr[] h, bool all, uint ms, uint mask);
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint remove);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  static WinEventProc keep;
  static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) { }
  static string State(IntPtr w) {
    bool alive = IsWindow(w);
    if (!alive) return "s alive=0";
    RECT r; GetWindowRect(w, out r);
    MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    GetMonitorInfo(MonitorFromWindow(w, 2), ref mi);
    int cloaked = 0; DwmGetWindowAttribute(w, 14, out cloaked, 4);
    RECT m = mi.rcMonitor;
    return "s alive=1 fg=" + (GetForegroundWindow() == w ? 1 : 0) + " min=" + (IsIconic(w) ? 1 : 0) +
      " vis=" + (IsWindowVisible(w) && cloaked == 0 ? 1 : 0) + " rect=" + r.L + "," + r.T + "," + r.R + "," + r.B +
      " mon=" + m.L + "," + m.T + "," + m.R + "," + m.B;
  }
  public static void Run(long hwnd, uint parentPid, uint pollMs, int heartbeatMs) {
    if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) SetProcessDPIAware();
    IntPtr parent = OpenProcess(0x00100000, false, parentPid);
    if (parent == IntPtr.Zero) return;
    IntPtr w = new IntPtr(hwnd);
    keep = new WinEventProc(OnEvent);
    SetWinEventHook(3, 3, IntPtr.Zero, keep, 0, 0, 0);
    SetWinEventHook(0x16, 0x17, IntPtr.Zero, keep, 0, 0, 0);
    string last = null; IntPtr[] handles = new IntPtr[] { parent }; MSG msg;
    var clock = System.Diagnostics.Stopwatch.StartNew(); long lastAt = 0;
    while (true) {
      string s = State(w);
      long t = clock.ElapsedMilliseconds;
      if (s != last || t - lastAt >= heartbeatMs) { Console.Out.WriteLine(s); Console.Out.Flush(); last = s; lastAt = t; }
      uint r = MsgWaitForMultipleObjects(1, handles, false, pollMs, 0x04FF);
      if (r == 0) return;
      while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
    }
  }
}`;

const QUNS_CS = `
using System; using System.Runtime.InteropServices;
public static class AsscrackQuns {
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  public static void Run(uint parentPid, uint pollMs) {
    IntPtr parent = OpenProcess(0x00100000, false, parentPid);
    if (parent == IntPtr.Zero) return;
    int last = -1;
    while (true) {
      int state = 0;
      if (SHQueryUserNotificationState(out state) != 0) state = 0;
      if (state != last) { Console.Out.WriteLine("q " + state); Console.Out.Flush(); last = state; }
      if (WaitForSingleObject(parent, pollMs) == 0) return;
    }
  }
}`;

const wrap = (cs, call) => [
    "$ErrorActionPreference = 'Stop'",
    `try { Add-Type -TypeDefinition @'\n${cs}\n'@ } catch { [Console]::Out.WriteLine('error add-type'); [Console]::Out.Flush(); exit 3 }`,
    "[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()",
    call
].join('\n');

const whole = (value, name) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Bad ${name}.`);
    return value;
};

export function guardScript(hwnd, parentPid, pollMs = GUARD_POLL_MS, heartbeatMs = GUARD_HEARTBEAT_MS) {
    return wrap(GUARD_CS, `[AsscrackGuard]::Run(${whole(hwnd, 'window')}, ${whole(parentPid, 'process')}, ${whole(pollMs, 'poll')}, ${whole(heartbeatMs, 'heartbeat')})`);
}

export function qunsScript(parentPid, pollMs = QUNS_POLL_MS) {
    return wrap(QUNS_CS, `[AsscrackQuns]::Run(${whole(parentPid, 'process')}, ${whole(pollMs, 'poll')})`);
}

// powershell.exe -EncodedCommand takes the script as base64 of UTF-16LE.
export const encodeCommand = script => Buffer.from(String(script), 'utf16le').toString('base64');

// The window handle in a desktopCapturer window ID: window:<HWND>:<n>. null for another ID.
export function hwndOf(sourceId) {
    const match = /^window:(\d{1,20}):\d+$/.exec(String(sourceId ?? ''));
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export const powershellPath = (env = process.env) =>
    path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// One guard line: "s alive=1 fg=1 min=0 vis=1 rect=L,T,R,B mon=L,T,R,B", or "s alive=0". null for another line.
export function parseGuardLine(line) {
    const text = String(line ?? '').trim();
    if (!text.startsWith('s ')) return null;
    const fields = {};
    for (const part of text.slice(2).split(' ')) {
        const eq = part.indexOf('=');
        if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
    }
    const rect = value => {
        const n = String(value ?? '').split(',').map(Number);
        return n.length === 4 && n.every(Number.isInteger) ? { left: n[0], top: n[1], right: n[2], bottom: n[3] } : null;
    };
    if (fields.alive !== '1') return { alive: false };
    return { alive: true, foreground: fields.fg === '1', minimized: fields.min === '1', visible: fields.vis === '1',
        rect: rect(fields.rect), monitor: rect(fields.mon) };
}

// One running helper. spawn: child_process.spawn. onLine(text) for each stdout line; onExit({ code, error }) one time.
// setPriority(pid): lowers the priority (os.setPriority). Gives { pid, stop() }.
export function startHelper({ spawn, script, onLine, onExit = () => {}, setPriority = () => {}, env = process.env }) {
    let child;
    let ended = false;
    const end = info => { if (!ended) { ended = true; onExit(info); } };
    try {
        child = spawn(powershellPath(env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-EncodedCommand', encodeCommand(script)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
        queueMicrotask(() => end({ code: null, error: error?.code ?? 'spawn' }));
        return { pid: null, stop() {} };
    }
    try { if (child.pid) setPriority(child.pid); } catch { /* the default priority */ }
    let buffer = '';
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 65536) buffer = buffer.slice(-4096);
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, index).replace(/\r$/, '');
            buffer = buffer.slice(index + 1);
            if (!ended && line) onLine(line);
        }
    });
    child.on('error', error => end({ code: null, error: error?.code ?? 'spawn' }));
    child.on('exit', code => end({ code, error: null }));
    return {
        pid: child.pid ?? null,
        stop() {
            ended = true;
            try { child.kill(); } catch { /* ended */ }
        }
    };
}
