// GLSL for the memeverse. Three programs:
//
//   tiles  — every meme as an instanced hex billboard. Draws twice per frame:
//            pass 0 = the opaque hex (depth-written, alpha-to-coverage edges),
//            pass 1 = an additive halo, so a far-off tile reads as a star of
//            its own average colour and resolves into a meme as you approach.
//            Galaxy tiles and assemble's mosaic clones share the program;
//            uMode picks the placement.
//   sky    — a fullscreen triangle: the nebula (baked once into a cubemap),
//            procedural stars and the hyperspace streaks of a warp.
//   disk   — the galaxy's dust disc (baked once into a texture) laid over
//            the y = 0 plane, following the spiral the systems sit on.
//   sprite — billboards for the glowing chainlink hex at the core and the dust
//            motes that give flights their parallax.

import { HEX_U0 } from '../lib/atlas-format';
import { DETAIL_KEEP } from './mosaic';

const GALAXY_POS = /* glsl */ `
vec3 galaxyPos(vec3 anchor, vec3 local, vec2 tilt, float spin) {
  float a = spin * uSpinT;
  float c = cos(a), s = sin(a);
  vec3 p = vec3(c * local.x - s * local.z, local.y, s * local.x + c * local.z);
  float cx = cos(tilt.x), sx = sin(tilt.x);
  p = vec3(p.x, cx * p.y - sx * p.z, sx * p.y + cx * p.z);
  float cz = cos(tilt.y), sz = sin(tilt.y);
  p = vec3(cz * p.x - sz * p.y, sz * p.x + cz * p.y, p.z);
  p += anchor;
  float cg = cos(uGalaxyAngle), sg = sin(uGalaxyAngle);
  return vec3(cg * p.x - sg * p.z, p.y, sg * p.x + cg * p.z);
}
`;

