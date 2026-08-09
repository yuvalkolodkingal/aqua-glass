// Aqua Glass - colour science.
//
// This module exists because "make the text readable" is the single hardest
// part of putting transparent surfaces over an arbitrary wallpaper, and every
// naive implementation of it is wrong in one of a few specific ways:
//
//   * Mixing colour spaces. WCAG relative luminance is computed on
//     *linearized* sRGB. If you compare a linear luminance against a threshold
//     you picked by eyeballing sRGB values, your decision point lands roughly
//     3x too high and everything comes out white-on-pale.
//
//   * Softened text colours. A #f2f2f2 / #1a1a1a pair looks tasteful and fails:
//     there is a band of backdrop luminance (L ~ 0.16-0.22) where *neither*
//     reaches AA 4.5:1 - worst case 3.94:1. Pure #ffffff / #000000 has a worst
//     case of 4.58:1, which clears AA at every possible backdrop luminance.
//     See idealThreshold() below for where that number comes from.

/** Foreground colours. Pure endpoints, deliberately - see the note above. */
export const LIGHT_FG = '#ffffff';
export const DARK_FG = '#000000';

/**
 * GNOME's accent palette, from st-theme-context.c (identical in 48 and 50).
 * Indexed by StSystemAccentColor enum order.
 */
export const ACCENT_PALETTE = [
    '#3584e4', // blue
    '#2190a4', // teal
    '#3a944a', // green
    '#c88800', // yellow
    '#ed5b00', // orange
    '#e62d42', // red
    '#d56199', // pink
    '#9141ac', // purple
    '#6f8396', // slate
];

/** GNOME always pairs accent backgrounds with white text. */
export const ACCENT_FG = '#ffffff';

/**
 * Parse a colour string into normalised 0..1 components.
 *
 * Accepts #rgb, #rrggbb, #rrggbbaa, rgb(...) and rgba(...).
 *
 * @param {string} str colour string
 * @returns {{r: number, g: number, b: number, a: number}|null} parsed colour
 */
export function parse(str) {
    if (typeof str !== 'string')
        return null;
    const s = str.trim().toLowerCase();

    if (s.startsWith('#')) {
        const hex = s.slice(1);
        const expand = c => parseInt(c + c, 16) / 255;
        if (hex.length === 3) {
            return {r: expand(hex[0]), g: expand(hex[1]), b: expand(hex[2]), a: 1};
        } else if (hex.length === 6 || hex.length === 8) {
            const v = i => parseInt(hex.slice(i, i + 2), 16) / 255;
            if (hex.split('').some(c => '0123456789abcdef'.indexOf(c) < 0))
                return null;
            return {r: v(0), g: v(2), b: v(4), a: hex.length === 8 ? v(6) : 1};
        }
        return null;
    }

    const m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
        const parts = m[1].split(',').map(p => p.trim());
        if (parts.length < 3)
            return null;
        const chan = p => (p.endsWith('%')
            ? parseFloat(p) / 100
            : parseFloat(p) / 255);
        const c = {
            r: chan(parts[0]),
            g: chan(parts[1]),
            b: chan(parts[2]),
            a: parts.length > 3 ? parseFloat(parts[3]) : 1,
        };
        if ([c.r, c.g, c.b, c.a].some(v => Number.isNaN(v)))
            return null;
        return c;
    }

    return null;
}

/**
 * @param {{r: number, g: number, b: number}} c colour with 0..1 components
 * @returns {string} #rrggbb
 */
