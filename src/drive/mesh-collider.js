/*
  Collision against a model's own triangles.

  A box that has a model collides with the MODEL, not with the box the track authored around
  it. The width, length and height in a .SIT are an editing volume; what a driver sees, and
  expects to hit, is the geometry. Colliding with the volume instead was the "invisible walls"
  complaint in another form: a tree with a 64 unit box stopped the truck metres from its trunk.

  Only boxes WITHOUT a model keep a box collider, because for them the box is the object.

  PLACEMENT IS COPIED FROM scene.js, not re-derived. _buildBinModel draws a model with

    traxxModelMatrix(psi, theta, phi, wx, wz * hs + baseZ * 0.75, worldSize - wy)

  applied to mesh positions in raw Traxx local space (x, y, z up, 2 units per foot). In feet
  the 0.75 stretch and the 1.5 units per vertical foot cancel, so a model is simply 2 units per
  foot on every axis once rotated. The formulas in `buildMeshShape` are that matrix, divided out.

  THE CONTACT TEST IS A SEGMENT, NOT A POINT. BIN models are not closed solids: most have no
  underside, fences are single planes, and a tree's canopy is a few crossed quads. "Is this
  point inside the mesh" has no answer for any of them. What does have an answer is whether a
  surface lies between the truck's centre of gravity and a point on its hull: the centre is
  inside the truck, so if a triangle separates the two, that hull point has gone through it.
  That works for open, closed and single-sided geometry alike, and it cannot tunnel through a
  thin plane the way a point test does, because the segment is several feet long while a step
  at 100 mph is barely one.
*/

/** Steepest a surface can be and still carry a wheel. Anything steeper is a wall. */
const SUPPORT_MIN_NORMAL_Y = 0.5;

/** Largest per-axis grid a single model is split into for its triangle lookups. */
const MAX_GRID = 24;

/*
  Traxx's rotation, as scene.js's traxxRotationRows builds it. The rows take a vector in the
  object's local space to Traxx world space.
*/
export function traxxRotationRows(psi, theta, phi) {
  const Cp = Math.cos(psi), Sp = Math.sin(psi);
  const Ct = Math.cos(theta), St = Math.sin(theta);
  const Cf = Math.cos(phi), Sf = Math.sin(phi);
  return [
    [Cp * Cf + Sp * St * Sf, Sp * Ct, -Cp * Sf + Sp * St * Cf],
    [-Sp * Cf + Cp * St * Sf, Cp * Ct, Sp * Sf + Cp * St * Cf],
    [Ct * Sf, -St, Ct * Cf],
  ];
}

const positionsOf = (mesh) => {
  const p = mesh?.positions;
  if (!p) return null;
  // The worker transfers the underlying ArrayBuffer, tests pass a typed array.
  return ArrayBuffer.isView(p) ? p : new Float32Array(p);
};

/**
 * Triangles of a placed model, in feet, relative to the model's placement origin.
 *
 * @returns {object|null} null for a model with no triangles
 */
