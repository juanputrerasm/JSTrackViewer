/*
  Drawing the hitboxes the simulation collides with.

  This exists because of a specific complaint: driving into invisible walls. The markers are
  built FROM THE COLLIDERS, not from the track data, so if the truck stops against a box there
  is a wireframe around it, and if there is no wireframe the truck will not stop there.

  Only the objects that collide as boxes are drawn: boxes with no model (the invisible walls
  and checkpoint blockers), ramps and ground columns. An object with a model collides with its
  own triangles, so its drawn model already IS its hitbox and a box around it would mark space
  the truck drives straight through. Moving and shoved model objects carry their collision
  with them for the same reason.

  One colour. An earlier version coloured each box by mass, which read as several kinds of
  hitbox when there is only one: white means solid.
*/
import * as THREE from "three";
import { UNITS_PER_FOOT_H, UNITS_PER_FOOT_V } from "./world-frame.js";

const HITBOX_COLOUR = 0xffffff;

/**
 * @param {object} colliders from createColliders
 * @returns {THREE.Group} ready to add to the scene
 */
export function buildColliderMarkers(colliders) {
  const group = new THREE.Group();
  group.name = "colliderMarkers";
  if (!colliders) return group;

  const material = new THREE.LineBasicMaterial({ color: HITBOX_COLOUR, transparent: true, opacity: 0.7 });

  for (const solid of colliders.solids) {
    if (solid.kind === "mesh") continue;

    /*
      Sized in scene units from the collider's feet. The scene is anisotropic, so a wireframe
      that ignored that would sit slightly off the thing it marks, which defeats a diagnostic.
    */
    const geometry = new THREE.BoxGeometry(
      solid.extents[0] * 2 * UNITS_PER_FOOT_H,
      solid.extents[1] * 2 * UNITS_PER_FOOT_V,
      solid.extents[2] * 2 * UNITS_PER_FOOT_H
    );
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), material);
    geometry.dispose();

    /*
      Orientation straight from the collider's axes, which are already in scene axes. Building
      a rotation from them rather than re-deriving it from psi/theta/phi means the marker
      cannot drift from the collider even if the placement convention is later found to be
      wrong: it would be wrong in the same way, which is what a diagnostic needs.
    */
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(solid.axes[0].x, solid.axes[0].y, solid.axes[0].z),
      new THREE.Vector3(solid.axes[1].x, solid.axes[1].y, solid.axes[1].z),
      new THREE.Vector3(solid.axes[2].x, solid.axes[2].y, solid.axes[2].z)
    );
    edges.quaternion.setFromRotationMatrix(basis);
    edges.position.set(
      solid.centre.x * UNITS_PER_FOOT_H,
      solid.centre.y * UNITS_PER_FOOT_V,
      solid.centre.z * UNITS_PER_FOOT_H
    );
    edges.userData.collider = solid;
    group.add(edges);
  }

  /*
    Ground columns are authored as terrain data rather than as objects, so nothing draws them
    except the terrain skin they stand under. They are the likeliest invisible wall of all.
  */
  for (const column of colliders.columns) {
    const geometry = new THREE.BoxGeometry(
      (column.maxX - column.minX) * UNITS_PER_FOOT_H,
      (column.top - column.bottom) * UNITS_PER_FOOT_V,
      (column.maxZ - column.minZ) * UNITS_PER_FOOT_H
    );
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), material);
    geometry.dispose();
    edges.position.set(
      (column.minX + column.maxX) / 2 * UNITS_PER_FOOT_H,
      (column.bottom + column.top) / 2 * UNITS_PER_FOOT_V,
      (column.minZ + column.maxZ) / 2 * UNITS_PER_FOOT_H
    );
    group.add(edges);
  }

  group.userData.dispose = () => {
    group.traverse((node) => node.geometry?.dispose?.());
    material.dispose();
  };

  return group;
}
