// Peer details use the same room snapshot as the map. Only local decoder byte counters measure audio.
(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    const panel = byId('peer-details');
    if (!panel) return;
    const query = byId('peer-search');
    const choices = byId('peer-choices');
    const title = byId('peer-detail-name');
    const facts = byId('peer-detail-facts');
    const activity = byId('peer-detail-activity');
    const rate = byId('peer-audio-rate');
    let members = [];
    let transfers = [];
    let selected = null;
    let choicesSignature = '';
    let previous = null;
    let timer = null;
    let version = 0;
    const fold = name => name.trim().toLowerCase();
    function stopSampling() {
        version++;
        clearInterval(timer);
        timer = null;
        previous = null;
        rate.textContent = 'Received voice · unavailable';
    }
    async function sample() {
        const started = version;
        if (!selected || panel.hidden || document.hidden || !document.body.classList.contains('map-open')) return;
        const stats = await window.voice?.stats?.();
        if (started !== version) return;
        const bytes = stats?.[selected]?.bytesReceived;
        const now = performance.now();
        if (Number.isFinite(bytes) && previous && bytes >= previous.bytes && now > previous.time) {
            const seconds = (now - previous.time) / 1000;
            rate.textContent = 'Received voice · ' + ((bytes - previous.bytes) * 8 / seconds / 1000).toFixed(1)
                + ' kbit/s over ' + seconds.toFixed(1) + ' s';
        } else rate.textContent = 'Received voice · unavailable';
        previous = Number.isFinite(bytes) ? { bytes, time: now } : null;
    }
    function details() {
        const member = members.find(item => item.id === selected);
        activity.hidden = !selected;
        title.textContent = member ? member.name + (member.self ? ' (you)' : '') : selected ? 'Peer left' : 'Find a buddy';
        if (!member) {
            facts.textContent = '';
            stopSampling();
            return;
        }
        const lines = [];
        if (member.idle) lines.push('Idle peer');
        if (member.host) lines.push('Host');
        if (member.fullNode) lines.push('Full node');
        if (!member.self) lines.push('Chat link · ' + (member.linkToYou || 'Unknown'));
        lines.push(member.speaking ? 'Speaking' : member.muted ? 'In voice · muted' : member.inVoice ? 'In voice' : 'Out of voice');
        const outgoing = transfers.filter(item => item.to === selected).length;
        const incoming = transfers.filter(item => item.from === selected).length;
        if (!member.self && outgoing + incoming) lines.push('Your transfers · ' + outgoing + ' sending, ' + incoming + ' receiving');
        facts.textContent = lines.join('\n');
        if (!member.self && member.inVoice && timer === null) {
            void sample();
            timer = setInterval(sample, 1000);
        } else if (member.self || !member.inVoice) stopSampling();
    }
    function renderChoices() {
        const needle = fold(query.value);
        const matches = members.filter(member => fold(member.name).includes(needle) || member.id === query.value);
        const signature = JSON.stringify(matches.map(member => [member.id, member.name]));
        if (signature === choicesSignature) return;
        choicesSignature = signature;
        choices.replaceChildren(...matches.map(member => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = member.name + ' · ' + member.id.slice(-8);
            button.title = member.id;
            button.addEventListener('click', () => open(member.id));
            return button;
        }));
        if (!matches.length) choices.textContent = 'No matching buddy';
    }
    function show() {
        if (!document.body.classList.contains('map-open')) byId('map-toggle').click();
        panel.hidden = false;
        byId('map-panel').classList.add('inspecting');
    }
    function open(id) {
        if (!members.some(member => member.id === id)) return false;
        show();
        selected = id;
        choices.hidden = true;
        query.value = '';
        stopSampling();
        details();
        window.nodeMap?.highlight(id);
        title.focus();
        return true;
    }
    function search(value) {
        const exact = members.filter(member => value && (fold(member.name) === fold(value) || member.id === value));
        if (exact.length === 1) return open(exact[0].id);
        show();
        selected = null;
        query.value = value;
        choices.hidden = false;
        renderChoices();
        details();
        query.focus();
        return true;
    }
    function close() {
        panel.hidden = true;
        byId('map-panel').classList.remove('inspecting');
        stopSampling();
        selected = null;
    }
    activity.addEventListener('click', () => {
        if (!selected) return;
        const member = members.find(item => item.id === selected);
        window.roomActivity.openPeer(selected, member?.name || 'disconnected buddy', activity);
    });
    byId('peer-detail-close').addEventListener('click', () => { close(); byId('map-close').focus(); });
    query.addEventListener('input', () => { choices.hidden = false; renderChoices(); });
    byId('map-close').addEventListener('click', close);
    document.addEventListener('visibilitychange', () => {
        stopSampling();
        if (!document.hidden && !panel.hidden) details();
    });
    window.peerInspector = {
        open, close,
        update(state) {
            members = state.nodes;
            transfers = state.transfers;
            if (panel.hidden) return;
            if (!choices.hidden) renderChoices();
            details();
        },
        command(line) {
            if (/^\/transfers\s*$/i.test(line)) {
                window.layout?.showTransfers?.();
                byId('transfer-panel').focus();
                return true;
            }
            const match = /^\/whois(?:\s+(.+?))?\s*$/i.exec(line);
            return match ? search((match[1] || '').trim()) : false;
        }
    };
})();
