import { tvPlacementToEditor, toDataLines } from "./tv-coords.js";

/*
  .PUP powerup placements (Terminal Velocity / Fury3 / F!Zone).

  Referenced from LVL header line 7. Plain ASCII, CRLF, count-prefixed, one line per pickup:

    <count>
      <x>,<y>,<z>,<type>

  Coordinates share the .DEF space (see tv-coords.js). Measured across FURY3.POD, FURYSE.POD
  and TV.pod: 206 files, 548 placements, four fields on every line, type values 0..11.

  Type names are not recorded anywhere in the level data. The F!Zone manual describes the
  powerup list as an editor enumeration ("To cycle through the list of powerups, press the P
  key"), so a level only ever stores the index. The viewer reports the index rather than
  inventing labels for it.

  Most levels place few loose powerups: the manual says authors preferred to hide them inside
  destructible bunkers, which are ordinary .DEF objects with a spawn probability, so a sparse
  .PUP is normal for a surface level and tunnels carry proportionally more.
*/

/**
 * Parses a .PUP file into powerup placements.
 *
 * Returns [] rather than throwing on malformed input.
 */
export function parsePowerups(bytes, gridSize) {
  if (!bytes || !bytes.length) return [];
  const lines = toDataLines(bytes);
  let i = 0;
  while (i < lines.length && lines[i] === "") i++;
  const count = parseInt(lines[i], 10);
  if (!Number.isFinite(count) || count < 0 || count > 8192) return [];
  i++;

  const powerups = [];
  for (let n = 0; n < count && i < lines.length; n++, i++) {
    const parts = lines[i].split(",");
    if (parts.length < 4) break;
    const values = parts.slice(0, 4).map((v) => parseInt(v.trim(), 10));
    if (values.some((v) => !Number.isFinite(v))) break;
    powerups.push({
      index: n,
      position: tvPlacementToEditor(values[0], values[1], values[2], gridSize),
      type: values[3],
    });
  }
  return powerups;
}
