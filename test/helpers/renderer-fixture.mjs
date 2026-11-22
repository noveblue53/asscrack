// Load the real classic scripts of the room window (reading.js, transcript-notes.js, room-link.js, find.js, quote.js,
// chat-links.js, highlights.js, renderer.js, composer-keys.js, menu.js) in node:vm
// with the fake DOM of fake-dom.mjs and a bridge (window.asscrack) that the test controls. voice.js, nodemap.js and
// layout.js do not load: small stubs take their place. No network, no Electron.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDom } from './fake-dom.mjs';

const SCRIPTS = ['reading.js', 'transcript-notes.js', 'room-link.js', 'find.js', 'quote.js', 'chat-links.js', 'highlights.js',
    'renderer.js', 'composer-keys.js', 'menu.js'];
const sources = await Promise.all(SCRIPTS.map(name =>
    readFile(new URL(`../../src/application/${name}`, import.meta.url), 'utf8')));

const IDS = ['chat-room', 'chat-screen', 'copy-invite', 'full-node-state', 'invite-code',
    'invite-field', 'invite-input', 'invite-note', 'invite-panel', 'invite-toggle', 'join-voice', 'leave-voice',
    'login', 'login-screen', 'map-close', 'map-panel', 'map-toggle', 'mute', 'deafen', 'peer-count', 'peers',
    'public-address', 'public-address-field', 'room', 'room-field', 'status', 'transfer-count',
    'transfers', 'username', 'voice-error'];

function layout() {
    const plain = IDS.map(id => ({ id, tag: ['peers', 'transfers'].includes(id) ? 'ul' : 'div' }));
    return [
        ...plain,
        { id: 'topic-value' }, { id: 'topic-edit', tag: 'button' },
        { id: 'topic-editor', hidden: true, children: [
            { id: 'topic-input', tag: 'input' }, { id: 'topic-save', tag: 'button' }, { id: 'topic-cancel', tag: 'button' }
        ] },
        { id: 'room-type', tag: 'select', value: 'new' },
        { id: 'availability-dialog', tag: 'dialog', children: [{ id: 'presence-fields' }] },
        { id: 'message-details', tag: 'dialog', children: [
            { id: 'message-detail-author' }, { id: 'message-detail-time' }, { id: 'message-detail-archive' }
        ] },
        { id: 'ptt-state' },
        { id: 'listening-dialog', tag: 'dialog', children: [
            { id: 'listening-title', tag: 'h2' }, { id: 'listener-muted', tag: 'input' },
            { id: 'listener-volume', tag: 'input' }, { id: 'listener-percent', tag: 'output' }
        ] },
        { id: 'message-panel', children: [
            { id: 'find-bar', hidden: true, children: [
                { id: 'find-input', tag: 'input' }, { id: 'find-count', tag: 'span' },
                { id: 'find-prev', tag: 'button' }, { id: 'find-next', tag: 'button' }, { id: 'find-close', tag: 'button' }
            ] },
        { id: 'messages', tag: 'ul' },
        { id: 'next-highlight', tag: 'button' },
        { id: 'highlight-words', tag: 'input' },
            { id: 'jump-latest', tag: 'button', hidden: true, children: [{ id: 'unread-count', tag: 'span' }] },
            { id: 'composer', children: [
                { id: 'quote-chip', hidden: true, children: [
                    { id: 'quote-head', tag: 'span', children: [{ id: 'quote-from', tag: 'span' }, { id: 'quote-time', tag: 'span' }] },
                    { id: 'quote-excerpt', tag: 'span' },
                    { id: 'quote-remove', tag: 'button' }
                ] },
                { id: 'file-draft', hidden: true, children: [
                    { id: 'file-draft-name', tag: 'span' }, { id: 'file-remove', tag: 'button' },
                    { id: 'file-recipient', tag: 'select', value: 'room', children: [{ tag: 'option', value: 'room' }] },
                    { id: 'send-file', tag: 'button' }
                ] },
                { id: 'file-input', tag: 'input' }, { id: 'attach-file', tag: 'button' },
                { id: 'message-input', tag: 'textarea' },
                { id: 'send', tag: 'button' }
            ] },
        ] },
        { id: 'statusbar', tag: 'footer', children: [{ class: 'net-note', tag: 'span' }] }
    ];
}

