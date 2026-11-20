// Run with Electron: electron tools/screenshare-bench/main.cjs
// Both windows belong to this experiment. No desktop enumeration or audio capture.
// Optional --loopback-routes replays the synthetic frames over two 127.0.0.1 routes.
const { app, BrowserWindow, session } = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const assert = require('node:assert/strict');

const profile = mkdtempSync(path.join(tmpdir(), 'asscrack-screen-'));
app.setPath('userData', profile);
app.once('quit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} });
const page = path.join(__dirname, 'bench.html');
const cpu = () => app.getAppMetrics().map(p => [p.pid, p.cpu.cumulativeCPUUsage]);

async function bench() {
    await app.whenReady();
    const prefs = { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false };
    const source = new BrowserWindow({ width: 1280, height: 720, frame: false, useContentSize: true, webPreferences: prefs });
    const viewer = new BrowserWindow({ width: 400, height: 180, webPreferences: prefs });
    await Promise.all([source.loadFile(page, { query: { source: 'yes' } }), viewer.loadFile(page)]);
    let allow = false;
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) =>
        callback(permission === 'display-capture' && allow));
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'display-capture' && allow);
    session.defaultSession.setDisplayMediaRequestHandler((request, reply) => {
        // A WebFrameMain grant captures this generated page even if another window covers it.
        const trusted = request.frame === viewer.webContents.mainFrame && !request.audioRequested && allow;
        reply(trusted ? { video: source.webContents.mainFrame } : {});
    });
    const denied = await viewer.webContents.executeJavaScript('denial()', true);
    assert.ok(['NotAllowedError', 'AbortError'].includes(denied), 'No track can open without permission');
    console.log('Display capture denied: ' + denied);
    allow = true;
    session.defaultSession.setPermissionCheckHandler(null);
    session.defaultSession.setPermissionRequestHandler(null);
    for (const scene of ['sheet', 'motion']) {
        await source.webContents.executeJavaScript('startScene(' + JSON.stringify(scene) + ')');
        await wait(300);
        const start = performance.now();
        const before = new Map(cpu());
        const routeSample = scene === 'motion' && process.argv.includes('--loopback-routes');
        const result = await viewer.webContents.executeJavaScript("measure(" + routeSample + ").catch(e => ({ error: e.name + ': ' + e.message, stack: e.stack }))", true);
        const elapsed = (performance.now() - start) / 1000;
        const after = cpu();
        // Include only processes observed across the sample; never treat a missing metric as zero.
        const common = after.filter(([pid, seconds]) => Number.isFinite(seconds) && Number.isFinite(before.get(pid)));
        const cpuSeconds = common.reduce((sum, [pid, seconds]) => sum + seconds - before.get(pid), 0);
        assert.ok(!result.error, JSON.stringify(result));
        assert.ok(result.frames >= 2 && result.decoded === result.frames && result.ended);
        console.log(JSON.stringify({ scene, electron: process.versions.electron, platform: process.platform,
            ...result, cpuCorePercent: common.length ? Math.round(cpuSeconds / elapsed * 1000) / 10 : null }));
        if (routeSample) {
            const sample = await viewer.webContents.executeJavaScript(
                'window.syntheticFrames.map(f => ({ at: f.at, data: f.data.toBase64() }))');
            const { replay } = await import('./routes.mjs');
            for (const result of await replay(sample)) console.log(JSON.stringify(result));
        }
    }
    app.quit();
}
bench().catch(err => { console.error(err); app.exit(1); });
