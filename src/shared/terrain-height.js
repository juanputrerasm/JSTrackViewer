/*
  Decoding terrain RAW samples into legacy heights, for every heightfield reader in the viewer.

  Parsing is OpenPhotex's (src/vendor/openphotex, the canonical Terminal Reality format
  library), which carries this module's former implementation and its evidence. Do not add
  format knowledge here; change OpenPhotex and re-vendor it.
*/
export {
  CPR_HEIGHT_DIVISOR, CPR_ALTITUDE_DIVISOR, CPR_HEIGHT_UNIT_SCALE, LEGACY_ALTITUDE_DIVISOR, decodeHeightSample,
  legacyWholeHeight16, heightAtCell,
} from "../vendor/openphotex/index.js";
