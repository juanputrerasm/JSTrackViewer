import { truckRadius } from "../truck/recovery.js";
import { HULL_ORDER, WHEEL_ORDER, depthInside, faceNormal, nearestFace } from "./faces.js";
import { cornerNearTriangles, triangleBox, triHullPoints, triTireWall, triWheelSupport } from "../../cp4/truck-tri.js";
import { lastHub, pushPoint, setBoxForce, setTruckForce, toBody, toWorld, touched, truckMass, unit, } from "./truck-pair.js";
/**
 * The sphere and separating-axis early out (§14.14 step 1). A box that takes Community Patch 4's triangle path
 * (`rules`, `triangleBox`) is separated only past both its own faces and its model's triangles: CP4 widens each slab to
 * the shape's bounds in the box frame (OpenMTM2 docs/CP4_EXE_ANALYSIS.md 11.2, `FUN_1403af350` with `FUN_1401815f0`),
 * so a model that stands above its origin (a deck 16 ft tall on a box centred on its base, which reaches 8 ft up) is
 * still met above the box's top. Its pair sphere is CP4's too: twice the truck's radius and the box's (`FUN_1403767f0`).
 */
export function truckBoxSeparated(s, p, box, dt, rules) {
    const R = truckRadius(p);
    const tri = rules ? triangleBox(box, rules) : false;
    const dx = s.pos[0] - box.pos[0], dy = s.pos[1] - box.pos[1], dz = s.pos[2] - box.pos[2];
    const reach = tri ? 2 * (R + box.radius) : R + box.radius;
    if (dx * dx + dy * dy + dz * dz >= reach ** 2)
        return true;
    const d = toBody(box.matrix, dx, dy, dz);
    const iv = toWorld(s.matrix, s.bvel[0], s.bvel[1], s.bvel[2]);
    const v = toBody(box.matrix, iv[0] - box.vel[0], iv[1] - box.vel[1], iv[2] - box.vel[2]);
    const shape = tri ? box.shape : null;
    for (let k = 0; k < 3; k++) {
        const lo = shape ? Math.min(-box.half[k], shape.min[k]) : -box.half[k];
        const hi = shape ? Math.max(box.half[k], shape.max[k]) : box.half[k];
        if (d[k] <= 0) {
            const vk = v[k] < 0 ? 0 : v[k];
            if (d[k] + R + vk * dt < lo)
                return true;
        }
        else {
            const vk = v[k] > 0 ? 0 : v[k];
            if (d[k] - R + vk * dt > hi)
                return true;
        }
    }
    return false;
}
/**
 * A truck against a box (§14.14, §14.17): hull points, wheels and tire contact points, then the
 * box's corners against the wheels. An immovable box becomes ground for the truck; a pushable one
 * is pushed out and gets the inelastic force law, the truck the opposite force. Pair forces go to
 * `s.extForce` / `s.extMoment` (truck body axes) and `box.force` / `box.moment` (box axes).
 * `s.prevPos` and `s.prevMatrix` are the truck's pose before this step's move.
 */
