/**
 * Portfolio orchestrator: fan out N workers with diversified strategies, stream
 * incumbents, arbitrate by (status rank, objective), terminate losers on a
 * winning OPTIMAL/INFEASIBLE proof, and resolve with the best result.
 *
 * Early termination uses port.terminate() (not a graceful stop message): solve()
 * blocks the worker thread, so a `stop` message could not be processed mid-solve.
 * terminate() is SAB-free and immediate.
 *
 * `spawner` is injectable so unit tests run an in-process fake worker (no build,
 * no real worker_thread) while exercising all orchestration logic.
 */
import { CpSolverStatus } from '../types';
import type { ModelJSON, SolverParameters } from '../types';
import type { MainThreadPort } from './port';
import type { WorkerIn, WorkerOut } from './protocol';
import { spawnWorker } from './spawn';

export interface WorkerStat {
  workerId: number;
  status: CpSolverStatus;
  objectiveValue: number | null;
  numBranches: number;
  numConflicts: number;
  wallTime: number;
}

export interface OrchestrateOptions {
  numWorkers: number;
  strategies: SolverParameters[];
  maximize: boolean;
  onIncumbent?: (info: { workerId: number; objectiveValue: number; wallTime: number }) => void;
  stopOnOptimal: boolean;
  stopOnInfeasible: boolean;
  signal?: AbortSignal;
  spawner?: () => Promise<MainThreadPort>;
}

export interface OrchestrateResult {
  status: CpSolverStatus;
  objectiveValue: number | null;
  bestObjectiveBound: number | null;
  /** Optimality gap % = |objective - bound| / max(1, |objective|) * 100; null if unknown. */
  gapPercent: number | null;
  solution: Map<number, number> | null;
  winningWorker: number;
  stats: WorkerStat[];
}

// Higher = better. OPTIMAL > INFEASIBLE (proof) > FEASIBLE > UNKNOWN > MODEL_INVALID.
const STATUS_RANK: Record<CpSolverStatus, number> = {
  [CpSolverStatus.OPTIMAL]: 4,
  [CpSolverStatus.INFEASIBLE]: 3,
  [CpSolverStatus.FEASIBLE]: 2,
  [CpSolverStatus.UNKNOWN]: 1,
  [CpSolverStatus.MODEL_INVALID]: 0,
};

interface WorkerState {
  id: number;
  port: MainThreadPort;
  done: boolean;
  status: CpSolverStatus;
  objectiveValue: number | null;
  bestObjectiveBound: number | null;
  solution: Record<number, number> | null;
  stats: { numBranches: number; numConflicts: number; numSolutions: number; wallTime: number };
}

