/*
  Ramps (MTM2_PHYSICS.md §14.19): wedges standing on their position, rising from the back (-z)
  to the front (+z). Their tops are ground through the height query; the probes keep the
  terrain's normal on them. Their sides and front end push wheels and hull points out; their
  edges go to the edge system (§14.19).
*/
import { eulerToMatrix } from "../math.js";
import { edgeAgainstTruck } from "./edges.js";
/** A ramp from its SIT record, sized by its model's bounds when it has one. Null without a position. */
export function createRamp(src, bounds = null) {
    if (!src.positionFt)
        return null;
    let length, width, height;
    if (bounds) {
        width = bounds.max[0] - bounds.min[0];
        height = bounds.max[1] - bounds.min[1];
        length = bounds.max[2] - bounds.min[2];
    }
    else {
        [length, width, height] = src.sizeFt ?? [0, 0, 0];
    }
    const matrix = new Float64Array(9);
    eulerToMatrix(src.theta, src.phi, src.psi, matrix);
    return {
        pos: [src.positionFt[0], src.positionFt[1], src.positionFt[2]], width, length, height,
        radius: Math.sqrt(height * height + (width / 2) ** 2 + (length / 2) ** 2),
        sinPsi: Math.sin(src.psi), cosPsi: Math.cos(src.psi), matrix,
    };
}
/** The ramp's top under (x, z), or null when the point is outside its footprint (`0x54feb0`). */
export function rampHeightAt(r, x, z) {
    const dx = r.pos[0] - x, dz = r.pos[2] - z;
    if (!(Math.abs(dx) <= r.radius && Math.abs(dz) <= r.radius))
        return null;
    const u = r.cosPsi * dx - r.sinPsi * dz;
    const v = r.cosPsi * dz + r.sinPsi * dx;
    if (!(-r.width * 0.5 <= u && u <= r.width * 0.5 && -r.length * 0.5 <= v && v <= r.length * 0.5))
        return null;
    return ((r.length - (r.length * 0.5 + v)) * r.height) / r.length + r.pos[1];
}
const toWorld = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
const toBody = (m, x, y, z) => [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
/** The wedge's top over a point in ramp axes, and whether the wedge holds it (`0x48c230`, §14.19). */
export function insideRamp(r, P) {
    const a = r.width * 0.5, b = r.length * 0.5;
    const top = ((P[2] + b) / (2 * b)) * r.height;
    return { inside: -b <= P[2] && P[2] <= b && -a <= P[0] && P[0] <= a && 0 <= P[1] && P[1] <= top, top };
}
/** A body point's velocity, `bvel + omega x r` with omega = (q, r, p) on (x, y, z). */
function pointVelocity(s, r) {
    const [p, q, w] = s.rates;
    return [s.bvel[0] + (w * r[2] - p * r[1]), s.bvel[1] + (p * r[0] - q * r[2]), s.bvel[2] + (q * r[1] - w * r[0])];
}
/**
 * Push a truck point (body `Pb`, ramp axes `P`) out of the ramp's sides or front end
 * (`0x4b2950`, `0x4b3540`, §14.19). Returns whether it moved the truck.
 */
function pushOut(r, s, Pb, P) {
    const { inside, top } = insideRamp(r, P);
    if (!inside)
        return false;
    // The ramp does not move: w is minus the truck point's velocity, in ramp axes.
    const vw = toWorld(s.matrix, ...pointVelocity(s, Pb));
    const vr = toBody(r.matrix, vw[0], vw[1], vw[2]);
    const w = [-vr[0], -vr[1], -vr[2]];
    const a = r.width * 0.5, b = r.length * 0.5;
    const dx = Math.abs((w[0] <= 0 ? -a : a) - P[0]);
    const dy = Math.abs(top - P[1]);
    const dz = Math.abs((w[2] <= 0 ? -b : b) - P[2]);
    const tx = w[0] === 0 ? 100 : dx / w[0];
    const ty = w[1] === 0 ? 1e6 : dy / w[1];
    const tz = w[2] === 0 ? 100 : dz / w[2];
    let n, t;
    if (Math.abs(ty) <= Math.abs(tx)) {
        if (!(Math.abs(tz) < Math.abs(ty) && tz > 0))
            return false;
        n = [0, 0, 1];
        t = tz;
    }
    else if (Math.abs(tz) <= Math.abs(tx)) {
        if (!(tz > 0))
            return false;
        n = [0, 0, 1];
        t = tz;
    }
    else {
        if (tx === 0)
            return false;
        n = [Math.sign(tx), 0, 0];
        t = tx;
    }
    const k = Math.abs(t);
    const push = toWorld(r.matrix, w[0] * k + n[0] * 0.2, w[1] * k + n[1] * 0.2, w[2] * k + n[2] * 0.2);
    for (let i = 0; i < 3; i++)
        s.pos[i] += push[i];
    return true;
}
/** The slope's outward normal, world (`+0xf8`, §14.19): `unit(0, 2b, -H)` turned with the ramp. */
export function rampSlopeNormal(r) {
    const l = Math.hypot(r.length, r.height);
    return l === 0 ? [0, 1, 0] : toWorld(r.matrix, 0, r.length / l, -r.height / l);
}
/** The five edges the edge system tests, world (`0x4b17c0`, §14.19): c0 c2, c1 c3, c2 c4, c3 c5, c2 c3. */
export function rampEdges(r) {
    const a = r.width * 0.5, b = r.length * 0.5, H = r.height;
    const local = [[-a, 0, b], [a, 0, b], [-a, H, b], [a, H, b], [-a, 0, -b], [a, 0, -b]];
    const c = local.map((v) => { const w = toWorld(r.matrix, v[0], v[1], v[2]); return [r.pos[0] + w[0], r.pos[1] + w[1], r.pos[2] + w[2]]; });
    return [[c[0], c[2]], [c[1], c[3]], [c[2], c[4]], [c[3], c[5]], [c[2], c[3]]];
}
/**
 * The ramp's sides and front end as walls for a truck's wheels, then its hull points
 * (`0x4b2580`, §14.19); then, given the edge state, its edges (`0x4b17c0`, §14.26). The edge
 * contacts' forces are discarded, as the game's ramp pair does.
 */
export function collideTruckRamp(r, s, p, edges) {
    const rho = Math.hypot(p.tireWidthFt * 0.5, p.tireRadiusFt);
    const toRamp = (b) => {
        const w = toWorld(s.matrix, b[0], b[1], b[2]);
        return toBody(r.matrix, s.pos[0] + w[0] - r.pos[0], s.pos[1] + w[1] - r.pos[1], s.pos[2] + w[2] - r.pos[2]);
    };
    for (const t of s.tires) {
        const hw = toWorld(s.matrix, t.hub[0], t.hub[1], t.hub[2]);
        const d = [s.pos[0] + hw[0] - r.pos[0], s.pos[1] + hw[1] - r.pos[1], s.pos[2] + hw[2] - r.pos[2]];
        if (!(Math.hypot(d[0], d[1], d[2]) < r.radius + rho))
            continue;
        const dr = toBody(r.matrix, d[0], d[1], d[2]);
        const fx = dr[0] / r.width, fz = dr[2] / r.length;
        const sgn = (v) => (v === 0 ? 1 : Math.sign(v));
        const toward = Math.abs(fx) <= Math.abs(fz) ? [0, 0, -sgn(fz)] : [-sgn(fx), 0, 0];
        const tw = toWorld(r.matrix, ...toward);
        const g = toBody(s.matrix, tw[0], tw[1], tw[2]);
        const side = g[0] > 0 ? 1 : -1;
        const gl = Math.hypot(g[1], g[2]);
        const [gy, gz] = gl === 0 ? [1, 0] : [g[1] / gl, g[2] / gl];
        const Pb = [t.hub[0] + side * p.tireWidthFt * 0.5, t.hub[1] + p.tireRadiusFt * gy, t.hub[2] + p.tireRadiusFt * gz];
        pushOut(r, s, Pb, toRamp(Pb));
    }
    for (let j = 0; j < 12; j++) {
        const Pb = [s.points[j * 3], s.points[j * 3 + 1], s.points[j * 3 + 2]];
        pushOut(r, s, Pb, toRamp(Pb));
    }
    if (!edges)
        return;
    const obstacle = { pos: r.pos, matrix: r.matrix, vel: [0, 0, 0], rates: [0, 0, 0] };
    for (const [W0, W1] of rampEdges(r))
        edgeAgainstTruck(W0, W1, obstacle, s, p, edges.state, edges.ctx);
}
