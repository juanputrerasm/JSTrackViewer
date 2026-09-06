/*
  MRGL material flags, shared by the worker's BIN decoder and the main thread's renderer.

  Traxx strides over MRGL_MATERIAL records without reading them, because its editor preview
  renders no materials. A viewer of the GAME has to: these flags are what decide whether a
  face is glass, a foliage cutout, additive, two-sided or emissive. Guessing that from the
  face type alone is what made every material-bearing model render as flat opaque geometry.

  Values from JSPod's BIN viewer, which established them against real models.
*/
export const MATERIAL_FLAGS = {
  LIT:       0x0001,
  BLEND:     0x0004,
  ALPHATEST: 0x0008,
  ADDITIVE:  0x0010,
  TWOSIDED:  0x0080,
  NOZWRITE:  0x0100,
  EMISSIVE:  0x0200,
  TINT:      0x0400,
  ALPHAREF:  0x0800,
  TEXSOLID:  0x2000,
};

// MRGL_MATERIAL2 flags.
export const MATERIAL2_FLAGS = {
  NORMALMAP: 0x0001,
};
