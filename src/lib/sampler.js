// Aqua Glass - reading pixels off the screen.
//
// Used only to decide whether text on a glass surface should be white or
// black. The requirements are unusual: it has to be cheap enough to run on
// every popup open, it must not trip any screencast indicator or portal
// prompt, and it must sample somewhere that does NOT contain the text we are
// about to recolour.
//
// API choice: Shell.Screenshot.pick_color(). Reading the C implementation
// (shell-screenshot.c), it sets screenshot_area to a 1x1 rectangle and grabs
// exactly that - it is a single-pixel read, not a full framebuffer capture.
// Because we call the C API in-process, it never goes through the
// org.gnome.Shell.Screenshot D-Bus interface, so none of the permission
// checks, portal dialogs or "screen is being shared" indicators are involved.
//
// Where we sample, and why it is OUTSIDE the popup: sampling the glass surface
// itself measures the text that was just recoloured, which makes the decision
// depend on its own previous output. Measured on a real surface, the variance
// inside a single capture was p10=0.30 / p90=0.94, and the same rectangle
// returned 0.29 on one open and 0.62 on the next - enough to flip black/white
// between opens. Sampling the raw backdrop just outside the popup is stable
// and text-free; we then predict what the glass will do to it analytically,
// using the same grade the shader applies.

import Shell from 'gi://Shell';

import * as Log from './logger.js';
import {relativeLuminance, medianLuminance} from './color.js';
import {capabilities} from './compat.js';

/** How far outside the surface to sample, in pixels. */
const DEFAULT_OUTSET = 8;

/** How many points around the perimeter. */
const DEFAULT_POINTS = 12;

export class ColorSampler {
    constructor() {
        this._screenshot = null;
        this._token = 0;
        this._inFlight = 0;
    }

    get inFlight() {
        return this._inFlight;
    }

    _instance() {
        if (this._screenshot)
            return this._screenshot;
        try {
            this._screenshot = new Shell.Screenshot();
        } catch (e) {
            Log.error(e, 'new Shell.Screenshot');
            this._screenshot = null;
        }
        return this._screenshot;
    }

    /**
     * Invalidate any sampling still in flight.
     *
     * Called when a popup closes: results that arrive afterwards refer to a
     * surface that no longer exists and must be dropped rather than applied.
     */
    invalidate() {
        this._token += 1;
    }

    /**
     * Build a ring of sample points around a rectangle.
     *
     * @param {object} rect {x, y, width, height} in stage coordinates
     * @param {object} bounds monitor geometry to clamp into
     * @param {number} outset distance outside the rect
     * @param {number} count number of points
     * @returns {Array<{x: number, y: number}>} sample points
     */
    static ringPoints(rect, bounds, outset = DEFAULT_OUTSET, count = DEFAULT_POINTS) {
        const points = [];
        const x0 = rect.x - outset;
        const y0 = rect.y - outset;
        const x1 = rect.x + rect.width + outset;
        const y1 = rect.y + rect.height + outset;

        const perSide = Math.max(1, Math.floor(count / 4));
        const lerp = (a, b, t) => a + (b - a) * t;

        for (let i = 0; i < perSide; i++) {
            const t = (i + 0.5) / perSide;
            points.push({x: lerp(x0, x1, t), y: y0});   // top
            points.push({x: lerp(x0, x1, t), y: y1});   // bottom
            points.push({x: x0, y: lerp(y0, y1, t)});   // left
            points.push({x: x1, y: lerp(y0, y1, t)});   // right
        }

        // Clamp inside the monitor: an off-screen read returns nothing useful.
        const minX = bounds ? bounds.x : 0;
        const minY = bounds ? bounds.y : 0;
        const maxX = bounds ? bounds.x + bounds.width - 1 : 4096;
        const maxY = bounds ? bounds.y + bounds.height - 1 : 4096;

        return points.map(p => ({
            x: Math.round(Math.max(minX, Math.min(maxX, p.x))),
            y: Math.round(Math.max(minY, Math.min(maxY, p.y))),
        }));
    }

