// upng-js ships no types. This shim covers the subset we use: APNG encode
// from an array of 32-bit RGBA frame buffers plus per-frame millisecond delays.
declare module 'upng-js' {
  interface UPNG {
    encode(
      imgs: ArrayBuffer[],
      w: number,
      h: number,
      cnum: number,
      delays?: number[],
    ): ArrayBuffer;
  }
  const UPNG: UPNG;
  export default UPNG;
}
