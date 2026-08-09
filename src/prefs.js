// Aqua Glass - preferences.
//
// This runs in gnome-shell-extension-prefs, a SEPARATE PROCESS from the shell.
// It has no access to any shell internals, actors or effects. That is why the
// diagnostics page talks to the extension over D-Bus rather than calling the
// self-check directly.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DBUS_NAME = 'org.gnome.Shell';
const DBUS_PATH = '/org/gnome/Shell/Extensions/AquaGlass';
const DBUS_IFACE = 'org.gnome.Shell.Extensions.AquaGlass';

const SURFACES = [
    ['surface-panel', 'Top panel', 'The bar across the top of the screen'],
    ['surface-panel-menus', 'Panel menus', 'Menus opened from the status area'],
    ['surface-date-menu', 'Date and calendar', 'The clock menu with the calendar and notifications'],
    ['surface-quick-settings', 'Quick Settings', 'The system menu with toggles and sliders'],
    ['surface-notifications', 'Notifications', 'Notification banners'],
    ['surface-osd', 'OSD popups', 'Volume and brightness overlays'],
    ['surface-dash-to-dock', 'Dash to Dock', 'The dock, if Dash to Dock is installed'],
    ['surface-context-menus', 'Context menus', 'Right-click menus on apps and the desktop'],
    ['surface-window-menus', 'Window menus', 'The menu on a window title bar'],
    ['surface-input-switcher', 'Input source switcher', 'The language/keyboard-layout switcher'],
    ['surface-alt-tab', 'Alt-Tab', 'The window and application switcher'],
    ['surface-ibus-candidate', 'IBus candidates', 'The input-method candidate popup'],
    ['surface-workspace-switcher', 'Workspace switcher', 'The workspace indicator popup'],
];

