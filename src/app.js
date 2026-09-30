import { TrackScene } from "./scene.js";
import { WorkerClient } from "./worker-client.js";
import { removePath, resetSessionFolder, writeBytesToFile } from "./shared/opfs.js";
import { extractFirstPodFromZipBytes, extractPodsFromZipBytes } from "./zip-utils.js";
import { UNITS_PER_FOOT_H } from "./drive/world-frame.js";
import { flySetsFromFolder } from "./fly-folder.js";

const APP_TITLE = "JSTrackViewer";
const DRIVE_CONTROLS = "↑/W Throttle · ↓/S Brake · ←→/A D Steer · Space Handbrake · M Manual (A/Z Shift) · L Lights · V Camera · R Reset";
// Every track POD of the open archive; a ZIP can carry several. See _storePodsAndIndex.
const TRACK_OPFS_DIR = "track-viewer/tracks";
// Track and truck archives have separate OPFS paths and separate indexes in the worker.
const TRUCK_OPFS_PATH = "track-viewer/truck.pod";
const WORKER_URL = new URL("./worker/track-worker.js", import.meta.url);

export class TrackViewerApp {
  constructor() {
    this._worker = null;
    this._scene = null;
    // One entry per track across every open POD: { archive, index (within it), name, fileName }.
    this._choices = [];
    // The open PODs: { filename, opfsPath, source }. The worker indexes one at a time.
    this._archives = [];
    this._indexedArchive = null;
    this._podSource = "—";
    this._truckChoices = [];
    this._truckAssembly = null;
    this._truckAssemblyName = null;
    this._driveRequestId = 0;
    // Traxx ALTITUDESCALE = 3 (Traxx/TraxxView.h:43). Terrain and object heights both
    // derive from it, so anything else renders the whole track vertically exaggerated.
    this._heightScale = 3;
    this._renderFlags = {
      terrain: true, textures: true, grid: false,
      objects: true, gboxes: true,
      cboxes: false, water: true, backdrop: true, sunlight: true, shadows: true,
      wireframe: false, trucks: true, billboards: true, checkpoints: false,
      navpoints: true, cpmarkers: true, tunnels: true, powerups: true, animate: true,
      racetrack: true, underground: true, terrainOverlap: true, lensflare: true,
      sky: true, fog: true, movingObjects: true,
    };
  }

  mount(doc) {
    this._doc = doc;
    this._viewerControls = doc.getElementById("nav-hint").textContent.trim();

    // Init worker
    this._worker = new WorkerClient(WORKER_URL.href);

    // Init scene
    const viewport = doc.getElementById("viewport");
    this._scene = new TrackScene(viewport);
    const smoothTexturesToggle = doc.getElementById("tog-smooth-textures");
    smoothTexturesToggle.addEventListener("change", () => {
      this._scene.setTextureSmoothingEnabled(smoothTexturesToggle.checked);
    });
    this._scene.setTextureSmoothingEnabled(smoothTexturesToggle.checked);
    this._minimap = new Minimap(doc.getElementById("minimap"), doc.getElementById("minimap-panel"), (x, z) => {
      this._scene.nav?.moveToWorldPosition(x, z);
    }, (x, z) => {
      // Double-click while driving: put the truck there. The map is in scene units.
      if (this._scene.drive?.isActive) this._scene.drive.teleport(x / UNITS_PER_FOOT_H, z / UNITS_PER_FOOT_H);
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

    // Open from URL: a dialog, since it has a warning to carry about CORS.
    const urlModal = doc.getElementById("url-modal");
    const urlInput = doc.getElementById("url-input");
    const hideUrlModal = () => {
      if (urlModal.hidden) return;
      urlModal.hidden = true;
      doc.getElementById("viewport")?.focus();
    };
    doc.getElementById("open-url-btn").addEventListener("click", () => {
      urlModal.hidden = false;
      urlInput.focus();
      urlInput.select();
    });
    doc.getElementById("url-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const url = urlInput.value.trim();
      if (!url) return;
      hideUrlModal();
      this._loadFromUrl(url);
    });
    doc.getElementById("url-modal-close").addEventListener("click", hideUrlModal);
    doc.getElementById("url-modal-cancel").addEventListener("click", hideUrlModal);
    urlModal.addEventListener("click", (e) => {
      if (e.target === urlModal) hideUrlModal();
    });
    doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideUrlModal();
    });

    // Open from Folder: a Fly! scenery folder, the one holding its .SCF.
    const folderInput = doc.getElementById("folder-input");
    doc.getElementById("open-folder-btn").addEventListener("click", () => folderInput.click());
    folderInput.addEventListener("change", (e) => {
      const files = [...(e.target.files ?? [])];
      if (files.length) this._loadFromFolder(files);
      folderInput.value = "";
    });

    // Clear temp
    doc.getElementById("clear-temp-btn").addEventListener("click", async () => {
      this._stopDrivingForChange();
      await resetSessionFolder("track-viewer");
      this._scene.clearTrack();
      this._setStatus("Temp cleared.");
      this._choices = [];
      this._archives = [];
      this._indexedArchive = null;
      this._hideTrackPicker();
      this._hideTrackModal();
      this._clearTrackInfo();
    });

    // Track picker
    doc.getElementById("load-track-btn").addEventListener("click", () => {
      const idx = parseInt(doc.getElementById("track-select").value, 10);
      if (!isNaN(idx)) this._loadTrackChoice(idx);
    });

