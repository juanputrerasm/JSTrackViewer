/*
  The bridge between the physics world and the scene.

  The simulation runs in feet, because that is what the game's own data is in: TRK wheel
  anchors, scrape points and light radii are all labelled "(ft)" in BinEdit's headers, and a
  SIT `ipos` is a plain foot position. The scene is not in feet. It inherits Traxx's world
  units, which are anisotropic: 2 units to a foot across the map and 1.5 up it, the 0.75
  ratio scene.js calls TRAXX_Z_STRETCH.

  Running the sim in scene units would mean a gravity that differs by axis and a truck whose
  wheelbase and ride height are on different scales, so every force would have to carry the
  stretch around with it. Instead the sim stays in honest feet and this module is the only
  place that knows about the conversion.

  How the numbers were established, with scratchpad/calib.py over the stock PODs:

    SUMMIT1's start grid is on dead flat ground, terrain height exactly 50.00 steps, and all
    eight stock trucks are parked at exactly 53.00. A 3 step rest height for a truck whose
    front wheel anchor is 3.8 ft below the body origin only works out if a step is 2 ft, and
    at 2 ft the SIT altitude column is simply feet (BIGFOOT: ipos.y 106.0, altitude 53 steps,
    106 ft). That fixes the whole chain:

      1 height step = 2 ft          1 cell = 64 units = 32 ft
      horizontal:  2 units per ft   vertical: 1.5 units per ft
      world:       16384 units = 8192 ft square

  Per-track rest heights vary (ALASKA 4.5 steps, CRAZY98 5.0, BAJA 2.4 to 4.5), so the stored
  spawn altitude is an authored drop height rather than a settled physics pose. Spawning snaps
  to the terrain rather than trusting it.
*/

/** Scene units per foot, across the map. */
export const UNITS_PER_FOOT_H = 2;
/** Scene units per foot, vertically. UNITS_PER_FOOT_V / UNITS_PER_FOOT_H is TRAXX_Z_STRETCH. */
export const UNITS_PER_FOOT_V = 1.5;
/** Feet per raw heightfield step, for the MTM family. */
export const FEET_PER_HEIGHT_STEP = 2;

const DEFAULT_CELL_SIZE = 64;
const DEFAULT_HEIGHT_SCALE = 3;

