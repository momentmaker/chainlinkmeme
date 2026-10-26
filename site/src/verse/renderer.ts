// Owns the WebGL2 context and everything on the GPU: the atlas sheets, the
// hi-res tile cache, the instance buffers for the galaxy and assemble's
// mosaic clones, and the per-frame draw order. Knows nothing about input,
// cameras or React — the engine hands it a FrameState each frame.

import { attrib, link, type Program } from './gl';
import { DISK_BAKE_FS, DISK_FS, DISK_VS, NEBULA_BAKE_FS, SKY_FS, SKY_VS, SPRITE_FS, SPRITE_VS, TILE_FS, TILE_VS } from './shaders';
import type { GalaxyLayout } from './layout';
import type { Mat4, Vec3 } from './math';
import { mulberry32 } from './math';
import { PAGE } from '../lib/atlas-format';

export const HI_SLOTS = 64; // 8×8 slots of 256px on one 2048² texture
export const HI_SIZE = 256;
const GALAXY_STRIDE = 13; // anchor3 local3 tilt2 spin1 tile1 color3
const CLONE_STRIDE = 20; // the above + target3 tint3 delay1

export interface FrameState {
  view: Mat4;
  proj: Mat4;
  invViewProj: Mat4;
  camPos: Vec3;
  camRight: Vec3;
  camUp: Vec3;
  spinT: number;
  galaxyAngle: number;
  time: number;
  warp: number;
  hover: number; // galaxy instance, -1 none
  hoverClone: number; // mosaic clone, -1 none
  focus: number;
  filterOn: boolean;
  morph: number; // 0–1 assemble progress
  galaxyFade: number;
  fog: [number, number];
  pulse: number;
  coreFade: number;
}

export interface MosaicPlane {
  origin: Vec3;
  right: Vec3;
  up: Vec3;
  normal: Vec3;
  tileR: number;
}

