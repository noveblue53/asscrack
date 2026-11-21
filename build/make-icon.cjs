// Makes src/application/img/app.ico from src/application/img/logo.svg. Run: electron build/make-icon.cjs [--png-dir <dir>]
// The SVG is drawn on an N x N canvas in a hidden window. capturePage() is not used: the display scale changes its size.
// The 256 px image is PNG data. The other images are 32-bit BGRA DIB data (bottom-up rows, AND mask of zeros).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const root = path.join(__dirname, '..');
const svgPath = path.join(root, 'src', 'application', 'img', 'logo.svg');
const icoPath = path.join(root, 'src', 'application', 'img', 'app.ico');
const pngDirArg = process.argv.indexOf('--png-dir');
const pngDir = pngDirArg > 0 ? path.resolve(process.argv[pngDirArg + 1]) : null;

function dib(n, rgba) {
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(n, 4);
    header.writeInt32LE(2 * n, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    header.writeUInt32LE(0, 16); // BI_RGB
    header.writeUInt32LE(n * n * 4, 20);
    const pixels = Buffer.alloc(n * n * 4);
    for (let y = 0; y < n; y++) {
        const src = y * n * 4;
        const dst = (n - 1 - y) * n * 4;
        for (let x = 0; x < n; x++) {
            const s = src + x * 4, d = dst + x * 4;
            pixels[d] = rgba[s + 2];
            pixels[d + 1] = rgba[s + 1];
            pixels[d + 2] = rgba[s];
            pixels[d + 3] = rgba[s + 3];
        }
    }
    const maskRow = Math.ceil(n / 32) * 4;
    return Buffer.concat([header, pixels, Buffer.alloc(maskRow * n)]);
}

function ico(images) {
    const head = Buffer.alloc(6 + 16 * images.length);
    head.writeUInt16LE(0, 0);
    head.writeUInt16LE(1, 2);
    head.writeUInt16LE(images.length, 4);
    let offset = head.length;
    images.forEach((img, i) => {
        const e = 6 + 16 * i;
        head.writeUInt8(img.size >= 256 ? 0 : img.size, e);
        head.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1);
        head.writeUInt8(0, e + 2);
        head.writeUInt8(0, e + 3);
        head.writeUInt16LE(1, e + 4);
        head.writeUInt16LE(32, e + 6);
        head.writeUInt32LE(img.data.length, e + 8);
        head.writeUInt32LE(offset, e + 12);
        offset += img.data.length;
    });
    return Buffer.concat([head, ...images.map(img => img.data)]);
}

async function main() {
    const svg = fs.readFileSync(svgPath, 'utf8');
    const src = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: false } });
    await win.loadURL('about:blank');
    const images = [];
    for (const n of SIZES) {
        const out = await win.webContents.executeJavaScript(`(async () => {
            const img = new Image();
            img.src = ${JSON.stringify(src)};
            await img.decode();
            const c = document.createElement('canvas');
            c.width = ${n}; c.height = ${n};
            const g = c.getContext('2d');
            g.imageSmoothingEnabled = true;
            g.imageSmoothingQuality = 'high';
            g.drawImage(img, 0, 0, ${n}, ${n});
            return { rgba: Array.from(g.getImageData(0, 0, ${n}, ${n}).data), png: c.toDataURL('image/png') };
        })()`);
        const png = Buffer.from(out.png.split(',')[1], 'base64');
        if (pngDir) {
            fs.mkdirSync(pngDir, { recursive: true });
            fs.writeFileSync(path.join(pngDir, `icon-${n}.png`), png);
        }
        const data = n === 256 ? png : dib(n, Buffer.from(out.rgba));
        images.push({ size: n, data });
        console.log(`${n}x${n} ${n === 256 ? 'PNG' : 'DIB BGRA32'} ${data.length} bytes`);
    }
    win.destroy();
    const file = ico(images);
    fs.writeFileSync(icoPath, file);
    console.log(`wrote ${path.relative(root, icoPath)} ${file.length} bytes, ${images.length} images`);
}

app.whenReady().then(main).then(() => app.exit(0), err => {
    console.error('make-icon failed: ' + (err?.stack ?? err));
    app.exit(1);
});
