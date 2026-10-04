/*
  The course the autopilot drives (MTM2_PHYSICS.md §12).

  A SIT stores only the straights. When a level loads, the game inserts an arc between each
  straight and the next (the last joining the first): the result alternates straight, arc,
  straight, arc..., numbered from 1, so straights hold the odd numbers. Each straight's speed
  becomes the speed of the arc after it, and the last segment is flagged `lastEntry`.

  Arc construction (0x487c60), between straight i (A to B) and straight j (C to D), in x and z:
  - If the gap C - B is at least 1 ft (in 3D), the corner P is where lines AB and CD cross, and the arc
    is a fillet tangent to both legs at the longer leg's distance from P. Otherwise the straights
    touch at B and the arc rounds the corner A, B, D with a 30 ft default.
  - For turns sharper than 90 degrees, a flag picks the opposite side of the circle for the
    entry and exit angles, depending on which side of the first straight the gap lies.
  - The centre's height and the bank come from the ground (terrain, boxes and ramp tops): the
    bank is atan((h(r + 5) - h(r - 5)) / 10) along the heading from the centre to the corner.
  - The corner speed is sqrt(k · r · g · max(0.1, sin β + K cos β)), k = 0.725 (0.75 on Sonic
    tracks), K the tire grip factor (1.75).
*/
import { G, TIRE_GRIP_K } from "../constants.js";
export function isArc(s) {
    return s.ctype === 2;
}
const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;
/** The game's angle wrap to [-π, π]. */
export function wrapAngle(a) {
    let w = a - Math.trunc(a / TWO_PI) * TWO_PI;
    if (w > Math.PI)
        w -= TWO_PI;
    if (w < -Math.PI)
        w += TWO_PI;
    return w;
}
function headingOf(dx, dz) {
    return Math.atan2(dx, dz);
}
function unit2(dx, dz) {
    const len = Math.hypot(dx, dz);
    return len === 0 ? [0, 0] : [dx / len, dz / len];
}
/**
 * Where lines AB and CD cross in x and z (0x468ee0), y = 0. Parallel lines give non-finite
 * values, as in the game. When either line has no extent in x, the game takes a shortcut that
 * lands on the crossing only when the far line's parameter comes out negative; it is kept.
 */
export function lineIntersection(a, b, c, d) {
    const dx1 = b[0] - a[0];
    const dx2 = d[0] - c[0];
    if (dx1 === 0 || dx2 === 0) {
        if (dx1 === 0) {
            const [ux, uz] = unit2(c[0] - d[0], c[2] - d[2]);
            let t = (d[0] - a[0]) / ux;
            if (t < 0)
                t = -t;
            return [ux * t + d[0], 0, uz * t + d[2]];
        }
        const [ux, uz] = unit2(dx1, b[2] - a[2]);
        let t = (d[0] - a[0]) / ux;
        if (t < 0)
            t = -t;
        return [ux * t + a[0], 0, uz * t + a[2]];
    }
    const negSlope1 = (a[2] - b[2]) / dx1;
    const b1 = a[2] - ((b[2] - a[2]) / dx1) * a[0];
    const b2 = c[2] - ((d[2] - c[2]) / dx2) * c[0];
    const x = (b1 - b2) / (negSlope1 - (c[2] - d[2]) / dx2);
    return [x, 0, b1 - x * negSlope1];
}
/**
 * One arc (0x487c60): `from` and `to` are the ends of the two legs, `corner` the point they
 * meet. `farSide` is the sharp-turn flag; `fillet` false is the touching-straights case.
 */
