import { resolveAsset } from "./pod-format.js";
import { archiveTitle, normalizeArchiveName, replaceExtension } from "../shared/path-utils.js";
import { decodeGroundBoxes } from "../vendor/openphotex/index.js";

/**
 * Loads ground-box layers from companion lower/upper/face entries, found beside the heightfield
 * by stem. Decoding them is OpenPhotex's (decodeGroundBoxes, which documents the three grids).
 *
 * A Hellbender level has two such layers on one grid: .RA0/.RA1/.CL0 above ground and
 * .RA4/.RA5/.CL2 in the cavern below it, the second on the biased altitude the cavern grids
 * use, so the caller names the extensions and the altitude bias.
 */
export function loadGroundBoxes(podIndex, getBytes, rawName, gridSize, layer = {}) {
  const { lower = ".RA0", upper = ".RA1", faces = ".CL0", heightOffset = 0 } = layer;
  const ra0Entry = resolveDataAsset(podIndex, replaceExtension(rawName, lower));
  const ra1Entry = resolveDataAsset(podIndex, replaceExtension(rawName, upper));
  const cl0Entry = resolveDataAsset(podIndex, replaceExtension(rawName, faces));
  if (!ra0Entry || !ra1Entry) return [];
  return decodeGroundBoxes(getBytes(ra0Entry), getBytes(ra1Entry), cl0Entry ? getBytes(cl0Entry) : null, gridSize, heightOffset);
}

function resolveDataAsset(podIndex, name) {
  const normalized = normalizeArchiveName(name);
  if (!normalized) return null;
  if (/[\\/]/.test(normalized)) return resolveAsset(podIndex, normalized);
  const title = archiveTitle(normalized);
  return resolveAsset(podIndex, "DATA/" + title) ?? resolveAsset(podIndex, normalized);
}
