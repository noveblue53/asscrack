// Full-node check (design rule 1). A node asks a connected peer to dial back to its listen port.
// The peer opens a new TCP connection with node:net to the remote IP of its libp2p connection to the node.
// It never dials another IP (it is not a port scanner).
import net from 'node:net'

export const DIALBACK_PROTOCOL = '/asscrack/dialback/1.0.0'
const DIALBACK_TIMEOUT_MS = 3000
const MAX_LINE = 256

const enc = new TextEncoder()

// Returns { ip, port } of a TCP multiaddr with no /p2p-circuit, else null.
export function tcpTarget(ma) {
    const text = ma.toString()
    if (text.includes('/p2p-circuit')) return null
    const m = /^\/(ip4|ip6)\/([^/]+)\/tcp\/(\d+)/.exec(text)
    if (!m) return null
    return { ip: m[2], port: Number(m[3]) }
}

export function isPrivateIp(ip) {
    if (typeof ip !== 'string') return true
    let v = ip.toLowerCase()
    if (v.startsWith('::ffff:')) v = v.slice(7)
    if (net.isIPv4(v)) {
        const [a, b] = v.split('.').map(Number)
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    }
    if (net.isIPv6(v)) {
        return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') ||
            v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff')
    }
    return true
}

// L1 (P10a): a private network address that a friend on the same LAN can have (not loopback, not multicast).
function isLanIp(ip) {
    let v = ip.toLowerCase()
    if (v.startsWith('::ffff:')) v = v.slice(7)
    if (net.isIPv4(v)) {
        const [a, b] = v.split('.').map(Number)
        return a === 10 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127)
    }
    return net.isIPv6(v) && /^(fc|fd|fe[89ab])/.test(v)
}

// L1 (P10a): an address that a peer gives for its node. Only /ip4 or /ip6 with an IP, then /tcp/<port 1..65535>, then
// an optional /p2p/<id>. No /dns*, no /unix, no /p2p-circuit. A public IP always. A LAN IP only with allowLan (a friend
// on the same network). Each private or loopback IP only with allowPrivate (the 127.0.0.1 tests).
export function peerAddrAllowed(addr, { allowPrivate = false, allowLan = false } = {}) {
    const m = /^\/(ip4|ip6)\/([^/]+)\/tcp\/(\d{1,5})(\/p2p\/[1-9A-HJ-NP-Za-km-z]+)?$/.exec(String(addr))
    if (!m) return false
    const port = Number(m[3])
    if (port < 1 || port > 65535 || !(m[1] === 'ip4' ? net.isIPv4(m[2]) : net.isIPv6(m[2]))) return false
    return allowPrivate || !isPrivateIp(m[2]) || (allowLan && isLanIp(m[2]))
}

async function readLine(source) {
    const buf = Buffer.alloc(MAX_LINE)
    let length = 0
    for await (const chunk of source) {
        // Coalescing a whole transport chunk here would defeat the message size limit.
        const prefix = chunk.subarray(0, Math.min(chunk.byteLength, MAX_LINE - length + 1))
        const newline = prefix.indexOf(10)
        const count = newline === -1 ? prefix.length : newline
        if (length + count > MAX_LINE) throw new Error('Dial-back header too long')
        buf.set(prefix.subarray(0, count), length)
        length += count
        if (newline !== -1) break
    }
    return length ? buf.toString('utf8', 0, length) : null
}

function tryTcp(host, port, timeoutMs) {
    return new Promise(resolve => {
        const socket = net.connect({ host, port })
        const finish = ok => { socket.destroy(); resolve(ok) }
        socket.setTimeout(timeoutMs, () => finish(false))
        socket.once('connect', () => finish(true))
        socket.once('error', () => finish(false))
    })
}

// The peer side: answer a dial-back request.
export function handleDialback({ stream, connection }) {
    const timeout = setTimeout(() => stream.abort(new Error('Dial-back request timed out')), DIALBACK_TIMEOUT_MS * 2)
    timeout.unref()
    return (async () => {
        let answer = { ok: false }
        try {
            const line = await readLine(stream.source)
            const request = line ? JSON.parse(line) : null
            const port = request?.port
            const target = tcpTarget(connection.remoteAddr)
            if (target && Number.isInteger(port) && port > 0 && port < 65536) {
                answer = { ok: await tryTcp(target.ip, port, DIALBACK_TIMEOUT_MS), ip: target.ip }
            }
        } catch { /* answer failed */ }
        await stream.sink([enc.encode(JSON.stringify(answer) + '\n')])
    })().catch(() => stream.abort?.(new Error('dial-back failed'))).finally(() => clearTimeout(timeout))
}

// The node side: ask the peer on this connection to dial back to port. Returns { ok, ip }.
export async function requestDialback(connection, port) {
    const stream = await connection.newStream(DIALBACK_PROTOCOL, { runOnTransientConnection: true, signal: AbortSignal.timeout(DIALBACK_TIMEOUT_MS) })
    const timeout = setTimeout(() => stream.abort(new Error('Dial-back reply timed out')), DIALBACK_TIMEOUT_MS * 2)
    timeout.unref()
    try {
        await stream.sink([enc.encode(JSON.stringify({ port }) + '\n')])
        const line = await readLine(stream.source)
        const answer = line ? JSON.parse(line) : null
        return { ok: answer?.ok === true, ip: typeof answer?.ip === 'string' ? answer.ip : null }
    } finally {
        clearTimeout(timeout)
        stream.close().catch(() => {})
    }
}

// The public IP from the identify observed addresses, else null.
export function observedIp(libp2p) {
    const addrs = libp2p.components?.addressManager?.getObservedAddrs?.() ?? []
    for (const ma of addrs) {
        const t = tcpTarget(ma)
        if (t) return t.ip
    }
    return null
}
