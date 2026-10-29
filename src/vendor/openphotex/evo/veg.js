import { splitEvoLines, evoNumbers } from "./text.js";
/** Trees per sector side, the most trees one sector holds, and a sector's side in feet. */
export const EVO_TREE_SECTORS = 16;
export const EVO_TREES_PER_SECTOR = 100;
export const EVO_TREE_SECTOR_FT = 512;
/** A tree's yaw about the vertical axis, radians, from its stored byte (0x468910: byte * pi / 128). */
export function evoTreeYaw(value) {
    return (value & 0xff) * (Math.PI / 128);
}
/** A tree's model slot (0..3): its index in its sector's list, low two bits (0x4660b0). */
export function evoTreeSlot(index) {
    return index & 3;
}
/*
  .VEG v6, the Evo 2 vegetation record.

    Version / 6
    maxTrees / <n>
    treeModel / four .SMF names
    treeTex / <name>
    treeLine / <height>
    treeMinDist2 Dense|Medium|Sparse / <n>
    treeSizeX,treeSizeY,treeBiasY / four triples
    whackTrees / <flag>
    grassTexture / <name>
    vegMinSize,vegMaxSize,vegBias / four triples
    vegiColorMin,vegiColorMax,scrubColor / <triple>
    treeGrid / <count> / <count> records of x,y,z,value
    ... repeated

  There are exactly 256 treeGrid blocks, one per 512 ft sector of a 16 x 16 grid: block b is
  the sector at x b % 16, z b / 16 (4x4 Evolution 2 reads them into its sector table, 0x466af0;
  on ALASKA1 block 1 holds x sector 1 and block 16 z sector 1). Each declares its own count, at
  most 100 in the game. BAJBEACH holds 6,169 trees and PEAK 11,342, both well under their
  declared maxTrees. Positions are already Evo world coordinates, on the same axes as .SIT
  placements; the stored height already sits treeBiasY * (1 - r) under the ground, as the
  game's generator wrote it.

  The fourth per-tree value is the byte rand() gave the tree when it was placed, and the game
  uses it as the tree's yaw, value * pi / 128 (0x468910). The model slot is not in the record:
  it is the tree's index in its block, & 3 (0x4660b0).

  Ported from JSTrackViewer's src/worker/evo/veg-parser.js (identical in JSMTM2Converter).
*/
const TREE_MODEL_SLOTS = 4;
export function parseEvoVeg(bytes, sourceName) {
    const lines = splitEvoLines(bytes).map((line) => line.trim());
    const veg = {
        sourceName,
        version: 6,
        maxTrees: 0,
        treeModels: [],
        treeTexture: null,
        treeLine: 0,
        minDistanceSquared: { dense: 0, medium: 0, sparse: 0 },
        treeSizes: [],
        whackTrees: 0,
        grassTexture: null,
        vegSizes: [],
        color: null,
        trees: [],
        gridCount: 0,
        warnings: [],
    };
    let i = 0;
    for (; i < lines.length; i++) {
        const label = lines[i];
        if (label === "treeGrid")
            break;
        const value = lines[i + 1] ?? "";
        if (label === "Version") {
            veg.version = int(value);
            i++;
        }
        else if (label === "maxTrees") {
            veg.maxTrees = int(value);
            i++;
        }
        else if (label === "treeModel") {
            for (let m = 0; m < TREE_MODEL_SLOTS; m++) {
                const name = lines[i + 1 + m];
                if (name)
                    veg.treeModels.push(name.toUpperCase());
            }
            i += TREE_MODEL_SLOTS;
        }
        else if (label === "treeTex") {
            veg.treeTexture = value.toUpperCase() || null;
            i++;
        }
        else if (label === "treeLine") {
            veg.treeLine = float(value);
            i++;
        }
        else if (label === "treeMinDist2 Dense") {
            veg.minDistanceSquared.dense = float(value);
            i++;
        }
        else if (label === "treeMinDist2 Medium") {
            veg.minDistanceSquared.medium = float(value);
            i++;
        }
        else if (label === "treeMinDist2 Sparse") {
            veg.minDistanceSquared.sparse = float(value);
            i++;
        }
        else if (label === "treeSizeX,treeSizeY,treeBiasY") {
            for (let m = 0; m < TREE_MODEL_SLOTS; m++) {
                const triple = evoNumbers(lines[i + 1 + m] ?? "");
                if (triple.length === 3)
                    veg.treeSizes.push({ sizeX: triple[0], sizeY: triple[1], biasY: triple[2] });
            }
            i += TREE_MODEL_SLOTS;
        }
        else if (label === "whackTrees") {
            veg.whackTrees = int(value);
            i++;
        }
        else if (label === "grassTexture") {
            veg.grassTexture = value.toUpperCase() || null;
            i++;
        }
        else if (label === "vegMinSize,vegMaxSize,vegBias") {
            for (let m = 0; m < TREE_MODEL_SLOTS; m++) {
                const triple = evoNumbers(lines[i + 1 + m] ?? "");
                if (triple.length === 3)
                    veg.vegSizes.push({ min: triple[0], max: triple[1], bias: triple[2] });
            }
            i += TREE_MODEL_SLOTS;
        }
        else if (label === "vegiColorMin,vegiColorMax,scrubColor") {
            const triple = evoNumbers(value);
            if (triple.length === 3)
                veg.color = { min: triple[0], max: triple[1], scrub: triple[2] };
            i++;
        }
    }
    for (; i < lines.length; i++) {
        if (lines[i] !== "treeGrid")
            continue;
        const count = int(lines[i + 1]);
        const sector = veg.gridCount;
        veg.gridCount++;
        if (!(count >= 0 && count < 1 << 20)) {
            veg.warnings.push(`${sourceName}: implausible treeGrid count ${lines[i + 1]}`);
            break;
        }
        for (let t = 0; t < count; t++) {
            const record = evoNumbers(lines[i + 2 + t] ?? "");
            if (record.length !== 4) {
                veg.warnings.push(`${sourceName}: malformed tree record in grid ${veg.gridCount}`);
                continue;
            }
            veg.trees.push({ x: record[0], y: record[1], z: record[2], value: record[3], sector, index: t });
        }
        i += 1 + count;
    }
    return veg;
}
function int(value) {
    const parsed = Number.parseInt((value ?? "").trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
}
function float(value) {
    const parsed = Number.parseFloat((value ?? "").trim());
    return Number.isFinite(parsed) ? parsed : 0;
}
