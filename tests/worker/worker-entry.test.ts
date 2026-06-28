import { describe, it, expect } from 'vitest';
import { CpModel } from '../../src/model';
import { CpSolver } from '../../src/solver';
import { CpSolverStatus } from '../../src/types';
import { runWorkerSolve } from '../../src/worker/worker-entry';

// runWorkerSolve is the pure worker body (rebuild-from-JSON + solve). It must agree
// with a direct in-process solve on the same model/params.
function directSolve(build: () => CpModel, params: { randomSeed?: number } = { randomSeed: 1 }) {
  const m = build();
  const s = new CpSolver();
  s.parameters = params;
  const status = s.solve(m);
  return { status, objectiveValue: s.objectiveValue };
}

describe('runWorkerSolve (worker body, in-process)', () => {
  it('solves an optimization model identically to a direct solve', () => {
    const build = () => {
      const m = new CpModel();
      const x = m.newIntVar(0, 5, 'x');
      const y = m.newIntVar(0, 5, 'y');
      m.maximize(x.add(y));
      return m;
    };
    const direct = directSolve(build);
    const m = build();
    const res = runWorkerSolve(m.toJSON(), { randomSeed: 1 });
    expect(res.status).toBe(direct.status);
    expect(res.objectiveValue).toBe(direct.objectiveValue);
    expect(res.solution).not.toBeNull();
    expect(res.solution!['0']).toBe(5); // x
    expect(res.solution!['1']).toBe(5); // y
  });

  it('streams incumbents via the callback', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    m.maximize(x);
    const incumbents: number[] = [];
    const res = runWorkerSolve(m.toJSON(), { randomSeed: 1 }, (obj) => incumbents.push(obj));
    expect(res.status).toBe(CpSolverStatus.OPTIMAL);
    expect(incumbents.length).toBeGreaterThan(0);
    // objective should be non-decreasing for a maximization
    for (let i = 1; i < incumbents.length; i++) {
      expect(incumbents[i]).toBeGreaterThanOrEqual(incumbents[i - 1]);
    }
    expect(Math.max(...incumbents)).toBe(5);
  });

  it('reports INFEASIBLE for an infeasible model', () => {
    const m = new CpModel();
    const z = m.newIntVar(0, 0, 'z'); // fixed 0
    m.add(z.ge(1));                   // must be >= 1 → infeasible
    const res = runWorkerSolve(m.toJSON(), { randomSeed: 1 });
    expect(res.status).toBe(CpSolverStatus.INFEASIBLE);
    expect(res.solution).toBeNull();
  });

  it('is deterministic given the same seed', () => {
    const build = () => {
      const m = new CpModel();
      const x = m.newIntVar(0, 7, 'x');
      const y = m.newIntVar(0, 7, 'y');
      m.addAllDifferent([x, y]);
      m.maximize(x.add(y));
      return m;
    };
    const r1 = runWorkerSolve(build().toJSON(), { randomSeed: 42 });
    const r2 = runWorkerSolve(build().toJSON(), { randomSeed: 42 });
    expect(r2.objectiveValue).toBe(r1.objectiveValue);
    expect(r2.stats.numBranches).toBe(r1.stats.numBranches);
  });

  it('reports a sound dual bound (>= primal for maximize on OPTIMAL)', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    const y = m.newIntVar(0, 5, 'y');
    m.addAllDifferent([x, y]);
    m.maximize(x.add(y));
    const res = runWorkerSolve(m.toJSON(), { randomSeed: 1 });
    expect(res.status).toBe(CpSolverStatus.OPTIMAL);
    expect(res.bestObjectiveBound).not.toBeNull();
    // On OPTIMAL, dual == primal.
    expect(res.bestObjectiveBound).toBe(res.objectiveValue);
  });
});
