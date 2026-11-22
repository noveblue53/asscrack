// Diagnostics requests (diag-requests.mjs): the limits of the asked side with a fake clock, the classification of
// the bundle offer, and two real protected-room nodes on 127.0.0.1: nothing goes out without Send, Not now sends
// nothing and starts the cool-down, Send gives the asker a verified zip. 127.0.0.1 results, not LAN results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { BUNDLE_NAME, COOLDOWN_MS, createDiagConsent, createDiagRequests, GLOBAL_LIMIT } from '../src/network/diag-requests.mjs';
import { protectedPair, waitFor } from './helpers/protected-pair.mjs';
import { readZip } from './helpers/zip-reader.mjs';
import { makeZip } from '../src/application/diag-bundle.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('the asked side: one pending request for each asker, a cool-down after Not now, a limit for all askers', () => {
    let t = 0;
    const c = createDiagConsent({ now: () => t, askTtl: 1000, cooldown: COOLDOWN_MS, globalLimit: GLOBAL_LIMIT, globalWindow: 3600_000 });
    assert.equal(c.receive('p1', 'not an id'), 'bad');
    assert.equal(c.receive('p1', id(1)), 'prompt');
    assert.equal(c.receive('p1', id(2)), 'pending', 'one pending request for each asker');
    assert.equal(c.decline(id(1)), 'p1');
    assert.equal(c.receive('p1', id(3)), 'cooldown', 'Not now starts the cool-down');
    assert.equal(c.receive('p2', id(4)), 'prompt');
    assert.equal(c.receive('p3', id(5)), 'prompt');
    assert.equal(c.receive('p4', id(6)), 'global', 'three prompts this hour from all askers');
    t += 3600_000;
    assert.equal(c.receive('p1', id(7)), 'prompt', 'after the hour the cool-down and the global limit are over');
    // A request expires: the answer comes too late and does nothing.
    t += 1000;
    assert.equal(c.take(id(7)), null);
    assert.deepEqual(c.pending(), []);
});

test('the asker accepts only the offer of its own grant: same peer, size, hash and name, below the cap', () => {
    const events = new EventEmitter();
    const sent = [];
    const session = { send: line => { sent.push(JSON.parse(line)); return true; } };
    const sessions = new Map([['peerA', session], ['peerB', session]]);
    const accepted = [];
    const files = { acceptFile: offerId => { accepted.push(offerId); return true; }, refuseFile() {}, forgetOffer() {} };
    const r = createDiagRequests({ sessions, files, events, allowed: () => true, capable: () => true, maxBytes: 1000 });
    t_after(() => r.stop());
    const ask = r.ask('peerA');
    assert.equal(ask.ok, true);
    assert.deepEqual(r.ask('peerA'), { ok: false, reason: 'pending' });
    const sha = 'a'.repeat(64);
    // No grant yet: an offer is not a diagnostics offer.
    assert.equal(r.classifyOffer('peerA', { offerId: id(9), name: BUNDLE_NAME, size: 10, sha256: sha }), null);
    r.handle('peerB', session, { type: 'diag', v: 1, op: 'grant', id: ask.id, offerId: id(9), size: 10, sha256: sha });
    assert.equal(r.classifyOffer('peerA', { offerId: id(9), name: BUNDLE_NAME, size: 10, sha256: sha }), null, 'a grant of another peer does nothing');
    r.handle('peerA', session, { type: 'diag', v: 1, op: 'grant', id: ask.id, offerId: id(9), size: 5000, sha256: sha });
    assert.equal(r.classifyOffer('peerA', { offerId: id(9), name: BUNDLE_NAME, size: 5000, sha256: sha }), null, 'over the cap');
    r.handle('peerA', session, { type: 'diag', v: 1, op: 'grant', id: ask.id, offerId: id(9), size: 10, sha256: sha });
    assert.equal(r.classifyOffer('peerB', { offerId: id(9), name: BUNDLE_NAME, size: 10, sha256: sha }), 'reject');
    assert.equal(r.classifyOffer('peerA', { offerId: id(9), name: 'other.exe', size: 10, sha256: sha }), 'reject');
    assert.equal(r.classifyOffer('peerA', { offerId: id(9), name: BUNDLE_NAME, size: 11, sha256: sha }), 'reject');
    assert.equal(r.classifyOffer('peerA', { offerId: id(9), name: BUNDLE_NAME, size: 10, sha256: sha }), 'requested');
    r.startOffer('peerA', id(9));
    assert.deepEqual(accepted, [id(9)]);
    assert.equal(r.isDiagOffer(id(9)), true);
});

