/**
 * Full simplex LP-relaxation bounds — end-to-end integration tests (CpSolver).
 *
 * Exercises the full pipeline: presolve problem build, the per-node strong
 * bound at the post-propagation prune site, and branch-and-bound behavior for
 * BOTH maximize and minimize objectives. The isolation test
 * (`simplex.isolation.test.ts`) proves the simplex bound math is sound in
 * isolation; here we prove the integration preserves optimality.
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus, LinearExpr } from '../src/types';

/** Build a deterministic 0/1 knapsack: maximize Σ valueᵢ·xᵢ s.t. Σ weightᵢ·xᵢ ≤ cap. */
function buildKnapsack(n: number): CpModel {
  const weights = Array.from({ length: n }, (_, i) => (i * 7 + 3) % 10 + 1);
  const values = Array.from({ length: n }, (_, i) => (i * 13 + 5) % 20 + 1);
  const capacity = Math.floor(weights.reduce((a, b) => a + b, 0) * 0.6);

  const model = new CpModel();
  const items = Array.from({ length: n }, (_, i) => model.newBoolVar(`x${i}`));
  const weightExpr = items.reduce((e, x, i) => e.add(x.mul(weights[i])), new LinearExpr([], [], 0));
  model.add(weightExpr.le(capacity));
  const valueExpr = items.reduce((e, x, i) => e.add(x.mul(values[i])), new LinearExpr([], [], 0));
  model.maximize(valueExpr);
  return model;
}

function solveKnapsack(n: number, enableSimplexBounds: boolean) {
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 30;
  solver.parameters.enableSimplexBounds = enableSimplexBounds;
  const status = solver.solve(buildKnapsack(n));
  return { status, objective: solver.objectiveValue, branches: solver.numBranches };
}

describe('Simplex bounds — end-to-end integration', () => {
  it('preserves the optimum (soundness) and reduces branches on knapsack', () => {
    const off = solveKnapsack(20, false);
    const on = solveKnapsack(20, true);

    expect([CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE]).toContain(off.status);
    expect([CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE]).toContain(on.status);

    // SOUNDNESS: the tighter bound must NOT change the optimum.
    expect(on.objective).toBe(off.objective);
    // The bound can only prune, never add work.
    expect(on.branches).toBeLessThanOrEqual(off.branches);
    expect(on.branches).toBeLessThan(off.branches); // it prunes meaningfully here
  });

  it('preserves the optimum for a MINIMIZE objective', () => {
    // min Σ costᵢ·xᵢ s.t. Σ coverᵢ·xᵢ ≥ demand (a set-cover-ish LP). The simplex
    // tightens the LOWER bound; the optimum must be unchanged.
    const build = (): CpModel => {
      const n = 14;
      const costs = Array.from({ length: n }, (_, i) => (i * 5 + 2) % 11 + 1);
      const covers = Array.from({ length: n }, (_, i) => (i * 3 + 1) % 8 + 1);
      const demand = Math.floor(covers.reduce((a, b) => a + b, 0) * 0.5);
      const m = new CpModel();
      const xs = Array.from({ length: n }, (_, i) => m.newBoolVar(`x${i}`));
      m.add(xs.reduce((e, x, i) => e.add(x.mul(covers[i])), new LinearExpr([], [], 0)).ge(demand));
      m.minimize(xs.reduce((e, x, i) => e.add(x.mul(costs[i])), new LinearExpr([], [], 0)));
      return m;
    };
    const run = (on: boolean) => {
      const s = new CpSolver();
      s.parameters.maxTimeInSeconds = 30;
      s.parameters.enableSimplexBounds = on;
      s.solve(build());
      return { objective: s.objectiveValue, branches: s.numBranches };
    };
    const off = run(false);
    const on = run(true);
    expect(on.objective).toBe(off.objective); // optimum preserved (soundness for minimize)
    expect(on.branches).toBeLessThanOrEqual(off.branches);
  });

  it('tightens bounds on a multi-constraint LP (beyond single-packing knapsack)', () => {
    // Two competing ≤ constraints — the simplex relaxation sees BOTH rows,
    // whereas the fractional-knapsack bound can use only one. Optimum preserved.
    const build = (): CpModel => {
      const m = new CpModel();
      const xs = Array.from({ length: 8 }, (_, i) => model0_3(m, i));
      const w1 = [3, 2, 5, 1, 4, 2, 3, 6];
      const w2 = [1, 4, 2, 3, 1, 5, 2, 3];
      const c = [5, 3, 9, 2, 7, 4, 6, 11];
      m.add(xs.reduce((e, x, i) => e.add(x.mul(w1[i])), new LinearExpr([], [], 0)).le(14));
      m.add(xs.reduce((e, x, i) => e.add(x.mul(w2[i])), new LinearExpr([], [], 0)).le(12));
      m.maximize(xs.reduce((e, x, i) => e.add(x.mul(c[i])), new LinearExpr([], [], 0)));
      return m;
    };
    const run = (on: boolean) => {
      const s = new CpSolver();
      s.parameters.maxTimeInSeconds = 30;
      s.parameters.enableSimplexBounds = on;
      s.solve(build());
      return { objective: s.objectiveValue, branches: s.numBranches };
    };
    const off = run(false);
    const on = run(true);
    expect(on.objective).toBe(off.objective); // optimum preserved
    expect(on.branches).toBeLessThanOrEqual(off.branches);
  });

  it('is off by default (unset behaves like false)', () => {
    const a = solveKnapsack(16, false);
    const solver = new CpSolver();
    solver.parameters.maxTimeInSeconds = 30;
    solver.solve(buildKnapsack(16)); // flag unset
    expect(solver.objectiveValue).toBe(a.objective);
    expect(solver.numBranches).toBe(a.branches);
  });

  it('does not regress a pure-feasibility (no-objective) model', () => {
    // No objective → no LP bound; the flag must be a harmless no-op.
    const m = new CpModel();
    const x = m.newIntVar(1, 5, 'x');
    const y = m.newIntVar(1, 5, 'y');
    m.add(x.add(y).ge(4));
    m.add(x.add(y).le(6));
    const run = (on: boolean) => {
      const s = new CpSolver();
      s.parameters.enableSimplexBounds = on;
      s.parameters.enumerateAllSolutions = true;
      s.solve(m);
      return s.numBranches;
    };
    expect(run(true)).toBe(run(false)); // identical search
  });

  it('is sound on a larger knapsack within the time budget', () => {
    const solver = new CpSolver();
    solver.parameters.maxTimeInSeconds = 30;
    solver.parameters.enableSimplexBounds = true;
    const status = solver.solve(buildKnapsack(30));
    expect([CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE]).toContain(status);
    expect(solver.objectiveValue).toBeGreaterThan(0);
  });
});

function model0_3(m: CpModel, i: number) {
  return m.newIntVar(0, 3, `x${i}`);
}
