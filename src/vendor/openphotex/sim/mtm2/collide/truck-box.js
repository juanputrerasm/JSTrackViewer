import { truckRadius } from "../truck/recovery.js";
import { truckWeight } from "../truck/dynamics.js";
import { INV_G } from "../constants.js";
import { HULL_ORDER, WHEEL_ORDER, depthInside, faceNormal, nearestFace } from "./faces.js";
const toWorld = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
const toBody = (m, x, y, z) => [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
/** The sphere and separating-axis early out (§14.14 step 1). */
export function truckBoxSeparated(s, p, box, dt) {
    const R = truckRadius(p);
    const dx = s.pos[0] - box.pos[0], dy = s.pos[1] - box.pos[1], dz = s.pos[2] - box.pos[2];
    if (dx * dx + dy * dy + dz * dz >= (R + box.radius) ** 2)
        return true;
    const d = toBody(box.matrix, dx, dy, dz);
    const iv = toWorld(s.matrix, s.bvel[0], s.bvel[1], s.bvel[2]);
    const v = toBody(box.matrix, iv[0] - box.vel[0], iv[1] - box.vel[1], iv[2] - box.vel[2]);
    for (let k = 0; k < 3; k++) {
        if (d[k] <= 0) {
            const vk = v[k] < 0 ? 0 : v[k];
            if (d[k] + R + vk * dt < -box.half[k])
                return true;
        }
        else {
            const vk = v[k] > 0 ? 0 : v[k];
            if (d[k] - R + vk * dt > box.half[k])
                return true;
        }
    }
    return false;
}
/** The truck's mass in slugs. */
function truckMass(p) {
    return truckWeight(p) * INV_G;
}
/** Records a contact along `normalWorld` (outward from the box), at the truck's speed against the box. */
function touched(touch, s, box, normalWorld) {
    const iv = toWorld(s.matrix, s.bvel[0], s.bvel[1], s.bvel[2]);
    const closing = -((iv[0] - box.vel[0]) * normalWorld[0] + (iv[1] - box.vel[1]) * normalWorld[1] + (iv[2] - box.vel[2]) * normalWorld[2]);
    const speed = closing > 0 ? closing : 0;
    if (!touch.hit)
        touch.hit = { speed };
    else if (speed > touch.hit.speed)
        touch.hit.speed = speed;
}
/**
 * A truck against a box (§14.14, §14.17): hull points, wheels and tire contact points, then the
 * box's corners against the wheels. An immovable box becomes ground for the truck; a pushable one
 * is pushed out and gets the inelastic force law, the truck the opposite force. Pair forces go to
 * `s.extForce` / `s.extMoment` (truck body axes) and `box.force` / `box.moment` (box axes).
 * `s.prevPos` and `s.prevMatrix` are the truck's pose before this step's move.
 */
export function collideTruckBox(s, p, box, dt) {
    if (truckBoxSeparated(s, p, box, dt))
        return null;
    const mt = truckMass(p);
    const pushable = box.mass !== 0 && box.mass < mt;
    const pair = { pushable, touch: { hit: null }, mEff: pushable ? box.mass : mt, box: null, truck: null };
    hullPoints(s, box, pair, dt);
    // Wheels, tires 13 to 16 (FR, FL, RR, RL), sides -1, +1, -1, +1.
    for (let i = 0; i < 4; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        wheelSuspension(s, p, box, i, side, pair.touch);
        tireContactPoint(s, p, box, i, pair, dt);
    }
    if (box.mass > 0 && !truckBoxSeparated(s, p, box, dt)) {
        for (let c = 0; c < 8; c++)
            for (let i = 0; i < 4; i++)
                cornerAgainstWheel(s, p, box, c, i, pair, dt);
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
export function collideTruckImmovableBox(s, p, box, dt) {
    if (truckBoxSeparated(s, p, box, dt))
        return null;
    const touch = { hit: null };
    hullPoints(s, box, { pushable: false, touch, mEff: truckMass(p), box: null, truck: null }, dt);
    for (let i = 0; i < 4; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        wheelSuspension(s, p, box, i, side, touch);
        tireContactPoint(s, p, box, i, { pushable: false, touch, mEff: 0, box: null, truck: null }, dt);
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
/**
 * The pushable force law (§14.17) at a truck point `body` (truck axes) that is `depth` inside the
 * face with outward normal `n`, at `cur` (both box axes). Returns whether the box was pushed.
 */
function pushPoint(s, box, body, cur, n, depth, pair, dt) {
    const m = s.matrix, bm = box.matrix;
    const [p, q, r] = s.rates;
    const vt = [s.bvel[0] + (r * body[2] - p * body[1]), s.bvel[1] + (p * body[0] - q * body[2]), s.bvel[2] + (q * body[1] - r * body[0])];
    const vw = toWorld(m, vt[0], vt[1], vt[2]);
    const vtb = toBody(bm, vw[0], vw[1], vw[2]);
    const [pb, qb, rb] = box.rates;
    const vb = [box.bvel[0] + (rb * cur[2] - pb * cur[1]), box.bvel[1] + (pb * cur[0] - qb * cur[2]), box.bvel[2] + (qb * cur[1] - rb * cur[0])];
    const closing = -(n[0] * (vtb[0] - vb[0]) + n[1] * (vtb[1] - vb[1]) + n[2] * (vtb[2] - vb[2]));
    if (!(closing >= 0))
        return false;
    const F = (closing / dt) * pair.mEff;
    setBoxForce(pair, cur, [-F * n[0], -F * n[1], -F * n[2]]);
    const fw = toWorld(bm, F * n[0], F * n[1], F * n[2]);
    setTruckForce(pair, body, toBody(m, fw[0], fw[1], fw[2]));
    const nw = toWorld(bm, n[0], n[1], n[2]);
    box.pos[0] -= depth * nw[0];
    box.pos[1] -= depth * nw[1];
    box.pos[2] -= depth * nw[2];
    return true;
}
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** The pair's force on the box, `f` at `at` (box axes), replacing the last one. */
function setBoxForce(pair, at, f) {
    pair.box = { f, m: crossV(at, f) };
}
/** The pair's force on the truck, `f` at `at` (body axes), replacing the last one. */
function setTruckForce(pair, at, f) {
    pair.truck = { f, m: crossV(at, f) };
}
function unit(v) {
    const l = Math.hypot(v[0], v[1], v[2]);
    return l === 0 ? [0, 1, 0] : [v[0] / l, v[1] / l, v[2] / l];
}
/**
 * Where tire `i`'s hub was last step, world feet (tire +0x24, §14.14 step 3): the truck's last position and rotation,
 * and the hub as the step began. The wheels' rays start here, not at the truck's centre.
 */
function lastHub(s, i) {
    const h = s.tires[i].hub;
    const w = toWorld(s.prevMatrix, h[0], h[1], h[2]);
    return [s.prevPos[0] + w[0], s.prevPos[1] + w[1], s.prevPos[2] + w[2]];
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
