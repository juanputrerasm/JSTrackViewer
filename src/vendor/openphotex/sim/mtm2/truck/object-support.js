/*
  Water under a tire, and a tire held up by an object.

  `inWaterForSound` is the game's own rule (MONSTER_EXE_ANALYSIS.md 12, "Water"; retail 0x41bbd0,
  kept by Community Patch 4): a truck is in water, for its splash and its in-water loop, when a
  tire's hub is under the water level, or a tire on the ground stands on water (300) or deep water
  (1300). Never in Snow. The water level is the one at the hub (a Community Patch 4 lake's, else
  the track's).

  `objectSurfaceValue` is NOT the game's: an opt-in host choice (StepContext `dryOnObjects`,
  OpenMTM2's). The game and both Community Patches read a tire's surface from the terrain under it
  whatever holds the tire up, so a tire on a bridge over terrain below the water stands on deep
  water: deep water's grip, the water sounds and the water commentary (OpenMTM2
  docs/CP4_EXE_ANALYSIS.md 2). With the choice on, a tire held up by an object (a box or ground box,
  a ramp, a Community Patch 4 triangle prop, a top-crush car, an edge) never takes water or deep
  water from the terrain: it reads 0, Default, the value the game gives the ground it sets apart
  (world/surface.ts): full grip, no tire-cut change, no sinking and no water drag. A .SRF face's
  own type is never water, so it is kept. Everything else (a terrain-held tire, a non-water value)
  is the game's.
*/
import { rampHeightAt } from "../collide/ramp.js";
import { WATER_TYPES } from "../constants.js";
import { surfaceType } from "../world/surface.js";
/** The surface value a tire held up by an object reads in place of water (Default). */
export const OBJECT_DRY_SURFACE = 0;
/**
 * Whether a tire on the ground is held up by an object rather than the terrain: its support source
 * (state.ts) is not the terrain's, or a ramp covers the point (ramps raise the ground's height).
 */
export function tireOnObject(t, ground, x, z) {
    if ((t.supportSource ?? 1) !== 1)
        return true;
    for (const r of ground.ramps ?? [])
        if (rampHeightAt(r, x, z) !== null)
            return true;
    return false;
}
/** A surface value for a tire held up by an object: water and deep water become Default, the rest is kept. */
export function objectSurfaceValue(value) {
    return value >= 0 && WATER_TYPES.has(surfaceType(value)) ? OBJECT_DRY_SURFACE : value;
}
/** Whether a truck is in water for its sounds (retail 0x41bbd0, above); `weather` 5 is Snow. */
export function inWaterForSound(s, ground, weather = 0) {
    if (weather === 5)
        return false;
    const m = s.matrix;
    for (const t of s.tires) {
        if (t.onGround && t.surface >= 0 && WATER_TYPES.has(surfaceType(t.surface)))
            return true;
        const h = t.hub;
        const x = s.pos[0] + m[0] * h[0] + m[1] * h[1] + m[2] * h[2];
        const y = s.pos[1] + m[3] * h[0] + m[4] * h[1] + m[5] * h[2];
        const z = s.pos[2] + m[6] * h[0] + m[7] * h[1] + m[8] * h[2];
        const level = ground.waterLevelAt ? ground.waterLevelAt(x, z) : ground.waterLevelFt;
        if (level !== null && level !== undefined && y < level)
            return true;
    }
    return false;
}
