// Aqua Glass - the Shell.GLSLEffect subclass.
//
// Architecture rule 1: there is one shared instance of this effect for every
// transient popup in the shell, plus at most one per always-visible surface.
// The counters below exist so selfcheck.js can *prove* that, rather than
// asserting it. A full-monitor offscreen framebuffer per menu is what drove
// gnome-shell to 2.3 GB and ended the session.

import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';

import * as Log from './logger.js';
import {DECLARATIONS, CODE} from './shader.js';

/**
 * Lifetime counters, for the self-check. `created` never decreases, so a leak
 * shows up as created > destroyed + live.
 */
export const stats = {
    created: 0,
    destroyed: 0,
    live: 0,
    paints: 0,
};

/**
 * Anything add_glsl_snippet() threw. A shader that fails to build renders
 * nothing, which is indistinguishable from "the extension does nothing" - so
 * the self-check reports this explicitly rather than leaving it silent.
 */
export const buildFailures = [];

/** Reset counters (called from enable()). */
export function resetStats() {
    stats.created = 0;
    stats.destroyed = 0;
    stats.live = 0;
    stats.paints = 0;
    buildFailures.length = 0;
}

const DEFAULT_PARAMS = {
    rect: [0, 0, 100, 100],
    clip: [0, 0, 100, 100],
    cornerRadius: 18,
    bevelWidth: 22,
    ior: 1.5,
    refraction: 0.55,
    chromatic: 0.30,
    tint: [1, 1, 1, 0.10],
    saturation: 1.15,
    brightness: 1.02,
    lightVec: [-0.7071, -0.7071],
    specular: 0.55,
    shininess: 48,
    sheen: 0.35,
    fresnel: 0.45,
    shadowOpacity: 0.28,
    shadowRadius: 32,
    shadowOffset: 10,
    fallbackBlur: 0,
    useBackdrop: false,
};

