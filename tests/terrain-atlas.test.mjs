/* Terrain atlas slot mapping and the optional Evo 2-pixel UV comparison. */
import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainMesh } from "../src/worker/terrain-builder.js";

const GRID = 4;
const TILE = 64;
const GREY_PALETTE = Uint8Array.from({ length: 768 }, (_, i) => Math.floor(i / 3));

function rampTile(base) {
  const data = new Uint8Array(TILE * TILE);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) data[y * TILE + x] = (base + x) & 0xff;
  return { name: `T${base}.RAW`, data };
}

function build(origin, textures, cellValue = (x) => x & 1) {
  const clrData = new Uint8Array(GRID * GRID * 2);
  for (let z = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
    const value = cellValue(x, z);
    const offset = (x + z * GRID) * 2;
    clrData[offset] = value & 0xff;
    clrData[offset + 1] = value >> 8;
  }
  return buildTerrainMesh({
    gridSize: GRID, rawData: new Uint8Array(GRID * GRID * 2), rawBytesPerCell: 2,
    clrData, clrBytesPerCell: 2,
  }, GREY_PALETTE, textures, 4, origin, null);
}

function spanPixels(uvs, cell, atlas) {
  const base = cell * 8;
  const values = [uvs[base], uvs[base + 2], uvs[base + 4], uvs[base + 6]];
  return (Math.max(...values) - Math.min(...values)) * atlas.width;
}

test("Evo maps one whole 64px tile per slot, with no neighborhood variants", () => {
  for (const origin of ["EVO1", "EVO2"]) {
    const mesh = build(origin, [rampTile(0), rampTile(64)]);
    const atlas = mesh.atlas;
    const uvs = new Float32Array(mesh.uvs);
    assert.equal(atlas.textureCount, 2);
    assert.equal(atlas.tileCount, 2);
    assert.equal(atlas.atlasPadding, 2);
    assert.equal(atlas.atlasTileSize, 68);
    for (let cell = 0; cell < GRID * GRID; cell++) {
      assert.ok(Math.abs(spanPixels(uvs, cell, atlas) - 64) < 0.001);
    }
    // The padding duplicates each slot's own edge solely to isolate slots in the atlas.
    const rgba = new Uint8ClampedArray(atlas.rgba);
    const red = (x, y) => rgba[(y * atlas.width + x) * 4];
    assert.equal(red(0, 10), red(2, 10));
    assert.equal(red(67, 10), red(65, 10));
    assert.equal(red(68, 10), red(70, 10));
  }
});

test("every game offers full 64px and cropped 60px UVs for the checkbox", () => {
  for (const origin of ["EVO1", "EVO2", "MTM1", "MTM2", "CPR", "TV", "F3", "HB"]) {
    const mesh = build(origin, [rampTile(0), rampTile(64)],
      (x, z) => (x & 1) | (((x + z) & 3) << 14) | (((x + z) & 1) << 12));
    const full = new Float32Array(mesh.uvs);
    const cropped = new Float32Array(mesh.uvsOverlap);
    for (let cell = 0; cell < GRID * GRID; cell++) {
      assert.ok(Math.abs(spanPixels(full, cell, mesh.atlas) - 64) < 0.001, `${origin} full cell ${cell}`);
      assert.ok(Math.abs(spanPixels(cropped, cell, mesh.atlas) - 60) < 0.001, `${origin} cropped cell ${cell}`);
    }
    assert.equal(mesh.atlas.tileCount, mesh.atlas.textureCount);
  }
});
