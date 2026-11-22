// Test helper for the timed screen share checks (work-orders/astra/P8/DESIGN.md, section 6, W2). From the design
// prototype scratch/proto/throttle-proxy2.mjs. A TCP proxy on 127.0.0.1 with a byte rate limit, a bounded queue and
// an optional fixed delay for each direction. It gives a link with a known capacity between two libp2p nodes on one
// computer. The rate of each direction can change during a run (setRate). It is not a real slow network.
import net from 'node:net'

function shaper({ rate, queueBytes, delayMs, write, pause, resume }) {
    const queue = [] // { at, data }
    let queued = 0
    let tokens = 0
    let last = performance.now()
    let paused = false
    let closed = false
    let passed = 0
    function pump() {
        if (closed) return
        const now = performance.now()
        const bytesPerSecond = rate()
        const burst = Math.max(1500, bytesPerSecond * 0.02)
        // No limit: only the delay and the byte counters apply.
        tokens = Number.isFinite(bytesPerSecond) ? Math.min(burst, tokens + (now - last) / 1000 * bytesPerSecond) : Infinity
        last = now
        while (queue.length && queue[0].at <= now && tokens >= 1) {
            const head = queue[0]
            const take = Math.min(head.data.length, Math.floor(tokens))
            write(head.data.subarray(0, take))
            passed += take
            tokens -= take
            queued -= take
            if (take === head.data.length) queue.shift()
            else head.data = head.data.subarray(take)
        }
        if (paused && queued < queueBytes / 2) { paused = false; resume() }
    }
    const timer = setInterval(pump, 4)
    return {
        push(data) {
            queue.push({ at: performance.now() + delayMs, data })
            queued += data.length
            if (!paused && queued >= queueBytes) { paused = true; pause() }
            if (!Number.isFinite(rate())) { tokens = Infinity; pump() }
        },
        passed: () => passed,
        close() { closed = true; clearInterval(timer) }
    }
}

// up: the direction client -> target. down: target -> client.
export async function createThrottleProxy({ targetPort, targetHost = '127.0.0.1', up = Infinity, down = Infinity,
    queueBytes = 64 * 1024, delayMs = 0 }) {
    const sockets = new Set()
    const totals = { up: 0, down: 0 }
    const rates = { up, down }
    const server = net.createServer(client => {
        const target = net.connect({ host: targetHost, port: targetPort })
        client.setNoDelay(true)
        target.setNoDelay(true)
        sockets.add(client); sockets.add(target)
        const upShaper = shaper({ rate: () => rates.up, queueBytes, delayMs,
            write: d => { totals.up += d.length; target.write(d) }, pause: () => client.pause(), resume: () => client.resume() })
        const downShaper = shaper({ rate: () => rates.down, queueBytes, delayMs,
            write: d => { totals.down += d.length; client.write(d) }, pause: () => target.pause(), resume: () => target.resume() })
        client.on('data', d => upShaper.push(d))
        target.on('data', d => downShaper.push(d))
        const end = () => { upShaper.close(); downShaper.close(); client.destroy(); target.destroy(); sockets.delete(client); sockets.delete(target) }
        client.on('close', end); target.on('close', end)
        client.on('error', end); target.on('error', end)
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    return {
        port: server.address().port,
        totals,
        setRate(direction, bytesPerSecond) { rates[direction] = bytesPerSecond },
        async close() {
            for (const s of sockets) s.destroy()
            await new Promise(resolve => server.close(resolve))
        }
    }
}
