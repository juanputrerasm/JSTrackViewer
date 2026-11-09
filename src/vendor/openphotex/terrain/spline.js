/*
  The Community Patch 4 smooth-terrain spline: a 256 x 256 16-bit height map (32 ft spacing)
  expanded into a 1024 x 1024 one (8 ft spacing).

  This is the engine's rule, published as terrainspline.c (TERRAIN_SPLINE_VERSION 2), which the
  CP4 engine and Traxx 1.7 share verbatim. A "16-bit Spline" track stores only the 256 x 256 map;
  the game expands it at load and the trucks drive on the expanded grid, so every reader that
  shows or drives such a track has to expand it the same way, bit for bit.

  Each segment between two coarse points is a monotone cubic Hermite curve sampled at t = 1/4,
  2/4 and 3/4. A point's tangent is the harmonic mean of its two secants, n / q with
  n = 2 * dl * dr and q = dl + dr, and zero at a crest, a valley or a flat (dl * dr <= 0). The
  weights for the three samples are integers over 64:

    k   A (p1)  B (n1/q1)  C (p2)  D (n2/q2)
    1     54        9        10       -3
    2     32        8        32       -8
    3     10        3        54       -9

    N   = (A * p1 + C * p2) * q1 * q2 + B * n1 * q2 + D * n2 * q1
    den = 64 * q1 * q2
    h   = floor((2N + den) / (2 den)), clamped to 0..65535

  Pass 1 runs along X on the coarse rows (fine rows 4z), pass 2 along Z on every fine column,
  reading the pass-1 values on the coarse rows. Indices wrap at 256 (the world wraps).

  N reaches about 1e17, past the 2^53 a double holds exactly. The common case (gentle slopes)
  fits and is computed with plain numbers; the rest falls back to BigInt, so the result is
  exact everywhere, as the C code's 64-bit integers are.
*/
/** The spline version this port implements (terrainspline.h TERRAIN_SPLINE_VERSION). */
export const TERRAIN_SPLINE_VERSION = 2;
export const TERRAIN_COARSE = 256;
export const TERRAIN_FINE = 1024;
const BA = [0, 54, 32, 10];
const BB = [0, 9, 8, 3];
const BC = [0, 10, 32, 54];
const BD = [0, -3, -8, -9];
const SAFE = 2 ** 52;
/** floor(a / b) for integers with |a| < 2^53 and b > 0, exactly. */
function floorDiv(a, b) {
    const r = a % b;
    const q = (a - r) / b;
    return r < 0 ? q - 1 : q;
}
function clamp16(v) {
    return v < 0 ? 0 : v > 65535 ? 65535 : v;
}
function segBig(p1, p2, n1, q1, n2, q2, k) {
    const N = (BigInt(BA[k] * p1 + BC[k] * p2) * BigInt(q1) * BigInt(q2))
        + BigInt(BB[k]) * BigInt(n1) * BigInt(q2)
        + BigInt(BD[k]) * BigInt(n2) * BigInt(q1);
    const den = 64n * BigInt(q1) * BigInt(q2);
    const a = 2n * N + den;
    const b = 2n * den;
    let q = a / b;
    if (a % b < 0n)
        q -= 1n;
    return clamp16(Number(q));
}
/**
 * One Hermite segment from p1 to p2 at t = k / 4 (k = 1..3), with p0 and p3 its neighbours,
 * clamped to 0..65535. Any other k gives p1 (clamped), as the C code does.
 */
export function terrainSplineSeg(p0, p1, p2, p3, k) {
    if (k < 1 || k > 3)
        return clamp16(p1);
    const d0 = p1 - p0, d1 = p2 - p1, d2 = p3 - p2;
    let n1 = 0, q1 = 1, n2 = 0, q2 = 1;
    const pa = d0 * d1;
    if (pa > 0) {
        n1 = 2 * pa;
        q1 = d0 + d1;
        if (q1 < 0) {
            n1 = -n1;
            q1 = -q1;
        }
    }
    const pb = d1 * d2;
    if (pb > 0) {
        n2 = 2 * pb;
        q2 = d1 + d2;
        if (q2 < 0) {
            n2 = -n2;
            q2 = -q2;
        }
    }
    return segWith(p1, p2, n1, q1, n2, q2, k);
}
function segWith(p1, p2, n1, q1, n2, q2, k) {
    const lin = BA[k] * p1 + BC[k] * p2;
    const qq = q1 * q2;
    // Bound |2N + den| before trusting doubles.
    const bound = 2 * (Math.abs(lin) * qq + 9 * (Math.abs(n1) * q2 + Math.abs(n2) * q1)) + 64 * qq;
    if (bound >= SAFE)
        return segBig(p1, p2, n1, q1, n2, q2, k);
    const N = lin * qq + BB[k] * n1 * q2 + BD[k] * n2 * q1;
    const den = 64 * qq;
    return clamp16(floorDiv(2 * N + den, 2 * den));
}
/** Fill out[o + 1 .. o + 3] (stride `step`) with the three samples of segment p1 -> p2. */
function fillSegment(p0, p1, p2, p3, out, o, step) {
    const d0 = p1 - p0, d1 = p2 - p1, d2 = p3 - p2;
    let n1 = 0, q1 = 1, n2 = 0, q2 = 1;
    const pa = d0 * d1;
    if (pa > 0) {
        n1 = 2 * pa;
        q1 = d0 + d1;
        if (q1 < 0) {
            n1 = -n1;
            q1 = -q1;
        }
    }
    const pb = d1 * d2;
    if (pb > 0) {
        n2 = 2 * pb;
        q2 = d1 + d2;
        if (q2 < 0) {
            n2 = -n2;
            q2 = -q2;
        }
    }
    if (d1 === 0 && n1 === 0 && n2 === 0) {
        // Flat segment with flat tangents: every sample is p1 (N = 64 p1 q1 q2, exact).
        out[o + step] = p1;
        out[o + 2 * step] = p1;
        out[o + 3 * step] = p1;
        return;
    }
    out[o + step] = segWith(p1, p2, n1, q1, n2, q2, 1);
    out[o + 2 * step] = segWith(p1, p2, n1, q1, n2, q2, 2);
    out[o + 3 * step] = segWith(p1, p2, n1, q1, n2, q2, 3);
}
/**
 * Expand a 256 x 256 height map (row = Z, u16 heights) into the 1024 x 1024 smooth grid.
 * fine[4z * 1024 + 4x] equals coarse[z * 256 + x].
 */
export function terrainSplineExpand(coarse) {
    if (coarse.length !== TERRAIN_COARSE * TERRAIN_COARSE) {
        throw new RangeError(`terrainSplineExpand: expected ${TERRAIN_COARSE * TERRAIN_COARSE} heights, got ${coarse.length}`);
    }
    const fine = new Uint16Array(TERRAIN_FINE * TERRAIN_FINE);
    const H = (z, x) => coarse[(z & 255) * 256 + (x & 255)];
    for (let z = 0; z < 256; z++) {
        const row = 4 * z * 1024;
        for (let x = 0; x < 256; x++) {
            const p1 = H(z, x);
            fine[row + 4 * x] = p1;
            fillSegment(H(z, x - 1), p1, H(z, x + 1), H(z, x + 2), fine, row + 4 * x, 1);
        }
    }
    const FR = (r, X) => fine[4 * (r & 255) * 1024 + X];
    for (let X = 0; X < 1024; X++) {
        for (let z = 0; z < 256; z++) {
            fillSegment(FR(z - 1, X), FR(z, X), FR(z + 1, X), FR(z + 2, X), fine, 4 * z * 1024 + X, 1024);
        }
    }
    return fine;
}
