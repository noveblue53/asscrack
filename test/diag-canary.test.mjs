// The "never" test of the diagnostics (REVIEW.md change 1): two real protected-room nodes on 127.0.0.1 with distinct
// canary strings in the room name, the names, a chat line, a whisper, the topic, a file name and its content. The
// journal of each node gets the node events through the projection of main.js (diag-events.mjs). Then each byte of
// each journal file and of each bundle (raw zip and inflated entries) is scanned for each canary, in UTF-8 and
// UTF-16LE, and for the raw address 127.0.0.1. 127.0.0.1 results, not LAN results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createJournal, deviceClass, tagKey } from '../src/application/journal.mjs';
import { journalNodeEvents } from '../src/application/diag-events.mjs';
import { logText } from '../src/application/diagnostics.mjs';
import { buildBundle } from '../src/application/diag-bundle.mjs';
import { protectedPair, waitFor } from './helpers/protected-pair.mjs';
import { readZip } from './helpers/zip-reader.mjs';

const C = {
    room: 'CanaryRoomQx7', owner: 'CanaryOwnerQx7', member: 'CanaryMemberQx7', chat: 'CanaryChatQx7 hello',
    whisper: 'CanaryWhisperQx7', topic: 'CanaryTopicQx7', file: 'CanaryFileQx7.txt', content: 'CanaryContentQx7',
    clipboard: 'CanaryClipQx7', headset: "CanaryHeadsetQx7's AirPods", pttKey: 'KeyCanaryQx7'
};

function scan(bytes, needles, where) {
    for (const [label, needle] of needles) {
        for (const enc of ['utf8', 'utf16le']) {
            assert.equal(bytes.indexOf(Buffer.from(needle, enc)), -1, `${label} (${enc}) found in ${where}`);
        }
    }
}

test('127.0.0.1: no chat text, name, file name, key, invite or raw address in the journal or the bundle', { timeout: 60000 }, async t => {
    const journals = new Map();
    const whispers = [];
    const attach = node => {
        const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-canary-'));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        const journal = createJournal({ dir, budgets: { default: [1e6, 0] } });
        t.after(() => journal.close());
        journalNodeEvents((type, fn) => node.events.on(type, fn), (type, fields) => journal.write(type, fields), node.peerId);
        journals.set(node, { dir, journal });
    };
    const pair = await protectedPair(t, { room: C.room, ownerName: C.owner, memberName: C.member, onNode: attach,
        nodeOptions: () => ({ receiveWhisper: m => { whispers.push(m); return true; } }) });
    const { owner, member, roomKey, invite } = pair;
    const got = [];
    member.events.on('message', m => got.push(m));
    // Chat line, topic, whisper.
    owner.send(C.chat);
    await waitFor(() => got.some(m => m.text === C.chat), 'chat line');
    await waitFor(() => owner.host()?.peerId && member.host()?.peerId === owner.host()?.peerId, 'host elected');
    await waitFor(() => { try { owner.setTopic(C.topic); return true; } catch { return false; } }, 'topic set');
    await waitFor(() => member.topic()?.text === C.topic, 'topic');
    await owner.sendWhisper(member.peerId, C.whisper, '11111111-1111-4111-8111-111111111111');
    await waitFor(() => whispers.length > 0, 'whisper');
    // A file with a canary name and content.
    const file = path.join(owner.dir, C.file);
    writeFileSync(file, C.content);
    const offers = [], done = [];
    member.events.on('file-offer', o => offers.push(o));
    member.events.on('file-done', d => done.push(d));
    await owner.offerFile(file, member.peerId);
    await waitFor(() => offers.length === 1, 'file offer');
    member.acceptFile(offers[0].offerId);
    await waitFor(() => done.length === 1, 'file done');
    // Main-process lines with user values: the voice settings line and a device label.
    const ownerJ = journals.get(owner).journal;
    ownerJ.write('log', { level: 'EVENT', text: logText(`voice settings mode ptt ptt-key ${C.pttKey} input selected`) });
    ownerJ.write('voice-device', { dir: 'in', ok: true, ...deviceClass(C.headset, tagKey(journals.get(owner).dir)) });
    ownerJ.write('log', { level: 'WARN', text: C.clipboard.length > 0 ? 'Saved line not written: SQLITE_BUSY' : '' });
    // A diagnostics request with Send: the bundle of the owner goes to the member.
    const prompts = [], received = [];
    owner.events.on('diag', d => { if (d.event === 'prompt') prompts.push(d); });
    member.events.on('diag', d => { if (d.event === 'received') received.push(d); });
    const ask = member.askDiagnostics(owner.peerId);
    assert.equal(ask.ok, true);
    await waitFor(() => prompts.length === 1, 'prompt');
    await ownerJ.flush();
    ownerJ.flushSync();
    const own = await buildBundle({ diagDir: journals.get(owner).dir, system: { version: 'test' } });
    const bundleFile = path.join(owner.dir, 'out.zip');
    writeFileSync(bundleFile, own.zip);
    assert.equal((await owner.answerDiagnostics(prompts[0].id, bundleFile)).ok, true);
    await waitFor(() => received.length === 1, 'bundle received');
    await delay(200);

    const needles = [...Object.entries(C).filter(([k]) => k !== 'headset'), ['headset', 'CanaryHeadsetQx7'],
        ['room key', roomKey], ['invite', invite], ['invite body', invite.split(':')[1].slice(0, 40)], ['address', '127.0.0.1']];
    let scanned = 0;
    for (const { dir, journal } of journals.values()) {
        await journal.flush();
        journal.flushSync();
        const lines = readdirSync(dir).filter(n => n.endsWith('.jsonl')).flatMap(n => readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean));
        // The journal has the events (the test is not empty).
        const types = new Set(lines.map(l => JSON.parse(l).type));
        for (const type of ['session', 'file', 'session-ids']) assert.ok(types.has(type), `journal has ${type}`);
        for (const name of readdirSync(dir)) {
            if (!statSync(path.join(dir, name)).isFile()) continue;
            scan(readFileSync(path.join(dir, name)), needles, name);
            scanned++;
        }
        const bundle = await buildBundle({ diagDir: dir, system: { version: 'test' }, reach: { state: 'lan' } });
        scan(bundle.zip, needles, 'bundle zip');
        const entries = readZip(bundle.zip);
        assert.ok(entries.has('manifest.json') && entries.has('summary.txt'));
        for (const [name, data] of entries) scan(data, needles, `bundle entry ${name}`);
        scanned += entries.size;
    }
    // The bundle that went over the network.
    const wire = readFileSync(received[0].path);
    scan(wire, needles, 'received bundle');
    for (const [name, data] of readZip(wire)) scan(data, needles, `received entry ${name}`);
    assert.ok(scanned > 10, `scanned ${scanned} files`);
});
