/*
  Autopilot traffic (`0x483600`, MTM2_PHYSICS.md §14.25): the truck picks a truck just ahead to
  pass and a side, aims beside it, and caps its target speed behind the nearest truck ahead.
  It reads the other trucks' values from their last step (segment, progress, time to the
  segment's end, cross-track error and correction), so the order the trucks step in matters
  as it does in the game. Every truck is taken to be on the primary course, and the reversed
  course is not in.
*/
import { nextSegmentIndex, orientedCourse } from "../world/course.js";
import { headingOf, tireForwardSpeed, wrapGame } from "./autopilot.js";
import { truckRadius } from "./recovery.js";
import { autopilotGain } from "./state.js";
const NONE = -1;
/** A truck counts as on the line within this cross-track error, ft. */
const ON_LINE = 32;
const HALF_PI = Math.PI / 2, QUARTER_PI = Math.PI / 4;
const toBody = (m, x, y, z) => [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const onLine = (t) => Math.abs(t.s.ap.crossTrack) < ON_LINE;
const straight = (seg) => seg?.ctype === 1;
/**
 * Traffic for truck `s` this step (§14.25), given the segment heading `hs`, the clamped
 * correction `c` and the target speed of §14.22. Returns them, possibly changed, and updates
 * the truck's pass target, side and truck to follow.
 */
export function applyTraffic(s, p, ctx, trucks, hs, c, target) {
    const course = orientedCourse(ctx.course, ctx.reversed);
    const ap = s.ap;
    const seg = course[ap.segment];
    const rev = ctx.reversed;
    const G0 = autopilotGain(ctx.difficulty);
    const rA = truckRadius(p);
    const oldTarget = ap.passTarget;
    ap.candidates = 0;
    ap.follow = NONE;
    // 1. Candidates: on this segment, ahead, at most `w` seconds ahead, on the line.
    let w = ((p.scrapePoints[0]?.[2] ?? 0) / seg.speed) * G0;
    if (ap.side !== 0)
        w *= 16;
    const list = [];
    let best = NONE, bestEta = 0;
    for (let k = trucks.length - 1; k >= 0; k--) {
        const o = trucks[k];
        if (o.s === s || o.s.ap.segment !== ap.segment)
            continue;
        if (!(ap.progress < o.s.ap.progress) || !(ap.eta < o.s.ap.eta + w) || !onLine(o))
            continue;
        list.push(k);
        ap.candidates++;
        if (bestEta < o.s.ap.eta) {
            bestEta = o.s.ap.eta;
            best = k;
        }
    }
    // 2. The previous target stays one while it is on the line on the next segment.
    let chosen = best;
    const old = oldTarget >= 0 ? trucks[oldTarget] : undefined;
    if (oldTarget !== best && old && onLine(old)) {
        const next = old.s.ap.segment === nextSegmentIndex(ctx.course, ap.segment, rev);
        if (next) {
            chosen = oldTarget;
            ap.candidates++;
            list.push(oldTarget);
        }
    }
    ap.passTarget = chosen;
    // 3. The side, and the truck to follow.
    const hy = ap.side * G0 * 0.2;
    const sideByFrame = (T) => {
        const q = toBody(T.s.matrix, s.pos[0] - T.s.pos[0], s.pos[1] - T.s.pos[1], s.pos[2] - T.s.pos[2]);
        return hy + headingOf(q[0], Math.abs(q[2])) <= 0 ? -1 : 1;
    };
    const sideByCorrection = (T) => (hy + (T.s.ap.correction - ap.correction) <= 0 ? -1 : 1);
    if (ap.candidates !== 0) {
        let side = 0;
        if (ap.candidates === 2) {
            for (const k of list)
                if (k !== ap.passTarget && Math.abs(trucks[k].s.ap.crossTrack) <= ON_LINE)
                    ap.follow = k;
            if (ap.passTarget !== NONE) {
                let T = trucks[ap.passTarget];
                if (straight(course[T.s.ap.segment]) && straight(seg)) {
                    if (dist3(s.pos, T.s.pos) <= (rA + truckRadius(T.p)) * 3)
                        side = sideByCorrection(T);
                    else {
                        const S = ap.follow !== NONE ? trucks[ap.follow] : undefined;
                        side = S && T.s.ap.correction - S.s.ap.correction > 0 ? -1 : 1;
                    }
                }
                else {
                    const f = ap.follow;
                    if (f !== NONE && trucks[f].s.ap.crossTrack < T.s.ap.crossTrack) {
                        ap.follow = NONE;
                        ap.passTarget = f;
                    }
                    T = trucks[ap.passTarget];
                    side = sideByFrame(T);
                }
            }
            if (ap.follow !== NONE && ap.eta < trucks[ap.follow].s.ap.eta)
                ap.follow = NONE;
        }
        else {
            let nearest = 999999;
            for (let k = trucks.length - 1; k >= 0; k--) {
                const o = trucks[k];
                if (o.s === s || k === ap.passTarget)
                    continue;
                const ahead = (o.s.ap.segment === ap.segment && ap.progress < o.s.ap.progress) || o.s.ap.segment === nextSegmentIndex(ctx.course, ap.segment, rev);
                if (!ahead || !onLine(o))
                    continue;
                const d = dist3(s.pos, o.s.pos);
                if (d < nearest) {
                    ap.follow = k;
                    nearest = d;
                }
            }
            if (ap.passTarget !== NONE) {
                const T = trucks[ap.passTarget];
                side = straight(course[T.s.ap.segment]) && straight(seg) ? sideByCorrection(T) : sideByFrame(T);
            }
        }
        ap.side = side;
    }
    const n = wrapGame(hs + HALF_PI);
    const sn = Math.sin(n), cn = Math.cos(n), sh = Math.sin(hs), ch = Math.cos(hs);
    let passing = false;
    // 4. Passing.
    if (ap.passTarget !== NONE) {
        passing = true;
        const T = trucks[ap.passTarget];
        const R = rA + truckRadius(T.p);
        const m = s.matrix, bv = s.bvel;
        const vx = m[0] * bv[0] + m[1] * bv[1] + m[2] * bv[2], vz = m[6] * bv[0] + m[7] * bv[1] + m[8] * bv[2];
        const beta = wrapGame(headingOf(sn * vx + cn * vz, sh * vx + ch * vz));
        const ts = wrapGame(hs + ap.side * HALF_PI);
        const Px = Math.sin(ts) * R + T.s.pos[0] - s.pos[0], Pz = Math.cos(ts) * R + T.s.pos[2] - s.pos[2];
        const phi = wrapGame(wrapGame(headingOf(sn * Px + cn * Pz, sh * Px + ch * Pz)) - beta);
        const go = ap.side >= 1 ? phi > 0 : phi < 0;
        if (go) {
            let th = wrapGame(headingOf(T.s.pos[0] - s.pos[0], T.s.pos[2] - s.pos[2]) + ap.side * HALF_PI);
            if (ap.side === 1) {
                if (wrapGame(th - hs) < QUARTER_PI)
                    th = wrapGame(hs + QUARTER_PI);
            }
            else if (wrapGame(th - hs) > -QUARTER_PI)
                th = wrapGame(hs - QUARTER_PI);
            const qx = Math.sin(th) * R + T.s.pos[0] - s.pos[0], qz = Math.cos(th) * R + T.s.pos[2] - s.pos[2];
            c = wrapGame(headingOf(qx, qz) - s.euler[2]);
            const cl = seg.ctype === 1 ? 0.125 : seg.ctype === 2 ? 0.25 : Infinity;
            c = Math.max(-cl, Math.min(cl, c));
        }
    }
    else {
        // 5. No target: no side, and the nearest truck ahead to follow.
        ap.side = 0;
        let nearest = 999999;
        for (let k = trucks.length - 1; k >= 0; k--) {
            const o = trucks[k];
            if (o.s === s)
                continue;
            const os = o.s.ap.segment;
            const ahead = (os === ap.segment && ap.progress < o.s.ap.progress) || os === nextSegmentIndex(ctx.course, ap.segment, rev);
            if (!ahead)
                continue;
            const d = dist3(s.pos, o.s.pos);
            if (d < nearest && onLine(o)) {
                ap.follow = k;
                nearest = d;
            }
        }
    }
    // 6. Following.
    if (ap.follow === NONE)
        return { c, target };
    const F = trucks[ap.follow];
    const R = rA + truckRadius(F.p);
    // The distance from the line through F across the segment (along n), at F's height.
    const ax = s.pos[0] - (F.s.pos[0] + sn * 100), ay = s.pos[1] - F.s.pos[1], az = s.pos[2] - (F.s.pos[2] + cn * 100);
    const dx = -sn * 200, dz = -cn * 200;
    const l = Math.hypot(ay * dz, az * dx - ax * dz, -ay * dx) / Math.hypot(dx, dz);
    const d = dist3(F.s.pos, s.pos);
    const sameSeg = ap.segment === F.s.ap.segment;
    const dp = d < R / G0 && sameSeg ? l : d;
    const vF = tireForwardSpeed(F.s, F.p);
    const v2 = vF * vF + ap.decel * 2 * (dp - R);
    if (v2 >= 0)
        target = Math.min(target, Math.sqrt(v2));
    // 7. Beside it: aim 100 ft up the segment, alongside on this truck's side.
    if (d < (1.25 / G0) * R && sameSeg && !passing && d > 0 && l / d < 0.866) {
        const q = toBody(F.s.matrix, s.pos[0] - F.s.pos[0], s.pos[1] - F.s.pos[1], s.pos[2] - F.s.pos[2]);
        const t = q[0] < 0 ? wrapGame(n + Math.PI) : n;
        const Px = Math.sin(hs) * 100 + Math.sin(t) * R + F.s.pos[0] - s.pos[0];
        const Pz = Math.cos(hs) * 100 + Math.cos(t) * R + F.s.pos[2] - s.pos[2];
        c = wrapGame(headingOf(Px, Pz) - hs);
    }
    return { c, target };
}
