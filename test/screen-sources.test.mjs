// P8b, design work package W3 (work-orders/astra/P8/DESIGN.md, sections 2.1, 2.2 and 2.9): the source list, the
// pending selection, the display media handler and the frame IPC check of the main process. Electron does not start:
// a fake desktopCapturer gives the sources, and a fake clock gives the time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptScreenFrame, createScreenSources, kindOfSource, MAX_SOURCES, MAX_SOURCE_NAME, MAX_THUMBNAIL_BYTES,
    PICKER_QUALITIES, SELECTION_MS, windowShareHasBorder } from '../src/application/screen-sources.mjs';

const roomFrame = { url: 'file:///asscrack/index.html' };

function thumb(bytes) {
    return { isEmpty: () => bytes === 0, toPNG: () => Buffer.alloc(bytes, 1) };
}

function setup({ sources } = {}) {
    const state = { now: 1000, idle: false, options: null, logs: [] };
    const list = sources ?? [
        { id: 'window:11:0', name: 'Notepad', thumbnail: thumb(900) },
        { id: 'screen:0:0', name: 'Screen 1', thumbnail: thumb(4000) },
        { id: 'window:12:0', name: 'x'.repeat(300), thumbnail: thumb(MAX_THUMBNAIL_BYTES + 1) },
        { id: 'screen:1:0', name: 'Screen 2', thumbnail: thumb(MAX_THUMBNAIL_BYTES) },
        { id: 'web-contents-media-stream:7', name: 'Other', thumbnail: thumb(10) }
    ];
    const capturer = { getSources: async options => { state.options = options; return list; } };
    const sources2 = createScreenSources({ desktopCapturer: capturer, isRoomFrame: frame => frame === roomFrame,
        isIdle: () => state.idle, now: () => state.now, log: (level, text) => state.logs.push(`${level} ${text}`) });
    return { state, screen: sources2, list };
}

// The display media handler: the answer of one request (the value that the handler gave to callback).
function ask(screen, request) {
    const calls = [];
    screen.handleDisplayMedia({ frame: roomFrame, videoRequested: true, audioRequested: false, userGesture: true, ...request },
        value => calls.push(value));
    assert.equal(calls.length, 1, 'the handler calls back exactly one time');
    return calls[0];
}

