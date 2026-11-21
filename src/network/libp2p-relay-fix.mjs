import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE = '@libp2p/circuit-relay-v2'
const VERSION = '4.2.17'
const STOCK_HASH = '257e844bbd2eb0a23cf0562fa9d48f70c80225937c2160a52f51535d35016719'
const FIXED_HASH = '760eea57b6b47e806a7b7d16a4741d05aacaecf9ca81720c23d0b3b6bd5babcb'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function inspect(appDir) {
    const entry = appDir
        ? pathToFileURL(createRequire(path.join(appDir, 'package.json')).resolve(PACKAGE))
        : new URL(import.meta.resolve(PACKAGE))
    const metadata = JSON.parse(readFileSync(new URL('../../package.json', entry), 'utf8'))
    if (metadata.name !== PACKAGE || metadata.version !== VERSION) {
        throw new Error(`Unsupported relay version ${metadata.version}. Review the circuit bridge fix before changing the relay.`)
    }
    const file = fileURLToPath(new URL('./utils.js', entry))
    const source = readFileSync(file, 'utf8')
    return { file, source, hash: sha256(source) }
}

export function assertRelayFixed() {
    if (inspect().hash !== FIXED_HASH) throw new Error('The installed circuit relay needs the pinned duplex fix. Run npm ci.')
}

export function beforePack({ appDir } = {}) {
    const { file, source, hash } = inspect(appDir)
    if (hash === FIXED_HASH) return
    if (hash !== STOCK_HASH) throw new Error(`Unexpected relay source SHA-256 ${hash}. Review the circuit bridge fix.`)
    // libp2p's pipe eagerly attaches a read listener to each native stream it wraps.
    // Reuse one duplex per circuit end so the return sink cannot create an unread second queue.
    const fixed = source
        .replace("import { pipe } from '@libp2p/utils';", "import { messageStreamToDuplex, pipe } from '@libp2p/utils';")
        .replace('    pipe(src, dst, src)',
            '    const sourceDuplex = messageStreamToDuplex(src);\n' +
            '    const destinationDuplex = messageStreamToDuplex(dst);\n' +
            '    pipe(sourceDuplex, destinationDuplex, sourceDuplex)')
    if (sha256(fixed) !== FIXED_HASH) throw new Error('The relay bridge fix produced unexpected source bytes')
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
        writeFileSync(temporary, fixed, { flag: 'wx' })
        renameSync(temporary, file)
    } finally { rmSync(temporary, { force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv[2] === '--verify') assertRelayFixed()
    else beforePack()
}
