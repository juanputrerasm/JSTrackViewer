/*
  TV-family and Hellbender world coordinates.

  Parsing is OpenPhotex's (src/vendor/openphotex, the canonical Terminal Reality format
  library), which carries this module's former implementation and its evidence. Do not add
  format knowledge here; change OpenPhotex and re-vendor it.
*/
export {
  TV_UNITS_PER_CELL, TV_UNITS_PER_HEIGHT_STEP, tvPlacementToEditor, tvHeightToAltitude, parseIntTriple, toDataLines,
  hbPlacementToEditor, placementToEditor,
} from "../vendor/openphotex/index.js";
