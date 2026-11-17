import { HULL_ORDER, depthInside, faceNormal, nearestFace } from "../mtm2/collide/faces.js";
import { lastHub, pushPoint, toBody, toWorld, touched, truckMass, unit, } from "../mtm2/collide/truck-pair.js";
import { cylinderQuery, pointDistance, rayQuery, shapeUsable } from "./coll-shape.js";
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Whether a box takes the triangle path under these rules (11.2). */
export function triangleBox(box, rules) {
    return rules?.collisionMode === 1 && !!rules.triangles && !box.ground && box.type !== -1 && shapeUsable(box.shape);
}
/** The box's height, ft (box +0x6C), and whether it is a small prop for a tire of radius `r` (11.1). */
function boxHeight(box) {
    return box.half[1] * 2;
}
function smallProp(box, rules, r) {
    const h = boxHeight(box);
    return h > 0 && h < (rules.smallPropRatio ?? 2) * r;
}
/* ---------- hull points 1-12 (11.7) ---------- */
/** Hull points 1 to 12 against the triangles: a ray from last step's reference point to each point now. */
export function triHullPoints(s, box, pair, dt) {
    const m = s.matrix, bm = box.matrix;
    const iv = toWorld(m, s.bvel[0], s.bvel[1], s.bvel[2]);
    const lift = toWorld(m, 0, s.points[2 * 3 + 1] * 0.5, 0);
    let rel = [0, 0, 0], prevRef = [0, 0, 0];
    const reference = () => {
        rel = [s.pos[0] - box.pos[0], s.pos[1] - box.pos[1], s.pos[2] - box.pos[2]];
        prevRef = toBody(bm, rel[0] - (iv[0] - box.vel[0]) * dt + lift[0], rel[1] - (iv[1] - box.vel[1]) * dt + lift[1], rel[2] - (iv[2] - box.vel[2]) * dt + lift[2]);
    };
    reference();
    for (let j = 0; j < 12; j++) {
        const body = [s.points[j * 3], s.points[j * 3 + 1], s.points[j * 3 + 2]];
        const w = toWorld(m, body[0], body[1], body[2]);
        const cur = toBody(bm, rel[0] + w[0], rel[1] + w[1], rel[2] + w[2]);
        const ray = [cur[0] - prevRef[0], cur[1] - prevRef[1], cur[2] - prevRef[2]];
        const L = Math.hypot(ray[0], ray[1], ray[2]);
        let n, depth;
        if (L === 0) {
            // A zero-length ray takes the box faces, as MTM2 (11.7).
            const { face } = nearestFace(box.half, prevRef, unit(ray), true, HULL_ORDER);
            if (face < 0)
                continue;
            depth = depthInside(box.half, cur, face);
            n = faceNormal(face);
        }
        else {
            const hit = rayQuery(box.shape, prevRef, [ray[0] / L, ray[1] / L, ray[2] / L], L);
            if (!hit)
                continue;
            n = hit.normal;
            depth = dot(n, [hit.point[0] - cur[0], hit.point[1] - cur[1], hit.point[2] - cur[2]]);
        }
        if (depth <= s.depths[j])
            continue;
        const nw = toWorld(bm, n[0], n[1], n[2]);
        if (depth > 0)
            touched(pair.touch, s, box, nw);
        if (!pair.pushable) {
            s.depths[j] = depth;
            s.normals.set(nw, j * 3);
        }
        else if (depth > 0 && pushPoint(s, box, body, cur, n, depth, pair, dt)) {
            reference();
        }
    }
}
/* ---------- the wheel's support (11.4, 11.5) ---------- */
/** The nine spokes: cos and sin of the angle below the hub, and the sidewall (0, +1, -1). */
const SPOKES = [
    [1, 0, 0],
    [0.9239, 0.3827, 0], [0.9239, -0.3827, 0],
    [0.7071, 0.7071, 0], [0.7071, -0.7071, 0],
    [1, 0, 1], [1, 0, -1],
    [0.7071, 0, 1], [0.7071, 0, -1],
];
/** The cylinder's hold slots (11.5), by box and tire; a box that goes away takes its slots with it. */
const HOLDS = new WeakMap();
/** Clear every hold this box keeps (a box removed or reset). */
export function clearHolds(box) {
    HOLDS.delete(box);
}
/**
 * A support candidate from a hit on the triangles: the face's normal (box frame, facing the hub) and the
 * point hit (box frame). Null when the face does not point up in the truck's frame or the profile rejects it.
 */
