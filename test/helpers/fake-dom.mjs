// A small fake DOM for the renderer tests. It has only the parts that the classic scripts of src/application use
// when they load and when a test runs a quote, a menu action or a send. No layout: all sizes are 0.
// Selectors: one or more simple selectors separated by commas, each a compound of tag, #id, .class and
// [attr] or [attr="value"]. A selector with a combinator (a space or ">") matches nothing.

class FakeEvent {
    constructor(type, init = {}) {
        this.type = type;
        this.bubbles = init.bubbles !== false;
        Object.assign(this, init);
        this.defaultPrevented = false;
        this.propagationStopped = false;
        this.target = null;
        this.currentTarget = null;
    }

    preventDefault() {
        this.defaultPrevented = true;
    }

    stopPropagation() {
        this.propagationStopped = true;
    }

    stopImmediatePropagation() {
        this.propagationStopped = true;
    }
}

class EventTargetBase {
    constructor() {
        this._listeners = new Map();
    }

    addEventListener(type, fn, options) {
        if (typeof fn !== 'function') return;
        const capture = options === true || options?.capture === true;
        const list = this._listeners.get(type) ?? [];
        list.push({ fn, capture });
        this._listeners.set(type, list);
    }

    removeEventListener(type, fn) {
        const list = this._listeners.get(type);
        if (list) this._listeners.set(type, list.filter(l => l.fn !== fn));
    }

    _fire(event, capture) {
        for (const { fn, capture: c } of [...(this._listeners.get(event.type) ?? [])]) {
            if (c !== capture) continue;
            event.currentTarget = this;
            fn.call(this, event);
        }
    }
}

function parseCompound(text) {
    const s = text.trim();
    if (!s || /[\s>+~]/.test(s.replace(/\[[^\]]*\]/g, ''))) return null;
    const out = { tag: null, id: null, classes: [], attrs: [] };
    const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/gy;
    let m;
    let at = 0;
    while (at < s.length) {
        re.lastIndex = at;
        m = re.exec(s);
        if (!m) return null;
        if (m[1]) out.tag = m[1].toUpperCase();
        else if (m[2]) out.id = m[2];
        else if (m[3]) out.classes.push(m[3]);
        else out.attrs.push({ name: m[4], value: m[5] });
        at = re.lastIndex;
    }
    return out;
}

function matchesSelector(el, selector) {
    if (!(el instanceof FakeElement)) return false;
    return String(selector).split(',').some(part => {
        const c = parseCompound(part);
        if (!c) return false;
        if (c.tag && el.tagName !== c.tag) return false;
        if (c.id && el.id !== c.id) return false;
        if (c.classes.some(cl => !el.classList.contains(cl))) return false;
        return c.attrs.every(({ name, value }) => {
            const v = el.getAttribute(name);
            return value === undefined ? v !== null : v === value;
        });
    });
}

export class FakeText {
    constructor(data, doc) {
        this.nodeType = 3;
        this.data = String(data);
        this.parentNode = null;
        this.ownerDocument = doc;
    }

    get textContent() {
        return this.data;
    }

    set textContent(v) {
        this.data = String(v);
    }

    get parentElement() {
        return this.parentNode instanceof FakeElement ? this.parentNode : null;
    }

    remove() {
        this.parentNode?.removeChild(this);
    }
}

