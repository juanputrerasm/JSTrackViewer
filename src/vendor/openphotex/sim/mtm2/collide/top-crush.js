/*
  Top-crush cars (MTM2_PHYSICS.md §7.6, §14.27): two boxes sharing one rotation, the body and the
  cab. Neither moves. A truck's hull points, tire points and wheels against their faces make
  ground contacts, as boxes do (§14.14); their 24 edges go to the edge system (§14.26). A contact
  more than 0.625 ft into the cab's roof lowers the roof by 15% of the excess, never below the
  body's top plus 0.25 ft, and the crushed fraction drives the cab's keyframed model. The body's
  own crush limit is 0, so it never crushes. No stock SIT has a top-crush car.
*/
import { eulerToMatrix } from "../math.js";
import { truckWeight } from "../truck/dynamics.js";
import { truckRadius } from "../truck/recovery.js";
import { edgeAgainstTruck } from "./edges.js";
const toWorld = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const toBody = (m, v) => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l === 0 ? [0, 1, 0] : [a[0] / l, a[1] / l, a[2] / l]; };
/** A car at load (`0x54a000`): a model's bounds replace that part's sizes (length z, width x, height y). */
export function createTopCrush(src, bodyBounds = null, cabBounds = null) {
    const sizes = (bounds, size) => bounds ? [bounds.max[2] - bounds.min[2], bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]] : [size?.[0] ?? 0, size?.[1] ?? 0, size?.[2] ?? 0];
    const [L, W, H] = sizes(bodyBounds, src.sizeFt);
    const [L2, W2, H2] = sizes(cabBounds, src.size2Ft);
    const wrap = (v) => (v < 0 ? v + 8192 : v);
    const pos = [wrap(src.positionFt[0]), src.positionFt[1], wrap(src.positionFt[2])];
    const pos2 = [wrap(src.position2Ft[0]), pos[1] - H / 2 + H2 / 2, wrap(src.position2Ft[2])];
    const matrix = new Float64Array(9);
    eulerToMatrix(src.theta, src.phi, src.psi, matrix);
    return {
        pos, pos2, matrix,
        body: { a: W / 2, b: L / 2, bottom: -H / 2, top: H / 2, height: H },
        cab: { a: W2 / 2, b: L2 / 2, bottom: -H2 / 2, top: H2 / 2, height: H2 },
        mass: src.mass,
        bvel: [src.bvel[0], src.bvel[1], src.bvel[2]],
        rates: [src.rates[0], src.rates[1], src.rates[2]],
        radius: Math.sqrt(H2 * H2 + L * L + W * W),
        crush: 0,
    };
}
/** The part's eight corners in the box order of §14.15, car axes about its centre. */
export function crushCorners(part) {
    const { a, b, bottom: lo, top: hi } = part;
    return [[-a, lo, b], [a, lo, b], [-a, hi, b], [a, hi, b], [-a, hi, -b], [a, hi, -b], [-a, lo, -b], [a, lo, -b]];
}
// Faces: 0 left (-x), 1 right (+x), 2 bottom, 3 top, 4 front (+z), 5 back (-z).
const HULL_ORDER = [2, 3, 4, 5, 0, 1];
const WHEEL_ORDER = [0, 1, 2, 3, 4, 5];
const AXIS = [0, 0, 1, 1, 2, 2];
const OUT = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]];
const TOP = 3;
function bounds(part) {
    return { lo: [-part.a, part.bottom, -part.b], hi: [part.a, part.top, part.b] };
}
/** The face a ray crosses first (at most two crossings counted; later faces win ties), or -1. */
function nearestFace(part, origin, dir, directional, order) {
    const { lo, hi } = bounds(part);
    let best = 999999, face = -1, crossings = 0;
    for (const f of order) {
        const axis = AXIS[f], sign = OUT[f][axis];
        if (dir[axis] === 0 || crossings >= 2)
            continue;
        const plane = sign > 0 ? hi[axis] : lo[axis];
        const t = (plane - origin[axis]) / dir[axis];
        const u = (axis + 1) % 3, v = (axis + 2) % 3;
        const pu = origin[u] + dir[u] * t, pv = origin[v] + dir[v] * t;
        if (!(lo[u] < pu && pu < hi[u] && lo[v] < pv && pv < hi[v]))
            continue;
        crossings++;
        const at = Math.abs(t);
        if (directional ? !(at <= best && t > 0 && dir[axis] * sign < 0) : !(at <= best))
            continue;
        best = at;
        face = f;
    }
    return face;
}
/** A point's depth inside a face (positive inside), car axes about the part's centre. */
function depthInside(part, p, face) {
    const { lo, hi } = bounds(part);
    const axis = AXIS[face];
    return OUT[face][axis] > 0 ? hi[axis] - p[axis] : p[axis] - lo[axis];
}
/**
 * The crush rule for a contact `depth` into a part's top (§14.27.5). Returns the depth, lowered
 * by whatever the roof came down.
 */
