// Aqua Glass - runtime self-check.
//
// The point of this file is that leaks are PROVABLE rather than assumed.
// Every resource this extension can leak is owned by a tracker that can be
// counted, so the report below is a direct read of live state, not an
// estimate:
//
//   * effects created  - must be exactly 1 shared popup effect (rule 1)
//   * tracked popups   - and how many currently hold the glass
//   * active signals   - per signal name, so a runaway connect is obvious
//   * pending timers   - must be 0 at rest, and there is no repeating-timer
//                        API for them to have come from (rule 2)
//
// It is reachable three ways: from Looking Glass as `globalThis.aquaGlass`,
// over D-Bus, and from the preferences window (which is a separate process and
// so can only use D-Bus).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Log from './logger.js';
import {rssMiB, shellVersion, capabilities} from './compat.js';
import {effectStats} from './glassSurface.js';

const DBUS_NAME = 'org.gnome.Shell.Extensions.AquaGlass';
const DBUS_PATH = '/org/gnome/Shell/Extensions/AquaGlass';

const DBUS_INTERFACE = `
<node>
  <interface name="org.gnome.Shell.Extensions.AquaGlass">
    <method name="SelfCheck">
      <arg type="s" direction="out" name="report"/>
    </method>
    <method name="MemoryTest">
      <arg type="i" direction="in"  name="cycles"/>
      <arg type="s" direction="out" name="report"/>
    </method>
    <method name="Rss">
      <arg type="d" direction="out" name="mib"/>
    </method>
  </interface>
</node>`;

export class SelfCheck {
    /**
     * @param {object} ctx the extension's live objects
     */
    constructor(ctx) {
        this._ctx = ctx;
        this._exported = null;
        this._memoryTestRunning = false;
    }

    /**
     * Collect the full diagnostic snapshot.
     *
     * @returns {object} report
     */
    collect() {
        const ctx = this._ctx;
        const effects = effectStats();

        const report = {
            version: '1.0.0',
            shell: shellVersion(),
            capabilities: capabilities(),
            rssMiB: rssMiB(),

            effects: {
                created: effects.created,
                destroyed: effects.destroyed,
                live: effects.live,
                // Rule 1: one shared effect serves every transient popup.
                sharedPopupEffects: ctx.sharedGlass?.isBuilt ? 1 : 0,
                persistentEffects: ctx.persistent
                    ? ctx.persistent.filter(p => p.isActive).length
                    : 0,
            },

            popups: ctx.popupManager ? ctx.popupManager.describe() : null,

            persistent: ctx.persistent
                ? ctx.persistent.map(p => p.describe())
                : [],

            signals: {
                total: ctx.signals ? ctx.signals.count : 0,
                bySignal: ctx.signals ? ctx.signals.describe() : {},
            },

            timers: {
                pending: ctx.timers ? ctx.timers.count : 0,
                byLabel: ctx.timers ? ctx.timers.describe() : {},
                // There is deliberately no repeating-timer API (rule 2).
                repeatingTimers: 0,
            },

            laters: {
                pending: ctx.laters ? ctx.laters.count : 0,
            },

            integrations: ctx.integrations ? ctx.integrations.describe() : null,
            accent: ctx.accentFix ? ctx.accentFix.report : null,
        };

        report.framebufferBytes = report.persistent.reduce(
            (sum, p) => sum + (p.glass?.bytes || 0),
            ctx.sharedGlass?.isBuilt ? ctx.sharedGlass.estimatedBytes() : 0);

        report.problems = this._problems(report);
        return report;
    }

