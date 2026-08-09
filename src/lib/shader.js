// Aqua Glass - the material.
//
// This is a single fragment snippet attached with Cogl.SnippetHook.FRAGMENT.
// A few hard constraints shape everything below; they were read out of the
// mutter/cogl sources rather than assumed:
//
//  * Cogl generates the `#version` line and, on GLES, `precision highp float;`
//    (cogl-glsl-shader-boilerplate.h). We must not declare either ourselves.
//
//  * The source texture is bound to layer 0, so it is reachable as the sampler
//    `cogl_sampler0`, and the interpolated coordinate is `cogl_tex_coord0_in`
//    (cogl-pipeline-fragend-glsl.c / cogl-pipeline-vertend-glsl.c). That is
//    what lets us sample at *displaced* coordinates, which is the whole basis
//    of refraction - a plain "modify cogl_texel" hook could not do it.
//
//  * Cogl itself emits `texture2D()`, so `texture2D()` is safe in every context
//    the shell runs in. `fwidth()` is not guaranteed, so all antialiasing here
//    is done in known pixel units instead of screen-space derivatives.
//
//  * ShellGLSLEffect sets the blend function to
//        RGB = ADD (SRC_COLOR * SRC_COLOR[A], DST_COLOR * (1 - SRC_COLOR[A]))
//    which multiplies by alpha *in the blender*. So this shader must output
//    STRAIGHT (non-premultiplied) alpha - while the texture it samples is
//    premultiplied content and must be divided by its own alpha first. Getting
//    that pair backwards is a silent, washed-out-looking bug.
//
//  * ShellGLSLEffect builds its pipeline once per *class*, not per instance
//    (shell-glsl-effect.c: `if (klass->base_pipeline == NULL)`). Therefore the
//    shader source may never depend on user settings - every adjustable value
//    has to be a uniform. Uniforms are per-instance because the instance holds
//    a cogl_pipeline_copy() of the class pipeline.
//
// Physical model: the glass is a slab whose thickness rises from zero at the
// edge to full over `bevel` pixels, following a circular (spherical-cap)
// profile. That profile is chosen deliberately: its derivative reaches zero at
// the top, so the centre of the panel is exactly flat and therefore completely
// undistorted, while the edge carries all the lensing. A linear ramp would
// distort the whole surface uniformly and read as cheap plastic wrap.

/**
 * GLSL declarations: uniforms and helper functions.
 *
 * All names are prefixed `ag` to guarantee they cannot collide with cogl's own
 * generated identifiers.
 */
export const DECLARATIONS = `
uniform vec2  agLocalOrigin;   // actor-local coords of texel (0,0)
uniform vec2  agLocalSize;     // actor-local extent covered by the texture
uniform vec4  agRect;          // glass rect (x, y, w, h), actor-local px
uniform vec4  agClip;          // backdrop sampling clamp (x, y, w, h)
uniform vec2  agCorner;        // x = corner radius px, y = bevel width px
uniform vec3  agRefr;          // x = IOR, y = strength, z = chromatic aberration
uniform vec4  agTint;          // rgb = tint colour, a = tint strength
uniform vec2  agGrade;         // x = saturation, y = brightness
uniform vec4  agLight;         // xy = unit vector toward light, z = specular, w = shininess
uniform vec2  agSheenFresnel;  // x = sheen intensity, y = fresnel/rim intensity
uniform vec3  agShadow;        // x = opacity, y = softness radius, z = offset
uniform float agFallbackBlur;  // > 0 => blur in-shader with this radius (px)

// Signed distance to a rounded rectangle centred on the origin.
// Negative inside. (Standard formulation; see Inigo Quilez, "distance
// functions".)
float agSdRoundRect(vec2 p, vec2 halfSize, float r)
{
    vec2 q = abs(p) - halfSize + vec2(r);
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
}

// Analytic gradient of the above: the outward 2D surface direction. Used
// instead of finite differences so the normal stays exact right at the corner
// arcs, where a difference estimate visibly stair-steps.
vec2 agSdGradient(vec2 p, vec2 halfSize, float r)
{
    vec2 q = abs(p) - halfSize + vec2(r);
    vec2 s = sign(p);
    vec2 g;
    if (max(q.x, q.y) > 0.0) {
        vec2 m = max(q, vec2(0.0));
        float l = length(m);
        g = (l > 0.0001) ? (m / l) : vec2(0.0, 1.0);
    } else {
        g = (q.x > q.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    }
    return g * s;
}

// Backdrop fetch. When the shell's native Gaussian blur is available the
// texture is already blurred and this is a single tap; the ring fallback only
// runs when Shell.BlurEffect could not be constructed.
vec4 agFetch(vec2 uv, vec2 texel, float radius)
{
    vec4 acc = texture2D(cogl_sampler0, uv);
    if (radius <= 0.0)
        return acc;

    float weight = 1.0;
    for (int i = 0; i < 12; i++) {
        float a = float(i) * 0.5235988;          // 30 degrees
        vec2 dir = vec2(cos(a), sin(a));
        acc += texture2D(cogl_sampler0, uv + dir * radius * texel);
        acc += texture2D(cogl_sampler0, uv + dir * (radius * 0.55) * texel);
        weight += 2.0;
    }
    return acc / weight;
}

// Undo premultiplication so the backdrop can be graded in straight colour.
vec3 agUnpremultiply(vec4 c)
{
    return c.rgb / max(c.a, 0.0025);
}
`;