function crush(car, cab, depth, s, ctx) {
    if (depth <= 0.25)
        return depth;
    const excess = depth - 0.25 - 0.375;
    if (excess <= 0)
        return depth;
    let e = 0.15 * excess;
    if (!cab) {
        // The body's floor is its top minus half its height: 0, so it never crushes.
        e = Math.min(e, car.body.top - 0.5 * car.body.height);
        if (e <= 0)
            return depth;
        car.body.top -= e;
        car.cab.top -= e;
    }
    else {
        const n = ctx.groundNormal(car.pos[0], car.pos[2]);
        const floor = (car.body.top - car.pos2[1] + car.pos[1] + 0.25) / n[1];
        if (car.cab.top - e < floor)
            e = car.cab.top - floor;
        if (e <= 0)
            return depth;
        car.cab.top -= e;
    }
    car.crush = 1 - (car.cab.top - car.cab.bottom) / car.cab.height;
    for (let j = 0; j < 16; j++)
        s.depths[j] -= e;
    return depth - e;
}
/** The face normals the edge system gets with each of a part's 12 edges (§14.27.4): [ends, B, A]. */
const EDGES = [
    [0, 1, [0, 0, 1], [0, -1, 0]], [0, 2, [0, 0, 1], [0, 0, -1]], [0, 6, [0, -1, 0], [-1, 0, 0]],
    [4, 2, [-1, 0, 0], [0, 1, 0]], [4, 5, [0, 0, -1], [0, 1, 0]], [4, 6, [0, 0, -1], [-1, 0, 0]],
    [3, 1, [0, 0, 1], [1, 0, 0]], [3, 2, [0, 0, 1], [0, 1, 0]], [3, 5, [0, 1, 0], [1, 0, 0]],
    [7, 1, [0, -1, 0], [1, 0, 0]], [7, 5, [0, 0, -1], [1, 0, 0]], [7, 6, [0, 0, -1], [0, -1, 0]],
];
/**
 * A truck against a top-crush car (`0x489f90`, §14.27.4): the mass class, hull points, wheels and
 * tire points against both parts, then the edges; the edge contacts' last force goes to the truck.
 */