export const TILE_VS = /* glsl */ `#version 300 es
precision highp float;

in vec2 aCorner;
in vec3 aAnchor;
in vec3 aLocal;
in vec2 aTilt;
in float aSpin;
in float aTile;
in vec3 aColor;
in float aMatch;  // galaxy tiles: 1 when the meme matches the active filter
in vec3 aTarget;  // clones: (u, v, relief) on the mosaic plane
in vec3 aTint;    // clones: target colour minus tile colour, 0–1 rgb
in float aDelay;  // clones: 0–1 launch stagger

uniform mat4 uView;
uniform mat4 uProj;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamPos;
uniform float uSpinT;
uniform float uGalaxyAngle;
uniform float uViewportH;
uniform float uMode;
uniform float uPass;
uniform float uMorph;
uniform vec3 uPlaneOrigin;
uniform vec3 uPlaneRight;
uniform vec3 uPlaneUp;
uniform vec3 uPlaneNormal;
uniform float uMosaicR;
uniform float uHover;
uniform float uFocus;
uniform float uFilter;
uniform float uTime;
uniform float uGalaxyFade;
uniform vec2 uFog;
uniform highp sampler2D uHiMap;

out vec2 vLocal;
out float vTile;
out vec3 vColor;
out float vStar;
out float vEmph;
out float vHi;
out float vFog;
out vec3 vTint;
out float vArrive;
out float vRim;

${GALAXY_POS}

void main() {
  vec3 S = galaxyPos(aAnchor, aLocal, aTilt, aSpin);
  vec3 P = S;
  vec3 right = uCamRight;
  vec3 up = uCamUp;
  float R = 1.0;
  float emph = 1.0;
  float rim = 0.28;
  float arrive = 0.0;
  bool hovered = float(gl_InstanceID) == uHover;
  bool focused = float(gl_InstanceID) == uFocus;

  if (uMode < 0.5) {
    if (uFilter > 0.5) {
      bool hit = aMatch > 0.5;
      emph = hit ? 1.25 : 0.13;
      R = hit ? 1.3 : 0.85;
      rim = hit ? 0.75 : 0.0;
    }
    emph *= uGalaxyFade;
    if (hovered) { R *= 1.55; rim = 1.0; emph = max(emph, 1.15); }
    if (focused) { R *= 1.25; rim = 1.0; emph = max(emph, 1.1); }
  } else {
    // Assemble: fly from the meme's place in the galaxy to its hex on the
    // portrait along a curve that bows out towards the viewer.
    float t = clamp((uMorph - aDelay * 0.55) / 0.45, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    arrive = t;
    vec3 T = uPlaneOrigin + uPlaneRight * aTarget.x + uPlaneUp * aTarget.y + uPlaneNormal * aTarget.z;
    float swirl = fract(aDelay * 7.13) - 0.5;
    vec3 C = mix(S, T, 0.55) + uPlaneNormal * (22.0 + 16.0 * fract(aDelay * 3.7)) + uPlaneRight * swirl * 40.0;
    P = mix(mix(S, C, t), mix(C, T, t), t);
    right = normalize(mix(uCamRight, uPlaneRight, t));
    up = normalize(mix(uCamUp, uPlaneUp, t));
    R = mix(1.0, uMosaicR, t) * smoothstep(0.0, 0.05, t);
    rim = 0.0;
    if (hovered) { R *= 1.9; P += uPlaneNormal * 1.5; rim = 1.0; }
  }

  vec4 cc = uProj * uView * vec4(P, 1.0);
  float pxR = R * uProj[1][1] * uViewportH * 0.5 / max(cc.w, 0.001);
  // Never let a tile shrink below ~1px: far tiles stay visible as stars
  // instead of flickering in and out between pixels.
  if (pxR > 0.0 && pxR < 1.1) R *= 1.1 / pxR;
  vStar = 1.0 - smoothstep(2.5, 9.0, pxR);

  vec2 corner;
  if (uPass > 0.5) {
    // Halos only matter while a tile still reads as a star; on anything
    // bigger they'd be an invisible 10× overdraw, so collapse the quad.
    if (uMode < 0.5 ? vStar < 0.02 : arrive < 0.01) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float halo = uMode < 0.5 ? 3.2 : 1.6;
    corner = aCorner * halo;
    vLocal = corner;
    // Sit the halo just behind its own tile so the tile occludes it.
    P += normalize(P - uCamPos) * R * 0.6;
    corner *= R;
    gl_Position = uProj * uView * vec4(P + right * corner.x + up * corner.y, 1.0);
  } else {
    corner = aCorner * vec2(0.8660254, 1.0);
    vLocal = corner;
    corner *= R;
    gl_Position = uProj * uView * vec4(P + right * corner.x + up * corner.y, 1.0);
  }

  float dist = length(P - uCamPos);
  vFog = smoothstep(uFog.x, uFog.y, dist);
  vTile = aTile;
  vColor = aColor;
  vEmph = emph;
  // Hi-res slot for this meme (or -1), shared by its galaxy tile and any
  // mosaic clones of it.
  int ti = int(aTile + 0.5);
  vHi = texelFetch(uHiMap, ivec2(ti % 64, ti / 64), 0).r;
  vTint = aTint;
  vArrive = arrive;
  vRim = rim;
}
`;

export const TILE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2DArray;

uniform sampler2DArray uAtlas;
uniform sampler2D uHiRes;
uniform float uPageMask;
uniform float uPass;
uniform float uMode;
uniform vec3 uFogColor;
uniform float uTintAmt;
uniform float uMorph;

in vec2 vLocal;
in float vTile;
in vec3 vColor;
in float vStar;
in float vEmph;
in float vHi;
in float vFog;
in vec3 vTint;
in float vArrive;
in float vRim;

out vec4 outColor;

const float U0 = ${HEX_U0.toFixed(6)};

float hexDist(vec2 p) {
  p = abs(p);
  return max(p.x, dot(p, vec2(0.5, 0.8660254)));
}

