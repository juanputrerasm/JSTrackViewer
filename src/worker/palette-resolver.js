import { PALETTES } from "../shared/bundled-palettes.js";

/*
  Choosing the .ACT palette for an 8-bit .RAW texture.

  MTM2 mostly ships a same-stem palette beside each texture, so a single "look for FOO.ACT
  next to FOO.RAW, else use the track palette" rule gets most of the way there. The older
  titles do not: TV, Fury3, Hellbender, MTM1 and a fair number of CPR and MTM2 assets have no
  same-name palette at all, and a texture handed the wrong palette does not fail, it renders
  in the wrong colours. That is the failure this chain exists to prevent.

  The order below is JSPod's, with one addition JSPod cannot make. JSPod inspects a pod with
  no idea which game it belongs to, so it has to offer the bundled palettes as a ranked guess
  and let a person pick. A track viewer has already read the .SIT or .LVL and therefore knows
  the origin, so the bundled palette can be selected outright instead of guessed.

  Ranked, highest first:

    1. A same-stem .ACT beside the texture. The archive putting FOO.ACT next to FOO.RAW is a
       direct statement and is never overridden.
    2. The palette named in the POD1 entry metadata. The 32-byte name field holds a second
       NUL-terminated string for .RAW entries naming the .ACT it was authored against; see
       decodePod1NameField in pod-format.js.
    3. The track's own palette, from the .SIT/.LVL ACT slot. For the flight titles this IS the
       game palette, and for MTM1/MTM2 it is at least the palette the terrain was built with.
    4. The archive's own METALCR2.ACT, then its VGA.ACT. A pod carrying either is telling us
       which family it belongs to, and its copy beats a bundled one: CPR's METALCR2 is not
       MTM1's METALCR2.
    5. The bundled palette for this origin.
    6. Nothing, and the caller falls back to its default.

  A same-stem palette belonging to some OTHER texture is deliberately not in this chain.
  JSPod lists those in its picker but never chooses one automatically, because handing a
  texture an unrelated texture's palette is a guess, whereas METALCR2 is not.
*/

// Where a texture's sibling files are looked for, in order. Mirrors JSPod's findArtEntry.
const ART_DIRS = ["ART/", "MODELS/", "DATA/", "TEXTURES/", ""];

const BUNDLED_BY_ORIGIN = {
  MTM1: PALETTES.metalcr2Mtm1,
  MTM2: PALETTES.metalcr2Mtm1,
  CPR: PALETTES.metalcr2Cpr,
  HB: PALETTES.vgaHB,
  TV: PALETTES.vgaTV,
  F3: PALETTES.vgaTV,
  "TV/F3": PALETTES.vgaTV,
};

export function textureStem(name) {
  const slashified = String(name ?? "").replace(/\\/g, "/").trim().toUpperCase();
  const basename = slashified.includes("/")
    ? slashified.slice(slashified.lastIndexOf("/") + 1)
    : slashified;
  return basename.includes(".") ? basename.slice(0, basename.lastIndexOf(".")) : basename;
}

/** Find `<stem><ext>` in the usual art directories. `ext` includes the dot. */
export function findArtSibling(podIndex, name, ext) {
  const stem = textureStem(name);
  if (!stem) return null;
  const target = stem + ext.toUpperCase();
  for (const dir of ART_DIRS) {
    const hit = podIndex.entries.find((e) => e.normalizedName === dir + target);
    if (hit) return hit;
  }
  return podIndex.entries.find((e) => e.title.toUpperCase() === target) ?? null;
}

/*
  The HD sibling of a texture, if the pod carries one.

  Community Patch 3 packs ART\<stem>.PNG or .TGA beside the legacy pair, and an HD-only pod
  carries no .RAW at all. Everything downstream still refers to the texture by its .RAW name,
  which stays the texture's identity; this only answers "is there a true-colour source for it".

  The fork notes this resolution was originally missing on the terrain path while the model
  paths had it, so an HD-only pod rendered no terrain whatsoever.
*/
export function findHdSibling(podIndex, name) {
  for (const ext of [".PNG", ".TGA"]) {
    const entry = findArtSibling(podIndex, name, ext);
    if (entry) return { entry, extension: ext };
  }
  return null;
}

function findByTitle(podIndex, title) {
  const upper = title.toUpperCase();
  return podIndex.entries.find((e) => e.title.toUpperCase() === upper) ?? null;
}

