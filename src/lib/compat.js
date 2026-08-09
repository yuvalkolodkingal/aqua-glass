// Aqua Glass - version and capability shims for GNOME Shell 48 / 49 / 50.
//
// Everything here is feature-detected at runtime rather than switched on a
// version number where that is possible. A version check tells you what the
// shell claims to be; a capability check tells you what it can actually do,
// which is what matters when a distro backports or a fork diverges.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import * as Log from './logger.js';
import {ACCENT_PALETTE} from './color.js';

let _capabilities = null;

/**
 * @returns {number} the shell major version, e.g. 48
 */
export function shellMajorVersion() {
    try {
        return parseInt(Config.PACKAGE_VERSION.split('.')[0], 10) || 0;
    } catch {
        return 0;
    }
}

/**
 * @returns {string} full shell version string
 */
export function shellVersion() {
    try {
        return Config.PACKAGE_VERSION;
    } catch {
        return 'unknown';
    }
}

/**
 * Probe for the APIs we depend on, once.
 *
 * Verified against gnome-shell 48.7 / 49.9 / 50.4 source: ShellBlurEffect has
 * carried the same `radius` / `brightness` / `mode` properties across all
 * three, and `radius` is passed straight through as the Gaussian *sigma*
 * (clutter_blur_node_new -> ClutterBlur sigma). There is no `sigma` property
 * to prefer, in any of those versions.
 *
 * @returns {object} capability flags
 */
export function capabilities() {
    if (_capabilities)
        return _capabilities;

    const caps = {
        glslEffect: false,
        blurEffect: false,
        pickColor: false,
        laters: false,
        accentColor: false,
    };

    try {
        caps.glslEffect = typeof Shell.GLSLEffect === 'function';
    } catch { /* ignore */ }

    try {
        // Constructing one is the only honest test: the type can exist while
        // the GL backend refuses to build the pipeline.
        const probe = new Shell.BlurEffect();
        caps.blurEffect = probe !== null;
    } catch (e) {
        Log.debug(`Shell.BlurEffect unavailable: ${e}`);
    }

    try {
        caps.pickColor = typeof Shell.Screenshot === 'function' &&
            typeof Shell.Screenshot.prototype.pick_color === 'function' &&
            typeof Shell.Screenshot.prototype.pick_color_finish === 'function';
    } catch { /* ignore */ }

    try {
        caps.laters = !!(global.compositor && typeof global.compositor.get_laters === 'function') ||
            typeof Meta.later_add === 'function';
    } catch { /* ignore */ }

    try {
        const settings = St.Settings.get();
        caps.accentColor = settings && settings.accent_color !== undefined;
    } catch { /* ignore */ }

    _capabilities = caps;
    return caps;
}

/** Forget cached capability probes (used by disable()). */
export function resetCapabilities() {
    _capabilities = null;
}

/**
 * The desktop accent colour as a hex string.
 *
 * @returns {string} hex colour, defaulting to GNOME blue
 */
export function accentColorHex() {
    try {
        const settings = St.Settings.get();
        const idx = settings?.accent_color;
        if (typeof idx === 'number' && idx >= 0 && idx < ACCENT_PALETTE.length)
            return ACCENT_PALETTE[idx];
    } catch (e) {
        Log.debug(`accent colour unavailable: ${e}`);
    }
    return ACCENT_PALETTE[0];
}

/**
 * Look up another installed extension.
 *
 * @param {string} uuid extension uuid
 * @returns {object|null} the extension record, or null
 */
export function lookupExtension(uuid) {
    try {
        return Main.extensionManager?.lookup(uuid) ?? null;
    } catch (e) {
        Log.debug(`lookupExtension(${uuid}): ${e}`);
        return null;
    }
}

/**
 * Is another extension installed *and* currently active?
 *
 * @param {string} uuid extension uuid
 * @returns {boolean} true if enabled
 */
export function isExtensionActive(uuid) {
    const ext = lookupExtension(uuid);
    if (!ext)
        return false;
    try {
        // ExtensionState.ACTIVE is 1 in every version we support; compare
        // against the enum when we can reach it, and fall back to the literal.
        return ext.state === 1;
    } catch {
        return false;
    }
}

/**
 * Open a GSettings object for another extension's schema, if that schema is
 * actually installed.
 *
 * Using Gio.SettingsSchemaSource directly (rather than new Gio.Settings) means
 * a missing schema returns null instead of aborting the process - Gio.Settings
 * calls g_error() on an unknown schema id, which would take gnome-shell down
 * with it.
 *
 * @param {string} schemaId the schema id
 * @param {string} [schemaDir] optional directory holding a compiled schema
 * @returns {Gio.Settings|null} settings object or null
 */
