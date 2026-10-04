/*
  Hull contacts with the ground (MTM2_PHYSICS.md §6, §14.12): force-based quasi-statics, not
  impulses. The support is gravity and drag pushed into the contact plane, split among up to four
  contacts by the game's lever rules, raised to the recovery force that would stop the points
  sinking, then each contact gets its friction.

  The game's two-contact split is the reverse of the lever rule, and its sliding friction uses
  |vt + v| rather than |vt|; both are kept (§14.12).
*/
import { weatherGrip } from "../constants.js";
import { surfaceMu, surfaceType } from "../world/surface.js";
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a); return l === 0 ? [0, 1, 0] : [a[0] / l, a[1] / l, a[2] / l]; };
/** The foot of point q on the line from a in direction u (unit), and its distance from a. */
function foot(a, u, q) {
    const t = dot(u, sub(q, a));
    return { point: add(a, scale(u, t)), along: t };
}
/** Q: the body origin moved straight down onto the plane through `c` with normal `n`. */
function originOnPlane(pos, c, n) {
    const d = Math.abs(dot(n, sub(pos, c)));
    return [pos[0], pos[1] - d / n[1], pos[2]];
}
/**
 * Where the line from `from` through `q` meets the edge through `edgeFoot` with direction `u`:
 * |QX| from the foot's distance and the angle, then along the edge by Pythagoras (§14.12).
 */
