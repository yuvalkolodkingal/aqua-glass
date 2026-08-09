// Aqua Glass - always-visible surfaces: the top panel and the dock.
//
// Architecture rule 2: "NO repeating timers on permanently-visible surfaces."
// A 250ms screenshot loop on the dock hit 2 GB in 32 seconds.
//
// Two things follow from that rule, and this file honours both:
//
//  * The backdrop is never sampled to produce the *image*. It is a live
//    Clutter.Clone of global.window_group, so window and wallpaper changes
//    arrive for free, on the compositor's own schedule, at zero cost to us.
//    There is nothing to poll.
//
//  * The things we genuinely cannot get from a clone - the surface's geometry,
//    and the backdrop luminance behind it for adaptive text - are recomputed
//    from events (monitors-changed, workspace-switched, restacked, window
//    created, allocation changes), passed through a Throttle with a hard
//    minimum interval. Every timer involved is a one-shot; TimerTracker offers
//    no other kind.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Log from './logger.js';
import {isAlive, monitorForRect, topLevelUnder} from './compat.js';
import {Throttle} from './trackers.js';
import {TransparencyGroup, themeCornerRadius} from './transparency.js';
import {AdaptiveText} from './adaptiveText.js';
import {ColorSampler, predictedLuminance} from './sampler.js';
import {decideTextMode, idealThreshold, medianLuminance} from './color.js';

/**
 * One always-visible glass surface.
 */
export class PersistentGlassSurface {
    /**
     * @param {object} config configuration
     * @param {string} config.name diagnostic name
     * @param {GlassSurface} config.glass its own glass instance
     * @param {SettingsStore} config.settings settings
     * @param {SignalTracker} config.signals signal tracker
     * @param {TimerTracker} config.timers timer tracker
     * @param {LaterTracker} config.laters later tracker, for frame ordering
     * @param {Function} config.findTarget returns {actor, paintActor} or null
     * @param {string} config.settingsKey the enable key
     * @param {object} [config.options] per-surface tweaks
     */
    constructor({name, glass, settings, signals, timers, laters, findTarget, settingsKey, options = {}}) {
        this._name = name;
        this._glass = glass;
        this._settings = settings;
        this._signals = signals;
        this._timers = timers;
        this._laters = laters;
        this._findTarget = findTarget;
        this._settingsKey = settingsKey;
        this._options = options;
        this._clearLater = null;

        this._target = null;
        this._paintActor = null;
        this._transparency = new TransparencyGroup(name);
        this._text = new AdaptiveText(name);
        this._sampler = new ColorSampler();
        this._textMode = null;
        this._targetSignals = [];
        this._enabled = false;
        this._active = false;

        const minInterval = Math.max(100, this._settings.getInt('min-refresh-interval'));
        this._geometryThrottle = new Throttle(timers, minInterval,
            () => this._applyGeometry(), `${name}-geometry`);
        // Text is re-measured far less often than geometry: it costs a
        // handful of pixel reads and the answer rarely changes.
        this._textThrottle = new Throttle(timers, Math.max(minInterval * 3, 1000),
            () => this._applyText(), `${name}-text`);
    }

    get name() {
        return this._name;
    }

    get isActive() {
        return this._active;
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;
        this._attachIfPossible();
    }

    disable() {
        this._enabled = false;
        this._geometryThrottle.cancel();
        this._textThrottle.cancel();
        this._detach(true);
        this._sampler.destroy();
    }

    /** Re-evaluate whether we should be showing at all. */
    refresh() {
        if (!this._enabled)
            return;
        if (!this._settings.surfaceEnabled(this._settingsKey)) {
            this._detach();
            return;
        }
        if (!this._active)
            this._attachIfPossible();
        else
            this._geometryThrottle.trigger();
        this._textThrottle.trigger();
    }

    /** Re-scan for the target actor (e.g. after another extension loaded). */
    rescan() {
        if (!this._enabled)
            return;
        if (this._active) {
            const found = this._findTarget();
            if (found && found.actor === this._target)
                return;
            this._detach();
        }
        this._attachIfPossible();
    }

