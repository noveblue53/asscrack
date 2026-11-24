// The projection of the node events into the diagnostics journal (journal.mjs). Each projection names its fields one
// by one: a new field of an event does not go into the journal by accident. Addresses become a class (addrClass),
// error text goes through scrubText, and no name, text, file name or key of the event is read.
// This module does not import electron (node tests use it with real nodes).
import { createHmac } from 'node:crypto';
import { addrClass, ipClass } from './journal.mjs';

// The node events that go into the journal.
export const JOURNAL_NODE_EVENTS = Object.freeze(['connection', 'dial-failed', 'dial-result', 'upnp', 'full-node', 'host-changed',
    'peer-left', 'failover', 'session-refused', 'session-ids', 'admission', 'clock', 'file-offer', 'file-done', 'file-failed',
    'file-refused', 'file-cancelled', 'file-paused', 'file-resumed', 'file-restarted', 'file-discarded', 'file-expired',
    'file-retried', 'diag', 'knock-event', 'screen-diag', 'screen-state', 'screen-ended', 'screen-watch']);

// A text of this program (a reason) as a code: lower case, or undefined.
export function reasonCode(value) {
    if (typeof value !== 'string' || !value) return undefined;
    const code = value.toLowerCase().trim().slice(0, 64);
    return /^[a-z0-9][a-z0-9 ._-]*$/.test(code) ? code : 'other';
}

// The cause of a refused session (node.mjs attachChat reject) as a code.
const REFUSE_CAUSES = [
    [/^hello with no nonce/, 'no-nonce'], [/could not be sent/, 'send-failed'], [/^unexpected room proof/, 'unexpected-proof'],
    [/^wrong proof/, 'wrong-proof'], [/^unexpected device proof/, 'unexpected-device-proof'],
    [/^device authorization unavailable/, 'not-member'], [/^first admission requires the owner/, 'needs-owner'],
    [/^invalid room admission/, 'invalid-admission'], [/^chat session already exists/, 'duplicate'],
    [/^device no longer admitted/, 'revoked'], [/^no valid proof in/, 'timeout'], [/could not be saved/, 'save-failed']
];
export function refuseCause(cause) {
    const text = String(cause ?? '');
    return REFUSE_CAUSES.find(([re]) => re.test(text))?.[1] ?? 'other';
}

// The class of a login or reopen error (the same tests as login-errors.mjs loginErrorText), as a code.
export function loginErrorCode(err, depth = 0) {
    const inUse = e => !!e && typeof e === 'object' && depth < 5 && (e.code === 'EADDRINUSE' ||
        (e.name === 'UnsupportedListenAddressesError' && /EADDRINUSE/.test(String(e.message))) ||
        inUse(e.cause) || (Array.isArray(e.errors) && e.errors.some(inUse)));
    if (inUse(err)) return 'address-in-use';
    const text = String(err?.message ?? err ?? '');
    if (/wrong prefix|not text/.test(text)) return 'not-invite';
    if (/damaged|not valid JSON|characters that are not valid|has a bad|no valid node list|too large/.test(text)) return 'invite-incomplete';
    if (/unknown version/.test(text)) return 'invite-version';
    if (/for another device/.test(text)) return 'other-device';
    if (/The public address must be/.test(text)) return 'public-address';
    if (/has expired/.test(text)) return 'invite-expired';
    if (/Enter a username|Enter a room name|Enter an invite|Choose how/.test(text)) return 'form';
    if (/legacy room code|requires a protected device invite|I trust everyone with this code|needs a device invite/.test(text)) return 'legacy';
    if (/Already logged in/.test(text)) return 'already';
    if (/Saved room not found/.test(text)) return 'saved-room-missing';
    return 'other';
}

const FILE_EVENTS = { 'file-offer': 'offer', 'file-done': 'done', 'file-failed': 'failed', 'file-refused': 'refused',
    'file-cancelled': 'cancelled', 'file-paused': 'paused', 'file-resumed': 'resumed', 'file-restarted': 'restarted',
    'file-discarded': 'discarded', 'file-expired': 'expired', 'file-retried': 'retried' };