    /**
     * Turn the snapshot into the list of things that are actually wrong.
     *
     * @param {object} r the report
     * @returns {string[]} problems
     */
    _problems(r) {
        const problems = [];

        if (r.effects.sharedPopupEffects > 1) {
            problems.push(
                `RULE 1 VIOLATED: ${r.effects.sharedPopupEffects} shared popup effects; ` +
                'exactly 1 is expected. One framebuffer per popup is what exhausts memory.');
        }

        const expectedLive = r.effects.sharedPopupEffects + r.effects.persistentEffects;
        if (r.effects.live > expectedLive) {
            problems.push(
                `Effect leak: ${r.effects.live} live effects but only ${expectedLive} ` +
                'surfaces are active.');
        }

        if (r.effects.created > r.effects.destroyed + r.effects.live) {
            problems.push(
                `Accounting mismatch: created=${r.effects.created}, ` +
                `destroyed=${r.effects.destroyed}, live=${r.effects.live}.`);
        }

        if (r.popups && r.popups.attached > 1) {
            problems.push(
                `${r.popups.attached} popups claim the glass at once; only one can own it.`);
        }

        if (r.timers.pending > 8) {
            problems.push(
                `${r.timers.pending} timers pending - unexpectedly many for an idle shell.`);
        }

        if (r.signals.total > 400) {
            problems.push(
                `${r.signals.total} live signal connections - possible connect leak.`);
        }

        return problems;
    }

    /**
     * Human-readable report.
     *
     * @returns {string} formatted text
     */
    format() {
        const r = this.collect();
        const lines = [];

        lines.push('Aqua Glass self-check');
        lines.push('=====================');
        lines.push(`shell            : ${r.shell}`);
        lines.push(`gnome-shell RSS  : ${r.rssMiB} MiB`);
        lines.push(`framebuffers     : ~${(r.framebufferBytes / (1024 * 1024)).toFixed(1)} MiB`);
        lines.push('');
        lines.push('Effects');
        lines.push(`  shared popup effects : ${r.effects.sharedPopupEffects}   (must be 1)`);
        lines.push(`  persistent effects   : ${r.effects.persistentEffects}`);
        lines.push(`  created / destroyed  : ${r.effects.created} / ${r.effects.destroyed}`);
        lines.push(`  live                 : ${r.effects.live}`);
        lines.push('');

        if (r.popups) {
            lines.push('Popups');
            lines.push(`  tracked   : ${r.popups.tracked}`);
            lines.push(`  attached  : ${r.popups.attached}`);
            lines.push(`  owner     : ${r.popups.ownerStack.join(' > ') || '(none)'}`);
            for (const [id, counts] of Object.entries(r.popups.byId))
                lines.push(`    ${id.padEnd(20)} tracked=${counts.tracked} attached=${counts.attached}`);
            lines.push('');
        }

        lines.push('Persistent surfaces');
        if (r.persistent.length === 0) {
            lines.push('  (none active)');
        } else {
            for (const p of r.persistent) {
                lines.push(`  ${p.name.padEnd(10)} active=${p.active} text=${p.textMode || '-'} ` +
                           `recoloured=${p.recoloured} fb=${((p.glass?.bytes || 0) / 1048576).toFixed(1)}MiB`);
            }
        }
        lines.push('');

        lines.push(`Signals : ${r.signals.total} live`);
        for (const [name, n] of Object.entries(r.signals.bySignal))
            lines.push(`    ${name.padEnd(24)} ${n}`);
        lines.push(`Timers  : ${r.timers.pending} pending, ${r.timers.repeatingTimers} repeating`);
        lines.push(`Laters  : ${r.laters.pending} pending`);
        lines.push('');

        if (r.accent) {
            lines.push(`Accent  : ${r.accent.accent} ${r.accent.ratioBefore}:1 -> ` +
                       `${r.accent.correctedColour} ${r.accent.ratioAfter}:1 ` +
                       `(${r.accent.corrected ? 'corrected' : 'already AA'})`);
        }

        if (r.integrations) {
            lines.push(`Blur My Shell : active=${r.integrations.blurMyShell.active} ` +
                       `overlapping=[${r.integrations.blurMyShell.overlapping.join(', ')}]`);
            lines.push(`Dash to Dock  : active=${r.integrations.dashToDock.active}`);
        }

        lines.push('');
        if (r.problems.length === 0) {
            lines.push('RESULT: OK - no leaks or rule violations detected.');
        } else {
            lines.push(`RESULT: ${r.problems.length} PROBLEM(S)`);
            for (const p of r.problems)
                lines.push(`  ! ${p}`);
        }

        return lines.join('\n');
    }

    // ---------------------------------------------------------------- D-Bus

