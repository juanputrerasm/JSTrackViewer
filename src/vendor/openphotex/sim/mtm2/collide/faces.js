/** The six faces: left (-x), right (+x), bottom, top, front (+z), back (-z). */
export const FACES = [
    { axis: 0, sign: -1 }, { axis: 0, sign: 1 },
    { axis: 1, sign: -1 }, { axis: 1, sign: 1 },
    { axis: 2, sign: 1 }, { axis: 2, sign: -1 },
];
/** The order the game tries them in: hull points start with y, wheels with x. */
export const HULL_ORDER = [2, 3, 4, 5, 0, 1];
export const WHEEL_ORDER = [0, 1, 2, 3, 4, 5];
/**
 * The nearest face a ray crosses inside the face (at most two crossings are counted, as in the
 * game), trying the faces in `order`; later faces win ties. `directional`: only faces ahead of
 * the origin (t > 0) whose outward normal faces the ray count.
 */
export function nearestFace(half, origin, dir, directional, order) {
    let best = 999999, face = -1, crossings = 0;
    for (const f of order) {
        const { axis, sign } = FACES[f];
        if (dir[axis] === 0)
            continue;
        if (crossings >= 2)
            continue;
        const t = (sign * half[axis] - origin[axis]) / dir[axis];
        const u = (axis + 1) % 3, v = (axis + 2) % 3;
        const pu = origin[u] + dir[u] * t, pv = origin[v] + dir[v] * t;
        if (!(pu < half[u] && pu > -half[u] && pv < half[v] && pv > -half[v]))
            continue;
        crossings++;
        const at = Math.abs(t);
        if (directional) {
            const facing = dir[axis] * sign < 0;
            if (!(at <= best && t > 0 && facing))
                continue;
        }
        else if (!(at <= best)) {
            continue;
        }
        best = at;
        face = f;
    }
    return { face };
}
/** A point's depth inside a face (positive inside), box frame. */
export function depthInside(half, p, face) {
    const { axis, sign } = FACES[face];
    return sign > 0 ? half[axis] - p[axis] : p[axis] + half[axis];
}
/** The face's outward normal in the box frame. */
export function faceNormal(face) {
    const n = [0, 0, 0];
    n[FACES[face].axis] = FACES[face].sign;
    return n;
}
