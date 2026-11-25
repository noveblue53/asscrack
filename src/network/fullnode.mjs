// Full-node check (design rule 1). A node asks a connected peer to dial back to its listen port.
// The peer opens a new TCP connection with node:net to the remote IP of its libp2p connection to the node.
// It never dials another IP (it is not a port scanner).
import net from 'node:net'

export const DIALBACK_PROTOCOL = '/asscrack/dialback/1.0.0'
const DIALBACK_TIMEOUT_MS = 3000
const MAX_LINE = 256

const enc = new TextEncoder()

// Returns { family, ip, port } of a TCP multiaddr with no /p2p-circuit, else null.
export function tcpTarget(ma) {
    if (ma == null) return null
    const text = ma.toString()
    if (text.includes('/p2p-circuit')) return null
    const m = /^\/(ip4|ip6)\/([^/]+)\/tcp\/(\d+)/.exec(text)
    if (!m) return null
    const port = Number(m[3])
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    if (!(m[1] === 'ip4' ? net.isIPv4(m[2]) : net.isIPv6(m[2]))) return null
    return { family: m[1], ip: m[2], port }
}

function parseIpv6(ip) {
    if (typeof ip !== 'string') return null
    const v = ip.toLowerCase()
    if (!net.isIPv6(v)) return null
    const parts = v.split('::')
    if (parts.length > 2) return null
    const parseSide = side => {
        if (!side) return []
        const tokens = side.split(':')
        const out = []
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i]
            if (tok.includes('.')) {
                if (i !== tokens.length - 1 || !net.isIPv4(tok)) return null
                const [a, b, c, d] = tok.split('.').map(Number)
                out.push((a << 8) | b, (c << 8) | d)
            } else {
                const n = Number.parseInt(tok, 16)
                if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null
                out.push(n)
            }
        }
        return out
    }
    const left = parseSide(parts[0])
    if (!left) return null
    if (parts.length === 1) return left.length === 8 ? Uint16Array.from(left) : null
    const right = parseSide(parts[1])
    if (!right || left.length + right.length > 7) return null
    const out = new Uint16Array(8)
    out.set(left, 0)
    out.set(right, 8 - right.length)
    return out
}

function isIpv4Private(a, b) {
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
}

function isIpv4Lan(a, b) {
    return a === 10 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127)
}

// Global unicast IPv6 (2000::/3). Excludes ::, ::1, fe80::/10 link-local, fc00::/7 ULA, ff00::/8 multicast, and ::ffff:0:0/96.
export function isGlobalUnicastIpv6(ip) {
    const h = parseIpv6(ip)
    return h !== null && (h[0] & 0xe000) === 0x2000
}

export function isPrivateIp(ip) {
    if (typeof ip !== 'string') return true
    const v = ip.toLowerCase()
    if (net.isIPv4(v)) {
        const [a, b] = v.split('.').map(Number)
        return isIpv4Private(a, b)
    }
    const h = parseIpv6(v)
    if (!h) return true
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
        return isIpv4Private(h[6] >> 8, h[6] & 0xff)
    }
    return !isGlobalUnicastIpv6(v)
}

// L1 (P10a): a private network address that a friend on the same LAN can have (not loopback, not multicast).
function isLanIp(ip) {
    if (typeof ip !== 'string') return false
    const v = ip.toLowerCase()
    if (net.isIPv4(v)) {
        const [a, b] = v.split('.').map(Number)
        return isIpv4Lan(a, b)
    }
    const h = parseIpv6(v)
    if (!h) return false
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
        return isIpv4Lan(h[6] >> 8, h[6] & 0xff)
    }
    return (h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80
}

// L1 (P10a): an address that a peer gives for its node. Only /ip4 or /ip6 with an IP, then /tcp/<port 1..65535>, then
// an optional /p2p/<id>. No /dns*, no /unix, no /p2p-circuit. A public IP always. A LAN IP only with allowLan (a friend
// on the same network). Each private or loopback IP only with allowPrivate (the 127.0.0.1 / ::1 tests).
export function peerAddrAllowed(addr, { allowPrivate = false, allowLan = false } = {}) {
    const m = /^\/(ip4|ip6)\/([^/]+)\/tcp\/(\d{1,5})(\/p2p\/[1-9A-HJ-NP-Za-km-z]+)?$/.exec(String(addr))
    if (!m) return false
    const port = Number(m[3])
    if (port < 1 || port > 65535 || !(m[1] === 'ip4' ? net.isIPv4(m[2]) : net.isIPv6(m[2]))) return false
    if (allowPrivate) return true
    if (m[1] === 'ip6') return isGlobalUnicastIpv6(m[2]) || (allowLan && isLanIp(m[2]))
    return !isPrivateIp(m[2]) || (allowLan && isLanIp(m[2]))
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

export function tryTcp(host, port, timeoutMs = DIALBACK_TIMEOUT_MS) {
    return new Promise(resolve => {
        const family = net.isIPv6(host) ? 6 : (net.isIPv4(host) ? 4 : undefined)
        const socket = net.connect({ host, port, ...(family ? { family } : {}) })
        let done = false
        const finish = ok => {
            if (done) return
            done = true
            socket.destroy()
            resolve(ok)
        }
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
                answer = { ok: await tryTcp(target.ip, port, DIALBACK_TIMEOUT_MS), ip: target.ip, family: target.family }
            }
        } catch { /* answer failed */ }
        await stream.sink([enc.encode(JSON.stringify(answer) + '\n')])
    })().catch(() => stream.abort?.(new Error('dial-back failed'))).finally(() => clearTimeout(timeout))
}

// The node side: ask the peer on this connection to dial back to port. Returns { ok, ip, family }.
export async function requestDialback(connection, port) {
    const stream = await connection.newStream(DIALBACK_PROTOCOL, { runOnTransientConnection: true, signal: AbortSignal.timeout(DIALBACK_TIMEOUT_MS) })
    const timeout = setTimeout(() => stream.abort(new Error('Dial-back reply timed out')), DIALBACK_TIMEOUT_MS * 2)
    timeout.unref()
    try {
        await stream.sink([enc.encode(JSON.stringify({ port }) + '\n')])
        const line = await readLine(stream.source)
        const answer = line ? JSON.parse(line) : null
        const ip = typeof answer?.ip === 'string' ? answer.ip : null
        const family = answer?.family === 'ip4' || answer?.family === 'ip6'
            ? answer.family
            : (ip ? (net.isIPv6(ip) ? 'ip6' : (net.isIPv4(ip) ? 'ip4' : null)) : null)
        return { ok: answer?.ok === true, ip, family }
    } finally {
        clearTimeout(timeout)
        stream.close().catch(() => {})
    }
}

// The public IP from the identify observed addresses (filtered by family when given), else fallback or null.
export function observedIp(libp2p, family = null) {
    const addrs = libp2p.components?.addressManager?.getObservedAddrs?.() ?? []
    let fallback = null
    for (const ma of addrs) {
        const t = tcpTarget(ma)
        if (!t || (family && t.family !== family)) continue
        const isPublic = t.family === 'ip6' ? isGlobalUnicastIpv6(t.ip) : !isPrivateIp(t.ip)
        if (isPublic) return t.ip
        if (!fallback) fallback = t.ip
    }
    return fallback
}
