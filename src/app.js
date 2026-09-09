import { TrackScene } from "./scene.js";
import { WorkerClient } from "./worker-client.js";
import { resetSessionFolder, writeBytesToFile } from "./shared/opfs.js";
import { extractFirstPodFromZipBytes } from "./zip-utils.js";

const APP_TITLE = "JSTrackViewer";
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
      navpoints: true, cpmarkers: true, tunnels: true, powerups: true, animate: true,
      racetrack: true, underground: true,
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
      "tog-gboxes":    "gboxes",
      "tog-cboxes":    "cboxes",
      "tog-racetrack": "racetrack",
      "tog-underground": "underground",
      "tog-water":     "water",
      "tog-backdrop":  "backdrop",
      "tog-shadows":   "shadows",
      "tog-wireframe": "wireframe",
      "tog-trucks":    "trucks",
      "tog-navpoints": "navpoints",
      "tog-cpmarkers": "cpmarkers",
      "tog-tunnels":   "tunnels",
      "tog-powerups":  "powerups",
      "tog-animate":   "animate",
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
      heading.setAttribute("aria-expanded", "true");
      heading.addEventListener("click", toggle);
      heading.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
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
  }

  async _loadFromFile(file) {
    this._setStatus(`Reading ${file.name}…`);
    this._showLoading(`Reading ${file.name}…`);
    try {
      const buffer = await file.arrayBuffer();
      const staged = await this._podBytesFromContainer(new Uint8Array(buffer), file.name);
      await this._storePodAndIndex(staged.bytes, staged.filename, staged.source);
    } catch (err) {
      this._showError(`Error: ${err.message}`);
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
      this._showError(`Error: ${err.message}`);
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
      this._applyLayerAvailability(this._scene.layerPresence());
      this._setStatus(result.trackName || choice.name);
      this._setDocumentTitle(result.trackName || choice.name, result.origin);
      // Focus viewport after load
      this._doc.getElementById("viewport")?.focus();
    } catch (err) {
      this._showError(`Error loading track: ${err.message}`);
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

    A View Options panel that offers Tunnels, Powerups and Nav points on an MTM track, or
    Ground boxes on an Evo one, is nineteen controls of which a third do nothing. Which ones
    those are is answered by the scene, from the layers it actually built, rather than by a
    table here of what each game is supposed to carry - see TrackScene.layerPresence.

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

  _clearTrackInfo() {
    const dl = this._doc.getElementById("track-info");
    dl.innerHTML = "<dt>Status</dt><dd>No track loaded.</dd>";
    const statsPanel = this._doc.getElementById("stats-panel");
    if (statsPanel) statsPanel.hidden = true;
    this._doc.getElementById("track-stats").innerHTML = "<dt>Status</dt><dd>No track loaded.</dd>";
    this._applyLayerAvailability(null);
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
  const name = arena?.modelName || data.backdropModelName || "";
  if (!name) return "—";
  const model = data.models?.[name];
  const format = model?.format ? ` (${model.format})` : "";
  return arena ? `${name}${format}, arena` : `${name}${format}`;
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
