/**
 * Portfolio-vs-direct comparison: solvePortfolio(1 worker, seed S) must produce
 * the same objective as a direct CpSolver.solve(seed S). This catches silent
 * serialization bugs (toJSON/fromJSON round-trip) and worker divergence.
 */
import { describe, it, expect } from 'vitest';
import { CpModel } from '../../src/model';
import { CpSolver } from '../../src/solver';
import { CpSolverStatus } from '../../src/types';
import type { SolverParameters } from '../../src/types';
import { solvePortfolio } from '../../src/worker/portfolio';
import { runWorkerSolve } from '../../src/worker/worker-entry';
import type { MainThreadPort } from '../../src/worker/port';
import type { WorkerIn, WorkerOut } from '../../src/worker/protocol';

// In-process fake spawner.
function fakeSpawner(): Promise<MainThreadPort> {
  let h: ((d: unknown) => void) | null = null;
  const port: MainThreadPort = {
    postMessage: (msg: unknown) => {
      const m = msg as WorkerIn;
      if (m.kind === 'solve') {
        setTimeout(() => {
          const result = runWorkerSolve(m.model, m.params, (obj, wall) => {
            h?.({ kind: 'incumbent', workerId: m.workerId, objectiveValue: obj, wallTime: wall } as WorkerOut);
          });
          h?.({ kind: 'done', workerId: m.workerId, ...result } as WorkerOut);
        }, 0);
      }
    },
    onMessage: (cb) => { h = cb; return () => { h = null; }; },
    onError: () => () => {},
    terminate: () => {},
  };
  return Promise.resolve(port);
}

describe('Portfolio vs direct solve', () => {
  it('portfolio(1 worker, seed S) == direct solve(seed S) on a simple model', async () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 7, 'x');
    const y = m.newIntVar(0, 7, 'y');
    m.addAllDifferent([x, y]);
    m.maximize(x.add(y));

    const seed = 5;
    const direct = new CpSolver();
    direct.parameters = { randomSeed: seed };
    direct.solve(m.clone());

    const portfolio = await solvePortfolio(m, {
      numWorkers: 1,
      strategies: [{ randomSeed: seed } as SolverParameters],
      spawner: fakeSpawner,
    });

    expect(portfolio.status).toBe(CpSolverStatus.OPTIMAL);
    expect(portfolio.objectiveValue).toBe(direct.objectiveValue);
  });

  it('portfolio(1 worker) == direct solve across multiple seeds', async () => {
    for (const seed of [1, 7, 42, 99]) {
      const m = new CpModel();
      const x = m.newIntVar(0, 10, 'x');
      const y = m.newIntVar(0, 10, 'y');
      const z = m.newIntVar(0, 10, 'z');
      m.addAllDifferent([x, y, z]);
      m.maximize(x.add(y).add(z));

      const direct = new CpSolver();
      direct.parameters = { randomSeed: seed };
      direct.solve(m.clone());

      const portfolio = await solvePortfolio(m, {
        numWorkers: 1,
        strategies: [{ randomSeed: seed } as SolverParameters],
        spawner: fakeSpawner,
      });

      expect(portfolio.objectiveValue).toBe(direct.objectiveValue);
    }
  });

  it('portfolio objective is never worse than direct solve on the same model', async () => {
    // Portfolio with multiple workers should find a solution at least as good
    // as a single-worker direct solve (diversified seeds explore more).
    const m = new CpModel();
    const x = m.newIntVar(0, 8, 'x');
    const y = m.newIntVar(0, 8, 'y');
    m.addAllDifferent([x, y]);
    m.maximize(x.add(y));

    const direct = new CpSolver();
    direct.parameters = { randomSeed: 1 };
    direct.solve(m.clone());

    const portfolio = await solvePortfolio(m, { numWorkers: 4, spawner: fakeSpawner });

    // Portfolio (maximize) should find >= direct's objective.
    expect(portfolio.objectiveValue).toBeGreaterThanOrEqual(direct.objectiveValue);
  });
});
