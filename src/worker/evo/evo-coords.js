/*
  4x4 Evolution world space, and how it reaches the viewer's scene space.

  Evo is Y-up: a .SIT `wPos` is (x, height, z), .SMF vertices are (x, height, z), .VEG tree
  records are (x, height, z), and `cstart`/`cend` are the same. That was established from the
  data rather than assumed - see the notes on each fact below - because the viewer's existing
  formats are all Z-up and misreading the axis order silently produces a track that looks
  plausible from above and is wrong everywhere else.

  Scale, verified across ASPEN, THEHILL, BAJBEACH and PEAK:

      cell   = 32 world units, so the 256-square grid is an 8192-unit world
      height = uint16LE / 32          (11.5 fixed point)
      grid index = column + row * 256, indexed as raw[x + z * 256]

  The index order is the one fact here that a plausible alternative could have won, so it was
  measured: taking every `wPos` in all four stock tracks and comparing the object's height
  against the terrain beneath it, `x + z*256` lands within a mean of 12-33 units while the
  transposed and row-flipped readings are off by 65-407. The residual is a consistent ~11
  units of objects sitting above their pivot, not a scale error.

  The viewer's scene space is Y-up with Z flipped, which the terrain builder has always done
  (`z0 = (gridSize - cz) * cellSize`). Applying the same flip to placements keeps objects on
  the ground the terrain builds:

      scene = (evoX, evoY, worldSize - evoZ)

  That flip is a reflection, so it reverses handedness. Two consequences are dealt with once,
  at this boundary, rather than being rediscovered downstream:

    - .SMF vertices are emitted with Z negated and their triangle winding reversed, so faces
      still point outward (see smf-parser.js).
    - a rotation by psi about Evo's up axis becomes a rotation by -psi about the scene's.

  Which component of `wOrient` is that heading was also measured rather than assumed. Runs of
  elongated props - guardrails, fences, handrails, coral - should point at their neighbours,
  and scoring that alignment over every such run in the stock tracks gives -psi 67%/83%
  against +psi 30%/65% on the two Evo 2 tracks, with Evo 1 agreeing more weakly because its
  elongated models are scattered logs rather than runs. The third component is the heading.

  The first two components are pitch and roll. They are nonzero on only 10-20% of placements
  and no test available here separates a pitch/roll swap from the correct assignment, so the
  mapping below is correlated, not verified, and is marked as such.
*/

/** Terrain cell size, in world units. */
export const EVO_CELL_SIZE = 32;

/** Divisor turning a raw uint16 height into world units. */
export const EVO_HEIGHT_DIVISOR = 32;

/*
  The .LVL water height is on a half-unit scale, so it is divided by 2 to reach world units.

  It is NOT in the same units as everything else in the file, which is easy to miss because
  the number looks reasonable on its own. Taken at face value it floods 48% of ASPEN, 93% of
  BAJBEACH and puts every one of those tracks' racing lines underwater - the single clearest
  test, since a course segment is never submerged: ASPEN's lowest course point is 141.6
  against a face-value water height of 274, PEAK's is 139.1 against 180, and BAJBEACH's is
  180.7 against 358. Halving clears all three.

  BAJBEACH then confirms it from three independent directions:

    - its sea floor is a dead-flat plateau at exactly 136 covering 22,182 cells, and 179 sits
      above it where a sea surface belongs;
    - SK1RAFT.SMF, a raft, floats at 182.2, just above 179 and 176 below the face value;
    - its two piers sit at 173.8 and 175.5, decks rising out of the water rather than under it.

  Rendered as a shoreline, 179 also resolves the island into the skull shape the track's own
  .WAT base name calls it, with both eye-socket lagoons filled. ASPEN at 137 resolves a
  narrow river winding along the valley beside the course. Neither shape appears at any other
  divisor, which is what makes this a measurement rather than a fudge factor.
*/
export const EVO_WATER_HEIGHT_DIVISOR = 2;

/** Evo terrain grids are always 256 square. */
export const EVO_GRID_SIZE = 256;

/** The world is one grid of cells on a side. */
export const EVO_WORLD_SIZE = EVO_GRID_SIZE * EVO_CELL_SIZE;

/*
  An Evo (x, height, z) placement in the viewer's existing box convention.

  Boxes travel as [x, depth, height] - the layout the MTM family uses and that scene.js turns
  into (x, height * heightScale, worldSize - depth). Evo builds at heightScale 1, so feeding
  it [evoX, evoZ, evoHeight] reproduces the transform above exactly, and every consumer that
  already understands a box position keeps working without knowing Evo exists.
*/
export function evoPositionToBox(position) {
  const [x, height, z] = position;
  return [x, z, height];
}

/**
 * Rotation for a placement, as the psi/theta/phi the scene builder expects.
 *
 * The scene applies these through its Evo matrix, which is the Z-flipped conjugate of the
 * Evo rotation; the sign changes that conjugation implies live there rather than here so
 * that this stays a description of the file.
 */
export function evoOrientToAngles(orient) {
  const [pitch, roll, heading] = orient;
  return { psi: heading ?? 0, theta: pitch ?? 0, phi: roll ?? 0 };
}

/** Terrain height in world units at a grid cell, clamped to the grid. */
export function evoHeightAtCell(rawData, gridX, gridZ) {
  if (!rawData) return 0;
  const x = Math.min(EVO_GRID_SIZE - 1, Math.max(0, gridX | 0));
  const z = Math.min(EVO_GRID_SIZE - 1, Math.max(0, gridZ | 0));
  const offset = (x + z * EVO_GRID_SIZE) * 2;
  return ((rawData[offset] ?? 0) | ((rawData[offset + 1] ?? 0) << 8)) / EVO_HEIGHT_DIVISOR;
}

/** Terrain height in world units under an Evo world (x, z), bilinearly sampled. */
export function evoHeightAt(rawData, worldX, worldZ) {
  const gx = worldX / EVO_CELL_SIZE;
  const gz = worldZ / EVO_CELL_SIZE;
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const fx = gx - x0;
  const fz = gz - z0;
  const h00 = evoHeightAtCell(rawData, x0, z0);
  const h10 = evoHeightAtCell(rawData, x0 + 1, z0);
  const h01 = evoHeightAtCell(rawData, x0, z0 + 1);
  const h11 = evoHeightAtCell(rawData, x0 + 1, z0 + 1);
  return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
}