test('W3 check 4: the list has screens first, at most 40 entries, names of at most 128 characters and no large thumbnail', async () => {
    const { state, screen } = setup();
    const list = await screen.list();
    assert.deepEqual(state.options, { types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
    assert.deepEqual(list.map(e => [e.id, e.kind]), [['screen:0:0', 'screen'], ['screen:1:0', 'screen'], ['window:11:0', 'window'], ['window:12:0', 'window']],
        'screens first, then windows; a source of another kind is not in the list');
    assert.equal(list[3].name.length, MAX_SOURCE_NAME);
    assert.equal(list[3].thumbnail, null, 'a thumbnail above 200 kB is left out');
    assert.equal(list[1].thumbnail.length, MAX_THUMBNAIL_BYTES, 'a thumbnail of 200 kB stays');
    assert.ok(list[0].thumbnail instanceof Uint8Array);
    assert.deepEqual(Object.keys(list[0]).sort(), ['id', 'kind', 'name', 'thumbnail'], 'the window gets no source object');
    assert.equal(kindOfSource('screen:3:0'), 'screen');
    assert.equal(kindOfSource('window:3:0'), 'window');
    assert.equal(kindOfSource('tab:3'), null);

    const many = Array.from({ length: 50 }, (_, i) => ({ id: `window:${i}:0`, name: `W${i}`, thumbnail: thumb(10) }));
    many.push({ id: 'screen:0:0', name: 'Screen', thumbnail: thumb(10) });
    const big = setup({ sources: many });
    const listed = await big.screen.list();
    assert.equal(listed.length, MAX_SOURCES);
    assert.equal(listed[0].kind, 'screen', 'the cut keeps the screens');
});

test('W3 check 4: an ID that was not in the last list is refused; check 4a: the 6 qualities, Auto gives the size of Max', async () => {
    const { screen } = setup();
    await assert.rejects(screen.pick('screen:0:0', 'auto'), /not in the list/, 'no list yet');
    await screen.list();
    await assert.rejects(screen.pick('screen:9:0', 'auto'), /not in the list/);
    await assert.rejects(screen.pick('web-contents-media-stream:7', 'auto'), /not in the list/);
    assert.deepEqual(PICKER_QUALITIES.map(q => q.id), ['auto', 'standard', 'smooth', 'balanced', 'high', 'max']);
    assert.deepEqual(PICKER_QUALITIES.map(q => q.label), ['Auto', 'Standard (720p, 15 fps)',
        'Smooth (720p, 30 fps)', 'Balanced (1080p, 30 fps)', 'High (1080p, 60 fps)', 'Max (1440p, 60 fps)']);
    assert.deepEqual(await screen.pick('screen:0:0', 'auto'), { name: 'Screen 1', width: 2560, height: 1440, frameRate: 60, bitrate: 12000000 });
    assert.deepEqual(await screen.pick('window:11:0', 'standard'), { name: 'Notepad', width: 1280, height: 720, frameRate: 15, bitrate: 1500000 });
    assert.equal(screen.lastQuality(), 'standard', 'the main process keeps the last quality in memory');
    await assert.rejects(screen.pick('screen:0:0', 'sharp'), /Unknown screen quality/, 'revision 2 removed sharp');
    await assert.rejects(screen.pick('screen:0:0', 'ultra'), /Unknown screen quality/);
    assert.equal(screen.lastQuality(), 'standard', 'a refused quality does not change the last quality');
});

test('W3 check 3: the display media handler refuses with null for each bad request and gives the selection one time', async () => {
    const { state, screen, list } = setup();
    await screen.list();
    // No selection.
    assert.equal(ask(screen, {}), null);
    screen.pick('screen:0:0', 'auto');
    assert.equal(ask(screen, { audioRequested: true }), null, 'audio requested');
    assert.equal(ask(screen, { frame: { url: roomFrame.url } }), null, 'a different frame');
    assert.equal(ask(screen, { userGesture: false }), null, 'no user gesture');
    assert.equal(ask(screen, { userGesture: undefined }), null, 'no user gesture value');
    state.idle = true;
    assert.equal(ask(screen, {}), null, 'Idle Peer');
    state.idle = false;
    assert.equal(screen.hasPending(), true, 'the refusals keep the selection');
    const granted = ask(screen, {});
    assert.deepEqual(Object.keys(granted), ['video'], 'no audio key');
    assert.equal(granted.video, list[1], 'the selected DesktopCapturerSource');
    assert.equal(screen.hasPending(), false);
    assert.equal(ask(screen, {}), null, 'a second request with the same selection');
    // A selection older than 10 s.
    screen.pick('window:11:0', 'smooth');
    state.now += SELECTION_MS + 1;
    assert.equal(screen.hasPending(), false);
    assert.equal(ask(screen, {}), null, 'a selection older than 10 s');
    // A selection at exactly 10 s is still valid.
    screen.pick('window:11:0', 'smooth');
    state.now += SELECTION_MS;
    assert.equal(ask(screen, {}).video, list[0]);
    // The log has the result and the kind, never a source name.
    assert.ok(state.logs.includes('EVENT screen capture request granted kind=screen'));
    assert.ok(state.logs.some(line => line.startsWith('EVENT screen capture request refused reason=audio')));
    assert.ok(state.logs.every(line => !/Notepad|Screen 1/.test(line)), 'no source name in the log');
    // clear() removes the selection and the list.
    screen.pick('screen:0:0', 'auto');
    screen.clear();
    assert.equal(screen.hasPending(), false);
    await assert.rejects(screen.pick('screen:0:0', 'auto'), /not in the list/);
});

test('W3 check 3: the handler never calls back with an empty object, and pick is refused in Idle Peer', async () => {
    const { state, screen } = setup();
    await screen.list();
    const answers = [];
    const requests = [{}, { audioRequested: true }, { userGesture: false }, { frame: null }, null];
    screen.pick('screen:0:0', 'max');
    for (const request of requests) {
        screen.handleDisplayMedia(request === null ? null : { frame: roomFrame, userGesture: true, audioRequested: false, ...request }, v => answers.push(v));
    }
    for (const value of answers) assert.ok(value === null || (value && value.video), `answer ${JSON.stringify(value)}`);
    state.idle = true;
    await assert.rejects(screen.pick('screen:0:0', 'auto'), /Idle Peer/);
});

test('W3 check 5: the frame IPC drops a frame with no share, with no Uint8Array, with 0 bytes and with 1 048 577 bytes', () => {
    const frame = data => ({ tier: 'fast', key: true, timestampMs: 0, data });
    assert.equal(acceptScreenFrame(frame(new Uint8Array(10)), true), true);
    assert.equal(acceptScreenFrame(frame(new Uint8Array(1024 * 1024)), true), true, 'the largest frame');
    assert.equal(acceptScreenFrame(frame(new Uint8Array(10)), false), false, 'no active share');
    assert.equal(acceptScreenFrame(frame([1, 2, 3]), true), false, 'an array');
    assert.equal(acceptScreenFrame(frame(new ArrayBuffer(10)), true), false, 'an ArrayBuffer');
    assert.equal(acceptScreenFrame(frame('abc'), true), false, 'a string');
    assert.equal(acceptScreenFrame(frame(new Uint8Array(0)), true), false, '0 bytes');
    assert.equal(acceptScreenFrame(frame(new Uint8Array(1024 * 1024 + 1)), true), false, '1 048 577 bytes');
    assert.equal(acceptScreenFrame(null, true), false);
});

// The yellow capture border (operator, 2026-11-22). Chromium 156 captures a window with WGC; Windows before build
// 20348 cannot turn the border off. A thumbnail keeps the aspect ratio of its source in 320 x 180 (this PC: a
// 2560 x 1440 window gives 320 x 180, a 1000 x 500 window gives 320 x 160, a 3440 x 1440 screen gives 320 x 134).
test('capture border: only a window share on Windows before build 20348 has the border', () => {
    assert.equal(windowShareHasBorder('win32', '10.0.19045'), true, 'Windows 10 22H2');
    assert.equal(windowShareHasBorder('win32', '10.0.17763'), true);
    assert.equal(windowShareHasBorder('win32', '10.0.20348'), false, 'IsBorderRequired is available');
    assert.equal(windowShareHasBorder('win32', '10.0.22631'), false, 'Windows 11');
    assert.equal(windowShareHasBorder('win32', '10.0.26100'), false, 'Windows 11 24H2');
    assert.equal(windowShareHasBorder('win32', ''), false);
    assert.equal(windowShareHasBorder('linux', '6.8.0'), false);
    assert.equal(windowShareHasBorder('darwin', '24.0.0'), false);
});

test('capture border: a window with the thumbnail size of one screen gets that screen ID, only where the border shows', async () => {
    const sized = (width, height) => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(10, 1), getSize: () => ({ width, height }) });
    const sources = [
        { id: 'window:21:0', name: 'Game', thumbnail: sized(320, 180) },
        { id: 'window:22:0', name: 'Wide game', thumbnail: sized(320, 134) },
        { id: 'window:23:0', name: 'Maximized', thumbnail: sized(320, 175) },
        { id: 'window:24:0', name: 'Minimized', thumbnail: { isEmpty: () => true, toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 0, height: 0 }) } },
        { id: 'window:25:0', name: 'No size', thumbnail: thumb(10) },
        { id: 'screen:0:0', name: 'Screen 1', thumbnail: sized(320, 180) },
        { id: 'screen:1:0', name: 'Screen 2', thumbnail: sized(320, 134) }
    ];
    const listOf = async (windowBorder, list = sources) => createScreenSources({ desktopCapturer: { getSources: async () => list },
        isRoomFrame: () => true, isIdle: () => false, windowBorder }).list();
    const marks = list => list.filter(e => e.kind === 'window').map(e => [e.id, e.fillsScreen, e.screenId]);
    assert.deepEqual(marks(await listOf(true)), [
        ['window:21:0', true, 'screen:0:0'], ['window:22:0', true, 'screen:1:0'], ['window:23:0', false, null],
        ['window:24:0', false, null], ['window:25:0', false, null]]);
    assert.ok(marks(await listOf(false)).every(([, fills, screenId]) => fills === false && screenId === null), 'no border: no mark');
    const listed = await listOf(true);
    assert.deepEqual(Object.keys(listed.find(e => e.id === 'screen:0:0')).sort(), ['id', 'kind', 'name', 'thumbnail']);
    assert.deepEqual(Object.keys(listed.find(e => e.id === 'window:21:0')).sort(), ['fillsScreen', 'id', 'kind', 'name', 'screenId', 'thumbnail'],
        'the window gets no size and no source object');
    // Two screens with the same size: the window fills a screen, but which one is not known.
    const twins = [sources[0], { id: 'screen:0:0', name: 'Screen 1', thumbnail: sized(320, 180) }, { id: 'screen:1:0', name: 'Screen 2', thumbnail: sized(320, 180) }];
    assert.deepEqual(marks(await listOf(true, twins)), [['window:21:0', true, null]]);
});

