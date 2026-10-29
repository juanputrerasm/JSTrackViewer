/*
  A truck against a truck (MTM2_PHYSICS.md §7.4, §14.20): each truck's hull points against the
  other's hull box, the faster truck pushed out along the axis the relative motion leaves by
  soonest, and the inelastic force law with the lighter truck's mass; after each pass, the
  wheels against the wheels (a rim point of one tire against the other's cylinder). As for
  boxes, each contact replaces the pair's forces and only the last one is applied.

  The wheel contact's response is the one part Monster Truck Madness 1 does differently
  (`rules`, constants.ts): its `0x467fd0` against MTM2's `0x491e20`.
*/
import { INV_G, MTM2_RULES } from "../constants.js";
import { truckWeight } from "../truck/dynamics.js";
import { truckRadius } from "../truck/recovery.js";
import { withNearest } from "../world/wrap.js";
const toWorld = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
const toBody = (m, x, y, z) => [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** A body point's velocity, `bvel + omega x r` with omega = (q, r, p) on (x, y, z). */
function pointVelocity(s, r) {
    const [p, q, w] = s.rates;
    return [s.bvel[0] + (w * r[2] - p * r[1]), s.bvel[1] + (p * r[0] - q * r[2]), s.bvel[2] + (q * r[1] - w * r[0])];
}
/** Whether `r` (O's axes) is inside O's hull box: two half boxes of its hull points (§14.20). */
function insideHullBox(hull, r) {
    const [P1, P2, P3, , , , , , P9, , P11, P12] = hull;
    if (r[2] >= 0) {
        return r[2] <= P1[2] && P1[0] <= r[0] && r[0] <= P2[0] && P1[1] <= r[1] && r[1] <= P3[1];
    }
    return P11[2] <= r[2] && P11[0] <= r[0] && r[0] <= P12[0] && P11[1] <= r[1] && r[1] <= P9[1];
}
/**
 * The pair test of two trucks (§14.20). `a` is the pair's first truck. Pair forces go to each
 * truck's `extForce` / `extMoment`; the faster truck is moved out of the slower one. Returns what
 * met (for a host's sounds and effects).
 */
export function collideTrucks(a, b, dt, rules = MTM2_RULES) {
    // Across the world's seam the two are a world apart by their numbers: `b` is tested as the copy nearest `a`.
    return withNearest(b.s, a.s.pos[0], a.s.pos[2], () => collideNear(a, b, dt, rules));
}
function collideNear(a, b, dt, rules) {
    if (a.s.heliTimer > 0 || b.s.heliTimer > 0)
        return { hull: false, wheels: false };
    const ra = truckRadius(a.p), rb = truckRadius(b.p);
    const d = Math.hypot(a.s.pos[0] - b.s.pos[0], a.s.pos[1] - b.s.pos[1], a.s.pos[2] - b.s.pos[2]);
    if (d >= ra + rb)
        return { hull: false, wheels: false };
    const speed = (t) => {
        const v = toWorld(t.s.matrix, t.s.bvel[0], t.s.bvel[1], t.s.bvel[2]);
        return Math.hypot(v[0], v[1], v[2]);
    };
    const [slow, fast] = speed(b) < speed(a) ? [b, a] : [a, b];
    const mEff = Math.min(truckWeight(a.p), truckWeight(b.p)) * INV_G;
    const out = { a: null, b: null, hull: false, wheels: false };
    pass(fast, slow, slow, mEff, dt, a, out);
    wheels(fast, slow, slow, mEff, dt, a, out, rules);
    pass(slow, fast, slow, mEff, dt, a, out);
    wheels(slow, fast, slow, mEff, dt, a, out, rules);
    for (const [t, f] of [[a, out.a], [b, out.b]]) {
        if (!f)
            continue;
        for (let k = 0; k < 3; k++) {
            t.s.extForce[k] += f.f[k];
            t.s.extMoment[k] += f.m[k];
        }
    }
    return { hull: out.hull, wheels: out.wheels };
}
/** The points of `T` against the hull box of `O`. */
function pass(O, T, slow, mEff, dt, first, out) {
    const mo = O.s.matrix, mt = T.s.matrix;
    const hull = O.p.scrapePoints;
    const radius = truckRadius(O.p);
    // T's points as world offsets, formed once; the positions are read as they move.
    const offsets = [];
    for (let j = 0; j < 12; j++)
        offsets.push(toWorld(mt, T.s.points[j * 3], T.s.points[j * 3 + 1], T.s.points[j * 3 + 2]));
    for (let j = 0; j < 12; j++) {
        const w = offsets[j];
        const dw = [T.s.pos[0] + w[0] - O.s.pos[0], T.s.pos[1] + w[1] - O.s.pos[1], T.s.pos[2] + w[2] - O.s.pos[2]];
        if (!(dw[0] * dw[0] + dw[1] * dw[1] + dw[2] * dw[2] < radius * radius))
            continue;
        const r = toBody(mo, dw[0], dw[1], dw[2]);
        if (!insideHullBox(hull, r))
            continue;
        const P = [T.s.points[j * 3], T.s.points[j * 3 + 1], T.s.points[j * 3 + 2]];
        respond(O, T, slow, P, r, hull, mEff, dt, first, out);
    }
}
function respond(O, T, slow, P, r, hull, mEff, dt, first, out) {
    const mo = O.s.matrix, mt = T.s.matrix;
    const vtw = toWorld(mt, ...pointVelocity(T.s, P));
    const vt = toBody(mo, vtw[0], vtw[1], vtw[2]);
    const vo = pointVelocity(O.s, r);
    const v = [vo[0] - vt[0], vo[1] - vt[1], vo[2] - vt[2]];
    const [P1, P2, P3, , , , , , P9, , P11, P12] = hull;
    const rear = v[2] <= 0;
    const dx = Math.abs((v[0] <= 0 ? (rear ? P11 : P1)[0] : (rear ? P12 : P2)[0]) - r[0]);
    const dy = Math.abs((v[1] <= 0 ? (rear ? P11 : P1)[1] : (rear ? P9 : P3)[1]) - r[1]);
    const dz = Math.abs((rear ? P11 : P1)[2] - r[2]);
    const t = [v[0] === 0 ? 100 : dx / v[0], v[1] === 0 ? 1e6 : dy / v[1], v[2] === 0 ? 100 : dz / v[2]];
    // The axis the relative motion leaves by soonest (0x48c3d0).
    let k = -1;
    const A = t.map(Math.abs);
    if (A[1] <= A[0]) {
        if (A[2] <= A[1]) {
            if (t[2] !== 0)
                k = 2;
        }
        else if (t[1] !== 0)
            k = 1;
    }
    else if (A[2] <= A[0]) {
        if (t[2] !== 0)
            k = 2;
    }
    else if (t[0] !== 0)
        k = 0;
    if (k < 0)
        return;
    const tk = A[k];
    const push = toWorld(mo, v[0] * tk, v[1] * tk, v[2] * tk);
    // The faster truck moves.
    if (O === slow)
        for (let i = 0; i < 3; i++)
            T.s.pos[i] += push[i];
    else
        for (let i = 0; i < 3; i++)
            O.s.pos[i] -= push[i];
    const e = [0, 0, 0];
    e[k] = Math.sign(t[k]);
    const F = (Math.abs(v[0] * e[0] + v[1] * e[1] + v[2] * e[2]) / dt) * mEff;
    const fo = [-F * e[0], -F * e[1], -F * e[2]];
    const fw = toWorld(mo, F * e[0], F * e[1], F * e[2]);
    const ft = toBody(mt, fw[0], fw[1], fw[2]);
    out.hull = true;
    const forO = { f: fo, m: cross(r, fo) }, forT = { f: ft, m: cross(P, ft) };
    if (O === first) {
        out.a = forO;
        out.b = forT;
    }
    else {
        out.a = forT;
        out.b = forO;
    }
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
/** The game's unit vector: (0, 1, 0) for a zero one. */
const unit = (a) => { const l = len(a); return l === 0 ? [0, 1, 0] : [a[0] / l, a[1] / l, a[2] / l]; };
/** A tire's half axis in body axes (§14.20): `(w/2)(cos d cos a, cos d sin a, sin d)`. */
function halfAxis(t, wheel) {
    const front = wheel < 2;
    const a = t.s.axles[front ? 0 : 1].articulation;
    const d = front ? t.s.controls.steer : t.s.controls.rearSteer;
    const k = t.p.tireWidthFt * 0.5;
    return [Math.cos(a) * Math.cos(d) * k, Math.sin(a) * Math.cos(d) * k, Math.sin(d) * k];
}
/** The wheels of `B` against the wheels of `A` (`0x491950`, §14.20). */
function wheels(A, B, slow, mEff, dt, first, out, rules) {
    const rho = (t) => Math.hypot(t.p.tireWidthFt * 0.5, t.p.tireRadiusFt);
    const RA = truckRadius(A.p);
    const hubWorld = (t, k) => add(t.s.pos, toWorld(t.s.matrix, ...t.s.tires[k].hub));
    for (const bw of [0, 1, 2, 3]) {
        if (!(len(sub(hubWorld(B, bw), A.s.pos)) < rho(B) + RA))
            continue;
        for (const aw of [0, 1, 2, 3])
            wheelPair(A, aw, B, bw, slow, mEff, dt, first, out, hubWorld, rho, rules);
    }
}
function wheelPair(A, aw, B, bw, slow, mEff, dt, first, out, hubWorld, rho, rules) {
    const mA = A.s.matrix, mB = B.s.matrix;
    const hA = hubWorld(A, aw), hB = hubWorld(B, bw);
    if (!(len(sub(hA, hB)) < rho(A) + rho(B)))
        return;
    // B's rim point nearest A's hub, in B's axes, then A's.
    const cB = B.s.tires[bw].hub, axB = halfAxis(B, bw);
    const DB = unit(scale(axB, 2));
    const q = toBody(mB, ...sub(hA, hB));
    const t = dot(DB, q);
    const E = t <= 0 ? sub(cB, axB) : add(cB, axB);
    const RB = add(E, scale(unit(sub(q, scale(DB, t))), B.p.tireRadiusFt));
    const RA = toBody(mA, ...sub(add(B.s.pos, toWorld(mB, ...RB)), A.s.pos));
    // Inside A's wheel: the axis from the inner face outward.
    const cA = A.s.tires[aw].hub, axA = halfAxis(A, aw);
    const left = A.p.hubs[aw][0] < 1;
    const S = left ? add(cA, axA) : sub(cA, axA);
    const axis = left ? scale(axA, -2) : scale(axA, 2);
    const al = len(axis);
    const dist = al === 0 ? 999999 : len(cross(sub(RA, S), axis)) / al;
    if (!(dist <= A.p.tireRadiusFt))
        return;
    const rel = sub(RA, cA);
    if (!(Math.sqrt(Math.max(0, dot(rel, rel) - dist * dist)) <= A.p.tireWidthFt * 0.5))
        return;
    respondWheels(A, aw, B, bw, slow, mEff, dt, first, out, RA, RB, E, unit(axis), rules);
}
/**
 * The velocity a wheel contact's force is made from, in A's axes. MTM2: half the relative
 * velocity. MTM1: axis by axis, the larger in magnitude of the two points' velocities (B's on a
 * tie), replaced by the relative velocity when that is smaller in magnitude.
 */
export function impactVelocity(vA, vB, rel, rules) {
    if (rules.wheelImpact === "half")
        return scale(rel, 0.5);
    const out = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
        const big = Math.abs(vB[k]) < Math.abs(vA[k]) ? vA[k] : vB[k];
        out[k] = Math.abs(rel[k]) < Math.abs(big) ? rel[k] : big;
    }
    return out;
}
/** The wheel contact's response (`0x491e20`, §14.20), in A's axes. */
function respondWheels(A, aw, B, bw, slow, mEff, dt, first, out, RA, RB, EB, D, rules) {
    const mA = A.s.matrix, mB = B.s.matrix;
    const vBw = toWorld(mB, ...pointVelocity(B.s, RB));
    const vB = toBody(mA, ...vBw), vA = pointVelocity(A.s, RA);
    const v = sub(vB, vA);
    const nv = scale(v, -1);
    const n = unit(nv);
    const cA = A.s.tires[aw].hub;
    const rA = A.p.tireRadiusFt, rB = B.p.tireRadiusFt;
    const off = sub(RA, cA);
    const k = dot(D, off);
    const da = Math.max(0, A.p.tireWidthFt * 0.5 - k);
    const rad = sub(off, scale(D, k));
    const u = unit(rad);
    const EA = toBody(mA, ...sub(add(B.s.pos, toWorld(mB, ...EB)), A.s.pos));
    const w = unit(sub(RA, EA));
    const cosT = Math.abs(dot(w, u));
    const ec = sub(EA, cA);
    const e = sub(ec, scale(D, dot(D, ec)));
    const l = len(e);
    const p = sub(nv, scale(D, dot(D, nv)));
    // The distance from A's axis to the line through e and rad - p.
    const c1 = sub(sub(rad, p), e);
    const c1l = len(c1);
    const delta = c1l === 0 ? 999999 : len(cross(scale(e, -1), c1)) / c1l;
    const lam = Math.sqrt(Math.max(0, l * l - delta * delta));
    const L = rB * cosT + rA;
    const mu = Math.sqrt(Math.max(0, L * L - delta * delta));
    const dr = dot(n, unit(e)) >= 0 ? mu - lam : lam + mu;
    const ta = nv[0] === 0 ? 100 : da / nv[0];
    const tr = nv[2] === 0 ? 100 : dr / nv[2];
    let depth, N, radial = false;
    if (Math.abs(tr) <= Math.abs(ta)) {
        if (tr === 0)
            return;
        depth = dr;
        N = unit(p);
        radial = true;
    }
    else {
        if (ta === 0)
            return;
        depth = da;
        N = D;
    }
    // The faster truck moves out.
    const push = toWorld(mA, ...scale(N, depth + 0.05));
    if (A === slow)
        for (let i = 0; i < 3; i++)
            B.s.pos[i] += push[i];
    else
        for (let i = 0; i < 3; i++)
            A.s.pos[i] -= push[i];
    const F = (Math.abs(dot(impactVelocity(vA, vB, v, rules), N)) / dt) * mEff;
    const f = scale(N, F);
    if (radial) {
        // Spinning tyres climb.
        let sp = 0;
        const ta_ = A.s.tires[aw], tb = B.s.tires[bw];
        if (ta_.onGround || !rules.wheelSpinNeedsGround)
            sp = rA * ta_.spin;
        if (tb.onGround || !rules.wheelSpinNeedsGround)
            sp += rB * tb.spin;
        const G = (sp / dt) * mEff * rules.wheelSpinClimb;
        f[1] += -G * N[2];
        f[2] += G * N[1];
    }
    const fA = scale(f, -1);
    const fw = toWorld(mA, ...f);
    const fB = toBody(mB, ...fw);
    out.wheels = true;
    const forA = { f: fA, m: cross(RA, fA) }, forB = { f: fB, m: cross(RB, fB) };
    if (A === first) {
        out.a = forA;
        out.b = forB;
    }
    else {
        out.a = forB;
        out.b = forA;
    }
}
