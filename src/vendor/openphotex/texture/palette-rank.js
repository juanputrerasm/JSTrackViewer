/*
  Choosing the .ACT palette for an 8-bit .RAW texture.

  MTM2 mostly ships a same-stem palette beside each texture, so "look for FOO.ACT next to
  FOO.RAW" gets most of the way there. The older titles do not: TV, Fury3, Hellbender, MTM1
  and a fair number of CPR and MTM2 assets have no same-name palette at all, and a texture
  handed the wrong palette does not fail, it renders in the wrong colours. That is the failure
  this ranking exists to prevent.

  Ranked, highest first:

    1. A same-stem .ACT beside the texture. The archive putting FOO.ACT next to FOO.RAW is a
       direct statement and is never overridden.
    2. The palette named in the POD1 entry metadata: the second NUL-terminated string in a
       .RAW entry's name field (see docs/POD.md, and PodEntry.paletteName). Named but not
       packed, METALCR2.ACT is standard enough to supply from the bundled copy.
    3. The archive's own METALCR2.ACT, then its VGA.ACT. A POD carrying either is telling us
       which family it belongs to, and its copy beats a bundled one: CPR's METALCR2 is not
       MTM1's.
    4. The bundled palettes.
    5. Any other .ACT in the texture's own folder, offered but never chosen automatically:
       handing a texture an unrelated texture's palette is a guess, whereas METALCR2 is not.

  When the caller knows which game the texture belongs to (a track viewer has read the .SIT
  or .LVL), two things change. The bundled palette for that game is selected outright instead
  of offered as one of four, and the level's own palette (the .SIT/.LVL ACT slot) joins the
  chain. Where it goes depends on what the texture is:

    In MTM1, MTM2 and CPR the track's own .ACT is the palette its TERRAIN was built against.
    Shared object art is not authored against it; it is authored against METALCR2, which lives
    in STARTUP.POD. So for a MODEL texture in those games the shared palette outranks the
    track palette: ranking them the other way rendered ROCKQRY's CKBOX, STRTGRN and STRTRED
    as coloured speckle instead of a white chevron and red and green start lights.

    MTM2 terrain joins that ranking. Every tile a track paints for itself ships its own
    same-stem .ACT and never gets this far; one that has none is stock art shared between
    tracks and drawn in METALCR2's grey ramp (slots 0-39), which the level's own palette fills
    with unrelated colours (CRAZY98's start line and bridge sides came out blue speckle).
    MTM1's levels name their palette on purpose (Arizona's DEMO.ACT), so they keep theirs.

    The flight games are the other way round: there is one global palette, the .LVL names it,
    and it is real data out of the archive, so it outranks anything bundled.

  Consolidated from JSPod's src/preview/raw-preview.js (the ranking and the picker) and
  JSTrackViewer's src/worker/palette-resolver.js (the origin-aware chain).
*/
import { normalizePodPath, podPathTitle } from "../pod/paths.js";
import { findPodEntryByTitle } from "../pod/lookup.js";
/** Where a texture's sibling files are looked for, in order, before any folder by name. */
export const TEXTURE_SIBLING_DIRS = ["ART/", "MODELS/", "DATA/", "TEXTURES/", ""];
/** The bundled palette each game's art is authored against. */
export const BUNDLED_PALETTE_BY_ORIGIN = {
    MTM1: "metalcr2Mtm1",
    MTM2: "metalcr2Mtm1",
    CPR: "metalcr2Cpr",
    HB: "vgaHB",
    TV: "vgaTV",
    F3: "vgaTV",
    "TV/F3": "vgaTV",
};
const SHARED_MODEL_PALETTE = new Set(["MTM1", "MTM2", "CPR"]);
/** A texture's name without folder or extension, upper-cased: `art\\Rd4a.raw` is `RD4A`. */
export function textureStem(name) {
    const title = podPathTitle(name);
    return title.includes(".") ? title.slice(0, title.lastIndexOf(".")) : title;
}
/**
 * `<stem><ext>` for a texture: first in the usual art folders, in TEXTURE_SIBLING_DIRS order,
 * then anywhere by file name. `ext` includes the dot.
 */