// 1.0.4 (operator, 2026-11-23): Share of a window that fills a screen uses that screen, with no extra click. The guard
// (share-guard.mjs, here a fake) gives the window state; the main process gives the physical display rectangles.
function guardedSetup({ state, fail = false, displays } = {}) {
    const sized = (width, height) => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(10, 1), getSize: () => ({ width, height }) });
    const sources = [
        { id: 'window:132456:0', name: 'Game', thumbnail: sized(320, 180) },
        { id: 'window:22:0', name: 'Notes', thumbnail: sized(320, 160) },
        { id: 'screen:0:0', name: 'Screen 1', thumbnail: sized(320, 180), display_id: '101' },
        { id: 'screen:1:0', name: 'Screen 2', thumbnail: sized(320, 134), display_id: '202' }
    ];
    const calls = [];
    const logs = [];
    const guard = {
        open: async hwnd => { calls.push(['open', hwnd]); if (fail) throw new Error('The window guard did not start.'); return state; },
        arm: monitor => { calls.push(['arm', monitor]); return { active: true, paused: true, reason: 'starting' }; },
        state: () => ({ active: true, paused: true, reason: 'starting' }),
        close: why => { calls.push(['close', why]); return true; }
    };
    const screen = createScreenSources({ desktopCapturer: { getSources: async () => sources }, isRoomFrame: frame => frame === roomFrame,
        isIdle: () => false, log: (level, text) => logs.push(`${level} ${text}`), windowBorder: true, guard,
        displays: () => displays ?? [{ id: 101, rect: { left: 0, top: 0, right: 2560, bottom: 1440 } },
            { id: 202, rect: { left: -3440, top: 12, right: 0, bottom: 1452 } }] });
    return { screen, calls, logs, sources };
}
const FULL = { alive: true, foreground: true, minimized: false, visible: true, rect: { left: 0, top: 0, right: 2560, bottom: 1440 },
    monitor: { left: 0, top: 0, right: 2560, bottom: 1440 } };

