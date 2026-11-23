'use strict';

// Room music: the audio worklet processors (MU-5). Stereo at 48 kHz.
// 'music-capture': the DJ. Collects the output of the <audio> element in blocks of 960 samples (20 ms) for each of the
//   two channels and posts each block pair to music.js (the Opus encoder).
// 'music-playback': a listener. One jitter buffer for the stream of the DJ. The music has no need of a short delay,
//   thus the buffer starts at 200 ms and keeps at most 2 s.

const BLOCK = 960;

class MusicCapture extends AudioWorkletProcessor {
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

const START_SAMPLES = 9600;
const MAX_SAMPLES = 96000;

class MusicPlayback extends AudioWorkletProcessor {
    constructor() {
        super();
        // { left, right } chunks of the same length.
        this.chunks = [];
        this.offset = 0;
        this.size = 0;
        this.playing = false;
        this.trims = 0;
        this.underruns = 0;
        this.port.onmessage = ({ data }) => {
            if (!data) return;
            if (data.type === 'samples' && data.left instanceof Float32Array && data.right instanceof Float32Array &&
                data.left.length === data.right.length) this.add(data.left, data.right);
            else if (data.type === 'clear') { this.chunks = []; this.offset = 0; this.size = 0; this.playing = false; }
            else if (data.type === 'stats') {
                this.port.postMessage({ type: 'stats', trims: this.trims, underruns: this.underruns, buffered: this.size });
                this.trims = 0;
                this.underruns = 0;
            }
        };
    }

    add(left, right) {
        this.chunks.push({ left, right });
        this.size += left.length;
        while (this.size > MAX_SAMPLES && this.chunks.length > 1) {
            this.trims++;
            const first = this.chunks.shift();
            this.size -= first.left.length - this.offset;
            this.offset = 0;
        }
        if (this.size >= START_SAMPLES) this.playing = true;
    }

    process(inputs, outputs) {
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
        if (this.size <= 0) {
            this.playing = false;
            if (i < l.length) this.underruns++;
        }
        return true;
    }
}

registerProcessor('music-capture', MusicCapture);
registerProcessor('music-playback', MusicPlayback);
