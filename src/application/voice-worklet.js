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

class VoicePlayback extends AudioWorkletProcessor {
    constructor() {
        super();
        // origin -> { chunks: Float32Array[], offset, size, playing }
        this.origins = new Map();
        this.port.onmessage = ({ data }) => {
            if (!data) return;
            if (data.type === 'samples') this.add(data.origin, data.samples);
            else if (data.type === 'remove') this.origins.delete(data.origin);
            else if (data.type === 'clear') this.origins.clear();
        };
    }

    add(origin, samples) {
        let o = this.origins.get(origin);
        if (!o) {
            o = { chunks: [], offset: 0, size: 0, playing: false };
            this.origins.set(origin, o);
        }
        o.chunks.push(samples);
        o.size += samples.length;
        while (o.size > MAX_SAMPLES && o.chunks.length > 1) {
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
                for (let k = 0; k < n; k++) out[i + k] += chunk[o.offset + k];
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
        for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
        return true;
    }
}

registerProcessor('voice-capture', VoiceCapture);
registerProcessor('voice-playback', VoicePlayback);
