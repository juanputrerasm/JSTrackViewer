export class WorkerClient {
  constructor(url) {
    this.worker = new Worker(url, { type: "module" });
    this.pending = new Map();
    this.nextId = 1;
    this.failure = null;
    this.ready = false;
    this.worker.addEventListener("message", (e) => this._handleMessage(e.data));

    /*
      A module Worker whose script graph fails to load or throws while evaluating never runs
      its message handler, so every call would sit unresolved and the interface would hang
      with no error anywhere. The error event is the only notice of it, so treat it as fatal
      to the worker and fail everything waiting.
    */
    this.worker.addEventListener("error", (e) => {
      // An error before the worker ever announced itself means the module graph never
      // evaluated. That error carries no message or filename, because the failure belongs to
      // no single script, so say what it actually is and what to do about it.
      if (!this.ready) {
        this._fail(new Error(
          "Worker script failed to load. Its module graph did not evaluate, which is almost "
          + "always a stale cached module: one import that no longer resolves kills the whole "
          + "graph. Reload with caching off (DevTools > Network > Disable cache) or use a "
          + "private window."));
        return;
      }
      const where = e.filename ? ` (${e.filename}:${e.lineno})` : "";
      this._fail(new Error(`Worker failed: ${e.message || "script error"}${where}`));
    });
    this.worker.addEventListener("messageerror", () => {
      this._fail(new Error("Worker sent a message that could not be deserialised"));
    });
  }

  call(type, payload, transfer = []) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // Register before posting: a synchronous failure must still find its deferred.
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, type, payload }, transfer);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  _fail(error) {
    this.failure = error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  terminate() {
    this.worker.terminate();
    for (const { reject } of this.pending.values()) {
      reject(new Error("Worker terminated."));
    }
    this.pending.clear();
  }

  _handleMessage(msg) {
    if (msg?.ready) { this.ready = true; return; }
    const deferred = this.pending.get(msg.id);
    if (!deferred) return;
    this.pending.delete(msg.id);
    if (msg.ok) {
      deferred.resolve(msg.payload);
    } else {
      deferred.reject(new Error(msg.error ?? "Worker error"));
    }
  }
}
