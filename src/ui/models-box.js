import * as THREE from "three";
import { FloatingPanel, el } from "./floating-panel.js";

/*
  The Models box: an overview of every model the loaded track carries, after JSTraxx's Models
  window (src/ui/panels/models-panel.ts, itself Traxx's IDD_OBJECTS) without its editing.

  Left, the models in a list, each with how many objects place it, filtered by a search box.
  Right, the picked model on its own in a 3D preview with JSTraxx's controls (a turn slider
  under it, a tilt slider beside it, a zoom slider), and its vertex and triangle counts.

  Picking a model also takes the main camera straight to the front of the first object that
  places it and outlines that object in wireframe (scene.focusObject); Previous and Next walk
  through the others. The outline stays until another object is picked, Clear outline is
  pressed or the track changes.
*/

/* JSTraxx's preview controls (TraxxObjectsDlg.cpp): 10 degree turn steps either side of 18, 5
   degree tilt steps either side of 9, the distance from 40 to 600 with 200 the start. */
const HMID = 18, VMID = 9, YAW_STEP = 10, PITCH_STEP = 5;
const ZOOM_NEAR = 40, ZOOM_FAR = 600, ZOOM_STEP = 10, ZOOM_START = 200;
const PREVIEW_FOV = 40;
const PREVIEW_BACKGROUND = 0x1a1a1e;

/** A second renderer for the preview, drawing on demand. Null where WebGL is not available. */
function createPreview(canvas) {
  let renderer = null;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  } catch {
    return null;
  }
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(PREVIEW_FOV, 1, 0.1, 100000);
  const pivot = new THREE.Group();
  scene.add(pivot);
  return {
    /** Draws `model` (a group, or null) turned by yaw and tilted by pitch (degrees), at distance / 200 of a fit. */
    draw(model, yaw, pitch, zoom) {
      const w = Math.max(8, canvas.clientWidth), h = Math.max(8, canvas.clientHeight);
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.setSize(w, h, false);
      renderer.setClearColor(PREVIEW_BACKGROUND);
      pivot.clear();
      pivot.rotation.set(THREE.MathUtils.degToRad(pitch), THREE.MathUtils.degToRad(yaw), 0, "XYZ");
      let radius = 1;
      if (model) {
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        if (!box.isEmpty()) {
          const centre = box.getCenter(new THREE.Vector3());
          radius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
          const holder = new THREE.Group();
          holder.position.copy(centre).negate();
          holder.add(model);
          pivot.add(holder);
        }
      }
      const distance = (radius / Math.sin(THREE.MathUtils.degToRad(PREVIEW_FOV / 2))) * 1.15 * zoom;
      camera.aspect = w / h;
      camera.near = Math.max(0.1, distance - radius * 4);
      camera.far = distance + radius * 4 + 10;
      camera.position.set(0, 0, distance);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    },
  };
}

