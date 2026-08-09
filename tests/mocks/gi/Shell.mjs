import {Emitter, Actor, bookkeeping} from '../core.mjs';

// Tracks how many times each concrete effect class had its pipeline built.
// ShellGLSLEffect builds `klass->base_pipeline` once per CLASS, so the
// extension must not depend on per-instance state inside build_pipeline.
export const pipelineBuilds = new Map();

export const glslStats = {
    instances: 0,
    snippets: [],
    uniformSets: [],
};

class GLSLEffect extends Emitter {
    constructor(...args) {
        super();
        this._actor = null;
        this._uniformNames = new Map();
        this._nextLocation = 1;
        glslStats.instances += 1;

        this._init(...args);

        // Mirror shell_glsl_effect_constructed(): build_pipeline runs once per
        // class, for the first instance only.
        const key = this.constructor;
        if (!pipelineBuilds.has(key)) {
            pipelineBuilds.set(key, 0);
            if (typeof this.vfunc_build_pipeline === 'function') {
                this.vfunc_build_pipeline();
                pipelineBuilds.set(key, 1);
            }
        }
    }

    _init() {}

    add_glsl_snippet(hook, declarations, code, isReplace) {
        if (hook === undefined || hook === null)
            throw new Error('add_glsl_snippet: hook is undefined');
        if (typeof declarations !== 'string' || typeof code !== 'string')
            throw new Error('add_glsl_snippet: declarations and code must be strings');
        glslStats.snippets.push({hook, declarations, code, isReplace});
    }

    get_uniform_location(name) {
        if (!this._uniformNames.has(name))
            this._uniformNames.set(name, this._nextLocation++);
        return this._uniformNames.get(name);
    }

    set_uniform_float(location, components, values) {
        if (typeof location !== 'number')
            throw new Error('set_uniform_float: location must be a number');
        if (!Array.isArray(values))
            throw new Error('set_uniform_float: values must be an array');
        if (values.length % components !== 0) {
            throw new Error(
                `set_uniform_float: ${values.length} floats is not a multiple ` +
                `of ${components} components`);
        }
        for (const v of values) {
            if (typeof v !== 'number' || Number.isNaN(v))
                throw new Error(`set_uniform_float: non-numeric value ${v}`);
        }
        glslStats.uniformSets.push({location, components, values});
    }

    get_actor() {
        return this._actor;
    }

    get_texture() {
        // A monitor-sized actor clipped to (w+3, h+3) at scale 1.
        const actor = this._actor;
        if (!actor)
            return null;
        const [, , cw, ch] = actor.has_clip()
            ? actor.get_clip()
            : [0, 0, actor.width, actor.height];
        return {
            get_width: () => Math.round(cw) + 3,
            get_height: () => Math.round(ch) + 3,
        };
    }

    vfunc_paint_target() {}
}

class BlurEffect extends Emitter {
    constructor(params = {}) {
        super();
        this.mode = params.mode ?? 0;
        this.brightness = params.brightness ?? 1;
        this.radius = params.radius ?? 0;
        this.enabled = true;
        this._actor = null;
    }
}

class Screenshot extends Emitter {
    pick_color(x, y, callback) {
        if (typeof callback !== 'function')
            throw new Error('pick_color: expected a callback');
        // Fire asynchronously, as the real API does.
        queueMicrotask(() => callback(this, {x, y}));
    }

    pick_color_finish() {
        return [true, {red: 40, green: 40, blue: 40, alpha: 255}];
    }
}

export default {
    GLSLEffect,
    BlurEffect,
    BlurMode: {ACTOR: 0, BACKGROUND: 1},
    Screenshot,
    Stack: class Stack extends Actor {},
};
