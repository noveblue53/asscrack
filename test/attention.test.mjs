import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ATTENTION_DEFAULTS, attentionSettings, createAttention, migrateAttention, noticeText, registerNotificationShortcut, WINDOWS_APP_ID, WINDOWS_TOAST_ID } from '../src/application/attention.mjs';

function setup() {
    const state = { prefs: { mentionAlert: true, whisperAlert: true, friendAlert: true, sound: false, previews: false }, quiet: false, allowed: true, room: {} };
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
        // Message alerts: the title tells who and where (no names in this fixture).
        ['Someone in #general', '2 new mentions', true], ['Someone (whisper)', 'New message', true]
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
    assert.deepEqual(notices.map(n => [n.body, n.silent]), [['public preview', false], ['New message', false]]);
});

test('read, disabled, idle/DND and room/access changes suppress pending and stale native attention', () => {
    const { state, attention, advance, notices, opens } = setup();
    attention.add(mention('a')); attention.read(mention('a')); advance();
    state.prefs.mentionAlert = false; attention.add(mention('b')); advance();
    state.prefs.mentionAlert = true; attention.add(mention('c')); state.quiet = true; advance();
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
    // Settings version 2 (message alerts): the grid of Sound and Notification boxes. All on, except the notification
    // of voice join and leave; previews on; only in the background. The Windows sound stays off.
    assert.deepEqual(prefs.get(), { voiceCues: true, volume: 35, chatSound: true, mentionSound: true, whisperSound: true,
        friendSound: true, voiceSound: true, chatAlert: true, mentionAlert: true, whisperAlert: true, friendAlert: true,
        voiceAlert: false, previews: true, sound: false, flash: true, background: true });
    prefs.set({ chatAlert: false, previews: 'no', voiceCues: false, voiceSound: 'no', mentionSound: 0, volume: 120, background: false });
    const reopened = attentionSettings(file).get();
    assert.equal(reopened.chatAlert, false); assert.equal(reopened.previews, true);
    assert.equal(reopened.voiceCues, false); assert.equal(reopened.volume, 100);
    assert.equal(reopened.voiceSound, true); assert.equal(reopened.mentionSound, true);
    assert.equal(reopened.background, false);
    prefs.set({ flash: 'off' });
    assert.equal(attentionSettings(file).get().flash, true);
    prefs.set({ flash: false, voiceAlert: true });
    assert.equal(attentionSettings(file).get().flash, false);
    assert.equal(attentionSettings(file).get().voiceAlert, true);
});

test('a 1.0.x file gets the new defaults one time, keeps its real choices, and later choices stay', t => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-migrate-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'attention.json');
    // A 1.0.x file: alerts and previews false were the defaults, not choices. The other keys were choices.
    writeFileSync(file, JSON.stringify({ voiceCues: false, otherVoiceCues: false, messageCues: false, volume: 20,
        alerts: false, previews: false, sound: true, flash: false }));
    const first = attentionSettings(file).get();
    assert.deepEqual(first, { ...ATTENTION_DEFAULTS, voiceCues: false, voiceSound: false, mentionSound: false,
        whisperSound: false, friendSound: false, volume: 20, sound: true, flash: false });
    assert.equal(first.chatAlert && first.mentionAlert && first.whisperAlert && first.friendAlert && first.previews &&
        first.chatSound, true);
    // The migration is in the file at once (version 2), so the next start does not migrate again.
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2);
    attentionSettings(file).set({ mentionAlert: false, previews: false, chatSound: false });
    const later = attentionSettings(file).get();
    assert.equal(later.mentionAlert, false); assert.equal(later.previews, false); assert.equal(later.chatSound, false);
    // A file with no keys of 1.0.x choices, a damaged file and no file give the defaults.
    assert.deepEqual(migrateAttention({}), ATTENTION_DEFAULTS);
    assert.deepEqual(migrateAttention(null), ATTENTION_DEFAULTS);
    writeFileSync(file, '{bad');
    assert.deepEqual(attentionSettings(file).get(), ATTENTION_DEFAULTS);
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

// ---- Message alerts (2026-11-22): who and where, every message, voice, one notification for each conversation ----

