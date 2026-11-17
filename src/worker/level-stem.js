import { archiveTitle } from "../shared/path-utils.js";

/*
  The files that belong to an MTM2 track's level (DATA\<name>.TXV, WORLD\<name>.WTR, .VEG, .WFL) are
  looked up by the level's stem first, then the track's (track format version 6, section 3, "Level
  files"). Community Patch 4 names its lakes and waterfalls after the level (CP4_EXE_ANALYSIS.md 2
  and 12.1.1: `WORLD\<lvl>.WTR`, the stem up to the first '.'), and OpenMTM2 reads every one of them
  in this order (worker/level-load.js). Several tracks may run on one level and share its files; on
  a track named after its level the two stems are one.
*/

/** The stem of a level name such as `LEVELS\CHGO.LVL`: its title up to the first '.' ("" for none). */
export function levelStemOf(lvlName) {
  const title = archiveTitle(String(lvlName ?? "").trim());
  const dot = title.indexOf(".");
  return (dot < 0 ? title : title.slice(0, dot)).toUpperCase();
}

/** The level a situation file names: its first line (OpenPhotex parseMtmSit's `lvlName`), as a stem. */
export function sitLevelStem(sitBytes) {
  if (!sitBytes?.length) return "";
  const head = new TextDecoder("latin1").decode(sitBytes.subarray(0, Math.min(sitBytes.length, 256)));
  return levelStemOf(head.split(/\r?\n/)[0]);
}

/** The stems to try for a level file, level first, without repeats or blanks. */
export function levelFileStems(levelStem, trackStem) {
  const out = [];
  for (const s of [levelStem, trackStem]) {
    const up = String(s ?? "").toUpperCase();
    if (up && !out.includes(up)) out.push(up);
  }
  return out;
}