void main() {
  if (uPass > 0.5) {
    float r = length(vLocal);
    float g = exp(-r * r * 0.55);
    float core = exp(-r * r * 4.0);
    float inten = (uMode < 0.5 ? mix(0.05, 0.95, vStar) : 0.12 * vArrive) * vEmph;
    // Stars read better a little more saturated and a touch bluer than the
    // memes' true (mostly beige) averages.
    float l = dot(vColor, vec3(0.2126, 0.7152, 0.0722));
    vec3 sc = clamp(mix(vec3(l), vColor, 1.8), 0.0, 1.0);
    sc = mix(sc, vec3(0.55, 0.7, 1.0), 0.22);
    vec3 c = sc * (g * 0.55 + core * 0.7) * inten * (1.0 - vFog * 0.75);
    outColor = vec4(c, 1.0);
    return;
  }

  float d = hexDist(vLocal) - 0.8660254;
  float aa = max(fwidth(d), 1e-4);
  float inside = 1.0 - smoothstep(-aa, aa, d);
  if (inside < 0.02) discard;

  vec2 uv = vec2(vLocal.x / 0.8660254 * 0.5 + 0.5, 0.5 - vLocal.y * 0.5);
  uv.x = U0 + uv.x * (1.0 - 2.0 * U0);

  float page = floor(vTile / 1024.0 + 0.001);
  float cell = vTile - page * 1024.0;
  vec2 cr = vec2(mod(cell, 32.0), floor(cell / 32.0 + 0.001));
  vec2 uvLo = clamp(uv, vec2(0.6 / 64.0), vec2(1.0 - 0.6 / 64.0));
  vec3 tex = texture(uAtlas, vec3((cr + uvLo) / 32.0, page)).rgb;
  float ready = mod(floor(uPageMask / exp2(page) + 0.001), 2.0);
  if (vHi >= 0.0) {
    vec2 sr = vec2(mod(vHi, 8.0), floor(vHi / 8.0 + 0.001));
    vec2 uvHi = clamp(uv, vec2(0.6 / 256.0), vec2(1.0 - 0.6 / 256.0));
    tex = texture(uHiRes, (sr + uvHi) / 8.0).rgb;
    ready = 1.0;
  }
  vec3 col = mix(vColor, tex, ready * (1.0 - vStar * 0.85));

  if (uMode > 0.5) {
    // Same blend as mosaic.ts recolor(): shift towards the photo's colour,
    // keep part of the meme's own contrast.
    float b = uTintAmt * vArrive;
    vec3 target = vColor + vTint;
    vec3 shifted = target + (col - vColor) * (1.0 - ${DETAIL_KEEP.toFixed(3)} * b);
    col = clamp(mix(col, shifted, b), 0.0, 1.0);
  }

  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, clamp(vEmph, 0.35, 1.0));
  col *= vEmph;

  float edge = smoothstep(-0.12, -0.005, d);
  vec3 rimCol = mix(vec3(0.29, 0.56, 1.0), vec3(0.85, 0.93, 1.0), step(0.99, vRim));
  col = mix(col, rimCol, edge * vRim);

  col = mix(col, uFogColor, vFog * 0.92);
  outColor = vec4(col, inside);
}
`;

export const SKY_VS = /* glsl */ `#version 300 es
precision highp float;
out vec2 vNdc;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  vNdc = p;
  gl_Position = vec4(p, 0.9999, 1.0);
}
`;

const NOISE = /* glsl */ `
float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 1.7; a *= 0.5; }
  return s;
}
`;

// Baked once into a cubemap: the nebula only depends on view direction, so
// there's no reason to spend ten octaves of noise per pixel per frame on it.
export const NEBULA_BAKE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform int uFace;
in vec2 vNdc;
out vec4 outColor;
${NOISE}
void main() {
  vec2 p = vNdc;
  vec3 dir;
  if (uFace == 0) dir = vec3(1.0, -p.y, -p.x);
  else if (uFace == 1) dir = vec3(-1.0, -p.y, p.x);
  else if (uFace == 2) dir = vec3(p.x, 1.0, p.y);
  else if (uFace == 3) dir = vec3(p.x, -1.0, -p.y);
  else if (uFace == 4) dir = vec3(p.x, -p.y, 1.0);
  else dir = vec3(-p.x, -p.y, -1.0);
  dir = normalize(dir);
  float n = fbm(dir * 2.1);
  float n2 = fbm(dir * 4.3 + 7.1);
  vec3 col = vec3(0.07, 0.14, 0.42) * pow(n, 3.2) * 1.3 + vec3(0.24, 0.07, 0.33) * pow(n2, 4.5) * 0.9;
  outColor = vec4(col, 1.0);
}
`;

