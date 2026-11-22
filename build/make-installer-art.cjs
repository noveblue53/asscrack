// 1.0.1: makes the bitmaps of the installer (electron-builder nsis, the assisted installer) from the art of the app.
// Run: electron build/make-installer-art.cjs [--png-dir <dir>]
// - build/installerSidebar.bmp (164 x 314): the left side of the Welcome and Finish pages, also of the uninstaller.
// - build/installerHeader.bmp (150 x 57): the right side of the header of the other pages.
// electron-builder finds the two files by their names in build/ (the build resources folder): package.json does not
// name them. The colors are the Aero Classic theme of themes.css (the default theme); the logo is img/logo.svg.
// The method of make-icon.cjs: the art is drawn on an N x M canvas in a hidden window, not with capturePage().
// NSIS needs a BMP with no alpha: 24-bit BI_RGB, rows from the bottom up, each row padded to 4 bytes.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const svgPath = path.join(root, 'src', 'application', 'img', 'logo.svg');
const pngDirArg = process.argv.indexOf('--png-dir');
const pngDir = pngDirArg > 0 ? path.resolve(process.argv[pngDirArg + 1]) : null;

// Aero Classic (themes.css). surface-raised is also MUI_BGCOLOR in build/installer.nsh.
const THEME = { frameTop: '#377657', frameMid: '#245d42', frameBottom: '#164631', surface: '#e0f2e9',
    surfaceRaised: '#f1faf5', map: '#d1eeeb', accent: '#12634d', ink: '#182f28' };

function bmp(width, height, rgba) {
    const row = Math.ceil((width * 3) / 4) * 4;
    const size = 54 + row * height;
    const out = Buffer.alloc(size);
    out.write('BM', 0, 'ascii');
    out.writeUInt32LE(size, 2);
    out.writeUInt32LE(54, 10);
    out.writeUInt32LE(40, 14);
    out.writeInt32LE(width, 18);
    out.writeInt32LE(height, 22);
    out.writeUInt16LE(1, 26);
    out.writeUInt16LE(24, 28);
    out.writeUInt32LE(0, 30); // BI_RGB
    out.writeUInt32LE(row * height, 34);
    out.writeInt32LE(2835, 38); // 72 DPI
    out.writeInt32LE(2835, 42);
    for (let y = 0; y < height; y++) {
        const dst = 54 + (height - 1 - y) * row;
        for (let x = 0; x < width; x++) {
            const s = (y * width + x) * 4, d = dst + x * 3;
            out[d] = rgba[s + 2];
            out[d + 1] = rgba[s + 1];
            out[d + 2] = rgba[s];
        }
    }
    return out;
}

// The drawing code runs in the page. It gets the theme, the logo as a data URL and the size.
const DRAW = {
    sidebar: `(g, w, h, logo, t) => {
        // The login screen of the app: the sky of the theme from the frame color down to the surface color.
        let f = g.createLinearGradient(0, 0, w * 0.27, h);
        f.addColorStop(0, t.frameTop); f.addColorStop(0.45, t.frameMid); f.addColorStop(1, t.surface);
        g.fillStyle = f; g.fillRect(0, 0, w, h);
        f = g.createRadialGradient(w * 0.86, -h * 0.1, 0, w * 0.86, -h * 0.1, h * 0.7);
        f.addColorStop(0, 'rgba(209, 238, 235, 0.55)'); f.addColorStop(1, 'rgba(209, 238, 235, 0)');
        g.fillStyle = f; g.fillRect(0, 0, w, h);
        // A soft glass band behind the logo.
        f = g.createLinearGradient(0, 0, 0, 150);
        f.addColorStop(0, 'rgba(255, 255, 255, 0.22)'); f.addColorStop(1, 'rgba(255, 255, 255, 0)');
        g.fillStyle = f; g.fillRect(0, 0, w, 150);
        const size = 96;
        g.shadowColor = 'rgba(0, 30, 20, 0.45)'; g.shadowBlur = 12; g.shadowOffsetY = 4;
        g.drawImage(logo, (w - size) / 2, 52, size, size);
        g.shadowColor = 'rgba(0, 30, 20, 0.6)'; g.shadowBlur = 4; g.shadowOffsetY = 1;
        g.fillStyle = '#ffffff';
        g.textAlign = 'center'; g.textBaseline = 'alphabetic';
        g.font = 'italic 700 23px "Trebuchet MS", "Segoe UI", sans-serif';
        g.fillText('ASSCRACK', w / 2, 182);
    }`,
    header: `(g, w, h, logo, t) => {
        g.fillStyle = t.surfaceRaised; g.fillRect(0, 0, w, h);
        const size = 44;
        g.shadowColor = 'rgba(0, 30, 20, 0.3)'; g.shadowBlur = 5; g.shadowOffsetY = 2;
        g.drawImage(logo, w - size - 8, (h - size) / 2, size, size);
        g.shadowColor = 'transparent';
        g.fillStyle = t.accent;
        g.textAlign = 'right'; g.textBaseline = 'middle';
        g.font = 'italic 700 17px "Trebuchet MS", "Segoe UI", sans-serif';
        g.fillText('ASSCRACK', w - size - 14, h / 2 + 1);
    }`
};
const ART = [
    { name: 'installerSidebar', width: 164, height: 314, draw: DRAW.sidebar },
    { name: 'installerHeader', width: 150, height: 57, draw: DRAW.header }
];

async function main() {
    const svg = fs.readFileSync(svgPath, 'utf8');
    const logo = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: false } });
    await win.loadURL('about:blank');
    for (const art of ART) {
        const out = await win.webContents.executeJavaScript(`(async () => {
            const logo = new Image();
            logo.src = ${JSON.stringify(logo)};
            await logo.decode();
            await document.fonts.load('italic 700 20px "Trebuchet MS"');
            const c = document.createElement('canvas');
            c.width = ${art.width}; c.height = ${art.height};
            const g = c.getContext('2d');
            g.imageSmoothingEnabled = true;
            g.imageSmoothingQuality = 'high';
            (${art.draw})(g, ${art.width}, ${art.height}, logo, ${JSON.stringify(THEME)});
            return { rgba: Array.from(g.getImageData(0, 0, ${art.width}, ${art.height}).data), png: c.toDataURL('image/png') };
        })()`);
        const file = path.join(__dirname, `${art.name}.bmp`);
        const data = bmp(art.width, art.height, Buffer.from(out.rgba));
        fs.writeFileSync(file, data);
        if (pngDir) {
            fs.mkdirSync(pngDir, { recursive: true });
            fs.writeFileSync(path.join(pngDir, `${art.name}.png`), Buffer.from(out.png.split(',')[1], 'base64'));
        }
        console.log(`wrote ${path.relative(root, file)} ${art.width}x${art.height} ${data.length} bytes`);
    }
    win.destroy();
}

app.whenReady().then(main).then(() => app.exit(0), err => {
    console.error('make-installer-art failed: ' + (err?.stack ?? err));
    app.exit(1);
});
