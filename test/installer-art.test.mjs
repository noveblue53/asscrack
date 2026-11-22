// 1.0.1: the look of the installer (build/installer.nsh, build/installerSidebar.bmp, build/installerHeader.bmp).
// The bitmaps are 24-bit BMP files of the sizes of NSIS Modern UI 2, in the build resources folder where
// electron-builder finds them by name. The colors of installer.nsh are the Aero Classic colors of themes.css.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root));

function bmpInfo(data) {
    assert.equal(data.toString('ascii', 0, 2), 'BM');
    const offset = data.readUInt32LE(10);
    const width = data.readInt32LE(18), height = data.readInt32LE(22);
    const bits = data.readUInt16LE(28), compression = data.readUInt32LE(30);
    const row = Math.ceil((width * 3) / 4) * 4;
    // The pixel at (x, y) from the top, as [r, g, b] (the rows are from the bottom up).
    const pixel = (x, y) => {
        const at = offset + (height - 1 - y) * row + x * 3;
        return [data[at + 2], data[at + 1], data[at]];
    };
    return { width, height, bits, compression, size: data.length, expected: offset + row * Math.abs(height), pixel };
}

test('the installer bitmaps have the Modern UI 2 sizes and the BMP form of NSIS', async () => {
    const pkg = JSON.parse(await read('package.json'));
    // electron-builder reads installerSidebar.bmp and installerHeader.bmp from the build resources folder (build/).
    assert.ok([undefined, 'build'].includes(pkg.build.directories?.buildResources));
    for (const key of ['installerSidebar', 'installerHeader', 'uninstallerSidebar']) assert.equal(pkg.build.nsis[key], undefined, key);
    for (const [name, width, height] of [['build/installerSidebar.bmp', 164, 314], ['build/installerHeader.bmp', 150, 57]]) {
        const info = bmpInfo(await read(name));
        assert.deepEqual([info.width, info.height, info.bits, info.compression], [width, height, 24, 0], name);
        assert.equal(info.size, info.expected, name);
    }
    // The art: the logo (cyan) in the middle of the sidebar, the green frame color at its top.
    const side = bmpInfo(await read('build/installerSidebar.bmp'));
    const [r, g, b] = side.pixel(60, 110);
    assert.ok(b > r + 60 && g > r + 60, `the logo at the sidebar middle: ${[r, g, b]}`);
    const top = side.pixel(10, 40);
    assert.ok(top[1] > top[0] && top[1] > top[2], `green at the top of the sidebar: ${top}`);
});

test('installer.nsh uses the font and the Aero Classic colors of the app, and adds a Welcome page', async () => {
    const nsh = String(await read('build/installer.nsh'));
    const themes = String(await read('src/application/themes.css'));
    const classic = themes.slice(0, themes.indexOf('}'));
    const color = name => new RegExp(`${name}:\\s*#([0-9a-f]{6})`, 'i').exec(classic)[1].toUpperCase();
    assert.match(nsh, /^SetFont "Segoe UI" 9$/m);
    assert.match(nsh, new RegExp(`^!define MUI_BGCOLOR "${color('--surface-raised')}"$`, 'm'));
    assert.match(nsh, new RegExp(`^!define MUI_TEXTCOLOR "${color('--ink')}"$`, 'm'));
    assert.match(nsh, new RegExp(`SetCtlColors \\$mui\\.WelcomePage\\.Title "${color('--accent')}"`));
    assert.match(nsh, /CreateFont \$0 "Trebuchet MS" "15" "700" \/ITALIC/);
    // electron-builder (assistedInstaller.nsh) shows a Welcome page only from the macro customWelcomePage.
    const welcome = /!macro customWelcomePage([\s\S]*?)!macroend/.exec(nsh);
    assert.ok(welcome, 'the macro customWelcomePage');
    assert.match(welcome[1], /!insertmacro skipPageIfUpdated[\s\S]*!insertmacro MUI_PAGE_WELCOME/);
    assert.match(nsh, /!define MUI_FINISHPAGE_TITLE "ASSCRACK is installed"/);
});
