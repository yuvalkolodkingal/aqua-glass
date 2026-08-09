// Aqua Glass - one glass instance.
//
// A GlassSurface owns exactly one AquaGlassEffect and the small actor tree it
// renders into. Instances are expensive (a framebuffer each), so they are
// created rarely and RETARGETED often - see retarget(), which allocates
// nothing.
//
// The actor tree, and why it is shaped this way:
//
//   root        Clutter.Actor, positioned at the MONITOR ORIGIN and sized to
//               the MONITOR (architecture rule 3). Carries the glass effect.
//               Also carries a clip covering just the glass and its shadow, so
//               the framebuffer is only as large as the region we actually
//               draw - the coordinate system is unchanged, only the cost.
//     clipFrame Clutter.Actor sized to the glass rect plus a sampling margin,
//               clip_to_allocation. Carries the native blur, which in ACTOR
//               mode sizes its framebuffers from this actor's allocation - so
//               blur cost tracks the popup, not the screen.
//       backdrop Clutter.Clone of global.window_group, shifted so that the
//               absolute screen coordinates of the real windows land in the
//               right place inside the framebuffer.
//
// Cloning global.window_group (rather than assembling per-window clones) is
// deliberate: layout.js puts the wallpaper's Meta.BackgroundGroup inside
// window_group and lowers it to the bottom, so a single live clone gives us
// wallpaper plus every window, already in the correct stacking order, with no
// per-window bookkeeping and no sampling timer at all.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Log from './logger.js';
import {capabilities} from './compat.js';
import {AquaGlassEffect, stats} from './glassEffect.js';

export class GlassSurface {
    /**
     * @param {string} name diagnostic label, e.g. 'shared-popup' or 'panel'
     */
    constructor(name) {
        this._name = name;
        this._root = null;
        this._clipFrame = null;
        this._backdrop = null;
        this._effect = null;
        this._blur = null;
        this._built = false;
        this._destroyed = false;
        this._monitor = null;
        this._material = null;
    }

    get name() {
        return this._name;
    }

    get actor() {
        return this._root;
    }

    get isBuilt() {
        return this._built && !this._destroyed;
    }

    /**
     * Create the actor tree and the single effect.
     *
     * @returns {boolean} true if the surface is usable
     */
    build() {
        if (this._built || this._destroyed)
            return this._built;

        try {
            this._root = new Clutter.Actor({
                name: `aqua-glass-${this._name}`,
                reactive: false,
            });
            // Belt and braces: even with an explicit clip, never let a child's
            // paint volume inflate the framebuffer.
            this._root.set_clip_to_allocation(true);

            this._clipFrame = new Clutter.Actor({
                name: `aqua-glass-${this._name}-clip`,
                reactive: false,
            });
            this._clipFrame.set_clip_to_allocation(true);

            this._backdrop = new Clutter.Clone({
                source: global.window_group,
                reactive: false,
            });

            this._clipFrame.add_child(this._backdrop);
            this._root.add_child(this._clipFrame);

            this._effect = new AquaGlassEffect();
            this._root.add_effect(this._effect);

            if (capabilities().blurEffect) {
                try {
                    this._blur = new Shell.BlurEffect({
                        mode: Shell.BlurMode.ACTOR,
                        brightness: 1.0,
                        radius: 24,
                    });
                    this._clipFrame.add_effect(this._blur);
                } catch (e) {
                    Log.error(e, 'add blur effect');
                    this._blur = null;
                }
            }

            this._root.hide();
            this._built = true;
            return true;
        } catch (e) {
            Log.error(e, `GlassSurface(${this._name}).build`);
            this._teardownActors();
            return false;
        }
    }