export function buildMeshShape(model, box, trackData) {
  const origin = trackData?.origin;
  const evo = origin === "EVO1" || origin === "EVO2";

  const heightScale = trackData?.terrain?.heightScale ?? 3;
  const worldSize = (trackData?.terrain?.gridSize ?? 256) * (trackData?.terrain?.cellSize ?? 64);
  const [wx = 0, wy = 0, wz = 0] = box.position ?? [];

  // The same origin _buildBinModel uses, in scene units.
  const posX = wx;
  const posY = evo ? wz * heightScale : origin === "HB" ? wz * 3 : wz * heightScale + (model.baseZ ?? 0) * 0.75;
  const posZ = worldSize - wy;

  const [r0, r1, r2] = traxxRotationRows(box.psi ?? 0, box.theta ?? 0, box.phi ?? 0);
  const yaw = box.evoVegetation ? (box.yaw ?? 0) : -(box.psi ?? 0);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const ct = Math.cos(box.theta ?? 0), st = Math.sin(box.theta ?? 0);
  const cf = Math.cos(box.phi ?? 0), sf = Math.sin(box.phi ?? 0);
  const [sx, scaleY, sz] = box.scale ?? [1, 1, 1];

  let count = 0;
  const sources = [];
  for (const mesh of model?.meshes ?? []) {
    const positions = positionsOf(mesh);
    if (!positions || positions.length < 9) continue;
    const raw = mesh.indices;
    const indices = raw ? (ArrayBuffer.isView(raw) ? raw : new Uint32Array(raw)) : null;
    sources.push({ positions, indices });
    count += Math.floor((indices?.length ?? positions.length / 3) / 3);
  }
  if (!count) return null;

  const tris = new Float64Array(count * 9);
  const normals = new Float64Array(count * 3);
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };

  let n = 0;
  for (const { positions, indices } of sources) {
    const vertexCount = indices?.length ?? positions.length / 3;
    for (let i = 0; i + 2 < vertexCount; i += 3) {
      const base = n * 9;
      for (let k = 0; k < 3; k++) {
        const vertex = indices ? indices[i + k] : i + k;
        const vx = positions[vertex * 3];
        const vy = positions[vertex * 3 + 1];
        const vz = positions[vertex * 3 + 2];
        let fx, fy, fz;
        if (evo) {
          // scene.js draws SMF vertices as Y-up, with Y(-psi) X(-theta) Z(phi).
          // .VEG instances use their own positive yaw and nonuniform scale.
          const x = vx * sx, y = vy * scaleY, z = vz * sz;
          const rx = cf * x - sf * y, ry = sf * x + cf * y;
          const py = ct * ry + st * z, pz = -st * ry + ct * z;
          fx = (cy * rx + sy * pz) / 2;
          fy = py / 1.5;
          fz = (-sy * rx + cy * pz) / 2;
        } else {
          // Scene = (r0.v, 0.75 * r2.v, -r1.v) in units; feet divide by 2, 1.5 and 2.
          fx = (r0[0] * vx + r0[1] * vy + r0[2] * vz) / 2;
          fy = (r2[0] * vx + r2[1] * vy + r2[2] * vz) / 2;
          fz = -(r1[0] * vx + r1[1] * vy + r1[2] * vz) / 2;
        }
        tris[base + k * 3] = fx;
        tris[base + k * 3 + 1] = fy;
        tris[base + k * 3 + 2] = fz;
      }

      const e1x = tris[base + 3] - tris[base], e1y = tris[base + 4] - tris[base + 1], e1z = tris[base + 5] - tris[base + 2];
      const e2x = tris[base + 6] - tris[base], e2y = tris[base + 7] - tris[base + 1], e2z = tris[base + 8] - tris[base + 2];
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const length = Math.hypot(nx, ny, nz);
      // Degenerate slivers have no plane to be pushed out of.
      if (!(length > 1e-9)) continue;

      normals[n * 3] = nx / length;
      normals[n * 3 + 1] = ny / length;
      normals[n * 3 + 2] = nz / length;
      for (let k = 0; k < 3; k++) {
        const x = tris[base + k * 3], y = tris[base + k * 3 + 1], z = tris[base + k * 3 + 2];
        if (x < bounds.minX) bounds.minX = x; if (x > bounds.maxX) bounds.maxX = x;
        if (y < bounds.minY) bounds.minY = y; if (y > bounds.maxY) bounds.maxY = y;
        if (z < bounds.minZ) bounds.minZ = z; if (z > bounds.maxZ) bounds.maxZ = z;
      }
      n++;
    }
  }
  if (!n) return null;

  const shape = {
    centre: { x: posX / 2, y: posY / 1.5, z: posZ / 2 },
    count: n,
    tris,
    normals,
    bounds,
    // Dedupe marks for triangles that span several grid cells.
    marks: new Uint32Array(n),
    mark: 0,
  };
  buildGrid(shape);
  return shape;
}

