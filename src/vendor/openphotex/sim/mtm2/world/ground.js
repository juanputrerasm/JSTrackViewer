import { rampHeightAt } from "../collide/ramp.js";
import { groundHeightAt, groundNormalAt } from "./terrain.js";
import { MTM2_RULES, weatherGrip } from "../constants.js";
import { terrainSurfaceValue } from "./surface.js";
/** The grip factor of the ground's weather under its rules. */
export function groundWeatherGrip(ground) {
    return (ground.rules ?? MTM2_RULES).weatherGrip ? weatherGrip(ground.weather) : 1;
}
export function createTerrainGround(terrain, surface, weather = 0, waterLevelFt = terrain.waterLevelFt, rules = MTM2_RULES) {
    const snow = weather === 5;
    const ramps = [];
    return {
        height: (x, z) => {
            for (const r of ramps) {
                const h = rampHeightAt(r, x, z);
                if (h !== null)
                    return h;
            }
            return groundHeightAt(terrain, x, z, snow);
        },
        normal: (x, z, out) => groundNormalAt(terrain, x, z, out, snow),
        surface: (x, _y, z) => (surface ? terrainSurfaceValue(terrain, surface, x, z, waterLevelFt, snow, rules.deepWater) : 200),
        waterLevelFt,
        weather,
        ramps,
        rules,
    };
}
