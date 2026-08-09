// Aqua Glass - unit tests for the parts that can be tested off-shell.
//
// lib/color.js and lib/shader.js import nothing from GI, so the whole of the
// contrast argument - which is the subtlest thing in this extension, and the
// thing most likely to be quietly wrong - is verifiable with plain node.
//
//     make test        (or: node tests/run.mjs)

import {
    parse, toHex, srgbToLinear, relativeLuminance, contrastRatio,
    contrastRatioFromLuminance, idealThreshold, decideTextMode,
    adjustForContrast, bestForeground, medianLuminance,
    ACCENT_PALETTE, ACCENT_FG, LIGHT_FG, DARK_FG,
} from '../src/lib/color.js';

import {lightVector} from '../src/lib/shader.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
    if (condition) {
        passed += 1;
        console.log(`  ok    ${name}`);
    } else {
        failed += 1;
        console.log(`  FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
    }
}

function near(a, b, tol = 1e-6) {
    return Math.abs(a - b) <= tol;
}

const round2 = v => Math.round(v * 100) / 100;

console.log('\nColour parsing');
check('#fff expands', (() => {
    const c = parse('#fff');
    return c && near(c.r, 1) && near(c.g, 1) && near(c.b, 1);
})());
check('#3584e4 parses', (() => {
    const c = parse('#3584e4');
    return c && near(c.r, 0x35 / 255) && near(c.g, 0x84 / 255) && near(c.b, 0xe4 / 255);
})());
check('rgba() parses', (() => {
    const c = parse('rgba(255, 0, 0, 0.5)');
    return c && near(c.r, 1) && near(c.g, 0) && near(c.a, 0.5);
})());
check('garbage rejected', parse('not-a-colour') === null);
check('round-trips through hex', toHex(parse('#3584e4')) === '#3584e4');

console.log('\nsRGB linearisation (WCAG)');
// The two branches of the piecewise transfer function, and the endpoints.
check('0 -> 0', near(srgbToLinear(0), 0));
check('1 -> 1', near(srgbToLinear(1), 1));
check('low branch is linear', near(srgbToLinear(0.02), 0.02 / 12.92));
check('high branch matches spec at 0.5',
    near(srgbToLinear(0.5), Math.pow((0.5 + 0.055) / 1.055, 2.4), 1e-12));
check('white luminance is 1', near(relativeLuminance({r: 1, g: 1, b: 1}), 1, 1e-12));
check('black luminance is 0', near(relativeLuminance({r: 0, g: 0, b: 0}), 0, 1e-12));

console.log('\nContrast ratios');
check('white on black is 21:1',
    near(contrastRatio({r: 1, g: 1, b: 1}, {r: 0, g: 0, b: 0}), 21, 1e-9));

// The load-bearing claim: pure endpoints clear AA everywhere, the softened
// pair does not.
const threshold = idealThreshold();
check('crossover is 0.179', near(threshold, 0.1791, 1e-4),
    `got ${threshold.toFixed(4)}`);

const worstPure = contrastRatioFromLuminance(1.0, threshold);
check('pure #fff/#000 worst case is 4.58:1 (>= AA 4.5)',
    worstPure >= 4.5 && near(round2(worstPure), 4.58, 0.01),
    `got ${round2(worstPure)}`);

// Now the softened pair, swept across the whole luminance range.
const softLight = relativeLuminance(parse('#f2f2f2'));
const softDark = relativeLuminance(parse('#1a1a1a'));
let softWorst = Infinity;
let softWorstAt = 0;
for (let i = 0; i <= 1000; i++) {
    const L = i / 1000;
    const best = Math.max(
        contrastRatioFromLuminance(softLight, L),
        contrastRatioFromLuminance(softDark, L));
    if (best < softWorst) {
        softWorst = best;
        softWorstAt = L;
    }
}
check('softened #f2f2f2/#1a1a1a drops below AA (~3.94:1)',
    softWorst < 4.5 && near(round2(softWorst), 3.94, 0.02),
    `worst ${round2(softWorst)} at L=${softWorstAt.toFixed(3)}`);

// And confirm the pure pair never does, over the same sweep.
let pureWorst = Infinity;
for (let i = 0; i <= 1000; i++) {
    const L = i / 1000;
    pureWorst = Math.min(pureWorst, Math.max(
        contrastRatioFromLuminance(relativeLuminance(parse(LIGHT_FG)), L),
        contrastRatioFromLuminance(relativeLuminance(parse(DARK_FG)), L)));
}
check('pure pair never drops below AA across all backdrops',
    pureWorst >= 4.5, `worst ${round2(pureWorst)}`);

console.log('\nText mode decision and hysteresis');
check('dark backdrop -> light text',
    decideTextMode(0.02, null, threshold, 0.08) === 'light');
check('bright backdrop -> dark text',
    decideTextMode(0.80, null, threshold, 0.08) === 'dark');
check('inside the dead band, previous choice is kept (light)',
    decideTextMode(threshold + 0.01, 'light', threshold, 0.08) === 'light');
check('inside the dead band, previous choice is kept (dark)',
    decideTextMode(threshold - 0.01, 'dark', threshold, 0.08) === 'dark');
check('outside the dead band, the band is overruled',
    decideTextMode(threshold + 0.05, 'light', threshold, 0.08) === 'dark');

// The oscillation the dead band exists to prevent: alternating measurements
// either side of the threshold must not alternate the decision.
let mode = 'light';
let flips = 0;
const wobble = [0.170, 0.188, 0.171, 0.190, 0.169, 0.187];
for (const L of wobble) {
    const next = decideTextMode(L, mode, threshold, 0.08);
    if (next !== mode)
        flips += 1;
    mode = next;
}
check('borderline measurements settle instead of alternating', flips === 0,
    `${flips} flips`);

// With no dead band the same sequence oscillates - proving the band is what
// does the work, not luck in the numbers.
let bareMode = 'light';
let bareFlips = 0;
for (const L of wobble) {
    const next = decideTextMode(L, bareMode, threshold, 0);
    if (next !== bareMode)
        bareFlips += 1;
    bareMode = next;
}
check('...and would oscillate with the dead band removed', bareFlips > 1,
    `${bareFlips} flips`);

console.log('\nAccent contrast');
const white = parse(ACCENT_FG);
const blue = parse(ACCENT_PALETTE[0]);
const blueRatio = contrastRatio(blue, white);
check('stock GNOME blue #3584e4 on white fails AA',
    blueRatio < 4.5 && near(round2(blueRatio), 3.77, 0.02),
    `got ${round2(blueRatio)}:1`);

// The figure quoted for the older accent, as an independent check that the
// luminance model matches published numbers.
const oldBlue = parse('#277be2');
check('older accent #277be2 on white is 4.19:1',
    near(round2(contrastRatio(oldBlue, white)), 4.19, 0.02),
    `got ${round2(contrastRatio(oldBlue, white))}:1`);

let corrected = 0;
for (const hex of ACCENT_PALETTE) {
    const accent = parse(hex);
    const result = adjustForContrast(accent, white, 4.5);
    check(`accent ${hex} reaches AA after adjustment`,
        result.ratio >= 4.5 - 1e-9,
        `got ${round2(result.ratio)}:1`);
    if (result.adjusted)
        corrected += 1;
}
check('some stock accents genuinely needed correcting', corrected > 0,
    `${corrected}/${ACCENT_PALETTE.length} corrected`);
check('an already-passing colour is left alone',
    adjustForContrast(parse('#000000'), white, 4.5).adjusted === false);

console.log('\nForeground selection');
check('white chosen on a dark backdrop',
    bestForeground({r: 0.05, g: 0.05, b: 0.05}).hex === LIGHT_FG);
check('black chosen on a light backdrop',
    bestForeground({r: 0.95, g: 0.95, b: 0.95}).hex === DARK_FG);

console.log('\nMedian sampling');
check('median ignores a single bright outlier', (() => {
    const dark = {r: 0.1, g: 0.1, b: 0.1};
    const samples = [dark, dark, dark, dark, {r: 1, g: 1, b: 1}];
    return medianLuminance(samples) === relativeLuminance(dark);
})());
check('median of an empty set is 0', medianLuminance([]) === 0);

console.log('\nLight direction convention');
// 0 degrees is from directly above; screen y points down, so "above" is -y.
check('0 deg is from above', (() => {
    const [x, y] = lightVector(0);
    return near(x, 0, 1e-9) && near(y, -1, 1e-9);
})());
check('90 deg is from the right', (() => {
    const [x, y] = lightVector(90);
    return near(x, 1, 1e-9) && near(y, 0, 1e-9);
})());
check('315 deg (the default) is from the top left', (() => {
    const [x, y] = lightVector(315);
    return x < 0 && y < 0 && near(Math.hypot(x, y), 1, 1e-9);
})());
check('every angle yields a unit vector', (() => {
    for (let a = 0; a < 360; a += 7) {
        const [x, y] = lightVector(a);
        if (!near(Math.hypot(x, y), 1, 1e-9))
            return false;
    }
    return true;
})());

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