export function findTextureSibling(archive, name, ext) {
    const stem = textureStem(name);
    if (!stem)
        return null;
    const target = stem + ext.toUpperCase();
    for (const dir of TEXTURE_SIBLING_DIRS) {
        const hit = archive.entries.find((e) => e.normalizedName === dir + target);
        if (hit)
            return hit;
    }
    return findPodEntryByTitle(archive, target);
}
/**
 * The palettes a .RAW texture could be drawn with, best first.
 *
 * `texture` is the name the texture is referred to by, and its archive entry when the caller
 * has it (rule 2 lives in the entry). Candidates name entries and bundled palettes rather than
 * holding bytes: the caller reads them, and should skip one that is shorter than 768 bytes and
 * move on to the next.
 *
 * Without `origin` the list is for a person to choose from: every rule, all four bundled
 * palettes and the same-folder palettes, with no entry listed twice. With `origin` it is an
 * automatic chain: one bundled palette, the track palette when there is one, and no
 * same-folder guesses.
 */
export function paletteCandidates(archive, texture, options = {}) {
    const { origin, kind = "model", trackPalette = false } = options;
    const automatic = options.automatic ?? origin !== undefined;
    const out = [];
    const entry = texture.entry ?? findTextureSibling(archive, texture.name, ".RAW");
    const sameStem = findTextureSibling(archive, texture.name, ".ACT");
    if (sameStem)
        out.push({ source: "same-stem", entry: sameStem });
    const metadataName = entry?.paletteName?.trim() ?? "";
    let metadataEntry = null;
    if (metadataName.toUpperCase().endsWith(".ACT")) {
        metadataEntry = findPodEntryByTitle(archive, metadataName);
        const bundled = !metadataEntry && metadataName.toUpperCase() === "METALCR2.ACT" ? "metalcr2Mtm1" : null;
        out.push({ source: "pod-metadata", name: metadataName, entry: metadataEntry, bundled });
    }
    const archiveMetal = findPodEntryByTitle(archive, "METALCR2.ACT");
    const archiveVga = findPodEntryByTitle(archive, "VGA.ACT");
    if (automatic) {
        const shared = archiveMetal ?? archiveVga;
        const archivePalette = shared ? [{ source: "archive", entry: shared }] : [];
        const known = origin !== undefined && Object.hasOwn(BUNDLED_PALETTE_BY_ORIGIN, origin) ? origin : null;
        const bundled = { source: "bundled", bundled: known ? BUNDLED_PALETTE_BY_ORIGIN[known] : "metalcr2Mtm1" };
        const track = trackPalette ? [{ source: "track" }] : [];
        const sharedFirst = (kind === "model" && known !== null && SHARED_MODEL_PALETTE.has(known)) || (kind === "terrain" && known === "MTM2");
        if (sharedFirst)
            out.push(...archivePalette, bundled, ...track);
        else
            out.push(...track, ...archivePalette, bundled);
        return out;
    }
    const listed = new Set([sameStem, metadataEntry].filter((e) => !!e));
    for (const e of [archiveMetal, archiveVga]) {
        if (e && !listed.has(e)) {
            out.push({ source: "archive", entry: e });
            listed.add(e);
        }
    }
    for (const id of ["metalcr2Mtm1", "metalcr2Cpr", "vgaHB", "vgaTV"])
        out.push({ source: "bundled", bundled: id });
    const folder = folderOf(entry ? entry.normalizedName : normalizePodPath(texture.name));
    for (const e of archive.entries) {
        if (!e.title.endsWith(".ACT") || listed.has(e))
            continue;
        if (folderOf(e.normalizedName) === folder)
            out.push({ source: "same-folder", entry: e });
    }
    return out;
}
function folderOf(normalizedName) {
    return normalizedName.replace(/\/[^/]+$/, "");
}
