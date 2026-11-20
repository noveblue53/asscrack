// WP3 check: saved rooms and local history. Run under xvfb-run + dbus-run-session + gnome-keyring (DECISIONS.md S2).
'use strict';
const { _electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT = '/home/user/asscrack';
const EXE = path.join(PROJECT, 'node_modules/electron/dist/electron');
const T = 30000;
const PORT1 = 41000 + Math.floor(Math.random() * 2000);
const PORT2 = PORT1 + 2500;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wp3-'));
const PH = path.join(base, 'PH');
const PM = path.join(base, 'PM');
const checks = {};
const archiveLines = [];
const errorLines = [];
const open = new Set();

function check(name, ok, detail) {
  checks[name] = detail === undefined ? (ok ? 'pass' : 'fail') : { result: ok ? 'pass' : 'fail', detail };
}
async function step(name, fn) {
  try { const r = await fn(); check(name, r !== false); }
  catch (e) { check(name, false, String(e?.message ?? e).split('\n')[0]); }
}
function collect(tag, line) {
  if (/Saved rooms archive/.test(line)) archiveLines.push(`${tag}: ${line}`);
  if (/error/i.test(line) && /error|Error/.test(line)) errorLines.push(`${tag}: ${line}`);
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
async function loginForm(page, { name, type, room, invite, save, address }) {
  await page.fill('#username', name, { timeout: T });
  await page.selectOption('#room-type', type, { timeout: T });
  if (room !== undefined) await page.fill('#room', room, { timeout: T });
  if (invite !== undefined) await page.fill('#invite-input', invite, { timeout: T });
  // The host types a public address: this VM has no UPnP gateway, and the UPnP wait is 60 s.
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
  await page.waitForFunction(t => document.getElementById('messages')?.textContent.includes(t), text, { timeout });
}
async function hasLine(page, text) {
  return page.evaluate(t => document.getElementById('messages')?.textContent.includes(t), text);
}
function noLeftover() {
  const out = execSync('ps -eo pid=,args=').toString().split('\n')
    .filter(l => l.includes(base) && l.includes('electron')).join('; ').trim();
  return out === '' ? true : out;
}
async function reopen(page, index) {
  await page.waitForSelector('#saved-rooms .saved-room', { timeout: T });
  const t0 = Date.now();
  await page.locator('#saved-rooms .saved-room .reopen-room').nth(index).click({ timeout: T });
  return t0;
}

(async () => {
  let H, M, invite1, invite2;
  // Steps 1 to 3
  try {
    H = await start('H1', PH);
    await step('1 H creates keyed room team with save and history', async () => {
      await loginForm(H.page, { name: 'hana', type: 'new', room: 'team', save: true, address: `127.0.0.1:${PORT1}` });
      invite1 = await readInvite(H.page);
    });
    M = await start('M1', PM);
    await step('2 M joins with invite, save and history', async () => {
      if (!invite1) throw new Error('no invite from step 1');
      await loginForm(M.page, { name: 'mika', type: 'join', invite: invite1, save: true });
    });
    await step('3 session and both lines on both copies', async () => {
      await waitPeer(M.page); await waitPeer(H.page);
      await send(M.page, 'line-one from mika');
      await waitLine(H.page, 'line-one from mika');
      await send(H.page, 'line-two from hana');
      await waitLine(M.page, 'line-two from hana');
      await waitLine(M.page, 'line-one from mika');
      await waitLine(H.page, 'line-two from hana');
    });
  } catch (e) { check('1-3 start', false, String(e.message).split('\n')[0]); }
  await close(M); await close(H); M = H = null;
  await new Promise(r => setTimeout(r, 1000));
  { const r = noLeftover(); check('4 no Electron process stays', r === true, r === true ? undefined : r); }

  // Step 5
  try {
    M = await start('M2', PM);
    await step('5a one saved room', async () => {
      await M.page.waitForSelector('#saved-rooms .saved-room', { timeout: T });
      const n = await M.page.locator('#saved-rooms .saved-room').count();
      if (n !== 1) throw new Error(`count ${n}`);
    });
    await step('5b reopen shows both lines and waiting-peer within 3 s', async () => {
      await reopen(M.page, 0);
      await waitLine(M.page, 'line-one from mika', 3000);
      await waitLine(M.page, 'line-two from hana', 3000);
      await M.page.waitForSelector('#waiting-peer', { state: 'visible', timeout: 3000 });
    });
  } catch (e) { check('5 start', false, String(e.message).split('\n')[0]); }
  await close(M); M = null;

  // Step 6
  try {
    M = await start('M3', PM);
    await step('6a M creates second room team with save and history', async () => {
      await loginForm(M.page, { name: 'mika', type: 'new', room: 'team', save: true, address: `127.0.0.1:${PORT2}` });
      invite2 = await readInvite(M.page);
      if (invite2 === invite1) throw new Error('same invite as room 1');
    });
    H = await start('H2', PH);
    await step('6b H joins without save, line three arrives', async () => {
      if (!invite2) throw new Error('no invite from step 6a');
      await loginForm(H.page, { name: 'hana', type: 'join', invite: invite2, save: false });
      await waitPeer(M.page); await waitPeer(H.page);
      await send(M.page, 'line-three from mika');
      await waitLine(H.page, 'line-three from mika');
    });
  } catch (e) { check('6 start', false, String(e.message).split('\n')[0]); }
  await close(M); await close(H); M = H = null;

  // Step 7
  const one = 'line-one from mika', two = 'line-two from hana', three = 'line-three from mika';
  try {
    M = await start('M4', PM);
    await step('7a two saved rooms', async () => {
      await M.page.waitForSelector('#saved-rooms .saved-room', { timeout: T });
      const n = await M.page.locator('#saved-rooms .saved-room').count();
      if (n !== 2) throw new Error(`count ${n}`);
    });
    const results = [];
    for (let i = 0; i < 2; i++) {
      if (i > 0) { await close(M); M = await start(`M${5 + i}`, PM); }
      try {
        await reopen(M.page, i);
        await waitLine(M.page, 'line-', 5000).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));
        results.push({ one: await hasLine(M.page, one), two: await hasLine(M.page, two), three: await hasLine(M.page, three) });
      } catch (e) { results.push({ error: String(e.message).split('\n')[0] }); }
    }
    const isA = r => r && r.one && r.two && !r.three;
    const isB = r => r && !r.one && !r.two && r.three;
    const ok = (isA(results[0]) && isB(results[1])) || (isB(results[0]) && isA(results[1]));
    check('7b each room shows only its own history', ok, results);
  } catch (e) { check('7 start', false, String(e.message).split('\n')[0]); }
  await close(M); M = null;
  for (const a of open) { try { await a.close(); } catch {} }
  await new Promise(r => setTimeout(r, 1000));
  { const r = noLeftover(); check('8 no Electron process stays at end', r === true, r === true ? undefined : r); }

  // main.js writes the archive state line only to its log file (--log-dir): read the log file of each copy.
  const logRoot = path.join(base, 'logs');
  for (const tag of fs.existsSync(logRoot) ? fs.readdirSync(logRoot).sort() : []) {
    for (const f of fs.readdirSync(path.join(logRoot, tag))) {
      for (const l of fs.readFileSync(path.join(logRoot, tag, f), 'utf8').split('\n')) {
        if (/Saved rooms archive/.test(l)) archiveLines.push(`${tag} log: ${l}`);
        else if (/error|Error/.test(l) && !errorLines.some(e => e.endsWith(l.replace(/^\S+ \S+ /, '')))) errorLines.push(`${tag} log: ${l}`);
      }
    }
  }
  console.log(JSON.stringify({ network: '127.0.0.1 (cloud VM, not LAN)', profiles: base, checks, archiveLines, errorLines }, null, 2));
  process.exit(0);
})();
