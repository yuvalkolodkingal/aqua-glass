// Aqua Glass - adaptive text colour.
//
// Transparent backgrounds put theme-coloured text on an arbitrary wallpaper.
// Three separate mistakes make naive implementations oscillate or fail
// contrast; all three are handled here.
//
// 1. WHAT NOT TO RECOLOUR. Widgets that paint their own filled background -
//    quick toggles, sliders, icon buttons, message cards, the calendar's
//    today button - are already paired by GNOME with `-st-accent-fg-color`.
//    Overriding their label colour puts black text on an accent-blue pill.
//    So the tree walk PRUNES those subtrees entirely rather than skipping just
//    the widget itself: their children are on the filled background too.
//
// 2. HYSTERESIS lives in the decision function (color.js decideTextMode), not
//    here, but this module is what feeds it the previous state so borderline
//    backdrops settle instead of alternating.
//
// 3. PURE ENDPOINTS. The stylesheet uses #ffffff / #000000, not a softened
//    pair - see the note in color.js for why the softened version has a band
//    where neither foreground reaches AA.

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Log from './logger.js';
import {isAlive} from './compat.js';

/**
 * Subtrees to leave completely alone: each of these paints its own filled
 * background and ships with a foreground colour already matched to it.
 */
export const EXCLUDED_CLASSES = [
    'quick-toggle',
    'quick-slider',
    'quick-menu-toggle',
    'quick-toggle-menu',
    'quick-settings-system-item',
    'icon-button',
    'message',
    'events-button',
    'world-clocks-button',
    'weather-button',
    'calendar-today',
    'item-box',
    'selected',
    'check-box',
    'toggle-switch',
    'popup-menu-item-active',
];

/**
 * Style classes we add; also what we remove on revert.
 *
 * The shadow is a separate class per mode rather than a compound selector,
 * because St's CSS engine is not a full CSS implementation and plain class
 * selectors are the safest thing to depend on.
 */
export const FG_LIGHT_CLASS = 'aqua-glass-fg-light';
export const FG_DARK_CLASS = 'aqua-glass-fg-dark';
export const SHADOW_UNDER_LIGHT = 'aqua-glass-shadow-under-light';
export const SHADOW_UNDER_DARK = 'aqua-glass-shadow-under-dark';

/**
 * Applies and reverts adaptive foreground classes over one surface.
 */
export class AdaptiveText {
    /**
     * @param {string} label diagnostic label
     */
    constructor(label) {
        this._label = label;
        this._touched = [];
        this._mode = null;
    }

    get mode() {
        return this._mode;
    }

    get count() {
        return this._touched.length;
    }

    /**
     * Walk a subtree and tag every text-bearing leaf.
     *
     * @param {Clutter.Actor} root subtree root
     * @param {string} mode 'light' or 'dark'
     * @param {boolean} withShadow add the matched text shadow
     */
    apply(root, mode, withShadow) {
        this.revert();
        if (!isAlive(root))
            return;

        this._mode = mode;
        const isDark = mode === 'dark';
        const fgClass = isDark ? FG_DARK_CLASS : FG_LIGHT_CLASS;
        // A light halo under dark text, a dark halo under light text.
        const shadowClass = isDark ? SHADOW_UNDER_DARK : SHADOW_UNDER_LIGHT;

        const visit = (actor, depth) => {
            if (depth > 24 || !isAlive(actor))
                return;

            // Prune: this widget paints its own background, so it and
            // everything inside it keeps the theme's own pairing.
            if (isExcluded(actor))
                return;

            if (isTextBearing(actor)) {
                try {
                    actor.add_style_class_name(fgClass);
                    if (withShadow)
                        actor.add_style_class_name(shadowClass);
                    this._touched.push({actor, fgClass, shadowClass, withShadow});
                } catch {
                    // Not a St.Widget after all.
                }
            }

            let children = [];
            try {
                children = actor.get_children();
            } catch {
                return;
            }
            for (const child of children)
                visit(child, depth + 1);
        };

        Log.guard(`adaptiveText apply (${this._label})`, () => visit(root, 0));
    }

    /** Remove every class we added. */
    revert() {
        const touched = this._touched;
        this._touched = [];
        this._mode = null;

        for (const entry of touched) {
            if (!isAlive(entry.actor))
                continue;
            try {
                entry.actor.remove_style_class_name(entry.fgClass);
                if (entry.withShadow)
                    entry.actor.remove_style_class_name(entry.shadowClass);
            } catch {
                // Actor is going away anyway.
            }
        }
    }
}

/**
 * Does this actor paint its own filled background?
 *
 * @param {Clutter.Actor} actor the actor
 * @returns {boolean} true if its subtree must be left alone
 */
export function isExcluded(actor) {
    try {
        if (!actor.has_style_class_name)
            return false;
        for (const cls of EXCLUDED_CLASSES) {
            if (actor.has_style_class_name(cls))
                return true;
        }
    } catch {
        return false;
    }
    return false;
}

/**
 * Is this a leaf that renders text or a symbolic icon?
 *
 * St.Icon is included because symbolic icons are recoloured through the CSS
 * `color` property, exactly like labels.
 *
 * @param {Clutter.Actor} actor the actor
 * @returns {boolean} true if it should be recoloured
 */
export function isTextBearing(actor) {
    try {
        return actor instanceof St.Label ||
               actor instanceof St.Icon ||
               actor instanceof Clutter.Text;
    } catch {
        return false;
    }
}
