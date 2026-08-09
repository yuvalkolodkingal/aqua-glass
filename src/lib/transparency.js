// Aqua Glass - making shell surfaces transparent, reversibly.
//
// Architecture rule 6: "Making a popup transparent means clearing the INNER
// content box, not just the outer actor."
//
// Verified against the GNOME 48/49/50 theme sources. The visible bubble of a
// menu is NOT painted by the BoxPointer - for every `popup-menu-boxpointer`
// the stock theme sets neither `-arrow-background-color` nor
// `-arrow-border-width`, so BoxPointer._drawBorder builds a cairo path and
// then discards it. What you actually see is `menu.box`, a St.BoxLayout with
// style class `popup-menu-content`, styled in _popovers.scss with a
// background-color, a 1px border and a box-shadow. All three have to go, or a
// ghost outline survives.
//
// A geometry warning worth repeating, because getting it wrong moves menus
// around the screen: `-arrow-border-width` and `-arrow-rise` are read in
// BoxPointer's vfunc_get_preferred_width/height, vfunc_allocate and
// _reposition. They are layout inputs, not decoration. Only
// `-arrow-background-color` and `-arrow-border-color` are paint-only and
// therefore safe for us to touch.

import St from 'gi://St';

import * as Log from './logger.js';
import {isAlive} from './compat.js';

/** Inline style that clears every way a St widget can paint a background. */
const CLEAR_STYLE = [
    'background-color: transparent;',
    'background-image: none;',
    'border-color: transparent;',
    'box-shadow: none;',
].join(' ');

/**
 * Paint-only arrow overrides. Deliberately does NOT include
 * `-arrow-border-width`, which would resize the menu.
 */
const CLEAR_ARROW_STYLE = [
    '-arrow-background-color: transparent;',
    '-arrow-border-color: transparent;',
].join(' ');

/**
 * Remembers the inline style of a set of actors so it can be put back exactly
 * as it was.
 */
export class TransparencyGroup {
    constructor(label) {
        this._label = label;
        this._entries = [];
        this._applied = false;
    }

    get isApplied() {
        return this._applied;
    }

    get count() {
        return this._entries.length;
    }

    /**
     * Make an actor's background transparent, remembering what was there.
     *
     * @param {St.Widget} actor the painting actor
     * @param {string} [extra] additional inline CSS
     */
    add(actor, extra = '') {
        if (!isAlive(actor))
            return;
        try {
            const previous = actor.get_style ? actor.get_style() : null;
            this._entries.push({actor, previous});
            actor.set_style(`${previous || ''} ${CLEAR_STYLE} ${extra}`.trim());
        } catch (e) {
            Log.error(e, `transparency add (${this._label})`);
        }
    }

    /**
     * Neutralise a BoxPointer's cairo-drawn bubble.
     *
     * Only matters for boxpointers whose theme actually sets the arrow colours
     * (the on-screen keyboard's subkey popup in stock GNOME, or any user
     * theme that adds them), but it costs nothing to be safe.
     *
     * @param {St.Widget} boxPointer the BoxPointer actor
     */
    addBoxPointer(boxPointer) {
        if (!isAlive(boxPointer))
            return;
        try {
            const previous = boxPointer.get_style ? boxPointer.get_style() : null;
            this._entries.push({actor: boxPointer, previous, repaintBorder: true});
            boxPointer.set_style(`${previous || ''} ${CLEAR_ARROW_STYLE}`.trim());
            queueBorderRepaint(boxPointer);
        } catch (e) {
            Log.error(e, `transparency addBoxPointer (${this._label})`);
        }
    }

    /** Mark the group as applied. */
    markApplied() {
        this._applied = true;
    }

    /**
     * Restore every remembered inline style.
     *
     * Called *before* the glass is hidden when a popup closes (architecture
     * rule 4): restoring the background first and dropping the glass a frame
     * later is what stops the user seeing a grey flash on the way out.
     */
    restore() {
        const entries = this._entries;
        this._entries = [];
        this._applied = false;

        for (const entry of entries) {
            if (!isAlive(entry.actor))
                continue;
            try {
                entry.actor.set_style(entry.previous);
                if (entry.repaintBorder)
                    queueBorderRepaint(entry.actor);
            } catch {
                // The actor is on its way out; nothing to restore onto.
            }
        }
    }
}

/**
 * Ask a BoxPointer's border DrawingArea to repaint.
 *
 * St only recomputes style for *mapped* widgets, so a style change applied to
 * a hidden menu would otherwise be deferred. This is what the shell itself
 * does in setArrowOrigin/setArrowActor.
 *
 * @param {St.Widget} boxPointer the BoxPointer actor
 */
export function queueBorderRepaint(boxPointer) {
    try {
        if (boxPointer._border && boxPointer._border.queue_repaint) {
            boxPointer._border.queue_repaint();
            return;
        }
    } catch {
        // Fall through to the structural search.
    }

    // `_border` is private API. If a future version renames it, find the
    // DrawingArea child instead of giving up.
    try {
        for (const child of boxPointer.get_children()) {
            if (child instanceof St.DrawingArea)
                child.queue_repaint();
        }
    } catch {
        // ignore
    }
}

/**
 * Find the actor that actually paints a popup's background.
 *
 * @param {Clutter.Actor} root the popup's outer actor
 * @param {string[]} classes candidate style class names, most specific first
 * @returns {Clutter.Actor|null} the painting actor
 */
export function findPaintingActor(root, classes) {
    if (!isAlive(root))
        return null;

    const matches = actor => {
        try {
            return classes.some(c => actor.has_style_class_name?.(c));
        } catch {
            return false;
        }
    };

    if (matches(root))
        return root;

    // Breadth-first: the content box is normally a direct or near child.
    const queue = [root];
    let guard = 0;
    while (queue.length > 0 && guard < 400) {
        guard += 1;
        const actor = queue.shift();
        let children = [];
        try {
            children = actor.get_children();
        } catch {
            continue;
        }
        for (const child of children) {
            if (matches(child))
                return child;
            queue.push(child);
        }
    }
    return null;
}

/**
 * Read a corner radius out of an actor's theme node.
 *
 * Lets the glass follow whatever the current (or user) theme uses instead of
 * hard-coding GNOME's numbers.
 *
 * @param {St.Widget} actor the painting actor
 * @param {number} fallback radius to use if it cannot be read
 * @returns {number} corner radius in pixels
 */
export function themeCornerRadius(actor, fallback) {
    if (!isAlive(actor))
        return fallback;
    try {
        const node = actor.get_theme_node();
        if (!node)
            return fallback;
        // St.Corner.TOPLEFT === 0
        const r = node.get_border_radius(0);
        if (typeof r === 'number' && r >= 0)
            return r;
    } catch {
        // Not a St.Widget, or no theme node yet.
    }
    return fallback;
}
