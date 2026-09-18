/*
  The scene graph for a drivable truck.

  The simulation works in feet and knows nothing about Three.js; this turns one assembled
  truck into a group it can drive, and exposes the handful of joints that move: suspension
  travel, steering, wheel spin, and the links that stretch between body and axle.

  Two things here are not obvious.

  THE TRUCK IS DRAWN TRUE, NOT BY THE SCENE'S VERTICAL CONVENTION. The scene is anisotropic,
  2 units to a foot across the map and 1.5 up it, so everything else in it is a quarter
  flatter than life. A truck built that way is visibly squashed next to the truck viewer, so
  its geometry is isotropic: the horizontal scale on all three axes.

  The cost is that geometry and position no longer share a scale, and a truck placed by the
  vertical one sinks into the ground. Placement therefore happens in scene units and is the
  caller's job, via world-frame's toSceneTruckPosition, which measures the truck's height from
  the terrain rather than from zero. setPose takes the result of that, already converted.

  Drawing true also removes a problem the earlier squashed version had: a non-uniform scale
  outside the chassis rotation still shears a truck that rolls or pitches, exactly as Traxx's
  PushZStretch does to a rotated object. An isotropic truck rotates correctly at any attitude.

  THE AXES ARE NOT THE SAME FOR MODELS AND FOR MANIFEST VECTORS. A decoded BIN's vertices are
  (x, up, forward) relabelled by the decoder, so they reach the scene as (x, z, -y). A TRK
  vector (a wheel anchor, a scrape point, a light) is already (x, up, forward) in truck terms
  and reaches the scene as (x, y, -z). Mixing the two puts the wheels inside the bodywork.
*/
import * as THREE from "three";
import { UNITS_PER_FOOT_H } from "./world-frame.js";

/** Truck space: isotropic, 2 scene units per foot on every axis. */
const FEET_TO_INNER = UNITS_PER_FOOT_H;

/** A decoded model's vertex buffer, in scene axes and inner units. */
function modelPositions(positions) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i] * FEET_TO_INNER;
    out[i + 1] = positions[i + 2] * FEET_TO_INNER;
    out[i + 2] = -positions[i + 1] * FEET_TO_INNER;
  }
  return out;
}

/** A decoded model's normals: direction only, so no scaling, but the same relabelling. */
function modelNormals(normals) {
  const out = new Float32Array(normals.length);
  for (let i = 0; i < normals.length; i += 3) {
    out[i] = normals[i];
    out[i + 1] = normals[i + 2];
    out[i + 2] = -normals[i + 1];
  }
  return out;
}

/** A TRK vector (feet, truck axes) as an inner-space THREE.Vector3. */
function truckVector(v) {
  return new THREE.Vector3(
    (v?.x ?? 0) * FEET_TO_INNER,
    (v?.y ?? 0) * FEET_TO_INNER,
    -(v?.z ?? 0) * FEET_TO_INNER
  );
}

function buildModelGroup(model, createMaterial) {
  const group = new THREE.Group();
  if (!model) return group;
  for (const mesh of model.meshes ?? []) {
    if (!mesh.positions?.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(modelPositions(mesh.positions), 3));
    if (mesh.normals?.length) {
      geo.setAttribute("normal", new THREE.BufferAttribute(modelNormals(mesh.normals), 3));
    }
    if (mesh.uvs?.length) {
      geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(mesh.uvs), 2));
    }
    if (mesh.indices) geo.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
    geo.computeBoundingSphere();
    group.add(new THREE.Mesh(geo, createMaterial(mesh)));
  }
  return group;
}

/**
 * @param {object}   assembly        from worker/truck/truck-assembly.js, in feet
 * @param {Function} createMaterial  mesh -> THREE.Material, normally TrackScene's own
 * @returns a root object plus the joints the simulation drives
 */