// One node event gives [journalType, fields], or null (not journaled). selfId: the peer ID of this node.
export function projectNodeEvent(type, data, selfId = null) {
    const d = data ?? {};
    switch (type) {
        case 'connection': {
            if (d.state === 'session') {
                return ['session', { state: 'open', peer: d.peer, route: d.type, dir: d.dir, relay: d.relay,
                    ...addrClass(d.addr), sid: d.sid, peerSid: d.peerSid }];
            }
            if (d.state === 'closed') return ['session', { state: 'closed', peer: d.peer, route: d.type, secs: d.secs, sid: d.sid }];
            return null;
        }
        case 'dial-failed':
            return ['dial', { peer: d.peer, via: reasonCode(d.via), result: 'failed', reason: reasonCode(d.reason),
                ...addrClass(d.addr), error: d.error, count: d.count, ms: d.ms }];
        // Diagnostics (1.0.1, rank 2): a successful dial or reach attempt, or a negative dial-back (node.mjs dialResult).
        case 'dial-result':
            return ['dial', { peer: d.peer, via: reasonCode(d.via), result: d.result === 'failed' ? 'failed' : 'ok',
                reason: reasonCode(d.reason), ...addrClass(d.addr), ms: d.ms }];
        case 'upnp':
            return ['upnp', { state: reasonCode(d.state), reason: reasonCode(d.reason), port: d.port,
                external: typeof d.ip === 'string' ? ipClass(d.ip) ?? 'unknown' : undefined, renew: d.renew }];
        case 'full-node':
            return ['full-node', { peer: d.peerId, on: d.fullNode === true, self: selfId !== null && d.peerId === selfId }];
        case 'host-changed':
            return ['host', { host: d.peerId ?? undefined, none: d.peerId == null, term: d.term, reason: reasonCode(d.reason),
                self: selfId !== null && d.peerId === selfId }];
        case 'peer-left':
            return ['peer-left', { peer: d.peerId, left: d.left === true ? 'bye' : 'lost' }];
        case 'failover':
            return ['failover', { lost: d.lost, host: d.host, term: d.term, reason: reasonCode(d.reason), end: d.end,
                inVoice: d.inVoice, self: d.self, hostMs: d.hostMs, voiceMs: d.voiceMs, chatMs: d.chatMs }];
        case 'session-refused':
            return ['session-refused', { peer: d.peerId, cause: refuseCause(d.cause) }];
        case 'session-ids':
            return ['session-ids', { peer: d.peerId, sid: d.sid, peerSid: d.peerSid, clock: d.clock, diag: d.diag }];
        case 'admission':
            return ['admission', { event: d.event, peer: d.peerId, cause: reasonCode(d.cause) }];
        case 'clock':
            return ['clock', { peer: d.peerId, rttMs: d.rttMs, offsetMs: d.offsetMs }];
        case 'diag':
            return ['diag', { event: d.event, peer: d.peerId, id: d.id, reason: reasonCode(d.reason), size: d.size }];
        // Rank 9 (screen-share.mjs diagTick): the tier changes of the rate control and the viewer stats.
        case 'screen-diag':
            return ['screen', { event: d.kind, share: d.shareId, agoMs: d.agoMs, tierId: d.tierId, role: reasonCode(d.role),
                from: reasonCode(d.from), to: reasonCode(d.to), why: reasonCode(d.why), bitrate: d.bitrate, peer: d.peerId,
                rate: d.rate, target: d.target, excessMs: d.excessMs, drops: d.drops, kframes: d.kframes,
                congestions: d.congestions, queueBytes: d.queueBytes, slow: d.slow, circuit: d.circuit, cap: reasonCode(d.cap),
                count: d.count, usePct: d.usePct, skipPct: d.skipPct, fps: d.fps, width: d.width, height: d.height }];
        // Multi-share (1.0.6, screen-share.mjs): the start and the stop of each share (own: start and stop, another
        // member: live and gone), and each watch. The share ID and the peer ID, no name.
        case 'screen-state':
            if (d.own) return d.sharing === true ? ['screen', { event: 'start', share: d.shareId, preset: reasonCode(d.preset) }] : null;
            return ['screen', { event: d.sharing === true ? 'live' : 'gone', share: d.shareId, peer: d.peerId,
                preset: d.sharing === true ? reasonCode(d.preset) : undefined }];
        case 'screen-ended':
            // The end of a watch comes from 'screen-watch' (also a stop or a switch of the user).
            return d.own ? ['screen', { event: 'stop', share: d.shareId, reason: reasonCode(d.reason), peer: d.by }] : null;
        case 'screen-watch':
            return ['screen', { event: d.event === 'start' ? 'watch' : 'watch-end', share: d.shareId, peer: d.peerId,
                reason: d.event === 'start' ? undefined : reasonCode(d.reason) }];
        // Easy-join (1.0.1, node.mjs knockEvent): the knock steps. The name and the invite are not in the event.
        case 'knock-event':
            return ['knock', { event: d.event, side: d.side, peer: d.peerId, id: d.id, route: d.route, friend: d.friend,
                cause: reasonCode(d.cause) }];
        default: {
            const event = FILE_EVENTS[type];
            if (!event) return null;
            const direction = d.direction ?? (type === 'file-offer' ? 'receive' : type === 'file-refused' ? 'send' : undefined);
            const by = d.by ?? (type === 'file-refused' || type === 'file-offer' ? 'peer' : 'none');
            return ['file', { event, offer: d.offerId, dir: direction, by, size: Number.isFinite(d.size) ? d.size : undefined,
                reason: reasonCode(d.reason), peer: d.peerId, retryOf: d.retryOf }];
        }
    }
}

