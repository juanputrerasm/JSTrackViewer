import { toDataLines } from "./tv-coords.js";

/*
  The mission briefing (Hellbender).

  LVL header line 1 is `null.txt` in every Terminal Velocity and Fury3 level, and
  `<stem>.txt` in every Hellbender one. The file is the pre-mission briefing screen:

    globe.bin                     <- the globe model that screen spins
    roidg1.raw                    <- the texture on it
    PLANET: Snow City
    MISSION: Freedom
    <briefing text, one line per displayed line>
    .                             <- terminator

  Verified against all nine shipped .TXT files. The label on lines 2 and 3 is not fixed -
  PLANET, AREA, LOCATION and OBJECTIVE all occur - so both are kept as the authored
  "<label>: <value>" pair rather than being forced into a planet/mission shape the data does
  not always have.

  Only those two lines are read. The briefing prose below them is the game's own pre-mission
  screen copy, hard-wrapped for that screen; it is a page of text, not a property of the map,
  and the viewer has nowhere it belongs. The two labelled lines do belong, because they are
  what a Hellbender level has instead of the track name and locale every other game writes.

  One file serves a whole world, so the two or three levels of a world share a briefing.
*/

/** Splits "PLANET: Snow City" into its label and value; returns null for anything else. */
function labelledLine(line) {
  const at = (line ?? "").indexOf(":");
  if (at <= 0) return null;
  const label = line.slice(0, at).trim();
  const value = line.slice(at + 1).trim();
  return label && value ? { label, value } : null;
}

/**
 * Parses a Hellbender .TXT briefing.
 *
 * Returns null when the file is not one, so a level that names something else at line 1
 * simply has no briefing rather than a panel full of filenames.
 */
export function parseHbBriefing(bytes) {
  if (!bytes || !bytes.length) return null;
  const lines = toDataLines(bytes);
  if (lines.length < 4) return null;

  const heading = labelledLine(lines[2]);
  const mission = labelledLine(lines[3]);
  if (!heading && !mission) return null;

  return {
    headingLabel: heading?.label ?? null,
    heading: heading?.value ?? null,
    missionLabel: mission?.label ?? null,
    mission: mission?.value ?? null,
  };
}