function supportFrom(s, p, box, i, side, tr, nBox, hitBox) {
    const m = s.matrix, bm = box.matrix;
    const [ax, ay, az] = p.hubs[i];
    const r = p.tireRadiusFt, w = p.tireWidthFt;
    const nw = toWorld(bm, nBox[0], nBox[1], nBox[2]);
    const nt = toBody(m, nw[0], nw[1], nw[2]);
    // The face must point up at least 60 degrees in the truck's frame (n_in.y < -0.5).
    if (!(nt[1] > 0.5))
        return null;
    const inY = -nt[1], inZ = -nt[2];
    const l = Math.hypot(inY, inZ);
    const ny = l === 0 ? 1 : inY / l, nz = l === 0 ? 0 : inZ / l;
    const P = [ax + side * w * 0.5, ay + r * ny, az + r * nz];
    const pw = toWorld(m, P[0], P[1], P[2]);
    const hw = toWorld(bm, hitBox[0], hitBox[1], hitBox[2]);
    const hitW = [box.pos[0] + hw[0], box.pos[1] + hw[1], box.pos[2] + hw[2]];
    const d = [hitW[0] - (s.pos[0] + pw[0]), hitW[1] - (s.pos[1] + pw[1]), hitW[2] - (s.pos[2] + pw[2])];
    let pen = dot(d, nw) / nt[1];
    if (tr.supportProfile) {
        // The wheel's own circle at the hit: within the tread (plus 0.5 ft) and inside the radius along z.
        const ht = toBody(m, hitW[0] - s.pos[0], hitW[1] - s.pos[1], hitW[2] - s.pos[2]);
        const dz = ht[2] - az;
        if (Math.abs(ht[0] - ax) > w * 0.5 + 0.5 || !(dz * dz < r * r))
            return null;
        pen = Math.min(pen, ht[1] - ay + Math.sqrt(r * r - dz * dz));
    }
    return { normalWorld: nw, penetration: pen };
}
/**
 * The wheel's support from the box's triangles (11.4, 11.5): the nine spokes, then the cylinder, then the
 * hold; the winner goes to the tire under MTM2's rule that the deepest support wins.
 */
