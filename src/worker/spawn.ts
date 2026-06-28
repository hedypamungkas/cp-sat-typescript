/**
 * Spawn a portfolio worker and wrap it in a MainThreadPort. Environment-agnostic:
 * Node `worker_threads` (loads the bundled `cp-sat-worker.cjs`) or browser Web Workers
 * (module worker — the consumer's bundler resolves & bundles it).
 *
 * Why a bundle for Node: the tsc ESM build uses extensionless imports, which Node ESM
 * rejects — but a Node worker_thread loads files directly with no bundler. So the build
 * bundles worker-entry (+ the solver) into one self-contained `dist/cp-sat-worker.cjs`
 * via esbuild (build-time devDep; the bundle has zero runtime deps). Real workers require
 * `npm run build`; unit tests inject an in-process fake spawner (no build needed).
 *
 * No SharedArrayBuffer — transport is postMessage + structured clone.
 */
import { BrowserMainThreadPort, NodeMainThreadPort } from './port';
import type { BrowserWorkerHandle, MainThreadPort } from './port';

const isNode =
  typeof process !== 'undefined' && !!(process.versions && process.versions.node);

async function spawnNode(): Promise<MainThreadPort> {
  const [{ Worker }, { existsSync }] = await Promise.all([
    import(/* @vite-ignore */ 'worker_threads'),
    import(/* @vite-ignore */ 'node:fs'),
  ]);
  // dist/esm/worker/spawn.js → ../../cp-sat-worker.cjs (the esbuild bundle).
  const url = new URL('../../cp-sat-worker.cjs', import.meta.url);
  if (!existsSync(url)) {
    throw new Error(
      `cp-sat-ts portfolio worker bundle not found at ${url.href}. ` +
        'Run `npm run build` first (real workers require the bundled worker). ' +
        '(Unit tests use an in-process fake spawner and do not need a build.)',
    );
  }
  return new NodeMainThreadPort(new Worker(url));
}

async function spawnBrowser(): Promise<MainThreadPort> {
  // Static literal so consumer bundlers (Vite / webpack 5) detect and emit the worker chunk.
  const url = new URL('./worker-bootstrap.js', import.meta.url);
  const WorkerCtor = (globalThis as unknown as {
    Worker: new (url: URL, opts: { type: 'module' }) => BrowserWorkerHandle;
  }).Worker;
  const worker = new WorkerCtor(url, { type: 'module' });
  return new BrowserMainThreadPort(worker);
}

/** Spawn one worker. The orchestrator calls this N times (overridable for tests). */
export function spawnWorker(): Promise<MainThreadPort> {
  return isNode ? spawnNode() : spawnBrowser();
}
