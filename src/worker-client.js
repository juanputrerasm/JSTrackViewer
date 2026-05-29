export class WorkerClient {
  constructor(url) {
    this.worker = new Worker(url, { type: "module" });
    this.pending = new Map();
    this.nextId = 1;
    this.worker.addEventListener("message", (e) => this._handleMessage(e.data));
  }

  call(type, payload, transfer = []) {
    const id = this.nextId++;
    this.worker.postMessage({ id, type, payload }, transfer);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  terminate() {
    this.worker.terminate();
    for (const { reject } of this.pending.values()) {
      reject(new Error("Worker terminated."));
    }
    this.pending.clear();
  }

  _handleMessage(msg) {
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
