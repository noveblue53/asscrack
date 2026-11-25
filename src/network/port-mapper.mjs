// Use the UPnP transport directly, with NAT-PMP fallback when UPnP fails. The node owns the TCP lease and its renewal timer.
import UPnP from '@silentbot1/nat-api/lib/upnp/index.js'
import NatPMP from '@silentbot1/nat-api/lib/pmp/index.js'
import { gateway4sync } from 'default-gateway'

export function createPortMapper(client = new UPnP(), options = {}) {
    const pmpOption = options.pmp
    const pmpTimeout = options.pmpTimeout ?? 2000
    let mode = 'upnp'
    let pmpClient = null
    let closed = false

    function mapping({ publicPort, localPort, localAddress, ttl }) {
        return {
            public: publicPort,
            private: { port: localPort, host: localAddress },
            protocol: 'TCP',
            description: 'ASSCRACK',
            ttl
        }
    }

    function pmpMapping({ publicPort, localPort, ttl }) {
        return {
            public: publicPort,
            private: localPort,
            type: 'tcp',
            ttl
        }
    }

    function pmpAllowed() {
        return !closed && pmpOption !== false && pmpOption !== null
    }

    function ensurePmp() {
        if (pmpClient) return pmpClient
        if (!pmpAllowed()) return null
        const created = typeof pmpOption === 'function'
            ? pmpOption()
            : (pmpOption ?? new NatPMP(gateway4sync().gateway))
        if (!created) return null
        created.on?.('error', () => {})
        pmpClient = created
        return pmpClient
    }

    async function closePmp() {
        const pmp = pmpClient
        pmpClient = null
        if (typeof pmp?.close === 'function') {
            try { await pmp.close() } catch { /* ignore */ }
        }
    }

    async function callPmp(pmp, fn) {
        let timer
        let onError
        try {
            return await Promise.race([
                Promise.resolve().then(() => fn(pmp)),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('NAT-PMP timeout')), pmpTimeout)
                    timer.unref?.()
                    if (typeof pmp?.once === 'function') {
                        onError = err => reject(err instanceof Error ? err : new Error(String(err)))
                        pmp.once('error', onError)
                    }
                })
            ])
        } finally {
            clearTimeout(timer)
            if (onError) {
                if (typeof pmp?.off === 'function') pmp.off('error', onError)
                else pmp?.removeListener?.('error', onError)
            }
        }
    }

    return {
        async externalIp() {
            if (mode === 'pmp') {
                const pmp = ensurePmp()
                if (!pmp) throw new Error('NAT-PMP closed')
                return callPmp(pmp, p => p.externalIp())
            }
            try {
                return await client.externalIp()
            } catch (upnpErr) {
                if (!pmpAllowed()) throw upnpErr
                try {
                    const pmp = ensurePmp()
                    if (!pmp) throw upnpErr
                    const ip = await callPmp(pmp, p => p.externalIp())
                    if (!closed && typeof ip === 'string' && ip.length > 0) {
                        mode = 'pmp'
                        return ip
                    }
                } catch {
                    // Fall through to cleanup and rethrow original UPnP error.
                }
                await closePmp()
                throw upnpErr
            }
        },
        async map(opts) {
            if (mode === 'pmp') {
                const pmp = ensurePmp()
                if (!pmp) throw new Error('NAT-PMP closed')
                return callPmp(pmp, p => p.portMapping(pmpMapping(opts)))
            }
            try {
                return await client.portMapping(mapping(opts))
            } catch (upnpErr) {
                if (!pmpAllowed()) throw upnpErr
                try {
                    const pmp = ensurePmp()
                    if (!pmp) throw upnpErr
                    const res = await callPmp(pmp, p => p.portMapping(pmpMapping(opts)))
                    if (!closed) {
                        mode = 'pmp'
                        return res
                    }
                } catch {
                    // Fall through to cleanup and rethrow original UPnP error.
                }
                await closePmp()
                throw upnpErr
            }
        },
        async unmap(opts) {
            if (mode === 'pmp') {
                if (!pmpClient) return
                return callPmp(pmpClient, p => p.portUnmapping({
                    public: opts.publicPort,
                    private: opts.localPort,
                    type: 'tcp'
                }))
            }
            return client.portUnmapping(mapping(opts))
        },
        async close() {
            closed = true
            client.destroy?.()
            await closePmp()
        }
    }
}
