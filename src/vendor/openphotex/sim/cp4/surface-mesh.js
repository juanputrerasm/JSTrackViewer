import { rayQuery, shapeUsable } from "./coll-shape.js";
/** Untyped faces (no .SRF entry matched): skipped by the lookup. */
export const UNTYPED_SURFACE = -2;
/** CP4 keeps at most this many surface boxes (5). */
export const MAX_SURFACE_BOXES = 64;
const toBody = (m, x, y, z) => [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
/** The typed face under (x, y, z): its type value and height, or null. */
export function surfaceMeshHit(boxes, x, y, z) {
    let best = null;
    for (const box of boxes) {
        const sh = box.shape;
        if (!shapeUsable(sh) || !sh.surfaceTypes)
            continue;
        const dx = x - box.pos[0], dz = z - box.pos[2];
        if (dx * dx + dz * dz > box.radius * box.radius)
            continue;
        const bm = box.matrix;
        let o = toBody(bm, dx, y + 4 - box.pos[1], dz);
        const dir = toBody(bm, 0, -1, 0);
        let left = 10;
        for (let k = 0; k < 4 && left > 0; k++) {
            const hit = rayQuery(sh, o, dir, left);
            if (!hit)
                break;
            const type = sh.surfaceTypes[hit.tri];
            // The up component of the face, in the world.
            const ny = bm[3] * hit.normal[0] + bm[4] * hit.normal[1] + bm[5] * hit.normal[2];
            const hy = y + 4 - (10 - left) - hit.t;
            if (type !== UNTYPED_SURFACE && Math.abs(ny) >= 0.25 && (!best || Math.abs(hy - y) < Math.abs(best.y - y))) {
                best = { value: type, y: hy };
            }
            // Step past this face and look again.
            const stepT = hit.t + 0.05;
            o = [o[0] + dir[0] * stepT, o[1] + dir[1] * stepT, o[2] + dir[2] * stepT];
            left -= stepT;
        }
    }
    return best;
}
/**
 * Give the ground CP4's surface meshes for the tires' grip (in place; returns it). `limit`: how many of the
 * boxes count, in their order; CP4 takes the first 64 and ignores the rest. A host may pass more.
 */
export function withSurfaceMeshes(ground, boxes, { limit = MAX_SURFACE_BOXES } = {}) {
    const list = boxes.filter((b) => shapeUsable(b.shape) && !!b.shape.surfaceTypes).slice(0, limit);
    delete ground.tireSurface;
    if (!list.length)
        return ground;
    ground.tireSurface = (x, y, z) => {
        const hit = surfaceMeshHit(list, x, y, z);
        if (!hit)
            return ground.surface(x, y, z);
        const h = ground.height(x, z);
        if (hit.y < h - 0.25 && Math.abs(h - y) < Math.abs(hit.y - y))
            return ground.surface(x, y, z);
        return hit.value;
    };
    return ground;
}
