import { groundHeightAt, groundNormalAt } from "./terrain.js";
import { terrainSurfaceValue } from "./surface.js";
export function createTerrainGround(terrain, surface, weather = 0, waterLevelFt = terrain.waterLevelFt) {
    const snow = weather === 5;
    return {
        height: (x, z) => groundHeightAt(terrain, x, z, snow),
        normal: (x, z, out) => groundNormalAt(terrain, x, z, out, snow),
        surface: (x, _y, z) => (surface ? terrainSurfaceValue(terrain, surface, x, z, waterLevelFt, snow) : 200),
        waterLevelFt,
        weather,
    };
}