    /**
     * Apply material settings.
     *
     * @param {object} material a MaterialParams object from settings.js
     */
    setMaterial(material) {
        this._material = material;
        if (!this._effect)
            return;

        const useNative = !!this._blur && material.nativeBlur;

        this._effect.setParams({
            cornerRadius: material.cornerRadius,
            bevelWidth: material.bevelWidth,
            ior: material.ior,
            refraction: material.refraction,
            chromatic: material.chromatic,
            tint: material.tint,
            saturation: material.saturation,
            brightness: material.brightness,
            lightVec: material.lightVec,
            specular: material.specularEnabled ? material.specular : 0,
            shininess: material.shininess,
            sheen: material.sheen,
            fresnel: material.fresnel,
            shadowOpacity: material.shadowEnabled ? material.shadowOpacity : 0,
            shadowRadius: material.shadowRadius,
            shadowOffset: material.shadowOffset,
            // If the native blur is unavailable the shader does its own, which
            // is why this is a uniform rather than a compile-time branch: the
            // pipeline is built once per class and cannot be rebuilt.
            fallbackBlur: useNative ? 0 : material.blurSigma,
        });

        if (this._blur) {
            try {
                // ShellBlurEffect's `radius` is passed straight through as the
                // Gaussian sigma (clutter_blur_node_new -> ClutterBlur sigma).
                // Identical property in 48, 49 and 50 - there is no `sigma`
                // property to prefer.
                const sigma = Math.max(0, Math.round(material.blurSigma));
                this._blur.enabled = useNative && sigma > 0;
                if (sigma > 0)
                    this._blur.radius = sigma;
            } catch (e) {
                Log.error(e, 'set blur radius');
            }
        }
    }

    /**
     * Point this glass at a new place on screen.
     *
     * This is the hot path for transient popups, and it must not allocate: no
     * new actors, no new effects, no new framebuffers. Only positions, sizes
     * and uniform values change. That is the whole reason a single shared
     * instance can serve every popup in the shell.
     *
     * @param {object} monitor monitor geometry {x, y, width, height}
     * @param {object} rect glass rectangle in ABSOLUTE stage coordinates
     * @param {number} cornerRadius corner radius in pixels
     * @returns {boolean} true if geometry was applied
     */
    retarget(monitor, rect, cornerRadius) {
        if (!this.isBuilt || !monitor || !rect)
            return false;
        if (!(rect.width > 0) || !(rect.height > 0))
            return false;

        try {
            const m = this._material;

            // How far outside the glass we must have real backdrop pixels:
            // enough for the blur kernel to be fully populated, plus the
            // furthest a refracted ray can reach.
            const sampleMargin = m
                ? Math.ceil(3 * m.blurSigma + 2.5 * m.refraction * m.bevelWidth + 8)
                : 96;

            // How far outside the glass we actually draw: the shadow.
            const shadowMargin = m && m.shadowEnabled
                ? Math.ceil(m.shadowRadius + m.shadowOffset + 4)
                : 8;

            const localX = rect.x - monitor.x;
            const localY = rect.y - monitor.y;

            // --- backdrop sampling frame (monitor-local, clamped) ---
            const sx = Math.max(0, Math.floor(localX - sampleMargin));
            const sy = Math.max(0, Math.floor(localY - sampleMargin));
            const sx2 = Math.min(monitor.width, Math.ceil(localX + rect.width + sampleMargin));
            const sy2 = Math.min(monitor.height, Math.ceil(localY + rect.height + sampleMargin));
            const sw = Math.max(1, sx2 - sx);
            const sh = Math.max(1, sy2 - sy);

            // --- render clip (monitor-local, clamped) ---
            const rx = Math.max(0, Math.floor(localX - shadowMargin));
            const ry = Math.max(0, Math.floor(localY - shadowMargin));
            const rx2 = Math.min(monitor.width, Math.ceil(localX + rect.width + shadowMargin));
            const ry2 = Math.min(monitor.height, Math.ceil(localY + rect.height + shadowMargin));
            const rw = Math.max(1, rx2 - rx);
            const rh = Math.max(1, ry2 - ry);

            // Rule 3: the effect actor covers the monitor, at the monitor
            // origin. Never the popup's own size.
            this._root.set_position(monitor.x, monitor.y);
            this._root.set_size(monitor.width, monitor.height);
            this._root.set_clip(rx, ry, rw, rh);

            this._clipFrame.set_position(sx, sy);
            this._clipFrame.set_size(sw, sh);

            // Rule 3 again: shift the clone so that absolute screen
            // coordinates land correctly inside the framebuffer. The clone's
            // local origin sits at absolute (monitor.x + sx, monitor.y + sy).
            this._backdrop.set_position(-(monitor.x + sx), -(monitor.y + sy));

            this._effect.setGeometry(
                [localX, localY, rect.width, rect.height],
                [sx, sy, sw, sh],
                cornerRadius);

            this._monitor = monitor;
            return true;
        } catch (e) {
            Log.error(e, `GlassSurface(${this._name}).retarget`);
            return false;
        }
    }

