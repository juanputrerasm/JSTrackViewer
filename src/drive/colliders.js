/*
  The solid parts of a track, in the shape the simulation already understands.

  The sim asks the world two questions, and only two: how high is the ground under this point
  (for a wheel ray), and how deep is this point inside something and which way is out (for the
  scrape hull). Terrain answers both through world-frame. This answers the same two for the
  track's objects, so boxes, models, ramps and ground boxes arrive through the impulse contact
  path that already exists rather than becoming a second collision system alongside it.

  WHAT A TRUCK HITS:

    a box with a model      the model's triangles (mesh-collider.js), never the authored box
    a box without a model   the box itself, which for these IS the object: invisible walls,
                            the blockers at the base of drive-through checkpoints
    a ramp                  the wedge
    a ground box            its column

  CONVENTIONS ARE COPIED, NOT INVENTED. Every one of these is taken from how scene.js draws
  the same object, because a collider that disagrees with the drawing is worse than no
  collider at all: the truck hits things that are not there.

    box placement   traxxPrismMatrix(psi, theta, phi, wx, wz * heightScale, worldSize - wy)
    box extents     width / length / height are HALF extents as authored (scene.js doubles
                    them only because THREE.BoxGeometry takes full sizes)
    model placement traxxModelMatrix(psi, theta, phi, wx, wz * hs + baseZ * 0.75, worldSize - wy)
    ramp            the same eight corners with the top of the low edge unused, climbing from
                    the -y edge to the +y edge in Traxx space
    ground boxes    64 unit columns centred on midX / midY, from lower * hs to upper * hs

  Everything here is in FEET, SECONDS and SLUGS, because that is what the sim runs in, and
  because a box's authored mass is already slugs (see TRUCK_MASS_SLUGS in params/mtm2-feel.js).
*/
import { UNITS_PER_FOOT_H, UNITS_PER_FOOT_V } from "./world-frame.js";
import { buildMeshShape, meshRay, meshSegmentContact, meshSupport, traxxRotationRows } from "./mesh-collider.js";
import { isVegetationModel, trunkCollisionModel } from "./vegetation-collision.js";

/*
  Which box types are solid.

  From Traxx's own notes (TrackPOD/File info/Model Types.txt) and scene.js's constants: 6 is
  the checkpoint trigger, 7 is "drive thru", 8 is "always face" (a camera-facing billboard).
  None of them stop a truck, with or without a model. The notes record that the "funky"
  checkpoints are type 7 with separate solid boxes at their base, which is the clearest
  statement that triggers and blockers are different objects.

  Type 11 is NOT on this list. The notes guess "11 means invisible?", and invisible is not the
  same as intangible: BAJA carries 26 model-less type 11 boxes and nothing else to keep a truck
  on its course. An earlier version let trucks straight through them.
*/
const TYPE_CHECKPOINT = 6;
const TYPE_DRIVE_THROUGH = 7;
const TYPE_NO_COLLIDE_FACING = 8;
const TYPE_MOVING = 10;
const TYPE_RAMP = 99;

const PASS_THROUGH = new Set([
  TYPE_CHECKPOINT,
  TYPE_DRIVE_THROUGH,
  TYPE_NO_COLLIDE_FACING,
]);

/** Cell size of the broad-phase grid, in feet. One terrain cell is 32 ft. */
const BUCKET_FEET = 32;

const GRAVITY = 32.174;

/** The fastest a struck object may leave, in ft/s. About 60 mph. */
const MAX_PUSH_SPEED = 90;

/** And the fastest it may spin, in rad/s. */
const MAX_PUSH_SPIN = 9;

/** Past this tilt an object has fallen over and stays down, in radians (about 63 degrees). */
const FALLEN_ANGLE = 1.1;

