/**
 * Transport abstraction over Web Workers / Node worker_threads.
 *
 * The repo's tsconfig has no DOM lib, so browser worker globals are described by
 * minimal structural interfaces below. Node worker types come from @types/node via
 * type-only imports (erased at compile, so no runtime Node import lands in browser
 * bundles).
 *
 * Hard rule: transport is postMessage + structured clone only. No SharedArrayBuffer.
 */
import type { MessagePort, Worker as NodeWorker } from 'worker_threads';

// ─────────────────────────────────────────────────────────────────────────
// Structural types for browser worker globals (no DOM lib in tsconfig)
// ─────────────────────────────────────────────────────────────────────────
export interface BrowserWorkerScope {
  postMessage(message: unknown, transfer?: unknown[]): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
}
export interface BrowserWorkerHandle {
  postMessage(message: unknown, transfer?: unknown[]): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (ev: unknown) => void): void;
  removeEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  removeEventListener(type: 'error', listener: (ev: unknown) => void): void;
  terminate(): void;
}

// ─────────────────────────────────────────────────────────────────────────
// Worker-side port (used inside worker-entry): send + receive from the host.
// ─────────────────────────────────────────────────────────────────────────
export interface WorkerPort {
  postMessage(message: unknown): void;
  onMessage(handler: (data: unknown) => void): () => void; // returns unsubscribe
}

/** Wraps the browser `DedicatedWorkerGlobalScope` (`self`). */
export class BrowserWorkerPort implements WorkerPort {
  private readonly scope: BrowserWorkerScope;
  constructor(scope: BrowserWorkerScope) { this.scope = scope; }
  postMessage(message: unknown): void { this.scope.postMessage(message); }
  onMessage(handler: (data: unknown) => void): () => void {
    const listener = (ev: { data: unknown }): void => handler(ev.data);
    this.scope.addEventListener('message', listener);
    return () => this.scope.removeEventListener('message', listener);
  }
}

/** Wraps a Node `MessagePort` (the `parentPort` inside a worker_thread). */
export class NodeWorkerPort implements WorkerPort {
  private readonly port: MessagePort;
  constructor(port: MessagePort) { this.port = port; }
  postMessage(message: unknown): void { this.port.postMessage(message); }
  onMessage(handler: (data: unknown) => void): () => void {
    const listener = (data: unknown): void => handler(data);
    this.port.on('message', listener);
    return () => this.port.off('message', listener);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Main-thread port (held by the orchestrator): send + receive + terminate.
// ─────────────────────────────────────────────────────────────────────────
export interface MainThreadPort {
  postMessage(message: unknown): void;
  onMessage(handler: (data: unknown) => void): () => void;
  onError(handler: (err: unknown) => void): () => void;
  terminate(): void;
}

/** Wraps a browser `Worker`. */
export class BrowserMainThreadPort implements MainThreadPort {
  private readonly worker: BrowserWorkerHandle;
  constructor(worker: BrowserWorkerHandle) { this.worker = worker; }
  postMessage(message: unknown): void { this.worker.postMessage(message); }
  onMessage(handler: (data: unknown) => void): () => void {
    const listener = (ev: { data: unknown }): void => handler(ev.data);
    this.worker.addEventListener('message', listener);
    return () => this.worker.removeEventListener('message', listener);
  }
  onError(handler: (err: unknown) => void): () => void {
    const listener = (ev: unknown): void => handler(ev);
    this.worker.addEventListener('error', listener);
    return () => this.worker.removeEventListener('error', listener);
  }
  terminate(): void { this.worker.terminate(); }
}

/** Wraps a Node `worker_threads.Worker`. */
export class NodeMainThreadPort implements MainThreadPort {
  private readonly worker: NodeWorker;
  constructor(worker: NodeWorker) { this.worker = worker; }
  postMessage(message: unknown): void { this.worker.postMessage(message); }
  onMessage(handler: (data: unknown) => void): () => void {
    const listener = (data: unknown): void => handler(data);
    this.worker.on('message', listener);
    return () => this.worker.off('message', listener);
  }
  onError(handler: (err: unknown) => void): () => void {
    this.worker.on('error', handler);
    return () => this.worker.off('error', handler);
  }
  terminate(): void { void this.worker.terminate(); }
}
