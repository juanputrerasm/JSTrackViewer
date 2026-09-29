/*
  MRGL material flags, shared by the worker's BIN decoder and the main thread's renderer.

  They come from OpenPhotex (MRGLMAT and MRGLMAT2), the canonical Terminal Reality format
  library: they decide whether a face is glass, a foliage cutout, additive, two-sided or
  emissive, which is what the renderer needs to know about every material-bearing model.
*/
export { MRGLMAT as MATERIAL_FLAGS, MRGLMAT2 as MATERIAL2_FLAGS } from "../vendor/openphotex/index.js";