/*
  Physics space is scene space measured in feet: x and z keep the scene's axes, including its
  flipped Z, and y is up. Keeping the axes and changing only the units means a pose converts
  with three multiplications and no reflection, and a heading in the sim is the same heading
  the scene draws. The editor-space helpers exist because that is what track data stores.
*/
export function createWorldFrame(trackData) {
  const terrain = trackData?.terrain ?? null;
  const gridSize = terrain?.gridSize ?? 256;
  const cellSize = terrain?.cellSize ?? DEFAULT_CELL_SIZE;
  const heightScale = terrain?.heightScale ?? DEFAULT_HEIGHT_SCALE;
  const bytesPerCell = terrain?.rawBytesPerCell ?? 1;
  const heightDivisor = terrain?.heightDivisor ?? 0;
  const worldSize = gridSize * cellSize;

  /*
    The heightfield, as the terrain mesh reads it.

    `rawData` arrives from the worker as an ArrayBuffer, and the scene keeps its own
    Uint8Array view; take a view here rather than a copy so a 128 KB grid is not duplicated
    per frame consumer.
  */
  const raw = terrain?.rawData
    ? (terrain.rawData instanceof Uint8Array ? terrain.rawData : new Uint8Array(terrain.rawData))
    : null;

  /** One raw sample, in height steps. Mirrors sampleHeight in worker/terrain-builder.js. */
  function stepsAtCell(cx, cz) {
    if (!raw) return 0;
    const x = cx < 0 ? 0 : (cx > gridSize - 1 ? gridSize - 1 : cx);
    const z = cz < 0 ? 0 : (cz > gridSize - 1 ? gridSize - 1 : cz);
    const off = (x + z * gridSize) * bytesPerCell;
    if (bytesPerCell === 1) return raw[off] ?? 0;
    const lo = raw[off] ?? 0;
    const hi = raw[off + 1] ?? 0;
    // An explicit divisor means the encoding is known (Evo's 11.5 fixed point). Otherwise the
    // MTM reading: a zero high byte is an 8-bit grid stored two bytes wide.
    if (heightDivisor) return (lo | (hi << 8)) / heightDivisor;
    if (hi === 0) return lo;
    return (lo | (hi << 8)) >>> 6;
  }

  const stepsToFeet = (steps) => steps * heightScale / UNITS_PER_FOOT_V;

  /*
    Terrain height under a point, in feet, interpolated over the same two triangles the mesh
    is built from.

    Getting the diagonal right matters more than it sounds. terrain-builder.js winds each cell
    as (v0,v1,v2) and (v0,v2,v3), which puts the split along v0 to v2, that is from the cell's
    (cx,cz) corner to its (cx+1,cz+1) corner. Interpolating bilinearly instead would put the
    wheels above the surface on one half of every cell and below it on the other, and on MTM's
    32 ft cells that error is large enough to bounce a truck.

    Local coordinates: u runs from the v0 corner toward v1 (+x), w runs from v0 toward v3,
    which is scene -z, because the builder lays row cz at (gridSize - cz) * cellSize. The
    first triangle covers u >= w and the second covers w >= u.
  */
  function heightAtFeet(xFt, zFt) {
    if (!raw) return 0;
    const sceneX = xFt * UNITS_PER_FOOT_H;
    const sceneZ = zFt * UNITS_PER_FOOT_H;
    const gx = sceneX / cellSize;
    // Invert z = (gridSize - cz) * cellSize.
    const gz = gridSize - sceneZ / cellSize;
    const cx = Math.floor(gx);
    const cz = Math.floor(gz);
    const u = gx - cx;
    const w = gz - cz;

    const h00 = stepsAtCell(cx, cz);
    const h10 = stepsAtCell(cx + 1, cz);
    const h11 = stepsAtCell(cx + 1, cz + 1);
    const h01 = stepsAtCell(cx, cz + 1);

    const steps = u >= w
      ? h00 + (h10 - h00) * u + (h11 - h10) * w
      : h00 + (h11 - h01) * u + (h01 - h00) * w;
    return stepsToFeet(steps);
  }

  /*
    The unit normal of the terrain triangle under a point, in physics axes.

    Taken from the triangle the point is actually in rather than from a smoothed corner
    normal. The mesh shades with averaged corner normals (see cornerNormal in
    terrain-builder.js) because a faceted hillside looks wrong, but a contact has to agree
    with the surface the wheel ray hit, or a truck parked on a slope drifts against geometry
    that is not there.
  */
  function normalAtFeet(xFt, zFt) {
    if (!raw) return { x: 0, y: 1, z: 0 };
    const cellFt = cellSize / UNITS_PER_FOOT_H;
    const sceneX = xFt * UNITS_PER_FOOT_H;
    const sceneZ = zFt * UNITS_PER_FOOT_H;
    const gx = sceneX / cellSize;
    const gz = gridSize - sceneZ / cellSize;
    const cx = Math.floor(gx);
    const cz = Math.floor(gz);
    const u = gx - cx;
    const w = gz - cz;

    const h00 = stepsToFeet(stepsAtCell(cx, cz));
    const h10 = stepsToFeet(stepsAtCell(cx + 1, cz));
    const h11 = stepsToFeet(stepsAtCell(cx + 1, cz + 1));
    const h01 = stepsToFeet(stepsAtCell(cx, cz + 1));

    // Slopes in feet per foot along +x (u) and along -z (w).
    let dhdu;
    let dhdw;
    if (u >= w) {
      dhdu = (h10 - h00) / cellFt;
      dhdw = (h11 - h10) / cellFt;
    } else {
      dhdu = (h11 - h01) / cellFt;
      dhdw = (h01 - h00) / cellFt;
    }
    // Tangents: along +x it is (1, dhdu, 0); w points at scene -z, so (0, dhdw, -1).
    // n = t_w x t_u keeps y positive.
    const nx = -dhdu;
    const ny = 1;
    const nz = dhdw;
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  return {
    gridSize,
    cellSize,
    heightScale,
    worldSize,
    /** Map extent in feet, one side. */
    worldSizeFeet: worldSize / UNITS_PER_FOOT_H,
    /** Cell pitch in feet (32 for the MTM family). */
    cellSizeFeet: cellSize / UNITS_PER_FOOT_H,
    hasTerrain: !!raw,

    heightAtFeet,
    normalAtFeet,

    /*
      Where a truck is DRAWN, which is not its position scaled.

      The scene is anisotropic: 2 units to a foot across the map, 1.5 up it. Terrain is drawn
      that way, so a height step of 2 ft becomes 3 units rather than the 4 a true scale would
      give, and the whole world is 25% flatter than life. (terrain-builder's own default of 4
      IS the true scale; the app overrides it to 3 to match Traxx.)

      Drawing a truck by that same convention squashes it by a quarter, which is visibly wrong
      next to the truck viewer, and the truck is the one thing on screen anybody looks at
      closely. So it is drawn true, at the horizontal scale on every axis.

      That leaves one problem, which is what this function exists for. Scaling the truck's
      GEOMETRY at 2 and its POSITION at 1.5 puts the two out of step: BIGFOOT's body origin
      rides 6.8 ft up, so at 1.5 it is drawn 10.2 units above the ground while its own wheels
      reach 13.6 units down, and the truck sinks about 2.3 ft into the terrain. The fix is to
      measure the truck's height from the ground rather than from zero: the contact point
      follows the terrain's vertical scale, and everything above it is drawn true.

      A jump therefore reads a third higher than the terrain convention implies, which is the
      same exaggeration the terrain already applies to every hill, only in the other direction.
    */
    toSceneTruckPosition(posFeet, groundFeet) {
      const ground = groundFeet ?? heightAtFeet(posFeet.x, posFeet.z);
      return {
        x: posFeet.x * UNITS_PER_FOOT_H,
        y: ground * UNITS_PER_FOOT_V + (posFeet.y - ground) * UNITS_PER_FOOT_H,
        z: posFeet.z * UNITS_PER_FOOT_H,
      };
    },

    /** Physics feet to scene units. */
    toScene(xFt, yFt, zFt) {
      return {
        x: xFt * UNITS_PER_FOOT_H,
        y: yFt * UNITS_PER_FOOT_V,
        z: zFt * UNITS_PER_FOOT_H,
      };
    },

    /** Scene units to physics feet. */
    toFeet(x, y, z) {
      return {
        x: x / UNITS_PER_FOOT_H,
        y: y / UNITS_PER_FOOT_V,
        z: z / UNITS_PER_FOOT_H,
      };
    },

    /*
      An editor-space record ([x, y, altitude], what .SIT and .DEF placements store) as a
      physics position in feet. Same transform scene.js `_editorToScene` applies, then scaled
      into feet: editor x and y are already world units, and the altitude is in height steps.
    */
    editorToFeet(position) {
      const [ex = 0, ey = 0, alt = 0] = position ?? [];
      return {
        x: ex / UNITS_PER_FOOT_H,
        y: stepsToFeet(alt),
        z: (worldSize - ey) / UNITS_PER_FOOT_H,
      };
    },

    /*
      A heading from a track record as a physics forward vector.

      scene.js `_buildTrucks` spawns its grid markers with forward = (sin psi, 0, -cos psi),
      which is the convention the start grid and the course segments share.
    */
    headingToForward(psi) {
      return { x: Math.sin(psi ?? 0), y: 0, z: -Math.cos(psi ?? 0) };
    },
  };
}
