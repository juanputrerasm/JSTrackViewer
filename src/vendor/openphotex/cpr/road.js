/*
  The CPR road layer as geometry: the quads and wall panels a `.TRK` describes.

  `parseCprTrk` returns the records; this lays them out, once, for whatever draws the track and
  whatever drives on it, so the two cannot disagree. It follows JSTrackViewer's road layer
  (docs/LEVELS.md, "CPR's road layer"):

    - Each record owns the stretch to the next one; a closed circuit's last record runs back
      to record 0 (`cprSegmentPairs`).
    - Only the slots between the outermost walls are there (`cprVisibleSlots`), and a slot
      collapsed to no width on both records is skipped (`isDegenerateSlot`).
    - A slot's texture is the packed reference of the record that owns the stretch, its U the
      record's own u1..u4 (road tiles carry their edge line on one side, so U is never tiled
      across the width) and its V runs along the stretch, one tile every 128 ft.
    - A wall stands on a cross section point of the owning record and spans to the next
      record's same point, stacked by its type (`CPR_WALL_LAYERS`). Each panel of the stack
      is one of the four strips of a wall texture, or the catch fence.

  Positions are the file's own: `[x, altitude, along]` in feet. The file says nothing of which
  way `along` runs against the terrain's rows; the caller places it.
*/
import { CPR_CROSS_SECTION_MIDPOINT, CPR_SLOT_CURB, CPR_SLOT_ROAD, CPR_TREE_WALL, CPR_WALL_LAYERS, cprSegmentPairs, cprTextureIndex, cprTextureSlice, cprTextureU, cprVisibleSlots, isDegenerateSlot, } from "./track.js";
/*
  Height of one wall panel, in feet: 4/256 of a 256 ft unit (CART.EXE 0x44a1a0, 0x448a80; OpenMTM2
  docs/CPR_PHYSICS.md 10.3). JSTrackViewer had calibrated 4.5 ft from screenshots of Laguna.
*/
export const CPR_WALL_PART_HEIGHT_FT = 4;
/** Feet of track one road texture tile covers along the stretch. */
const ROAD_TILE_FT = 128;
/** The section U values a slot takes when the record writes none (16.16 over 0..256). */
const DEFAULT_U_INNER = 262144;
const DEFAULT_U_OUTER = 16384000;
const point = (p) => [p?.[0] ?? 0, p?.[1] ?? 0, p?.[2] ?? 0];
/** `textureCount` is the `.TTX`'s length: a reference outside it reads as texture 0. */
export function buildCprRoad(surfaces, textureCount = Infinity) {
    const quads = [];
    const walls = [];
    const textureOf = (value) => {
        const index = cprTextureIndex(value ?? 0);
        return index >= 0 && index < textureCount ? index : 0;
    };
    for (const [from, to] of cprSegmentPairs(surfaces)) {
        const a = surfaces[from], b = surfaces[to];
        const aPts = a.points ?? [], bPts = b.points ?? [];
        const pointCount = Math.min(aPts.length, bPts.length);
        if (pointCount < 2)
            continue;
        const visible = cprVisibleSlots(a);
        for (let slot = Math.max(0, visible.first); slot <= Math.min(pointCount - 2, visible.last); slot++) {
            if (isDegenerateSlot(a, slot) && isDegenerateSlot(b, slot))
                continue;
            const coords = a.textureCoordinates?.[slot];
            const p0 = point(aPts[slot]), p1 = point(bPts[slot]), p2 = point(bPts[slot + 1]), p3 = point(aPts[slot + 1]);
            const vRepeat = Math.max(1, Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) / ROAD_TILE_FT);
            quads.push({
                segment: from, slot, corners: [p0, p1, p2, p3], texture: textureOf(coords?.[0] ?? a.textureIndexes?.[slot]),
                uvs: [
                    [cprTextureU(coords?.[1] ?? DEFAULT_U_INNER), 1], [cprTextureU(coords?.[3] ?? DEFAULT_U_INNER), 1 - vRepeat],
                    [cprTextureU(coords?.[4] ?? DEFAULT_U_OUTER), 1 - vRepeat], [cprTextureU(coords?.[2] ?? DEFAULT_U_OUTER), 1],
                ],
            });
        }
        for (let index = 0; index < pointCount; index++) {
            // The owning record decides whether a wall stands here; its texture parts outlive a deleted wall.
            const wallType = a.wallTypes?.[index] ?? 0;
            const layers = CPR_WALL_LAYERS[wallType];
            if (!layers)
                continue;
            const parts = a.wallTextures?.[index] ?? [];
            const p0 = point(aPts[index]), p1 = point(bPts[index]);
            const panels = [];
            let base = 0;
            for (const layer of layers) {
                const top = base + layer.units * CPR_WALL_PART_HEIGHT_FT;
                const value = parts[layer.part ?? 0] ?? parts[0] ?? 0;
                // CART.EXE 0x448a80 reads a strip's rows 1 to 63 of its 64, so the strip next to it never bleeds in.
                const slice = cprTextureSlice(value);
                panels.push({
                    baseFt: base, topFt: top, fence: !!layer.fence, texture: layer.fence ? -1 : textureOf(value),
                    vTop: layer.fence ? 0 : (slice * 64 + 1) / 256, vBottom: layer.fence ? 1 : (slice * 64 + 63) / 256,
                });
                base = top;
            }
            walls.push({
                segment: from, point: index, wallType, solid: wallType !== CPR_TREE_WALL, from: p0, to: p1, heightFt: base,
                // One texture width per stretch, however long (CART.EXE 0x448a80: U from texel 1 to 255).
                uRepeat: 1,
                facing: index < CPR_CROSS_SECTION_MIDPOINT ? 1 : -1, panels,
            });
        }
    }
    return { quads, walls };
}
/**
 * The track's centreline, one point per cross section in the file's order: the place on each section at lateral offset
 * 0 (the `pointOffsets` are measured from it), between the two points either side of it in the section's left half,
 * where the game's sections keep the racing surface. With it, how far the road's own slots (Road and Curb) reach either
 * way from it, on the run of them that holds the centreline. Sections without points are skipped.
 */
