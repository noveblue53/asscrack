// Local oscillator output only. Voice capture/transport never receives this graph.
(function () {
    // Own cues: join, leave, mute, unmute. Cues of other people (P11): other-join and other-leave are 3 short steps
    // (up and down), so they are not the 2-step own join and leave. mention and whisper are high and use a
    // triangle wave, so they are not voice cues: mention goes up, whisper is 2 equal soft tones.
    const pitches = {
        join: [440, 660], leave: [550, 330], mute: [220], unmute: [740],
        'other-join': [392, 494, 587], 'other-leave': [587, 494, 392],
        mention: [880, 1319], whisper: [1047, 1047]
    };
    const waves = { mention: 'triangle', whisper: 'triangle' };
    function play(context, kind, volume) {
        if (!Object.hasOwn(pitches, kind) || !Number.isFinite(volume) || volume <= 0) return false;
        const start = context.currentTime;
        for (const [i, hz] of pitches[kind].entries()) {
            const time = start + i * 0.085;
            const tone = context.createOscillator();
            const envelope = context.createGain();
            tone.type = waves[kind] ?? 'sine';
            tone.frequency.value = hz;
            envelope.gain.setValueAtTime(0, time);
            envelope.gain.linearRampToValueAtTime(Math.min(100, volume) / 100 * 0.14, time + 0.008);
            envelope.gain.linearRampToValueAtTime(0, time + 0.075);
            tone.connect(envelope).connect(context.destination);
            tone.onended = () => { tone.disconnect(); envelope.disconnect(); };
            tone.start(time);
            tone.stop(time + 0.076);
        }
        return true;
    }
    window.voiceCues = { play };
})();
