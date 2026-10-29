/* Viewer mesh/moving-scenery contacts around OpenPhotex's truck step.
 * Terrain and suspension are solved by OpenPhotex. Scenery keeps the viewer's
 * model geometry, crush flags and movable objects rather than becoming boxes.
 */
import { bodyToWorld, worldToBody } from "../vendor/openphotex/sim/mtm2/math.js";

const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const viewer = (v) => ({ x: v[0], y: v[1], z: -v[2] });
const game = (v) => [v.x, v.y, -v.z];

export function resolveSceneryContacts(s, p, colliders, dt) {
  if (!colliders) return;
  const world = (v) => bodyToWorld(s.matrix, v, [0, 0, 0]);
  const body = (v) => worldToBody(s.matrix, v, [0, 0, 0]);
  const inertia = [p.inertia[1], p.inertia[2], p.inertia[0]];
  const origin = viewer(s.pos);
  const contacts = [];
  function probe(local, wheel = false) {
    const arm = world(local);
    const point = viewer(s.pos.map((v, i) => v + arm[i]));
    // Ground boxes and fixed scenery's walls are OpenPhotex's (openmtm2-sim.js collideWorld).
    const hit = colliders.contactAt(point, origin, { truck: true });
    // Tire support belongs to the solid-axle solver; only tire side hits come here.
    if (!hit || (wheel && Math.abs(hit.normal.y) >= 0.7)) return null;
    return { ...hit, point, local, normal: game(hit.normal) };
  }
  for (const point of p.scrapePoints) {
    const contact = probe(point);
    if (contact) contacts.push(contact);
  }
  for (const t of s.tires) {
    const r = p.tireRadiusFt, w = p.tireWidthFt / 2;
    let deepest = null;
    for (const d of [[0, 0, r], [0, 0, -r], [w, 0, 0], [-w, 0, 0], [0, -r * 0.7, r * 0.7], [0, -r * 0.7, -r * 0.7]]) {
      const hit = probe(t.hub.map((v, i) => v + d[i]), true);
      if (hit && (!deepest || hit.depth > deepest.depth)) deepest = hit;
    }
    if (deepest) contacts.push(deepest);
  }
  let pushOut = null;
  for (const c of contacts) {
    const arm = c.local.map((v, i) => v - p.cgOffset[i]);
    const n = body(c.normal);
    const other = c.solid?.velocity ? body(game(c.solid.velocity)) : [0, 0, 0];
    const movableMass = c.solid?.movable ? Math.max(0.01, c.solid.mass) : Infinity;
    const invOther = 1 / movableMass;
    const velocity = () => {
      const spin = cross([s.rates[1], s.rates[2], s.rates[0]], arm);
      return s.bvel.map((v, i) => v + spin[i] - other[i]);
    };
    const effectiveMass = (direction) => {
      const r = cross(arm, direction);
      return 1 / p.massSlug + invOther + r.reduce((sum, v, i) => sum + v * v / inertia[i], 0);
    };
    const impulse = (direction, amount) => {
      const j = direction.map((v) => v * amount);
      for (let i = 0; i < 3; i++) s.bvel[i] += j[i] / p.massSlug;
      const torque = cross(arm, j).map((v, i) => v / inertia[i]);
      s.rates[0] += torque[2]; s.rates[1] += torque[0]; s.rates[2] += torque[1];
      if (Number.isFinite(movableMass)) colliders.push(c.solid, viewer(world(j.map((v) => -v))), c.point);
    };
    if (movableMass >= p.massSlug && (!pushOut || c.depth > pushOut.depth)) pushOut = c;
    const approach = dot(velocity(), n);
    if (approach >= 0) continue;
    const j = -approach / effectiveMass(n);
    impulse(n, j);
    const v = velocity(), vn = dot(v, n);
    const tangent = v.map((value, i) => value - vn * n[i]);
    const speed = Math.hypot(...tangent);
    if (speed > 0.01) {
      const direction = tangent.map((value) => value / speed);
      impulse(direction, -Math.min(j * 0.5, speed / effectiveMass(direction)));
    }
  }
  if (pushOut) {
    const distance = Math.min(Math.max(0, pushOut.depth - 0.06), 12 * dt);
    for (let i = 0; i < 3; i++) s.pos[i] += pushOut.normal[i] * distance;
  }
}