export const AquaGlassEffect = GObject.registerClass(
class AquaGlassEffect extends Shell.GLSLEffect {
    _init(params = {}) {
        super._init();

        this._params = Object.assign({}, DEFAULT_PARAMS, params);
        this._locations = null;
        this._warnedNoLocations = false;

        stats.created += 1;
        stats.live += 1;
    }

    /**
     * Attach the fragment snippet.
     *
     * Called once per *class* by ShellGLSLEffect, not once per instance, which
     * is precisely why every tunable is a uniform rather than baked into the
     * source string.
     */
    vfunc_build_pipeline() {
        try {
            // is_replace = TRUE: our snippet replaces cogl's generated
            // fragment processing entirely.
            //
            // We do our own texture2D() lookups (refraction samples at
            // displaced coordinates), so the default per-layer lookup is dead
            // work whose only effect is to make the final colour depend on
            // pipeline state we do not control. Replacing it means the shader
            // is exactly what shader.js says it is. This is the form
            // gnome-shell's own lightbox.js and messageList.js effects use.
            this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, true);
            this._pipelineBuilt = true;
        } catch (e) {
            Log.error(e, 'build_pipeline');
            buildFailures.push(String(e));
        }
    }

    /**
     * Replace some or all material parameters.
     *
     * @param {object} params partial parameter set
     */
    setParams(params) {
        Object.assign(this._params, params);
    }

    /**
     * Set the glass geometry.
     *
     * Architecture rule 3: the effect actor covers the whole monitor, and the
     * glass rectangle is passed separately in MONITOR-LOCAL coordinates. A
     * popup-sized actor would put the window clones - which live at absolute
     * screen coordinates - entirely outside the framebuffer, and the glass
     * would render as a grey rectangle.
     *
     * @param {number[]} rect [x, y, w, h] in monitor-local pixels
     * @param {number[]} clip [x, y, w, h] backdrop sampling clamp
     * @param {number} cornerRadius corner radius in pixels
     */
    setGeometry(rect, clip, cornerRadius) {
        this._params.rect = rect;
        this._params.clip = clip;
        if (cornerRadius !== undefined && cornerRadius !== null)
            this._params.cornerRadius = cornerRadius;
    }

    _cacheLocations() {
        if (this._locations)
            return this._locations;

        const names = [
            'agLocalOrigin', 'agLocalSize', 'agRect', 'agClip', 'agCorner',
            'agRefr', 'agTint', 'agGrade', 'agLight', 'agSheenFresnel',
            'agShadow', 'agFallbackBlur', 'agUseBackdrop',
        ];

        const loc = {};
        for (const name of names) {
            try {
                loc[name] = this.get_uniform_location(name);
            } catch (e) {
                Log.error(e, `get_uniform_location(${name})`);
                loc[name] = -1;
            }
        }
        this._locations = loc;
        return loc;
    }

    _set(loc, components, values) {
        if (loc === undefined || loc < 0)
            return;
        try {
            this.set_uniform_float(loc, components, values);
        } catch (e) {
            Log.error(e, 'set_uniform_float');
        }
    }

    /**
     * Work out how the framebuffer's texture coordinates map onto actor-local
     * pixels.
     *
     * ClutterOffscreenEffect does not size its framebuffer to the actor's
     * allocation - it sizes it to the actor's *paint volume*, then pads that
     * box for stability (clutter-actor-box.c: x2 = ceil(x2 + 0.75),
     * x1 = x2 - width - 3). So the texture is about 3px wider than the actor
     * and its origin sits ~2px outside. Ignoring this shifts the entire glass
     * rectangle by a couple of pixels relative to the popup it is meant to sit
     * behind.
     *
     * We prefer the real texture size when we can read it, and fall back to
     * the analytic form otherwise.
     *
     * Note the clip handling. The glass actor keeps its full-monitor
     * allocation (rule 3), but carries a clip covering only the glass
     * rectangle plus its shadow margin. clutter_actor_real_get_paint_volume()
     * returns the clip rectangle verbatim when one is set, so the framebuffer
     * shrinks to the region that actually has glass in it. That keeps an
     * always-visible surface from clearing and rasterising a full-monitor
     * quad on every frame, without changing the coordinate system the shader
     * works in one bit - because we derive the mapping from the paint volume
     * rather than assuming it.
     *
     * @param {Clutter.Actor} actor the effect's actor
     * @returns {{origin: number[], size: number[]}} mapping
     */
    _computeMapping(actor) {
        let boxX = 0;
        let boxY = 0;
        let boxW = 0;
        let boxH = 0;

        let hasClip = false;
        try {
            hasClip = actor.has_clip();
        } catch {
            hasClip = false;
        }

        if (hasClip) {
            try {
                const [cx, cy, cw, ch] = actor.get_clip();
                boxX = cx;
                boxY = cy;
                boxW = cw;
                boxH = ch;
            } catch {
                hasClip = false;
            }
        }

        if (!hasClip) {
            try {
                const box = actor.get_allocation_box();
                boxW = box.get_width();
                boxH = box.get_height();
            } catch {
                try {
                    boxW = actor.width;
                    boxH = actor.height;
                } catch {
                    boxW = 0;
                    boxH = 0;
                }
            }
        }

        if (!(boxW > 0) || !(boxH > 0))
            return {origin: [0, 0], size: [1, 1]};

        // Mirror _clutter_actor_box_enlarge_for_effects(): the width is
        // rounded to a stable integer, the bottom-right is ceil'd with 0.75
        // slack, and the top-left is then redefined as (bottom right - width
        // - 3) so the box size does not wobble with sub-pixel position.
        const w = Math.round(boxW);
        const h = Math.round(boxH);
        const x2 = Math.ceil(boxX + boxW + 0.75);
        const y2 = Math.ceil(boxY + boxH + 0.75);
        const originX = x2 - w - 3;
        const originY = y2 - h - 3;

        let sizeW = w + 3;
        let sizeH = h + 3;

        try {
            const tex = this.get_texture();
            if (tex) {
                let scale = 1;
                try {
                    scale = Math.ceil(actor.get_resource_scale() || 1);
                } catch {
                    scale = 1;
                }
                if (scale >= 1) {
                    const tw = tex.get_width() / scale;
                    const th = tex.get_height() / scale;
                    if (tw > 0 && th > 0) {
                        sizeW = tw;
                        sizeH = th;
                    }
                }
            }
        } catch {
            // Keep the analytic fallback.
        }

        return {origin: [originX, originY], size: [sizeW, sizeH]};
    }

    vfunc_paint_target(node, paintContext) {
        // Counting paints separates "the effect never ran" (actor hidden,
        // zero-sized, culled, or the framebuffer could not be created) from
        // "the effect ran but drew nothing" (a shader problem). Without this
        // the two are indistinguishable from outside, and they have completely
        // different fixes.
        stats.paints += 1;

        try {
            const actor = this.get_actor();
            if (actor) {
                const loc = this._cacheLocations();
                const p = this._params;
                const {origin, size} = this._computeMapping(actor);

                // Kept for the self-check so the geometry the shader actually
                // received can be inspected at runtime.
                this._lastMapping = {origin, size, rect: p.rect, clip: p.clip};

                this._set(loc.agLocalOrigin, 2, origin);
                this._set(loc.agLocalSize, 2, size);
                this._set(loc.agRect, 4, p.rect);
                this._set(loc.agClip, 4, p.clip);
                this._set(loc.agCorner, 2, [p.cornerRadius, p.bevelWidth]);
                this._set(loc.agRefr, 3, [p.ior, p.refraction, p.chromatic]);
                this._set(loc.agTint, 4, p.tint);
                this._set(loc.agGrade, 2, [p.saturation, p.brightness]);
                this._set(loc.agLight, 4, [
                    p.lightVec[0], p.lightVec[1], p.specular, p.shininess,
                ]);
                this._set(loc.agSheenFresnel, 2, [p.sheen, p.fresnel]);
                this._set(loc.agShadow, 3, [
                    p.shadowOpacity, p.shadowRadius, p.shadowOffset,
                ]);
                this._set(loc.agFallbackBlur, 1, [p.fallbackBlur]);
                this._set(loc.agUseBackdrop, 1, [p.useBackdrop ? 1 : 0]);
            }
        } catch (e) {
            Log.error(e, 'paint_target uniforms');
        }

        // Always chain up, even if setting uniforms failed - otherwise the
        // actor simply vanishes instead of merely looking wrong.
        super.vfunc_paint_target(node, paintContext);
    }

    /**
     * Note the instance's death for the self-check.
     *
     * GObject may finalize us without an explicit call, so this is idempotent.
     */
    noteDestroyed() {
        if (this._counted)
            return;
        this._counted = true;
        stats.destroyed += 1;
        stats.live = Math.max(0, stats.live - 1);
    }
});
