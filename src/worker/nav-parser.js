/*
  .NAV navigation points (Terminal Velocity / Fury3 / F!Zone).

  Parsing is OpenPhotex's (src/vendor/openphotex, the canonical Terminal Reality format
  library), which carries this module's former implementation and its evidence. Do not add
  format knowledge here; change OpenPhotex and re-vendor it.
*/
export {
  NAV_TARGET_LIST, NAV_TUNNEL_ENTRANCE, NAV_CHECKPOINT, NAV_JUMP_ZONE, NAV_TUNNEL_EXIT, NAV_BOSS, NAV_START_POINT,
  NAV_TYPE_NAMES, parseNavPoints, findStartPoint,
} from "../vendor/openphotex/index.js";
