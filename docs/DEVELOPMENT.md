# Development

Build ASSCRACK from source, run the tests and use the terminal demo. The [status and roadmap](STATUS.md) give the
test evidence of each feature.

## Get started

Releases are on GitHub: https://github.com/noveblue53/asscrack/releases (installer and portable `.exe`, with signed in-app updates).

## Build and run from source

Use Node 24 and the lockfile of the project.

```bash
npm ci
```

On a Windows PC with no VC++ build tools, `npm ci` alone fails. npm 11 runs a `node-gyp rebuild` for
`better-sqlite3-multiple-ciphers`, because its lockfile entry does not keep `"gypfile": false`, and node-gyp needs a
compiler. The package has a prebuilt binary, so the build is not necessary. Use this command on such a PC:

```bash
npm run install:clean
```

It runs `npm ci --ignore-scripts`, then the Electron download (`node node_modules/electron/install.js`), then the
libp2p patch (`node src/network/libp2p-relay-fix.mjs`). It does not change the dependencies or the lockfile.

```bash
npm start
```

To start two copies on one computer, give each copy its own profile folder:

```bash
npm start -- --profile ./profile-a
```

```bash
npm start -- --profile ./profile-b
```

On Windows, `npm run dist` creates `dist/ASSCRACK-<version>-portable.exe`. For a verified Windows x64 candidate, install the locked dependencies with `npm ci --ignore-scripts`, run `npm test`, and choose a fresh output directory.

```powershell
./build/build-windows-candidate.ps1 -OutputDirectory 'C:\builds\asscrack-private'
```

The private candidate includes an executable digest and payload verification report. For signed staging, install the approved signing certificate in the signing account’s Windows certificate store and configure `ASSCRACK_WINDOWS_SIGNER_SHA1` and `ASSCRACK_WINDOWS_SIGNER_SHA256`. Run the same command with `-Mode TrustedSigned`, then verify both signatures and hashes independently before publishing. [Windows signing and verification](WINDOWS_RELEASE.md)

## Run the tests

The tests start real libp2p nodes on 127.0.0.1.

```bash
npm test
```

## Terminal demo

The terminal demo listens on loopback by default. Its optional `--trusted-lan` mode uses the legacy shared LAN room. Use the desktop app for protected rooms.

```bash
node src/network/transceiver.mjs --room <name> --name <name>
```

## How it works (technology)

| Part | Technology |
|---|---|
| Peer-to-peer network | libp2p with TCP, Noise encryption and Yamux |
| LAN discovery | mDNS |
| Internet reachability | Circuit relay v2 through full nodes, a dial-back check, UPnP |
| Roles | Host election with terms and heartbeats |
| Voice | WebCodecs Opus (48 kHz, 20 ms, 32 kbps) on libp2p streams |
| Files | Chunks on a libp2p stream, direct from the sender to each receiver, with a SHA-256 check |
| Desktop app | Electron, packaged as one portable Windows `.exe` |
| Logs | One log file for each start in `%APPDATA%\asscrack\logs`, with no chat text |

The network code is in `src/network/`. The Electron app is in `src/application/`. The tests are in `test/`.
