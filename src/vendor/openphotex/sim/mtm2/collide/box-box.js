import { HULL_ORDER, depthInside, faceNormal, nearestFace } from "./faces.js";
const toWorld = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
const toBody = (m, x, y, z) => [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
/**
 * The pair test of two boxes, `first` listed before `second` (§14.21). The mover is `second` when
 * it is dynamic, else `first`; nothing happens when neither is.
 */
export function collideBoxes(first, second, dt) {
    if (!first.dynamic && !second.dynamic)
        return;
    const dx = first.pos[0] - second.pos[0], dy = first.pos[1] - second.pos[1], dz = first.pos[2] - second.pos[2];
    if (dx * dx + dy * dy + dz * dz >= (first.radius + second.radius) ** 2)
        return;
    const [M, B] = second.dynamic ? [second, first] : [first, second];
    const bm = B.matrix;
    const rel = [M.pos[0] - B.pos[0], M.pos[1] - B.pos[1], M.pos[2] - B.pos[2]];
    const origin = toBody(bm, rel[0] - M.vel[0] * dt, rel[1] - M.vel[1] * dt, rel[2] - M.vel[2] * dt);
    for (let i = 0; i < 8; i++) {
        const c = toWorld(M.matrix, M.points[i * 3], M.points[i * 3 + 1], M.points[i * 3 + 2]);
        const cur = toBody(bm, rel[0] + c[0], rel[1] + c[1], rel[2] + c[2]);
        const d = [cur[0] - origin[0], cur[1] - origin[1], cur[2] - origin[2]];
        const l = Math.hypot(d[0], d[1], d[2]);
        const dir = l === 0 ? [0, 1, 0] : [d[0] / l, d[1] / l, d[2] / l];
        const { face } = nearestFace(B.half, origin, dir, true, HULL_ORDER);
        if (face < 0)
            continue;
        const depth = depthInside(B.half, cur, face);
        if (!(M.depths[i] < depth))
            continue;
        M.depths[i] = depth;
        const n = faceNormal(face);
        M.normals.set(toWorld(bm, n[0], n[1], n[2]), i * 3);
        M.force[1] += 0.01;
    }
}
