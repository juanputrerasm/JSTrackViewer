/*
  The truck simulation.

  Deliberately free of Three.js and of the scene: it takes a truck's measured geometry, a
  parameter set and a terrain sampler, and steps a rigid body. That is what lets it run under
  node for tests, and later under the parameter fitter, which replays captured input traces
  thousands of times looking for the values that match the real game.

  THE STATE IS MTM2'S OWN. The save-state block in a .SIT names the engine's variables:

    ipos                        position
    bvel                        velocity in BODY axes
    theta, phi, psi             orientation as Euler angles
    p, q, r                     angular rates in body axes
    faxle.angle, faxle.steering_angle, and the same for raxle
    faxle.rtire.on_gnd, ...     per tire ground contact
    xm.gear                     the selected gear

  That is a flight-dynamics formulation, which is no surprise: Terminal Reality wrote flight
  sims either side of this game. Keeping the same variables means a save-state can seed the
  sim directly, and that captured telemetry maps field for field onto what is stored here
  rather than through a conversion nobody can check.

  Internally the orientation is a quaternion, because Euler angles gimbal lock and a monster
  truck lands upside down regularly; theta/phi/psi are derived on read. Everything is feet,
  seconds, slugs and pounds-force, the consistent set where F = ma needs no constant.

  WHAT IS NOT KNOWN. None of the coefficients are measured from MTM2 yet, so this reproduces
  the SHAPE of the game's model with plausible numbers in it. See params/mtm2-feel.js.
*/
import { GRAVITY, MTM2_FEEL, TRUCK_MASS_SLUGS } from "./params/mtm2-feel.js";

const WHEEL_ORDER = ["faxle.rtire", "faxle.ltire", "raxle.rtire", "raxle.ltire"];

/*
  Ceilings, not targets.

  Nothing in a monster truck race approaches either of these: the gearing tops the truck out
  near 71 mph, and a truck rolling at two turns a second is already an accident. They exist so
  that a bad contact cannot hand the next step a number that makes the truck disappear, taking
  the cameras with it.
*/
const MAX_SPEED = 250;       // ft/s, about 170 mph
const MAX_SPIN_RATE = 12;    // rad/s, about two rotations a second

/*
  How hard bodywork scrubs along the ground, as a fraction of the contact impulse.

  Well above a tire's grip on purpose. Sheet metal dragging through dirt is not a tire rolling
  on it: it ploughs, and it stops a truck fast. In MTM2 going over ends the run almost at once,
  where 0.6 here left a rolled truck sliding for tens of metres and 1.8 still took four seconds
  to come down from 41 mph to 10.

  Raising it is only safe because contacts are impulses now. The friction impulse is capped by
  the one that would stop the sliding outright, so a larger coefficient makes the truck stop
  sooner and can never drag it backwards or add energy. Under the old force model this number
  fought the integrator, and every increase risked another launch.
*/
const SCRAPE_FRICTION = 3.5;

/*
  How upright the truck has to be before its wheels are treated as load bearing.

  Below this it is on its side or its roof, the wheels are no longer underneath it, and any
  measurement projected along the truck's own up axis stops meaning anything: that projection
  divides by up.y, which is heading for zero and then going negative. Clamping up.y to a small
  positive floor instead turned the division into a five times amplifier, so a wheel half a
  foot under the surface read as four feet of excess travel and the truck was teleported four
  feet upward every step. A rolled truck pogoed across the landscape rather than grinding to a
  halt, and bodywork friction could do nothing about it, because a truck in the air is not
  touching anything to rub against.

  0.35 is roughly a 70 degree lean, past the point where a monster truck is coming back down
  on its own wheels. Beyond it the scrape hull carries the body, which is what it is for.
*/
const UPRIGHT_ENOUGH = 0.35;

/*
  The most the truck is pushed out of the ground in one step, in feet.

  A position correction is a teleport, so it has to stay small enough to read as the
  suspension topping out rather than as the truck jumping. Deeper penetration resolves over
  several steps, which at 120 Hz is still inside a frame or two.
*/
const MAX_LIFT_PER_STEP = 0.35;

/*
  How far into its contact a resting body is allowed to sit, in feet.

  Under three quarters of an inch, so nothing shows, but enough that the contact carries load:
  at the body stiffness used here that is a few thousand pounds per point, which is the right
  order for holding a five ton truck on its roof, and it is what the scrape friction scales
  from.
*/
const RESTING_DEPTH = 0.06;
/*
  Most the body is moved out of an object in one step, in feet.

  Velocity impulses stop the truck going further in; they do nothing about overlap already
  there, and a moving object creates overlap every step it advances. Terrain has
  liftOutOfGround for this. Objects push along their own normal instead, because out of a wall
  is sideways, and the cap keeps a deep overlap from turning into a teleport.
*/
const MAX_OBJECT_PUSH_PER_STEP = 0.1;

/** Below this, in ft/s, the truck counts as stopped for the purpose of selecting reverse. */
const REVERSE_ENGAGE_SPEED = 1.5;

/* ---- small vector and quaternion helpers, so this file needs no library ---- */

const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a, s) => v3(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => v3(
  a.y * b.z - a.z * b.y,
  a.z * b.x - a.x * b.z,
  a.x * b.y - a.y * b.x
);
const length = (a) => Math.hypot(a.x, a.y, a.z);
const normalize = (a) => {
  const len = length(a) || 1;
  return v3(a.x / len, a.y / len, a.z / len);
};

/** Rotate a vector by a quaternion {w,x,y,z}. */
function rotate(q, v) {
  const t = cross(v3(q.x, q.y, q.z), v);
  const tx = t.x * 2, ty = t.y * 2, tz = t.z * 2;
  return v3(
    v.x + q.w * tx + (q.y * tz - q.z * ty),
    v.y + q.w * ty + (q.z * tx - q.x * tz),
    v.z + q.w * tz + (q.x * ty - q.y * tx)
  );
}

/** Rotate a world vector into body axes. */
function inverseRotate(q, v) {
  return rotate({ w: q.w, x: -q.x, y: -q.y, z: -q.z }, v);
}

function quatFromAxisAngle(axis, angle) {
  const half = angle / 2;
  const s = Math.sin(half);
  const a = normalize(axis);
  return { w: Math.cos(half), x: a.x * s, y: a.y * s, z: a.z * s };
}

function quatMultiply(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function quatNormalize(q) {
  const len = Math.hypot(q.w, q.x, q.y, q.z) || 1;
  return { w: q.w / len, x: q.x / len, y: q.y / len, z: q.z / len };
}

/** Euler angles in the engine's own names, for reporting and for save-state comparison. */
function eulerOf(q) {
  const sinTheta = 2 * (q.w * q.x - q.y * q.z);
  const theta = Math.asin(Math.max(-1, Math.min(1, sinTheta)));
  const psi = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));
  const phi = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.x * q.x + q.z * q.z));
  return { theta, phi, psi };
}

