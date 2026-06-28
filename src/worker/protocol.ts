/**
 * Wire protocol for portfolio workers — all payloads are JSON-safe (postMessage+JSON,
 * no SharedArrayBuffer). Shared between the orchestrator (main thread) and worker-entry.
 */
import type { CpSolverStatus, ModelJSON, SolverParameters } from '../types';

/** Main thread → worker. */
export type WorkerIn =
  | { kind: 'solve'; workerId: number; model: ModelJSON; params: SolverParameters }
  | { kind: 'stop' };

/** Per-worker statistics reported on completion. */
export interface WorkerStats {
  numBranches: number;
  numConflicts: number;
  numSolutions: number;
  wallTime: number;
}

/** Worker → main thread. */
export type WorkerOut =
  | { kind: 'ready'; workerId: number }
  | { kind: 'incumbent'; workerId: number; objectiveValue: number; wallTime: number }
  | {
      kind: 'done';
      workerId: number;
      status: CpSolverStatus;
      objectiveValue: number | null;
      bestObjectiveBound: number | null;
      solution: Record<number, number> | null;
      stats: WorkerStats;
    };
