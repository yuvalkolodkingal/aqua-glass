// Aqua Glass - coexisting with Blur My Shell and Dash to Dock.
//
// Aqua Glass covers the panel, popups and the dock natively, so Blur My Shell
// is not needed for those. Running both stacks two blurs over the same pixels:
// it looks muddy and costs twice. Rather than silently reaching into another
// extension's settings, we detect the overlap and ASK, then remember exactly
// what we changed so a revert puts it back.
//
// Dash to Dock is a different problem. Its default transparency-mode is
// DYNAMIC, which fades a nearly-opaque background in whenever a window comes
// near the dock - straight over our glass. Pinning it to FIXED with zero alpha
// makes the dock's own background disappear so the glass is what you see.

import Gio from 'gi://Gio';

import * as Log from './logger.js';
import {safeSettings, isExtensionActive, extensionSchemaDir, notify} from './compat.js';

export const BMS_UUID = 'blur-my-shell@aunetx';
export const DTD_UUID = 'dash-to-dock@micxgx.gmail.com';
export const DTP_UUID = 'dash-to-panel@jderose9.github.com';

const BMS_SCHEMA = 'org.gnome.shell.extensions.blur-my-shell';
const DTD_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock';

/**
 * Blur My Shell components that cover the same surfaces we do. Each is a child
 * schema with a `blur` boolean.
 */
const BMS_OVERLAPPING = ['panel', 'popup', 'dash-to-dock', 'dash-to-panel'];

/** Dash to Dock keys we override, with the values we want. */
const DTD_OVERRIDES = {
    // FIXED rather than DYNAMIC: DYNAMIC is what fades an opaque layer over
    // the glass when a window approaches the dock.
    'transparency-mode': {type: 'enum', value: 'FIXED'},
    'customize-alphas': {type: 'boolean', value: true},
    'min-alpha': {type: 'double', value: 0.0},
    'max-alpha': {type: 'double', value: 0.0},
    'background-opacity': {type: 'double', value: 0.0},
};

export class Integrations {
    /**
     * @param {SettingsStore} settings the extension's settings
     * @param {SignalTracker} signals signal tracker
     */
    constructor(settings, signals) {
        this._settings = settings;
        this._signals = signals;
        this._promptShown = false;
    }

    /** @returns {boolean} whether Blur My Shell is installed and running */
    static blurMyShellActive() {
        return isExtensionActive(BMS_UUID);
    }

    /** @returns {boolean} whether Dash to Dock is installed and running */
    static dashToDockActive() {
        return isExtensionActive(DTD_UUID);
    }

    /**
     * Which Blur My Shell components currently overlap us.
     *
     * @returns {string[]} child schema names with blur enabled
     */
    overlappingBmsComponents() {
        const root = safeSettings(BMS_SCHEMA, extensionSchemaDir(BMS_UUID));
        if (!root)
            return [];

        const active = [];
        for (const name of BMS_OVERLAPPING) {
            try {
                const child = root.get_child(name);
                if (child && child.get_boolean('blur'))
                    active.push(name);
            } catch {
                // That component does not exist in this BMS version.
            }
        }
        return active;
    }

    /**
     * Offer to switch off overlapping Blur My Shell components.
     *
     * Deliberately a prompt rather than an automatic change: another
     * extension's configuration is the user's, not ours.
     */
    maybePromptForBlurMyShell() {
        if (!this._settings.getBoolean('manage-blur-my-shell'))
            return;
        if (this._promptShown)
            return;
        if (!Integrations.blurMyShellActive())
            return;

        const components = this.overlappingBmsComponents();
        if (components.length === 0)
            return;

        this._promptShown = true;

        notify({
            title: 'Blur My Shell is also running',
            body: `Aqua Glass already covers ${components.join(', ')}. ` +
                  'Running both stacks two blurs over the same pixels. ' +
                  'Disable the overlapping Blur My Shell components?',
            actions: [
                {
                    label: 'Disable them',
                    callback: () => this.disableBmsComponents(components),
                },
                {
                    label: 'Keep both',
                    callback: () => {
                        this._settings.setBoolean('manage-blur-my-shell', false);
                    },
                },
            ],
        });
    }

    /**
     * Turn off the given Blur My Shell components, remembering their previous
     * values so revert() can restore them.
     *
     * @param {string[]} components child schema names
     */
    disableBmsComponents(components) {
        const root = safeSettings(BMS_SCHEMA, extensionSchemaDir(BMS_UUID));
        if (!root)
            return;

        const backup = this._readBackup('blur-my-shell-backup');

        for (const name of components) {
            try {
                const child = root.get_child(name);
                if (!child)
                    continue;
                if (backup[name] === undefined)
                    backup[name] = child.get_boolean('blur');
                child.set_boolean('blur', false);
            } catch (e) {
                Log.error(e, `disabling BMS component ${name}`);
            }
        }

        this._writeBackup('blur-my-shell-backup', backup);
        Log.info(`disabled Blur My Shell components: ${components.join(', ')}`);
    }