export function collideTruckBox(s, p, box, dt, rules) {
    if (truckBoxSeparated(s, p, box, dt, rules))
        return null;
    const mt = truckMass(p);
    const pushable = box.mass !== 0 && box.mass < mt;
    const pair = { pushable, touch: { hit: null }, mEff: pushable ? box.mass : mt, box: null, truck: null };
    // Community Patch 4 tests a box with a usable shape by its triangles (sim/cp4/truck-tri.ts).
    const tri = triangleBox(box, rules);
    if (tri)
        triHullPoints(s, box, pair, dt);
    else
        hullPoints(s, box, pair, dt);
    // Wheels, tires 13 to 16 (FR, FL, RR, RL), sides -1, +1, -1, +1.
    for (let i = 0; i < 4; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        if (tri) {
            triWheelSupport(s, p, box, i, side, pair.touch, rules);
            triTireWall(s, p, box, i, pair, dt, rules);
        }
        else {
            wheelSuspension(s, p, box, i, side, pair.touch);
            tireContactPoint(s, p, box, i, pair, dt);
        }
    }
    if (box.mass > 0 && !truckBoxSeparated(s, p, box, dt, rules)) {
        for (let c = 0; c < 8; c++) {
            if (tri && !cornerNearTriangles(box, c, rules))
                continue;
            for (let i = 0; i < 4; i++)
                cornerAgainstWheel(s, p, box, c, i, pair, dt);
        }
    }
    if (pair.box) {
        for (let k = 0; k < 3; k++) {
            box.force[k] += pair.box.f[k];
            box.moment[k] += pair.box.m[k];
        }
    }
    if (pair.truck) {
        for (let k = 0; k < 3; k++) {
            s.extForce[k] += pair.truck.f[k];
            s.extMoment[k] += pair.truck.m[k];
        }
    }
    return pair.touch.hit;
}
/** The immovable case only, whatever the box's mass (ground boxes have none). Returns the contact, as `collideTruckBox`. */
export function collideTruckImmovableBox(s, p, box, dt, rules) {
    if (truckBoxSeparated(s, p, box, dt, rules))
        return null;
    const touch = { hit: null };
    const tri = triangleBox(box, rules);
    const hull = { pushable: false, touch, mEff: truckMass(p), box: null, truck: null };
    if (tri)
        triHullPoints(s, box, hull, dt);
    else
        hullPoints(s, box, hull, dt);
    for (let i = 0; i < 4; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const pair = { pushable: false, touch, mEff: 0, box: null, truck: null };
        if (tri) {
            triWheelSupport(s, p, box, i, side, touch, rules);
            triTireWall(s, p, box, i, pair, dt, rules);
        }
        else {
            wheelSuspension(s, p, box, i, side, touch);
            tireContactPoint(s, p, box, i, pair, dt);
        }
    }
    return touch.hit;
}
/** Hull points 1 to 12: rays from last step's reference point through each point now. */
function hullPoints(s, box, pair, dt) {
    const m = s.matrix, bm = box.matrix, half = box.half;
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
        const dir = unit([cur[0] - prevRef[0], cur[1] - prevRef[1], cur[2] - prevRef[2]]);
        const { face } = nearestFace(half, prevRef, dir, true, HULL_ORDER);
        if (face < 0)
            continue;
        const depth = depthInside(half, cur, face);
        if (depth <= s.depths[j])
            continue;
        const n = faceNormal(face);
        // A hull point deeper inside the box than its last contact (`0x4aad00`).
        if (depth > 0)
            touched(pair.touch, s, box, toWorld(bm, n[0], n[1], n[2]));
        if (!pair.pushable) {
            s.depths[j] = depth;
            s.normals.set(toWorld(bm, n[0], n[1], n[2]), j * 3);
        }
        else if (depth > 0 && pushPoint(s, box, body, cur, n, depth, pair, dt)) {
            reference();
        }
    }
}
/** The wheel's suspension against the box: driving on its top (§14.14 step 3). */
function wheelSuspension(s, p, box, i, side, touch) {
    const m = s.matrix, bm = box.matrix, half = box.half;
    const t = s.tires[i];
    const [ax, ay, az] = p.hubs[i];
    const r = p.tireRadiusFt, w = p.tireWidthFt;
    // Toward the bottom of the wheel at its static anchor now, from the hub last step.
    const bottom = toWorld(m, ax, ay - r, az);
    const from = lastHub(s, i);
    const toBottom = [s.pos[0] + bottom[0] - from[0], s.pos[1] + bottom[1] - from[1], s.pos[2] + bottom[2] - from[2]];
    const dir = unit(toBody(bm, toBottom[0], toBottom[1], toBottom[2]));
    const art = s.axles[i < 2 ? 0 : 1].articulation;
    const off = toWorld(m, Math.cos(art) * w * side * 0.5, Math.sin(art) * w * side * 0.5, 0);
    // Moved half the tire's width out along the axle.
    const origin = toBody(bm, from[0] - box.pos[0] + off[0], from[1] - box.pos[1] + off[1], from[2] - box.pos[2] + off[2]);
    const face = nearestFace(half, origin, dir, false, WHEEL_ORDER).face;
    if (face < 0)
        return;
    const out = faceNormal(face);
    const outWorld = toWorld(bm, out[0], out[1], out[2]);
    const outTruck = toBody(m, outWorld[0], outWorld[1], outWorld[2]);
    // Only a face that is mostly up or down in the truck frame counts; only up gives contact.
    if (Math.abs(outTruck[1]) <= 0.5 || outTruck[1] <= 0.5)
        return;
    const inY = -outTruck[1], inZ = -outTruck[2];
    const l = Math.hypot(inY, inZ);
    const ny = l === 0 ? 1 : inY / l, nz = l === 0 ? 0 : inZ / l;
    const px = w * side * 0.5 + ax;
    const point = [px, ay + r * ny, az + r * nz];
    const pw = toWorld(m, point[0], point[1], point[2]);
    const pb = toBody(bm, s.pos[0] + pw[0] - box.pos[0], s.pos[1] + pw[1] - box.pos[1], s.pos[2] + pw[2] - box.pos[2]);
    const pen = -(depthInside(half, pb, face) / inY);
    if (!(t.penetration < pen))
        return;
    if (pen > 0) {
        t.normal = outWorld;
        t.onGround = true;
        // Community Patch 4 records the prop for its bottoming rule (CP4_EXE_ANALYSIS.md 11.5); unused otherwise.
        t.propHeight = box.half[1] * 2;
        t.supportSource = 2;
        touched(touch, s, box, outWorld); // `0x4a5da0`
    }
    t.penetration = pen;
    t.lever = Math.hypot(r, px);
}
/** A tire contact point (13 to 16) against the box (§14.14 step 3, §14.17). */
function tireContactPoint(s, p, box, i, pair, dt) {
    const m = s.matrix, bm = box.matrix, half = box.half;
    const t = s.tires[i];
    const hubW = toWorld(m, t.hub[0], t.hub[1], t.hub[2]);
    // Along the hub's own move: from where it was last step, relative to the box's last position, to where it is now.
    const from = lastHub(s, i);
    const origin = toBody(bm, from[0] - (box.pos[0] - box.vel[0] * dt), from[1] - (box.pos[1] - box.vel[1] * dt), from[2] - (box.pos[2] - box.vel[2] * dt));
    const ray = toBody(bm, s.pos[0] + hubW[0] - from[0], s.pos[1] + hubW[1] - from[1], s.pos[2] + hubW[2] - from[2]);
    if (ray[0] === 0 && ray[1] === 0 && ray[2] === 0)
        return;
    /** The tire's contact point for a face: the face's normals, the point on the truck and in the box frame. */
    const contactAt = (f) => {
        const out = faceNormal(f);
        const outWorld = toWorld(bm, out[0], out[1], out[2]);
        const n = toBody(m, outWorld[0], outWorld[1], outWorld[2]);
        const reach = p.tireRadiusFt * Math.max(Math.abs(Math.sin(Math.atan2(n[2], n[1]))), Math.abs(Math.sin(Math.atan2(n[0], n[1]))));
        const side = -n[0] > 0 ? 1 : -1;
        const l = Math.hypot(n[1], n[2]);
        const ny = l === 0 ? 1 : -n[1] / l, nz = l === 0 ? 0 : -n[2] / l;
        const point = [t.hub[0] + p.tireWidthFt * side * 0.5, t.hub[1] + ny * reach, t.hub[2] + nz * reach];
        const pw = toWorld(m, point[0], point[1], point[2]);
        const pb = toBody(bm, s.pos[0] + pw[0] - box.pos[0], s.pos[1] + pw[1] - box.pos[1], s.pos[2] + pw[2] - box.pos[2]);
        return { out, outWorld, point, pb };
    };
    const face = nearestFace(half, origin, unit(ray), false, WHEEL_ORDER).face;
    if (face < 0)
        return;
    const { out, outWorld, point, pb } = contactAt(face);
    const depth = depthInside(half, pb, face);
    const j = 12 + i;
    if (!(s.depths[j] < depth))
        return;
    if (depth > 0)
        touched(pair.touch, s, box, outWorld); // `0x4a7fc0`
    if (pair.pushable) {
        if (depth > 0)
            pushPoint(s, box, point, pb, out, depth, pair, dt);
        return;
    }
    s.depths[j] = depth;
    s.normals.set(outWorld, j * 3);
    s.points.set(point, j * 3);
}
/**
 * A box corner against a wheel (§14.17, `0x49f920`): the corner's move this step, relative to the
 * truck, is cast against the wheel's two caps and its side. On a hit the box is moved so the
 * corner sits on the wheel, and the force law pushes box and truck apart.
 */
