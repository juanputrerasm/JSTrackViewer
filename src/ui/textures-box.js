import { FloatingPanel, el } from "./floating-panel.js";
import { SURFACES } from "../drive/surfaces.js";
import { CPR_SURFACE_TYPES } from "../shared/cpr-track-schema.js";

/*
  The Textures box: an overview of every texture the loaded track carries, after JSTraxx's
  Textures window (src/ui/panels/textures-panel.ts, Traxx's IDD_TEXTURES) without its editing.

  The textures are drawn in a grid in three groups: the terrain's (its .TEX list, in slot order,
  so a tile's place is the index the .CLR names), the models', and the sky. A click picks one
  and shows its name and size under the grid; the zoom buttons draw the grid at JSTraxx's sizes,
  24 to 128 pixels, 48 by default, so a box of the default size shows dozens at once and a larger
  one more.

  A picked terrain texture also shows its ground type, what the game makes of a wheel on it: the
  track's .TTY for Monster Truck Madness, CART Precision Racing, Terminal Velocity, Fury3 and
  Hellbender (Traxx's thirteen types, with a depth), the .TEX record for 4x4 Evolution (the same
  table plus train track, with its vegetation class). A CART road texture shows its road surface
  type from the .TTX.
*/

/** Ground type names by `type` (value / 100): Traxx's table, and Evo's type 14. */
const GROUND_NAMES = SURFACES.map((s) => s.name);
const EVO_EXTRA = { 14: "Train track" };
const VEGETATION = ["no vegetation", "sparse vegetation", "medium vegetation", "dense vegetation"];

/** A slot's ground value (`type * 100 + depth`) in words, for the game it came from. */
export function groundDescription(item, origin) {
  if (item.roadFlags !== undefined) return `road surface: ${CPR_SURFACE_TYPES[item.roadFlags] ?? `type ${item.roadFlags}`}`;
  if (item.ground === null || item.ground === undefined) return item.slot === undefined ? "" : "no ground type";
  const evo = origin === "EVO1" || origin === "EVO2";
  const type = Math.floor(item.ground / 100), depth = item.ground % 100;
  const name = GROUND_NAMES[type] ?? (evo ? EVO_EXTRA[type] : null) ?? `type ${type}`;
  const parts = [`ground: ${name}`, `depth ${depth}`];
  if (evo && item.vegetation !== null && item.vegetation !== undefined) parts.push(VEGETATION[item.vegetation] ?? `vegetation ${item.vegetation}`);
  return parts.join(", ");
}

/** kTexZoom: the sizes the grid draws textures at. */
const ZOOMS = [24, 32, 48, 64, 96, 128];
const ZOOM_DEFAULT = 2;

export class TexturesBox {
  /**
   * @param {HTMLElement} area the viewport, which the box floats over
   * @param {object} scene the TrackScene
   */
  constructor(area, scene) {
    this.scene = scene;
    this.zoom = ZOOM_DEFAULT;
    this.selected = null;
    this.panel = new FloatingPanel(area, {
      id: "textures", title: "Textures", width: 520, height: 420, minWidth: 240, minHeight: 180,
      onShow: () => this.refresh(),
    });
    this.smaller = el("button", { type: "button", title: "Smaller textures", onclick: () => this.setZoom(this.zoom - 1) }, "−");
    this.larger = el("button", { type: "button", title: "Larger textures", onclick: () => this.setZoom(this.zoom + 1) }, "+");
    this.grid = el("div", { class: "tex-grid" });
    this.info = el("output", { class: "tex-info" }, "No texture selected");
    this.panel.body.append(el("div", { class: "tex-window" },
      el("div", { class: "tex-tools" }, this.smaller, this.larger, this.info),
      this.grid));
  }

  toggle() { this.panel.toggle(); }

  setTrack() {
    this.selected = null;
    this.info.textContent = "No texture selected";
    if (this.panel.visible) this.refresh();
    else this.grid.replaceChildren();
  }

  setZoom(level) {
    this.zoom = Math.max(0, Math.min(ZOOMS.length - 1, level));
    this.smaller.disabled = this.zoom === 0;
    this.larger.disabled = this.zoom === ZOOMS.length - 1;
    // One variable sizes every tile (styles.css .tex-tile), which the viewport's canvas rule cannot override.
    this.grid.style.setProperty("--tile", `${ZOOMS[this.zoom]}px`);
  }

  refresh() {
    const groups = this.scene.textureCatalog();
    const origin = this.scene.trackOrigin;
    this.grid.replaceChildren();
    if (!groups.length) {
      this.grid.append(el("p", { class: "box-empty" }, "This track has no textures to show."));
      return;
    }
    for (const group of groups) {
      this.grid.append(el("h3", { class: "tex-group" }, `${group.title} (${group.items.length})`));
      const tiles = el("div", { class: "tex-tiles" });
      group.items.forEach((item, i) => {
        const canvas = el("canvas", {
          class: "tex-tile", title: [`${item.name} ${item.width}x${item.height}`, groundDescription(item, origin)].filter(Boolean).join("\n"), tabindex: 0,
          "aria-label": `${group.title} texture ${item.name}`,
        });
        const key = `${group.title}:${i}`;
        if (key === this.selected) canvas.classList.add("selected");
        const pick = () => {
          this.selected = key;
          for (const other of this.grid.querySelectorAll(".tex-tile.selected")) other.classList.remove("selected");
          canvas.classList.add("selected");
          const ground = groundDescription(item, origin);
          const slot = item.slot === undefined ? "" : ` (slot ${item.slot})`;
          this.info.textContent = `${item.name}${slot}  ${item.width} x ${item.height}${ground ? `  ·  ${ground}` : ""}`;
          this.info.title = this.info.textContent;
        };
        canvas.addEventListener("click", pick);
        canvas.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") pick(); });
        tiles.append(canvas);
        // Drawn after the grid is in place, one frame later, so a large track opens at once.
        requestAnimationFrame(() => paint(canvas, item));
      });
      this.grid.append(tiles);
    }
    this.setZoom(this.zoom);
  }
}

function paint(canvas, item) {
  try {
    const { rgba, width, height } = item.image();
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
  } catch {
    canvas.classList.add("missing");
  }
}