test('fill switch: Share of a window that fills a screen captures that screen, with the guard and the window name', async () => {
    const { screen, calls, logs, sources } = guardedSetup({ state: FULL });
    await screen.list();
    const info = await screen.pick('window:132456:0', 'auto');
    assert.equal(info.name, 'Game', 'the bar shows the window name');
    assert.equal(info.guard?.paused, true, 'the share starts paused');
    assert.deepEqual(calls.slice(0, 3), [['close', 'repick'], ['open', 132456], ['arm', FULL.monitor]]);
    const answer = ask(screen, {});
    assert.equal(answer.video, sources[2], 'the screen of the window, not the window');
    assert.ok(logs.includes('EVENT screen capture request granted kind=screen from=window'), 'the log line of the path with no border');
    assert.ok(logs.every(l => !/Game|132456/.test(l)), 'no window name and no handle in the log');
    screen.clear();
    assert.deepEqual(calls.at(-1), ['close', 'clear'], 'clear stops the guard');
});

test('fill switch: a window that does not fill its screen, a failed guard and the border switch give the window share', async () => {
    const small = guardedSetup({ state: { ...FULL, rect: { left: 100, top: 100, right: 1380, bottom: 820 } } });
    await small.screen.list();
    const info = await small.screen.pick('window:132456:0', 'auto');
    assert.equal(info.guard, undefined);
    assert.equal(ask(small.screen, {}).video, small.sources[0], 'a 1280 x 720 window stays a window share');
    assert.deepEqual(small.calls.at(-1), ['close', 'no-fill']);

    const failed = guardedSetup({ state: FULL, fail: true });
    await failed.screen.list();
    await failed.screen.pick('window:132456:0', 'auto');
    assert.equal(ask(failed.screen, {}).video, failed.sources[0], 'no guard: no screen');

    const border = guardedSetup({ state: FULL });
    await border.screen.list();
    await border.screen.pick('window:132456:0', 'auto', { border: true });
    assert.equal(ask(border.screen, {}).video, border.sources[0]);
    assert.equal(border.calls.some(c => c[0] === 'open'), false, 'the border switch starts no guard');

    const other = guardedSetup({ state: FULL });
    await other.screen.list();
    await other.screen.pick('window:22:0', 'auto');
    assert.equal(other.calls.some(c => c[0] === 'open'), false, 'a window with no screen thumbnail size starts no guard');
    await other.screen.pick('screen:0:0', 'auto');
    assert.equal(other.calls.some(c => c[0] === 'open'), false, 'a screen starts no guard');
});
