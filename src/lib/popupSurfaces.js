// Aqua Glass - every transient popup in the shell, served by ONE glass.
//
// Architecture rule 1, restated: only one popup is on screen at a time, so we
// build the glass once, RETARGET it, and destroy it once. Attaching to a popup
// must allocate nothing but signal ids. A full-screen offscreen framebuffer
// per menu is what drove gnome-shell to 2.3 GB and ended the session.
//
// Architecture rule 5, restated: tear down when the popup is GONE, not when
// close() is called. PopupMenu.close() emits open-state-changed(false)
// immediately and only calls hide() from the fade-out's onComplete
// (popupMenu.js:1137-1146, boxpointer.js:124-170), so restoring the opaque
// background on open-state-changed makes the user watch a grey menu fade out.
//
// The predicate this module uses instead - `visible && mapped`, re-evaluated
// on notify::visible, notify::mapped and destroy - is true exactly when the
// popup is really on screen, for every popup class in the shell. It needs no
// per-class knowledge of close animations, which is what makes it survive the
// 48 -> 49 animation rework (49 added a scale animation and flipped the close
// translation sign) without any version branching.

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Log from './logger.js';
import {isAlive, monitorForRect, topLevelUnder} from './compat.js';
import {TransparencyGroup, themeCornerRadius} from './transparency.js';
import {AdaptiveText} from './adaptiveText.js';
import {ColorSampler, predictedLuminance} from './sampler.js';
import {decideTextMode, idealThreshold, medianLuminance} from './color.js';

/**
 * How a paint class maps to a surface, its settings key and its default
 * corner radius. Order matters: the first match wins, so more specific
 * classes come first.
 */
const PAINT_CLASSES = [
    {cls: 'candidate-popup-content', id: 'ibus-candidate', key: 'surface-ibus-candidate', radius: 12},
    {cls: 'quick-settings', id: 'quick-settings', key: 'surface-quick-settings', radius: 22},
    {cls: 'datemenu-popover', id: 'date-menu', key: 'surface-date-menu', radius: 22},
    {cls: 'workspace-switcher', id: 'workspace-switcher', key: 'surface-workspace-switcher', radius: 18},
    {cls: 'switcher-list', id: 'alt-tab', key: 'surface-alt-tab', radius: 18},
    {cls: 'osd-window', id: 'osd', key: 'surface-osd', radius: 20},
    {cls: 'notification-banner', id: 'notifications', key: 'surface-notifications', radius: 16},
    {cls: 'popup-menu-content', id: 'panel-menus', key: 'surface-panel-menus', radius: 20},
];

/** Marker classes on the BoxPointer that refine a plain popup-menu-content. */
const BOXPOINTER_MARKERS = [
    {cls: 'app-menu', id: 'context-menus', key: 'surface-context-menus'},
    {cls: 'background-menu', id: 'context-menus', key: 'surface-context-menus'},
    {cls: 'window-menu', id: 'window-menus', key: 'surface-window-menus'},
];

/**
 * Depth-first search for the first descendant carrying one of `classes`.
 *
 * @param {Clutter.Actor} root subtree root
 * @param {string[]} classes style class names
 * @param {number} maxDepth search depth limit
 * @returns {{actor: Clutter.Actor, cls: string}|null} first match
 */
function findByClass(root, classes, maxDepth = 6) {
    if (!isAlive(root))
        return null;

    const queue = [{actor: root, depth: 0}];
    let guard = 0;

    while (queue.length > 0 && guard < 500) {
        guard += 1;
        const {actor, depth} = queue.shift();

        try {
            if (actor.has_style_class_name) {
                for (const cls of classes) {
                    if (actor.has_style_class_name(cls))
                        return {actor, cls};
                }
            }
        } catch {
            continue;
        }

        if (depth >= maxDepth)
            continue;

        try {
            for (const child of actor.get_children())
                queue.push({actor: child, depth: depth + 1});
        } catch {
            // ignore
        }
    }
    return null;
}

/**
 * Decide whether an actor is a popup we handle, and which surface it is.
 *
 * @param {Clutter.Actor} actor a candidate top-level actor
 * @returns {object|null} descriptor
 */
