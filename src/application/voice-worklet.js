'use strict';

// Audio worklet processors for voice over libp2p.
// 'voice-capture': collects mono input in blocks of 960 samples (20 ms at 48 kHz) and posts each block.
// 'voice-playback': one jitter buffer for each origin, mixes all origins to the output.

const BLOCK = 960;

class VoiceCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.block = new Float32Array(BLOCK);
        this.fill = 0;
    }

    process(inputs) {
        const input = inputs[0];
        const channel = input && input[0];
        if (!channel) return true;
        let i = 0;
        while (i < channel.length) {
            const n = Math.min(BLOCK - this.fill, channel.length - i);
            this.block.set(channel.subarray(i, i + n), this.fill);
            this.fill += n;
            i += n;
            if (this.fill === BLOCK) {
                const out = this.block;
                this.port.postMessage(out, [out.buffer]);
                this.block = new Float32Array(BLOCK);
                this.fill = 0;
            }
        }
        return true;
    }
}

// Jitter buffer: playback of an origin starts when 60 ms of samples are in its queue.
// When the queue becomes empty, the origin waits again for 60 ms of samples.
const START_SAMPLES = 2880;
// Limit of the queue (240 ms). Older samples are dropped to keep the audio live.
const MAX_SAMPLES = 11520;
// G4: the gain of an origin is 0 to 2 (200 %). A soft limiter above LIMIT_START keeps the mix below 1, thus a boost
// does not clip. A sample at or below LIMIT_START does not change.
const MAX_GAIN = 2;
const LIMIT_START = 0.9;
function limit(x) {
    const a = Math.abs(x);
    if (a <= LIMIT_START) return x;
    const room = 1 - LIMIT_START;
    return Math.sign(x) * (LIMIT_START + room * Math.tanh((a - LIMIT_START) / room));
}

class VoicePlayback extends AudioWorkletProcessor {
    constructor() {
        super();
        // origin -> { chunks: Float32Array[], offset, size, playing }
        this.origins = new Map();
        this.port.onmessage = ({ data }) => {
            if (!data) return;
            if (data.type === 'samples') this.add(data.origin, data.samples);
            else if (data.type === 'gain' && Number.isFinite(data.gain) && data.gain >= 0 && data.gain <= MAX_GAIN) {
                this.origin(data.origin).gain = data.gain;
            } else if (data.type === 'remove') this.origins.delete(data.origin);
            else if (data.type === 'clear') this.origins.clear();
            // Diagnostics (1.0.1): the counters of each origin since the last question, then zero.
            else if (data.type === 'stats') {
                const origins = {};
                for (const [origin, o] of this.origins) {
                    origins[origin] = { trims: o.trims };
                    o.trims = 0;
                }
                this.port.postMessage({ type: 'stats', origins });
            }
        };
    }

    origin(origin) {
        let o = this.origins.get(origin);
        if (!o) {
            // trims (diagnostics): the chunks dropped above MAX_SAMPLES. An empty queue is not counted here: the gate of
            // the sender empties it at each pause (voice.js counts the late frames).
            o = { chunks: [], offset: 0, size: 0, playing: false, gain: 1, trims: 0 };
            this.origins.set(origin, o);
        }
        return o;
    }

    add(origin, samples) {
        const o = this.origin(origin);
        o.chunks.push(samples);
        o.size += samples.length;
        while (o.size > MAX_SAMPLES && o.chunks.length > 1) {
            o.trims++;
            const first = o.chunks.shift();
            o.size -= first.length - o.offset;
            o.offset = 0;
        }
        if (o.size >= START_SAMPLES) o.playing = true;
    }

    process(inputs, outputs) {
        const out = outputs[0][0];
        if (!out) return true;
        out.fill(0);
        for (const o of this.origins.values()) {
            if (!o.playing) continue;
            let i = 0;
            while (i < out.length && o.chunks.length > 0) {
                const chunk = o.chunks[0];
                const n = Math.min(out.length - i, chunk.length - o.offset);
                for (let k = 0; k < n; k++) out[i + k] += chunk[o.offset + k] * o.gain;
                i += n;
                o.offset += n;
                o.size -= n;
                if (o.offset >= chunk.length) {
                    o.chunks.shift();
                    o.offset = 0;
                }
            }
            if (o.size <= 0) o.playing = false;
        }
        for (let i = 0; i < out.length; i++) out[i] = limit(out[i]);
        for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
        return true;
    }
}

registerProcessor('voice-capture', VoiceCapture);
registerProcessor('voice-playback', VoicePlayback);