// A bridge with the API of preload.cjs. on* calls keep each handler: handlers[name](data) calls all the handlers of
// that event (renderer.js has more than one for some events). send(text) calls options.send(text) (default: 1 peer).
// The other calls give null.
function makeBridge(options) {
    const registered = {};
    const handlers = new Proxy({}, {
        get: (_, name) => data => {
            for (const fn of registered[name] ?? []) fn(data);
        }
    });
    const calls = [];
    const base = {
        login: async opts => ({ room: opts.room, internet: false }),
        send: options.send ?? (async () => 1),
        copyText: async text => {
            calls.push({ name: 'copyText', args: [text] });
            return true;
        },
        // options.api: calls that a script uses when it loads (for example listSavedRooms of saved-rooms-ui.js).
        ...(options.api ?? {})
    };
    const bridge = new Proxy(base, {
        get(target, name) {
            if (name in target) return target[name];
            if (typeof name === 'string' && name.startsWith('on')) {
                return fn => {
                    (registered[name] ??= []).push(fn);
                };
            }
            return async (...args) => {
                calls.push({ name, args });
                return null;
            };
        }
    });
    return { bridge, handlers, calls };
}

// options.send: async (text) => peer count, or throw. options.api: bridge calls that must exist before the scripts
// load. options.clock: a clock of fake-clock.mjs for the timers and Date of the scripts (default: the real timers,
// and setInterval does nothing). options.globals: more globals of the scripts (for example AudioContext and navigator
// for attention.js). options.before: classic scripts that load before the room scripts, each as its own script (for
// example voice-gate.js and the real voice.js in place of the voice stub). Returns the fixture.
export async function loadRoomWindow(options = {}) {
    const { document, window, Event } = createDom([...layout(), ...(options.elements ?? [])]);
    const { bridge, handlers, calls } = makeBridge(options);
    const errors = [];
    Object.assign(window, {
        localStorage: options.localStorage,
        asscrack: bridge,
        matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
        voice: {
            state: () => ({ self: 'self-peer-id', host: null, members: {} }),
            onChange() {},
            stats: async () => null,
            join: async () => {},
            leave: async () => {},
            setMuted() {},
            setDeafened() {}
        },
        nodeMap: null,
        layout: { closeTopLayer: () => false }
    });
    const context = {
        window,
        document,
        console: { log() {}, info() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) },
        setTimeout: options.clock?.setTimeout ?? setTimeout,
        clearTimeout: options.clock?.clearTimeout ?? clearTimeout,
        setInterval: options.clock?.setInterval ?? (() => 0),
        clearInterval: options.clock?.clearInterval ?? (() => {}),
        ...(options.clock ? { Date: options.clock.Date } : {}),
        queueMicrotask,
        Promise,
        Event,
        // chat-links.js reads each link with new URL().
        URL,
        MutationObserver: class {
            observe() {}
            disconnect() {}
        },
        ...(options.globals ?? {})
    };
    window.window = window;
    window.document = document;
    vm.createContext(context);
    // Classic scripts: a top-level const of one script is visible to the next one (one global scope).
    const extra = await Promise.all((options.scripts ?? []).map(name =>
        readFile(new URL(`../../src/application/${name}`, import.meta.url), 'utf8')));
    for (const name of options.before ?? []) {
        const source = await readFile(new URL(`../../src/application/${name}`, import.meta.url), 'utf8');
        vm.runInContext(source, context, { filename: name });
    }
    vm.runInContext([...sources, ...extra].join('\n;\n'), context, { filename: 'room-window.js' });

    const fixture = {
        window, document, handlers, calls, errors, Event,
        el: id => document.getElementById(id),
        async login(name) {
            document.getElementById('username').value = name;
            document.getElementById('room').value = 'test';
            document.getElementById('login').click();
            await settle();
        },
        // A live message from a peer (the onMessage event of the bridge).
        receive({ from, text, peerId, id, time = Date.now() }) {
            handlers.onMessage({ from, text, peerId, id, time });
            return fixture.rows().find(r => r.dataset.id === String(id)) ?? null;
        },
        // History lines (the onHistory event): no peer ID.
        history(messages) {
            handlers.onHistory({ messages });
        },
        // The rows of #messages with no note rows (transcript-notes.js: day, presence and link rows).
        rows: () => document.getElementById('messages').children.filter(row => !row.classList.contains('note')),
        // The note rows of #messages: [{ kind, text }].
        notes: () => document.getElementById('messages').children.filter(row => row.classList.contains('note'))
            .map(row => ({ kind: row.dataset.kind, text: row.textContent })),
        key(target, key, init = {}) {
            const event = new Event('keydown', { key, ...init });
            target.dispatchEvent(event);
            return event;
        },
        chip() {
            const chip = document.getElementById('quote-chip');
            return {
                hidden: chip.hidden,
                from: document.getElementById('quote-from').textContent,
                time: document.getElementById('quote-time').textContent,
                excerpt: document.getElementById('quote-excerpt').textContent
            };
        }
    };
    return fixture;
}

// Let the promise callbacks and the timers of 0 ms run.
export async function settle() {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
}