export function classify(actor) {
    if (!isAlive(actor))
        return null;

    const hit = findByClass(actor, PAINT_CLASSES.map(p => p.cls));
    if (!hit)
        return null;

    const entry = PAINT_CLASSES.find(p => p.cls === hit.cls);
    let id = entry.id;
    let key = entry.key;

    // Refine a generic menu by the marker class the shell puts on the
    // BoxPointer itself.
    if (id === 'panel-menus') {
        for (const marker of BOXPOINTER_MARKERS) {
            try {
                if (actor.has_style_class_name?.(marker.cls)) {
                    id = marker.id;
                    key = marker.key;
                    break;
                }
            } catch {
                // ignore
            }
        }
    }

    // Alt-Tab and the input-source switcher share `.switcher-list`; the
    // language switcher's items carry their own class.
    if (id === 'alt-tab' && findByClass(actor, ['input-source-switcher'], 4)) {
        id = 'input-switcher';
        key = 'surface-input-switcher';
    }

    return {
        id,
        settingsKey: key,
        paintActor: hit.actor,
        defaultRadius: entry.radius,
    };
}

/**
 * Per-popup bookkeeping. Holds only signal ids and small objects - never a
 * framebuffer, never an effect.
 */
class TrackedPopup {
    constructor(actor, descriptor) {
        this.actor = actor;
        this.descriptor = descriptor;
        this.signalKeys = [];
        this.transparency = new TransparencyGroup(descriptor.id);
        this.text = new AdaptiveText(descriptor.id);
        this.attached = false;
        this.applyLater = null;
        this.hideLater = null;
        this.verifyTimer = null;
        this.verifyAttempts = 0;
    }
}

export class PopupGlassManager {
    /**
     * @param {object} deps injected collaborators
     */
    constructor({glass, settings, signals, timers, laters}) {
        this._glass = glass;
        this._settings = settings;
        this._signals = signals;
        this._timers = timers;
        this._laters = laters;

        this._tracked = new Map();      // actor -> TrackedPopup
        this._ownerStack = [];          // TrackedPopup[], last is current owner
        this._sampler = new ColorSampler();
        this._textModeMemory = new Map(); // surface id -> 'light' | 'dark'
        this._enabled = false;
    }

    get trackedCount() {
        return this._tracked.size;
    }

    get attachedCount() {
        let n = 0;
        for (const entry of this._tracked.values()) {
            if (entry.attached)
                n += 1;
        }
        return n;
    }

    get currentOwner() {
        return this._ownerStack.length > 0
            ? this._ownerStack[this._ownerStack.length - 1]
            : null;
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;

        // Discovery. uiGroup is where PopupMenu, SwitcherPopup, OsdWindow,
        // WorkspaceSwitcherPopup and the IBus candidate popup all live.
        const uiGroup = Main.layoutManager?.uiGroup;
        if (uiGroup) {
            this._signals.connect(uiGroup, 'child-added',
                (_c, actor) => this._consider(actor), 'popup-discovery');
            this._signals.connect(uiGroup, 'child-removed',
                (_c, actor) => this._forget(actor), 'popup-discovery');

            // Menus created before we were enabled are already children.
            try {
                for (const child of uiGroup.get_children())
                    this._consider(child);
            } catch (e) {
                Log.error(e, 'initial uiGroup scan');
            }
        }

        // Notification banners are parented into the message tray, not uiGroup.
        const bannerBin = Main.messageTray?._bannerBin;
        if (bannerBin) {
            this._signals.connect(bannerBin, 'child-added',
                (_c, actor) => this._consider(actor), 'popup-discovery');
            this._signals.connect(bannerBin, 'child-removed',
                (_c, actor) => this._forget(actor), 'popup-discovery');
        }
    }

    disable() {
        if (!this._enabled)
            return;
        this._enabled = false;

        for (const entry of [...this._tracked.values()])
            this._release(entry, true);

        this._tracked.clear();
        this._ownerStack = [];
        this._sampler.destroy();
        this._textModeMemory.clear();
    }

