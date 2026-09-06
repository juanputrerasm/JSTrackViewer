import { TrackScene } from "./scene.js";
import { WorkerClient } from "./worker-client.js";
import { resetSessionFolder, writeBytesToFile } from "./shared/opfs.js";
import { extractFirstPodFromZipBytes } from "./zip-utils.js";

const OPFS_PATH = "track-viewer/current.pod";
const WORKER_URL = new URL("./worker/track-worker.js", import.meta.url);

export class TrackViewerApp {
  constructor() {
    this._worker = null;
    this._scene = null;
    this._choices = [];
    this._currentPodPath = null;
    this._podFilename = "";
    this._podSource = "—";
    // Traxx ALTITUDESCALE = 3 (Traxx/TraxxView.h:43). Terrain and object heights both
    // derive from it, so anything else renders the whole track vertically exaggerated.
    this._heightScale = 3;
    this._renderFlags = {
      terrain: true, textures: true, grid: false,
      courses: false, objects: true, gboxes: true,
      cboxes: false, water: true, backdrop: true, shadows: true,
      wireframe: false, trucks: true, billboards: true, checkpoints: true,
      ramps: true,
    };
  }

  mount(doc) {
    this._doc = doc;

    // Init worker
    this._worker = new WorkerClient(WORKER_URL.href);

    // Init scene
    const viewport = doc.getElementById("viewport");
    this._scene = new TrackScene(viewport);
    this._minimap = new Minimap(doc.getElementById("minimap"), doc.getElementById("minimap-panel"), (x, z) => {
      this._scene.nav?.moveToWorldPosition(x, z);
    });
    this._scene.setNavigationChangeCallback((nav) => this._minimap.updateCamera(nav));

    // File input
    const fileInput = doc.getElementById("file-input");
    doc.getElementById("open-file-btn").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) this._loadFromFile(file);
      fileInput.value = "";
    });

    // URL input
    doc.getElementById("open-url-btn").addEventListener("click", () => {
      const url = doc.getElementById("url-input").value.trim();
      if (url) this._loadFromUrl(url);
    });
    doc.getElementById("url-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") doc.getElementById("open-url-btn").click();
    });

    // Clear temp
    doc.getElementById("clear-temp-btn").addEventListener("click", async () => {
      await resetSessionFolder("track-viewer");
      this._scene.clearTrack();
      this._setStatus("Temp cleared.");
      this._choices = [];
      this._hideTrackPicker();
      this._clearTrackInfo();
    });

    // Track picker
    doc.getElementById("load-track-btn").addEventListener("click", () => {
      const idx = parseInt(doc.getElementById("track-select").value, 10);
      if (!isNaN(idx)) this._loadTrackChoice(idx);
    });

    // Camera reset
    doc.getElementById("reset-cam-btn").addEventListener("click", () => {
      const td = this._scene?._trackData;
      if (td?.terrain) {
        this._scene.nav.resetToCourseStart(td, this._heightScale);
      }
    });

    // View toggles
    const toggleMap = {
      "tog-terrain":   "terrain",
      "tog-textures":  "textures",
      "tog-grid":      "grid",
      "tog-courses":   "courses",
      "tog-objects":   "objects",
      "tog-billboards": "billboards",
      "tog-checkpoints":"checkpoints",
      "tog-ramps":     "ramps",
      "tog-gboxes":    "gboxes",
      "tog-cboxes":    "cboxes",
      "tog-water":     "water",
      "tog-backdrop":  "backdrop",
      "tog-shadows":   "shadows",
      "tog-wireframe": "wireframe",
      "tog-trucks":    "trucks",
    };
    for (const [id, flag] of Object.entries(toggleMap)) {
      const el = doc.getElementById(id);
      if (!el) continue;
      el.addEventListener("change", () => {
        this._renderFlags[flag] = el.checked;
        this._scene.setRenderFlags(this._renderFlags);
      });
    }

    // Sliders
    const gridSlider = doc.getElementById("grid-span-slider");
    const gridLabel  = doc.getElementById("grid-span-value");
    gridSlider.addEventListener("input", () => {
      const v = parseInt(gridSlider.value, 10);
      gridLabel.textContent = v;
      this._scene.setViewDistance(v);
    });
    // Apply initial value
    this._scene.setViewDistance(parseInt(gridSlider.value, 10));

    const sunSlider = doc.getElementById("sun-intensity-slider");
    const sunLabel  = doc.getElementById("sun-intensity-value");
    sunSlider.addEventListener("input", () => {
      const v = parseInt(sunSlider.value, 10) / 10;
      sunLabel.textContent = v.toFixed(1);
      this._scene.setSunIntensity(v);
    });
    this._scene.setSunIntensity(parseInt(sunSlider.value, 10) / 10);

    const gammaSlider = doc.getElementById("gamma-slider");
    const gammaLabel  = doc.getElementById("gamma-value");
    gammaSlider.addEventListener("input", () => {
      const v = parseInt(gammaSlider.value, 10) / 10;
      gammaLabel.textContent = v.toFixed(1);
      this._scene.setGamma(v);
    });
    this._scene.setGamma(parseInt(gammaSlider.value, 10) / 10);

    // Focus viewport to capture keyboard events
    viewport.setAttribute("tabindex", "0");
    viewport.focus();
  }

  async _loadFromFile(file) {
    this._setStatus(`Reading ${file.name}…`);
    this._showLoading(`Reading ${file.name}…`);
    try {
      const buffer = await file.arrayBuffer();
      const staged = await this._podBytesFromContainer(new Uint8Array(buffer), file.name);
      await this._storePodAndIndex(staged.bytes, staged.filename, staged.source);
    } catch (err) {
      this._setStatus(`Error: ${err.message}`);
    } finally {
      this._hideLoading();
    }
  }

  async _loadFromUrl(url) {
    this._setStatus(`Fetching…`);
    this._showLoading("Fetching from URL…");
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const buffer = await resp.arrayBuffer();
      const name = nameFromUrl(url);
      const staged = await this._podBytesFromContainer(new Uint8Array(buffer), name, "URL");
      await this._storePodAndIndex(staged.bytes, staged.filename, staged.source);
    } catch (err) {
      this._setStatus(`Error: ${err.message}`);
    } finally {
      this._hideLoading();
    }
  }

  async _podBytesFromContainer(bytes, filename, sourcePrefix = "Local file") {
    if (!isZipName(filename)) {
      return { bytes, filename, source: sourcePrefix };
    }
    this._setStatus("Extracting POD from ZIP…");
    this._showLoading("Extracting POD from ZIP…");
    const { podBytes, podEntryName } = await extractFirstPodFromZipBytes(bytes, filename);
    return {
      bytes: podBytes,
      filename: podNameFromZipEntry(filename, podEntryName),
      source: sourcePrefix === "URL" ? `URL ZIP: ${filename}` : `ZIP: ${filename}`,
    };
  }

  async _storePodAndIndex(bytes, filename, source) {
    this._podFilename = filename;
    this._podSource = source ?? "—";
    this._setStatus("Writing to temp storage…");
    await resetSessionFolder("track-viewer");
    await writeBytesToFile(OPFS_PATH, bytes);
    this._currentPodPath = OPFS_PATH;

    this._setStatus("Indexing POD…");
    const { comment, entryCount } = await this._worker.call("indexPod", { opfsPodPath: OPFS_PATH });
    this._setStatus(`POD indexed: ${entryCount} entries.`);

    const { choices } = await this._worker.call("listTrackChoices", {});
    this._choices = choices;

    if (choices.length === 0) {
      this._setStatus("No tracks found in POD.");
      return;
    }

    this._populateTrackPicker(choices, filename);

    if (choices.length === 1) {
      await this._loadTrackChoice(0);
    } else {
      this._setStatus(`Found ${choices.length} tracks. Choose one and click Load Track.`);
    }
  }

  async _loadTrackChoice(choiceIndex) {
    this._lastChoiceIndex = choiceIndex;
    const choice = this._choices[choiceIndex];
    if (!choice) return;

    this._setStatus(`Loading "${choice.name}"…`);
    this._showLoading(`Loading ${choice.name}…`);
    try {
      const result = await this._worker.call("loadTrack", {
        choiceIndex,
        heightScale: this._heightScale,
      });
      this._scene.setTrack(result, this._renderFlags, this._heightScale);
      this._minimap.setTrack(result);
      this._minimap.updateCamera(this._scene.nav);
      this._updateTrackInfo(result);
      this._setStatus(result.trackName || choice.name);
      // Focus viewport after load
      this._doc.getElementById("viewport")?.focus();
    } catch (err) {
      this._setStatus(`Error loading track: ${err.message}`);
      console.error(err);
    } finally {
      this._hideLoading();
    }
  }

  _populateTrackPicker(choices, filename) {
    const panel = this._doc.getElementById("track-picker-panel");
    const select = this._doc.getElementById("track-select");
    select.innerHTML = "";
    for (let i = 0; i < choices.length; i++) {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = choices[i].name || `Track ${i + 1}`;
      select.appendChild(opt);
    }
    panel.hidden = false;
  }

  _hideTrackPicker() {
    this._doc.getElementById("track-picker-panel").hidden = true;
    this._doc.getElementById("track-select").innerHTML = "";
  }

  _updateTrackInfo(data) {
    const dl = this._doc.getElementById("track-info");
    const pairs = [
      ["File",         data.fileName || "—"],
      ["Origin",       this._podSource],
      ["Name",         data.trackName || "—"],
      ["Locale",       data.localeName || "—"],
      ["Type",         data.trackType || "—"],
      ["Game",         data.origin || "—"],
      ["Background",   displayBackgroundModel(data)],
      ["Music",        displayMusic(data)],
      ["Weather",      displayWeather(data.weatherMask)],
      ["Water level",  data.waterLevel > 0 ? data.waterLevel : "None"],
      ["Ambient",      displayMusicSlot(data.ambientSound)],
      ["POD comment",  data.podComment || "—"],
    ];

    dl.innerHTML = pairs.map(([k, v]) =>
      `<dt>${escHtml(String(k))}</dt><dd>${escHtml(String(v))}</dd>`
    ).join("");

    const statsPanel = this._doc.getElementById("stats-panel");
    const statsDl = this._doc.getElementById("track-stats");
    if (data.stats) {
      const s = data.stats;
      const statsPairs = [
        ["Grid size",    `${s.gridSize}×${s.gridSize}`],
        ["Textures",     s.textureCount],
        ["Objects",      s.objectCount],
        ["Ground boxes", s.groundBoxCount],
        ["Course segs",  s.primarySegmentCount],
      ];
      statsDl.innerHTML = statsPairs.map(([k, v]) =>
        `<dt>${escHtml(String(k))}</dt><dd>${escHtml(String(v))}</dd>`
      ).join("");
      if (statsPanel) statsPanel.hidden = false;
    } else {
      statsDl.innerHTML = "<dt>Status</dt><dd>No stats.</dd>";
      if (statsPanel) statsPanel.hidden = false;
    }
  }

  _clearTrackInfo() {
    const dl = this._doc.getElementById("track-info");
    dl.innerHTML = "<dt>Status</dt><dd>No track loaded.</dd>";
    const statsPanel = this._doc.getElementById("stats-panel");
    if (statsPanel) statsPanel.hidden = true;
    this._doc.getElementById("track-stats").innerHTML = "<dt>Status</dt><dd>No track loaded.</dd>";
    this._minimap?.clear();
  }

  _setStatus(msg) {
    const el = this._doc.getElementById("status-text");
    if (el) el.textContent = msg;
  }

  _showLoading(msg) {
    const overlay = this._doc.getElementById("loading-overlay");
    const msgEl   = this._doc.getElementById("loading-msg");
    if (overlay) overlay.hidden = false;
    if (msgEl) msgEl.textContent = msg;
  }

  _hideLoading() {
    const overlay = this._doc.getElementById("loading-overlay");
    if (overlay) overlay.hidden = true;
  }
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isZipName(name) {
  return String(name ?? "").trim().toUpperCase().endsWith(".ZIP");
}