/*
  A TRK anchor, in physics axes.

  A manifest is (x right, y up, z forward); physics space keeps the scene's axes, where the
  truck faces -Z. Only z flips.
*/
const anchorToBody = (a) => v3(a?.x ?? 0, a?.y ?? 0, -(a?.z ?? 0));

/**
 * @param {object} assembly  from the truck loader: wheels with anchors and measured radii,
 *                           the scrape hull, and the body bounds
 * @param {object} frame     world-frame, for heightAtFeet and normalAtFeet
 * @param {object} params    a parameter set, defaulting to the feel-alike one
 */
export function createVehicleSim(assembly, frame, params = MTM2_FEEL, colliders = null) {
  /*
    The ground under a point: terrain, or the top of whatever object is standing on it.

    Wheels ask this rather than the terrain directly, which is what lets a truck drive onto a
    box instead of through it. Only surfaces at or below the wheel count, so a raised object
    overhead is something to drive under rather than be snapped up onto.

    With no colliders (a track with no objects, or the tests) this is exactly the terrain, so
    nothing else in the sim has to know whether a track has objects in it.
  */
  const groundUnder = (x, z, y) => {
    const terrain = frame.heightAtFeet(x, z);
    if (!colliders) return terrain;
    const support = colliders.supportAt(x, z, y);
    return support !== null && support > terrain ? support : terrain;
  };
  const wheels = (assembly.wheels ?? []).map((wheel, index) => ({
    index,
    key: wheel.key,
    isFront: wheel.key.startsWith("faxle"),
    isLeft: wheel.key.includes(".ltire."),
    // Where the wheel hangs from, in body axes, and how big it is.
    mount: anchorToBody(wheel.position),
    radius: wheel.radius || 3.0,
    // Per-wheel running state.
    compression: 0,
    lastCompression: 0,
    onGround: false,
    spinAngle: 0,
    spinRate: 0,
    steerAngle: 0,
  }));
  // Keep the engine's own ordering, which is also what on_gnd is reported in.
  wheels.sort((a, b) => WHEEL_ORDER.indexOf(keyOf(a)) - WHEEL_ORDER.indexOf(keyOf(b)));

  const scrape = (assembly.scrapePoints ?? []).map(anchorToBody);
  const mass = params.chassis.mass;
  const inertia = inertiaFor(assembly, params, mass);
  const cg = anchorToBody(params.chassis.cg);

  // The last state that was entirely finite, for recovering from a bad step.
  let lastGood = null;

  const state = {
    /*
      Internally this is the CENTRE OF GRAVITY, not the body origin.

      A rigid body rotates about its centre of gravity and F = ma moves that point, so the
      integration has to be about it. MTM2's ipos is the body origin, though, and so is what
      the renderer places and what a save-state records, so reset() takes a body origin and
      readState() reports one. The conversion is one rotated offset at each boundary, and
      keeping it there is what stops a 3 ft cg offset from quietly becoming a 3 ft spawn error.
    */
    ipos: v3(),
    // World-axis velocity is what gets integrated; bvel is reported in body axes, as MTM2
    // stores it, and is the one the telemetry comparison uses.
    vel: v3(),
    orientation: { w: 1, x: 0, y: 0, z: 0 },
    // Body rates, the engine's p (roll), q (pitch), r (yaw).
    omega: v3(),
    gear: 1,
    rpm: params.engine.idleRpm,
    steerInput: 0,
    airborne: false,
    // Seconds spent upside down, which is what decides when the truck is put back on the course.
    invertedFor: 0,
    shiftTimer: 0,
  };

  /**
   * Put the truck somewhere, at rest.
   *
   * @param {{x,y,z}} positionFeet the BODY ORIGIN, the same point MTM2's ipos names and the
   *        same one the renderer places. The centre of gravity is derived from it.
   */
  function reset(positionFeet, psi = 0, rollRadians = 0) {
    /*
      The track's heading convention is not this sim's rotation convention.

      A .SIT stores psi such that forward is (sin psi, 0, -cos psi); that is what scene.js's
      start-grid arrows are drawn along and what spawnDriveTruck uses. Here the truck's body
      faces -Z, and rotating (0, 0, -1) by Ry(theta) gives (-sin theta, 0, -cos theta). The
      two agree only when theta = -psi.

      Rotating by +psi instead mirrors the truck about the map's x axis, which is invisible on
      a grid facing north or south and puts the truck exactly backwards on one facing east or
      west. The static placement already used -psi, so driving also moved the truck relative
      to where placing it had just shown it.
    */
    state.orientation = quatFromAxisAngle(v3(0, 1, 0), -psi);
    /*
      An optional roll, for putting a truck down on its side or its roof.

      Respawning wants it (a truck can be returned to the course in any attitude) and so does
      testing the inverted timer, which otherwise cannot be exercised without rolling a truck
      for real and hoping.
    */
    if (rollRadians) {
      const forward = rotate(state.orientation, v3(0, 0, -1));
      state.orientation = quatNormalize(quatMultiply(quatFromAxisAngle(forward, rollRadians), state.orientation));
    }
    state.ipos = add(v3(positionFeet.x, positionFeet.y, positionFeet.z), rotate(state.orientation, cg));
    state.vel = v3();
    state.omega = v3();
    state.gear = 1;
    state.rpm = params.engine.idleRpm;
    state.steerInput = 0;
    state.shiftTimer = 0;
    state.invertedFor = 0;
    for (const wheel of wheels) {
      wheel.compression = 0;
      wheel.lastCompression = 0;
      wheel.onGround = false;
      wheel.spinAngle = 0;
      wheel.spinRate = 0;
      wheel.steerAngle = 0;
      // Filtered ground height under this wheel; null means "take whatever is there".
      wheel.support = null;
    }
  }

  /*
    One fixed step.

    Fixed because a spring-damper suspension integrated at a varying rate changes character
    with the frame rate, and because a sim that is to be compared against captured telemetry
    has to be reproducible. The caller accumulates real time and calls this a whole number of
    times; 1/120 s is small enough for a 3,100 lbf/ft spring on a 78 slug corner.
  */
  /**
   * @param {number} dt
   * @param {object} input
   * @param {Array}  [debug] when given, one record per grounded wheel is pushed onto it.
   *        The force terms are locals, and every question worth asking of this sim (why is a
   *        wheel spinning, why is there no grip, which term dominates) needs them. The
   *        parameter fitter in Phase 5 wants the same numbers.
   */
  function step(dt, input, debug) {
    const q = state.orientation;
    const up = rotate(q, v3(0, 1, 0));
    const forward = rotate(q, v3(0, 0, -1));
    const right = rotate(q, v3(1, 0, 0));

    updateSteering(dt, input);
    const controls = resolveReverse(dt, input);

    let force = v3(0, -mass * GRAVITY, 0);
    let torque = v3();
    // Body contacts found this step, resolved as impulses once the forces have been integrated.
    const bodyContacts = [];

    const engine = engineTorque(dt, controls);
    let groundedCount = 0;

    const horizontalSpeed = Math.hypot(state.vel.x, state.vel.z);

    for (const wheel of wheels) {
      // Where this wheel's mount is in the world, and where its contact would be.
      const mountWorld = add(state.ipos, rotate(q, sub(wheel.mount, cg)));
      const terrainY = frame.heightAtFeet(mountWorld.x, mountWorld.z);
      const rawGround = groundUnder(mountWorld.x, mountWorld.z, mountWorld.y);

      /*
        An object top under a wheel may RISE only as fast as a wheel could climb it.

        A wheel here is a single downward ray, so the top of a ground box appears the instant
        the ray crosses its edge: the wheel goes from resting on terrain to a foot inside solid
        scenery between one step and the next. The anti-clipping correction then lifts the body
        out at its maximum rate, and TPARK's bridges threw the truck into the air. Measured, the
        climb was 42.0 ft/s whatever the speed, which is exactly MAX_LIFT_PER_STEP / dt: the
        truck was being teleported, not sprung.

        A real wheel climbs a step over its own contact patch. A 3 ft wheel needs about 2.8 ft
        of travel to climb 2 ft, so the rise is bounded by how fast the truck is moving forward,
        which is what this does. Falling away is instant, because nothing holds a wheel up.

        The floor lets a stationary truck settle onto something that rises under it rather than
        hanging there for ever.
      */
      const climbLimit = Math.max(3, horizontalSpeed) * dt;
      // Terrain is continuous. Delaying its rise lets an axle enter a steep hillside before
      // the support ray catches up, then the penetration correction lifts the whole truck.
      // Only an object's abrupt top edge needs the wheel climb limit.
      if (rawGround <= terrainY + 1e-6) wheel.support = terrainY;
      else if (wheel.support === null || rawGround <= wheel.support) wheel.support = rawGround;
      else wheel.support = Math.max(terrainY, Math.min(rawGround, wheel.support + climbLimit));
      const groundY = wheel.support;

      /*
        Contact is found along the truck's own up axis rather than straight down.

        A wheel hangs from the chassis, so its travel is along the body's up; using world down
        would lengthen the effective suspension as the truck leans and make a truck on a slope
        settle differently depending on which way it faces.
      */
      /*
        Same restriction as the lift: a wheel only carries load while the truck is upright
        enough for its own up axis to point away from the ground.

        Dividing by a clamped up.y on a rolled truck invents enormous compression out of a
        wheel that is in the air, and the suspension then fires the truck off the scenery.
      */
      const restCentre = mountWorld;
      const terrainNormal = frame.normalAtFeet(mountWorld.x, mountWorld.z);
      const steepTerrain = groundY <= terrainY + 1e-6 && terrainNormal.y < 0.8;
      const contactAxis = steepTerrain ? dot(up, terrainNormal) : up.y;
      const contactDistance = up.y > UPRIGHT_ENOUGH && contactAxis > UPRIGHT_ENOUGH
        ? (restCentre.y - groundY) * (steepTerrain ? terrainNormal.y : 1) / contactAxis
        : Infinity;
      const compression = wheel.radius - contactDistance;

      wheel.lastCompression = wheel.compression;
      wheel.compression = Math.max(0, Math.min(params.suspension[wheel.isFront ? "front" : "rear"].maxcompr, compression));
      wheel.onGround = compression > 0;
      if (!wheel.onGround) {
        // A free wheel spins down slowly rather than holding its speed for ever.
        wheel.spinRate *= Math.max(0, 1 - dt * 0.8);
        wheel.spinAngle += wheel.spinRate * dt;
        continue;
      }
      groundedCount++;

      const axle = params.suspension[wheel.isFront ? "front" : "rear"];
      const cornerMass = mass / wheels.length;
      const critical = 2 * Math.sqrt(axle.spring_rate * cornerMass);
      const rate = (wheel.compression - wheel.lastCompression) / dt;
      const damping = (rate > 0 ? axle.dampingBump : axle.dampingRebound) * critical;

      /*
        Spring and damper, both along the body's up axis, and both PUSHING the body up.

        The damper's sign is the thing to get right. `rate` is how fast the suspension is
        compressing, so while it compresses the damper resists that motion by pushing up, and
        the two terms add; on rebound `rate` goes negative and the damper subtracts, which is
        what keeps the truck from springing back as hard as it landed.

        Subtracting instead is a quiet disaster rather than a visible one: on any sharp
        compression the damper term swamps the spring, the clamp below takes the whole force
        to zero, and the truck both fails to hold itself up and loses all tire grip, because
        grip is proportional to this force. It then rebounds with energy added rather than
        removed, so it never settles.
      */
      const springForce = axle.spring_rate * wheel.compression + damping * rate;
      // A suspension can push but not pull: past full droop the wheel simply hangs.
      const normalForce = Math.max(0, springForce);
      const suspension = scale(steepTerrain ? terrainNormal : up, normalForce);

      // Velocity of this contact patch, world then in the wheel's own frame.
      const arm = sub(add(state.ipos, rotate(q, sub(wheel.mount, cg))), state.ipos);
      const pointVel = add(state.vel, cross(rotate(q, state.omega), arm));

      const steer = wheel.steerAngle;
      const wheelForward = normalize(add(scale(forward, Math.cos(steer)), scale(right, Math.sin(steer))));
      const wheelRight = normalize(cross(v3(0, 1, 0), wheelForward));

      const vForward = dot(pointVel, wheelForward);
      const vLateral = dot(pointVel, wheelRight);

      // Longitudinal: the difference between the tread's speed and the ground's.
      const treadSpeed = wheel.spinRate * wheel.radius;
      const slipRatio = clamp((treadSpeed - vForward) / Math.max(4, Math.abs(vForward)), -1.5, 1.5);

      /*
        The longitudinal force, clamped so it cannot overshoot zero slip within one step.

        Tire contact is stiff: several thousand pounds of grip act on a wheel whose inertia is
        a couple of hundred slug ft^2, so an explicit step can apply more impulse than it takes
        to null the slip and send the wheel spinning the other way. It then reverses again next
        step. That oscillation is not a wobble to be damped out, it changes the answer: the
        force alternates sign and averages to near nothing, which showed up as a parked truck
        creeping along at 0.34 ft/s and full throttle stalling at 14 mph.

        The fix is the usual one for stiff contact: work out the force that brings the slip
        velocity exactly to zero over this step and never exceed it. Slip closes through both
        the wheel spinning and the truck accelerating, so both contribute:

          d(slip)/dF = dt * (r^2 / I + 1 / m_corner)

        Below the limit the tire curve governs, as it should; at the limit the contact simply
        stops slipping, which is what a real tire does when it hooks up.
      */
      const wheelMass = params.tire.wheelWeight / GRAVITY;
      const wheelInertia = 0.5 * wheelMass * wheel.radius * wheel.radius;
      const slipVelocity = treadSpeed - vForward;
      const slipCompliance = dt * ((wheel.radius * wheel.radius) / wheelInertia + 1 / cornerMass);
      const nonOvershoot = Math.abs(slipVelocity) / Math.max(1e-9, slipCompliance);

      const curveForce = saturate(slipRatio, params.tire.peakSlipRatio) * params.tire.CF_long * normalForce;
      const longForce = Math.sign(curveForce) * Math.min(Math.abs(curveForce), nonOvershoot);

      // Lateral: the angle between where the wheel points and where it is going.
      const slipAngle = Math.atan2(-vLateral, Math.max(2, Math.abs(vForward)));
      const latForce = saturate(slipAngle, params.tire.peakSlipAngle) * params.tire.CF_lat * normalForce;

      // Both live inside one friction circle, or a spinning wheel would still corner.
      const limit = Math.max(params.tire.CF_long, params.tire.CF_lat) * normalForce;
      const combined = Math.hypot(longForce, latForce);
      const trim = combined > limit && combined > 0 ? limit / combined : 1;

      const traction = add(scale(wheelForward, longForce * trim), scale(wheelRight, latForce * trim));
      const rolling = scale(wheelForward, -Math.sign(vForward) * params.tire.rollingResistance * normalForce);

      const total = add(add(suspension, traction), rolling);
      force = add(force, total);
      torque = add(torque, cross(arm, total));

      // The wheel's own spin: drive and brake torque against the ground's reaction.
      const share = wheel.isFront ? params.transmission.torque_pct.front : params.transmission.torque_pct.rear;
      const brakeTorque = (controls.brake ?? 0)
        * (wheel.isFront ? params.brakes.maxTorqueFront : params.brakes.maxTorqueRear);

      /*
        Drive accelerates the wheel; everything else only ever slows it.

        Engine braking has to be kept on the resisting side explicitly. Folding it into one
        signed "net engine torque" makes a closed throttle apply a large NEGATIVE drive
        torque, which spins the wheels backwards and drives the truck slowly in reverse: a
        parked truck crept backwards at 0.34 ft/s until this was separated out.

        Both resistances are capped at the torque that would bring this wheel exactly to rest
        within the step, so neither the brakes nor the engine can spin a wheel up the other
        way, which is the discrete-time version of the same mistake.
      */
      const drivenShare = share / 2;
      const inertiaW = wheelInertia;
      const resist = brakeTorque + engine.brake * drivenShare;
      const stoppingTorque = Math.abs(wheel.spinRate) * inertiaW / dt;

      let netTorque = engine.drive * drivenShare - longForce * trim * wheel.radius;
      netTorque -= Math.sign(wheel.spinRate) * Math.min(resist, stoppingTorque);

      wheel.spinRate += (netTorque / inertiaW) * dt;
      wheel.spinAngle += wheel.spinRate * dt;

      if (debug) {
        debug.push({
          key: wheel.key,
          normalForce, compression: wheel.compression,
          vForward, vLateral, treadSpeed,
          slipRatio, slipAngle, longForce, latForce, trim,
          spinRate: wheel.spinRate, netTorque,
          engineDrive: engine.drive, engineBrake: engine.brake,
          driveTerm: engine.drive * drivenShare,
          tractionTerm: -longForce * trim * wheel.radius,
          resistTerm: -Math.sign(wheel.spinRate) * Math.min(resist, stoppingTorque),
          rpm: state.rpm, gear: state.gear,
        });
      }
    }

    state.airborne = groundedCount === 0;

    /*
      How long the truck has been upside down.

      MTM2 leaves a rolled truck lying there and puts it back on the course after a couple of
      seconds rather than flipping it upright on the spot. Drive mode does the putting back; the
      simulation only counts.
    */
    state.invertedFor = up.y < 0 ? state.invertedFor + dt : 0;

    /*
      The wheels are solid too.

      Only the body's twelve scrape points met objects before, so a tire could pass straight
      through a fence post that the bodywork never reached. The test point is the LEADING edge
      of the tire, a radius ahead of its centre along the direction of travel, because that is
      what touches a wall first.

      Only walls count: anything whose normal points mostly upward is a floor, and floors are
      already handled by the wheel's own downward ray. Without that filter a compressed tire
      standing on a ramp finds its own ground and shoves the truck backwards.
    */
    for (const wheel of wheels) {
      if (!colliders) break;
      const mountWorld = add(state.ipos, rotate(q, sub(wheel.mount, cg)));
      const centre = add(mountWorld, scale(up, wheel.compression));
      const heading = horizontalSpeed > 1
        ? normalize(v3(state.vel.x, 0, state.vel.z))
        : rotate(q, v3(0, 0, -1));
      const leading = add(centre, scale(heading, wheel.radius));
      const hit = colliders.contactAt(leading, state.ipos);
      if (hit && Math.abs(hit.normal.y) < 0.7) {
        bodyContacts.push({
          object: true,
          normal: hit.normal,
          arm: sub(leading, state.ipos),
          depth: hit.depth,
          solid: hit.solid ?? null,
        });
      }
    }

    // The scrape hull: the body itself hitting the ground.
    for (const point of scrape) {
      const world = add(state.ipos, rotate(q, sub(point, cg)));

      /*
        The hull meets objects as well as terrain.

        Without this the truck drives through the SIDE of a box while its wheels happily ride
        over the top of it: the wheel rays know about objects and the body did not. An object
        hit comes back with its own outward normal, which is what makes a wall push the truck
        back rather than up.
      */
      /*
        The centre of gravity goes along as the reference point. A model is not a closed solid,
        so "is this point inside it" has no answer; "does a surface separate this hull point
        from the middle of the truck" does, for open, closed and paper-thin geometry alike.
      */
      const objectContact = colliders?.contactAt(world, state.ipos) ?? null;
      if (objectContact) {
        bodyContacts.push({
          object: true,
          normal: objectContact.normal,
          arm: sub(world, state.ipos),
          depth: objectContact.depth,
          // Carried through so the resolver can shove whatever was hit.
          solid: objectContact.solid ?? null,
        });
        if (debug) {
          debug.push({ key: "object", depth: objectContact.depth, worldY: world.y });
        }
        continue;
      }

      const groundY = frame.heightAtFeet(world.x, world.z);
      const depth = groundY - world.y;
      if (depth <= 0) continue;

      /*
        A penalty contact rather than a proper constraint: stiff enough to stop the body
        passing through, damped hard so it does not launch the truck back out. This is what
        makes a landing on the bodywork behave like MTM2's belly flops rather than like a
        trampoline.
      */
      /*
        Collected here, resolved after the integration as an impulse.

        A spring cannot do this job. Tried three ways, it failed at one end or the other every
        time: capped by the force needed to arrest the approach, it holds nothing once a truck
        has come to rest on it; uncapped, a body landing 3 ft deep in one step saturates at 20 g
        per point and the truck departs faster than it arrived, gaining energy from nothing.
        That is inherent to answering a stiff collision with a force under an explicit
        integrator, not a matter of finding better constants.

        An impulse cannot overshoot, because it is written in the units of the thing it is
        cancelling: remove the approaching velocity, keep almost none of it as rebound, and
        take friction out of the tangential velocity in the same pass.
      */
      const normal = frame.normalAtFeet(world.x, world.z);
      const arm = sub(world, state.ipos);
      const pointVel = add(state.vel, cross(rotate(q, state.omega), arm));
      const closing = dot(pointVel, normal);
      bodyContacts.push({ normal, arm, depth });
      if (debug) {
        debug.push({ key: "scrape", depth, closing, worldY: world.y, groundY });
      }
      continue;
    }

    // Air drag, against the body's own motion.
    const speed = length(state.vel);
    if (speed > 0.1) {
      const drag = 0.5 * params.chassis.airDensity * params.chassis.dragArea * speed * speed;
      force = add(force, scale(normalize(state.vel), -drag));
    }

    // Integrate: semi-implicit Euler, which stays stable with stiff springs where explicit
    // Euler does not.
    state.vel = add(state.vel, scale(force, dt / mass));
    state.ipos = add(state.ipos, scale(state.vel, dt));

    const bodyTorque = inverseRotate(q, torque);
    const omegaDot = v3(
      (bodyTorque.x - (inertia.z - inertia.y) * state.omega.y * state.omega.z) / inertia.x,
      (bodyTorque.y - (inertia.x - inertia.z) * state.omega.z * state.omega.x) / inertia.y,
      (bodyTorque.z - (inertia.y - inertia.x) * state.omega.x * state.omega.y) / inertia.z
    );
    state.omega = add(state.omega, scale(omegaDot, dt));

    const spin = length(state.omega);
    if (spin > 1e-9) {
      const delta = quatFromAxisAngle(rotate(q, normalize(state.omega)), spin * dt);
      state.orientation = quatNormalize(quatMultiply(delta, q));
    }

    /*
      Limits, then a hard push out of the ground, then a sanity check.

      Penalty forces alone cannot keep a truck above the terrain. They are a spring, and a
      spring reacts AFTER the step that buried the wheel: at 100 mph a frame covers 1.2 ft, so
      a hard landing can put a corner below the surface faster than any stiffness can answer,
      and once it is under, the terrain is simply not in the way any more. MTM2 never shows
      that, so the sim corrects position directly rather than only pushing.
    */
    // Named apart from the `speed` the drag term uses earlier in this step, which is the value
    // BEFORE integration and a different number.
    const finalSpeed = length(state.vel);
    if (finalSpeed > MAX_SPEED) state.vel = scale(state.vel, MAX_SPEED / finalSpeed);
    const finalSpin = length(state.omega);
    if (finalSpin > MAX_SPIN_RATE) state.omega = scale(state.omega, MAX_SPIN_RATE / finalSpin);

    // Velocity first, then position: cancel the approach, then clear any overlap that is left.
    resolveBodyContacts(bodyContacts);
    liftOutOfGround();

    if (isFiniteState()) rememberGoodState();
    else restoreGoodState();

    return state;
  }

  /*
    Lift the truck clear of anything it has sunk into.

    Measured at the wheels (past full suspension travel the axle itself is through the ground)
    and at the scrape hull, taking whichever is deepest. Correction follows the surface normal:
    a steep hillside pushes the truck away from the hillside instead of acting as a vertical
    elevator. Only velocity into that surface is cancelled.
  */
  /*
    Resolve body contacts by changing velocity directly.

    For each point that is inside the ground and still moving into it, work out the impulse
    that brings its approach to a stop, apply it to the body's linear and angular velocity, and
    then take friction out of what is left moving along the surface.

    The effective mass is what makes this correct for a body that can rotate: an impulse at a
    point far from the centre of gravity spends most of itself spinning the truck rather than
    stopping it, and 1/m + n . (I^-1 (r x n)) x r is exactly how much of it does which.

    Restitution is almost nothing, because bodywork does not bounce. MTM2's trucks land on
    their roofs and stay there.
  */
  function resolveBodyContacts(contacts) {
    if (!contacts.length) return;
    const q = state.orientation;

    let pushOut = null;

    for (const contact of contacts) {
      const { arm } = contact;
      let normal = contact.normal;
      if (!contact.object) {
        // Contacts were gathered before position integration. On the lip of a jump a hull
        // point can leave the slope in that step; applying its old impulse afterwards gives
        // the airborne truck a spurious upward kick.
        const point = add(state.ipos, arm);
        if (frame.heightAtFeet(point.x, point.z) <= point.y) continue;
        normal = frame.normalAtFeet(point.x, point.z);
      }
      /*
        Velocity RELATIVE to whatever was hit.

        Against terrain and static scenery that is just the truck's own. Against a moving object
        it is not: a parked truck approaches nothing, and judged on its own velocity TPARK's
        train would sweep straight through it. Relative to the train, the truck is closing at
        70 ft/s, and the same impulse that stops a truck against a wall carries it along.
      */
      const surfaceVelocity = contact.solid?.velocity ?? null;
      const relativeVelocity = () => {
        const v = add(state.vel, cross(rotate(q, state.omega), arm));
        return surfaceVelocity ? sub(v, surfaceVelocity) : v;
      };

      // Overlap with anything the truck cannot simply knock aside is cleared after the loop.
      const yields = contact.solid?.movable && contact.solid.mass < TRUCK_MASS_SLUGS;
      if (contact.object && !yields && (!pushOut || contact.depth > pushOut.depth)) pushOut = contact;

      const pointVel = relativeVelocity();
      const normalSpeed = dot(pointVel, normal);
      if (normalSpeed >= 0) continue; // already leaving, nothing to cancel

      const inverseMass = effectiveInverseMass(arm, normal);
      if (!(inverseMass > 0)) continue;

      const restitution = 0.05;
      const j = -(1 + restitution) * normalSpeed / inverseMass;

      /*
        A movable object takes the hit instead of returning it.

        The truck keeps only the share of the impulse that the object's mass can actually
        resist: a traffic cone at 0.093 against a truck at 10 gives back about one percent, so
        the truck barely notices it and the cone leaves at speed, which is what hitting a cone
        does. A fence section at 77.7 is heavier than the truck, keeps the full share, and
        stops it dead.

        Momentum is not conserved exactly here. A proper two-body resolution would need the
        object's inertia and its own contact set, and these track files describe neither; what
        they do give is a mass, and honouring the RATIO is what makes light things fly and
        heavy things not.
      */
      const solid = contact.solid;
      let truckShare = 1;
      if (solid?.movable && colliders) {
        truckShare = Math.min(1, solid.mass / TRUCK_MASS_SLUGS);
        /*
          The contact point goes with the impulse, because where an object is hit decides what
          it does. A lamp post caught high up turns most of the blow into rotation about its
          foot and goes over; the same blow at its base only slides it.
        */
        colliders.push(solid, scale(normal, -j), add(state.ipos, arm));
      }

      // Terrain turns the truck as a rigid body should; objects mostly just stop it.
      const spinShare = contact.object ? (params.chassis.objectSpinShare ?? 0.3) : 1;
      applyImpulse(scale(normal, j * truckShare), arm, spinShare);

      /*
        Friction, from the tangential velocity that is left after the normal impulse.

        Capped by Coulomb against the normal impulse just applied, so a light touch scrubs
        lightly, and capped again by the impulse that would stop the sliding outright, so it
        can never drag the body backwards.
      */
      const after = relativeVelocity();
      const tangent = sub(after, scale(normal, dot(after, normal)));
      const tangentSpeed = length(tangent);
      if (tangentSpeed < 0.01) continue;

      const direction = normalize(tangent);
      const stopping = tangentSpeed / effectiveInverseMass(arm, direction);
      const friction = Math.min(SCRAPE_FRICTION * j, stopping);
      applyImpulse(scale(direction, -friction), arm, spinShare);
    }

    if (pushOut) {
      const excess = pushOut.depth - RESTING_DEPTH;
      if (excess > 0) {
        state.ipos = add(state.ipos, scale(pushOut.normal, Math.min(excess, MAX_OBJECT_PUSH_PER_STEP)));
      }
    }
  }

  /** How much of an impulse along `direction` at `arm` actually slows that point down. */
  function effectiveInverseMass(arm, direction) {
    const q = state.orientation;
    const torqueAxis = cross(arm, direction);
    const bodyAxis = inverseRotate(q, torqueAxis);
    const angular = v3(bodyAxis.x / inertia.x, bodyAxis.y / inertia.y, bodyAxis.z / inertia.z);
    const worldAngular = rotate(q, angular);
    return 1 / mass + dot(cross(worldAngular, arm), direction);
  }

  /**
   * @param {object} impulse
   * @param {object} arm
   * @param {number} [spinShare] how much of the impulse's TURNING effect to keep.
   *
   * A rigid body takes all of it, and for terrain that is right. For hitting objects it is not
   * what MTM2 does: a replay of a TPARK lap has the truck losing 69 mph in a single frame, about
   * 11 g, while its roll stays at 6 degrees, and across that whole lap with six impacts it never
   * exceeds 29 degrees of roll or turns over once. The game stops the truck hard and barely
   * rotates it. Keeping the full torque here is what made light scenery like a wooden fence
   * throw the truck onto its roof.
   */
  function applyImpulse(impulse, arm, spinShare = 1) {
    state.vel = add(state.vel, scale(impulse, 1 / mass));
    if (spinShare <= 0) return;
    const q = state.orientation;
    const bodyTorque = inverseRotate(q, cross(arm, impulse));
    state.omega = add(state.omega, v3(
      bodyTorque.x * spinShare / inertia.x,
      bodyTorque.y * spinShare / inertia.y,
      bodyTorque.z * spinShare / inertia.z
    ));
  }

  function liftOutOfGround() {
    const q = state.orientation;
    const up = rotate(q, v3(0, 1, 0));
    let deepest = 0;
    let correctionNormal = v3(0, 1, 0);

    /*
      Wheels only count while the truck is the right way up.

      The wheel measurement divides by up.y to project along the truck's own up axis, and on a
      truck that has rolled, up.y is NEGATIVE. Clamping it to a small positive floor turned
      that division into a five times amplifier: a mount half a foot under the surface read as
      four feet of excess travel, and the truck was teleported four feet into the air, every
      step. That is what made a rolled truck pogo across the landscape instead of grinding to
      a halt, and no amount of bodywork friction could fix it, because a truck in the air is
      not touching anything.

      Upside down, the wheels are above the body and cannot be carrying it anyway. The scrape
      hull below handles that case, which is exactly what it is for.
    */
    if (up.y > UPRIGHT_ENOUGH) {
      for (const wheel of wheels) {
        const mountWorld = add(state.ipos, rotate(q, sub(wheel.mount, cg)));
        /*
          The same ground the wheel forces used, which now means the FILTERED height.

          Using the raw ground here while the springs used the filtered one is what turned a
          step into a teleport: the springs were still easing the truck up while this decided it
          was buried and lifted it bodily.
        */
        const groundY = wheel.support ?? groundUnder(mountWorld.x, mountWorld.z, mountWorld.y);
        const terrainY = frame.heightAtFeet(mountWorld.x, mountWorld.z);
        const terrainNormal = frame.normalAtFeet(mountWorld.x, mountWorld.z);
        const steepTerrain = groundY <= terrainY + 1e-6 && terrainNormal.y < 0.8;
        const axis = steepTerrain ? dot(up, terrainNormal) : up.y;
        if (axis <= UPRIGHT_ENOUGH) continue;
        const contactDistance = (mountWorld.y - groundY) *
          (steepTerrain ? terrainNormal.y : 1) / axis;
        const axle = params.suspension[wheel.isFront ? "front" : "rear"];
        const excess = (wheel.radius - contactDistance) - axle.maxcompr;
        if (excess > deepest) {
          deepest = excess;
          correctionNormal = steepTerrain ? terrainNormal : v3(0, 1, 0);
        }
      }
    }

    for (const point of scrape) {
      const world = add(state.ipos, rotate(q, sub(point, cg)));
      const normal = frame.normalAtFeet(world.x, world.z);
      const depth = (frame.heightAtFeet(world.x, world.z) - world.y) * normal.y;
      if (depth > deepest) {
        deepest = depth;
        correctionNormal = normal;
      }
    }

    if (deepest <= 0) return;

    /*
      Correct only while the truck is settling into the ground, never while it is leaving.

      Lifting is a teleport, and a teleport repeated every step is a conveyor belt: at 120 Hz a
      0.35 ft correction is 42 ft/s of free upward travel, and because the lift also cancels
      downward velocity, none of it is ever given back. A truck on its roof was carried 36 ft
      into the air by this alone, which looked exactly like a physics explosion and was in fact
      the anti-clipping fix doing its job far too eagerly.

      Gating on downward motion keeps what the correction is for (a truck that is sinking into
      terrain a step cannot catch) and removes what it was doing by accident.
    */
    if (dot(state.vel, correctionNormal) > 0.5) return;

    /*
      Leave the body resting slightly INTO its contact rather than exactly on it.

      A penalty contact has no force without penetration, and friction is a fraction of that
      force. Correcting to exactly zero depth therefore removed the load the friction was
      computed from: an upside down truck settled precisely at the contact threshold, reported
      no contacts at all, and slid 90 m without slowing. The two mechanisms were cancelling
      each other out, one lifting the truck out of the ground and the other needing it to be in.

      RESTING_DEPTH is small enough to be invisible and enough to keep the contact loaded. The
      correction only removes what is deeper than that.
    */
    const excess = deepest - RESTING_DEPTH;
    if (excess <= 0) return;

    state.ipos = add(state.ipos, scale(correctionNormal, Math.min(excess, MAX_LIFT_PER_STEP)));
    const closing = dot(state.vel, correctionNormal);
    if (closing < 0) state.vel = sub(state.vel, scale(correctionNormal, closing));
  }

  /*
    One NaN ends the drive, so it is caught at the step that made it.

    Every later frame would inherit it: the position feeds the renderer, the cameras filter it
    and keep their own copy, and the truck vanishes with no way back short of a reload. Falling
    back to the last good state costs one step of motion and nothing else.
  */
  function isFiniteState() {
    const { ipos, vel, omega, orientation } = state;
    return [ipos.x, ipos.y, ipos.z, vel.x, vel.y, vel.z, omega.x, omega.y, omega.z,
      orientation.w, orientation.x, orientation.y, orientation.z].every(Number.isFinite);
  }

  function rememberGoodState() {
    lastGood = {
      ipos: { ...state.ipos },
      vel: { ...state.vel },
      omega: { ...state.omega },
      orientation: { ...state.orientation },
    };
  }

  function restoreGoodState() {
    if (!lastGood) {
      state.ipos = v3();
      state.vel = v3();
      state.omega = v3();
      state.orientation = { w: 1, x: 0, y: 0, z: 0 };
      return;
    }
    state.ipos = { ...lastGood.ipos };
    // Stopped rather than resumed: whatever produced the bad step is not worth carrying on.
    state.vel = v3();
    state.omega = v3();
    state.orientation = { ...lastGood.orientation };
  }

  /*
    Steering, rate limited and reduced with speed.

    A truck given instant lock spins on the first tap, and MONSTER.INI's steeringResponse says
    the game rate limits it too, though not yet by how much.
  */
  function updateSteering(dt, input) {
    const wanted = clamp(input.steer ?? 0, -1, 1);
    const moving = wanted !== 0;
    const time = moving ? params.steering.lockTime : params.steering.returnTime;
    const rate = dt / Math.max(0.01, time);
    state.steerInput += clamp(wanted - state.steerInput, -rate, rate);

    const speed = Math.abs(dot(state.vel, rotate(state.orientation, v3(0, 0, -1))));
    const { speedReductionStart, speedReductionFull, minLockFraction } = params.steering;
    const t = clamp((speed - speedReductionStart) / Math.max(1, speedReductionFull - speedReductionStart), 0, 1);
    const available = 1 - t * (1 - minLockFraction);

    for (const wheel of wheels) {
      const axle = params.suspension[wheel.isFront ? "front" : "rear"];
      wheel.steerAngle = state.steerInput * axle.maxangle * available;
    }
  }

  /*
    Engine and gearbox.

    rpm follows the driven wheels through the gearing rather than being integrated on its own,
    which is the simplification every arcade racer makes: no clutch, so the engine cannot be
    stalled or bogged, and the gear shift is a timed interruption of drive.
  */
  function engineTorque(dt, input) {
    const driven = wheels.filter((w) => (w.isFront ? params.transmission.torque_pct.front : params.transmission.torque_pct.rear) > 0);
    const meanSpin = driven.length
      ? driven.reduce((sum, w) => sum + Math.abs(w.spinRate), 0) / driven.length
      : 0;

    const ratio = gearRatio() * params.transmission.final_drive;
    // Magnitude: reverse turns the wheels the other way but the engine still revs upward.
    const rpmFromWheels = meanSpin * Math.abs(ratio) * 60 / (2 * Math.PI);
    state.rpm = clamp(
      Math.max(params.engine.idleRpm, rpmFromWheels),
      params.engine.idleRpm,
      params.engine.redline
    );
    /*
      Whether the wheels are asking for more rpm than the engine has.

      The clamp above hides this: rpm reads 6500 whether the driveline wants 6500 or 9000, so
      the drive term has to know which. Without it the truck kept gaining speed while pinned
      at the limiter, drifting from 71 mph to over 85, because a reduced torque is still a
      torque. What actually caps a vehicle's speed in top gear is that past the limiter there
      is no drive at all.
    */
    state.overRev = rpmFromWheels >= params.engine.redline;

    const gearing = Math.abs(ratio) * (1 - params.transmission.pct_loss);

    // Mid-shift there is no drive, but the engine still drags on the driveline.
    if (state.shiftTimer > 0) {
      state.shiftTimer -= dt;
      return { drive: 0, brake: params.engine.friction_cf * state.rpm * gearing };
    }
    autoShift();

    const throttle = clamp(input.throttle ?? 0, 0, 1);

    /*
      Reverse has a ceiling of its own.

      Forward speed is capped by the gearing running out of revs, which is a real mechanism and
      needs no help. Reverse has the same gearbox and the same engine behind one short ratio,
      so without a limit it simply keeps pulling: holding the brake to a stop wound the truck
      up to 33 mph backwards, which no vehicle does and no player wants from the key they are
      using to stop.
    */
    let reverseLimited = false;
    if (state.gear < 0) {
      const backwards = -dot(state.vel, rotate(state.orientation, v3(0, 0, -1)));
      reverseLimited = backwards >= (params.transmission.reverse_max_speed ?? 16);
    }

    // On the limiter the engine makes no drive; the gearing is what sets top speed.
    const output = (state.overRev || reverseLimited) ? 0 : throttle * torqueAt(state.rpm);
    const friction = (1 - throttle) * params.engine.friction_cf * state.rpm;
    const direction = state.gear < 0 ? -1 : 1;

    /*
      Returned as two separate quantities on purpose. `drive` is signed by the selected gear
      and turns the wheels; `brake` is a magnitude that the wheel loop applies against
      whichever way the wheel happens to be turning. See the note there.
    */
    return {
      drive: output * gearing * direction,
      brake: friction * gearing,
    };
  }

  function gearRatio() {
    if (state.gear < 0) return -params.transmission.reverse_ratio;
    const gears = params.transmission.gear_ratio;
    return gears[Math.min(gears.length - 1, Math.max(0, state.gear - 1))];
  }

  /*
    Reverse, engaged by holding the brake once the truck has stopped.

    This is the arcade convention and the one MTM2 uses: there is no separate reverse control,
    the down arrow brakes while you are moving and backs up once you are not. The pedals swap
    while reversing, so the same key that got you into reverse drives you backwards and the
    throttle becomes the brake, which is what makes rocking off an obstacle work without the
    driver thinking about gears at all.

    The speed threshold is what keeps a truck being braked hard from snapping into reverse the
    instant it stops and driving away backwards under the same key press; it has to actually
    be stationary, and the driver has to still be asking.
  */
  function resolveReverse(dt, input) {
    const throttle = clamp(input.throttle ?? 0, 0, 1);
    const brake = clamp(input.brake ?? 0, 0, 1);
    const forwardSpeed = dot(state.vel, rotate(state.orientation, v3(0, 0, -1)));
    const stopped = Math.abs(forwardSpeed) < REVERSE_ENGAGE_SPEED;

    if (state.gear > 0 && stopped && brake > 0.5) {
      state.gear = -1;
      state.shiftTimer = params.transmission.shiftTime;
    } else if (state.gear < 0 && stopped && throttle > 0.5) {
      state.gear = 1;
      state.shiftTimer = params.transmission.shiftTime;
    }

    // In reverse the two pedals trade places.
    return state.gear < 0
      ? { throttle: brake, brake: throttle }
      : { throttle, brake };
  }

  function autoShift() {
    // Reverse is a gear the driver selects, not one the gearbox shifts out of.
    if (state.gear < 0) return;
    const gears = params.transmission.gear_ratio;
    if (state.gear > 0 && state.rpm >= params.transmission.upshift_rpm && state.gear < gears.length) {
      state.gear++;
      state.shiftTimer = params.transmission.shiftTime;
    } else if (state.gear > 1 && state.rpm <= params.transmission.dnshift_rpm) {
      state.gear--;
      state.shiftTimer = params.transmission.shiftTime;
    }
  }

  function torqueAt(rpm) {
    const table = params.engine.torqueTable;
    if (rpm <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
      const [x1, y1] = table[i];
      if (rpm <= x1) {
        const [x0, y0] = table[i - 1];
        return y0 + (y1 - y0) * (rpm - x0) / Math.max(1, x1 - x0);
      }
    }
    return table[table.length - 1][1];
  }

  /** The engine's own reported state, in its own names. */
  function readState() {
    const { theta, phi, psi: yaw } = eulerOf(state.orientation);
    // Reported back in the track's convention, the inverse of the mapping reset() applies, so
    // that a heading handed to the cameras or compared against a save-state means the same
    // thing the .SIT means by it.
    const psi = -yaw;
    return {
      // Back to the body origin, which is what ipos means everywhere outside this file.
      ipos: sub(state.ipos, rotate(state.orientation, cg)),
      bvel: inverseRotate(state.orientation, state.vel),
      theta, phi, psi,
      /*
        Body rates about THIS sim's axes: x lateral, y up, z longitudinal. So omega.x is the
        pitch rate, omega.y the yaw rate and omega.z the roll rate.

        MTM2 reports p, q and r in a flight frame, where x runs forward, so its p is roll and
        its r is yaw. The two are not interchangeable, and the mapping belongs in the
        telemetry comparison rather than here, where quietly relabelling them would make a
        captured trace appear to disagree with a sim that is actually right.
      */
      pitchRate: state.omega.x,
      yawRate: state.omega.y,
      rollRate: state.omega.z,
      gear: state.gear,
      rpm: state.rpm,
      airborne: state.airborne,
      // Seconds upside down. Drive mode puts the truck back on the course once this passes 2.5.
      invertedFor: state.invertedFor,
      speed: length(state.vel),
      wheels: wheels.map((w) => ({
        key: w.key,
        on_gnd: w.onGround,
        compression: w.compression,
        steering_angle: w.steerAngle,
        spinAngle: w.spinAngle,
      })),
    };
  }

  return {
    state,
    wheels,
    mass,
    inertia,
    reset,
    step,
    readState,
    get orientation() { return state.orientation; },
    /** Arrays in wheel order, for the renderer. */
    wheelCompression: () => wheels.map((w) => w.compression),
    wheelSteer: () => wheels.map((w) => w.steerAngle),
    wheelSpin: () => wheels.map((w) => w.spinAngle),
  };
}