    /**
     * Neutralise Dash to Dock's own background.
     *
     * @returns {boolean} true if anything was changed
     */
    applyDashToDock() {
        if (!this._settings.getBoolean('manage-dash-to-dock'))
            return false;
        if (!Integrations.dashToDockActive())
            return false;

        // DtD ships its compiled schema inside its own extension directory;
        // the default schema source knows nothing about it, and without the
        // directory every one of these writes silently did nothing.
        const dtd = safeSettings(DTD_SCHEMA, extensionSchemaDir(DTD_UUID));
        if (!dtd)
            return false;

        const backup = this._readBackup('dash-to-dock-backup');
        let changed = false;

        for (const [key, spec] of Object.entries(DTD_OVERRIDES)) {
            try {
                if (backup[key] === undefined)
                    backup[key] = this._readKey(dtd, key, spec.type);
                this._writeKey(dtd, key, spec.type, spec.value);
                changed = true;
            } catch (e) {
                Log.debug(`dash-to-dock key ${key}: ${e}`);
            }
        }

        if (changed) {
            this._writeBackup('dash-to-dock-backup', backup);
            Log.info('neutralised Dash to Dock background (transparency-mode=FIXED, alphas 0)');
        }
        return changed;
    }

    /**
     * Put back everything we changed in other extensions.
     *
     * This is what makes the one-command revert honest: uninstalling Aqua
     * Glass must not leave Blur My Shell switched off and the dock invisible.
     */
    revert() {
        this._revertBms();
        this._revertDtd();
    }

    _revertBms() {
        const backup = this._readBackup('blur-my-shell-backup');
        if (Object.keys(backup).length === 0)
            return;

        const root = safeSettings(BMS_SCHEMA, extensionSchemaDir(BMS_UUID));
        if (root) {
            for (const [name, value] of Object.entries(backup)) {
                try {
                    const child = root.get_child(name);
                    if (child)
                        child.set_boolean('blur', !!value);
                } catch (e) {
                    Log.debug(`restoring BMS ${name}: ${e}`);
                }
            }
        }
        this._settings.setString('blur-my-shell-backup', '');
    }

    _revertDtd() {
        const backup = this._readBackup('dash-to-dock-backup');
        if (Object.keys(backup).length === 0)
            return;

        const dtd = safeSettings(DTD_SCHEMA, extensionSchemaDir(DTD_UUID));
        if (dtd) {
            for (const [key, value] of Object.entries(backup)) {
                const spec = DTD_OVERRIDES[key];
                if (!spec)
                    continue;
                try {
                    this._writeKey(dtd, key, spec.type, value);
                } catch (e) {
                    Log.debug(`restoring dash-to-dock ${key}: ${e}`);
                }
            }
        }
        this._settings.setString('dash-to-dock-backup', '');
    }

    _readKey(settings, key, type) {
        switch (type) {
        case 'boolean':
            return settings.get_boolean(key);
        case 'double':
            return settings.get_double(key);
        case 'enum':
            return settings.get_string(key);
        default:
            return settings.get_value(key).unpack();
        }
    }

    _writeKey(settings, key, type, value) {
        switch (type) {
        case 'boolean':
            settings.set_boolean(key, !!value);
            break;
        case 'double':
            settings.set_double(key, Number(value));
            break;
        case 'enum':
            settings.set_string(key, String(value));
            break;
        default:
            break;
        }
    }

    _readBackup(key) {
        const raw = this._settings.getString(key);
        if (!raw)
            return {};
        try {
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch {
            return {};
        }
    }

    _writeBackup(key, value) {
        try {
            this._settings.setString(key, JSON.stringify(value));
        } catch (e) {
            Log.error(e, `writing backup ${key}`);
        }
    }

    /** @returns {object} diagnostic snapshot */
    describe() {
        return {
            blurMyShell: {
                active: Integrations.blurMyShellActive(),
                overlapping: this.overlappingBmsComponents(),
                backed_up: this._readBackup('blur-my-shell-backup'),
            },
            dashToDock: {
                active: Integrations.dashToDockActive(),
                backed_up: this._readBackup('dash-to-dock-backup'),
            },
        };
    }
}

/**
 * A GSettings object for another extension, if its schema is installed.
 *
 * @param {string} schemaId schema id
 * @returns {Gio.Settings|null} settings or null
 */
export function otherExtensionSettings(schemaId) {
    return safeSettings(schemaId);
}
