/*
  The autopilot (MTM2_PHYSICS.md §12, §14.22, §14.23): CPU trucks, and the player with autopilot
  on, follow the course. Each tick the truck may move on to the next segment; then, at the start
  of its step, the segment becomes a line to follow, which gives the steering and a target speed,
  and the speed controller turns the target into throttle and brakes.

  Traffic (`0x483600`, §14.25, passing and following other trucks) is in `traffic.ts`; the
  reversed course is not in yet.
*/
import { ENGINE, G, INV_G } from "../constants.js";
import { isArc, nextSegmentIndex, orientedCourse } from "../world/course.js";
import { gearRatio } from "./drivetrain.js";
import { truckWeight } from "./dynamics.js";
import { applyTraffic } from "./traffic.js";
const TWO_PI = Math.PI * 2;
/** The game's angle wrap: `a - trunc(a / 2 pi) 2 pi`, then into [-pi, pi]. */
export function wrapGame(a) {
    let w = a - Math.trunc(a / TWO_PI) * TWO_PI;
    if (w > Math.PI)
        w -= TWO_PI;
    if (w < -Math.PI)
        w += TWO_PI;
    return w;
}
/** The game's heading, `atan2(dx, dz)`, with its special cases for a zero component. */
export function headingOf(dx, dz) {
    if (dx === 0)
        return dz < 0 ? Math.PI : 0;
    if (dz === 0)
        return dx >= 0 ? Math.PI / 2 : -Math.PI / 2;
    return Math.atan2(dx, dz);
}
/**
 * **Hypothesis** (MTM2_PHYSICS.md 14.22): the game was tuned at about 30 frames per second, and
 * the autopilot's frame-dependent terms use that frame time rather than the port's step.
 */
export const AUTOPILOT_FRAME_DT = 1 / 30;
const K_DEFAULT = 1.75, K_SONIC = 2.0;
const SLOPE_K_DEFAULT = 0.45, SLOPE_K_SONIC = 1.0;
function segmentGain(difficulty) {
    return difficulty === 0 ? 0.5 : difficulty === 2 ? 1.0 : 0.75;
}
/** The average of the four tires' forward speeds (`v_fwd`, tire +0x50), ft/s. */
export function tireForwardSpeed(s, p) {
    const [FR, FL, RR, RL] = s.tires;
    return (FR.spin + FL.spin + RR.spin + RL.spin) * p.tireRadiusFt * 0.25;
}
/**
 * The estimated time to the end of the truck's segment (`0x480ba0`, §14.24): on a straight,
 * accelerating then braking into the next corner's speed; on an arc, the arc left at the
 * current speed.
 */
export function segmentEta(s, p, seg, height) {
    const v = tireForwardSpeed(s, p);
    const x = s.pos[0], z = s.pos[2];
    if (isArc(seg)) {
        const left = Math.abs(wrapGame(headingOf(x - seg.centre[0], z - seg.centre[2]) - seg.exitAngle));
        return (seg.radius * left) / (v < 0.1 ? 0.1 : v);
    }
    const E = seg.end;
    const dx = E[0] - x, dy = E[1] - height(x, z), dz = E[2] - z;
    const D = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const b = s.ap.accel < 0.1 ? 0.1 : s.ap.accel;
    if (s.ap.decel < 0.1)
        s.ap.decel = 0.1;
    const a = s.ap.decel, vc = seg.speed;
    const run = (a * (D - seg.decPoint) * 2 + (vc * vc - v * v)) / ((a + b) * 2);
    let vp = v, t1 = 0;
    if (run > 0) {
        vp = Math.sqrt(Math.max(0, b * run * 2 + v * v));
        t1 = (vp - v) / b;
    }
    return t1 + (vp - vc) / a;
}
/**
 * The next segment (§14.23): when the truck is closer to the segment's end line than its
 * `cdec_point`, it moves on. Returns whether it did. With the truck's parameters, the time to
 * the new segment's end is set too (§14.24).
 */
