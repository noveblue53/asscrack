// OI4 (goal AF): `npm ci` alone fails on a Windows PC with no VC++ build tools. The script install:clean gives the
// three commands that work there, in this order.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8')

test('package.json has the clean install script with the three commands in order', () => {
    const pkg = JSON.parse(read('package.json'))
    assert.equal(pkg.scripts['install:clean'],
        'npm ci --ignore-scripts && node node_modules/electron/install.js && node src/network/libp2p-relay-fix.mjs')
})

test('the README tells why npm ci alone fails and gives the clean install command', () => {
    const readme = read('README.md')
    assert.match(readme, /npm run install:clean/)
    assert.match(readme, /VC\+\+/)
})
