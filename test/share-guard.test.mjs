// 1.0.4: the share of a window that fills a screen (operator, 2026-11-23: no yellow border on a game share). The window
// to screen mapping, the pause rule of the guard, the guard lifecycle with a fake helper, and the helper process itself
// (Windows only: one powershell.exe with an invalid window handle, never a window of this PC).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { screenForWindow } from '../src/application/screen-sources.mjs';
import { covers, createShareGuard, pauseReason } from '../src/application/share-guard.mjs';
import { encodeCommand, guardScript, hwndOf, parseGuardLine, qunsScript, startHelper } from '../src/application/win-helper.mjs';

const R = (left, top, right, bottom) => ({ left, top, right, bottom });
// This PC: DISPLAY1 2560 x 1440 at 0,0 and DISPLAY2 3440 x 1440 at -3440,12.
const PRIMARY = R(0, 0, 2560, 1440);
const SECOND = R(-3440, 12, 0, 1452);
const DISPLAYS = [{ id: 101, rect: PRIMARY }, { id: 202, rect: SECOND }];
const SCREENS = [{ id: 'screen:0:0', displayId: '101' }, { id: 'screen:1:0', displayId: '202' }];
const shown = (rect, monitor, extra = {}) => ({ alive: true, foreground: true, minimized: false, visible: true, rect, monitor, ...extra });

test('mapping: a window that covers its monitor maps to the screen source of that display', () => {
    assert.equal(screenForWindow(shown(PRIMARY, PRIMARY), DISPLAYS, SCREENS)?.id, 'screen:0:0');
    assert.equal(screenForWindow(shown(SECOND, SECOND), DISPLAYS, SCREENS)?.id, 'screen:1:0', 'the other monitor');
    // A maximized window with an automatic task bar: GetWindowRect is 8 px larger on each side.
    assert.equal(screenForWindow(shown(R(-8, -8, 2568, 1448), PRIMARY), DISPLAYS, SCREENS)?.id, 'screen:0:0');
});

test('mapping: a thumbnail match that does not fill a screen gives no screen (the share stays a window share)', () => {
    // A 1280 x 720 window has the 320 x 180 thumbnail of the 2560 x 1440 screen.
    assert.equal(screenForWindow(shown(R(100, 100, 1380, 820), PRIMARY), DISPLAYS, SCREENS), null, 'a small 16:9 window');
    // A 2560 x 1440 window on the 3440 x 1440 monitor has the size of the primary screen.
    assert.equal(screenForWindow(shown(R(-3000, 12, -440, 1452), SECOND), DISPLAYS, SCREENS), null, 'primary size on the other monitor');
    // A maximized window above the task bar.
    assert.equal(screenForWindow(shown(R(-8, -8, 2568, 1400), PRIMARY), DISPLAYS, SCREENS), null, 'the task bar shows');
    assert.equal(screenForWindow({ alive: false }, DISPLAYS, SCREENS), null, 'a closed window');
    assert.equal(screenForWindow(shown(PRIMARY, R(0, 0, 1920, 1080)), DISPLAYS, SCREENS), null, 'no display has this monitor rectangle');
    assert.equal(screenForWindow(shown(PRIMARY, PRIMARY), [...DISPLAYS, { id: 303, rect: PRIMARY }], SCREENS), null, 'two displays match');
    assert.equal(screenForWindow(shown(PRIMARY, PRIMARY), DISPLAYS, [{ id: 'screen:0:0', displayId: '' }]), null, 'no display ID');
    assert.equal(screenForWindow(shown(PRIMARY, PRIMARY), DISPLAYS, [...SCREENS, { id: 'screen:9:0', displayId: '101' }]), null, 'two sources');
});

test('mapping: the physical rectangle of a scaled display (150 %) matches the window in physical pixels', () => {
    // Electron gives the bounds in DIP; main.js converts them with screen.dipToScreenRect.
    const scaled = [{ id: 7, rect: R(0, 0, 3840, 2160) }];
    assert.equal(screenForWindow(shown(R(0, 0, 3840, 2160), R(0, 0, 3840, 2160)), scaled, [{ id: 'screen:0:0', displayId: '7' }])?.id, 'screen:0:0');
    assert.equal(screenForWindow(shown(R(0, 0, 2560, 1440), R(0, 0, 2560, 1440)), scaled, [{ id: 'screen:0:0', displayId: '7' }]), null,
        'a DIP rectangle is not a match');
});

test('pause rule: the share shows the screen only while the window is in front, shown, on its monitor and covers it', () => {
    assert.equal(pauseReason(shown(PRIMARY, PRIMARY), PRIMARY), null);
    assert.equal(pauseReason(null, PRIMARY), 'starting');
    assert.equal(pauseReason({ alive: false }, PRIMARY), 'closed');
    assert.equal(pauseReason(shown(PRIMARY, PRIMARY, { minimized: true }), PRIMARY), 'minimized');
    assert.equal(pauseReason(shown(PRIMARY, PRIMARY, { visible: false }), PRIMARY), 'hidden');
    assert.equal(pauseReason(shown(PRIMARY, PRIMARY, { foreground: false }), PRIMARY), 'background');
    assert.equal(pauseReason(shown(SECOND, SECOND), PRIMARY), 'moved', 'the window went to the other monitor');
    assert.equal(pauseReason(shown(R(0, 0, 1280, 720), PRIMARY), PRIMARY), 'size', 'the game went to windowed mode');
    assert.equal(covers(PRIMARY, PRIMARY), true);
    assert.equal(covers(R(1, 0, 2560, 1440), PRIMARY), false);
});