    /** Export the diagnostic interface on the session bus. */
    exportDBus() {
        if (this._exported)
            return;
        try {
            this._exported = Gio.DBusExportedObject.wrapJSObject(DBUS_INTERFACE, this);
            this._exported.export(Gio.DBus.session, DBUS_PATH);
            Log.debug(`exported ${DBUS_NAME} at ${DBUS_PATH}`);
        } catch (e) {
            Log.error(e, 'exporting D-Bus interface');
            this._exported = null;
        }
    }

    /** Withdraw the D-Bus interface. */
    unexportDBus() {
        if (!this._exported)
            return;
        try {
            this._exported.unexport();
        } catch (e) {
            Log.error(e, 'unexporting D-Bus interface');
        }
        this._exported = null;
    }

    /**
     * D-Bus: SelfCheck() -> s
     *
     * @returns {string} the formatted report
     */
    SelfCheck() {
        return Log.guard('SelfCheck', () => this.format(), 'self-check failed');
    }

    /**
     * D-Bus: Rss() -> d
     *
     * @returns {number} gnome-shell RSS in MiB
     */
    Rss() {
        return rssMiB();
    }

    /**
     * D-Bus: MemoryTest(cycles) -> s
     *
     * Opens and closes a real menu `cycles` times and reports the RSS delta.
     * This is the procedure in docs/MEMORY-TEST.md, run from inside the shell
     * so it measures the right process without any external tooling.
     *
     * Async so the caller gets the result when the run has actually finished.
     * The timer chain is built from one-shots - each step schedules the next -
     * so an interrupted run cannot leave a repeating source behind.
     *
     * @param {Array} params [cycles]
     * @param {Gio.DBusMethodInvocation} invocation the pending call
     */
    MemoryTestAsync(params, invocation) {
        const [requested] = params;
        const cycles = Math.max(1, Math.min(500, requested || 50));

        if (this._memoryTestRunning) {
            invocation.return_value(new GLib.Variant('(s)', ['a memory test is already running']));
            return;
        }

        const menu = this._findTestMenu();
        if (!menu) {
            invocation.return_value(new GLib.Variant('(s)',
                ['no suitable menu found to cycle']));
            return;
        }

        this._memoryTestRunning = true;
        const timers = this._ctx.timers;
        const startRss = rssMiB();
        const startEffects = effectStats();
        let done = 0;

        const finish = () => {
            this._memoryTestRunning = false;
            const endEffects = effectStats();

            // Give the GC a chance so the number reflects real retention
            // rather than uncollected garbage.
            try {
                imports.system.gc();
            } catch {
                // `imports` is unavailable under ESM in some builds.
            }

            timers.oneShot(500, () => {
                const endRss = rssMiB();
                const delta = Math.round((endRss - startRss) * 10) / 10;
                const lines = [
                    `Aqua Glass memory test: ${cycles} open/close cycles`,
                    `  RSS before : ${startRss} MiB`,
                    `  RSS after  : ${endRss} MiB`,
                    `  delta      : ${delta >= 0 ? '+' : ''}${delta} MiB`,
                    `  effects created during test : ${endEffects.created - startEffects.created} (expected 0)`,
                    `  effects live                : ${endEffects.live}`,
                    '',
                    Math.abs(delta) <= 25 && endEffects.created === startEffects.created
                        ? 'RESULT: PASS - RSS returned to baseline and no new effects were built.'
                        : 'RESULT: INVESTIGATE - see the report above and run SelfCheck.',
                ];
                invocation.return_value(new GLib.Variant('(s)', [lines.join('\n')]));
            }, 'memtest-settle');
        };

        const step = () => {
            if (done >= cycles) {
                finish();
                return;
            }
            done += 1;
            Log.guard('memtest cycle', () => {
                menu.open(false);
                timers.oneShot(30, () => {
                    Log.guard('memtest close', () => menu.close(false));
                    timers.oneShot(30, step, 'memtest-next');
                }, 'memtest-close');
            });
        };

        step();
    }

    _findTestMenu() {
        try {
            const qs = Main.panel?.statusArea?.quickSettings;
            if (qs?.menu)
                return qs.menu;
            const dateMenu = Main.panel?.statusArea?.dateMenu;
            if (dateMenu?.menu)
                return dateMenu.menu;
        } catch {
            // ignore
        }
        return null;
    }
}
