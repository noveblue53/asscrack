// G7a: a short cache of os.networkInterfaces() for the whole process (DECISIONS.md G7a, the friend cap).
// @libp2p/mdns reads the addresses of a node (os.networkInterfaces() through @libp2p/utils) for each mDNS query on
// the network, before it checks the service tag. With one node for each friend, the cost grew with the number of
// friends (measured on this PC: about 1.2 ms for each node and each query). With this cache, all the nodes of one
// query share one read. Each caller gets its own copy: a change of the result does not change the cache.
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'

export const INTERFACE_CACHE_MS = 2000

let installed = null

// Install the cache one time for the process. Returns { clear(), uninstall() }. A second call gives the same object.
// now: the clock (tests). ttlMs: the time to live of one read.
export function installInterfaceCache({ ttlMs = INTERFACE_CACHE_MS, now = Date.now } = {}) {
    if (installed) return installed
    const read = os.networkInterfaces
    let value = null
    let at = 0
    function cached() {
        const time = now()
        if (value === null || time - at >= ttlMs || time < at) {
            value = read.call(os)
            at = time
        }
        return structuredClone(value)
    }
    os.networkInterfaces = cached
    syncBuiltinESMExports()
    installed = Object.freeze({
        // A network change (for example a resume from sleep): the next call reads the interfaces again.
        clear() { value = null },
        uninstall() {
            if (os.networkInterfaces === cached) {
                os.networkInterfaces = read
                syncBuiltinESMExports()
            }
            installed = null
        }
    })
    return installed
}