// Baked once into a square texture laid over the galactic plane: the dust
// disc, brightest along the same two logarithmic arms the star systems are
// threaded on, with darker lanes and a hot core.
export const DISK_BAKE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float uRadius;
uniform float uArmR0;
uniform float uExtent;
in vec2 vNdc;
out vec4 outColor;
${NOISE}
void main() {
  vec2 xz = vNdc * uRadius;
  float r = length(xz);
  float ang = atan(xz.y, xz.x);
  float th = log(max(r - 8.0, 1.0) / uArmR0) / 0.2;
  float arm = pow(0.5 + 0.5 * cos(2.0 * (ang - th)), 2.5);
  float disk = exp(-r / (uExtent * 0.38));
  float dust = fbm(vec3(xz * 0.025, 3.0));
  float lanes = smoothstep(0.35, 0.75, fbm(vec3(xz * 0.06, 9.0)));
  float bright = disk * (0.18 + 0.82 * arm) * (0.45 + 0.9 * dust) * (1.0 - 0.45 * lanes);
  float core = exp(-r / 16.0);
  vec3 dcol = mix(vec3(0.17, 0.30, 0.85), vec3(0.80, 0.86, 1.0), core);
  float edge = 1.0 - smoothstep(uRadius * 0.8, uRadius, r);
  outColor = vec4(dcol * (bright * 0.75 + core * 0.6) * edge, 1.0);
}
`;

export const DISK_VS = /* glsl */ `#version 300 es
precision highp float;
in vec2 aCorner;
uniform mat4 uView;
uniform mat4 uProj;
uniform float uRadius;
uniform float uGalaxyAngle;
out vec2 vUv;
out vec3 vWorld;
void main() {
  vec2 xz = aCorner * uRadius;
  float c = cos(uGalaxyAngle), s = sin(uGalaxyAngle);
  vec3 p = vec3(c * xz.x - s * xz.y, 0.0, s * xz.x + c * xz.y);
  vUv = aCorner * 0.5 + 0.5;
  vWorld = p;
  gl_Position = uProj * uView * vec4(p, 1.0);
}
`;

export const DISK_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uDisk;
uniform vec3 uCamPos;
uniform float uFade;
in vec2 vUv;
in vec3 vWorld;
out vec4 outColor;
void main() {
  vec3 dir = normalize(vWorld - uCamPos);
  float graze = mix(0.3, 1.0, smoothstep(0.0, 0.3, abs(dir.y)));
  outColor = vec4(texture(uDisk, vUv).rgb * graze * uFade, 1.0);
}
`;

