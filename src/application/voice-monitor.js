(() => {
    const mic = document.getElementById('mic');
    const mute = document.getElementById('mute');
    const speakers = document.getElementById('speakers');
    let muted = false;
    window.voiceMonitor.onState(view => {
        muted = view.muted;
        document.documentElement.dataset.theme = view.theme;
        mic.dataset.muted = String(view.inVoice && muted);
        mic.textContent = !view.inVoice ? 'Mic off' : muted ? 'Mic muted' : view.transmitting ? 'Mic transmitting' : 'Mic ready';
        mute.textContent = muted ? 'Unmute' : 'Mute';
        mute.disabled = !view.inVoice;
        mute.setAttribute('aria-pressed', String(muted));
        speakers.textContent = view.speakers.join(', ') || 'No one speaking';
    });
    mute.addEventListener('click', () => window.voiceMonitor.setMuted(!muted));
    document.getElementById('back').addEventListener('click', () => window.voiceMonitor.close());
})();
