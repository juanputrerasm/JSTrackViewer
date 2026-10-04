/*
  What the ground is made of at a point (MTM2_PHYSICS.md §2.3).

  - Every texture has a type value, `type * 100 + depth`, from the level's `.TTY`: entries are
    matched to `.TEX` names, a later entry overriding an earlier one; a texture with no entry
    gets 0 (Default), and an empty `.TTY` makes every texture 200 (Dirt).
  - On the terrain, the cell's `.CLR` word (bits 0-11) picks the texture. Ground at or below
    the water level reads 1300 (deep water), or 800 (ice) in Snow; the comparison has no
    "level has water" guard, so on a level without water, ground at exactly 0 ft reads deep water.
  - Inside a ground box, the box's top texture is used, with no water rule (callers pass it).
*/
import { AIR_DENSITY, CUT_FACTORS, DEEP_WATER_TYPE, FROZEN_WATER_TYPE, SURFACE_MU, TERRAIN_CELLS, TIRE_GRIP_K, WATER_DRAG_DENSITY, WATER_TYPES, weatherGrip, } from "../constants.js";
import { terrainHeightAt } from "./terrain.js";
/** Type values per texture index, from the `.TEX` names and the parsed `.TTY` entries. */
export function textureTypeValues(textureNames, tty) {
    const out = new Int32Array(textureNames.length);
    if (tty.length === 0)
        return out.fill(200);
    const index = new Map();
    textureNames.forEach((name, i) => { if (!index.has(name.toUpperCase()))
        index.set(name.toUpperCase(), i); });
    for (const entry of tty) {
        const i = index.get(entry.name.toUpperCase());
        if (i !== undefined)
            out[i] = entry.value;
    }
    return out;
}
export function createSurfaceMap(clr, textureValues) {
    if (clr.length !== TERRAIN_CELLS * TERRAIN_CELLS) {
        throw new RangeError(`surface map needs ${TERRAIN_CELLS * TERRAIN_CELLS} cells, got ${clr.length}`);
    }
    return { clr, textureValues };
}
/** The type value of a texture word (unknown textures read 0). */
export function textureWordValue(map, word) {
    return map.textureValues[word & 0x0fff] ?? 0;
}
/**
 * The terrain's type value at (x, z): the cell texture, or water below the level. `waterLevelFt`
 * null is treated as the game's level 0.
 */
export function terrainSurfaceValue(terrain, map, x, z, waterLevelFt, snow = false) {
    if (terrainHeightAt(terrain, x, z) <= (waterLevelFt ?? 0)) {
        return (snow ? FROZEN_WATER_TYPE : DEEP_WATER_TYPE) * 100;
    }
    const col = (Math.trunc(x * 256) >> 13) & (TERRAIN_CELLS - 1);
    const row = (Math.trunc(z * 256) >> 13) & (TERRAIN_CELLS - 1);
    return textureWordValue(map, map.clr[row * TERRAIN_CELLS + col]);
}
export function surfaceType(value) {
    return Math.floor(value / 100);
}
/** How far a wheel sinks, in feet: the depth is in inches. */
export function surfaceSinkFt(value) {
    return (value % 100) / 12;
}
/** Base friction coefficient of a ground type. */
export function surfaceMu(type) {
    return SURFACE_MU[type] ?? 1;
}
/** Fluid density used for drag over a ground type, slug/ft³. */
export function surfaceDragDensity(type) {
    return WATER_TYPES.has(type) ? WATER_DRAG_DENSITY : AIR_DENSITY;
}
/** Tire-cut factor: cut 0 shallow, 1 medium, 2 deep. */
export function cutFactor(type, cut) {
    return CUT_FACTORS[type]?.[cut] ?? 1;
}
/** A tire's friction coefficient, μ_tire = cutFactor · K · μ · weather (§5.1). */
export function tireMu(type, cut, weather, k = TIRE_GRIP_K) {
    return cutFactor(type, cut) * k * surfaceMu(type) * weatherGrip(weather);
}
