/*
  What the ground is made of at a point (MTM2_PHYSICS.md §2.3).

  - Every texture has a type value, `type * 100 + depth`, from the level's `.TTY`: entries are
    matched to `.TEX` names, a later entry overriding an earlier one; a texture with no entry
    gets 0 (Default), and an empty `.TTY` makes every texture 200 (Dirt).
  - On the terrain, the cell's `.CLR` word (bits 0-11) picks the texture. Ground at or below
    the water level reads 1300 (deep water), or 800 (ice) in Snow.
  - Ground at exactly 0 (raised to the water level in Snow) is neither: `0x502210` sets it apart
    (it returns 3, not 0, for "open terrain"), and `0x503060` then skips both the texture and the
    water test and reads the type table at an index it never set. That index is a stack slot its
    only caller (`0x4de180`) leaves holding `__ftol`'s FPU control word, so it is at least 0xC00:
    past the table, in memory nothing writes, which reads 0. Ground at 0 is Default (0) whatever its
    texture, with water over it or not: full grip, no sinking, no water drag.
    Monster Truck Madness 1 has no such rules (`deepWater` false): water is what the texture says.
  - Inside a ground box, the box's top texture is used, with no water rule (callers pass it).
*/
import { AIR_DENSITY, CUT_FACTORS, DEEP_WATER_TYPE, FROZEN_WATER_TYPE, SURFACE_MU, TERRAIN_CELLS, TIRE_GRIP_K, WATER_DRAG_DENSITY, WATER_TYPES, weatherGrip, } from "../constants.js";
import { terrainHeightAt, terrainLakeAt } from "./terrain.js";
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
export function terrainSurfaceValue(terrain, map, x, z, waterLevelFt, snow = false, deepWater = true) {
    if (deepWater) {
        const height = terrainHeightAt(terrain, x, z);
        // A Community Patch 4 lake tile is deep water below the lake's surface (FUN_140203ed0, CP4_EXE_ANALYSIS.md 2).
        const lake = terrainLakeAt(terrain, x, z);
        if (lake && height < terrain.lakes.levelFt[lake])
            return (snow ? FROZEN_WATER_TYPE : DEEP_WATER_TYPE) * 100;
        const level = waterLevelFt ?? 0;
        // In the game's units (1/256 ft, floored): ground at 0 is Default, before the water test.
        if (Math.floor((snow && height < level ? level : height) * 256) === 0)
            return 0;
        if (height <= level)
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
export function surfaceDragDensity(type, waterDensity = WATER_DRAG_DENSITY) {
    return WATER_TYPES.has(type) ? waterDensity : AIR_DENSITY;
}
/** Tire-cut factor: cut 0 shallow, 1 medium, 2 deep. */
export function cutFactor(type, cut) {
    return CUT_FACTORS[type]?.[cut] ?? 1;
}
/** A tire's friction coefficient, μ_tire = cutFactor · K · μ · weather (§5.1). */
export function tireMu(type, cut, weather, k = TIRE_GRIP_K) {
    return cutFactor(type, cut) * k * surfaceMu(type) * weatherGrip(weather);
}
