/*
  A pushable box as a rigid body (MTM2_PHYSICS.md §14.16): its step and its post-step.

  A box with mass is stepped only once something moves it (a pair force or a velocity), so the
  level's scenery stays put until a truck touches it. The step is the truck's without tires:
  gravity, air drag over its faces, aero damping, the shared hull-contact solver on its 8
  corners, the sums and the same integration. The post-step probes the corners against the
  terrain and pushes the box out, as a truck's post-step does with its hull points.
*/
import { AIR_DENSITY, G } from "../constants.js";
import { solveHullContacts } from "../truck/contacts.js";
import { integrateOrientation } from "../truck/dynamics.js";
import { surfaceSinkFt } from "../world/surface.js";
const SKIN = 0.25;
const FORCE_LIMIT = 500000;
const RATE_LIMIT = 13;
const toWorld = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
/** The inertias I1, I2, I3 (about z, x, y) from the full sizes (§14.16). */
export function boxInertia(box) {
    const w = box.half[0] * 2, h = box.half[1] * 2, l = box.half[2] * 2;
    return [box.mass * (h * h + w * w) / 12, box.mass * (h * h + l * l) / 12, box.mass * (w * w + l * l) / 12];
}
/** One step of a box (§14.16). Immovable boxes, and boxes at rest with nothing on them, stay. */
export function stepBox(box, ground, dt) {
    if (!box.dynamic)
        return;
    const f = box.force, v = box.vel;
    if (f[0] === 0 && f[1] === 0 && f[2] === 0 && v[0] === 0 && v[1] === 0 && v[2] === 0)
        return;
    const m = box.matrix;
    const mass = box.mass, W = mass * G;
    const w = box.half[0] * 2, h = box.half[1] * 2, l = box.half[2] * 2;
    const area = [h * l, w * l, w * h];
    // Gravity and drag, body axes.
    const force = [-W * m[3], -W * m[4], -W * m[5]];
    for (let k = 0; k < 3; k++) {
        const vk = box.bvel[k];
        force[k] += -(area[k] * AIR_DENSITY) * 0.5 * vk * Math.abs(vk);
    }
    // Aero damping: coefficients -1, q_bar at least 0.11885.
    const speed = Math.hypot(box.bvel[0], box.bvel[1], box.bvel[2]);
    const qbar = Math.max(0.11885, 0.0011885 * speed * speed);
    const [p, q, r] = box.rates;
    const moment = [-q * area[1] * l * qbar, -r * area[0] * l * qbar, -p * area[0] * l * qbar];
    const inertia = boxInertia(box);
    const contacts = solveHullContacts(box, inertia, ground, force, mass, W, dt);
    // Sums: contacts and the pair forces, at most 500000; then the accumulators are cleared.
    for (let k = 0; k < 3; k++)
        force[k] += contacts.force[k] + box.force[k];
    const fMag = Math.hypot(force[0], force[1], force[2]);
    if (fMag > FORCE_LIMIT)
        for (let k = 0; k < 3; k++)
            force[k] *= FORCE_LIMIT / fMag;
    for (let k = 0; k < 3; k++)
        moment[k] += contacts.moment[k] + box.moment[k];
    box.force.fill(0);
    box.moment.fill(0);
    // Integration, as for a truck (§14.9).
    const [I1, I2, I3] = inertia;
    const clamp = (x) => (x > RATE_LIMIT ? RATE_LIMIT : x < -RATE_LIMIT ? -RATE_LIMIT : x);
    const qDot = clamp(((I3 - I1) / I2) * r * p + moment[0] / I2);
    const pDot = clamp(((I2 - I3) / I1) * r * q + moment[2] / I1);
    const rDot = clamp(((I1 - I2) / I3) * q * p + moment[1] / I3);
    const [vx, vy, vz] = box.bvel;
    const ax = p * vy - r * vz + force[0] / mass;
    const ay = q * vz - p * vx + force[1] / mass;
    const az = r * vx - q * vy + force[2] / mass;
    box.rates[0] += pDot * dt;
    box.rates[1] += qDot * dt;
    box.rates[2] += rDot * dt;
    box.bvel[0] += ax * dt;
    box.bvel[1] += ay * dt;
    box.bvel[2] += az * dt;
    let ivel = toWorld(m, box.bvel[0], box.bvel[1], box.bvel[2]);
    const iv = Math.hypot(ivel[0], ivel[1], ivel[2]);
    // At rest: below 0.1 ft/s, or below 2 with three or more contacts.
    if (iv < 0.1 || (iv < 2 && contacts.count >= 3)) {
        box.bvel.fill(0);
        box.rates.fill(0);
        ivel = [0, 0, 0];
    }
    box.vel[0] = ivel[0];
    box.vel[1] = ivel[1];
    box.vel[2] = ivel[2];
    for (let k = 0; k < 3; k++)
        box.pos[k] += ivel[k] * dt;
    integrateOrientation(box, dt);
    box.depths.fill(-9999);
}
/** The box post-step (§14.16): each corner against the terrain, pushed out past the skin. */
export function postStepBox(box, ground) {
    if (!box.dynamic)
        return;
    box.contactCount = 0;
    const m = box.matrix;
    const n = [0, 1, 0];
    for (let i = 0; i < 8; i++) {
        const c = toWorld(m, box.points[i * 3], box.points[i * 3 + 1], box.points[i * 3 + 2]);
        const x = box.pos[0] + c[0], y = box.pos[1] + c[1], z = box.pos[2] + c[2];
        ground.normal(x, z, n);
        const gh = ground.height(x, z);
        const d = gh - y - surfaceSinkFt(ground.surface(x, gh + 100, z));
        let push;
        let nx, ny, nz;
        if (d * n[1] <= box.depths[i]) {
            // The stored contact (from a pair test) is deeper.
            nx = box.normals[i * 3];
            ny = box.normals[i * 3 + 1];
            nz = box.normals[i * 3 + 2];
            const stored = box.depths[i];
            push = stored > SKIN || stored < 0 ? stored - ny * SKIN : 0;
        }
        else {
            box.depths[i] = d * n[1];
            box.normals[i * 3] = n[0];
            box.normals[i * 3 + 1] = n[1];
            box.normals[i * 3 + 2] = n[2];
            nx = n[0];
            ny = n[1];
            nz = n[2];
            push = d > SKIN || d < 0 ? (d - SKIN) * ny : 0;
        }
        if (!(push >= 0) || !(box.depths[i] >= 0))
            continue;
        const px = nx * push, py = ny * push, pz = nz * push;
        for (let j = 0; j < 8; j++) {
            box.depths[j] -= box.normals[j * 3] * px + box.normals[j * 3 + 1] * py + box.normals[j * 3 + 2] * pz;
        }
        box.pos[0] += px;
        box.pos[1] += py;
        box.pos[2] += pz;
        box.contactCount++;
    }
}
