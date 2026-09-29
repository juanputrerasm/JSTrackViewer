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

import { heightAtCell } from "../shared/terrain-height.js";
import { createRaceTrackSupport } from "./racetrack-collider.js";

/** How far under a CPR road surface the ground is held where it would poke through. */
const ROAD_GROUND_CLEARANCE_FT = 0.5;

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

  /**
   * One raw sample, in height steps, with its fraction: the same shared decode the mesh
   * builder uses, so CPR's 10.6 and Evo's 11.5 grids keep their low bits under the wheels.
   */
  function stepsAtCell(cx, cz) {
    return heightAtCell(terrain, raw, cx, cz);
  }

  const stepsToFeet = (steps) => steps * heightScale / UNITS_PER_FOOT_V;

  // The .TTY value per cell (100 * ground type + depth), when the track assigns any.
  const surface = terrain?.surface
    ? (terrain.surface instanceof Uint16Array ? terrain.surface : new Uint16Array(terrain.surface))
    : null;

  /** The ground type under a point, as its .TTY value; 0 (Default) off the grid or untyped. */
  function surfaceAtFeet(xFt, zFt) {
    if (!surface) return 0;
    const cx = Math.floor(xFt * UNITS_PER_FOOT_H / cellSize);
    // The same cell convention as terrainHeightAtFeet: row cz is laid at (gridSize - cz).
    const cz = Math.floor(gridSize - zFt * UNITS_PER_FOOT_H / cellSize);
    if (cx < 0 || cz < 0 || cx >= gridSize || cz >= gridSize) return 0;
    return surface[cx + cz * gridSize];
  }

  /*
    Whether a cell is split along its other diagonal, (cx+1,cz) to (cx,cz+1). Only on a
    checkerboard terrain (CPR), and only where cx + cz is odd; see cellSplit in
    terrain-builder.js. The wheels have to meet the triangles that are drawn.
  */
  const checkerboard = terrain?.cellSplit === "checkerboard";
  const splitsOther = (cx, cz) => checkerboard && ((cx + cz) & 1) === 1;

  /*
    Terrain height under a point, in feet, interpolated over the same two triangles the mesh
    is built from.

    Getting the diagonal right matters more than it sounds. terrain-builder.js winds a cell
    as (v0,v1,v2) and (v0,v2,v3) unless it is an odd cell on a checkerboard terrain (CPR),
    which is split the other way (see splitsOther). The usual split is along v0 to v2, that
    is from the cell's (cx,cz) corner to its (cx+1,cz+1) corner. Interpolating bilinearly instead would put the
    wheels above the surface on one half of every cell and below it on the other, and on MTM's
    32 ft cells that error is large enough to bounce a truck.

    Local coordinates: u runs from the v0 corner toward v1 (+x), w runs from v0 toward v3,
    which is scene -z, because the builder lays row cz at (gridSize - cz) * cellSize. The
    first triangle covers u >= w and the second covers w >= u.
  */
  function terrainHeightAtFeet(xFt, zFt) {
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

    let steps;
    if (splitsOther(cx, cz)) {
      // Split along v1-v3: (v0,v1,v3) covers u + w <= 1, (v1,v2,v3) the rest.
      steps = u + w <= 1
        ? h00 + (h10 - h00) * u + (h01 - h00) * w
        : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - w);
    } else {
      steps = u >= w
        ? h00 + (h10 - h00) * u + (h11 - h10) * w
        : h00 + (h11 - h01) * u + (h01 - h00) * w;
    }
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
  function terrainNormalAtFeet(xFt, zFt) {
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
    if (splitsOther(cx, cz)) {
      if (u + w <= 1) {
        dhdu = (h10 - h00) / cellFt;
        dhdw = (h01 - h00) / cellFt;
      } else {
        dhdu = (h11 - h01) / cellFt;
        dhdw = (h11 - h10) / cellFt;
      }
    } else if (u >= w) {
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

  /*
    CPR's road has precedence over the ground, in the sim as it does on screen.

    The scene discards any terrain inside the road's footprint (see _buildRoadMask in
    scene.js), because on a banked turn the 32 ft grid rises through the tarmac between its
    points. A heightfield cannot pass over the road, so terrain above the road there is
    terrain poking through it. Holding the ground just under the road keeps the wheels and
    the hull from meeting ground that is not drawn; the road collider carries them instead.
  */
  const road = (trackData?.raceTrackSurfaces?.length ?? 0) >= 2 ? createRaceTrackSupport(trackData) : null;
  const roadTopAt = (xFt, zFt) => (road ? road.supportAt(xFt, zFt, Infinity) : null);

  function heightAtFeet(xFt, zFt) {
    const ground = terrainHeightAtFeet(xFt, zFt);
    const top = roadTopAt(xFt, zFt);
    return top !== null && ground > top - ROAD_GROUND_CLEARANCE_FT ? top - ROAD_GROUND_CLEARANCE_FT : ground;
  }

  function normalAtFeet(xFt, zFt) {
    const top = roadTopAt(xFt, zFt);
    if (top !== null && terrainHeightAtFeet(xFt, zFt) > top - ROAD_GROUND_CLEARANCE_FT) return { x: 0, y: 1, z: 0 };
    return terrainNormalAtFeet(xFt, zFt);
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
    surfaceAtFeet,

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

    /*
      Where a truck is drawn, as a whole pose, from where its wheel mounts are.

      toSceneTruckPosition places the body origin from the ground under that one point, which
      holds on the flat and fails on a slope and in the air:

        - On a slope the ground under each wheel differs from the ground under the middle.
          That difference is drawn at the terrain's 1.5 units per foot while the truck's own
          tilt is drawn true at 2, so half of it is lost: climbing a steep hill, the rear
          wheels were drawn feet into the hillside and the front ones above it.
        - In the air every foot above the ground was drawn at 2 units instead of 1.5, so a
          truck high over a valley was drawn a third higher than it was, and the moment the
          ground fell away beneath it (off a crest, a cliff or a bridge deck) the drawn truck
          leapt upward by half the drop while the simulated one did nothing of the kind.

      So each mount is placed on its own: the terrain's scale for the world, plus the true
      scale for its height above the ground up to `reach` feet, which is the wheel hanging
      below it (the one part of the truck that has to meet the drawn ground). Above that the
      extra is constant, so height in the air is drawn at the terrain's scale and a change of
      ground underneath moves nothing. The drawn truck is then the rigid pose that best fits
      the placed mounts: axes from the front, rear, left and right pairs, position from their
      centroid.

      @param mounts [{ world: {x,y,z} feet, body: {x,y,z} feet from the body origin,
                       ground: feet, reach: feet, isFront, isLeft }]
      @returns { position, right, up, back } in scene units, or null for fewer than 4 mounts
    */
    toSceneTruckPose(mounts) {
      if (!mounts || mounts.length < 4) return null;
      const H = UNITS_PER_FOOT_H, V = UNITS_PER_FOOT_V;
      const placed = mounts.map((m) => {
        const above = Math.min(Math.max(m.world.y - m.ground, 0), m.reach);
        return { m, x: m.world.x * H, y: m.world.y * V + (H - V) * above, z: m.world.z * H };
      });
      const mid = (list) => {
        const out = { x: 0, y: 0, z: 0 };
        for (const p of list) { out.x += p.x; out.y += p.y; out.z += p.z; }
        return { x: out.x / list.length, y: out.y / list.length, z: out.z / list.length };
      };
      const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
      const norm = (a) => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
      const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
      const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
      const pick = (fn) => placed.filter((p) => fn(p.m));
      const front = pick((m) => m.isFront), rear = pick((m) => !m.isFront);
      const left = pick((m) => m.isLeft), right = pick((m) => !m.isLeft);
      if (!front.length || !rear.length || !left.length || !right.length) return null;
      // The truck faces -Z, so forward runs rear to front and "back" is its +Z axis.
      const forward = norm(sub(mid(front), mid(rear)));
      const across = sub(mid(right), mid(left));
      const r = norm(sub(across, { x: forward.x * dot(across, forward), y: forward.y * dot(across, forward), z: forward.z * dot(across, forward) }));
      const up = norm(cross(r, forward));
      const back = { x: -forward.x, y: -forward.y, z: -forward.z };
      // Body origin: the placed centroid, less the mounts' own centroid turned into the pose.
      const c = mid(placed);
      const b = mid(mounts.map((m) => ({ x: m.body.x * H, y: m.body.y * H, z: m.body.z * H })));
      return {
        position: {
          x: c.x - (r.x * b.x + up.x * b.y + back.x * b.z),
          y: c.y - (r.y * b.x + up.y * b.y + back.y * b.z),
          z: c.z - (r.z * b.x + up.z * b.y + back.z * b.z),
        },
        right: r, up, back,
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
