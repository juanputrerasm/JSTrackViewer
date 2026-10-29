/*
  CART Precision Racing's car model (OpenMTM2 docs/CPR_PHYSICS.md), shaped like `sim/evo`: MTM2's tire geometry,
  probes, hull contacts, Euler integration and post-step, with CPR's own forces: the car's weight and inertia, a six
  speed box on overall ratios, springs and four-way dampers from the setup, load-sensitive grip by compound, weather and
  surface, slip-based tire forces on the game's force curve with a friction circle, camber, brakes by the proportioning,
  and drag and downforce from the wings; and the driving aids the car carries (14.3: ABS, traction control, the Skill
  Level's grip).

  Built from the documented facts where there are some, the port's where there are none, and said so:
  - the torque curve (rules.ts `CPR_TORQUE`): the game's mixture and boost composition is not traced, so no boost, pop-off
    valve or fuel use;
  - the wing coefficients (`cprAero`): the game's per-type slopes are not traced;
  - the slip stiffnesses: the slips are scaled so the force curve peaks at 6 degrees of slip angle and 12% slip ratio;
  - the anti-roll bars and third springs are not applied; the four tires share MTM2's solid-axle post-step;
  - drafting needs the car ahead (`cprDraft` is there; the step takes a factor, 1 by default).
*/
import { G, GEAR, MPH_10 } from "../mtm2/constants.js";
import { eulerToMatrix, wrapPi } from "../mtm2/math.js";
import { surfaceType } from "../mtm2/world/surface.js";
import { holdRule, integrateOrientation, probeContacts, tireFrame, tireGeometry } from "../mtm2/truck/dynamics.js";
import { solveHullContacts } from "../mtm2/truck/contacts.js";
import { helicopterStep, updateStuck } from "../mtm2/truck/recovery.js";
import { createTruckState } from "../mtm2/truck/state.js";
import { DAMPER_FACTOR } from "../mtm2/constants.js";
import { cloneCprSetup } from "../../cpr/garage.js";
import { CPR_AIR_DENSITY, CPR_CAR, cprCompoundGrip, cprDamperForce, cprEngineTorque, cprForceFactor, cprMu, cprSurfaceGrip, } from "./rules.js";
const RPM_PER_RAD_S = 9.5493;
/** Slip angle and slip ratio at the force curve's peak (2.75): the port's stiffnesses. */
const PEAK_ANGLE = 0.105, PEAK_RATIO = 0.12, CURVE_PEAK = 2.75;
/** Below this ground speed the slips read it as this (CPR_PHYSICS.md 6.3). */
const MIN_SPEED_RATIO = 10, MIN_SPEED_ANGLE = 20;
/** The engine's speed with the clutch slipping at a standstill, and how fast it follows, the port's. */
const CLUTCH_RPM = 4000, IDLE_RPM = 2500;
/** The downshift rpm: the port's (the game's +0x800 is not traced). */
const DOWNSHIFT_RPM = 9500;
/** The car's figures: the constructor's, its anchors and hull points, and a setup (the stock one when none). */
export function cprSpec(anchors, scrapePoints, setup = null) {
    const s = setup ?? cloneCprSetup();
    return {
        setup: s,
        weightLb: CPR_CAR.dryWeightLb + Math.max(0, s.fuelAmount) * CPR_CAR.fuelLbPerGallon,
        inertia: [CPR_CAR.inertia[0], CPR_CAR.inertia[1], CPR_CAR.inertia[2]],
        wheelAnchors: anchors.map((a) => [a[0], a[1], a[2]]),
        scrapePoints: scrapePoints.map((p) => [p[0], p[1], p[2]]),
    };
}
/** ABS holds a braked wheel at no less than 80% of its rolling speed above 10 ft/s (0x5b2500, 0x5b24f0). */
export const CPR_ABS_SLIP = 0.2, CPR_ABS_MIN_SPEED = 10;
/** Traction control: past 15% rear slip the rev limit falls to the rear wheels' rpm at 15% slip (0x5b20f8, 0x5b2108). */
export const CPR_TC_SLIP = 0.15;
export function createCprParams(spec, tire = {}, setup = {}) {
    const s = spec.setup;
    const hubs = spec.wheelAnchors.map((a) => [a[0], a[1], a[2]]);
    const W = spec.weightLb;
    const wheelRate = [0, 1, 2, 3].map((i) => s.springRate[cornerOf(i)] * s.installationRatio[cornerOf(i)]);
    const spring = [(wheelRate[0] + wheelRate[1]) / 2, (wheelRate[2] + wheelRate[3]) / 2];
    // The weight sits 45% on the front (the port's: the CG is not traced), the CG at the floor.
    const frontZ = hubs[0][2], rearZ = hubs[2][2];
    const cgZ = rearZ + (frontZ - rearZ) * 0.45;
    return {
        bodyWeightLb: W, axleWeightLb: 0, weightLb: W, massSlug: W / G,
        inertia: [spec.inertia[0], spec.inertia[1], spec.inertia[2]],
        cgOffset: [0, 0.5, cgZ],
        tireRadiusFt: tire.radiusFt && tire.radiusFt > 0 ? tire.radiusFt : 1.1,
        tireWidthFt: tire.widthFt && tire.widthFt > 0 ? tire.widthFt : 1.2,
        hubs, drawHubs: hubs.map((h) => [h[0], h[1], h[2]]),
        frontAxleZ: frontZ, rearAxleZ: rearZ,
        scrapePoints: spec.scrapePoints.map((p) => [p[0], p[1], p[2]]),
        sagFt: spring[0] > 0 ? (W * 0.45 * 0.5) / spring[0] : 0,
        spring, damper: [Math.sqrt(spring[0]) * DAMPER_FACTOR / 3, Math.sqrt(spring[1]) * DAMPER_FACTOR / 3],
        transferRatio: 1, tireCut: 0, gripK: 1, torqueGain: 1,
        cpu: setup.cpu ?? false, autoShift: setup.autoShift ?? true, difficulty: setup.difficulty ?? 1,
        // A racing car's suspension: a few inches of travel, next to no articulation.
        bumpTravelFt: [0.35, 0.35], articulationLimit: [0.06, 0.06],
        springArmFt: Math.abs(hubs[0][0]) || 2.8,
        aeroArea: [CPR_CAR.sideAreaFt2, 40, CPR_CAR.refAreaFt2],
        cpr: {
            spec, wheelRate, gears: s.gearRatio.map((g) => g * s.finalDriveRatio),
            aids: {
                abs: setup.aids?.abs ?? !!setup.cpu, tractionControl: setup.aids?.tractionControl ?? false,
                gripScale: setup.aids?.gripScale ?? 1, offroadGrip: setup.aids?.offroadGrip ?? null,
            },
        },
    };
}
/** The setup's corner (FL, FR, RL, RR) of a simulation tire (FR, FL, RR, RL). */
const cornerOf = (i) => [1, 0, 3, 2][i];
export function createCprTruckState(pos, heading, gear, p) {
    const s = createTruckState(pos, heading, gear, p);
    s.cpr = { slipRatio: [0, 0, 0, 0], combinedSlip: [0, 0, 0, 0], temperature: [0, 0, 0, 0], drag: 0, downforce: 0, draft: 1 };
    return s;
}
/** The overall ratio of an MTM2 gear number (1 Park, 2 Reverse, 3 Neutral, 4 first...): six forward gears, reverse the game's -20. */
export function cprGearRatio(p, gear) {
    if (gear === GEAR.REVERSE)
        return -20 * p.cpr.spec.setup.finalDriveRatio;
    return gear >= GEAR.FIRST ? p.cpr.gears[gear - GEAR.FIRST] ?? 0 : 0;
}
/**
 * Drag and downforce coefficients from the wings (CPR_PHYSICS.md 7: a body term plus each wing's angle x 0.05 x its slope,
 * plus the Gurney flaps), and the front axle's share of the downforce. The slopes and body terms are the port's, set for
 * about 3,000 lb of downforce and 225 mph flat out with the stock setup.
 */