export function triWheelSupport(s, p, box, i, side, touch, rules) {
    const tr = rules.triangles;
    const m = s.matrix, bm = box.matrix;
    const t = s.tires[i];
    const [ax, ay, az] = p.hubs[i];
    const r = p.tireRadiusFt, w = p.tireWidthFt;
    const from = lastHub(s, i);
    const art = s.axles[i < 2 ? 0 : 1].articulation;
    const off = toWorld(m, Math.cos(art) * w * side * 0.5, Math.sin(art) * w * side * 0.5, 0);
    // The inner sidewall plane, as MTM2's box support (11.4).
    const origin = toBody(bm, from[0] - box.pos[0] + off[0], from[1] - box.pos[1] + off[1], from[2] - box.pos[2] + off[2]);
    let best = null;
    const spokes = Math.max(1, Math.min(9, Math.trunc(tr.supportSpokes)));
    for (let k = 0; k < spokes; k++) {
        const [cy, cz, sx] = SPOKES[k];
        const e = toWorld(m, ax + sx * w * 0.5, ay - r * cy, az + r * cz);
        const vec = [s.pos[0] + e[0] - from[0], s.pos[1] + e[1] - from[1], s.pos[2] + e[2] - from[2]];
        const L = Math.hypot(vec[0], vec[1], vec[2]);
        if (L === 0)
            continue;
        const dir = toBody(bm, vec[0] / L, vec[1] / L, vec[2] / L);
        const hit = rayQuery(box.shape, origin, dir, L);
        if (!hit)
            continue;
        const c = supportFrom(s, p, box, i, side, tr, hit.normal, hit.point);
        if (!c)
            continue;
        if (!best) {
            best = { ...c, t: hit.t };
            continue;
        }
        const pick = tr.supportProfile ? 0 : tr.supportPick;
        const better = pick === 1 ? hit.t < best.t : pick === 2 ? c.penetration < best.penetration : c.penetration > best.penetration;
        if (better)
            best = { ...c, t: hit.t };
    }
    if (!best && tr.supportCylinder) {
        const axis = toBody(bm, m[0], m[3], m[6]);
        const hit = cylinderQuery(box.shape, origin, axis, r, w * 0.5, tr.supportSlackFt, tr.cylinderTreadClip);
        if (hit && hit.penetration > 0) {
            const c = supportFrom(s, p, box, i, side, tr, hit.normal, hit.point);
            if (c && c.penetration > 0) {
                best = { ...c, t: 0 };
                if (tr.supportCylHoldTicks > 0) {
                    let slots = HOLDS.get(box);
                    if (!slots)
                        HOLDS.set(box, (slots = new Map()));
                    slots.set(t, { normal: c.normalWorld, penetration: c.penetration, pos: [s.pos[0], s.pos[1], s.pos[2]], ticks: tr.supportCylHoldTicks });
                }
            }
        }
        if (!best && tr.supportCylHoldTicks > 0) {
            const h = HOLDS.get(box)?.get(t);
            if (h && h.ticks > 0 && Math.hypot(s.pos[0] - h.pos[0], s.pos[1] - h.pos[1], s.pos[2] - h.pos[2]) <= r) {
                best = { normalWorld: h.normal, penetration: (h.penetration * h.ticks) / tr.supportCylHoldTicks, t: 0 };
                h.ticks--;
            }
        }
    }
    if (!best)
        return;
    let pen = best.penetration;
    if (tr.supportComprMaxFt > 0 && pen > tr.supportComprMaxFt && (!tr.supportClampSmall || smallProp(box, rules, r))) {
        pen = tr.supportComprMaxFt;
    }
    if (!(t.penetration < pen))
        return;
    if (pen > 0) {
        t.normal = best.normalWorld;
        t.onGround = true;
        t.propHeight = boxHeight(box);
        t.supportSource = 3;
        touched(touch, s, box, best.normalWorld);
    }
    t.penetration = pen;
    t.lever = Math.hypot(r, ax + side * w * 0.5);
}
/* ---------- the tire's wall contact (11.6) ---------- */
/** The nine wall rays: down, forward, sidewall (times r, r, w/2) in the articulated axle frame. */
const WALL_RAYS = [
    [1, 0, 0],
    [0.7071, 0.7071, 0], [0.7071, -0.7071, 0],
    [0, 1, 0], [0, -1, 0],
    [1, 0, 1], [1, 0, -1],
    [0, 0, 1], [0, 0, -1],
];
const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : (3 - 2 * x) * x * x);
/** Tire `i`'s wall contact (point 13 + i) against the box's triangles. */
export function triTireWall(s, p, box, i, pair, dt, rules) {
    const tr = rules.triangles;
    const m = s.matrix, bm = box.matrix;
    const t = s.tires[i];
    const r = p.tireRadiusFt, w = p.tireWidthFt;
    const hubW = toWorld(m, t.hub[0], t.hub[1], t.hub[2]);
    const hubNow = [s.pos[0] + hubW[0], s.pos[1] + hubW[1], s.pos[2] + hubW[2]];
    const from = lastHub(s, i);
    const boxLast = [box.pos[0] - box.vel[0] * dt, box.pos[1] - box.vel[1] * dt, box.pos[2] - box.vel[2] * dt];
    const origin = toBody(bm, from[0] - boxLast[0], from[1] - boxLast[1], from[2] - boxLast[2]);
    const art = s.axles[i < 2 ? 0 : 1].articulation;
    const ca = Math.cos(art), sa = Math.sin(art);
    const pushable = pair.pushable;
    /** The tire's contact point for a face normal (box frame, facing the hub): MTM2's rule with r_eff (11.6). */
    const contactFor = (nBox, hitBox) => {
        const nw = toWorld(bm, nBox[0], nBox[1], nBox[2]);
        const n = toBody(m, nw[0], nw[1], nw[2]);
        const reach = r * Math.max(Math.abs(Math.sin(Math.atan2(n[2], n[1]))), Math.abs(Math.sin(Math.atan2(n[0], n[1]))));
        const side = -n[0] > 0 ? 1 : -1;
        const l = Math.hypot(n[1], n[2]);
        const ny = l === 0 ? 1 : -n[1] / l, nz = l === 0 ? 0 : -n[2] / l;
        const point = [t.hub[0] + w * side * 0.5, t.hub[1] + ny * reach, t.hub[2] + nz * reach];
        const pw = toWorld(m, point[0], point[1], point[2]);
        const pWorld = [s.pos[0] + pw[0], s.pos[1] + pw[1], s.pos[2] + pw[2]];
        const hw = toWorld(bm, hitBox[0], hitBox[1], hitBox[2]);
        const hitW = [box.pos[0] + hw[0], box.pos[1] + hw[1], box.pos[2] + hw[2]];
        const depth = dot([hitW[0] - pWorld[0], hitW[1] - pWorld[1], hitW[2] - pWorld[2]], nw);
        const pb = toBody(bm, pWorld[0] - box.pos[0], pWorld[1] - box.pos[1], pWorld[2] - box.pos[2]);
        return { nBox, nw, nTruck: n, point, pWorld, pb, hitW, depth };
    };
    let wall = null;
    for (const [D, F, X] of WALL_RAYS) {
        // r D down + r F forward + (w/2) X along the axle, in the articulated axle frame.
        const ob = [r * D * sa + (w * 0.5) * X * ca, -r * D * ca + (w * 0.5) * X * sa, r * F];
        const ow = toWorld(m, ob[0], ob[1], ob[2]);
        const vec = [hubNow[0] + ow[0] - from[0], hubNow[1] + ow[1] - from[1], hubNow[2] + ow[2] - from[2]];
        const L = Math.hypot(vec[0], vec[1], vec[2]);
        if (L === 0)
            continue;
        const dir = toBody(bm, vec[0] / L, vec[1] / L, vec[2] / L);
        const hit = rayQuery(box.shape, origin, dir, L);
        if (!hit)
            continue;
        const c = contactFor(hit.normal, hit.point);
        // A drivable face under a supported tire is a spring, not a wall (wallSkipDrivable).
        const drivable = c.nTruck[1] > 0.5 || (tr.wallShortPropPct > 0 && boxHeight(box) < tr.wallShortPropPct * r);
        if (tr.wallSkipDrivable && drivable && t.penetration > 0 && c.depth > 0)
            continue;
        if (!wall || c.depth > wall.depth)
            wall = c;
    }
    if (!wall && tr.wallCylinder && pushable) {
        const axis = toBody(bm, m[0], m[3], m[6]);
        const so = toBody(bm, from[0] - box.pos[0], from[1] - box.pos[1], from[2] - box.pos[2]);
        const hit = cylinderQuery(box.shape, so, axis, r, w * 0.5, tr.supportSlackFt, tr.cylinderTreadClip);
        if (hit && hit.penetration > 0)
            wall = contactFor(hit.normal, hit.point);
    }
    if (!wall)
        return;
    const j = 12 + i;
    if (!(s.depths[j] < wall.depth))
        return;
    if (wall.depth > 0)
        touched(pair.touch, s, box, wall.nw);
    if (pushable) {
        if (wall.depth > 0)
            pushPoint(s, box, wall.point, wall.pb, wall.nBox, wall.depth, pair, dt);
        return;
    }
    let n = wall.nw;
    if (tr.climbBlend) {
        // Round the edge: a hub above the hit climbs (11.6 step 2).
        const R = tr.dropFromHit ? wall.hitW : wall.pWorld;
        const f = Math.max(0, Math.min(1, (hubNow[1] - R[1]) / r));
        const u = unit([hubNow[0] - R[0], hubNow[1] - R[1], hubNow[2] - R[2]]);
        const allowed = !tr.climbLiftGuard || n[1] < u[1];
        if (allowed && dot(u, n) > 0) {
            const b = smoothstep((f - tr.climbBlendLo) / (tr.climbBlendHi - tr.climbBlendLo));
            n = unit([(1 - b) * n[0] + b * u[0], (1 - b) * n[1] + b * u[1], (1 - b) * n[2] + b * u[2]]);
        }
    }
    let depth = Math.min(wall.depth, tr.wallComprMaxFt);
    if (tr.wallDampRefFtPerSec > 0) {
        const iv = toWorld(m, s.bvel[0], s.bvel[1], s.bvel[2]);
        const vn = dot(iv, n);
        if (vn > 0)
            depth *= Math.max(0, 1 - vn / tr.wallDampRefFtPerSec);
    }
    depth *= tr.wallCorrect;
    s.depths[j] = depth;
    s.normals.set(n, j * 3);
    s.points.set(wall.point, j * 3);
}
/* ---------- box corners against the wheels: phantom corners (11.8) ---------- */
/** Whether box corner `c` is near enough the triangles to be tested against the tires. */
export function cornerNearTriangles(box, c, rules) {
    const limit = rules.triangles.phantomCornerFt;
    if (!(limit > 0) || !(box.mass > 0))
        return true;
    const sh = box.shape;
    const layout = box.points;
    let cache = sh.corners;
    const stale = !cache || cache.layout.length !== layout.length
        || cache.layout.some((v, k) => Math.abs(v - layout[k]) > 0.01);
    if (stale) {
        if (cache)
            return true; // a box laid out differently from the cached one: every corner is tested
        const dist = new Float64Array(8);
        for (let k = 0; k < 8; k++)
            dist[k] = pointDistance(sh, [layout[k * 3], layout[k * 3 + 1], layout[k * 3 + 2]]);
        cache = sh.corners = { layout: Float64Array.from(layout), dist };
    }
    return cache.dist[c] <= limit;
}
export { truckMass };
