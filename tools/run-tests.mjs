import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SLOW_FIRST = Object.freeze([
    'friend-refresh.test.mjs',
    'screen-picker-layout.test.mjs',
    'diag-screen.test.mjs',
    'election.test.mjs',
    'multi-share.test.mjs',
    'room-archive.test.mjs',
    'connect-race.test.mjs',
    'music-relay.test.mjs',
    'file-credit.test.mjs',
    'friends-offline-ui.test.mjs',
    'transfer-resume-restart.test.mjs',
    'voice-channels.test.mjs',
    'relay-spread.test.mjs',
    'voice-relay.test.mjs',
    'upnp.test.mjs',
    'transfer-resume.test.mjs',
    'friend-requests.test.mjs',
    'friend-auto-allow.test.mjs',
    'roomkey.test.mjs',
    'friend-knock-node.test.mjs',
    'voice-relay-path.test.mjs',
    'file-transfer.test.mjs',
    'friend-invite.test.mjs',
    'rejoin.test.mjs',
    'screen-fanout-streams.test.mjs',
])

const VALUE_FLAGS = new Set([
    '--test-reporter',
    '--test-reporter-destination',
    '--test-name-pattern',
    '--test-skip-pattern',
    '--test-concurrency',
    '--test-timeout',
    '--test-shard',
    '--test-isolation',
    '--test-global-setup',
    '--test-rerun-failures',
])

/**
 * Discovers `*.test.mjs` files under `dir`, returning `test/<name>` paths sorted alphabetically.
 */
export function discoverTestFiles(dir = path.resolve(import.meta.dirname, '..', 'test')) {
    return readdirSync(dir)
        .filter(name => name.endsWith('.test.mjs'))
        .sort()
        .map(name => `test/${name}`)
}

/**
 * Orders test file paths with the top 4 slow files first, then interleaves remaining slow files with 3 fast files each.
 */
export function orderTestFiles(files, slowOrder = SLOW_FIRST) {
    const rank = new Map(slowOrder.map((name, i) => [name, i]))
    const slow = []
    const fast = []
    for (const file of files) {
        const base = path.posix.basename(file.replaceAll('\\', '/'))
        if (rank.has(base)) slow.push({ file, order: rank.get(base) })
        else fast.push(file)
    }
    slow.sort((a, b) => a.order - b.order)
    const ordered = slow.slice(0, 4).map(x => x.file)
    let fastIndex = 0
    for (let i = 4; i < slow.length; i++) {
        ordered.push(slow[i].file)
        for (let k = 0; k < 3 && fastIndex < fast.length; k++) ordered.push(fast[fastIndex++])
    }
    while (fastIndex < fast.length) ordered.push(fast[fastIndex++])
    return ordered
}

/**
 * Separates `node --test` CLI flags from explicit positional test file arguments.
 */
export function parseArgs(argv) {
    const flags = []
    const files = []
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--') {
            files.push(...argv.slice(i + 1))
            break
        }
        if (arg.startsWith('-')) {
            flags.push(arg)
            if (!arg.includes('=') && VALUE_FLAGS.has(arg) && i + 1 < argv.length) {
                flags.push(argv[++i])
            }
        } else {
            files.push(arg)
        }
    }
    return { flags, files }
}

/**
 * Computes default `--test-concurrency` for full-suite runs (capped below loopback contention elbow).
 */
export function defaultConcurrency(cpus = availableParallelism()) {
    return Math.min(Math.max(Math.round(cpus * 1.25), 4), 20)
}

/**
 * Returns true if CLI flags already specify `--test-concurrency`.
 */
export function hasConcurrencyFlag(flags) {
    return flags.some(flag => flag === '--test-concurrency' || flag.startsWith('--test-concurrency='))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { flags, files } = parseArgs(process.argv.slice(2))
    const targets = files.length > 0 ? files : orderTestFiles(discoverTestFiles())
    const runnerFlags = files.length === 0 && !hasConcurrencyFlag(flags)
        ? [`--test-concurrency=${defaultConcurrency()}`, ...flags]
        : flags
    const child = spawn(process.execPath, ['--test', ...runnerFlags, ...targets], {
        stdio: 'inherit',
        env: process.env,
    })
    child.on('exit', (code, signal) => {
        if (signal) process.exit(1)
        process.exit(code ?? 1)
    })
}
