import { resolveAsset } from "./pod-format.js";
import { archiveTitle, normalizeArchiveName, replaceExtension } from "../shared/path-utils.js";
import { HB_UNDERGROUND_BIAS, decodeHbUnderground } from "../vendor/openphotex/index.js";

/*
  Hellbender's underground: a second world beneath the level, on the same grid, described by
  companion files the level never names (.RA2 floor, .RA3 ceiling, .CL1 textures). Decoding them,
  and the evidence for the -256 altitude bias, the hollow-cell mask and which half of .CL1 is
  the floor, is OpenPhotex's (decodeHbUnderground). This file finds the files by stem.
*/

export { HB_UNDERGROUND_BIAS };

/**
 * Reads a Hellbender level's cavern layers.
 *
 * Returns null when the level has no cavern, when a companion file is missing, or when one is
 * the wrong size - a viewer that loses this layer still draws the surface.
 */
export function loadUndergroundLayers(podIndex, getBytes, rawName, gridSize) {
  const grid = (ext) => {
    const entry = resolveDataAsset(podIndex, replaceExtension(rawName, ext));
    return entry ? getBytes(entry) : null;
  };
  return decodeHbUnderground(grid(".RA2"), grid(".RA3"), grid(".CL1"), gridSize);
}

function resolveDataAsset(podIndex, name) {
  const normalized = normalizeArchiveName(name);
  if (!normalized) return null;
  if (/[\\/]/.test(normalized)) return resolveAsset(podIndex, normalized);
  const title = archiveTitle(normalized);
  return resolveAsset(podIndex, "DATA/" + title) ?? resolveAsset(podIndex, normalized);
}
