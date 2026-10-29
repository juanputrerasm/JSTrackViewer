/*
  Crash damage (OpenMTM2 docs/MONSTER_EXE_ANALYSIS.md section 10, core/TruckDmg.c).

  The 12 zones are the truck's 12 hull points. Each frame a hull point is in contact, the zone
  gets the truck's last impact force: its level (0 to 3, two bits of the damage code, only ever
  rising) follows the force, and the body's vertices near the point are pushed along the zone's
  direction, a little more at every level, every time. The model is in 1/256 ft units; the
  functions here work in feet.
*/
export const DAMAGE_ZONES = 12;
/** The impact forces (lb) that end level 1 and level 2; above the second is level 3. */
export const DAMAGE_LEVEL_1_FORCE = 10000, DAMAGE_LEVEL_2_FORCE = 30000;
/** Model units per foot, as the BIN stores vertices. */
export const MODEL_UNITS_PER_FT = 256;
/** The push radius of zones 1 to 12 in model units (index 0 is unused): 512 for 1 to 4, 384 for 5 to 12. */
export const ZONE_RADIUS_UNITS = [0, 512, 512, 512, 512, 384, 384, 384, 384, 384, 384, 384, 384];
/** The direction a zone pushes, three signs in body axes (x right, y up, z forward), zones 1 to 12 (index 0 unused). */
export const ZONE_PUSH = [
    [0, 0, 0], [1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1], [1, -1, -1], [-1, -1, -1],
    [1, -1, 1], [-1, -1, 1], [1, -1, 1], [-1, -1, 1], [1, 1, 1], [-1, 1, 1],
];
/** The damage level a force gives: 0 for none, 1 up to 10000, 2 up to 30000, 3 above. */
export function damageLevelForForce(force) {
    if (force > DAMAGE_LEVEL_2_FORCE)
        return 3;
    if (force > DAMAGE_LEVEL_1_FORCE)
        return 2;
    return force > 0 ? 1 : 0;
}
/** Zone `zone` (1 to 12)'s level in a damage code. */
export function zoneLevel(code, zone) {
    return (code >>> (zone * 2)) & 3;
}
/** Whether any zone is damaged (the hull sound changes). */
export const isDamaged = (code) => code !== 0;
/** The new damage code after `force` hits `zone` (1 to 12); a zone only gets worse. */
export function recordZoneHit(code, zone, force) {
    const level = damageLevelForForce(force);
    const raised = zoneLevel(code, zone) < level;
    const next = raised ? ((code & ~(3 << (zone * 2))) | (level << (zone * 2))) >>> 0 : code;
    return { code: next, level, raised };
}
/**
 * How far one vertex moves in one push, in model units: `((level + 1) * 0xfffe + rand) * 16 >> 16`
 * with `rand` 0 to 32767 (`random` in [0, 1)), which is 16 to 24 at level 0 and 64 to 72 at level 3.
 */
export function dentUnits(level, random) {
    return Math.floor((((level + 1) * 0xfffe + Math.floor(random * 32768)) * 16) / 65536);
}
/** A zone's push radius in feet and direction in body axes. */
export function zoneDent(zone) {
    return { radiusFt: (ZONE_RADIUS_UNITS[zone] ?? 0) / MODEL_UNITS_PER_FT, direction: ZONE_PUSH[zone] ?? [0, 0, 0] };
}
/**
 * Push the vertices of `positions` (x, y, z in feet, flat, in place) that are within `radiusFt` of
 * `center` by `direction` times the level's dent, each vertex drawing its own amount from
 * `random`. Vertices that share a position (a mesh repeats them per face) get the same amount so
 * a model stays welded. `center` and `direction` are in the same axes as `positions`. Returns how
 * many vertices moved.
 */
export function dentVertices(positions, center, direction, radiusFt, level, random = Math.random) {
    const limit = radiusFt * radiusFt;
    const amounts = new Map();
    let moved = 0;
    for (let i = 0; i + 2 < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
        if ((x - center[0]) ** 2 + (y - center[1]) ** 2 + (z - center[2]) ** 2 >= limit)
            continue;
        const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
        let amount = amounts.get(key);
        if (amount === undefined) {
            amount = dentUnits(level, random()) / MODEL_UNITS_PER_FT;
            amounts.set(key, amount);
        }
        positions[i] = x + direction[0] * amount;
        positions[i + 1] = y + direction[1] * amount;
        positions[i + 2] = z + direction[2] * amount;
        moved++;
    }
    return moved;
}