// Subscribes the journal to the events of a node. on(type, listener): the subscribe call (main.js gives its
// onLive, a test gives node.events.on). write(type, fields): the journal write.
export function journalNodeEvents(on, write, selfId = null) {
    for (const type of JOURNAL_NODE_EVENTS) {
        on(type, data => {
            const projected = projectNodeEvent(type, data, selfId);
            if (projected) write(projected[0], projected[1]);
        });
    }
}

// 1.0.6: the device tag of a friend: the first 8 hex characters of an HMAC of the device ID with the tag key of the data
// folder (journal.mjs tagKey). The tag is the same in each run of this data folder, and it does not give the device ID.
export function friendTag(deviceId, key) {
    if (typeof deviceId !== 'string' || !deviceId || typeof key !== 'string' || !key) return undefined;
    return createHmac('sha256', key).update(`friend\n${deviceId}`).digest('hex').slice(0, 8);
}

// The name or the code of an error object (node.mjs dialErrorCode), or undefined.
const errorCode = value => (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : undefined);

// 1.0.6: one 'journal' event of friend-links.mjs gives ['friend', fields], or null. Each event names its fields one by
// one. The device ID becomes a tag (friendTag), each address a class, a refuse cause a code. No name, no nickname, no
// friend room and no line text is read. key: the tag key (main.js diag.tagKey()).
export function projectFriendEvent(data, key = null) {
    const d = data ?? {};
    const base = { event: d.event, peer: d.peer, node: d.node, tag: friendTag(d.deviceId, key) };
    switch (d.event) {
        case 'start':
            return ['friend', { ...base, port: d.port, count: d.count }];
        case 'try':
            return ['friend', { ...base, via: reasonCode(d.via), result: d.result === 'ok' ? 'ok' : 'failed',
                reason: reasonCode(d.reason), error: errorCode(d.error), ...addrClass(d.addr), ms: d.ms }];
        case 'session':
            return ['friend', { ...base, state: d.state, route: d.route, dir: d.dir, ...(d.addr ? addrClass(d.addr) : {}),
                secs: d.secs, cause: d.state === 'refused' ? refuseCause(d.cause) : reasonCode(d.cause) }];
        case 'state':
            return ['friend', { ...base, from: d.from, to: d.to, cause: reasonCode(d.cause), ms: d.ms }];
        case 'addrs':
            return ['friend', { ...base, source: d.source, via: reasonCode(d.via), result: reasonCode(d.result), count: d.count }];
        case 'ask':
            return ['friend', { ...base, role: d.role, reason: reasonCode(d.reason), result: reasonCode(d.result),
                friends: d.friends, members: d.members, count: d.count }];
        case 'answer':
            return ['friend', { ...base, role: d.role, via: reasonCode(d.via), result: reasonCode(d.result), count: d.count }];
        case 'network':
            return ['friend', { event: 'network', cause: reasonCode(d.cause), count: d.count }];
        default:
            return null;
    }
}

// The room window can send these journal types (preload diagEvent). Each goes through the allowlist. The errors of the
// window come from its console (diagnostics.mjs attachWindow), the marks from their own IPC.
export const RENDERER_TYPES = Object.freeze(new Set(['voice-device', 'voice-summary']));
