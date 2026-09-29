/*
  4x4 Evolution .SIT scene scripts, v6 and v7.

  Parsing is OpenPhotex's (src/vendor/openphotex, the canonical Terminal Reality format
  library), consolidated from this file's former implementation. Do not add format
  knowledge here; change OpenPhotex and re-vendor it. See its docs/EVO.md.
*/
export { isEvoSit, evoGameForSitVersion, parseEvoSit, evoTrackTypeName } from "../../vendor/openphotex/index.js";