    /**
     * Consider a newly parented actor as a possible popup.
     *
     * Called for every child added to uiGroup, which is a busy signal, so this
     * stays cheap and bails out fast.
     *
     * @param {Clutter.Actor} actor the candidate
     */
    _consider(actor) {
        if (!this._enabled || !isAlive(actor) || this._tracked.has(actor))
            return;

        // Never track our own glass.
        if (this._glass.actor === actor)
            return;

        const descriptor = classify(actor);
        if (!descriptor)
            return;

        const entry = new TrackedPopup(actor, descriptor);
        this._tracked.set(actor, entry);

        // The universal "is it really on screen" predicate.
        entry.signalKeys.push(this._signals.connect(actor, 'notify::visible',
            () => this._evaluate(entry), 'popup-lifecycle'));
        entry.signalKeys.push(this._signals.connect(actor, 'notify::mapped',
            () => this._evaluate(entry), 'popup-lifecycle'));
        entry.signalKeys.push(this._signals.connect(actor, 'destroy',
            () => this._forget(actor), 'popup-lifecycle'));

        // Keep the glass fading in lockstep with the popup. This is what stops
        // the glass sitting there at full strength for 150ms after a menu has
        // faded away - and it is animation-agnostic, so the 49 rework (scale
        // + EASE_OUT_QUAD + flipped translation) needs no special case.
        entry.signalKeys.push(this._signals.connect(actor, 'notify::opacity',
            () => this._syncOpacity(entry), 'popup-lifecycle'));

        // Menus change size while open - Quick Settings grows when a toggle
        // sub-menu expands, ordinary menus when a submenu unrolls. Track the
        // painting actor's allocation so the glass follows.
        if (isAlive(descriptor.paintActor)) {
            entry.signalKeys.push(this._signals.connect(
                descriptor.paintActor, 'notify::allocation', () => {
                    if (entry.attached && this._isOnScreen(entry))
                        this._refreshGeometry(entry);
                }, 'popup-lifecycle'));
        }

        this._evaluate(entry);
    }

    _forget(actor) {
        const entry = this._tracked.get(actor);
        if (!entry)
            return;
        this._tracked.delete(actor);
        this._release(entry, true);
    }

    /** @param {TrackedPopup} entry the popup to check */
    _isOnScreen(entry) {
        try {
            return isAlive(entry.actor) && entry.actor.visible && entry.actor.mapped;
        } catch {
            return false;
        }
    }

    _evaluate(entry) {
        if (!this._enabled)
            return;

        const wanted = this._isOnScreen(entry) &&
            this._settings.surfaceEnabled(entry.descriptor.settingsKey);

        if (wanted && !entry.attached)
            this._attach(entry);
        else if (!wanted && entry.attached)
            this._release(entry, false);
    }

