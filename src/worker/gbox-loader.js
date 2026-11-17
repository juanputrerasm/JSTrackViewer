import { resolveAsset } from "./pod-format.js";
import { archiveTitle, normalizeArchiveName, replaceExtension } from "../shared/path-utils.js";
import { decodeGroundBoxes, mtm2GroundBoxDepth, mtm2GroundBoxHeightFt } from "../vendor/openphotex/index.js";

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

/*
  A track format version 6 track's .RA0/.RA1/.CL0 (the spec's section 8.3): N x N cells, 8-bit or
  16-bit by size, the pair at the same depth (mtm2GroundBoxDepth throws otherwise, and the track is
  refused with its message). Heights go through mtm2GroundBoxHeightFt with the track's step and base
  (128 and 0 when the track has no terrainHeightMap: CP4's rules), and are handed on in legacy 2 ft
  steps like every other box, so `lower` and `upper` may be fractional or negative. Such a box
  carries `v6: true`: its top is no longer "0 means no box" (the decoder already dropped those),
  and `lowerFt` / `upperFt` keep its feet.
*/
export function loadMtm2V6GroundBoxes(podIndex, getBytes, rawName, cells, { step = 128, base = 0 } = {}) {
  const ra0Entry = resolveDataAsset(podIndex, replaceExtension(rawName, ".RA0"));
  const ra1Entry = resolveDataAsset(podIndex, replaceExtension(rawName, ".RA1"));
  const cl0Entry = resolveDataAsset(podIndex, replaceExtension(rawName, ".CL0"));
  if (!ra0Entry || !ra1Entry) return [];
  const ra0 = getBytes(ra0Entry), ra1 = getBytes(ra1Entry);
  const depth = mtm2GroundBoxDepth(ra0, ra1, cells);
  const boxes = decodeGroundBoxes(ra0, ra1, cl0Entry ? getBytes(cl0Entry) : null, cells, 0, depth);
  for (const box of boxes) {
    box.lowerFt = mtm2GroundBoxHeightFt(box.lower, depth, step, base);
    box.upperFt = mtm2GroundBoxHeightFt(box.upper, depth, step, base);
    box.lower = box.lowerFt / 2;
    box.upper = box.upperFt / 2;
    box.midZ = (box.lower + box.upper) / 2;
    box.depth = depth;
    box.v6 = true;
  }
  return boxes;
}

export function resolveDataAsset(podIndex, name) {
  const normalized = normalizeArchiveName(name);
  if (!normalized) return null;
  if (/[\\/]/.test(normalized)) return resolveAsset(podIndex, normalized);
  const title = archiveTitle(normalized);
  return resolveAsset(podIndex, "DATA/" + title) ?? resolveAsset(podIndex, normalized);
}
