// 1.0.4: the settings of the automatic status in the dialog "Your availability" (auto-status-ui.js), in node:vm with
// the fake DOM of test/helpers/fake-dom.mjs and a bridge that the test controls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDom } from './helpers/fake-dom.mjs';

const source = await readFile(new URL('../src/application/auto-status-ui.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

function load({ settings = { awayMinutes: 10, dndFullscreen: false }, failSet = false } = {}) {
    const { document, window, Event } = createDom([
        { id: 'availability-dialog', tag: 'dialog', children: [
            { id: 'presence-fields' },
            { id: 'auto-status', hidden: true, children: [
                { id: 'auto-away', tag: 'select', value: '10' }, { id: 'auto-dnd', tag: 'input' },
                { id: 'auto-status-error', tag: 'p', hidden: true }
            ] }
        ] }
    ]);
    const sets = [];
    let current = { ...settings };
    window.asscrack = {
        getAutoStatus: async () => ({ ...current }),
        setAutoStatus: async patch => {
            sets.push({ ...patch });
            if (failSet) throw new Error('disk full');
            current = { ...current, ...patch };
            return { ...current };
        }
    };
    window.window = window;
    window.document = document;
    const context = { window, document, console, Promise, Number, String, Object };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'auto-status-ui.js' });
    return { document, window, Event, sets, el: id => document.getElementById(id) };
}

test('the settings show after the read: Away after 10 min and no full-screen Do not disturb by default', async () => {
    const f = load();
    assert.equal(f.el('auto-status').hidden, true, 'hidden until the read');
    await flush();
    assert.equal(f.el('auto-status').hidden, false);
    assert.equal(f.el('auto-away').value, '10');
    assert.equal(f.el('auto-dnd').checked, false);
});

test('a change saves one setting; a failed save shows the error and the saved value again', async () => {
    const f = load({ settings: { awayMinutes: 5, dndFullscreen: true } });
    await flush();
    assert.equal(f.el('auto-away').value, '5');
    assert.equal(f.el('auto-dnd').checked, true);
    f.el('auto-away').value = '0';
    f.el('auto-away').dispatchEvent(new f.Event('change'));
    await flush();
    f.el('auto-dnd').checked = false;
    f.el('auto-dnd').dispatchEvent(new f.Event('change'));
    await flush();
    assert.deepEqual(f.sets, [{ awayMinutes: 0 }, { dndFullscreen: false }]);
    assert.equal(f.el('auto-away').value, '0');

    const bad = load({ failSet: true });
    await flush();
    bad.el('auto-away').value = '15';
    bad.el('auto-away').dispatchEvent(new bad.Event('change'));
    await flush();
    assert.equal(bad.el('auto-status-error').hidden, false);
    assert.equal(bad.el('auto-status-error').textContent, 'Not saved. Try again.');
    assert.equal(bad.el('auto-away').value, '10', 'the saved value again');
});
