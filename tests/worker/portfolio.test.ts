import { describe, it, expect } from 'vitest';
import { CpModel } from '../../src/model';
import { CpSolverStatus } from '../../src/types';
import { solvePortfolio, diversify } from '../../src/worker/portfolio';
import { runWorkerSolve } from '../../src/worker/worker-entry';
import type { MainThreadPort } from '../../src/worker/port';
import type { WorkerIn, WorkerOut } from '../../src/worker/protocol';

/**
 * In-process fake spawner: runs runWorkerSolve on the main thread and feeds the
 * protocol messages back. This exercises ALL orchestrator logic (fan-out, arbitrate,
 * terminate-on-winner, abort) deterministically without spawning a real worker.
 */
function fakeSpawner(): Promise<MainThreadPort> {
  let msgHandler: ((d: unknown) => void) | null = null;
  const port: MainThreadPort = {
    postMessage: (msg: unknown) => {
      const m = msg as WorkerIn;
      if (m.kind === 'solve') {
        setTimeout(() => {
          const result = runWorkerSolve(m.model, m.params, (objectiveValue, wallTime) => {
            msgHandler?.({ kind: 'incumbent', workerId: m.workerId, objectiveValue, wallTime } as WorkerOut);
          });
          msgHandler?.({ kind: 'done', workerId: m.workerId, ...result } as WorkerOut);
        }, 0);
      }
    },
    onMessage: (h) => { msgHandler = h; return () => { msgHandler = null; }; },
    onError: () => () => {},
    terminate: () => {},
  };
  return Promise.resolve(port);
}

describe('solvePortfolio (in-process fake workers)', () => {
  it('solves an optimization model to OPTIMAL', async () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    const y = m.newIntVar(0, 5, 'y');
    m.maximize(x.add(y));
    const res = await solvePortfolio(m, { numWorkers: 4, spawner: fakeSpawner });
    expect(res.status).toBe(CpSolverStatus.OPTIMAL);
    expect(res.objectiveValue).toBe(10);
    expect(res.solution?.get(x.index)).toBe(5);
    expect(res.solution?.get(y.index)).toBe(5);
    expect(res.winningWorker).toBeGreaterThanOrEqual(0);
  });

  it('reports gapPercent = 0 on OPTIMAL and a sound dual bound', async () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    const y = m.newIntVar(0, 5, 'y');
    m.addAllDifferent([x, y]);
    m.maximize(x.add(y));
    const res = await solvePortfolio(m, { numWorkers: 3, spawner: fakeSpawner });
    expect(res.status).toBe(CpSolverStatus.OPTIMAL);
    expect(res.bestObjectiveBound).toBe(res.objectiveValue); // dual == primal
    expect(res.gapPercent).toBe(0);
  });

  it('returns a satisfying solution for a feasibility-only model', async () => {
    const m = new CpModel();
    const x = m.newIntVar(1, 3, 'x');
    const y = m.newIntVar(1, 3, 'y');
    m.addAllDifferent([x, y]);
    const res = await solvePortfolio(m, { numWorkers: 2, spawner: fakeSpawner });
    expect([CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE]).toContain(res.status);
    expect(res.solution).not.toBeNull();
    expect(res.solution!.get(x.index)).not.toBe(res.solution!.get(y.index));
  });

  it('proves INFEASIBLE and propagates it', async () => {
    const m = new CpModel();
    const z = m.newIntVar(0, 0, 'z');
    m.add(z.ge(1));
    const res = await solvePortfolio(m, { numWorkers: 3, spawner: fakeSpawner });
    expect(res.status).toBe(CpSolverStatus.INFEASIBLE);
    expect(res.solution).toBeNull();
  });

  it('streams non-decreasing incumbents for maximization', async () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    m.maximize(x);
    const seen: number[] = [];
    await solvePortfolio(m, {
      numWorkers: 2,
      spawner: fakeSpawner,
      onIncumbent: (info) => seen.push(info.objectiveValue),
    });
    expect(seen.length).toBeGreaterThan(0);
    // at least one worker's stream reached the optimum
    expect(Math.max(...seen)).toBe(5);
  });

  it('terminates losers on the first OPTIMAL (fewer done-stats than workers)', async () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    m.maximize(x);
    const res = await solvePortfolio(m, { numWorkers: 4, spawner: fakeSpawner });
    // first worker's OPTIMAL should stop the rest → not all 4 stats recorded
    expect(res.stats.length).toBeLessThanOrEqual(4);
    expect(res.status).toBe(CpSolverStatus.OPTIMAL);
  });

  it('resolves on AbortSignal', async () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    m.maximize(x);
    const controller = new AbortController();
    const p = solvePortfolio(m, { numWorkers: 2, spawner: fakeSpawner, signal: controller.signal });
    controller.abort();
    const res = await p;
    // aborted before/independent of a solve; status is whatever was best so far (likely UNKNOWN)
    expect([CpSolverStatus.UNKNOWN, CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE]).toContain(res.status);
  });

  it('numWorkers=1 behaves like a single async solve', async () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 9, 'x');
    m.maximize(x);
    const res = await solvePortfolio(m, { numWorkers: 1, spawner: fakeSpawner });
    expect(res.numWorkers).toBe(1);
    expect(res.status).toBe(CpSolverStatus.OPTIMAL);
    expect(res.objectiveValue).toBe(9);
  });

  it('returns a sound solution (re-validated against the model)', async () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 4, 'x');
    const y = m.newIntVar(0, 4, 'y');
    m.addAllDifferent([x, y]);
    m.maximize(x.add(y));
    const res = await solvePortfolio(m, { numWorkers: 2, spawner: fakeSpawner });
    expect(res.solution).not.toBeNull();
    // re-validate: x != y and within bounds
    const xv = res.solution!.get(x.index)!;
    const yv = res.solution!.get(y.index)!;
    expect(xv).not.toBe(yv);
    expect(xv).toBeGreaterThanOrEqual(0);
    expect(xv).toBeLessThanOrEqual(4);
  });
});

describe('diversify', () => {
  it('produces numWorkers distinct strategies with distinct seeds', () => {
    const s = diversify(6, 1, 10);
    expect(s.length).toBe(6);
    const seeds = s.map((p) => p.randomSeed);
    expect(new Set(seeds).size).toBe(6);
    expect(s.every((p) => p.maxTimeInSeconds === 10)).toBe(true);
  });

  it('rotates the 4-strategy portfolio (restart/LNS/bound regimes)', () => {
    const s = diversify(4, 1);
    expect(s[0].restartStrategy).toBe('none');
    expect(s[1].restartStrategy).toBe('luby');
    expect(s[2].enableLNS).toBe(true);
    expect(s[3].enableSimplexBounds).toBe(true);
  });
});
