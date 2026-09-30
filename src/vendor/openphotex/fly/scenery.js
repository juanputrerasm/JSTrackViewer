import { flyTag, flyTags, parseFlyAngle, parseFlyTagged } from "./tagged.js";
/*
    <bgno> ==== BEGIN SCENERY FILE ====
      <name>  San Francisco
      <call>  36 43 17.33 N / 123 45 00.00 W     coverage, lower left
      <caur>  38 57 32.71 N / 120 56 15.00 W     coverage, upper right
      <ldll>  35 34 39.87 N / 125 09 22.50 W     load area, lower left
      <ldur>  40 03 09.29 N / 119 31 52.50 W     load area, upper right
      <file>  sanfran1.epd                       one per archive
    <endo>
*/
export function parseFlyScf(input, sourceName = ".SCF") {
    const tags = parseFlyTagged(input, sourceName);
    return {
        name: flyTag(tags, "name")?.values[0] ?? "",
        coverage: bounds(flyTag(tags, "call"), flyTag(tags, "caur")),
        load: bounds(flyTag(tags, "ldll"), flyTag(tags, "ldur")),
        files: flyTags(tags, "file").flatMap((t) => t.values),
    };
}
function bounds(lowerLeft, upperRight) {
    if (!lowerLeft || !upperRight)
        return null;
    const [south, west] = lowerLeft.values.map(parseFlyAngle);
    const [north, east] = upperRight.values.map(parseFlyAngle);
    if ([south, west, north, east].some((v) => v === null || v === undefined))
        return null;
    return { south: south, west: west, north: north, east: east };
}
/*
    <wobj> mobj
    <bgno>
      <geop>  37 54'43.8401"N / 122 22'41.5354"W / 139.93359375
      <type>  mobj
      <flag>  -2147483339
      <detl>  1
      <id  >  mobj2
      <name>  Blue Gas Tank
      <mmgr>
      <bgno>
        <simu>  comp
        <modl>  comp / BLUTANK.BIN               a part and its file
        <mdst>  comp / GOLD1.BSP / 0 / 14000     or a file and its distance range
      <endo>
      <iang>  0.000000,0.067196,0.000000
      <lens>  2                                  beacons only
    <endo>

  An object whose position cannot be read is skipped with a warning rather than failing the
  file.
*/
export function parseFlySceneryObjects(input, sourceName = "SCENERY.Sxx") {
    const objects = [];
    const warnings = [];
    for (const wobj of flyTags(parseFlyTagged(input, sourceName), "wobj")) {
        const body = wobj.blocks[0] ?? [];
        const geop = flyTag(body, "geop")?.values ?? [];
        const latitude = parseFlyAngle(geop[0] ?? "");
        const longitude = parseFlyAngle(geop[1] ?? "");
        const id = flyTag(body, "id")?.values[0] ?? "";
        if (latitude === null || longitude === null) {
            warnings.push(`${sourceName}: object ${id || objects.length} has no readable <geop>`);
            continue;
        }
        const angles = (flyTag(body, "iang")?.values[0] ?? "").split(",").map(Number);
        const models = [];
        for (const manager of [...flyTags(body, "mmgr"), ...flyTags(body, "nmgr")]) {
            for (const tag of manager.blocks.flat()) {
                if (tag.tag === "modl" && tag.values.length >= 2) {
                    models.push({ part: tag.values[0], file: tag.values[1], near: null, far: null });
                }
                else if (tag.tag === "mdst" && tag.values.length >= 4) {
                    models.push({ part: tag.values[0], file: tag.values[1], near: Number(tag.values[2]), far: Number(tag.values[3]) });
                }
            }
        }
        objects.push({
            kind: wobj.values[0] ?? "",
            type: flyTag(body, "type")?.values[0] ?? "",
            id,
            name: flyTag(body, "name")?.values[0] ?? "",
            flag: numberOrNull(flyTag(body, "flag")?.values[0]),
            detail: numberOrNull(flyTag(body, "detl")?.values[0]),
            latitude,
            longitude,
            altitude: Number(geop[2] ?? 0) || 0,
            orientation: [angles[0] || 0, angles[1] || 0, angles[2] || 0],
            models,
            lens: numberOrNull(flyTag(body, "lens")?.values[0]),
        });
    }
    return { objects, warnings };
}
function numberOrNull(value) {
    if (value === undefined)
        return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