    /** @param {boolean} visible whether the glass should be shown */
    setVisible(visible) {
        if (!this.isBuilt)
            return;
        try {
            if (visible)
                this._root.show();
            else
                this._root.hide();
        } catch (e) {
            Log.error(e, `GlassSurface(${this._name}).setVisible`);
        }
    }

    /** @returns {boolean} whether the glass actor is currently visible */
    get visible() {
        try {
            return !!this._root && this._root.visible;
        } catch {
            return false;
        }
    }

    /**
     * Reparent the glass so it sits directly beneath `sibling`.
     *
     * @param {Clutter.Actor} parent the container to live in
     * @param {Clutter.Actor} sibling the actor to sit below
     * @returns {boolean} true on success
     */
    placeBelow(parent, sibling) {
        if (!this.isBuilt || !parent)
            return false;
        try {
            const current = this._root.get_parent();
            if (current !== parent) {
                if (current)
                    current.remove_child(this._root);
                parent.add_child(this._root);
            }
            if (sibling && sibling.get_parent() === parent)
                parent.set_child_below_sibling(this._root, sibling);
            return true;
        } catch (e) {
            Log.error(e, `GlassSurface(${this._name}).placeBelow`);
            return false;
        }
    }

    /** Detach from whatever container currently holds the glass. */
    unparent() {
        if (!this._root)
            return;
        try {
            const parent = this._root.get_parent();
            if (parent)
                parent.remove_child(this._root);
        } catch (e) {
            Log.error(e, `GlassSurface(${this._name}).unparent`);
        }
    }

    /**
     * Approximate framebuffer footprint, for the self-check report.
     *
     * @returns {number} bytes
     */
    estimatedBytes() {
        if (!this.isBuilt)
            return 0;
        try {
            let w = 0;
            let h = 0;
            if (this._root.has_clip()) {
                const [, , cw, ch] = this._root.get_clip();
                w = cw;
                h = ch;
            } else {
                w = this._root.width;
                h = this._root.height;
            }
            let bytes = Math.max(0, (w + 3) * (h + 3) * 4);
            if (this._blur && this._blur.enabled) {
                // Two working framebuffers plus the source copy, over the
                // clip frame's area.
                bytes += this._clipFrame.width * this._clipFrame.height * 4 * 3;
            }
            return Math.round(bytes);
        } catch {
            return 0;
        }
    }

    _teardownActors() {
        try {
            if (this._blur && this._clipFrame)
                this._clipFrame.remove_effect(this._blur);
        } catch { /* ignore */ }
        this._blur = null;

        try {
            if (this._effect && this._root)
                this._root.remove_effect(this._effect);
        } catch { /* ignore */ }

        if (this._effect) {
            try {
                this._effect.noteDestroyed();
            } catch { /* ignore */ }
        }
        this._effect = null;

        // Destroying the root destroys the clip frame and the clone with it.
        try {
            if (this._root)
                this._root.destroy();
        } catch { /* ignore */ }

        this._root = null;
        this._clipFrame = null;
        this._backdrop = null;
    }

    /** Destroy the surface. Safe to call more than once. */
    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._built = false;
        this._teardownActors();
    }

    /**
     * @returns {object} diagnostic snapshot for the self-check
     */
    describe() {
        let geometry = null;
        try {
            if (this._root) {
                geometry = {
                    pos: `${Math.round(this._root.x)},${Math.round(this._root.y)}`,
                    size: `${Math.round(this._root.width)}x${Math.round(this._root.height)}`,
                    clip: this._root.has_clip()
                        ? this._root.get_clip().map(Math.round).join(',')
                        : 'none',
                    parented: !!this._root.get_parent(),
                    opacity: this._root.opacity,
                };
            }
        } catch { /* ignore */ }

        return {
            name: this._name,
            built: this.isBuilt,
            visible: this.visible,
            nativeBlur: !!this._blur && !!this._blur.enabled,
            bytes: this.estimatedBytes(),
            geometry,
            // What the shader was last handed. If the glass looks wrong, this
            // says whether the geometry or the shader is at fault.
            mapping: this._effect?._lastMapping ?? null,
            monitor: this._monitor
                ? `${this._monitor.width}x${this._monitor.height}+${this._monitor.x}+${this._monitor.y}`
                : 'none',
        };
    }
}

/** @returns {object} live effect counters */
export function effectStats() {
    return {...stats};
}
