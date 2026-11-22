// Screen share, viewer side: the checks of the data from the sharer before it goes to the decoder
// (work-orders/astra/P8/DESIGN.md, section 2.9, "Limits at the viewer", package W5). A classic script: the room window
// loads it, and test/screen-frame-check.test.mjs loads it in node:vm. window.screenFrameCheck:
//   checkConfig(config, shareId): { ok, reason }. codec vp8, width 16 to 2560, height 16 to 1440, fps 1 to 60 or none.
//   checkKeyframe(bytes, width, height): { ok, reason }. The VP8 keyframe header (RFC 6386, section 9.1).
//   createFrameGate({ now, keyRequestMs }): the sequence rules. gate.config() after each CONFIG. gate.frame(seq, key)
//     gives { decode, keyRequest }: decode is false for a frame that must not go to the decoder.
(function (root) {
    'use strict';
    const LIMITS = Object.freeze({ minSize: 16, maxWidth: 2560, maxHeight: 1440, minFps: 1, maxFps: 60, headerBytes: 10 });

    const integerIn = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

    function checkConfig(config, shareId) {
        if (!config || typeof config !== 'object') return { ok: false, reason: 'no CONFIG' };
        if (config.codec !== undefined && config.codec !== 'vp8') return { ok: false, reason: 'codec' };
        if (!integerIn(config.width, LIMITS.minSize, LIMITS.maxWidth)) return { ok: false, reason: 'width' };
        if (!integerIn(config.height, LIMITS.minSize, LIMITS.maxHeight)) return { ok: false, reason: 'height' };
        if (config.fps !== undefined && config.fps !== null && !integerIn(config.fps, LIMITS.minFps, LIMITS.maxFps)) return { ok: false, reason: 'fps' };
        if (typeof shareId !== 'string' || config.shareId !== shareId) return { ok: false, reason: 'share' };
        return { ok: true, reason: null };
    }

    // Byte 0 bit 0 is 0 for a keyframe. Bytes 3 to 5 are the start code 9d 01 2a. Bytes 6 to 9 have the 14-bit width
    // and height, little endian, with 2 scale bits at the top.
    function checkKeyframe(bytes, width, height) {
        if (!bytes || typeof bytes.length !== 'number' || bytes.length < LIMITS.headerBytes) return { ok: false, reason: 'short' };
        if ((bytes[0] & 1) !== 0) return { ok: false, reason: 'not a keyframe' };
        if (bytes[3] !== 0x9d || bytes[4] !== 0x01 || bytes[5] !== 0x2a) return { ok: false, reason: 'start code' };
        const w = (bytes[6] | (bytes[7] << 8)) & 0x3fff;
        const h = (bytes[8] | (bytes[9] << 8)) & 0x3fff;
        if (w !== width) return { ok: false, reason: 'width' };
        if (h !== height) return { ok: false, reason: 'height' };
        return { ok: true, reason: null };
    }

    // The first frame after each CONFIG must be a keyframe. A delta frame after a gap of the sequence numbers does
    // not go to the decoder, and asks for a keyframe. A keyframe request goes out at most one time each keyRequestMs.
    function createFrameGate({ now, keyRequestMs = 2000 } = {}) {
        const clock = typeof now === 'function' ? now : () => Date.now();
        let needKey = true;
        let last = null;
        let lastRequest = -Infinity;
        function request() {
            const t = clock();
            if (t - lastRequest < keyRequestMs) return false;
            lastRequest = t;
            return true;
        }
        return {
            config() { needKey = true; },
            // A decoder reset (an error or a long queue): wait for a keyframe again.
            reset() { needKey = true; return request(); },
            requestKey: request,
            frame(seq, key) {
                const gap = last !== null && seq !== ((last + 1) >>> 0);
                last = seq;
                if (key) { needKey = false; return { decode: true, keyRequest: false }; }
                if (gap) needKey = true;
                if (needKey) return { decode: false, keyRequest: request() };
                return { decode: true, keyRequest: false };
            }
        };
    }

    root.screenFrameCheck = Object.freeze({ LIMITS, checkConfig, checkKeyframe, createFrameGate });
})(typeof window !== 'undefined' ? window : globalThis);
