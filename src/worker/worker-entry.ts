/**
 * Worker body for portfolio parallelism. Transport-agnostic: runs under Node
 * worker_threads (CI/tests) and browser Web Workers (production) via the `Port`
 * abstraction. No SharedArrayBuffer — transport is postMessage + structured clone.
 *
 * `runWorkerSolve` is a pure, in-process-callable function (unit-tested directly).
 * `startWorker` is the message loop the actual worker boots.
 */
import { CpModel } from '../model';
import { CpSolver } from '../solver';
import { CpSolverStatus } from '../types';
import type { ModelJSON, SolverParameters } from '../types';
import { CpSolverSolutionCallback } from '../callback';
import type { WorkerIn, WorkerOut, WorkerStats } from './protocol';
import { BrowserWorkerPort, NodeWorkerPort } from './port';
import type { BrowserWorkerScope, WorkerPort } from './port';

export interface SolveResult {
  status: CpSolverStatus;
  objectiveValue: number | null;
  bestObjectiveBound: number | null;
  solution: Record<number, number> | null;
  stats: WorkerStats;
}

/**
 * Rebuild a model from JSON and solve it. Streams each incumbent via `onIncumbent`.
 * Pure: safe to call in-process (used by unit tests and the worker message loop).
 */
export function runWorkerSolve(
  modelJson: ModelJSON,
  params: SolverParameters,
  onIncumbent?: (objectiveValue: number, wallTime: number) => void,
): SolveResult {
  const model = CpModel.fromJSON(modelJson);
  const solver = new CpSolver();
  solver.parameters = params;

  let callback: CpSolverSolutionCallback | undefined;
  if (onIncumbent) {
    callback = new (class extends CpSolverSolutionCallback {
      onSolutionCallback(): void {
        onIncumbent(this._objectiveValue, this._wallTime);
      }
    })();
  }

  const status = solver.solve(model, callback);
  const haveSol = status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE;

  let solution: Record<number, number> | null = null;
  if (haveSol) {
    solution = {};
    for (const v of model.registry.allIntVars) solution[v.index] = solver.value(v);
    for (const v of model.registry.allBoolVars) solution[v.index] = solver.value(v);
  }

  return {
    status,
    objectiveValue: haveSol ? solver.objectiveValue : null,
    // P0: solver.bestObjectiveBound currently mirrors the primal incumbent (engine
    // has no persistent dual field). P1 will add a real dual bound. Reported honestly.
    bestObjectiveBound: haveSol ? solver.bestObjectiveBound : null,
    solution,
    stats: {
      numBranches: solver.numBranches,
      numConflicts: solver.numConflicts,
      numSolutions: solver.numSolutions,
      wallTime: solver.wallTime,
    },
  };
}

/** Detect the worker-side transport port from the execution context. */
export async function detectWorkerPort(): Promise<WorkerPort> {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const { parentPort } = await import(/* @vite-ignore */ 'worker_threads');
    if (!parentPort) throw new Error('cp-sat-ts worker: Node context but no parentPort');
    return new NodeWorkerPort(parentPort);
  }
  const scope = globalThis as unknown as BrowserWorkerScope;
  if (typeof scope.addEventListener === 'function' && typeof scope.postMessage === 'function') {
    return new BrowserWorkerPort(scope);
  }
  throw new Error('cp-sat-ts worker: unknown context (not a Web Worker / worker_thread)');
}

/**
 * Boot the worker message loop. Messages sent before the (async) port detection
 * completes are buffered by the runtime (Web Worker / worker_threads), so none are lost.
 *
 * Note: `solve()` blocks the worker thread, so a graceful `{kind:'stop'}` cannot be
 * processed mid-solve — early termination is done by the orchestrator via port.terminate().
 */
export async function startWorker(port?: WorkerPort): Promise<void> {
  const p = port ?? await detectWorkerPort();
  p.onMessage((raw: unknown) => {
    const msg = raw as WorkerIn;
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'stop') return;
    if (msg.kind === 'solve') {
      const { workerId, model, params } = msg;
      const result = runWorkerSolve(model, params, (objectiveValue, wallTime) => {
        const out: WorkerOut = { kind: 'incumbent', workerId, objectiveValue, wallTime };
        p.postMessage(out);
      });
      const out: WorkerOut = { kind: 'done', workerId, ...result };
      p.postMessage(out);
    }
  });
}