export function buildArc(from, corner, to, farSide, fillet, ground, options = {}) {
    const legTo = Math.hypot(to[0] - corner[0], to[2] - corner[2]);
    const legFrom = Math.hypot(from[0] - corner[0], from[2] - corner[2]);
    const ua = unit2(to[0] - corner[0], to[2] - corner[2]);
    const ub = unit2(from[0] - corner[0], from[2] - corner[2]);
    const dot = Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1]));
    const alpha = Math.acos(dot) * 0.5;
    const bis = unit2(ua[0] + ub[0], ua[1] + ub[1]);
    const thetaC = farSide ? headingOf(bis[0], bis[1]) : headingOf(-bis[0], -bis[1]);
    const reference = farSide ? headingOf(ub[0], ub[1]) : headingOf(-ub[0], -ub[1]);
    const sense = wrapAngle(headingOf(ua[0], ua[1]) - reference);
    const half = HALF_PI - alpha;
    const entryAngle = wrapAngle(sense > 0 ? thetaC - half : thetaC + half);
    const exitAngle = wrapAngle(sense > 0 ? thetaC + half : thetaC - half);
    let radius, cx, cz;
    if (fillet) {
        radius = Math.tan(alpha) * Math.max(legTo, legFrom);
        const dist = radius / Math.sin(alpha);
        cx = corner[0] + bis[0] * dist;
        cz = corner[2] + bis[1] * dist;
    }
    else {
        const r = 30 / Math.cos(alpha);
        const r2 = r * r;
        if (r2 >= 1800) {
            cx = corner[0] + bis[0] * r;
            cz = corner[2] + bis[1] * r;
            radius = Math.sqrt(Math.max(0, r2 - 900));
        }
        else {
            const dist = 30 / Math.sin(alpha);
            cx = corner[0] + bis[0] * dist;
            cz = corner[2] + bis[1] * dist;
            radius = 30;
        }
    }
    const sx = Math.sin(thetaC), sz = Math.cos(thetaC);
    const outside = ground(sx * (radius + 5) + cx, sz * (radius + 5) + cz);
    const inside = ground(sx * (radius - 5) + cx, sz * (radius - 5) + cz);
    const bank = Math.atan((outside - inside) * 0.1);
    const k = options.sonicTrack ? 0.75 : 0.725;
    let grip = Math.sin(bank) + (options.gripK ?? TIRE_GRIP_K) * Math.cos(bank);
    if (grip < 0.1)
        grip = 0.1;
    const v2 = k * radius * G * grip;
    const speed = v2 < 0 ? 0 : Math.sqrt(v2);
    const third = radius / 3;
    return {
        ctype: 2, cspeedType: 1,
        centre: [cx, ground(cx, cz), cz],
        entryAngle, exitAngle, radius,
        decPoint: 20 <= third ? 20 : third,
        speed, bank, lastEntry: false,
    };
}
/** The arc that joins straight `s` to straight `t` (0x4e13b0's choice of case and flag). */
export function arcBetween(s, t, ground, options = {}) {
    const [a, b, c, d] = [s.start, s.end, t.start, t.end];
    const h1 = wrapAngle(headingOf(b[0] - a[0], b[2] - a[2]));
    const h2 = wrapAngle(headingOf(d[0] - c[0], d[2] - c[2]));
    const turn = wrapAngle(h2 - h1);
    const gx = c[0] - b[0], gz = c[2] - b[2];
    // The gap test is in 3D; everything else is horizontal.
    if (Math.hypot(gx, c[1] - b[1], gz) < 1)
        return buildArc(a, b, d, false, false, ground, options);
    const gapSide = wrapAngle(headingOf(gx, gz) - h1);
    const corner = lineIntersection(a, b, c, d);
    let farSide = false;
    if (Math.abs(turn) > HALF_PI)
        farSide = gapSide <= 0 ? turn >= 0 : turn <= 0;
    return buildArc(b, corner, c, farSide, true, ground, options);
}
/**
 * The driven course from the SIT straights: straight, arc, straight, arc..., index 0 being
 * segment number 1.
 */
export function buildCourse(straights, ground, options = {}) {
    const n = straights.length;
    const out = [];
    const copies = straights.map((s) => ({
        ctype: s.ctype, cspeedType: s.cspeedType,
        start: [s.startFt[0], s.startFt[1], s.startFt[2]],
        end: [s.endFt[0], s.endFt[1], s.endFt[2]],
        decPoint: s.cdecPoint, speed: s.cspeed, speedLimit: s.speedLimit, trackWidth: s.trackWidthFt,
        lastEntry: false,
    }));
    for (let i = 0; i < n; i++) {
        out.push(copies[i]);
        out.push(arcBetween(copies[i], copies[(i + 1) % n], ground, options));
    }
    if (out.length > 0)
        out[out.length - 1].lastEntry = true;
    for (let i = 0; i < out.length; i++) {
        const seg = out[i];
        if (seg.ctype === 1)
            seg.speed = out[(i + 1) % out.length].speed;
    }
    return out;
}