function podNameFromZipEntry(zipName, podEntryName) {
  const cleanEntry = String(podEntryName ?? "").replace(/\\/g, "/").split("/").filter(Boolean).pop();
  return cleanEntry || `${String(zipName ?? "track").replace(/\.[^.]+$/, "")}.POD`;
}

function nameFromUrl(url) {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.pathname.split("/").filter(Boolean).pop() || "track.pod";
  } catch {
    return "track.pod";
  }
}

const MUSIC_NAMES = ["AZTEC", "BREAK", "FARM", "GRAVEX", "ROCKX", "SCRAP", "SPLASH", "SURF", "VOODOO"];
const WEATHER_NAMES = ["Clear", "Cloudy", "Foggy", "Dense Fog", "Rain", "Snow", "Dusk", "Night", "Pitch Black"];

function displayMusic(data) {
  const name = data.musicName || "";
  if (!name) return "—";
  const base = name.split(/[\\/]/).pop().replace(/\.[^.]+$/, "").toUpperCase();
  return MUSIC_NAMES.includes(base) ? base : name;
}

function displayBackgroundModel(data) {
  const name = data.backdropModelName || "";
  if (!name) return "—";
  const model = data.models?.[name];
  return model?.format ? `${name} (${model.format})` : name;
}

function displayMusicSlot(slot) {
  if (slot == null || slot === "") return "—";
  if (slot >= 0 && slot < MUSIC_NAMES.length) return `${MUSIC_NAMES[slot]} (${slot})`;
  return slot === 14 ? "None (14)" : `Slot ${slot}`;
}

