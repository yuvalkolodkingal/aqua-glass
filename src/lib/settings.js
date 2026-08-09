// Aqua Glass - typed access to GSettings.

import * as Log from './logger.js';
import {parse} from './color.js';
import {lightVector} from './shader.js';
import {prefersDark, highContrast} from './compat.js';

/**
 * The automatic tints, chosen to sit where Apple's dark/light glass sits:
 * dark-mode glass is a deep neutral (not black - black kills the backdrop),
 * light-mode glass is white.
 */
export const AUTO_TINT_DARK = {r: 0.10, g: 0.10, b: 0.12};
// Not pure white: full white at these opacities is the milky-frost defect
// waiting for anyone who selects prefer-light. Apple's light glass is a
// slightly warm off-white.
export const AUTO_TINT_LIGHT = {r: 0.961, g: 0.961, b: 0.968};

/** Keys that change the material and so require a repaint of every surface. */
export const MATERIAL_KEYS = [
    'blur-sigma', 'tint-color', 'tint-strength', 'saturation', 'brightness',
    'ior', 'refraction-strength', 'bevel-width', 'corner-radius',
    'specular-enabled', 'specular-intensity', 'specular-shininess',
    'chromatic-aberration', 'sheen-intensity', 'fresnel-intensity',
    'shadow-enabled', 'shadow-opacity', 'shadow-radius', 'shadow-offset',
    'light-angle', 'native-blur', 'base-opacity', 'refraction-3d',
];

/** Keys that turn individual surfaces on and off. */
export const SURFACE_KEYS = [
    'surface-panel', 'surface-panel-menus', 'surface-date-menu',
    'surface-quick-settings', 'surface-notifications', 'surface-osd',
    'surface-dash-to-dock', 'surface-context-menus', 'surface-window-menus',
    'surface-input-switcher', 'surface-alt-tab', 'surface-ibus-candidate',
    'surface-workspace-switcher',
];

/** Keys that affect adaptive text. */
export const TEXT_KEYS = [
    'adaptive-text', 'text-mode', 'text-threshold', 'text-hysteresis',
    'text-shadow', 'fix-accent-contrast',
];

/**
 * A snapshot of every material parameter, in the form the shader wants.
 */
export class MaterialParams {
    constructor(settings) {
        // 'auto' (the default) follows the desktop colour scheme, which is
        // what Apple's material does: dark translucent glass in dark mode,
        // white frost in light mode. A milky white surface on a dark desktop
        // is the single thing that most says "not macOS".
        this.isDark = prefersDark();
        const tintSetting = settings.get_string('tint-color').trim().toLowerCase();
        const tint = tintSetting === 'auto' || tintSetting === ''
            ? (this.isDark ? AUTO_TINT_DARK : AUTO_TINT_LIGHT)
            : (parse(tintSetting) || (this.isDark ? AUTO_TINT_DARK : AUTO_TINT_LIGHT));

        this.blurSigma = settings.get_int('blur-sigma');
        this.tint = [tint.r, tint.g, tint.b, settings.get_double('tint-strength')];
        this.saturation = settings.get_double('saturation');
        this.brightness = settings.get_double('brightness');
        this.ior = settings.get_double('ior');
        this.refraction = settings.get_double('refraction-strength');
        this.bevelWidth = settings.get_int('bevel-width');

        // -1 means "read the radius from the surface's own theme node", which
        // the surface adapters resolve. Anything else is an explicit override.
        this.cornerRadiusSetting = settings.get_int('corner-radius');
        this.cornerRadius = this.cornerRadiusSetting >= 0 ? this.cornerRadiusSetting : 18;

        this.specularEnabled = settings.get_boolean('specular-enabled');
        this.specular = settings.get_double('specular-intensity');
        this.shininess = settings.get_double('specular-shininess');
        this.chromatic = settings.get_double('chromatic-aberration');
        this.sheen = settings.get_double('sheen-intensity');
        this.fresnel = settings.get_double('fresnel-intensity');

        this.shadowEnabled = settings.get_boolean('shadow-enabled');
        this.shadowOpacity = settings.get_double('shadow-opacity');
        this.shadowRadius = settings.get_int('shadow-radius');
        this.shadowOffset = settings.get_int('shadow-offset');

        this.lightAngle = settings.get_int('light-angle');
        // One light direction feeds specular, rim and shadow, so the material
        // cannot disagree with itself about where the light is.
        this.lightVec = lightVector(this.lightAngle);

        this.nativeBlur = settings.get_boolean('native-blur');
        this.baseOpacity = settings.get_double('base-opacity');
        this.refraction3d = settings.get_boolean('refraction-3d');

        // Accessibility overrides everything aesthetic. When the desktop asks
        // for high contrast, the glass becomes a near-opaque plain surface
        // with no blur and no decorative light - which is exactly Apple's own
        // reduce-transparency fallback for this material.
        this.highContrast = highContrast();
        if (this.highContrast) {
            this.tint = [0.114, 0.114, 0.122, this.tint[3]];
            this.baseOpacity = 0.95;
            this.blurSigma = 0;
            this.sheen = 0;
            this.fresnel = 0;
            this.specularEnabled = false;
            this.refraction3d = false;
        }
    }

