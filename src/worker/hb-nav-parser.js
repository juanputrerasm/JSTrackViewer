/*
  .NAV navigation points (Hellbender).

  Parsing is OpenPhotex's (src/vendor/openphotex, the canonical Terminal Reality format
  library), which carries this module's former implementation and its evidence. Do not add
  format knowledge here; change OpenPhotex and re-vendor it.
*/
export {
  HBNAV_TARGET_LIST, HBNAV_TUNNEL_ENTRANCE, HBNAV_CHECKPOINT, HBNAV_JUMP_ZONE, HBNAV_TUNNEL_EXIT, HBNAV_BOSS,
  HBNAV_START_POINT, HBNAV_SYNC_POINT, HBNAV_RESCUE_BEACON, HBNAV_END_OF_NAVS, HBNAV_ESCORT, HBNAV_RETRIEVE,
  HBNAV_PURSUE, HBNAV_TYPE_NAMES, parseHbNavPoints,
} from "../vendor/openphotex/index.js";
