/**
 * `cp-sat-ts/worker` subpath — portfolio parallelism via Web Workers / worker_threads.
 *
 * Workers are ESM-only (module workers require `import.meta.url`). Import from the
 * subpath, not the core entry:
 *   import { solvePortfolio } from 'cp-sat-ts/worker';
 */
export { solvePortfolio, diversify } from './portfolio';
export type { PortfolioOptions, PortfolioResult } from './portfolio';
export type { WorkerStat } from './orchestrator';
export type {
  WorkerPort, MainThreadPort,
  BrowserWorkerPort, NodeWorkerPort, BrowserMainThreadPort, NodeMainThreadPort,
} from './port';
export type { WorkerIn, WorkerOut, WorkerStats } from './protocol';
export { runWorkerSolve } from './worker-entry';
export type { SolveResult } from './worker-entry';