/**
 * Build a palette resolver for one track.
 *
 * @param {object}   podIndex
 * @param {Function} getBytes      synchronous entry -> Uint8Array
 * @param {string}   origin        MTM1 | MTM2 | CPR | TV/F3 | HB
 * @param {Uint8Array} trackPalette the .SIT/.LVL ACT slot, if the track had one
 */
export function createPaletteResolver(podIndex, getBytes, origin, trackPalette) {
  const cache = new Map();
  const sources = new Map();

  const read = (entry) => {
    if (!entry) return null;
    try {
      const bytes = getBytes(entry);
      return bytes?.length >= 768 ? bytes : null;
    } catch {
      return null;
    }
  };

  // Archive-wide candidates, looked up once rather than per texture.
  const archiveMetal = read(findByTitle(podIndex, "METALCR2.ACT"));
  const archiveVga = read(findByTitle(podIndex, "VGA.ACT"));
  const bundled = BUNDLED_BY_ORIGIN[origin] ?? PALETTES.metalcr2Mtm1;
  const trackAct = trackPalette?.length >= 768 ? trackPalette : null;

  /*
    The two texture classes do NOT rank the same, and conflating them is what sent
    ROCKQRY's CKBOX / STRTGRN / STRTRED to the track palette and rendered them as coloured
    speckle instead of a white chevron and red and green start lights.

    In MTM1, MTM2 and CPR the track's own .ACT is the palette its TERRAIN was built against.
    Shared object art is not authored against it; it is authored against METALCR2, which
    lives in STARTUP.POD and so is never present in the track pod at all. That is exactly why
    JSPod ships the palettes: a single-pod viewer cannot reach the real one. For a model
    texture in those titles the shared palette therefore outranks the track palette.

    The flight titles are the other way round: there is one global palette, the .LVL names it,
    and it is real data out of this pod, so it outranks anything bundled.
  */
  const SHARED_MODEL_PALETTE = new Set(["MTM1", "MTM2", "CPR"]);

  /**
   * @param {string} textureName  the name as the model or TEX list refers to it
   * @param {object} rawEntry     the resolved .RAW pod entry, for its POD1 metadata
   * @param {"model"|"terrain"} kind  which ranking applies
   * @returns {Uint8Array|null}
   */
  function paletteFor(textureName, rawEntry, kind = "model") {
    // Cached per class: the same texture can legitimately resolve differently as terrain art
    // and as model art.
    const key = `${kind}:${textureStem(textureName)}`;
    if (cache.has(key)) return cache.get(key);

    // Callers that already resolved the .RAW pass it in; the rest get it looked up, because
    // rule 2 lives in that entry's POD1 metadata.
    const entry = rawEntry ?? findArtSibling(podIndex, textureName, ".RAW");

    let bytes = null;
    let source = "none";

    const take = (label, value) => {
      if (bytes || !value) return;
      bytes = value;
      source = label;
    };

    // 1. A same-stem .ACT beside the texture always wins.
    take("same-stem", read(findArtSibling(podIndex, textureName, ".ACT")));

    // 2. The palette the archive records for this entry.
    if (!bytes && entry?.paletteName) {
      const named = read(findByTitle(podIndex, entry.paletteName));
      if (named) {
        take(`pod-metadata:${entry.paletteName}`, named);
      } else if (entry.paletteName.toUpperCase() === "METALCR2.ACT") {
        // Named but not packed. This one is standard enough to supply ourselves.
        take("pod-metadata:bundled METALCR2", PALETTES.metalcr2Mtm1);
      }
    }

    // 3+. Class-dependent, per the note above.
    const sharedFirst = kind === "model" && SHARED_MODEL_PALETTE.has(origin);
    if (sharedFirst) {
      if (archiveMetal) take("archive:METALCR2.ACT", archiveMetal);
      else if (archiveVga) take("archive:VGA.ACT", archiveVga);
      take(`bundled:${origin}`, bundled);
      take("track", trackAct);
    } else {
      take("track", trackAct);
      if (archiveMetal) take("archive:METALCR2.ACT", archiveMetal);
      else if (archiveVga) take("archive:VGA.ACT", archiveVga);
      take(`bundled:${origin}`, bundled);
    }

    cache.set(key, bytes);
    sources.set(key, source);
    return bytes;
  }

  /** Per-source counts, for reporting which rule actually carried a track. */
  function sourceSummary() {
    const counts = {};
    for (const source of sources.values()) counts[source] = (counts[source] ?? 0) + 1;
    return counts;
  }

  return { paletteFor, sourceSummary };
}