    /**
     * Give the shared glass to this popup.
     *
     * Architecture rule 4 (opening): show the glass while the popup still has
     * its own opaque background, and only make it transparent one frame later.
     * Doing both in one frame shows a grey rectangle for a frame.
     *
     * @param {TrackedPopup} entry the popup
     */
    _attach(entry) {
        if (!this._glass.isBuilt)
            return;

        // A close that has not finished retiring the glass yet must not pull
        // it out from under this open. Menus reopen well inside one frame when
        // the user clicks from one panel button straight to the next.
        this._laters.cancel(entry.hideLater);
        entry.hideLater = null;

        // Validate BEFORE suspending the current owner: bailing out after the
        // suspend would strip the previous popup's glass and give it back its
        // opaque background for nothing.
        const rect = this._surfaceRect(entry);
        if (!rect)
            return;

        const monitor = monitorForRect(rect);
        if (!monitor)
            return;

        // Only one popup can own the glass. If another has it, take it away -
        // it keeps its place on the stack and gets it back when we go.
        const previous = this.currentOwner;
        if (previous && previous !== entry)
            this._suspend(previous);

        const material = this._settings.material();
        const radius = material.cornerRadiusSetting >= 0
            ? material.cornerRadiusSetting
            : themeCornerRadius(entry.descriptor.paintActor, entry.descriptor.defaultRadius);

        this._glass.setMaterial(material.withCornerRadius(radius));
        if (!this._glass.retarget(monitor, rect, radius))
            return;

        // Sit directly beneath the popup, but always parented into uiGroup.
        //
        // We deliberately do NOT parent into the popup's own parent. uiGroup is
        // a fixed-layout St.Widget, so a child there keeps the absolute
        // position and size we give it - which is what rule 3's
        // monitor-origin/monitor-size model requires. Other containers do not
        // behave that way: the message tray's banner bin, for instance, is
        // sized and centred around the banner, so a glass root placed inside
        // it would be positioned relative to the banner rather than the stage.
        //
        // Z-ordering therefore targets the popup's top-level ancestor within
        // uiGroup. PopupMenu.open() raises itself above all its siblings on
        // every open, so this has to happen after the popup is up - which it
        // does, because we are reacting to it having become visible.
        const uiGroup = Main.layoutManager?.uiGroup;
        if (uiGroup) {
            const sibling = topLevelUnder(entry.actor, uiGroup);
            if (sibling)
                this._glass.placeBelow(uiGroup, sibling);
        }

        this._glass.setVisible(true);
        this._syncOpacity(entry);

        entry.attached = true;
        if (!this._ownerStack.includes(entry))
            this._ownerStack.push(entry);

        // One frame later: clear the popup's own background and adapt its text.
        this._laters.cancel(entry.applyLater);
        entry.applyLater = this._laters.add(() => {
            entry.applyLater = null;
            if (!entry.attached || !this._isOnScreen(entry))
                return;
            this._makeTransparent(entry);
            this._adaptText(entry, rect, monitor, material);
        }, `attach:${entry.descriptor.id}`);

        this._armVerify(entry);
    }

    /**
     * Take the glass away from a popup that is still on screen, because
     * another popup wants it. The popup gets its opaque background back so it
     * stays readable.
     *
     * @param {TrackedPopup} entry the popup losing the glass
     */
    _suspend(entry) {
        entry.transparency.restore();
        entry.text.revert();
        entry.attached = false;
    }

    /**
     * Release the glass.
     *
     * Architecture rule 4 (closing): restore the popup's own background FIRST,
     * and only hide the glass one frame later. The other order flashes grey.
     *
     * @param {TrackedPopup} entry the popup
     * @param {boolean} immediate skip the deferred hide (used on disable)
     */
    _release(entry, immediate) {
        this._laters.cancel(entry.applyLater);
        entry.applyLater = null;
        this._timers.cancel(entry.verifyTimer);
        entry.verifyTimer = null;
        entry.verifyAttempts = 0;

        const wasOwner = this.currentOwner === entry;

        // 1. Background back first.
        entry.transparency.restore();
        entry.text.revert();
        entry.attached = false;

        const idx = this._ownerStack.indexOf(entry);
        if (idx >= 0)
            this._ownerStack.splice(idx, 1);

        this._sampler.invalidate();

        if (!wasOwner) {
            // Someone else owns the glass; leave it where it is.
            if (immediate)
                this._disconnectEntry(entry);
            return;
        }

        const restoreNext = () => {
            // Hand the glass back to whatever is still open underneath, if
            // anything - an OSD popped up over a menu, say.
            const next = this.currentOwner;
            if (next && this._isOnScreen(next)) {
                this._attach(next);
                return true;
            }
            return false;
        };

        if (immediate) {
            if (!restoreNext())
                this._glass.setVisible(false);
            this._disconnectEntry(entry);
            return;
        }

        // 2. Glass down one frame later.
        this._laters.cancel(entry.hideLater);
        entry.hideLater = this._laters.add(() => {
            entry.hideLater = null;

            // Another popup may have claimed the glass in the meantime - it
            // is already positioned and visible, so leave it alone.
            const owner = this.currentOwner;
            if (owner && owner.attached)
                return;

            if (!restoreNext())
                this._glass.setVisible(false);
        }, `release:${entry.descriptor.id}`);
    }

    _disconnectEntry(entry) {
        for (const key of entry.signalKeys)
            this._signals.disconnect(key);
        entry.signalKeys = [];
        this._laters.cancel(entry.hideLater);
        entry.hideLater = null;
    }