export function collideTruckTopCrush(car, s, p, ctx) {
    // The broadphase: bounding spheres (§14.27.4).
    if (!(Math.hypot(...sub(s.pos, car.pos)) < car.radius + truckRadius(p)))
        return;
    const mTruck = truckWeight(p) * 0.031081;
    if (car.mass !== 0 && car.mass < mTruck) {
        ctx.edges.mover = 1;
        ctx.edges.mEff = Math.max(car.mass, 1);
    }
    else {
        ctx.edges.mover = 2;
        ctx.edges.mEff = mTruck;
    }
    const M = car.matrix, Mt = s.matrix;
    const dt = ctx.dt;
    // Hull points: one reference, the same for both boxes (both centred on the body, §14.27.4).
    const d = sub(s.pos, car.pos);
    const iv = toWorld(Mt, s.bvel);
    const Rf = toBody(M, sub(d, scale(iv, dt)));
    for (let j = 0; j < 12; j++) {
        const pj = [s.points[j * 3], s.points[j * 3 + 1], s.points[j * 3 + 2]];
        const Q = toBody(M, add(d, toWorld(Mt, pj)));
        const u = unit(sub(Q, Rf));
        for (const cab of [false, true]) {
            const part = cab ? car.cab : car.body;
            const face = nearestFace(part, Rf, u, true, HULL_ORDER);
            if (face < 0)
                continue;
            let depth = depthInside(part, Q, face);
            if (!(depth > s.depths[j]))
                continue;
            if (face === TOP)
                depth = crush(car, cab, depth, s, ctx);
            s.depths[j] = depth;
            s.normals.set(toWorld(M, OUT[face]), j * 3);
        }
    }
    // Wheels: the suspension test, then the tire contact point, body then cab.
    for (let i = 0; i < 4; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        for (const cab of [false, true]) {
            const part = cab ? car.cab : car.body;
            const C = cab ? car.pos2 : car.pos;
            wheelOnPart(car, part, cab, C, s, p, i, side, ctx);
            tirePointOnPart(car, part, cab, C, s, p, i, ctx);
        }
    }
    // The edges, body then cab; the pair applies the last edge force record (§14.27.4 step 3).
    let forces = null;
    const obstacleRates = [car.rates[1], car.rates[2], car.rates[0]];
    for (const cab of [false, true]) {
        const part = cab ? car.cab : car.body;
        const C = cab ? car.pos2 : car.pos;
        const W = crushCorners(part).map((c) => add(C, toWorld(M, c)));
        const obstacle = { pos: C, matrix: M, vel: car.bvel, rates: obstacleRates };
        for (const [k0, k1, B, A] of EDGES) {
            ctx.edges.faceA = A;
            ctx.edges.faceB = B;
            forces = edgeAgainstTruck(W[k0], W[k1], obstacle, s, p, ctx.edges, ctx) ?? forces;
        }
    }
    if (forces) {
        for (let k = 0; k < 3; k++) {
            s.extForce[k] += forces.truck.f[k];
            s.extMoment[k] += forces.truck.m[k];
        }
    }
}
/** The suspension test against a part (`0x4b46f0`, `0x4b80c0`) and its apply step. */
function wheelOnPart(car, part, cab, C, s, p, i, side, ctx) {
    const M = car.matrix, Mt = s.matrix;
    const t = s.tires[i];
    const A = p.hubs[i];
    const r = p.tireRadiusFt, w = p.tireWidthFt;
    const S = s.prevPos;
    const Wb = add(s.pos, toWorld(Mt, [A[0], A[1] - r, A[2]]));
    const u = unit(toBody(M, sub(Wb, S)));
    const art = s.axles[i < 2 ? 0 : 1].articulation;
    const ca = Math.sin(art), sa = Math.cos(art);
    const o = toWorld(Mt, [ca * r + sa * side * w / 2, ca * side * w / 2 - sa * r, 0]);
    const Rf = toBody(M, add(sub(S, C), o));
    const face = nearestFace(part, Rf, u, false, WHEEL_ORDER);
    if (face < 0)
        return;
    const nIn = scale(OUT[face], -1);
    const nt = toBody(Mt, toWorld(M, nIn));
    if (!(Math.abs(nt[1]) > 0.5) || !(nt[1] < -0.5))
        return;
    const l = Math.hypot(nt[1], nt[2]);
    const [cy, cz] = l === 0 ? [1, 0] : [nt[1] / l, nt[2] / l];
    const Pc = [A[0] + side * w / 2, A[1] + r * cy, A[2] + r * cz];
    const Q = toBody(M, sub(add(s.pos, toWorld(Mt, Pc)), C));
    let pen = -depthInside(part, Q, face) / nt[1];
    if (!(pen > t.penetration))
        return;
    if (pen > 0) {
        pen = crush(car, cab, pen, s, ctx);
        t.normal = toWorld(M, OUT[face]);
        t.onGround = true;
    }
    t.penetration = pen;
    t.lever = Math.hypot(r, A[0] + side * w / 2);
}
/** The tire contact point against a part (`0x4b6350`, `0x4b9d20`): slots 13 to 16. */
function tirePointOnPart(car, part, cab, C, s, p, i, ctx) {
    const M = car.matrix, Mt = s.matrix;
    const t = s.tires[i];
    const r = p.tireRadiusFt, w = p.tireWidthFt;
    const S = s.prevPos;
    const H = toWorld(Mt, t.hub);
    const Rf = toBody(M, sub(S, C));
    const ray = toBody(M, sub(add(s.pos, H), S));
    if (ray[0] === 0 && ray[1] === 0 && ray[2] === 0)
        return;
    const face = nearestFace(part, Rf, unit(ray), false, WHEEL_ORDER);
    if (face < 0)
        return;
    const nw = toWorld(M, scale(OUT[face], -1));
    const nt = toBody(Mt, nw);
    const a1 = Math.atan2(-nt[2], -nt[1]), a2 = Math.atan2(-nt[0], -nt[1]);
    const K = r * Math.max(Math.abs(Math.sin(a1)), Math.abs(Math.sin(a2)));
    const sx = nt[0] > 0 ? 1 : -1;
    const l = Math.hypot(nt[1], nt[2]);
    const [ey, ez] = l === 0 ? [1, 0] : [nt[1] / l, nt[2] / l];
    const Pt = [t.hub[0] + w * sx / 2, t.hub[1] + K * ey, t.hub[2] + K * ez];
    const Q = toBody(M, sub(add(s.pos, toWorld(Mt, Pt)), C));
    let depth = depthInside(part, Q, face);
    const j = 12 + i;
    if (!(depth > s.depths[j]))
        return;
    if (face === TOP)
        depth = crush(car, cab, depth, s, ctx);
    s.depths[j] = depth;
    s.normals.set(scale(nw, -1), j * 3);
    s.points.set(Pt, j * 3);
}
