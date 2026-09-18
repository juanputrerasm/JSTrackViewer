/** The same authored spawn is used when Drive begins, when R resets, and for placement. */
export function trackSpawnPoint(trackData, frame, assembly) {
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
  position.y = (start?.underground && !slot ? position.y : frame.heightAtFeet(position.x, position.z))
    + (assembly?.restHeight ?? 0);
  return { ...position, psi };
}
