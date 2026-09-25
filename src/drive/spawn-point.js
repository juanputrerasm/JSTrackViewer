/*
  How far above the terrain a spawn looks for something to stand on.

  The CPR road sits a median of 2 ft above the terrain and at most about 6 ft; a bridge deck
  or walkway is 15 ft or more. Looking 10 ft up puts the truck on the road and not on the
  underside of a walkway spanning it.
*/
const SPAWN_SUPPORT_REACH_FT = 10;

/**
 * The surface a truck should be dropped onto: the terrain, or a solid surface on top of it
 * such as the CPR road layer, whichever is higher within reach.
 */
export function groundForSpawn(frame, colliders, x, z) {
  const terrain = frame.heightAtFeet(x, z);
  const support = colliders?.supportAt(x, z, terrain + SPAWN_SUPPORT_REACH_FT) ?? null;
  return support !== null && support > terrain ? support : terrain;
}

/** The same authored spawn is used when Drive begins, when R resets, and for placement. */
export function trackSpawnPoint(trackData, frame, assembly, colliders = null) {
  const slot = (trackData?.trucks ?? []).find((t) => t.playerSlot !== true);
  const start = trackData?.navPoints?.find((p) => p.type === 6 && p.position);
  const segment = trackData?.primaryCourse?.segments?.[0];
  let position;
  let psi = 0;
  if (slot) {
    position = frame.editorToFeet(slot.position);
    psi = slot.psi ?? 0;
  } else if (start) {
    position = frame.editorToFeet(start.position);
    psi = ((start.heading ?? 0) / 65536) * Math.PI * 2;
  } else if (segment) {
    position = frame.editorToFeet(segment.start ?? segment);
  } else {
    const mid = frame.worldSizeFeet / 2;
    position = { x: mid, y: 0, z: mid };
  }
  // Hellbender can place a NAV start below its surface heightfield.
  position.y = (start?.underground && !slot ? position.y : groundForSpawn(frame, colliders, position.x, position.z))
    + (assembly?.restHeight ?? 0);
  return { ...position, psi };
}
