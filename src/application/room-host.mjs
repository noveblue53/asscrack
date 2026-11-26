import { readFileSync, renameSync, writeFileSync } from 'fs';

/**
 * Read persisted host metadata (`rooms/<tag>.host.json`) for a saved room.
 */
export function readHostFile(file) {
    try {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        return value !== null && typeof value === 'object' ? value : {};
    } catch {
        return {};
    }
}

/**
 * Read a saved publicAddress from host metadata, or an empty string if unset.
 */
export function readHostAddress(file) {
    const value = readHostFile(file).publicAddress;
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read a saved UPnP port (1-65535) from host metadata, or null if absent/invalid.
 */
export function readUpnpPort(file) {
    const value = readHostFile(file).upnpPort;
    return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

/**
 * Atomically merge `fields` into a room's `.host.json` file.
 */
export function saveHostFields(file, fields, { log = () => {} } = {}) {
    try {
        const temp = `${file}.tmp`;
        writeFileSync(temp, JSON.stringify({ ...readHostFile(file), ...fields }), { mode: 0o600 });
        renameSync(temp, file);
    } catch (err) {
        log('WARN', `Host data not saved to ${file}: ${err?.message ?? err}`);
    }
}

/**
 * Compute address, UPnP mapping flag, and saved UPnP port for starting or reopening a room.
 */
export function resolveRoomHostPlan({
    hostFile = null,
    publicAddress = '',
    allowUpnp = false,
    autoUpnp = true,
    reopen = false,
    lan = false
} = {}) {
    const address = lan ? '' : reopen && hostFile ? readHostAddress(hostFile) : publicAddress;
    const mapping = !lan && !address && (reopen && hostFile ? autoUpnp && readHostFile(hostFile).allowUpnp !== false : allowUpnp === true);
    const savedPort = mapping && reopen && hostFile ? readUpnpPort(hostFile) : null;
    return { address, mapping, savedPort };
}

/**
 * Compute initial host metadata fields to persist when a room is saved.
 */
export function initialHostFields({
    reopen = false,
    lan = false,
    address = '',
    mapping = false,
    mappedPort = null
} = {}) {
    const fields = {};
    if (!reopen && !lan) Object.assign(fields, { publicAddress: address, allowUpnp: mapping });
    if (mappedPort !== null) fields.upnpPort = mappedPort;
    return fields;
}