export default class AquaGlassPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(720, 820);

        window.add(this._surfacesPage(settings));
        window.add(this._materialPage(settings));
        window.add(this._textPage(settings));
        window.add(this._integrationPage(settings));
        window.add(this._diagnosticsPage(settings));
    }

    // ------------------------------------------------------------- helpers

    _switchRow(group, settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle: subtitle || ''});
        group.add(row);
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    // Adw.SpinRow's `value` is a double. Gio.Settings.bind() refuses to bind a
    // double property to an integer ('i') key, so both row helpers below sync
    // by hand rather than relying on bind() and discovering the mismatch at
    // runtime. The guards on both sides stop the two notifications from
    // ping-ponging.

    _intRow(group, settings, key, title, subtitle, min, max, step = 1) {
        const row = new Adw.SpinRow({
            title,
            subtitle: subtitle || '',
            adjustment: new Gtk.Adjustment({
                lower: min, upper: max,
                step_increment: step, page_increment: step * 5,
            }),
        });
        group.add(row);

        row.value = settings.get_int(key);
        row.connect('notify::value', () => {
            const v = Math.round(row.value);
            if (settings.get_int(key) !== v)
                settings.set_int(key, v);
        });
        settings.connect(`changed::${key}`, () => {
            const v = settings.get_int(key);
            if (Math.round(row.value) !== v)
                row.value = v;
        });
        return row;
    }

    _doubleRow(group, settings, key, title, subtitle, min, max, step = 0.05, digits = 2) {
        const row = new Adw.SpinRow({
            title,
            subtitle: subtitle || '',
            digits,
            adjustment: new Gtk.Adjustment({
                lower: min, upper: max,
                step_increment: step, page_increment: step * 4,
            }),
        });
        group.add(row);

        const epsilon = Math.pow(10, -(digits + 1));
        row.value = settings.get_double(key);
        row.connect('notify::value', () => {
            if (Math.abs(settings.get_double(key) - row.value) > epsilon)
                settings.set_double(key, row.value);
        });
        settings.connect(`changed::${key}`, () => {
            const v = settings.get_double(key);
            if (Math.abs(row.value - v) > epsilon)
                row.value = v;
        });
        return row;
    }

    // --------------------------------------------------------------- pages

    _surfacesPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Surfaces',
            icon_name: 'view-grid-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Where glass is drawn',
            description: 'Each surface is independent. Turning one off restores ' +
                         'its normal appearance immediately.',
        });
        page.add(group);

        for (const [key, title, subtitle] of SURFACES)
            this._switchRow(group, settings, key, title, subtitle);

        return page;
    }

    _materialPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Material',
            icon_name: 'preferences-desktop-theme-symbolic',
        });

        const base = new Adw.PreferencesGroup({
            title: 'Backdrop',
            description: 'What the glass does to what is behind it.',
        });
        page.add(base);
        this._intRow(base, settings, 'blur-sigma', 'Blur',
            'Gaussian sigma in pixels', 0, 64);
        this._doubleRow(base, settings, 'saturation', 'Saturation',
            'Above 1 makes colours behind the glass richer', 0, 2);
        this._doubleRow(base, settings, 'brightness', 'Brightness',
            null, 0.5, 1.5);
        this._doubleRow(base, settings, 'tint-strength', 'Tint strength',
            null, 0, 1);

        const tintRow = new Adw.EntryRow({title: 'Tint colour (hex)'});
        base.add(tintRow);
        settings.bind('tint-color', tintRow, 'text', Gio.SettingsBindFlags.DEFAULT);

        this._doubleRow(base, settings, 'base-opacity', 'Surface opacity',
            'How solid the glass itself is over the blurred backdrop. Held ' +
            'above a floor at runtime so a surface is never invisible.', 0, 1);

        const optics = new Adw.PreferencesGroup({
            title: 'Optics',
            description: 'Refraction is concentrated at the edges; the centre of ' +
                         'the panel stays undistorted, as real glass with a ' +
                         'bevelled edge does.',
        });
        page.add(optics);
        this._switchRow(optics, settings, 'refraction-3d',
            'Edge refraction (experimental)',
            'Bends the backdrop at the edges like real glass. Needs a live ' +
            'copy of the screen in its own framebuffer, so it costs more and ' +
            'is less predictable than the rest of the material.');
        this._doubleRow(optics, settings, 'ior', 'Index of refraction',
            '1.5 is glass. 2.4 would be diamond.', 1.0, 2.0, 0.01);
        this._doubleRow(optics, settings, 'refraction-strength', 'Refraction strength',
            null, 0, 1);
        this._intRow(optics, settings, 'bevel-width', 'Bevel width',
            'How far in from the edge the lensing reaches, in pixels', 2, 80);
        this._doubleRow(optics, settings, 'chromatic-aberration', 'Chromatic aberration',
            'Subtle colour fringing, confined to the bevel', 0, 1);
        this._intRow(optics, settings, 'corner-radius', 'Corner radius',
            '-1 follows each surface\'s own theme', -1, 64);

        const light = new Adw.PreferencesGroup({
            title: 'Light',
            description: 'One light direction drives the specular highlight, the ' +
                         'rim and the shadow together, so they cannot disagree.',
        });
        page.add(light);
        this._switchRow(light, settings, 'specular-enabled', 'Specular highlights',
            'Glass without a specular highlight reads as flat plastic');
        this._doubleRow(light, settings, 'specular-intensity', 'Specular intensity',
            null, 0, 1);
        this._doubleRow(light, settings, 'specular-shininess', 'Specular tightness',
            'Higher is a smaller, sharper highlight', 4, 256, 4, 0);
        this._doubleRow(light, settings, 'sheen-intensity', 'Sheen',
            'A directional gradient, not a flat veil', 0, 1);
        this._doubleRow(light, settings, 'fresnel-intensity', 'Rim light',
            'Fresnel brightening at grazing angles', 0, 1);
        this._intRow(light, settings, 'light-angle', 'Light angle',
            'Degrees; 0 is from directly above, increasing clockwise', 0, 359, 5);

        const shadow = new Adw.PreferencesGroup({title: 'Shadow'});
        page.add(shadow);
        this._switchRow(shadow, settings, 'shadow-enabled', 'Drop shadow',
            'A soft, wide shadow rather than a hard contact ring');
        this._doubleRow(shadow, settings, 'shadow-opacity', 'Shadow opacity',
            null, 0, 1);
        this._intRow(shadow, settings, 'shadow-radius', 'Shadow softness',
            null, 0, 80);
        this._intRow(shadow, settings, 'shadow-offset', 'Shadow offset',
            'Distance the shadow falls away from the light', 0, 40);

        const perf = new Adw.PreferencesGroup({title: 'Performance'});
        page.add(perf);
        this._switchRow(perf, settings, 'native-blur', 'Use the shell\'s native blur',
            'Falls back to an in-shader blur if unavailable');
        this._intRow(perf, settings, 'min-refresh-interval',
            'Minimum refresh interval',
            'Hard floor between geometry refreshes of always-visible surfaces, in ms',
            100, 5000, 50);
        this._switchRow(perf, settings, 'hide-in-overview', 'Hide panel glass in the overview',
            null);

        return page;
    }

    _textPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Text',
            icon_name: 'format-text-rich-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Adaptive text',
            description: 'Transparent surfaces put text over an arbitrary ' +
                         'wallpaper. Aqua Glass measures the backdrop and picks ' +
                         'pure white or pure black, which is the only pair that ' +
                         'reaches WCAG AA at every backdrop brightness.',
        });
        page.add(group);

        this._switchRow(group, settings, 'adaptive-text', 'Adapt text colour', null);

        const modeRow = new Adw.ComboRow({
            title: 'Mode',
            subtitle: 'Force a colour instead of measuring',
            model: Gtk.StringList.new(['Automatic', 'Always light', 'Always dark']),
        });
        group.add(modeRow);

        const modes = ['auto', 'light', 'dark'];
        modeRow.selected = Math.max(0, modes.indexOf(settings.get_string('text-mode')));
        modeRow.connect('notify::selected', () => {
            settings.set_string('text-mode', modes[modeRow.selected] || 'auto');
        });
        settings.connect('changed::text-mode', () => {
            const idx = modes.indexOf(settings.get_string('text-mode'));
            if (idx >= 0 && idx !== modeRow.selected)
                modeRow.selected = idx;
        });

        this._switchRow(group, settings, 'text-shadow', 'Matched text shadow',
            'A dark halo under light text, a light halo under dark text');

        const tuning = new Adw.PreferencesGroup({
            title: 'Tuning',
            description: 'The default threshold, 0.179, is the backdrop luminance ' +
                         'at which white and black text are exactly equally ' +
                         'legible (4.58:1 each). The dead band stops backdrops ' +
                         'near that point from flipping between opens.',
        });
        page.add(tuning);
        this._doubleRow(tuning, settings, 'text-threshold', 'Switch threshold',
            'WCAG relative luminance', 0, 1, 0.005, 3);
        this._doubleRow(tuning, settings, 'text-hysteresis', 'Dead band',
            'Total width of the no-change band around the threshold', 0, 0.5, 0.01, 3);

        const accent = new Adw.PreferencesGroup({
            title: 'Accent colours',
            description: 'GNOME pairs accent-coloured chips with white text, but ' +
                         'several stock accents fall short of AA that way - blue ' +
                         '#3584e4 is only 3.77:1. Aqua Glass leaves the chips\' own ' +
                         'text alone and darkens the chip instead.',
        });
        page.add(accent);
        this._switchRow(accent, settings, 'fix-accent-contrast',
            'Fix accent chip contrast', null);

        return page;
    }

    _integrationPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Integration',
            icon_name: 'application-x-addon-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Other extensions',
            description: 'Aqua Glass covers the panel, popups and the dock itself, ' +
                         'so Blur My Shell is not needed for those. Anything ' +
                         'changed here is remembered and put back when Aqua Glass ' +
                         'is disabled.',
        });
        page.add(group);

        this._switchRow(group, settings, 'manage-blur-my-shell',
            'Offer to disable overlapping Blur My Shell components',
            'Running both stacks two blurs over the same pixels');
        this._switchRow(group, settings, 'manage-dash-to-dock',
            'Neutralise Dash to Dock\'s own background',
            'Its default DYNAMIC mode fades an opaque layer over the glass ' +
            'whenever a window comes near the dock');

        const restore = new Adw.PreferencesGroup({
            title: 'Revert',
            description: 'Restores every setting Aqua Glass changed in other ' +
                         'extensions, right now.',
        });
        page.add(restore);

        const row = new Adw.ActionRow({
            title: 'Restore other extensions\' settings',
            subtitle: 'Clears the saved backups after restoring',
        });
        const button = new Gtk.Button({
            label: 'Restore',
            valign: Gtk.Align.CENTER,
        });
        button.add_css_class('destructive-action');
        button.connect('clicked', () => {
            // Toggling this off makes the extension revert immediately, then we
            // put the preference back so future enables behave normally.
            settings.set_boolean('manage-dash-to-dock', false);
            settings.set_string('blur-my-shell-backup', '');
            settings.set_string('dash-to-dock-backup', '');
            button.label = 'Restored';
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                button.label = 'Restore';
                return GLib.SOURCE_REMOVE;
            });
        });
        row.add_suffix(button);
        restore.add(row);

        const debug = new Adw.PreferencesGroup({title: 'Debugging'});
        page.add(debug);
        this._switchRow(debug, settings, 'debug-logging', 'Verbose logging',
            'Writes detail to the journal: journalctl -f -o cat /usr/bin/gnome-shell');

        return page;
    }

    _diagnosticsPage() {
        const page = new Adw.PreferencesPage({
            title: 'Diagnostics',
            icon_name: 'utilities-system-monitor-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Self-check',
            description: 'Reports live effect, signal and timer counts straight ' +
                         'from the running extension, so leaks are provable ' +
                         'rather than assumed. Exactly one shared popup effect ' +
                         'is expected.',
        });
        page.add(group);

        const buffer = new Gtk.TextBuffer({
            text: 'Press "Run self-check" to query the running extension.',
        });
        const view = new Gtk.TextView({
            buffer,
            editable: false,
            monospace: true,
            top_margin: 8, bottom_margin: 8,
            left_margin: 8, right_margin: 8,
        });
        const scroller = new Gtk.ScrolledWindow({
            height_request: 380,
            child: view,
        });
        scroller.add_css_class('card');

        const buttons = new Gtk.Box({
            spacing: 8,
            margin_bottom: 8,
            halign: Gtk.Align.START,
        });

        const runButton = new Gtk.Button({label: 'Run self-check'});
        runButton.connect('clicked', () => this._call('SelfCheck', null, buffer));
        buttons.append(runButton);

        const memButton = new Gtk.Button({label: 'Memory test (50 cycles)'});
        memButton.connect('clicked', () => {
            buffer.set_text('Opening and closing 50 menus, please wait...', -1);
            this._call('MemoryTest', new GLib.Variant('(i)', [50]), buffer);
        });
        buttons.append(memButton);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
        });
        box.append(buttons);
        box.append(scroller);
        group.add(box);

        return page;
    }

    /**
     * Call a method on the running extension.
     *
     * @param {string} method method name
     * @param {GLib.Variant|null} args arguments
     * @param {Gtk.TextBuffer} buffer where to put the result
     */
    _call(method, args, buffer) {
        try {
            const bus = Gio.DBus.session;
            bus.call(
                DBUS_NAME, DBUS_PATH, DBUS_IFACE, method,
                args, null, Gio.DBusCallFlags.NONE, 120000, null,
                (connection, result) => {
                    try {
                        const reply = connection.call_finish(result);
                        const [text] = reply.deepUnpack();
                        buffer.set_text(text, -1);
                    } catch (e) {
                        buffer.set_text(
                            `Could not reach the extension.\n\n${e}\n\n` +
                            'Aqua Glass must be enabled for diagnostics to work.',
                            -1);
                    }
                });
        } catch (e) {
            buffer.set_text(`${e}`, -1);
        }
    }
}
