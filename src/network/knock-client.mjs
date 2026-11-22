// easy-join part 2: the knock of a room code over the network. A short-lived libp2p node (no listen address) finds the
// owner, does the knock (knock.mjs) and stops. The room node starts only after Allow, with the device invite of the
// answer. The order of the paths: the addresses of the owner in the code (direct, or a relay circuit to the owner),
// then the same addresses with no peer ID (the owner started again with a new peer ID), then the peers that mDNS finds
// with the tag of the room (a LAN room, or two copies on one network). The node does not answer mDNS queries, thus the
// room nodes do not dial it.
import { tcp } from '@libp2p/tcp'
import { mdns } from '@libp2p/mdns'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { identify } from '@libp2p/identify'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { multiaddr } from '@multiformats/multiaddr'
import { createStreamCompatibleLibp2p } from './libp2p-streams.mjs'
import { roomCodeAccess } from './room-membership.mjs'
import { createKnocker, KNOCK_LIMITS, KNOCK_PROTOCOL } from './knock.mjs'
import { knockChannel } from './knock-stream.mjs'

const DIAL_MS = 8000
const DISCOVERY_MS = 4000
// The answer of the owner can be a device invite of some kilobytes.
const READ_LIMITS = { maxLineBytes: 64 * 1024, maxStreamBytes: 256 * 1024 }

// The dial addresses of the code, in order: [{ addr, peer }] (peer: the expected peer ID, or null for a bare address).
export function knockTargets(code) {
    const owner = code.ownerPeer
    const first = []
    const bare = []
    for (const node of code.nodes) {
        for (const addr of node.addrs) {
            const plain = addr.replace(/\/p2p\/[^/]+$/, '')
            if (addr.includes('/p2p-circuit')) first.push({ addr: `${plain}/p2p/${owner}`, peer: owner })
            else if (node.id === owner) {
                first.push({ addr: `${plain}/p2p/${owner}`, peer: owner })
                bare.push({ addr: plain, peer: null })
            } else first.push({ addr: `${plain}/p2p/${node.id}/p2p-circuit/p2p/${owner}`, peer: owner })
        }
    }
    const seen = new Set()
    return [...first, ...bare].filter(t => !seen.has(t.addr) && seen.add(t.addr))
}

// code: the value of readRoomCode. serviceTag: the mDNS tag of the room (keyedServiceTag), or null for no mDNS.
// onState('looking' | 'waiting'). Returns { result: 'allowed', invite } | { result: 'denied' | 'timeout' | 'offline' } |
// { result: 'refused', reason }. 'offline': no peer proved the owner key.
export async function knockRoom({ code, identity, name, serviceTag = null, onState = () => {}, dialMs = DIAL_MS,
    discoveryMs = DISCOVERY_MS, waitMs = KNOCK_LIMITS.promptMs + 30000, log = () => {} }) {
    const access = roomCodeAccess(code.room, code.key, code.owner, code.lan)
    const node = await createStreamCompatibleLibp2p({
        start: false,
        addresses: { listen: [] },
        transports: [tcp(), circuitRelayTransport()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: { identify: identify() },
        peerDiscovery: serviceTag ? [mdns({ serviceTag, broadcast: false, interval: 1000 })] : [],
        connectionManager: { minConnections: 0, maxConnections: 16 }
    })
    const found = []
    node.addEventListener('peer:discovery', ({ detail }) => { found.push(detail.id) })
    await node.start()
    onState('looking')
    try {
        const tried = new Set()
        for (const target of knockTargets(code)) {
            const outcome = await tryTarget(target.addr, target.peer)
            if (outcome) return outcome
        }
        // mDNS: each peer of the room tag, until discoveryMs after the last direct try.
        const until = Date.now() + (serviceTag ? discoveryMs : 0)
        while (Date.now() < until || found.length) {
            const peer = found.shift()
            if (!peer) {
                await new Promise(resolve => setTimeout(resolve, 200))
                continue
            }
            const id = peer.toString()
            if (tried.has(id)) continue
            tried.add(id)
            const outcome = await tryTarget(peer, id)
            if (outcome) return outcome
        }
        return { result: 'offline' }

        // Returns the end result, or null when this peer is not the owner (or did not answer).
        async function tryTarget(target, peer) {
            if (peer) tried.add(peer)
            let connection
            try {
                connection = await node.dial(typeof target === 'string' ? multiaddr(target) : target, { signal: AbortSignal.timeout(dialMs) })
            } catch (err) {
                log(`Knock dial failed: ${err?.message ?? err}`)
                return null
            }
            const remote = connection.remotePeer.toString()
            if (tried.has(remote) && remote !== peer) return null
            tried.add(remote)
            let stream
            try {
                stream = await connection.newStream(KNOCK_PROTOCOL, { runOnTransientConnection: true, signal: AbortSignal.timeout(dialMs) })
            } catch (err) {
                log(`Knock stream refused by ${remote}: ${err?.message ?? err}`)
                return null
            }
            return run(stream)
        }

        function run(stream) {
            const knocker = createKnocker({ code, access, identity, name })
            return new Promise(resolve => {
                let settled = false
                let timer = null
                const finish = value => {
                    if (settled) return
                    settled = true
                    clearTimeout(timer)
                    channel.end()
                    resolve(value)
                }
                const arm = ms => {
                    clearTimeout(timer)
                    timer = setTimeout(() => finish(knocker.provedOwner() ? { result: 'timeout' } : null), ms)
                }
                const channel = knockChannel(stream, {
                    ...READ_LIMITS,
                    onLine: message => {
                        const step = knocker.receive(message)
                        if (step.send) {
                            channel.send(step.send)
                            arm(waitMs)
                        }
                        if (step.waiting) onState('waiting')
                        if (step.done) finish(step.done.result === 'not-owner' ? null : step.done)
                    },
                    // The stream ended with no result: the owner left, or this peer is not the owner.
                    onClose: () => finish(knocker.provedOwner() ? { result: 'timeout' } : null)
                })
                arm(KNOCK_LIMITS.stepMs)
                channel.send(knocker.hello())
            })
        }
    } finally {
        await node.stop().catch(() => {})
    }
}
