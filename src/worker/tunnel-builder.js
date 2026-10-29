import { buildSharedAtlas } from "./terrain-builder.js";
import { decodeClrWord, tunnelSegmentGeometry, TUNNEL_SEGMENT_LENGTH, TUNNEL_UNIT } from "../vendor/openphotex/index.js";

/*
  A Terminal Velocity or Fury3 tunnel interior, as a mesh.

  The tube is read from the level's .TNL by OpenPhotex (parseTvTunnel), and its rings are the
  ones the engine's builder makes (tunnelSegmentGeometry; TV GAME.EXE 0x33f00). Each face of a
  segment joins two neighbouring ring vertices at the segment's start to the same two at its
  end, textured with that face's entry in the level's .TEX list, the same list a surface level
  textures its terrain from.

  Units. A .TNL coordinate is 256 world units, and the level's .DEF, .PUP and .NAV are in the
  same world frame as the tube: X and Y in the ring plane, Z along it. In the viewer's editor
  space (64 units per 2^20-unit cell, a height step of 2^15) that is X / 64 across, Z / 64 along
  (the editor's second axis) and Y / 128 height steps, which the scene then scales like any
  altitude. So objects placed in a tunnel level land inside the tube drawn here.

  Segment types (doors, blockers) are gameplay and are not drawn; a door segment is drawn as an
  ordinary tube.
*/

/** Editor units per .TNL unit horizontally, and height steps per .TNL unit vertically. */
const EDITOR_PER_UNIT = TUNNEL_UNIT / ((1 << 20) / 64);
const STEPS_PER_UNIT = TUNNEL_UNIT / (1 << 15);

/**
 * Builds the tube. `heightScale` is scene units per height step; `worldSize` the scene's Z flip
 * (the viewer draws editor Y at worldSize - Y, as for terrain).
 */
export function buildTunnelMesh(tunnel, textures, palette, heightScale, worldSize) {
  if (!tunnel?.segments?.length) return null;
  const atlas = buildSharedAtlas(textures ?? [], palette);
  const { uvRects, atlasWidth, atlasHeight, textureCount } = atlas;

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const toScene = ([x, y, z]) => [x * EDITOR_PER_UNIT, y * STEPS_PER_UNIT * heightScale, worldSize - z * EDITOR_PER_UNIT];

  for (const segment of tunnel.segments) {
    const { ringA, ringB, faces } = tunnelSegmentGeometry(segment);
    for (const face of faces) {
      const a0 = toScene(ringA[face.a]);
      const a1 = toScene(ringA[face.b]);
      const b1 = toScene(ringB[face.b]);
      const b0 = toScene(ringB[face.a]);
      // A face collapsed onto the centre line on both rings has no area.
      const ux = a1[0] - a0[0], uy = a1[1] - a0[1], uz = a1[2] - a0[2];
      const vx = b0[0] - a0[0], vy = b0[1] - a0[1], vz = b0[2] - a0[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz);
      if (!(length > 1e-6)) continue;
      nx /= length; ny /= length; nz /= length;

      const word = decodeClrWord(face.texture);
      const slot = textureCount ? Math.min(word.texture, textureCount - 1) : 0;
      const rect = uvRects[slot] ?? uvRects[0];
      const u0 = rect ? rect.x / atlasWidth : 0, u1 = rect ? (rect.x + rect.w) / atlasWidth : 1;
      const v0 = rect ? rect.y / atlasHeight : 0, v1 = rect ? (rect.y + rect.h) / atlasHeight : 1;

      const base = positions.length / 3;
      for (const p of [a0, a1, b1, b0]) positions.push(p[0], p[1], p[2]);
      for (let k = 0; k < 4; k++) normals.push(nx, ny, nz);
      uvs.push(u0, v1, u1, v1, u1, v0, u0, v0);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  if (!indices.length) return null;
  /*
    Where the viewer's camera opens (nav.js startView): on the tube's centre line a quarter of a
    segment in from its mouth, looking along it. The tube runs towards +editor Y, which the scene
    draws towards -Z, the camera's yaw 0. Without this a tunnel level opened at the map's centre,
    far outside the tube.
  */
  const [ax, ay] = tunnel.segments[0].centreA;
  const startView = {
    x: ax * EDITOR_PER_UNIT,
    y: ay * STEPS_PER_UNIT * heightScale,
    z: worldSize - TUNNEL_SEGMENT_LENGTH * EDITOR_PER_UNIT / 4,
    yaw: 0,
    pitch: 0,
  };
  return {
    startView,
    positions: new Float32Array(positions).buffer,
    normals: new Float32Array(normals).buffer,
    uvs: new Float32Array(uvs).buffer,
    indices: new Uint32Array(indices).buffer,
    segmentCount: tunnel.segments.length,
    // The scene draws the level's objects at this scale too; a tunnel level has no terrain to carry it.
    heightScale,
    // With the terrain atlas's layout, so the Textures box can cut its tiles out (scene.textureCatalog).
    atlas: {
      rgba: atlas.atlas.buffer, width: atlasWidth, height: atlasHeight,
      atlasCols: atlas.atlasCols, atlasTileSize: atlas.atlasTileSize, atlasPadding: atlas.atlasPadding,
      sourceTileSize: atlas.sourceTileSize, textureCount,
      textureNames: (textures ?? []).map((t) => t?.name ?? ""),
    },
  };
}