export function toHex(c) {
    const h = v => {
        const n = Math.max(0, Math.min(255, Math.round(v * 255)));
        return n.toString(16).padStart(2, '0');
    };
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/**
 * Undo the sRGB transfer function for one channel.
 *
 * This is the step naive implementations skip. The threshold and the measured
 * luminance must live in the same space.
 *
 * @param {number} c channel value, 0..1 in sRGB
 * @returns {number} linear-light value, 0..1
 */
export function srgbToLinear(c) {
    const v = Math.max(0, Math.min(1, c));
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * WCAG 2.1 relative luminance.
 *
 * @param {{r: number, g: number, b: number}} c colour with 0..1 components
 * @returns {number} relative luminance, 0..1 (linear space)
 */
export function relativeLuminance(c) {
    return 0.2126 * srgbToLinear(c.r) +
           0.7152 * srgbToLinear(c.g) +
           0.0722 * srgbToLinear(c.b);
}

/**
 * WCAG contrast ratio between two relative luminances.
 *
 * @param {number} l1 first relative luminance
 * @param {number} l2 second relative luminance
 * @returns {number} contrast ratio, 1..21
 */
export function contrastRatioFromLuminance(l1, l2) {
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * WCAG contrast ratio between two colours.
 *
 * @param {{r: number, g: number, b: number}} a first colour
 * @param {{r: number, g: number, b: number}} b second colour
 * @returns {number} contrast ratio, 1..21
 */
export function contrastRatio(a, b) {
    return contrastRatioFromLuminance(relativeLuminance(a), relativeLuminance(b));
}

/**
 * The backdrop luminance at which white and black text are equally legible.
 *
 * White on L gives 1.05 / (L + 0.05); black on L gives (L + 0.05) / 0.05.
 * Setting those equal: (L + 0.05)^2 = 1.05 * 0.05, so
 *
 *     L = sqrt(0.0525) - 0.05 = 0.1791
 *
 * and at that crossover both reach 1.05 / 0.2291 = 4.58:1. Because that is the
 * *worst* case over all L, pure black/white text clears AA 4.5:1 against every
 * possible backdrop. This is the whole argument for not softening the pair.
 *
 * @returns {number} the crossover relative luminance
 */
export function idealThreshold() {
    return Math.sqrt(1.05 * 0.05) - 0.05;
}

/**
 * Decide light or dark text for a backdrop, with hysteresis.
 *
 * Without the dead band, a backdrop sitting near the threshold flips between
 * black and white on consecutive opens, because the measurement varies by a
 * few percent each time. The band makes borderline backdrops settle on
 * whatever they chose last.
 *
 * @param {number} luminance measured backdrop relative luminance
 * @param {string|null} previous 'light' | 'dark' | null - the last decision
 * @param {number} threshold crossover luminance
 * @param {number} hysteresis total width of the dead band
 * @returns {string} 'light' (white text) or 'dark' (black text)
 */
export function decideTextMode(luminance, previous, threshold, hysteresis) {
    const half = Math.max(0, hysteresis) / 2;

    if (luminance > threshold + half)
        return 'dark';   // bright backdrop -> dark text
    if (luminance < threshold - half)
        return 'light';  // dark backdrop -> light text

    // Inside the dead band: keep what we had.
    return previous || (luminance > threshold ? 'dark' : 'light');
}

/**
 * Darken a colour until it reaches a target contrast ratio against `fg`.
 *
 * Used for accent chips: GNOME pairs accent backgrounds with white text, but
 * stock blue #3584e4 on white is only 3.77:1, below AA. We scale the colour
 * down in sRGB space until it passes, which keeps the hue recognisable.
 *
 * If the foreground is dark rather than light, we lighten instead.
 *
 * @param {{r: number, g: number, b: number}} bg background colour
 * @param {{r: number, g: number, b: number}} fg foreground colour
 * @param {number} [target] required contrast ratio
 * @returns {{color: object, ratio: number, adjusted: boolean}} result
 */
export function adjustForContrast(bg, fg, target = 4.5) {
    const fgLum = relativeLuminance(fg);
    const startRatio = contrastRatioFromLuminance(relativeLuminance(bg), fgLum);
    if (startRatio >= target)
        return {color: bg, ratio: startRatio, adjusted: false};

    // If the foreground is light we must go darker; if dark, lighter.
    const goDarker = fgLum > 0.5;

    let lo = 0;
    let hi = 1;
    let best = null;

    // 24 bisection steps is far more precision than 8-bit colour can express.
    for (let i = 0; i < 24; i++) {
        const t = (lo + hi) / 2;
        const cand = goDarker
            ? {r: bg.r * (1 - t), g: bg.g * (1 - t), b: bg.b * (1 - t)}
            : {r: bg.r + (1 - bg.r) * t, g: bg.g + (1 - bg.g) * t, b: bg.b + (1 - bg.b) * t};

        const ratio = contrastRatioFromLuminance(relativeLuminance(cand), fgLum);
        if (ratio >= target) {
            best = {color: cand, ratio};
            hi = t;   // we passed - try a subtler adjustment
        } else {
            lo = t;   // still failing - push harder
        }
    }

    if (best)
        return {color: best.color, ratio: best.ratio, adjusted: true};

    // Even a full push could not reach the target (only possible for absurd
    // targets). Return the extreme.
    const extreme = goDarker ? {r: 0, g: 0, b: 0} : {r: 1, g: 1, b: 1};
    return {
        color: extreme,
        ratio: contrastRatioFromLuminance(relativeLuminance(extreme), fgLum),
        adjusted: true,
    };
}

/**
 * Pick whichever of white/black contrasts better with a colour.
 *
 * @param {{r: number, g: number, b: number}} bg background colour
 * @returns {{hex: string, ratio: number}} the better foreground
 */
export function bestForeground(bg) {
    const lum = relativeLuminance(bg);
    const white = contrastRatioFromLuminance(1.0, lum);
    const black = contrastRatioFromLuminance(0.0, lum);
    return white >= black
        ? {hex: LIGHT_FG, ratio: white}
        : {hex: DARK_FG, ratio: black};
}

/**
 * Average a set of sampled colours in *linear* light.
 *
 * Averaging gamma-encoded sRGB values biases the result bright; converting to
 * linear first is the physically meaningful way to combine samples.
 *
 * @param {Array<{r: number, g: number, b: number}>} samples colours, 0..1
 * @returns {number} mean relative luminance
 */
export function meanLuminance(samples) {
    if (!samples || samples.length === 0)
        return 0;
    let sum = 0;
    for (const s of samples)
        sum += relativeLuminance(s);
    return sum / samples.length;
}

/**
 * Median relative luminance of a set of samples.
 *
 * Preferred over the mean when the sampled ring may clip a high-contrast edge
 * (a window border, a bright icon): one outlier should not swing the decision.
 *
 * @param {Array<{r: number, g: number, b: number}>} samples colours, 0..1
 * @returns {number} median relative luminance
 */
export function medianLuminance(samples) {
    if (!samples || samples.length === 0)
        return 0;
    const lums = samples.map(relativeLuminance).sort((a, b) => a - b);
    const mid = Math.floor(lums.length / 2);
    return lums.length % 2 ? lums[mid] : (lums[mid - 1] + lums[mid]) / 2;
}
