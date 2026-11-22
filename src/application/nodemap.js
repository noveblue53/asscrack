'use strict';

// The node map: one plain SVG in #node-map that shows the room as a web.
// - Each room member is a node. The own node has the text "(you)".
// - A mesh edge is a chat session between two members (from the topology data). When the endpoints agree on a
//   session route, use the reported kind. Missing or conflicting information produces an unknown edge.
// - A full node has a FULL badge.
// - A voice edge goes from each voice member to the host. The host is the voice relay and has a RELAY badge.
// - A node that speaks now has a pulse (a CSS animation, see styles.css).
// - A transfer edge is an active file transfer of this computer, with an arrow from the sender to the receiver.
//
// Interface: window.nodeMap.update(state). The renderer calls it when the data changes.
//   window.nodeMap.highlight(peerId): marks the node of that peer ID for a short time (data-highlight="true",
//   see menu.css). Only that node, also when two users have the same name. Returns false when the map has no node
//   for that peer ID.
//   window.nodeMap.select(peerId): keeps the inspected peer marked until selection changes.
//   state = {
//     self: <peer ID or null>, host: <peer ID or null>,
//     nodes: [{ id, name, color, inVoice, muted, speaking, fullNode }],   color is a name color class (nc0 to nc7)
//     links: { <peer ID>: [<peer ID>, ...] },                   the chat sessions that each peer reports
//     kinds: { <peer ID>: { <peer ID>: 'relay' | 'mesh' } },    optional: the link kind that each peer reports
//     transfers: [{ id, from, to }]                             the active transfers of this computer
//   }
// This file does not read the globals of the renderer. All peer text goes in with textContent.
//
// Test contract: each node element has data-node. The host node has data-host="true". A full node has
// data-full-node="true". Each edge element has data-edge, data-kind (mesh, relay, unknown, voice or transfer), data-from and
// data-to. A chat session is one edge; its title identifies locally observed and peer-reported routes.
//
// Motion: the nodes are on a ring. When the ring changes, the nodes move to the new positions in MOVE_MS and then
// stop. There is no continuous requestAnimationFrame loop. There is no motion while document.hidden is true or with
// prefers-reduced-motion.
(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const NODE_R = 17;
    const MOVE_MS = 280;
    const COLOR_RE = /^nc[0-7]$/;

    const container = document.getElementById('node-map');
    const legend = document.getElementById('map-legend');
    if (!container) {
        window.nodeMap = { update() {}, highlight() { return false; }, select() {} };
        return;
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    function svgEl(name, attrs) {
        const element = document.createElementNS(SVG_NS, name);
        if (attrs) for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
        return element;
    }

    function stop(offset, color, opacity) {
        return svgEl('stop', { offset, 'stop-color': color, 'stop-opacity': opacity });
    }

    // ---- The fixed parts of the picture ----

    const svg = svgEl('svg', { role: 'group', 'aria-label': 'Network map', width: '100%', height: '100%' });
    const defs = svgEl('defs');
    const gloss = svgEl('radialGradient', { id: 'nm-gloss', cx: 0.34, cy: 0.26, r: 0.62 });
    gloss.append(stop(0, '#ffffff', 0.9), stop(0.7, '#ffffff', 0));
    const shade = svgEl('linearGradient', { id: 'nm-shade', x1: 0, y1: 0, x2: 0, y2: 1 });
    shade.append(stop(0, '#ffffff', 0.2), stop(1, '#000000', 0.24));
    const gold = svgEl('linearGradient', { id: 'nm-gold', x1: 0, y1: 0, x2: 0, y2: 1 });
    gold.append(stop(0, '#fff3b8', 1), stop(0.5, '#ffd95a', 1), stop(0.51, '#f7c22c', 1), stop(1, '#ffe07a', 1));
    const arrow = svgEl('marker', {
        id: 'nm-arrow', viewBox: '0 0 10 10', refX: 7, refY: 5, markerWidth: 4.5, markerHeight: 4.5, orient: 'auto'
    });
    arrow.append(svgEl('path', { d: 'M0 0.5 L10 5 L0 9.5 z', fill: '#e07c00' }));
    defs.append(gloss, shade, gold, arrow);
    const meshLayer = svgEl('g', { class: 'nm-layer-mesh' });
    const voiceLayer = svgEl('g', { class: 'nm-layer-voice' });
    const transferLayer = svgEl('g', { class: 'nm-layer-transfer' });
    const nodeLayer = svgEl('g', { class: 'nm-layer-nodes' });
    svg.append(defs, meshLayer, voiceLayer, transferLayer, nodeLayer);
    container.replaceChildren(svg);

    const layers = { mesh: meshLayer, voice: voiceLayer, transfer: transferLayer };

    // ---- State ----

    const nodes = new Map(); // peer ID -> node view
    const edges = new Map(); // key -> edge view
    let order = []; // peer IDs in ring sequence: the own node first, then the other nodes by peer ID
    let lastSignature = '';
    let selected = null;
    let width = 0;
    let height = 0;
    let frame = 0; // the pending requestAnimationFrame ID, 0 when there is no motion
    let moveStart = 0;

    function noMotion() {
        return document.hidden || reducedMotion.matches;
    }

    // ---- Input ----

    function text(value) {
        return typeof value === 'string' ? value : '';
    }

    // Make a safe copy of the state. The copy has only the data that the picture shows.
    function normalize(state) {
        const self = text(state?.self) || null;
        const host = text(state?.host) || null;
        const list = [];
        const seen = new Set();
        for (const item of Array.isArray(state?.nodes) ? state.nodes : []) {
            const id = text(item?.id);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const inVoice = item.inVoice === true;
            const muted = inVoice && item.muted === true;
            list.push({
                id,
                name: text(item.name) || id.slice(0, 12),
                color: COLOR_RE.test(item.color) ? item.color : '',
                self: id === self,
                host: id === host,
                inVoice,
                muted,
                speaking: inVoice && !muted && item.speaking === true,
                // G6: the voice channel name ('' when the room has only General).
                channel: inVoice ? text(item.channel) : '',
                idle: item.idle === true,
                fullNode: item.fullNode === true
            });
        }
        // One mesh edge for each pair, also when the two peers report the session.
        const mesh = new Set();
        const links = state?.links !== null && typeof state?.links === 'object' ? state.links : {};
        const kinds = state?.kinds !== null && typeof state?.kinds === 'object' ? state.kinds : {};
        for (const [from, peers] of Object.entries(links)) {
            if (!seen.has(from) || !Array.isArray(peers)) continue;
            for (const to of peers) {
                if (typeof to !== 'string' || to === from || !seen.has(to)) continue;
                mesh.add(from < to ? `${from}|${to}` : `${to}|${from}`);
            }
        }
        // Each voice member that is not the host has one voice connection, to the host.
        const voice = seen.has(host) ? list.filter(node => node.inVoice && !node.host).map(node => node.id) : [];
        const transfers = [];
        const transferIds = new Set();
        for (const item of Array.isArray(state?.transfers) ? state.transfers : []) {
            const id = text(item?.id);
            const from = text(item?.from);
            const to = text(item?.to);
            if (!id || transferIds.has(id) || from === to || !seen.has(from) || !seen.has(to)) continue;
            transferIds.add(id);
            transfers.push({ id, from, to });
        }
        const chatEdges = [...mesh].sort().map(key => {
            const [from, to] = key.split('|');
            const a = kinds[from]?.[to];
            const b = kinds[to]?.[from];
            const local = (from === self && a) || (to === self && b);
            const reported = a || b;
            const conflict = a && b && a !== b;
            const kind = !conflict && (reported === 'mesh' || reported === 'relay') ? reported : 'unknown';
            const route = kind === 'mesh' ? 'Direct' : kind === 'relay' ? 'Relayed' : 'Unknown';
            const evidence = conflict ? 'conflicting reports' : local ? 'observed here' : reported ? 'peer-reported' : 'route unavailable';
            const title = route + ' (' + evidence + ')';
            return { from, to, kind, title };
        });
        const byId = new Map(list.map(node => [node.id, node]));
        for (const edge of chatEdges) {
            if (edge.from === self) byId.get(edge.to).linkToYou = edge.title;
            if (edge.to === self) byId.get(edge.from).linkToYou = edge.title;
        }
        return { host: seen.has(host) ? host : null, nodes: list, chatEdges, voice, transfers };
    }

    // ---- Nodes ----

    function makeNode(id) {
        const group = svgEl('g', { class: 'nm-node', 'data-node': id, role: 'button', tabindex: 0 });
        function activate() {
            if (group.classList.contains('self')) window.roomActions?.editAvailability();
            else window.peerInspector?.open(id);
        }
        group.addEventListener('click', activate);
        group.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activate();
            }
        });
        // The body has the start animation. The group has the position.
        const body = svgEl('g', { class: 'nm-body' });
        const title = svgEl('title');
        const pulse = svgEl('circle', { class: 'nm-pulse', r: NODE_R + 4 });
        const halo = svgEl('circle', { class: 'nm-halo', r: NODE_R + 3.5 });
        const orb = svgEl('circle', { class: 'nm-orb', r: NODE_R });
        const orbShade = svgEl('circle', { class: 'nm-orb-light', r: NODE_R, fill: 'url(#nm-shade)' });
        const orbGloss = svgEl('circle', { class: 'nm-orb-light', r: NODE_R, fill: 'url(#nm-gloss)' });
        const letter = svgEl('text', { class: 'nm-letter', 'text-anchor': 'middle', dy: '0.35em' });
        const voiceDot = svgEl('circle', { class: 'nm-voice-dot', r: 4.5, cx: NODE_R * 0.72, cy: NODE_R * 0.72 });
        const label = svgEl('text', { class: 'nm-name', 'text-anchor': 'middle' });
        const fullBadge = svgEl('g', { class: 'nm-full-badge', transform: `translate(${-NODE_R - 6} ${-NODE_R + 2})` });
        const fullBox = svgEl('rect', { x: -12, y: -6, width: 24, height: 11, rx: 5.5 });
        const fullText = svgEl('text', { 'text-anchor': 'middle', x: 0, y: 2.8 });
        fullText.textContent = 'FULL';
        fullBadge.append(fullBox, fullText);
        const badge = svgEl('g', { class: 'nm-badge' });
        const badgeBox = svgEl('rect', { x: -19, width: 38, height: 12, rx: 6, fill: 'url(#nm-gold)' });
        const badgeText = svgEl('text', { 'text-anchor': 'middle', x: 0 });
        badgeText.textContent = 'RELAY';
        badge.append(badgeBox, badgeText);
        body.append(title, pulse, halo, orb, orbShade, orbGloss, letter, voiceDot, label, badge, fullBadge);
        group.append(body);
        nodeLayer.append(group);
        return { id, group, title, letter, label, badge, badgeBox, badgeText, view: '', placed: false, up: null, host: false, x: 0, y: 0, fromX: 0, fromY: 0, toX: 0, toY: 0 };
    }

    function shortName(name, max) {
        const chars = Array.from(name);
        return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : name;
    }

    function showNode(node, data, labelMax) {
        const view = JSON.stringify([data, labelMax]);
        if (node.view === view) return;
        node.view = view;
        const classes = ['nm-node'];
        if (data.color) classes.push(data.color);
        for (const flag of ['self', 'host', 'inVoice', 'muted', 'speaking']) {
            if (data[flag]) classes.push(flag === 'inVoice' ? 'in-voice' : flag);
        }
        if (data.fullNode) classes.push('full-node');
        node.group.setAttribute('class', classes.join(' '));
        if (data.host) node.group.setAttribute('data-host', 'true');
        else node.group.removeAttribute('data-host');
        if (data.fullNode) node.group.setAttribute('data-full-node', 'true');
        else node.group.removeAttribute('data-full-node');
        const first = Array.from(data.name.trim())[0];
        node.letter.textContent = first ? first.toUpperCase() : '?';
        node.label.textContent = (data.self ? 'You' : shortName(data.name, labelMax)) + (data.idle ? ' · Idle peer' : '');
        const facts = [data.name + (data.self ? ' (you)' : '')];
        if (data.idle) facts.push('Idle peer');
        if (data.host) facts.push('host: the voice relay of the room');
        if (data.fullNode) facts.push('Full node · available to relay');
        if (data.linkToYou) facts.push('Chat link to you · ' + data.linkToYou);
        if (data.inVoice) facts.push((data.speaking ? 'speaks now' : data.muted ? 'in voice (muted)' : 'in voice') + (data.channel ? ' · ' + data.channel : ''));
        else facts.push('not in voice');
        node.group.setAttribute('aria-label', data.self ? 'Edit your availability and status note' : 'Inspect ' + data.name);
        node.title.textContent = facts.join('\n');
        if (node.host !== data.host) {
            node.host = data.host;
            node.up = null; // The label position depends on the badge.
        }
    }

    // The name is on the outer side of the ring: above a node in the top part, below the other nodes.
    function placeLabel(node, up) {
        if (node.up === up) return;
        node.up = up;
        if (up) {
            node.label.setAttribute('y', node.host ? -(NODE_R + 22) : -(NODE_R + 7));
            node.badgeBox.setAttribute('y', -(NODE_R + 18));
            node.badgeText.setAttribute('y', -(NODE_R + 9));
        } else {
            node.label.setAttribute('y', NODE_R + 14);
            node.badgeBox.setAttribute('y', NODE_R + 19);
            node.badgeText.setAttribute('y', NODE_R + 28);
        }
    }

    function syncNodes(state) {
        const ids = new Set(state.nodes.map(node => node.id));
        for (const [id, node] of nodes) {
            if (ids.has(id)) continue;
            node.group.remove();
            nodes.delete(id);
        }
        const labelMax = state.nodes.length > 8 ? 8 : 14;
        for (const data of state.nodes) {
            let node = nodes.get(data.id);
            if (!node) {
                node = makeNode(data.id);
                nodes.set(data.id, node);
                if (data.id === selected) setSelected(node, true);
            }
            showNode(node, data, labelMax);
        }
        const own = state.nodes.filter(node => node.self).map(node => node.id);
        const others = state.nodes.filter(node => !node.self).map(node => node.id).sort();
        order = [...own, ...others];
        assignSlots();
    }

    // ---- Edges ----

    function syncEdges(state) {
        const wanted = new Map();
        // The edge key has the kind, so a change of the kind makes a new element.
        for (const edge of state.chatEdges) {
            wanted.set(`${edge.kind}|${edge.from}|${edge.to}`, { ...edge, lane: 0, layer: 'mesh' });
        }
        for (const id of state.voice) wanted.set(`voice|${id}`, {
            kind: 'voice', from: id, to: state.host, lane: 0, title: 'Voice membership'
        });
        // Transfers between the same two nodes get different curves.
        const lanes = new Map();
        for (const transfer of state.transfers) {
            const pair = `${transfer.from}|${transfer.to}`;
            const lane = lanes.get(pair) ?? 0;
            lanes.set(pair, lane + 1);
            wanted.set(`transfer|${transfer.id}`, { kind: 'transfer', from: transfer.from, to: transfer.to, lane });
        }
        for (const [key, edge] of edges) {
            const next = wanted.get(key);
            if (next && next.from === edge.from && next.to === edge.to) continue;
            edge.element.remove();
            edges.delete(key);
        }
        for (const [key, data] of wanted) {
            const edge = edges.get(key);
            if (edge) {
                edge.lane = data.lane;
                if (edge.title) edge.title.textContent = data.title;
                continue;
            }
            const element = svgEl(data.kind === 'transfer' ? 'path' : 'line', {
                class: `nm-edge nm-edge-${data.kind}`,
                'data-edge': key,
                'data-kind': data.kind,
                'data-from': data.from,
                'data-to': data.to
            });
            if (data.kind === 'transfer') element.setAttribute('marker-end', 'url(#nm-arrow)');
            const title = data.title ? svgEl('title') : null;
            if (title) {
                title.textContent = data.title;
                element.append(title);
            }
            layers[data.layer ?? data.kind].append(element);
            edges.set(key, { ...data, title, element });
        }
    }

    // ---- Layout ----

    function round(value) {
        return Math.round(value * 10) / 10;
    }

    // The first three members form a triangle. A later arrival takes the largest free arc.
    // Existing peers keep their place on the ring as others join or leave.
    function assignSlots() {
        const occupied = order.map(id => nodes.get(id).slot).filter(Number.isFinite).sort((a, b) => a - b);
        for (const id of order) {
            const node = nodes.get(id);
            if (Number.isFinite(node.slot)) continue;
            let slot = occupied.length < 3 ? [0, 3 / 8, 5 / 8].find(value => !occupied.includes(value)) : null;
            if (slot === null) {
                let largest = 0;
                for (let i = 0; i < occupied.length; i++) {
                    const next = occupied[i + 1] ?? occupied[0] + 1;
                    const gap = next - occupied[i];
                    if (gap > largest) {
                        largest = gap;
                        slot = (occupied[i] + gap / 2) % 1;
                    }
                }
            }
            node.slot = slot;
            occupied.push(slot);
            occupied.sort((a, b) => a - b);
        }
    }
    function setTargets() {
        const w = width > 0 ? width : 320;
        const h = height > 0 ? height : 200;
        const count = order.length;
        const centerX = w / 2;
        const centerY = h / 2;
        const radiusY = Math.max(0, h / 2 - (NODE_R + 36));
        const radiusX = Math.max(0, Math.min(w / 2 - 52, radiusY * 2.4));
        order.forEach(id => {
            const node = nodes.get(id);
            const angle = Math.PI / 2 + node.slot * 2 * Math.PI;
            node.toX = count === 1 ? centerX : centerX + radiusX * Math.cos(angle);
            node.toY = count === 1 ? centerY : centerY + radiusY * Math.sin(angle);
            placeLabel(node, count > 1 && Math.sin(angle) < -0.25);
        });
    }

    function drawEdge(edge) {
        const a = nodes.get(edge.from);
        const b = nodes.get(edge.to);
        if (!a || !b) return;
        const element = edge.element;
        if (edge.kind !== 'transfer') {
            element.setAttribute('x1', round(a.x));
            element.setAttribute('y1', round(a.y));
            element.setAttribute('x2', round(b.x));
            element.setAttribute('y2', round(b.y));
            return;
        }
        // A curve at the side of the straight line, from the rim of the sender to the rim of the receiver.
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy) || 1;
        const bend = 16 + 10 * edge.lane;
        const controlX = (a.x + b.x) / 2 - (dy / length) * bend;
        const controlY = (a.y + b.y) / 2 + (dx / length) * bend;
        const startLength = Math.hypot(controlX - a.x, controlY - a.y) || 1;
        const endLength = Math.hypot(controlX - b.x, controlY - b.y) || 1;
        const startX = a.x + ((controlX - a.x) / startLength) * (NODE_R + 3);
        const startY = a.y + ((controlY - a.y) / startLength) * (NODE_R + 3);
        const endX = b.x + ((controlX - b.x) / endLength) * (NODE_R + 6);
        const endY = b.y + ((controlY - b.y) / endLength) * (NODE_R + 6);
        element.setAttribute('d', `M${round(startX)} ${round(startY)} Q${round(controlX)} ${round(controlY)} ${round(endX)} ${round(endY)}`);
    }

    function draw() {
        for (const node of nodes.values()) node.group.setAttribute('transform', `translate(${round(node.x)} ${round(node.y)})`);
        for (const edge of edges.values()) drawEdge(edge);
    }

    function stopMotion() {
        if (frame !== 0) cancelAnimationFrame(frame);
        frame = 0;
    }

    function snap() {
        stopMotion();
        for (const node of nodes.values()) {
            node.x = node.toX;
            node.y = node.toY;
            node.placed = true;
        }
        draw();
    }

    function step(now) {
        const t = Math.min(1, (now - moveStart) / MOVE_MS);
        const eased = 1 - Math.pow(1 - t, 3);
        for (const node of nodes.values()) {
            node.x = node.fromX + (node.toX - node.fromX) * eased;
            node.y = node.fromY + (node.toY - node.fromY) * eased;
        }
        draw();
        // The motion stops at the target positions. There is no frame request after that.
        frame = t < 1 ? requestAnimationFrame(step) : 0;
    }

    // Put the nodes at the target positions. With move = true, the nodes that are in the picture move there.
    function layout(move) {
        setTargets();
        let moved = false;
        for (const node of nodes.values()) {
            if (!node.placed) {
                // A new node starts at its position. Its start animation is in styles.css.
                node.x = node.toX;
                node.y = node.toY;
                node.placed = true;
            }
            node.fromX = node.x;
            node.fromY = node.y;
            if (Math.abs(node.toX - node.x) > 0.5 || Math.abs(node.toY - node.y) > 0.5) moved = true;
        }
        if (!move || !moved || noMotion()) {
            snap();
            return;
        }
        stopMotion();
        draw();
        moveStart = performance.now();
        frame = requestAnimationFrame(step);
    }

    // ---- Highlight of one node ----
    // The attribute data-highlight is not in the class list, because showNode replaces the class list at each change.

    const HIGHLIGHT_MS = 2400;
    let highlighted = null;
    let highlightTimer = 0;

    function clearHighlight() {
        if (highlightTimer) clearTimeout(highlightTimer);
        highlightTimer = 0;
        if (highlighted) highlighted.group.removeAttribute('data-highlight');
        highlighted = null;
    }

    function highlight(id) {
        clearHighlight();
        const node = nodes.get(String(id ?? ''));
        if (!node) return false;
        node.group.setAttribute('data-highlight', 'true');
        highlighted = node;
        highlightTimer = setTimeout(clearHighlight, HIGHLIGHT_MS);
        return true;
    }

    function setSelected(node, value) {
        if (!node) return;
        if (value) node.group.setAttribute('data-selected', 'true');
        else node.group.removeAttribute('data-selected');
    }

    function select(id) {
        setSelected(nodes.get(selected), false);
        selected = id;
        setSelected(nodes.get(selected), true);
    }

    function updateLegend(state) {
        if (!legend) return;
        const kinds = new Set(state.chatEdges.map(edge => edge.kind));
        const shown = {
            relay: Boolean(state.host),
            direct: kinds.has('mesh'),
            relayed: kinds.has('relay'),
            unknown: kinds.has('unknown'),
            full: state.nodes.some(node => node.fullNode),
            voice: state.nodes.some(node => node.inVoice),
            speaking: state.nodes.some(node => node.speaking),
            file: state.transfers.length > 0,
        };
        for (const key of legend.children) key.hidden = !shown[key.dataset.legend];
        legend.hidden = !Object.values(shown).some(Boolean);
    }

    // ---- Interface and page events ----

    function update(state) {
        const next = normalize(state);
        const signature = JSON.stringify(next);
        if (signature === lastSignature) return;
        lastSignature = signature;
        window.peerInspector?.update(next);
        syncNodes(next);
        syncEdges(next);
        updateLegend(next);
        layout(true);
    }

    new ResizeObserver(entries => {
        const box = entries[entries.length - 1].contentRect;
        if (box.width === width && box.height === height) return;
        width = box.width;
        height = box.height;
        layout(false);
    }).observe(container);

    // No motion in a hidden page: the nodes go to the target positions and the pulse stops (styles.css).
    function showPageState() {
        if (document.hidden) {
            snap();
            container.setAttribute('data-paused', 'true');
        } else {
            container.removeAttribute('data-paused');
        }
    }
    document.addEventListener('visibilitychange', showPageState);
    showPageState();

    window.nodeMap = { update, highlight, select };
})();
