// Thin WebGL2 helpers. Nothing clever: compile, link, look up locations once.

export function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

export interface Program {
  program: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
  a: Record<string, number>;
}

export function link(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const program = gl.createProgram()!;
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  gl.deleteShader(v);
  gl.deleteShader(f);
  const u: Program['u'] = {};
  const nu = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < nu; i++) {
    const info = gl.getActiveUniform(program, i);
    if (info) u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
  }
  const a: Program['a'] = {};
  const na = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;
  for (let i = 0; i < na; i++) {
    const info = gl.getActiveAttrib(program, i);
    if (info) a[info.name] = gl.getAttribLocation(program, info.name);
  }
  return { program, u, a };
}

// Binds `buffer` to the named attribute if the program actually uses it (the
// GLSL compiler strips unused inputs, so a missing name is not an error).
export function attrib(
  gl: WebGL2RenderingContext,
  p: Program,
  name: string,
  buffer: WebGLBuffer,
  size: number,
  stride: number,
  offset: number,
  divisor: number,
): void {
  const loc = p.a[name];
  if (loc === undefined || loc < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
  gl.vertexAttribDivisor(loc, divisor);
}