function displayWeather(mask) {
  if (mask == null) return "—";
  const active = [];
  for (let i = 0; i < WEATHER_NAMES.length; i++) {
    if ((mask & (1 << i)) !== 0) active.push(WEATHER_NAMES[i]);
  }
  if ((mask & 0x01FF) === 0x01FF) return "All";
  if (!active.length) return "None";
  return active.join(", ");
}

class Minimap {
  constructor(canvas, panel, onNavigate) {
    this.canvas = canvas;
    this.panel = panel;
    this.onNavigate = onNavigate;
    this.track = null;
    this.mapBitmap = null;
    this.mapCanvas = null;
    this.canvas?.addEventListener("click", (e) => this._onClick(e));
  }

  setTrack(track) {
    this.track = track;
    this._buildHeightMap();
    this.panel.hidden = !this.mapBitmap;
    this.draw();
  }

  clear() {
    this.track = null;
    this.mapBitmap = null;
    this.mapCanvas = null;
    if (this.panel) this.panel.hidden = true;
    const ctx = this.canvas?.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  updateCamera(nav) {
    this.nav = nav;
    this.draw();
  }

  _onClick(e) {
    const terrain = this.track?.terrain;
    if (!this.canvas || !terrain || !this.onNavigate) return;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const worldSize = (terrain.gridSize ?? 256) * (terrain.cellSize ?? 64);
    const x = ((e.clientX - rect.left) / rect.width) * worldSize;
    const z = ((e.clientY - rect.top) / rect.height) * worldSize;
    this.onNavigate(x, z);
  }

  _buildHeightMap() {
    const terrain = this.track?.terrain;
    if (!this.canvas || !terrain?.rawData) {
      this.mapBitmap = null;
      return;
    }
    const gridSize = terrain.gridSize ?? 256;
    const raw = new Uint8Array(terrain.rawData);
    const bytesPerCell = terrain.rawBytesPerCell ?? 1;
    const values = new Float32Array(gridSize * gridSize);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < values.length; i++) {
      const v = bytesPerCell === 2
        ? (raw[i * 2] | (raw[i * 2 + 1] << 8))
        : raw[i];
      values[i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const scale = max > min ? 255 / (max - min) : 1;
    const image = new ImageData(gridSize, gridSize);
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const src = x + y * gridSize;
        const dstY = gridSize - 1 - y;
        const dst = (x + dstY * gridSize) * 4;
        const g = Math.max(0, Math.min(255, Math.round((values[src] - min) * scale)));
        image.data[dst] = image.data[dst + 1] = image.data[dst + 2] = g;
        image.data[dst + 3] = 255;
      }
    }
    this.mapBitmap = image;
    this.mapCanvas = document.createElement("canvas");
    this.mapCanvas.width = gridSize;
    this.mapCanvas.height = gridSize;
    this.mapCanvas.getContext("2d").putImageData(image, 0, 0);
  }

  draw() {
    if (!this.canvas || !this.mapBitmap) return;
    const ctx = this.canvas.getContext("2d");
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.mapCanvas, 0, 0, w, h);

    const nav = this.nav;
    const terrain = this.track?.terrain;
    if (!nav || !terrain) return;
    const worldSize = (terrain.gridSize ?? 256) * (terrain.cellSize ?? 64);
    const x = Math.max(0, Math.min(w, (nav.position.x / worldSize) * w));
    const y = Math.max(0, Math.min(h, (nav.position.z / worldSize) * h));
    const yaw = (nav.yaw ?? 0) * Math.PI / 180;
    const fx = Math.sin(yaw);
    const fy = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const ry = Math.sin(yaw);
    const size = 9;

    ctx.beginPath();
    ctx.moveTo(x + fx * size, y + fy * size);
    ctx.lineTo(x - fx * size * 0.65 - rx * size * 0.55, y - fy * size * 0.65 - ry * size * 0.55);
    ctx.lineTo(x - fx * size * 0.65 + rx * size * 0.55, y - fy * size * 0.65 + ry * size * 0.55);
    ctx.closePath();
    ctx.fillStyle = "#ffdd40";
    ctx.strokeStyle = "#171717";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fill();
  }
}
