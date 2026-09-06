import { splitEvoLines, evoNumbers } from "./evo-text.js";

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

  There are exactly 256 treeGrid blocks - one per terrain row - and each declares its own
  count, so an empty band is a zero rather than a missing block. BAJBEACH holds 6,169 trees
  across its 256 blocks and PEAK 11,342, both well under their declared maxTrees. Positions
  are already Evo world coordinates, on the same axes as .SIT placements.

  The fourth per-tree value spans the full 0..255 byte range in both stock tracks and its
  meaning is unknown. It is preserved verbatim; the viewer derives a deterministic model
  choice from it so that placement is stable between loads, but that mapping is a viewer
  convention, not a decoded fact.
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
    if (label === "treeGrid") break;
    const value = lines[i + 1] ?? "";
    if (label === "Version") { veg.version = int(value); i++; }
    else if (label === "maxTrees") { veg.maxTrees = int(value); i++; }
    else if (label === "treeModel") {
      for (let m = 0; m < TREE_MODEL_SLOTS; m++) {
        const name = lines[i + 1 + m];
        if (name) veg.treeModels.push(name.toUpperCase());
      }
      i += TREE_MODEL_SLOTS;
    } else if (label === "treeTex") { veg.treeTexture = value.toUpperCase() || null; i++; }
    else if (label === "treeLine") { veg.treeLine = float(value); i++; }
    else if (label === "treeMinDist2 Dense") { veg.minDistanceSquared.dense = float(value); i++; }
    else if (label === "treeMinDist2 Medium") { veg.minDistanceSquared.medium = float(value); i++; }
    else if (label === "treeMinDist2 Sparse") { veg.minDistanceSquared.sparse = float(value); i++; }
    else if (label === "treeSizeX,treeSizeY,treeBiasY") {
      for (let m = 0; m < TREE_MODEL_SLOTS; m++) {
        const triple = evoNumbers(lines[i + 1 + m] ?? "");
        if (triple.length === 3) veg.treeSizes.push({ sizeX: triple[0], sizeY: triple[1], biasY: triple[2] });
      }
      i += TREE_MODEL_SLOTS;
    } else if (label === "grassTexture") { veg.grassTexture = value.toUpperCase() || null; i++; }
    else if (label === "vegMinSize,vegMaxSize,vegBias") {
      for (let m = 0; m < TREE_MODEL_SLOTS; m++) {
        const triple = evoNumbers(lines[i + 1 + m] ?? "");
        if (triple.length === 3) veg.vegSizes.push({ min: triple[0], max: triple[1], bias: triple[2] });
      }
      i += TREE_MODEL_SLOTS;
    } else if (label === "vegiColorMin,vegiColorMax,scrubColor") {
      const triple = evoNumbers(value);
      if (triple.length === 3) veg.color = { min: triple[0], max: triple[1], scrub: triple[2] };
      i++;
    }
  }

  for (; i < lines.length; i++) {
    if (lines[i] !== "treeGrid") continue;
    const count = int(lines[i + 1]);
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
      veg.trees.push({ x: record[0], y: record[1], z: record[2], value: record[3] });
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
