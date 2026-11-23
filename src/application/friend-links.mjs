// G7a: the friend links of the main process (design F1 to F9, DECISIONS.md G7a). This module does not import electron.
// Each friend is a saved protected 2-person room with its own background node. The friend nodes run from the start
// of the archive to Quit, on the login screen and in a room. The room node, Leave room and a new login do not stop
// them. The room node gives the friend requests (attachRoom). G7b: a common protected room also carries the private
// messages (when the friend link has no session) and the 'addrs' line (design F5 item 4); the outbox keeps each message
// to a friend with no session until the friend acknowledges it (design F10); the friend nodes copy the availability
// of the person (design F11).
// Events: 'changed' (list()), 'line' { friendId, line }, 'request' (a request event), 'receipt' { friendId, id, result },
// 'away' { friendId, batch, count } (G7b: the end of a batch of lines that were sent while this device was away),
// 'invite' { friendId, id, name, room } (easy-join: a valid room invite of a friend arrived; friend-invite.mjs).
// 'invite-sent' { result } (diagnostics, 1.0.1: the result of "Invite to room", no code).
// 'journal' { event, deviceId, peer, node, ... } (diagnostics, 1.0.6: the friend link tries, sessions, statuses, address
// sources and refresh asks; main.js projects each event with diag-events.mjs projectFriendEvent, docs/DIAGNOSTICS.md).
// 1.0.6: each friend view has a status for the Friends list (friend-presence.mjs): 'online', 'room', 'connecting',
// 'unreachable', 'offline' or 'removed-you'. The state field stays as before. The address refresh (friend-refresh.mjs)
// asks the other friends and the members of the current room for the addresses of a friend with no session.
// easy-join part 3: each friend link carries the room announce line and the friend knock (friend-knock.mjs).
// A line of an event or of lines() never has the code of an invite: an invite line has text '' and invite { state, room }.
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { multiaddr } from '@multiformats/multiaddr';
import { newRoomKey } from '../network/invite.mjs';
import { createRoomMembership, restoreRoomMembership } from '../network/room-membership.mjs';
import { addrsLine, createFriendRequests, validName } from '../network/friend-requests.mjs';
import { displayText } from '../network/text-safety.mjs';
import { createPrivateMessages, validPmText } from '../network/private-messages.mjs';
import { observedIp, peerAddrAllowed } from '../network/fullnode.mjs';
import { deviceMark } from '../network/device-mark.mjs';
import { restoreSavedAdmission } from './room-admission.mjs';
import { isAddressInUse } from './login-errors.mjs';
import { checkInvite, inviteCodeOf, inviteText, isInviteText, plainText, validInviteCode, windowLine } from './friend-invite.mjs';
import { createKnockRelay, isFriendKnockLine, readRoomLine, roomLine, startFriendKnock } from '../network/friend-knock.mjs';
import { checkFriendAllowedInvite } from '../network/knock.mjs';
import { dialErrorCode, dialReason } from '../network/node.mjs';
import { createPresence } from './friend-presence.mjs';
import { createRateLimit, hereLine, isRefreshLine, newRefreshId, readHere, readWhere, readWhereFor, REFRESH_LIMITS,
    whereForLine, whereLine, whereTag } from './friend-refresh.mjs';

// The cap and the ports (design F2). 32 needs the interface cache of main.js (interface-cache.mjs, DECISIONS.md G7a).
export const FRIEND_CAP = 32;
export const FRIEND_BASE_PORT = 47200;
export const FRIEND_START_STEP_MS = 500;
// G7b (operator decision 2, 2026-11-21): at most 200 waiting messages for each friend, no expiry. At most 20 lines with
// no ack at a time. A batch of away lines ends 1.5 s after its last line.
export const OUTBOX_CAP = 200;
export const OUTBOX_WINDOW = 20;
export const AWAY_BATCH_MS = 1500;
// The prefix of a route through the room node (a peer ID of the room, not of the friend node).
const ROOM_ROUTE = 'room:';
const PRESENCE_STATES = new Set(['available', 'away', 'dnd']);
const MAX_NODES = 16;
const MAX_ADDRS = 16;
// easy-join: the codes of the shown invite lines of one friend (line ID -> code), for Join.
const MAX_KEPT_INVITES = 64;

const errText = err => err?.message ?? String(err);

// The IP and the port of a TCP multiaddr string, or null.
function tcpParts(addr) {
    const m = /^\/(ip4|ip6)\/([^/]+)\/tcp\/(\d+)/.exec(String(addr));
    return m ? { family: m[1], ip: m[2], port: Number(m[3]) } : null;
}

// Add nodes to a node list: { id, addrs } items, no duplicate address, at most 16 nodes of 16 addresses.
export function mergeNodes(list, more) {
    const out = (Array.isArray(list) ? list : []).map(n => ({ id: n.id, addrs: [...n.addrs] }));
    for (const node of more) {
        if (!node?.id || !Array.isArray(node.addrs) || !node.addrs.length) continue;
        let entry = out.find(n => n.id === node.id);
        if (!entry) {
            entry = { id: node.id, addrs: [] };
            out.unshift(entry);
        }
        for (const addr of node.addrs) if (!entry.addrs.includes(addr) && entry.addrs.length < MAX_ADDRS) entry.addrs.push(addr);
    }
    return out.filter(n => n.addrs.length).slice(0, MAX_NODES);
}

// The remote IP of each direct (not /p2p-circuit) connection of the room node to a peer, with a port (design F5a).
function connectionCandidates(roomNode, peerId, port) {
    const out = [];
    for (const connection of roomNode?.libp2p?.getConnections?.() ?? []) {
        if (connection.remotePeer?.toString() !== peerId) continue;
        const addr = connection.remoteAddr?.toString() ?? '';
        const parts = addr.includes('/p2p-circuit') ? null : tcpParts(addr);
        const candidate = parts ? `/${parts.family}/${parts.ip}/tcp/${port}` : null;
        if (candidate && !out.includes(candidate)) out.push(candidate);
    }
    return out;
}

// The candidate addresses of a new friend node (design F5a): its public addresses, else the IP of the room node
// (public addresses, else the observed IP) with the friend port, else its own listen addresses (same network).
function ownCandidates(friendNode, roomNode, port) {
    const own = friendNode.publicAddrs?.() ?? [];
    if (own.length) return own.slice(0, MAX_ADDRS);
    const roomIp = (roomNode?.publicAddrs?.() ?? []).map(tcpParts).find(Boolean)?.ip ??
        (roomNode?.libp2p ? observedIp(roomNode.libp2p) : null);
    if (roomIp) return [`/ip4/${roomIp}/tcp/${port}`];
    return (friendNode.getMultiaddrs?.() ?? []).map(a => a.replace(/\/p2p\/[^/]+$/, ''))
        .filter(a => tcpParts(a) && !a.includes('/p2p-circuit')).slice(0, 4);
}