/*
  A flat grid over the model's footprint, so a query only tests the triangles under it.

  A building or a locomotive runs to a thousand triangles or more, and every hull point asks
  every nearby object on every step. Without this a single train car cost more than the
  whole terrain query.
*/
function buildGrid(shape) {
  const { bounds, tris, count } = shape;
  const size = Math.max(1, Math.min(MAX_GRID, Math.ceil(Math.sqrt(count / 4))));
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const spanZ = Math.max(bounds.maxZ - bounds.minZ, 1e-6);
  const cells = Array.from({ length: size * size }, () => []);

  for (let t = 0; t < count; t++) {
    const b = t * 9;
    const minX = Math.min(tris[b], tris[b + 3], tris[b + 6]);
    const maxX = Math.max(tris[b], tris[b + 3], tris[b + 6]);
    const minZ = Math.min(tris[b + 2], tris[b + 5], tris[b + 8]);
    const maxZ = Math.max(tris[b + 2], tris[b + 5], tris[b + 8]);
    const x0 = cellIndex(minX, bounds.minX, spanX, size);
    const x1 = cellIndex(maxX, bounds.minX, spanX, size);
    const z0 = cellIndex(minZ, bounds.minZ, spanZ, size);
    const z1 = cellIndex(maxZ, bounds.minZ, spanZ, size);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) cells[gz * size + gx].push(t);
    }
  }
  shape.grid = { size, spanX, spanZ, cells };
}

function cellIndex(value, min, span, size) {
  const i = Math.floor(((value - min) / span) * size);
  return i < 0 ? 0 : i >= size ? size - 1 : i;
}

/** Visit each triangle whose grid cells overlap an x/z rectangle, once. */
function forTrianglesIn(shape, minX, maxX, minZ, maxZ, visit) {
  const { bounds, grid } = shape;
  if (maxX < bounds.minX || minX > bounds.maxX || maxZ < bounds.minZ || minZ > bounds.maxZ) return;
  const x0 = cellIndex(minX, bounds.minX, grid.spanX, grid.size);
  const x1 = cellIndex(maxX, bounds.minX, grid.spanX, grid.size);
  const z0 = cellIndex(minZ, bounds.minZ, grid.spanZ, grid.size);
  const z1 = cellIndex(maxZ, bounds.minZ, grid.spanZ, grid.size);

  shape.mark = (shape.mark + 1) >>> 0;
  if (shape.mark === 0) { shape.marks.fill(0); shape.mark = 1; }
  for (let gx = x0; gx <= x1; gx++) {
    for (let gz = z0; gz <= z1; gz++) {
      for (const t of grid.cells[gz * grid.size + gx]) {
        if (shape.marks[t] === shape.mark) continue;
        shape.marks[t] = shape.mark;
        visit(t);
      }
    }
  }
}

/**
 * The highest walkable surface at or below `fromY` under a point, in the shape's local feet,
 * or null. Steep faces are skipped: they are walls, and the hull contacts answer those.
 */
export function meshSupport(shape, x, z, fromY) {
  const { tris, normals } = shape;
  let best = null;
  forTrianglesIn(shape, x, x, z, z, (t) => {
    if (Math.abs(normals[t * 3 + 1]) < SUPPORT_MIN_NORMAL_Y) return;
    const b = t * 9;
    const x0 = tris[b], y0 = tris[b + 1], z0 = tris[b + 2];
    const x1 = tris[b + 3], y1 = tris[b + 4], z1 = tris[b + 5];
    const x2 = tris[b + 6], y2 = tris[b + 7], z2 = tris[b + 8];
    if (Math.min(y0, y1, y2) > fromY) return;

    const denom = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
    if (Math.abs(denom) < 1e-12) return;
    const a = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / denom;
    const c = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / denom;
    const d = 1 - a - c;
    if (a < -1e-9 || c < -1e-9 || d < -1e-9) return;

    const y = a * y0 + c * y1 + d * y2;
    if (y <= fromY + 1e-6 && (best === null || y > best)) best = y;
  });
  return best;
}

