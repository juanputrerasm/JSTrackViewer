import * as THREE from "three";

const DEG2RAD = Math.PI / 180;
const MOVE_SPEED_BASE = 3000;  // world units/sec (crosses 256-cell track in ~5s)
const TURN_SPEED = 80;         // degrees/sec
const PITCH_SPEED = 60;        // degrees/sec
const HEIGHT_SPEED_BASE = 2000; // world units/sec

export class TrackCamera {
  constructor(camera) {
    this.camera = camera;
    this.position = new THREE.Vector3(8192, 1500, 8192);
    this.yaw = 0;      // degrees, 0=north (+Z), 90=east (+X)
    this.pitch = -25;  // degrees, negative=look down

    this._keys = new Set();
    this._dragging = false;
    this._lastMouse = { x: 0, y: 0 };
    this._gridSpan = 64;
    this._trackCenter = new THREE.Vector3(8192, 0, 8192);
    this._trackGridSize = 256;
    this._trackCellSize = 64;
    this._trackHeightScale = 4;
    this._trackData = null;
    this._onGridSpanChange = null;
    this._onChange = null;

    this._applyToCamera();
  }

  setGridSpanChangeCallback(fn) {
    this._onGridSpanChange = fn;
  }

  setChangeCallback(fn) {
    this._onChange = fn;
  }

  get gridSpan() { return this._gridSpan; }
  set gridSpan(v) {
    this._gridSpan = Math.max(4, Math.min(256, v));
    if (this._onGridSpanChange) this._onGridSpanChange(this._gridSpan);
  }

  bindElement(el) {
    this._el = el;
    el.addEventListener("keydown", (e) => this._onKeyDown(e));
    el.addEventListener("keyup", (e) => this._onKeyUp(e));
    el.addEventListener("mousedown", (e) => this._onMouseDown(e));
    el.addEventListener("mousemove", (e) => this._onMouseMove(e));
    el.addEventListener("mouseup", () => this._dragging = false);
    el.addEventListener("mouseleave", () => this._dragging = false);
    el.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    el.setAttribute("tabindex", "0");
  }

  resetToTrackCenter(gridSize, cellSize, heightScale) {
    this._trackGridSize = gridSize;
    this._trackCellSize = cellSize;
    this._trackHeightScale = heightScale;
    const worldSize = gridSize * cellSize;
    const cx = worldSize / 2;
    // After Z-flip: Z=worldSize is south edge, Z=0 is north edge
    // Camera starts south (large Z), looks north (-Z direction, yaw=0)
    const cz = worldSize / 2;
    this._trackCenter.set(cx, 0, cz);
    const dist = worldSize * 0.35;
    this.position.set(cx, worldSize * 0.18, cz + dist);
    this.yaw = 0;   // yaw=0 → looks in -Z (north)
    this.pitch = -25;
    this._applyToCamera();
  }

  resetToCourseStart(trackData, heightScale) {
    this._trackData = trackData;
    const gridSize = trackData?.terrain?.gridSize ?? 256;
    const cellSize = trackData?.terrain?.cellSize ?? 64;
    this._trackGridSize = gridSize;
    this._trackCellSize = cellSize;
    this._trackHeightScale = heightScale;
    const worldSize = gridSize * cellSize;
    const first = trackData?.primaryCourse?.segments?.[0];
    if (!first?.start || !first?.end) {
      this.resetToTrackCenter(gridSize, cellSize, heightScale);
      return;
    }

    const sx = first.start[0];
    const sy = first.start[2] * heightScale;
    const sz = worldSize - first.start[1];
    const ex = first.end[0];
    const ez = worldSize - first.end[1];
    let dx = ex - sx;
    let dz = ez - sz;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;

    const standOff = Math.max(384, cellSize * 8);
    this.position.set(sx - dx * standOff, sy + Math.max(900, worldSize * 0.07), sz - dz * standOff);
    this.yaw = ((Math.atan2(dx, -dz) / DEG2RAD) % 360 + 360) % 360;
    this.pitch = -25;
    this._applyToCamera();
  }

