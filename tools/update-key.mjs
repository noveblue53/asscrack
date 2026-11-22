// P9C: make the update key pair one time (the operator's step, docs/RELEASE_UPDATES.md).
//
// Usage:
//   node tools/update-key.mjs [--out <folder>]           make the key pair
//   node tools/update-key.mjs --public [--out <folder>]  print the public key of the key that exists
//
// The private key goes to <folder>/update-key.pem (default %USERPROFILE%\.asscrack-release). The script refuses a
// folder in a Git work tree and a key file that exists. It never prints the private key. It prints the two lines for
// src/application/update-key.mjs. Keep a backup of the key file: with a lost key, the clients cannot get signed updates.
//
// Exit code 0: done. 1: refused or failed.
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const KEY_FILE = 'update-key.pem';
export const defaultKeyFolder = () => path.join(os.homedir(), '.asscrack-release');

// True when the folder (or a parent) has a .git entry: a key there can go into a commit.
export function insideGitTree(folder) {
    let dir = path.resolve(folder);
    for (;;) {
        if (existsSync(path.join(dir, '.git'))) return true;
        const parent = path.dirname(dir);
        if (parent === dir) return false;
        dir = parent;
    }
}

export function publicKeyText(privateKeyPem) {
    return createPublicKey(createPrivateKey(privateKeyPem)).export({ format: 'jwk' }).x;
}

function sourceLines(x) {
    return `export const UPDATE_PUBLIC_KEY = '${x}';\nexport const UPDATE_KEY_IS_TEST = false;`;
}

function main(argv) {
    const outIndex = argv.indexOf('--out');
    const folder = path.resolve(outIndex !== -1 && argv[outIndex + 1] ? argv[outIndex + 1] : defaultKeyFolder());
    const file = path.join(folder, KEY_FILE);
    if (argv.includes('--public')) {
        console.log(sourceLines(publicKeyText(readFileSync(file, 'utf8'))));
        return 0;
    }
    if (insideGitTree(folder)) {
        console.error(`Refused: ${folder} is in a Git work tree. Use a folder outside each repository.`);
        return 1;
    }
    if (existsSync(file)) {
        console.error(`Refused: ${file} exists. The script does not replace a key. A new key stops the updates of each client that has the old key.`);
        return 1;
    }
    mkdirSync(folder, { recursive: true });
    if (!statSync(folder).isDirectory()) throw new Error(`${folder} is not a folder`);
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    writeFileSync(file, pem, { flag: 'wx', mode: 0o600 });
    console.log(`The private key is in ${file}.`);
    console.log('Keep a backup copy of that file in a safe place outside this PC. Do not commit it, copy it into a work order or send it.');
    console.log('Put these two lines in src/application/update-key.mjs (in place of the test key):');
    console.log(sourceLines(publicKeyText(pem)));
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (err) {
        console.error(`Failed: ${err?.message ?? err}`);
        process.exitCode = 1;
    }
}
