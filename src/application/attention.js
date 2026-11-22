// The network handlers call mention/incoming only after accepting a new, remote live
// message. Replays, local sends, topology and receipts have no attention path.
// API for the other scripts: cue(kind, cls) plays a cue by the rule of its class (CUE_RULES); wanted(target) is the
// attention rule of a live line; mention(data) and incoming(target) give the message cue and the notification.
(function () {
    const api = window.asscrack;
    const byId = id => document.getElementById(id);
    const dialog = byId('attention-settings');
    if (!dialog || !api?.getAttentionSettings) return;
    const status = byId('attention-status');
    const pending = new Map();
    let prefs = null;
    let audio = null;

    // The rule of each cue class (REVIEW.md, "Cue and attention rules"). setting: the key in attention.mjs that
    // switches the class on and off. idle and dnd: the class plays in Idle Peer or in Do not disturb. inView: the
    // class plays when viewing(target) is true. gap: the minimum time in ms between two cues of the class; a cue in
    // that time is dropped, not queued. The volume controls all the classes.
    // 'own' keeps the behavior of 0.8 (silent in DND): G4 (C4) changes only its dnd value.
    const CUE_RULES = Object.freeze({
        own: Object.freeze({ setting: 'voiceCues', idle: false, dnd: false, inView: true, gap: 0 }),
        // The caller (renderer.js) sends these cues only while I am in voice.
        'voice-other': Object.freeze({ setting: 'otherVoiceCues', idle: false, dnd: false, inView: true, gap: 500 }),
        message: Object.freeze({ setting: 'messageCues', idle: false, dnd: false, inView: false, gap: 2000 })
    });
    const lastCue = new Map(); // class -> Date.now() of the last accepted cue

    function idle() {
        return !!window.idlePeer?.isIdle();
    }

    function dnd() {
        return ownPresence.state === 'dnd';
    }

    function quiet() {
        return idle() || dnd();
    }

    function viewing(target) {
        if (!document.hasFocus() || document.visibilityState !== 'visible' || byId('chat-screen').hidden) return false;
        if (target.kind === 'whisper') return !!window.whispers?.isViewing(target.peerId);
        if (window.whispers?.isOpen()) return false;
        return window.roomChannels?.isViewing(target.channelId) ?? target.channelId === 'general';
    }

    // One rule for the attention of a live line (REVIEW.md): a line of a different person, not Idle Peer, not DND, and
    // the conversation is not in view. The message cue and the native notification use it; G5 (E1) adds the taskbar
    // flash. target: { kind: 'mention', channelId, id, from } or { kind: 'whisper', peerId, id }.
    function wanted(target) {
        if (!target?.id || quiet()) return false;
        const author = target.kind === 'whisper' ? target.peerId : target.from;
        if (!author || author === (selfId ?? topologySelf)) return false;
        return !viewing(target);
    }

    // The native notification. It keeps its own alerts setting.
    function notify(target) {
        if (!prefs?.alerts || !wanted(target)) return;
        const key = target.kind + '/' + (target.peerId ?? target.channelId);
        // Keep only a routing reference here, even when public previews are enabled.
        const { preview, from, ...route } = target;
        pending.delete(key);
        pending.set(key, route);
        if (pending.size > 64) pending.delete(pending.keys().next().value);
        api.addAttention(from === undefined ? target : { ...route, preview });
    }

    // whispers.js: a live whisper to me. The whisper cue, then the native notification.
    function incoming(target) {
        if (!target?.id) return;
        if (target.kind === 'whisper' && wanted(target)) cue('whisper', 'message', target);
        notify(target);
    }

    function viewChanged() {
        for (const [key, target] of pending) {
            if (viewing(target)) {
                api.readAttention(target);
                pending.delete(key);
            }
        }
    }

    // renderer.js: a new, remote live line. First the match, then the cue, then the alerts setting of the
    // notification: the mention cue plays also when alerts is off (the default).
    function mention(data) {
        if (!data?.peerId || data.peerId === (selfId ?? topologySelf) || !window.chatHighlights?.matches(data.text)) return;
        const target = { kind: 'mention', channelId: data.channelId || 'general', id: data.id, from: data.peerId };
        if (wanted(target)) cue('mention', 'message', target);
        if (!prefs?.alerts) return;
        const quote = prefs.previews && window.quoteCore.split(data.text);
        notify({ ...target, preview: prefs.previews ? (quote ? quote.rest : data.text).slice(0, 160) : '' });
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
        if (!row) return;
        window.whispers?.close();
        if (lists && !lists.open(target.channelId)) return;
        window.reading.revealLine(row);
    }

    // The rule of the class, at this time. target: the conversation of a message cue (for inView).
    function cueAllowed(rule, target) {
        if (!prefs?.[rule.setting] || !prefs.volume) return false;
        if (idle() && !rule.idle) return false;
        if (dnd() && !rule.dnd) return false;
        if (!rule.inView && target && viewing(target)) return false;
        return true;
    }

    // kind: a cue of voice-cues.js. cls: 'own', 'voice-other' or 'message' (CUE_RULES). options.preview: the preview
    // button (no rate limit). Returns true when the cue played.
    async function cue(kind, cls = 'own', target = null, options = {}) {
        const rule = CUE_RULES[cls];
        if (!rule || !cueAllowed(rule, target)) return false;
        if (rule.gap && !options.preview) {
            // The time stamp is set before the first await: a burst of calls gives one cue.
            const now = Date.now();
            if (now - (lastCue.get(cls) ?? -Infinity) < rule.gap) return false;
            lastCue.set(cls, now);
        }
        try {
            audio ??= new AudioContext();
            if (audio.state === 'suspended') await audio.resume();
            if (!cueAllowed(rule, target)) return false;
            return window.voiceCues.play(audio, kind, prefs.volume);
        } catch { return false; }
    }

    const fields = { voiceCues: 'cues', otherVoiceCues: 'other-cues', messageCues: 'message-cues', alerts: 'alerts',
        sound: 'sound', previews: 'content', volume: 'volume' };
    // The class of each cue in the preview list.
    const toneClass = { 'other-join': 'voice-other', 'other-leave': 'voice-other', mention: 'message', whisper: 'message' };
    const previewClass = () => toneClass[byId('attention-tone').value] ?? 'own';
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
        byId('attention-preview').disabled = !prefs[CUE_RULES[previewClass()].setting] || prefs.volume === 0;
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
    byId('attention-tone').addEventListener('change', render);
    byId('attention-preview').addEventListener('click', async () => {
        const played = await cue(byId('attention-tone').value, previewClass(), null, { preview: true });
        status.textContent = played ? 'Preview played.' : quiet() ? 'Sounds are quiet in your current availability.' : 'Audio output unavailable.';
    });
    byId('attention-windows').hidden = !navigator.userAgent.includes('Windows');
    api.onAttentionOpen(openTarget);
    document.addEventListener('visibilitychange', viewChanged);
    window.addEventListener('focus', viewChanged);
    window.roomAttention = {
        cue, wanted, mention, incoming, viewChanged,
        async openSettings() {
            await ready;
            if (!dialog.open) dialog.showModal();
        }
    };
})();
