/*
  4x4 Evolution .TEX terrain and shadow texture tables.

  Parsing is OpenPhotex's (src/vendor/openphotex, the canonical Terminal Reality format
  library), consolidated from this file's former implementation. Do not add format
  knowledge here; change OpenPhotex and re-vendor it. See its docs/EVO.md.
*/
export { parseEvoTex } from "../../vendor/openphotex/index.js";