/**
 * Distance from `origin` along `direction` to the nearest surface, or null for a miss.
 *
 * The support test above is faster and only answers a straight-down ray, which stops being
 * straight down in the object's own frame the moment the object tips over. Both are in the
 * shape's local feet, and `direction` must be a unit vector, so the answer is a distance.
 */
export function meshRay(shape, origin, direction) {
  const { tris, normals } = shape;
  const { bounds } = shape;
  // A ray can enter anywhere in the footprint, so the whole of it is a candidate.
  let best = null;
  forTrianglesIn(shape, bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ, (t) => {
    if (normals[t * 3 + 1] === 0 && direction.y === 0) return;
    const b = t * 9;
    const v0x = tris[b], v0y = tris[b + 1], v0z = tris[b + 2];
    const e1x = tris[b + 3] - v0x, e1y = tris[b + 4] - v0y, e1z = tris[b + 5] - v0z;
    const e2x = tris[b + 6] - v0x, e2y = tris[b + 7] - v0y, e2z = tris[b + 8] - v0z;

    const px = direction.y * e2z - direction.z * e2y;
    const py = direction.z * e2x - direction.x * e2z;
    const pz = direction.x * e2y - direction.y * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return;
    const inv = 1 / det;
    const sx = origin.x - v0x, sy = origin.y - v0y, sz = origin.z - v0z;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) return;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (direction.x * qx + direction.y * qy + direction.z * qz) * inv;
    if (v < 0 || u + v > 1) return;
    const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (hit < 0) return;
    if (best === null || hit < best) best = hit;
  });
  return best;
}

/**
 * Does a surface separate `from` (inside the truck) from `to` (a hull point)?
 *
 * Both in the shape's local feet. Returns the surface met FIRST travelling from `from`, which
 * is the one the hull point went through, with its normal turned to face `from` (out of the
 * object, towards the truck) and the hull point's distance behind its plane as the depth.
 */
export function meshSegmentContact(shape, from, to) {
  const { tris, normals } = shape;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  let bestT = Infinity;
  let bestTri = -1;

  forTrianglesIn(shape,
    Math.min(from.x, to.x), Math.max(from.x, to.x),
    Math.min(from.z, to.z), Math.max(from.z, to.z),
    (t) => {
      const b = t * 9;
      const v0x = tris[b], v0y = tris[b + 1], v0z = tris[b + 2];
      const e1x = tris[b + 3] - v0x, e1y = tris[b + 4] - v0y, e1z = tris[b + 5] - v0z;
      const e2x = tris[b + 6] - v0x, e2y = tris[b + 7] - v0y, e2z = tris[b + 8] - v0z;

      // Moller-Trumbore, with the segment as the ray and t limited to (0, 1].
      const px = dy * e2z - dz * e2y;
      const py = dz * e2x - dx * e2z;
      const pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) return;
      const inv = 1 / det;
      const sx = from.x - v0x, sy = from.y - v0y, sz = from.z - v0z;
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) return;
      const qx = sy * e1z - sz * e1y;
      const qy = sz * e1x - sx * e1z;
      const qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) return;
      const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (hit <= 0 || hit > 1) return;
      if (hit < bestT) { bestT = hit; bestTri = t; }
    });

  if (bestTri < 0) return null;
  const b = bestTri * 9;
  let nx = normals[bestTri * 3], ny = normals[bestTri * 3 + 1], nz = normals[bestTri * 3 + 2];
  // Face the truck. Winding in a BIN says which side is drawn, not which side is outside.
  if ((from.x - tris[b]) * nx + (from.y - tris[b + 1]) * ny + (from.z - tris[b + 2]) * nz < 0) {
    nx = -nx; ny = -ny; nz = -nz;
  }
  const depth = -((to.x - tris[b]) * nx + (to.y - tris[b + 1]) * ny + (to.z - tris[b + 2]) * nz);
  return { depth: Math.max(0, depth), normal: { x: nx, y: ny, z: nz } };
}
