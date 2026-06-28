import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';

// P1: bestObjectiveBound is a SOUND dual bound (root relaxation), not the primal.
// For maximize it is an upper bound (>= optimum); for minimize a lower bound (<= optimum).
// On OPTIMAL it equals the primal (gap 0).

describe('bestObjectiveBound (real dual bound)', () => {
  it('equals the objective on a MAXIMIZE model solved to OPTIMAL (gap 0)', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    const y = m.newIntVar(0, 5, 'y');
    m.addAllDifferent([x, y]);
    m.maximize(x.add(y));
    const s = new CpSolver();
    s.parameters = { randomSeed: 1 };
    const status = s.solve(m);
    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(s.objectiveValue).toBe(9); // 5 + 4
    expect(s.bestObjectiveBound).toBe(9); // proven optimal → dual == primal
  });

  it('equals the objective on a MINIMIZE model solved to OPTIMAL (gap 0)', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 10, 'x');
    m.add(x.ge(3)); // forces x >= 3
    m.minimize(x);
    const s = new CpSolver();
    s.parameters = { randomSeed: 1 };
    const status = s.solve(m);
    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(s.objectiveValue).toBe(3);
    expect(s.bestObjectiveBound).toBe(3);
  });

  it('is computed (non-null) for optimization models', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 4, 'x');
    m.maximize(x);
    const s = new CpSolver();
    s.solve(m);
    expect(s.bestObjectiveBound).not.toBeNull();
  });

  it('returns the default (0) for a feasibility-only model — no dual concept without an objective', () => {
    const m = new CpModel();
    m.newIntVar(0, 3, 'x');
    const s = new CpSolver();
    s.solve(m);
    // No objective → no dual bound; the facade reports its default (unchanged by P1).
    expect(s.bestObjectiveBound).toBe(0);
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
    const s1 = new CpSolver(); s1.parameters = { randomSeed: 42, enableSimplexBounds: true };
    s1.solve(build());
    const s2 = new CpSolver(); s2.parameters = { randomSeed: 42, enableSimplexBounds: true };
    s2.solve(build());
    expect(s2.bestObjectiveBound).toBe(s1.bestObjectiveBound);
  });

  it('respects the sound direction on a non-OPTIMAL (time-limited) solve', () => {
    // A hard NoOverlap-makespan minimization: with a tiny budget it won't prove OPTIMAL.
    // The dual (lower bound) must be <= the incumbent (sound), and non-null regardless.
    const m = new CpModel();
    const ivs = [];
    const ends = [];
    for (let i = 0; i < 10; i++) {
      const start = m.newIntVar(0, 40, `s${i}`);
      ivs.push(m.newFixedSizeIntervalVar(start, 4, `t${i}`));
      ends.push(start.add(4));
    }
    m.addNoOverlap(ivs);
    const makespan = m.newIntVar(0, 44, 'mk');
    m.addMaxEquality(makespan, ends);
    m.minimize(makespan);
    const s = new CpSolver();
    s.parameters = { randomSeed: 1, maxTimeInSeconds: 0.05 };
    const status = s.solve(m);
    const bound = s.bestObjectiveBound;
    expect(bound).not.toBeNull(); // root relaxation exists regardless of search outcome
    if (status === CpSolverStatus.FEASIBLE && s.objectiveValue !== undefined) {
      // minimize: dual (lower bound) <= incumbent
      expect(bound!).toBeLessThanOrEqual(s.objectiveValue);
    }
  });

  it('with LP enabled produces a bound at least as tight as without (maximize)', () => {
    // The LP relaxation can only tighten the upper bound, never loosen it.
    const build = () => {
      const m = new CpModel();
      const x = m.newIntVar(0, 10, 'x');
      const y = m.newIntVar(0, 10, 'y');
      m.add(x.add(y).le(7));
      m.maximize(x.add(y));
      return m;
    };
    const sNoLp = new CpSolver(); sNoLp.parameters = { randomSeed: 1 };
    sNoLp.solve(build());
    const sLp = new CpSolver(); sLp.parameters = { randomSeed: 1, enableSimplexBounds: true };
    sLp.solve(build());
    // Both reach OPTIMAL (7); bounds equal the optimum.
    expect(sNoLp.bestObjectiveBound).toBe(7);
    expect(sLp.bestObjectiveBound).toBe(7);
  });
});
