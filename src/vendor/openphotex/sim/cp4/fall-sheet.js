/*
  Community Patch 4 beta 0.53 hotfix 3's waterfall sheet (OpenMTM2 docs/CP4_EXE_ANALYSIS.md 16.3, read from
  monster.exe; its author published no source code): what the hotfix does to the written grid of a fall after the
  0.53 build pass (falls.ts). In the engine's order:

  - the flow tubes (16.3.4): a column whose path step comes within 0.25 x spacing of a neighbour's polyline merges
    into the one nearer the crest's centre, ending at the junction; strips and junctions replace the 0.53 quads;
  - the split (16.3.5): a triangle with a vertex torn from the other column (over 3 x spacing, past a dry end or
    behind a ridge 8 ft above both waters) is dropped;
  - the lens counts, the merge weights, the ribbons (16.3.6) for the vertices no kept triangle uses;
  - the per-vertex horizontal flow, the across arc and u (16.3.7), the spread factor, the normals (12.2.8);
  - the ribbon vertices, the slab thickness (16.3.10), the speed ADVECT (16.3.8), the path and tau relaxation
    (16.3.9), the back face, the fold clamp, the zipper and the push of the front face.

  Everything is in feet (positions unwrapped, as falls.ts holds them) and doubles; the caller writes the vertices.
  Pure: no allocation outside the call.
*/
/** The vertex record, 16 numbers (falls.ts FALL_VERTEX), positions in feet here. */
const F = 16;
const PX = 0, PY = 1, PZ = 2, U = 3, TAU = 4, SPD = 5, AIR = 6, EDGE = 7, END = 8, KIND = 9, DROP = 11, NX = 12, NY = 13, NZ = 14, PATH = 15;
/** The hotfix's sheet constants (16.3). */
export const FALL_SHEET = {
    /** A column merges when its path step comes within this x spacing of a neighbour's polyline (16.3.4). */
    mergeSpacing: 0.25,
    /** ... measured over the neighbour's rows r +- this. */
    mergeRows: 64,
    /** A vertex further than this x spacing (3D) from the other column may be torn (16.3.5). */
    splitSpacing: 3,
    /** The ridge that tears a rung stands this far above both waters, ft, sampled every foot. */
    splitRiseFt: 8,
    /** The strip zipper's tie, x spacing. */
    zipTieSpacing: 1,
    /** Ribbon width: clamp(0.35 x weight x spacing, 2 ft, weight x spacing) (16.3.6). */
    ribbonShare: 0.35,
    ribbonMinFt: 2,
    /** A ribbon end ties to a kept neighbour within this many ribbon widths. */
    ribbonTieWidths: 2,
    /** A draped ribbon vertex is put back on the ground plus this. */
    ribbonDrapeFt: 0.3,
    /** The across arc's vertical allowance, ft (16.3.7). */
    acrossSlackFt: 0.25,
    /** ADVECT: |dv / ds| at most this, 1/s (16.3.8). */
    advectSlope: 1.25,
    /** Relaxation: a neighbour's path further than this x spacing flags the vertex; rows +- 8 relax; 64 iterations. */
    relaxSpacing: 0.5,
    relaxRows: 8,
    relaxIterations: 64,
    /** The spread factor: below this share of the crest spacing the water thickens, at most by 1 / 0.25. */
    spreadShare: 0.95,
    spreadMin: 0.25,
    /** Slab (16.3.10). */
    crestDepthFt: 2,
    drapeMaxFt: 2.5,
    drapeMinFt: 0.5,
    bulkFt: 25,
    thickMinFt: 0.05,
    thickMaxFt: 8,
    crestTaperFt: 1,
    footTaperFt: 3,
    /** The fold clamp keeps at least this share of the gap between neighbours. */
    foldKeep: 0.5,
    /** The zipper's weight on the tie's distance, and its passes. */
    zipWeight: 1.75,
    zipPasses: 256,
    zipPairs: 0x30000,
    /** The ribbon join pair table. */
    ribbonPairs: 0x8000,
};
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Horizontal squared distance from (x, z) to a segment. */
function ps2(x, z, ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    let t = 0;
    if (l2 > 1e-18)
        t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
    const ex = ax + dx * t - x, ez = az + dz * t - z;
    return ex * ex + ez * ez;
}
/** Horizontal squared distance between two segments, 0 when they cross strictly. */
function ss2(ax, az, bx, bz, cx, cz, dx, dz) {
    const o1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    const o2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
    const o3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
    const o4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
    if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0)))
        return 0;
    return Math.min(ps2(ax, az, cx, cz, dx, dz), ps2(bx, bz, cx, cz, dx, dz), ps2(cx, cz, ax, az, bx, bz), ps2(dx, dz, ax, az, bx, bz));
}
/** Ribbon width W for a merge weight (16.3.6). */
export function fallRibbonWidth(weight, spacing) {
    const S = FALL_SHEET;
    return Math.min(Math.max(S.ribbonShare * weight * spacing, S.ribbonMinFt), weight * spacing);
}
/**
 * The slab thickness at one sheet vertex, ft (16.3.10): `v0` the crest speed, `vE` the vertex's speed, `air`, `drop`
 * (ft below the crest), `s` its path and `lEnd` the column's last path, `a` and `b` its column counts to the tube's
 * two sides (the lens), `k` the spread factor times the merge weight, `columns` the fall's columns, `ds` and `bulk`
 * wfDepthScale / 100 and waterfallBulk / 100.
 */
export function fallSlabThickness(o) {
    const S = FALL_SHEET;
    const ds = o.ds && o.ds > 0 ? o.ds : 1, bulk = o.bulk && o.bulk > 0 ? o.bulk : 1;
    const h0 = Math.min(S.crestDepthFt * ds, (ds * o.v0 * o.v0) / 32);
    const pile = 2 * h0;
    let hc = o.vE > 1e-9 ? (h0 * o.v0) / o.vE : h0 * o.v0 > 0 ? pile : 0;
    hc *= o.k ?? 1;
    const hDrape = Math.max(Math.min(S.drapeMaxFt, pile, hc), S.drapeMinFt * bulk);
    const hAir = h0 * (1 + (bulk * Math.max(o.drop, 0)) / S.bulkFt);
    const h = clamp(hDrape + (hAir - hDrape) * clamp(o.air, 0, 1), S.thickMinFt, S.thickMaxFt);
    let lens = 0;
    if (o.a + o.b > 0) {
        const t = (o.a - o.b) / (o.a + o.b);
        lens = Math.sqrt(Math.max(0, 1 - t * t));
    }
    const along = Math.min(clamp(o.s / S.crestTaperFt, 0, 1), clamp((o.lEnd - o.s) / S.footTaperFt, 0, 1));
    return o.columns <= 2 ? 0 : h * lens * along;
}
/**
 * The hotfix's sheet from the build pass's columns (`cols`, unchanged by the call). See the header for the stages.
 */