// node:test has no t in a sync helper above; keep a list of cleanups.
const cleanups = [];
function t_after(fn) { cleanups.push(fn); }
test.after(() => { for (const fn of cleanups) fn(); });

test('127.0.0.1: Not now sends nothing and starts the cool-down; Send gives the asker a verified zip', { timeout: 40000 }, async t => {
    const { owner, member } = await protectedPair(t);
    const ownerDiag = [], memberDiag = [], ownerOffers = [], memberOffers = [];
    owner.events.on('diag', d => ownerDiag.push(d));
    member.events.on('diag', d => memberDiag.push(d));
    owner.events.on('file-offer', d => ownerOffers.push(d));
    member.events.on('file-offer', d => memberOffers.push(d));

    // The owner asks; the member sees a prompt. Nothing else happens without an answer.
    const first = owner.askDiagnostics(member.peerId);
    assert.equal(first.ok, true);
    await waitFor(() => memberDiag.some(d => d.event === 'prompt'), 'prompt on the member');
    await delay(500);
    assert.deepEqual(ownerOffers, [], 'no offer goes out without Send');
    assert.ok(!ownerDiag.some(d => d.event === 'granted'));

    // Not now: the owner gets "declined", no offer, and a new ask is refused (cool-down).
    assert.deepEqual(await member.answerDiagnostics(memberDiag.find(d => d.event === 'prompt').id, null), { ok: true });
    await waitFor(() => ownerDiag.some(d => d.event === 'declined' && d.by === 'peer'), 'declined on the owner');
    const second = owner.askDiagnostics(member.peerId);
    assert.equal(second.ok, true);
    await waitFor(() => ownerDiag.some(d => d.event === 'refused' && d.id === second.id), 'busy (cool-down) on the owner');
    assert.equal(memberDiag.filter(d => d.event === 'prompt').length, 1, 'no second prompt during the cool-down');
    assert.deepEqual(ownerOffers, []);
    assert.equal(await member.answerDiagnostics(second.id, null).then(r => r.ok), false, 'an answer to a refused request does nothing');

    // The other direction: the member asks, the owner selects Send with a bundle.
    const ask = member.askDiagnostics(owner.peerId);
    assert.equal(ask.ok, true);
    await waitFor(() => ownerDiag.some(d => d.event === 'prompt' && d.id === ask.id), 'prompt on the owner');
    const bundle = path.join(owner.dir, 'bundle.zip');
    writeFileSync(bundle, await makeZip([{ name: 'summary.txt', data: 'Run x\n' }]));
    const sent = await owner.answerDiagnostics(ask.id, bundle);
    assert.equal(sent.ok, true);
    await waitFor(() => memberDiag.some(d => d.event === 'received'), 'the member receives the bundle');
    const received = memberDiag.find(d => d.event === 'received');
    assert.ok(existsSync(received.path));
    assert.equal(path.basename(received.path), BUNDLE_NAME);
    assert.equal(readZip(readFileSync(received.path)).get('summary.txt').toString(), 'Run x\n');
    assert.equal(member.isDiagOffer(sent.offerId), true, 'main.js keeps the bundle transfer out of Transfers');
    assert.equal(member.isDiagOffer('00000000-0000-4000-8000-000000000000'), false);
    assert.deepEqual(memberOffers.length, 1, 'the offer event of the bundle');
    assert.equal(memberOffers[0].offerId, sent.offerId);

    // An ordinary file offer is not accepted automatically.
    const other = path.join(owner.dir, 'note.txt');
    writeFileSync(other, 'x');
    await owner.offerFile(other, member.peerId);
    await waitFor(() => memberOffers.length === 2, 'ordinary offer');
    await delay(300);
    assert.equal(memberDiag.filter(d => d.event === 'received').length, 1);
});