// A fake helper: the test sends the lines. setTimer/clearTimer are fakes with a manual clock.
function fakeGuard() {
    const timers = new Map();
    let nextTimer = 1;
    const helpers = [];
    const changes = [];
    const logs = [];
    const guard = createShareGuard({
        start: (hwnd, handlers) => {
            const helper = { hwnd, handlers, stopped: false, pid: 4000 + helpers.length, stop() { this.stopped = true; } };
            helpers.push(helper);
            return helper;
        },
        onChange: state => changes.push(state),
        log: (level, text) => logs.push(`${level} ${text}`),
        setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
        clearTimer: id => timers.delete(id)
    });
    const fire = ms => { for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); } };
    const line = (state, helper = helpers.at(-1)) => helper.handlers.onLine(state);
    return { guard, helpers, changes, logs, fire, line, timers };
}
const IN_FRONT = 's alive=1 fg=1 min=0 vis=1 rect=0,0,2560,1440 mon=0,0,2560,1440';

test('guard lifecycle: the first state, the pause at each foreground change, the close stops the helper', async () => {
    const g = fakeGuard();
    const first = g.guard.open(132456);
    assert.equal(g.helpers[0].hwnd, 132456);
    g.line('ready');
    g.line(IN_FRONT);
    const state = await first;
    assert.deepEqual(state.rect, PRIMARY);
    assert.equal(g.changes.length, 0, 'no event before the share uses the screen');
    assert.deepEqual(g.guard.arm(state.monitor), { active: true, paused: true, reason: 'starting' }, 'paused at the start');
    g.fire(300);
    assert.deepEqual(g.changes.at(-1), { active: true, paused: false, reason: null }, 'shown after 300 ms in front');
    g.line(IN_FRONT.replace('fg=1', 'fg=0'));
    assert.deepEqual(g.changes.at(-1), { active: true, paused: true, reason: 'background' }, 'the pause comes at once');
    g.line(IN_FRONT);
    assert.deepEqual(g.changes.at(-1), { active: true, paused: true, reason: 'background' }, 'no resume at once');
    g.line(IN_FRONT.replace('fg=1', 'fg=0'));
    g.fire(300);
    assert.equal(g.guard.state().paused, true, 'a short return to the front gives no resume');
    g.line(IN_FRONT);
    g.fire(300);
    assert.deepEqual(g.changes.at(-1), { active: true, paused: false, reason: null });
    g.line(IN_FRONT.replace('min=0', 'min=1').replace('fg=1', 'fg=0'));
    assert.deepEqual(g.changes.at(-1), { active: true, paused: true, reason: 'minimized' });
    g.line(IN_FRONT);
    g.line('s alive=0');
    assert.deepEqual(g.changes.at(-1), { active: true, paused: true, reason: 'closed' });
    const count = g.changes.length;
    g.line('s alive=0');
    assert.equal(g.changes.length, count, 'the same state gives no event');
    assert.ok(g.logs.includes('EVENT screen guard paused reason=background'));
    assert.ok(g.logs.includes('EVENT screen guard resumed'));
    assert.ok(g.logs.every(l => !/132456/.test(l)), 'no window handle in the log');
    g.guard.close('stop');
    assert.equal(g.helpers[0].stopped, true);
    assert.deepEqual(g.changes.at(-1), { active: false, paused: true, reason: 'off' });
    assert.equal(g.guard.running(), false);
});

test('guard lifecycle: fail closed on a stale helper, a helper exit and an Add-Type error', async () => {
    const g = fakeGuard();
    const first = g.guard.open(77);
    g.line(IN_FRONT);
    g.guard.arm((await first).monitor);
    g.fire(300);
    assert.equal(g.guard.state().paused, false);
    g.fire(1500);
    assert.deepEqual(g.changes.at(-1), { active: true, paused: true, reason: 'stale' }, 'no line for 1.5 s');
    g.line(IN_FRONT);
    g.fire(300);
    assert.equal(g.guard.state().paused, false, 'a new line resumes');
    g.helpers[0].handlers.onExit({ code: 1 });
    assert.deepEqual(g.changes.at(-1), { active: true, paused: true, reason: 'helper' });
    g.line(IN_FRONT);
    assert.equal(g.guard.state().paused, true, 'a helper that ended stays a failure');

    const e = fakeGuard();
    const failed = e.guard.open(78);
    e.line('error add-type');
    await assert.rejects(failed, /did not start/);
    assert.equal(e.helpers[0].stopped, true, 'the helper stops');
    assert.equal(e.guard.running(), false);
});

