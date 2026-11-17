/*
  Decoding terrain RAW samples into legacy heights, for every heightfield reader in the viewer.

  Parsing is OpenPhotex's (src/vendor/openphotex, the canonical Terminal Reality format
  library), which carries this module's former implementation and its evidence. Do not add
  format knowledge here; change OpenPhotex and re-vendor it.
*/
import { heightAtCell as decodeHeightAtCell } from "../vendor/openphotex/index.js";

export {
  CPR_HEIGHT_DIVISOR, CPR_ALTITUDE_DIVISOR, CPR_HEIGHT_UNIT_SCALE, LEGACY_ALTITUDE_DIVISOR, decodeHeightSample,
  legacyWholeHeight16,
} from "../vendor/openphotex/index.js";

/*
  OpenPhotex heightAtCell, plus the terrain's `heightOffset` in steps: the layout a track format
  version 6 terrain is carried in (sit-parser.js applyV6Heights: samples over 2 * step, plus
  base / 2), the same offset terrain-builder.js adds to every vertex. Every other terrain has no
  offset and reads exactly as before.
*/
export function heightAtCell(terrain, raw, cx, cz) {
  const h = decodeHeightAtCell(terrain, raw, cx, cz);
  return raw && terrain?.heightOffset ? h + terrain.heightOffset : h;
}
