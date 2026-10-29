import { truckRadius } from "../truck/recovery.js";
const toWorld = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const toBody = (m, v) => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
/** The game's unit vector: (0, 1, 0) for a zero one. */
const unit = (a) => { const l = len(a); return l === 0 ? [0, 1, 0] : [a[0] / l, a[1] / l, a[2] / l]; };
/** The distance from Q to the infinite line through P1 and P2, 999999 when they coincide (`0x48e9d0`). */
export function lineDistance(P1, P2, Q) {
    const d = sub(P2, P1);
    const l = len(d);
    return l === 0 ? 999999 : len(cross(d, sub(Q, P1))) / l;
}
export function createEdgeState() {
    return { faceA: [0, 0, 0], faceB: [0, 0, 0], mEff: 0, mover: 0 };
}
/** A truck body point's velocity, `bvel + omega x r` with omega = (q, r, p) on (x, y, z). */
function pointVelocity(s, r) {
    const [p, q, w] = s.rates;
    return [s.bvel[0] + (w * r[2] - p * r[1]), s.bvel[1] + (p * r[0] - q * r[2]), s.bvel[2] + (q * r[1] - w * r[0])];
}
/** The obstacle's point velocity at `r` (its axes), in world axes. */
function obstacleVelocity(o, r) {
    return toWorld(o.matrix, add(o.vel, cross(o.rates, r)));
}
/**
 * One edge, from `W0` to `W1` (world), against a truck (§14.26.1): the pretest, the wheels
 * (§14.26.9), then the hull box (§14.26.2). Returns the last force record the wheel contacts
 * made, or null; a ramp pair discards it, a top-crush pair applies it.
 */
