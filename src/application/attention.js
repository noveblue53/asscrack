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
    // C3: the output device of the voice settings that the cue context uses now (null: not set yet, or it failed).
    let cueSink = null;

    // The rule of each cue class (REVIEW.md, "Cue and attention rules"). setting: the key in attention.mjs that
    // switches the class on and off (a function of the cue kind and the target for the message class: the Sound column
    // of the settings grid). idle and dnd: the class plays in Idle Peer or in Do not disturb. inView: the
    // class plays when viewing(target) is true. gap: the minimum time in ms between two cues of the class; a cue in
    // that time is dropped, not queued. The volume controls all the classes.
    // 'own' (C4): a cue of my own action (join, leave, mute, unmute, deafen) is a confirmation, thus it plays in DND.
    const CUE_RULES = Object.freeze({
        own: Object.freeze({ setting: 'voiceCues', idle: false, dnd: true, inView: true, gap: 0 }),
        // The caller (renderer.js) sends these cues only while I am in voice.
        'voice-other': Object.freeze({ setting: 'voiceSound', idle: false, dnd: false, inView: true, gap: 500 }),
        message: Object.freeze({ setting: soundKey, idle: false, dnd: false, inView: false, gap: 2000 }),
        // Every other room line (message alerts, 2026-11-22). after: a cue of that class in the gap also drops this
        // cue, so a busy chat gives at most one message cue each 2 s. A chat cue does not drop a mention cue.
        chat: Object.freeze({ setting: 'chatSound', idle: false, dnd: false, inView: false, gap: 2000, after: 'message' })
    });
    // The rows of the settings grid (attention.mjs SOUND_KEYS and ALERT_KEYS).
    const SOUND = { chat: 'chatSound', mention: 'mentionSound', whisper: 'whisperSound', friend: 'friendSound', voice: 'voiceSound' };
    const ALERT = { chat: 'chatAlert', mention: 'mentionAlert', whisper: 'whisperAlert', friend: 'friendAlert', voice: 'voiceAlert' };
    // The row of a message cue: a friend line uses the whisper tone, a plain room line the chat row.
    function rowOf(kind, target) {
        if (target?.kind === 'friend') return 'friend';
        if (target?.kind === 'whisper' || kind === 'whisper') return 'whisper';
        return kind === 'chat' ? 'chat' : 'mention';
    }
    function soundKey(kind, target) {
        return SOUND[rowOf(kind, target)];
    }
    function settingOf(rule, kind, target) {
        return typeof rule.setting === 'function' ? rule.setting(kind, target) : rule.setting;
    }
    const lastCue = new Map(); // class -> Date.now() of the last accepted cue
    // The tones of a plain room line (the setting chatTone). soft: one soft, short tone, so it is not the mention (up)
    // or the whisper (2 equal tones). chime: 2 tones down. pop: one short high tone.
    const CHAT_TONES = Object.freeze({
        soft: Object.freeze({ pitches: [784], wave: 'sine', length: 0.09 }),
        chime: Object.freeze({ pitches: [988, 659], wave: 'sine', length: 0.11 }),
        pop: Object.freeze({ pitches: [1397], wave: 'triangle', length: 0.05 })
    });

    function playChat(context, volume) {
        const CHAT_TONE = CHAT_TONES[prefs?.chatTone] ?? CHAT_TONES.soft;
        const time = context.currentTime;
        for (const [i, hz] of CHAT_TONE.pitches.entries()) {
            const start = time + i * 0.085;
            const tone = context.createOscillator();
            const envelope = context.createGain();
            tone.type = CHAT_TONE.wave;
            tone.frequency.value = hz;
            envelope.gain.setValueAtTime(0, start);
            envelope.gain.linearRampToValueAtTime(Math.min(100, volume) / 100 * 0.1, start + 0.008);
            envelope.gain.linearRampToValueAtTime(0, start + CHAT_TONE.length);
            tone.connect(envelope).connect(context.destination);
            tone.onended = () => { tone.disconnect(); envelope.disconnect(); };
            tone.start(start);
            tone.stop(start + CHAT_TONE.length + 0.001);
        }
        return true;
    }

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
        // G7b: a friend line is in view only when the chat window of that friend has the focus (main.js tells it).
        if (target.kind === 'friend') return target.focused === true;
        if (!document.hasFocus() || document.visibilityState !== 'visible' || byId('chat-screen').hidden) return false;
        // Voice join and leave: the room window is in view.
        if (target.kind === 'voice') return true;
        if (target.kind === 'whisper') return !!window.whispers?.isViewing(target.peerId);
        if (window.whispers?.isOpen()) return false;
        return window.roomChannels?.isViewing(target.channelId) ?? target.channelId === 'general';
    }

    // One rule for the attention of a live line (REVIEW.md): a line of a different person, not Idle Peer, not DND, and
    // the conversation is not in view. The setting background off ("Only when in the background") also allows a line
    // in view. The message cue, the native notification and the taskbar flash (E1) use it. target: { kind: 'mention', channelId, id, from } or { kind: 'whisper', peerId, id }.
    // G7b: { kind: 'friend', friendId, id, away, focused } (a friend line, always of a different person).
    function wanted(target) {
        if (!target?.id || quiet()) return false;
        const author = target.kind === 'whisper' ? target.peerId : target.kind === 'friend' ? target.friendId : target.from;
        if (!author || author === (selfId ?? topologySelf)) return false;
        return hidden(target);
    }

    // The view part of the rule for a cue or a notification: background off allows a conversation in view.
    function hidden(target) {
        return prefs?.background === false || !viewing(target);
    }

    // The Notification column of the settings grid for a target (attention.mjs alertOn).
    function alertOn(target) {
        if (!prefs) return false;
        if (target.kind === 'mention') return prefs.mentionAlert === true;
        if (target.kind === 'message') return prefs.chatAlert === true;
        return prefs[ALERT[target.kind]] === true;
    }

    // The native notification. It keeps its own column of the settings grid.
    function notify(target) {
        if (!alertOn(target) || !wanted(target)) return;
        // The key of attention.mjs: a mention and a plain line of one channel are one conversation.
        const key = target.kind === 'voice' ? 'voice'
            : (target.kind === 'message' ? 'mention' : target.kind) + '/' + (target.friendId ?? target.peerId ?? target.channelId);
        // Keep only a routing reference here, even when public previews are enabled. A room line also sends the
        // name that its row shows (the title of the notification).
        const { preview, from, focused, name, ...route } = target;
        pending.delete(key);
        pending.set(key, route);
        if (pending.size > 64) pending.delete(pending.keys().next().value);
        api.addAttention(from === undefined || route.kind === 'voice' ? route : { ...route, preview, name });
    }

    // The row "All messages" notifies only in a small room: at most 10 people (me included) when the line comes.
    const SMALL_ROOM = 10;
    function roomSize() {
        return (typeof peerItems === 'undefined' ? 0 : peerItems.size) + 1;
    }

    // Gap E1: the taskbar flash and the overlay dot. main.js flashes only a window with no focus that is not hidden
    // as Idle Peer. The flash keeps its own setting (default on), not the alerts setting.
    function flash() {
        if (prefs?.flash) api.flashAttention?.();
    }

    // whispers.js: a live whisper to me. The whisper cue and the flash, then the native notification.
    function incoming(target) {
        if (!target?.id) return;
        if (target.kind === 'whisper' && wanted(target)) {
            cue('whisper', 'message', target);
            flash();
        }
        // G7b: a friend line (live, or one batch of away lines) gets the message cue of P11 and the notification, as a
        // whisper. No taskbar flash: the line is in its own chat window, not in this window.
        if (target.kind === 'friend' && wanted(target)) cue('whisper', 'message', target);
        notify(target);
    }

    function viewChanged() {
        for (const [key, target] of pending) {
            if (target.kind !== 'friend' && viewing(target)) {
                api.readAttention(target);
                pending.delete(key);
            }
        }
    }

    // renderer.js: a new, remote live line (not history: a replay or the lines after a reconnect have no attention
    // path). First the match, then the cue, then the Notification column: the cue plays also when the notification
    // is off. A line with no match is a chat line: the row "All messages". A mention with its Sound box off uses that
    // row too.
    function mention(data) {
        if (!data?.peerId || data.peerId === (selfId ?? topologySelf)) return;
        const matched = !!window.chatHighlights?.matches(data.text);
        if (silenced(data.channelId || 'general', matched)) return;
        const target = { kind: matched ? 'mention' : 'chat', channelId: data.channelId || 'general', id: data.id, from: data.peerId };
        if (wanted(target)) {
            if (matched) flash();
            if (matched && prefs?.mentionSound) cue('mention', 'message', target);
            else cue('chat', 'chat', target);
        }
        // The notification: a mention by its row; a plain line (or a mention with its row off) by the row of all
        // messages in a small room.
        let kind = null;
        if (matched && prefs?.mentionAlert) kind = 'mention';
        else if (prefs?.chatAlert && roomSize() <= SMALL_ROOM) kind = 'message';
        if (!kind) return;
        const quote = prefs.previews && window.quoteCore.split(data.text);
        notify({ ...target, kind, name: typeof data.from === 'string' ? data.from : '',
            preview: prefs.previews ? (quote ? quote.rest : data.text).slice(0, 160) : '' });
    }

    // renderer.js: a different person joins or leaves voice (a real change, not the state at the start of a
    // session). Only the notification: the cue of voice keeps its own rule (it plays only while I am in voice).
    function voice(kind, peerId) {
        if (typeof peerId !== 'string' || !peerId || (kind !== 'other-join' && kind !== 'other-leave')) return;
        if (silenced(null, false)) return;
        notify({ kind: 'voice', peerId, id: peerId + '/' + Date.now(), joined: kind === 'other-join', from: peerId });
    }

    function openTarget(target) {
        if (quiet() || byId('chat-screen').hidden || target?.kind === 'voice') return;
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

    // C3: the cues play on the output device of the voice settings. Not the voice context: Leave closes it before the
    // leave cue plays. A device that does not open gives the default device, and the next cue tries again.
    function outputDevice() {
        const wanted = window.voice?.settings?.()?.outputDeviceId ?? '';
        return typeof audio.setSinkId === 'function' && wanted !== cueSink ? wanted : null;
    }

    async function useOutputDevice(wanted) {
        try {
            await audio.setSinkId(wanted);
            cueSink = wanted;
        } catch {
            cueSink = null;
            if (audio.sinkId !== '') await audio.setSinkId('').catch(() => {});
        }
    }

    // C4: the current availability stops this class (the text of the preview status).
    function quietFor(rule) {
        return (idle() && !rule.idle) || (dnd() && !rule.dnd);
    }

    // The rule of the class, at this time. target: the conversation of a message cue (for inView).
    function cueAllowed(rule, kind, target) {
        if (!prefs?.[settingOf(rule, kind, target)] || !prefs.volume) return false;
        if (idle() && !rule.idle) return false;
        if (dnd() && !rule.dnd) return false;
        if (!rule.inView && target && !hidden(target)) return false;
        return true;
    }

    // kind: a cue of voice-cues.js. cls: 'own', 'voice-other' or 'message' (CUE_RULES). options.preview: the preview
    // button (no rate limit). Returns true when the cue played.
    async function cue(kind, cls = 'own', target = null, options = {}) {
        const rule = CUE_RULES[cls];
        if (!rule || !cueAllowed(rule, kind, target)) return false;
        if (rule.gap && !options.preview) {
            // The time stamp is set before the first await: a burst of calls gives one cue.
            const now = Date.now();
            if (now - (lastCue.get(cls) ?? -Infinity) < rule.gap) return false;
            if (rule.after && now - (lastCue.get(rule.after) ?? -Infinity) < rule.gap) return false;
            lastCue.set(cls, now);
        }
        try {
            audio ??= new AudioContext();
            // No await when the device is the same: the cue plays at once.
            const wanted = outputDevice();
            if (wanted !== null) await useOutputDevice(wanted);
            if (audio.state === 'suspended') await audio.resume();
            if (!cueAllowed(rule, kind, target)) return false;
            return kind === 'chat' ? playChat(audio, prefs.volume) : window.voiceCues.play(audio, kind, prefs.volume);
        } catch { return false; }
    }

    const fields = { voiceCues: 'cues', sound: 'sound', previews: 'content', volume: 'volume', flash: 'flash',
        background: 'background', chatTone: 'chat-tone' };
    for (const [row, key] of Object.entries(SOUND)) fields[key] = row + '-sound';
    for (const [row, key] of Object.entries(ALERT)) fields[key] = row + '-alert';
    // The class of each cue in the preview list.
    const toneClass = { 'other-join': 'voice-other', 'other-leave': 'voice-other', mention: 'message', whisper: 'message',
        chat: 'chat' };
    const previewClass = () => toneClass[byId('attention-tone').value] ?? 'own';
    function render() {
        if (!prefs) return;
        for (const [key, suffix] of Object.entries(fields)) {
            const input = byId('attention-' + suffix);
            // A page with no box for a setting (for example a test page with an older dialog) skips it.
            if (!input) continue;
            if (key === 'volume') input.value = prefs.volume;
            else if (key === 'chatTone') input.value = prefs.chatTone ?? 'soft';
            else input.checked = prefs[key];
        }
        byId('attention-percent').textContent = prefs.volume + '%';
        const anyAlert = Object.values(ALERT).some(key => prefs[key]);
        byId('attention-content').disabled = !anyAlert;
        byId('attention-sound').disabled = !anyAlert;
        const tone = byId('attention-tone').value;
        byId('attention-preview').disabled = !prefs[settingOf(CUE_RULES[previewClass()], tone, null)] || prefs.volume === 0;
    }

    const ready = api.getAttentionSettings().then(value => { prefs = value; render(); })
        .catch(() => { status.textContent = 'Couldn\'t load settings.'; });
    for (const [key, suffix] of Object.entries(fields)) {
        const input = byId('attention-' + suffix);
        if (!input) continue;
        input.addEventListener('change', async () => {
            const value = key === 'volume' ? Number(input.value) : key === 'chatTone' ? input.value : input.checked;
            try {
                prefs = await api.setAttentionSettings({ [key]: value });
                status.textContent = '';
            } catch (err) {
                status.textContent = String(err?.message ?? 'Couldn\'t save this setting.').replace(/^Error invoking remote method '[^']+': Error: /, '');
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
        const rule = CUE_RULES[previewClass()];
        // UI copy pass: no text when the preview plays (you hear it); a reason when it does not.
        const quietText = dnd() && !rule.dnd ? 'Sounds are off while Do not disturb is on.' : 'Sounds are off in Idle Peer.';
        status.textContent = played ? '' : quietFor(rule) ? quietText : 'Audio output unavailable.';
    });
    // The Start menu shortcut of the notifications (Windows only): a tooltip, not a paragraph.
    const alertsLabel = byId('attention-alerts-label');
    if (alertsLabel && navigator.userAgent.includes('Windows')) alertsLabel.title = 'Adds a Start menu shortcut';
    // ---- Mute per channel and per room (message alerts) ----
    // mutes: the mutes of the open room from main.js ({ room, channels }: { until, mentions }; until null: until I
    // unmute). The end of a mute is checked at each line, so a mute ends on time with no timer.
    let mutes = { room: null, channels: {} };
    let muteTimer = null;
    const muteDialog = byId('mute-dialog');
    let muteScope = null; // { scope: 'room' } or { scope: 'channel', channelId }

    function activeMute(entry) {
        return !!entry && (entry.until === null || entry.until > Date.now());
    }

    // The mute of a channel, else of the room. channelId null: the room only (voice).
    function muteOf(channelId) {
        const channel = channelId === null ? null : mutes.channels?.[channelId];
        if (activeMute(channel)) return channel;
        return activeMute(mutes.room) ? mutes.room : null;
    }

    // A muted conversation plays no cue and shows no notification; a mention passes when the mute allows it.
    function silenced(channelId, isMention) {
        const mute = muteOf(channelId);
        return !!mute && !(isMention && mute.mentions);
    }

    function channelName(channelId) {
        const option = [...(byId('channel-select')?.options ?? [])].find(o => o.value === channelId);
        return option ? option.textContent.replace(/ \(.*$/, '').replace(/ · muted$/, '') : '#' + channelId;
    }

    // The marks: " · muted" in the channel list (channels-ui.js asks isMuted), a class on the room name.
    function showMutes() {
        byId('chat-room')?.classList.toggle('muted', activeMute(mutes.room));
        window.roomChannels?.refresh?.();
        clearTimeout(muteTimer);
        const ends = [mutes.room, ...Object.values(mutes.channels ?? {})].filter(m => m && m.until !== null && m.until > Date.now())
            .map(m => m.until - Date.now());
        // The mark goes away at the end of the next mute (at most 24 days ahead for setTimeout).
        if (ends.length) muteTimer = setTimeout(showMutes, Math.min(Math.min(...ends) + 50, 2 ** 31 - 1));
    }

    async function refreshMutes() {
        try { mutes = (await api.getAttentionMutes?.()) ?? { room: null, channels: {} }; } catch { mutes = { room: null, channels: {} }; }
        showMutes();
    }

    function openMute(scope) {
        if (!muteDialog || byId('chat-screen').hidden) return;
        muteScope = scope;
        const entry = scope.scope === 'room' ? mutes.room : mutes.channels?.[scope.channelId];
        const on = activeMute(entry);
        byId('mute-title').textContent = scope.scope === 'room' ? 'Mute room' : 'Mute ' + channelName(scope.channelId);
        byId('mute-mentions').checked = on ? entry.mentions : true;
        byId('mute-off').hidden = !on;
        byId('mute-status').textContent = '';
        if (!muteDialog.open) muteDialog.showModal();
    }

    async function applyMute(time) {
        if (!muteScope) return;
        try {
            mutes = await api.setAttentionMute({ ...muteScope, time, mentions: byId('mute-mentions').checked });
            showMutes();
            muteDialog.close();
        } catch (err) {
            byId('mute-status').textContent = String(err?.message ?? 'Couldn\'t save the mute.').replace(/^Error invoking remote method '[^']+': Error: /, '');
        }
    }

    if (muteDialog) {
        byId('mute-on').addEventListener('click', () => applyMute(byId('mute-time').value));
        byId('mute-off').addEventListener('click', () => applyMute('off'));
        byId('mute-cancel').addEventListener('click', () => muteDialog.close());
        byId('mute-channel-open')?.addEventListener('click', () => {
            byId('room-options')?.hidePopover?.();
            openMute({ scope: 'channel', channelId: window.roomChannels?.active() ?? 'general' });
        });
        byId('mute-room-open')?.addEventListener('click', () => {
            byId('room-options')?.hidePopover?.();
            openMute({ scope: 'room' });
        });
        // Right-click on the channel list (the channel that it shows) or on the room name.
        byId('channel-select')?.addEventListener('contextmenu', event => {
            event.preventDefault();
            openMute({ scope: 'channel', channelId: window.roomChannels?.active() ?? 'general' });
        });
        byId('chat-room')?.addEventListener('contextmenu', event => {
            event.preventDefault();
            openMute({ scope: 'room' });
        });
    }

    api.onAttentionOpen(openTarget);
    // G7b: the friend lines come from the main process (friend-links.mjs), not from the room.
    window.friends?.onAttention?.(target => incoming(target && typeof target === 'object' ? { ...target, kind: 'friend' } : null));
    document.addEventListener('visibilitychange', viewChanged);
    window.addEventListener('focus', viewChanged);
    window.roomAttention = {
        cue, wanted, mention, incoming, voice, viewChanged, refreshMutes, openMute,
        // The mark of a channel: a mute of that channel (a room mute has its mark on the room name).
        isMuted: channelId => activeMute(mutes.channels?.[channelId]),
        async openSettings() {
            await ready;
            if (!dialog.open) dialog.showModal();
        }
    };
})();