function keyOf(wheel) {
  return wheel.key.replace(".static_bpos", "");
}

/*
  Rotational inertia from the body's own measured bounds, as a uniform box.

  Scaling with the truck rather than hard-coding means a short wheelbase truck turns more
  readily than a long one without anybody authoring a number for it.
*/
function inertiaFor(assembly, params, mass) {
  if (!params.chassis.inertiaFromBodyBox || !assembly.body?.vertices?.length) {
    const f = params.chassis.inertiaFallback;
    // Body axis order: pitch about x, yaw about y, roll about z. See the note below.
    return v3(f.pitch, f.yaw, f.roll);
  }
  const vs = assembly.body.vertices;
  const span = (axis) => {
    let min = Infinity;
    let max = -Infinity;
    for (const v of vs) {
      if (v[axis] < min) min = v[axis];
      if (v[axis] > max) max = v[axis];
    }
    return max - min;
  };
  // The decoder's axes: x lateral, y longitudinal, z vertical. BIGFOOT measures 7.34 wide,
  // 18.40 long and 8.39 tall this way.
  const width = span("x");
  const len = span("y");
  const height = span("z");

  /*
    Returned in BODY axis order, which is not the same as roll/pitch/yaw order.

    This sim's body axes are x lateral, y up and z longitudinal (the truck faces -z), so
    turning about x pitches the truck, about y yaws it and about z rolls it. Naming the three
    moments roll, pitch and yaw and then storing them as x, y, z is the mistake this comment
    exists to prevent: it would give a truck its yaw inertia about the roll axis, making it
    flop over sideways far too easily and refuse to turn.
  */
  return v3(
    mass * (len * len + height * height) / 12,     // about x: pitch
    mass * (len * len + width * width) / 12,       // about y: yaw
    mass * (width * width + height * height) / 12  // about z: roll
  );
}

function clamp(value, low, high) {
  return value < low ? low : (value > high ? high : value);
}

/*
  A tire curve without the cost of a real one: linear to the peak, then saturating.

  Force rises in proportion to slip up to where the tread starts sliding, and past that it
  falls away slowly rather than holding. tanh gives that shape in one call and is smooth, so
  the integrator never sees a corner in the force.
*/
function saturate(slip, peak) {
  return Math.tanh(slip / Math.max(1e-3, peak));
}