  moveToWorldPosition(x, z) {
    const worldSize = this._trackGridSize * this._trackCellSize;
    this.position.x = Math.max(0, Math.min(worldSize, x));
    this.position.z = Math.max(0, Math.min(worldSize, z));
    this._applyToCamera();
  }

  update(dt) {
    const keys = this._keys;
    const worldSize = this._trackGridSize * this._trackCellSize;
    const moveSpeed = MOVE_SPEED_BASE * (worldSize / 16384);
    const heightSpeed = HEIGHT_SPEED_BASE * (worldSize / 16384);

    if (keys.has("ArrowLeft"))  this.yaw -= TURN_SPEED * dt;
    if (keys.has("ArrowRight")) this.yaw += TURN_SPEED * dt;
    if (keys.has("PageUp"))   this.pitch = Math.min(85,  this.pitch + PITCH_SPEED * dt);
    if (keys.has("PageDown")) this.pitch = Math.max(-85, this.pitch - PITCH_SPEED * dt);

    this.yaw = ((this.yaw % 360) + 360) % 360;

    const fwd = this._forwardFlat();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);

    if (keys.has("ArrowUp"))   this.position.addScaledVector(fwd, moveSpeed * dt);
    if (keys.has("ArrowDown")) this.position.addScaledVector(fwd, -moveSpeed * dt);
    if (keys.has("KeyA") || keys.has("a")) this.position.y += heightSpeed * dt;
    if (keys.has("KeyZ") || keys.has("z")) this.position.y -= heightSpeed * dt;

    if (keys.has("Home")) {
      this.resetToCourseStart(this._trackData, this._trackHeightScale);
      return;
    }

    this._applyToCamera();
  }

  _forwardFlat() {
    const yawRad = this.yaw * DEG2RAD;
    return new THREE.Vector3(Math.sin(yawRad), 0, -Math.cos(yawRad)).normalize();
  }

  _applyToCamera() {
    const yawRad = this.yaw * DEG2RAD;
    const pitchRad = this.pitch * DEG2RAD;
    // Direction camera is looking
    const dx = Math.sin(yawRad) * Math.cos(pitchRad);
    const dy = Math.sin(pitchRad);
    const dz = -Math.cos(yawRad) * Math.cos(pitchRad);
    const target = this.position.clone().add(new THREE.Vector3(dx, dy, dz));
    this.camera.position.copy(this.position);
    this.camera.lookAt(target);
    if (this._onChange) this._onChange(this);
  }

  _onKeyDown(e) {
    this._keys.add(e.code || e.key);
    if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","PageUp","PageDown"].includes(e.key)) {
      e.preventDefault();
    }
    if (e.key === "Home") {
      e.preventDefault();
      this.resetToCourseStart(this._trackData, this._trackHeightScale);
    }
  }

  _onKeyUp(e) { this._keys.delete(e.code || e.key); }

  _onMouseDown(e) {
    if (e.button !== 0) return;
    this._dragging = true;
    this._lastMouse = { x: e.clientX, y: e.clientY };
    this._el?.focus();
  }

  _onMouseMove(e) {
    if (!this._dragging) return;
    const dx = e.clientX - this._lastMouse.x;
    const dy = e.clientY - this._lastMouse.y;
    this._lastMouse = { x: e.clientX, y: e.clientY };
    this.yaw = ((this.yaw + dx * 0.3) % 360 + 360) % 360;
    this.pitch = Math.max(-85, Math.min(85, this.pitch - dy * 0.25));
    this._applyToCamera();
  }

  _onWheel(e) {
    e.preventDefault();
    const worldSize = this._trackGridSize * this._trackCellSize;
    const zoomStep = MOVE_SPEED_BASE * (worldSize / 16384) * 0.12;
    const dir = e.deltaY > 0 ? -1 : 1;
    const fwd = this._forwardFlat();
    this.position.addScaledVector(fwd, zoomStep * dir);
    this._applyToCamera();
  }
}