export function hexToRgb(hex: string): [number, number, number] {
  if (!hex || hex.length < 7) return [0.5, 0.5, 0.5];
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private tiles: Program;
  private sky: Program;
  private sprite: Program;
  private disk: Program;
  private nebulaTex: WebGLTexture;
  private diskTex: WebGLTexture | null = null;
  private diskRadius = 240;
  private cornerBuf: WebGLBuffer;
  private galaxyBuf: WebGLBuffer | null = null;
  private stateBuf: WebGLBuffer | null = null;
  private hiMapTex: WebGLTexture | null = null;
  private hiMapRows = 1;
  private cloneBuf: WebGLBuffer | null = null;
  private spriteBuf: WebGLBuffer;
  private galaxyVao: WebGLVertexArrayObject | null = null;
  private cloneVao: WebGLVertexArrayObject | null = null;
  private skyVao: WebGLVertexArrayObject;
  private diskVao: WebGLVertexArrayObject;
  private spriteVao: WebGLVertexArrayObject;
  private atlasTex: WebGLTexture;
  private hiTex: WebGLTexture;
  private galaxyCount = 0;
  private cloneCount = 0;
  private spriteCount = 0;
  private pageMask = 0;
  private hiDirty = false;
  private galaxyData: Float32Array | null = null;
  private plane: MosaicPlane | null = null;
  private armR0 = 30;
  private extent = 200;
  tintAmount = 0.55;
  width = 1;
  height = 1;

  constructor(readonly canvas: HTMLCanvasElement, pages: number) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('webgl2 unavailable');
    this.gl = gl;

    this.tiles = link(gl, TILE_VS, TILE_FS);
    this.sky = link(gl, SKY_VS, SKY_FS);
    this.sprite = link(gl, SPRITE_VS, SPRITE_FS);
    this.disk = link(gl, DISK_VS, DISK_FS);

    this.cornerBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.skyVao = gl.createVertexArray()!;
    this.diskVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.diskVao);
    attrib(gl, this.disk, 'aCorner', this.cornerBuf, 2, 8, 0, 0);
    gl.bindVertexArray(null);
    this.spriteBuf = gl.createBuffer()!;
    this.spriteVao = gl.createVertexArray()!;

    // Atlas: one layer per sheet, mipmapped down to 4px per tile. Deeper
    // levels would just smear neighbouring memes into each other.
    this.atlasTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 5, gl.RGBA8, PAGE, PAGE, Math.max(1, pages));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, 4);

    this.hiTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.hiTex);
    gl.texStorage2D(gl.TEXTURE_2D, 4, gl.RGBA8, HI_SIZE * 8, HI_SIZE * 8);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 3);

    this.nebulaTex = this.bakeNebula();

    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) {
      const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTex);
      gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, max));
    }
  }

  // Render a fullscreen pass into `tex` (or one face of it) once.
  private bake(prog: Program, target: number, tex: WebGLTexture, size: number, setUniforms: () => void): void {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, target, tex, 0);
    gl.viewport(0, 0, size, size);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(prog.program);
    setUniforms();
    gl.bindVertexArray(this.skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
  }

  private bakeNebula(): WebGLTexture {
    const gl = this.gl;
    const size = 512;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 1, gl.RGBA8, size, size);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const prog = link(gl, SKY_VS, NEBULA_BAKE_FS);
    for (let face = 0; face < 6; face++) {
      this.bake(prog, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, tex, size, () => gl.uniform1i(prog.u.uFace!, face));
    }
    gl.deleteProgram(prog.program);
    return tex;
  }

  private bakeDisk(): void {
    const gl = this.gl;
    const size = 1024;
    if (this.diskTex) gl.deleteTexture(this.diskTex);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const prog = link(gl, SKY_VS, DISK_BAKE_FS);
    this.bake(prog, gl.TEXTURE_2D, tex, size, () => {
      gl.uniform1f(prog.u.uRadius!, this.diskRadius);
      gl.uniform1f(prog.u.uArmR0!, this.armR0);
      gl.uniform1f(prog.u.uExtent!, this.extent);
    });
    gl.deleteProgram(prog.program);
    this.diskTex = tex;
  }

  setGalaxy(layout: GalaxyLayout, colors: [number, number, number][]): void {
    const gl = this.gl;
    const n = layout.memeSystem.length;
    const data = new Float32Array(n * GALAXY_STRIDE);
    for (let i = 0; i < n; i++) {
      const o = i * GALAXY_STRIDE;
      data[o] = layout.anchor[i * 3]!;
      data[o + 1] = layout.anchor[i * 3 + 1]!;
      data[o + 2] = layout.anchor[i * 3 + 2]!;
      data[o + 3] = layout.local[i * 3]!;
      data[o + 4] = layout.local[i * 3 + 1]!;
      data[o + 5] = layout.local[i * 3 + 2]!;
      data[o + 6] = layout.tilt[i * 2]!;
      data[o + 7] = layout.tilt[i * 2 + 1]!;
      data[o + 8] = layout.spin[i]!;
      data[o + 9] = i;
      const c = colors[i] ?? [0.5, 0.5, 0.5];
      data[o + 10] = c[0];
      data[o + 11] = c[1];
      data[o + 12] = c[2];
    }
    this.galaxyData = data;
    this.galaxyCount = n;
    this.extent = layout.extent;
    const core = layout.systems.find((s) => s.arm === -1);
    this.armR0 = (core?.radius ?? 20) + 7;
    this.diskRadius = layout.extent * 1.1;
    this.bakeDisk();

    this.galaxyBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.galaxyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    this.stateBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(n).fill(1), gl.DYNAMIC_DRAW);

    // Meme index → hi-res slot, as a 64-wide float texture the vertex
    // shader reads with texelFetch.
    this.hiMapRows = Math.ceil(n / 64);
    this.hiMapTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.hiMapTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, 64, this.hiMapRows);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.setHiMap(new Float32Array(n).fill(-1));

    this.galaxyVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.galaxyVao);
    this.bindCorner(this.tiles);
    this.bindGalaxyAttribs(this.galaxyBuf, GALAXY_STRIDE * 4);
    attrib(gl, this.tiles, 'aMatch', this.stateBuf, 1, 4, 0, 1);
    gl.bindVertexArray(null);

    this.buildSprites(layout, colors);
  }

  private bindCorner(p: Program): void {
    attrib(this.gl, p, 'aCorner', this.cornerBuf, 2, 8, 0, 0);
  }

  private bindGalaxyAttribs(buf: WebGLBuffer, stride: number): void {
    const gl = this.gl, p = this.tiles;
    attrib(gl, p, 'aAnchor', buf, 3, stride, 0, 1);
    attrib(gl, p, 'aLocal', buf, 3, stride, 12, 1);
    attrib(gl, p, 'aTilt', buf, 2, stride, 24, 1);
    attrib(gl, p, 'aSpin', buf, 1, stride, 32, 1);
    attrib(gl, p, 'aTile', buf, 1, stride, 36, 1);
    attrib(gl, p, 'aColor', buf, 3, stride, 40, 1);
  }

  // Dust motes strewn along the arms, plus the chainlink hex at the core.
  private buildSprites(layout: GalaxyLayout, colors: [number, number, number][]): void {
    const gl = this.gl;
    const rand = mulberry32(7);
    const motes = 2600;
    const data = new Float32Array((motes + 1) * 8);
    data.set([0, 0, 0, 9, 0.21, 0.36, 0.86, 0], 0);
    const systems = layout.systems;
    for (let i = 0; i < motes; i++) {
      const o = (i + 1) * 8;
      let x: number, y: number, z: number;
      if (rand() < 0.7 && systems.length) {
        const s = systems[Math.floor(rand() * systems.length)]!;
        const a = rand() * Math.PI * 2;
        const r = s.radius * (0.6 + rand() * 1.9);
        x = s.center[0] + Math.cos(a) * r;
        z = s.center[2] + Math.sin(a) * r;
        y = (rand() - 0.5) * 9;
      } else {
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * layout.extent * 1.1;
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
        y = (rand() - 0.5) * 30 * (1 - r / (layout.extent * 1.2));
      }
      const c = colors[Math.floor(rand() * colors.length)] ?? [0.6, 0.7, 1];
      const k = 0.18 + rand() * 0.25;
      data.set([x, y, z, 0.25 + rand() * 0.55, 0.35 + c[0] * k, 0.45 + c[1] * k, 0.85 + c[2] * k * 0.3, 1], o);
      for (let j = 4; j < 7; j++) data[o + j] = data[o + j]! * 0.32;
    }
    this.spriteCount = motes + 1;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.bindVertexArray(this.spriteVao);
    this.bindCorner(this.sprite);
    attrib(gl, this.sprite, 'aPosSize', this.spriteBuf, 4, 32, 0, 1);
    attrib(gl, this.sprite, 'aColor', this.spriteBuf, 4, 32, 16, 1);
    gl.bindVertexArray(null);
  }

  uploadPage(index: number, image: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const w = (image as { width: number }).width;
    const h = (image as { height: number }).height;
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, index, w, h, 1, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    this.pageMask |= 1 << index;
  }

  uploadHi(slot: number, image: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.hiTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, (slot % 8) * HI_SIZE, Math.floor(slot / 8) * HI_SIZE, HI_SIZE, HI_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, image);
    this.hiDirty = true;
  }

  setHiMap(map: Float32Array): void {
    if (!this.hiMapTex) return;
    const gl = this.gl;
    const data = new Float32Array(64 * this.hiMapRows).fill(-1);
    data.set(map.subarray(0, data.length));
    gl.bindTexture(gl.TEXTURE_2D, this.hiMapTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, this.hiMapRows, gl.RED, gl.FLOAT, data);
  }

  // One float per galaxy tile: 1 when it matches the active filter.
  setState(state: Float32Array): void {
    if (!this.stateBuf) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, state);
  }

  // Mosaic clones: one per hex of the portrait. Each carries a copy of its
  // meme's galaxy placement so it can launch from wherever that meme is.
  setMosaic(
    cells: { tile: number; u: number; v: number; relief: number; tint: [number, number, number]; delay: number }[],
    plane: MosaicPlane,
  ): void {
    const gl = this.gl;
    if (!this.galaxyData) return;
    const data = new Float32Array(cells.length * CLONE_STRIDE);
    cells.forEach((c, i) => {
      const o = i * CLONE_STRIDE;
      data.set(this.galaxyData!.subarray(c.tile * GALAXY_STRIDE, (c.tile + 1) * GALAXY_STRIDE), o);
      data[o + 13] = c.u;
      data[o + 14] = c.v;
      data[o + 15] = c.relief;
      data[o + 16] = c.tint[0];
      data[o + 17] = c.tint[1];
      data[o + 18] = c.tint[2];
      data[o + 19] = c.delay;
    });
    if (this.cloneBuf) gl.deleteBuffer(this.cloneBuf);
    if (this.cloneVao) gl.deleteVertexArray(this.cloneVao);
    this.cloneBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cloneBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.cloneVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.cloneVao);
    this.bindCorner(this.tiles);
    const stride = CLONE_STRIDE * 4;
    this.bindGalaxyAttribs(this.cloneBuf, stride);
    attrib(gl, this.tiles, 'aTarget', this.cloneBuf, 3, stride, 52, 1);
    attrib(gl, this.tiles, 'aTint', this.cloneBuf, 3, stride, 64, 1);
    attrib(gl, this.tiles, 'aDelay', this.cloneBuf, 1, stride, 76, 1);
    gl.bindVertexArray(null);
    this.cloneCount = cells.length;
    this.plane = plane;
  }

  clearMosaic(): void {
    this.cloneCount = 0;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.width = w;
    this.height = h;
  }

  render(f: FrameState): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    if (this.hiDirty) {
      gl.bindTexture(gl.TEXTURE_2D, this.hiTex);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.hiDirty = false;
    }
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0.01, 0.014, 0.032, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // 1 — sky
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.useProgram(this.sky.program);
    const su = this.sky.u;
    gl.uniformMatrix4fv(su.uInvViewProj!, false, f.invViewProj);
    gl.uniform3fv(su.uCamPos!, f.camPos);
    gl.uniform1f(su.uTime!, f.time);
    gl.uniform1f(su.uWarp!, f.warp);
    gl.uniform1f(su.uAspect!, this.width / this.height);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.nebulaTex);
    gl.uniform1i(su.uNebula!, 2);
    gl.bindVertexArray(this.skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (!this.galaxyVao) return;

    // 2 — solid hex tiles
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    const p = this.tiles;
    gl.useProgram(p.program);
    const u = p.u;
    gl.uniformMatrix4fv(u.uView!, false, f.view);
    gl.uniformMatrix4fv(u.uProj!, false, f.proj);
    gl.uniform3fv(u.uCamRight!, f.camRight);
    gl.uniform3fv(u.uCamUp!, f.camUp);
    gl.uniform3fv(u.uCamPos!, f.camPos);
    gl.uniform1f(u.uSpinT!, f.spinT);
    gl.uniform1f(u.uGalaxyAngle!, f.galaxyAngle);
    gl.uniform1f(u.uViewportH!, this.height);
    gl.uniform1f(u.uMorph!, f.morph);
    gl.uniform1f(u.uFilter!, f.filterOn ? 1 : 0);
    gl.uniform1f(u.uTime!, f.time);
    gl.uniform1f(u.uGalaxyFade!, f.galaxyFade);
    gl.uniform2f(u.uFog!, f.fog[0], f.fog[1]);
    gl.uniform3f(u.uFogColor!, 0.012, 0.018, 0.045);
    gl.uniform1f(u.uPageMask!, this.pageMask);
    gl.uniform1f(u.uTintAmt!, this.tintAmount);
    if (this.plane) {
      gl.uniform3fv(u.uPlaneOrigin!, this.plane.origin);
      gl.uniform3fv(u.uPlaneRight!, this.plane.right);
      gl.uniform3fv(u.uPlaneUp!, this.plane.up);
      gl.uniform3fv(u.uPlaneNormal!, this.plane.normal);
      gl.uniform1f(u.uMosaicR!, this.plane.tileR);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTex);
    gl.uniform1i(u.uAtlas!, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.hiTex);
    gl.uniform1i(u.uHiRes!, 1);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.hiMapTex);
    gl.uniform1i(u.uHiMap!, 3);

    const drawTiles = (pass: number) => {
      gl.uniform1f(u.uPass!, pass);
      gl.uniform1f(u.uMode!, 0);
      gl.uniform1f(u.uHover!, f.hover);
      gl.uniform1f(u.uFocus!, f.focus);
      gl.bindVertexArray(this.galaxyVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.galaxyCount);
      if (this.cloneCount > 0 && this.cloneVao && f.morph > 0) {
        gl.uniform1f(u.uMode!, 1);
        gl.uniform1f(u.uHover!, f.hoverClone);
        gl.uniform1f(u.uFocus!, -1);
        gl.bindVertexArray(this.cloneVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.cloneCount);
      }
    };
    drawTiles(0);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);

    // 3 — additive light: the core mark, tile halos, dust motes
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);

    if (this.diskTex) {
      gl.useProgram(this.disk.program);
      const du = this.disk.u;
      gl.uniformMatrix4fv(du.uView!, false, f.view);
      gl.uniformMatrix4fv(du.uProj!, false, f.proj);
      gl.uniform1f(du.uRadius!, this.diskRadius);
      gl.uniform1f(du.uGalaxyAngle!, f.galaxyAngle);
      gl.uniform3fv(du.uCamPos!, f.camPos);
      gl.uniform1f(du.uFade!, f.galaxyFade);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.diskTex);
      gl.uniform1i(du.uDisk!, 2);
      gl.bindVertexArray(this.diskVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.useProgram(this.sprite.program);
    const pu = this.sprite.u;
    gl.uniformMatrix4fv(pu.uView!, false, f.view);
    gl.uniformMatrix4fv(pu.uProj!, false, f.proj);
    gl.uniform3fv(pu.uCamRight!, f.camRight);
    gl.uniform3fv(pu.uCamUp!, f.camUp);
    gl.uniform1f(pu.uTime!, f.time);
    gl.uniform1f(pu.uPulse!, f.pulse);
    gl.uniform1f(pu.uCoreFade!, f.coreFade);
    gl.uniform1f(pu.uGalaxyAngle!, f.galaxyAngle);
    gl.uniform1f(pu.uRotateMotes!, 1);
    gl.bindVertexArray(this.spriteVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.spriteCount);

    gl.useProgram(p.program);
    drawTiles(1);

    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  dispose(): void {
    const gl = this.gl;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
