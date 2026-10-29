/*
 * Test Drive's adapter to the same OpenPhotex simulation used by OpenMTM2.
 * The library owns vehicle physics; this module owns viewer coordinates, input,
 * scenery contacts, and the rendering/HUD interface. No game files are decoded here.
 *
 * Simulation world z is the negative of viewer world z. Body anchors stay in
 * TRK axes (x right, y up, z forward); headings need no conversion.
 */
import * as S from "../vendor/openphotex/sim/mtm2/index.js";
import { surfaceOf } from "./surfaces.js";
import { resolveSceneryContacts } from "./scenery-contacts.js";
import { UNITS_PER_FOOT_V } from "./world-frame.js";

const KEYS = ["faxle.rtire", "faxle.ltire", "raxle.rtire", "raxle.ltire"];
const vec = (v) => ({ x: v[0], y: v[1], z: -v[2] });
const array = (v) => [v.x, v.y, -v.z];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
/** How near a ground box's top a surface query must be to take the top's type, feet. */
const COLUMN_TOP_REACH_FT = 1.5;
const WEATHER = { clear: 0, cloudy: 1, foggy: 2, rain: 4, snow: 5, dusk: 6, night: 7 };

/*
  A state the simulation cannot go on from, as OpenMTM2's sim worker judges it (stateIsSane):
  any number not finite, or a speed, height or turn rate no truck reaches. The game has no such
  guard; without one a contact the truck was deep inside of can throw it with a force no step
  can follow, and every later frame inherits the broken numbers.
*/
const SANE_SPEED_FT_S = 2000, SANE_HEIGHT_FT = 1e5, SANE_RATE = 500;
/** Steps between the copies a broken state is put back to: a quarter of a second. */
const SAFE_EVERY = 30;

function stateIsSane(s) {
  for (const list of [s.pos, s.bvel, s.rates, s.matrix, s.euler]) {
    for (let i = 0; i < list.length; i++) if (!Number.isFinite(list[i])) return false;
  }
  return Math.hypot(...s.bvel) < SANE_SPEED_FT_S && Math.abs(s.pos[1]) < SANE_HEIGHT_FT && Math.hypot(...s.rates) < SANE_RATE;
}
function copyState(value) {
  if (ArrayBuffer.isView(value)) return value.slice();
  if (Array.isArray(value)) return value.map(copyState);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyState(v)]));
  return value;
}
function restoreState(live, saved) {
  for (const [key, value] of Object.entries(saved)) {
    const now = live[key];
    if (ArrayBuffer.isView(value) && ArrayBuffer.isView(now) && now.length === value.length) now.set(value);
    else if (value && typeof value === "object" && now && typeof now === "object" && !ArrayBuffer.isView(now)) restoreState(now, value);
    else live[key] = copyState(value);
  }
  return live;
}

/*
  A track's ground boxes as OpenPhotex's MTM2 simulation takes them (groundBoxesAround): the
  .RA0 and .RA1 heights on MTM2's 256 by 256 grid of 32 ft cells, and the feet to a height step.

  The viewer's sim world puts grid row r at z = 32 r - (the world's width in feet), so on a 256 grid
  a row lands on itself through the library's wrap, and a smaller grid that divides 256
  (Hellbender's 128) is laid out to repeat, as OpenMTM2 lays it out. A step is the drawn one,
  the terrain's height scale over the viewer's vertical units per foot, so a box meets the truck
  where it is drawn and where the terrain beside it is. Null for a track with none, or whose grid
  cannot be laid on MTM2's (4x4 Evolution's 32-unit cells, which carry no ground boxes).
*/
export function simGroundBoxes(trackData) {
  const terrain = trackData?.terrain;
  const boxes = trackData?.groundBoxes ?? [];
  const grid = terrain?.gridSize ?? 256;
  if (!boxes.length || (terrain?.cellSize ?? 64) !== 64 || grid > 256 || 256 % grid !== 0) return null;
  const ra0 = new Uint8Array(256 * 256), ra1 = new Uint8Array(256 * 256);
  for (const box of boxes) {
    if (!(box.upper >= 1)) continue;
    for (let row = box.y; row < 256; row += grid) {
      for (let col = box.x; col < 256; col += grid) {
        ra0[row * 256 + col] = Math.max(0, Math.min(255, box.lower));
        ra1[row * 256 + col] = Math.max(0, Math.min(255, box.upper));
      }
    }
  }
  return { ra0, ra1, stepFt: (terrain?.heightScale ?? 3) / UNITS_PER_FOOT_V };
}