function dataKey(name) {
    return name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function dataAttr(key) {
    return `data-${key.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)}`;
}

export class FakeElement extends EventTargetBase {
    constructor(tag, doc) {
        super();
        this.nodeType = 1;
        this.tagName = String(tag).toUpperCase();
        this.ownerDocument = doc;
        this.childNodes = [];
        this.parentNode = null;
        this._attrs = new Map();
        this._classes = new Set();
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.tabIndex = 0;
        this.title = '';
        this.scrollTop = 0;
        this.scrollLeft = 0;
        this.clientHeight = 0;
        this.clientWidth = 0;
        this.scrollHeight = 0;
        this.offsetHeight = 0;
        this.offsetTop = 0;
        const self = this;
        this.classList = {
            add: (...c) => c.forEach(x => self._classes.add(x)),
            remove: (...c) => c.forEach(x => self._classes.delete(x)),
            contains: c => self._classes.has(c),
            toggle: (c, force) => {
                const on = force === undefined ? !self._classes.has(c) : Boolean(force);
                if (on) self._classes.add(c);
                else self._classes.delete(c);
                return on;
            }
        };
        this.dataset = new Proxy({}, {
            set: (target, key, value) => {
                target[key] = String(value);
                return true;
            },
            deleteProperty: (target, key) => {
                delete target[key];
                return true;
            }
        });
        this.style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' };
    }

    get id() {
        return this._attrs.get('id') ?? '';
    }

    set id(v) {
        this._attrs.set('id', String(v));
    }

    get className() {
        return [...this._classes].join(' ');
    }

    set className(v) {
        this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
    }

    setAttribute(name, value) {
        if (name === 'class') this.className = value;
        else if (name.startsWith('data-')) this.dataset[dataKey(name)] = value;
        else this._attrs.set(name, String(value));
    }

    getAttribute(name) {
        if (name === 'class') return this._classes.size ? this.className : null;
        if (name.startsWith('data-')) return this.dataset[dataKey(name)] ?? null;
        return this._attrs.get(name) ?? null;
    }

    hasAttribute(name) {
        return this.getAttribute(name) !== null;
    }

    removeAttribute(name) {
        if (name.startsWith('data-')) delete this.dataset[dataKey(name)];
        else this._attrs.delete(name);
    }

    get children() {
        return this.childNodes.filter(n => n instanceof FakeElement);
    }

    get firstChild() {
        return this.childNodes[0] ?? null;
    }

    get lastChild() {
        return this.childNodes[this.childNodes.length - 1] ?? null;
    }

    get firstElementChild() {
        return this.children[0] ?? null;
    }

    get parentElement() {
        return this.parentNode instanceof FakeElement ? this.parentNode : null;
    }

    _sibling(step) {
        const parent = this.parentNode;
        if (!parent) return null;
        const list = parent.children;
        return list[list.indexOf(this) + step] ?? null;
    }

    get previousElementSibling() {
        return this._sibling(-1);
    }

    get nextElementSibling() {
        return this._sibling(1);
    }

    get isConnected() {
        let node = this;
        while (node.parentNode) node = node.parentNode;
        return node === this.ownerDocument;
    }

    get textContent() {
        return this.childNodes.map(n => n.textContent).join('');
    }

    set textContent(v) {
        for (const n of this.childNodes) n.parentNode = null;
        this.childNodes = [];
        if (String(v ?? '') !== '') this.appendChild(new FakeText(v, this.ownerDocument));
    }

    _node(n) {
        return typeof n === 'string' ? new FakeText(n, this.ownerDocument) : n;
    }

    insertBefore(node, ref) {
        const n = this._node(node);
        if (n.parentNode) n.parentNode.removeChild(n);
        const at = ref ? this.childNodes.indexOf(ref) : -1;
        if (at < 0) this.childNodes.push(n);
        else this.childNodes.splice(at, 0, n);
        n.parentNode = this;
        return n;
    }

    appendChild(node) {
        return this.insertBefore(node, null);
    }

    append(...nodes) {
        for (const n of nodes) this.appendChild(n);
    }

    prepend(...nodes) {
        const first = this.firstChild;
        for (const n of nodes) this.insertBefore(n, first);
    }

    removeChild(node) {
        const at = this.childNodes.indexOf(node);
        if (at >= 0) this.childNodes.splice(at, 1);
        node.parentNode = null;
        return node;
    }

    remove() {
        this.parentNode?.removeChild(this);
    }

    replaceChildren(...nodes) {
        for (const n of this.childNodes) n.parentNode = null;
        this.childNodes = [];
        this.append(...nodes);
    }

    contains(node) {
        for (let n = node; n; n = n.parentNode) if (n === this) return true;
        return false;
    }

    _descendants() {
        const out = [];
        const walk = el => {
            for (const c of el.children) {
                out.push(c);
                walk(c);
            }
        };
        walk(this);
        return out;
    }

    querySelectorAll(selector) {
        return this._descendants().filter(el => matchesSelector(el, selector));
    }

    querySelector(selector) {
        return this._descendants().find(el => matchesSelector(el, selector)) ?? null;
    }

    matches(selector) {
        return matchesSelector(this, selector);
    }

    closest(selector) {
        for (let n = this; n instanceof FakeElement; n = n.parentNode) if (matchesSelector(n, selector)) return n;
        return null;
    }

    focus() {
        this.ownerDocument.activeElement = this;
    }

    blur() {
        if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
    }

    click() {
        if (this.disabled) return;
        this.dispatchEvent(new FakeEvent('click'));
    }

    getBoundingClientRect() {
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    }

    scrollIntoView() {}

    scrollTo() {}

    dispatchEvent(event) {
        event.target = this;
        const path = [];
        for (let n = this; n; n = n.parentNode) path.push(n);
        const win = this.ownerDocument.defaultView;
        if (win) path.push(win);
        for (const n of [...path].reverse()) {
            n._fire(event, true);
            if (event.propagationStopped) return !event.defaultPrevented;
        }
        for (const n of path) {
            if (n !== this && !event.bubbles) break;
            n._fire(event, false);
            if (event.propagationStopped) break;
        }
        return !event.defaultPrevented;
    }
}

class FakeDocument extends FakeElement {
    constructor() {
        super('#document', null);
        this.ownerDocument = this;
        this.nodeType = 9;
        this.documentElement = new FakeElement('html', this);
        this.appendChild(this.documentElement);
        this.body = new FakeElement('body', this);
        this.documentElement.appendChild(this.body);
        this.activeElement = this.body;
        this.defaultView = null;
    }

    get isConnected() {
        return true;
    }

    createElement(tag) {
        return new FakeElement(tag, this);
    }

    createTextNode(text) {
        return new FakeText(text, this);
    }

    getElementById(id) {
        return this.querySelector(`#${id}`);
    }

    getSelection() {
        return { toString: () => '', isCollapsed: true, rangeCount: 0 };
    }
}

class FakeWindow extends EventTargetBase {
    _fire(event, capture) {
        super._fire(event, capture);
    }
}

// Make a document. layout: { tag, id, class, children: [...] } trees that go in the body.
export function createDom(layout = []) {
    const document = new FakeDocument();
    const build = spec => {
        const el = document.createElement(spec.tag ?? 'div');
        if (spec.id) el.id = spec.id;
        if (spec.class) el.className = spec.class;
        if (spec.hidden) el.hidden = true;
        if (spec.value !== undefined) el.value = spec.value;
        for (const child of spec.children ?? []) el.appendChild(build(child));
        return el;
    };
    for (const spec of layout) document.body.appendChild(build(spec));
    const window = new FakeWindow();
    document.defaultView = window;
    return { document, window, Event: FakeEvent };
}

export { FakeEvent };