export function advanceAutopilotSegment(s, ctx, p) {
    const course = orientedCourse(ctx.course, ctx.reversed);
    if (course.length === 0)
        return false;
    const seg = course[s.ap.segment];
    const x = s.pos[0], z = s.pos[2];
    let distance;
    if (isArc(seg)) {
        const ex = Math.sin(seg.exitAngle) * seg.radius * 2, ez = Math.cos(seg.exitAngle) * seg.radius * 2;
        const rx = x - seg.centre[0], rz = z - seg.centre[2];
        if (ex * rx + ez * rz <= 0) {
            distance = seg.decPoint * 2;
        }
        else {
            // Distance from the line through the centre along the exit direction.
            const l = Math.hypot(ex, ez);
            distance = l === 0 ? 999999 : Math.abs(rx * ez - rz * ex) / l;
        }
    }
    else {
        const next = course[nextSegmentIndex(course, s.ap.segment, ctx.reversed) % course.length];
        const N = isArc(next) ? next.centre : next.start;
        distance = distanceToEndLine(seg, N, x, z);
    }
    if (!(distance < seg.decPoint))
        return false;
    s.ap.integral = 0;
    s.ap.segmentsPassed++;
    s.ap.segment = nextSegmentIndex(ctx.course, s.ap.segment, ctx.reversed);
    const entered = course[s.ap.segment];
    if (!isArc(entered)) {
        let bonus = 0;
        if (ctx.rubberBand && ctx.difficulty !== 2 && (ctx.place ?? 99) <= 2) {
            const vz = s.bvel[2];
            bonus = Math.trunc(((vz - Math.trunc(vz)) * 5) / (ctx.place ?? 1)) * 0.1;
        }
        s.ap.gain = segmentGain(ctx.difficulty) - bonus;
    }
    if (p)
        s.ap.eta = segmentEta(s, p, entered, ctx.height);
    return true;
}
/** The truck's distance (x, z) from a straight's end line: across it, where the next arc begins. */
function distanceToEndLine(seg, N, x, z) {
    const S = seg.start, E = seg.end;
    const d = [E[0] - S[0], E[1] - S[1], E[2] - S[2]];
    const l = Math.hypot(d[0], d[1], d[2]);
    const u = l === 0 ? [0, 1, 0] : [d[0] / l, d[1] / l, d[2] / l];
    const t = u[0] * (N[0] - S[0]) + u[1] * (N[1] - S[1]) + u[2] * (N[2] - S[2]);
    const Fx = u[0] * t + S[0], Fz = u[2] * t + S[2];
    let nx = Fx - N[0], nz = Fz - N[2];
    const nl = Math.hypot(nx, nz);
    if (nl === 0) {
        nx = 0;
        nz = 0;
    }
    else {
        nx /= nl;
        nz /= nl;
    }
    // The line from F - 200 n to F + 200 n.
    const ax = Fx + nx * 200, az = Fz + nz * 200;
    const bx = Fx - nx * 200 - ax, bz = Fz - nz * 200 - az;
    const px = x - ax, pz = z - az;
    const bl = Math.hypot(bx, bz);
    return bl === 0 ? 999999 : Math.abs(px * bz - pz * bx) / bl;
}
/** The line the truck follows on a segment (§14.22). */
function segmentLine(s, seg, dt) {
    if (!isArc(seg))
        return { S: seg.start, E: seg.end };
    const arc = seg;
    const iv = toWorld(s.matrix, s.bvel[0], s.bvel[1], s.bvel[2]);
    const L = [s.pos[0] + iv[0] * dt * 2 - arc.centre[0], s.pos[1] + iv[1] * dt * 2 - arc.centre[1], s.pos[2] + iv[2] * dt * 2 - arc.centre[2]];
    const ll = Math.hypot(L[0], L[1], L[2]);
    const u = ll === 0 ? [0, 1, 0] : [L[0] / ll, L[1] / ll, L[2] / ll];
    const theta = u[0] !== 0 && u[2] !== 0 ? Math.atan2(u[0], u[2]) : headingOf(u[0], u[2]);
    const span = wrapGame(arc.exitAngle - arc.entryAngle);
    const f = wrapGame(theta - arc.entryAngle) / span;
    if (f < 0 || f > 1) {
        const a = f <= 1 ? arc.entryAngle : arc.exitAngle;
        u[0] = Math.sin(a);
        u[2] = Math.cos(a);
    }
    const T = span > 0 ? [u[2], 0, -u[0]] : [-u[2], 0, u[0]];
    const P = [arc.centre[0] + arc.radius * u[0], arc.centre[1] + arc.radius * u[1], arc.centre[2] + arc.radius * u[2]];
    return {
        S: [P[0] - T[0] * 100, P[1] - T[1] * 100, P[2] - T[2] * 100],
        E: [P[0] + T[0] * 100, P[1] + T[1] * 100, P[2] + T[2] * 100],
    };
}
function toWorld(m, x, y, z) {
    return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
}
/**
 * The autopilot's controls for this step (§14.22): steering, then throttle and brakes, written
 * into `s.controls`. Run at the start of the step, before `stepTruck`.
 */
