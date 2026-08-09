// Aqua Glass - typed access to GSettings.

import * as Log from './logger.js';
import {parse} from './color.js';
import {lightVector} from './shader.js';

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
        const tint = parse(settings.get_string('tint-color')) || {r: 1, g: 1, b: 1};

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
