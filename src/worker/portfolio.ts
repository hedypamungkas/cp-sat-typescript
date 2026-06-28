/**
 * Public portfolio API: run N workers with diversified strategies, return the
 * best result. Exported via the `cp-sat-ts/worker` package subpath (ESM only —
 * module workers need `import.meta.url`). The core `cp-sat-ts` entry stays
 * worker-free for tree-shaking.
 *
 * Usage:
 *   import { solvePortfolio } from 'cp-sat-ts/worker';
 *   const result = await solvePortfolio(model, { numWorkers: 8, maxTimeInSeconds: 30 });
 */
import type { CpModel } from '../model';
import { CpSolverStatus } from '../types';
import type { SolverParameters } from '../types';
import { orchestrate } from './orchestrator';
import type { OrchestrateOptions, WorkerStat } from './orchestrator';
import type { MainThreadPort } from './port';

export interface PortfolioOptions {
  /** Number of parallel workers. Default: min(hardwareConcurrency, 8). */
  numWorkers?: number;
  /** Per-worker wall-clock budget. Default: unlimited (run to completion). */
  maxTimeInSeconds?: number;
  /** Base seed; worker i gets `randomSeed = baseSeed + i`. Default 1. */
  randomSeed?: number;
  /** Override the auto-diversified strategies (advanced). Length must match numWorkers. */
  strategies?: SolverParameters[];
  /** Fired whenever any worker finds a new (worker-local) incumbent. */
  onIncumbent?: (info: { workerId: number; objectiveValue: number; wallTime: number }) => void;
  /** Stop all workers as soon as one proves OPTIMAL (default true). */
  stopOnOptimal?: boolean;
  /** Stop all workers as soon as one proves INFEASIBLE (default true). */
  stopOnInfeasible?: boolean;
  /** Abort the whole portfolio (stops + resolves with the best result so far). */
  signal?: AbortSignal;
  /** @internal In-process fake spawner for unit tests (no real worker spawned). */
  spawner?: () => Promise<MainThreadPort>;
}

export interface PortfolioResult {
  status: CpSolverStatus;
  objectiveValue: number | null;
  /** Sound dual bound: tightest (min/max) across workers. Equals objectiveValue on OPTIMAL. */
  bestObjectiveBound: number | null;
  /** Optimality gap % = |objective - bound| / max(1, |objective|) * 100; null if unknown. */
  gapPercent: number | null;
  /** var index → value for the winning worker's solution, or null. */
  solution: Map<number, number> | null;
  winningWorker: number;
  numWorkers: number;
  stats: WorkerStat[];
}

const isNode =
  typeof process !== 'undefined' && !!(process.versions && process.versions.node);

async function detectCpus(): Promise<number> {
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
  if (nav && typeof nav.hardwareConcurrency === 'number') return Math.min(nav.hardwareConcurrency, 8);
  if (isNode) {
    try {
      const os = await import('node:os');
      const n = os.cpus()?.length;
      if (typeof n === 'number') return Math.min(n, 8);
    } catch { /* ignore */ }
  }
  return 4;
}

/**
 * Default 4-strategy portfolio rotation (mirrors OR-Tools' default portfolio shape):
 *  0 — pure DFS (no restarts, baseline)
 *  1 — Luby restarts (base 256)
 *  2 — aggressive Luby (base 64) + LNS
 *  3 — tighter LP bounds (simplex + knapsack)
 * Each worker also gets a distinct `randomSeed` for MRV tie-break diversity.
 */
export function diversify(
  n: number,
  baseSeed: number,
  maxTimeInSeconds?: number,
): SolverParameters[] {
  const out: SolverParameters[] = [];
  for (let i = 0; i < n; i++) {
    const base: SolverParameters = { randomSeed: baseSeed + i };
    if (maxTimeInSeconds !== undefined) base.maxTimeInSeconds = maxTimeInSeconds;
    switch (i % 4) {
      case 0: base.restartStrategy = 'none'; break;
      case 1: base.restartStrategy = 'luby'; base.restartBaseInterval = 256; break;
      case 2:
        base.restartStrategy = 'luby'; base.restartBaseInterval = 64;
        base.enableLNS = true; base.lnsNeighborhoodSize = 0.4;
        break;
      case 3:
        base.restartStrategy = 'none';
        base.enableSimplexBounds = true; base.enableLpBounds = true;
        break;
    }
    out.push(base);
  }
  return out;
}

export async function solvePortfolio(
  model: CpModel,
  opts: PortfolioOptions = {},
): Promise<PortfolioResult> {
  const modelJson = model.toJSON();
  const maximize = !!model.isMaximize;

  const numWorkers = opts.strategies ? opts.strategies.length : (opts.numWorkers ?? (await detectCpus()));
  const strategies = opts.strategies ?? diversify(numWorkers, opts.randomSeed ?? 1, opts.maxTimeInSeconds);

  const oopts: OrchestrateOptions = {
    numWorkers,
    strategies,
    maximize,
    onIncumbent: opts.onIncumbent,
    stopOnOptimal: opts.stopOnOptimal ?? true,
    stopOnInfeasible: opts.stopOnInfeasible ?? true,
    signal: opts.signal,
    spawner: opts.spawner,
  };

  const res = await orchestrate(modelJson, oopts);
  return { ...res, numWorkers };
}
