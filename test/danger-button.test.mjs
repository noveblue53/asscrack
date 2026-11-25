// 1.0.1: the Leave room button and its confirmation have the danger style (themes.css, button.btn-danger). The test
// reads the palette of each theme from themes.css, resolves the colors of the rule (var() and color-mix() in srgb)
// and calculates the WCAG contrast of the text on each stop of the gradient, also with the hover filter of
// styles.css (brightness 1.07). WCAG AA for normal text: 4.5:1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/application/themes.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/application/index.html', import.meta.url), 'utf8');
const THEMES = ['aero-classic', 'aero-night', 'aero-black', 'aero-midnight', 'pearl', 'amber-terminal',
    'winamp-slate', 'crt-phosphor', 'classic-mirc'];

function palette(theme) {
    const start = theme === 'aero-classic' ? css.indexOf(':root, [data-theme="aero-classic"]') : css.indexOf(`[data-theme="${theme}"] {`);
    assert.ok(start >= 0, `palette of ${theme}`);
    const block = css.slice(start, css.indexOf('}', start));
    const vars = {};
    for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6}|#[0-9a-f]{3})\b/gi)) vars[m[1]] = m[2];
    return vars;
}

const hex = text => text.length === 4 ? [1, 2, 3].map(i => parseInt(text[i] + text[i], 16))
    : [1, 3, 5].map(i => parseInt(text.slice(i, i + 2), 16));
// Split at the commas of the top level (not in brackets).
function split(text) {
    const parts = [];
    let depth = 0, from = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
        else if (text[i] === ',' && depth === 0) { parts.push(text.slice(from, i).trim()); from = i + 1; }
    }
    parts.push(text.slice(from).trim());
    return parts;
}
function color(text, vars) {
    text = text.trim();
    if (/^#(?:[0-9a-f]{3}){1,2}$/i.test(text)) return hex(text);
    let m = /^var\((--[\w-]+)\)$/.exec(text);
    if (m) { assert.ok(vars[m[1]], `variable ${m[1]}`); return hex(vars[m[1]]); }
    m = /^color-mix\(in srgb,(.*)\)$/s.exec(text);
    assert.ok(m, `color form: ${text}`);
    const [a, b] = split(m[1]);
    const pa = /^(.*)\s+(\d+(?:\.\d+)?)%$/.exec(a);
    assert.ok(pa, `color-mix with a percentage: ${text}`);
    const p = Number(pa[2]) / 100;
    const ca = color(pa[1], vars), cb = color(b, vars);
    return ca.map((v, i) => v * p + cb[i] * (1 - p));
}
function luminance(rgb) {
    const [r, g, b] = rgb.map(v => {
        const c = Math.min(255, v) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
}

function dangerRule() {
    const at = css.indexOf(':root[data-theme] button.btn-danger {');
    assert.ok(at >= 0, 'themes.css has the rule :root[data-theme] button.btn-danger');
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    const decl = {};
    for (const part of body.split(/;\s*/)) {
        const i = part.indexOf(':');
        if (i > 0) decl[part.slice(0, i).trim()] = part.slice(i + 1).replace(/\s+/g, ' ').trim();
    }
    return decl;
}

test('Leave room and its confirmation button have the danger class', () => {
    assert.match(html, /<button id="leave-room" class="btn-danger"/);
    assert.match(html, /<button id="leave-confirm" class="btn-danger"/);
});

test('the danger button text has 4.5:1 or more on each gradient stop in each theme, also at hover', () => {
    const decl = dangerRule();
    const g = /^linear-gradient\((.*)\)$/.exec(decl.background);
    assert.ok(g, 'the background is a linear gradient');
    const stops = split(g[1]).slice(1).map(stop => stop.replace(/\s+\d+(?:\.\d+)?%$/, ''));
    assert.ok(stops.length >= 2);
    const rows = [];
    for (const theme of THEMES) {
        const vars = palette(theme);
        const ink = color(decl.color, vars);
        const fill = stops.map(stop => color(stop, vars));
        // The fill is red in each theme: the red channel is the largest at each stop.
        for (const c of fill) assert.ok(c[0] > c[1] && c[0] > c[2], `${theme}: the fill is red (${c.map(Math.round)})`);
        const plain = Math.min(...fill.map(c => contrast(ink, c)));
        const hover = Math.min(...fill.map(c => contrast(ink.map(v => v * 1.07), c.map(v => v * 1.07))));
        rows.push(`${theme} ${plain.toFixed(2)} ${hover.toFixed(2)}`);
        assert.ok(plain >= 4.5, `${theme}: ${plain.toFixed(2)}:1`);
        assert.ok(hover >= 4.5, `${theme} hover: ${hover.toFixed(2)}:1`);
    }
    console.log('danger button contrast (theme, plain, hover): ' + rows.join('; '));
});
