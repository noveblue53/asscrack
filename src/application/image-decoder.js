// L7: the page of the hidden image decoder window (sandboxed, no Node). It decodes the image of one job, makes the
// preview (at most 1024 px and 1 000 000 pixels, the rules of room-media.mjs) and gives a PNG back. The main
// process checks the PNG again.
(function () {
    'use strict';

    async function png(canvas) {
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        return new Uint8Array(await blob.arrayBuffer());
    }

    async function preview(bytes, size) {
        const bitmap = await createImageBitmap(new Blob([bytes]));
        try {
            const { width, height } = bitmap;
            // A JPEG with an EXIF orientation of 90 or 270 degrees gives the two sizes in the other order.
            const same = width === size.width && height === size.height;
            const turned = width === size.height && height === size.width;
            if (!width || !height || !(same || turned)) return null;
            const ratio = Math.min(1, 1024 / Math.max(width, height), Math.sqrt(1000000 / (width * height)));
            let w = Math.max(1, Math.floor(width * ratio)), h = Math.max(1, Math.floor(height * ratio));
            for (let i = 0; i < 8; i++) {
                const canvas = new OffscreenCanvas(w, h);
                canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
                const out = await png(canvas);
                if (out.length && out.length <= size.limit) return out;
                w = Math.max(1, Math.floor(w * 0.72));
                h = Math.max(1, Math.floor(h * 0.72));
            }
            return null;
        } finally {
            bitmap.close();
        }
    }

    // Profile pictures (avatars.mjs). mode 'avatar': the square part crop { x, y, w, h } (parts of 1 of the image) of the
    // user's own picture to a 128 x 128 WebP (PNG when WebP is too large or not there) of at most size.limit bytes.
    // mode 'avatar-show': a 128 x 128 picture (of a peer or the own one) to the bitmap pixels for the notification icon
    // (BGRA, premultiplied, 65 536 bytes) and then a PNG for the window. The main process checks both and decodes none.
    const SIDE = 128;
    function bitmapOk(bitmap, size) {
        const { width, height } = bitmap;
        const same = width === size.width && height === size.height;
        const turned = width === size.height && height === size.width;
        return width > 0 && height > 0 && (same || turned);
    }
    async function encodeAvatar(canvas, limit) {
        for (const quality of [0.9, 0.8, 0.7, 0.55, 0.4]) {
            const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
            if (blob.type !== 'image/webp') break;
            if (blob.size <= limit) return new Uint8Array(await blob.arrayBuffer());
        }
        const out = await png(canvas);
        return out.length <= limit ? out : null;
    }
    async function avatar(bytes, size) {
        const bitmap = await createImageBitmap(new Blob([bytes]));
        try {
            if (!bitmapOk(bitmap, size)) return null;
            const canvas = new OffscreenCanvas(SIDE, SIDE);
            const context = canvas.getContext('2d');
            context.imageSmoothingQuality = 'high';
            if (size.mode === 'avatar-show') {
                if (bitmap.width !== SIDE || bitmap.height !== SIDE) return null;
                context.drawImage(bitmap, 0, 0);
                const rgba = context.getImageData(0, 0, SIDE, SIDE).data;
                const out = new Uint8Array(SIDE * SIDE * 4);
                for (let i = 0; i < out.length; i += 4) {
                    const a = rgba[i + 3];
                    out[i] = Math.round(rgba[i + 2] * a / 255);
                    out[i + 1] = Math.round(rgba[i + 1] * a / 255);
                    out[i + 2] = Math.round(rgba[i] * a / 255);
                    out[i + 3] = a;
                }
                const image = await png(canvas);
                if (!image.length || image.length > size.limit) return null;
                const both = new Uint8Array(out.length + image.length);
                both.set(out, 0);
                both.set(image, out.length);
                return both;
            }
            const crop = size.crop ?? {};
            const part = v => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : NaN);
            const x = part(crop.x), y = part(crop.y), w = part(crop.w), h = part(crop.h);
            if ([x, y, w, h].some(Number.isNaN) || w <= 0 || h <= 0) return null;
            const sx = x * bitmap.width, sy = y * bitmap.height;
            const sw = Math.max(1, Math.min(bitmap.width - sx, w * bitmap.width));
            const sh = Math.max(1, Math.min(bitmap.height - sy, h * bitmap.height));
            context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, SIDE, SIDE);
            return await encodeAvatar(canvas, size.limit);
        } finally {
            bitmap.close();
        }
    }

    // Copy image: the image is at the top left corner of the page, where the main process calls copyImageAt(0, 0).
    // It stays until the next copy, because copyImageAt reads it after this answer. The src is a data: URL, because
    // copyImageAt also writes an <img> with this src as HTML Format: a browser or an editor can read a data: URL, but
    // not a blob: URL of this page.
    function dataUrl(bytes) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(new Blob([bytes], { type: 'image/png' }));
        });
    }
    let shown = null;
    window.imageDecoder.onCopy?.(async (id, bytes) => {
        if (shown) { shown.remove(); shown = null; }
        let ok = false;
        try {
            const image = new Image();
            image.className = 'copy';
            image.src = await dataUrl(bytes);
            document.body.prepend(image);
            shown = image;
            await image.decode();
            ok = image.naturalWidth > 0 && image.naturalHeight > 0;
        } catch { ok = false; }
        window.imageDecoder.copyReady(id, ok);
    });

    window.imageDecoder.onJob(async (id, bytes, size) => {
        let out = null;
        try { out = size?.mode === 'avatar' || size?.mode === 'avatar-show' ? await avatar(bytes, size) : await preview(bytes, size); }
        catch { out = null; }
        window.imageDecoder.reply(id, out);
    });
})();
