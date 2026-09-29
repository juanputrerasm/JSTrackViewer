/*
  The objects a track sets in motion on its own: trains and aircraft.

  Two kinds, from three games:

    linear   MTM2's type 10 "Moving" object (TPARK's train) and the same type in 4x4 Evolution 1
             (THEHILL's), plus Evo 2's CTrain. Each travels along its bvel, in feet per second
             on world axes. Traxx's help says what happens on the way: "moving objects will
             follow the contours of the terrain and/or ground-boxes in their path", so the
             height is not integrated from bvel but kept at the authored clearance above
             whatever surface is under the object. Leaving the world on one side brings it
             back on the other, keeping a train's cars in formation.

    orbit    Evo 2's CFlyingObject, such as TERRAMAR's plane towing a banner. The record has
             no velocity and no path at all, only a placement, and that placement is banked
             (TERRAMAR's plane is rolled 34 degrees). A banked aircraft holding its height is
             flying a level turn, so the object circles through its authored position, along
             its authored heading, turning toward its lowered wing at the radius that bank
             gives at FLYING_SPEED. An unbanked flying object has no turn to fly and stays put.
             The speed is this viewer's choice, not the game's: nothing in the file states it.

  A box whose Evo `parent` names a moving object rides along with it rigidly, which is how the
  banner stays behind its plane.

  Everything here is in FEET, the drive simulation's unit (world-frame.js), and pure, so the
  same movers run the viewer's animation and drive mode's colliders and can be tested in node.
  Drive mode steps them on the simulation clock; the viewer steps them once a frame. Either
  way there is one state, so switching between the two never makes a train jump.
*/
import { UNITS_PER_FOOT_H, UNITS_PER_FOOT_V } from "./world-frame.js";

const TYPE_MOVING = 10;

/** Cruise speed of a flying object, in ft/s (60 mph). Not in the files; see above. */
export const FLYING_SPEED = 88;

const GRAVITY = 32.174;

/** Banks outside this range, in radians, are treated as level flight or as not a turn. */
const MIN_BANK = 0.05;
const MAX_BANK = 1.4;

const CELL = 64;

/** Is this box one that travels along its bvel? */
export function isLinearMover(box) {
  const [x = 0, , z = 0] = box?.bvel ?? [];
  if (x === 0 && z === 0) return false;
  return box.type === TYPE_MOVING || box.boxType === TYPE_MOVING || box.sourceClass === "CTrain";
}

/** Is this box an aircraft that circles? */
export function isFlyingObject(box) {
  return box?.sourceClass === "CFlyingObject";
}

/**
 * Build the movers for one track.
 *
 * @param {object} trackData as the worker returns it
 * @param {object} frame     world-frame, for the terrain height under a point
 */