export function cprCentreline(surfaces) {
    const out = [];
    for (const s of surfaces) {
        const pts = s.points ?? [], offs = s.pointOffsets ?? [];
        const n = Math.min(pts.length, offs.length);
        if (n < 2)
            continue;
        let pos = null;
        for (let i = 0; i + 1 < n && !pos; i++) {
            const a = offs[i], b = offs[i + 1];
            if (a <= 0 && b >= 0) {
                const t = b === a ? 0 : -a / (b - a);
                const p = point(pts[i]), q = point(pts[i + 1]);
                pos = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
            }
        }
        if (!pos)
            continue;
        // The run of road and curb slots round the centreline, out to the first slot of another kind with any width either
        // way (a slot of no width, as the sections' middle ones often are, does not break it): its outermost offsets. Where a
        // pit lane joins the track with no grass between, it is counted in.
        const types = s.segmentTypes ?? [];
        const slots = Math.min(types.length, n - 1);
        const road = (k) => types[k] === CPR_SLOT_ROAD || types[k] === CPR_SLOT_CURB || Math.abs(offs[k + 1] - offs[k]) < 0.5;
        let centre = -1;
        for (let k = 0; k < slots; k++)
            if (offs[k] <= 0 && offs[k + 1] >= 0 && road(k)) {
                centre = k;
                break;
            }
        let left = 0, right = 0;
        if (centre >= 0) {
            for (let k = centre; k >= 0 && road(k); k--)
                left = Math.max(left, -Math.min(offs[k], offs[k + 1]));
            for (let k = centre; k < slots && road(k); k++)
                right = Math.max(right, Math.max(offs[k], offs[k + 1]));
        }
        out.push({ pos, left, right });
    }
    return out;
}