// createNode: createAsscrackNode (a test can give its own). hintFiles(room, roomKey) -> { peers, host }.
// nodeOptions: extra node options (main.js: allowPrivateFullNode and fullNode of the test flags).
// The test options: basePort (0: port 0 for each friend node), cap, startStep, ackMs, now, setTimer, clearTimer,
// candidates (false: no candidate), refresh (false: no address refresh), refreshLimits, graceMs, unreachableMs.
export function createFriendLinks({ createNode, hintFiles = null, nodeOptions = {}, log = () => {},
    basePort = FRIEND_BASE_PORT, cap = FRIEND_CAP, startStep = FRIEND_START_STEP_MS, ackMs, requestMs, rateMs,
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, candidates = true, discovery = true,
    refresh = true, refreshLimits = {}, graceMs, unreachableMs, avatarOf = () => null } = {}) {
    const events = new EventEmitter();
    let identity = null;
    let archive = null;
    let state = 'stopped'; // 'stopped' | 'locked' | 'open'
    let stopped = false;
    let settings = { name: null, upnp: false };
    const friends = new Map(); // roomId -> entry
    const waiting = new Map(); // peerId -> { id, name } (requests of this device that wait)
    const startTimers = new Set();
    let room = null; // { node, name, requests, off() }
    // G7b: the availability of this person for the friend nodes (design F11).
    let availability = { state: 'available', note: '', idle: false };
    // 1.0.6: the address refresh (friend-refresh.mjs).
    const L = { ...REFRESH_LIMITS, ...refreshLimits };
    const askedAt = new Map(); // helper device ID -> the time of the last 'where' line to it
    const asks = new Map(); // ask ID -> { device, route, via, tags: Map(tag -> entry), timer }
    const forwards = new Map(); // forward ID -> { askId, tag, askerRoute, targetDevice, targetRoute, via, timer }
    const forwardedAt = new Map(); // 'asker device, target device' -> time
    const whereLimit = createRateLimit({ limit: L.whereRate, now });
    const forLimit = createRateLimit({ limit: L.forRate, now });
    const askReasons = new Set();
    let askTimer = null;
    let repeatTimer = null;

    const emitChanged = () => events.emit('changed', list());
    // 1.0.6: one diagnostics event. entry: the friend (its device ID becomes a tag in main.js), or null.
    function report(event, entry, fields = {}) {
        if (events.listenerCount('journal') === 0) return;
        const base = entry ? { deviceId: entry.row.deviceId, peer: entry.peerId ?? entry.lastPeer ?? undefined, node: entry.node?.peerId } : {};
        events.emit('journal', { ...base, ...fields, event });
    }
    // L1 (P10a): the addresses of a friend from a grant, a done line or an addrs line. Only TCP addresses with an IP: no
    // /dns* and no /unix. A LAN address is good (a friend on the same network). A loopback address only with the test
    // flag allowPrivateFullNode.
    const addrOk = addr => peerAddrAllowed(addr, { allowLan: true, allowPrivate: nodeOptions.allowPrivateFullNode === true });
    const friendNodes = nodes => (Array.isArray(nodes) ? nodes : [])
        .map(n => ({ id: n?.id, addrs: Array.isArray(n?.addrs) ? n.addrs.filter(addrOk) : [] }));
    const blocked = () => { try { return archive?.blocks() ?? []; } catch { return []; } };
    const isBlocked = deviceId => blocked().some(b => b.deviceId === deviceId);
    const byDevice = deviceId => [...friends.values()].find(e => e.row.deviceId === deviceId) ?? null;
    const ownName = fallback => settings.name || (validName(fallback) ? fallback.trim() : 'Friend');

    function save(roomId, fields) {
        try { archive?.updateFriend(roomId, fields); }
        catch (err) { log('WARN', `Friend not saved: ${errText(err)}`); }
    }

    function freeSlot() {
        const used = new Set([...friends.values()].map(e => e.row.slot));
        for (let slot = 0; slot < cap; slot++) if (!used.has(slot)) return slot;
        return -1;
    }

    function sessionPeer(entry) {
        return entry.peerId && entry.node?.peers().includes(entry.peerId) ? entry.peerId : null;
    }

    // G7b: the room peer ID of the friend in the current protected room, or null.
    function roomPeerOf(entry) {
        if (!room) return null;
        return room.node.peers().find(peerId => room.node.deviceOf(peerId) === entry.row.deviceId) ?? null;
    }
    // The route of the 'pm' lines: the friend link, else the session of the common room (design F5 item 4).
    function routePeer(entry) {
        const direct = sessionPeer(entry);
        if (direct) return direct;
        const viaRoom = roomPeerOf(entry);
        return viaRoom ? ROOM_ROUTE + viaRoom : null;
    }
    function routeSend(entry, peer, line) {
        if (peer.startsWith(ROOM_ROUTE)) return Boolean(room?.node.sendTo(peer.slice(ROOM_ROUTE.length), line));
        return Boolean(entry.node?.sendTo(peer, line));
    }

    // The availability of the friend on the friend link: 'idle', 'dnd', 'away' or null (available).
    function friendAvailability(entry, peerId) {
        try {
            if (entry.node.topology().idlePeers.includes(peerId)) return { availability: 'idle', note: '' };
            const presence = entry.node.peerPresence()[peerId];
            if (presence?.state === 'dnd' || presence?.state === 'away') return { availability: presence.state, note: presence.note ?? '' };
        } catch { /* a node that stops */ }
        return { availability: null, note: '' };
    }

    function friendView(entry) {
        const peerId = sessionPeer(entry);
        const removed = entry.row.state === 'removed-you';
        const inRoom = !removed && peerId === null && roomPeerOf(entry) !== null;
        const view = {
            friendId: entry.row.roomId, name: entry.row.nickname, unread: entry.unread,
            state: removed ? 'removed-you' : peerId ? 'online' : inRoom ? 'room' : 'offline',
            // 1.0.6: the status of the Friends list (friend-presence.mjs). A node that did not start yet is 'connecting'.
            status: removed ? 'removed-you' : peerId ? 'online' : inRoom ? 'room' : entry.presence.status(),
            lastSeen: entry.row.lastSeen ?? null,
            // 1.0.6: the hash of the profile picture of the friend device (avatars.mjs), or null (the letter).
            avatar: avatarOf(entry.row.deviceId) ?? null
        };
        if (peerId && !removed) Object.assign(view, friendAvailability(entry, peerId));
        if (inRoom) view.roomName = room.name ?? '';
        // easy-join part 3: the friend is in a protected room that this device is not in. join.ask: the friend cannot
        // forward a knock ("Ask <friend> for an invite").
        const target = peerId && !removed ? joinTarget(entry) : null;
        if (target) view.join = { room: target.name, ask: target.route === 'none' };
        // easy-join: the owner of the current protected room can invite this friend (friend-invite.mjs). A friend that is
        // in this room now (also with a friend link session) gets no item.
        view.canInvite = !removed && roomPeerOf(entry) === null && canInviteTo(entry);
        return view;
    }

    function reach() {
        const nodes = [...friends.values()].map(e => e.node).filter(Boolean);
        if (nodes.some(n => n.fullNode() || n.publicAddrs().length > 0)) return 'reachable';
        if (nodes.some(n => n.upnpPending())) return 'asking';
        return 'local';
    }

    function list() {
        if (state !== 'open') return { state, friends: [], waiting: [], blocked: [], cap, count: 0, name: null, upnp: false, reach: 'local' };
        return {
            state, cap, count: friends.size, name: settings.name, upnp: settings.upnp, reach: reach(),
            friends: [...friends.values()].sort((a, b) => a.row.nickname.localeCompare(b.row.nickname)).map(friendView),
            waiting: [...waiting.values()].map(w => ({ name: w.name })),
            blocked: blocked().map(b => ({ deviceId: b.deviceId, name: b.name ?? '' }))
        };
    }

    // Start the node of one friend. membership: the membership object (a new friend), else the saved admission.
    async function startNode(entry, membership = null) {
        if (stopped || entry.node || entry.row.state === 'removed-you') return;
        const saved = archive.getRoom(entry.row.roomId);
        if (!saved) return;
        membership ??= restoreSavedAdmission(saved, identity);
        membership.setPersistence(snapshot => {
            if (!archive?.updateMembership(entry.row.roomId, snapshot)) throw new Error('Couldn\'t save friend access.');
        });
        let storePath = null;
        if (hintFiles) {
            storePath = hintFiles(saved.name, saved.roomKey).peers;
            try { mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 }); } catch { storePath = null; }
        }
        const options = {
            room: saved.name, roomKey: saved.roomKey, membership, name: ownName(saved.userName),
            port: basePort === 0 ? 0 : basePort + entry.row.slot, upnp: settings.upnp === true, inviteNodes: entry.row.addrs, storePath,
            discovery, discoveryInterval: 60000, redialInterval: 30000, fullNode: 'auto', seedHistory: [], ...nodeOptions
        };
        let node;
        try {
            node = await createNode(options);
        } catch (err) {
            // libp2p gives UnsupportedListenAddressesError with no cause when the fixed port is in use (this PC).
            if (!isAddressInUse(err) && err?.name !== 'UnsupportedListenAddressesError') throw err;
            log('WARN', `Friend port ${options.port} is in use (EADDRINUSE). Start again with port 0`);
            options.port = 0;
            node = await createNode(options);
        }
        if (stopped || !friends.has(entry.row.roomId)) {
            await node.stop().catch(() => {});
            return;
        }
        entry.node = node;
        entry.port = node.getMultiaddrs().map(tcpParts).find(p => p && p.port > 0)?.port ?? options.port;
        // 1.0.6: the diagnostics of the tries and sessions of this friend node, and the status of the Friends list.
        report('start', entry, { port: entry.port, count: (entry.row.addrs ?? []).reduce((n, x) => n + x.addrs.length, 0) });
        node.events.on('dial-failed', d => {
            report('try', entry, { peer: d.peer, via: d.via, result: 'failed', reason: d.reason, error: d.code, addr: d.addr, ms: d.ms });
            if (!sessionPeer(entry)) needAsk('failed');
        });
        node.events.on('dial-result', d => report('try', entry, { peer: d.peer, via: d.via, result: d.result, reason: d.reason,
            addr: d.addr, ms: d.ms }));
        node.events.on('connection', d => {
            if (d.state === 'session') report('session', entry, { peer: d.peer, state: 'open', route: d.type, dir: d.dir, addr: d.addr });
        });
        node.events.on('session-refused', d => report('session', entry, { peer: d.peerId, state: 'refused', cause: d.cause }));
        entry.presence.started();
        armRepeat();
        entry.pm = createPrivateMessages({
            selfDevice: identity.id, friendDevice: entry.row.deviceId, sessionPeer: () => routePeer(entry),
            sendTo: (peer, line) => routeSend(entry, peer, line),
            seen: id => { try { return archive.hasLine(entry.row.roomId, id); } catch { return false; } },
            receive: msg => {
                // easy-join: the archive keeps an invite as its stored text (friend-invite.mjs).
                const text = msg.invite !== undefined ? inviteText(msg.invite) : plainText(msg.text);
                const line = { id: msg.id, from: entry.row.nickname, text, time: msg.time, own: false };
                if (msg.away) line.away = awayMark(entry);
                try {
                    archive.addLine(entry.row.roomId, { id: line.id, from: line.from, text: line.text, time: line.time,
                        own: false, source: 'live', peerId: null });
                    if (line.away) archive.addAwayMark(entry.row.roomId, line.id, line.away.batch);
                } catch (err) {
                    log('WARN', `Friend line not saved: ${errText(err)}`);
                }
                entry.unread += 1;
                const shown = showLine(entry, line);
                events.emit('line', { friendId: entry.row.roomId, line: shown });
                if (shown.invite?.state === 'ok') {
                    events.emit('invite', { friendId: entry.row.roomId, id: line.id, name: entry.row.nickname, room: shown.invite.room });
                }
                emitChanged();
            },
            acked: (id, result) => onAcked(entry, id, result),
            unfriended: () => removedYou(entry),
            now, setTimer, clearTimer, ...(ackMs ? { timeoutMs: ackMs } : {})
        });
        const opened = ({ peerId }) => {
            if (node.deviceOf(peerId) !== entry.row.deviceId || entry.peerId === peerId) return;
            entry.peerId = peerId;
            entry.lastPeer = peerId;
            entry.sessionAt = now();
            entry.row.lastSeen = now();
            save(entry.row.roomId, { lastSeen: entry.row.lastSeen });
            // 1.0.6: an address of a refresh answer is saved only now: a session with the device of this friend opened.
            const asked = entry.askAddrs.get(peerId);
            entry.askAddrs.clear();
            if (asked?.length) {
                entry.row.addrs = mergeNodes(entry.row.addrs, [{ id: peerId, addrs: asked }]);
                save(entry.row.roomId, { addrs: entry.row.addrs });
                report('addrs', entry, { source: 'ask', result: 'saved', count: asked.length });
            }
            entry.presence.sessionOpened();
            // 1.0.6: a new friend link session is a new helper for the other friends.
            needAsk('helper');
            // easy-join part 3: a new session gets the current room of this device.
            entry.sentRoom = null;
            announce(entry);
            emitChanged();
            // G7b: a new session sends the waiting lines.
            flush(entry);
        };
        node.events.on('peer-joined', opened);
        node.events.on('membership', () => { for (const peerId of node.peers()) opened({ peerId }); });
        node.events.on('peer-left', ({ peerId, left }) => {
            if (entry.peerId !== peerId) return;
            entry.peerId = null;
            entry.row.lastSeen = now();
            save(entry.row.roomId, { lastSeen: entry.row.lastSeen });
            routeClosed(entry, peerId);
            knockClosed(entry);
            // 1.0.6: a bye line (a clean quit) gives 'offline' at once; a lost session gives 'connecting'.
            report('session', entry, { peer: peerId, state: 'closed', cause: left === true ? 'bye' : 'lost',
                secs: Math.round((now() - (entry.sessionAt ?? now())) / 100) / 10 });
            entry.presence.sessionClosed(left === true);
            // 1.0.6: the refresh rounds run again while this friend has no session (the first one after repeatMs, or
            // at the first failed redial).
            armRepeat();
            emitChanged();
        });
        // G7b: the availability of the friend (presence lines and the idle flag of the node line).
        node.events.on('presence', ({ peerId }) => { if (peerId === entry.peerId) emitChanged(); });
        node.events.on('topology', () => {
            const idle = Boolean(entry.peerId && friendAvailability(entry, entry.peerId).availability === 'idle');
            if (idle !== entry.idle) { entry.idle = idle; emitChanged(); }
        });
        node.events.on('pm', data => {
            // 1.0.6: the lines of the address refresh (friend-refresh.mjs).
            if (isRefreshLine(data?.message)) refreshFromFriend(entry, data);
            // easy-join part 3: the room announce line and the friend knock lines (friend-knock.mjs).
            else if (isFriendKnockLine(data?.message)) knockLine(entry, data);
            else entry.pm?.handle(data);
        });
        // A proved address of the friend: keep it for each start (design F5 item 2).
        node.events.on('full-node-addrs', ({ peerId, addrs }) => {
            if (node.deviceOf(peerId) !== entry.row.deviceId || !Array.isArray(addrs)) return;
            const direct = addrs.filter(a => !a.includes('/p2p-circuit'));
            entry.row.addrs = mergeNodes(entry.row.addrs, [{ id: peerId, addrs: direct }]);
            save(entry.row.roomId, { addrs: entry.row.addrs });
            report('addrs', entry, { peer: peerId, source: 'full-node', result: 'saved', count: direct.length });
        });
        // G7b: changed addresses of the friend node go to the friend in a common room.
        const addrsChanged = () => { emitChanged(); if (entry.roomPeer) sendAddrs(entry, entry.roomPeer); };
        node.events.on('upnp', addrsChanged);
        node.events.on('full-node', addrsChanged);
        entry.relay = createKnockRelay({
            send: line => Boolean(sessionPeer(entry) && entry.node?.sendTo(sessionPeer(entry), line)),
            connect: knockRoute(entry), setTimer, clearTimer, log: text => log('INFO', text)
        });
        applyAvailability(entry);
        emitChanged();
        roomScan();
    }

    // ---- G7b: the outbox (design F10) ----

    // The receipt of a line. A waiting line moves to the messages only with an ack ('delivered'). With no ack it stays
    // in the outbox and keeps the mark "Waiting" (no receipt).
    function onAcked(entry, id, result) {
        const roomId = entry.row.roomId;
        let waitingRow = false;
        try { waitingRow = Boolean(archive?.hasOutbox(roomId, id)); } catch { /* a closed archive */ }
        if (!waitingRow) { events.emit('receipt', { friendId: roomId, id, result }); return; }
        if (result !== 'delivered') return;
        let line = null;
        try { line = archive.deliverOutbox(roomId, id, ownName(archive.getRoom(roomId)?.userName)); }
        catch (err) { log('WARN', `Friend line not saved: ${errText(err)}`); }
        if (line) events.emit('receipt', { friendId: roomId, id, result: 'delivered' });
    }

    // A new session (friend link or common room): send the outbox again from the start.
    function flush(entry) {
        entry.tried = new Set();
        pump(entry);
    }
    // Send the waiting lines in seq order with away: true, at most OUTBOX_WINDOW with no ack at a time. Each line goes
    // one time in each session. A line with no ack waits for the next session.
    function pump(entry) {
        const pm = entry.pm;
        if (stopped || !pm || entry.row.state === 'removed-you' || !routePeer(entry)) return;
        let rows;
        try { rows = archive.listOutbox(entry.row.roomId); } catch { return; }
        for (const row of rows) {
            if (entry.inflight.size >= OUTBOX_WINDOW) break;
            if (entry.inflight.has(row.id) || entry.tried.has(row.id)) continue;
            entry.tried.add(row.id);
            entry.inflight.add(row.id);
            transmit(pm, row.id, row.text, { time: row.time, away: true }).then(result => {
                entry.inflight.delete(row.id);
                if (entry.pm === pm && result !== 'unavailable') pump(entry);
            });
        }
    }

    // A route to the friend closed: the lines on it with no ack wait again, and an open batch of away lines ends.
    function routeClosed(entry, peer) {
        entry.pm?.closed(peer);
        endBatch(entry);
        if (routePeer(entry)) flush(entry);
    }

    // ---- G7b: the away lines of the receiver ----

    function awayMark(entry) {
        let batch = entry.batch;
        if (!batch) batch = entry.batch = { id: randomUUID(), count: 0, timer: null };
        batch.count += 1;
        clearTimer(batch.timer);
        batch.timer = setTimer(() => endBatch(entry), AWAY_BATCH_MS);
        batch.timer?.unref?.();
        return { batch: batch.id, count: batch.count };
    }
    function endBatch(entry) {
        const batch = entry.batch;
        if (!batch) return;
        entry.batch = null;
        clearTimer(batch.timer);
        events.emit('away', { friendId: entry.row.roomId, batch: batch.id, count: batch.count });
    }

    // ---- G7b: the common room (design F5 item 4) and the availability (design F11) ----

    // The current addresses of the friend node for the friend, on the session of the common room.
    function sendAddrs(entry, roomPeerId) {
        if (!candidates || !entry.node || !room || entry.row.state === 'removed-you') return;
        const addrs = ownCandidates(entry.node, room.node, entry.port);
        if (addrs.length) room.node.sendTo(roomPeerId, addrsLine(entry.port, [{ id: entry.node.peerId, addrs }]));
    }

    // Look for each friend in the current room. A new room peer of a friend gets the addrs line and, when the friend
    // link has no session, the waiting lines. A room peer that left ends that route.
    function roomScan() {
        for (const entry of friends.values()) {
            const peerId = entry.node ? roomPeerOf(entry) : null;
            if (peerId === entry.roomPeer) continue;
            const old = entry.roomPeer;
            entry.roomPeer = peerId;
            if (old) routeClosed(entry, ROOM_ROUTE + old);
            if (peerId) {
                sendAddrs(entry, peerId);
                if (!sessionPeer(entry)) flush(entry);
            }
            emitChanged();
        }
        // easy-join part 3: a new room, Leave room or a new membership state goes to each friend with a session.
        for (const entry of friends.values()) announce(entry);
    }

    // ---- easy-join part 3: the room announce line and the friend knock (friend-knock.mjs) ----

    // The current protected room of this device for the friends: { id, owner, name, route }, or null.
    function ownRoom() {
        if (!room) return null;
        let member;
        try { member = room.node.memberState?.(); } catch { return null; }
        if (!member?.protected || typeof member.roomId !== 'string' || typeof member.ownerId !== 'string') return null;
        const route = member.owner ? 'owner' : member.admitted && !member.revoked ? 'forward' : 'none';
        return { id: member.roomId, owner: member.ownerId, name: room.name || 'a room', route };
    }
    // Send the room line to the friend when it changed. Only on the friend link session (not on a common room).
    function announce(entry) {
        const peerId = entry.node ? sessionPeer(entry) : null;
        if (!peerId || entry.row.state === 'removed-you') return;
        const line = roomLine(ownRoom());
        const text = JSON.stringify(line.room);
        if (text === entry.sentRoom) return;
        if (entry.node.sendTo(peerId, line)) entry.sentRoom = text;
    }
    // The room of the friend that this device can ask to join, or null: not the current room of this device, and not
    // a room that this device owns.
    function joinTarget(entry) {
        const target = entry.friendRoom;
        if (!target || target.owner === identity?.id) return null;
        const own = ownRoom();
        return own && own.id === target.id ? null : target;
    }
    // A line of friend-knock.mjs from the friend link of this friend. Only the proved device of the friend, on the
    // friend link session (never on a common room).
    function knockLine(entry, { peerId, deviceId, message } = {}) {
        if (stopped || deviceId !== entry.row.deviceId || !peerId || peerId !== sessionPeer(entry) || entry.row.state === 'removed-you') return;
        if (message.op === 'room') {
            const next = readRoomLine(message);
            if (JSON.stringify(next) === JSON.stringify(entry.friendRoom ?? null)) return;
            entry.friendRoom = next;
            emitChanged();
            return;
        }
        if (entry.knock && message.kid === entry.knock.kid) entry.knock.handle(message);
        else entry.relay?.handle(message);
    }
    // The friend link session ended: the room of the friend is not known now, and each knock on it ends.
    function knockClosed(entry) {
        entry.friendRoom = null;
        entry.sentRoom = null;
        entry.relay?.closed();
        entry.knock?.closed();
    }
    // The route of a knock that this friend sends to this device: the knock desk of the own room (this device is the
    // owner), else a forward to the owner (an admitted member), else none.
    function knockRoute(entry) {
        return ({ toJoiner, ended }) => {
            const node = room?.node;
            const desk = node?.knockDesk?.() ?? null;
            if (desk) {
                const handler = desk.open({ send: line => { toJoiner(line); return true; }, end: () => ended() },
                    { source: `friend:${entry.row.deviceId}`, via: 'friend', friend: true });
                return { send: line => handler.receive(line), end: () => handler.closed() };
            }
            if (!node?.forwardKnock || ownRoom()?.route !== 'forward') return null;
            return node.forwardKnock({ onLine: toJoiner, onClose: () => ended() })
                .then(channel => channel && { send: line => channel.send(line), end: () => channel.end() });
        };
    }

    function applyAvailability(entry) {
        const node = entry.node;
        if (!node) return;
        try {
            const own = node.presence();
            if (own.state !== availability.state || own.note !== availability.note) {
                node.setPresence({ state: availability.state, note: availability.note });
            }
            node.setIdle(availability.idle);
        } catch (err) {
            log('WARN', `Friend availability not set: ${errText(err)}`);
        }
    }

    // ---- easy-join: the friend invite (friend-invite.mjs) ----

    // A message or an invite line on the pm session.
    function transmit(pm, id, text, options) {
        return isInviteText(text) ? pm.sendInvite(id, inviteCodeOf(text), options) : pm.send(id, text, options);
    }
    // The owner of the current protected room can invite a friend with a device ID.
    function canInviteTo(entry) {
        if (!room || typeof entry.row.deviceId !== 'string' || !entry.row.deviceId) return false;
        try {
            const member = room.node.memberState?.();
            return member?.protected === true && member.owner === true;
        } catch {
            return false;
        }
    }
    // The line for a window. The receiver checks each received invite again: the device of the grant must be this
    // device, and the owner of the room must be the device of this friend. The code of a valid invite stays in main.
    function showLine(entry, line) {
        const shown = windowLine(line, code => checkInvite(code, { selfId: identity.id, friendDevice: entry.row.deviceId }));
        if (shown.invite && !line.own && shown.invite.state === 'ok') {
            entry.invites.delete(line.id);
            entry.invites.set(line.id, inviteCodeOf(line.text));
            if (entry.invites.size > MAX_KEPT_INVITES) entry.invites.delete(entry.invites.keys().next().value);
        }
        return shown;
    }
    // Send a text or an invite line: on the session now, else into the outbox (G7b).
    function post(entry, text) {
        const friendId = entry.row.roomId;
        const time = now();
        const from = ownName(archive.getRoom(friendId)?.userName);
        if (!entry.pm || !routePeer(entry)) {
            const id = `${identity.id}.${randomUUID()}`;
            let seq = null;
            try { seq = archive.addOutbox(friendId, { id, text, time }, OUTBOX_CAP); }
            catch (err) { log('WARN', `Friend line not queued: ${errText(err)}`); return { result: 'unavailable' }; }
            if (seq === null) return { result: 'full' };
            return { result: 'waiting', line: showLine(entry, { id, from, text, time, own: true, waiting: true }) };
        }
        const id = entry.pm.newId();
        const line = { id, from, text, time, own: true };
        transmit(entry.pm, id, text, { time }).then(result => {
            if (result === 'unavailable' || result === 'invalid') events.emit('receipt', { friendId, id, result });
        });
        try { archive.addLine(friendId, { ...line, source: 'send', peerId: null }); }
        catch (err) { log('WARN', `Friend line not saved: ${errText(err)}`); }
        return { result: 'sending', line: showLine(entry, line) };
    }

    async function stopNode(entry) {
        const node = entry.node;
        entry.node = null;
        entry.peerId = null;
        entry.pm?.stop();
        entry.pm = null;
        knockClosed(entry);
        entry.relay = null;
        entry.roomPeer = null;
        clearTimer(entry.batch?.timer);
        entry.batch = null;
        entry.presence.stop();
        entry.askAddrs.clear();
        if (node) await node.stop().catch(err => log('WARN', `Friend node stop failed: ${errText(err)}`));
    }

    function removedYou(entry) {
        if (entry.row.state === 'removed-you') return;
        entry.row.state = 'removed-you';
        save(entry.row.roomId, { state: 'removed-you' });
        log('INFO', 'A friend removed this device');
        stopNode(entry).then(emitChanged);
        emitChanged();
    }

    function scheduleStart(entry, delay) {
        const timer = setTimer(() => {
            startTimers.delete(timer);
            startNode(entry).catch(err => {
                log('WARN', `Friend node not started: ${errText(err)}`);
                // 1.0.6: the status leaves 'connecting' after the grace time.
                if (!entry.node) entry.presence.started();
            });
        }, delay);
        startTimers.add(timer);
    }

    // ---- The grant (design F3 steps 3 and 4) ----

    function checkRoomForNew(deviceId) {
        if (state !== 'open') throw new Error('Friends are locked: secure storage is unavailable.');
        if (byDevice(deviceId)) throw new Error('already a friend');
        if (isBlocked(deviceId)) throw new Error('blocked');
        const slot = freeSlot();
        if (slot < 0) throw new Error('friend limit');
        return slot;
    }

    function addEntry(row) {
        const entry = { row, node: null, pm: null, peerId: null, port: null, unread: 0,
            roomPeer: null, tried: new Set(), inflight: new Set(), batch: null, idle: false, invites: new Map(),
            friendRoom: null, sentRoom: null, relay: null, knock: null,
            // 1.0.6: the status (friend-presence.mjs), the last session peer and its start, the addresses of refresh
            // answers that wait for a session (peer ID -> addresses), and the time of the last redial for an ask.
            presence: null, lastPeer: null, sessionAt: null, askAddrs: new Map(), redialAt: null };
        entry.presence = createPresence({ now, setTimer, clearTimer,
            ...(graceMs ? { graceMs } : {}), ...(unreachableMs ? { unreachableMs } : {}),
            onChange: change => {
                report('state', entry, change);
                if (change.to === 'unreachable') needAsk('unreachable');
                emitChanged();
            } });
        friends.set(row.roomId, entry);
        return entry;
    }

    function forget(entry) {
        friends.delete(entry.row.roomId);
        try { archive?.removeFriendRoom(entry.row.roomId); }
        catch (err) { log('WARN', `Friend room not removed: ${errText(err)}`); }
    }

    // L2: the default nickname of a new friend. The name comes from a peer: remove the bidi controls.
    function friendNickname(name) {
        const clean = typeof name === 'string' ? displayText(name).trim() : '';
        return validName(clean) ? clean : 'Friend';
    }

    // A (the device that sent the request): make, save and start the friend room, then give the grant.
    async function ownerGrant(roomNode, peerId, deviceId, name) {
        const slot = checkRoomForNew(deviceId);
        const roomName = `friend-${randomBytes(16).toString('base64url')}`;
        const roomKey = newRoomKey();
        const membership = createRoomMembership({ identity, room: roomName, roomKey });
        const descriptor = membership.issue(deviceId, true);
        descriptor.admission = membership.admit({ deviceId, grant: descriptor.grant });
        const userName = ownName(roomNode.name);
        const { roomId } = archive.saveFriendRoom({ name: roomName, roomKey, userName, membership: membership.snapshot(),
            friend: { deviceId, nickname: friendNickname(name), slot, addrs: [] } });
        const entry = addEntry(archive.listFriends().find(f => f.roomId === roomId));
        try {
            await startNode(entry, membership);
            if (!entry.node) throw new Error('friend node not started');
        } catch (err) {
            await stopNode(entry);
            forget(entry);
            throw err;
        }
        log('INFO', `Friend room made (slot ${slot}, port ${entry.port})`);
        const addrs = candidates ? ownCandidates(entry.node, roomNode, entry.port) : [];
        emitChanged();
        return { room: roomName, key: roomKey, descriptor, port: entry.port,
            nodes: addrs.length ? [{ id: entry.node.peerId, addrs }] : [] };
    }

    // B: check the grant, then save and start the friend room. Throws for each refusal (nothing is saved).
    async function receiveGrant(roomNode, peerId, deviceId, name, grant) {
        const slot = checkRoomForNew(deviceId);
        if (grant.descriptor.owner !== deviceId) throw new Error('The grant is not from the requester');
        if (!/^[A-Za-z0-9_-]{43}$/.test(grant.key)) throw new Error('bad room key');
        const membership = restoreRoomMembership({ identity, room: grant.room, roomKey: grant.key, descriptor: grant.descriptor });
        if (membership.ownerId !== deviceId || membership.lan || !membership.admitted() || !membership.canHost()) {
            throw new Error('The grant is not valid');
        }
        const id = grant.nodes[0]?.id;
        const fromRoom = candidates && id ? [{ id, addrs: connectionCandidates(roomNode, peerId, grant.port) }] : [];
        const addrs = candidates ? mergeNodes(friendNodes(grant.nodes), friendNodes(fromRoom)) : [];
        const { roomId } = archive.saveFriendRoom({ name: grant.room, roomKey: grant.key, userName: ownName(roomNode.name),
            membership: membership.snapshot(), friend: { deviceId, nickname: friendNickname(name), slot, addrs } });
        const entry = addEntry(archive.listFriends().find(f => f.roomId === roomId));
        try {
            await startNode(entry, membership);
            if (!entry.node) throw new Error('friend node not started');
        } catch (err) {
            await stopNode(entry);
            forget(entry);
            throw err;
        }
        log('INFO', `Friend room saved (slot ${slot}, port ${entry.port})`);
        const own = candidates ? ownCandidates(entry.node, roomNode, entry.port) : [];
        emitChanged();
        return { port: entry.port, nodes: own.length ? [{ id: entry.node.peerId, addrs: own }] : [] };
    }

    // A: the done line of B. Dial the candidates of B one time. G7b: the same for the addrs line of a friend in a
    // common room. L1 (P10a): save a candidate only after a connection to that peer ID (tryFriendAddr). The friend node
    // opens the friend link on that connection when the link has no session.
    function ownerDone(roomNode, peerId, deviceId, port, nodes, source = 'room') {
        const entry = byDevice(deviceId);
        if (!entry || !candidates || entry.row.state === 'removed-you') return;
        const id = nodes[0]?.id;
        const more = mergeNodes(friendNodes(nodes), friendNodes(id ? [{ id, addrs: connectionCandidates(roomNode, peerId, port) }] : []));
        report('addrs', entry, { source, result: 'received', count: more.reduce((n, x) => n + x.addrs.length, 0) });
        for (const node of more) for (const addr of node.addrs) tryFriendAddr(entry, node.id, addr);
    }

    // L1 (P10a): one dial of an address of the friend node. A new connection (force), also when a connection exists.
    // 1.0.6: via 'ask' (an address of a refresh answer): the address is saved only after a session opened (opened()).
    async function tryFriendAddr(entry, id, addr, via = 'candidate') {
        const node = entry.node;
        if (stopped || !node?.libp2p) return;
        const target = `${addr}/p2p/${id}`;
        const started = now();
        let conn;
        try {
            conn = await node.libp2p.dial(multiaddr(target), { force: true });
        } catch (err) {
            report('try', entry, { peer: id, via, result: 'failed', reason: dialReason(err), error: dialErrorCode(err), addr,
                ms: now() - started });
            return;
        }
        if (stopped || entry.node !== node || !friends.has(entry.row.roomId) || conn.remotePeer.toString() !== id) {
            conn.close().catch(() => {});
            return;
        }
        report('try', entry, { peer: id, via, result: 'ok', addr, ms: now() - started });
        if (via === 'ask') {
            const list = entry.askAddrs.get(id) ?? [];
            if (!list.includes(addr) && list.length < MAX_ADDRS) list.push(addr);
            entry.askAddrs.set(id, list);
            if (entry.askAddrs.size > MAX_NODES) entry.askAddrs.delete(entry.askAddrs.keys().next().value);
        } else {
            entry.row.addrs = mergeNodes(entry.row.addrs, [{ id, addrs: [addr] }]);
            save(entry.row.roomId, { addrs: entry.row.addrs });
        }
        if (!sessionPeer(entry)) node.connect(target).catch(() => {});
        else if (!conn.streams.some(stream => stream.protocol?.startsWith('/asscrack/chat'))) conn.close().catch(() => {});
    }

    function requestEvent(event) {
        if (event.kind === 'outgoing') waiting.set(event.peerId, { id: event.id, name: event.name });
        if (event.kind === 'ended' && event.side === 'out') waiting.delete(event.peerId);
        // L3 (P10a): the device mark of the other device. The window shows it beside the name of the request.
        events.emit('request', { kind: event.kind, id: event.id, name: event.name ?? '', side: event.side ?? null,
            result: event.result ?? null, mark: deviceMark(event.deviceId) });
        emitChanged();
    }

    // ---- 1.0.6: the address refresh (friend-refresh.mjs) ----

    // A route of a refresh line: { kind: 'friend', entry } (the friend link session of that friend) or
    // { kind: 'room', node, peerId } (the session of a proved member of the current room).
    function routeLine(route, line) {
        if (stopped) return false;
        if (route.kind === 'friend') {
            const peerId = route.entry.node ? sessionPeer(route.entry) : null;
            return Boolean(peerId && route.entry.node.sendTo(peerId, line));
        }
        return Boolean(room && room.node === route.node && room.node.sendTo(route.peerId, line));
    }
    const sameRoute = (a, b) => a.kind === b.kind && (a.kind === 'friend' ? a.entry === b.entry : a.node === b.node && a.peerId === b.peerId);
    // The IP of the session of a route with a port (design F5a), as candidate addresses.
    function seenCandidates(route, port) {
        if (route.kind === 'friend') {
            const peerId = sessionPeer(route.entry);
            return peerId ? connectionCandidates(route.entry.node, peerId, port) : [];
        }
        return room?.node === route.node ? connectionCandidates(room.node, route.peerId, port) : [];
    }
    // The devices with a route for refresh lines: the friends with a friend link session, then the proved member devices
    // of the current protected room. Never a blocked device and never this device.
    function routes() {
        const out = new Map();
        for (const entry of friends.values()) {
            if (entry.row.state === 'removed-you' || !entry.node || !sessionPeer(entry) || isBlocked(entry.row.deviceId)) continue;
            out.set(entry.row.deviceId, { route: { kind: 'friend', entry }, via: 'friend' });
        }
        let member = null;
        try { member = room?.node.memberState?.() ?? null; } catch { member = null; }
        if (room && member?.protected) {
            for (const peerId of room.node.peers()) {
                const device = room.node.deviceOf(peerId);
                if (!device || device === identity?.id || out.has(device) || isBlocked(device)) continue;
                out.set(device, { route: { kind: 'room', node: room.node, peerId }, via: 'room' });
            }
        }
        return out;
    }
    // The own candidate addresses of the friend node of a friend: { port, nodes } or {}.
    function ownAddrs(entry) {
        const addrs = candidates && entry.node ? ownCandidates(entry.node, room?.node, entry.port) : [];
        return addrs.length ? { port: entry.port, nodes: [{ id: entry.node.peerId, addrs }] } : {};
    }
    // The friends that need addresses: a running node, no session and no common room.
    const askTargets = () => [...friends.values()].filter(e => e.node && e.row.state !== 'removed-you' && !sessionPeer(e) && !e.roomPeer);

    function needAsk(reason) {
        if (!refresh || stopped || state !== 'open') return;
        askReasons.add(reason);
        if (askTimer) return;
        askTimer = setTimer(() => {
            askTimer = null;
            const order = ['network', 'unreachable', 'failed', 'helper', 'repeat'];
            const first = order.find(r => askReasons.has(r)) ?? [...askReasons][0];
            askReasons.clear();
            askRound(first);
        }, L.debounceMs);
        askTimer?.unref?.();
    }
    function armRepeat() {
        if (!refresh || stopped || repeatTimer) return;
        repeatTimer = setTimer(() => { repeatTimer = null; needAsk('repeat'); }, L.repeatMs);
        repeatTimer?.unref?.();
    }
    // One round: one 'where' line to each helper device that did not get one in askGapMs. A new round each repeatMs
    // while a friend needs addresses.
    function askRound(reason) {
        if (stopped || state !== 'open') return;
        const targets = askTargets();
        if (!targets.length) return;
        armRepeat();
        let viaFriends = 0, viaRoom = 0, limited = 0;
        for (const [device, helper] of routes()) {
            const list = targets.filter(t => t.row.deviceId !== device).slice(0, L.maxTags);
            if (!list.length) continue;
            const last = askedAt.get(device);
            if (last !== undefined && now() - last < L.askGapMs) { limited += 1; continue; }
            const id = newRefreshId();
            const line = whereLine(id, newRefreshId(), list.map(t => ({ deviceId: t.row.deviceId, ...ownAddrs(t) })));
            if (!routeLine(helper.route, line)) continue;
            askedAt.set(device, now());
            if (askedAt.size > 256) askedAt.delete(askedAt.keys().next().value);
            const ask = { device, route: helper.route, via: helper.via, tags: new Map(list.map((t, i) => [line.ask[i].tag, t])) };
            ask.timer = setTimer(() => asks.delete(id), L.answerMs);
            ask.timer?.unref?.();
            asks.set(id, ask);
            if (helper.via === 'friend') viaFriends += 1;
            else viaRoom += 1;
        }
        // The journal gets a round that sent a line, and a round with no helper for a new status or a network change.
        const sent = viaFriends + viaRoom > 0;
        if (!sent && reason !== 'unreachable' && reason !== 'network') return;
        for (const t of targets) {
            report('ask', t, { role: 'asker', reason, result: sent ? 'sent' : limited ? 'limited' : 'no-helper',
                friends: viaFriends, members: viaRoom, count: limited });
        }
    }

    // A refresh line on the friend link session of a friend.
    function refreshFromFriend(entry, { peerId, deviceId, message } = {}) {
        if (stopped || deviceId !== entry.row.deviceId || !peerId || peerId !== sessionPeer(entry) ||
            entry.row.state === 'removed-you' || isBlocked(deviceId)) return;
        refreshLine({ kind: 'friend', entry }, deviceId, message, 'friend');
    }
    // A refresh line on the session of a proved member of the current protected room.
    function refreshFromRoom(node, { peerId, deviceId, message } = {}) {
        if (stopped || !room || room.node !== node || typeof peerId !== 'string' || typeof deviceId !== 'string' ||
            node.deviceOf(peerId) !== deviceId || deviceId === identity?.id || isBlocked(deviceId)) return;
        refreshLine({ kind: 'room', node, peerId }, deviceId, message, 'room');
    }
    function refreshLine(route, device, message, via) {
        if (message.op === 'where') onWhere(route, device, message, via);
        else if (message.op === 'where-for') onWhereFor(route, device, message, via);
        else onHere(route, device, message, via);
    }

    // Helper: forward each known tag to that device. Silent for an unknown tag.
    function onWhere(route, askerDevice, message, via) {
        const ask = readWhere(message);
        if (!ask) return;
        if (!whereLimit.allow(askerDevice)) { report('answer', null, { role: 'helper', via, result: 'rate' }); return; }
        const known = routes();
        for (const item of ask.ask) {
            let target = null;
            for (const [device, helper] of known) {
                if (device !== askerDevice && whereTag(ask.nonce, device) === item.tag) { target = { device, route: helper.route }; break; }
            }
            if (!target) continue;
            const friend = byDevice(target.device);
            const key = `${askerDevice} ${target.device}`;
            const last = forwardedAt.get(key);
            if ((last !== undefined && now() - last < L.forwardGapMs) || forwards.size >= L.maxForwards) {
                report('answer', friend, { deviceId: target.device, role: 'helper', via, result: 'limited' });
                continue;
            }
            const id = newRefreshId();
            if (!routeLine(target.route, whereForLine(id, askerDevice, item.port, item.nodes))) continue;
            forwardedAt.delete(key);
            forwardedAt.set(key, now());
            if (forwardedAt.size > 256) forwardedAt.delete(forwardedAt.keys().next().value);
            const forward = { askId: ask.id, tag: item.tag, askerRoute: route, targetDevice: target.device, targetRoute: target.route, via };
            forward.timer = setTimer(() => forwards.delete(id), L.answerMs);
            forward.timer?.unref?.();
            forwards.set(id, forward);
            report('answer', friend, { deviceId: target.device, role: 'helper', via, result: 'forwarded' });
        }
    }

    // Friend: a helper forwards an ask of a friend of this device. Dial the addresses of the asker, and answer with the
    // own candidates of the friend node for the asker.
    function onWhereFor(route, helperDevice, message, via) {
        const ask = readWhereFor(message);
        if (!ask) return;
        if (!forLimit.allow(helperDevice)) { report('answer', null, { role: 'friend', via, result: 'rate' }); return; }
        const asker = byDevice(ask.device);
        if (!asker || ask.device === helperDevice || asker.row.state === 'removed-you' || isBlocked(ask.device) || !asker.node) {
            report('answer', null, { role: 'friend', via, result: 'unknown' });
            return;
        }
        // The asker runs now.
        asker.presence.answered();
        if (!sessionPeer(asker)) {
            let tries = 0;
            for (const node of friendNodes(ask.nodes)) {
                for (const addr of node.addrs) if (tries++ < L.maxTries) tryFriendAddr(asker, node.id, addr, 'ask');
            }
            if (asker.redialAt === null || now() - asker.redialAt >= L.redialGapMs) {
                asker.redialAt = now();
                try { asker.node.refreshRoutes?.(); } catch { /* a node that stops */ }
            }
        }
        const own = ownAddrs(asker);
        const sent = Boolean(own.nodes) && routeLine(route, hereLine(ask.id, null, own.port, own.nodes));
        report('answer', asker, { role: 'friend', via, result: sent ? 'answered' : 'no-address',
            count: own.nodes ? own.nodes[0].addrs.length : 0 });
    }

    // Helper: the answer of the friend for a forward goes back to the asker, with the IP of the session to the friend.
    // Asker: the answer of a helper; dial the addresses of the friend.
    function onHere(route, device, message, via) {
        const here = readHere(message);
        if (!here) return;
        const forward = forwards.get(here.id);
        if (forward) {
            if (device !== forward.targetDevice || !sameRoute(route, forward.targetRoute)) return;
            forwards.delete(here.id);
            clearTimer(forward.timer);
            const id = here.nodes[0].id;
            const nodes = mergeNodes(friendNodes(here.nodes), friendNodes([{ id, addrs: seenCandidates(route, here.port) }]))
                .filter(n => n.addrs.length);
            const sent = nodes.length > 0 && routeLine(forward.askerRoute, hereLine(forward.askId, forward.tag, here.port, nodes));
            report('answer', byDevice(device), { deviceId: device, role: 'helper', via, result: sent ? 'relayed' : 'no-address',
                count: nodes.reduce((n, x) => n + x.addrs.length, 0) });
            return;
        }
        const ask = asks.get(here.id);
        if (!ask || device !== ask.device || !sameRoute(route, ask.route) || !here.tag) return;
        const target = ask.tags.get(here.tag);
        if (!target) return;
        ask.tags.delete(here.tag);
        if (stopped || !friends.has(target.row.roomId) || !target.node || target.row.state === 'removed-you') return;
        target.presence.answered();
        const nodes = friendNodes(here.nodes).filter(n => n.addrs.length);
        report('addrs', target, { source: 'ask', via: ask.via, result: 'received', count: nodes.reduce((n, x) => n + x.addrs.length, 0) });
        if (sessionPeer(target)) return;
        let tries = 0;
        for (const node of nodes) for (const addr of node.addrs) if (tries++ < L.maxTries) tryFriendAddr(target, node.id, addr, 'ask');
    }

    // ---- The API ----

    return {
        events,
        FRIEND_CAP: cap,
        // Start after the archive is open. archive: savedRooms.friendArchive() (null: locked).
        start(newIdentity, newArchive) {
            if (state === 'open' || stopped) return list();
            if (!newIdentity || !newArchive) {
                state = 'locked';
                emitChanged();
                return list();
            }
            identity = newIdentity;
            archive = newArchive;
            try {
                settings = archive.settings();
                const rows = archive.listFriends();
                state = 'open';
                let delay = 0;
                for (const row of rows) {
                    const entry = addEntry(row);
                    if (row.state === 'removed-you') continue;
                    scheduleStart(entry, delay);
                    delay += startStep;
                }
                log('INFO', `Friend links: ${rows.length} friends`);
            } catch (err) {
                log('WARN', `Friend links not started: ${errText(err)}`);
                state = 'locked';
            }
            emitChanged();
            return list();
        },
        state: () => state,
        list,
        // The room node of the current room, or null (Leave room). Only a protected room gives friend requests.
        // G7b: info.name is the room name for "Online · in <room name>".
        attachRoom(node, info = {}) {
            if (room) {
                room.off();
                room.requests.stop();
                room = null;
                waiting.clear();
                roomScan();
            }
            if (!node || stopped || !node.memberState?.().protected) { emitChanged(); return; }
            const requests = createFriendRequests({
                send: (peerId, line) => node.sendTo(peerId, line),
                isBlocked,
                makeGrant: ({ peerId, deviceId, name }) => ownerGrant(node, peerId, deviceId, name)
                    .catch(err => { log('WARN', `Friend grant not made: ${errText(err)}`); throw err; }),
                acceptGrant: ({ peerId, deviceId, name, grant }) => receiveGrant(node, peerId, deviceId, name, grant)
                    .catch(err => { log('WARN', `Friend grant refused: ${errText(err)}`); throw err; }),
                done: ({ peerId, deviceId, port, nodes }) => ownerDone(node, peerId, deviceId, port, nodes, 'done'),
                addrs: ({ peerId, deviceId, port, nodes }) => ownerDone(node, peerId, deviceId, port, nodes, 'room'),
                undo: ({ deviceId }) => {
                    const entry = byDevice(deviceId);
                    if (entry) stopNode(entry).then(() => { forget(entry); emitChanged(); });
                },
                changed: requestEvent,
                now, setTimer, clearTimer, ...(requestMs ? { requestMs } : {}), ...(rateMs ? { rateMs } : {})
            });
            const onFriend = data => requests.handle(data);
            const onLeft = ({ peerId }) => { requests.closed(peerId); roomScan(); };
            // G7b: a 'pm' line on the room session goes to the conversation of the friend with that proved device ID.
            // 1.0.6: the lines of the address refresh from a proved member of this room (friend-refresh.mjs).
            const onPm = data => {
                if (isRefreshLine(data?.message)) refreshFromRoom(node, data);
                else byDevice(data?.deviceId)?.pm?.handle({ ...data, peerId: ROOM_ROUTE + data.peerId });
            };
            const onScan = () => { roomScan(); needAsk('helper'); };
            const listeners = [['friend', onFriend], ['peer-left', onLeft], ['pm', onPm], ['peer-joined', onScan], ['membership', onScan]];
            for (const [name, fn] of listeners) node.events.on(name, fn);
            room = { node, name: typeof info?.name === 'string' ? info.name : '', requests,
                off() { for (const [name, fn] of listeners) node.events.off(name, fn); } };
            roomScan();
            needAsk('helper');
            emitChanged();
        },
        // 1.0.6: a network change of this PC (cause: 'online', 'changed' or 'resume'). Each friend with no session goes
        // back to 'connecting', its node dials the known addresses now, and a refresh round starts (the gap of each
        // helper does not apply to this round). Returns the number of friends with new tries.
        networkChanged(cause = 'changed') {
            if (state !== 'open' || stopped) return 0;
            let count = 0;
            for (const entry of friends.values()) {
                if (!entry.node || entry.row.state === 'removed-you' || sessionPeer(entry)) continue;
                count += 1;
                entry.presence.network();
                try { entry.node.refreshRoutes?.(); } catch (err) { log('WARN', `Friend redial failed: ${errText(err)}`); }
            }
            report('network', null, { cause, count });
            if (count) {
                askedAt.clear();
                needAsk('network');
            }
            return count;
        },
        // G7b: the availability of this person for the friends (design F11): the room presence (state, note) and the
        // idle flag of Idle Peer. A field that is not given keeps its value.
        setAvailability({ state, note, idle } = {}) {
            availability = {
                state: PRESENCE_STATES.has(state) ? state : availability.state,
                note: typeof note === 'string' ? note : availability.note,
                idle: typeof idle === 'boolean' ? idle : availability.idle
            };
            for (const entry of friends.values()) applyAvailability(entry);
            return { ...availability };
        },
        // The buddy menu line for a peer of the room: 'add', 'open' (a friend), or null (no line).
        relation(peerId) {
            if (state !== 'open' || !room) return null;
            const deviceId = room.node.deviceOf(peerId);
            if (!deviceId) return null;
            const friend = byDevice(deviceId);
            if (friend) return { kind: 'open', friendId: friend.row.roomId };
            if (isBlocked(deviceId) || room.requests.pendingTo(peerId) || friends.size >= cap) return null;
            return { kind: 'add' };
        },
        relations(peerIds) {
            const out = {};
            for (const peerId of Array.isArray(peerIds) ? peerIds.slice(0, 128) : []) {
                const value = this.relation(peerId);
                if (value) out[peerId] = value;
            }
            return out;
        },
        // Add friend: returns { result, name }. result: 'sent', 'busy', 'friend', 'blocked', 'cap', 'unavailable'.
        request(roomNode, peerId) {
            if (state !== 'open') return { result: 'locked' };
            if (!room || room.node !== roomNode) return { result: 'unavailable' };
            const deviceId = roomNode.deviceOf(peerId);
            const name = roomNode.peerNames()[peerId] ?? '';
            if (!deviceId) return { result: 'unavailable', name };
            if (byDevice(deviceId)) return { result: 'friend', name };
            if (isBlocked(deviceId)) return { result: 'blocked', name };
            if (friends.size >= cap) return { result: 'cap', name };
            return { result: room.requests.request(peerId, deviceId, ownName(roomNode.name), name), name };
        },
        respond(requestId, accept) {
            return Boolean(room?.requests.respond(String(requestId), accept === true));
        },
        // Remove friend (design F9): 'unfriend' on an open session, stop the node, forget the room.
        async remove(friendId) {
            const entry = friends.get(friendId);
            if (!entry) return false;
            entry.pm?.unfriend();
            await stopNode(entry);
            forget(entry);
            log('INFO', 'Friend removed');
            emitChanged();
            return true;
        },
        async block(friendId) {
            const entry = friends.get(friendId);
            if (!entry) return false;
            try { archive.block(entry.row.deviceId, entry.row.nickname); }
            catch (err) { log('WARN', `Block not saved: ${errText(err)}`); throw new Error('Couldn\'t block. Try again.'); }
            return this.remove(friendId);
        },
        unblock(deviceId) {
            const done = Boolean(archive?.unblock(String(deviceId)));
            emitChanged();
            return done;
        },
        rename(friendId, nickname) {
            const entry = friends.get(friendId);
            if (!entry) return false;
            if (!validName(nickname)) throw new Error('Enter a name of up to 64 characters.');
            entry.row.nickname = nickname.trim();
            save(friendId, { nickname: entry.row.nickname });
            emitChanged();
            return true;
        },
        setName(name) {
            if (!validName(name)) throw new Error('Enter a name of up to 64 characters.');
            settings = { ...settings, name: name.trim() };
            archive.saveSettings(settings);
            emitChanged();
            return settings.name;
        },
        // UPnP for all friend links. On: each running node asks the router now. Off: from the next start.
        setUpnp(on) {
            settings = { ...settings, upnp: on === true };
            archive.saveSettings(settings);
            if (on === true) for (const entry of friends.values()) entry.node?.enableUpnp();
            emitChanged();
            return settings.upnp;
        },
        // Send one message. Returns { result: 'sending', line } (a session), { result: 'waiting', line } (G7b: no session,
        // the line waits in the outbox), or { result: 'full' | 'removed' | 'unavailable' | 'invalid' }.
        // The receipt comes as the event 'receipt'.
        send(friendId, text) {
            const entry = friends.get(friendId);
            if (!entry || state !== 'open') return { result: 'unavailable' };
            // easy-join: a typed text never has the mark of a stored invite.
            if (!validPmText(text) || isInviteText(text)) return { result: 'invalid' };
            if (entry.row.state === 'removed-you') return { result: 'removed' };
            return post(entry, text);
        },
        // easy-join: "Invite to room". The owner of the current protected room sends a device invite (no host rights)
        // for the saved device ID of the friend, on the session or into the outbox. The caller gives no device ID.
        // Returns the result of send(), or { result: 'not-owner' | 'no-room' | 'no-device' | 'no-address' | 'failed' }.
        invite(friendId) {
            const entry = friends.get(friendId);
            if (!entry || state !== 'open') return { result: 'unavailable' };
            if (entry.row.state === 'removed-you') return { result: 'removed' };
            if (!room) return { result: 'no-room' };
            if (typeof entry.row.deviceId !== 'string' || !entry.row.deviceId) return { result: 'no-device' };
            if (!canInviteTo(entry)) return { result: 'not-owner' };
            let code;
            try {
                code = room.node.createMemberInvite(entry.row.deviceId, { canHost: false });
            } catch (err) {
                log('WARN', `Friend invite not made: ${errText(err)}`);
                return { result: /reachable owner address/.test(errText(err)) ? 'no-address' : 'failed' };
            }
            if (!validInviteCode(code)) { log('WARN', 'Friend invite not made: the code is too large'); return { result: 'failed' }; }
            const answer = post(entry, inviteText(code));
            if (answer.line) log('INFO', `Friend invite ${answer.result === 'waiting' ? 'queued' : 'sent'}`);
            // Diagnostics (main.js journal): the result code only.
            events.emit('invite-sent', { result: answer.result });
            return answer;
        },
        // easy-join: Join of a received invite. Checks the invite again now (the expiry). Returns { state, room, code }:
        // code only for the state 'ok'. state 'gone': no shown invite line with this ID.
        inviteCode(friendId, id) {
            const entry = friends.get(friendId);
            const code = entry?.invites.get(id);
            if (!entry || typeof code !== 'string') return { state: 'gone', room: '' };
            const view = checkInvite(code, { selfId: identity.id, friendDevice: entry.row.deviceId });
            return view.state === 'ok' ? { state: 'ok', room: view.room, code } : { state: view.state, room: view.room };
        },
        // easy-join part 3: the room of the friend for Join. Returns { state: 'ok' | 'ask' | 'gone', room, roomId }.
        // 'ask': the friend cannot forward a knock. 'gone': no room to join (no session, no room, or the same room).
        joinTarget(friendId) {
            const entry = friends.get(friendId);
            const target = entry && state === 'open' && entry.row.state !== 'removed-you' && sessionPeer(entry) ? joinTarget(entry) : null;
            if (!target) return { state: 'gone', room: '', roomId: null };
            return { state: target.route === 'none' ? 'ask' : 'ok', room: target.name, roomId: target.id };
        },
        // easy-join part 3: Join of a friend row. Sends a knock (knock.mjs) over the friend link to the friend: the owner
        // of the room, or a member that forwards it to the owner. Resolves { result: 'allowed', invite, room } (the
        // device invite of Allow, checked) or { result: 'denied' | 'timeout' | 'offline' | 'refused', reason?, room }.
        // onState('waiting'): the owner sees the prompt.
        async knock(friendId, { name = '', onState = () => {} } = {}) {
            const entry = friends.get(friendId);
            const target = entry && state === 'open' && entry.row.state !== 'removed-you' && sessionPeer(entry) ? joinTarget(entry) : null;
            if (!target) return { result: 'offline', room: '' };
            if (target.route === 'none') return { result: 'refused', reason: 'ask', room: target.name };
            if ([...friends.values()].some(e => e.knock)) return { result: 'refused', reason: 'pending', room: target.name };
            const knock = startFriendKnock({
                // The name of the knock: the name for friends, else the name of this friend link.
                room: target, identity, name: name || ownName(archive.getRoom(entry.row.roomId)?.userName), onState,
                send: line => Boolean(sessionPeer(entry) && entry.node?.sendTo(sessionPeer(entry), line)),
                setTimer, clearTimer
            });
            entry.knock = knock;
            let outcome;
            try {
                outcome = await knock.result;
            } finally {
                if (entry.knock === knock) entry.knock = null;
            }
            log('INFO', `Friend knock result: ${outcome.result}${outcome.reason ? ` (${outcome.reason})` : ''}`);
            if (outcome.result !== 'allowed') return { ...outcome, room: target.name };
            try {
                checkFriendAllowedInvite({ roomId: target.id, owner: target.owner }, identity, outcome.invite);
            } catch (err) {
                log('WARN', `Friend knock answer refused: ${errText(err)}`);
                return { result: 'refused', reason: 'error', room: target.name };
            }
            return { result: 'allowed', invite: outcome.invite, room: target.name };
        },
        // easy-join part 3: "Always allow my friends" of the owner: a friend with this device ID that is not blocked.
        isFriend(deviceId) {
            const entry = typeof deviceId === 'string' && state === 'open' ? byDevice(deviceId) : null;
            return Boolean(entry && entry.row.state !== 'removed-you' && !isBlocked(deviceId));
        },
        // The nickname of a friend device, or null.
        nameOf(deviceId) {
            const entry = typeof deviceId === 'string' && state === 'open' ? byDevice(deviceId) : null;
            return entry ? entry.row.nickname : null;
        },
        // The saved lines (pages), with the away mark of each received away line. The first page also has the waiting
        // lines of the outbox (G7b), in time order.
        lines(friendId, before = null) {
            if (!friends.has(friendId)) return [];
            const entry = friends.get(friendId);
            const page = archive.lines(friendId, { before, limit: before ? 100 : 200 })
                .map(({ id, from, text, time, own }) => showLine(entry, { id, from, text, time, own }));
            let marks = new Map();
            try { marks = archive.awayMarks(friendId, page.filter(l => !l.own).map(l => l.id)); }
            catch (err) { log('WARN', `Friend away marks not read: ${errText(err)}`); }
            for (const line of page) if (marks.has(line.id)) line.away = marks.get(line.id);
            if (before) return page;
            let rows = [];
            try { rows = archive.listOutbox(friendId); } catch (err) { log('WARN', `Friend outbox not read: ${errText(err)}`); }
            if (!rows.length) return page;
            const from = ownName(archive.getRoom(friendId)?.userName);
            return [...page, ...rows.map(r => showLine(entry, { id: r.id, from, text: r.text, time: r.time, own: true, waiting: true }))]
                .sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        },
        // G7b: Delete of a waiting line. Returns 'deleted', 'sending' (it is on a session now) or 'gone'.
        deleteWaiting(friendId, id) {
            const entry = friends.get(friendId);
            if (!entry || typeof id !== 'string') return 'gone';
            if (entry.inflight.has(id)) return 'sending';
            try { return archive.deleteOutbox(friendId, id) ? 'deleted' : 'gone'; }
            catch (err) { log('WARN', `Friend line not deleted: ${errText(err)}`); return 'gone'; }
        },
        // G7b: the number of waiting lines of a friend (test and diagnostic use).
        waitingCount(friendId) {
            try { return friends.has(friendId) ? archive.listOutbox(friendId).length : 0; } catch { return 0; }
        },
        friend(friendId) {
            const entry = friends.get(friendId);
            return entry ? friendView(entry) : null;
        },
        // 1.0.6: a profile picture changed: the list again.
        avatarsChanged() { if (state === 'open') emitChanged(); },
        markRead(friendId) {
            const entry = friends.get(friendId);
            if (!entry || entry.unread === 0) return;
            entry.unread = 0;
            emitChanged();
        },
        // Test and diagnostic use: the node of a friend.
        nodeOf: friendId => friends.get(friendId)?.node ?? null,
        // Stop all friend nodes. The caller keeps the 3 s quit limit.
        async stop() {
            stopped = true;
            for (const timer of startTimers) clearTimer(timer);
            startTimers.clear();
            clearTimer(askTimer);
            clearTimer(repeatTimer);
            askTimer = repeatTimer = null;
            for (const item of [...asks.values(), ...forwards.values()]) clearTimer(item.timer);
            asks.clear();
            forwards.clear();
            if (room) { room.off(); room.requests.stop(); room = null; }
            await Promise.all([...friends.values()].map(stopNode));
            state = 'stopped';
            archive = null;
        }
    };
}

// 1.0.6: the test flag --friend-test of the check scripts (main.js, only in a dev start). value: a list with commas of
// 'port=<n>' (the first friend port; 0: port 0 for each friend node), 'no-inbound' (the friend nodes listen on no
// address: a PC behind NAT), 'no-mdns' (no mDNS on the friend nodes: friends on other networks) and 'no-ask' (no
// address refresh). Returns the options for createFriendLinks; an unknown item is ignored.
export function friendTestOptions(value) {
    const out = {};
    for (const item of String(value ?? '').split(',').map(x => x.trim()).filter(Boolean)) {
        const port = /^port=(\d{1,5})$/.exec(item);
        if (port && Number(port[1]) <= 65535 - FRIEND_CAP) out.basePort = Number(port[1]);
        else if (item === 'no-inbound') out.listen = [];
        else if (item === 'no-mdns') out.discovery = false;
        else if (item === 'no-ask') out.refresh = false;
    }
    return out;
}
