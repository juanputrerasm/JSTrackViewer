import { cellTriangleHeight, cellUsesOtherDiagonal, parseBin } from "../vendor/openphotex/index.js";
import { HB_UNDERGROUND_BIAS } from "./hb-underground.js";

/*
  Where Terminal Velocity, Fury3 and Hellbender actually put a .DEF placement.

  The stored placement is the editor's copy; the engines settle it at load, and the viewer
  should draw what the player sees. The rules are from the executables (docs/TV_GAME_EXE_ANALYSIS.md
  section 3, docs/FURY3_EXE_ANALYSIS.md section 2, docs/HELLBENDER_EXE_ANALYSIS.md section 6):

  Terminal Velocity and Fury3 (GAME.EXE 0x230a0 and 0x22f20, TF.EXE 0x40c2b0 and 0x40c140)
    1. On a surface level the stored Y is replaced by the terrain height at (x, z), sampled on
       the cell's triangle with the checkerboard split. A tunnel level keeps the stored Y.
    2. The definition's X, Y and Z offsets (header slots 3 to 5) are added.
    3. Logics 2, 4, 7 and 8 (the flyers) are lifted by half the model radius, the radius of the
       simple model's bounding-box corner, which the engine also writes over the hit radius.

  Hellbender (HELLBEND.EXE 0x404f60, 0x41c300)
    1. The stored Y is kept. A negative Y belongs to the cavern, whose floor is .RA2; any other
       to the surface.
    2. A Y below that world's floor is raised to it; a Y inside a ground box of that world is
       raised to the box top.
    3. The X and Z offsets are added; the Y offset is not, and nothing is lifted.

  This is engine behaviour on top of the data, so it lives here rather than in OpenPhotex.
*/

/** The TV-family flyer logics the engine lifts by half the model radius. */
const FLYER_LOGICS = new Set([2, 4, 7, 8]);

/** World units per editor unit horizontally: TV 2^20 per 64-unit cell, Hellbender 2^19 / 64 in 16.16. */
const TV_WORLD_PER_EDITOR = (1 << 20) / 64;
const HB_WORLD_PER_EDITOR = (8 * 65536) / 64;

/** World units per height step: 2^15 in both (Hellbender bytes are stored << 7, sampled * 256). */
const WORLD_PER_STEP = 1 << 15;

/**
 * The engine's model radius (TV GAME.EXE 0x22df0, Fury3 0x40bf80, Hellbender 0x404d40), in world
 * units: per axis the larger of |min| and |max| over the raw vertices, scaled as world =
 * raw * 65536 / magnify, then round(sqrt(ax^2 + ay^2 + az^2)). Null when the model has no
 * vertices.
 */
export function binCornerRadius(bytes) {
  if (!bytes?.length) return null;
  const bin = parseBin(bytes);
  if (bin.kind !== "mrgl" || !bin.vertices.length || !(bin.magnify > 0)) return null;
  const scale = 65536 / bin.magnify;
  const extent = [0, 0, 0];
  for (let i = 0; i < bin.vertices.length; i++) {
    const axis = i % 3;
    extent[axis] = Math.max(extent[axis], Math.abs(bin.vertices[i] * scale));
  }
  return Math.round(Math.hypot(extent[0], extent[1], extent[2]));
}

/** The triangle-sampled height of a byte heightfield at editor (x, y), in steps. */
function sampleGrid(grid, gridSize, ex, ey) {
  const x = ex / 64;
  const z = ey / 64;
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  const at = (i, k) => grid[((i % gridSize) + gridSize) % gridSize + (((k % gridSize) + gridSize) % gridSize) * gridSize];
  return cellTriangleHeight(at(cx, cz), at(cx + 1, cz), at(cx + 1, cz + 1), at(cx, cz + 1),
    x - cx, z - cz, cellUsesOtherDiagonal(cx, cz, "checkerboard"));
}

/**
 * Settles every placed box of a TV-family or Hellbender level the way its engine does. Boxes
 * carry `engine` (from def-loader.js): the definition's offsets, logic and model radius. The
 * stored altitude is kept as `storedAltitude`.
 */
export function settlePlacements(doc) {
  const gridSize = doc.terrain?.gridSize ?? 256;
  if (doc.origin === "HB") {
    settleHellbender(doc, gridSize);
  } else {
    settleTerminalVelocity(doc, gridSize);
  }
}

function settleTerminalVelocity(doc, gridSize) {
  const raw = doc.terrain?.rawData;
  for (const box of doc.boxes) {
    const info = box.engine;
    if (!info) continue;
    const [x, y, altitude] = box.position;
    box.storedAltitude = altitude;
    const [ox, oy, oz] = info.offset;
    const nx = x + ox / TV_WORLD_PER_EDITOR;
    const ny = y + oz / TV_WORLD_PER_EDITOR;
    // A tunnel level has no heightfield and keeps the stored height (def-loader already added Y).
    if (!raw || raw.length < gridSize * gridSize) {
      box.position = [nx, ny, altitude];
      continue;
    }
    const lift = FLYER_LOGICS.has(info.logic) && info.modelRadius ? info.modelRadius / 2 : 0;
    const ground = sampleGrid(raw, gridSize, x, y);
    box.position = [nx, ny, ground + (oy + lift) / WORLD_PER_STEP];
  }
}

function settleHellbender(doc, gridSize) {
  const raw = doc.terrain?.rawData;
  if (!raw || raw.length < gridSize * gridSize) return;
  const cavern = doc.underground;
  const boxesAt = (list) => {
    const map = new Map();
    for (const b of list ?? []) map.set(b.x + b.y * gridSize, b);
    return map;
  };
  const surfaceBoxes = boxesAt(doc.groundBoxes);
  const cavernBoxes = boxesAt(doc.undergroundBoxes);
  for (const box of doc.boxes) {
    const info = box.engine;
    if (!info) continue;
    const [x, y, altitude] = box.position;
    box.storedAltitude = altitude;
    const underground = altitude < 0;
    const floor = underground
      ? (cavern ? sampleGrid(cavern.floorHeights, gridSize, x, y) + HB_UNDERGROUND_BIAS : altitude)
      : sampleGrid(raw, gridSize, x, y);
    let settled = altitude;
    if (settled < floor) {
      settled = floor;
    } else {
      const cx = ((Math.floor(x / 64) % gridSize) + gridSize) % gridSize;
      const cz = ((Math.floor(y / 64) % gridSize) + gridSize) % gridSize;
      const ground = (underground ? cavernBoxes : surfaceBoxes).get(cx + cz * gridSize);
      if (ground && settled >= ground.lower && settled < ground.upper) settled = ground.upper;
    }
    const [ox, , oz] = info.offset;
    box.position = [x + ox / HB_WORLD_PER_EDITOR, y + oz / HB_WORLD_PER_EDITOR, settled];
  }
}
