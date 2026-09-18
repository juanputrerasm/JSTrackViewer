/*
  POD lookups the truck loader needs and the track loader never did.

  JSTrackViewer's pod-format.js resolves a track's assets: one named .SIT, the .LVL it points
  at, and art by title. A truck is addressed differently. Its manifest lives under TRUCK\, its
  models are picked out of MODELS\ by prefix and detail tier rather than by exact name, and the
  four wheels have to be matched per corner. Those rules are ported from JSTruckViewer's
  pod-format.js and kept here rather than added to pod-format.js, so the track path keeps the
  surface it has.

  Everything here is a pure function of an already built pod index.
*/
import { archiveTitle, basenameWithoutExtension, joinPath, normalizeArchiveName } from "../../shared/path-utils.js";

/** Every TRUCK\*.TRK in the archive, in directory order. */
export function findAllTruckManifests(podIndex) {
  return podIndex.entries.filter(
    (entry) => entry.normalizedName.startsWith("TRUCK/") && entry.normalizedName.endsWith(".TRK")
  );
}

export function findEntryByNormalizedName(podIndex, normalizedName) {
  const upper = normalizeArchiveName(normalizedName);
  return podIndex.entries.find((entry) => entry.normalizedName === upper) ?? null;
}

export function findEntryByTitle(podIndex, title) {
  const upper = archiveTitle(title);
  return podIndex.entries.find((entry) => entry.title === upper) ?? null;
}

/** Models under MODELS\ whose title starts with `prefix` and ends with `extension`. */
export function findModelCandidatesByPrefix(podIndex, prefix, extension = ".BIN") {
  const base = basenameWithoutExtension(prefix).toUpperCase();
  const suffix = extension.toUpperCase();
  return podIndex.entries.filter(
    (entry) => entry.normalizedName.startsWith("MODELS/")
      && entry.title.startsWith(base)
      && entry.title.endsWith(suffix)
  );
}

/**
 * A texture's sibling in ART\, with the extension substituted.
 *
 * A manifest names "Black.raw" for a shock texture but the archive may carry Black.PNG
 * instead, so the caller asks for each extension in its own order of preference.
 */
export function findArtEntry(podIndex, textureName, extension) {
  const upperTitle = archiveTitle(textureName);
  const title = upperTitle.includes(".")
    ? upperTitle.replace(/\.[^.]+$/, extension)
    : `${upperTitle}${extension}`;
  return findEntryByNormalizedName(podIndex, joinPath("ART", title)) ?? findEntryByTitle(podIndex, title);
}

/*
  Numbered detail variants of a model stem, highest first.

  In MTM a HIGHER number is a HIGHER detail model: BIGFOOT1.BIN is the full body and
  BIGFOOT.BIN may not exist at all, which is why an exact-name lookup is not enough. The
  engine also truncates long stems to seven characters when deriving these names, so a caller
  that misses on the full stem retries on the first seven.
*/
export function findNumberedLodEntries(podIndex, stem) {
  const escaped = escapeForRegExp(stem);
  const matcher = new RegExp(`^${escaped}(\\d+)\\.BIN$`, "i");
  return podIndex.entries
    .map((entry) => ({
      entry,
      match: entry.normalizedName.startsWith("MODELS/") ? entry.title.match(matcher) : null,
    }))
    .filter(({ match }) => match)
    .sort((a, b) => Number(b.match[1]) - Number(a.match[1]))
    .map(({ entry }) => entry);
}

export function escapeForRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