    /**
     * A bounded, one-shot safety net.
     *
     * Everything above is driven by signals, and signals can be missed if an
     * actor is reparented or destroyed in an unusual order. This re-checks a
     * few times and then stops - it is a backstop, not a poll, and it can
     * never become a repeating timer because TimerTracker only makes
     * one-shots.
     *
     * @param {TrackedPopup} entry the popup
     */
    _armVerify(entry) {
        this._timers.cancel(entry.verifyTimer);
        entry.verifyAttempts = 0;
        this._scheduleVerify(entry);
    }

    _scheduleVerify(entry) {
        if (entry.verifyAttempts >= 3)
            return;
        entry.verifyAttempts += 1;

        entry.verifyTimer = this._timers.oneShot(700, () => {
            entry.verifyTimer = null;
            if (!this._enabled)
                return;

            if (!this._isOnScreen(entry)) {
                if (entry.attached)
                    this._release(entry, false);
                return;
            }

            if (entry.attached) {
                // Still up: make sure the geometry still matches (a menu can
                // grow when a submenu opens).
                this._refreshGeometry(entry);
                this._scheduleVerify(entry);
            }
        }, `verify:${entry.descriptor.id}`);
    }

    _refreshGeometry(entry) {
        const rect = this._surfaceRect(entry);
        if (!rect)
            return;
        const monitor = monitorForRect(rect);
        if (!monitor)
            return;
        const material = this._settings.material();
        const radius = material.cornerRadiusSetting >= 0
            ? material.cornerRadiusSetting
            : themeCornerRadius(entry.descriptor.paintActor, entry.descriptor.defaultRadius);
        this._glass.retarget(monitor, rect, radius);
    }

    /**
     * The rectangle the glass should cover: the painting actor's box, in
     * absolute stage coordinates.
     *
     * We use the inner painting actor rather than the outer popup, because the
     * outer BoxPointer includes the arrow rise and gap as empty space.
     *
     * @param {TrackedPopup} entry the popup
     * @returns {object|null} {x, y, width, height}
     */
    _surfaceRect(entry) {
        const target = isAlive(entry.descriptor.paintActor)
            ? entry.descriptor.paintActor
            : entry.actor;

        try {
            const [x, y] = target.get_transformed_position();
            const [w, h] = target.get_transformed_size();
            if (!(w > 0) || !(h > 0) || !Number.isFinite(x) || !Number.isFinite(y))
                return null;

            const rect = {x, y, width: w, height: h};

            // Quick Settings only: QuickSettingsLayout.vfunc_get_preferred_height
            // (quickSettings.js:658-674) ALWAYS adds the _overlay's preferred
            // height - space reserved for quick-toggle sub-menus - so the
            // .quick-settings box is permanently taller than its visible
            // content. Glass sized to the box shows as a bare band hanging
            // below the last row. Clamp to the visible content instead.
            if (entry.descriptor.id === 'quick-settings')
                this._clampToVisibleContent(rect, target);

            return rect;
        } catch (e) {
            Log.debug(`surfaceRect: ${e}`);
            return null;
        }
    }

    /**
     * Shrink a rect's height to the bottom of its deepest visible content.
     *
     * Walks a few levels of the paint actor's children and finds the lowest
     * bottom edge among visible, allocated descendants - skipping every
     * Clutter.Clone, because the reserved-space placeholder inside the Quick
     * Settings grid IS a Clone (of the overlay) and is exactly the thing we
     * must not measure. The actor's own top padding is mirrored below the
     * content so the glass keeps a symmetric inset.
     *
     * When a quick-toggle sub-menu opens, its actor becomes a visible
     * non-Clone descendant, the union grows, and the periodic geometry
     * refresh extends the glass over it.
     *
     * @param {object} rect rect to clamp, mutated in place
     * @param {Clutter.Actor} root the paint actor
     */
    _clampToVisibleContent(rect, root) {
        let maxBottom = -Infinity;
        let minTop = Infinity;

        const visit = (actor, depth) => {
            let children = [];
            try {
                children = actor.get_children();
            } catch {
                return;
            }
            for (const child of children) {
                try {
                    if (!child.visible || child instanceof Clutter.Clone)
                        continue;
                    const [, cy] = child.get_transformed_position();
                    const [, ch] = child.get_transformed_size();
                    if (ch > 0 && Number.isFinite(cy)) {
                        minTop = Math.min(minTop, cy);
                        maxBottom = Math.max(maxBottom, cy + ch);
                    }
                    if (depth < 3)
                        visit(child, depth + 1);
                } catch {
                    // skip this child
                }
            }
        };

        Log.guard('clampToVisibleContent', () => visit(root, 0));

        if (!Number.isFinite(maxBottom) || !Number.isFinite(minTop))
            return;

        const topPadding = Math.max(0, minTop - rect.y);
        const clamped = (maxBottom + topPadding) - rect.y;
        if (clamped > 40 && clamped < rect.height)
            rect.height = clamped;
    }

