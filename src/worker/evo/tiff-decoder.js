/*
  4x4 Evolution 2 TIFF textures and normal maps.

  Parsing is OpenPhotex's (src/vendor/openphotex, the canonical Terminal Reality format
  library), consolidated from this file's former implementation. Do not add format
  knowledge here; change OpenPhotex and re-vendor it. See its docs/EVO.md.
*/
import { decodeTiff, isTiff } from "../../vendor/openphotex/index.js";

export { isTiff };

export function decodeTiffTexture(bytes, textureName) {
  const { width, height, rgba, hasAlpha } = decodeTiff(bytes, textureName);
  return { name: textureName, width, height, rgba, hasAlpha };
}
