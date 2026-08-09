// Shared mock scene graph: signals, actors, and bookkeeping the harness
// asserts against.
//
// Fidelity goal: faithful enough that the extension's real code paths run and
// real mistakes surface (missing methods, wrong property names, unbalanced
// connect/disconnect, actors left parented). It is not a Clutter emulator.

export const bookkeeping = {
    liveHandlers: 0,
    liveTimeouts: 0,
    createdActors: 0,
    destroyedActors: 0,
    warnings: [],
    errors: [],
};

export function resetBookkeeping() {
    bookkeeping.liveHandlers = 0;
    bookkeeping.liveTimeouts = 0;
    bookkeeping.createdActors = 0;
    bookkeeping.destroyedActors = 0;
    bookkeeping.warnings = [];
    bookkeeping.errors = [];
}

let nextHandlerId = 1;

/** Minimal GObject-style signal emitter. */
export class Emitter {
    constructor() {
        this._handlers = new Map();
        this._destroyed = false;
    }

    connect(signal, callback) {
        if (this._destroyed)
            throw new Error('Object has been already deallocated');
        const id = nextHandlerId++;
        this._handlers.set(id, {signal, callback});
        bookkeeping.liveHandlers += 1;
        return id;
    }

    disconnect(id) {
        if (this._destroyed)
            throw new Error('Object has been already deallocated');
        if (!this._handlers.has(id))
            throw new Error(`No handler ${id}`);
        this._handlers.delete(id);
        bookkeeping.liveHandlers -= 1;
    }

    emit(signal, ...args) {
        for (const {signal: s, callback} of [...this._handlers.values()]) {
            if (s === signal || s === `notify::${signal}`)
                callback(this, ...args);
        }
    }

    notify(prop) {
        for (const {signal, callback} of [...this._handlers.values()]) {
            if (signal === `notify::${prop}`)
                callback(this, {name: prop});
        }
    }

    get handlerCount() {
        return this._handlers.size;
    }
}

export class ThemeNode {
    constructor(radius = 12) {
        this._radius = radius;
    }

    get_border_radius() {
        return this._radius;
    }

    lookup_color() {
        return [false, null];
    }

    get_color() {
        return {red: 0, green: 0, blue: 0, alpha: 255};
    }

    get_length() {
        return 0;
    }
}

export class Actor extends Emitter {
    constructor(params = {}) {
        super();
        bookkeeping.createdActors += 1;

        this._children = [];
        this._parent = null;
        this._effects = [];
        this._styleClasses = new Set();
        this._style = null;

        this.name = params.name ?? '';
        this.reactive = params.reactive ?? false;
        this.visible = params.visible ?? true;
        this.mapped = true;
        this.opacity = 255;
        this.x = 0;
        this.y = 0;
        this.width = params.width ?? 0;
        this.height = params.height ?? 0;

        this._hasClip = false;
        this._clip = [0, 0, 0, 0];
        this._clipToAllocation = false;

        if (params.style_class)
            this._styleClasses.add(params.style_class);
        if (params.source)
            this.source = params.source;
    }

    // --- tree ---
    add_child(child) {
        if (child._parent)
            throw new Error('actor already has a parent');
        child._parent = this;
        this._children.push(child);
        this.emit('child-added', child);
    }

    remove_child(child) {
        const i = this._children.indexOf(child);
        if (i < 0)
            throw new Error('not a child');
        this._children.splice(i, 1);
        child._parent = null;
        this.emit('child-removed', child);
    }

    insert_child_below(child, sibling) {
        child._parent = this;
        const i = sibling ? this._children.indexOf(sibling) : 0;
        this._children.splice(i < 0 ? 0 : i, 0, child);
        this.emit('child-added', child);
    }

    set_child_below_sibling(child, sibling) {
        const ci = this._children.indexOf(child);
        if (ci < 0)
            throw new Error('set_child_below_sibling: not a child');
        this._children.splice(ci, 1);
        const si = sibling ? this._children.indexOf(sibling) : this._children.length;
        this._children.splice(si < 0 ? this._children.length : si, 0, child);
    }

    get_children() {
        return [...this._children];
    }

    get_parent() {
        return this._parent;
    }

    get_stage() {
        return globalThis.global?.stage ?? null;
    }

    destroy() {
        if (this._destroyed)
            return;
        for (const child of [...this._children])
            child.destroy();
        if (this._parent)
            this._parent.remove_child(this);
        this.emit('destroy');
        bookkeeping.liveHandlers -= this._handlers.size;
        this._handlers.clear();
        this._destroyed = true;
        bookkeeping.destroyedActors += 1;
    }

    // --- geometry ---
    set_position(x, y) {
        this.x = x;
        this.y = y;
    }

    set_size(w, h) {
        this.width = w;
        this.height = h;
    }

    get_allocation_box() {
        const {width, height} = this;
        return {
            get_width: () => width,
            get_height: () => height,
            x1: this.x, y1: this.y,
        };
    }

    get_resource_scale() {
        return 1;
    }

    set_clip(x, y, w, h) {
        this._hasClip = true;
        this._clip = [x, y, w, h];
    }

    get_clip() {
        return this._clip;
    }

    has_clip() {
        return this._hasClip;
    }

    remove_clip() {
        this._hasClip = false;
    }

    set_clip_to_allocation(v) {
        this._clipToAllocation = v;
    }

    get_transformed_position() {
        let x = this.x;
        let y = this.y;
        let p = this._parent;
        while (p) {
            x += p.x;
            y += p.y;
            p = p._parent;
        }
        return [x, y];
    }

    get_transformed_size() {
        return [this.width, this.height];
    }

    show() {
        this.visible = true;
        this.notify('visible');
    }

    hide() {
        this.visible = false;
        this.notify('visible');
    }

    // --- effects ---
    add_effect(effect) {
        this._effects.push(effect);
        effect._actor = this;
    }

    remove_effect(effect) {
        const i = this._effects.indexOf(effect);
        if (i >= 0)
            this._effects.splice(i, 1);
    }

    // --- style ---
    add_style_class_name(c) {
        this._styleClasses.add(c);
    }

    remove_style_class_name(c) {
        this._styleClasses.delete(c);
    }

    has_style_class_name(c) {
        return this._styleClasses.has(c);
    }

    get_style() {
        return this._style;
    }

    set_style(s) {
        this._style = s;
    }

    get_name() {
        return this.name;
    }

    get_theme_node() {
        return new ThemeNode();
    }

    queue_repaint() {}
    queue_relayout() {}
    ease() {}
}
