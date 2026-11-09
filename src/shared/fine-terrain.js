/*
  Community Patch 4's 8 ft terrain grid, sampled the way the mesh draws it.

  A Spline or Full Map MTM2 track (sit-parser.js applyCp4Heights) carries `terrain.fine`:
  { heights, subdivisions, divisor }, a (gridSize * subdivisions)^2 grid of 16-bit samples in file
  order (rows along the level's z), `divisor` samples to a legacy 2 ft step. terrain-builder.js
  buildFineCells draws each fine cell as two triangles split on the checkerboard of the fine
  indices, as the CP4 ground query does (OpenMTM2 docs/CP4_EXE_ANALYSIS.md 1.6); this is the same
  surface for drive mode (drive/world-frame.js) and the scene's marker placement. Indices clamp
  at the edge of the map, as the coarse samplers (heightAtCell) do.
*/

/** A sampler over `fine`, or null when the terrain has no fine grid. */
export function createFineSampler(fine, gridSize = 256) {
  if (!fine?.heights || !(fine.subdivisions > 1)) return null;
  const heights = fine.heights instanceof Uint16Array ? fine.heights : new Uint16Array(fine.heights);
  const s = fine.subdivisions;
  const side = gridSize * s;
  if (heights.length !== side * side) return null;
  const divisor = fine.divisor ?? 256;
  const clamp = (v) => (v < 0 ? 0 : v > side - 1 ? side - 1 : v);
  const at = (x, z) => heights[clamp(x) + clamp(z) * side] / divisor;

  /*
    The fine cell under a point given in coarse-cell coordinates (gx along +x, gz along the
    rows): its corners in steps, h00 at (cx, cz) to h11 at (cx + 1, cz + 1), the fractions u and w
    across it, and whether it splits along (cx + 1, cz) to (cx, cz + 1).
  */
  function cell(gx, gz) {
    const fx = gx * s, fz = gz * s;
    const cx = Math.floor(fx), cz = Math.floor(fz);
    return {
      h00: at(cx, cz), h10: at(cx + 1, cz), h11: at(cx + 1, cz + 1), h01: at(cx, cz + 1),
      u: fx - cx, w: fz - cz, other: ((cx + cz) & 1) === 1,
    };
  }

  return { subdivisions: s, side, at, cell };
}
