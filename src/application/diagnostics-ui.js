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
        const name = info.name || 'Someone';
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
        offline: who => `${who} is offline.`, 'not-member': who => `${who} can't be asked in this room.`,
        'old-version': who => `${who} needs to update first.`, pending: who => `Already asked ${who}.`
    };
    async function ask(peerId) {
        if (typeof peerId !== 'string' || !peerId) return false;
        try {
            const result = await api.diagAsk(peerId);
            if (result?.ok) status(`Asked ${label(peerId)} for diagnostics.`);
            else status((ASK_REASONS[result?.reason] ?? (who => `Can't ask ${who} now.`))(label(peerId)));
            return result?.ok === true;
        } catch (err) {
            status(`Request failed: ${errorText(err)}`);
            return false;
        }
    }

    async function askAll() {
        try {
            const result = await api.diagAskAll();
            const skipped = result?.skipped ? ` ${result.skipped} skipped.` : '';
            const own = result?.saved ? ' Your own copy is saved.' : '';
            status(`Asked ${result?.asked ?? 0} people.${skipped}${own}`, { folder: result?.saved === true });
        } catch (err) {
            status(`Request failed: ${errorText(err)}`);
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
        byId('diag-prompt-title').textContent = `${label(current.peerId)} asks for diagnostics`;
        const friend = window.friendsUi?.relation?.(current.peerId) === 'open' ? 'Friend. ' : '';
        byId('diag-prompt-who').textContent = `${friend}Only send to someone you trust.`;
        byId('diag-prompt-dumps').checked = false;
        byId('diag-prompt-status').textContent = '';
        byId('diag-preview').textContent = 'Loading…';
        byId('diag-prompt-send').disabled = false;
        refreshPreview();
        dialog.showModal();
    }
    async function refreshPreview() {
        try {
            const preview = await api.diagPreview(byId('diag-prompt-dumps').checked);
            byId('diag-preview').textContent = preview?.summary || 'Nothing logged yet.';
            byId('diag-files').textContent = (preview?.files ?? []).join(', ');
        } catch {
            byId('diag-preview').textContent = 'Preview unavailable.';
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
                byId('diag-prompt-status').textContent = result?.reason === 'expired' ? 'Request expired.' : 'Send failed. Try again.';
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
        if (send) status(`Sending diagnostics to ${label(request.peerId)}…`);
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
        const who = typeof event.peerId === 'string' ? label(event.peerId) : 'Someone';
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
                } else status(`${who} didn't answer.`);
                break;
            case 'declined': if (event.by === 'peer') status(`${who} declined.`); break;
            case 'refused': if (event.by === 'peer') status(`Can't ask ${who} right now. Try later.`); break;
            case 'granted': status(`Receiving diagnostics from ${who}…`, { sticky: true }); break;
            case 'saved': status(`Diagnostics from ${who} saved.`, { folder: true, sticky: true }); break;
            case 'failed': if (event.side !== 'asked') status(`Transfer from ${who} failed (${event.reason ?? 'error'}).`); break;
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
            status('Problem marked.');
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
            out.textContent = result?.ok ? 'Diagnostics saved.' : result?.canceled ? '' : "Couldn't save diagnostics.";
        } catch {
            out.textContent = "Couldn't save diagnostics.";
        }
    });

    window.diagnosticsUi = Object.freeze({ canAsk: peerId => typeof peerId === 'string' && peerId.length > 0, ask, askAll, openMark });
})();