/**
 * GLSL body, appended after cogl's own fragment processing. It overwrites
 * cogl_color_out entirely.
 */
export const CODE = `
    vec2 agTexel = vec2(1.0) / max(agLocalSize, vec2(1.0));
    vec2 agP = agLocalOrigin + cogl_tex_coord0_in.st * agLocalSize;

    vec2 agHalf = agRect.zw * 0.5;
    vec2 agCentre = agRect.xy + agHalf;
    float agRadius = min(agCorner.x, min(agHalf.x, agHalf.y));
    float agBevel = max(agCorner.y, 0.5);
    vec2 agRel = agP - agCentre;

    float agDist = agSdRoundRect(agRel, agHalf, agRadius);

    // Coverage with 1px antialiasing. agP is in logical pixels, so a fixed
    // 1px band is correct without needing screen-space derivatives.
    float agCoverage = clamp(0.5 - agDist, 0.0, 1.0);

    vec3 agColour = vec3(0.0);
    float agAlpha = 0.0;

    if (agCoverage > 0.0) {
        // ---- bevel profile -------------------------------------------------
        // agT: 0 at the very edge, 1 once we are a full bevel width inside.
        float agT = clamp(-agDist / agBevel, 0.0, 1.0);
        float agInv = 1.0 - agT;

        // Spherical cap. h(0) = 0, h(1) = 1, and dh/dt -> 0 at t = 1, which is
        // what makes the centre perfectly flat and undistorted.
        float agH = sqrt(max(1.0 - agInv * agInv, 0.0001));
        float agSlope = min((agInv / agH) / agBevel, 12.0);

        vec2 agGrad = agSdGradient(agRel, agHalf, agRadius);
        vec3 agN = normalize(vec3(agSlope * agGrad, 1.0));

        // ---- refraction ----------------------------------------------------
        // Air -> glass, so eta < 1 and total internal reflection cannot occur.
        vec3 agIncident = vec3(0.0, 0.0, -1.0);
        float agEta = 1.0 / max(agRefr.x, 1.0001);
        float agThickness = agRefr.y * agBevel;

        vec3 agBent = refract(agIncident, agN, agEta);
        vec2 agOffset = (agBent.xy / max(abs(agBent.z), 0.15)) * agThickness;

        vec2 agClipMin = agClip.xy;
        vec2 agClipMax = agClip.xy + agClip.zw;

        vec2 agSamplePos = clamp(agP + agOffset, agClipMin, agClipMax);
        vec4 agTexel0 = agFetch((agSamplePos - agLocalOrigin) * agTexel, agTexel, agFallbackBlur);
        vec3 agBack = agUnpremultiply(agTexel0);

        // ---- chromatic aberration, edge only -------------------------------
        // Dispersion is proportional to how steeply the ray is bent, so it is
        // confined to the bevel by construction; agEdge fades it out further so
        // it never tints the flat centre.
        float agEdge = 1.0 - agT;
        if (agRefr.z > 0.0 && agEdge > 0.002) {
            float agDisp = agRefr.z * 0.06 * agEdge;

            vec3 agBentR = refract(agIncident, agN, 1.0 / max(agRefr.x - agDisp, 1.0001));
            vec3 agBentB = refract(agIncident, agN, 1.0 / max(agRefr.x + agDisp, 1.0001));

            vec2 agOffR = (agBentR.xy / max(abs(agBentR.z), 0.15)) * agThickness;
            vec2 agOffB = (agBentB.xy / max(abs(agBentB.z), 0.15)) * agThickness;

            vec2 agPosR = clamp(agP + agOffR, agClipMin, agClipMax);
            vec2 agPosB = clamp(agP + agOffB, agClipMin, agClipMax);

            vec4 agTr = agFetch((agPosR - agLocalOrigin) * agTexel, agTexel, agFallbackBlur);
            vec4 agTb = agFetch((agPosB - agLocalOrigin) * agTexel, agTexel, agFallbackBlur);

            agBack.r = agUnpremultiply(agTr).r;
            agBack.b = agUnpremultiply(agTb).b;
        }

        // ---- grade and tint ------------------------------------------------
        float agLum = dot(agBack, vec3(0.2126, 0.7152, 0.0722));
        agBack = mix(vec3(agLum), agBack, agGrade.x);
        agBack *= agGrade.y;
        agBack = mix(agBack, agTint.rgb, agTint.a);

        // ---- specular ------------------------------------------------------
        // Blinn-Phong against the bevel normal. Masked to the bevel: in the
        // flat centre the normal is constant, so an unmasked highlight would
        // become a uniform white film over the whole panel.
        vec3 agL = normalize(vec3(agLight.xy, 0.85));
        vec3 agV = vec3(0.0, 0.0, 1.0);
        vec3 agHv = normalize(agL + agV);
        float agBevelMask = 1.0 - smoothstep(0.55, 1.0, agT);
        float agSpecular = pow(max(dot(agN, agHv), 0.0), agLight.w) * agLight.z * agBevelMask;

        // ---- Fresnel rim ---------------------------------------------------
        // Schlick, F0 = 0.04 for glass. Naturally rim-only: agN.z is 1 in the
        // centre (F = 0.04) and falls to 0 at the edge (F -> 1).
        float agFresnel = 0.04 + 0.96 * pow(1.0 - clamp(agN.z, 0.0, 1.0), 5.0);
        float agRim = agFresnel * agSheenFresnel.y;

        // ---- directional sheen ---------------------------------------------
        // A gradient, not a constant. A constant sheen is the "milky plastic"
        // look; the sweep from the light-facing edge to the far edge is what
        // reads as a curved, lit surface.
        vec2 agNorm = (agP - agRect.xy) / max(agRect.zw, vec2(1.0));
        vec2 agLightDir = normalize(agLight.xy + vec2(0.00001, 0.0));
        float agGradient = clamp(0.5 + dot(agNorm - vec2(0.5), agLightDir), 0.0, 1.0);
        float agSheen = agSheenFresnel.x * pow(agGradient, 2.2);

        agColour = agBack + vec3(agSheen + agSpecular + agRim);
        agAlpha = agCoverage;
    }

    // ---- soft drop shadow --------------------------------------------------
    // Offset away from the same light vector that drives the specular and rim,
    // so the whole material agrees about where the light is. The falloff is
    // wide and smooth rather than a hard contact ring.
    if (agShadow.x > 0.0 && agCoverage < 1.0) {
        vec2 agShadowRel = agRel + agLight.xy * agShadow.z;
        float agShadowDist = agSdRoundRect(agShadowRel, agHalf, agRadius);
        float agShadowA = agShadow.x *
            (1.0 - smoothstep(-agShadow.y * 0.35, agShadow.y, agShadowDist));
        agShadowA *= (1.0 - agCoverage);

        if (agShadowA > 0.0) {
            // Composite the glass over a black shadow, in straight alpha.
            float agOut = agAlpha + agShadowA * (1.0 - agAlpha);
            agColour = (agColour * agAlpha) / max(agOut, 0.0001);
            agAlpha = agOut;
        }
    }

    // Straight (non-premultiplied) alpha: the pipeline blend multiplies by
    // alpha for us. cogl_color_in carries the actor's paint opacity, which is
    // how the show/hide transitions fade.
    cogl_color_out = vec4(agColour, agAlpha * cogl_color_in.a);
`;

/**
 * Names of every uniform the shader declares, in the order the effect sets
 * them. Kept beside the source so the two cannot drift apart.
 */
export const UNIFORMS = [
    'agLocalOrigin',
    'agLocalSize',
    'agRect',
    'agClip',
    'agCorner',
    'agRefr',
    'agTint',
    'agGrade',
    'agLight',
    'agSheenFresnel',
    'agShadow',
    'agFallbackBlur',
];

/**
 * Convert the user-facing light angle into the vector the shader wants.
 *
 * Convention: degrees, 0 = light coming from directly above the surface,
 * increasing clockwise. Screen space has y pointing down, so "up" is -y. The
 * result points *toward* the light.
 *
 * @param {number} degrees light angle
 * @returns {number[]} unit vector [x, y] in screen space
 */
export function lightVector(degrees) {
    const rad = (degrees * Math.PI) / 180;
    return [Math.sin(rad), -Math.cos(rad)];
}
