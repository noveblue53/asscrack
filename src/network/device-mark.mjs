// L3 (P10a): no key verifies a user name, and two devices can use the same name. The window shows a short mark of the
// device beside each name: the first 6 hex characters of SHA-256 of the device ID (a protected room) or of the peer ID
// (a legacy room). The mark stays the same for one device. A new key with a chosen mark needs about 2^24 tries.
import { createHash } from 'node:crypto'

export function deviceMark(id) {
    if (typeof id !== 'string' || id === '') return null
    return createHash('sha256').update(id).digest('hex').slice(0, 6)
}
