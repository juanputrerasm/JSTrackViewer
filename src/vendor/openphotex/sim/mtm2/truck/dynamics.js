/*
  One truck step and the post-step (MTM2_PHYSICS.md §4-§10, detailed in §14).

  `stepTruck` runs §14.1 steps 2-8 (the controls and autopilot come before it, collisions and
  `postStepTruck` after). Everything is in the game frame: feet, body x right, y up, z forward.
  The order of operations and every constant follow the game; where the game does something
  surprising the comment says so, with the section that records it.
*/
import { DIFFICULTY, ENGINE, G, INV_G, LATERAL_TABLE, MPH_10, TRUCK } from "../constants.js";
import { eulerToMatrix, matrixToEuler, wrapPi, wrapTwoPi } from "../math.js";
import { cutFactor, surfaceMu, surfaceSinkFt, surfaceType } from "../world/surface.js";
import { weatherGrip } from "../constants.js";
import { deliveredTorque, gearRatio, stepGearbox } from "./drivetrain.js";
import { solveHullContacts } from "./contacts.js";
import { fluidAreas } from "./water-drag.js";
import { helicopterStep, updateStuck } from "./recovery.js";
const SKIN = 0.25;
const TWO_PI = Math.PI * 2;
const AREA = TRUCK.aeroArea; // x, y, z
const CD = TRUCK.aeroCd; // x, y, z
const toWorld = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
const toBody = (m, x, y, z) => [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Total weight, lb: body, both axles and the (zero in stock trucks) +0x5a0 term (§14.1). */
export function truckWeight(p) {
    return p.bodyWeightLb + 2 * p.axleWeightLb;
}
/** C(alpha) from the stored table (§5.3), with the game's lookup. */
export function lateralCoefficient(alpha) {
    const t = LATERAL_TABLE;
    let i = 0;
    while (i < t.length - 1 && t[i + 1][0] < alpha)
        i++;
    if (i >= t.length - 1)
        i = t.length - 2;
    const [a0, c0] = t[i], [a1, c1] = t[i + 1];
    return (alpha - a0) * ((c1 - c0) / (a1 - a0)) + c0;
}
/** Tire geometry (§14.2): hub, contact point and contact velocity, body axes. */
export function tireGeometry(s, p, i) {
    const t = s.tires[i];
    const axle = s.axles[i < 2 ? 0 : 1];
    const ca = Math.cos(axle.articulation), sa = Math.sin(axle.articulation);
    const [ax, , az] = p.hubs[i];
    t.hub[0] = ax * ca;
    t.hub[1] = ax * sa + axle.travel;
    t.hub[2] = az;
    const r = p.tireRadiusFt;
    t.contact[0] = t.hub[0] + sa * r;
    t.contact[1] = t.hub[1] - ca * r;
    t.contact[2] = t.hub[2];
    const [cx, cy, cz] = t.contact;
    const [roll, pitch, yaw] = s.rates; // p about z, q about x, r about y
    let vx = s.bvel[0] + yaw * cz, vy = s.bvel[1], vz = s.bvel[2] - yaw * cx;
    if (!t.onGround) {
        // In the air the roll and pitch rates move the contact too (the axle's own rate is 0 here).
        vx -= roll * cy;
        vy += roll * cx - pitch * cz;
        vz += pitch * cy;
    }
    t.velocity[0] = vx;
    t.velocity[1] = vy;
    t.velocity[2] = vz;
}
/** The hold rule shared by both tire forces (§14.4). */
function holdRule(current, slope, hold) {
    const f = slope + hold;
    if (hold === 0)
        return Math.abs(f) <= Math.abs(current) && current !== 0 ? f : current;
    return hold > 0 ? Math.min(current, f) : Math.max(current, f);
}
function tireFrame(s, t, steer) {
    const nb = toBody(s.matrix, t.normal[0], t.normal[1], t.normal[2]);
    t.pitchG = Math.atan2(nb[2], nb[1]);
    t.rollG = Math.atan2(nb[0], nb[1]);
    const v = t.velocity;
    const vz = Math.cos(t.pitchG) * v[2] - Math.sin(t.pitchG) * v[1];
    const vx = Math.cos(t.rollG) * v[0] - Math.sin(t.rollG) * v[1];
    const cd = Math.cos(steer), sd = Math.sin(steer);
    return { vFwd: vz * cd + vx * sd, vLat: vx * cd - vz * sd, nb, cd, sd };
}
/**
 * Advance one truck by `dt` (§14.1 steps 2-8). The controls must already be set; collision
 * forces and the post-step come after.
 */
export function stepTruck(s, p, ctx, dt) {
    // In helicopter flight the helicopter carries the truck instead (§10.3).
    if (s.heliTimer > 0) {
        helicopterStep(s, ctx.ground, dt);
        s.splash = false;
        return { force: [0, 0, 0], moment: [0, 0, 0], count: 0 };
    }
    const m = s.matrix;
    eulerToMatrix(s.euler[0], s.euler[1], s.euler[2], m);
    const c = s.controls;
    for (let i = 0; i < 4; i++)
        tireGeometry(s, p, i);
    stepGearbox(c, { rpm: s.rpm, autoShift: p.autoShift, forwardSpeed: s.bvel[2], dragStaging: false });
    const W = truckWeight(p);
    const mass = W * INV_G;
    const gripK = !ctx.human && ctx.difficulty === DIFFICULTY.PROFESSIONAL && ctx.sonicTrack ? 2 : 1.75;
    const speed = Math.hypot(s.bvel[0], s.bvel[1], s.bvel[2]);
    // Gravity and drag, body axes (§14.7).
    const force = [-W * m[3], -W * m[4], -W * m[5]];
    const drag = [0, 0, 0];
    const fluid = fluidAreas(s, p, ctx.ground);
    s.splash = fluid.splash;
    for (let k = 0; k < 3; k++) {
        const v = s.bvel[k];
        drag[k] = -fluid.rhoA[k] * (v * Math.abs(v) * CD[k] * 0.5);
        force[k] += drag[k];
    }
    // Tires (§14.3-§14.6).
    const weather = weatherGrip(ctx.ground.weather);
    for (let i = 0; i < 4; i++) {
        const t = s.tires[i];
        const axleIdx = i < 2 ? 0 : 1;
        const k = p.spring[axleIdx], damper = p.damper[axleIdx];
        t.load = k * t.compression;
        if (t.onGround) {
            const nLoad = t.load * (t.normal[0] * m[1] + t.normal[1] * m[4] + t.normal[2] * m[7]);
            const w = toWorld(m, t.hub[0], t.hub[1], t.hub[2]);
            const type = surfaceType(ctx.ground.surface(s.pos[0] + w[0], s.pos[1] + w[1] + 100, s.pos[2] + w[2]));
            t.grip = gripK * surfaceMu(type) * weather * cutFactor(type, p.tireCut) * nLoad;
        }
        else {
            t.grip = 0;
        }
        t.load = Math.max(0, t.load - damper * t.extensionRate);
    }
    const human = ctx.human;
    const driver = { human, autoShift: p.autoShift, difficulty: ctx.difficulty, sonicTrack: ctx.sonicTrack };
    const ratio = gearRatio(c.gear);
    const r = p.tireRadiusFt;
    const frames = [null, null, null, null];
    const groundF = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    let totalGrip = s.tires.reduce((a, t) => a + t.grip, 0);
    for (let i = 0; i < 4; i++) {
        const t = s.tires[i];
        const front = i < 2;
        const brake = front ? c.brakeFront : c.brakeRear;
        if (!t.onGround) {
            // In the air the engine winds towards the wheel's spin or the throttle (§5.2).
            let target = ratio * t.spin * p.transferRatio * 60 / TWO_PI;
            if (target < c.throttle * ENGINE.maxRpm)
                target = c.throttle * ENGINE.maxRpm;
            if (target > ENGINE.maxRpm)
                target = ENGINE.maxRpm;
            const wind = (brake * 16000 + 3200) * dt;
            target = target >= 0 ? Math.max(0, target - wind) : Math.min(0, target + wind);
            s.rpm += (target - s.rpm) * dt;
            if (ratio !== 0)
                t.spin = s.rpm * TWO_PI / (ratio * p.transferRatio * 60);
            t.angle = wrapPi(t.angle + t.spin * dt);
            continue;
        }
        const steer = front ? c.steer : c.rearSteer;
        const f = tireFrame(s, t, steer);
        frames[i] = f;
        let D = (brake * 0.8 + 0.02) * t.grip;
        if (f.vFwd > 0)
            D = -D;
        // Engine and drive (four-wheel drive, §5.2).
        let target = ratio === 0
            ? c.throttle * ENGINE.maxRpm
            : Math.abs((p.transferRatio * ratio * f.vFwd * 60) / (r * TWO_PI));
        if (target < ENGINE.idleRpm)
            target = ENGINE.idleRpm;
        s.rpm += (target - s.rpm) * dt;
        if (s.rpm > ENGINE.maxRpm)
            s.rpm = ENGINE.maxRpm;
        const torque = deliveredTorque(s.rpm, c.throttle, driver);
        const split = front ? TRUCK.torqueSplit.front : TRUCK.torqueSplit.rear;
        let drive = p.transferRatio * ratio * (torque / r) * split * 0.5;
        // Static hold below 10 mph (§14.4).
        if (speed < MPH_10) {
            const share = totalGrip !== 0 ? t.grip / totalGrip : 1;
            const tF = toWorld(m, f.nb[0], -f.nb[2], f.nb[1]);
            const slope = tF[1] * W * share;
            const hold = -(f.vFwd / dt) * mass * share;
            D = holdRule(D, slope, hold);
        }
        const lim = 0.8 * t.grip;
        if (drive + D > lim)
            drive -= drive + D - lim;
        if (drive + D < -lim)
            drive -= drive + D + lim;
        const F = drive + D;
        groundF[i] = [f.sd * F, 0, f.cd * F];
        t.spin = f.vFwd / r;
        t.angle = wrapPi(t.angle + t.spin * dt);
        if (ctx.difficulty !== DIFFICULTY.ROOKIE)
            t.grip = Math.sqrt(Math.max(0, t.grip * t.grip - F * F));
    }
    totalGrip = s.tires.reduce((a, t) => a + t.grip, 0);
    for (let i = 0; i < 4; i++) {
        const t = s.tires[i];
        // An airborne tire has no lateral force (the routine returns at once, §14.5).
        const f = frames[i];
        if (!t.onGround || !f)
            continue;
        let alpha;
        if (Math.abs(f.vFwd) <= 10) {
            if (f.vFwd >= 0)
                alpha = f.vLat === 0 ? 0 : Math.atan2(f.vLat, 10);
            else
                alpha = f.vLat === 0 ? Math.PI : Math.atan2(f.vLat, -10);
        }
        else {
            alpha = Math.atan2(f.vLat, f.vFwd);
        }
        const C = lateralCoefficient(alpha);
        const share = totalGrip !== 0 ? t.grip / totalGrip : 1;
        const tL = toWorld(m, f.nb[1], -f.nb[0], f.nb[2]);
        const slope = tL[1] * W * share;
        let F = t.grip * C + slope;
        if (speed < MPH_10) {
            if (Math.abs(F) > t.grip)
                F = (t.grip / Math.abs(F)) * F;
            const hold = -(f.vLat / dt) * mass * share;
            F = holdRule(F, slope, hold);
        }
        groundF[i][0] += F * f.cd;
        groundF[i][2] += -F * f.sd;
    }
    // Tire forces into body axes (§14.6).
    const tireSum = [0, 0, 0];
    for (let i = 0; i < 4; i++) {
        const t = s.tires[i];
        const [fx, , fz] = groundF[i];
        const fb = [
            Math.cos(t.rollG) * fx,
            Math.sin(t.rollG) * fx + Math.sin(t.pitchG) * fz,
            Math.cos(t.pitchG) * fz,
        ];
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
    // Aero damping (§14.7).
    let qbar = speed * speed * 0.0011885;
    if (qbar < 26.74125)
        qbar = 26.74125;
    const L = p.hubs[0][2] * 2;
    const [pRoll, qPitch, rYaw] = s.rates;
    const moment = [
        -0.2 * qPitch * AREA[1] * L * qbar,
        -0.4 * rYaw * AREA[0] * L * qbar,
        -0.2 * pRoll * AREA[0] * L * qbar,
    ];
    // Hull contacts (§14.12), from gravity and drag so far.
    const contacts = solveHullContacts(s, p, ctx.ground, force, mass, W, dt);
    // Sums (§14.8).
    for (let k = 0; k < 3; k++)
        force[k] += contacts.force[k] + tireSum[k];
    const fMag = Math.hypot(force[0], force[1], force[2]);
    if (fMag > 500000) {
        const sc = 500000 / fMag;
        for (let k = 0; k < 3; k++)
            force[k] *= sc;
    }
    const cg = p.cgOffset;
    // Drag at the body origin, about the CG.
    moment[0] += cg[2] * drag[1] - cg[1] * drag[2];
    moment[1] += cg[0] * drag[2] - cg[2] * drag[0];
    moment[2] += cg[1] * drag[0] - cg[0] * drag[1];
    for (let k = 0; k < 3; k++)
        moment[k] += contacts.moment[k];
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
    // Integration (§14.9): rates and velocity first, then position and orientation.
    const [I1, I2, I3] = p.inertia; // roll (z), pitch (x), yaw (y)
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
    let ivel = toWorld(m, s.bvel[0], s.bvel[1], s.bvel[2]);
    const iv = Math.hypot(ivel[0], ivel[1], ivel[2]);
    const atRest = iv < 0.1 || (iv < 0.5 && contacts.count >= 3);
    if (atRest) {
        s.bvel.fill(0);
        s.rates.fill(0);
        ivel = [0, 0, 0];
    }
    // The stuck checks (§10.3); a reset or lift-off keeps this step's move, as in the game.
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
/** Euler angle rates and the gimbal guard (§9.4). */
function integrateOrientation(s, dt) {
    const [p, q, r] = s.rates;
    let [theta, phi, psi] = s.euler;
    let guard = null;
    if (theta > 1.05 || theta < -1.05) {
        guard = s.matrix.slice();
        theta = 0;
        phi = 0;
        psi = 0;
    }
    const st = Math.sin(theta), ct = Math.cos(theta), sp = Math.sin(phi), cp = Math.cos(phi);
    const thetaDot = q * cp - r * sp;
    const phiDot = (r / ct) * cp * st + (q / ct) * sp * st + p;
    const psiDot = (r * cp + q * sp) / ct;
    theta = wrapPi(theta + thetaDot * dt);
    phi = wrapPi(phi + phiDot * dt);
    psi = wrapTwoPi(psi + psiDot * dt);
    eulerToMatrix(theta, phi, psi, s.matrix);
    if (guard) {
        // Combine the old orientation with this step's small rotation and read the angles back.
        const d = s.matrix.slice();
        for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 3; col++) {
                s.matrix[row * 3 + col] = guard[row * 3] * d[col] + guard[row * 3 + 1] * d[3 + col] + guard[row * 3 + 2] * d[6 + col];
            }
        }
        const e = new Float64Array(3);
        matrixToEuler(s.matrix, e);
        theta = e[0];
        phi = e[1];
        psi = wrapTwoPi(e[2]);
    }
    s.euler[0] = theta;
    s.euler[1] = phi;
    s.euler[2] = psi;
}
/** The ground probe of a body point (§14.10): depth (vertical, less the sink) and normal. */
export function probeGround(s, ground, px, py, pz, offset) {
    const m = s.matrix;
    const w = toWorld(m, px, py, pz);
    let x = s.pos[0] + w[0], y = s.pos[1] + w[1], z = s.pos[2] + w[2];
    const normal = [0, 1, 0];
    ground.normal(x, z, normal);
    if (offset !== 0) {
        const nb = toBody(m, normal[0], normal[1], normal[2]);
        const len = Math.hypot(nb[1], nb[2]);
        const ny = len === 0 ? 1 : nb[1] / len, nz = len === 0 ? 0 : nb[2] / len;
        const o = toWorld(m, 0, offset * ny, offset * nz);
        x -= o[0];
        y -= o[1];
        z -= o[2];
    }
    const h = ground.height(x, z);
    let depth = h - y;
    let water = depth;
    const value = ground.surface(x, h + 100, z);
    if (surfaceType(value) === 13 && ground.waterLevelFt !== null)
        water += ground.waterLevelFt - h;
    depth -= surfaceSinkFt(value);
    return { depth, normal, water, point: [x, y, z] };
}
/** Contact probing at the end of the step (§14.10): tire contact points 13-16. */
function probeContacts(s, p, ground) {
    const m = s.matrix;
    let sign = 1;
    for (let i = 0; i < 4; i++) {
        const t = s.tires[i];
        t.penetration = -9999;
        t.lever = 0;
        const axle = s.axles[i < 2 ? 0 : 1];
        const half = p.tireWidthFt * sign * 0.5;
        const px = Math.cos(axle.articulation) * half + t.hub[0];
        const py = Math.sin(axle.articulation) * half + t.hub[1];
        const offset = p.tireRadiusFt * Math.max(Math.abs(Math.sin(t.pitchG)), Math.abs(Math.sin(t.rollG)));
        // The point the probe reached becomes the tire's contact point, in body axes.
        const { point } = probeGround(s, ground, px, py, t.hub[2], offset);
        s.points.set(toBody(m, point[0] - s.pos[0], point[1] - s.pos[1], point[2] - s.pos[2]), (12 + i) * 3);
        sign = -sign;
    }
    for (let j = 0; j < 16; j++) {
        s.depths[j] = -9999;
        if (j < 12)
            continue;
        const pr = probeGround(s, ground, s.points[j * 3], s.points[j * 3 + 1], s.points[j * 3 + 2], 0);
        s.waterDepths[j] = pr.water;
        s.depths[j] = pr.depth * pr.normal[1];
        s.normals.set(pr.normal, j * 3);
    }
}
/** The post-step (§14.11): axle reset, push-out, wheels and solid axles, bottoming. */
export function postStepTruck(s, p, ground, dt) {
    // Skipped in helicopter flight (§10.3).
    if (s.heliTimer > 0)
        return;
    const m = s.matrix;
    eulerToMatrix(s.euler[0], s.euler[1], s.euler[2], m);
    s.axles[0].articulation = 0;
    s.axles[0].travel = p.hubs[0][1];
    s.axles[1].articulation = 0;
    s.axles[1].travel = p.hubs[2][1];
    // Push-out (§14.11.2).
    s.contactCount = 0;
    for (let j = 0; j < 16; j++) {
        const pr = probeGround(s, ground, s.points[j * 3], s.points[j * 3 + 1], s.points[j * 3 + 2], 0);
        s.waterDepths[j] = pr.water;
        let push;
        if (pr.depth * pr.normal[1] <= s.depths[j] || j >= 12) {
            const st = s.depths[j], ny = s.normals[j * 3 + 1];
            push = st > SKIN || st < 0 ? st - ny * SKIN : 0;
        }
        else {
            s.depths[j] = pr.depth * pr.normal[1];
            s.normals.set(pr.normal, j * 3);
            push = pr.depth > SKIN || pr.depth < 0 ? (pr.depth - SKIN) * pr.normal[1] : 0;
        }
        if (push >= 0 && s.depths[j] >= 0) {
            const n = [s.normals[j * 3], s.normals[j * 3 + 1], s.normals[j * 3 + 2]];
            const move = [n[0] * push, n[1] * push, n[2] * push];
            for (let k = 0; k < 16; k++) {
                const d = s.normals[k * 3] * move[0] + s.normals[k * 3 + 1] * move[1] + s.normals[k * 3 + 2] * move[2];
                s.depths[k] -= d;
                s.waterDepths[k] -= d;
            }
            s.pos[0] += move[0];
            s.pos[1] += move[1];
            s.pos[2] += move[2];
            s.contactCount++;
        }
    }
    // Wheels (§14.11.3): probe at the static anchor, half the width inward, offset r.
    const bodyY = [m[1], m[4], m[7]];
    let sign = -1;
    for (let i = 0; i < 4; i++) {
        const t = s.tires[i];
        if (t.penetration < 0)
            t.onGround = false;
        const [ax, ay, az] = p.hubs[i];
        const px = p.tireWidthFt * sign * 0.5 + ax;
        const pr = probeGround(s, ground, px, ay, az, p.tireRadiusFt);
        t.waterDepth = pr.water;
        t.waterPoint = pr.point;
        const d = pr.depth * pr.normal[1];
        const vec = [pr.normal[0] * d, pr.normal[1] * d, pr.normal[2] * d];
        const along = dot(bodyY, vec);
        let pen = along === 0 ? 0 : dot(vec, vec) / along;
        if (pr.depth !== 0 && pen / pr.depth < 0 && pr.depth < 0)
            pen = -pen;
        if (t.penetration < pen) {
            if (pen > 0) {
                t.normal = pr.normal;
                t.onGround = true;
            }
            t.penetration = pen;
            t.lever = Math.hypot(p.tireRadiusFt, px);
        }
        sign = -sign;
    }
    // Solid axles, the deeper first (§14.11.4).
    const deeper = (a) => Math.max(s.tires[a].penetration, s.tires[a + 1].penetration);
    const order = deeper(0) > deeper(2) ? [0, 1] : [1, 0];
    let carry = 0;
    for (const axleIdx of order)
        carry = solveAxle(s, p, axleIdx, carry, dt);
    // Bottoming (§14.11.5).
    const iv = toWorld(m, s.bvel[0], s.bvel[1], s.bvel[2]);
    const corr = [0, 0, 0];
    for (const i of [1, 0, 3, 2]) {
        const t = s.tires[i];
        if (TRUCK.bumpTravelFt > t.compression)
            continue;
        const vn = dot(t.normal, iv);
        if (vn < 0)
            for (let k = 0; k < 3; k++)
                corr[k] += t.normal[k] * vn * 0.25;
    }
    if (corr[0] !== 0 || corr[1] !== 0 || corr[2] !== 0) {
        const b = toBody(m, -corr[0], -corr[1], -corr[2]);
        for (let k = 0; k < 3; k++)
            s.bvel[k] += b[k];
    }
}
/** One solid axle (§14.11.4). Returns the lift left over for the other axle. */
function solveAxle(s, p, axleIdx, carry, dt) {
    const axle = s.axles[axleIdx];
    const R = s.tires[axleIdx * 2], Lt = s.tires[axleIdx * 2 + 1];
    const anchorY = p.hubs[axleIdx * 2][1];
    const bump = TRUCK.bumpTravelFt, limit = TRUCK.articulationLimit;
    R.penetration -= carry;
    Lt.penetration -= carry;
    const oldR = R.compression, oldL = Lt.compression;
    let art = axle.articulation;
    if (R.penetration > 0 || Lt.penetration > 0) {
        let ratio;
        if (R.penetration + Lt.penetration <= 0) {
            ratio = R.penetration > 0 ? R.penetration / R.lever : -(Lt.penetration / Lt.lever);
        }
        else {
            ratio = (R.penetration - Lt.penetration) / (Lt.lever + R.lever);
        }
        art = Math.atan(ratio);
    }
    if (art > limit)
        art = limit;
    if (art < -limit)
        art = -limit;
    if (R.penetration > 0 || Lt.penetration > 0) {
        const delta = Math.sin(axle.articulation) - Math.sin(art);
        R.penetration += R.lever * delta;
        Lt.penetration -= delta * Lt.lever;
        axle.articulation = art;
    }
    const sa = Math.sin(axle.articulation);
    // Each tire's lateral offset for the compression is +5 ft (right) and -5 ft (left) (§14.13).
    R.compression = 5 * sa - anchorY + axle.travel;
    Lt.compression = -5 * sa - anchorY + axle.travel;
    const overBump = (t, other) => {
        if (t.compression <= bump)
            return;
        const over = t.compression - bump;
        t.compression = bump;
        axle.travel -= over;
        other.compression -= over;
        if (R.penetration > 0 || Lt.penetration > 0) {
            R.penetration += over;
            Lt.penetration += over;
        }
    };
    overBump(R, Lt);
    overBump(Lt, R);
    if (axle.travel < anchorY) {
        const d = anchorY - axle.travel;
        axle.travel = anchorY;
        R.compression += d;
        Lt.compression += d;
        if (R.penetration > 0 || Lt.penetration > 0) {
            R.penetration -= d;
            Lt.penetration -= d;
        }
    }
    const deep = R.penetration >= Lt.penetration ? R : Lt;
    let pen = deep.penetration;
    if (pen <= 0) {
        pen = 0;
    }
    else {
        const room = Math.min(bump - R.compression, bump - Lt.compression);
        const raise = room <= pen ? room : pen;
        R.compression += raise;
        Lt.compression += raise;
        axle.travel += raise;
        pen -= raise;
        // What the axle cannot take lifts the truck along that wheel's normal.
        const m = s.matrix;
        const lift = pen * (deep.normal[0] * m[1] + deep.normal[1] * m[4] + deep.normal[2] * m[7]);
        for (let k = 0; k < 3; k++)
            s.pos[k] += deep.normal[k] * lift;
        for (let j = 0; j < 16; j++)
            s.depths[j] -= lift;
        R.waterDepth -= lift;
        Lt.waterDepth -= lift;
    }
    if (R.compression < 0)
        R.compression = 0;
    if (Lt.compression < 0)
        Lt.compression = 0;
    R.extensionRate = (oldR - R.compression) / dt;
    Lt.extensionRate = (oldL - Lt.compression) / dt;
    return pen;
}
export { G };
