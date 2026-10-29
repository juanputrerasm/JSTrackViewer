import { truckRadius } from "../truck/recovery.js";
/** How far behind a face it is solid, feet. */
export const FACE_DEPTH_FT = 2;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const toWorld = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
const toBody = (m, x, y, z) => [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
/**
 * A wall face from its three corners (world feet), facing the way `outward` points (any vector on the open side), or
 * the corners' winding (a, b, c counter-clockwise seen from outside) without it. Null for a face with no area.
 */
export function createFace(a, b, c, outward) {
    let n = cross(sub(b, a), sub(c, a));
    const l = Math.hypot(n[0], n[1], n[2]);
    if (!(l > 1e-9))
        return null;
    n = [n[0] / l, n[1] / l, n[2] / l];
    if (outward && dot(n, outward) < 0)
        n = [-n[0], -n[1], -n[2]];
    const centre = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const radius = Math.max(...[a, b, c].map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2])));
    return { a: [...a], b: [...b], c: [...c], normal: n, centre, radius };
}
/** Whether `p`, taken into the face's plane, is over the triangle: on the same side of its three edges, either winding. */
function overFace(f, p) {
    const n = f.normal;
    const e = [sub(f.b, f.a), sub(f.c, f.b), sub(f.a, f.c)], o = [f.a, f.b, f.c];
    let above = false, below = false;
    for (let k = 0; k < 3; k++) {
        const d = dot(cross(e[k], sub(p, o[k])), n);
        if (d > 0)
            above = true;
        else if (d < 0)
            below = true;
    }
    return !(above && below);
}
/**
 * How deep a point that was at `from` and is now at `to` is behind the face, or -Infinity where it is not: behind it
 * now within its depth and over it, or crossed its plane over it since.
 */
function depthBehind(f, from, to) {
    const dTo = dot(sub(to, f.a), f.normal);
    if (dTo >= 0)
        return -Infinity;
    if (dTo > -FACE_DEPTH_FT && overFace(f, to))
        return -dTo;
    const dFrom = dot(sub(from, f.a), f.normal);
    if (dFrom < 0)
        return -Infinity;
    const t = dFrom / (dFrom - dTo);
    const hit = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
    return overFace(f, hit) ? -dTo : -Infinity;
}
/**
 * A truck against a wall face, after the truck step and before the post-step, as `collideTruckImmovableBox`.
 * `s.prevPos` and `s.prevMatrix` are the truck's pose before this step's move.
 */
export function collideTruckFace(s, p, f, dt) {
    const R = truckRadius(p);
    const dx = s.pos[0] - f.centre[0], dy = s.pos[1] - f.centre[1], dz = s.pos[2] - f.centre[2];
    // The step's own move is in reach as well.
    const iv = toWorld(s.matrix, s.bvel[0], s.bvel[1], s.bvel[2]);
    const reach = R + f.radius + Math.hypot(iv[0], iv[1], iv[2]) * dt;
    if (dx * dx + dy * dy + dz * dz >= reach * reach)
        return;
    const plane = dot(sub(s.pos, f.a), f.normal);
    if (plane > R + Math.hypot(iv[0], iv[1], iv[2]) * dt || plane < -R - FACE_DEPTH_FT)
        return;
    const m = s.matrix, pm = s.prevMatrix, n = f.normal;
    const at = (mat, pos, x, y, z) => {
        const w = toWorld(mat, x, y, z);
        return [pos[0] + w[0], pos[1] + w[1], pos[2] + w[2]];
    };
    // Hull points 1 to 12.
    for (let j = 0; j < 12; j++) {
        const x = s.points[j * 3], y = s.points[j * 3 + 1], z = s.points[j * 3 + 2];
        const depth = depthBehind(f, at(pm, s.prevPos, x, y, z), at(m, s.pos, x, y, z));
        if (!(depth > s.depths[j]))
            continue;
        s.depths[j] = depth;
        s.normals.set(n, j * 3);
    }
    // Tire contact points 13 to 16: the point of each tire toward the face, as for a box's side (truck-box.ts).
    const nt = toBody(m, n[0], n[1], n[2]);
    const reachR = p.tireRadiusFt * Math.max(Math.abs(Math.sin(Math.atan2(nt[2], nt[1]))), Math.abs(Math.sin(Math.atan2(nt[0], nt[1]))));
    const side = -nt[0] > 0 ? 1 : -1;
    const l = Math.hypot(nt[1], nt[2]);
    const ny = l === 0 ? 1 : -nt[1] / l, nz = l === 0 ? 0 : -nt[2] / l;
    for (let i = 0; i < 4; i++) {
        const h = s.tires[i].hub;
        const point = [h[0] + p.tireWidthFt * side * 0.5, h[1] + ny * reachR, h[2] + nz * reachR];
        // From the hub's place last step to the contact point now, so a wheel driven at the face meets it.
        const depth = depthBehind(f, at(pm, s.prevPos, h[0], h[1], h[2]), at(m, s.pos, point[0], point[1], point[2]));
        const j = 12 + i;
        if (!(depth > s.depths[j]))
            continue;
        s.depths[j] = depth;
        s.normals.set(n, j * 3);
        s.points.set(point, j * 3);
    }
}
