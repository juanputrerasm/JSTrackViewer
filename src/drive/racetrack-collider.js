/*
  The CPR road layer as something a truck can drive on and hit.

  A CART Precision Racing track is not in the heightfield. The road surface, its curbs and its
  walls are the separate .TRK layer the scene draws on top of the terrain, which sits a median
  of 2 ft above the ground beneath it. Drive mode used to know only the terrain and the .SIT
  objects, so on a CPR track the wheels ran on the ground under the road and the truck drove
  straight through every wall and catch fence.

  This builds one static mesh collider per drawn segment, from the same records and the same
  transform the scene uses (cprSegmentPairs, cprPointToScene), so what is solid is exactly
  what is drawn, including the segment that closes the circuit:

    road    one quad per cross section slot that has any width. Flat enough to carry a
            wheel, so supportAt answers with the road rather than the terrain under it.
    walls   one vertical quad per wall, as tall as its whole stack of panels and fencing.
            Too steep to stand on, so the hull contacts treat it as a wall.

  Per segment rather than one shape for the whole circuit, because a shape's triangle grid is
  capped and a lap is miles long: a segment is about 35 ft by 100 ft, which the broad phase
  buckets cheaply and the grid splits finely.
*/

import {
  CPR_WALL_LAYERS,
  CPR_WALL_PART_HEIGHT_FT,
  cprFeetToWorldY,
  cprPointToScene,
  cprSegmentPairs,
  cprVisibleSlots,
  isDegenerateSlot,
} from "../shared/cpr-track-schema.js";
import { LEGACY_ALTITUDE_DIVISOR } from "../shared/terrain-height.js";
import { buildTriangleShape, meshSupport } from "./mesh-collider.js";
import { UNITS_PER_FOOT_H, UNITS_PER_FOOT_V } from "./world-frame.js";

/** Total height of a wall type's stack, in panel units, or 0 for no wall. */
function wallUnits(wallType) {
  const layers = CPR_WALL_LAYERS[wallType ?? 0];
  if (!layers) return 0;
  return layers.reduce((sum, layer) => sum + layer.units, 0);
}

/**
 * One collision shape per drawn road segment, in world feet.
 *
 * @param {object} trackData  the loaded track, with raceTrackSurfaces and terrain
 * @returns {object[]}        shapes for buildTriangleShape's queries; empty off CPR
 */
export function buildRaceTrackShapes(trackData) {
  const surfaces = trackData?.raceTrackSurfaces ?? [];
  if (surfaces.length < 2) return [];

  const terrain = trackData?.terrain;
  const heightScale = terrain?.heightScale ?? 3;
  const worldSize = (terrain?.gridSize ?? 256) * (terrain?.cellSize ?? 64);
  const zDivisor = LEGACY_ALTITUDE_DIVISOR;
  const partHeight = cprFeetToWorldY(CPR_WALL_PART_HEIGHT_FT, heightScale, zDivisor);

  // Scene units to feet, on the scene's own axes: the conversion world-frame uses.
  const toFeet = (p) => [p[0] / UNITS_PER_FOOT_H, p[1] / UNITS_PER_FOOT_V, p[2] / UNITS_PER_FOOT_H];
  const scene = (point) => cprPointToScene(point, heightScale, worldSize, zDivisor);

  const shapes = [];
  for (const [from, to] of cprSegmentPairs(surfaces)) {
    const a = surfaces[from];
    const b = surfaces[to];
    const aPts = a.points ?? [];
    const bPts = b.points ?? [];
    const pointCount = Math.min(aPts.length, bPts.length);
    if (pointCount < 2) continue;

    const coords = [];
    const quad = (q0, q1, q2, q3) => {
      const [f0, f1, f2, f3] = [q0, q1, q2, q3].map(toFeet);
      coords.push(...f0, ...f1, ...f2, ...f0, ...f2, ...f3);
    };

    // Only what is drawn is solid: nothing outside the walls.
    const visible = cprVisibleSlots(a);
    for (let lane = Math.max(0, visible.first); lane + 1 < pointCount && lane <= visible.last; lane++) {
      if (isDegenerateSlot(a, lane) && isDegenerateSlot(b, lane)) continue;
      quad(scene(aPts[lane]), scene(bPts[lane]), scene(bPts[lane + 1]), scene(aPts[lane + 1]));
    }

    // The owning segment decides whether a wall exists, as it does for drawing.
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
      const units = wallUnits(a.wallTypes?.[pointIndex]);
      if (!units) continue;
      const p0 = scene(aPts[pointIndex]);
      const p1 = scene(bPts[pointIndex]);
      const top = units * partHeight;
      quad(p0, p1, [p1[0], p1[1] + top, p1[2]], [p0[0], p0[1] + top, p0[2]]);
    }

    if (!coords.length) continue;
    const centre = { x: 0, y: 0, z: 0 };
    const vertices = coords.length / 3;
    for (let i = 0; i < coords.length; i += 3) {
      centre.x += coords[i]; centre.y += coords[i + 1]; centre.z += coords[i + 2];
    }
    centre.x /= vertices; centre.y /= vertices; centre.z /= vertices;

    const shape = buildTriangleShape(coords, centre);
    if (shape) shapes.push(shape);
  }
  return shapes;
}

/**
 * The road surface alone, answering supportAt like the full collider set does, for placing a
 * truck on the grid before drive mode (and its colliders) exists. A linear scan, which is fine
 * for a one-off placement and would not be for a simulation step.
 */
export function createRaceTrackSupport(trackData) {
  const shapes = buildRaceTrackShapes(trackData);
  return {
    supportAt(x, z, y) {
      let best = null;
      for (const shape of shapes) {
        const { centre, bounds } = shape;
        const lx = x - centre.x, lz = z - centre.z;
        if (lx < bounds.minX || lx > bounds.maxX || lz < bounds.minZ || lz > bounds.maxZ) continue;
        const local = meshSupport(shape, lx, lz, y - centre.y);
        if (local === null) continue;
        const surface = local + centre.y;
        if (best === null || surface > best) best = surface;
      }
      return best;
    },
  };
}
