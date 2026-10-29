import { resolveAsset } from "./pod-format.js";
import { archiveTitle, normalizeArchiveName, replaceExtension } from "../shared/path-utils.js";
import { HB_UNDERGROUND_BIAS, decodeHbUnderground } from "../vendor/openphotex/index.js";

/*
  Hellbender's underground: a second world beneath the level, on the same grid, described by
  companion files the level never names (.RA2 floor, .RA3 ceiling, .CL1 textures). Decoding them,
  and the evidence for the -255 altitude bias (byte 255 is altitude 0), the hollow-cell mask and which half of .CL1 is
  the floor, is OpenPhotex's (decodeHbUnderground). This file finds the files by stem.
*/

export { HB_UNDERGROUND_BIAS };

/*
  Openings between Hellbender's two worlds.

  The engine's own definition (HELLBEND.EXE 0x41a8c0, docs/HELLBENDER_EXE_ANALYSIS.md 4.3): a
  grid sample is an opening when its surface height is 0 AND its cavern ceiling is at altitude 0,
  that is .RA3 byte 255. Each frame the engine looks for one near the camera and, when it finds
  one, draws both worlds, so the player sees down into the cavern and flies through. In the
  shipped game 79,946 samples are openings: almost all of FLOAT, FLOAT2, ROID, ROID2, ROID3 and
  SHIP (the floating levels), and the shafts and pits of JURASIC, JURASIC3, ROID4 and KREASH3.
  A surface sample at 0 with the cavern ceiling below it is ground, not a hole.

  The viewer draws quads, so a quad is open when all four of its corner samples are openings.
  The cavern ceiling is cut at the same quads: there it is the hole's lower rim at altitude 0,
  and drawn it would be a lid over the opening.

  This is engine behaviour on top of ordinary heightfields, so it lives here, beside the
  viewer's other Hellbender layers, rather than in OpenPhotex.
*/

/** One byte per grid sample: 1 where the surface is 0 and the cavern ceiling byte is 255. */
export function hbOpeningSamples(rawData, ceilingHeights, gridSize) {
  const cells = gridSize * gridSize;
  if (!rawData || !ceilingHeights || rawData.length < cells || ceilingHeights.length < cells) return null;
  const open = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) open[i] = rawData[i] === 0 && ceilingHeights[i] === 255 ? 1 : 0;
  return open;
}

/**
 * The surface's draw mask: 0 for a quad whose four corners are openings, 1 otherwise. Null when
 * the level has no opening quad, which keeps another 16 KiB buffer off ordinary levels.
 *
 * The returned byte per cell matches terrain-builder's cavern mask convention.
 */
export function buildHbSurfaceMask(rawData, gridSize, ceilingHeights) {
  if (!rawData || !Number.isInteger(gridSize) || gridSize <= 0) return null;
  const open = hbOpeningSamples(rawData, ceilingHeights, gridSize);
  if (!open) return null;

  const mask = new Uint8Array(gridSize * gridSize);
  const at = (x, z) => open[
    Math.min(gridSize - 1, Math.max(0, x)) +
    Math.min(gridSize - 1, Math.max(0, z)) * gridSize
  ];
  let holes = 0;
  for (let z = 0; z < gridSize; z++) {
    for (let x = 0; x < gridSize; x++) {
      const hole = at(x, z) && at(x + 1, z) && at(x + 1, z + 1) && at(x, z + 1);
      mask[x + z * gridSize] = hole ? 0 : 1;
      if (hole) holes++;
    }
  }
  return holes ? mask : null;
}

/** True when more than half the surface is open: the floating levels, whose cavern is the world. */
export function isHbFloatingSurface(surfaceMask) {
  if (!surfaceMask) return false;
  let holes = 0;
  for (let i = 0; i < surfaceMask.length; i++) if (!surfaceMask[i]) holes++;
  return holes > surfaceMask.length / 2;
}

/**
 * Removes a broad, perfectly flat fallback plane from one cavern heightfield.
 *
 * A plane qualifies only when one height owns more than half the grid, and only quads whose
 * four corners equal that height are removed. Slopes at its boundary, carved cavern geometry,
 * and the companion ground boxes therefore survive unchanged.
 */
export function buildHbFlatLayerMask(heights, cellMask, gridSize) {
  const cells = gridSize * gridSize;
  if (!heights || heights.length < cells || !cellMask || cellMask.length < cells) return cellMask;

  const counts = new Uint32Array(256);
  let activeSamples = 0;
  for (let cell = 0; cell < cells; cell++) {
    if (!cellMask[cell]) continue;
    counts[heights[cell]]++;
    activeSamples++;
  }
  let planeHeight = 0;
  for (let height = 1; height < counts.length; height++) {
    if (counts[height] > counts[planeHeight]) planeHeight = height;
  }
  if (counts[planeHeight] <= activeSamples / 2) return cellMask;

  const result = cellMask.slice();
  const at = (x, z) => heights[
    Math.min(gridSize - 1, Math.max(0, x)) +
    Math.min(gridSize - 1, Math.max(0, z)) * gridSize
  ];
  for (let z = 0; z < gridSize; z++) {
    for (let x = 0; x < gridSize; x++) {
      const cell = x + z * gridSize;
      if (!result[cell]) continue;
      if (at(x, z) === planeHeight && at(x + 1, z) === planeHeight &&
          at(x + 1, z + 1) === planeHeight && at(x, z + 1) === planeHeight) {
        result[cell] = 0;
      }
    }
  }
  return result;
}

/**
 * Cuts the cavern where the surface is open.
 *
 * Every level with an opening gets a ceiling mask without the opening quads. A floating level
 * (more than half the surface open) is an exposed lower world rather than an enclosed cavern:
 * it is lit by the sun, and its broad flat fallback planes, the floor's and the ceiling's,
 * are removed too (buildHbFlatLayerMask).
 */
export function maskHbUnderground(cavern, surfaceMask) {
  if (!cavern || !surfaceMask) return cavern;
  const both = (a, b) => {
    const out = a.slice();
    for (let i = 0; i < out.length; i++) out[i] = a[i] && b[i] ? 1 : 0;
    return out;
  };
  if (!isHbFloatingSurface(surfaceMask)) {
    return { ...cavern, ceilingMask: both(cavern.mask, surfaceMask) };
  }
  return {
    ...cavern,
    // Once a fallback plane is opened, this is an exposed lower world rather than an enclosed
    // cavern. The renderer should light it with the same sun and shadows as surface terrain.
    sunlit: true,
    floorMask: buildHbFlatLayerMask(cavern.floorHeights, cavern.mask, cavern.gridSize),
    ceilingMask: both(buildHbFlatLayerMask(cavern.ceilingHeights, cavern.mask, cavern.gridSize), surfaceMask),
  };
}

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
