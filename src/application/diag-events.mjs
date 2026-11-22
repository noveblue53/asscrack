// The projection of the node events into the diagnostics journal (journal.mjs). Each projection names its fields one
// by one: a new field of an event does not go into the journal by accident. Addresses become a class (addrClass),
// error text goes through scrubText, and no name, text, file name or key of the event is read.
// This module does not import electron (node tests use it with real nodes).
import { addrClass, ipClass } from './journal.mjs';

// The node events that go into the journal.
export const JOURNAL_NODE_EVENTS = Object.freeze(['connection', 'dial-failed', 'dial-ok', 'upnp', 'full-node', 'host-changed',
    'peer-left', 'failover', 'session-refused', 'session-ids', 'admission', 'clock', 'file-offer', 'file-done', 'file-failed',
    'file-refused', 'file-cancelled', 'file-paused', 'file-resumed', 'file-restarted', 'file-discarded', 'file-expired',
    'file-retried', 'diag', 'knock-event', 'screen-diag']);

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
    if (/legacy room code|requires a protected device invite/.test(text)) return 'legacy';
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
        // Diagnostics (1.0.1, rank 2): a successful dial or reach attempt (node.mjs dialOk).
        case 'dial-ok':
            return ['dial', { peer: d.peer, via: reasonCode(d.via), result: 'ok', ...addrClass(d.addr), ms: d.ms }];
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
                count: d.count }];
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

// The room window can send these journal types (preload diagEvent). Each goes through the allowlist. The errors of the
// window come from its console (diagnostics.mjs attachWindow), the marks from their own IPC.
export const RENDERER_TYPES = Object.freeze(new Set(['voice-device', 'voice-summary']));
