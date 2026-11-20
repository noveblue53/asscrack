// Part 2 check: live chat and the archive agree. Run under xvfb-run + dbus-run-session + gnome-keyring.
'use strict';
const { _electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT = '/home/user/asscrack';
const EXE = path.join(PROJECT, 'node_modules/electron/dist/electron');
const T = 30000;
const PORT1 = 41000 + Math.floor(Math.random() * 4000);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-'));
const PH = path.join(base, 'PH');
const PM = path.join(base, 'PM');
const checks = {};
const errorLines = [];
const open = new Set();
const N = 125;
const pad = i => String(i).padStart(3, '0');
const mText = i => `m${pad(i)} from mika`;
const hText = i => `h${pad(i)} from hana`;
const ALL = [];
for (let i = 1; i <= N; i++) { ALL.push(mText(i)); ALL.push(hText(i)); }
const CLEAR_TEXT = 'Delete the saved messages of this room from this computer? The room and its saving choice stay. Peers that are online can still show recent messages.';

function check(name, ok, detail) {
  checks[name] = { result: ok ? 'pass' : 'fail', detail: detail === undefined ? '' : detail };
}
async function step(name, fn) {
  try {
    const r = await fn();
    if (r && typeof r === 'object' && 'ok' in r) check(name, !!r.ok, r.detail);
    else check(name, r !== false, r === undefined || r === true || r === false ? undefined : r);
  } catch (e) { check(name, false, String(e?.message ?? e).split('\n')[0]); }
}
function collect(tag, line) {
  if (/error|Error/.test(line)) errorLines.push(`${tag}: ${line}`);
}
async function start(tag, profile) {
  const app = await _electron.launch({
    executablePath: EXE,
    args: [PROJECT, '--profile', profile, '--log-dir', path.join(base, 'logs', tag), '--password-store=gnome-libsecret', '--no-sandbox'],
    timeout: T,
  });
  open.add(app);
  const proc = app.process();
  for (const s of [proc.stdout, proc.stderr]) {
    let buf = '';
    s.on('data', d => {
      buf += d.toString();
      const parts = buf.split('\n'); buf = parts.pop();
      for (const l of parts) if (l.trim()) collect(`${tag} term`, l);
    });
  }
  const page = await app.firstWindow({ timeout: T });
  page.on('console', m => collect(`${tag} console`, m.text()));
  page.on('pageerror', e => collect(`${tag} console`, `pageerror Error: ${e.message}`));
  await page.waitForSelector('#login-screen', { timeout: T });
  return { app, page, tag };
}
async function close(c) {
  if (!c) return;
  try { await c.app.close(); } catch { try { c.app.process().kill('SIGKILL'); } catch {} }
  open.delete(c.app);
}
async function startSafe(tag, profile, label) {
  try { return await start(tag, profile); }
  catch (e) { check(`${label} start ${tag}`, false, String(e.message).split('\n')[0]); return null; }
}
async function loginForm(page, { name, type, room, invite, save, address }) {
  await page.fill('#username', name, { timeout: T });
  await page.selectOption('#room-type', type, { timeout: T });
  if (room !== undefined) await page.fill('#room', room, { timeout: T });
  if (invite !== undefined) await page.fill('#invite-input', invite, { timeout: T });
  if (address !== undefined) await page.fill('#public-address', address, { timeout: T });
  if (save) {
    await page.check('#save-room', { timeout: T });
    await page.check('#keep-history', { timeout: T });
  }
  await page.click('#login', { timeout: T });
  await page.waitForSelector('#login-screen', { state: 'hidden', timeout: T });
}
async function readInvite(page) {
  await page.waitForFunction(() => document.getElementById('invite-code')?.value.trim().length > 0, null, { timeout: T });
  return (await page.inputValue('#invite-code')).trim();
}
async function waitPeer(page) {
  await page.waitForFunction(() => document.querySelectorAll('#peers li:not(.self)').length > 0, null, { timeout: T });
}
async function send(page, text) {
  await page.fill('#message-input', text, { timeout: T });
  await page.click('#send', { timeout: T });
}
async function waitLine(page, text, timeout = T) {
  await page.waitForFunction(t => [...document.querySelectorAll('#messages li')].some(li => li.textContent.includes(t)), text, { timeout });
}
// Count of li per text. Returns { missing, dup, count }.
async function countTexts(page, texts) {
  return page.evaluate(ts => {
    const lis = [...document.querySelectorAll('#messages li')].map(li => li.textContent);
    const missing = [], dup = [];
    for (const t of ts) {
      const n = lis.filter(x => x.includes(t)).length;
      if (n === 0) missing.push(t); else if (n > 1) dup.push(`${t} x${n}`);
    }
    return { missing, dup, count: lis.length };
  }, texts);
}
async function liCount(page) { return page.locator('#messages li').count(); }
async function reopen(page, index = 0) {
  await page.waitForSelector('#saved-rooms .saved-room', { timeout: T });
  await page.locator('#saved-rooms .saved-room .reopen-room').nth(index).click({ timeout: T });
  await page.waitForSelector('#login-screen', { state: 'hidden', timeout: T });
}
function noLeftover() {
  const out = execSync('ps -eo pid=,args=').toString().split('\n')
    .filter(l => l.includes(base) && l.includes('electron')).join('; ').trim();
  return out === '' ? true : out;
}
// First li that is visible in #messages: text and top offset to the list top.
async function firstVisible(page) {
  return page.evaluate(() => {
    const box = document.getElementById('messages');
    const top = box.getBoundingClientRect().top;
    for (const li of box.querySelectorAll('li')) {
      const r = li.getBoundingClientRect();
      if (r.bottom > top + 1) return { text: li.textContent.trim().slice(0, 80), offset: Math.round(r.top - top), y: r.top };
    }
    return null;
  });
}
async function scrollTop(page) {
  await page.evaluate(() => {
    const box = document.getElementById('messages');
    box.scrollTop = 0;
    box.dispatchEvent(new Event('scroll'));
  });
}
async function older(page) { return page.evaluate(() => document.getElementById('messages')?.dataset.older ?? null); }

(async () => {
  let H, M, invite;
  // Steps 1 to 3
  H = await startSafe('H1', PH, '1');
  M = await startSafe('M1', PM, '1');
  await step('1 H makes room, M joins, session', async () => {
    await loginForm(H.page, { name: 'hana', type: 'new', room: 'team', save: true, address: `127.0.0.1:${PORT1}` });
    invite = await readInvite(H.page);
    await loginForm(M.page, { name: 'mika', type: 'join', invite, save: true });
    await waitPeer(M.page); await waitPeer(H.page);
  });
  await step('2 250 lines, each one time on each copy', async () => {
    const loop = async (page, f) => { for (let i = 1; i <= N; i++) await send(page, f(i)); };
    await Promise.all([loop(M.page, mText), loop(H.page, hText)]);
    await waitLine(M.page, hText(N)); await waitLine(H.page, mText(N));
    await waitLine(M.page, mText(N)); await waitLine(H.page, hText(N));
    await new Promise(r => setTimeout(r, 1000));
    const m = await countTexts(M.page, ALL), h = await countTexts(H.page, ALL);
    const bad = m.missing.length + m.dup.length + h.missing.length + h.dup.length;
    return { ok: bad === 0, detail: { M: { li: m.count, missing: m.missing.slice(0, 5), missingN: m.missing.length, dup: m.dup.slice(0, 5) }, H: { li: h.count, missing: h.missing.slice(0, 5), missingN: h.missing.length, dup: h.dup.slice(0, 5) } } };
  });
  await step('3 M each line gets class saved', async () => {
    let timedOut = false;
    await M.page.waitForFunction(ts => {
      const lis = [...document.querySelectorAll('#messages li')];
      return ts.every(t => lis.some(li => li.textContent.includes(t) && li.classList.contains('saved')));
    }, ALL, { timeout: T }).catch(() => { timedOut = true; });
    const n = await M.page.locator('#messages li.saved').count();
    return { ok: !timedOut, detail: { liSaved: n, timedOut } };
  });
  await close(M); await close(H); M = H = null;

  // Step 4
  M = await startSafe('M2', PM, '4');
  await step('4a reopen shows 200 lines, data-older=more', async () => {
    await reopen(M.page);
    await M.page.waitForFunction(() => document.querySelectorAll('#messages li').length >= 200, null, { timeout: T }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
    const n = await liCount(M.page), o = await older(M.page);
    return { ok: n === 200 && o === 'more', detail: { li: n, older: o } };
  });
  await step('4b scroll to top loads 50, first visible line stays', async () => {
    const before = await firstVisible(M.page);
    const n0 = await liCount(M.page);
    await scrollTop(M.page);
    const vb = await firstVisible(M.page); // after the scroll, before the load
    await M.page.waitForFunction(n => document.querySelectorAll('#messages li').length > n, n0, { timeout: T });
    await new Promise(r => setTimeout(r, 500));
    const after = await M.page.evaluate(t => {
      const box = document.getElementById('messages');
      const top = box.getBoundingClientRect().top;
      const li = [...box.querySelectorAll('li')].find(x => x.textContent.trim().slice(0, 80) === t);
      return li ? Math.round(li.getBoundingClientRect().top - top) : null;
    }, vb?.text);
    const fa = await firstVisible(M.page);
    const n1 = await liCount(M.page);
    const diff = after === null ? null : Math.abs(after - vb.offset);
    return { ok: n1 - n0 === 50 && diff !== null && diff <= 30, detail: { beforeScroll: before?.text, firstVisibleBeforeLoad: vb?.text, offsetBefore: vb?.offset, offsetAfter: after, firstVisibleAfterLoad: fa?.text, added: n1 - n0 } };
  });
  await step('4c all pages: 250 lines each one time, data-older=none', async () => {
    for (let i = 0; i < 5 && (await older(M.page)) !== 'none'; i++) {
      await scrollTop(M.page);
      await M.page.waitForFunction(() => document.getElementById('messages').dataset.older === 'none', null, { timeout: 5000 }).catch(() => {});
    }
    const c = await countTexts(M.page, ALL), o = await older(M.page);
    return { ok: c.count === 250 && c.missing.length === 0 && c.dup.length === 0 && o === 'none', detail: { li: c.count, missingN: c.missing.length, dup: c.dup.slice(0, 5), older: o } };
  });
  // Step 5
  await step('5 alone-1 is local-only, not saved', async () => {
    await send(M.page, 'alone-1');
    await waitLine(M.page, 'alone-1');
    await new Promise(r => setTimeout(r, 1500));
    const r = await M.page.evaluate(() => {
      const li = [...document.querySelectorAll('#messages li')].reverse().find(x => x.textContent.includes('alone-1'));
      const mark = li?.querySelector('.local-only-mark');
      return { local: li?.classList.contains('local-only'), saved: li?.classList.contains('saved'), mark: mark?.textContent.trim() ?? null, markVisible: !!mark && mark.offsetParent !== null };
    });
    return { ok: r.local && !r.saved && r.mark === 'Only on this computer' && r.markVisible, detail: r };
  });
  // Step 6
  await step('6a uncheck keep history, state text', async () => {
    await M.page.uncheck('#room-keep-history', { timeout: T });
    await M.page.waitForFunction(() => document.getElementById('history-state')?.textContent.trim() === 'Saving is off. Saved messages stay.', null, { timeout: T });
  });
  await close(M); M = null;
  M = await startSafe('M3', PM, '6');
  await step('6b after reopen keep history is off', async () => {
    await reopen(M.page);
    await M.page.waitForSelector('#room-keep-history', { timeout: T });
    const c = await M.page.isChecked('#room-keep-history');
    return { ok: !c, detail: { checked: c } };
  });
  H = await startSafe('H2', PH, '6');
  await step('6c H reopens, session, off-1 then on-1', async () => {
    await reopen(H.page);
    await waitPeer(M.page); await waitPeer(H.page);
    await send(H.page, 'off-1');
    await waitLine(M.page, 'off-1');
    await new Promise(r => setTimeout(r, 1000));
    await M.page.check('#room-keep-history', { timeout: T });
    await new Promise(r => setTimeout(r, 1000));
    await send(H.page, 'on-1');
    await waitLine(M.page, 'on-1');
    await new Promise(r => setTimeout(r, 1500));
  });
  await close(M); await close(H); M = H = null;
  M = await startSafe('M4', PM, '6');
  await step('6d reopen: on-1 shows, off-1 does not', async () => {
    await reopen(M.page);
    await waitLine(M.page, 'on-1', 10000).catch(() => {});
    const c = await countTexts(M.page, ['on-1', 'off-1']);
    const on = !c.missing.includes('on-1'), off = !c.missing.includes('off-1');
    return { ok: on && !off, detail: { on1: on, off1: off } };
  });
  // Step 7
  await step('7a clear confirm visible with text, Cancel keeps lines', async () => {
    const n0 = await liCount(M.page);
    await M.page.click('#clear-history', { timeout: T });
    await M.page.waitForSelector('#clear-confirm', { state: 'visible', timeout: T });
    const txt = (await M.page.textContent('#clear-confirm')) ?? '';
    await M.page.click('#clear-confirm-no', { timeout: T });
    await new Promise(r => setTimeout(r, 1000));
    const n1 = await liCount(M.page);
    return { ok: txt.replace(/\s+/g, ' ').includes(CLEAR_TEXT) && n1 === n0 && n0 > 0, detail: { textOk: txt.replace(/\s+/g, ' ').includes(CLEAR_TEXT), li: [n0, n1] } };
  });
  await step('7b clear yes', async () => {
    await M.page.click('#clear-history', { timeout: T });
    await M.page.click('#clear-confirm-yes', { timeout: T });
    await new Promise(r => setTimeout(r, 1500));
  });
  await close(M); M = null;
  M = await startSafe('M5', PM, '7');
  await step('7c reopen after clear: 0 lines, keep history on', async () => {
    await reopen(M.page);
    await M.page.waitForSelector('#room-keep-history', { timeout: T });
    await new Promise(r => setTimeout(r, 2000));
    const n = await liCount(M.page), c = await M.page.isChecked('#room-keep-history');
    return { ok: n === 0 && c, detail: { li: n, keepHistory: c } };
  });
  await close(M); M = null;
  // Step 8
  M = await startSafe('M6', PM, '8');
  await step('8a forget then cancel keeps room', async () => {
    await M.page.waitForSelector('#saved-rooms .saved-room', { timeout: T });
    await M.page.locator('#saved-rooms .saved-room .forget-room').first().click({ timeout: T });
    await M.page.waitForSelector('#saved-rooms .forget-confirm', { state: 'visible', timeout: T });
    await M.page.locator('#saved-rooms .forget-no').first().click({ timeout: T });
    await new Promise(r => setTimeout(r, 1000));
    const n = await M.page.locator('#saved-rooms .saved-room').count();
    return { ok: n === 1, detail: { rooms: n } };
  });
  await step('8b forget yes removes room', async () => {
    await M.page.locator('#saved-rooms .saved-room .forget-room').first().click({ timeout: T });
    await M.page.locator('#saved-rooms .forget-yes').first().click({ timeout: T });
    await M.page.waitForFunction(() => document.querySelectorAll('#saved-rooms .saved-room').length === 0, null, { timeout: T });
  });
  await close(M); M = null;
  H = await startSafe('H3', PH, '8');
  await step('8c H still has room, reopen shows lines', async () => {
    await reopen(H.page);
    await waitLine(H.page, 'from', 10000);
    return { ok: true, detail: { li: await liCount(H.page) } };
  });
  await close(H); H = null;

  for (const a of open) { try { await a.close(); } catch { try { a.process().kill('SIGKILL'); } catch {} } }
  await new Promise(r => setTimeout(r, 1000));
  { const r = noLeftover(); check('9 no Electron process stays at end', r === true, r === true ? undefined : r); }

  const logRoot = path.join(base, 'logs');
  for (const tag of fs.existsSync(logRoot) ? fs.readdirSync(logRoot).sort() : []) {
    for (const f of fs.readdirSync(path.join(logRoot, tag))) {
      for (const l of fs.readFileSync(path.join(logRoot, tag, f), 'utf8').split('\n')) {
        if (/error|Error/.test(l)) errorLines.push(`${tag} log: ${l}`);
      }
    }
  }
  console.log(JSON.stringify({ network: '127.0.0.1 (cloud VM, not LAN)', profiles: base, checks, errorLines }, null, 2));
  process.exit(0);
})();
