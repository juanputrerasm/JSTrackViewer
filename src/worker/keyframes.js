/*
  Animated BINs, resolved into something the scene can draw and play.
*/

/**
 * A keyframe control model (ANIMATED_BIN) carries frame NAMES, not polygons. The frame models
 * are ordinary .BIN entries elsewhere in the pod. The first one that resolves is the model's
 * geometry, and all of them together become `keyframes` (see keyframeMorphs).
 *
 * This mirrors what the Traxx fork had to add for the same reason: GetAniName(0) is only
 * useful if the frame it names has itself been loaded, and nothing was loading it, so
 * keyframed objects drew as empty wireframes.
 *
 * The frame's geometry is adopted under the CONTROL model's name, because that is the name
 * the .SIT refers to and everything downstream keys off it.
 */
export function resolveKeyframeModel(model, loadFrame) {
  if (!model || model.format !== "ANIMATED_BIN") return model;
  const frames = (model.frameNames ?? []).map((frameName) => ({ frameName, frame: loadFrame(frameName) }));
  const first = frames.find(({ frame }) => frame?.meshes?.length);
  if (!first) return model;
  const resolved = {
    ...first.frame,
    name: model.name,
    format: model.format,
    frameNames: model.frameNames,
    resolvedFrame: first.frameName,
  };
  const morphFrames = keyframeMorphs(first.frame, frames.map(({ frame }) => frame).filter((frame) => frame?.meshes?.length));
  if (morphFrames) resolved.keyframes = morphFrames;
  else if (frames.length > 1) {
    resolved.warnings = [...(resolved.warnings ?? []),
      "keyframes differ in shape from the first frame, so only the first is drawn"];
  }
  return resolved;
}

/*
  The frames of an animated BIN, as vertex positions and normals the scene can morph between.

  Every frame of the stock animations (MTM2's PUMPJACK and REX, MTM1's WREC1 crush cab) is the
  same object in a different pose: the same meshes in the same order, the same vertex count,
  and identical UVs. That is what lets the scene blend two frames vertex by vertex, which is
  how the game gets a smooth motion out of a handful of keyframes rather than jumping between
  them. PUMPJACK even names a different texture per frame (PJ0.RAW to PJ7.RAW), but they are
  byte for byte the same image, so the first frame's materials serve for all of them.

  Each frame is decoded around its own anchor, and the anchors differ from frame to frame, so
  every frame is moved into the first frame's space before it is kept. A set of frames that
  does not line up returns null, and the model is drawn from its first frame alone.
*/
export function keyframeMorphs(base, frames) {
  if (frames.length < 2) return null;
  const baseAnchor = base.anchor ?? { x: 0, y: 0, z: 0 };
  const out = [];
  for (const frame of frames) {
    if (frame.meshes.length !== base.meshes.length) return null;
    const anchor = frame.anchor ?? { x: 0, y: 0, z: 0 };
    const dx = anchor.x - baseAnchor.x, dy = anchor.y - baseAnchor.y, dz = anchor.z - baseAnchor.z;
    const meshes = [];
    for (let m = 0; m < base.meshes.length; m++) {
      const source = frame.meshes[m];
      if (source.positions.length !== base.meshes[m].positions.length) return null;
      const positions = new Float32Array(source.positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        positions[i] = source.positions[i] + dx;
        positions[i + 1] = source.positions[i + 1] + dy;
        positions[i + 2] = source.positions[i + 2] + dz;
      }
      meshes.push({ positions, normals: new Float32Array(source.normals) });
    }
    out.push({ meshes });
  }
  return out;
}