function cornerAgainstWheel(s, p, box, c, i, pair, dt) {
    const m = s.matrix, pm = s.prevMatrix, bm = box.matrix;
    const cb = [box.points[c * 3], box.points[c * 3 + 1], box.points[c * 3 + 2]];
    const cw = toWorld(bm, cb[0], cb[1], cb[2]);
    const W = [box.pos[0] + cw[0], box.pos[1] + cw[1], box.pos[2] + cw[2]];
    // The corner relative to the truck as it was last step, and as it is now (truck axes).
    const A = toBody(pm, W[0] - s.prevPos[0], W[1] - s.prevPos[1], W[2] - s.prevPos[2]);
    const B = toBody(m, W[0] - s.pos[0], W[1] - s.pos[1], W[2] - s.pos[2]);
    const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const L = Math.hypot(d[0], d[1], d[2]);
    if (L === 0)
        return;
    const u = [d[0] / L, d[1] / L, d[2] / L];
    const h = s.tires[i].hub;
    const r = p.tireRadiusFt, hw = p.tireWidthFt * 0.5;
    const BACK = 0.1;
    const hits = [];
    const at = (t) => [A[0] + u[0] * t, A[1] + u[1] * t, A[2] + u[2] * t];
    // The caps: planes across the axle (x) at the hub -+ half the width.
    if (u[0] !== 0) {
        for (const cx of [h[0] - hw, h[0] + hw]) {
            let t = (cx - A[0]) / u[0];
            if (!(t < L && t > 0))
                continue;
            t -= BACK;
            const P = at(t);
            if (Math.hypot(cx - P[0], h[1] - P[1], h[2] - P[2]) > r)
                continue;
            hits.push({ t, at: P });
        }
    }
    // The side: the circle of radius r about the axle, in the plane across it.
    const dl = Math.hypot(u[1], u[2]);
    if (dl > 0) {
        const nY = u[1] / dl, nZ = u[2] / dl;
        const mY = h[1] - A[1], mZ = h[2] - A[2];
        const sAlong = nY * mY + nZ * mZ;
        if (sAlong >= 0) {
            const disc = r * r - (mY * mY + mZ * mZ - sAlong * sAlong);
            if (disc >= 0) {
                const root = Math.sqrt(disc);
                const denom = u[1] * nY + u[2] * nZ;
                for (const t0 of [(sAlong - root) / denom, (sAlong + root) / denom]) {
                    if (!(t0 < L))
                        continue;
                    const t = t0 - BACK;
                    const P = at(t);
                    if (Math.abs(P[0] - h[0]) > hw)
                        continue;
                    hits.push({ t, at: P });
                }
            }
        }
    }
    let best = null;
    for (const hit of hits)
        if (hit.t > -BACK && (!best || hit.t < best.t))
            best = hit;
    if (!best)
        return;
    // Move the box so the corner sits on the wheel.
    const moveB = [best.at[0] - B[0], best.at[1] - B[1], best.at[2] - B[2]];
    const move = toWorld(m, moveB[0], moveB[1], moveB[2]);
    box.pos[0] += move[0];
    box.pos[1] += move[1];
    box.pos[2] += move[2];
    const ml = Math.hypot(move[0], move[1], move[2]);
    const nw = ml === 0 ? [0, 1, 0] : [move[0] / ml, move[1] / ml, move[2] / ml];
    const n = toBody(bm, nw[0], nw[1], nw[2]);
    // A corner against a wheel (`0x49f920`): the box was pushed along `nw`, so its face looks the other way.
    touched(pair.touch, s, box, [-nw[0], -nw[1], -nw[2]]);
    // The hub's velocity against the corner's, box axes.
    const [pr, qr, rr] = s.rates;
    const vh = [s.bvel[0] + (rr * h[2] - pr * h[1]), s.bvel[1] + (pr * h[0] - qr * h[2]), s.bvel[2] + (qr * h[1] - rr * h[0])];
    const vhw = toWorld(m, vh[0], vh[1], vh[2]);
    const vhb = toBody(bm, vhw[0], vhw[1], vhw[2]);
    const [pb, qb, rb] = box.rates;
    const vc = [box.bvel[0] + (rb * cb[2] - pb * cb[1]), box.bvel[1] + (pb * cb[0] - qb * cb[2]), box.bvel[2] + (qb * cb[1] - rb * cb[0])];
    const closing = (vhb[0] - vc[0]) * n[0] + (vhb[1] - vc[1]) * n[1] + (vhb[2] - vc[2]) * n[2];
    if (closing < 0) {
        // Nothing but a nudge, which wakes the box for its next step.
        box.force[1] += 0.01;
        return;
    }
    const F = (closing / dt) * pair.mEff;
    setBoxForce(pair, cb, [F * n[0], F * n[1], F * n[2]]);
    const fw = toWorld(bm, -F * n[0], -F * n[1], -F * n[2]);
    setTruckForce(pair, [h[0], h[1], h[2]], toBody(m, fw[0], fw[1], fw[2]));
}
