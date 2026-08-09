// Aqua Glass - compile the fragment shader for real.
//
// Assembles the shader exactly the way Cogl does at runtime (boilerplate from
// cogl-glsl-shader-boilerplate.h, then the per-layer declarations from
// cogl-pipeline-vertend-glsl.c, then the generated header with
// `uniform sampler2D cogl_sampler0`, then our snippet) and runs it through a
// real GLSL compiler.
//
// A shader that fails to link renders nothing, which looks exactly like "the
// extension does nothing" - so this check is the difference between guessing
// and knowing.
//
//     node tests/shader-compile.mjs

import {execFileSync} from 'node:child_process';
import {writeFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {DECLARATIONS, CODE} from '../src/lib/shader.js';

// From cogl-glsl-shader-boilerplate.h.
const COMMON = `#define COGL_VERSION 100

uniform mat4 cogl_modelview_matrix;
uniform mat4 cogl_modelview_projection_matrix;
uniform mat4 cogl_projection_matrix;
`;

const FRAGMENT_BOILERPLATE = `#ifdef GL_ES
precision highp float;
#endif
${COMMON}
varying vec4 _cogl_color;

#define cogl_color_in _cogl_color
#define cogl_tex_coord_in _cogl_tex_coord

#define cogl_color_out gl_FragColor
#define cogl_depth_out gl_FragDepth

#define cogl_front_facing gl_FrontFacing

#define cogl_point_coord gl_PointCoord
`;

// From cogl-pipeline-vertend-glsl.c: one layer, so one texture coordinate
// varying and the cogl_tex_coord0_in alias.
const LAYER_DECLARATIONS = `varying vec4 _cogl_tex_coord[1];
#define cogl_tex_coord0_in _cogl_tex_coord[0]
`;

// From cogl-pipeline-fragend-glsl.c add_layer_declaration_cb(), emitted into
// shader_state->header before any snippet declarations.
const SAMPLER_DECLARATIONS = `uniform sampler2D cogl_sampler0;
`;

/**
 * @param {string} version the #version token
 * @param {boolean} replace true to model add_glsl_snippet(..., is_replace=true)
 * @returns {string} the assembled fragment shader
 */
function build(version, replace) {
    // With is_replace = true our snippet IS the whole fragment body. With
    // false, cogl's generated processing runs first and leaves its result in
    // cogl_color_out, which our code then overwrites. Both must compile: the
    // extension uses the replace form, but a future change must not silently
    // break the other.
    const defaultProcessing = replace ? [] : [
        '  vec4 cogl_texel0 = texture2D(cogl_sampler0, cogl_tex_coord0_in.st);',
        '  cogl_color_out = cogl_texel0 * cogl_color_in;',
    ];

    return [
        `#version ${version}`,
        '',
        FRAGMENT_BOILERPLATE,
        LAYER_DECLARATIONS,
        SAMPLER_DECLARATIONS,
        DECLARATIONS,
        '',
        'void main()',
        '{',
        ...defaultProcessing,
        CODE,
        '}',
        '',
    ].join('\n');
}

const dir = mkdtempSync(join(tmpdir(), 'aqua-glsl-'));
let failed = 0;

// 120 is the realistic desktop-GL floor for the compatibility profile mutter
// uses; 100 is the GLES2 floor (glslang rejects a profile token below 150, so
// it is plain "100", with -DGL_ES supplied through the ES client flag).
const TARGETS = [
    {version: '120', replace: true, args: []},
    {version: '120', replace: false, args: []},
    {version: '100', replace: true, args: []},
];

for (const {version, replace, args} of TARGETS) {
    const source = build(version, replace);
    const label = `#version ${version} ${replace ? 'replace' : 'post'}`;
    const file = join(dir, `frag-${version}-${replace ? 'replace' : 'post'}.frag`);
    writeFileSync(file, source);

    process.stdout.write(`  ${label.padEnd(24)} `);
    try {
        execFileSync('glslangValidator', ['-S', 'frag', ...args, file], {stdio: 'pipe'});
        console.log('ok');
    } catch (e) {
        failed += 1;
        console.log('FAIL');
        const out = `${e.stdout || ''}${e.stderr || ''}`;
        for (const line of out.split('\n').filter(l => l.trim()).slice(0, 25))
            console.log(`      ${line}`);
        console.log(`      (full source: ${file})`);
    }
}

console.log(failed === 0
    ? '\nshader compiles cleanly'
    : `\n${failed} shader target(s) failed to compile`);
process.exit(failed === 0 ? 0 : 1);
