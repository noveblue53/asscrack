// Diagnostics in the room window (1.0.1, docs/DIAGNOSTICS.md):
// - "Ask for diagnostics…" on a buddy line (menu.js action 'ask-diagnostics') and "Ask everyone for diagnostics…"
//   in the Room options. The asked person sees a fixed local prompt: "<name> asks for your diagnostics" with Send and
//   Not now, and the "What is in it" preview (the summary.txt text of the bundle). Nothing goes out without Send.
//   The prompt waits while the window does not have the focus (a game or a screen share in front).
// - "Mark a problem…" in the Room options and in the voice controls: a category, no free text.
// - "Save diagnostics…" in the About dialog.
// API for renderer.js: window.diagnosticsUi = { canAsk(peerId), ask(peerId) }.
(function () {
    const api = window.asscrack;
    const byId = id => document.getElementById(id);
    if (!api?.diagAsk) return;
    const errorText = err => String(err?.message ?? err ?? '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

    const label = peerId => {
        const info = window.roomActions?.peerLabel?.(peerId) ?? {};
        const name = info.name || 'A room member';
        return info.mark ? `${name} (${info.mark})` : name;
    };

    // ---- The status bar of the asker ----
    let barTimer = null;
    function status(text, { folder = false, sticky = false } = {}) {
        const bar = byId('diag-bar');
        if (!bar) return;
        byId('diag-bar-text').textContent = text;
        byId('diag-bar-open').hidden = !folder;
        bar.hidden = false;
        clearTimeout(barTimer);
        if (!sticky) barTimer = setTimeout(() => { bar.hidden = true; }, 12000);
    }
    byId('diag-bar-open')?.addEventListener('click', () => { api.diagOpenReceived().catch(() => {}); });
    byId('diag-bar-close')?.addEventListener('click', () => { byId('diag-bar').hidden = true; });

    const ASK_REASONS = {
        offline: 'is not connected now', 'not-member': 'is not a member device of this protected room',
        'old-version': 'has an older ASSCRACK with no diagnostics', pending: 'has a request from you already'
    };
    async function ask(peerId) {
        if (typeof peerId !== 'string' || !peerId) return false;
        try {
            const result = await api.diagAsk(peerId);
            if (result?.ok) status(`Asked ${label(peerId)} for diagnostics. They select Send or Not now.`);
            else status(`${label(peerId)} ${ASK_REASONS[result?.reason] ?? 'cannot get the request now'}.`);
            return result?.ok === true;
        } catch (err) {
            status(`The request did not go out: ${errorText(err)}`);
            return false;
        }
    }

    async function askAll() {
        try {
            const result = await api.diagAskAll();
            const own = result?.saved ? ' Your own diagnostics are in the same folder.' : '';
            status(`Asked ${result?.asked ?? 0} people for diagnostics (${result?.skipped ?? 0} cannot get it).${own}`, { folder: result?.saved === true });
        } catch (err) {
            status(`The requests did not go out: ${errorText(err)}`);
        }
    }

    // ---- The prompt of the asked person ----
    const queue = [];
    let current = null;
    function showNext() {
        const dialog = byId('diag-prompt');
        if (!dialog || current || !queue.length) return;
        // A game or a screen share has the focus: the prompt waits for the window.
        if (!document.hasFocus()) return;
        current = queue.shift();
        byId('diag-prompt-title').textContent = `${label(current.peerId)} asks for your diagnostics`;
        const friend = window.friendsUi?.relation?.(current.peerId) === 'open' ? 'This person is your friend. ' : '';
        byId('diag-prompt-who').textContent = `${friend}Send only when you know this person and want help with a problem.`;
        byId('diag-prompt-dumps').checked = false;
        byId('diag-prompt-status').textContent = '';
        byId('diag-preview').textContent = 'Loading the summary…';
        byId('diag-prompt-send').disabled = false;
        refreshPreview();
        dialog.showModal();
    }
    async function refreshPreview() {
        try {
            const preview = await api.diagPreview(byId('diag-prompt-dumps').checked);
            byId('diag-preview').textContent = preview?.summary || '(The journal has no lines yet.)';
            byId('diag-files').textContent = (preview?.files ?? []).join(', ');
        } catch {
            byId('diag-preview').textContent = 'The summary could not be made.';
        }
    }
    byId('diag-prompt-dumps')?.addEventListener('change', refreshPreview);
    async function answer(send) {
        if (!current) return;
        const request = current;
        byId('diag-prompt-send').disabled = true;
        try {
            const result = await api.diagAnswer(request.id, send, send && byId('diag-prompt-dumps').checked);
            if (send && !result?.ok) {
                byId('diag-prompt-status').textContent = result?.reason === 'expired' ? 'The request expired.' : 'The diagnostics could not be sent.';
                byId('diag-prompt-send').disabled = false;
                if (result?.reason !== 'expired') return;
            }
        } catch (err) {
            byId('diag-prompt-status').textContent = errorText(err);
            byId('diag-prompt-send').disabled = false;
            return;
        }
        current = null;
        byId('diag-prompt').close();
        if (send) status(`Your diagnostics go to ${label(request.peerId)}.`);
        showNext();
    }
    byId('diag-prompt-send')?.addEventListener('click', () => answer(true));
    byId('diag-prompt-later')?.addEventListener('click', () => answer(false));
    // Escape is "Not now".
    byId('diag-prompt')?.addEventListener('cancel', event => { event.preventDefault(); answer(false); });
    window.addEventListener('focus', showNext);

    // ---- The events of the main process ----
    api.onDiag(event => {
        if (!event || typeof event !== 'object') return;
        const who = typeof event.peerId === 'string' ? label(event.peerId) : 'A room member';
        switch (event.event) {
            case 'prompt':
                queue.push({ id: event.id, peerId: event.peerId });
                showNext();
                if (!document.hasFocus()) api.flashAttention?.();
                break;
            case 'expired':
                if (event.side === 'asked') {
                    const i = queue.findIndex(q => q.id === event.id);
                    if (i >= 0) queue.splice(i, 1);
                    if (current?.id === event.id) { current = null; byId('diag-prompt').close(); showNext(); }
                } else status(`${who} did not answer the request for diagnostics.`);
                break;
            case 'declined': if (event.by === 'peer') status(`${who} did not send diagnostics now.`); break;
            case 'refused': if (event.by === 'peer') status(`${who} cannot get a new request now. Try again later.`); break;
            case 'granted': status(`${who} sends diagnostics…`, { sticky: true }); break;
            case 'saved': status(`Diagnostics from ${who} saved.`, { folder: true, sticky: true }); break;
            case 'failed': if (event.side !== 'asked') status(`The diagnostics from ${who} did not arrive (${event.reason ?? 'error'}).`); break;
            default: break;
        }
    });

    // ---- Mark a problem ----
    function openMark() {
        const dialog = byId('mark-dialog');
        if (!dialog || dialog.open) return;
        for (const input of dialog.querySelectorAll('input[name="mark-category"]')) input.checked = false;
        byId('mark-status').textContent = '';
        dialog.showModal();
    }
    byId('mark-save')?.addEventListener('click', async () => {
        const chosen = byId('mark-dialog').querySelector('input[name="mark-category"]:checked');
        if (!chosen) { byId('mark-status').textContent = 'Select what went wrong.'; return; }
        try {
            await api.diagMark(chosen.value);
            byId('mark-dialog').close();
            status('Problem marked with the time. It is in your diagnostics.');
        } catch (err) {
            byId('mark-status').textContent = errorText(err);
        }
    });
    byId('mark-problem')?.addEventListener('click', openMark);
    byId('mark-problem-voice')?.addEventListener('click', openMark);
    byId('ask-everyone')?.addEventListener('click', () => { byId('room-options')?.hidePopover?.(); askAll(); });
    // The voice button shows only in voice (the same state as Leave voice).
    const leaveVoice = byId('leave-voice');
    const voiceMark = byId('mark-problem-voice');
    if (leaveVoice && voiceMark) {
        const sync = () => { voiceMark.hidden = leaveVoice.hidden; };
        new MutationObserver(sync).observe(leaveVoice, { attributes: true, attributeFilter: ['hidden'] });
        sync();
    }

    // ---- Save diagnostics (About) ----
    byId('about-diag-save')?.addEventListener('click', async () => {
        const out = byId('about-status');
        try {
            const result = await api.diagSave(byId('about-diag-dumps').checked);
            out.textContent = result?.ok ? 'Diagnostics saved.' : result?.canceled ? '' : 'The diagnostics could not be saved.';
        } catch {
            out.textContent = 'The diagnostics could not be saved.';
        }
    });

    window.diagnosticsUi = Object.freeze({ canAsk: peerId => typeof peerId === 'string' && peerId.length > 0, ask, askAll, openMark });
})();
