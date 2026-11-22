// L2 (P10a, P10b): file names, ready texts, chat links and friend names from peers must not keep bidi controls or
// zero width characters. The window shows the real extension of a received file and warns for a program file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { safeFileName } from '../src/network/file-transfer.mjs';
import { readyText } from '../src/network/ready-check.mjs';
import { createFriendRequests } from '../src/network/friend-requests.mjs';
import { loadRoomWindow } from './helpers/renderer-fixture.mjs';

const RLO = String.fromCodePoint(0x202e);
const LRI = String.fromCodePoint(0x2066);
const PDI = String.fromCodePoint(0x2069);
const ZWSP = String.fromCodePoint(0x200b);
const ZWJ = String.fromCodePoint(0x200d);
const FAMILY = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467].map(c => String.fromCodePoint(c)).join('');
const HIDDEN = [0x061c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]
    .map(c => String.fromCodePoint(c));

test('safeFileName removes the bidi controls and the zero width characters', () => {
    assert.equal(safeFileName('report' + RLO + 'fdp.exe'), 'reportfdp.exe');
    assert.equal(safeFileName('a' + ZWSP + 'b' + LRI + 'c' + PDI + '.txt'), 'abc.txt');
    for (const c of HIDDEN) assert.equal(safeFileName('x' + c + 'y.pdf'), 'xy.pdf', c.codePointAt(0).toString(16));
    assert.equal(safeFileName('Grüße.txt'), 'Grüße.txt');
});

test('the ready text has no bidi control, and an emoji with ZWJ stays', () => {
    assert.equal(readyText('Ready' + RLO + '?'), 'Ready?');
    assert.equal(readyText(ZWSP + 'go' + LRI), 'go');
    assert.equal(readyText('Raid ' + FAMILY), 'Raid ' + FAMILY);
    assert.ok(readyText('Raid ' + FAMILY).includes(ZWJ));
});

test('a chat link ends at a bidi control or a zero width character', async () => {
    const source = await readFile(new URL('../src/application/chat-links.js', import.meta.url), 'utf8');
    const window = {};
    vm.runInNewContext(source, { window, URL }, { filename: 'chat-links.js' });
    const hrefs = text => Array.from(window.chatLinksCore.linkRanges(text), r => r.href);
    assert.deepEqual(hrefs('see https://good.example/' + RLO + 'moc.live'), ['https://good.example/']);
    assert.deepEqual(hrefs('https://a.example/x' + ZWSP + 'y'), ['https://a.example/x']);
    assert.deepEqual(hrefs('https://a.example/x' + String.fromCodePoint(0xfeff)), ['https://a.example/x']);
});

test('a friend request name has no bidi control, and a name of only controls is refused', async () => {
    const seen = [];
    const requests = createFriendRequests({ send: () => true, changed: e => seen.push(e),
        now: () => 1, setTimer: () => 1, clearTimer: () => {} });
    const id = '0b6d3c4e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
    requests.handle({ peerId: 'peerA', deviceId: 'devA', message: { type: 'friend', v: 1, op: 'request', id, name: 'Ann' + RLO + 'nimda' } });
    requests.handle({ peerId: 'peerB', deviceId: 'devB',
        message: { type: 'friend', v: 1, op: 'request', id: '1b6d3c4e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', name: RLO + LRI } });
    const incoming = seen.filter(e => e.kind === 'incoming');
    assert.equal(incoming.length, 1);
    assert.equal(incoming[0].name, 'Annnimda');
});

test('the window shows the real extension of a received file and warns for a program file', async () => {
    const room = await loadRoomWindow();
    room.handlers.onFileOffer({ offerId: 'one', peerId: 'peer-00000001', from: 'Sam', name: 'invoice.pdf.exe', size: 5 });
    room.handlers.onFileOffer({ offerId: 'two', peerId: 'peer-00000001', from: 'Sam', name: 'note.txt', size: 5 });
    const [risky, plain] = room.el('transfers').children;
    assert.equal(risky.querySelector('.file-name').dataset.ext, '.exe');
    assert.ok(risky.classList.contains('program-file'));
    assert.match(risky.querySelector('.file-warning').textContent, /Program file \(\.exe\)/);
    assert.equal(plain.querySelector('.file-name').dataset.ext, '.txt');
    assert.equal(plain.querySelector('.file-warning'), null);
    assert.equal(plain.classList.contains('program-file'), false);
    const cards = room.rows().filter(row => row.classList.contains('file-card'));
    assert.equal(cards.length, 2);
    assert.match(cards[0].querySelector('.file-warning').textContent, /trust the sender/);
});
