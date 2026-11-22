// P9C: peers spread the news of an update. Each open session gets one line with the app version of this node
// ({ type: 'app-version', v: 1, version }). A node that has a newer signed manifest than the version of the peer sends
// it one time for each session ({ type: 'update-manifest', v: 1, text, signature }). The node does not check the
// manifest: it gives the text to the app (hub.received), and the app checks the signature (update-manifest.mjs).
//
// The version goes in its own line after the session is open, not in the hello line: in a protected room the hello
// line goes before the room proof, thus to a peer that is not proved yet.
//
// hub (node option "updates", or null for no update lines; the terminal demo gives null):
//   version: the app version of this node. offer(peerVersion): { text, signature } or null.
//   received(peerId, { text, signature }). onShare(listener): the app calls listener when it gets a new manifest;
//   returns a function that removes the listener.
export const MAX_VERSION_TEXT = 64
export const MAX_MANIFEST_TEXT = 8192
export const MAX_SIGNATURE_TEXT = 200

export function createUpdateSpread(hub) {
    const active = !!hub && typeof hub.version === 'string' && hub.version.length > 0 && hub.version.length <= MAX_VERSION_TEXT
    // session -> { version, sent, received }
    const state = new WeakMap()
    const entry = session => {
        let value = state.get(session)
        if (!value) { value = { version: null, sent: false, received: false }; state.set(session, value) }
        return value
    }

    function offerTo(session) {
        const value = entry(session)
        if (value.sent || value.version === null) return
        let manifest = null
        try { manifest = hub.offer(value.version) } catch { manifest = null }
        if (!manifest || typeof manifest.text !== 'string' || typeof manifest.signature !== 'string') return
        if (manifest.text.length > MAX_MANIFEST_TEXT || manifest.signature.length > MAX_SIGNATURE_TEXT) return
        value.sent = true
        session.send(JSON.stringify({ type: 'update-manifest', v: 1, text: manifest.text, signature: manifest.signature }))
    }

    return {
        opened(peerId, session) {
            if (active) session.send(JSON.stringify({ type: 'app-version', v: 1, version: hub.version }))
        },
        // Returns true when the line is an update line (handled or ignored).
        handle(peerId, session, control) {
            if (control.type !== 'app-version' && control.type !== 'update-manifest') return false
            if (!active || control.v !== 1) return true
            const value = entry(session)
            if (control.type === 'app-version') {
                // The first version of the session counts.
                if (value.version !== null || typeof control.version !== 'string' || control.version.length === 0 ||
                    control.version.length > MAX_VERSION_TEXT) return true
                value.version = control.version
                offerTo(session)
                return true
            }
            // One manifest for each session. A bigger line is ignored before the app reads it.
            if (value.received) return true
            value.received = true
            if (typeof control.text !== 'string' || typeof control.signature !== 'string' ||
                Buffer.byteLength(control.text) > MAX_MANIFEST_TEXT || control.signature.length > MAX_SIGNATURE_TEXT) return true
            try { hub.received(peerId, { text: control.text, signature: control.signature }) } catch { /* the app logs */ }
            return true
        },
        // The app has a new manifest: offer it to each open session with an older peer version.
        share(sessions) {
            if (!active) return
            for (const session of sessions) offerTo(session)
        },
        subscribe(listener) {
            if (!active || typeof hub.onShare !== 'function') return () => {}
            return hub.onShare(listener)
        }
    }
}