    _attachIfPossible() {
        if (!this._enabled || this._active)
            return;
        if (!this._settings.surfaceEnabled(this._settingsKey))
            return;
        if (!this._glass.isBuilt)
            return;

        const found = Log.guard(`${this._name} findTarget`, () => this._findTarget(), null);
        if (!found || !isAlive(found.actor))
            return;

        this._target = found.actor;
        this._paintActor = found.paintActor || found.actor;
        this._active = true;

        // Geometry follows the target. allocation-changed is the authoritative
        // signal; visibility mirrors things like a fullscreen window hiding
        // the panel.
        this._targetSignals.push(this._signals.connect(this._target, 'notify::allocation',
            () => this._geometryThrottle.trigger(), `${this._name}-target`));
        this._targetSignals.push(this._signals.connect(this._target, 'notify::visible',
            () => this._onVisibilityChanged(), `${this._name}-target`));
        this._targetSignals.push(this._signals.connect(this._target, 'notify::mapped',
            () => this._onVisibilityChanged(), `${this._name}-target`));
        this._targetSignals.push(this._signals.connect(this._target, 'destroy',
            () => this._onTargetDestroyed(), `${this._name}-target`));

        this._applyGeometry();

        // Rule 4 ordering applies here too, even though the surface is
        // permanent. _applyGeometry() has only just given the glass its
        // position and size; that allocation does not exist until the next
        // layout pass. Clearing the panel's real background in this same turn
        // would paint one frame with neither the panel background nor a laid
        // out glass behind it - the desktop showing straight through the
        // panel. So: glass first, real background cleared a frame later.
        this._laters.cancel(this._clearLater);
        this._clearLater = this._laters.add(() => {
            this._clearLater = null;
            if (!this._active || !isAlive(this._paintActor))
                return;
            this._transparency.add(this._paintActor, this._options.extraStyle || '');
            this._transparency.markApplied();
            this._applyText();
        }, `${this._name}-clear`);
    }

    _onVisibilityChanged() {
        if (!this._active)
            return;
        const visible = this._isTargetVisible();
        this._glass.setVisible(visible && this._shouldShow());
        if (visible)
            this._geometryThrottle.trigger();
    }

    _onTargetDestroyed() {
        // The dock in particular is recreated on monitor and settings changes.
        this._detach();
        if (this._enabled) {
            this._timers.oneShot(250, () => this._attachIfPossible(),
                `${this._name}-reattach`);
        }
    }

    _isTargetVisible() {
        try {
            return isAlive(this._target) && this._target.visible && this._target.mapped;
        } catch {
            return false;
        }
    }

    _shouldShow() {
        if (this._options.hideInOverview && this._settings.getBoolean('hide-in-overview')) {
            try {
                if (Main.overview?.visible)
                    return false;
            } catch {
                // ignore
            }
        }
        return true;
    }

    _rect() {
        if (!isAlive(this._target))
            return null;
        try {
            const [x, y] = this._target.get_transformed_position();
            const [w, h] = this._target.get_transformed_size();
            if (!(w > 0) || !(h > 0) || !Number.isFinite(x) || !Number.isFinite(y))
                return null;
            return {x, y, width: w, height: h};
        } catch {
            return null;
        }
    }

    _applyGeometry() {
        if (!this._active || !this._glass.isBuilt)
            return;

        const rect = this._rect();
        if (!rect) {
            this._glass.setVisible(false);
            return;
        }

        const monitor = monitorForRect(rect);
        if (!monitor) {
            this._glass.setVisible(false);
            return;
        }

        let material = this._settings.material();
        if (this._options.noShadow)
            material = material.withoutShadow();

        const radius = material.cornerRadiusSetting >= 0
            ? material.cornerRadiusSetting
            : (this._options.cornerRadius !== undefined
                ? this._options.cornerRadius
                : themeCornerRadius(this._paintActor, 0));

        this._glass.setMaterial(material.withCornerRadius(radius));
        if (!this._glass.retarget(monitor, rect, radius))
            return;

        // Sit directly below the surface's top-level chrome actor. uiGroup is
        // a fixed-layout St.Widget, so a child there keeps the position and
        // size we give it - which a St.BoxLayout parent such as panelBox would
        // not.
        const uiGroup = Main.layoutManager?.uiGroup;
        if (uiGroup) {
            const sibling = topLevelUnder(this._target, uiGroup);
            if (sibling)
                this._glass.placeBelow(uiGroup, sibling);
        }

        this._glass.setVisible(this._isTargetVisible() && this._shouldShow());
    }

