// Aqua Glass - an Apple-style Liquid Glass material for GNOME Shell 48+.
//
// This file owns the lifecycle. Everything it creates is registered with a
// tracker, and disable() drains every tracker unconditionally - because this
// code runs inside gnome-shell, and on Wayland a crash or a wedged actor logs
// the user out instantly.
//
// The five things disable() must guarantee, in order:
//   1. no timers or laters left pending
//   2. no signal handlers left on process-lifetime objects
//      (display, workspace manager, layout manager, overview, St.Settings)
//   3. every surface's real background restored
//   4. every effect and actor destroyed, and the counters showing it
//   5. nothing left on globalThis

import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Log from './lib/logger.js';
import {SignalTracker, TimerTracker, LaterTracker} from './lib/trackers.js';
import {SettingsStore, MATERIAL_KEYS, SURFACE_KEYS, TEXT_KEYS} from './lib/settings.js';
import {GlassSurface} from './lib/glassSurface.js';
import {resetStats} from './lib/glassEffect.js';
import {PopupGlassManager} from './lib/popupSurfaces.js';
import {PersistentGlassSurface, findPanel, findDock} from './lib/persistentSurfaces.js';
import {Integrations} from './lib/integrations.js';
import {AccentFix} from './lib/accentFix.js';
import {SelfCheck} from './lib/selfcheck.js';
import {capabilities, resetCapabilities} from './lib/compat.js';

export default class AquaGlassExtension extends Extension {
    enable() {
        // Nothing below may throw out of enable(): a half-built extension that
        // cannot be disabled is worse than one that never started.
        Log.guard('enable', () => this._enable());
    }

    disable() {
        Log.guard('disable', () => this._disable());
    }

    _enable() {
        this._signals = new SignalTracker('aqua-glass');
        this._timers = new TimerTracker('aqua-glass');
        this._laters = new LaterTracker();

        resetCapabilities();
        resetStats();

        this._settings = new SettingsStore(this.getSettings(), this._signals);
        Log.setDebugEnabled(this._settings.getBoolean('debug-logging'));

        const caps = capabilities();
        if (!caps.glslEffect) {
            Log.warn('Shell.GLSLEffect is unavailable; Aqua Glass cannot render. ' +
                     'The extension will stay loaded but inert.');
            return;
        }
        if (!caps.blurEffect)
            Log.warn('Shell.BlurEffect unavailable; falling back to in-shader blur.');
        if (!caps.pickColor)
            Log.warn('Shell.Screenshot.pick_color unavailable; adaptive text will use its default.');

        // ---- the one shared glass for every transient popup (rule 1) -------
        this._sharedGlass = new GlassSurface('shared-popup');
        this._sharedGlass.build();
        this._sharedGlass.setMaterial(this._settings.material());

        this._popupManager = new PopupGlassManager({
            glass: this._sharedGlass,
            settings: this._settings,
            signals: this._signals,
            timers: this._timers,
            laters: this._laters,
        });
        this._popupManager.enable();

        // ---- always-visible surfaces, one glass each -----------------------
        this._panelGlass = new GlassSurface('panel');
        this._panelGlass.build();

        this._dockGlass = new GlassSurface('dock');
        this._dockGlass.build();

        this._persistent = [
            new PersistentGlassSurface({
                name: 'panel',
                glass: this._panelGlass,
                settings: this._settings,
                signals: this._signals,
                timers: this._timers,
                laters: this._laters,
                findTarget: findPanel,
                settingsKey: 'surface-panel',
                options: {
                    hideInOverview: true,
                    cornerRadius: 0,
                    // The panel is flush with the top edge, so it needs the
                    // shadow only on the side facing content.
                    noShadow: false,
                },
            }),
            new PersistentGlassSurface({
                name: 'dock',
                glass: this._dockGlass,
                settings: this._settings,
                signals: this._signals,
                timers: this._timers,
                laters: this._laters,
                findTarget: findDock,
                settingsKey: 'surface-dash-to-dock',
                options: {hideInOverview: false, cornerRadius: 20},
            }),
        ];

        for (const surface of this._persistent)
            surface.enable();

        // ---- other extensions ----------------------------------------------
        this._integrations = new Integrations(this._settings, this._signals);
        this._integrations.applyDashToDock();
        // Ask about Blur My Shell once the shell has settled, so the
        // notification does not race the login animation.
        this._timers.oneShot(4000,
            () => this._integrations.maybePromptForBlurMyShell(), 'bms-prompt');

        // ---- accent contrast ------------------------------------------------
        this._accentFix = new AccentFix();
        if (this._settings.getBoolean('fix-accent-contrast'))
            this._accentFix.apply(this._cacheDir());

        // ---- diagnostics -----------------------------------------------------
        this._selfCheck = new SelfCheck({
            sharedGlass: this._sharedGlass,
            popupManager: this._popupManager,
            persistent: this._persistent,
            signals: this._signals,
            timers: this._timers,
            laters: this._laters,
            integrations: this._integrations,
            accentFix: this._accentFix,
        });
        this._selfCheck.exportDBus();
        globalThis.aquaGlass = {
            selfCheck: () => this._selfCheck.format(),
            report: () => this._selfCheck.collect(),
        };

        this._connectGlobalEvents();
        this._watchSettings();

        // Dock discovery has to wait for Dash to Dock to build its actors,
        // which it does after our enable() on a fresh login.
        this._timers.oneShot(1500, () => this._rescanDock(), 'dock-rescan');

        Log.info(`enabled (shell ${capabilities().blurEffect ? 'native blur' : 'shader blur'})`);
    }