    /**
     * Sample a set of points and report their colours.
     *
     * @param {Array<{x: number, y: number}>} points where to sample
     * @param {Function} callback called with an array of {r,g,b} in 0..1
     */
    sample(points, callback) {
        if (!capabilities().pickColor || points.length === 0) {
            callback(null);
            return;
        }

        const shot = this._instance();
        if (!shot) {
            callback(null);
            return;
        }

        const token = this._token;
        const results = [];
        let pending = points.length;
        let finished = false;

        this._inFlight += 1;

        const done = () => {
            if (finished)
                return;
            finished = true;
            this._inFlight = Math.max(0, this._inFlight - 1);
            if (token !== this._token) {
                // The surface this was for has gone away.
                callback(null);
                return;
            }
            callback(results.length > 0 ? results : null);
        };

        for (const point of points) {
            let started = false;
            try {
                shot.pick_color(point.x, point.y, (source, result) => {
                    try {
                        const [ok, color] = source.pick_color_finish(result);
                        if (ok && color) {
                            // Cogl.Color components are uint8 (cogl-color.h).
                            results.push({
                                r: color.red / 255,
                                g: color.green / 255,
                                b: color.blue / 255,
                            });
                        }
                    } catch (e) {
                        Log.debug(`pick_color_finish: ${e}`);
                    }
                    pending -= 1;
                    if (pending <= 0)
                        done();
                });
                started = true;
            } catch (e) {
                Log.debug(`pick_color: ${e}`);
            }

            if (!started) {
                pending -= 1;
                if (pending <= 0)
                    done();
            }
        }

        if (pending <= 0)
            done();
    }

    destroy() {
        this.invalidate();
        this._screenshot = null;
    }
}

/**
 * Predict the luminance of the glass, given the backdrop behind it.
 *
 * This mirrors, in the same order, what the fragment shader does to the
 * backdrop before any text sits on top: desaturate/saturate around the video
 * luma, scale brightness, then mix toward the tint. Doing the prediction
 * analytically - rather than sampling the composited glass - is what keeps the
 * measurement independent of the text colour we are trying to choose.
 *
 * @param {{r: number, g: number, b: number}} backdrop sampled colour, 0..1
 * @param {object} material MaterialParams
 * @returns {{r: number, g: number, b: number}} predicted glass colour
 */
export function predictGlassColour(backdrop, material) {
    const lum = 0.2126 * backdrop.r + 0.7152 * backdrop.g + 0.0722 * backdrop.b;

    const sat = material.saturation;
    let r = lum + (backdrop.r - lum) * sat;
    let g = lum + (backdrop.g - lum) * sat;
    let b = lum + (backdrop.b - lum) * sat;

    r *= material.brightness;
    g *= material.brightness;
    b *= material.brightness;

    const [tr, tg, tb, ta] = material.tint;
    r = r + (tr - r) * ta;
    g = g + (tg - g) * ta;
    b = b + (tb - b) * ta;

    // The sheen adds a little light on the light-facing side; include a
    // fraction of it so a bright sheen does not surprise us.
    const sheenBias = material.sheen * 0.25;
    r = Math.min(1, Math.max(0, r + sheenBias));
    g = Math.min(1, Math.max(0, g + sheenBias));
    b = Math.min(1, Math.max(0, b + sheenBias));

    return {r, g, b};
}

/**
 * Turn a set of backdrop samples into the luminance the text will sit on.
 *
 * Uses the median rather than the mean: a sample ring can clip a bright window
 * border or a dark shadow, and one outlier should not swing the decision.
 *
 * @param {Array<{r: number, g: number, b: number}>} samples backdrop samples
 * @param {object} material MaterialParams
 * @returns {number} predicted relative luminance
 */
export function predictedLuminance(samples, material) {
    if (!samples || samples.length === 0)
        return 0;
    const predicted = samples.map(s => predictGlassColour(s, material));
    return medianLuminance(predicted);
}

/**
 * Relative luminance of a single colour, re-exported for callers that already
 * have a colour in hand.
 *
 * @param {{r: number, g: number, b: number}} c colour, 0..1
 * @returns {number} relative luminance
 */
export function luminanceOf(c) {
    return relativeLuminance(c);
}
