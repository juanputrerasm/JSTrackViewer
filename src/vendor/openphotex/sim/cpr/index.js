/*
  CART Precision Racing's car model (OpenMTM2 docs/CPR_PHYSICS.md 16.2): CPR's forces on MTM2's world, contacts,
  integration and post-step, as `sim/evo` is. See step.ts for what is the game's and what is the port's.
*/
export * from "./rules.js";
export * from "./step.js";
export { postStepTruck as postStepCprTruck } from "../mtm2/truck/dynamics.js";
