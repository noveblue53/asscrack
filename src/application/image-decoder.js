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

    // Copy image: the image is at the top left corner of the page, where the main process calls copyImageAt(0, 0).
    // It stays until the next copy, because copyImageAt reads it after this answer.
    let shown = null;
    window.imageDecoder.onCopy?.(async (id, bytes) => {
        if (shown) { URL.revokeObjectURL(shown.src); shown.remove(); shown = null; }
        let ok = false;
        try {
            const image = new Image();
            image.className = 'copy';
            image.src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
            document.body.prepend(image);
            shown = image;
            await image.decode();
            ok = image.naturalWidth > 0 && image.naturalHeight > 0;
        } catch { ok = false; }
        window.imageDecoder.copyReady(id, ok);
    });

    window.imageDecoder.onJob(async (id, bytes, size) => {
        let out = null;
        try { out = await preview(bytes, size); } catch { out = null; }
        window.imageDecoder.reply(id, out);
    });
})();
