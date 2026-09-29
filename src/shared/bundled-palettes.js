import { bundledPalette } from "../vendor/openphotex/index.js";

/*
  The stock METALCR2 and VGA palettes a single archive lacks. The bytes and where each comes
  from are OpenPhotex's (bundledPalette); this keeps the viewer's old names.
*/
export const PALETTES = {
  metalcr2Mtm1: bundledPalette("metalcr2Mtm1"),
  metalcr2Cpr: bundledPalette("metalcr2Cpr"),
  vgaHB: bundledPalette("vgaHB"),
  vgaTV: bundledPalette("vgaTV"),
};