/** The wall-face lookup cell, feet: OpenMTM2's 64. */
const FACE_CELL_FT = 64;

/*
  Fixed scenery's steep faces as OpenPhotex wall faces (createFace), in the simulation's axes,
  sorted into 64 ft cells as OpenMTM2 sorts them, and the faces a truck of a radius may touch.
*/
function createWallFaces(colliders) {
  const cells = new Map();
  for (const f of colliders?.wallFaces?.() ?? []) {
    const face = S.createFace(array(f.a), array(f.b), array(f.c), array(f.outward));
    if (!face) continue;
    const { centre, radius } = face;
    for (let cx = Math.floor((centre[0] - radius) / FACE_CELL_FT); cx <= Math.floor((centre[0] + radius) / FACE_CELL_FT); cx++) {
      for (let cz = Math.floor((centre[2] - radius) / FACE_CELL_FT); cz <= Math.floor((centre[2] + radius) / FACE_CELL_FT); cz++) {
        const key = `${cx},${cz}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(face);
      }
    }
  }
  return {
    count: [...cells.values()].reduce((n, list) => n + list.length, 0),
    around(x, z, r, out) {
      if (!cells.size || !(Math.abs(x) < 1e6) || !(Math.abs(z) < 1e6)) return out;
      const seen = new Set();
      for (let cx = Math.floor((x - r) / FACE_CELL_FT); cx <= Math.floor((x + r) / FACE_CELL_FT); cx++) {
        for (let cz = Math.floor((z - r) / FACE_CELL_FT); cz <= Math.floor((z + r) / FACE_CELL_FT); cz++) {
          for (const face of cells.get(`${cx},${cz}`) ?? []) {
            if (seen.has(face)) continue;
            seen.add(face);
            out.push(face);
          }
        }
      }
      return out;
    },
  };
}

export function createOpenMtm2Sim(assembly, frame, { colliders = null, waterLevelFt = null, weather = "clear", groundBoxes = null } = {}) {
  const supplied = assembly.wheels ?? [];
  const ordered = KEYS.map((key) => supplied.find((w) => w.key.replace(".static_bpos", "") === key));
  /*
    The truck's own tires, as OpenMTM2 passes them (`tireRadiusFt`, `tireWidthFt`): the mean of
    the four measured from each tire model (truck-assembly.js), in feet. A truck whose tires
    could not be measured rolls on MTM2's 3 by 4 ft tires, the library's default.
  */
  const mean = (values) => {
    const good = values.filter((v) => Number.isFinite(v) && v > 0);
    return good.length ? good.reduce((a, b) => a + b, 0) / good.length : null;
  };
  const params = S.createTruckParams({
    wheelAnchors: ordered.every(Boolean) ? ordered.map((w) => [w.position.x, w.position.y, w.position.z]) : undefined,
    scrapePoints: (assembly.scrapePoints ?? []).map((p) => [p.x, p.y, p.z]),
    tireRadiusFt: mean(ordered.map((w) => w?.radius)),
    tireWidthFt: mean(ordered.map((w) => w?.width)),
  });
  let state = S.createTruckState([0, 0, 0], 0, S.GEAR.FIRST, params);
  let invertedFor = 0;
  let manual = false;
  // The hardest hull contact and bump-stop landing in the last step() call, and the safe copy.
  let impactForce = 0, bottoming = 0, splash = false;
  let safe = null, sinceSafe = 0, rescued = 0;
  const terrainAt = (x, z) => typeof frame.terrainAtFeet === "function"
    ? frame.terrainAtFeet(x, -z) : frame.heightAtFeet(x, -z);

  // A support must be below the body, so bridges do not pull a truck up from underneath.
  // The library's height query has no y argument; use this truck's current altitude.
  function support(x, z) {
    const terrain = terrainAt(x, z);
    const top = colliders?.supportAt(x, -z, state.pos[1], { truck: true }) ?? null;
    return { terrain, top, onObject: top !== null && (terrain === null || top > terrain) };
  }
  const ground = {
    weather: WEATHER[weather] ?? 0,
    waterLevelFt,
    height(x, z) {
      const s = support(x, z);
      // A finite empty-space sentinel avoids Infinity * 0 inside the axle solver.
      return s.onObject ? s.top : s.terrain ?? -1e9;
    },
    normal(x, z, out) {
      const s = support(x, z);
      if (s.onObject) {
        const h = 0.05;
        const sample = (a, b) => colliders.supportAt(a, -b, state.pos[1], { probe: true, truck: true });
        const left = sample(x - h, z), right = sample(x + h, z);
        const back = sample(x, z - h), front = sample(x, z + h);
        // Do not turn a deck edge into a near-vertical terrain normal.
        out[0] = left !== null && right !== null && Math.abs(left - right) < 1 ? (left - right) / (2 * h) : 0;
        out[1] = 1;
        out[2] = back !== null && front !== null && Math.abs(back - front) < 1 ? (back - front) / (2 * h) : 0;
        return S.normalize(out);
      }
      const n = s.terrain === null ? { x: 0, y: 1, z: 0 } : frame.normalAtFeet(x, -z);
      out[0] = n.x; out[1] = n.y; out[2] = -n.z;
      return out;
    },
    surface(x, y, z) {
      const s = support(x, z);
      if (s.onObject) return colliders.surfaceAt?.(x, -z, state.pos[1]) ?? 0;
      // A wheel on a ground box's top takes the type of its top texture, as before.
      const column = colliders?.columnAt?.(x, -z, y + COLUMN_TOP_REACH_FT);
      if (column && column.top > y - COLUMN_TOP_REACH_FT && (s.terrain === null || column.top >= s.terrain)) return column.surface;
      if (waterLevelFt !== null && s.terrain !== null && s.terrain <= waterLevelFt) {
        return ground.weather === S.WEATHER.SNOW ? 800 : 1300;
      }
      return frame.surfaceAtFeet?.(x, -z) ?? 200;
    },
  };
  const context = { ground, human: true, difficulty: params.difficulty, sonicTrack: false };
  // OpenPhotex's own collision for ground boxes and fixed scenery's walls, as OpenMTM2 runs it.
  const wallFaces = createWallFaces(colliders);
  const nearBoxes = [], nearFaces = [];
  const radius = S.truckRadius(params);
  function collideWorld(h) {
    nearBoxes.length = 0;
    if (groundBoxes) S.groundBoxesAround(groundBoxes.ra0, groundBoxes.ra1, state.pos[0], state.pos[2], nearBoxes, groundBoxes.stepFt);
    for (const box of nearBoxes) S.collideTruckImmovableBox(state, params, box, h);
    nearFaces.length = 0;
    wallFaces.around(state.pos[0], state.pos[2], radius, nearFaces);
    for (const face of nearFaces) S.collideTruckFace(state, params, face, h);
  }

  function worldPoint(body) {
    const w = [0, 0, 0];
    S.bodyToWorld(state.matrix, body, w);
    return vec(w.map((v, i) => v + state.pos[i]));
  }
  function velocity() {
    const v = [0, 0, 0];
    S.bodyToWorld(state.matrix, state.bvel, v);
    return vec(v);
  }
  function setVelocity(v) { S.worldToBody(state.matrix, array(v), state.bvel); }

  function reset(position, psi = 0, roll = 0) {
    state = S.createTruckState(array(position), psi, S.GEAR.FIRST, params);
    state.euler[1] = roll;
    S.eulerToMatrix(0, roll, psi, state.matrix);
    state.prevMatrix.set(state.matrix);
    invertedFor = 0;
    for (let i = 0; i < 4; i++) S.tireGeometry(state, params, i);
    safe = copyState(state);
    sinceSafe = 0;
    impactForce = bottoming = 0;
    splash = false;
  }

  function shift(direction) {
    if (!manual) return false;
    const before = state.controls.gear;
    // Keep the viewer's first/reverse shortcut while the core retains its native
    // Park/Reverse/Neutral/1/2/3 numbering internally.
    if (before === S.GEAR.FIRST && direction < 0) {
      if (Math.abs(state.bvel[2]) >= 1.5) return false;
      state.controls.gear = S.GEAR.REVERSE;
    } else if (before === S.GEAR.REVERSE && direction > 0) {
      if (Math.abs(state.bvel[2]) >= 1.5) return false;
      state.controls.gear = S.GEAR.FIRST;
    } else {
      state.controls.shiftRequest = direction;
      S.stepGearbox(state.controls, { rpm: state.rpm, autoShift: false, forwardSpeed: state.bvel[2], dragStaging: false });
    }
    return before !== state.controls.gear;
  }

  function step(dt, input = {}) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    impactForce = bottoming = 0;
    splash = false;
    // All callers, including headless tools, obey the same stable substep ceiling.
    const steps = Math.ceil(Math.min(dt, 0.25) * 120);
    const h = Math.min(dt, 0.25) / steps;
    for (let k = 0; k < steps; k++) {
      const throttle = clamp(input.throttle, 0, 1), brake = clamp(input.brake, 0, 1);
      const steer = clamp(input.steer, -1, 1);
      const ctx = { dt: h, autoShift: !manual, forwardSpeed: state.bvel[2], dragMode: false, segments: 0 };
      S.applyKeyboard(state.controls, {
        accelerate: throttle > 0, brake: brake > 0 && !input.handbrake,
        left: steer < 0, right: steer > 0,
      }, ctx);
      // Gamepad axes are already dead-zoned by drive-input. Preserve analog travel.
      if (input.analog) S.applyJoystick(state.controls, { x: steer, y: brake - throttle }, ctx);
      // Test Drive releases the manual throttle with the pedal. The original
      // keyboard routine latches it, which is unsuitable for the viewer's controls.
      if (manual && throttle === 0) state.controls.throttle = 0;
      if (input.handbrake) {
        state.controls.throttle = 0;
        state.controls.brakeFront = state.controls.brakeRear = 1;
      }
      S.stepTruck(state, params, context, h);
      // This step's hull contact force only (OpenPhotex 1.3.1: 0 without contact).
      impactForce = Math.max(impactForce, state.impactForce ?? 0);
      splash = splash || state.splash === true;
      S.eulerToMatrix(...state.euler, state.matrix);
      // After the truck step and before the post-step, as OpenMTM2's session (sim-worker.js).
      collideWorld(h);
      resolveSceneryContacts(state, params, colliders, h);
      S.postStepTruck(state, params, ground, h);
      // The speed the bump stops took off the truck in that post-step (OpenPhotex 1.3.1).
      bottoming = Math.max(bottoming, state.bottoming ?? 0);
      // A broken state is put back as the truck last stood, at rest (OpenMTM2's guard).
      if (stateIsSane(state)) {
        if (!safe || (++sinceSafe >= SAFE_EVERY && Math.hypot(...state.bvel) < 400)) { safe = copyState(state); sinceSafe = 0; }
      } else if (safe) {
        restoreState(state, safe);
        for (const list of [state.bvel, state.rates, state.extForce, state.extMoment]) list?.fill?.(0);
        rescued++;
      }
      invertedFor = state.matrix[4] < 0 ? invertedFor + h : 0;
    }
  }

  // Arrays given to the renderer follow the assembly's order, not physics' FR/FL/RR/RL.
  const indices = supplied.map((w) => KEYS.indexOf(w.key.replace(".static_bpos", "")));
  const wheelValues = (fn) => indices.map((i) => i < 0 ? 0 : fn(i));
  function hub(i) {
    const a = state.axles[i < 2 ? 0 : 1], p = params.drawHubs[i];
    return [p[0] * Math.cos(a.articulation), p[0] * Math.sin(a.articulation) + a.travel, p[2]];
  }
  function readState() {
    return {
      // Over the last step() call: the hardest hull contact (lbf) and bump-stop landing (ft/s).
      impactForce, bottoming, splash, rescued,
      ipos: vec(state.pos), bvel: vec(state.bvel),
      theta: -state.euler[0], phi: state.euler[1], psi: state.euler[2],
      pitchRate: -state.rates[1], yawRate: -state.rates[2], rollRate: state.rates[0],
      gear: state.controls.gear === S.GEAR.REVERSE ? -1 : Math.max(0, state.controls.gear - 3),
      rpm: state.rpm, speed: S.length(state.bvel),
      airborne: state.tires.every((t) => !t.onGround), invertedFor,
      braking: state.controls.brakeFront > 0.05 || state.controls.brakeRear > 0.05,
      wheels: state.tires.map((t, i) => {
        const p = worldPoint(hub(i));
        const value = ground.surface(p.x, p.y, -p.z);
        return { key: `${KEYS[i]}.static_bpos`, on_gnd: t.onGround,
          compression: t.compression, steering_angle: i < 2 ? state.controls.steer : state.controls.rearSteer,
          spinAngle: t.angle, surface: t.onGround ? (value === 1300 ? "Water" : surfaceOf(value).name) : null };
      }),
    };
  }
  return {
    reset, step, readState, params,
    get physicsState() { return state; },
    get velocity() { return velocity(); },
    setVelocity,
    setGear(gear) { state.controls.gear = gear < 0 ? S.GEAR.REVERSE : clamp(gear, 1, 3) + 3; },
    setManual(value) { manual = value === true; params.autoShift = !manual; },
    get manual() { return manual; },
    setWeather(value) { ground.weather = WEATHER[value] ?? 0; },
    shiftUp: () => shift(1), shiftDown: () => shift(-1),
    get orientation() {
      const [t, p, s] = state.euler.map((v) => v / 2);
      const ct = Math.cos(t), st = Math.sin(t), cp = Math.cos(p), sp = Math.sin(p), cs = Math.cos(s), ss = Math.sin(s);
      return { x: -(cs * st * cp + ss * ct * sp), y: -(ss * ct * cp - cs * st * sp),
        z: cs * ct * sp - ss * st * cp, w: cs * ct * cp + ss * st * sp };
    },
    mountPoints: () => params.drawHubs.map((p, i) => ({
      // Static mounts preserve the chassis pose when the viewer fits its anisotropic world.
      world: worldPoint(p), body: vec(p), radius: params.tireRadiusFt,
      isFront: i < 2, isLeft: i % 2 === 1,
    })),
    wheelCompression: () => wheelValues((i) => hub(i)[1] - params.drawHubs[i][1]),
    wheelSteer: () => wheelValues((i) => i < 2 ? state.controls.steer : state.controls.rearSteer),
    wheelSpin: () => wheelValues((i) => state.tires[i].angle),
    wheelPoses: () => indices.map((i) => i < 0 ? null : ({ position: vec(hub(i)), articulation: state.axles[i < 2 ? 0 : 1].articulation })),
    axlePoses: () => state.axles.map((a) => ({ ...a })),
  };
}