export function edgeAgainstTruck(W0, W1, o, s, p, es, ctx) {
    if (!(lineDistance(W0, W1, s.pos) < truckRadius(p)))
        return null;
    const E0 = toBody(s.matrix, sub(W0, s.pos));
    const E1 = toBody(s.matrix, sub(W1, s.pos));
    let forces = null;
    for (let i = 0; i < 4; i++) {
        const t = s.tires[i];
        if (es.mEff >= 1)
            edgeAsGround(E0, E1, s, p, i, t, ctx);
        if (t.penetration === -9999)
            forces = edgeAgainstTire(E0, E1, o, s, p, i, t, es, ctx) ?? forces;
    }
    edgeAgainstHull(E0, E1, o, s, es);
    return forces;
}
/** Test A (`0x49d630`): the edge as ground for a wheel at its static anchor. */
function edgeAsGround(E0, E1, s, p, i, t, ctx) {
    const A = p.hubs[i];
    const w = p.tireWidthFt, r = p.tireRadiusFt;
    const d = sub(E1, E0);
    const L = len(d);
    const u = unit(d);
    const D = w > 0 ? [1, 0, 0] : [0, 1, 0];
    if (!(Math.abs(u[1]) < 0.866))
        return;
    const tt = dot(u, sub(A, E0));
    if (!(-w < tt && tt < w + L))
        return;
    const P = add(E0, scale(u, tt));
    const q = sub(P, A);
    const k = dot(q, D);
    const rad = sub(q, scale(D, k));
    if (!(Math.abs(k) < w / 2))
        return;
    if (!(dot(rad, rad) <= r * r))
        return;
    const hz = Math.hypot(rad[0], rad[2]);
    const pen = Math.sqrt(Math.max(0, r * r - hz * hz)) + rad[1];
    if (!(pen > t.penetration))
        return;
    const Pw = add(s.pos, toWorld(s.matrix, P));
    t.penetration = pen;
    t.onGround = true;
    const n = ctx.groundNormal(Pw[0], Pw[2]);
    t.normal[0] = n[0];
    t.normal[1] = n[1];
    t.normal[2] = n[2];
    t.lever = Math.sqrt(Math.max(0, r * r + (A[0] + k) ** 2));
}
/** Test B (`0x49df20`): the edge against a tire's side and tread, then the response (`0x49c620`). */
function edgeAgainstTire(E0, E1, o, s, p, i, t, es, ctx) {
    const c = t.hub;
    const w = p.tireWidthFt, r = p.tireRadiusFt, hw = w / 2;
    const rho = Math.hypot(hw, r);
    if (!(lineDistance(E0, E1, c) < rho))
        return null;
    const a = s.axles[i < 2 ? 0 : 1].articulation;
    const h = [hw * Math.cos(a), hw * Math.sin(a), 0];
    const Fp = add(c, h), Fm = sub(c, h);
    const d = sub(E1, E0);
    const L = len(d);
    const u = unit(d);
    const D = unit(sub(Fp, Fm));
    // Cap discs pierced.
    let n = 0;
    for (const F of [Fp, Fm]) {
        const tc = Math.abs(dot(D, sub(F, E0))) / Math.abs(dot(u, D));
        const X = add(E0, scale(u, tc));
        const xf = sub(X, F);
        if (dot(xf, xf) < r * r)
            n++;
    }
    const tt = dot(u, sub(c, E0));
    if (!(n < 2 && tt > 0 && tt < L))
        return null;
    const P = add(E0, scale(u, tt));
    const q = sub(P, c);
    const k = dot(q, D);
    const rad = sub(q, scale(D, k));
    const Pw = add(s.pos, toWorld(s.matrix, P));
    const R = toBody(o.matrix, sub(Pw, o.pos));
    const vo = toBody(s.matrix, obstacleVelocity(o, R));
    const vrel = sub(pointVelocity(s, P), vo);
    const vperp = sub(vrel, scale(u, dot(u, vrel)));
    const vD = dot(vperp, D);
    // Depths.
    const uD = dot(u, D);
    const uperp = sub(u, scale(D, uD));
    const Cm = sub(P, scale(D, k));
    const delta = lineDistance(Cm, add(Cm, uperp), c);
    let sx = delta >= r ? Math.sqrt(Math.max(0, delta * delta - r * r)) : Math.sqrt(Math.max(0, r * r - delta * delta));
    const f = dot(q, uperp);
    let kk;
    if (k / vD >= 0) {
        kk = hw - Math.abs(k);
        sx -= Math.abs(f);
    }
    else {
        kk = hw + Math.abs(k);
        sx += Math.abs(f);
    }
    const g = Math.abs(dot(u, uperp));
    sx /= g;
    kk += Math.abs(sx * uD);
    if (!(Math.abs(kk - hw) <= hw))
        return null;
    if (!(dot(rad, rad) <= r * r))
        return null;
    const vrad = sub(vperp, scale(D, vD));
    const dR = r - len(rad);
    const tR = dR / len(vrad);
    const N = unit(vperp);
    const depth = kk / Math.abs(vD) > tR ? dR / dot(unit(rad), N) : kk / Math.abs(dot(N, D));
    // The response: back along the motion across the edge.
    const nn = scale(N, -1);
    const C = sub(P, scale(nn, depth));
    const move = toWorld(s.matrix, scale(nn, depth + 0.2));
    if (es.mover !== 1) {
        for (let i2 = 0; i2 < 3; i2++)
            s.pos[i2] += move[i2];
        for (let j = 0; j < 16; j++)
            s.depths[j] -= dot([s.normals[j * 3], s.normals[j * 3 + 1], s.normals[j * 3 + 2]], move);
    }
    const F = (len(vperp) / ctx.dt) * es.mEff;
    const ft = scale(nn, F);
    const fo = toBody(o.matrix, toWorld(s.matrix, scale(ft, -1)));
    return { truck: { f: ft, m: cross(C, ft) }, other: { f: fo, m: cross(R, fo) } };
}
/** Hull corner slots by octant (`0x496da0`), 1-based. */
function cornerSlot(C) {
    const right = C[0] > 0, front = C[2] > 0, top = C[1] > 1;
    if (front)
        return top ? (right ? 4 : 3) : (right ? 2 : 1);
    return top ? (right ? 10 : 9) : (right ? 12 : 11);
}
/** The edge against the hull box (`0x49b190`) and the face responses (`0x497be0`, `0x496e30`, `0x498980`). */
function edgeAgainstHull(E0, E1, o, s, es) {
    const P = (k) => [s.points[(k - 1) * 3], s.points[(k - 1) * 3 + 1], s.points[(k - 1) * 3 + 2]];
    const [P1, P2, P3, P4, P9, P10, P11, P12] = [P(1), P(2), P(3), P(4), P(9), P(10), P(11), P(12)];
    const d = sub(E1, E0);
    const L = len(d);
    const u = unit(d);
    let count = 0;
    // axis: 0 x, 1 y, 2 z; bounds on the other two axes as [axis, lo, hi].
    const face = (axis, c, b1, b2) => {
        const t = (c - E0[axis]) / u[axis];
        if (!(count < 2 && t > 0 && t < L))
            return;
        const H = add(E0, scale(u, t));
        if (!(b1[1] < H[b1[0]] && H[b1[0]] < b1[2] && b2[1] < H[b2[0]] && H[b2[0]] < b2[2]))
            return;
        count++;
        respond(H, axis);
    };
    const respond = (H, dropped) => {
        const Pw = add(s.pos, toWorld(s.matrix, H));
        const r = toBody(o.matrix, sub(Pw, o.pos));
        let vrel = sub(toBody(s.matrix, obstacleVelocity(o, r)), pointVelocity(s, H));
        const Aw = toWorld(o.matrix, es.faceA), Bw = toWorld(o.matrix, es.faceB);
        const blend = (v) => add(scale(Aw, Math.max(0, dot(Aw, v))), scale(Bw, Math.max(0, dot(Bw, v))));
        const flat = (v) => { const f = [v[0], v[1], v[2]]; f[dropped] = 0; return f; };
        let nraw, e;
        const positionCase = () => {
            nraw = blend(sub(Pw, o.pos));
            e = unit(flat(toBody(s.matrix, sub(o.pos, Pw))));
        };
        if (len(vrel) === 0)
            positionCase();
        else {
            vrel = sub(vrel, scale(u, dot(u, vrel)));
            nraw = blend(toWorld(s.matrix, vrel));
            e = scale(unit(flat(vrel)), -1);
            if (nraw[0] === 0 && nraw[1] === 0 && nraw[2] === 0)
                positionCase();
        }
        const n = unit(nraw);
        const ee = e;
        const side = [
            (ee[0] > 0 ? P2[0] : P1[0]) - H[0],
            (ee[1] > 0 ? P3[1] : P1[1]) - H[1],
            (ee[2] > 0 ? P1[2] : P11[2]) - H[2],
        ];
        const [a1, a2] = dropped === 1 ? [0, 2] : dropped === 2 ? [0, 1] : [1, 2];
        const t1 = Math.abs(side[a1] / ee[a1]), t2 = Math.abs(side[a2] / ee[a2]);
        const depth = t1 <= t2 || Number.isNaN(t1) || Number.isNaN(t2) ? Math.abs(n[a1] * side[a1]) : Math.abs(n[a2] * side[a2]);
        const C = add(H, scale(ee, depth));
        const j = cornerSlot(C) - 1;
        if (!(depth > s.depths[j]))
            return;
        s.contactPoints.set(C, j * 3);
        s.depths[j] = depth;
        s.normals.set(n, j * 3);
    };
    if (u[1] !== 0) {
        face(1, P1[1], [0, P1[0], P2[0]], [2, P11[2], P1[2]]);
        face(1, P3[1], [0, P3[0], P4[0]], [2, P10[2], P3[2]]);
    }
    if (u[2] !== 0 && count < 2) {
        face(2, P1[2], [0, P1[0], P2[0]], [1, P1[1], P3[1]]);
        face(2, P11[2], [0, P11[0], P12[0]], [1, P11[1], P9[1]]);
    }
    if (u[0] !== 0 && count < 2) {
        face(0, P1[0], [1, P1[1], P3[1]], [2, P11[2], P1[2]]);
        face(0, P2[0], [1, P2[1], P4[1]], [2, P12[2], P2[2]]);
    }
}