test('guard lifecycle: no first state in 5 s, or a close before it, rejects and stops the helper', async () => {
    const g = fakeGuard();
    const first = g.guard.open(79);
    g.fire(5000);
    await assert.rejects(first, /did not come/);
    assert.equal(g.helpers[0].stopped, true);
    const again = g.guard.open(80);
    const newer = g.guard.open(81);
    await assert.rejects(again, /stopped/, 'a new open closes the old run at once');
    assert.equal(g.helpers[1].stopped, true);
    assert.equal(g.helpers[2].stopped, false);
    g.line(IN_FRONT, g.helpers[1]);
    g.line(IN_FRONT, g.helpers[2]);
    assert.equal((await newer).alive, true);
});

test('helper: the window handle comes from the source ID; the script takes numbers only', () => {
    assert.equal(hwndOf('window:132456:0'), 132456);
    assert.equal(hwndOf('screen:0:0'), null);
    assert.equal(hwndOf('window:abc:0'), null);
    assert.equal(hwndOf('window:0:0'), null);
    assert.match(guardScript(132456, 999), /\[AsscrackGuard\]::Run\(132456, 999, 250, 500\)$/);
    assert.throws(() => guardScript('1); Remove-Item x; (', 999), /Bad window/);
    assert.throws(() => qunsScript(-1), /Bad process/);
    assert.equal(Buffer.from(encodeCommand('ab'), 'base64').toString('utf16le'), 'ab');
    assert.deepEqual(parseGuardLine(IN_FRONT), { alive: true, foreground: true, minimized: false, visible: true, rect: PRIMARY, monitor: PRIMARY });
    assert.deepEqual(parseGuardLine('s alive=0'), { alive: false });
    assert.equal(parseGuardLine('ready'), null);
    assert.equal(parseGuardLine('s alive=1 fg=1 min=0 vis=1 rect=x mon=0,0,1,1').rect, null);
});

test('helper: one hidden powershell.exe, lines split across chunks, one exit report, stop kills it', () => {
    const calls = [];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.pid = 321;
    child.kill = () => { calls.push('kill'); };
    const lines = [];
    const exits = [];
    const helper = startHelper({ spawn: (file, args, options) => { calls.push({ file, args, options }); return child; },
        script: 'x', onLine: l => lines.push(l), onExit: e => exits.push(e), setPriority: pid => calls.push(`priority ${pid}`),
        env: { SystemRoot: 'C:\\Windows' } });
    assert.equal(calls[0].file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(calls[0].args.slice(0, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
    assert.equal(calls[0].args[5], '-EncodedCommand');
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[1], 'priority 321');
    child.stdout.emit('data', 'rea');
    child.stdout.emit('data', 'dy\r\ns alive=0\n');
    assert.deepEqual(lines, ['ready', 's alive=0']);
    child.emit('exit', 3);
    child.emit('exit', 3);
    assert.deepEqual(exits, [{ code: 3, error: null }]);
    helper.stop();
    assert.ok(calls.includes('kill'));
});

const onWindows = process.platform === 'win32';

test('helper process (Windows): starts in a few seconds, reports a closed window, and ends with stop', { skip: !onWindows }, async () => {
    const lines = [];
    const t0 = Date.now();
    let exited = null;
    let helper;
    await new Promise(resolve => {
        const timer = setTimeout(resolve, 15000);
        helper = startHelper({ spawn, script: guardScript(1, process.pid), onLine: l => {
            lines.push(l);
            if (l.startsWith('s ')) { clearTimeout(timer); resolve(); }
        }, onExit: e => { exited = e; } });
    });
    const ms = Date.now() - t0;
    helper.stop();
    assert.ok(lines.includes('ready'), `lines: ${lines.join('|')}`);
    assert.equal(lines.find(l => l.startsWith('s ')), 's alive=0', 'window handle 1 is not a window');
    assert.ok(ms < 15000, `first state after ${ms} ms`);
    const alive = () => { try { process.kill(helper.pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 50 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(alive(), false, 'stop ends the process');
    assert.equal(exited, null, 'stop() reports no exit');
});

test('helper process (Windows): the helper ends by itself when its parent process ends', { skip: !onWindows }, async () => {
    // A small node parent starts the helper, prints its process ID, and exits after the first state line.
    const parentCode = `
        const { spawn } = require('node:child_process');
        import(${JSON.stringify(new URL('../src/application/win-helper.mjs', import.meta.url).href)}).then(m => {
            const h = m.startHelper({ spawn, script: m.guardScript(1, process.pid), onLine: l => {
                if (l.startsWith('s ')) { console.log('pid ' + h.pid); process.exit(0); } } });
        });`;
    const parent = spawn(process.execPath, ['-e', parentCode], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    parent.stdout.on('data', d => { out += d; });
    await new Promise(resolve => parent.on('exit', resolve));
    const pid = Number(/pid (\d+)/.exec(out)?.[1]);
    assert.ok(pid > 0, `parent output: ${out}`);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const t0 = Date.now();
    while (alive() && Date.now() - t0 < 5000) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(alive(), false, 'the helper ended within 5 s of the parent');
});