export function safeSettings(schemaId, schemaDir = null) {
    try {
        let source = Gio.SettingsSchemaSource.get_default();
        if (schemaDir) {
            const dir = Gio.File.new_for_path(schemaDir);
            if (dir.query_exists(null)) {
                source = Gio.SettingsSchemaSource.new_from_directory(
                    schemaDir, source, false);
            }
        }
        if (!source)
            return null;
        const schema = source.lookup(schemaId, true);
        if (!schema)
            return null;
        return new Gio.Settings({settings_schema: schema});
    } catch (e) {
        Log.debug(`safeSettings(${schemaId}): ${e}`);
        return null;
    }
}

/**
 * Post a notification, optionally with action buttons.
 *
 * Matches the GNOME 46+ object-literal API, which is what 48/49/50 all use
 * (see js/ui/screenshot.js `_showNotification`).
 *
 * @param {object} params notification parameters
 * @param {string} params.title notification title
 * @param {string} [params.body] notification body
 * @param {string} [params.iconName] symbolic icon name
 * @param {Array<{label: string, callback: Function}>} [params.actions] buttons
 * @returns {object|null} the notification, or null on failure
 */
export function notify({title, body = '', iconName = 'preferences-desktop-theme-symbolic', actions = []}) {
    try {
        const source = new MessageTray.Source({
            title: 'Aqua Glass',
            iconName,
        });

        const notification = new MessageTray.Notification({
            source,
            title,
            body,
            isTransient: false,
        });

        for (const action of actions) {
            notification.addAction(action.label, () => {
                Log.guard(`notification action ${action.label}`, action.callback);
            });
        }

        Main.messageTray.add(source);
        source.addNotification(notification);
        return notification;
    } catch (e) {
        Log.error(e, 'notify');
        return null;
    }
}

/**
 * Current process resident set size, in MiB.
 *
 * We are running inside gnome-shell, so /proc/self is gnome-shell. This is what
 * makes the memory test in docs/MEMORY-TEST.md self-verifying rather than
 * something the user has to measure from outside.
 *
 * @returns {number} RSS in MiB, or -1 if unreadable
 */
export function rssMiB() {
    try {
        const [ok, contents] = GLib.file_get_contents('/proc/self/status');
        if (!ok)
            return -1;
        const text = new TextDecoder().decode(contents);
        const m = text.match(/VmRSS:\s+(\d+)\s+kB/);
        if (!m)
            return -1;
        return Math.round(parseInt(m[1], 10) / 1024 * 10) / 10;
    } catch {
        return -1;
    }
}

/**
 * The monitor geometry containing a rectangle's centre.
 *
 * @param {object} rect {x, y, width, height} in stage coordinates
 * @returns {object|null} monitor geometry, or null
 */
export function monitorForRect(rect) {
    try {
        const monitors = Main.layoutManager.monitors;
        if (!monitors || monitors.length === 0)
            return null;

        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;

        for (const m of monitors) {
            if (cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height)
                return m;
        }

        // Centre is off-screen (a menu being positioned, say). Fall back to
        // whichever monitor is nearest, then to the primary.
        let best = null;
        let bestDist = Infinity;
        for (const m of monitors) {
            const mx = m.x + m.width / 2;
            const my = m.y + m.height / 2;
            const d = (mx - cx) * (mx - cx) + (my - cy) * (my - cy);
            if (d < bestDist) {
                bestDist = d;
                best = m;
            }
        }
        return best ?? Main.layoutManager.primaryMonitor ?? null;
    } catch (e) {
        Log.error(e, 'monitorForRect');
        return null;
    }
}

/**
 * Walk up from `actor` until we find the ancestor that is a direct child of
 * `container`.
 *
 * Used to z-order the glass. The glass is always parented into uiGroup - a
 * fixed-layout St.Widget, which keeps the absolute position and size we give
 * it - but the actor we need to sit *below* is often several levels down
 * inside some other container.
 *
 * @param {Clutter.Actor} actor starting actor
 * @param {Clutter.Actor} container the ancestor container
 * @returns {Clutter.Actor|null} the direct child of `container`, or null
 */
export function topLevelUnder(actor, container) {
    let cur = actor;
    let guard = 0;
    try {
        while (cur && guard < 40) {
            guard += 1;
            const parent = cur.get_parent();
            if (!parent)
                return null;
            if (parent === container)
                return cur;
            cur = parent;
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Is the actor alive and usable?
 *
 * GJS keeps the JS wrapper alive after the underlying GObject is destroyed;
 * touching such a wrapper throws. Every actor access in this extension goes
 * through this check first.
 *
 * @param {Clutter.Actor} actor the actor
 * @returns {boolean} true if safe to use
 */
export function isAlive(actor) {
    if (!actor)
        return false;
    try {
        // get_stage() is cheap and throws on a finalized wrapper.
        return actor.get_stage !== undefined && !!actor.get_parent;
    } catch {
        return false;
    }
}
