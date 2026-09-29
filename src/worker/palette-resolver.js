import { bundledPalette, findTextureSibling, paletteCandidates, textureStem } from "../vendor/openphotex/index.js";

/*
  Choosing the .ACT palette for an 8-bit .RAW texture.

  The ranking is OpenPhotex's paletteCandidates, which carries the rules and the evidence for
  them. A track viewer has already read the .SIT or .LVL, so it passes the origin and the
  track palette and gets an automatic chain rather than JSPod's picker list; this file reads
  the candidates in order, takes the first real palette, and records which rule carried it.
*/

export { textureStem };

/** Find `<stem><ext>` in the usual art directories. `ext` includes the dot. */
export const findArtSibling = findTextureSibling;

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

  const trackAct = trackPalette?.length >= 768 ? trackPalette : null;

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

    let bytes = null;
    let source = "none";
    const candidates = paletteCandidates(podIndex, { name: textureName, entry: rawEntry }, { origin, automatic: true, kind, trackPalette: !!trackAct });
    for (const candidate of candidates) {
      bytes = candidateBytes(candidate);
      if (bytes) {
        source = candidateLabel(candidate);
        break;
      }
    }

    cache.set(key, bytes);
    sources.set(key, source);
    return bytes;
  }

  function candidateBytes(candidate) {
    switch (candidate.source) {
      case "track": return trackAct;
      case "bundled": return bundledPalette(candidate.bundled);
      case "pod-metadata": return candidate.entry ? read(candidate.entry) : candidate.bundled ? bundledPalette(candidate.bundled) : null;
      default: return read(candidate.entry);
    }
  }

  function candidateLabel(candidate) {
    switch (candidate.source) {
      case "pod-metadata": return candidate.entry ? `pod-metadata:${candidate.name}` : "pod-metadata:bundled METALCR2";
      case "archive": return `archive:${candidate.entry.title}`;
      case "bundled": return `bundled:${origin}`;
      default: return candidate.source;
    }
  }

  /** Per-source counts, for reporting which rule actually carried a track. */
  function sourceSummary() {
    const counts = {};
    for (const source of sources.values()) counts[source] = (counts[source] ?? 0) + 1;
    return counts;
  }

  return { paletteFor, sourceSummary };
}