export function cprAero(setup) {
    const slope = (type) => 0.6 + 0.15 * Math.max(0, Math.min(4, type));
    const [fa, ra] = setup.wingAngle, [ft, rt] = setup.wingType, [fg, rg] = setup.gurneyFlapSize;
    const front = 0.25 + fa * 0.05 * slope(ft) + fg * 0.2, rear = 0.3 + ra * 0.05 * slope(rt) + rg * 0.2;
    const cl = front + rear;
    const cd = 0.3 + (fa * slope(ft) + ra * slope(rt)) * 0.012 + (fg + rg) * 0.05;
    return { cd, cl, frontShare: front / cl };
}
const toWorld = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
const toBody = (m, x, y, z) => [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** The automatic box (CPR_PHYSICS.md 5): up above the upshift rpm, down below the downshift rpm. Manual: one gear a request. */
function stepGearbox(s, p) {
    const c = s.controls;
    const top = GEAR.FIRST + p.cpr.gears.length - 1;
    if (p.autoShift) {
        if (c.gear >= GEAR.FIRST && c.gear < top && s.rpm >= CPR_CAR.upshiftRpm)
            c.gear++;
        else if (c.gear > GEAR.FIRST && s.rpm < DOWNSHIFT_RPM) {
            // Down only where the lower gear stays under the limit.
            const lower = cprGearRatio(p, c.gear - 1), now = cprGearRatio(p, c.gear);
            if (now > 0 && (s.rpm * lower) / now < CPR_CAR.upshiftRpm - 500)
                c.gear--;
        }
    }
    else {
        if (c.shiftRequest > 0 && c.gear < top)
            c.gear++;
        if (c.shiftRequest < 0 && c.gear > GEAR.PARK)
            c.gear--;
    }
    c.shiftRequest = 0;
    if (c.gear === GEAR.PARK) {
        c.brakeFront = 1;
        c.brakeRear = 1;
    }
}
/** Advance one car by `dt`. The controls must already be set; collisions and the post-step come after, as MTM2's. */
export function stepCprTruck(s, p, ctx, dt) {
    if (s.heliTimer > 0) {
        helicopterStep(s, ctx.ground, dt);
        s.splash = false;
        return { force: [0, 0, 0], moment: [0, 0, 0], count: 0 };
    }
    const setup = p.cpr.spec.setup;
    const aids = p.cpr.aids ?? { abs: false, tractionControl: false, gripScale: 1, offroadGrip: null };
    const e = s.cpr;
    const m = s.matrix;
    eulerToMatrix(s.euler[0], s.euler[1], s.euler[2], m);
    s.prevMatrix.set(m);
    const c = s.controls;
    c.rearSteer = 0;
    // The steering lock of the setup.
    c.steer = Math.max(-setup.steeringLock, Math.min(setup.steeringLock, c.steer));
    for (let i = 0; i < 4; i++)
        tireGeometry(s, p, i);
    stepGearbox(s, p);
    const W = p.weightLb;
    const mass = W / G;
    const speed = Math.hypot(s.bvel[0], s.bvel[1], s.bvel[2]);
    const force = [-W * m[3], -W * m[4], -W * m[5]];
    s.splash = false;
    // Aerodynamics (CPR_PHYSICS.md 7): drag and downforce on the forward speed, the side force on the lateral, each by the draft.
    const aero = cprAero(setup);
    const vz = s.bvel[2], vx = s.bvel[0];
    const q = 0.5 * CPR_AIR_DENSITY * vz * vz * CPR_CAR.refAreaFt2 * e.draft;
    const drag = -Math.sign(vz) * q * aero.cd;
    const downforce = q * aero.cl;
    let side = -Math.sign(vx) * 0.5 * CPR_AIR_DENSITY * vx * vx * CPR_CAR.sideAreaFt2 * e.draft;
    const sideCap = 0.8 * Math.abs(vx) * mass / dt;
    if (Math.abs(side) > sideCap)
        side = Math.sign(side) * sideCap;
    force[0] += side;
    force[1] -= downforce;
    force[2] += drag;
    e.drag = -drag;
    e.downforce = downforce;
    const moment = [0, 0, 0];
    // The downforce loads each axle by its share: as forces at the axles, about the CG.
    const cg = p.cgOffset;
    const fDown = downforce * aero.frontShare, rDown = downforce - fDown;
    // As an upward force fy at z gives -fy (z - cg z) about x (the tires' sum below), a downward one gives +.
    moment[0] += fDown * (p.frontAxleZ - cg[2]) + rDown * (p.rearAxleZ - cg[2]);
    // Each tire's load: its spring at the wheel and its damper (6.1), then grip (6.2).
    const rain = (ctx.ground.weather ?? 0) === 4;
    const grip = [0, 0, 0, 0], mu = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
        const t = s.tires[i];
        const k = cornerOf(i);
        const extending = t.extensionRate > 0;
        const damper = cprDamperForce(t.extensionRate, extending ? setup.dampingSlowRebound[k] : setup.dampingSlowBump[k], extending ? setup.dampingFastRebound[k] : setup.dampingFastBump[k]);
        t.load = p.cpr.wheelRate[i] * t.compression;
        if (t.onGround) {
            const nLoad = Math.max(1, t.load - damper * setup.installationRatio[k]) * (t.normal[0] * m[1] + t.normal[1] * m[4] + t.normal[2] * m[7]);
            const w = toWorld(m, t.hub[0], t.hub[1], t.hub[2]);
            t.surface = ctx.ground.surface(s.pos[0] + w[0], s.pos[1] + w[1] + 100, s.pos[2] + w[2]);
            const type = surfaceType(t.surface);
            const offroad = aids.offroadGrip !== null && (type === 2 || type === 6 || type === 7 || type === 12);
            mu[i] = cprMu(nLoad, i < 2) * cprCompoundGrip(setup.tireCompound[k], rain) * (offroad ? aids.offroadGrip : cprSurfaceGrip(type)) * aids.gripScale;
            t.mu = mu[i];
            grip[i] = Math.max(0, mu[i] * nLoad);
            t.grip = grip[i];
        }
        else {
            t.grip = 0;
            t.surface = -1;
        }
        t.lateral = 0;
        t.load = Math.max(0, t.load - damper);
    }
    // The engine and the rear wheels (4, 5): the rpm from the rear wheels' speed through the gear, a slipping clutch at a crawl.
    const ratio = cprGearRatio(p, c.gear);
    const r = p.tireRadiusFt;
    const rearSpeed = ((s.tires[2].spin + s.tires[3].spin) / 2) * r;
    let rpm = Math.abs((rearSpeed / r) * ratio * RPM_PER_RAD_S);
    if (ratio !== 0 && rpm < CLUTCH_RPM && c.throttle > 0.05)
        rpm = CLUTCH_RPM;
    if (ratio === 0)
        rpm = IDLE_RPM + c.throttle * (CPR_CAR.revLimit - IDLE_RPM);
    if (rpm < IDLE_RPM)
        rpm = IDLE_RPM;
    s.rpm = Math.min(rpm, CPR_CAR.revLimit + 100);
    const limiter = s.rpm >= CPR_CAR.revLimit;
    // The throttle's torque drives; the engine's friction only ever holds the wheels back, fading out at a crawl (the
    // port's: shut, a car in gear must not creep).
    const net = limiter || ratio === 0 ? 0 : cprEngineTorque(s.rpm, 1) * c.throttle;
    const friction = -cprEngineTorque(s.rpm, 0) * (1 - c.throttle);
    const rolling = s.bvel[2];
    const holdBack = ratio === 0 ? 0 : -Math.sign(rolling) * friction * Math.abs(ratio) * Math.min(1, Math.abs(rolling) / 10);
    // At the rear wheels, shared by the differential: open and locked half each; limited slip by the wheels' speeds, 0.3..0.7.
    const wheelTorque = net * ratio + holdBack;
    let leftShare = 0.5;
    if (setup.differentialType === 1) {
        const a = Math.abs(s.tires[3].spin), b = Math.abs(s.tires[2].spin);
        leftShare = a + b > 0.1 ? Math.max(0.3, Math.min(0.7, b / (a + b))) : 0.5;
    }
    const frames = [null, null, null, null];
    const groundF = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const totalGrip = grip.reduce((a, g) => a + g, 0);
    // The brakes: the proportioning's share to the front, a full brake able to lock every tire.
    const brakeShare = [setup.brakeProportioning, setup.brakeProportioning, 1 - setup.brakeProportioning, 1 - setup.brakeProportioning];
    for (let i = 0; i < 4; i++) {
        const t = s.tires[i];
        const front = i < 2;
        if (!t.onGround) {
            // In the air a rear wheel runs up with the engine, a front one coasts.
            if (!front && ratio !== 0)
                t.spin += ((wheelTorque * (i === 3 ? leftShare : 1 - leftShare)) / 20) * dt;
            t.spin *= 0.995;
            t.angle = wrapPi(t.angle + t.spin * dt);
            continue;
        }
        const f = tireFrame(s, t, front ? c.steer : 0);
        frames[i] = f;
        const k = cornerOf(i);
        const camber = Math.cos(Math.abs(setup.camber[k]) + 0.0698) ** 5 / Math.cos(0.0698) ** 5;
        // Lateral: the slip angle, normalised so the curve peaks at PEAK_ANGLE.
        const vLong = Math.max(Math.abs(f.vFwd), MIN_SPEED_ANGLE);
        const alpha = Math.atan2(f.vLat, vLong);
        const latSlip = (alpha / PEAK_ANGLE) * CURVE_PEAK;
        // Longitudinal: what the engine and brakes ask of the tire, as a slip ratio on the same curve.
        const brakeCap = 2.2 * W * brakeShare[i] * 0.5;
        let brake = (front ? c.brakeFront : c.brakeRear) * brakeCap;
        brake = f.vFwd > 0 ? -brake : brake;
        // Traction control: in a forward gear the rear wheels' drive no more than turns them 15% past the ground (the game
        // lowers the rev limit to that and its governor cuts the torque; the port limits the drive at the tire).
        let drive = front ? 0 : (wheelTorque * (i === 3 ? leftShare : 1 - leftShare)) / r;
        if (aids.tractionControl && !front && ratio > 0 && drive > 0)
            drive = Math.min(drive, grip[i] * (CPR_TC_SLIP / PEAK_RATIO));
        let want = drive + brake;
        const capacity = grip[i];
        // ABS: the brake no harder than holds the wheel at 80% of its rolling speed.
        if (aids.abs && brake !== 0 && Math.abs(f.vFwd) > CPR_ABS_MIN_SPEED) {
            const limit = capacity * (CPR_ABS_SLIP / PEAK_RATIO);
            if (want * Math.sign(brake) > limit)
                want = Math.sign(brake) * limit;
        }
        // The demand as a share of the capacity, on the curve's scale: at the capacity it reaches the peak.
        const longSlip = capacity > 0 ? (want / capacity) * CURVE_PEAK : 0;
        const combined = Math.hypot(latSlip, longSlip);
        const factor = cprForceFactor(combined);
        const share = combined > 0 ? factor / combined : 0;
        // The friction circle: both forces on the curve in proportion to their slips.
        let Fx = Math.abs(longSlip) <= CURVE_PEAK && combined <= CURVE_PEAK ? want : longSlip * share * capacity;
        let Fy = -latSlip * share * capacity * camber;
        // Slow, the tire holds the car where it stands (MTM2's static hold, §5.2).
        if (speed < MPH_10) {
            const sh = totalGrip !== 0 ? grip[i] / totalGrip : 1;
            const tF = toWorld(m, f.nb[0], -f.nb[2], f.nb[1]);
            Fx = holdRule(Fx, tF[1] * W * sh, -(f.vFwd / dt) * mass * sh);
            const tL = toWorld(m, f.nb[1], -f.nb[0], f.nb[2]);
            Fy = holdRule(Math.max(-capacity, Math.min(capacity, Fy)), tL[1] * W * sh, -(f.vLat / dt) * mass * sh);
        }
        groundF[i] = [f.sd * Fx + Fy * f.cd, 0, f.cd * Fx - Fy * f.sd];
        // The wheel: rolling, plus what the slip ratio says it turns past the ground.
        const ratioSlip = Math.max(-1, Math.min(2, (longSlip / CURVE_PEAK) * PEAK_RATIO));
        e.slipRatio[i] = ratioSlip;
        e.combinedSlip[i] = combined;
        t.spin = (f.vFwd / r) * (1 + ratioSlip * (Math.abs(f.vFwd) > MIN_SPEED_RATIO ? 1 : 0));
        t.angle = wrapPi(t.angle + t.spin * dt);
        t.lateral = factor;
        // Temperature (6.3): up with the slip, down with the speed.
        e.temperature[i] = Math.max(0, Math.min(400, e.temperature[i] + combined * 30 * dt - Math.max(50, speed) * 0.225 * dt));
    }
    // Tire forces into body axes, as MTM2's.
    const tireSum = [0, 0, 0];
    for (let i = 0; i < 4; i++) {
        const t = s.tires[i];
        const [fx, , fz] = groundF[i];
        const fb = [Math.cos(t.rollG) * fx, Math.sin(t.rollG) * fx + Math.sin(t.pitchG) * fz, Math.cos(t.pitchG) * fz];
        const n = t.normal;
        const lw = toWorld(m, 0, t.load * n[1], 0);
        const s1 = dot(n, lw);
        const nb = toBody(m, n[0] * s1, n[1] * s1, n[2] * s1);
        t.force[0] = fb[0] + nb[0];
        t.force[1] = fb[1] + nb[1];
        t.force[2] = fb[2] + nb[2];
        for (let k = 0; k < 3; k++)
            tireSum[k] += t.force[k];
    }
    // Aerodynamic damping (7, 0x4707e0): the player's factors on the rates (which rate is which axis is a hypothesis there).
    const qbar = Math.max(26.74, speed * speed * 0.0011885);
    moment[0] += -0.05 * s.rates[1] * qbar * 10;
    moment[1] += -0.05 * s.rates[2] * qbar * 10;
    moment[2] += -0.0025 * s.rates[0] * qbar * 10;
    const contacts = solveHullContacts(s, p.inertia, ctx.ground, force, mass, W, dt);
    for (let k = 0; k < 3; k++)
        force[k] += contacts.force[k] + tireSum[k] + s.extForce[k];
    const fMag = Math.hypot(force[0], force[1], force[2]);
    if (fMag > 500000) {
        const sc = 500000 / fMag;
        for (let k = 0; k < 3; k++)
            force[k] *= sc;
    }
    for (let k = 0; k < 3; k++)
        moment[k] += contacts.moment[k] + s.extMoment[k];
    s.extForce.fill(0);
    s.extMoment.fill(0);
    for (let i = 0; i < 4; i++) {
        const t = s.tires[i];
        const [fx, fy, fz] = t.force;
        const [hx, hy, hz] = t.hub;
        const travel = s.axles[i < 2 ? 0 : 1].travel;
        moment[0] += (hy - cg[1]) * fz - fy * (hz - cg[2]);
        moment[1] += fx * (hz - cg[2]) - fz * (hx - cg[0]);
        moment[2] += fy * (hx - cg[0]) - fx * (travel - cg[1]);
    }
    moment[0] += s.impulseMoment / dt;
    s.impulseMoment = 0;
    // Euler's equations, each angular acceleration held to 13 rad/s² (10, 0x4654c0), and explicit Euler (8).
    const [I1, I2, I3] = p.inertia;
    const [pRoll, qPitch, rYaw] = s.rates;
    const clamp13 = (v) => (v > 13 ? 13 : v < -13 ? -13 : v);
    const qDot = clamp13(((I3 - I1) / I2) * rYaw * pRoll + moment[0] / I2);
    const pDot = clamp13(((I2 - I3) / I1) * rYaw * qPitch + moment[2] / I1);
    const rDot = clamp13(((I1 - I2) / I3) * qPitch * pRoll + moment[1] / I3);
    const [bx, by, bz] = s.bvel;
    const ax = pRoll * by - rYaw * bz + force[0] / mass;
    const ay = qPitch * bz - pRoll * bx + force[1] / mass;
    const az = rYaw * bx - qPitch * by + force[2] / mass;
    s.rates[0] += pDot * dt;
    s.rates[1] += qDot * dt;
    s.rates[2] += rDot * dt;
    s.bvel[0] += ax * dt;
    s.bvel[1] += ay * dt;
    s.bvel[2] += az * dt;
    s.ap.accel = az;
    let ivel = toWorld(m, s.bvel[0], s.bvel[1], s.bvel[2]);
    const iv = Math.hypot(ivel[0], ivel[1], ivel[2]);
    s.prevPos.set(s.pos);
    const atRest = (iv < 0.1 && c.throttle < 0.05) || (iv < 0.5 && contacts.count >= 3);
    if (atRest) {
        s.bvel.fill(0);
        s.rates.fill(0);
        ivel = [0, 0, 0];
    }
    if (ctx.recovery)
        updateStuck(s, p, ctx.ground, ctx.recovery, iv, contacts.count, atRest, dt);
    for (let k = 0; k < 3; k++)
        s.pos[k] += ivel[k] * dt;
    integrateOrientation(s, dt);
    for (let i = 0; i < 4; i++)
        tireGeometry(s, p, i);
    probeContacts(s, p, ctx.ground);
    return contacts;
}
/** The forward gear (1 = first) the gauges show, or 0 in Park, Reverse and Neutral. */
export const cprForwardGear = (gear) => (gear >= GEAR.FIRST ? gear - GEAR.FIRST + 1 : 0);
