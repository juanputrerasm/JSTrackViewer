/*
  Fly!'s globe tiles: how the world is cut into the DATA\Dxxxyyy folders of the scenery
  archives, and how a terrain texture's name says where it goes. See docs/FLY.md.

  Longitude is 256 columns of 1.40625 degrees, column 0 starting at the prime meridian and
  counting east, so San Francisco's column 168 starts at 236.25 E = 123.75 W.

  Latitude rows are not equal. Row 128 starts at the equator, and each row is 1.40625 x
  cos(its southern edge) degrees tall, which keeps tiles roughly square. The recurrence
  reproduces every tile edge named in the five stock .SCF files (rows 152 to 162) to within
  0.01 arcseconds. Rows south of the equator are taken as the mirror image; no stock scenery
  lies there to confirm it.

  A tile is 64 x 64 cells, split into four 32 x 32 quadrants (G00..G11). Everything in a
  quadrant file is column-major: x (west to east) is the outer index, y (south to north) the
  inner one. Cells are equal steps of longitude and of latitude within their tile.
*/
export const FLY_TILE_DEGREES = 1.40625;
export const FLY_TILE_COLUMNS = 256;
export const FLY_EQUATOR_ROW = 128;
/** Cells along each side of a globe tile. */
export const FLY_TILE_CELLS = 64;
/** Cells along each side of a quadrant (G00, G01, G10, G11). */
export const FLY_QUADRANT_CELLS = 32;
const rowStarts = (() => {
    const starts = new Array(FLY_TILE_COLUMNS + 1).fill(0);
    for (let row = FLY_EQUATOR_ROW; row < FLY_TILE_COLUMNS; row++) {
        const lat = starts[row];
        starts[row + 1] = Math.min(90, lat + FLY_TILE_DEGREES * Math.cos((lat * Math.PI) / 180));
    }
    for (let row = FLY_EQUATOR_ROW - 1; row >= 0; row--)
        starts[row] = -starts[2 * FLY_EQUATOR_ROW - row];
    return starts;
})();
/** The latitude where globe tile row `row` starts (its southern edge), in degrees. */
export function flyRowLatitude(row) {
    if (!Number.isInteger(row) || row < 0 || row > FLY_TILE_COLUMNS)
        throw new RangeError(`No globe tile row ${row}.`);
    return rowStarts[row];
}
/** The longitude where globe tile column `column` starts (its western edge), in -180..180. */
export function flyColumnLongitude(column) {
    const lon = column * FLY_TILE_DEGREES;
    return lon >= 180 ? lon - 360 : lon;
}
/** The box a globe tile covers. */
export function flyTileBounds(column, row) {
    const west = flyColumnLongitude(column);
    return { south: flyRowLatitude(row), north: flyRowLatitude(row + 1), west, east: west + FLY_TILE_DEGREES };
}
/**
 * The globe tile a point lies in, and where in it as fractional cells from the tile's
 * south-west corner (0 to 64 on each axis).
 */
export function flyTileAt(latitude, longitude) {
    const east = ((longitude % 360) + 360) % 360;
    const column = Math.min(FLY_TILE_COLUMNS - 1, Math.floor(east / FLY_TILE_DEGREES));
    let row = FLY_EQUATOR_ROW;
    while (row < FLY_TILE_COLUMNS - 1 && rowStarts[row + 1] <= latitude)
        row++;
    while (row > 0 && rowStarts[row] > latitude)
        row--;
    const south = rowStarts[row];
    const x = ((east - column * FLY_TILE_DEGREES) / FLY_TILE_DEGREES) * FLY_TILE_CELLS;
    const y = ((latitude - south) / (rowStarts[row + 1] - south)) * FLY_TILE_CELLS;
    return { column, row, x, y };
}
/** The column and row a `Dxxxyyy` folder name encodes, or null. */
export function parseFlyFolderName(name) {
    const match = /^D(\d{3})(\d{3})$/i.exec(name.trim());
    return match ? { first: Number(match[1]), second: Number(match[2]) } : null;
}
/** The `Dxxxyyy` folder name for two numbers. */
export function flyFolderName(first, second) {
    return `D${String(first).padStart(3, "0")}${String(second).padStart(3, "0")}`;
}
export function parseFlyTextureName(name) {
    const stem = name.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
    if (!/^[0-9A-F]{8}$/i.test(stem))
        return null;
    const digits = String(Number.parseInt(stem, 16)).padStart(10, "0");
    if (digits.length !== 10)
        return null;
    const index = Number(digits.slice(6));
    if (index >= FLY_TILE_CELLS * FLY_TILE_CELLS)
        return null;
    return {
        folderFirst: Number(digits.slice(0, 3)),
        folderSecond: Number(digits.slice(3, 6)),
        x: index % FLY_TILE_CELLS,
        y: Math.floor(index / FLY_TILE_CELLS),
    };
}
