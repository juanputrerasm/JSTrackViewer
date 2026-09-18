/*
  Choosing which BIN entries a truck is built from.

  A TRK names stems, not files. "bigfoot" has to become MODELS\BIGFOOT1.BIN and "bfc" has to
  become four wheels, one per corner, at the highest detail tier the archive carries. These
  rules are ported from JSTruckViewer's truck-worker.js; the comments explain the cases they
  exist for, because none of them is guessable from the format documentation.

  Nothing here decodes geometry. It returns pod entries and warnings, so it can be tested
  against a real archive without a decoder or a renderer.
*/
import { basenameWithoutExtension, joinPath, normalizeArchiveName, replaceExtension } from "../../shared/path-utils.js";
import {
  escapeForRegExp,
  findEntryByNormalizedName,
  findModelCandidatesByPrefix,
  findNumberedLodEntries,
} from "./pod-lookup.js";
import { WHEEL_KEYS } from "./trk-parser.js";

const stemOf = (name) => basenameWithoutExtension(name).toUpperCase();

/**
 * One named model (the body, or the axle).
 *
 * @returns the pod entry, or null with a warning pushed.
 */
export function resolveSingleModelEntry(podIndex, requestedName, label, warnings) {
  if (!requestedName) {
    warnings.push(`Manifest did not define a ${label} model name.`);
    return null;
  }
  const normalized = normalizeArchiveName(requestedName);
  const fullPath = normalized.startsWith("MODELS/") ? normalized : joinPath("MODELS", normalized);
  const exact = findEntryByNormalizedName(podIndex, fullPath)
    ?? findEntryByNormalizedName(podIndex, replaceExtension(fullPath, ".BIN"));
  if (exact) return exact;

  /*
    The numbered-suffix search, for archives where the exact name is absent.

    Among the numbered variants a higher number is the higher detail model, which is why they
    sort descending. They are reduced versions of the unnumbered file rather than better ones:
    in the stock TRUCK2.POD, BIGFOOT.BIN is 236 verts and 248 polys, BIGFOOT1.BIN is 201 and
    218, and BIGFOOT0.BIN is 155 and 183. So the exact match above is both the first rule and
    the best outcome, and this branch only runs for a truck that ships no unnumbered body.
  */
  const stem = stemOf(requestedName);
  const appendedLods = findNumberedLodEntries(podIndex, stem);
  if (appendedLods.length) {
    warnings.push(`Resolved ${label} model ${requestedName} to full-stem LOD ${appendedLods[0].title}.`);
    return appendedLods[0];
  }
  // The engine truncates a long stem to seven characters when deriving these names.
  if (stem.length > 7) {
    const legacyLods = findNumberedLodEntries(podIndex, stem.slice(0, 7));
    if (legacyLods.length) {
      warnings.push(`Resolved ${label} model ${requestedName} through the legacy offset-7 name ${legacyLods[0].title}.`);
      return legacyLods[0];
    }
  }

  const candidates = findModelCandidatesByPrefix(podIndex, requestedName, ".BIN");
  if (candidates.length === 1) {
    warnings.push(`Resolved ${label} model ${requestedName} by prefix to ${candidates[0].title}.`);
    return candidates[0];
  }
  if (candidates.length > 1) {
    warnings.push(`Multiple candidates matched ${label} model ${requestedName}; using ${candidates[0].title}.`);
    return candidates[0];
  }
  warnings.push(`Could not resolve ${label} model ${requestedName}.`);
  return null;
}

/**
 * The four wheels, keyed by their TRK anchor names.
 *
 * @returns {{mapping: Record<string, object|null>, candidates?: object[], enhanced?: boolean}}
 */
export function resolveWheelEntries(podIndex, prefix, warnings) {
  const mapping = {};
  if (!prefix) {
    warnings.push("Manifest did not define tireModelBaseName.");
    return { mapping };
  }
  const prefixMatches = findModelCandidatesByPrefix(podIndex, prefix, ".BIN");
  if (!prefixMatches.length) {
    warnings.push(`Could not resolve any tire models for prefix ${prefix}.`);
    return { mapping };
  }

  /*
    A bare prefix search also catches a longer, unrelated family: "CLASS3TIRE" matches
    CLASS3TIREB16L as readily as CLASS3TIRE16L, and both score 16 on the detail-tier sort, so
    which one a truck got came down to POD directory order. Prefer candidates that are exactly
    the prefix plus a detail tier and a side, the shape every stock tire set uses, and keep the
    loose set only for an archive that names its tires some other way.
  */
  const strictPattern = new RegExp(`^${escapeForRegExp(prefix.toUpperCase())}\\d+[FR]?[LR]\\.BIN$`, "i");
  const strictMatches = prefixMatches.filter((entry) => strictPattern.test(entry.title));
  const candidates = strictMatches.length ? strictMatches : prefixMatches;

  // Highest numeric tier first: 16 beats 12 beats 08.
  const tierOf = (entry) => {
    const m = entry.title.match(/(\d+)[FR]?[LR]\.BIN$/i);
    return m ? parseInt(m[1], 10) : 0;
  };
  const left = candidates.filter((e) => /L\.BIN$/i.test(e.title)).sort((a, b) => tierOf(b) - tierOf(a));
  const right = candidates.filter((e) => /R\.BIN$/i.test(e.title)).sort((a, b) => tierOf(b) - tierOf(a));
  const bestLeft = left[0] ?? null;
  const bestRight = right[0] ?? null;

  // MTM2.1 can supply four distinct high-detail wheels: 16FL / 16FR / 16RL / 16RR.
  const enhanced = {
    "faxle.ltire.static_bpos": pickBySuffix(candidates, "16FL.BIN"),
    "faxle.rtire.static_bpos": pickBySuffix(candidates, "16FR.BIN"),
    "raxle.ltire.static_bpos": pickBySuffix(candidates, "16RL.BIN"),
    "raxle.rtire.static_bpos": pickBySuffix(candidates, "16RR.BIN"),
  };
  const anyEnhanced = Object.values(enhanced).some(Boolean);

  if (anyEnhanced) {
    for (const key of WHEEL_KEYS) {
      const isLeft = key.includes(".ltire.");
      mapping[key] = enhanced[key] ?? (isLeft ? bestLeft : bestRight);
    }
    if (!Object.values(enhanced).every(Boolean)) {
      warnings.push(`MTM2.1 tire set for ${prefix} is incomplete; falling back to the legacy left/right models where needed.`);
    }
    return { mapping, candidates, enhanced: true };
  }

  for (const key of WHEEL_KEYS) {
    mapping[key] = key.includes(".ltire.") ? bestLeft : bestRight;
  }
  return { mapping, candidates };
}

/*
  MTM1 names one tire model outright ("wheel13.bin") and reuses it on all four corners. Its
  sidewalls carry the same hub texture on both faces, so no mirroring is needed.
*/
export function resolveMtm1WheelEntries(podIndex, tireModelName, warnings) {
  const mapping = {};
  if (!tireModelName) {
    warnings.push("Manifest did not define tireModelName.");
    return { mapping };
  }
  const entry = resolveSingleModelEntry(podIndex, tireModelName, "tire", warnings);
  if (!entry) return { mapping };
  for (const key of WHEEL_KEYS) mapping[key] = entry;
  return { mapping, candidates: [entry] };
}

function pickBySuffix(candidates, suffix) {
  const upper = suffix.toUpperCase();
  return candidates.find((entry) => entry.title.toUpperCase().endsWith(upper)) ?? null;
}
