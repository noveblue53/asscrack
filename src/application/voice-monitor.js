(() => {
    const mic = document.getElementById('mic');
    const mute = document.getElementById('mute');
    const speakers = document.getElementById('speakers');
    const shareRow = document.getElementById('share-row');
    let muted = false;
    window.voiceMonitor.onState(view => {
        muted = view.muted;
        document.documentElement.dataset.theme = view.theme;
        mic.dataset.muted = String(view.inVoice && muted);
        // C2: Deafen mutes the microphone too. The text tells the user that the voice of the others does not play.
        const state = !view.inVoice ? 'Mic off' : view.deafened ? 'Deafened' : muted ? 'Mic muted'
            : view.transmitting ? 'Mic transmitting' : 'Mic ready';
        // G6: in voice, the line starts with the voice channel name ("Raid · Mic ready").
        mic.textContent = view.inVoice && typeof view.channel === 'string' && view.channel ? `${view.channel} · ${state}` : state;
        mute.textContent = muted ? 'Unmute' : 'Mute';
        mute.disabled = !view.inVoice;
        mute.setAttribute('aria-pressed', String(muted));
        speakers.textContent = view.speakers.join(', ') || 'No one speaking';
        // P8b: the line of the screen share, only while the share is on.
        if (shareRow) shareRow.hidden = view.sharing !== true;
    });
    mute.addEventListener('click', () => window.voiceMonitor.setMuted(!muted));
    document.getElementById('stop-share')?.addEventListener('click', () => window.voiceMonitor.stopShare?.());
    document.getElementById('back').addEventListener('click', () => window.voiceMonitor.close());
})();