    /**
     * Connect to the shell-wide objects that tell us the backdrop changed.
     *
     * Architecture rule 2: always-visible surfaces are refreshed from THESE
     * events, never from a repeating timer. Each surface throttles its own
     * response with a hard minimum interval.
     *
     * Every one of these objects lives for the whole session, so every one of
     * these handlers is tracked and unconditionally disconnected in disable().
     */
    _connectGlobalEvents() {
        const backdropChanged = () => {
            for (const surface of this._persistent)
                surface.onBackdropChanged();
        };

        const geometryChanged = () => {
            for (const surface of this._persistent)
                surface.refresh();
            this._popupManager.refresh();
        };

        this._signals.connect(Main.layoutManager, 'monitors-changed',
            geometryChanged, 'global');

        this._signals.connect(Main.overview, 'showing', () => {
            for (const surface of this._persistent)
                surface.onOverviewChanged();
        }, 'global');
        this._signals.connect(Main.overview, 'hidden', () => {
            for (const surface of this._persistent)
                surface.onOverviewChanged();
        }, 'global');

        this._signals.connect(global.workspace_manager, 'workspace-switched',
            backdropChanged, 'global');
        this._signals.connect(global.display, 'restacked',
            backdropChanged, 'global');
        this._signals.connect(global.display, 'window-created',
            backdropChanged, 'global');

        // Another extension appearing or disappearing may add or remove the
        // dock we attach to.
        if (Main.extensionManager) {
            this._signals.connect(Main.extensionManager, 'extension-state-changed',
                () => this._rescanDock(), 'global');
        }

        // Accent colour and theme changes invalidate our generated stylesheet
        // and the radii we read from theme nodes.
        try {
            const stSettings = St.Settings.get();
            this._signals.connect(stSettings, 'notify::accent-color',
                () => this._refreshAccent(), 'global');
            this._signals.connect(stSettings, 'notify::color-scheme',
                () => geometryChanged(), 'global');
        } catch (e) {
            Log.debug(`St.Settings signals unavailable: ${e}`);
        }
    }

    _watchSettings() {
        this._unwatchSettings = this._settings.onChanged(key => {
            if (key === 'debug-logging') {
                Log.setDebugEnabled(this._settings.getBoolean('debug-logging'));
                return;
            }

            if (key === 'fix-accent-contrast') {
                this._refreshAccent();
                return;
            }

            if (key === 'manage-dash-to-dock') {
                if (this._settings.getBoolean('manage-dash-to-dock'))
                    this._integrations.applyDashToDock();
                else
                    this._integrations.revert();
                return;
            }

            if (key === 'min-refresh-interval') {
                for (const surface of this._persistent)
                    surface.refresh();
                return;
            }

            if (MATERIAL_KEYS.includes(key)) {
                const material = this._settings.material();
                this._sharedGlass.setMaterial(material);
                for (const surface of this._persistent)
                    surface.refresh();
                this._popupManager.refresh();
                return;
            }

            if (SURFACE_KEYS.includes(key) || TEXT_KEYS.includes(key)) {
                for (const surface of this._persistent)
                    surface.refresh();
                this._popupManager.refresh();
            }
        });
    }

    _refreshAccent() {
        if (!this._accentFix)
            return;
        this._accentFix.revert();
        if (this._settings.getBoolean('fix-accent-contrast'))
            this._accentFix.apply(this._cacheDir());
    }

    _rescanDock() {
        if (!this._persistent)
            return;
        for (const surface of this._persistent) {
            if (surface.name === 'dock')
                surface.rescan();
        }
    }

    _cacheDir() {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), 'aqua-glass']);
    }

    _disable() {
        // 1. Stop anything that could fire while we are dismantling.
        if (this._timers)
            this._timers.cancelAll();
        if (this._laters)
            this._laters.cancelAll();

        // 2. Drop the diagnostics surface.
        delete globalThis.aquaGlass;
        if (this._selfCheck) {
            this._selfCheck.unexportDBus();
            this._selfCheck = null;
        }

        // 3. Restore every surface's real background before anything is
        //    destroyed (rule 4: background back first, glass down after).
        if (this._popupManager) {
            this._popupManager.disable();
            this._popupManager = null;
        }
        if (this._persistent) {
            for (const surface of this._persistent)
                surface.disable();
            this._persistent = null;
        }

        // 4. Put other extensions back exactly as we found them, so disabling
        //    Aqua Glass never leaves the dock invisible or Blur My Shell off.
        if (this._integrations) {
            this._integrations.revert();
            this._integrations = null;
        }

        if (this._accentFix) {
            this._accentFix.revert();
            this._accentFix = null;
        }

        // 5. Destroy the glass instances and their framebuffers.
        for (const glass of [this._sharedGlass, this._panelGlass, this._dockGlass]) {
            if (glass)
                glass.destroy();
        }
        this._sharedGlass = null;
        this._panelGlass = null;
        this._dockGlass = null;

        // 6. Disconnect everything, including every handler on a
        //    process-lifetime object.
        if (this._unwatchSettings) {
            this._unwatchSettings();
            this._unwatchSettings = null;
        }
        if (this._settings) {
            this._settings.destroy();
            this._settings = null;
        }
        if (this._signals) {
            this._signals.disconnectAll();
            this._signals = null;
        }

        // 7. Final drain: a teardown step above may have scheduled something.
        if (this._timers) {
            this._timers.cancelAll();
            this._timers = null;
        }
        if (this._laters) {
            this._laters.cancelAll();
            this._laters = null;
        }

        resetCapabilities();
        Log.info('disabled');
    }
}
