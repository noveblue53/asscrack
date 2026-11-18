// Guard for the UPnP router HTTP error crash.
// @achingbrain/nat-port-mapper (upnp/fetch.js) throws "Request failed: <status>" inside the HTTP response callback,
// outside of its promise. Thus a router that answers a UPnP request with an HTTP error (for example 500 with a SOAP
// fault) gives an uncaughtException. The real stack frame (Node 24, probe 2026-11-18):
//   at ClientRequest.<anonymous> (file:///.../node_modules/@achingbrain/nat-port-mapper/dist/src/upnp/fetch.js:43:23)
// The guard swallows only this error. Each other error goes to onOther.
// Note: each uncaughtException listener turns off the default crash of Node (and the default dialog of Electron)
// for ALL errors. Thus onOther must keep the behavior that the entry point wants.

const FETCH_FRAME = /nat-port-mapper[\\/]dist[\\/]src[\\/]upnp[\\/]fetch\.js/

let installed = null
const subscribers = new Set()

// Subscribe to the router errors that the guard swallows. Returns an unsubscribe function.
// With one or more subscribers, the guard writes no line of its own (the subscriber logs the error).
export function onUpnpRouterError(listener) {
    subscribers.add(listener)
    return () => { subscribers.delete(listener) }
}

export function isUpnpRouterError(err) {
    const message = typeof err?.message === 'string' ? err.message : ''
    const stack = typeof err?.stack === 'string' ? err.stack : ''
    return message.startsWith('Request failed:') && FETCH_FRAME.test(stack)
}

// The default for each other error: the Node behavior (print the stack to stderr, exit with code 1).
function exitLikeNode(err) {
    try {
        process.stderr.write(`${err?.stack ?? String(err)}\n`)
    } finally {
        process.exit(1)
    }
}

function lineText(err) {
    const text = String(err?.message ?? err)
    return `upnp none reason=router-error error=${/^[^\s"=]+$/.test(text) ? text : JSON.stringify(text)}`
}

// Adds one uncaughtException listener. A second call does not add a second listener and returns the first one.
export function installUpnpGuard({ log = text => console.info(text), onOther = exitLikeNode } = {}) {
    if (installed) return installed
    installed = err => {
        if (isUpnpRouterError(err)) {
            if (subscribers.size === 0) log(lineText(err))
            for (const listener of [...subscribers]) {
                try { listener(err) } catch { /* a subscriber error must not stop the guard */ }
            }
            return
        }
        onOther(err)
    }
    process.on('uncaughtException', installed)
    return installed
}