export const SKY_FS = /* glsl */ `#version 300 es
precision highp float;

uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uWarp;
uniform float uAspect;
uniform samplerCube uNebula;

in vec2 vNdc;
out vec4 outColor;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec4 farP = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(farP.xyz / farP.w - uCamPos);

  vec3 col = vec3(0.010, 0.014, 0.032) + texture(uNebula, dir).rgb;

  // Procedural stars on a fine lattice of directions — cheap enough to keep
  // per pixel, and crisper than any cubemap we could afford.
  vec3 sp = dir * 280.0;
  vec3 cell = floor(sp);
  float h = hash(cell);
  if (h > 0.982) {
    vec3 ctr = cell + 0.5 + (vec3(hash(cell + 1.3), hash(cell + 2.7), hash(cell + 5.1)) - 0.5) * 0.5;
    float d = length(sp - ctr);
    float tw = 0.75 + 0.25 * sin(uTime * (1.0 + h * 3.0) + h * 40.0);
    float star = smoothstep(0.42, 0.0, d) * (h - 0.982) / 0.018 * tw;
    vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.9, 0.8), hash(cell + 9.0));
    col += tint * star * 1.6;
  }

  // Hyperspace: radial streaks racing outward while warping.
  if (uWarp > 0.001) {
    vec2 q = vNdc * vec2(uAspect, 1.0);
    float a = atan(q.y, q.x);
    float r = length(q);
    float lane = floor((a + 3.14159) / 6.28318 * 180.0);
    float rnd = hash(vec3(lane, 3.0, 7.0));
    float s = fract(rnd * 13.0 - uTime * (0.8 + rnd * 2.2) + r * 0.35);
    float streak = smoothstep(0.82, 1.0, s) * step(0.45, rnd) * smoothstep(0.05, 0.9, r);
    col += vec3(0.55, 0.72, 1.0) * streak * uWarp * 1.6;
    col += vec3(0.18, 0.32, 0.9) * uWarp * 0.25 * (1.0 - r * 0.5);
  }

  outColor = vec4(col, 1.0);
}
`;

export const SPRITE_VS = /* glsl */ `#version 300 es
precision highp float;
in vec2 aCorner;
in vec4 aPosSize;  // xyz world, w size
in vec4 aColor;    // rgb, a = shape (0 hex ring, 1 soft mote)
uniform mat4 uView;
uniform mat4 uProj;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uGalaxyAngle;
uniform float uRotateMotes;
out vec2 vLocal;
out vec4 vColor;
void main() {
  vec3 p = aPosSize.xyz;
  if (aColor.a > 0.5 && uRotateMotes > 0.5) {
    float cg = cos(uGalaxyAngle), sg = sin(uGalaxyAngle);
    p = vec3(cg * p.x - sg * p.z, p.y, sg * p.x + cg * p.z);
  }
  vLocal = aCorner;
  vColor = aColor;
  gl_Position = uProj * uView * vec4(p + (uCamRight * aCorner.x + uCamUp * aCorner.y) * aPosSize.w, 1.0);
}
`;

export const SPRITE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float uTime;
uniform float uPulse;
uniform float uCoreFade;
in vec2 vLocal;
in vec4 vColor;
out vec4 outColor;
float hexDist(vec2 p) {
  p = abs(p);
  return max(p.x, dot(p, vec2(0.5, 0.8660254)));
}
void main() {
  if (vColor.a < 0.5) {
    // The chainlink mark: a thick pointy-top hex ring, with a breathing glow.
    vec2 p = vLocal * 1.9;
    float d = hexDist(p) - 0.62;
    float ring = 1.0 - smoothstep(0.13, 0.16, abs(d));
    float glow = exp(-max(abs(d) - 0.14, 0.0) * 5.5) * (0.55 + 0.25 * sin(uTime * 1.4)) * (1.0 + uPulse * 2.0);
    float fall = smoothstep(1.0, 0.6, length(vLocal));
    vec3 c = vColor.rgb * glow * 0.9 + vec3(0.92, 0.96, 1.0) * ring;
    outColor = vec4(c * fall * uCoreFade, 1.0);
  } else {
    float r = length(vLocal);
    float g = exp(-r * r * 6.0);
    outColor = vec4(vColor.rgb * g, 1.0);
  }
}
`;
