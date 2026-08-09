// Aqua Glass - lifecycle test.
//
// Runs the real extension against a mock GI layer: enable(), open and close a
// popup, then disable(). It exists because the interesting failures here are
// runtime ones (a method that does not exist, an unbalanced connect, an actor
// left parented) that no syntax check can see.
//
//     node --import ./tests/register-hooks.mjs tests/lifecycle.mjs

import {bookkeeping, resetBookkeeping} from './mocks/core.mjs';
import {timerControl} from './mocks/gi/GLib.mjs';
import {glslStats, pipelineBuilds} from './mocks/gi/Shell.mjs';
import St from './mocks/gi/St.mjs';

// Globals gnome-shell provides that plain node does not.
globalThis.logError = (e, msg) => {
    bookkeeping.errors.push(`${msg}: ${e && e.stack ? e.stack : e}`);
};
const realWarn = console.warn;
console.warn = (...a) => bookkeeping.warnings.push(a.join(' '));
globalThis.__StLabel = St.Label;

const Main = await import('./mocks/res/org_gnome_shell_ui_main.mjs');
const {laterControl} = Main;

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
    if (cond) {
        passed += 1;
        console.log(`  ok    ${name}`);
    } else {
        failed += 1;
        console.log(`  FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
    }
}

function settle() {
    laterControl.flush();
    timerControl.flush();
    laterControl.flush();
}

// ---------------------------------------------------------------- run it
resetBookkeeping();
const handlersAtStart = bookkeeping.liveHandlers;

const {default: AquaGlassExtension} = await import('../src/extension.js');

const ext = new AquaGlassExtension({uuid: 'aqua-glass@test'});

console.log('\nenable()');
ext.enable();
settle();

check('enable() raised no errors', bookkeeping.errors.length === 0,
    bookkeeping.errors.slice(0, 3).join(' | '));

check('the fragment snippet was attached', glslStats.snippets.length >= 1,
    `${glslStats.snippets.length} snippets`);

check('the snippet uses a defined Cogl hook',
    glslStats.snippets.every(s => typeof s.hook === 'number'));

check('the pipeline was built exactly once for the class',
    [...pipelineBuilds.values()].every(n => n === 1));

check('three glass instances exist (shared popup, panel, dock)',
    glslStats.instances === 3, `${glslStats.instances} instances`);

const glassActors = Main.uiGroupRef.get_children()
    .filter(c => (c.get_name() || '').startsWith('aqua-glass-'));
check('glass actors were parented into uiGroup', glassActors.length >= 1,
    `found ${glassActors.length}`);

const panelGlass = glassActors.find(a => a.get_name() === 'aqua-glass-panel');
check('the panel glass exists', !!panelGlass);
if (panelGlass) {
    check('panel glass is monitor-sized at the monitor origin (rule 3)',
        panelGlass.width === 1920 && panelGlass.height === 1080 &&
        panelGlass.x === 0 && panelGlass.y === 0,
        `${panelGlass.width}x${panelGlass.height}+${panelGlass.x}+${panelGlass.y}`);
    check('panel glass is clipped to the drawn region, not the whole monitor',
        panelGlass.has_clip() && panelGlass.get_clip()[3] < 1080,
        `clip=${panelGlass.get_clip().join(',')}`);
    check('panel glass is non-reactive so it cannot swallow clicks',
        panelGlass.reactive === false);
    check('panel glass is visible', panelGlass.visible === true);
}

// The panel's own background must have been cleared a frame later.
check('the panel background was cleared',
    (Main.panel.get_style() || '').includes('transparent'),
    `style=${Main.panel.get_style()}`);

// ---------------------------------------------------------- popup cycle
console.log('\npopup open/close');
const effectsBeforePopup = glslStats.instances;
const {boxPointer, content} = Main.makePopup('popup-menu-content');

boxPointer.show();
settle();

check('opening a popup created NO new effect (rule 1)',
    glslStats.instances === effectsBeforePopup,
    `${glslStats.instances} vs ${effectsBeforePopup}`);

check('the popup content background was cleared',
    (content.get_style() || '').includes('transparent'),
    `style=${content.get_style()}`);

// The shared glass is only parented when a popup claims it, so look it up now
// rather than reusing the snapshot taken at enable().
const findGlass = name => Main.uiGroupRef.get_children()
    .find(a => a.get_name() === name);

const sharedGlass = findGlass('aqua-glass-shared-popup');
check('the shared glass became visible for the popup',
    !!sharedGlass && sharedGlass.visible === true,
    sharedGlass ? `visible=${sharedGlass.visible}` : 'not parented into uiGroup');

check('the shared glass sits below the popup it serves',
    !!sharedGlass &&
    Main.uiGroupRef.get_children().indexOf(sharedGlass) <
    Main.uiGroupRef.get_children().indexOf(boxPointer));

check('the shared glass covers the monitor at its origin (rule 3)',
    !!sharedGlass && sharedGlass.width === 1920 && sharedGlass.height === 1080,
    sharedGlass ? `${sharedGlass.width}x${sharedGlass.height}` : 'n/a');

boxPointer.hide();
settle();

check('closing restored the popup background',
    !(content.get_style() || '').includes('transparent'),
    `style=${content.get_style()}`);

check('the shared glass was hidden again',
    !sharedGlass || sharedGlass.visible === false);

// 50 cycles: the memory-test scenario, asserted structurally.
console.log('\n50 open/close cycles');
const beforeCycles = glslStats.instances;
for (let i = 0; i < 50; i++) {
    boxPointer.show();
    settle();
    boxPointer.hide();
    settle();
}
check('50 cycles created no new effects',
    glslStats.instances === beforeCycles,
    `${glslStats.instances} vs ${beforeCycles}`);
check('50 cycles left no pending timers', timerControl.pending === 0,
    `${timerControl.pending} pending`);
check('no errors during cycling', bookkeeping.errors.length === 0,
    bookkeeping.errors.slice(0, 3).join(' | '));

// --------------------------------------------------------------- disable
console.log('\ndisable()');
const errorsBeforeDisable = bookkeeping.errors.length;
ext.disable();
settle();

check('disable() raised no errors',
    bookkeeping.errors.length === errorsBeforeDisable,
    bookkeeping.errors.slice(errorsBeforeDisable, errorsBeforeDisable + 3).join(' | '));

check('every signal handler was disconnected',
    bookkeeping.liveHandlers === handlersAtStart,
    `${bookkeeping.liveHandlers} live, expected ${handlersAtStart}`);

check('no timers left pending', timerControl.pending === 0,
    `${timerControl.pending} pending`);

check('no laters left pending', laterControl.pending === 0,
    `${laterControl.pending} pending`);

check('every glass actor was removed from uiGroup',
    Main.uiGroupRef.get_children()
        .filter(c => (c.get_name() || '').startsWith('aqua-glass-')).length === 0);

check('the panel background was restored',
    !(Main.panel.get_style() || '').includes('transparent'),
    `style=${Main.panel.get_style()}`);

check('globalThis.aquaGlass was removed',
    globalThis.aquaGlass === undefined);

// Re-enabling must work: a leak on this path is just as fatal.
console.log('\nre-enable/disable');
ext.enable();
settle();
ext.disable();
settle();
check('enable/disable/enable/disable leaves no handlers',
    bookkeeping.liveHandlers === handlersAtStart,
    `${bookkeeping.liveHandlers} live, expected ${handlersAtStart}`);
check('re-enable cycle raised no errors',
    bookkeeping.errors.length === errorsBeforeDisable,
    bookkeeping.errors.slice(-3).join(' | '));

console.warn = realWarn;
console.log(`\n${passed} passed, ${failed} failed`);
if (bookkeeping.errors.length > 0) {
    console.log('\nLogged errors:');
    for (const e of bookkeeping.errors.slice(0, 12))
        console.log(`  - ${e.split('\n')[0]}`);
}
process.exit(failed === 0 ? 0 : 1);
