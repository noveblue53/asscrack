import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    initialHostFields,
    readHostAddress,
    readHostFile,
    readUpnpPort,
    resolveRoomHostPlan,
    saveHostFields
} from '../src/application/room-host.mjs';

const tempDirs = [];
function makeTempDir() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'asscrack-reopen-upnp-'));
    tempDirs.push(dir);
    return dir;
}

after(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('saved-room reopen UPnP auto-mapping', () => {
    test('reopening a saved internet room without allowUpnp in .host.json enables UPnP and reuses upnpPort when autoUpnp is true', () => {
        const dir = makeTempDir();
        const hostFile = path.join(dir, 'room.host.json');
        writeFileSync(hostFile, JSON.stringify({ upnpPort: 45123 }));

        const plan = resolveRoomHostPlan({ hostFile, autoUpnp: true, reopen: true, lan: false });
        assert.deepEqual(plan, { address: '', mapping: true, savedPort: 45123 });
    });

    test('reopening a saved internet room with no .host.json file enables UPnP when autoUpnp is true', () => {
        const dir = makeTempDir();
        const hostFile = path.join(dir, 'missing.host.json');

        const plan = resolveRoomHostPlan({ hostFile, autoUpnp: true, reopen: true, lan: false });
        assert.deepEqual(plan, { address: '', mapping: true, savedPort: null });
    });

    test('reopening a saved internet room does not enable UPnP when autoUpnp is false', () => {
        const dir = makeTempDir();
        const hostFile = path.join(dir, 'room.host.json');
        writeFileSync(hostFile, JSON.stringify({ upnpPort: 45123 }));

        assert.deepEqual(
            resolveRoomHostPlan({ hostFile, autoUpnp: false, reopen: true, lan: false }),
            { address: '', mapping: false, savedPort: null }
        );
        assert.deepEqual(
            resolveRoomHostPlan({ hostFile: path.join(dir, 'missing.host.json'), autoUpnp: false, reopen: true, lan: false }),
            { address: '', mapping: false, savedPort: null }
        );
    });

    test('reopening a saved internet room with allowUpnp: false does not enable UPnP even when autoUpnp is true', () => {
        const dir = makeTempDir();
        const hostFile = path.join(dir, 'room.host.json');
        writeFileSync(hostFile, JSON.stringify({ allowUpnp: false, upnpPort: 45123 }));

        const plan = resolveRoomHostPlan({ hostFile, autoUpnp: true, reopen: true, lan: false });
        assert.deepEqual(plan, { address: '', mapping: false, savedPort: null });
    });

    test('reopening a LAN room does not enable UPnP', () => {
        const dir = makeTempDir();
        const hostFile = path.join(dir, 'room.host.json');
        writeFileSync(hostFile, JSON.stringify({ allowUpnp: true, upnpPort: 45123 }));

        const plan = resolveRoomHostPlan({ hostFile, autoUpnp: true, reopen: true, lan: true });
        assert.deepEqual(plan, { address: '', mapping: false, savedPort: null });
    });

    test('reopening a room with a saved publicAddress does not enable UPnP', () => {
        const dir = makeTempDir();
        const hostFile = path.join(dir, 'room.host.json');
        writeFileSync(hostFile, JSON.stringify({ publicAddress: '203.0.113.10:4001', allowUpnp: true, upnpPort: 45123 }));

        const plan = resolveRoomHostPlan({ hostFile, autoUpnp: true, reopen: true, lan: false });
        assert.deepEqual(plan, { address: '203.0.113.10:4001', mapping: false, savedPort: null });
    });

    test('initial login opt-out persists allowUpnp: false and enableUpnp overrides it on later reopen', () => {
        const dir = makeTempDir();
        const hostFile = path.join(dir, 'room.host.json');

        const fields = initialHostFields({ reopen: false, lan: false, address: '', mapping: false, mappedPort: null });
        assert.deepEqual(fields, { publicAddress: '', allowUpnp: false });
        saveHostFields(hostFile, fields);
        assert.equal(readHostFile(hostFile).allowUpnp, false);
        assert.equal(readHostAddress(hostFile), '');
        assert.equal(readUpnpPort(hostFile), null);

        assert.deepEqual(
            resolveRoomHostPlan({ hostFile, autoUpnp: true, reopen: true, lan: false }),
            { address: '', mapping: false, savedPort: null }
        );

        saveHostFields(hostFile, { allowUpnp: true });
        saveHostFields(hostFile, { upnpPort: 46001 });
        assert.equal(readUpnpPort(hostFile), 46001);

        assert.deepEqual(
            resolveRoomHostPlan({ hostFile, autoUpnp: true, reopen: true, lan: false }),
            { address: '', mapping: true, savedPort: 46001 }
        );
    });

    test('initial login for a LAN room does not persist allowUpnp or publicAddress', () => {
        const fields = initialHostFields({ reopen: false, lan: true, address: '', mapping: false, mappedPort: null });
        assert.deepEqual(fields, {});
    });

    test('main.js wires startRoom, retainRoomHints, saveUpnpChoice, and upnp mapped persistence to room-host.mjs', () => {
        const mainSource = readFileSync(new URL('../src/application/main.js', import.meta.url), 'utf8');
        assert.match(mainSource, /resolveRoomHostPlan\s*\(\s*\{\s*hostFile,\s*publicAddress,\s*allowUpnp,\s*autoUpnp,\s*reopen,\s*lan\s*\}\s*\)/);
        assert.match(mainSource, /options\.upnp\s*=\s*true;/);
        assert.match(mainSource, /options\.port\s*=\s*savedPort;/);
        assert.match(mainSource, /options\.savedUpnpPort\s*=\s*true;/);
        assert.match(mainSource, /initialHostFields\s*\(\s*\{\s*reopen,\s*lan,\s*address,\s*mapping,\s*mappedPort\s*\}\s*\)/);
        assert.match(mainSource, /saveHostFields\s*\(\s*hints\.host,\s*fields,\s*\{\s*log:\s*writeLog\s*\}\s*\)/);
        assert.match(mainSource, /saveUpnpChoice\s*=\s*\(\)\s*=>\s*\{\s*if\s*\(\s*persistence\s*\)\s*saveHostFields\s*\(\s*hints\.host,\s*\{\s*allowUpnp:\s*true\s*\},\s*\{\s*log:\s*writeLog\s*\}\s*\)/);
        assert.match(mainSource, /if\s*\(\s*persistence\s*\)\s*saveHostFields\s*\(\s*hints\.host,\s*\{\s*upnpPort:\s*mappedPort\s*\},\s*\{\s*log:\s*writeLog\s*\}\s*\)/);
    });
});