test('the title tells who and where; the body is the text with previews on, else a short text', () => {
    assert.deepEqual(noticeText({ kind: 'message', name: 'Sam', channel: 'games', preview: 'gg' }), { title: 'Sam in #games', body: 'gg' });
    assert.deepEqual(noticeText({ kind: 'message', name: 'Sam', channel: 'general' }), { title: 'Sam in #general', body: 'New message' });
    assert.deepEqual(noticeText({ kind: 'message', name: 'Sam', channel: 'general', count: 3, mentions: 1 }),
        { title: 'Sam in #general', body: '3 new messages' });
    assert.deepEqual(noticeText({ kind: 'mention', name: 'Sam', channel: 'general', mentions: 1 }), { title: 'Sam in #general', body: 'Mentioned you' });
    assert.deepEqual(noticeText({ kind: 'mention', name: 'Sam', channel: 'general', count: 2, mentions: 2 }),
        { title: 'Sam in #general', body: '2 new mentions' });
    assert.deepEqual(noticeText({ kind: 'mention', name: 'Sam', channel: 'general', mentions: 1, preview: 'hi Parker' }),
        { title: 'Sam in #general', body: 'hi Parker' });
    // A whisper and a friend line never show their text.
    assert.deepEqual(noticeText({ kind: 'whisper', name: 'Alex', preview: 'secret' }), { title: 'Alex (whisper)', body: 'New message' });
    assert.deepEqual(noticeText({ kind: 'whisper', name: 'Alex', count: 2 }), { title: 'Alex (whisper)', body: '2 new messages' });
    assert.deepEqual(noticeText({ kind: 'friend', name: 'Ben' }), { title: 'Ben', body: 'New message' });
    assert.deepEqual(noticeText({ kind: 'friend', name: 'Ben', away: 3 }), { title: 'Ben', body: '3 messages while you were away' });
    assert.deepEqual(noticeText({ kind: 'friend', name: '', away: 1 }), { title: 'A friend', body: 'Sent while you were away' });
    assert.deepEqual(noticeText({ kind: 'voice', name: 'Sam', joined: true }), { title: 'Sam', body: 'Joined voice' });
    assert.deepEqual(noticeText({ kind: 'voice', name: 'Sam', joined: false }), { title: 'Sam', body: 'Left voice' });
    // Control characters and a long name do not reach the title.
    assert.equal(noticeText({ kind: 'message', name: 'S\u0007am' + 'x'.repeat(100), channel: 'a\nb' }).title,
        'S am' + 'x'.repeat(60) + ' in #a b');
});

test('a plain line and a mention of one channel replace one notification; each row of the grid gates its kind', () => {
    const notices = [], timers = new Set();
    const prefs = { chatAlert: true, mentionAlert: true, whisperAlert: true, friendAlert: true, voiceAlert: false, previews: true, sound: false };
    const attention = createAttention({
        settings: () => prefs, room: () => 'room', quiet: () => false, allowed: () => true, navigate: () => {},
        notify: options => Object.assign(new EventEmitter(), { ...options, close() { this.closed = true; this.emit('close'); }, show() { notices.push(this); } }),
        peerName: id => ({ p1: 'Alex' })[id] ?? '', channelName: id => ({ c1: 'games' })[id] ?? '',
        schedule(fn) { timers.add(fn); return fn; }, cancel(fn) { timers.delete(fn); }
    });
    const advance = () => { for (const fn of [...timers]) { timers.delete(fn); fn(); } };
    attention.add({ kind: 'message', channelId: 'c1', id: 'a', name: 'Sam', preview: 'first' });
    advance();
    assert.deepEqual(notices.map(n => [n.title, n.body]), [['Sam in #games', 'first']]);
    attention.add({ kind: 'mention', channelId: 'c1', id: 'b', name: 'Sam', preview: 'hi Parker' });
    attention.add({ kind: 'message', channelId: 'c1', id: 'c', name: 'Kim', preview: 'last' });
    advance();
    assert.equal(notices.length, 2);
    assert.equal(notices[0].closed, true, 'the new notification replaces the old one of the same channel');
    assert.deepEqual([notices[1].title, notices[1].body], ['Kim in #games', 'last']);
    // The voice row is off by default; a whisper title has the name from the node.
    attention.add({ kind: 'voice', peerId: 'p1', id: 'v1', joined: true });
    attention.add({ kind: 'whisper', peerId: 'p1', id: 'w1', preview: 'secret' });
    advance();
    assert.deepEqual(notices.slice(2).map(n => [n.title, n.body]), [['Alex (whisper)', 'New message']]);
    prefs.voiceAlert = true;
    attention.add({ kind: 'voice', peerId: 'p1', id: 'v2', joined: true });
    advance();
    assert.deepEqual([notices.at(-1).title, notices.at(-1).body], ['Alex', 'Joined voice']);
    // The row of all messages off: no plain line. A mention follows that row only when its own row is off.
    prefs.chatAlert = false;
    attention.add({ kind: 'message', channelId: 'c1', id: 'd', name: 'Sam' });
    advance();
    assert.equal(notices.length, 4);
    prefs.mentionAlert = false;
    attention.add({ kind: 'mention', channelId: 'c1', id: 'e', name: 'Sam' });
    advance();
    assert.equal(notices.length, 4);
    prefs.chatAlert = true;
    attention.add({ kind: 'mention', channelId: 'c1', id: 'f', name: 'Sam' });
    advance();
    assert.equal(notices.length, 5);
});
