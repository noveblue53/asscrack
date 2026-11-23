// 1.0.6: the address refresh of the friend links (friend-links.mjs). When the tries to a friend fail, this device asks
// its other friends and the proved members of its current protected room for the current addresses of that friend.
// This module has no transport and no archive: it gives the lines, reads them and counts the limits.
//
// Lines ('pm' lines; an older app ignores an unknown op with no line, no ack and no error):
//   { type: 'pm', v: 1, op: 'where', id, nonce, ask: [{ tag, port?, nodes? }] }        asker -> helper
//       One entry for each friend with no session. tag: whereTag(nonce, device ID of the friend). A helper that does
//       not know that device learns nothing from the tag. port and nodes: the own addresses of the friend node of the
//       asker for that friend (the 'addrs' line rules of L1), so that the friend can dial the asker too.
//   { type: 'pm', v: 1, op: 'where-for', id, device, port?, nodes? }                       helper -> friend
//       device: the proved device ID of the asker (the session of the helper proved it). port and nodes: as above.
//   { type: 'pm', v: 1, op: 'here', id, tag?, port, nodes }                                friend -> helper -> asker
//       The current candidate addresses of the friend node of the friend for the asker (friend-links ownCandidates).
//       The helper adds the IP of its own session to the friend with that port (design F5a), and the tag.
// Trust (DECISIONS: friend presence, 1.0.6):
//   - The asker asks only friends with a friend link session and proved member devices of its current protected room.
//   - A helper forwards only to a device that is its own friend (friend link session) or a proved member of its own
//     current protected room, and only for an asker on such a session. It never answers from its own records.
//   - The friend answers only for an asker that is its own friend (not removed, not blocked).
//   - The asker accepts an answer only from the helper that it asked, in REFRESH_LIMITS.answerMs. Each address must
//     pass the L1 rules (public or LAN; loopback only with the test flag). It saves an address only after a session
//     with the device of that friend opened on it.
import { createHash, randomBytes } from 'node:crypto';
import { validNodes, validPort } from '../network/friend-requests.mjs';
import { validDeviceId } from '../network/room-membership.mjs';

export const REFRESH_LIMITS = Object.freeze({
    // Asker: one 'where' line to each helper device in this time. A round starts after this delay (more reasons
    // become one round). A new round each repeatMs while a friend has no session.
    askGapMs: 60000, debounceMs: 1000, repeatMs: 120000,
    // A pending ask (asker) or forward (helper) ends after this time.
    answerMs: 15000,
    // At most this many friends in one 'where' line, own addresses in one entry, and dials for one answer.
    maxTags: 32, maxOwnAddrs: 4, maxTries: 8,
    // Helper: 'where' lines of one asker device each minute; one forward for each asker and friend in forwardGapMs;
    // forwards that wait at one time.
    whereRate: 3, forwardGapMs: 30000, maxForwards: 64,
    // Friend: 'where-for' lines of one helper device each minute; one redial to the asker in redialGapMs.
    forRate: 10, redialGapMs: 30000
});

const ID = /^[A-Za-z0-9_-]{22}$/;
const TAG = /^[A-Za-z0-9_-]{43}$/;
const OPS = new Set(['where', 'where-for', 'here']);

export const newRefreshId = () => randomBytes(16).toString('base64url');
export const isRefreshLine = message => message?.type === 'pm' && message.v === 1 && OPS.has(message.op);

// The tag of a device ID for one ask. SHA-256 of a fixed prefix, the nonce and the device ID (base64url, 43 chars).
export function whereTag(nonce, deviceId) {
    return createHash('sha256').update(`asscrack-where-1\n${nonce}\n${deviceId}`).digest('base64url');
}

// Own addresses of a line: { port, nodes } with one node of at most maxOwnAddrs addresses, or {} (no address).
function ownPart(port, nodes, maxAddrs = REFRESH_LIMITS.maxOwnAddrs) {
    const node = Array.isArray(nodes) ? nodes[0] : null;
    if (!validPort(port) || !node?.id || !Array.isArray(node.addrs) || !node.addrs.length) return {};
    return { port, nodes: [{ id: node.id, addrs: node.addrs.slice(0, maxAddrs) }] };
}
// The checked own addresses of a received line: { port, nodes } or { port: null, nodes: [] }. A bad part is dropped.
function readOwn(message, maxNodes, maxAddrs) {
    if (message.port === undefined && message.nodes === undefined) return { port: null, nodes: [] };
    const nodes = validNodes(message.nodes);
    if (!validPort(message.port) || nodes === null || nodes.length > maxNodes || nodes.some(n => n.addrs.length > maxAddrs)) {
        return { port: null, nodes: [] };
    }
    return { port: message.port, nodes };
}

// asks: [{ deviceId, port, nodes }] (port and nodes: the own addresses for that friend, or none).
export function whereLine(id, nonce, asks) {
    return { type: 'pm', v: 1, op: 'where', id, nonce,
        ask: asks.slice(0, REFRESH_LIMITS.maxTags).map(a => ({ tag: whereTag(nonce, a.deviceId), ...ownPart(a.port, a.nodes) })) };
}
export function readWhere(message) {
    if (message?.op !== 'where' || !ID.test(message.id) || !ID.test(message.nonce) || !Array.isArray(message.ask) ||
        message.ask.length < 1 || message.ask.length > REFRESH_LIMITS.maxTags) return null;
    const ask = [];
    for (const entry of message.ask) {
        if (entry === null || typeof entry !== 'object' || !TAG.test(entry.tag)) return null;
        ask.push({ tag: entry.tag, ...readOwn(entry, 1, REFRESH_LIMITS.maxOwnAddrs) });
    }
    return { id: message.id, nonce: message.nonce, ask };
}

export function whereForLine(id, device, port, nodes) {
    return { type: 'pm', v: 1, op: 'where-for', id, device, ...ownPart(port, nodes) };
}
export function readWhereFor(message) {
    if (message?.op !== 'where-for' || !ID.test(message.id) || !validDeviceId(message.device)) return null;
    return { id: message.id, device: message.device, ...readOwn(message, 1, REFRESH_LIMITS.maxOwnAddrs) };
}

export function hereLine(id, tag, port, nodes) {
    return { type: 'pm', v: 1, op: 'here', id, ...(tag ? { tag } : {}), port, nodes };
}
// The friend gives at most 16 addresses (ownCandidates); the helper adds the IP of its session.
export function readHere(message) {
    if (message?.op !== 'here' || !ID.test(message.id) || (message.tag !== undefined && !TAG.test(message.tag))) return null;
    const own = readOwn(message, 2, 16);
    if (own.port === null || !own.nodes.length) return null;
    return { id: message.id, tag: message.tag ?? null, port: own.port, nodes: own.nodes };
}

// At most limit events for each key in windowMs. At most maxKeys keys (the oldest key goes first).
export function createRateLimit({ limit, windowMs = 60000, now = Date.now, maxKeys = 256 }) {
    const seen = new Map();
    return {
        allow(key) {
            const time = now();
            const list = (seen.get(key) ?? []).filter(t => time - t < windowMs && t <= time);
            if (list.length >= limit) { seen.set(key, list); return false; }
            list.push(time);
            seen.delete(key);
            seen.set(key, list);
            if (seen.size > maxKeys) seen.delete(seen.keys().next().value);
            return true;
        },
        clear() { seen.clear(); }
    };
}
