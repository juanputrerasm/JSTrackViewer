/*
  .ANI animated texture definitions (Terminal Velocity / Fury3).

  Parsing is OpenPhotex's (src/vendor/openphotex, the canonical Terminal Reality format
  library), which carries this module's former implementation and its evidence. Do not add
  format knowledge here; change OpenPhotex and re-vendor it.
*/
export {
  ANIMATION_BASE_FPS, parseAnimations,
} from "../vendor/openphotex/index.js";