export function buildTruckObject(assembly, createMaterial, getTexture = () => null) {
  const root = new THREE.Group();
  root.name = "driveTruck";
  // No scale here on purpose: the truck is drawn true and placed in scene units. See above.

  const chassis = new THREE.Group();
  chassis.name = "chassis";
  root.add(chassis);

  const body = buildModelGroup(assembly.body, createMaterial);
  body.name = "body";
  chassis.add(body);

  /*
    Each wheel is three nested groups, so the three motions cannot fight each other:
      mount  suspension travel, along the truck's own up axis
      steer  yaw, only the steered axle uses it
      spin   roll about the axle, which is scene X for a truck facing -Z
  */
  const wheels = assembly.wheels.map((wheel) => {
    const mount = new THREE.Group();
    mount.name = wheel.key;
    const rest = truckVector(wheel.position);
    mount.position.copy(rest);

    const steer = new THREE.Group();
    const spin = buildModelGroup(wheel.model, createMaterial);
    steer.add(spin);
    mount.add(steer);
    chassis.add(mount);

    return {
      key: wheel.key,
      radius: wheel.radius,
      anchor: wheel.position,
      restY: rest.y,
      mount,
      steer,
      spin,
      isFront: wheel.key.startsWith("faxle"),
      isLeft: wheel.key.includes(".ltire."),
    };
  });

  const axles = (assembly.axles ?? []).map((axle) => {
    const group = buildModelGroup(axle.model, createMaterial);
    group.name = axle.key;
    group.position.copy(truckVector(axle.position));
    chassis.add(group);
    return { key: axle.key, group, restY: group.position.y };
  });

  /*
    Links are built once and re-aimed, never rebuilt.

    A cylinder between two moving points is the one piece of truck geometry that changes shape
    every frame. Rebuilding four bars, eight shocks and two driveshaft halves per frame means
    fourteen geometries and materials per frame; instead each is created at unit length and
    then positioned, aimed and scaled along its own axis.
  */
  const links = new THREE.Group();
  links.name = "links";
  chassis.add(links);

  /*
    Links carry the TRK's own textures where the archive has them.

    A TRK names barTextureName and shockTextureName precisely because the game draws these as
    textured tubes rather than as bare metal, and an untextured cylinder reads as a much more
    prominent white strut than the game shows. The texture is looked up by stem, since a
    manifest writes "Silver.raw" while the cache is keyed by the archive's own name.
  */
  const linkMaterial = (color, textureName) => {
    const map = getTexture(textureName) ?? null;
    return new THREE.MeshLambertMaterial({
      color: map ? 0xffffff : color,
      map,
      side: THREE.DoubleSide,
    });
  };
  const barMaterial = linkMaterial(0xb6b6b6, assembly.barTextureName);
  const shockMaterial = linkMaterial(0xb7b7b7, assembly.shockTextureName);
  // The driveshaft has no texture field of its own; the game draws it in the same bar art.
  const shaftMaterial = linkMaterial(0x4b321f, assembly.barTextureName);

  const makeLink = (radius, material) => {
    // Unit height along +Y, so scale.y is the link's length.
    const geo = new THREE.CylinderGeometry(radius, radius, 1, 10, 1, false);
    const mesh = new THREE.Mesh(geo, material);
    links.add(mesh);
    return mesh;
  };

  const linkSegments = [];
  for (const bar of assembly.axleBars ?? []) {
    linkSegments.push({
      mesh: makeLink(0.10 * FEET_TO_INNER, barMaterial),
      start: truckVector(bar.start), end: truckVector(bar.end),
      startAttachment: bar.startAttachment, endAttachment: bar.endAttachment,
      startAxle: axleForPoint(bar.start, assembly), endAxle: axleForPoint(bar.end, assembly),
    });
  }
  for (const shock of assembly.shocks ?? []) {
    linkSegments.push({
      mesh: makeLink(0.12 * FEET_TO_INNER, shockMaterial),
      start: truckVector(shock.base), end: truckVector(shock.top),
      startAttachment: shock.baseAttachment, endAttachment: shock.topAttachment,
      startAxle: axleForPoint(shock.base, assembly), endAxle: axleForPoint(shock.top, assembly),
    });
  }
  if (assembly.driveshaft) {
    const hub = truckVector(assembly.driveshaft.hub);
    for (const endKey of ["front", "rear"]) {
      linkSegments.push({
        mesh: makeLink(0.14 * FEET_TO_INNER, shaftMaterial),
        start: hub.clone(), end: truckVector(assembly.driveshaft[endKey]),
        startAttachment: "body", endAttachment: "axle",
        startAxle: null, endAxle: endKey === "front" ? 0 : 1,
      });
    }
  }

  const up = new THREE.Vector3(0, 1, 0);
  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  const delta = new THREE.Vector3();

  /** Re-aim every link from the current axle offsets. */
  function updateLinks(axleTravel) {
    for (const seg of linkSegments) {
      from.copy(seg.start);
      to.copy(seg.end);
      if (seg.startAttachment === "axle") from.y += travelOf(seg.startAxle, axleTravel);
      if (seg.endAttachment === "axle") to.y += travelOf(seg.endAxle, axleTravel);
      delta.subVectors(to, from);
      const length = delta.length();
      if (!(length > 1e-6)) {
        seg.mesh.visible = false;
        continue;
      }
      seg.mesh.visible = true;
      seg.mesh.position.copy(from).add(to).multiplyScalar(0.5);
      seg.mesh.quaternion.setFromUnitVectors(up, delta.normalize());
      seg.mesh.scale.set(1, length, 1);
    }
  }

  updateLinks([0, 0]);

  return {
    root,
    chassis,
    body,
    wheels,
    axles,
    /** Restore the whole truck to its unloaded pose, which is how it is first shown. */
    reset() {
      for (const wheel of wheels) {
        wheel.mount.position.y = wheel.restY;
        wheel.steer.rotation.y = 0;
        wheel.spin.rotation.x = 0;
      }
      for (const axle of axles) axle.group.position.y = axle.restY;
      updateLinks([0, 0]);
    },
    /**
     * Drive the joints from one simulation step.
     *
     * @param {number[]} compression  per wheel, in feet, positive upward
     * @param {number[]} steerAngles  per wheel, radians
     * @param {number[]} spinAngles   per wheel, radians
     */
    setWheelState(compression, steerAngles, spinAngles) {
      const axleTravel = [0, 0];
      wheels.forEach((wheel, i) => {
        const travel = (compression?.[i] ?? 0) * FEET_TO_INNER;
        wheel.mount.position.y = wheel.restY + travel;
        /*
          Negated, for the same reason the spawn heading is.

          The simulation builds its steered direction as forward*cos + right*sin, so a positive
          angle points the tire to the truck's right. Rotating geometry that faces -Z by
          Ry(+angle) swings it to the LEFT, so drawing the angle as given mirrors the wheels
          against the physics: the truck turns right while its front wheels point left.
        */
        wheel.steer.rotation.y = -(steerAngles?.[i] ?? 0);
        // Negative, so a forward roll turns the wheel the way the truck is going.
        wheel.spin.rotation.x = -(spinAngles?.[i] ?? 0);
        const axleIndex = wheel.isFront ? 0 : 1;
        axleTravel[axleIndex] += travel / 2;
      });
      axles.forEach((axle, i) => {
        axle.group.position.y = axle.restY + axleTravel[i];
      });
      updateLinks(axleTravel);
    },
    /**
     * Place the truck.
     *
     * @param {{x:number,y:number,z:number}} scenePosition already in scene units, from
     *        world-frame's toSceneTruckPosition. Feet are deliberately not accepted: the
     *        vertical mapping depends on the terrain under the truck, which this does not know.
     * @param {THREE.Quaternion} orientation of the chassis
     */
    setPose(scenePosition, orientation) {
      chassis.position.set(scenePosition.x, scenePosition.y, scenePosition.z);
      if (orientation) chassis.quaternion.copy(orientation);
    },
    dispose() {
      root.traverse((node) => {
        node.geometry?.dispose?.();
        if (Array.isArray(node.material)) node.material.forEach((m) => m.dispose?.());
        else node.material?.dispose?.();
      });
    },
  };
}

/** Which axle a link endpoint belongs to, by whichever axle centre it is nearer in z. */
function axleForPoint(point, assembly) {
  const front = assembly.axles?.[0]?.position?.z ?? 0;
  const rear = assembly.axles?.[1]?.position?.z ?? 0;
  const z = point?.z ?? 0;
  return Math.abs(z - front) <= Math.abs(z - rear) ? 0 : 1;
}

function travelOf(axleIndex, axleTravel) {
  if (axleIndex === null || axleIndex === undefined) return 0;
  return axleTravel?.[axleIndex] ?? 0;
}
