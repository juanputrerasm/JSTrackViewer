/*
  Floating tool windows over the viewport, as JSTraxx's (src/ui/shell/panel.ts) and Traxx's
  Textures and Models boxes: a title bar to drag, a close button, a resize grip, and the last
  position and size remembered per window. They stay inside the area they float over.

  Plain DOM and no build step, like the rest of the viewer. The remembered rectangles live in
  localStorage, which can be missing or refuse writes (private windows, blocked storage), so
  every access is guarded and a window simply opens at its default place when it cannot read.
*/

const STORAGE_KEY = "jstrackviewer.panels";
let topZ = 20;

function readStored() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function writeStored(id, rect) {
  try {
    const all = readStored();
    all[id] = rect;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* Storage is a convenience; the window still works without it. */
  }
}

/** Creates an element with attributes and children, the small helper JSTraxx's `el` is. */
export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export class FloatingPanel {
  /**
   * @param {HTMLElement} area the element the window floats over (the viewport)
   * @param {{ id: string, title: string, width: number, height: number, minWidth?: number,
   *   minHeight?: number, onShow?: () => void, onHide?: () => void, onResize?: () => void }} options
   */
  constructor(area, options) {
    this.area = area;
    this.options = options;
    const title = el("div", { class: "fpanel-title" },
      el("span", {}, options.title),
      el("button", { type: "button", class: "fpanel-close", title: "Close", "aria-label": `Close ${options.title}`, onclick: () => this.hide() }, "×"));
    this.body = el("div", { class: "fpanel-body" });
    const grip = el("div", { class: "fpanel-grip", "aria-hidden": "true" });
    this.element = el("section", { class: "fpanel", role: "dialog", "aria-label": options.title, hidden: true }, title, this.body, grip);
    // Keys typed in a box (a list, a slider) are the box's, not the flying camera's.
    // Keys, clicks, drags and the wheel inside a box are the box's, not the camera's beneath it.
    for (const type of ["keydown", "keyup", "mousedown", "pointerdown", "wheel", "dblclick", "contextmenu", "touchstart"]) {
      this.element.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
    }
    this.element.addEventListener("pointerdown", () => this.raise());
    this._drag(title, (dx, dy, s) => this._place(s.x + dx, s.y + dy, s.w, s.h));
    this._drag(grip, (dx, dy, s) => { this._place(s.x, s.y, s.w + dx, s.h + dy); options.onResize?.(); });
    area.append(this.element);
  }

  get visible() {
    return !this.element.hidden;
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  show() {
    const a = this.area.getBoundingClientRect();
    const stored = readStored()[this.options.id];
    const r = stored ?? { x: Math.max(0, a.width - this.options.width - 12), y: 12, w: this.options.width, h: this.options.height };
    this.element.hidden = false;
    this._place(r.x, r.y, r.w, r.h);
    this.raise();
    this._remember();
    this.options.onShow?.();
  }

  hide() {
    if (this.element.hidden) return;
    this.element.hidden = true;
    this._remember();
    this.options.onHide?.();
  }

  raise() {
    this.element.style.zIndex = String(++topZ);
  }

  _place(x, y, w, h) {
    const a = this.area.getBoundingClientRect();
    w = Math.max(this.options.minWidth ?? 180, Math.min(w, a.width));
    h = Math.max(this.options.minHeight ?? 120, Math.min(h, a.height));
    x = Math.max(0, Math.min(x, a.width - Math.min(w, 80)));
    y = Math.max(0, Math.min(y, a.height - 24));
    Object.assign(this.element.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  }

  _remember() {
    const s = this.element.style;
    writeStored(this.options.id, {
      x: parseFloat(s.left) || 0, y: parseFloat(s.top) || 0,
      w: parseFloat(s.width) || this.options.width, h: parseFloat(s.height) || this.options.height,
    });
  }

  _drag(handle, move) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button") || e.button !== 0) return;
      e.preventDefault();
      const s = this.element.style;
      const start = { x: parseFloat(s.left), y: parseFloat(s.top), w: this.element.offsetWidth, h: this.element.offsetHeight };
      const ox = e.clientX, oy = e.clientY;
      handle.setPointerCapture(e.pointerId);
      const onMove = (m) => move(m.clientX - ox, m.clientY - oy, start);
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        this._remember();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
  }
}
