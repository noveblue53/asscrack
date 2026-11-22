// G7a: the friend links of the main process (design F1 to F9, DECISIONS.md G7a). This module does not import electron.
// Each friend is a saved protected 2-person room with its own background node. The friend nodes run from the start
// of the archive to Quit, on the login screen and in a room. The room node, Leave room and a new login do not stop
// them. The room node gives only the friend requests (attachRoom).
// Events: 'changed' (list()), 'line' { friendId, line }, 'request' (a request event), 'receipt' { friendId, id, result }.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { newRoomKey } from '../network/invite.mjs';
import { createRoomMembership, restoreRoomMembership } from '../network/room-membership.mjs';
import { createFriendRequests, validName } from '../network/friend-requests.mjs';
import { createPrivateMessages, validPmText } from '../network/private-messages.mjs';
import { observedIp } from '../network/fullnode.mjs';
import { restoreSavedAdmission } from './room-admission.mjs';
import { isAddressInUse } from './login-errors.mjs';

// The cap and the ports (design F2). 32 needs the interface cache of main.js (interface-cache.mjs, DECISIONS.md G7a).
export const FRIEND_CAP = 32;
export const FRIEND_BASE_PORT = 47200;
export const FRIEND_START_STEP_MS = 500;
const MAX_NODES = 16;
const MAX_ADDRS = 16;

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
// The test options: basePort, cap, startStep, ackMs, now, setTimer, clearTimer, candidates (false: no candidate).
export function createFriendLinks({ createNode, hintFiles = null, nodeOptions = {}, log = () => {},
    basePort = FRIEND_BASE_PORT, cap = FRIEND_CAP, startStep = FRIEND_START_STEP_MS, ackMs, requestMs, rateMs,
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, candidates = true, discovery = true } = {}) {
    const events = new EventEmitter();
    let identity = null;
    let archive = null;
    let state = 'stopped'; // 'stopped' | 'locked' | 'open'
    let stopped = false;
    let settings = { name: null, upnp: false };
    const friends = new Map(); // roomId -> entry
    const waiting = new Map(); // peerId -> { id, name } (requests of this device that wait)
    const startTimers = new Set();
    let room = null; // { node, requests, off() }

    const emitChanged = () => events.emit('changed', list());
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

    function friendView(entry) {
        const online = sessionPeer(entry) !== null;
        return {
            friendId: entry.row.roomId, name: entry.row.nickname, unread: entry.unread,
            state: entry.row.state === 'removed-you' ? 'removed-you' : online ? 'online' : 'offline',
            lastSeen: entry.row.lastSeen ?? null
        };
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
            if (!archive?.updateMembership(entry.row.roomId, snapshot)) throw new Error('Could not save friend access.');
        });
        let storePath = null;
        if (hintFiles) {
            storePath = hintFiles(saved.name, saved.roomKey).peers;
            try { mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 }); } catch { storePath = null; }
        }
        const options = {
            room: saved.name, roomKey: saved.roomKey, membership, name: ownName(saved.userName),
            port: basePort + entry.row.slot, upnp: settings.upnp === true, inviteNodes: entry.row.addrs, storePath,
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
        entry.pm = createPrivateMessages({
            selfDevice: identity.id, friendDevice: entry.row.deviceId, sessionPeer: () => sessionPeer(entry),
            sendTo: (peerId, line) => node.sendTo(peerId, line),
            seen: id => { try { return archive.hasLine(entry.row.roomId, id); } catch { return false; } },
            receive: msg => {
                const line = { id: msg.id, from: entry.row.nickname, text: msg.text, time: msg.time, own: false };
                try {
                    archive.addLine(entry.row.roomId, { ...line, source: 'live', peerId: null });
                } catch (err) {
                    log('WARN', `Friend line not saved: ${errText(err)}`);
                }
                entry.unread += 1;
                events.emit('line', { friendId: entry.row.roomId, line });
                emitChanged();
            },
            acked: (id, result) => events.emit('receipt', { friendId: entry.row.roomId, id, result }),
            unfriended: () => removedYou(entry),
            now, setTimer, clearTimer, ...(ackMs ? { timeoutMs: ackMs } : {})
        });
        const opened = ({ peerId }) => {
            if (node.deviceOf(peerId) !== entry.row.deviceId || entry.peerId === peerId) return;
            entry.peerId = peerId;
            entry.row.lastSeen = now();
            save(entry.row.roomId, { lastSeen: entry.row.lastSeen });
            emitChanged();
        };
        node.events.on('peer-joined', opened);
        node.events.on('membership', () => { for (const peerId of node.peers()) opened({ peerId }); });
        node.events.on('peer-left', ({ peerId }) => {
            if (entry.peerId !== peerId) return;
            entry.peerId = null;
            entry.row.lastSeen = now();
            save(entry.row.roomId, { lastSeen: entry.row.lastSeen });
            emitChanged();
        });
        node.events.on('pm', data => entry.pm?.handle(data));
        // A proved address of the friend: keep it for each start (design F5 item 2).
        node.events.on('full-node-addrs', ({ peerId, addrs }) => {
            if (node.deviceOf(peerId) !== entry.row.deviceId || !Array.isArray(addrs)) return;
            entry.row.addrs = mergeNodes(entry.row.addrs, [{ id: peerId, addrs: addrs.filter(a => !a.includes('/p2p-circuit')) }]);
            save(entry.row.roomId, { addrs: entry.row.addrs });
        });
        node.events.on('upnp', emitChanged);
        node.events.on('full-node', emitChanged);
        emitChanged();
    }

    async function stopNode(entry) {
        const node = entry.node;
        entry.node = null;
        entry.peerId = null;
        entry.pm?.stop();
        entry.pm = null;
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
            startNode(entry).catch(err => log('WARN', `Friend node not started: ${errText(err)}`));
        }, delay);
        startTimers.add(timer);
    }

    // ---- The grant (design F3 steps 3 and 4) ----

    function checkRoomForNew(deviceId) {
        if (state !== 'open') throw new Error('Friends need the protected storage of this computer.');
        if (byDevice(deviceId)) throw new Error('already a friend');
        if (isBlocked(deviceId)) throw new Error('blocked');
        const slot = freeSlot();
        if (slot < 0) throw new Error('friend limit');
        return slot;
    }

    function addEntry(row) {
        const entry = { row, node: null, pm: null, peerId: null, port: null, unread: 0 };
        friends.set(row.roomId, entry);
        return entry;
    }

    function forget(entry) {
        friends.delete(entry.row.roomId);
        try { archive?.removeFriendRoom(entry.row.roomId); }
        catch (err) { log('WARN', `Friend room not removed: ${errText(err)}`); }
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
            friend: { deviceId, nickname: validName(name) ? name.trim() : 'Friend', slot, addrs: [] } });
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
        const addrs = candidates ? mergeNodes(grant.nodes, fromRoom) : [];
        const { roomId } = archive.saveFriendRoom({ name: grant.room, roomKey: grant.key, userName: ownName(roomNode.name),
            membership: membership.snapshot(), friend: { deviceId, nickname: validName(name) ? name.trim() : 'Friend', slot, addrs } });
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

    // A: the done line of B. Keep the candidates of B and dial them one time.
    function ownerDone(roomNode, peerId, deviceId, port, nodes) {
        const entry = byDevice(deviceId);
        if (!entry || !candidates) return;
        const id = nodes[0]?.id;
        const more = mergeNodes(nodes, id ? [{ id, addrs: connectionCandidates(roomNode, peerId, port) }] : []);
        entry.row.addrs = mergeNodes(entry.row.addrs, more);
        save(entry.row.roomId, { addrs: entry.row.addrs });
        for (const node of more) for (const addr of node.addrs) {
            entry.node?.connect(`${addr}/p2p/${node.id}`).catch(() => {});
        }
    }

    function requestEvent(event) {
        if (event.kind === 'outgoing') waiting.set(event.peerId, { id: event.id, name: event.name });
        if (event.kind === 'ended' && event.side === 'out') waiting.delete(event.peerId);
        events.emit('request', { kind: event.kind, id: event.id, name: event.name ?? '', side: event.side ?? null,
            result: event.result ?? null });
        emitChanged();
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
        attachRoom(node) {
            if (room) {
                room.off();
                room.requests.stop();
                room = null;
                waiting.clear();
            }
            if (!node || stopped || !node.memberState?.().protected) { emitChanged(); return; }
            const requests = createFriendRequests({
                send: (peerId, line) => node.sendTo(peerId, line),
                isBlocked,
                makeGrant: ({ peerId, deviceId, name }) => ownerGrant(node, peerId, deviceId, name)
                    .catch(err => { log('WARN', `Friend grant not made: ${errText(err)}`); throw err; }),
                acceptGrant: ({ peerId, deviceId, name, grant }) => receiveGrant(node, peerId, deviceId, name, grant)
                    .catch(err => { log('WARN', `Friend grant refused: ${errText(err)}`); throw err; }),
                done: ({ peerId, deviceId, port, nodes }) => ownerDone(node, peerId, deviceId, port, nodes),
                undo: ({ deviceId }) => {
                    const entry = byDevice(deviceId);
                    if (entry) stopNode(entry).then(() => { forget(entry); emitChanged(); });
                },
                changed: requestEvent,
                now, setTimer, clearTimer, ...(requestMs ? { requestMs } : {}), ...(rateMs ? { rateMs } : {})
            });
            const onFriend = data => requests.handle(data);
            const onLeft = ({ peerId }) => requests.closed(peerId);
            node.events.on('friend', onFriend);
            node.events.on('peer-left', onLeft);
            room = { node, requests, off() { node.events.off('friend', onFriend); node.events.off('peer-left', onLeft); } };
            emitChanged();
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
            catch (err) { log('WARN', `Block not saved: ${errText(err)}`); throw new Error('Could not save the block.'); }
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
        // Send one message. Returns { result: 'sending', line } or { result: 'unavailable' | 'invalid' }.
        // The receipt comes as the event 'receipt'.
        send(friendId, text) {
            const entry = friends.get(friendId);
            if (!entry?.pm) return { result: 'unavailable' };
            if (!validPmText(text)) return { result: 'invalid' };
            if (!sessionPeer(entry)) return { result: 'unavailable' };
            const id = entry.pm.newId();
            const time = now();
            const saved = archive.getRoom(friendId);
            const line = { id, from: ownName(saved?.userName), text, time, own: true };
            entry.pm.send(id, text, { time }).then(result => {
                if (result === 'unavailable' || result === 'invalid') events.emit('receipt', { friendId, id, result });
            });
            try { archive.addLine(friendId, { ...line, source: 'send', peerId: null }); }
            catch (err) { log('WARN', `Friend line not saved: ${errText(err)}`); }
            return { result: 'sending', line };
        },
        lines(friendId, before = null) {
            if (!friends.has(friendId)) return [];
            return archive.lines(friendId, { before, limit: before ? 100 : 200 })
                .map(({ id, from, text, time, own }) => ({ id, from, text, time, own }));
        },
        friend(friendId) {
            const entry = friends.get(friendId);
            return entry ? friendView(entry) : null;
        },
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
            if (room) { room.off(); room.requests.stop(); room = null; }
            await Promise.all([...friends.values()].map(stopNode));
            state = 'stopped';
            archive = null;
        }
    };
}
