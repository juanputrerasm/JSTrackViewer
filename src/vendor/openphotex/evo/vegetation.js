/*
  4x4 Evolution's shade, shadow overlay, grass and generated trees, as 4x4 Evolution 2 builds them
  (OpenMTM2 docs/EVO2_EXE_ANALYSIS.md 2 and 3, from 4x42.exe of 25 September 2001).

  .RTD   131,072 bytes: a 1024 x 1024 bitmask, one bit per 8 ft square, bit x8 + z8 * 1024, least
         significant bit first. A set bit is shade: the terrain's vertex light is scaled to 0.35
         and a truck there casts no sun shadow. The stock files already hold the trees' shade
         (every ALASKA1 tree stands on a set bit, against 12% of the map).
  .SDW   256 x 256 16-bit words, rows along z: per terrain cell, an index into the whole .TEX
         list (so ordinaryCount and up, the shadow group), or 0x8000 for none. 0x4000 is a value
         the game keeps without replacing it (its meaning is not traced).

  Grass is not stored: each cell whose texture has vegetation class c > 0 draws 1 << c tufts
  (four times as many, at most 32, at high detail) from a fixed table of 2,048 tufts that
  repeats every 8 x 8 cells. The table's offsets come from the C library's rand() seeded with
  873; its slots and sizes are drawn again, unseeded, once the .VEG is read, so those are the
  port's (seeded) choice here.

  Trees are generated when a level has no .VEG (every 4x4 Evolution 1 track run by Evo 2): random
  points over the world, kept by the cell's vegetation class and the .VEG spacing. The game's
  rand() is unseeded there too; the seed is the caller's.
*/
import { EVO_TREES_PER_SECTOR, EVO_TREE_SECTORS, EVO_TREE_SECTOR_FT } from "./veg.js";
export const EVO_RTD_SIZE = 1024;
export const EVO_RTD_BYTES = (EVO_RTD_SIZE * EVO_RTD_SIZE) / 8;
export const EVO_RTD_CELL_FT = 8;
/** The terrain's vertex light in shade (0x664684). */
export const EVO_SHADE_LIGHT = 0.35;
export const EVO_SDW_NONE = 0x8000;
export const EVO_SDW_KEEP = 0x4000;
/** The shade map of a .RTD, or null when it is not 131,072 bytes. */
export function parseEvoRtd(bytes) {
    return bytes.length === EVO_RTD_BYTES ? bytes.slice() : null;
}
/** Whether (x, z), in feet, is in shade; the map repeats with the world. */
export function evoShadeAt(rtd, x, z) {
    const cx = Math.floor(x / EVO_RTD_CELL_FT) & (EVO_RTD_SIZE - 1);
    const cz = Math.floor(z / EVO_RTD_CELL_FT) & (EVO_RTD_SIZE - 1);
    const bit = cx + cz * EVO_RTD_SIZE;
    return ((rtd[bit >> 3] >> (bit & 7)) & 1) === 1;
}
/** The shadow words of a .SDW, or null when it is not 256 x 256 words. */
export function parseEvoSdw(bytes) {
    if (bytes.length !== 256 * 256 * 2)
        return null;
    const out = new Uint16Array(256 * 256);
    for (let i = 0; i < out.length; i++)
        out[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    return out;
}
/** The C library's rand() of the Watcom runtime (0x60fa5c): next = next * 1103515245 + 12345. */
export function evoRand(seed) {
    let next = seed >>> 0;
    return () => {
        next = (Math.imul(next, 1103515245) + 12345) >>> 0;
        return (next >>> 16) & 0x7fff;
    };
}
/** The seed the game gives rand() before drawing the grass table (0x469b20). */
export const EVO_GRASS_SEED = 873;
export const EVO_GRASS_TUFTS = 2048;
/**
 * The 2,048-tuft table. Offsets are the game's (rand() seeded with 873); slots and sizes are
 * redrawn from `vegSizes` (the .VEG `vegMinSize,vegMaxSize`) with `seed`, as the game redraws them
 * unseeded. Without sizes they stay the first pass's, uniform [2, 4].
 */
export function evoGrassPattern(vegSizes = [], seed = EVO_GRASS_SEED) {
    const out = {
        x: new Float32Array(EVO_GRASS_TUFTS), z: new Float32Array(EVO_GRASS_TUFTS),
        size: new Float32Array(EVO_GRASS_TUFTS), slot: new Uint8Array(EVO_GRASS_TUFTS),
    };
    const order = (fill) => {
        // The game's loops: 32 tufts, then 8 cell columns, then 8 cell rows (the index is
        // tuft + 32 * (x & 7) + 256 * (z & 7)), walked tuft-major as it wrote them.
        for (let t = 0; t < 32; t++)
            for (let j = 0; j < 8; j++)
                for (let k = 0; k < 8; k++)
                    fill(t + 32 * k + 256 * j);
    };
    const rand = evoRand(EVO_GRASS_SEED);
    order((i) => {
        out.x[i] = rand() * 32 / 32767;
        out.z[i] = rand() * 32 / 32767;
        out.size[i] = rand() * 2 / 32767 + 2;
        out.slot[i] = rand() & 3;
    });
    if (vegSizes.length) {
        const again = evoRand(seed);
        order((i) => {
            const slot = again() & 3;
            const s = vegSizes[slot] ?? vegSizes[0];
            out.slot[i] = slot;
            out.size[i] = (s.max - s.min) * again() / 32767 + s.min;
        });
    }
    return out;
}
/** Tufts a cell of vegetation class `vegClass` draws (0x470f40). */
export function evoGrassCount(vegClass, highDetail = false) {
    if (!(vegClass > 0))
        return 0;
    const n = 1 << vegClass;
    return highDetail ? Math.min(32, n * 4) : n;
}
/** The pattern index of tuft `t` of the cell at (cx, cz), cells of 32 ft. */
export function evoGrassIndex(t, cx, cz) {
    return t + 32 * (cx & 7) + 256 * (cz & 7);
}
/** Trees generated for a level without a .VEG, in sector order like a .VEG's (0x467be0). */
export function evoGenerateTrees(input, seed) {
    const rand = evoRand(seed);
    const sectors = Array.from({ length: EVO_TREE_SECTORS * EVO_TREE_SECTORS }, () => []);
    const spacing = [0, input.minDistanceSquared.sparse, input.minDistanceSquared.medium, input.minDistanceSquared.dense];
    const water = input.waterLevelFt ?? 0;
    const world = EVO_TREE_SECTORS * EVO_TREE_SECTOR_FT;
    for (let k = 0; k < input.maxTrees; k++) {
        const x = rand() * 8191 / 32767;
        const z = rand() * 8191 / 32767;
        const h = input.heightAt(x, z);
        if (!(h < input.treeLine))
            continue;
        const cls = input.vegClassAt(x, z);
        if (!(cls > 0) || h < water + 1 || input.blocked?.(x, z))
            continue;
        const min2 = spacing[cls] ?? 0;
        if (!(min2 > 0))
            continue;
        const sx = Math.min(EVO_TREE_SECTORS - 1, Math.floor((x / world) * EVO_TREE_SECTORS));
        const sz = Math.min(EVO_TREE_SECTORS - 1, Math.floor((z / world) * EVO_TREE_SECTORS));
        const list = sectors[sx + sz * EVO_TREE_SECTORS];
        if (list.length >= EVO_TREES_PER_SECTOR)
            continue;
        if (list.some((t) => (z - t.z) * (z - t.z) + (x - t.x) * (x - t.x) < min2))
            continue;
        const bias = input.biasY[list.length & 3] ?? 0;
        const y = (0 - bias) * rand() / 32767 + bias + h;
        list.push({ x, y, z, value: rand() & 0xff });
    }
    return sectors.flatMap((list, sector) => list.map((t, index) => ({ ...t, sector, index })));
}
