// G7a: the cache of os.networkInterfaces() (interface-cache.mjs). A controllable clock, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { networkInterfaces } from 'node:os';
import { installInterfaceCache, INTERFACE_CACHE_MS } from '../src/network/interface-cache.mjs';

test('the interface cache gives the same result as the uncached call, keeps it for the time to live, and clears', t => {
    const real = os.networkInterfaces;
    const uncached = real.call(os);
    let reads = 0;
    let time = 1000;
    // Count the reads of the real function under the cache.
    os.networkInterfaces = () => { reads++; return real.call(os); };
    const cache = installInterfaceCache({ now: () => time });
    t.after(() => { cache.uninstall(); os.networkInterfaces = real; });
    assert.equal(INTERFACE_CACHE_MS, 2000);
    assert.deepEqual(os.networkInterfaces(), uncached, 'the same result as the uncached call');
    assert.deepEqual(networkInterfaces(), uncached, 'a named import of node:os also gets the cache');
    assert.equal(reads, 1);
    // A caller that changes its copy does not change the cache.
    const copy = os.networkInterfaces();
    for (const name of Object.keys(copy)) delete copy[name];
    assert.deepEqual(os.networkInterfaces(), uncached);
    time += 1999;
    os.networkInterfaces();
    assert.equal(reads, 1, 'one read in the time to live');
    time += 1;
    os.networkInterfaces();
    assert.equal(reads, 2, 'a new read after 2 s');
    cache.clear();
    os.networkInterfaces();
    assert.equal(reads, 3, 'clear() gives a new read at the next call');
    assert.equal(installInterfaceCache(), cache, 'one cache for each process');
    cache.uninstall();
    os.networkInterfaces();
    assert.equal(reads, 4, 'uninstall gives the function under the cache again');
});
