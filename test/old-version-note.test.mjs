// The update text for 0.7.0 users (DECISIONS.md item 100) is gone in the UI copy pass (U3): the window shows no version
// history. This test keeps the removal: index.html has no #old-version-note, and renderer.js does not look for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('index.html has no old-version note and renderer.js does not use one', async () => {
    const html = await readFile(new URL('../src/application/index.html', import.meta.url), 'utf8');
    assert.equal(html.includes('old-version-note'), false);
    assert.equal(/0\.7\.0 or older/.test(html), false);
    const renderer = await readFile(new URL('../src/application/renderer.js', import.meta.url), 'utf8');
    assert.equal(renderer.includes('old-version-note'), false);
});
