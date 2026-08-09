import {Actor, Emitter} from '../core.mjs';

// ---------------------------------------------------------------- laters
const laterQueue = new Map();
let nextLaterId = 1;

export const laterControl = {
    flush(maxRounds = 100) {
        let rounds = 0;
        while (laterQueue.size > 0 && rounds < maxRounds) {
            rounds += 1;
            for (const [id, fn] of [...laterQueue.entries()]) {
                laterQueue.delete(id);
                fn();
            }
        }
    },
    get pending() {
        return laterQueue.size;
    },
};

const laters = {
    add(type, fn) {
        const id = nextLaterId++;
        laterQueue.set(id, fn);
        return id;
    },
    remove(id) {
        if (!laterQueue.has(id))
            throw new Error(`laters.remove: no such later ${id}`);
        laterQueue.delete(id);
    },
};

// ------------------------------------------------------------- the scene
const MONITOR = {x: 0, y: 0, width: 1920, height: 1080, index: 0};

const stage = new Actor({name: 'stage'});
stage.set_size(MONITOR.width, MONITOR.height);

const windowGroup = new Actor({name: 'window_group'});
windowGroup.set_size(MONITOR.width, MONITOR.height);
const backgroundGroup = new Actor({name: 'backgroundGroup'});
windowGroup.add_child(backgroundGroup);

const uiGroup = new Actor({name: 'uiGroup'});
uiGroup.set_size(MONITOR.width, MONITOR.height);
stage.add_child(uiGroup);
uiGroup.add_child(windowGroup);

const panel = new Actor({name: 'panel'});
panel.set_size(MONITOR.width, 32);
panel.statusArea = {};

const panelBox = new Actor({name: 'panelBox'});
panelBox.set_size(MONITOR.width, 32);
panelBox.add_child(panel);
uiGroup.add_child(panelBox);

globalThis.global = {
    stage,
    window_group: windowGroup,
    display: new Emitter(),
    workspace_manager: new Emitter(),
    compositor: {get_laters: () => laters},
};

// ------------------------------------------------------------ Main object
class Overview extends Emitter {
    constructor() {
        super();
        this.visible = false;
    }
}

class MessageTray extends Emitter {
    constructor() {
        super();
        this._bannerBin = new Actor({name: 'notification-container'});
        uiGroup.add_child(this._bannerBin);
        this.added = [];
    }

    add(source) {
        this.added.push(source);
    }
}

class ExtensionManager extends Emitter {
    constructor() {
        super();
        this._extensions = new Map();
    }

    lookup(uuid) {
        return this._extensions.get(uuid) ?? null;
    }
}

export const layoutManager = {
    uiGroup,
    panelBox,
    monitors: [MONITOR],
    primaryMonitor: MONITOR,
    _backgroundGroup: backgroundGroup,
    ...new Emitter(),
};

// layoutManager needs to be a real emitter (monitors-changed).
const layoutEmitter = new Emitter();
layoutManager.connect = layoutEmitter.connect.bind(layoutEmitter);
layoutManager.disconnect = layoutEmitter.disconnect.bind(layoutEmitter);
layoutManager.emit = layoutEmitter.emit.bind(layoutEmitter);

export {panel};
export const overview = new Overview();
export const messageTray = new MessageTray();
export const extensionManager = new ExtensionManager();
export const uiGroupRef = uiGroup;
export const MONITOR_GEOMETRY = MONITOR;

/**
 * Build a popup that classify() should recognise, shaped like a real
 * BoxPointer: an outer actor with an inner `popup-menu-content` box.
 *
 * @param {string} contentClass style class of the painting actor
 * @param {string} [markerClass] optional marker class on the boxpointer
 * @returns {object} the popup actors
 */
export function makePopup(contentClass = 'popup-menu-content', markerClass = null) {
    const boxPointer = new Actor({name: 'boxpointer', style_class: 'popup-menu-boxpointer'});
    if (markerClass)
        boxPointer.add_style_class_name(markerClass);

    const content = new Actor({name: 'content', style_class: contentClass});
    content.set_size(320, 400);
    boxPointer.add_child(content);

    const label = new (globalThis.__StLabel ?? Actor)({name: 'label'});
    content.add_child(label);

    boxPointer.set_position(600, 40);
    boxPointer.set_size(320, 400);
    boxPointer.visible = false;
    boxPointer._border = new Actor({name: 'border'});
    boxPointer.add_child(boxPointer._border);

    uiGroup.add_child(boxPointer);
    return {boxPointer, content, label};
}
