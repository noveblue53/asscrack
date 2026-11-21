// Inspect the actual embedded release payload, separately from builder's unpacked staging directory.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createReadStream, readFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');

const project = path.resolve(__dirname, '..');
const nativeModules = [
    'better-sqlite3-multiple-ciphers/prebuilds/win32-x64.node',
    'uiohook-napi/prebuilds/win32-x64/uiohook-napi.node'
];
const textFile = /\.(?:cjs|css|html|js|json|md|mjs|svg)$/i;
const patchedRuntimeVersions = {
    '@libp2p/crypto': '5.2.0',
    '@libp2p/circuit-relay-v2': '4.2.17'
};

function run(program, args, options = {}) {
    const result = spawnSync(program, args, { ...options, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${path.basename(program)} failed:\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
}

function files(root, prefix = '') {
    return readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return files(root, relative);
        assert.ok(entry.isFile(), `Unexpected non-file entry ${relative}`);
        return relative;
    });
}

function pe(file) {
    const bytes = readFileSync(file);
    assert.ok(bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ', `Invalid Windows executable ${file}`);
    const offset = bytes.readUInt32LE(0x3c);
    assert.ok(offset + 26 <= bytes.length && bytes.readUInt32LE(offset) === 0x4550, `Invalid PE header ${file}`);
    return { machine: bytes.readUInt16LE(offset + 4), format: bytes.readUInt16LE(offset + 24) };
}

function executableCodeSha256(file) {
    const bytes = readFileSync(file);
    const header = bytes.readUInt32LE(0x3c);
    const sectionCount = bytes.readUInt16LE(header + 6);
    const sections = header + 24 + bytes.readUInt16LE(header + 20);
    assert.ok(sections + sectionCount * 40 <= bytes.length, `Invalid PE sections ${file}`);
    for (let index = 0; index < sectionCount; index++) {
        const table = sections + index * 40;
        if (bytes.toString('ascii', table, table + 5) !== '.text') continue;
        const length = bytes.readUInt32LE(table + 16);
        const offset = bytes.readUInt32LE(table + 20);
        assert.ok(length > 0 && offset + length <= bytes.length, `Invalid executable code section ${file}`);
        return createHash('sha256').update(bytes.subarray(offset, offset + length)).digest('hex');
    }
    throw new Error(`No executable code section in ${file}`);
}

function compare(packaged, expected, relative) {
    if (packaged.equals(expected)) return;
    if ((textFile.test(relative) || ['.editorconfig', '.prettierrc'].includes(path.posix.basename(relative))) &&
        packaged.toString('utf8').replaceAll('\r\n', '\n') === expected.toString('utf8').replaceAll('\r\n', '\n')) return;
    throw new Error(`Embedded payload differs from the source: ${relative}`);
}

function verifyRuntimePackages(archive, packed, lock) {
    const lockedNames = Object.keys(lock.packages).filter(entry => entry.startsWith('node_modules/'));
    const productionVersions = Object.fromEntries(Object.entries(patchedRuntimeVersions).map(([name, expected]) => {
        const matching = lockedNames.filter(entry => entry === `node_modules/${name}` || entry.endsWith(`/node_modules/${name}`));
        const versions = new Set(matching.filter(entry => !lock.packages[entry].dev).map(entry => lock.packages[entry].version));
        assert.deepEqual([...versions], [expected], `Unexpected locked production versions of ${name}`);
        return [name, { version: expected, copies: 0 }];
    }));
    for (const file of packed.filter(entry => entry.startsWith('node_modules/') && entry.endsWith('/package.json'))) {
        const pkg = JSON.parse(asar.extractFile(archive, path.normalize(file)).toString('utf8'));
        assert.notEqual(pkg.name, 'node-forge', `Unexpected Forge dependency in embedded package at ${file}`);
        if (!Object.hasOwn(productionVersions, pkg.name)) continue;
        const expected = productionVersions[pkg.name];
        assert.equal(pkg.version, expected.version, `Unexpected packaged ${pkg.name} version at ${file}`);
        expected.copies++;
    }
    for (const [name, result] of Object.entries(productionVersions)) assert.ok(result.copies > 0, `Missing packaged ${name}`);
    return { ...productionVersions, 'node-forge': { copies: 0 } };
}

function verifyNetworkImports(archive, scratch) {
    const extracted = path.join(scratch, 'module-check');
    asar.extractAll(archive, extracted);
    const probe = `
        const path = require('node:path');
        const { fileURLToPath } = require('node:url');
        const { registerHooks } = require('node:module');
        registerHooks({
            resolve(specifier, context, nextResolve) {
                const result = nextResolve(specifier, context);
                if (result.url.startsWith('file:')) {
                    const relative = path.relative(process.cwd(), fileURLToPath(result.url));
                    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
                        throw new Error('Packaged load depended on a file outside the application: ' + specifier);
                    }
                }
                return result;
            }
        });
        Promise.all([import('./src/network/node.mjs'), import('./src/network/libp2p-relay-fix.mjs')])
            .then(([, relay]) => relay.assertRelayFixed())
            .catch(error => { console.error(error); process.exitCode = 1; });
    `;
    run(process.execPath, ['-e', probe], { cwd: extracted });
}

async function verifyFuses(application, expected = {}) {
    const entries = Object.entries(expected);
    if (!entries.length) return {};
    const fuseWire = await getCurrentFuseWire(application);
    assert.equal(fuseWire.version, '1', 'Unsupported Electron fuse wire');
    return Object.fromEntries(entries.map(([name, value]) => {
        const option = name[0].toUpperCase() + name.slice(1);
        const index = FuseV1Options[option];
        assert.equal(typeof index, 'number', `Unsupported packaged Electron fuse ${name}`);
        assert.equal(fuseWire[index], (value ? '1' : '0').charCodeAt(0), `Packaged Electron fuse ${name}`);
        return [name, value];
    }));
}

async function sha256(file) {
    const hash = createHash('sha256');
    for await (const block of createReadStream(file)) hash.update(block);
    return hash.digest('hex');
}

async function verifyElectronDistribution(officialZip, version, sevenZip, scratch, payload, application) {
    const file = `electron-v${version}-win32-x64.zip`;
    const installed = JSON.parse(readFileSync(path.join(project, 'node_modules/electron/package.json'), 'utf8'));
    assert.equal(installed.version, version, 'Installed Electron must match the lockfile');
    const table = JSON.parse(readFileSync(path.join(project, 'node_modules/electron/checksums.json'), 'utf8'));
    const expected = table[file];
    assert.match(expected ?? '', /^[a-f0-9]{64}$/, 'Missing official Windows x64 Electron checksum');
    assert.equal(await sha256(officialZip), expected, 'Official Electron archive SHA-256');
    const reference = path.join(scratch, 'official-electron');
    const unchanged = ['version', 'ffmpeg.dll', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin'];
    assert.equal(readFileSync(path.join(payload, 'version'), 'utf8').trim(), version, 'Packaged Electron release version');
    run(sevenZip, ['x', '-y', `-o${reference}`, officialZip, 'electron.exe', ...unchanged]);
    const codeSha256 = executableCodeSha256(application);
    assert.equal(codeSha256, executableCodeSha256(path.join(reference, 'electron.exe')), 'Packaged Electron executable code');
    for (const name of unchanged) {
        assert.equal(await sha256(path.join(payload, name)), await sha256(path.join(reference, name)), `Electron distribution file ${name}`);
    }
    return { version, windowsX64ZipSha256: expected, executableCodeSha256: codeSha256, unchangedFiles: unchanged };
}

async function verify() {
    const [portable, verification, sevenZip = '7z', officialZip] = process.argv.slice(2);
    assert.ok(portable && verification, 'Usage: node build/verify-windows-portable.cjs <portable exe> <verification directory> [7z] [official Electron Windows x64 zip]');
    const executable = path.resolve(portable);
    const out = path.resolve(verification);
    mkdirSync(out, { recursive: true });
    const scratch = mkdtempSync(path.join(out, 'extracted-'));
    const launcher = path.join(scratch, 'launcher');
    const payload = path.join(scratch, 'payload');
    const outer = pe(executable);
    assert.ok((outer.machine === 0x14c && outer.format === 0x10b) || (outer.machine === 0x8664 && outer.format === 0x20b),
        'Expected an x86 or x64 Windows portable launcher');

    run(sevenZip, ['t', executable]);
    run(sevenZip, ['x', '-y', `-o${launcher}`, executable]);
    const bundles = files(launcher).filter(file => /(?:^|\/)app-[^/]+\.7z$/i.test(file));
    assert.equal(bundles.length, 1, 'Expected exactly one embedded Windows build');
    assert.equal(path.posix.basename(bundles[0]), 'app-64.7z', 'Expected an x64 payload');
    const bundle = path.join(launcher, bundles[0]);
    run(sevenZip, ['t', bundle]);
    run(sevenZip, ['x', '-y', `-o${payload}`, bundle]);

    const application = path.join(payload, 'ASSCRACK.exe');
    assert.deepEqual(pe(application), { machine: 0x8664, format: 0x20b }, 'Packaged application architecture');
    const archive = path.join(payload, 'resources', 'app.asar');
    const pkg = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8'));
    const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
    const fuses = await verifyFuses(application, pkg.build.electronFuses);
    const lock = JSON.parse(readFileSync(path.join(project, 'package-lock.json'), 'utf8'));
    const electronVersion = lock.packages['node_modules/electron']?.version;
    const electronDistribution = officialZip ? await verifyElectronDistribution(path.resolve(officialZip), electronVersion,
        sevenZip, scratch, payload, application) : null;
    for (const field of ['name', 'version', 'main']) assert.equal(packaged[field], pkg[field], `Package ${field}`);
    const applicationRoots = ['src/application', 'src/network'];
    const packed = asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, ''));
    const packedPaths = packed.filter(file => applicationRoots.some(root => file.startsWith(`${root}/`)));
    // The ASAR reader traverses nested entries using the host's path separator.
    const packedFiles = packedPaths.filter(file => !asar.statFile(archive, path.normalize(file)).files);
    const expectedPaths = applicationRoots.flatMap(root => files(project, root)).filter(file =>
        !file.split('/').some(segment => segment.startsWith('.')) && /\.(?:cjs|css|html|js|mjs|png|svg)$/i.test(file));
    assert.ok(expectedPaths.length > 0, 'Expected runtime sources');
    for (const file of expectedPaths) assert.ok(packedFiles.includes(file), `Missing packaged runtime file ${file}`);
    for (const file of packedFiles) compare(asar.extractFile(archive, path.normalize(file)), readFileSync(path.join(project, file)), file);
    const runtimePackages = verifyRuntimePackages(archive, packed, lock);
    verifyNetworkImports(archive, scratch);

    const native = [];
    for (const module of nativeModules) {
        const packagedFile = path.join(`${archive}.unpacked`, 'node_modules', module);
        const installedFile = path.join(project, 'node_modules', module);
        assert.deepEqual(pe(packagedFile), { machine: 0x8664, format: 0x20b }, `Native module architecture ${module}`);
        const hash = await sha256(packagedFile);
        assert.equal(hash, await sha256(installedFile), `Native module differs from installed locked dependency ${module}`);
        native.push({ module, sha256: hash });
    }

    const report = {
        file: path.basename(executable), bytes: statSync(executable).size, sha256: await sha256(executable),
        applicationVersion: packaged.version, electronVersion, electronDistribution,
        application, applicationSha256: await sha256(application), archiveSha256: await sha256(archive),
        architecture: 'x64', runtimeFiles: packedFiles.length, packagedNetworkImport: true, patchedCircuitRelay: true, runtimePackages, fuses, native
    };
    writeFileSync(path.join(out, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify(report, null, 2));
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