export function applyAutopilot(s, p, ctx) {
    const { dt } = ctx;
    const course = orientedCourse(ctx.course, ctx.reversed);
    const fdt = ctx.frameDt ?? AUTOPILOT_FRAME_DT;
    if (course.length === 0)
        return;
    const seg = course[s.ap.segment];
    const arc = isArc(seg);
    const K = ctx.sonicTrack && ctx.difficulty === 2 ? K_SONIC : K_DEFAULT;
    const kSlope = ctx.sonicTrack && ctx.difficulty === 2 ? SLOPE_K_SONIC : SLOPE_K_DEFAULT;
    const { S, E } = segmentLine(s, seg, fdt);
    const x = s.pos[0], y = s.pos[1], z = s.pos[2];
    // Bearing and cross-track error.
    const hs = headingOf(E[0] - S[0], E[2] - S[2]);
    const dx = E[0] - x, dz = E[2] - z, dy = E[1] - ctx.height(x, z);
    const D = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const b = wrapGame(headingOf(dx, dz) - hs);
    const e = Math.sin(b) * D;
    let c = D > 50 ? Math.asin(Math.max(-1, Math.min(1, 0.02 * e))) : b;
    s.ap.crossTrack = e;
    s.ap.correction = c;
    const cl = arc ? 0.5 : 0.125;
    c = Math.max(-cl, Math.min(cl, c));
    // Target speed.
    const hE = ctx.height(E[0], E[2]);
    const wx = E[0] - x, wy = hE - y + 6, wz = E[2] - z;
    const wl = Math.hypot(wx, wy, wz);
    const wyU = wl === 0 ? 1 : wy / wl;
    const mu = (s.tires[0].mu + s.tires[1].mu + s.tires[2].mu + s.tires[3].mu) * 0.25;
    const decel = G * wyU + mu * Math.sqrt(Math.max(0, 1 - wyU * wyU)) * kSlope * G;
    s.ap.decel = decel;
    const G_ = s.ap.gain;
    let target;
    if (arc) {
        const a = seg;
        const rx = x - a.centre[0], rz = z - a.centre[2];
        const th = headingOf(rx, rz);
        const hOut = ctx.height(a.centre[0] + Math.sin(th) * (a.radius + 5), a.centre[2] + Math.cos(th) * (a.radius + 5));
        const hIn = ctx.height(a.centre[0] + Math.sin(th) * (a.radius - 5), a.centre[2] + Math.cos(th) * (a.radius - 5));
        const bHere = Math.atan((hOut - hIn) * 0.1);
        let ratio = (Math.sin(bHere) + Math.cos(bHere) * K) / (Math.sin(a.bank) + Math.cos(a.bank) * K);
        const wide = Math.hypot(rx, rz) - a.radius;
        if (wide > 0) {
            const k2 = ctx.sonicTrack ? 0.75 : 0.725;
            ratio *= Math.min(Math.sqrt(Math.max(0, (k2 * wide + a.radius) / a.radius)), 1.2);
        }
        if (ratio < 0.1)
            ratio = 0.1;
        target = a.speed * Math.sqrt(Math.max(0, G_)) * Math.sqrt(Math.max(0, mu / K)) * Math.sqrt(ratio);
    }
    else {
        const v0 = seg.speed * Math.sqrt(Math.max(0, G_));
        target = Math.sqrt(Math.max(0, v0 * v0 + decel * D * 2)) * Math.sqrt(Math.max(0, mu / K));
    }
    // Traffic (§14.25) may lower the target and replace the correction.
    if (ctx.traffic)
        ({ c, target } = applyTraffic(s, p, ctx, ctx.traffic, hs, c, target));
    // Steering.
    const err = wrapGame(hs - s.euler[2] + c);
    let cmd = 22 * fdt * err;
    if (Math.abs(e) > 32 && !arc)
        cmd *= Math.min(Math.abs(e) * 0.03125, 1.5);
    const iv = toWorld(s.matrix, s.bvel[0], s.bvel[1], s.bvel[2]);
    const speed = Math.hypot(iv[0], iv[1], iv[2]);
    if (speed > 14.67 && s.tires.every((t) => !t.onGround)) {
        // Per frame the integrator gains clamp(err): `/ dt * gain * dt` in the code.
        s.ap.integral += Math.max(-0.5, Math.min(0.5, err)) * 1.0 * (dt / fdt);
        cmd += s.ap.integral;
    }
    if (D < 30)
        cmd *= D * (1 / 30);
    if (!arc)
        cmd *= Math.min(Math.sqrt(Math.abs(20 / s.bvel[2])), 1);
    cmd = Math.max(-0.45, Math.min(0.45, cmd));
    const ctl = s.controls;
    ctl.steer -= (ctl.steer - cmd) * 6.66 * dt;
    ctl.steer = Math.max(-0.45, Math.min(0.45, ctl.steer));
    ctl.rearSteer = -ctl.steer * 0.33 * (ctx.dragMode ? 1.25 : 1);
    // Speed control (0x4805d0).
    const [FR, FL, RR, RL] = s.tires;
    const drag = (ctl.brakeRear * 0.8 + 0.02) * (RR.grip + RL.grip) + (ctl.brakeFront * 0.8 + 0.02) * (FR.grip + FL.grip);
    const rpm = s.rpm;
    const torque = ((ENGINE.a * rpm + ENGINE.b) * rpm + ENGINE.c) * ctl.throttle;
    const mass = truckWeight(p) * INV_G;
    const acc = (torque / p.tireRadiusFt) * gearRatio(ctl.gear) * p.transferRatio - drag;
    const wheels = tireForwardSpeed(s, p);
    const predicted = (acc / mass) * fdt * 0.05 + wheels;
    if (!ctx.dragMode && target < 17)
        target = 17;
    if (seg.ctype === 1 && seg.speedLimit >= 10 && seg.speedLimit < target) {
        target = seg.speedLimit;
    }
    const u = 1.2 * fdt * (target - predicted);
    if (u >= 0) {
        ctl.throttle = Math.min(u, 1);
        ctl.brakeFront = ctl.brakeRear = 0;
    }
    else {
        const brake = Math.min(-u, 1);
        ctl.throttle = 0;
        ctl.brakeFront = ctl.brakeRear = brake;
    }
    s.ap.target = target;
}
