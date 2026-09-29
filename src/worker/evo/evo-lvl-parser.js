/*
  4x4 Evolution .LVL and .WAT.

  Parsing is OpenPhotex's (src/vendor/openphotex, the canonical Terminal Reality format
  library), consolidated from this file's former implementation. Do not add format
  knowledge here; change OpenPhotex and re-vendor it. See its docs/EVO.md.
*/
export { parseEvoLvl, parseEvoWat } from "../../vendor/openphotex/index.js";
