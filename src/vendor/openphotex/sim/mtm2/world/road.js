import { wrapCoord } from "./wrap.js";
/** Bucket side in feet. */
const BUCKET_FT = 32;
/** The steepest a triangle may be and still carry a wheel: its unit normal's y. */
const MIN_NORMAL_Y = 0.5;
export function createRoadGround(base, road) {
    const p = road.positions;
    const count = Math.floor(p.length / 9);
    // Per triangle: the plane y = y0 + sx * (x - x0) + sz * (z - z0), and its unit normal.
    const plane = new Float64Array(count * 6);
    const usable = new Uint8Array(count);
    const buckets = new Map();
    const key = (bx, bz) => bx * 65536 + bz;
    for (let t = 0; t < count; t++) {
        const o = t * 9;
        const ax = p[o], ay = p[o + 1], az = p[o + 2];
        const ux = p[o + 3] - ax, uy = p[o + 4] - ay, uz = p[o + 5] - az;
        const vx = p[o + 6] - ax, vy = p[o + 7] - ay, vz = p[o + 8] - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len === 0)
            continue;
        if (ny < 0) {
            nx = -nx;
            ny = -ny;
            nz = -nz;
        }
        nx /= len;
        ny /= len;
        nz /= len;
        if (ny < MIN_NORMAL_Y)
            continue;
        usable[t] = 1;
        plane.set([-nx / ny, -nz / ny, nx, ny, nz, 0], t * 6);
        const x0 = Math.floor(Math.min(ax, ax + ux, ax + vx) / BUCKET_FT), x1 = Math.floor(Math.max(ax, ax + ux, ax + vx) / BUCKET_FT);
        const z0 = Math.floor(Math.min(az, az + uz, az + vz) / BUCKET_FT), z1 = Math.floor(Math.max(az, az + uz, az + vz) / BUCKET_FT);
        for (let bx = x0; bx <= x1; bx++) {
            for (let bz = z0; bz <= z1; bz++) {
                const k = key(bx, bz);
                let list = buckets.get(k);
                if (!list)
                    buckets.set(k, (list = []));
                list.push(t);
            }
        }
    }
    /** The highest road triangle over (x, z): its index, with its height left in `found`; -1 for none. */
    let found = 0;
    function triangleAt(x, z, limit = Infinity) {
        // The road is in the one world: a point a world away is over the same triangle.
        x = wrapCoord(x);
        z = wrapCoord(z);
        const list = buckets.get(key(Math.floor(x / BUCKET_FT), Math.floor(z / BUCKET_FT)));
        if (!list)
            return -1;
        let best = -1;
        for (const t of list) {
            const o = t * 9;
            const ax = p[o], az = p[o + 2], bx = p[o + 3], bz = p[o + 5], cx = p[o + 6], cz = p[o + 8];
            // Inside when the point is on one side of all three edges (either winding).
            const d1 = (x - ax) * (bz - az) - (z - az) * (bx - ax);
            const d2 = (x - bx) * (cz - bz) - (z - bz) * (cx - bx);
            const d3 = (x - cx) * (az - cz) - (z - cz) * (ax - cx);
            if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
                continue;
            const y = p[o + 1] + plane[t * 6] * (x - ax) + plane[t * 6 + 1] * (z - az);
            if (y > limit)
                continue;
            if (best < 0 || y > found) {
                best = t;
                found = y;
            }
        }
        return best;
    }
    /** The road triangle that is the ground at (x, z), or -1 where the wrapped ground is; `found` is its height. */
    function onRoad(x, z, limit = Infinity) {
        const t = triangleAt(x, z, limit);
        return t >= 0 && found >= base.height(x, z) ? t : -1;
    }
    // A view asks the road ground (`outer`, which a host may give its rules) and then the base.
    const view = (limit) => ({
        get rules() { return outer.rules ?? base.rules; },
        get waterLevelFt() { return base.waterLevelFt; },
        get weather() { return base.weather; },
        set weather(value) { base.weather = value; },
        ramps: base.ramps,
        height: (x, z) => {
            const h = base.height(x, z);
            return triangleAt(x, z, limit()) >= 0 && found > h ? found : h;
        },
        normal: (x, z, out) => {
            const t = onRoad(x, z, limit());
            if (t < 0)
                return base.normal(x, z, out);
            out[0] = plane[t * 6 + 2];
            out[1] = plane[t * 6 + 3];
            out[2] = plane[t * 6 + 4];
            return out;
        },
        surface: (x, y, z) => {
            const t = onRoad(x, z, limit());
            return t < 0 ? base.surface(x, y, z) : Number(road.surfaceValues[t] ?? 100);
        },
    });
    const outer = {
        below: view,
        get waterLevelFt() { return base.waterLevelFt; },
        get weather() { return base.weather; },
        set weather(value) { base.weather = value; },
        ramps: base.ramps,
        roadHeight: (x, z) => (triangleAt(x, z) >= 0 ? found : null),
        height: (x, z) => {
            const h = base.height(x, z);
            return triangleAt(x, z) >= 0 && found > h ? found : h;
        },
        normal: (x, z, out) => {
            const t = onRoad(x, z);
            if (t < 0)
                return base.normal(x, z, out);
            out[0] = plane[t * 6 + 2];
            out[1] = plane[t * 6 + 3];
            out[2] = plane[t * 6 + 4];
            return out;
        },
        surface: (x, y, z) => {
            const t = onRoad(x, z);
            return t < 0 ? base.surface(x, y, z) : Number(road.surfaceValues[t] ?? 100);
        },
    };
    return outer;
}
