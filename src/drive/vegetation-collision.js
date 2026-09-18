/** Tree leaves are visual sheets; only the narrow trunk geometry stops the truck. */
export function isVegetationModel(name, sourceClass = "") {
  return /TREE|PINE|PALM|JUNGLE|BUSH|SHRUB|PLANT/i.test(name ?? "") || /^CTree/i.test(sourceClass);
}

export function trunkCollisionModel(model) {
  const meshes = [];
  for (const mesh of model?.meshes ?? []) {
    // Evo 1 usually separates branches into TRANSP and the trunk into OPAQUE.
    if (/^transp/i.test(mesh.groupName ?? "")) continue;
    const rawPositions = mesh.positions;
    const positions = ArrayBuffer.isView(rawPositions) ? rawPositions : new Float32Array(rawPositions);
    const rawIndices = mesh.indices;
    const indices = rawIndices ? (ArrayBuffer.isView(rawIndices) ? rawIndices : new Uint32Array(rawIndices)) : null;
    if (!positions || !indices?.length) continue;

    // Evo 2's stock .VEG models put trunk and foliage in one alpha-textured group.
    // Its trunk faces are narrow in the horizontal plane; broad leaf cards are not.
    if (mesh.textureHasAlpha && model.meshes.length === 1) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < positions.length; i += 3) {
        minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
        minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
        minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
      }
      const maxSpan = Math.max(maxX - minX, maxZ - minZ) * 0.12;
      const trunkTop = minY + (maxY - minY) * 0.35;
      const trunkIndices = [];
      for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
        const spanX = Math.max(positions[a], positions[b], positions[c]) - Math.min(positions[a], positions[b], positions[c]);
        const spanZ = Math.max(positions[a + 2], positions[b + 2], positions[c + 2]) - Math.min(positions[a + 2], positions[b + 2], positions[c + 2]);
        const midY = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
        if (Math.max(spanX, spanZ) <= maxSpan && midY <= trunkTop) trunkIndices.push(indices[i], indices[i + 1], indices[i + 2]);
      }
      if (trunkIndices.length) meshes.push({ ...mesh, indices: new Uint32Array(trunkIndices) });
    } else {
      meshes.push(mesh);
    }
  }
  return { ...model, meshes };
}
