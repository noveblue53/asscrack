import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultConcurrency, hasConcurrencyFlag, orderTestFiles, parseArgs, SLOW_FIRST } from '../tools/run-tests.mjs'

describe('tools/run-tests', { concurrency: true }, () => {
    test('orderTestFiles places top 4 slow files first and interleaves remaining slow files with fast files', () => {
        const slowOrder = ['s1.test.mjs', 's2.test.mjs', 's3.test.mjs', 's4.test.mjs', 's5.test.mjs', 's6.test.mjs']
        const input = [
            'test/f1.test.mjs', 'test/s6.test.mjs', 'test/f2.test.mjs', 'test/s3.test.mjs',
            'test/f3.test.mjs', 'test/s1.test.mjs', 'test/f4.test.mjs', 'test/s5.test.mjs',
            'test/f5.test.mjs', 'test/s2.test.mjs', 'test/s4.test.mjs',
        ]
        const ordered = orderTestFiles(input, slowOrder)
        assert.deepEqual(ordered, [
            'test/s1.test.mjs', 'test/s2.test.mjs', 'test/s3.test.mjs', 'test/s4.test.mjs',
            'test/s5.test.mjs', 'test/f1.test.mjs', 'test/f2.test.mjs', 'test/f3.test.mjs',
            'test/s6.test.mjs', 'test/f4.test.mjs', 'test/f5.test.mjs',
        ])
        assert.equal(ordered.length, input.length)
        assert.equal(new Set(ordered).size, input.length)
    })

    test('orderTestFiles ignores SLOW_FIRST entries absent from input and handles Windows paths', () => {
        const ordered = orderTestFiles([
            'test\\zeta.test.mjs',
            'test\\voice-relay.test.mjs',
            'test\\beta.test.mjs',
        ])
        assert.deepEqual(ordered, [
            'test\\voice-relay.test.mjs',
            'test\\zeta.test.mjs',
            'test\\beta.test.mjs',
        ])
        assert.ok(SLOW_FIRST.length >= 20)
    })

    test('parseArgs separates flags with inline or separate values from positional test files', () => {
        const parsed = parseArgs([
            '--test-reporter=tap',
            '--test-concurrency', '8',
            '--test-name-pattern', 'foo bar',
            'test/a.test.mjs',
            'test/b.test.mjs',
        ])
        assert.deepEqual(parsed.flags, [
            '--test-reporter=tap',
            '--test-concurrency', '8',
            '--test-name-pattern', 'foo bar',
        ])
        assert.deepEqual(parsed.files, ['test/a.test.mjs', 'test/b.test.mjs'])
    })

    test('parseArgs handles -- separator as positional files', () => {
        const parsed = parseArgs(['--test-only', '--', 'test/c.test.mjs'])
        assert.deepEqual(parsed.flags, ['--test-only'])
        assert.deepEqual(parsed.files, ['test/c.test.mjs'])
    })

    test('defaultConcurrency scales with CPU count and caps at 20', () => {
        assert.equal(defaultConcurrency(16), 20)
        assert.equal(defaultConcurrency(4), 5)
        assert.equal(defaultConcurrency(1), 4)
    })

    test('hasConcurrencyFlag detects --test-concurrency in both forms', () => {
        assert.equal(hasConcurrencyFlag(['--test-concurrency=8']), true)
        assert.equal(hasConcurrencyFlag(['--test-reporter=tap', '--test-concurrency', '8']), true)
        assert.equal(hasConcurrencyFlag(['--test-reporter=tap']), false)
    })
})