export function buildFallSheet(cols, o) {
    const S = FALL_SHEET;
    const C = cols.length, sp = o.spacing;
    const rc = cols.map((c) => c.x.length);
    const sunk = cols.map((c) => c.sink);
    const px = (c, r) => cols[c].x[r];
    const py = (c, r) => cols[c].y[r];
    const pz = (c, r) => cols[c].z[r];
    // ---- flowMerge (16.3.4): rows down, columns across, the left neighbour before the right.
    const ln = new Int32Array(C), rn = new Int32Array(C), osL = new Int32Array(C), osR = new Int32Array(C), need = new Int32Array(C);
    const endR = new Int32Array(C), lastA = new Int32Array(C), surv = new Int32Array(C).fill(-1), target = new Int32Array(C).fill(-1);
    const wt = new Float64Array(C).fill(1), wtM = new Float64Array(C), merged = new Uint8Array(C);
    const strips = [], juncs = [];
    let maxR = 0, merges = 0;
    for (let c = 0; c < C; c++) {
        ln[c] = c - 1;
        rn[c] = c + 1 < C ? c + 1 : -1;
        endR[c] = rc[c] - 1;
        lastA[c] = sunk[c] ? rc[c] - 2 : rc[c] - 1;
        if (rc[c] > maxR)
            maxR = rc[c];
    }
    const pathPoly2 = (c, n, r, a, b) => {
        const ax = px(c, r - 1), az = pz(c, r - 1), bx = px(c, r), bz = pz(c, r);
        if (a === b)
            return ps2(px(n, a), pz(n, a), ax, az, bx, bz);
        let best = Infinity;
        for (let k = a; k < b; k++) {
            const d = ss2(ax, az, bx, bz, px(n, k), pz(n, k), px(n, k + 1), pz(n, k + 1));
            if (d < best)
                best = d;
        }
        return best;
    };
    const nearestRow = (n, a, b, x, y, z) => {
        let best = a, bd = (px(n, a) - x) ** 2 + (py(n, a) - y) ** 2 + (pz(n, a) - z) ** 2;
        for (let k = a + 1; k <= b; k++) {
            const d = (px(n, k) - x) ** 2 + (py(n, k) - y) ** 2 + (pz(n, k) - z) ** 2;
            if (d < bd) {
                bd = d;
                best = k;
            }
        }
        return best;
    };
    const thr2 = (S.mergeSpacing * sp) ** 2;
    for (let r = 1; r < maxR; r++) {
        for (let c = 0; c < C; c++) {
            for (let side = 0; side < 2; side++) {
                if (merged[c] || r > lastA[c])
                    break;
                const n = side ? rn[c] : ln[c];
                if (n < 0 || r > lastA[n])
                    continue;
                const a = Math.max(0, r - S.mergeRows), b = Math.min(r + S.mergeRows, lastA[n]);
                if (!(pathPoly2(c, n, r, a, b) < thr2))
                    continue;
                const ka = Math.abs(2 * c - (C - 1)), kb = Math.abs(2 * n - (C - 1));
                const [Sv, M] = ka < kb || (ka === kb && c < n) ? [c, n] : [n, c];
                let rm = r;
                if (ln[M] >= 0 && osR[ln[M]] > rm)
                    rm = osR[ln[M]];
                if (rn[M] >= 0 && osL[M] > rm)
                    rm = osL[M];
                if (need[M] > rm)
                    rm = need[M];
                if (rm > rc[M] - 1)
                    rm = rc[M] - 1;
                const x = px(M, rm), y = py(M, rm), z = pz(M, rm);
                const right = Sv === rn[M];
                const Z = right ? ln[M] : rn[M];
                const jS = nearestRow(Sv, right ? osR[M] : osL[Sv], lastA[Sv], x, y, z);
                const jZ = Z >= 0 ? nearestRow(Z, Z === ln[M] ? osL[Z] : osR[M], lastA[Z], x, y, z) : 0;
                if (right) {
                    strips.push({ L: M, R: Sv, sL: osL[M], sR: osR[M], eL: rm, eR: jS });
                    if (Z >= 0) {
                        strips.push({ L: Z, R: M, sL: osL[Z], sR: osR[Z], eL: jZ, eR: rm });
                        juncs.push({ l: Z, m: M, r: Sv, rl: jZ, rm, rr: jS });
                        rn[Z] = Sv;
                        osL[Z] = jZ;
                        osR[Z] = jS;
                    }
                    ln[Sv] = Z;
                }
                else {
                    strips.push({ L: Sv, R: M, sL: osL[Sv], sR: osR[Sv], eL: jS, eR: rm });
                    if (Z >= 0) {
                        strips.push({ L: M, R: Z, sL: osL[M], sR: osR[M], eL: rm, eR: jZ });
                        juncs.push({ l: Sv, m: M, r: Z, rl: jS, rm, rr: jZ });
                        ln[Z] = Sv;
                        osL[Sv] = jS;
                        osR[Sv] = jZ;
                    }
                    rn[Sv] = Z;
                }
                if (jS > need[Sv])
                    need[Sv] = jS;
                if (Z >= 0 && jZ > need[Z])
                    need[Z] = jZ;
                merged[M] = 1;
                endR[M] = rm;
                lastA[M] = rm;
                surv[M] = Sv;
                target[M] = jS;
                wtM[M] = wt[M];
                wt[Sv] = wt[Sv] + wt[M];
                merges++;
                break;
            }
        }
    }
    for (let c = 0; c < C; c++) {
        if (!merged[c] && rn[c] >= 0)
            strips.push({ L: c, R: rn[c], sL: osL[c], sR: osR[c], eL: endR[c], eR: endR[rn[c]] });
    }
    // Stable by the left column.
    const order = strips.map((s, i) => [s, i]).sort((a, b) => a[0].L - b[0].L || a[1] - b[1]).map(([s]) => s);
    // ---- The written grid: a merged column ends at its junction row (no sink), vertex ids column by column.
    const rows = [], base = [], sinkKept = [];
    let SC = 0;
    for (let c = 0; c < C; c++) {
        rows.push(endR[c] + 1);
        base.push(SC);
        SC += endR[c] + 1;
        sinkKept.push(sunk[c] && !merged[c]);
    }
    const colOf = new Int32Array(SC), rowOf = new Int32Array(SC);
    for (let c = 0; c < C; c++)
        for (let r = 0; r < rows[c]; r++) {
            colOf[base[c] + r] = c;
            rowOf[base[c] + r] = r;
        }
    const id = (c, r) => base[c] + r;
    // ---- The torn test (16.3.5).
    const s2 = (S.splitSpacing * sp) ** 2;
    const farCache = new Map();
    const nearestOnColumn = (c, r, n) => {
        const x = px(c, r), y = py(c, r), z = pz(c, r);
        let a = Math.max(0, r - S.mergeRows);
        const b = Math.min(r + S.mergeRows, endR[n]);
        if (a > b)
            a = b;
        let qx = px(n, a), qy = py(n, a), qz = pz(n, a), best, atEnd = a === b && b === endR[n];
        if (a === b)
            best = (qx - x) ** 2 + (qy - y) ** 2 + (qz - z) ** 2;
        else {
            best = Infinity;
            for (let k = a; k < b; k++) {
                const ax = px(n, k), ay = py(n, k), az = pz(n, k);
                const dx = px(n, k + 1) - ax, dy = py(n, k + 1) - ay, dz = pz(n, k + 1) - az;
                const l2 = dx * dx + dy * dy + dz * dz;
                const t = l2 > 1e-18 ? clamp(((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / l2, 0, 1) : 0;
                const ex = ax + dx * t - x, ey = ay + dy * t - y, ez = az + dz * t - z;
                const d = ex * ex + ey * ey + ez * ez;
                if (d < best) {
                    best = d;
                    qx = ax + dx * t;
                    qy = ay + dy * t;
                    qz = az + dz * t;
                    atEnd = k + 1 === endR[n] && t >= 1;
                }
            }
        }
        return { best, qx, qy, qz, atEnd, x, y, z };
    };
    const far = (c, r, n) => {
        const key = (c * 8192 + r) * 2048 + n;
        const hit = farCache.get(key);
        if (hit !== undefined)
            return hit;
        let out = false;
        if (r < 0 || r >= rc[c] || endR[n] < 0 || endR[n] >= rc[n])
            out = true;
        else {
            const q = nearestOnColumn(c, r, n);
            if (q.best > s2) {
                if (q.atEnd && !merged[n] && !sunk[n])
                    out = true;
                else {
                    const dx = q.qx - q.x, dz = q.qz - q.z;
                    const N = Math.ceil(Math.sqrt(dx * dx + dz * dz));
                    const top = Math.max(q.y, q.qy) + S.splitRiseFt;
                    for (let k = 1; k < N; k++) {
                        const t = k / N;
                        if (o.ground(q.x + dx * t, q.z + dz * t) > top) {
                            out = true;
                            break;
                        }
                    }
                }
            }
        }
        farCache.set(key, out);
        return out;
    };
    // ---- flowTris: the strips zipped along the flow, then the junctions; a torn triangle is dropped.
    const front = [];
    let dropped = 0;
    const tieBase = S.zipTieSpacing * sp;
    for (const q of order) {
        let ii = q.sL, jj = q.sR, lastR = false;
        if (q.sL < 0 || q.sL > q.eL || q.eL > endR[q.L] || q.sR < 0 || q.sR > q.eR || q.eR > endR[q.R])
            continue;
        while (ii < q.eL || jj < q.eR) {
            let advR;
            if (ii >= q.eL)
                advR = true;
            else if (jj >= q.eR)
                advR = false;
            else {
                const lx = px(q.L, ii + 1) - px(q.L, ii), ly = py(q.L, ii + 1) - py(q.L, ii), lz = pz(q.L, ii + 1) - pz(q.L, ii);
                const rx = px(q.R, jj + 1) - px(q.R, jj), ry = py(q.R, jj + 1) - py(q.R, jj), rz = pz(q.R, jj + 1) - pz(q.R, jj);
                let fx = lx + rx, fy = ly + ry, fz = lz + rz;
                const fl = Math.hypot(fx, fy, fz);
                const tie = Math.max(tieBase, Math.hypot(lx, ly, lz), Math.hypot(rx, ry, rz));
                if (fl < 1e-12)
                    advR = true;
                else {
                    fx /= fl;
                    fy /= fl;
                    fz /= fl;
                    const ox = (px(q.L, ii) + px(q.R, jj)) / 2, oy = (py(q.L, ii) + py(q.R, jj)) / 2, oz = (pz(q.L, ii) + pz(q.R, jj)) / 2;
                    const pa = (px(q.L, ii + 1) - ox) * fx + (py(q.L, ii + 1) - oy) * fy + (pz(q.L, ii + 1) - oz) * fz;
                    const pb = (px(q.R, jj + 1) - ox) * fx + (py(q.R, jj + 1) - oy) * fy + (pz(q.R, jj + 1) - oz) * fz;
                    advR = !lastR;
                    if (advR && pb > pa + tie)
                        advR = false;
                    if (!advR && pa > pb + tie)
                        advR = true;
                }
            }
            if (advR) {
                if (far(q.L, ii, q.R) || far(q.R, jj, q.L) || far(q.R, jj + 1, q.L))
                    dropped++;
                else
                    front.push(id(q.L, ii), id(q.R, jj), id(q.R, jj + 1));
                jj++;
                lastR = true;
            }
            else {
                if (far(q.L, ii, q.R) || far(q.R, jj, q.L) || far(q.L, ii + 1, q.R))
                    dropped++;
                else
                    front.push(id(q.L, ii), id(q.R, jj), id(q.L, ii + 1));
                ii++;
                lastR = false;
            }
        }
    }
    for (const j of juncs) {
        if (j.rl < 0 || j.rl > endR[j.l] || j.rm < 0 || j.rm > endR[j.m] || j.rr < 0 || j.rr > endR[j.r])
            continue;
        if (far(j.l, j.rl, j.m) || far(j.l, j.rl, j.r) || far(j.m, j.rm, j.l) || far(j.m, j.rm, j.r) || far(j.r, j.rr, j.l) || far(j.r, j.rr, j.m)) {
            dropped++;
            continue;
        }
        front.push(id(j.l, j.rl), id(j.m, j.rm), id(j.r, j.rr));
    }
    const nFront = front.length / 3;
    // Cross-column edges of the kept sheet triangles, in triangle order.
    const edges = [];
    for (let t = 0; t < nFront; t++) {
        for (let k = 0; k < 3; k++) {
            const a = front[3 * t + k], b = front[3 * t + ((k + 1) % 3)];
            if (colOf[a] !== colOf[b])
                edges.push(colOf[a] < colOf[b] ? [a, b] : [b, a]);
        }
    }
    // ---- Lens counts: columns from the tube's left side and from its right, over the kept triangles.
    const BIG = 0x3fffffff;
    const lensA = new Int32Array(SC).fill(BIG), lensB = new Int32Array(SC).fill(BIG);
    const byHi = Array.from({ length: C }, () => []), byLo = Array.from({ length: C }, () => []);
    edges.forEach(([lo, hi], i) => { byHi[colOf[hi]].push(i); byLo[colOf[lo]].push(i); });
    for (let c = 0; c < C; c++) {
        for (const i of byHi[c]) {
            const [lo, hi] = edges[i];
            if (lensA[lo] + 1 < lensA[hi])
                lensA[hi] = lensA[lo] + 1;
        }
        for (let r = 0; r < rows[c]; r++)
            if (lensA[id(c, r)] === BIG)
                lensA[id(c, r)] = 0;
    }
    for (let c = C - 1; c >= 0; c--) {
        for (const i of byLo[c]) {
            const [lo, hi] = edges[i];
            if (lensB[hi] + 1 < lensB[lo])
                lensB[lo] = lensB[hi] + 1;
        }
        for (let r = 0; r < rows[c]; r++)
            if (lensB[id(c, r)] === BIG)
                lensB[id(c, r)] = 0;
    }
    // ---- Merge weights down each column: a merged column's weight joins its survivor below the junction.
    const wf = new Float64Array(SC);
    for (let c = 0; c < C; c++) {
        if (!merged[c])
            continue;
        const s = surv[c], t = target[c];
        if (t + 1 < rows[s])
            wf[id(s, t + 1)] = wf[id(s, t + 1)] + wtM[c];
    }
    for (let c = 0; c < C; c++) {
        let acc = 1;
        for (let r = 0; r < rows[c]; r++) {
            acc += wf[id(c, r)];
            wf[id(c, r)] = acc;
        }
    }
    // ---- Ribbons (16.3.6): the vertices no kept triangle uses.
    const used = new Uint8Array(SC);
    for (const v of front)
        used[v] = 1;
    const loneIdx = new Int32Array(SC).fill(-1);
    let nLone = 0;
    for (let v = 0; v < SC; v++)
        if (!used[v])
            loneIdx[v] = nLone++;
    // Boundary edges (one kept triangle) and each vertex's nearest partner across them (horizontal).
    const edgeUses = new Map();
    for (const [lo, hi] of edges) {
        const k = lo * 0x10000 + hi;
        edgeUses.set(k, (edgeUses.get(k) ?? 0) + 1);
    }
    const partLv = new Int32Array(SC).fill(-1), partRv = new Int32Array(SC).fill(-1);
    const partLd = new Float64Array(SC), partRd = new Float64Array(SC);
    for (const [lo, hi] of edges) {
        if (edgeUses.get(lo * 0x10000 + hi) !== 1)
            continue;
        const d = (px(colOf[hi], rowOf[hi]) - px(colOf[lo], rowOf[lo])) ** 2 + (pz(colOf[hi], rowOf[hi]) - pz(colOf[lo], rowOf[lo])) ** 2;
        if (partLv[hi] < 0 || d < partLd[hi]) {
            partLd[hi] = d;
            partLv[hi] = lo;
        }
        if (partRv[lo] < 0 || d < partRd[lo]) {
            partRd[lo] = d;
            partRv[lo] = hi;
        }
    }
    const ribbonWidth = new Float64Array(SC);
    for (let v = 0; v < SC; v++)
        if (loneIdx[v] >= 0)
            ribbonWidth[v] = fallRibbonWidth(wf[v], sp);
    const taken = new Set();
    const anchor = (j, partner, partD, w) => {
        if (partner < 0 || !(partD <= (S.ribbonTieWidths * w) ** 2))
            return j;
        const key = Math.min(j, partner) * 0x10000 + Math.max(j, partner);
        if (taken.has(key))
            return j;
        if (taken.size < S.ribbonPairs)
            taken.add(key);
        return partner;
    };
    const ribTris = [];
    const RL = (v) => SC + 2 * loneIdx[v], RR = (v) => SC + 2 * loneIdx[v] + 1;
    for (let c = 0; c < C; c++) {
        let r = 0;
        while (r < rows[c]) {
            if (loneIdx[id(c, r)] < 0) {
                r++;
                continue;
            }
            let r1 = r;
            while (r1 + 1 < rows[c] && loneIdx[id(c, r1 + 1)] >= 0)
                r1++;
            if (r > 0) {
                const j = id(c, r - 1), w = ribbonWidth[id(c, r)], v = id(c, r);
                const tL = anchor(j, partLv[j], partLd[j], w), tR = anchor(j, partRv[j], partRd[j], w);
                if (tL !== j)
                    ribTris.push(tL, j, v, tL, v, RL(v));
                else
                    ribTris.push(j, v, RL(v));
                if (tR !== j)
                    ribTris.push(j, tR, RR(v), j, RR(v), v);
                else
                    ribTris.push(j, RR(v), v);
            }
            for (let i = r; i < r1; i++) {
                const a = id(c, i), b = id(c, i + 1);
                ribTris.push(RL(a), a, b, RL(a), b, RL(b), a, RR(a), RR(b), a, RR(b), b);
            }
            if (r1 < rows[c] - 1) {
                const j = id(c, r1 + 1), v = id(c, r1), w = ribbonWidth[v];
                const bL = anchor(j, partLv[j], partLd[j], w), bR = anchor(j, partRv[j], partRd[j], w);
                ribTris.push(RL(v), v, j);
                if (bL !== j)
                    ribTris.push(RL(v), j, bL);
                if (bR !== j)
                    ribTris.push(v, RR(v), bR, v, bR, j);
                else
                    ribTris.push(v, RR(v), j);
            }
            r = r1 + 1;
        }
    }
    // ---- The sheet's vertices: the build pass's fields, merged columns' end 1 on every row.
    const NR = SC + 2 * nLone;
    const V = new Float64Array(NR * F);
    for (let c = 0; c < C; c++) {
        const col = cols[c];
        for (let r = 0; r < rows[c]; r++) {
            const o2 = id(c, r) * F;
            V[o2 + PX] = col.x[r];
            V[o2 + PY] = col.y[r];
            V[o2 + PZ] = col.z[r];
            V[o2 + U] = col.s;
            V[o2 + TAU] = col.tau[r];
            V[o2 + SPD] = col.speed[r];
            V[o2 + AIR] = col.air[r];
            V[o2 + EDGE] = col.edge;
            V[o2 + END] = merged[c] ? 1 : col.end[r];
            V[o2 + KIND] = 0;
            V[o2 + 10] = o.slot;
            V[o2 + DROP] = col.drop[r];
            V[o2 + NX] = 0;
            V[o2 + NY] = 1;
            V[o2 + NZ] = 0;
            V[o2 + PATH] = col.path[r];
        }
    }
    const has = (c, r) => c >= 0 && c < C && r < rows[c] && !(sinkKept[c] && r === rows[c] - 1);
    // ---- Per-vertex horizontal flow and the (along, vertical) tangent.
    const flowX = new Float64Array(SC), flowZ = new Float64Array(SC), tanH = new Float64Array(SC), tanV = new Float64Array(SC);
    for (let c = 0; c < C; c++) {
        let fx = cols[c].fx, fz = cols[c].fz;
        const fl = Math.hypot(fx, fz);
        if (fl >= 1e-12) {
            fx /= fl;
            fz /= fl;
        }
        else {
            fx = 1;
            fz = 0;
        }
        const m = rows[c];
        for (let i = 0; i < m; i++) {
            const next = i + 1 < m && (!sinkKept[c] || i !== m - 2) ? i + 1 : i;
            const prev = i === 0 ? 0 : i - 1;
            const a = id(c, prev) * F, b = id(c, next) * F;
            const dx = V[b + PX] - V[a + PX], dy = V[b + PY] - V[a + PY], dz = V[b + PZ] - V[a + PZ];
            const h = Math.hypot(dx, dz);
            // The engine tests in vertex units (1/256 ft): at least 1e-6, and not steeper than |h| < 0.1 |d|.
            if (h * 256 >= 1e-6 && Math.hypot(h, dy) * 0.1 <= h) {
                let nx = dx / h, nz = dz / h;
                if (nx * fx + nz * fz < 0) {
                    nx = -nx;
                    nz = -nz;
                }
                fx = nx;
                fz = nz;
            }
            const v = id(c, i);
            flowX[v] = fx;
            flowZ[v] = fz;
            const along = dx * fx + dz * fz, tl = Math.hypot(along, dy);
            if (tl * 256 >= 1e-9) {
                tanH[v] = along / tl;
                tanV[v] = dy / tl;
            }
            else {
                tanH[v] = 1;
                tanV[v] = 0;
            }
        }
    }
    {
        const sx = new Float64Array(SC), sz = new Float64Array(SC);
        for (let c = 0; c < C; c++) {
            for (let r = 0; r < rows[c]; r++) {
                let ax = 0, az = 0;
                for (let cc = c - 2; cc <= c + 2; cc++)
                    for (let rr = r - 2; rr <= r + 2; rr++) {
                        if (rr < 0 || !has(cc, rr))
                            continue;
                        ax += flowX[id(cc, rr)];
                        az += flowZ[id(cc, rr)];
                    }
                const l = Math.hypot(ax, az), v = id(c, r);
                if (l >= 1e-9) {
                    sx[v] = ax / l;
                    sz[v] = az / l;
                }
                else {
                    sx[v] = flowX[v];
                    sz[v] = flowZ[v];
                }
            }
        }
        flowX.set(sx);
        flowZ.set(sz);
    }
    // ---- The across arc per row and u (16.3.7).
    const across = new Float64Array(SC), rawU = new Float64Array(SC);
    for (let r = 0; r < maxR; r++) {
        const live = [];
        for (let c = 0; c < C; c++)
            if (has(c, r))
                live.push(c);
        if (!live.length)
            continue;
        const A = new Float64Array(live.length);
        for (let k = 1; k < live.length; k++) {
            const a = id(live[k - 1], r), b = id(live[k], r);
            let fx = flowX[a] + flowX[b], fz = flowZ[a] + flowZ[b];
            let l = Math.hypot(fx, fz);
            if (l < 1e-9) {
                fx = flowX[b];
                fz = flowZ[b];
                l = 1;
            }
            fx /= l;
            fz /= l;
            const dx = V[b * F + PX] - V[a * F + PX], dy = V[b * F + PY] - V[a * F + PY], dz = V[b * F + PZ] - V[a * F + PZ];
            const along = dx * fx + dz * fz;
            let lateral = dz * fx - dx * fz;
            const off = Math.min(Math.abs(tanV[a] * along - tanH[a] * dy), Math.abs(tanV[b] * along - tanH[b] * dy)) - S.acrossSlackFt;
            if (off > 0)
                lateral = (lateral < 0 ? -1 : 1) * Math.sqrt(off * off + lateral * lateral);
            A[k] = A[k - 1] + lateral;
        }
        let mean = 0;
        for (const v of A)
            mean += v;
        mean /= live.length;
        live.forEach((c, k) => { across[id(c, r)] = A[k] - mean; });
        // The anchor: the column with this row nearest the middle (C / 2, then C / 2 - 1, C / 2 + 1, ...).
        const mid = Math.floor(C / 2);
        let anc = -1;
        for (let k = 0; k < C && anc < 0; k++) {
            if (mid - k >= 0 && has(mid - k, r))
                anc = mid - k;
            else if (mid + k < C && has(mid + k, r))
                anc = mid + k;
        }
        if (anc < 0)
            continue;
        const value = anc === mid || r === 0 ? cols[anc].s : rawU[id(anc, r - 1)];
        for (const c of live)
            rawU[id(c, r)] = value + across[id(c, r)] - across[id(anc, r)];
    }
    for (let c = 0; c < C; c++) {
        const m = rows[c] - (sinkKept[c] ? 1 : 0);
        const W = [1, 2, 3, 2, 1];
        for (let r = 0; r < m; r++) {
            let sum = 0, wsum = 0;
            for (let k = -2; k <= 2; k++) {
                const rr = r + k;
                if (rr < 0 || rr >= m)
                    continue;
                sum += W[k + 2] * rawU[id(c, rr)];
                wsum += W[k + 2];
            }
            V[id(c, r) * F + U] = sum / wsum;
        }
        if (sinkKept[c] && rows[c] > 1)
            V[id(c, rows[c] - 1) * F + U] = V[id(c, rows[c] - 2) * F + U];
    }
    // ---- The spread factor: water squeezed across under 95 % of its crest spacing thickens.
    const spread = new Float64Array(SC).fill(1);
    for (let c = 0; c < C; c++) {
        const m = rows[c];
        for (let r = 0; r < m; r++) {
            const rr = sinkKept[c] && r === m - 1 ? r - 1 : r;
            let l = c;
            while (l > 0 && !has(l - 1, rr))
                l--;
            let cl = l >= 1 ? l - 1 : l;
            let rt = c;
            while (rt < C - 1 && !has(rt + 1, rr))
                rt++;
            let cr = rt < C - 1 ? rt + 1 : rt;
            if (!has(cl, rr))
                cl = c;
            if (!has(cr, rr))
                cr = c;
            if (cl === cr || rr < 0)
                continue;
            const du0 = V[id(cr, 0) * F + U] - V[id(cl, 0) * F + U];
            if (!(du0 > 1e-6))
                continue;
            const ratio = Math.max((V[id(cr, rr) * F + U] - V[id(cl, rr) * F + U]) / du0, S.spreadMin);
            if (ratio < S.spreadShare)
                spread[id(c, r)] = S.spreadShare / ratio;
        }
    }
    // ---- Normals (12.2.8) on the written grid; the sink takes the row above's.
    for (let c = 0; c < C; c++) {
        const m = rows[c], col = cols[c];
        for (let r = 0; r < m; r++) {
            const p = (cc, rr, k) => V[id(cc, rr) * F + k];
            const ra = Math.min(r + 1, m - 1), rb = Math.max(r - 1, 0);
            let Dx = p(c, ra, PX) - p(c, rb, PX), Dy = p(c, ra, PY) - p(c, rb, PY), Dz = p(c, ra, PZ) - p(c, rb, PZ);
            if ((Dx * Dx + Dy * Dy + Dz * Dz) * 65536 < 1e-6) {
                Dx = col.fx;
                Dy = 0;
                Dz = col.fz;
            }
            const cn = c + 1 < C && rows[c + 1] > r ? c + 1 : c, cp = c - 1 >= 0 && rows[c - 1] > r ? c - 1 : c;
            let Ax = p(cn, r, PX) - p(cp, r, PX), Ay = p(cn, r, PY) - p(cp, r, PY), Az = p(cn, r, PZ) - p(cp, r, PZ);
            if ((Ax * Ax + Ay * Ay + Az * Az) * 65536 < 1e-6) {
                Ax = -col.fz;
                Ay = 0;
                Az = col.fx;
            }
            let nx = Dy * Az - Dz * Ay, ny = Dz * Ax - Dx * Az, nz = Dx * Ay - Dy * Ax;
            const l = Math.hypot(nx, ny, nz);
            if (l < 1e-12) {
                nx = 0;
                ny = 1;
                nz = 0;
            }
            else {
                nx /= l;
                ny /= l;
                nz /= l;
            }
            if (nx * col.fx + ny + nz * col.fz < 0) {
                nx = -nx;
                ny = -ny;
                nz = -nz;
            }
            const o2 = id(c, r) * F;
            V[o2 + NX] = nx;
            V[o2 + NY] = ny;
            V[o2 + NZ] = nz;
        }
        if (sinkKept[c] && m > 1) {
            const a = id(c, m - 1) * F, b = id(c, m - 2) * F;
            V[a + NX] = V[b + NX];
            V[a + NY] = V[b + NY];
            V[a + NZ] = V[b + NZ];
        }
    }
    // ---- The ribbon vertices: two copies of each lone vertex, W / 2 either side across its flow.
    for (let v = 0; v < SC; v++) {
        const k = loneIdx[v];
        if (k < 0)
            continue;
        const c = colOf[v], r = rowOf[v], w = ribbonWidth[v];
        let fx = flowX[v], fz = flowZ[v], fl = Math.hypot(fx, fz);
        if (fl < 1e-9) {
            fx = cols[c].fx;
            fz = cols[c].fz;
            fl = Math.hypot(fx, fz) || 1;
        }
        const qx = -fz / fl, qz = fx / fl;
        const draped = V[v * F + AIR] === 0 && (!sinkKept[c] || r < rows[c] - 2);
        for (let side = 0; side < 2; side++) {
            const off = side ? w / 2 : -w / 2, o2 = (SC + 2 * k + side) * F;
            for (let f = 0; f < F; f++)
                V[o2 + f] = V[v * F + f];
            const x = V[v * F + PX] + qx * off, z = V[v * F + PZ] + qz * off;
            const y = draped ? o.ground(x, z) + S.ribbonDrapeFt : V[v * F + PY];
            V[o2 + PX] = x;
            V[o2 + PY] = y;
            V[o2 + PZ] = z;
            V[o2 + U] = V[v * F + U] + off;
            V[o2 + EDGE] = 0;
            V[o2 + KIND] = 0;
            V[o2 + DROP] = o.crestY - y;
        }
        V[v * F + EDGE] = 1;
        lensA[v] = 1;
        lensB[v] = 1;
    }
    // ---- The air flags (row 0 takes row 1's; a ribbon its source's) and the slab thickness (16.3.10).
    const flag = new Uint8Array(NR);
    const thick = new Float64Array(NR);
    for (let c = 0; c < C; c++) {
        const m = rows[c];
        const lEnd = merged[c] ? 1e30 : V[id(c, m - 1) * F + PATH];
        for (let r = 0; r < m; r++) {
            const v = id(c, r), o2 = v * F;
            thick[v] = fallSlabThickness({
                v0: o.speed, vE: V[o2 + SPD], air: V[o2 + AIR], drop: V[o2 + DROP], s: V[o2 + PATH], lEnd,
                a: lensA[v], b: lensB[v], k: spread[v] * wf[v], columns: C, ds: o.depthScale, bulk: o.bulk,
            });
            flag[v] = V[o2 + AIR] > 0 ? 1 : 0;
        }
        if (m > 1)
            flag[id(c, 0)] = flag[id(c, 1)];
    }
    for (let v = 0; v < SC; v++)
        if (loneIdx[v] >= 0)
            flag[RL(v)] = flag[RR(v)] = flag[v];
    // ---- ADVECT (16.3.8): [1 2 1] across the row, then |dv / ds| <= 1.25 down the column.
    {
        const old = new Float64Array(SC);
        for (let v = 0; v < SC; v++)
            old[v] = V[v * F + SPD];
        const across1 = new Float64Array(old);
        for (let r = 0; r < maxR; r++) {
            for (let c = 0; c < C; c++) {
                if (!has(c, r))
                    continue;
                let n = 0, sum = 2 * old[id(c, r)];
                for (let l = c - 1; l >= 0; l--)
                    if (has(l, r)) {
                        sum += old[id(l, r)];
                        n++;
                        break;
                    }
                for (let rr = c + 1; rr < C; rr++)
                    if (has(rr, r)) {
                        sum += old[id(rr, r)];
                        n++;
                        break;
                    }
                across1[id(c, r)] = sum / (2 + n);
            }
        }
        for (let c = 0; c < C; c++) {
            for (let r = 0; r < rows[c]; r++) {
                const v = id(c, r);
                let s = across1[v];
                if (r > 0) {
                    const prev = V[(v - 1) * F + SPD];
                    const ds = Math.max(0, V[v * F + PATH] - V[(v - 1) * F + PATH]);
                    s = clamp(s, prev - S.advectSlope * ds, prev + S.advectSlope * ds);
                }
                V[v * F + SPD] = s;
            }
        }
        for (let v = 0; v < SC; v++)
            if (loneIdx[v] >= 0)
                V[RL(v) * F + SPD] = V[RR(v) * F + SPD] = V[v * F + SPD];
    }
    // ---- Path and tau relaxation (16.3.9), with each vertex's nearest kept neighbours across.
    const partL = new Int32Array(SC).fill(-1), partR = new Int32Array(SC).fill(-1);
    {
        const bL = new Float64Array(SC).fill(1e300), bR = new Float64Array(SC).fill(1e300);
        for (const [lo, hi] of edges) {
            const d = (V[hi * F + PX] - V[lo * F + PX]) ** 2 + (V[hi * F + PY] - V[lo * F + PY]) ** 2 + (V[hi * F + PZ] - V[lo * F + PZ]) ** 2;
            if (d < bL[hi]) {
                bL[hi] = d;
                partL[hi] = lo;
            }
            if (d < bR[lo]) {
                bR[lo] = d;
                partR[lo] = hi;
            }
        }
        // The last row of each column, and a water column's water row, stay where they are.
        const pinned = new Uint8Array(SC);
        for (let c = 0; c < C; c++) {
            pinned[id(c, rows[c] - 1)] = 1;
            if (sinkKept[c] && rows[c] > 1)
                pinned[id(c, rows[c] - 2)] = 1;
        }
        const path = new Float64Array(SC), tau = new Float64Array(SC);
        for (let v = 0; v < SC; v++) {
            path[v] = V[v * F + PATH];
            tau[v] = V[v * F + TAU];
        }
        const p0 = new Float64Array(path), t0 = new Float64Array(tau);
        const nb = (v, w) => (w < 0 || pinned[w] ? -1 : w);
        const flagged = new Uint8Array(SC);
        const lim = S.relaxSpacing * sp;
        for (let v = 0; v < SC; v++) {
            if (pinned[v])
                continue;
            const l = nb(v, partL[v]), r = nb(v, partR[v]);
            if ((l >= 0 && Math.abs(path[l] - path[v]) > lim) || (r >= 0 && Math.abs(path[r] - path[v]) > lim))
                flagged[v] = 1;
        }
        const relax = new Uint8Array(SC);
        let any = 0;
        for (let c = 0; c < C; c++) {
            const m = rows[c];
            if (m <= 1)
                continue;
            for (let r = 1; r < m; r++) {
                const v = id(c, r);
                if (pinned[v])
                    continue;
                for (let k = r - S.relaxRows; k <= r + S.relaxRows; k++)
                    if (k >= 0 && k < m && flagged[id(c, k)]) {
                        relax[v] = 1;
                        any++;
                        break;
                    }
            }
        }
        if (any) {
            const np = new Float64Array(SC), nt = new Float64Array(SC);
            for (let it = 0; it < S.relaxIterations; it++) {
                np.set(path);
                nt.set(tau);
                for (let c = 0; c < C; c++) {
                    const m = rows[c];
                    for (let r = 1; r < m; r++) {
                        const v = id(c, r);
                        if (!relax[v])
                            continue;
                        const l = nb(v, partL[v]), rr = nb(v, partR[v]);
                        let n = 1, sp2 = path[v - 1] + (p0[v] - p0[v - 1]), st = tau[v - 1] + (t0[v] - t0[v - 1]);
                        if (l >= 0) {
                            sp2 += path[l];
                            st += tau[l];
                            n++;
                        }
                        if (rr >= 0) {
                            sp2 += path[rr];
                            st += tau[rr];
                            n++;
                        }
                        if (r + 1 < m) {
                            sp2 += path[v + 1] - (p0[v + 1] - p0[v]);
                            st += tau[v + 1] - (t0[v + 1] - t0[v]);
                            n++;
                        }
                        np[v] = sp2 / n;
                        nt[v] = st / n;
                    }
                }
                path.set(np);
                tau.set(nt);
            }
        }
        for (let c = 0; c < C; c++) {
            for (let r = 0; r < rows[c]; r++) {
                const v = id(c, r);
                let p = Math.fround(path[v]), t = Math.fround(tau[v]);
                if (r > 0) {
                    p = Math.max(p, V[(v - 1) * F + PATH]);
                    t = Math.max(t, V[(v - 1) * F + TAU]);
                }
                V[v * F + PATH] = p;
                V[v * F + TAU] = t;
            }
        }
        for (let v = 0; v < SC; v++) {
            if (loneIdx[v] < 0)
                continue;
            for (const w of [RL(v), RR(v)]) {
                V[w * F + PATH] = V[v * F + PATH];
                V[w * F + TAU] = V[v * F + TAU];
            }
        }
    }
    // ---- The back face (kind 2): the corners of every front triangle with an airborne corner, unpushed.
    const frontAll = front.concat(ribTris);
    const backOf = new Int32Array(NR).fill(-1);
    let nBack = 0, nBackTris = 0;
    if (C > 2) {
        const mark = new Uint8Array(NR);
        for (let t = 0; t < frontAll.length; t += 3) {
            const a = frontAll[t], b = frontAll[t + 1], c = frontAll[t + 2];
            if (flag[a] || flag[b] || flag[c]) {
                mark[a] = mark[b] = mark[c] = 1;
                nBackTris++;
            }
        }
        for (let v = 0; v < NR; v++)
            if (mark[v])
                backOf[v] = NR + nBack++;
    }
    const verts = new Float64Array((NR + nBack) * F);
    verts.set(V);
    for (let v = 0; v < NR; v++) {
        const b = backOf[v];
        if (b < 0)
            continue;
        const o2 = b * F;
        for (let f = 0; f < F; f++)
            verts[o2 + f] = V[v * F + f];
        verts[o2 + KIND] = 2;
        verts[o2 + AIR] = flag[v];
        verts[o2 + NX] = -V[v * F + NX];
        verts[o2 + NY] = -V[v * F + NY];
        verts[o2 + NZ] = -V[v * F + NZ];
    }
    // ---- The fold clamp: neighbours whose pushed faces would close more than half their gap are thinned.
    {
        const factor = new Float64Array(NR).fill(1);
        let hit = false;
        for (let r = 0; r < maxR; r++) {
            let prev = -1;
            for (let c = 0; c < C; c++) {
                if (!has(c, r))
                    continue;
                if (prev >= 0) {
                    const a = id(prev, r), b = id(c, r);
                    const sx = flowX[a] + flowX[b], sz = flowZ[a] + flowZ[b], l = Math.hypot(sx, sz);
                    if (l >= 1e-9) {
                        const qx = -sz / l, qz = sx / l;
                        const closing = (V[b * F + NX] * thick[b] - V[a * F + NX] * thick[a]) * qx + (V[b * F + NZ] * thick[b] - V[a * F + NZ] * thick[a]) * qz;
                        if (closing < 0) {
                            const gap = (V[b * F + PX] - V[a * F + PX]) * qx + (V[b * F + PZ] - V[a * F + PZ]) * qz;
                            if (closing + gap < gap * S.foldKeep) {
                                const k = gap > 0 ? (gap * S.foldKeep) / -closing : 0;
                                if (k < factor[a])
                                    factor[a] = k;
                                if (k < factor[b])
                                    factor[b] = k;
                                hit = true;
                            }
                        }
                    }
                }
                prev = c;
            }
        }
        if (hit)
            for (let v = 0; v < NR; v++)
                thick[v] = thick[v] * factor[v];
    }
    // ---- The zipper: tied neighbours across the tubes differ in thickness by at most 1.75 x their distance.
    {
        const pa = [], pb = [], pw = [];
        const dist = (v, n) => Math.sqrt(nearestOnColumn(colOf[v], rowOf[v], n).best);
        for (const [lo, hi] of edges) {
            if (pa.length >= S.zipPairs)
                break;
            if (!(partL[hi] === lo || partR[lo] === hi || partL[lo] === hi || partR[hi] === lo))
                continue;
            pa.push(lo);
            pb.push(hi);
            pw.push(Math.min(dist(hi, colOf[lo]), dist(lo, colOf[hi])) * S.zipWeight);
        }
        for (let pass = 0; pass < S.zipPasses; pass++) {
            let changed = false;
            for (let i = 0; i < pa.length; i++) {
                const a = pa[i], b = pb[i], w = pw[i];
                if (thick[b] + w < thick[a]) {
                    thick[a] = thick[b] + w;
                    changed = true;
                }
                if (thick[a] + w < thick[b]) {
                    thick[b] = thick[a] + w;
                    changed = true;
                }
            }
            if (!changed)
                break;
        }
    }
    // ---- The front face pushed out along its normal by the thickness (the ribbons' is 0).
    for (let v = 0; v < SC; v++) {
        const o2 = v * F, h = thick[v];
        verts[o2 + PX] = V[o2 + PX] + V[o2 + NX] * h;
        verts[o2 + PY] = V[o2 + PY] + V[o2 + NY] * h;
        verts[o2 + PZ] = V[o2 + PZ] + V[o2 + NZ] * h;
    }
    // ---- Triangles: the back face (reversed), then the front.
    const tris = new Int32Array(3 * nBackTris + frontAll.length);
    let q = 0;
    if (nBack) {
        for (let t = 0; t < frontAll.length; t += 3) {
            const a = frontAll[t], b = frontAll[t + 1], c = frontAll[t + 2];
            if (flag[a] || flag[b] || flag[c]) {
                tris[q++] = backOf[a];
                tris[q++] = backOf[c];
                tris[q++] = backOf[b];
            }
        }
    }
    tris.set(frontAll, q);
    return {
        verts, sheetCount: SC, ribbonCount: 2 * nLone, backCount: nBack, tris, backTris: nBackTris,
        frontTris: nFront, ribbonTris: ribTris.length / 3,
        rows, base, merged: Array.from(merged, (m) => m === 1), sink: sinkKept, ribbonWidth, merges, droppedTris: dropped,
    };
}
/**
 * CountBack (16.3.3): the back-face vertices and triangles of the full grid cut at R rows, over the 12.2.9 pattern,
 * `rows[c]` the column's grid rows and `flags[c][r]` its air flags (row 0 taking row 1's, a sink the water row's).
 * None for fewer than 3 columns.
 */
export function fallCountBack(rows, flags) {
    const C = rows.length;
    if (C <= 2)
        return { verts: 0, tris: 0 };
    const off = [];
    let n = 0;
    for (const m of rows) {
        off.push(n);
        n += m;
    }
    const mark = new Uint8Array(n);
    let tris = 0;
    const T = (c0, r0, c1, r1, c2, r2) => {
        if (!flags[c0][r0] && !flags[c1][r1] && !flags[c2][r2])
            return;
        mark[off[c0] + r0] = mark[off[c1] + r1] = mark[off[c2] + r2] = 1;
        tris++;
    };
    for (let c = 0; c + 1 < C; c++) {
        const ra = rows[c], rb = rows[c + 1], m = Math.min(ra, rb);
        for (let r = 0; r + 1 < m; r++) {
            T(c, r, c + 1, r, c + 1, r + 1);
            T(c, r, c + 1, r + 1, c, r + 1);
        }
        if (ra < rb)
            for (let r = m - 1; r + 1 < rb; r++)
                T(c, m - 1, c + 1, r, c + 1, r + 1);
        else if (rb < ra)
            for (let r = m - 1; r + 1 < ra; r++)
                T(c, r, c + 1, m - 1, c, r + 1);
    }
    let verts = 0;
    for (const v of mark)
        verts += v;
    return { verts, tris };
}
