// L3 (P10a): no key verifies a user name, and two devices can use the same name. main.js adds a device mark to the
// window events of names and lines (deviceMark of device-mark.mjs): the mark of the device ID in a protected room,
// the mark of the peer ID in a legacy room. A history line of a protected room gets the mark of the device prefix of
// its message ID. A history line of a legacy room has no peer ID, thus no mark. The network events do not change.
import { deviceMark } from '../network/device-mark.mjs';

const DEVICE_PREFIX = /^([A-Za-z0-9_-]{43})\./;

// node: memberState() and memberDevice(peerId) of the room node.
export function withDeviceMarks(type, data, node) {
    if (!data || typeof data !== 'object' || !node) return data;
    const isProtected = node.memberState?.()?.protected === true;
    if (type === 'peer-name' || type === 'message') {
        if (typeof data.peerId !== 'string') return data;
        const mark = deviceMark(isProtected ? node.memberDevice?.(data.peerId) : data.peerId);
        return mark ? { ...data, mark } : data;
    }
    if (type === 'history' && isProtected && Array.isArray(data.messages)) {
        return { ...data, messages: data.messages.map(m => {
            const mark = deviceMark(DEVICE_PREFIX.exec(typeof m?.id === 'string' ? m.id : '')?.[1]);
            return mark ? { ...m, mark } : m;
        }) };
    }
    return data;
}
