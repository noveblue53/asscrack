import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attentionSettings, createAttention, registerNotificationShortcut, WINDOWS_APP_ID, WINDOWS_TOAST_ID } from '../src/application/attention.mjs';

function setup() {
    const state = { prefs: { alerts: true, sound: false, previews: false }, quiet: false, allowed: true, room: {} };
    const notices = [], opens = [], timers = new Set();
    const attention = createAttention({
        settings: () => state.prefs, room: () => state.room, quiet: () => state.quiet, allowed: () => state.allowed,
        notify: options => {
            const n = Object.assign(new EventEmitter(), { ...options, close() { this.closed = true; this.emit('close'); }, show() { notices.push(this); } });
            return n;
        }, navigate: target => opens.push(target),
        schedule(fn) { timers.add(fn); return fn; }, cancel(fn) { timers.delete(fn); }
    });
    function advance() { for (const fn of [...timers]) { timers.delete(fn); fn(); } }
    return { state, attention, advance, notices, opens };
}
const mention = (id, channelId = 'general') => ({ kind: 'mention', channelId, id, preview: 'public preview' });
const whisper = id => ({ kind: 'whisper', peerId: 'peer', id, preview: 'never reveal this text' });

test('native alerts coalesce each conversation, deduplicate live IDs, and open the displayed message', () => {
    const { attention, advance, notices, opens } = setup();
    attention.add(mention('a')); attention.add(mention('a')); attention.add(mention('b')); attention.add(whisper('p'));
    advance();
    assert.deepEqual(notices.map(n => [n.title, n.body, n.silent]), [
        ['ASSCRACK', '2 new mentions', true], ['ASSCRACK', 'New private message', true]
    ]);
    attention.add(mention('c'));
    notices[0].emit('click');
    assert.deepEqual(opens, [{ kind: 'mention', channelId: 'general', id: 'b' }]);
    notices[1].emit('click');
    assert.deepEqual(opens[1], { kind: 'whisper', peerId: 'peer', id: 'p' });
    advance();
    attention.add(mention('b')); advance();
    assert.equal(notices.length, 2);
});

test('native preview and sound are opt-in; private targets and content never appear in a banner', () => {
    const { state, attention, advance, notices } = setup();
    state.prefs.previews = true;
    state.prefs.sound = true;
    attention.add(mention('a')); attention.add(whisper('b')); advance();
    assert.deepEqual(notices.map(n => [n.body, n.silent]), [['public preview', false], ['New private message', false]]);
});

test('read, disabled, idle/DND and room/access changes suppress pending and stale native attention', () => {
    const { state, attention, advance, notices, opens } = setup();
    attention.add(mention('a')); attention.read(mention('a')); advance();
    state.prefs.alerts = false; attention.add(mention('b')); advance();
    state.prefs.alerts = true; attention.add(mention('c')); state.quiet = true; advance();
    attention.add(mention('d')); state.quiet = false; advance();
    attention.add(mention('e')); state.room = {}; advance();
    assert.equal(notices.length, 0);
    attention.add(whisper('p')); advance(); state.allowed = false;
    notices[0].emit('click'); assert.equal(opens.length, 0);
    attention.clear(); assert.equal(notices[0].closed, true);
    state.allowed = true; notices[0].emit('click'); assert.equal(opens.length, 0);
});

test('sound and privacy settings are per profile, validated, and retain mute and volume on restart', t => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-alert-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'prefs.json');
    const prefs = attentionSettings(file);
    assert.deepEqual(prefs.get(), { alerts: false, previews: false, sound: false, voiceCues: true, otherVoiceCues: true,
        messageCues: true, volume: 35 });
    prefs.set({ alerts: true, previews: 'yes', voiceCues: false, otherVoiceCues: 'no', messageCues: 0, volume: 120 });
    const reopened = attentionSettings(file).get();
    assert.equal(reopened.alerts, true); assert.equal(reopened.previews, false);
    assert.equal(reopened.voiceCues, false); assert.equal(reopened.volume, 100);
    // P11 keys: the same validation as the old keys (only a boolean changes them).
    assert.equal(reopened.otherVoiceCues, true); assert.equal(reopened.messageCues, true);
    prefs.set({ otherVoiceCues: false, messageCues: false });
    assert.equal(attentionSettings(file).get().otherVoiceCues, false);
    assert.equal(attentionSettings(file).get().messageCues, false);
});

test('portable notification identity uses the stable executable and preserves unrelated Start Menu shortcuts', t => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-shortcut-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = [];
    let details = {};
    const shell = { readShortcutLink: () => details, writeShortcutLink(file, op, value) {
        calls.push([op, value]); details = value; writeFileSync(file, 'shortcut fixture'); return true;
    } };
    const opts = { appData: dir, executable: 'C:\\Games\\ASSCRACK.exe', shell };
    registerNotificationShortcut(opts); registerNotificationShortcut(opts);
    assert.deepEqual(calls, [['create', { target: opts.executable, args: '', appUserModelId: WINDOWS_APP_ID, toastActivatorClsid: WINDOWS_TOAST_ID }]]);
    registerNotificationShortcut({ ...opts, executable: 'D:\\ASSCRACK.exe' });
    assert.equal(calls[1][0], 'update');
    details = { appUserModelId: 'other-app' };
    assert.throws(() => registerNotificationShortcut(opts), /another app/);
    assert.equal(calls.length, 2);
});
