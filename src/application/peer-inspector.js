// Peer details use the same room snapshot as the map. Only local decoder byte counters measure audio.
(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    const panel = byId('peer-details');
    if (!panel) return;
    const map = byId('map-panel');
    const mapTab = byId('peer-detail-map');
    const detailsTab = byId('peer-detail-show');
    const query = byId('peer-search');
    const searchField = byId('peer-search-field');
    const choices = byId('peer-choices');
    const title = byId('peer-detail-name');
    const facts = byId('peer-detail-facts');
    const readings = byId('peer-readings');
    const link = byId('peer-detail-link');
    const voice = byId('peer-detail-voice');
    const activity = byId('peer-detail-activity');
    const summary = byId('peer-activity-summary');
    const recent = byId('peer-recent-events');
    const eventsStatus = byId('peer-events-status');
    const rate = byId('peer-audio-rate');
    let members = [];
    let transfers = [];
    let selected = null;
    let choicesSignature = '';
    let previous = null;
    let timer = null;
    let version = 0;
    let eventsTimer;
    let eventsVersion = 0;
    let eventsSignature = null;
    const fold = name => name.trim().toLowerCase();

    function stopSampling() {
        version++;
        clearInterval(timer);
        timer = null;
        previous = null;
        rate.textContent = 'Unavailable';
    }
    async function sample() {
        const started = version;
        if (!selected || panel.hidden || document.hidden || !document.body.classList.contains('map-open')) return;
        let stats;
        try { stats = await window.voice?.stats?.(); } catch {}
        if (started !== version) return;
        const bytes = stats?.[selected]?.bytesReceived;
        const now = performance.now();
        if (Number.isFinite(bytes) && previous && bytes >= previous.bytes && now > previous.time) {
            const seconds = (now - previous.time) / 1000;
            rate.textContent = ((bytes - previous.bytes) * 8 / seconds / 1000).toFixed(1)
                + ' kbit/s over ' + seconds.toFixed(1) + ' s';
        } else rate.textContent = 'Unavailable';
        previous = Number.isFinite(bytes) ? { bytes, time: now } : null;
    }

    function showEvents(lines, emptyText) {
        const signature = JSON.stringify([lines, emptyText]);
        if (signature === eventsSignature) return;
        eventsSignature = signature;
        recent.replaceChildren(...lines.map(line => {
            const item = document.createElement('li');
            const divider = line.indexOf('  ');
            if (divider === -1) item.textContent = line;
            else {
                const stamp = line.slice(0, divider);
                const time = document.createElement('time');
                time.dateTime = stamp;
                time.title = stamp;
                time.textContent = stamp.slice(11, 19) + ' UTC';
                item.append(time, line.slice(divider + 1));
            }
            return item;
        }));
        eventsStatus.textContent = emptyText;
        eventsStatus.hidden = lines.length !== 0;
    }

    function stopEvents() {
        eventsVersion++;
        clearTimeout(eventsTimer);
    }

    async function refreshEvents(started) {
        if (!selected || panel.hidden || document.hidden || !document.body.classList.contains('map-open')) return;
        try {
            const lines = await window.asscrack.getRoomActivity(selected, false);
            if (started !== eventsVersion) return;
            showEvents(lines.slice(-2).reverse(), 'No recent events');
        } catch {
            if (started !== eventsVersion) return;
            showEvents([], 'Activity unavailable');
        }
        eventsTimer = setTimeout(() => refreshEvents(started), 2000);
    }

    function markRoster() {
        for (const row of byId('peers').children) {
            const active = row.dataset.peerId && row.dataset.peerId === selected;
            const avatar = row.querySelector('.avatar');
            if (active) {
                row.dataset.selected = 'true';
                avatar?.setAttribute('aria-current', 'true');
            } else {
                delete row.dataset.selected;
                avatar?.removeAttribute('aria-current');
            }
        }
    }

    function select(id) {
        selected = id;
        window.nodeMap?.select(id);
        markRoster();
        stopSampling();
        stopEvents();
        showEvents([], 'No recent events');
        if (id) void refreshEvents(eventsVersion);
    }

    function details() {
        const member = members.find(item => item.id === selected);
        summary.hidden = !selected;
        readings.hidden = !member;
        searchField.hidden = Boolean(selected);
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
        link.textContent = member.self ? 'This device' : member.linkToYou || 'Unknown (route unavailable)';
        voice.textContent = member.speaking ? 'Speaking' : member.muted ? 'In voice · muted' : member.inVoice ? 'In voice' : 'Out of voice';
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
        map.classList.add('inspecting');
        mapTab.hidden = false;
        detailsTab.hidden = false;
        showMapTab(false);
    }
    function showMapTab(on) {
        map.classList.toggle('show-map', on);
        mapTab.setAttribute('aria-pressed', String(on));
        detailsTab.setAttribute('aria-pressed', String(!on));
    }
    function open(id) {
        if (!members.some(member => member.id === id)) return false;
        show();
        if (selected !== id) select(id);
        choices.hidden = true;
        query.value = '';
        details();
        title.focus({ preventScroll: true });
        return true;
    }
    function search(value) {
        const exact = members.filter(member => value && (fold(member.name) === fold(value) || member.id === value));
        if (exact.length === 1) return open(exact[0].id);
        show();
        select(null);
        query.value = value;
        choices.hidden = false;
        renderChoices();
        details();
        query.focus({ preventScroll: true });
        return true;
    }
    function close() {
        panel.hidden = true;
        map.classList.remove('inspecting', 'show-map');
        mapTab.hidden = true;
        detailsTab.hidden = true;
        select(null);
    }
    activity.addEventListener('click', () => {
        if (!selected) return;
        const member = members.find(item => item.id === selected);
        window.roomActivity.openPeer(selected, member?.name || 'disconnected buddy', activity);
    });
    byId('peer-detail-close').addEventListener('click', () => { close(); byId('map-close').focus({ preventScroll: true }); });
    mapTab.addEventListener('click', () => showMapTab(true));
    detailsTab.addEventListener('click', () => showMapTab(false));
    query.addEventListener('input', () => { choices.hidden = false; renderChoices(); });
    document.addEventListener('visibilitychange', () => {
        stopSampling();
        stopEvents();
        if (!document.hidden && !panel.hidden) {
            details();
            void refreshEvents(eventsVersion);
        }
    });
    window.peerInspector = {
        open, close,
        update(state) {
            members = state.nodes;
            transfers = state.transfers;
            if (panel.hidden) return;
            markRoster();
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
