// The network handlers call mention/incoming only after accepting a new, remote live
// message. Replays, local sends, topology and receipts have no attention path.
(function () {
    const api = window.asscrack;
    const byId = id => document.getElementById(id);
    const dialog = byId('attention-settings');
    if (!dialog || !api?.getAttentionSettings) return;
    const status = byId('attention-status');
    const pending = new Map();
    let prefs = null;
    let audio = null;

    function quiet() {
        return window.idlePeer?.isIdle() || ownPresence.state === 'dnd';
    }

    function viewing(target) {
        if (!document.hasFocus() || document.visibilityState !== 'visible' || byId('chat-screen').hidden) return false;
        if (target.kind === 'whisper') return !!window.whispers?.isViewing(target.peerId);
        if (window.whispers?.isOpen()) return false;
        return window.roomChannels?.isViewing(target.channelId) ?? target.channelId === 'general';
    }

    function incoming(target) {
        if (!prefs?.alerts || quiet() || !target?.id || viewing(target)) return;
        const key = target.kind + '/' + (target.peerId ?? target.channelId);
        // Keep only a routing reference here, even when public previews are enabled.
        const { preview, ...route } = target;
        pending.delete(key);
        pending.set(key, route);
        if (pending.size > 64) pending.delete(pending.keys().next().value);
        api.addAttention(target);
    }

    function viewChanged() {
        for (const [key, target] of pending) {
            if (viewing(target)) {
                api.readAttention(target);
                pending.delete(key);
            }
        }
    }

    function mention(data) {
        if (!prefs?.alerts || !data?.peerId || data.peerId === (selfId ?? topologySelf) ||
            !window.chatHighlights?.matches(data.text)) return;
        const quote = prefs.previews && window.quoteCore.split(data.text);
        incoming({ kind: 'mention', channelId: data.channelId || 'general', id: data.id,
            preview: prefs.previews ? (quote ? quote.rest : data.text).slice(0, 160) : '' });
    }

    function openTarget(target) {
        if (quiet() || byId('chat-screen').hidden) return;
        if (target.kind === 'whisper') {
            window.whispers?.open(target.peerId, target.id);
            return;
        }
        const lists = window.roomChannels;
        if (!lists && target.channelId !== 'general') return;
        const list = lists?.listFor(target.channelId) ?? byId('messages');
        const row = list.querySelector('li[data-id="' + CSS.escape(target.id) + '"]');
        if (!row || (lists && !lists.open(target.channelId))) return;
        window.whispers?.close();
        window.reading.revealLine(row);
    }

    async function cue(kind) {
        if (!prefs?.voiceCues || !prefs.volume || quiet()) return false;
        try {
            audio ??= new AudioContext();
            if (audio.state === 'suspended') await audio.resume();
            if (!prefs.voiceCues || !prefs.volume || quiet()) return false;
            return window.voiceCues.play(audio, kind, prefs.volume);
        } catch { return false; }
    }

    const fields = { voiceCues: 'cues', alerts: 'alerts', sound: 'sound', previews: 'content', volume: 'volume' };
    function render() {
        if (!prefs) return;
        for (const [key, suffix] of Object.entries(fields)) {
            const input = byId('attention-' + suffix);
            if (key === 'volume') input.value = prefs.volume;
            else input.checked = prefs[key];
        }
        byId('attention-percent').textContent = prefs.volume + '%';
        byId('attention-content').disabled = !prefs.alerts;
        byId('attention-sound').disabled = !prefs.alerts;
        byId('attention-preview').disabled = !prefs.voiceCues || prefs.volume === 0;
    }

    const ready = api.getAttentionSettings().then(value => { prefs = value; render(); })
        .catch(() => { status.textContent = 'Sound and notification settings could not be loaded.'; });
    for (const [key, suffix] of Object.entries(fields)) {
        const input = byId('attention-' + suffix);
        input.addEventListener('change', async () => {
            const value = key === 'volume' ? Number(input.value) : input.checked;
            try {
                prefs = await api.setAttentionSettings({ [key]: value });
                status.textContent = '';
            } catch (err) {
                status.textContent = String(err?.message ?? 'The setting could not be saved.').replace(/^Error invoking remote method '[^']+': Error: /, '');
            }
            render();
        });
    }
    byId('attention-volume').addEventListener('input', event => {
        byId('attention-percent').textContent = event.target.value + '%';
    });
    byId('attention-preview').addEventListener('click', async () => {
        const played = await cue(byId('attention-tone').value);
        status.textContent = played ? 'Preview played.' : quiet() ? 'Sounds are quiet in your current availability.' : 'Audio output unavailable.';
    });
    byId('attention-windows').hidden = !navigator.userAgent.includes('Windows');
    api.onAttentionOpen(openTarget);
    document.addEventListener('visibilitychange', viewChanged);
    window.addEventListener('focus', viewChanged);
    window.roomAttention = {
        cue, mention, incoming, viewChanged,
        async openSettings() {
            await ready;
            if (!dialog.open) dialog.showModal();
        }
    };
})();
