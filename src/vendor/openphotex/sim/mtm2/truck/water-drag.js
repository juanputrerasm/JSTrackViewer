/*
  The fluid areas behind the drag (MTM2_PHYSICS.md §14.7.1).

  Each body axis gets `rhoA`: the density times the area facing that axis. Submerged wheels and
  hull faces count at their surface's density (water 0.15); what is left of the aero area counts
  at the air's. The game also sums water moments about the CG, but never applies them, so they
  are not computed here.
*/
import { AIR_DENSITY, TRUCK, WATER_DRAG_DENSITY } from "../constants.js";
import { surfaceDragDensity, surfaceType } from "../world/surface.js";
/** Speed above which entering water splashes, ft/s. */
export const SPLASH_SPEED = 14.67;
/**
 * A wheel's areas in water `depth` deep, `[side (x), under (y), front (z)]`; zero when dry.
 * The depth counts up to the wheel's diameter.
 */
export function wheelWaterAreas(depth, radius, width) {
    if (!(depth > 0))
        return [0, 0, 0];
    const d = Math.min(depth, radius * 2);
    const off = radius - d;
    const a = Math.acos(Math.min(1, Math.abs(off) / radius));
    const chord = Math.sin(a) * radius * 2;
    let side = a * 0.5 * radius * radius * 2 - chord * Math.abs(off) * 0.5;
    let under = chord * width;
    if (off < 0) {
        under = width * radius * 2;
        side = radius * radius * Math.PI - side;
    }
    return [side, under, d * width];
}
/** The density of the surface at a world point (§14.7.1). */
function densityAt(ground, x, y, z) {
    return surfaceDragDensity(surfaceType(ground.surface(x, y, z)));
}
const toWorld = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
/**
 * The submerged area of one hull face. `corners` are hull point numbers (1-12) in the game's
 * order, `axis` the body axis the face faces. Returns the area and the density at its first wet
 * corner (0 when dry).
 */
export function hullFaceWaterArea(s, ground, corners, axis) {
    const idx = corners.map((n) => n - 1);
    const wet = idx.map((j) => s.waterDepths[j] > 0);
    const mask = (wet[0] ? 1 : 0) | (wet[1] ? 2 : 0) | (wet[2] ? 4 : 0) | (wet[3] ? 8 : 0);
    if (mask === 0)
        return { area: 0, density: 0 };
    const P = s.points, N = s.normals, W = s.waterDepths;
    const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    // The sign pointing from a corner back toward the body centre along an axis.
    const inward = (j, k) => (P[j * 3 + k] > 0 ? -1 : 1);
    const leg = (j, k) => W[j] * N[j * 3 + k] * inward(j, k);
    const triangle = (j) => 0.5 * leg(j, u) * leg(j, v);
    const trapezoid = (j1, j2) => {
        // The axis the two corners differ in is the edge; the legs run across it.
        const [along, across] = P[j1 * 3 + u] === P[j2 * 3 + u] ? [v, u] : [u, v];
        const L = Math.abs(P[j1 * 3 + along] - P[j2 * 3 + along]);
        const sign = inward(j1, across);
        return 0.5 * L * (W[j1] * N[j1 * 3 + across] * sign + W[j2] * N[j2 * 3 + across] * sign);
    };
    const a = idx[0], d = idx[3];
    const full = (P[d * 3 + u] - P[a * 3 + u]) * (P[d * 3 + v] - P[a * 3 + v]);
    const wetIdx = idx.filter((_, i) => wet[i]);
    const dryIdx = idx.filter((_, i) => !wet[i]);
    let area;
    switch (wetIdx.length) {
        case 1:
            area = triangle(wetIdx[0]);
            break;
        case 2:
            area = trapezoid(wetIdx[0], wetIdx[1]);
            break;
        case 3:
            area = full - triangle(dryIdx[0]);
            break;
        default: area = full;
    }
    const j = wetIdx[0];
    const w = toWorld(s.matrix, P[j * 3], P[j * 3 + 1], P[j * 3 + 2]);
    return { area: Math.abs(area), density: densityAt(ground, s.pos[0] + w[0], s.pos[1] + w[1], s.pos[2] + w[2]) };
}
const FACE_Z_BACK = [11, 12, 7, 8];
const FACE_Z_FRONT = [1, 2, 7, 8];
const FACE_Y_DOWN = [1, 2, 11, 12];
const FACES_Y_UP = [[3, 4, 5, 6], [5, 6, 7, 8], [7, 8, 9, 10]];
/** `rhoA` per body axis for this step (§14.7.1). Tires are FR, FL, RR, RL. */
export function fluidAreas(s, p, ground) {
    const dry = [TRUCK.aeroArea[0], TRUCK.aeroArea[1], TRUCK.aeroArea[2]];
    const rhoA = [0, 0, 0];
    const tires = s.tires;
    if (tires.some((t) => t.waterDepth > 0)) {
        const areas = tires.map((t) => wheelWaterAreas(t.waterDepth, p.tireRadiusFt, p.tireWidthFt));
        const dens = tires.map((t) => t.waterDepth > 0 ? densityAt(ground, t.waterPoint[0], t.waterPoint[1], t.waterPoint[2]) : 0);
        // x: the deeper wheel of each axle (the second on a tie).
        for (const [i0, i1] of [[0, 1], [2, 3]]) {
            const i = tires[i0].waterDepth <= tires[i1].waterDepth ? i1 : i0;
            if (tires[i].waterDepth > 0) {
                dry[0] -= areas[i][0];
                rhoA[0] += dens[i] * areas[i][0];
            }
        }
        // y: every wet wheel.
        for (let i = 0; i < 4; i++) {
            if (tires[i].waterDepth > 0) {
                dry[1] -= areas[i][1];
                rhoA[1] += dens[i] * areas[i][1];
            }
        }
        // z: the deeper of front and rear on each side (the rear on a tie).
        for (const [i0, i1] of [[0, 2], [1, 3]]) {
            const i = tires[i0].waterDepth <= tires[i1].waterDepth ? i1 : i0;
            if (tires[i].waterDepth > 0) {
                dry[2] -= areas[i][2];
                rhoA[2] += dens[i] * areas[i][2];
            }
        }
        for (let k = 0; k < 3; k++)
            if (dry[k] < 0)
                dry[k] = 0;
    }
    // Hull faces.
    const zFace = hullFaceWaterArea(s, ground, s.bvel[2] > 0 ? FACE_Z_FRONT : FACE_Z_BACK, 2);
    let yArea = 0, yDensity = 0;
    for (const face of s.bvel[1] > 0 ? FACES_Y_UP : [FACE_Y_DOWN]) {
        const f = hullFaceWaterArea(s, ground, face, 1);
        yArea += f.area;
        yDensity = f.density;
    }
    dry[1] -= yArea;
    dry[2] -= zFace.area;
    rhoA[1] += yDensity * yArea;
    rhoA[2] += zFace.density * zFace.area;
    const splash = (yDensity === WATER_DRAG_DENSITY || zFace.density === WATER_DRAG_DENSITY)
        && Math.hypot(s.bvel[0], s.bvel[1], s.bvel[2]) > SPLASH_SPEED;
    for (let k = 0; k < 3; k++)
        rhoA[k] += Math.max(0, dry[k]) * AIR_DENSITY;
    return { rhoA, splash };
}
