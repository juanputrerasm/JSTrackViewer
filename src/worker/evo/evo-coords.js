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

/*
  The world constants and height sampling are OpenPhotex's (src/evo/coords.ts), with the
  evidence for the scale, the grid order and the water divisor. What stays here is how a
  placement enters this viewer's box and rotation conventions.
*/
export {
  EVO_CELL_SIZE, EVO_HEIGHT_DIVISOR, EVO_WATER_HEIGHT_DIVISOR, EVO_GRID_SIZE, EVO_WORLD_SIZE, evoHeightAtCell, evoHeightAt,
} from "../../vendor/openphotex/index.js";

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
