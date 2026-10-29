/*
  The 4x4 Evolution 1 and 2 vehicle model, as specified in OpenMTM2's docs/EVO2_PHYSICS.md. It
  runs on the MTM2 simulation's world, collisions and post-step (`mtm2Sim`); exported from the
  package root as the `evoSim` namespace. See docs/SIM_EVO.md.
*/
export * from "./rules.js";
export * from "./spec.js";
export * from "./ground.js";
export * from "./params.js";
export * from "./driveline.js";
export * from "./step.js";
export { postStepTruck as postStepEvoTruck } from "../mtm2/truck/dynamics.js";