export class ModelsBox {
  /**
   * @param {HTMLElement} area the viewport, which the box floats over
   * @param {object} scene the TrackScene
   */
  constructor(area, scene) {
    this.scene = scene;
    this.catalog = [];
    this.selected = null;
    this.instance = 0;
    this.zoom = ZOOM_START;
    this.panel = new FloatingPanel(area, {
      id: "models", title: "Models", width: 460, height: 340, minWidth: 360, minHeight: 260,
      onShow: () => this.refresh(), onResize: () => this.draw(),
    });

    this.filter = el("input", { type: "search", class: "box-filter", placeholder: "Filter", "aria-label": "Filter models" });
    this.list = el("select", { size: 12, class: "box-list", "aria-label": "Models" });
    this.canvas = el("canvas", { class: "box-preview", "aria-label": "Model preview" });
    this.yaw = el("input", { type: "range", min: 0, max: 2 * HMID, value: HMID, "aria-label": "Turn" });
    this.pitch = el("input", { type: "range", min: 0, max: 2 * VMID, value: VMID, class: "box-vslider", "aria-label": "Tilt" });
    this.zoomSlider = el("input", { type: "range", min: 0, max: (ZOOM_FAR - ZOOM_NEAR) / ZOOM_STEP, value: (ZOOM_FAR - ZOOM_START) / ZOOM_STEP, "aria-label": "Zoom" });
    this.vertices = el("output", { class: "box-count" }, "0");
    this.triangles = el("output", { class: "box-count" }, "0");
    this.placed = el("output", { class: "box-count" }, "0");
    this.prev = el("button", { type: "button", title: "Go to the previous object with this model", onclick: () => this.step(-1) }, "◀");
    this.next = el("button", { type: "button", title: "Go to the next object with this model", onclick: () => this.step(1) }, "▶");
    this.which = el("span", { class: "box-which" }, "");
    this.clear = el("button", { type: "button", class: "quiet", onclick: () => this.scene.clearHighlight() }, "Clear outline");

    this.panel.body.append(el("div", { class: "box-window" },
      el("div", { class: "box-left" }, this.filter, this.list),
      el("div", { class: "box-right" },
        el("div", { class: "box-view" }, this.canvas, this.pitch),
        this.yaw,
        el("label", { class: "box-field" }, "Zoom", this.zoomSlider),
        el("div", { class: "box-counts" },
          el("label", { class: "box-field" }, "Vertices", this.vertices),
          el("label", { class: "box-field" }, "Triangles", this.triangles),
          el("label", { class: "box-field" }, "Placed", this.placed)),
        el("div", { class: "box-go" }, this.prev, this.which, this.next, this.clear))));

    this.preview = createPreview(this.canvas);
    if (!this.preview) this.canvas.replaceWith(el("p", { class: "box-empty" }, "No 3D preview: WebGL is not available."));

    this.list.addEventListener("change", () => this.pick(this.list.value));
    this.filter.addEventListener("input", () => this.fill());
    for (const input of [this.yaw, this.pitch]) input.addEventListener("input", () => this.draw());
    this.zoomSlider.addEventListener("input", () => {
      this.zoom = ZOOM_FAR - ZOOM_STEP * Number(this.zoomSlider.value);
      this.draw();
    });
  }

  toggle() { this.panel.toggle(); }

  /** A new track: the list again, nothing picked. */
  setTrack() {
    this.selected = null;
    this.instance = 0;
    this.catalog = [];
    if (this.panel.visible) this.refresh();
  }

  refresh() {
    this.catalog = this.scene.modelCatalog();
    if (this.selected && !this.catalog.some((m) => m.name === this.selected)) this.selected = null;
    this.fill();
    this.update();
  }

  fill() {
    const needle = this.filter.value.trim().toUpperCase();
    const shown = this.catalog.filter((m) => !needle || m.name.toUpperCase().includes(needle));
    this.list.replaceChildren(...shown.map((m) => el("option", { value: m.name, selected: m.name === this.selected },
      `${m.name.replace(/\.(BIN|SMF)$/i, "")}  ${m.instances.length ? `(${m.instances.length})` : "(not placed)"}`)));
    if (!shown.length) this.list.append(el("option", { disabled: true }, this.catalog.length ? "No match" : "No models"));
  }

  pick(name) {
    this.selected = name;
    this.instance = 0;
    this.update();
    this.go();
  }

  step(direction) {
    const model = this.current();
    if (!model?.instances.length) return;
    this.instance = (this.instance + direction + model.instances.length) % model.instances.length;
    this.update();
    this.go();
  }

  current() {
    return this.catalog.find((m) => m.name === this.selected) ?? null;
  }

  go() {
    const model = this.current();
    if (model?.instances.length) this.scene.focusObject(model.instances[this.instance]);
    else this.scene.clearHighlight();
  }

  update() {
    const model = this.current();
    this.vertices.value = String(model?.vertices ?? 0);
    this.triangles.value = String(model?.triangles ?? 0);
    this.placed.value = String(model?.instances.length ?? 0);
    const many = (model?.instances.length ?? 0) > 1;
    this.prev.disabled = this.next.disabled = !many;
    this.which.textContent = model?.instances.length ? `${this.instance + 1} / ${model.instances.length}` : "";
    this.draw();
  }

  draw() {
    if (!this.panel.visible || !this.preview) return;
    const group = this.selected ? this.scene.modelPreviewGroup(this.selected) : null;
    this.preview.draw(group, YAW_STEP * (Number(this.yaw.value) - HMID),
      PITCH_STEP * (Number(this.pitch.value) - VMID), this.zoom / ZOOM_START);
  }
}
