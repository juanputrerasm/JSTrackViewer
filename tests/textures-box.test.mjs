/*
  The Textures box's ground types (ui/textures-box.js groundDescription): the value a terrain
  slot carries, `type * 100 + depth`, named from the game's table.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { groundDescription } from "../src/ui/textures-box.js";

test("a terrain slot's ground type is named from the game's table", () => {
  assert.equal(groundDescription({ slot: 0, ground: 603 }, "MTM2"), "ground: Grass, depth 3");
  assert.equal(groundDescription({ slot: 0, ground: 100 }, "TV/F3"), "ground: Cement, depth 0");
  assert.equal(groundDescription({ slot: 0, ground: 1201 }, "HB"), "ground: Rocks, depth 1");
  // 4x4 Evolution adds train track and a vegetation class.
  assert.equal(groundDescription({ slot: 0, ground: 1400, vegetation: 2 }, "EVO2"), "ground: Train track, depth 0, medium vegetation");
  assert.equal(groundDescription({ slot: 0, ground: 1400 }, "MTM2"), "ground: type 14, depth 0");
  assert.equal(groundDescription({ slot: 3, ground: null }, "MTM1"), "no ground type");
  // A CART road texture names its road surface; a model texture has no ground.
  assert.equal(groundDescription({ roadFlags: 1 }, "CPR"), "road surface: Curb");
  assert.equal(groundDescription({ name: "X.RAW" }, "MTM2"), "");
});