export function createMovers(trackData, frame) {
  const boxes = trackData?.boxes ?? [];
  const heightScale = trackData?.terrain?.heightScale ?? 3;
  const worldSize = (trackData?.terrain?.gridSize ?? 256) * (trackData?.terrain?.cellSize ?? CELL);
  const worldFeet = worldSize / UNITS_PER_FOOT_H;

  // The highest ground box standing in each terrain cell, in feet, for the linear movers.
  const groundBoxTops = new Map();
  for (const gb of trackData?.groundBoxes ?? []) {
    const upper = gb.upper ?? 0;
    if (upper < 1) continue;
    const midX = gb.midX ?? ((gb.x ?? 0) * CELL + CELL / 2);
    const midY = gb.midY ?? ((gb.y ?? 0) * CELL + CELL / 2);
    const key = `${Math.floor(midX / CELL)},${Math.floor((worldSize - midY) / CELL)}`;
    const top = upper * heightScale / UNITS_PER_FOOT_V;
    if (!(groundBoxTops.get(key) >= top)) groundBoxTops.set(key, top);
  }
  const surfaceAt = (x, z) => {
    const ground = frame?.heightAtFeet?.(x, z) ?? 0;
    const cell = `${Math.floor(x * UNITS_PER_FOOT_H / CELL)},${Math.floor(z * UNITS_PER_FOOT_H / CELL)}`;
    const box = groundBoxTops.get(cell);
    return box !== undefined && box > ground ? box : ground;
  };

  const movers = [];
  const byInstance = new Map();
  boxes.forEach((box, index) => { if (box.instanceId != null) byInstance.set(box.instanceId, index); });
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index];
    // Attached to something else, it moves with that (TERRAMAR's banner is a flying object too).
    if (box.parent && byInstance.has(box.parent)) continue;
    const [wx = 0, wy = 0] = box.position ?? [];
    const start = { x: wx / UNITS_PER_FOOT_H, z: (worldSize - wy) / UNITS_PER_FOOT_H };

    if (isLinearMover(box)) {
      const [bvx = 0, , bvz = 0] = box.bvel;
      movers.push({
        kind: "linear", sourceIndex: index, start,
        // The .SIT's z runs opposite to the scene's; see colliders.js.
        velocity: { x: bvx, z: -bvz },
        startSurface: surfaceAt(start.x, start.z),
        offset: { x: 0, y: 0, z: 0 }, yaw: 0,
      });
    } else if (isFlyingObject(box)) {
      const orbit = orbitFor(box, start);
      if (orbit) movers.push({ kind: "orbit", sourceIndex: index, start, ...orbit, offset: { x: 0, y: 0, z: 0 }, yaw: 0 });
    }
  }

  // Riders: boxes attached to a mover through Evo's `parent` link.
  const riders = new Map();
  const moverByIndex = new Map(movers.map((mover) => [mover.sourceIndex, mover]));
  for (let index = 0; index < boxes.length; index++) {
    const parent = boxes[index].parent;
    if (!parent || moverByIndex.has(index)) continue;
    const parentIndex = byInstance.get(parent);
    const mover = parentIndex === undefined ? null : moverByIndex.get(parentIndex);
    if (mover) riders.set(index, mover);
  }

  let enabled = true;
  let time = 0;

  function place(mover) {
    if (mover.kind === "linear") {
      let x = mover.start.x + mover.velocity.x * time;
      let z = mover.start.z + mover.velocity.z * time;
      x = ((x % worldFeet) + worldFeet) % worldFeet;
      z = ((z % worldFeet) + worldFeet) % worldFeet;
      mover.offset.x = x - mover.start.x;
      mover.offset.z = z - mover.start.z;
      mover.offset.y = surfaceAt(x, z) - mover.startSurface;
      return;
    }
    const angle = mover.rate * time;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const rx = mover.start.x - mover.centre.x, rz = mover.start.z - mover.centre.z;
    // A turn of `angle` about +Y, the scene's up axis: x' = x cos + z sin, z' = -x sin + z cos.
    mover.offset.x = mover.centre.x + rx * cos + rz * sin - mover.start.x;
    mover.offset.z = mover.centre.z - rx * sin + rz * cos - mover.start.z;
    mover.offset.y = 0;
    mover.yaw = angle;
  }

  function reset() {
    time = 0;
    for (const mover of movers) {
      mover.offset.x = mover.offset.y = mover.offset.z = 0;
      mover.yaw = 0;
    }
  }

  return {
    movers,
    get count() { return movers.length; },
    get enabled() { return enabled; },
    get time() { return time; },

    /** Stopping puts every object back where the track authored it. */
    setEnabled(on) {
      enabled = on !== false;
      if (!enabled) reset();
    },

    step(dt) {
      if (!enabled || !movers.length || !(dt > 0)) return;
      time += dt;
      for (const mover of movers) place(mover);
    },

    reset,

    /** The mover that carries box `index`, itself or its parent, or null. */
    moverFor(index) {
      return moverByIndex.get(index) ?? riders.get(index) ?? null;
    },

    /** Every box index that moves, riders included, with its mover. */
    placements() {
      return [...moverByIndex, ...riders];
    },
  };
}

/*
  The circle a banked flying object flies, or null when it is not banked.

  Evo placements are drawn with Y(-psi) X(-theta) Z(phi) (scene.js evoModelMatrix). The roll
  axis is the model's own Z, its fuselage, and its nose is on -Z in scene axes: TERRAMAR's
  banner, parented to its plane, is authored 31 units behind it along exactly that line. So:

    forward = Y(-psi)(0, 0, -1) = (sin psi, 0, -cos psi)
    right   = Y(-psi)(1, 0, 0)  = (cos psi, 0, sin psi)

  and the right wing is the low one when Z(phi) turns it downward, sin(phi) < 0. A level turn
  at bank b and speed v has radius v^2 / (g tan b).
*/
function orbitFor(box, start) {
  const phi = Math.atan2(Math.sin(box.phi ?? 0), Math.cos(box.phi ?? 0));
  const bank = Math.abs(phi);
  if (bank < MIN_BANK || bank > MAX_BANK) return null;
  const psi = box.psi ?? 0;
  const right = { x: Math.cos(psi), z: Math.sin(psi) };
  const turnRight = phi < 0;
  const radius = (FLYING_SPEED * FLYING_SPEED) / (GRAVITY * Math.tan(bank));
  const side = turnRight ? 1 : -1;
  return {
    radius,
    centre: { x: start.x + right.x * radius * side, z: start.z + right.z * radius * side },
    // Turning right, seen from above, is a negative turn about +Y.
    rate: (turnRight ? -1 : 1) * FLYING_SPEED / radius,
  };
}