    /**
     * A copy with an overridden corner radius, used when a surface supplies
     * its own radius from the theme.
     *
     * @param {number} radius corner radius in pixels
     * @returns {MaterialParams} a shallow clone
     */
    withCornerRadius(radius) {
        const clone = Object.create(MaterialParams.prototype);
        Object.assign(clone, this);
        clone.cornerRadius = radius;
        return clone;
    }

    /**
     * A copy with the shadow suppressed, for surfaces flush against a screen
     * edge (the panel) where a drop shadow would just be a dark band.
     *
     * @returns {MaterialParams} a shallow clone
     */
    withoutShadow() {
        const clone = Object.create(MaterialParams.prototype);
        Object.assign(clone, this);
        clone.shadowEnabled = false;
        clone.shadowOpacity = 0;
        return clone;
    }
}

/**
 * Thin wrapper giving named access to the extension's settings.
 */
export class SettingsStore {
    /**
     * @param {Gio.Settings} settings the extension's settings object
     * @param {SignalTracker} signals tracker for the change handler
     */
    constructor(settings, signals) {
        this._settings = settings;
        this._signals = signals;
        this._listeners = new Set();

        this._signalKey = this._signals.connect(settings, 'changed', (_s, key) => {
            for (const fn of [...this._listeners])
                Log.guard(`settings listener (${key})`, () => fn(key));
        }, 'settings');
    }

    get raw() {
        return this._settings;
    }

    /**
     * @param {Function} fn called with the changed key
     * @returns {Function} an unsubscribe function
     */
    onChanged(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    /** @returns {MaterialParams} a fresh material snapshot */
    material() {
        return new MaterialParams(this._settings);
    }

    /**
     * @param {string} key surface key, e.g. 'surface-panel'
     * @returns {boolean} whether that surface is enabled
     */
    surfaceEnabled(key) {
        try {
            return this._settings.get_boolean(key);
        } catch {
            return false;
        }
    }

    getBoolean(key) {
        try {
            return this._settings.get_boolean(key);
        } catch {
            return false;
        }
    }

    getInt(key) {
        try {
            return this._settings.get_int(key);
        } catch {
            return 0;
        }
    }

    getDouble(key) {
        try {
            return this._settings.get_double(key);
        } catch {
            return 0;
        }
    }

    getString(key) {
        try {
            return this._settings.get_string(key);
        } catch {
            return '';
        }
    }

    setString(key, value) {
        try {
            this._settings.set_string(key, value);
        } catch (e) {
            Log.error(e, `setString(${key})`);
        }
    }

    setBoolean(key, value) {
        try {
            this._settings.set_boolean(key, value);
        } catch (e) {
            Log.error(e, `setBoolean(${key})`);
        }
    }

    destroy() {
        this._listeners.clear();
        this._signals.disconnect(this._signalKey);
        this._signalKey = null;
        this._settings = null;
    }
}
