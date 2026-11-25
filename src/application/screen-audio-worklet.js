'use strict';

// Screen share audio worklet processors (48 kHz stereo, 20 ms blocks).
// 'screen-audio-capture': used in Chromium loopback fallback mode to chunk MediaStream audio into 960-sample stereo
//   blocks for WebCodecs Opus encoding.
// 'screen-audio-playback': low-latency stereo jitter buffer (starts at 60 ms, caps at 500 ms) so audio stays tightly
//   synced with the shared screen video.

const BLOCK = 960;

class ScreenAudioCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.left = new Float32Array(BLOCK);
        this.right = new Float32Array(BLOCK);
        this.fill = 0;
    }

    process(inputs) {
        const input = inputs[0];
        const l = input && input[0];
        if (!l) return true;
        const r = input[1] ?? l;
        let i = 0;
        while (i < l.length) {
            const n = Math.min(BLOCK - this.fill, l.length - i);
            this.left.set(l.subarray(i, i + n), this.fill);
            this.right.set(r.subarray(i, i + n), this.fill);
            this.fill += n;
            i += n;
            if (this.fill === BLOCK) {
                const left = this.left, right = this.right;
                this.port.postMessage({ left, right }, [left.buffer, right.buffer]);
                this.left = new Float32Array(BLOCK);
                this.right = new Float32Array(BLOCK);
                this.fill = 0;
            }
        }
        return true;
    }
}

const START_SAMPLES = 2880; // 60 ms at 48 kHz
const MAX_SAMPLES = 24000;  // 500 ms cap

class ScreenAudioPlayback extends AudioWorkletProcessor {
    constructor() {
        super();
        this.chunks = [];
        this.offset = 0;
        this.size = 0;
        this.playing = false;
        this.port.onmessage = ({ data }) => {
            if (!data) return;
            if (data.type === 'samples' && data.left instanceof Float32Array && data.right instanceof Float32Array &&
                data.left.length === data.right.length) {
                this.add(data.left, data.right);
            } else if (data.type === 'clear') {
                this.chunks = [];
                this.offset = 0;
                this.size = 0;
                this.playing = false;
            }
        };
    }

    add(left, right) {
        this.chunks.push({ left, right });
        this.size += left.length;
        while (this.size > MAX_SAMPLES && this.chunks.length > 1) {
            const first = this.chunks.shift();
            this.size -= first.left.length - this.offset;
            this.offset = 0;
        }
        if (this.size >= START_SAMPLES) this.playing = true;
    }

    process(_inputs, outputs) {
        const out = outputs[0];
        const l = out[0], r = out[1] ?? out[0];
        if (!l) return true;
        l.fill(0);
        if (r !== l) r.fill(0);
        if (!this.playing) return true;
        let i = 0;
        while (i < l.length && this.chunks.length > 0) {
            const chunk = this.chunks[0];
            const n = Math.min(l.length - i, chunk.left.length - this.offset);
            l.set(chunk.left.subarray(this.offset, this.offset + n), i);
            if (r !== l) r.set(chunk.right.subarray(this.offset, this.offset + n), i);
            i += n;
            this.offset += n;
            this.size -= n;
            if (this.offset >= chunk.left.length) {
                this.chunks.shift();
                this.offset = 0;
            }
        }
        if (this.size <= 0) this.playing = false;
        return true;
    }
}

registerProcessor('screen-audio-capture', ScreenAudioCapture);
registerProcessor('screen-audio-playback', ScreenAudioPlayback);