export async function orchestrate(
  modelJson: ModelJSON,
  opts: OrchestrateOptions,
): Promise<OrchestrateResult> {
  const spawner = opts.spawner ?? spawnWorker;

  // Best-so-far tracker (status rank then objective).
  let bestStatus: CpSolverStatus = CpSolverStatus.UNKNOWN;
  let bestObj: number | null = null;
  let bestSolution: Record<number, number> | null = null;
  let bestWorker = -1;

  const states: WorkerState[] = [];
  const stats: WorkerStat[] = [];
  let doneCount = 0;
  let resolved = false;

  return new Promise<OrchestrateResult>((resolve) => {
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      // Terminate ALL workers (done or not). Completed-but-idle worker_threads keep the
      // event loop alive, so we must clean every one up or the process never exits.
      for (const s of states) { try { s.port.terminate(); } catch { /* ignore */ } }

      // Harvest the tightest dual bound across all workers. Each worker's root bound is
      // a valid GLOBAL bound (same model), so min (maximize) / max (minimize) is sound.
      const bounds = states.map((s) => s.bestObjectiveBound).filter((b): b is number => b !== null);
      let harvestedBound: number | null = null;
      if (bounds.length > 0) {
        harvestedBound = opts.maximize ? Math.min(...bounds) : Math.max(...bounds);
      }
      // Optimality gap % (mirrors solver-engine.ts gap formula).
      let gapPercent: number | null = null;
      if (bestObj !== null && harvestedBound !== null) {
        gapPercent = (Math.abs(bestObj - harvestedBound) / Math.max(1, Math.abs(bestObj))) * 100;
      }

      resolve({
        status: bestStatus,
        objectiveValue: bestObj,
        bestObjectiveBound: harvestedBound,
        gapPercent,
        solution: bestSolution ? new Map(Object.entries(bestSolution).map(([k, v]) => [Number(k), v])) : null,
        winningWorker: bestWorker,
        stats,
      });
    };

    const considerAsBest = (s: WorkerState): void => {
      const rank = STATUS_RANK[s.status];
      const curRank = STATUS_RANK[bestStatus];
      let take = false;
      if (rank > curRank) take = true;
      else if (rank === curRank && (s.status === CpSolverStatus.OPTIMAL || s.status === CpSolverStatus.FEASIBLE)) {
        // tie among solution-bearing statuses: compare objective
        if (s.objectiveValue !== null) {
          if (bestObj === null) take = true;
          else if (opts.maximize) take = s.objectiveValue > bestObj;
          else take = s.objectiveValue < bestObj;
        }
      }
      if (take) {
        bestStatus = s.status;
        bestObj = s.objectiveValue;
        bestSolution = s.solution;
        bestWorker = s.id;
      }
    };

    const onWorkerDone = (s: WorkerState): void => {
      if (s.done) return;
      s.done = true;
      doneCount++;
      considerAsBest(s);
      stats.push({
        workerId: s.id, status: s.status, objectiveValue: s.objectiveValue,
        numBranches: s.stats.numBranches, numConflicts: s.stats.numConflicts, wallTime: s.stats.wallTime,
      });

      const isOptimal = s.status === CpSolverStatus.OPTIMAL;
      const isInfeasible = s.status === CpSolverStatus.INFEASIBLE;
      if ((isOptimal && opts.stopOnOptimal) || (isInfeasible && opts.stopOnInfeasible)) {
        // reconsidered above already; terminate losers + resolve
        finish();
        return;
      }
      if (doneCount === states.length) finish();
    };

    // Spawn + wire each worker.
    void (async () => {
      for (let i = 0; i < opts.numWorkers; i++) {
        const id = i;
        let port: MainThreadPort;
        try {
          port = await spawner();
        } catch {
          // spawn failed (e.g. no build) — treat as an immediately-done UNKNOWN worker
          const s: WorkerState = { id, port: { postMessage() {}, onMessage() { return () => {}; }, onError() { return () => {}; }, terminate() {} }, done: false, status: CpSolverStatus.UNKNOWN, objectiveValue: null, bestObjectiveBound: null, solution: null, stats: { numBranches: 0, numConflicts: 0, numSolutions: 0, wallTime: 0 } };
          states.push(s);
          onWorkerDone(s);
          continue;
        }
        const s: WorkerState = { id, port, done: false, status: CpSolverStatus.UNKNOWN, objectiveValue: null, bestObjectiveBound: null, solution: null, stats: { numBranches: 0, numConflicts: 0, numSolutions: 0, wallTime: 0 } };
        states.push(s);
        port.onMessage((raw: unknown) => {
          const msg = raw as WorkerOut;
          if (!msg || typeof msg !== 'object') return;
          if (msg.kind === 'incumbent') {
            opts.onIncumbent?.({ workerId: msg.workerId, objectiveValue: msg.objectiveValue, wallTime: msg.wallTime });
            // track best incumbent live (FEASIBLE-level)
            if (s.objectiveValue === null || (opts.maximize ? msg.objectiveValue > s.objectiveValue : msg.objectiveValue < s.objectiveValue)) {
              s.objectiveValue = msg.objectiveValue;
              s.status = CpSolverStatus.FEASIBLE;
            }
            considerAsBest(s);
          } else if (msg.kind === 'done') {
            s.status = msg.status;
            s.objectiveValue = msg.objectiveValue;
            s.bestObjectiveBound = msg.bestObjectiveBound;
            s.solution = msg.solution;
            s.stats = msg.stats;
            onWorkerDone(s);
          }
        });
        port.onError(() => onWorkerDone(s));
        const solveMsg: WorkerIn = { kind: 'solve', workerId: id, model: modelJson, params: opts.strategies[id] ?? opts.strategies[0] };
        port.postMessage(solveMsg);
      }
      if (states.length === 0) finish();
    })();

    if (opts.signal) {
      if (opts.signal.aborted) finish();
      else opts.signal.addEventListener('abort', () => finish(), { once: true });
    }
  });
}