    // The track chooser over the viewport; the top bar picker stays for switching later.
    doc.getElementById("track-modal-close").addEventListener("click", () => this._hideTrackModal());
    doc.getElementById("track-modal").addEventListener("click", (e) => {
      if (e.target.id === "track-modal") this._hideTrackModal();
    });
    doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !doc.getElementById("track-modal").hidden) this._hideTrackModal();
    });

    // Test Drive: a truck comes from its own POD, so it has its own file input.
    const truckInput = doc.getElementById("truck-file-input");
    doc.getElementById("open-truck-btn").addEventListener("click", () => truckInput.click());
    truckInput.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) this._loadTruckFromFile(file);
      truckInput.value = "";
    });
    doc.getElementById("truck-select").addEventListener("change", () => this._selectTruck());
    doc.getElementById("drive-btn").addEventListener("click", () => this._toggleDrive());

    /*
      How courses are drawn: Smooth (the corners rounded off as a truck drives them), Joined
      (the runs as stored, joined straight) or Traxx (each segment on its own and numbered, as
      the track editor shows it). Remembered per browser.
    */
    const courseStyle = doc.getElementById("course-style-select");
    try {
      const saved = localStorage.getItem("jstv.courseStyle");
      if (saved && [...courseStyle.options].some((o) => o.value === saved)) courseStyle.value = saved;
    } catch { /* ignore */ }
    courseStyle.addEventListener("change", () => {
      this._scene.setCourseStyle(courseStyle.value);
      try { localStorage.setItem("jstv.courseStyle", courseStyle.value); } catch { /* ignore */ }
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
      "tog-terrain-overlap": "terrainOverlap",
      "tog-grid":      "grid",
      "tog-objects":   "objects",
      "tog-billboards": "billboards",
      "tog-checkpoints":"checkpoints",
      "tog-gboxes":    "gboxes",
      "tog-cboxes":    "cboxes",
      "tog-racetrack": "racetrack",
      "tog-underground": "underground",
      "tog-water":     "water",
      "tog-backdrop":  "backdrop",
      "tog-sky":       "sky",
      "tog-fog":       "fog",
      "tog-sunlight":  "sunlight",
      "tog-shadows":   "shadows",
      "tog-lensflare": "lensflare",
      "tog-wireframe": "wireframe",
      "tog-trucks":    "trucks",
      "tog-navpoints": "navpoints",
      "tog-cpmarkers": "cpmarkers",
      "tog-tunnels":   "tunnels",
      "tog-powerups":  "powerups",
      "tog-animate":   "animate",
      "tog-moving":    "movingObjects",
      // Lives in the Test Drive panel rather than View Options: it shows what the simulation
      // collides with, which only means anything while driving.
      "tog-hitboxes":  "hitboxes",
    };
    this._toggleMap = toggleMap;
    for (const [id, flag] of Object.entries(toggleMap)) {
      const el = doc.getElementById(id);
      if (!el) continue;
      el.addEventListener("change", () => {
        this._renderFlags[flag] = el.checked;
        this._scene.setRenderFlags(this._renderFlags);
      });
    }

    /*
      Every sidebar panel folds from its own heading, except the minimap: that one is a control
      rather than a readout, and collapsing what you navigate with helps nobody.
    */
    for (const panel of doc.querySelectorAll(".sidebar .panel")) {
      if (panel.id === "minimap-panel") continue;
      const heading = panel.querySelector("h2");
      if (!heading) continue;
      heading.classList.add("collapsible");
      heading.setAttribute("role", "button");
      heading.setAttribute("tabindex", "0");
      const toggle = () => {
        const collapsed = panel.classList.toggle("collapsed");
        heading.setAttribute("aria-expanded", collapsed ? "false" : "true");
      };
      heading.setAttribute("aria-expanded", panel.classList.contains("collapsed") ? "false" : "true");
      heading.addEventListener("click", toggle);
      heading.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    }

    // Sliders
    /*
      Fly speed for the arrow keys and A/Z, as a percentage of the camera's full rate. The
      full rate crosses a whole track in about five seconds, which is too fast to look at
      anything, so the default is a quarter of it. The choice is remembered per browser.
    */
    const speedSlider = doc.getElementById("nav-speed-slider");
    const speedLabel  = doc.getElementById("nav-speed-value");
    try {
      const saved = localStorage.getItem("jstv.navSpeed");
      if (saved !== null && !Number.isNaN(parseInt(saved, 10))) speedSlider.value = saved;
    } catch { /* storage unavailable: keep the default */ }
    const applyNavSpeed = () => {
      const v = parseInt(speedSlider.value, 10);
      speedLabel.textContent = `${v}%`;
      this._scene.nav?.setSpeedFactor(v / 100);
      try { localStorage.setItem("jstv.navSpeed", String(v)); } catch { /* ignore */ }
    };
    speedSlider.addEventListener("input", applyNavSpeed);
    applyNavSpeed();

    const gridSlider = doc.getElementById("grid-span-slider");
    const gridLabel  = doc.getElementById("grid-span-value");
    gridSlider.addEventListener("input", () => {
      const v = parseInt(gridSlider.value, 10);
      gridLabel.textContent = v;
      this._scene.setViewDistance(v);
    });
    // Apply initial value
    this._scene.setViewDistance(parseInt(gridSlider.value, 10));

    /*
      Weather, for the games that have it (see TrackScene.weatherApplies). The choice is kept
      across track loads and visits.
    */
    const weatherSelect = doc.getElementById("weather-select");
    try {
      const saved = localStorage.getItem("jstv.weather");
      if (saved && [...weatherSelect.options].some((o) => o.value === saved)) weatherSelect.value = saved;
    } catch { /* ignore */ }
    weatherSelect.addEventListener("change", () => {
      this._applyWeather();
      try { localStorage.setItem("jstv.weather", weatherSelect.value); } catch { /* ignore */ }
    });

    /*
      Sky style, beside the weather: the weather's sky photograph, the plain gradient MTM1 and
      MTM2 draw with their textured sky off, or MTM1's own flat sky. Remembered like the
      weather; Classic is only offered on an MTM1 track and reads as Textured elsewhere.
    */
    const skyStyleSelect = doc.getElementById("sky-style-select");
    try {
      const saved = localStorage.getItem("jstv.skyStyle");
      if (saved && [...skyStyleSelect.options].some((o) => o.value === saved)) this._skyStyle = saved;
    } catch { /* ignore */ }
    this._skyStyle ??= "textured";
    skyStyleSelect.value = this._skyStyle;
    skyStyleSelect.addEventListener("change", () => {
      this._skyStyle = skyStyleSelect.value;
      this._applyWeather();
      try { localStorage.setItem("jstv.skyStyle", this._skyStyle); } catch { /* ignore */ }
    });

    const sunSlider = doc.getElementById("sun-intensity-slider");
    const sunLabel  = doc.getElementById("sun-intensity-value");
    sunSlider.addEventListener("input", () => {
      const v = parseInt(sunSlider.value, 10) / 10;
      sunLabel.textContent = v.toFixed(1);
      this._scene.setSunIntensity(v);
    });
    this._scene.setSunIntensity(parseInt(sunSlider.value, 10) / 10);

    /*
      Sun position. The two sliders are a compass bearing and a height above the horizon,
      because that is how you think about where the sun is; the scene converts them into the
      light vector these levels actually store. See TrackScene.setSunAngles.
    */
    const azimuthSlider = doc.getElementById("sun-azimuth-slider");
    const elevationSlider = doc.getElementById("sun-elevation-slider");
    const applySunAngles = () => {
      this._scene.setSunAngles(
        parseInt(azimuthSlider.value, 10), parseInt(elevationSlider.value, 10));
    };
    azimuthSlider.addEventListener("input", applySunAngles);
    elevationSlider.addEventListener("input", applySunAngles);
    doc.getElementById("reset-sun-btn").addEventListener("click", () => this._scene.restoreTrackSun());
    // The scene is the one that knows where the sun ended up, whether a slider or a track put
    // it there, so the panel follows it rather than the other way round.
    this._scene.setSunChangeCallback((angles) => this._updateSunPanel(angles));

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

    // A converter or test harness can hand the viewer a same-origin POD URL directly. Blob
    // URLs work too, provided their creating page remains open.
    const initialPodUrl = new URLSearchParams(window.location.search).get("pod");
    if (initialPodUrl) {
      doc.getElementById("url-input").value = initialPodUrl;
      queueMicrotask(() => this._loadFromUrl(initialPodUrl));
    }

    /*
      The converter hands its result over by message rather than by URL.

      A blob: URL only resolves while the page that minted it lives and only in a context the
      browser agrees shares its storage, which is exactly the case that failed for people
      running the converter somewhere other than beside this viewer. A Blob posted between
      windows has neither condition. It also lets the converter push each new conversion into
      the SAME viewer tab, so convert, look, adjust and convert again needs no download.

      Only the window that opened this one is listened to. Its origin is not checked: a POD it
      posts can do nothing that `?pod=<any url>` cannot already do, and the converter may well
      be served from somewhere other than this viewer.
    */
    window.addEventListener("message", (event) => {
      if (event.source !== window.opener || event.data?.type !== "jstrackviewer:pod") return;
      const { blob, name } = event.data;
      if (blob instanceof Blob) this._loadFromFile(new File([blob], name || "converted.pod"), "Converter");
    });
    if (window.opener && new URLSearchParams(window.location.search).has("handoff")) {
      // Carries no data, so it can go to any origin; the converter matches it by window.
      window.opener.postMessage({ type: "jstrackviewer:ready" }, "*");
    }
  }

  async _loadFromFile(file, source = "Local file") {
    this._stopDrivingForChange();
    this._setStatus(`Reading ${file.name}…`);
    this._showLoading(`Reading ${file.name}…`);
    try {
      const buffer = await file.arrayBuffer();
      const staged = await this._podsFromContainer(new Uint8Array(buffer), file.name, source);
      await this._storePodsAndIndex(staged);
    } catch (err) {
      this._showError(`Error: ${err.message}`);
      this._updateTruckButtons();
    } finally {
      this._hideLoading();
    }
  }

  async _loadFromUrl(url) {
    this._stopDrivingForChange();
    this._setStatus(`Fetching…`);
    this._showLoading("Fetching from URL…");
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const buffer = await resp.arrayBuffer();
      const name = nameFromUrl(url);
      const staged = await this._podsFromContainer(new Uint8Array(buffer), name, "URL");
      await this._storePodsAndIndex(staged);
    } catch (err) {
      this._showError(`Error: ${err.message}`);
      this._updateTruckButtons();
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

  /*
    Every POD an opened file holds: the file itself, or each .POD inside a ZIP.

    @returns {{ pods: {bytes, filename}[], source: string, container: string }}
  */
  async _podsFromContainer(bytes, filename, sourcePrefix = "Local file") {
    if (!isZipName(filename)) {
      return { pods: [{ bytes, filename }], source: sourcePrefix, container: filename };
    }
    this._setStatus("Extracting PODs from ZIP…");
    this._showLoading("Extracting PODs from ZIP…");
    const pods = await extractPodsFromZipBytes(bytes, filename);
    return {
      pods: pods.map(({ podBytes, podEntryName }) => ({
        bytes: podBytes, filename: podNameFromZipEntry(filename, podEntryName),
      })),
      source: sourcePrefix === "URL" ? `URL ZIP: ${filename}` : `ZIP: ${filename}`,
      container: filename,
    };
  }

  /*
    Store each POD, list the tracks in every one of them, and offer them all.

    The worker holds one indexed POD at a time, so each is indexed in turn to list its tracks,
    and indexed again when a track from it is loaded (see _loadTrackChoice). Indexing reads only
    the directory, so switching between the PODs of a pack costs next to nothing. A POD with no
    track in it, a truck or a sound pack riding along in the ZIP, is simply left out.
  */
  async _storePodsAndIndex({ pods, source, container }) {
    this._setStatus("Writing to temp storage…");
    await resetSessionFolder("track-viewer");
    await removePath(TRACK_OPFS_DIR);
    this._scene.clearTrack();
    this._clearTrackInfo();
    this._hideTrackPicker();
    this._hideTrackModal();
    this._archives = [];
    this._choices = [];
    this._indexedArchive = null;
    const notes = [];

    for (let i = 0; i < pods.length; i++) {
      const { bytes, filename } = pods[i];
      const opfsPath = `${TRACK_OPFS_DIR}/pod-${i}.pod`;
      await writeBytesToFile(opfsPath, bytes);
      this._setStatus(`Indexing ${filename}…`);
      const archive = {
        filename, opfsPath,
        source: pods.length > 1 ? `${source} / ${filename}` : source,
      };
      const { entryCount } = await this._worker.call("indexPod", { opfsPodPath: opfsPath });
      this._indexedArchive = archive;
      const { choices, note } = await this._worker.call("listTrackChoices", {});
      this._setStatus(`${filename}: ${entryCount} entries, ${choices.length} track(s).`);
      if (note) notes.push(note);
      if (!choices.length) continue;
      this._archives.push(archive);
      for (const choice of choices) {
        this._choices.push({ archive, index: choice.index, name: choice.name, fileName: choice.fileName ?? "" });
      }
    }

    if (this._choices.length === 0) {
      const message = notes[0] ?? `No tracks found in ${container}.`;
      this._setStatus(message);
      throw new Error(message);
    }

    this._populateTrackPicker();

    if (this._choices.length === 1) {
      await this._loadTrackChoice(0);
    } else {
      this._setStatus(`Found ${this._choices.length} tracks. Choose one to load.`);
      this._showTrackModal(container);
    }
  }

  async _loadTrackChoice(choiceIndex) {
    this._lastChoiceIndex = choiceIndex;
    const choice = this._choices[choiceIndex];
    if (!choice) return;
    this._hideTrackModal();
    this._doc.getElementById("track-select").value = String(choiceIndex);

    this._stopDrivingForChange();
    this._setStatus(`Loading "${choice.name}"…`);
    this._showLoading(`Loading ${choice.name}…`);
    try {
      let result;
      if (choice.flySet) {
        // Handed to the worker as Files: a city is 50 to 150 MB, not worth copying anywhere.
        const set = choice.flySet;
        this._podSource = `Folder: ${set.directory}`;
        result = await this._worker.call("loadFly", {
          archives: set.archives.map((file) => ({ blob: file, name: file.name })),
          name: set.name,
          coverage: set.coverage,
        });
        if (set.missing.length) result.warnings.unshift(`${set.scfName} lists files not in the folder: ${set.missing.join(", ")}.`);
      } else {
        if (this._indexedArchive !== choice.archive) {
          await this._worker.call("indexPod", { opfsPodPath: choice.archive.opfsPath });
          this._indexedArchive = choice.archive;
        }
        this._podSource = choice.archive.source ?? "—";
        result = await this._worker.call("loadTrack", {
          choiceIndex: choice.index,
          heightScale: this._heightScale,
        });
      }
      this._presentTrack(result, choice.name);
    } catch (err) {
      this._showError(`Error loading track: ${err.message}`);
      console.error(err);
    } finally {
      this._updateTruckButtons();
      this._hideLoading();
    }
  }

  /*
    Open from Folder. Every Fly! scenery set under the folder becomes a choice, so picking the
    Scenery folder itself offers all five cities. Nothing is copied: the Files go straight to
    the worker, which reads only what it draws.
  */
  async _loadFromFolder(files) {
    this._stopDrivingForChange();
    this._setStatus("Looking for Fly! scenery…");
    try {
      const { folder, sets } = await flySetsFromFolder(files);
      if (!sets.length) {
        throw new Error(`No Fly! scenery in ${folder || "that folder"}: pick the folder holding a city's .SCF, such as Scenery/SANFRAN.`);
      }
      this._scene.clearTrack();
      this._clearTrackInfo();
      this._hideTrackPicker();
      this._hideTrackModal();
      const archive = { filename: folder, source: `Folder: ${folder}` };
      this._archives = [archive];
      this._indexedArchive = null;
      this._choices = sets.map((set) => ({
        archive,
        index: 0,
        name: set.name,
        fileName: set.directory,
        flySet: set,
      }));
      this._populateTrackPicker();
      if (sets.length === 1) {
        await this._loadTrackChoice(0);
      } else {
        this._setStatus(`Found ${sets.length} Fly! scenery sets. Choose one to load.`);
        this._showTrackModal(folder);
      }
    } catch (err) {
      this._showError(`Error: ${err.message}`);
      this._updateTruckButtons();
    }
  }

  /** Put a loaded result on screen: the scene, the minimap, the panels and the title. */
  _presentTrack(result, fallbackName) {
    const name = result.trackName || fallbackName;
    this._renderFlags.checkpoints = !["MTM1", "MTM2", "EVO1", "EVO2", "CPR"].includes(result.origin);
    this._doc.getElementById("tog-checkpoints").checked = this._renderFlags.checkpoints;
    // The 2px terrain overlap hides seams on MTM2 and Evo's tile sets, and only blurs the
    // others' (MTM1, CPR, TV, Fury3, Hellbender), so it starts on per game. Still a toggle.
    this._renderFlags.terrainOverlap = ["MTM2", "EVO1", "EVO2"].includes(result.origin);
    this._doc.getElementById("tog-terrain-overlap").checked = this._renderFlags.terrainOverlap;
    this._scene.setTrack(result, this._renderFlags, this._heightScale);
    this._doc.getElementById("sidebar").classList.remove("no-track");
    // Fly! scenery is a flight world with no truck physics behind it.
    if (this._truckAssembly && result.origin !== "FLY") {
      this._scene.setDriveTruck(this._truckAssembly);
    }
    this._minimap.setTrack(result);
    this._minimap.updateCamera(this._scene.nav);
    this._updateTrackInfo(result);
    this._applyLayerAvailability(this._scene.layerPresence());
    this._buildCourseToggles();
    this._applyWeather();
    this._setStatus(name);
    this._setDocumentTitle(name, result.origin);
    for (const warning of result.warnings ?? []) console.warn(warning);
    // Focus viewport after load
    this._doc.getElementById("viewport")?.focus();
  }

  _stopDrivingForChange() {
    const wasDriving = this._scene.drive?.isActive;
    this._driveRequestId++;
    this._scene.stopDrive();
    this._renderFlags.hitboxes = false;
    this._setDrivingUi(false);
    this._doc.getElementById("drive-btn").disabled = true;
    if (wasDriving) this._setTruckInfo("Status", "Drive stopped. Truck remains loaded.");
  }

  _setDrivingUi(driving) {
    if (!driving) this._minimap?.updateTruck(null);
    // A different truck POD needs a stop first; the trucks in the open one switch in place.
    this._doc.getElementById("open-truck-btn").disabled = driving;
    this._doc.getElementById("drive-btn").textContent = driving ? "Stop test drive" : "Drive";
    this._doc.getElementById("nav-hint").textContent = driving ? DRIVE_CONTROLS : this._viewerControls;
    const hitboxes = this._doc.getElementById("tog-hitboxes");
    hitboxes.disabled = !driving;
    if (!driving) hitboxes.checked = false;
  }

  _updateTruckButtons() {
    // Drive and its hitbox overlay mean nothing until a truck POD is open, so they are not
    // shown at all before then; with a truck but no track, Drive shows but stays disabled.
    const hasTruck = !!(this._truckChoices.length || this._truckAssembly);
    const ready = !!(this._scene._trackData && hasTruck && this._scene._trackData.origin !== "FLY");
    const drive = this._doc.getElementById("drive-btn");
    drive.hidden = !hasTruck;
    drive.disabled = !ready;
    this._doc.getElementById("hitboxes-row").hidden = !hasTruck;
  }

  async _loadTruckFromFile(file) {
    this._stopDrivingForChange();
    this._showLoading(`Reading ${file.name}…`);
    try {
      const buffer = await file.arrayBuffer();
      const staged = await this._podBytesFromContainer(new Uint8Array(buffer), file.name, "Local file");
      // Deliberately no resetSessionFolder here; see TRUCK_OPFS_PATH.
      await writeBytesToFile(TRUCK_OPFS_PATH, staged.bytes);

      const { trucks } = await this._worker.call("indexTruckPod", { opfsPodPath: TRUCK_OPFS_PATH });
      this._truckChoices = trucks ?? [];
      this._truckAssembly = null;
      this._truckAssemblyName = null;
      this._scene.setDriveTruck(null);
      this._populateTruckPicker();
      if (!this._truckChoices.length) {
        this._setTruckInfo("Status", `${staged.filename} contains no TRUCK/*.TRK.`);
        return;
      }
      this._setTruckInfo("Status", `${this._truckChoices.length} truck${this._truckChoices.length === 1 ? "" : "s"} found. Click Drive to load one.`);
    } catch (err) {
      this._showError(`Error loading truck: ${err.message}`);
      console.error(err);
    } finally {
      this._updateTruckButtons();
      this._hideLoading();
    }
  }

  _populateTruckPicker() {
    const row = this._doc.getElementById("truck-picker-row");
    const select = this._doc.getElementById("truck-select");
    select.innerHTML = "";
    this._truckChoices.forEach((truck, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = truck.name || truck.title;
      select.appendChild(opt);
    });
    row.hidden = this._truckChoices.length === 0;
  }

  _selectTruck() {
    const index = parseInt(this._doc.getElementById("truck-select").value, 10) || 0;
    const choice = this._truckChoices[index];
    if (!choice) return;

    if (this._scene.drive?.isActive) {
      if (choice.normalizedName !== this._truckAssemblyName) this._swapTruckWhileDriving(choice);
      return;
    }
    if (choice.normalizedName !== this._truckAssemblyName) {
      this._truckAssembly = null;
      this._truckAssemblyName = null;
      this._scene.setDriveTruck(null);
    }
    this._setTruckInfo("Status", `${choice.name}. Click Drive to start.`);
    this._updateTruckButtons();
  }

  /*
    Picking another truck mid-drive swaps it in where the old one was.

    The new truck is a different body, so drive mode restarts with it, but it starts from the
    old truck's position, heading and velocity, keeps the gearbox mode and the camera view,
    and the driver never has to press Drive. The old truck keeps driving while the new one
    loads. A lap in progress restarts, since a different truck is not the same attempt.
  */
  async _swapTruckWhileDriving(choice) {
    const trackData = this._scene._trackData;
    const old = this._scene.drive;
    if (!trackData || !old) return;
    const state = old.sim.readState();
    const velocity = { ...old.sim.state.vel };
    const manual = old.sim.manual;
    const lightsOn = old.lightsOn;
    const viewId = old.cameras.view?.id;

    const requestId = ++this._driveRequestId;
    try {
      const assembly = await this._ensureSelectedTruck(requestId, trackData);
      if (!assembly || requestId !== this._driveRequestId || trackData !== this._scene._trackData) return;
      const drive = await this._scene.startDrive(trackData, assembly,
        (status) => this._showDriveStatus(status),
        (pose) => this._minimap.updateTruck(pose));
      if (!drive || requestId !== this._driveRequestId) return;
      drive.placeAt(state.ipos.x, state.ipos.z, state.psi ?? 0);
      drive.sim.state.vel = velocity;
      drive.setManual(manual);
      drive.setLights(lightsOn);
      if (viewId) drive.cameras.select(viewId);
      this._setDrivingUi(true);
      this._doc.getElementById("viewport")?.focus();
    } catch (err) {
      if (requestId === this._driveRequestId) {
        this._showError(`Error switching truck: ${err.message}`);
        console.error(err);
      }
    } finally {
      if (requestId === this._driveRequestId) {
        this._hideLoading();
        this._updateTruckButtons();
      }
    }
  }

  async _ensureSelectedTruck(requestId, trackData) {
    const index = parseInt(this._doc.getElementById("truck-select").value, 10) || 0;
    const choice = this._truckChoices[index];
    if (!choice) return null;
    if (this._truckAssembly && this._truckAssemblyName === choice.normalizedName) {
      if (!this._scene.driveTruck) this._scene.setDriveTruck(this._truckAssembly);
      return this._truckAssembly;
    }

    this._showLoading(`Assembling ${choice.name}…`);
    const assembly = await this._worker.call("loadTruck", { normalizedName: choice.normalizedName });
    if (requestId !== this._driveRequestId || trackData !== this._scene._trackData) return null;
    this._truckAssembly = assembly;
    this._truckAssemblyName = choice.normalizedName;
    this._scene.setDriveTruck(assembly);
    if (assembly.warnings?.length) console.warn("[JSTrackViewer] truck:", assembly.warnings);
    return assembly;
  }

  async _toggleDrive() {
    const button = this._doc.getElementById("drive-btn");
    const trackData = this._scene?._trackData;
    if (!trackData || (!this._truckChoices.length && !this._truckAssembly)) return;

    if (this._scene.drive?.isActive) {
      this._scene.stopDrive();
      this._renderFlags.hitboxes = false;
      this._setDrivingUi(false);
      this._setTruckInfo("Status", "Parked. The fly camera has the controls again.");
      return;
    }

    const requestId = ++this._driveRequestId;
    button.disabled = true;
    try {
      const assembly = await this._ensureSelectedTruck(requestId, trackData);
      if (!assembly || requestId !== this._driveRequestId || trackData !== this._scene._trackData) return;
      const drive = await this._scene.startDrive(trackData, assembly,
        (status) => this._showDriveStatus(status),
        (pose) => this._minimap.updateTruck(pose));
      if (!drive || requestId !== this._driveRequestId) return;
      this._setDrivingUi(true);
      this._doc.getElementById("viewport")?.focus();
    } catch (err) {
      if (requestId === this._driveRequestId) {
        this._showError(`Error starting test drive: ${err.message}`);
        console.error(err);
      }
    } finally {
      if (requestId === this._driveRequestId) {
        this._hideLoading();
        this._updateTruckButtons();
      }
    }
  }

  /*
    The driving readout. Arrow keys drive, so this also says where the keys went: a viewer
    whose arrow keys suddenly stop panning the camera needs to be told why.
  */
  _showDriveStatus(status) {
    const dl = this._doc.getElementById("truck-info");
    if (!dl) return;
    const rows = [];
    // status.speed is mph; 1 mph is exactly 1.609344 km/h.
    if (status.speed !== undefined) {
      rows.push(["Speed", `${status.speed.toFixed(0)} mph / ${(status.speed * 1.609344).toFixed(0)} km/h`]);
    }
    if (status.gear !== undefined) {
      const gear = status.gear < 0 ? "R" : String(status.gear);
      rows.push(["Gear", status.airborne ? `${gear} (airborne)` : gear]);
    }
    if (status.manual !== undefined) rows.push(["Gearbox", status.manual ? "Manual (A/Z shift)" : "Automatic"]);
    if (status.lights !== undefined && status.lights !== null) rows.push(["Lights", status.lights ? "On (L)" : "Off (L)"]);
    if (status.rpm !== undefined) rows.push(["Engine", `${status.rpm.toFixed(0)} rpm`]);
    // The ground type under the tires (the track's .TTY); absent in the air.
    if (status.surface !== undefined) rows.push(["Surface", status.surface ?? "Airborne"]);
    if (status.view) rows.push(["View", status.view]);

    /*
      Race rows only appear on a track that has checkpoints. A drag strip or a stadium has
      none, and showing "Lap 0" with a gate count of zero would be stating something the
      track does not have.
    */
    const race = status.race;
    if (race?.gateCount) {
      const clock = (seconds) => {
        const m = Math.floor(seconds / 60);
        const s = seconds - m * 60;
        return m > 0 ? `${m}:${s.toFixed(2).padStart(5, "0")}` : `${s.toFixed(2)}s`;
      };
      rows.push(["Lap", String(race.lap)]);
      rows.push(["Checkpoint", `${race.next + 1} of ${race.gateCount}`]);
      rows.push(["Lap time", clock(race.lapTime)]);
      if (race.bestLap !== null) rows.push(["Best lap", clock(race.bestLap)]);
    }
    if (!rows.length) return;
    dl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  }

  _setTruckInfo(label, value) {
    const dl = this._doc.getElementById("truck-info");
    if (!dl) return;
    dl.innerHTML = `<dt>${label}</dt><dd>${value}</dd>`;
  }

  /** The top bar picker, grouped by POD when the archive held more than one. */
  _populateTrackPicker() {
    const panel = this._doc.getElementById("track-picker-panel");
    const select = this._doc.getElementById("track-select");
    select.replaceChildren();
    const grouped = this._archives.length > 1;
    let group = null;
    this._choices.forEach((choice, i) => {
      if (grouped && group?.label !== choice.archive.filename) {
        group = this._doc.createElement("optgroup");
        group.label = choice.archive.filename;
        select.appendChild(group);
      }
      const opt = this._doc.createElement("option");
      opt.value = i;
      opt.textContent = choice.name || `Track ${i + 1}`;
      (group ?? select).appendChild(opt);
    });
    panel.hidden = this._choices.length < 2;
  }

  _hideTrackPicker() {
    this._doc.getElementById("track-picker-panel").hidden = true;
    this._doc.getElementById("track-select").replaceChildren();
  }

  /*
    The track chooser over the viewport, for an archive with more than one track: every track
    of every POD, under its POD's name when there are several, with the file it comes from.
  */
  _showTrackModal(container) {
    const list = this._doc.getElementById("track-modal-list");
    list.replaceChildren();
    const grouped = this._archives.length > 1;
    let heading = null;
    const scenery = this._choices.every((choice) => choice.flySet);
    this._doc.getElementById("track-modal-title").textContent = scenery ? "Choose a scenery set" : "Choose a track";
    this._doc.getElementById("track-modal-source").textContent = scenery
      ? `${container} holds ${this._choices.length} Fly! scenery sets.`
      : grouped
        ? `${container} holds ${this._archives.length} PODs with ${this._choices.length} tracks.`
        : `${container} holds ${this._choices.length} tracks.`;
    this._choices.forEach((choice, i) => {
      if (grouped && heading !== choice.archive.filename) {
        heading = choice.archive.filename;
        const h = this._doc.createElement("h3");
        h.textContent = heading;
        list.appendChild(h);
      }
      const button = this._doc.createElement("button");
      button.type = "button";
      const name = this._doc.createElement("span");
      name.textContent = choice.name || `Track ${i + 1}`;
      const file = this._doc.createElement("span");
      file.textContent = choice.fileName;
      button.append(name, file);
      button.addEventListener("click", () => this._loadTrackChoice(i));
      list.appendChild(button);
    });
    this._doc.getElementById("track-modal").hidden = false;
    list.querySelector("button")?.focus();
  }

  _hideTrackModal() {
    const modal = this._doc.getElementById("track-modal");
    if (modal.hidden) return;
    modal.hidden = true;
    this._doc.getElementById("viewport")?.focus();
  }

  /*
    Track Data, carrying only the fields the track's own file has.

    Every row below except the first four is a field some of these games write and others do
    not, and a row printed for a field the file never carried is a claim about the track: a
    CPR .SIT has no ambient sound or weather mask, an MTM 1 one has neither of those nor a
    water height, and a TV-family .LVL header has none of the four. Those used to be reported
    as slot 0 in clear weather with no water, which is the parser's defaults being read back
    as if they were data.

    So a field is shown when the file states it and omitted when it does not. "None" and 0
    still appear where the file really says so - `!waterHeight 0` is a track with no water,
    which is not the same as a track that cannot have any.
  */
  _updateTrackInfo(data) {
    const dl = this._doc.getElementById("track-info");
    const background = displayBackgroundModel(data);
    const pairs = [
      ["File",         data.fileName || "—"],
      ["Origin",       this._podSource],
      ["Name",         data.trackName || "—"],
      ["Game",         data.origin || "—"],
    ];
    if (data.localeName) pairs.push(["Locale", data.localeName]);
    /*
      A Hellbender level's .TXT states where it is and what the mission is, which is what it
      has instead of the "Race Track Locale" and race type every other game writes. The label
      is the file's own - PLANET, AREA, LOCATION and OBJECTIVE all occur - so it is shown as
      authored. See hb-briefing.js.
    */
    if (data.briefing?.heading) {
      pairs.push([data.briefing.headingLabel ?? "Location", data.briefing.heading]);
    }
    if (data.briefing?.mission) {
      pairs.push([data.briefing.missionLabel ?? "Mission", data.briefing.mission]);
    }
    if (data.trackType && data.trackType !== "UNKNOWN") pairs.push(["Type", data.trackType]);
    if (background !== "—") pairs.push(["Background", background]);
    if (data.musicName) pairs.push(["Music", displayMusic(data)]);
    if (data.weatherMask != null) pairs.push(["Weather", displayWeather(data.weatherMask)]);
    if (data.waterLevel != null) {
      pairs.push(["Water level", data.waterLevel > 0 ? data.waterLevel : "None"]);
    }
    if (data.ambientSound != null) pairs.push(["Ambient", displayAmbientSound(data)]);
    if (data.redbookTrack != null) pairs.push(["Redbook track", String(data.redbookTrack)]);
    if (data.podComment) pairs.push(["POD comment", data.podComment]);
    if (data.fly) {
      pairs.push(["Globe tiles", data.fly.tiles.join(", ")]);
      const c = data.fly.coverage;
      if (c) pairs.push(["Coverage", `${formatLatitude(c.south)} to ${formatLatitude(c.north)}, ${formatLongitude(c.west)} to ${formatLongitude(c.east)}`]);
      if (data.warnings?.length) pairs.push(["Notes", data.warnings.join(" ")]);
    }

    // Only shown when the pod carries a Community Patch 3 version record.
    const version = data.trackVersion;
    if (version) {
      const tool = [version.tool, version.toolVersion].filter(Boolean).join(" ");
      pairs.push(["Track format", version.formatVersion ? `v${version.formatVersion}` : "—"]);
      if (tool) pairs.push(["Built with", tool]);
      if (version.built) pairs.push(["Built", version.built]);
      if (version.hdTextures) pairs.push(["HD textures", version.hdTextures]);
      if (version.legacyFallback) pairs.push(["Legacy fallback", version.legacyFallback]);
    }

    dl.innerHTML = pairs.map(([k, v]) =>
      `<dt>${escHtml(String(k))}</dt><dd>${escHtml(String(v))}</dd>`
    ).join("");

    const statsPanel = this._doc.getElementById("stats-panel");
    const statsDl = this._doc.getElementById("track-stats");
    if (data.stats) {
      const s = data.stats;
      /*
        Grid size, textures and objects are true of every track. Everything below is a layer
        some of these games have and others do not, so a zero is almost always "this game has
        no such thing" rather than "this track has none of them": Evo has no ground-box layer
        at all and no Hellbender level has a course. Those rows are omitted for the same
        reason their View Options toggles are.
      */
      const statsPairs = [
        ["Grid size",    `${s.gridSize}×${s.gridSize}`],
        ["Textures",     s.textureCount],
        ["Objects",      s.objectCount],
      ];
      if (s.groundBoxCount) statsPairs.push(["Ground boxes", s.groundBoxCount]);
      // Hellbender's cavern, which is a second world on the same grid; see hb-underground.js.
      if (s.cavernCellCount) statsPairs.push(["Cavern cells", s.cavernCellCount]);
      if (s.undergroundBoxCount) statsPairs.push(["Cavern boxes", s.undergroundBoxCount]);
      if (s.primarySegmentCount) statsPairs.push(["Course segs", s.primarySegmentCount]);
      /*
        TV-family map content that has no MTM equivalent. Each row is only added when the
        level actually carries that side file, so an MTM track's stats panel is unchanged.
      */
      /*
        4x4 Evolution content. A .SMF track's models and art are counted because they are the
        bulk of what it draws, and its vegetation is a separate instanced layer with no
        equivalent in the other games - a stock Evo 2 track places 6,000-11,000 trees.
      */
      if (s.sitVersion) statsPairs.push(["SIT version", `v${s.sitVersion}`]);
      if (s.modelCount) statsPairs.push(["Models", s.modelCount]);
      if (s.modelTextureCount) statsPairs.push(["Model textures", s.modelTextureCount]);
      if (s.shadowTextureCount) statsPairs.push(["Shadow textures", s.shadowTextureCount]);
      if (s.treeCount) statsPairs.push(["Trees", s.treeCount]);
      if (s.checkpointCount) statsPairs.push(["Checkpoints", s.checkpointCount]);
      if (s.navPointCount) statsPairs.push(["Nav points", s.navPointCount]);
      if (s.tunnelCount) statsPairs.push(["Tunnels", s.tunnelCount]);
      if (s.powerupCount) statsPairs.push(["Powerups", s.powerupCount]);
      if (s.animationCount) statsPairs.push(["Animated textures", s.animationCount]);
      /*
        CPR tracks carry a second geometry layer the other games have no equivalent for. The
        names are the track editor's own, so this reads the way CPREdit would have shown it.
      */
      if (s.cpr) {
        statsPairs.push(["Track segments", s.cpr.segmentCount]);
        statsPairs.push(["Walls", s.cpr.wallCount]);
        for (const { name, count } of s.cpr.wallTypes) statsPairs.push([`  ${name}`, count]);
        for (const { name, count } of s.cpr.surfaceTypes) statsPairs.push([`  ${name} textures`, count]);
        statsPairs.push(["Catch fence", s.cpr.fenceSource]);
      }
      statsDl.innerHTML = statsPairs.map(([k, v]) =>
        `<dt>${escHtml(String(k))}</dt><dd>${escHtml(String(v))}</dd>`
      ).join("");
      if (statsPanel) statsPanel.hidden = false;
    } else {
      statsDl.innerHTML = "<dt>Status</dt><dd>No stats.</dd>";
      if (statsPanel) statsPanel.hidden = false;
    }
  }

  /** The browser tab names the track being viewed, since several are usually open at once. */
  _setDocumentTitle(trackName, origin) {
    const label = [trackName, origin ? `(${origin})` : ""].filter(Boolean).join(" ");
    this._doc.title = label ? `${APP_TITLE} - ${label}` : APP_TITLE;
  }

  /*
    The Sun panel: where the light is, and where it came from.

    Every game in this viewer states a sun direction in its level file, so the panel names the
    compass point when the direction matches one - Traxx offers exactly five and its stock
    content uses only those - and says when a slider has moved the sun off it.
  */
  _updateSunPanel(angles) {
    const info = this._doc.getElementById("sun-info");
    if (!info) return;
    if (!angles) {
      info.innerHTML = "<dt>Source</dt><dd>Track states none</dd>";
      return;
    }
    const azimuthSlider = this._doc.getElementById("sun-azimuth-slider");
    const elevationSlider = this._doc.getElementById("sun-elevation-slider");
    const azimuth = Math.round(angles.azimuth);
    const elevation = Math.round(angles.elevation);
    if (azimuthSlider) {
      azimuthSlider.value = String(((azimuth % 360) + 360) % 360);
      this._doc.getElementById("sun-azimuth-value").textContent = `${azimuth}\u00b0`;
    }
    if (elevationSlider) {
      elevationSlider.value = String(Math.max(1, Math.min(90, elevation)));
      this._doc.getElementById("sun-elevation-value").textContent = `${elevation}\u00b0`;
    }
    info.innerHTML = [
      ["Source", angles.fromTrack ? "From the track" : "Adjusted"],
      ["Bearing", `${azimuth}\u00b0 ${compassPoint(azimuth, elevation)}`],
      ["Height", `${elevation}\u00b0 above horizon`],
    ].map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd>`).join("");
  }

  /*
    Shows only the toggles the loaded track has something for.

    Markers and View Options only show controls backed by the loaded track. The scene answers
    that from the layers it actually built; see TrackScene.layerPresence.

    Passing null restores the full set, which is the right state with no track loaded: nothing
    is known to be absent yet.
  */
  _applyLayerAvailability(presence) {
    for (const [id, flag] of Object.entries(this._toggleMap ?? {})) {
      const input = this._doc.getElementById(id);
      const row = input?.closest("label");
      if (row) row.hidden = presence ? presence[flag] === false : false;
    }
  }

  /*
    One checkbox per course, since what a track's courses are depends on the game: CPR's five
    each have a purpose (three AI lines, pit road, pit row), and a SIT track has its main
    course and the AI lines. Each is labelled and coloured as it is drawn. All start off, as
    the single course toggle they replace did.
  */
  _buildCourseToggles() {
    const box = this._doc.getElementById("course-toggles");
    const list = this._doc.getElementById("course-toggle-list");
    if (!box || !list) return;
    list.replaceChildren();
    const courses = this._scene?.courseList() ?? [];
    for (const course of courses) {
      const label = this._doc.createElement("label");
      const input = this._doc.createElement("input");
      input.type = "checkbox";
      input.checked = course.visible;
      input.addEventListener("change", () => this._scene.setCourseVisible(course.index, input.checked));
      const swatch = this._doc.createElement("span");
      swatch.className = "course-swatch";
      swatch.style.background = `#${course.color.toString(16).padStart(6, "0")}`;
      label.append(input, swatch, this._doc.createTextNode(course.label));
      list.append(label);
    }
    box.hidden = courses.length === 0;
    this._scene.setCourseStyle(this._doc.getElementById("course-style-select").value);
  }

  _applyWeather() {
    const select = this._doc.getElementById("weather-select");
    this._scene.setWeather(select.value);
    this._scene.setSkyStyle(this._skyStyle);
    const applies = this._scene.weatherApplies();
    this._doc.getElementById("weather-row").hidden = !applies;
    this._doc.getElementById("sky-style-row").hidden = !applies;
    const classic = this._doc.getElementById("sky-style-classic");
    const classicApplies = this._scene.classicSkyApplies();
    classic.hidden = !classicApplies;
    classic.disabled = !classicApplies;
    // Shown as Textured where Classic has nothing to draw, without forgetting the choice.
    this._doc.getElementById("sky-style-select").value =
      this._skyStyle === "classic" && !classicApplies ? "textured" : this._skyStyle;
    // The Classic sky brings fog with it, so the Fog toggle comes and goes with it.
    if (this._scene._trackData) this._applyLayerAvailability(this._scene.layerPresence());
  }

  _clearTrackInfo() {
    const dl = this._doc.getElementById("track-info");
    dl.innerHTML = "<dt>Status</dt><dd>No track loaded.</dd>";
    const statsPanel = this._doc.getElementById("stats-panel");
    if (statsPanel) statsPanel.hidden = true;
    this._doc.getElementById("track-stats").innerHTML = "<dt>Status</dt><dd>No track loaded.</dd>";
    this._applyLayerAvailability(null);
    this._doc.getElementById("weather-row").hidden = true;
    this._doc.getElementById("sky-style-row").hidden = true;
    this._doc.getElementById("sidebar").classList.add("no-track");
    this._doc.getElementById("course-toggle-list")?.replaceChildren();
    const courseToggles = this._doc.getElementById("course-toggles");
    if (courseToggles) courseToggles.hidden = true;
    this._doc.title = APP_TITLE;
    this._minimap?.clear();
  }

  _setStatus(msg) {
    const el = this._doc.getElementById("status-text");
    if (el) el.textContent = msg;
    // There is no status bar in the markup, so without this every status line, including
    // every caught error, went nowhere at all.
    else console.info(`[JSTrackViewer] ${msg}`);
  }

  _showLoading(msg) {
    this._errorShown = false;
    const overlay = this._doc.getElementById("loading-overlay");
    const msgEl   = this._doc.getElementById("loading-msg");
    if (overlay) overlay.hidden = false;
    if (msgEl) { msgEl.textContent = msg; msgEl.style.color = ""; }
  }

  /** Leave the failure on screen rather than hiding the overlay over a track that never came. */
  _showError(msg) {
    console.error(`[JSTrackViewer] ${msg}`);
    this._errorShown = true;
    const overlay = this._doc.getElementById("loading-overlay");
    const msgEl   = this._doc.getElementById("loading-msg");
    if (overlay) overlay.hidden = false;
    if (msgEl) { msgEl.textContent = msg; msgEl.style.color = "#ff8080"; }
  }

  _hideLoading() {
    if (this._errorShown) return;
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

/*
  MTM 2's nine soundtrack stems, which are the .WAV files in its MUSIC.POD.

  This list names a MUSIC file, and only a music file. It used to name the ambient sound slot
  too, which put "AZTEC (0)" on the info panel of every CPR, Evo, MTM 1, TV and Fury3 track in
  the viewer. Three separate things were wrong with that:

    - MTM 1 and CPR .SITs have no ambient-sound line at all, and neither does a TV-family
      .LVL, so the 0 being named was a default the parser invented, not a value from the file;
    - the ambient slot is not an index into this list even in MTM 2, where AZTEC's own track
      is on slot 2 and slot 0 belongs to Torture Pit;
    - Evo carries a real ambient slot, but nothing maps its numbering onto anything.
*/
const MUSIC_NAMES = ["AZTEC", "BREAK", "FARM", "GRAVEX", "ROCKX", "SCRAP", "SPLASH", "SURF", "VOODOO"];
const WEATHER_NAMES = ["Clear", "Cloudy", "Foggy", "Dense Fog", "Rain", "Snow", "Dusk", "Night", "Pitch Black"];

/*
  The compass point a bearing falls on.

  Traxx offers five sun positions and writes only those, so a stock track always lands exactly
  on one: N, E, S, W, or straight overhead. Anything else is either a hand-edited level or a
  slider, and gets the nearest of the eight points rather than a claim of precision.
*/
const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

function compassPoint(azimuthDeg, elevationDeg) {
  if (elevationDeg >= 88) return "overhead";
  const index = Math.round((((azimuthDeg % 360) + 360) % 360) / 45) % 8;
  return COMPASS_POINTS[index];
}

function displayMusic(data) {
  const name = data.musicName || "";
  if (!name) return "—";
  const base = name.split(/[\\/]/).pop().replace(/\.[^.]+$/, "").toUpperCase();
  return MUSIC_NAMES.includes(base) ? base : name;
}

function displayBackgroundModel(data) {
  // An arena stands in for the backdrop rather than accompanying it, so it is what this
  // field should name. Without this an arena track reports no background model at all,
  // which is now visibly untrue.
  const arena = data.arena?.modelName ? data.arena : null;
  const names = data.backdropModelNames?.length ? data.backdropModelNames : (data.backdropModelName ? [data.backdropModelName] : []);
  const name = arena?.modelName || names[0] || "";
  if (!name) return "—";
  const model = data.models?.[name];
  const format = model?.format ? ` (${model.format})` : "";
  return arena ? `${name}${format}, arena` : names.length > 1 ? `${name}${format} + ${names.length - 1} more` : `${name}${format}`;
}

/*
  The ambient sound slot.

  MTM 2 is the one game whose slot resolves to something nameable: it indexes
  DATA\SOUND<NNN>.TXT in the game's SOUND.POD, the per-course table of one-shot and looping
  ambience. The mapping is exact across the fifteen stock courses - Sidewinder Canyon and
  Tumbleweed Flats, the two deserts, are on slots 6 and 8 and SOUND006/SOUND008 are the two
  coyote tables, The Heights is on 5 against SOUND005's eagles, and The Graveyard is on 13
  against the one table whose checkpoint sound is scream4.wav. The four slots with no file
  (0, 10, 11 and 12) are the arenas, which have no outdoor ambience.

  That table lives in another archive, so the viewer names the file rather than its contents.
  Every other game gets the bare number, and a track whose file has no such field gets
  nothing, which is what a missing field should read as.
*/
function displayAmbientSound(data) {
  const slot = data?.ambientSound;
  if (slot == null || slot === "") return "—";
  if (data?.origin === "MTM2") {
    const table = `SOUND${String(slot).padStart(3, "0")}.TXT`;
    return `Slot ${slot} (${table})`;
  }
  return `Slot ${slot}`;
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
  constructor(canvas, panel, onNavigate, onTeleport) {
    this.canvas = canvas;
    this.panel = panel;
    this.onNavigate = onNavigate;
    this.onTeleport = onTeleport;
    this.track = null;
    this.mapBitmap = null;
    this.mapCanvas = null;
    // The driven truck's pose while Test Drive is on; null means show the fly camera.
    this.truck = null;
    this.canvas?.addEventListener("click", (e) => this._onClick(e));
    this.canvas?.addEventListener("dblclick", (e) => {
      const point = this._worldPointOf(e);
      if (point && this.truck) this.onTeleport?.(point.x, point.z);
    });
  }

  /** Follow the truck instead of the camera, or stop following it with null. */
  updateTruck(pose) {
    this.truck = pose;
    this.draw();
  }

  /** Scene-unit (x, z) under a mouse event, or null off the map. */
  _worldPointOf(e) {
    const terrain = this.track?.terrain;
    if (!this.canvas || !terrain) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const worldSize = (terrain.gridSize ?? 256) * (terrain.cellSize ?? 64);
    return {
      x: ((e.clientX - rect.left) / rect.width) * worldSize,
      z: ((e.clientY - rect.top) / rect.height) * worldSize,
    };
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
    // While driving, the fly camera is not in use, so a single click moves nothing.
    if (this.truck || !this.onNavigate) return;
    const point = this._worldPointOf(e);
    if (point) this.onNavigate(point.x, point.z);
  }

  _buildHeightMap() {
    const terrain = this.track?.terrain;
    // Fly! brings its own picture of the world, its satellite imagery, already north up.
    if (this.canvas && terrain?.minimap) {
      const { rgba, width, height } = terrain.minimap;
      this.mapBitmap = new ImageData(new Uint8ClampedArray(rgba.buffer ?? rgba), width, height);
      this.mapCanvas = document.createElement("canvas");
      this.mapCanvas.width = width;
      this.mapCanvas.height = height;
      this.mapCanvas.getContext("2d").putImageData(this.mapBitmap, 0, 0);
      return;
    }
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

    // Test Drive shows the truck, in green; otherwise the fly camera, in yellow.
    const nav = this.truck ? { position: { x: this.truck.x, z: this.truck.z }, yaw: this.truck.yaw } : this.nav;
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
    ctx.fillStyle = this.truck ? "#3ddc6a" : "#ffdd40";
    ctx.strokeStyle = "#171717";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fill();
  }
}

/** A latitude as 37.84°N. */
function formatLatitude(degrees) {
  return `${Math.abs(degrees).toFixed(2)}°${degrees < 0 ? "S" : "N"}`;
}

/** A longitude as 122.34°W. */
function formatLongitude(degrees) {
  return `${Math.abs(degrees).toFixed(2)}°${degrees < 0 ? "W" : "E"}`;
}