function edgeCrossing(from, q, edgeFoot, u) {
    let v = unit(sub(q, from));
    if (dot(v, sub(edgeFoot, from)) < 0)
        v = scale(v, -1);
    const w = sub(edgeFoot, q);
    const wl = len(w);
    const cosAngle = Math.abs(dot(unit(w), v));
    const qx = wl / cosAngle;
    const big = Math.max(qx, wl), small = Math.min(qx, wl);
    let along = big * big - small * small >= 0 ? Math.sqrt(big * big - small * small) : 0;
    if (dot(u, v) < 0)
        along = -along;
    return { qx, x: add(edgeFoot, scale(u, along)), fromQ: len(sub(q, from)) };
}
export function solveHullContacts(s, p, ground, external, mass, weight, dt) {
    const out = { force: [0, 0, 0], moment: [0, 0, 0], count: 0 };
    if (s.contactCount === 0)
        return out;
    const m = s.matrix;
    const toWorld = (v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
    const toBody = (v) => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
    const pos = [s.pos[0], s.pos[1], s.pos[2]];
    const all = [];
    for (let j = 0; j < 16; j++) {
        if (!(s.depths[j] >= -0.25))
            continue;
        const body = [s.points[j * 3], s.points[j * 3 + 1], s.points[j * 3 + 2]];
        const normal = [s.normals[j * 3], s.normals[j * 3 + 1], s.normals[j * 3 + 2]];
        const world = add(add(pos, toWorld(body)), scale(normal, s.depths[j]));
        all.push({ body, world, normal });
    }
    out.count = all.length;
    if (all.length === 0)
        return out;
    const used = all.slice(0, 4);
    const G = toWorld(external);
    // Support shares (§14.12).
    let planeN;
    let shares;
    const k = used.length;
    const [c1, c2, c3, c4] = used;
    if (k === 1) {
        planeN = c1.normal;
        shares = [1];
    }
    else if (k === 2) {
        planeN = unit(add(c1.normal, c2.normal));
        const q = originOnPlane(pos, c1.world, planeN);
        const u = unit(sub(c2.world, c1.world));
        const a = Math.abs(dot(u, sub(q, c1.world)));
        const b = Math.abs(len(sub(c2.world, c1.world)) - a);
        shares = a + b === 0 ? [0.5, 0.5] : [a / (a + b), b / (a + b)];
    }
    else {
        planeN = unit(cross(sub(c2.world, c1.world), sub(c3.world, c1.world)));
        if (planeN[1] < 0)
            planeN = scale(planeN, -1);
        const q = originOnPlane(pos, c1.world, planeN);
        const e12 = sub(c2.world, c1.world);
        const u12 = unit(e12), l12 = len(e12);
        if (k === 3) {
            const f = foot(c1.world, u12, q).point;
            const { qx, x, fromQ } = edgeCrossing(c3.world, q, f, u12);
            const s3 = qx / (qx + fromQ);
            const r = Math.min(1, len(sub(x, c2.world)) / l12);
            shares = [(1 - s3) * r, (1 - s3) - (1 - s3) * r, s3];
        }
        else {
            const e34 = sub(c4.world, c3.world);
            const u34 = unit(e34), l34 = len(e34);
            const f = foot(c1.world, u12, q);
            const g = foot(c3.world, u34, q).point;
            const { qx, x, fromQ } = edgeCrossing(f.point, q, g, u34);
            const sA = qx / (fromQ + qx), sB = 1 - sA;
            const s2 = sA * (f.along / l12);
            const s3 = sB * (len(sub(x, c4.world)) / l34);
            shares = [sA - s2, s2, s3, sB - s3];
        }
    }
    const N0 = Math.max(0, -dot(G, planeN));
    const N = shares.map((sh) => N0 * sh);
    // Recovery (§14.12).
    const [pRoll, qPitch, rYaw] = s.rates;
    const omega = [qPitch, rYaw, pRoll];
    const speed = Math.hypot(s.bvel[0], s.bvel[1], s.bvel[2]);
    const vScale = Math.min(speed / 3, 1) * 0.75;
    const [I1, I2, I3] = p.inertia;
    const sumN = () => N.reduce((a, n) => a + Math.abs(n), 0);
    const recovery = (c, share, total) => {
        const vp = scale(add([s.bvel[0], s.bvel[1], s.bvel[2]], cross(omega, c.body)), vScale);
        const lever = len(c.body);
        const ax = unit(cross(c.body, c.normal));
        const inertia = I2 * ax[0] * ax[0] + I3 * ax[1] * ax[1] + I1 * ax[2] * ax[2];
        let r = lever === 0 ? 0 : -(inertia * dot(c.normal, toWorld(vp))) / (dt * lever * lever);
        if (total !== 0)
            r *= Math.abs(share) / total;
        return r < 0 ? 0 : r;
    };
    const before = sumN();
    const R = used.map((c, i) => recovery(c, N[i], before));
    if (k === 1) {
        if (N[0] < R[0])
            N[0] = R[0];
    }
    else if (before < R.reduce((a, r) => a + r, 0)) {
        for (let i = 0; i < k; i++)
            N[i] = R[i];
    }
    const apply = (c, fw) => {
        const fb = toBody(fw);
        for (let j = 0; j < 3; j++)
            out.force[j] += fb[j];
        const mo = cross(c.body, fb);
        for (let j = 0; j < 3; j++)
            out.moment[j] += mo[j];
    };
    for (let i = 0; i < k; i++)
        apply(used[i], scale(used[i].normal, N[i]));
    // Friction (§14.12).
    const total = sumN();
    const weather = weatherGrip(ground.weather);
    for (let i = 0; i < k; i++) {
        const c = used[i];
        const share = total !== 0 ? Math.abs(N[i]) / total : 1;
        let vb = [s.bvel[0], s.bvel[1], s.bvel[2]];
        if (all.length < 3)
            vb = add(vb, cross(omega, c.body));
        const v = toWorld(vb);
        const vt = sub(v, scale(c.normal, dot(v, c.normal)));
        const u = add(vt, v);
        // The game samples the surface at the truck position plus the unrotated body point.
        const type = surfaceType(ground.surface(pos[0] + c.body[0], pos[1] + c.body[1], pos[2] + c.body[2]));
        let limit = N[i] * 0.5 * surfaceMu(type) * weather;
        if (limit < 0)
            limit = 0;
        const sp = len(u);
        let f;
        if (sp === 0) {
            const g = [0, weight, 0];
            let gt = sub(g, scale(c.normal, dot(g, c.normal)));
            gt = scale(gt, share);
            const gl = len(gt);
            f = gl <= limit ? gt : scale(gt, limit / gl);
        }
        else {
            const dir = scale(u, 1 / sp);
            const gpart = dot(dir, [0, weight, 0]) * share;
            const stop = mass * (sp / dt) * share;
            limit = Math.min(limit, stop - gpart);
            f = scale(dir, -limit);
        }
        apply(c, f);
    }
    s.impactForce = len(out.force);
    return out;
}