    _applyText() {
        if (!this._active)
            return;
        if (!this._settings.getBoolean('adaptive-text')) {
            this._text.revert();
            return;
        }

        const withShadow = this._settings.getBoolean('text-shadow');
        const forced = this._settings.getString('text-mode');
        if (forced === 'light' || forced === 'dark') {
            this._text.apply(this._target, forced, withShadow);
            return;
        }

        const rect = this._rect();
        if (!rect)
            return;
        const monitor = monitorForRect(rect);
        if (!monitor)
            return;

        const material = this._settings.material();
        const points = ColorSampler.ringPoints(rect, monitor);

        this._sampler.sample(points, samples => {
            if (!this._active)
                return;

            // Feed the material too - see popupSurfaces for the reasoning.
            if (samples && samples.length > 0)
                this._glass.setBackdropLuminance(medianLuminance(samples));

            let mode;
            if (!samples || samples.length === 0) {
                mode = this._textMode || 'light';
            } else {
                const luminance = predictedLuminance(samples, material);
                const threshold = this._settings.getDouble('text-threshold') || idealThreshold();
                const hysteresis = this._settings.getDouble('text-hysteresis');
                mode = decideTextMode(luminance, this._textMode, threshold, hysteresis);
            }
            if (mode === this._text.mode)
                return;
            this._textMode = mode;
            this._text.apply(this._target, mode, withShadow);
        });
    }

    /** Called from the shared event router when the backdrop may have changed. */
    onBackdropChanged() {
        if (!this._active)
            return;
        this._textThrottle.trigger();
    }

    /** Called when the overview opens or closes. */
    onOverviewChanged() {
        if (!this._active)
            return;
        this._glass.setVisible(this._isTargetVisible() && this._shouldShow());
    }

    /**
     * @param {boolean} [immediate] hide the glass now rather than next frame
     */
    _detach(immediate = false) {
        for (const key of this._targetSignals)
            this._signals.disconnect(key);
        this._targetSignals = [];

        this._laters.cancel(this._clearLater);
        this._clearLater = null;

        // Rule 4 (closing): the real background goes back FIRST...
        this._transparency.restore();
        this._text.revert();
        this._sampler.invalidate();

        this._target = null;
        this._paintActor = null;
        this._active = false;

        // ...and the glass comes down a frame later, so there is never a frame
        // showing neither. On disable() we cannot defer - the trackers are
        // about to be drained - but there the actor is destroyed outright, so
        // there is no intermediate state to see.
        if (!this._glass.isBuilt)
            return;

        if (immediate) {
            this._glass.setVisible(false);
            return;
        }

        this._laters.add(() => {
            if (!this._active && this._glass.isBuilt)
                this._glass.setVisible(false);
        }, `${this._name}-hide`);
    }

    /** @returns {object} diagnostic snapshot */
    describe() {
        return {
            name: this._name,
            active: this._active,
            textMode: this._text.mode,
            recoloured: this._text.count,
            glass: this._glass.describe(),
        };
    }
}

/**
 * Locate the top panel.
 *
 * @returns {object|null} target descriptor
 */
export function findPanel() {
    const panel = Main.panel;
    if (!isAlive(panel))
        return null;
    // The panel paints its own `#panel` background - there is no inner content
    // box to clear, unlike a menu.
    return {actor: panel, paintActor: panel};
}

/**
 * Locate a Dash to Dock (or Dash to Panel) dock actor.
 *
 * Both extensions add their chrome to uiGroup via layoutManager.addChrome, so
 * we look for the known container names and style classes among uiGroup's
 * children rather than reaching into another extension's internals.
 *
 * @returns {object|null} target descriptor
 */
export function findDock() {
    const uiGroup = Main.layoutManager?.uiGroup;
    if (!uiGroup)
        return null;

    const NAMES = ['dashtodockContainer', 'dashtopanelContainer'];
    const CLASSES = ['dashtodock', 'dash-to-dock'];

    let children = [];
    try {
        children = uiGroup.get_children();
    } catch {
        return null;
    }

    for (const child of children) {
        if (!isAlive(child))
            continue;
        try {
            const name = child.get_name?.();
            if (name && NAMES.includes(name))
                return {actor: child, paintActor: findDashBackground(child) || child};

            for (const cls of CLASSES) {
                if (child.has_style_class_name?.(cls))
                    return {actor: child, paintActor: findDashBackground(child) || child};
            }
        } catch {
            // ignore
        }
    }
    return null;
}

/**
 * Inside a dock container, find the actor that paints the dock background.
 *
 * @param {Clutter.Actor} root the dock container
 * @returns {Clutter.Actor|null} the painting actor
 */
function findDashBackground(root) {
    const queue = [{actor: root, depth: 0}];
    let guard = 0;
    while (queue.length > 0 && guard < 200) {
        guard += 1;
        const {actor, depth} = queue.shift();
        try {
            if (actor.has_style_class_name?.('dash-background'))
                return actor;
            if (actor.get_name?.() === 'dash')
                return actor;
        } catch {
            // ignore
        }
        if (depth >= 6)
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