/* Minimal quaternion helpers, so this file stays dependency free and runs under node. */
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function quatMultiply(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function quatNormalize(q) {
  const length = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

function rotateByQuat(q, v) {
  // v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx,
  };
}

const conjugate = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const isUpright = (q) => q.x === 0 && q.y === 0 && q.z === 0;

/**
 * Build the collision world for one track.
 *
 * @param {object} trackData as the worker returns it, including `models` for model collision
 * @param {object} frame     world-frame, for terrain height under a point
 */
export function createColliders(trackData, frame) {
  const heightScale = trackData?.terrain?.heightScale ?? 3;
  const worldSize = (trackData?.terrain?.gridSize ?? 256) * (trackData?.terrain?.cellSize ?? 64);
  const toFeetH = 1 / UNITS_PER_FOOT_H;
  const toFeetV = 1 / UNITS_PER_FOOT_V;
  const worldFeet = worldSize * toFeetH;

  const solids = [];
  const boxes = trackData?.boxes ?? [];
  const evo = trackData?.origin === "EVO1" || trackData?.origin === "EVO2";
  const trunkModels = new Map();
  const trunkOf = (name, model) => {
    if (!trunkModels.has(name)) trunkModels.set(name, trunkCollisionModel(model));
    return trunkModels.get(name);
  };

  function addModelSolid(common, model, placement) {
    const shape = buildMeshShape(model, placement, trackData);
    if (!shape) return;
    const { bounds } = shape;
    solids.push(finishSolid({
      ...common,
      index: solids.length,
      kind: "mesh",
      shape,
      centre: shape.centre,
      reachX: Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX)),
      reachZ: Math.max(Math.abs(bounds.minZ), Math.abs(bounds.maxZ)),
      reachY: Math.max(Math.abs(bounds.minY), Math.abs(bounds.maxY)),
      bottom: bounds.minY,
      centreOfMass: {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
        z: (bounds.minZ + bounds.maxZ) / 2,
      },
    }));
  }

  for (let boxIndex = 0; boxIndex < boxes.length; boxIndex++) {
    const box = boxes[boxIndex];
    const type = box.type ?? 0;
    if (PASS_THROUGH.has(type)) continue;
    // Evo checkpoint and non-colliding classes are triggers/visuals. Their records have no
    // Traxx `type`, so passing them through the MTM fallback made invisible 32-unit walls.
    if (evo && (box.boxType === TYPE_CHECKPOINT || box.sourceClass === "CCheckpoint" || box.sourceClass?.startsWith("CNonCollide"))) continue;

    /*
      Moving objects: TPARK's train, which Traxx's notes describe as "10 (moving - use bvel)"
      and MTM2's own Simobj.c calls a train ("Too many trains", right after the box parser).

      All ten of its cars carry mass 0 and bvel (0, 0, -70), and they are authored facing both
      ways within one train, so the velocity is read in WORLD axes: in body axes the cars would
      drive apart. In world axes every locomotive leads. The .SIT's z runs opposite to the
      scene's, hence the sign on z.

      A moving object is kinematic. It follows its velocity whatever it meets, and what it
      meets is shoved out of the way; mass 0 still means nothing can push IT.
    */
    const [bvx = 0, bvy = 0, bvz = 0] = box.bvel ?? [];
    const moving = type === TYPE_MOVING && (bvx !== 0 || bvy !== 0 || bvz !== 0);

    const common = {
      type,
      /*
        `index` is the collider's own position in `solids`; `sourceIndex` ties it back to the
        box it came from, so whatever the scene drew for that box can be moved with it.
      */
      index: solids.length,
      sourceIndex: boxIndex,
      /*
        Mass in SLUGS, exactly as the file stores it. See TRUCK_MASS_SLUGS in
        params/mtm2-feel.js for the evidence that a .SIT's mass is pounds over g.
      */
      mass: box.mass ?? 0,
      movable: !moving && (box.mass ?? 0) > 0,
      moving,
      // Displacement from where the track authored it, and how fast it is moving, in feet.
      offset: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      // How far it has been tipped over, about its own base, and how fast it is tipping.
      tilt: IDENTITY,
      spin: { x: 0, y: 0, z: 0 },
      fallen: false,
      modelName: box.modelName ?? "",
    };
    if (moving) {
      common.velocity = { x: bvx, y: bvy, z: -bvz };
    }

    const model = box.modelName ? trackData?.models?.[box.modelName] : null;
    if (model?.meshes?.length && type !== TYPE_RAMP) {
      addModelSolid(common, evo && isVegetationModel(box.modelName, box.sourceClass)
        ? trunkOf(box.modelName, model) : model, box);
      continue;
    }
    // Evo does not render model-less SIT boxes; their authored size is not a visible object.
    if (evo) continue;

    /*
      An oriented box, stored as a centre plus three unit axes and three half extents, all in
      feet. That is everything a point test needs: project the offset onto each axis, and the
      point is inside when all three projections are within their extent.

      A box whose model is named but missing from the pod lands here too, which is right: the
      scene draws a box for it, so a box is what the truck should meet.
    */
    const [wx = 0, wy = 0, wz = 0] = box.position ?? [];
    const rows = traxxRotationRows(box.psi ?? 0, box.theta ?? 0, box.phi ?? 0);

    /*
      Traxx local (x, y, z) reaches the scene as (x, z, -y), which is why the axes below take
      their components from the rotation rows in that order. The vertical axis is also the one
      the world stretches, so it converts with the vertical scale and the other two with the
      horizontal one.
    */
    const axisX = { x: rows[0][0], y: rows[2][0], z: -rows[1][0] };
    const axisY = { x: rows[0][2], y: rows[2][2], z: -rows[1][2] };
    const axisZ = { x: rows[0][1], y: rows[2][1], z: -rows[1][1] };
    const axes = [axisX, axisY, axisZ];
    // width is the local x extent, height the vertical, length the fore-aft.
    const extents = [
      (box.width ?? 32) * toFeetH,
      (box.height ?? 32) * toFeetV,
      (box.length ?? 32) * toFeetH,
    ];
    const reach = (component) => axes.reduce((sum, axis, i) => sum + Math.abs(axis[component]) * extents[i], 0);

    solids.push(finishSolid({
      ...common,
      kind: type === TYPE_RAMP ? "ramp" : "box",
      centre: {
        x: wx * toFeetH,
        y: wz * heightScale * toFeetV,
        z: (worldSize - wy) * toFeetH,
      },
      axes,
      extents,
      // Worst-case reach of an oriented box along each world axis.
      reachX: reach("x"),
      reachY: reach("y"),
      reachZ: reach("z"),
      bottom: -reach("y"),
      centreOfMass: { x: 0, y: 0, z: 0 },
    }));
  }

  // .VEG trees are drawn as instances rather than SIT boxes. Match each instance's actual
  // scaled, yawed SMF triangles, including the narrow trunk inside its wide tree footprint.
  if (evo) for (const tree of trackData?.vegetation?.trees ?? []) {
    const model = trackData?.models?.[tree.modelName];
    if (!model?.meshes?.length) continue;
    addModelSolid({
      type: 0, sourceIndex: -1, mass: 0, movable: false, moving: false,
      offset: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
      tilt: IDENTITY, spin: { x: 0, y: 0, z: 0 }, fallen: false,
      modelName: tree.modelName,
    }, trunkOf(tree.modelName, model), { ...tree, evoVegetation: true });
  }

  /*
    Everything an object needs to fall over, derived from the shape it already has.

    The pivot is the middle of its BASE rather than its centre, which is the whole trick: a
    lamp post tips about where it meets the ground, so it swings down and its foot stays put.
    Rotating about the centre would drive one half of it through the terrain.
  */
  function finishSolid(solid) {
    const pivot = { x: 0, y: solid.bottom, z: 0 };          // relative to `centre`
    const arm = {                                           // centre of mass, from the pivot
      x: solid.centreOfMass.x - pivot.x,
      y: solid.centreOfMass.y - pivot.y,
      z: solid.centreOfMass.z - pivot.z,
    };
    const height = Math.max(0.01, arm.y);
    // How far the object's own footprint reaches, which is what decides when it goes over.
    const footprint = Math.max(0.01, Math.min(solid.reachX, solid.reachZ));
    /*
      Inertia about the pivot as a uniform box: I = m(w^2 + h^2)/12 about its centre, plus
      m * h^2 for moving the axis down to the base. Crude, and the right shape: a tall thin
      post has far less of it than a wide low rock, so the post goes over and the rock does not.
    */
    const width = 2 * footprint;
    const tall = 2 * height;
    const inertiaCom = Math.max(1e-3, solid.mass * (width * width + tall * tall) / 12);
    // Parallel axis, for when the object is leaning on the ground and turning about its foot.
    const inertiaBase = Math.max(1e-3, inertiaCom + solid.mass * height * height);
    return { ...solid, pivot, comArm: arm, comHeight: height, footprint, inertiaCom, inertiaBase };
  }

  /*
    Ground boxes: axis aligned columns, one per terrain cell, standing between two heights.

    No rotation and no per-object axes, so they are kept apart from the oriented boxes and
    tested directly. A track can carry thousands, which is the other reason not to push them
    through the general path.
  */
  const columns = [];
  const CELL = 64;
  for (const gb of trackData?.groundBoxes ?? []) {
    const upper = gb.upper ?? 0;
    if (upper < 1) continue;
    const lower = gb.lower ?? 0;
    const midX = gb.midX ?? ((gb.x ?? 0) * CELL + CELL / 2);
    const midY = gb.midY ?? ((gb.y ?? 0) * CELL + CELL / 2);
    columns.push({
      minX: (midX - CELL / 2) * toFeetH,
      maxX: (midX + CELL / 2) * toFeetH,
      minZ: (worldSize - midY - CELL / 2) * toFeetH,
      maxZ: (worldSize - midY + CELL / 2) * toFeetH,
      bottom: lower * heightScale * toFeetV,
      top: upper * heightScale * toFeetV,
    });
  }

  /*
    Broad phase: a bucket per 32 ft of world, holding whatever overlaps it.

    A stock track is a few hundred boxes and can be thousands of ground columns, and the sim
    asks about sixteen points at 120 Hz. Testing everything against everything would be tens of
    millions of tests a second for a truck that is nowhere near most of it.
  */
  const buckets = new Map();
  const keyFor = (x, z) => `${Math.floor(x / BUCKET_FEET)},${Math.floor(z / BUCKET_FEET)}`;

  const addToBuckets = (item, minX, maxX, minZ, maxZ) => {
    const x0 = Math.floor(minX / BUCKET_FEET);
    const x1 = Math.floor(maxX / BUCKET_FEET);
    const z0 = Math.floor(minZ / BUCKET_FEET);
    const z1 = Math.floor(maxZ / BUCKET_FEET);
    for (let bx = x0; bx <= x1; bx++) {
      for (let bz = z0; bz <= z1; bz++) {
        const key = `${bx},${bz}`;
        let list = buckets.get(key);
        if (!list) buckets.set(key, (list = []));
        list.push(item);
      }
    }
  };

  for (const solid of solids) {
    addToBuckets(solid,
      solid.centre.x - solid.reachX, solid.centre.x + solid.reachX,
      solid.centre.z - solid.reachZ, solid.centre.z + solid.reachZ);
  }
  for (const column of columns) {
    addToBuckets(column, column.minX, column.maxX, column.minZ, column.maxZ);
  }

  /** Everything that can change position, which is the only set worth stepping. */
  const dynamic = solids.filter((s) => s.movable || s.moving);

  /*
    What is near a point, including anything that has left where it started.

    The bucket grid is built once from the authored positions, which is right for the scenery
    that never moves and wrong for anything that does: a displaced object is still filed under
    the buckets it used to occupy, so it silently stops colliding as soon as it leaves them. A
    cone knocked 60 ft became a ghost, present in the simulation and solid to nothing.
  */
  const displaced = new Set();
  const near = (x, z) => {
    const inBucket = buckets.get(keyFor(x, z)) ?? [];
    if (!displaced.size) return inBucket;
    return [...inBucket, ...displaced];
  };

  /** Near either end of a segment, each object once. */
  const nearSegment = (a, b) => {
    const keyA = keyFor(a.x, a.z);
    const keyB = keyFor(b.x, b.z);
    if (keyA === keyB) return near(a.x, a.z);
    return [...new Set([...near(a.x, a.z), ...(buckets.get(keyB) ?? [])])];
  };

  const currentCentre = (solid) => ({
    x: solid.centre.x + solid.offset.x,
    y: solid.centre.y + solid.offset.y,
    z: solid.centre.z + solid.offset.z,
  });

  /*
    A world point in the object's own frame, undoing both where it has been shoved to and how
    far it has tipped over. Tilt is about the base pivot, so the point is measured from there
    and put back relative to the centre, which is the frame the shapes are stored in.
  */
  function toObject(solid, point) {
    const c = currentCentre(solid);
    const d = { x: point.x - c.x, y: point.y - c.y, z: point.z - c.z };
    if (isUpright(solid.tilt)) return d;
    const fromPivot = { x: d.x - solid.pivot.x, y: d.y - solid.pivot.y, z: d.z - solid.pivot.z };
    const local = rotateByQuat(conjugate(solid.tilt), fromPivot);
    return { x: local.x + solid.pivot.x, y: local.y + solid.pivot.y, z: local.z + solid.pivot.z };
  }

  /** The point in a box's local axes, taking displacement and tilt into account. */
  function toLocal(solid, point) {
    const d = toObject(solid, point);
    return [
      d.x * solid.axes[0].x + d.y * solid.axes[0].y + d.z * solid.axes[0].z,
      d.x * solid.axes[1].x + d.y * solid.axes[1].y + d.z * solid.axes[1].z,
      d.x * solid.axes[2].x + d.y * solid.axes[2].y + d.z * solid.axes[2].z,
    ];
  }

  /** Straight down in world terms, expressed in the object's own frame. */
  function downInObject(solid) {
    if (isUpright(solid.tilt)) return { x: 0, y: -1, z: 0 };
    return rotateByQuat(conjugate(solid.tilt), { x: 0, y: -1, z: 0 });
  }

  /*
    Is this local point inside the shape?

    A ramp is the box with the top of its low edge cut away, so the solid part is everything
    under the slope that runs from the -z edge (low) to the +z edge (high) in local terms.
    Traxx's wedge climbs from -y to +y in ITS axes, which is local z here after the axis
    relabelling above.
  */
  function insideLocal(solid, local) {
    const [lx, ly, lz] = local;
    const [ex, ey, ez] = solid.extents;
    if (Math.abs(lx) > ex || Math.abs(ly) > ey || Math.abs(lz) > ez) return false;
    if (solid.kind !== "ramp") return true;
    // Height allowed at this point along the slope, from the bottom of the box.
    const along = (lz + ez) / (2 * ez);          // 0 at the low edge, 1 at the high edge
    return ly <= -ey + along * (2 * ey);
  }

  /*
    Where a straight-down ray first meets a box or ramp, or null if it misses.

    This replaces an earlier version that sampled a point at the box's guessed top and asked
    whether it was inside. That put the sample exactly ON the surface, where the answer comes
    down to which way the rounding fell: a box 5.3 ft tall reported no top at all, while a
    taller one in a unit test reported its top correctly, purely by luck of arithmetic.

    A slab test has no such edge. The ray starts at `from`, which is the querying point, so a
    surface above it is never reported: a truck drives under a raised box rather than being
    snapped onto its roof.
  */
  function surfaceHeightAt(item, x, z, from) {
    // toLocal already accounts for displacement and tilt.
    const o = toLocal(item, { x, y: from, z });
    // A world-space (0, -1, 0) direction expressed in the box's axes.
    const worldDown = downInObject(item);
    const d = [
      worldDown.x * item.axes[0].x + worldDown.y * item.axes[0].y + worldDown.z * item.axes[0].z,
      worldDown.x * item.axes[1].x + worldDown.y * item.axes[1].y + worldDown.z * item.axes[1].z,
      worldDown.x * item.axes[2].x + worldDown.y * item.axes[2].y + worldDown.z * item.axes[2].z,
    ];

    let tEnter = -Infinity;
    let tExit = Infinity;
    for (let i = 0; i < 3; i++) {
      const extent = item.extents[i];
      if (Math.abs(d[i]) < 1e-9) {
        // Parallel to this slab: either always within it or never.
        if (Math.abs(o[i]) > extent) return null;
        continue;
      }
      let t1 = (-extent - o[i]) / d[i];
      let t2 = (extent - o[i]) / d[i];
      if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; }
      if (t1 > tEnter) tEnter = t1;
      if (t2 < tExit) tExit = t2;
      if (tEnter > tExit) return null;
    }
    if (tExit < 0) return null;
    let t = Math.max(tEnter, 0);

    /*
      A ramp is the box with the top of its low edge cut away, so a ray can enter the box above
      the slope and only meet solid further down. Where that happens, the real surface is the
      slope plane: ly = -ey + (lz + ez) * ey / ez, which is linear along the ray and so solves
      in one step.
    */
    if (item.kind === "ramp") {
      const [, ey, ez] = item.extents;
      const slopeAt = (tt) => -ey + ((o[2] + d[2] * tt) + ez) * (ey / ez);
      const above = (tt) => (o[1] + d[1] * tt) - slopeAt(tt);
      if (above(t) > 0) {
        // f(t) is linear: f = (d[1] - d[2] * ey / ez) * t + constant.
        const slope = d[1] - d[2] * (ey / ez);
        if (Math.abs(slope) < 1e-9) return null;
        const hit = t - above(t) / slope;
        if (!(hit >= t && hit <= tExit)) return null;
        t = hit;
      }
    }

    // The ray travels at unit speed and the world ray is vertical, so t is a drop in feet.
    return from - t;
  }

  /*
    A hull point against a model.

    `reference` is a point known to be outside the object, which for the sim is the truck's
    centre of gravity: a surface between the two means the hull point has gone through it. With
    no reference (probes, tests) the segment comes straight down from above the model, so a
    point counts as inside when it is under the first surface met from above.
  */
  function meshContact(item, point, reference) {
    const c = currentCentre(item);
    const { bounds } = item.shape;
    const from = reference ?? { x: point.x, y: c.y + bounds.maxY + 1, z: point.z };

    // Cheap reject against the object's reach, which already covers however it is tipped.
    const reach = Math.max(item.reachX, item.reachY, item.reachZ);
    if (Math.max(from.x, point.x) < c.x - reach || Math.min(from.x, point.x) > c.x + reach) return null;
    if (Math.max(from.z, point.z) < c.z - reach || Math.min(from.z, point.z) > c.z + reach) return null;
    if (Math.max(from.y, point.y) < c.y - reach || Math.min(from.y, point.y) > c.y + reach) return null;

    const hit = meshSegmentContact(item.shape, toObject(item, from), toObject(item, point));
    if (!hit) return null;
    // The normal comes back in the object's frame, so it has to be turned back into the world's.
    const normal = isUpright(item.tilt) ? hit.normal : rotateByQuat(item.tilt, hit.normal);
    return { depth: hit.depth, normal, solid: item };
  }

  /** The lowest point of an object, relative to its centre, however it is tipped. */
  function lowestOffset(solid) {
    if (isUpright(solid.tilt)) return solid.bottom;
    const b = solid.kind === "mesh" ? solid.shape.bounds : null;
    const corners = [];
    if (b) {
      for (const x of [b.minX, b.maxX]) for (const y of [b.minY, b.maxY]) for (const z of [b.minZ, b.maxZ]) {
        corners.push({ x, y, z });
      }
    } else {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        corners.push({
          x: sx * solid.axes[0].x * solid.extents[0] + sy * solid.axes[1].x * solid.extents[1] + sz * solid.axes[2].x * solid.extents[2],
          y: sx * solid.axes[0].y * solid.extents[0] + sy * solid.axes[1].y * solid.extents[1] + sz * solid.axes[2].y * solid.extents[2],
          z: sx * solid.axes[0].z * solid.extents[0] + sy * solid.axes[1].z * solid.extents[1] + sz * solid.axes[2].z * solid.extents[2],
        });
      }
    }
    let lowest = Infinity;
    for (const corner of corners) {
      const fromPivot = { x: corner.x - solid.pivot.x, y: corner.y - solid.pivot.y, z: corner.z - solid.pivot.z };
      const world = rotateByQuat(solid.tilt, fromPivot);
      const y = world.y + solid.pivot.y;
      if (y < lowest) lowest = y;
    }
    return lowest;
  }

  return {
    /** Every solid built, for debug drawing and tests. */
    solids,
    columns,
    bucketCount: buckets.size,
    worldFeet,

    /** Every solid that can change position, which is the only set worth stepping or redrawing. */
    get movables() { return dynamic; },

    /*
      Shove one object, at a point.

      WHERE it is hit is what decides whether it slides or goes over. A lamp post caught six
      feet up gets most of the impulse as rotation about its foot and falls; the same impulse
      at its base only slides it. That is the whole difference between MTM2's scenery and a
      field of sliding boxes, and it costs one cross product.
    */
    push(solid, impulse, point = null) {
      if (!solid?.movable) return;
      solid.disturbed = true;
      /*
        Velocity change is impulse over MASS, and the mass in the file is already slugs.

        Two separate versions of this went wrong before. The first divided by a dimensionless
        mass RATIO, which turned a cone's 0.0093 into a 50x multiplier and launched it at
        20,000 ft/s. The second multiplied the file's mass by 31, on a guess that its unit was
        a thousand pounds, which made every object on a track far too heavy to move.
      */
      const massSlugs = Math.max(0.01, solid.mass);
      solid.velocity.x += impulse.x / massSlugs;
      solid.velocity.y += impulse.y / massSlugs;
      solid.velocity.z += impulse.z / massSlugs;

      if (point && !solid.fallen) {
        /*
          An impulse turns a body about its CENTRE OF MASS, not about its foot.

          Turning it about the foot was the obvious reading of "it pivots where it meets the
          ground" and it made every object on the track fall over, a boulder as readily as a
          lamp post: pinning the foot and ALSO giving the object the full sliding velocity
          spends the same impulse twice. About the centre of mass, a hit level with it slides
          the object and a hit away from it turns it, which is the difference between shoving a
          hay bale and knocking a post down. Gravity decides the rest, in step().
        */
        const c = currentCentre(solid);
        const arm = rotateByQuat(solid.tilt, solid.comArm);
        const rx = point.x - (c.x + solid.pivot.x + arm.x);
        const ry = point.y - (c.y + solid.pivot.y + arm.y);
        const rz = point.z - (c.z + solid.pivot.z + arm.z);
        solid.spin.x += (ry * impulse.z - rz * impulse.y) / solid.inertiaCom;
        solid.spin.y += (rz * impulse.x - rx * impulse.z) / solid.inertiaCom;
        solid.spin.z += (rx * impulse.y - ry * impulse.x) / solid.inertiaCom;
        const spin = Math.hypot(solid.spin.x, solid.spin.y, solid.spin.z);
        if (spin > MAX_PUSH_SPIN) {
          const trim = MAX_PUSH_SPIN / spin;
          solid.spin.x *= trim; solid.spin.y *= trim; solid.spin.z *= trim;
        }
      }

      /*
        Bounded, but SOFTLY, so that mass still decides the outcome: v * MAX / (v + MAX).

        A truck stopping dead hands its whole momentum to a 3 lb cone, and the honest answer is
        unwatchable. A hard clip was the obvious fix and destroyed the feature: a cone and a car
        both left at exactly 90 ft/s for an identical distance, erasing the mass difference the
        feature is about. The soft clamp keeps both properties, and is a stated limit rather
        than a claim about impacts.
      */
      const speed = Math.hypot(solid.velocity.x, solid.velocity.y, solid.velocity.z);
      if (speed > 1e-6) {
        const trim = (speed * MAX_PUSH_SPEED / (speed + MAX_PUSH_SPEED)) / speed;
        solid.velocity.x *= trim;
        solid.velocity.y *= trim;
        solid.velocity.z *= trim;
      }
    },

    /*
      Move everything that moves.

      Moving objects follow their velocity and wrap at the edge of the world, so a train that
      runs off one side of the map comes back on the other, keeping its formation because every
      car crosses the same edge at the same speed. Whether MTM2 wraps, reverses or respawns its
      train is not recorded anywhere; it is on the Phase 4 capture list.

      Shoved objects fall, tip, land and skid to a stop.
    */
    step(dt) {
      for (const solid of dynamic) {
        if (solid.moving) {
          solid.offset.x += solid.velocity.x * dt;
          solid.offset.y += solid.velocity.y * dt;
          solid.offset.z += solid.velocity.z * dt;
          const x = solid.centre.x + solid.offset.x;
          const z = solid.centre.z + solid.offset.z;
          if (x < 0) solid.offset.x += worldFeet; else if (x >= worldFeet) solid.offset.x -= worldFeet;
          if (z < 0) solid.offset.z += worldFeet; else if (z >= worldFeet) solid.offset.z -= worldFeet;
          displaced.add(solid);
          continue;
        }

        // Authored scenery can be suspended. It becomes dynamic only after a hit.
        if (!solid.disturbed) continue;

        const speed = Math.hypot(solid.velocity.x, solid.velocity.y, solid.velocity.z);
        const spin = Math.hypot(solid.spin.x, solid.spin.y, solid.spin.z);
        // A struck object can lose its speed at the top of an arc. It may sleep only after
        // its lowest point has reached the terrain; otherwise it hangs in mid air forever.
        const restingGround = frame.heightAtFeet(
          solid.centre.x + solid.offset.x, solid.centre.z + solid.offset.z);
        const restingBase = solid.centre.y + solid.offset.y + lowestOffset(solid);
        if (speed < 0.05 && spin < 0.02 &&
            restingBase <= restingGround + 0.05 &&
            (solid.fallen || isUpright(solid.tilt))) {
          solid.velocity.x = 0;
          solid.velocity.y = 0;
          solid.velocity.z = 0;
          solid.spin.x = 0; solid.spin.y = 0; solid.spin.z = 0;
          continue;
        }

        solid.velocity.y -= GRAVITY * dt;
        solid.offset.x += solid.velocity.x * dt;
        solid.offset.y += solid.velocity.y * dt;
        solid.offset.z += solid.velocity.z * dt;
        // Anything that has left its authored position is no longer findable by bucket.
        displaced.add(solid);

        if (spin > 1e-6) {
          const half = spin * dt / 2;
          const s = Math.sin(half) / spin;
          solid.tilt = quatNormalize(quatMultiply(
            { x: solid.spin.x * s, y: solid.spin.y * s, z: solid.spin.z * s, w: Math.cos(half) },
            solid.tilt));
        }

        const groundY = frame.heightAtFeet(
          solid.centre.x + solid.offset.x,
          solid.centre.z + solid.offset.z
        );
        const baseY = solid.centre.y + lowestOffset(solid);
        const grounded = baseY + solid.offset.y <= groundY + 0.05;

        if (baseY + solid.offset.y <= groundY) {
          // Back onto the ground when it gets there, keeping its slide but losing the drop.
          solid.offset.y = groundY - baseY;
          if (solid.velocity.y < 0) solid.velocity.y = 0;
          const drag = Math.exp(-2.5 * dt);
          solid.velocity.x *= drag;
          solid.velocity.z *= drag;
        }

        if (grounded && !solid.fallen) {
          /*
            Standing, leaning, or going over, decided the way it is decided in the world.

            An object is stable while its weight acts INSIDE its own footprint and goes over
            once it passes the edge, and the torque either way is the same expression: its
            weight times how far outside the edge the centre of mass has swung. Positive takes
            it over, negative rights it. A lamp post's weight leaves its narrow foot after a
            few degrees; a boulder's never leaves its own base, so the same code rocks it back.

            About the foot, so the inertia is the one about the base.
          */
          const arm = rotateByQuat(solid.tilt, solid.comArm);
          const lean = Math.hypot(arm.x, arm.z);
          if (lean > 1e-4) {
            // The axis gravity turns it about, which is across the lean.
            const axis = { x: arm.z / lean, z: -arm.x / lean };
            const torque = solid.mass * GRAVITY * (lean - solid.footprint);
            const alpha = torque / solid.inertiaBase * dt;
            solid.spin.x += axis.x * alpha;
            solid.spin.z += axis.z * alpha;
          }
          // The ground takes the energy out of a wobble rather than letting it ring.
          const damp = Math.exp((lean > solid.footprint ? -0.5 : -4) * dt);
          solid.spin.x *= damp; solid.spin.y *= damp; solid.spin.z *= damp;

          const upright = rotateByQuat(solid.tilt, { x: 0, y: 1, z: 0 });
          const angle = Math.acos(Math.max(-1, Math.min(1, upright.y)));
          if (angle > FALLEN_ANGLE) {
            // Over it goes. Scenery that has fallen stays fallen; it does not roll away.
            solid.fallen = true;
          } else if (angle < 0.02 && Math.hypot(solid.spin.x, solid.spin.y, solid.spin.z) < 0.15) {
            // Settled back upright. Snapped, so a standing object stops costing anything.
            solid.tilt = IDENTITY;
            solid.spin.x = 0; solid.spin.y = 0; solid.spin.z = 0;
          }
        } else if (solid.fallen) {
          const damp = Math.exp(-8 * dt);
          solid.spin.x *= damp; solid.spin.y *= damp; solid.spin.z *= damp;
          if (Math.hypot(solid.spin.x, solid.spin.y, solid.spin.z) < 0.05) {
            solid.spin.x = 0; solid.spin.y = 0; solid.spin.z = 0;
          }
        }
      }
    },

    /*
      The highest solid surface under a point, or null if there is nothing but terrain.

      Used for the wheel rays, so a truck drives ON TOP of an object rather than through it.
      Only surfaces at or below the wheel are considered: a roof overhead is not something to
      stand on, and one just above the wheel would otherwise snap the truck up into it.
    */
    supportAt(x, z, y) {
      let best = null;
      for (const item of near(x, z)) {
        if (item.top !== undefined) {
          // A ground column.
          if (x < item.minX || x > item.maxX || z < item.minZ || z > item.maxZ) continue;
          if (item.top <= y && (best === null || item.top > best)) best = item.top;
          continue;
        }
        const c = currentCentre(item);
        const reachX = isUpright(item.tilt) ? item.reachX : Math.max(item.reachX, item.reachY, item.reachZ);
        const reachZ = isUpright(item.tilt) ? item.reachZ : reachX;
        if (Math.abs(x - c.x) > reachX || Math.abs(z - c.z) > reachZ) continue;

        let surface;
        if (item.kind === "mesh") {
          if (isUpright(item.tilt)) {
            const local = meshSupport(item.shape, x - c.x, z - c.z, y - c.y);
            surface = local === null ? null : local + c.y;
          } else {
            // Tipped over, the ray is no longer vertical in the object's own frame.
            const origin = toObject(item, { x, y, z });
            const distance = meshRay(item.shape, origin, downInObject(item));
            surface = distance === null ? null : y - distance;
          }
        } else {
          surface = surfaceHeightAt(item, x, z, y);
        }
        if (surface !== null && surface <= y && (best === null || surface > best)) best = surface;
      }
      return best;
    },

    /*
      How deep a point is inside something, and which way is out.

      For a box the way out is the nearest face, the standard shallow-penetration answer: the
      truck is being pushed out of a wall it has just touched, not resolved from deep inside a
      solid. For a model it is the surface between the point and `reference` (see meshContact).

      @param {object} point      a hull point, in feet
      @param {object} [reference] a point inside the truck, normally its centre of gravity
    */
    contactAt(point, reference = null) {
      const candidates = reference ? nearSegment(point, reference) : near(point.x, point.z);
      for (const item of candidates) {
        if (item.top !== undefined) {
          if (point.x < item.minX || point.x > item.maxX) continue;
          if (point.z < item.minZ || point.z > item.maxZ) continue;
          if (point.y < item.bottom || point.y > item.top) continue;
          // Columns are terrain-like: push straight up, which is the only face a truck meets.
          return { depth: item.top - point.y, normal: { x: 0, y: 1, z: 0 } };
        }

        if (item.kind === "mesh") {
          const hit = meshContact(item, point, reference);
          if (hit) return hit;
          continue;
        }

        const local = toLocal(item, point);
        if (!insideLocal(item, local)) continue;

        let bestAxis = 0;
        let bestDepth = Infinity;
        let bestSign = 1;
        for (let axis = 0; axis < 3; axis++) {
          const distance = item.extents[axis] - Math.abs(local[axis]);
          if (distance < bestDepth) {
            bestDepth = distance;
            bestAxis = axis;
            bestSign = local[axis] >= 0 ? 1 : -1;
          }
        }
        const a = item.axes[bestAxis];
        const normal = { x: a.x * bestSign, y: a.y * bestSign, z: a.z * bestSign };
        return {
          depth: bestDepth,
          normal: isUpright(item.tilt) ? normal : rotateByQuat(item.tilt, normal),
          solid: item,
        };
      }
      return null;
    },
  };
}
