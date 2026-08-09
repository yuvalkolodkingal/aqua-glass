// Aqua Glass - one glass instance.
//
// TWO LAYERS, and the split matters.
//
//   root        plain container, monitor-sized at the monitor origin. No effect.
//     base      St.Widget the size of the glass rectangle. Carries
//               Shell.BlurEffect in BACKGROUND mode plus a translucent tint,
//               rounded corners, a hairline border and a soft drop shadow, all
//               as ordinary St styling.
//     material  monitor-sized, clipped, carrying the AquaGlassEffect. Adds the
//               light - specular, Fresnel rim, directional sheen - over the top.
//
// Why this way round. BACKGROUND-mode blur reads the real framebuffer behind
// the actor (shell-blur-effect.c update_actor_box), so it needs no clone, no
// coordinate arithmetic, and no offscreen framebuffer of our own. It is the
// mechanism Blur My Shell uses for exactly these surfaces, and it renders even
// if everything else here fails. The base layer alone is already a credible
// frosted-glass surface; the shader layer is additive polish on top of it.
//
// The previous design put the entire appearance behind a Clutter.Clone of
// global.window_group inside an offscreen framebuffer. If that clone produced
// nothing, the surface rendered nothing at all - a menu with no background,
// text floating on the wallpaper. Two things make that fragile:
// clutter_clone_allocate() SCALES the source to fill the clone's allocation
// (x_scale = clone_box / source_box), and a Clone takes its size from the
// source's *preferred* size, which is not the same as the source's allocation.
// Refraction genuinely needs that clone, so it is still available, but it is
// now opt-in and it can no longer take the whole surface down with it.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

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
        this._base = null;
        this._material = null;
        this._clipFrame = null;
        this._backdrop = null;
        this._effect = null;
        this._blur = null;
        this._built = false;
        this._destroyed = false;
        this._monitor = null;
        this._params = null;
        this._refraction = false;
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

            // ---- layer 1: the surface itself -------------------------------
            this._base = new St.Widget({
                name: `aqua-glass-${this._name}-base`,
                reactive: false,
            });
            this._root.add_child(this._base);

            if (capabilities().blurEffect) {
                try {
                    this._blur = new Shell.BlurEffect({
                        // BACKGROUND reads what is actually behind the actor,
                        // so there is nothing to clone and nothing to align.
                        mode: Shell.BlurMode.BACKGROUND,
                        brightness: 1.0,
                        radius: 24,
                    });
                    // QuickSettings already owns an effect named 'dim' on its
                    // box pointer, so ours is explicitly namespaced.
                    this._base.add_effect_with_name('aqua-glass-blur', this._blur);
                } catch (e) {
                    Log.error(e, 'add background blur');
                    this._blur = null;
                }
            }

            // ---- layer 2: the light ----------------------------------------
            this._material = new Clutter.Actor({
                name: `aqua-glass-${this._name}-material`,
                reactive: false,
            });
            this._material.set_clip_to_allocation(true);
            this._root.add_child(this._material);

            this._effect = new AquaGlassEffect();
            this._material.add_effect_with_name('aqua-glass-material', this._effect);

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
     * Turn refraction on or off.
     *
     * Refraction has to sample the backdrop, which means a live clone of
     * global.window_group inside our own framebuffer. Everything else works
     * without it.
     *
     * @param {boolean} enabled whether to build and use the clone
     */
    setRefraction(enabled) {
        if (!this.isBuilt || this._refraction === !!enabled)
            return;
        this._refraction = !!enabled;

        if (!this._refraction) {
            try {
                if (this._clipFrame)
                    this._clipFrame.destroy();
            } catch { /* ignore */ }
            this._clipFrame = null;
            this._backdrop = null;
            this._effect?.setParams({useBackdrop: false});
            return;
        }

        try {
            this._clipFrame = new Clutter.Actor({
                name: `aqua-glass-${this._name}-clip`,
                reactive: false,
            });
            this._clipFrame.set_clip_to_allocation(true);

            this._backdrop = new Clutter.Clone({
                source: global.window_group,
                reactive: false,
            });
            this._syncCloneSize();

            this._clipFrame.add_child(this._backdrop);
            this._material.add_child(this._clipFrame);
            this._effect.setParams({useBackdrop: true});
        } catch (e) {
            Log.error(e, `GlassSurface(${this._name}).setRefraction`);
            this._refraction = false;
            this._effect?.setParams({useBackdrop: false});
        }
    }

    /**
     * Pin the clone to the source's ALLOCATION size.
     *
     * clutter_clone_allocate() computes
     *     x_scale = clone_allocation_width / source_allocation_width
     * and scales everything the source paints by it. A Clone's default
     * preferred size is the source's *preferred* size, which for
     * global.window_group is the union of its children's preferred sizes - not
     * its allocation. Left alone, the backdrop is silently drawn at the wrong
     * scale, and if the source has not been allocated yet the ratio is a
     * division by zero. Forcing the sizes equal makes the scale exactly 1.
     */
    _syncCloneSize() {
        if (!this._backdrop)
            return;
        try {
            const box = global.window_group.get_allocation_box();
            const w = box.get_width();
            const h = box.get_height();
            if (w > 0 && h > 0)
                this._backdrop.set_size(w, h);
        } catch (e) {
            Log.debug(`clone size sync: ${e}`);
        }
    }

    /**
     * Apply material settings.
     *
     * @param {object} material a MaterialParams object from settings.js
     */
    setMaterial(material) {
        this._params = material;
        if (!this.isBuilt)
            return;

        this.setRefraction(material.refraction3d);

        const useNative = !!this._blur;

        if (this._effect) {
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
                // The base layer draws the drop shadow with a real box-shadow,
                // so the shader must not draw a second one on top of it.
                shadowOpacity: 0,
                shadowRadius: material.shadowRadius,
                shadowOffset: material.shadowOffset,
                fallbackBlur: (this._refraction && !useNative) ? material.blurSigma : 0,
                useBackdrop: this._refraction,
            });
        }

        if (this._blur) {
            try {
                // ShellBlurEffect's `radius` is passed straight through as the
                // Gaussian sigma. Identical in 48, 49 and 50; there is no
                // `sigma` property to prefer.
                const sigma = Math.max(0, Math.round(material.blurSigma));
                this._blur.enabled = sigma > 0;
                if (sigma > 0)
                    this._blur.radius = sigma;
                // Dark glass darkens what is behind it a little, exactly as
                // Apple's dark material does; light glass leaves it alone.
                this._blur.brightness = material.isDark ? 0.82 : 1.0;
            } catch (e) {
                Log.error(e, 'set blur radius');
            }
        }
    }

    /**
     * The base layer's styling: the part of the material that St can draw
     * directly, and therefore the part that always survives.
     *
     * @param {number} radius corner radius in pixels
     * @returns {string} inline CSS
     */
    _baseStyle(radius) {
        const m = this._params;
        const [r, g, b] = m ? m.tint : [1, 1, 1];
        const to255 = v => Math.round(Math.max(0, Math.min(1, v)) * 255);

        // A floor under the tint alpha. Without it a "subtle" setting plus a
        // blur that did not load leaves text floating on bare wallpaper.
        const alpha = m ? Math.max(0.10, Math.min(0.75, m.baseOpacity)) : 0.38;

        const shadowAlpha = m && m.shadowEnabled ? m.shadowOpacity : 0;
        const shadowBlur = m ? m.shadowRadius : 32;
        const shadowY = m ? Math.round(m.shadowOffset * 0.6) : 6;

        // On dark glass the rim is a faint light catch; on light glass a
        // slightly stronger one - both hairline, never a drawn outline.
        const rimAlpha = m && m.isDark ? 0.12 : 0.22;

        return [
            `background-color: rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${alpha.toFixed(3)});`,
            `border-radius: ${Math.max(0, Math.round(radius))}px;`,
            `border: 1px solid rgba(255, 255, 255, ${rimAlpha});`,
            shadowAlpha > 0
                ? `box-shadow: 0 ${shadowY}px ${Math.round(shadowBlur)}px rgba(0, 0, 0, ${shadowAlpha.toFixed(3)});`
                : '',
        ].join(' ');
    }

    /**
     * Point this glass at a new place on screen.
     *
     * Must not allocate: no new actors, no new effects, no new framebuffers.
     * Only positions, sizes, styles and uniform values change.
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
            const m = this._params;
            const localX = rect.x - monitor.x;
            const localY = rect.y - monitor.y;

            // Container: monitor-sized, at the monitor origin (rule 3).
            this._root.set_position(monitor.x, monitor.y);
            this._root.set_size(monitor.width, monitor.height);

            // Layer 1 sits exactly on the surface.
            this._base.set_position(localX, localY);
            this._base.set_size(rect.width, rect.height);
            this._base.set_style(this._baseStyle(cornerRadius));

            // Layer 2 keeps the monitor-sized frame the shader's coordinate
            // model is written against, clipped to the drawn region so the
            // framebuffer stays small.
            const margin = m && m.shadowEnabled
                ? Math.ceil(m.shadowRadius + m.shadowOffset + 4)
                : 8;
            const rx = Math.max(0, Math.floor(localX - margin));
            const ry = Math.max(0, Math.floor(localY - margin));
            const rx2 = Math.min(monitor.width, Math.ceil(localX + rect.width + margin));
            const ry2 = Math.min(monitor.height, Math.ceil(localY + rect.height + margin));

            this._material.set_position(0, 0);
            this._material.set_size(monitor.width, monitor.height);
            this._material.set_clip(rx, ry, Math.max(1, rx2 - rx), Math.max(1, ry2 - ry));

            // Backdrop sampling frame, only when refraction is on.
            let clip = [rx, ry, Math.max(1, rx2 - rx), Math.max(1, ry2 - ry)];
            if (this._refraction && this._clipFrame) {
                const sample = m
                    ? Math.ceil(3 * m.blurSigma + 2.5 * m.refraction * m.bevelWidth + 8)
                    : 96;
                const sx = Math.max(0, Math.floor(localX - sample));
                const sy = Math.max(0, Math.floor(localY - sample));
                const sx2 = Math.min(monitor.width, Math.ceil(localX + rect.width + sample));
                const sy2 = Math.min(monitor.height, Math.ceil(localY + rect.height + sample));
                const sw = Math.max(1, sx2 - sx);
                const sh = Math.max(1, sy2 - sy);

                this._clipFrame.set_position(sx, sy);
                this._clipFrame.set_size(sw, sh);

                // Shift the clone so absolute screen coordinates land in the
                // right place: its local origin is at (monitor.x + sx, ...).
                this._syncCloneSize();
                this._backdrop.set_position(-(monitor.x + sx), -(monitor.y + sy));
                clip = [sx, sy, sw, sh];
            }

            this._effect.setGeometry(
                [localX, localY, rect.width, rect.height], clip, cornerRadius);

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
            let bytes = 0;
            if (this._material.has_clip()) {
                const [, , cw, ch] = this._material.get_clip();
                bytes += Math.max(0, (cw + 3) * (ch + 3) * 4);
            }
            if (this._blur && this._blur.enabled)
                bytes += this._base.width * this._base.height * 4 * 3;
            return Math.round(bytes);
        } catch {
            return 0;
        }
    }

    _teardownActors() {
        try {
            if (this._blur && this._base)
                this._base.remove_effect(this._blur);
        } catch { /* ignore */ }
        this._blur = null;

        try {
            if (this._effect && this._material)
                this._material.remove_effect(this._effect);
        } catch { /* ignore */ }

        if (this._effect) {
            try {
                this._effect.noteDestroyed();
            } catch { /* ignore */ }
        }
        this._effect = null;

        try {
            if (this._root)
                this._root.destroy();
        } catch { /* ignore */ }

        this._root = null;
        this._base = null;
        this._material = null;
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
                    base: this._base
                        ? `${Math.round(this._base.x)},${Math.round(this._base.y)} ` +
                          `${Math.round(this._base.width)}x${Math.round(this._base.height)}`
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
            refraction: this._refraction,
            bytes: this.estimatedBytes(),
            geometry,
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
