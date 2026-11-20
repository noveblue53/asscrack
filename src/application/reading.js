// Reading position and unread count of the chat list (#messages).
// window.readingCore: pure functions with no DOM. The tests load this file with node:vm and call them.
// window.reading: the DOM part. renderer.js calls it around each change of the list.
// All names stay inside this function: renderer.js is a classic script in the same global scope.
(function () {
    'use strict';

    // The list is at its end when less than this distance (px) is below the viewport.
    const END_PX = 24;

    // True when the viewport shows the end of the list.
    function isAtEnd(scrollHeight, scrollTop, clientHeight, threshold = END_PX) {
        return scrollHeight - scrollTop - clientHeight < threshold;
    }

    // The index of the first line whose bottom is below the top of the viewport.
    // count: the number of lines. topAt(i), heightAt(i): layout values of line i in list coordinates.
    // The lines are in layout sequence, so a binary search is correct. Returns -1 when there is no line.
    function firstVisibleIndex(count, topAt, heightAt, scrollTop) {
        if (count <= 0) return -1;
        let lo = 0;
        let hi = count - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (topAt(mid) + heightAt(mid) > scrollTop) hi = mid;
            else lo = mid + 1;
        }
        return lo;
    }

    // The anchor: the first visible line and its offset from the top of the viewport.
    // lines: [{ top, height }] in list coordinates. Returns { index, offset } or null.
    function chooseAnchor(lines, scrollTop) {
        const index = firstVisibleIndex(lines.length, i => lines[i].top, i => lines[i].height, scrollTop);
        if (index < 0) return null;
        return { index, offset: lines[index].top - scrollTop };
    }

    // The line to use when the anchor line is gone. keys: the lines at the time of the capture, in sequence.
    // index: the anchor index in keys. alive(key): true when the line is still in the list.
    // Rule: the anchor itself, else the nearest surviving line below it, else the nearest surviving line above it.
    // Returns the index in keys, or -1 when no line survived.
    function survivorIndex(keys, index, alive) {
        if (index < 0 || index >= keys.length) return -1;
        if (alive(keys[index])) return index;
        for (let i = index + 1; i < keys.length; i++) if (alive(keys[i])) return i;
        for (let i = index - 1; i >= 0; i--) if (alive(keys[i])) return i;
        return -1;
    }

    // The new scrollTop that puts the anchor line at its old offset from the top of the viewport.
    // A change of scrollTop, so it is also correct when the browser moved the list already.
    function restoreScrollTop(scrollTop, anchorTop, savedOffset) {
        return scrollTop + ((anchorTop - scrollTop) - savedOffset);
    }

    // The insert position of a line with the time t: after the last line with a time <= t.
    // Equal times keep the arrival sequence. times: the times of the lines in list sequence.
    function insertIndex(times, t) {
        const i = times.findIndex(x => Number(x) > t);
        return i < 0 ? times.length : i;
    }

    // The history lines to show: lines with an id that is not shown and not already in this batch,
    // sorted by time. The sort is stable, so equal times keep the sequence of the batch.
    function newHistoryLines(lines, isShown) {
        const seen = new Set();
        const out = [];
        for (const line of Array.isArray(lines) ? lines : []) {
            const id = line?.id;
            if (id !== undefined && id !== null && id !== '') {
                if (isShown(String(id)) || seen.has(String(id))) continue;
                seen.add(String(id));
            }
            out.push(line);
        }
        return out.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
    }

    // The unread counter. Each key counts one time. The first counted key is the first unread line.
    function createUnread() {
        const keys = new Set();
        let first = null;
        return {
            note(key) {
                if (keys.has(key)) return false;
                keys.add(key);
                if (first === null) first = key;
                return true;
            },
            clear() {
                keys.clear();
                first = null;
            },
            get count() {
                return keys.size;
            },
            get first() {
                return first;
            }
        };
    }

    const readingCore = {
        END_PX,
        isAtEnd,
        firstVisibleIndex,
        chooseAnchor,
        survivorIndex,
        restoreScrollTop,
        insertIndex,
        newHistoryLines,
        createUnread
    };
    window.readingCore = readingCore;

    if (typeof document === 'undefined') return;

    // ---- DOM part ----

    const list = document.getElementById('messages');
    const jumpButton = document.getElementById('jump-latest');
    const countSpan = document.getElementById('unread-count');
    if (!list) return;

    const UNREAD_CLASS = 'unread-first';
    const JUMP_END_MS = 1500;

    let following = true;
    // The stored anchor: { el, offset, keys, index }. A resize restores it.
    let anchor = null;
    // True while a smooth scroll of Jump to latest runs. The scroll events then do not stop following.
    let jumping = false;
    let jumpTimer = null;
    // True while the find bar (find.js) is open. The find bar moves the list, not the user: the list does not follow,
    // and a scroll to the end does not clear the unread count and the marker. restorePosition sets the old state.
    let hold = false;
    let highlightScrollTop = null;
    let unread = createUnread();
    let roomBeforeWhisper = null;

    function lines() {
        return list.children;
    }

    // Capture the first visible line and its offset. offsetTop ignores the transform of the line-in animation.
    // The list has position: relative (reading.css), so it is the offsetParent of each line.
    function captureAnchor() {
        const items = lines();
        const index = firstVisibleIndex(items.length, i => items[i].offsetTop, i => items[i].offsetHeight, list.scrollTop);
        if (index < 0) return null;
        const el = items[index];
        return { el, offset: el.offsetTop - list.scrollTop, keys: Array.from(items), index };
    }

    function scrollToEnd() {
        list.scrollTop = list.scrollHeight;
    }

    function restoreAnchor(saved) {
        if (!saved) return;
        const at = survivorIndex(saved.keys, saved.index, el => el.parentElement === list);
        if (at < 0) return;
        const el = saved.keys[at];
        // For a fallback line, keep the old position of the anchor line: the nearest line takes its place.
        list.scrollTop = restoreScrollTop(list.scrollTop, el.offsetTop, saved.offset);
    }

    function showUnread() {
        const count = unread.count;
        if (countSpan) countSpan.textContent = count > 0 ? String(count) : '';
        if (jumpButton) {
            jumpButton.hidden = following && count === 0;
            jumpButton.setAttribute('aria-label', count > 0 ? `Jump to latest, ${count} new` : 'Jump to latest');
        }
    }

    function clearUnread() {
        const first = unread.first;
        if (first && first.classList) first.classList.remove(UNREAD_CLASS);
        unread.clear();
        window.chatHighlights?.clearUnread();
    }

    function endJump() {
        jumping = false;
        if (jumpTimer !== null) clearTimeout(jumpTimer);
        jumpTimer = null;
    }

    function reducedMotion() {
        return typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    // Call before a change of the list (append, history insert). Returns the state for afterChange.
    function beforeChange() {
        if (roomBeforeWhisper) return roomBeforeWhisper;
        return { following, anchor: following ? null : captureAnchor() };
    }

    // Call after the change. Following: keep the end in view. Else: put the anchor line back at its offset.
    function afterChange(state) {
        if (roomBeforeWhisper) return;
        if (state?.following ?? following) scrollToEnd();
        else restoreAnchor(state?.anchor ?? anchor);
        anchor = captureAnchor();
        showUnread();
    }

    // Call for a new live line between beforeChange and afterChange. While not following, the line counts
    // one time as unread. The first unread line gets the marker class.
    function noteIncoming(item) {
        if ((!roomBeforeWhisper && following) || !item) return false;
        if (!unread.note(item)) return false;
        if (unread.first === item) item.classList.add(UNREAD_CLASS);
        return true;
    }

    // Go to the newest line and follow again. Clears the count and the marker.
    // smooth: a smooth scroll, only when the user does not ask for reduced motion.
    function followLatest(options = {}) {
        if (roomBeforeWhisper) return;
        const state = { following: true, anchor: null };
        clearUnread();
        following = true;
        const smooth = options.smooth === true && !reducedMotion() && typeof list.scrollTo === 'function';
        if (smooth) {
            jumping = true;
            if (jumpTimer !== null) clearTimeout(jumpTimer);
            jumpTimer = setTimeout(endJump, JUMP_END_MS);
            list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
            anchor = null;
            showUnread();
        } else {
            endJump();
            afterChange(state);
        }
    }

    list.addEventListener('scroll', () => {
        if (roomBeforeWhisper) return;
        const atEnd = isAtEnd(list.scrollHeight, list.scrollTop, list.clientHeight);
        // Revealing a near-end highlight can land exactly at the bottom. Keep the next
        // highlight pending until the user advances, even when Chromium posts scroll later.
        const revealed = highlightScrollTop !== null && list.scrollTop === highlightScrollTop;
        highlightScrollTop = null;
        if ((hold || revealed) && !jumping) {
            // The find bar moved the list. It does not follow: a new line counts as unread and does not move the
            // list away from the result. The count and the marker stay.
            following = false;
            anchor = captureAnchor();
            showUnread();
            return;
        }
        if (jumping) {
            if (atEnd) endJump();
            following = true;
        } else {
            following = atEnd;
        }
        if (atEnd && unread.count > 0) {
            // At the end by hand: the new lines are read.
            const state = { following: true, anchor: null };
            clearUnread();
            afterChange(state);
            return;
        }
        anchor = following ? null : captureAnchor();
        showUnread();
    }, { passive: true });

    if ('onscrollend' in list) {
        list.addEventListener('scrollend', () => {
            if (!jumping) return;
            endJump();
            following = isAtEnd(list.scrollHeight, list.scrollTop, list.clientHeight);
            showUnread();
        });
    }

    // A new size of the list (window resize, panel resize, transfer table). Following: keep the end.
    // Else: keep the stored anchor line at its offset. The callback comes after the layout change,
    // so it uses the anchor of the last scroll or change, not a new measurement.
    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => {
            if (roomBeforeWhisper) return;
            if (following) scrollToEnd();
            else restoreAnchor(anchor);
            if (!following) anchor = captureAnchor();
        }).observe(list);
    }

    if (jumpButton) jumpButton.addEventListener('click', () => followLatest({ smooth: true }));

    // The position now, for restorePosition: following, or the first visible line and its offset.
    function savePosition() {
        if (roomBeforeWhisper) return roomBeforeWhisper;
        return { following, anchor: following ? null : captureAnchor() };
    }

    // Put the list back at a saved position. The unread count and the marker do not change.
    function restorePosition(saved) {
        if (!saved || roomBeforeWhisper) return;
        endJump();
        following = saved.following === true;
        if (following) scrollToEnd();
        else restoreAnchor(saved.anchor);
        anchor = following ? null : captureAnchor();
        showUnread();
    }

    // on: true while the find bar is open (see hold).
    function setHold(on) {
        hold = on === true;
        if (hold) {
            following = false;
            anchor = captureAnchor();
            showUnread();
        }
    }

    // Saved rooms (milestone 6): a change above the viewport (older lines at the top of the list). The first visible
    // line stays at the same place on the screen. Following: the end stays in view.
    function keepPosition(change) {
        if (roomBeforeWhisper) return change();
        const saved = following ? null : captureAnchor();
        change();
        if (following) scrollToEnd();
        else restoreAnchor(saved);
        anchor = following ? null : captureAnchor();
        showUnread();
    }

    function revealLine(line) {
        endJump();
        following = false;
        const before = list.scrollTop;
        list.scrollTop = Math.max(0, line.offsetTop - Math.max(0, (list.clientHeight - line.offsetHeight) / 2));
        if (list.scrollTop !== before) highlightScrollTop = list.scrollTop;
        anchor = captureAnchor();
        showUnread();
    }

    window.reading = {
        suspendForWhisper() {
            if (roomBeforeWhisper) return;
            endJump();
            // Even a reader at the bottom needs this line if room traffic arrives in private chat.
            roomBeforeWhisper = { following, anchor: captureAnchor() };
        },
        resumeFromWhisper() {
            if (!roomBeforeWhisper) return;
            const saved = roomBeforeWhisper;
            roomBeforeWhisper = null;
            restorePosition({ following: saved.following && unread.count === 0, anchor: saved.anchor });
            if (unread.count) highlightScrollTop = list.scrollTop;
        },
        leaveChannel() {
            const state = { position: savePosition(), unread };
            unread = createUnread();
            endJump();
            return state;
        },
        enterChannel(state) {
            unread = state?.unread ?? createUnread();
            restorePosition(state?.position ?? { following: true });
        },
        revealLine,
        keepPosition,
        beforeChange,
        afterChange,
        noteIncoming,
        followLatest,
        savePosition,
        restorePosition,
        setHold,
        isFollowing: () => following && !roomBeforeWhisper,
        unreadCount: () => unread.count
    };
    showUnread();
})();