    _syncOpacity(entry) {
        if (!entry.attached || !this._glass.isBuilt)
            return;
        if (this.currentOwner !== entry)
            return;
        try {
            this._glass.actor.opacity = entry.actor.opacity;
        } catch {
            // ignore
        }
    }

    _makeTransparent(entry) {
        const {paintActor} = entry.descriptor;
        if (isAlive(paintActor))
            entry.transparency.add(paintActor);

        // Also neutralise the BoxPointer's cairo bubble where a theme draws
        // one. Paint-only properties only - see transparency.js.
        if (isAlive(entry.actor))
            entry.transparency.addBoxPointer(entry.actor);

        entry.transparency.markApplied();
    }

    /**
     * Measure the backdrop and recolour the popup's text to suit.
     *
     * @param {TrackedPopup} entry the popup
     * @param {object} rect surface rect in stage coordinates
     * @param {object} monitor monitor geometry
     * @param {object} material material parameters
     */
    _adaptText(entry, rect, monitor, material) {
        if (!this._settings.getBoolean('adaptive-text'))
            return;

        const forced = this._settings.getString('text-mode');
        const withShadow = this._settings.getBoolean('text-shadow');

        if (forced === 'light' || forced === 'dark') {
            entry.text.apply(entry.actor, forced, withShadow);
            return;
        }

        const points = ColorSampler.ringPoints(rect, monitor);
        this._sampler.sample(points, samples => {
            if (!entry.attached || !this._isOnScreen(entry))
                return;

            // The raw backdrop luminance also drives the material: the base
            // deepens and the additive light quietens over bright content.
            if (samples && samples.length > 0)
                this._glass.setBackdropLuminance(medianLuminance(samples));

            let mode;
            if (!samples || samples.length === 0) {
                // Sampling unavailable: light text is the safer default,
                // because GNOME's own popup backgrounds are dark by default.
                mode = this._textModeMemory.get(entry.descriptor.id) || 'light';
            } else {
                const luminance = predictedLuminance(samples, material);
                const threshold = this._settings.getDouble('text-threshold') || idealThreshold();
                const hysteresis = this._settings.getDouble('text-hysteresis');
                const previous = this._textModeMemory.get(entry.descriptor.id) || null;
                mode = decideTextMode(luminance, previous, threshold, hysteresis);
            }

            this._textModeMemory.set(entry.descriptor.id, mode);
            entry.text.apply(entry.actor, mode, withShadow);
        });
    }

    /** Re-read settings and re-apply to whatever is currently on screen. */
    refresh() {
        const owner = this.currentOwner;
        for (const entry of [...this._tracked.values()])
            this._evaluate(entry);
        if (owner && owner.attached)
            this._refreshGeometry(owner);
    }

    /** @returns {object} diagnostic snapshot */
    describe() {
        const byId = {};
        for (const entry of this._tracked.values()) {
            const id = entry.descriptor.id;
            byId[id] = byId[id] || {tracked: 0, attached: 0};
            byId[id].tracked += 1;
            if (entry.attached)
                byId[id].attached += 1;
        }
        return {
            tracked: this._tracked.size,
            attached: this.attachedCount,
            ownerStack: this._ownerStack.map(e => e.descriptor.id),
            samplerInFlight: this._sampler.inFlight,
            byId,
        };
    }
}
