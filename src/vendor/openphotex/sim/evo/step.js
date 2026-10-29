/*
  One vehicle step under the 4x4 Evolution model (OpenMTM2 docs/EVO2_PHYSICS.md §3-§9).

  Evo's step descends from MTM2's: the same tire geometry, probes, hull contacts, sums, Euler
  integration and post-step, which this module reuses from `sim/mtm2`. What differs is here: the
  grip setup (§3.1), gravity (§4), drag with the vehicle's own areas and coefficients (§8), the
  tires' grip with the tread table (§5.1), the driveline and wheelspin (§5.3, §6) and the hull
  friction (§7). Not reproduced: Evo's catch-up for computer vehicles (the port's autopilot has its
  own), the misfire and the crash timer (not traced), independent suspension (the solid-axle
  post-step serves every vehicle).
*/
import { G, GEAR, MPH_10 } from "../mtm2/constants.js";
import { eulerToMatrix, wrapPi } from "../mtm2/math.js";
import { groundWeatherGrip } from "../mtm2/world/ground.js";
import { surfaceType } from "../mtm2/world/surface.js";
import { holdRule, integrateOrientation, lateralCoefficient, probeContacts, tireFrame, tireGeometry, } from "../mtm2/truck/dynamics.js";
import { solveHullContacts } from "../mtm2/truck/contacts.js";
import { fluidAreas } from "../mtm2/truck/water-drag.js";
import { helicopterStep, updateStuck } from "../mtm2/truck/recovery.js";
import { createTruckState } from "../mtm2/truck/state.js";
import { evoCentreSplit, evoDifferential, evoDriveInertia, evoGearRatio, evoStepSlip, evoTorqueAt, stepEvoGearbox, } from "./driveline.js";
import { evoSurfaceMu, evoTreadFactor } from "./rules.js";
/** A vehicle at `pos` facing `heading`, in `gear`, with its Evo state. */
export function createEvoTruckState(pos, heading, gear, p) {
    const s = createTruckState(pos, heading, gear, p);
    const spec = p.evo.spec;
    s.evo = {
        slip: [0, 0, 0, 0],
        splitOffset: [0, 0],
        split: [spec.torquePct[0], spec.torquePct[1]],
        shares: [[0.5, 0.5], [0.5, 0.5]],
        neutralRpm: 0,
        torque: 0,
        // The reader starts in 4WD High when the vehicle has four-wheel drive (0x5ed4b0).
        transfer: spec.driveType !== 0 ? 1 : 0,
        handbrake: false,
        finalRatio: spec.finalDrive * spec.axleRatio,
    };
    return s;
}
const TWO_PI = Math.PI * 2;
const toWorld = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
const toBody = (m, x, y, z) => [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** The grip setup (§3.1): each tire's CF this step, FR, FL, RR, RL. */
export function evoTireCF(s, p) {
    const { spec, rules, tireCFModifier, brakeBalance } = p.evo;
    const base = spec.tireCF;
    const cf = base.map((v) => v * tireCFModifier);
    const c = s.controls;
    const steer = c.steer;
    if (steer < -0.0025 || steer > 0.0025) {
        if (rules.steerRearGripCut && s.bvel[2] * 0.681818 > 20) {
            const yaw = s.rates[2];
            if ((yaw > 0.35 && steer > 0) || (yaw < -0.35 && steer < 0)) {
                const k = Math.max(0, (0.45 - Math.abs(steer)) / 0.45);
                cf[2] = base[2] * k;
                cf[3] = base[3] * k;
            }
            else {
                cf[2] = base[2];
                cf[3] = base[3];
            }
        }
    }
    else {
        cf[0] = cf[2];
        cf[1] = cf[3];
    }
    if (c.brakeFront > 0.35) {
        if (brakeBalance < 0.5) {
            const k = 1 - brakeBalance / 0.5;
            cf[0] = base[0] - k * base[0] * c.brakeFront;
            cf[1] = base[1] - k * base[1] * c.brakeFront;
        }
        else if (brakeBalance > 0.5) {
            const k = (brakeBalance - 0.5) * 2;
            cf[2] = base[2] - k * base[2] * c.brakeRear;
            cf[3] = base[3] - k * base[3] * c.brakeRear;
        }
    }
    if (s.evo.handbrake) {
        cf[2] = base[2] * 0.1;
        cf[3] = base[3] * 0.1;
    }
    return cf;
}
/** Advance one vehicle by `dt`. The controls must already be set; collisions and the post-step come after. */
export function stepEvoTruck(s, p, ctx, dt) {
    if (s.heliTimer > 0) {
        helicopterStep(s, ctx.ground, dt);
        s.splash = false;
        return { force: [0, 0, 0], moment: [0, 0, 0], count: 0 };
    }
    const { spec, rules } = p.evo;
    const e = s.evo;
    const m = s.matrix;
    eulerToMatrix(s.euler[0], s.euler[1], s.euler[2], m);
    s.prevMatrix.set(m);
    const c = s.controls;
    if (!spec.rearSteer)
        c.rearSteer = 0;
    for (let i = 0; i < 4; i++)
        tireGeometry(s, p, i);
    // Grip setup, effective final ratio, gearbox (§3).
    if (e.handbrake)
        c.brakeRear = 1;
    const cf = evoTireCF(s, p);
    e.finalRatio = spec.finalDrive * spec.axleRatio * (e.transfer === 2 ? spec.xfrLowRatio : 1);
    const fr = e.finalRatio;
    const r = p.tireRadiusFt;
    stepEvoGearbox(c, spec, s.rpm, s.bvel[2], fr, r, p.autoShift);
    // Gravity (§4): Evo 2 pulls a vehicle with every tire off the ground at 1.75 g.
    const W = p.weightLb;
    const airborne = s.tires.every((t) => !t.onGround);
    const mass = W / (airborne ? rules.airborneG : G);
    const speed = Math.hypot(s.bvel[0], s.bvel[1], s.bvel[2]);
    const force = [-W * m[3], -W * m[4], -W * m[5]];
    // Drag (§8.1): the areas wetted and dry, the vehicle's own coefficients facing x, y, z.
    const drag = [0, 0, 0];
    const fluid = fluidAreas(s, p, ctx.ground);
    s.splash = fluid.splash;
    const coef = [spec.cy, spec.cl, spec.cd];
    for (let k = 0; k < 3; k++) {
        const v = s.bvel[k];
        drag[k] = -fluid.rhoA[k] * (v * Math.abs(v) * coef[k] * 0.5);
        force[k] += drag[k];
    }
    // Spring load and grip (§5.1).
    const weather = groundWeatherGrip(ctx.ground);
    const gripCoef = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
        const t = s.tires[i];
        const axleIdx = i < 2 ? 0 : 1;
        t.load = p.spring[axleIdx] * t.compression;
        if (t.onGround) {
            const nLoad = t.load * (t.normal[0] * m[1] + t.normal[1] * m[4] + t.normal[2] * m[7]);
            const w = toWorld(m, t.hub[0], t.hub[1], t.hub[2]);
            t.surface = ctx.ground.surface(s.pos[0] + w[0], s.pos[1] + w[1] + 100, s.pos[2] + w[2]);
            const type = surfaceType(t.surface);
            gripCoef[i] = cf[i] * evoSurfaceMu(type) * weather * evoTreadFactor(type, p.evo.tread);
            t.mu = gripCoef[i];
            t.grip = t.mu * nLoad;
        }
        else {
            t.grip = 0;
            t.surface = -1;
        }
        t.lateral = 0;
        t.load = Math.max(0, t.load - p.damper[axleIdx] * t.extensionRate);
    }
    // The driveline (§5.3, §6): centre split, then each tire, each axle's differential after its tires.
    evoCentreSplit(spec, e.splitOffset, e.split, e.slip);
    const ratio = evoGearRatio(spec, c.gear);
    const inertia = evoDriveInertia(spec, c.gear, fr);
    const frames = [null, null, null, null];
    const groundF = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const totalGrip = s.tires.reduce((a, t) => a + t.grip, 0);
    const rpmPerSpin = (60 * ratio * fr) / TWO_PI;
    for (let i = 0; i < 4; i++) {
        const t = s.tires[i];
        const front = i < 2;
        const axleIdx = front ? 0 : 1;
        const brake = front ? c.brakeFront : c.brakeRear;
        // In Neutral the engine follows the throttle; in gear that share decays.
        e.neutralRpm = ratio === 0 ? e.neutralRpm + (c.throttle * spec.redline - e.neutralRpm) * 0.1 : e.neutralRpm * 0.97;
        const meanSlip = (e.slip[0] + e.slip[1] + e.slip[2] + e.slip[3]) * 0.25;
        // The tire's drive share: none at the front in 2WD and half each at the rear; else split by the diff.
        const side = (i & 1) === 1 ? 0 : 1; // shares are [left, right]; FR and RR are right
        const share = e.transfer === 0 ? (front ? 0 : 0.5) : e.split[axleIdx] * e.shares[axleIdx][side];
        if (!t.onGround) {
            // In the air (§6.1): the engine winds towards the wheels or the throttle, braked down; no ground force.
            const drive = ratio * fr * (e.torque / r) * share;
            e.slip[i] = evoStepSlip(e.slip[i], drive, speed, gripCoef[i], 0, false, inertia, dt);
            let target = Math.abs(meanSlip * rpmPerSpin) + (s.bvel[2] * 60 * ratio * fr) / (r * TWO_PI);
            if (target < c.throttle * spec.redline)
                target = c.throttle * spec.redline;
            if (target > spec.redline)
                target = spec.redline - 250;
            const wind = (brake * 16000 + 3200) * dt;
            target = target >= 0 ? Math.max(0, target - wind) : Math.min(0, target + wind);
            s.rpm += (target - s.rpm) * dt;
            if (s.rpm < 800)
                s.rpm = 800;
            t.spin = ratio === 0 || s.rpm <= 800 ? t.spin * 0.9 : (s.rpm * TWO_PI) / (ratio * 60 * fr);
            t.angle = wrapPi(t.angle + t.spin * dt);
        }
        else {
            const f = tireFrame(s, t, front ? c.steer : c.rearSteer);
            frames[i] = f;
            let D = (brake * spec.maxBrakePct * 0.8 + 0.02) * t.grip;
            if (f.vFwd > 0)
                D = -D;
            // Engine (§6.1).
            let target = ratio !== 0 ? (s.bvel[2] * 60 * ratio * fr) / (r * TWO_PI) + meanSlip * rpmPerSpin : 0;
            target = Math.abs(target + e.neutralRpm);
            if (target < 800)
                target = 800;
            if (target > spec.redline)
                target = spec.redline + 100000;
            s.rpm += (target - s.rpm) * dt;
            const torqueNow = () => evoTorqueAt(spec.torqueTable, s.rpm) * c.throttle * p.evo.torqueModifier;
            if (s.rpm < spec.redline) {
                e.torque = torqueNow();
            }
            else {
                s.rpm = spec.redline - 250;
                e.torque = ratio !== 0 && s.bvel[2] / ratio <= 0 ? torqueNow() : 0;
            }
            let drive = ratio * fr * (e.torque / r) * share;
            e.slip[i] = evoStepSlip(e.slip[i], drive, speed, gripCoef[i], t.grip, true, inertia, dt);
            // Static hold below 10 mph (§5.2), as MTM2's.
            if (speed < MPH_10) {
                const sh = totalGrip !== 0 ? t.grip / totalGrip : 1;
                const tF = toWorld(m, f.nb[0], -f.nb[2], f.nb[1]);
                D = holdRule(D, tF[1] * W * sh, -(f.vFwd / dt) * mass * sh);
            }
            const lim = 0.8 * t.grip;
            if (drive + D > lim)
                drive -= drive + D - lim;
            if (drive + D < -lim)
                drive -= drive + D + lim;
            const F = drive + D;
            groundF[i] = [f.sd * F, 0, f.cd * F];
            t.spin = f.vFwd / r + e.slip[i] * 0.3;
            t.angle = wrapPi(t.angle + t.spin * dt);
        }
        // After both tires of an axle, its differential (the longitudinal forces of this step).
        if (i === 1 || i === 3) {
            const right = i - 1, left = i;
            evoDifferential(spec.slipDiffType[axleIdx], e.shares[axleIdx], groundF[left][2], groundF[right][2], e.slip[left], e.slip[right]);
        }
    }
    // Lateral force (§5.2): the slip angle and the shared table; a zero longitudinal speed reads 10 ft/s.
    for (let i = 0; i < 4; i++) {
        const t = s.tires[i];
        const f = frames[i];
        if (!t.onGround || !f)
            continue;
        const alpha = f.vFwd === 0 ? Math.atan2(f.vLat, 10) : Math.atan2(f.vLat, f.vFwd);
        const C = lateralCoefficient(alpha);
        t.lateral = C;
        const sh = totalGrip !== 0 ? t.grip / totalGrip : 1;
        const tL = toWorld(m, f.nb[1], -f.nb[0], f.nb[2]);
        const slope = tL[1] * W * sh;
        let F = t.grip * C + slope;
        if (speed < MPH_10) {
            if (Math.abs(F) > t.grip)
                F = (t.grip / Math.abs(F)) * F;
            F = holdRule(F, slope, -(f.vLat / dt) * mass * sh);
        }
        groundF[i][0] += F * f.cd;
        groundF[i][2] += -F * f.sd;
    }
    // Tire forces into body axes (§5.3, 0x55aaf0), as MTM2's.
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
    // Aero damping (§8.2): the vehicle's derivatives.
    let qbar = speed * speed * 0.0011885;
    if (qbar < 26.74125)
        qbar = 26.74125;
    const L = p.hubs[0][2] * 2;
    const [pRoll, qPitch, rYaw] = s.rates;
    const A = spec.refArea;
    const moment = [spec.cmq * qPitch * A[1] * L * qbar, spec.cnr * rYaw * A[0] * L * qbar, spec.clp * pRoll * A[0] * L * qbar];
    // Hull contacts (§7) with Evo's friction.
    const contacts = solveHullContacts(s, p.inertia, ctx.ground, force, mass, W, dt, { factor: rules.hullFrictionFactor, mu: evoSurfaceMu });
    // Sums and integration (§9), as MTM2's.
    for (let k = 0; k < 3; k++)
        force[k] += contacts.force[k] + tireSum[k] + s.extForce[k];
    const fMag = Math.hypot(force[0], force[1], force[2]);
    if (fMag > 500000) {
        const sc = 500000 / fMag;
        for (let k = 0; k < 3; k++)
            force[k] *= sc;
    }
    const cg = p.cgOffset;
    moment[0] += cg[2] * drag[1] - cg[1] * drag[2];
    moment[1] += cg[0] * drag[2] - cg[2] * drag[0];
    moment[2] += cg[1] * drag[0] - cg[0] * drag[1];
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
    const [I1, I2, I3] = p.inertia;
    const clamp13 = (v) => (v > 13 ? 13 : v < -13 ? -13 : v);
    const qDot = clamp13(((I3 - I1) / I2) * rYaw * pRoll + moment[0] / I2);
    const pDot = clamp13(((I2 - I3) / I1) * rYaw * qPitch + moment[2] / I1);
    const rDot = clamp13(((I1 - I2) / I3) * qPitch * pRoll + moment[1] / I3);
    const [vx, vy, vz] = s.bvel;
    const ax = pRoll * vy - rYaw * vz + force[0] / mass;
    const ay = qPitch * vz - pRoll * vx + force[1] / mass;
    const az = rYaw * vx - qPitch * vy + force[2] / mass;
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
    const atRest = iv < 0.1 || (iv < 0.5 && contacts.count >= 3);
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
export function evoForwardGear(gear) {
    return gear >= GEAR.FIRST ? gear - GEAR.FIRST + 1 : 0;
}
