// The tiles of the screen-share picker are buttons. The global button rule (height 30 px, no wrap) must not make
// the thumbnail spill out of its tile. A real Electron window loads index.html and measures the picker in each theme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const electron = createRequire(import.meta.url)('electron');
const themes = [...new Set(readFileSync(path.join(root, 'src/application/themes.css'), 'utf8')
    .match(/data-theme="[a-z-]+"/g).map(x => x.slice(12, -1)))];

// Runs in the page: fill the picker as screen-share.js does, then measure it in each theme.
async function measurePage(themeList) {
    const d = document.getElementById('screen-picker');
    if (!d.open) d.showModal();
    document.getElementById('screen-picker-status').hidden = true;
    const fill = (id, names) => document.getElementById(id).replaceChildren(...names.map(n => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'screen-source';
        const c = document.createElement('canvas');
        c.width = 160;
        c.height = 90;
        const s = document.createElement('span');
        s.className = 'screen-source-name';
        s.textContent = n;
        b.append(c, s);
        li.append(b);
        return li;
    }));
    fill('screen-list-screens', ['Screen 1', 'Screen 2']);
    fill('screen-list-windows', ['A window with a long name that does not fit in the tile', 'Window 2', 'Window 3', 'Window 4']);
    const box = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    const out = {};
    for (const theme of ['', ...themeList]) {
        if (theme) document.documentElement.dataset.theme = theme;
        else delete document.documentElement.dataset.theme;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        out[theme || 'none'] = {
            tiles: [...d.querySelectorAll('.screen-source')].map(t => ({ tile: box(t), canvas: box(t.querySelector('canvas')), name: box(t.querySelector('.screen-source-name')) })),
            headings: [...d.querySelectorAll('h3')].map(box),
        };
    }
    return out;
}

// The Electron main script. It is text in a temporary folder because node --test runs each script below test/.
const mainScript = `
const { app, BrowserWindow } = require('electron');
const [page, themes] = process.argv.slice(-2);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
    const w = new BrowserWindow({ show: false, width: 1000, height: 800 });
    try {
        await w.loadFile(page);
        const code = '(' + ${JSON.stringify(measurePage.toString())} + ')(' + themes + ')';
        process.stdout.write('RESULT ' + JSON.stringify(await w.webContents.executeJavaScript(code)) + '\\n');
    } catch (e) { process.stdout.write('ERROR ' + String(e) + '\\n'); }
    app.exit(0);
});
`;

function measure() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'picker-layout-'));
    const main = path.join(dir, 'main.cjs');
    writeFileSync(main, mainScript);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    return new Promise((resolve, reject) => {
        execFile(electron, [main, `--user-data-dir=${path.join(dir, 'profile')}`, path.join(root, 'src/application/index.html'), JSON.stringify(themes)],
            { timeout: 60000, env }, (err, stdout) => {
                rmSync(dir, { recursive: true, force: true });
                const line = stdout.split('\n').find(l => l.startsWith('RESULT '));
                if (!line) return reject(new Error(`no result: ${err ?? ''} ${stdout}`));
                resolve(JSON.parse(line.slice(7)));
            });
    });
}
const inside = (a, b) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5;
const overlap = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;

test('each picker tile contains its thumbnail and name and overlaps no other tile or heading, in each theme', async () => {
    const result = await measure();
    assert.equal(Object.keys(result).length, themes.length + 1);
    for (const [theme, { tiles, headings }] of Object.entries(result)) {
        assert.equal(tiles.length, 6, theme);
        tiles.forEach((t, i) => {
            assert.ok(inside(t.canvas, t.tile), `${theme} tile ${i}: canvas ${JSON.stringify(t.canvas)} outside tile ${JSON.stringify(t.tile)}`);
            assert.ok(inside(t.name, t.tile), `${theme} tile ${i}: name ${JSON.stringify(t.name)} outside tile ${JSON.stringify(t.tile)}`);
            assert.ok(t.name.y >= t.canvas.y + t.canvas.h - 0.5, `${theme} tile ${i}: the name is not under the canvas`);
            tiles.forEach((u, j) => { if (j > i) assert.ok(!overlap(t.tile, u.tile), `${theme}: tile ${i} overlaps tile ${j}`); });
            headings.forEach((h, k) => assert.ok(!overlap(t.tile, h), `${theme}: tile ${i} overlaps heading ${k}`));
        });
    }
});
