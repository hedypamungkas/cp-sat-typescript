/**
 * LP-Relaxation Bounds — end-to-end integration tests (through CpSolver).
 *
 * These exercise the full pipeline: presolve detection, the per-node strong
 * bound at the post-propagation prune site, and branch-and-bound behavior.
 * The isolation tests (lp-bounds.isolation.test.ts) prove the bound math is
 * sound in isolation; here we prove the *integration* preserves optimality.
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus, LinearExpr } from '../src/types';

interface SolveResult {
  status: CpSolverStatus;
  objective: number;
  branches: number;
}

/** Build a deterministic 0/1 knapsack: maximize Σ valueᵢ·xᵢ s.t. Σ weightᵢ·xᵢ ≤ cap. */
function buildKnapsack(n: number): CpModel {
  const weights = Array.from({ length: n }, (_, i) => (i * 7 + 3) % 10 + 1);
  const values = Array.from({ length: n }, (_, i) => (i * 13 + 5) % 20 + 1);
  const capacity = Math.floor(weights.reduce((a, b) => a + b, 0) * 0.6);

  const model = new CpModel();
  const items = Array.from({ length: n }, (_, i) => model.newBoolVar(`x${i}`));
  const weightExpr = items.reduce(
    (e, x, i) => e.add(x.mul(weights[i])),
    new LinearExpr([], [], 0)
  );
  model.add(weightExpr.le(capacity));
  const valueExpr = items.reduce(
    (e, x, i) => e.add(x.mul(values[i])),
    new LinearExpr([], [], 0)
  );
  model.maximize(valueExpr);
  return model;
}

function solveKnapsack(n: number, enableLpBounds: boolean): SolveResult {
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 30;
  solver.parameters.enableLpBounds = enableLpBounds;
  const status = solver.solve(buildKnapsack(n));
  return {
    status,
    objective: solver.objectiveValue,
    branches: solver.numBranches,
  };
}

describe('LP bounds — end-to-end integration', () => {
  it('preserves the optimum (soundness) and reduces branches on knapsack', () => {
    const off = solveKnapsack(20, false);
    const on = solveKnapsack(20, true);

    // Both must reach a solution.
    expect([CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE]).toContain(off.status);
    expect([CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE]).toContain(on.status);

    // SOUNDNESS (integration): the tighter bound must NOT change the optimum.
    expect(on.objective).toBe(off.objective);

    // The bound can only prune, never add work.
    expect(on.branches).toBeLessThanOrEqual(off.branches);
    // And on this (loose interval-bound) knapsack it prunes meaningfully.
    expect(on.branches).toBeLessThan(off.branches);
  });

  it('is a no-op for a MINIMIZE objective (bound unchanged)', () => {
    // Same knapsack but minimize the negated value → no maximize packing bound applies.
    const run = (enableLpBounds: boolean): number => {
      const weights = Array.from({ length: 12 }, (_, i) => (i * 7 + 3) % 10 + 1);
      const values = Array.from({ length: 12 }, (_, i) => (i * 13 + 5) % 20 + 1);
      const capacity = Math.floor(weights.reduce((a, b) => a + b, 0) * 0.6);
      const model = new CpModel();
      const items = Array.from({ length: 12 }, (_, i) => model.newBoolVar(`x${i}`));
      model.add(items.reduce((e, x, i) => e.add(x.mul(weights[i])), new LinearExpr([], [], 0)).le(capacity));
      model.minimize(items.reduce((e, x, i) => e.add(x.mul(values[i])), new LinearExpr([], [], 0)));
      const solver = new CpSolver();
      solver.parameters.maxTimeInSeconds = 30;
      solver.parameters.enableLpBounds = enableLpBounds;
      solver.solve(model);
      return solver.numBranches;
    };
    // No-op: identical search (deterministic), so identical branch count.
    expect(run(true)).toBe(run(false));
  });

  it('is a no-op for a maximize model with no packing constraint', () => {
    // Maximize x (no constraint) → nothing to detect → interval bound only.
    const run = (enableLpBounds: boolean): number => {
      const model = new CpModel();
      const x = model.newIntVar(0, 50, 'x');
      model.maximize(x);
      const solver = new CpSolver();
      solver.parameters.maxTimeInSeconds = 10;
      solver.parameters.enableLpBounds = enableLpBounds;
      solver.solve(model);
      return solver.numBranches;
    };
    expect(run(true)).toBe(run(false));
  });

  it('handles bounded-integer (non-bool) packing variables', () => {
    // max Σ cᵢxᵢ s.t. Σ wᵢxᵢ ≤ W, xᵢ ∈ [0, 3]. Optimum must be identical on/off.
    const build = (): CpModel => {
      const model = new CpModel();
      const xs = Array.from({ length: 8 }, (_, i) => model.newIntVar(0, 3, `x${i}`));
      const weights = [3, 2, 5, 1, 4, 2, 3, 6];
      const coeffs = [5, 3, 9, 2, 7, 4, 6, 11];
      model.add(xs.reduce((e, x, i) => e.add(x.mul(weights[i])), new LinearExpr([], [], 0)).le(14));
      model.maximize(xs.reduce((e, x, i) => e.add(x.mul(coeffs[i])), new LinearExpr([], [], 0)));
      return model;
    };
    const solve = (lp: boolean): number => {
      const solver = new CpSolver();
      solver.parameters.maxTimeInSeconds = 30;
      solver.parameters.enableLpBounds = lp;
      solver.solve(build());
      return solver.objectiveValue;
    };
    expect(solve(true)).toBe(solve(false)); // optimum preserved
  });

  it('scales to a larger knapsack within the time budget', () => {
    const solver = new CpSolver();
    solver.parameters.maxTimeInSeconds = 30;
    solver.parameters.enableLpBounds = true;
    const status = solver.solve(buildKnapsack(30));
    expect([CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE]).toContain(status);
    // Sanity: at least some value selected.
    expect(solver.objectiveValue).toBeGreaterThan(0);
  });

  it('is off by default (enableLpBounds unset behaves like false)', () => {
    // Unset must equal explicitly-false: same branches.
    const a = solveKnapsack(16, false);
    const solver = new CpSolver();
    solver.parameters.maxTimeInSeconds = 30;
    solver.solve(buildKnapsack(16));
    const unset = { branches: solver.numBranches, objective: solver.objectiveValue };
    expect(unset.branches).toBe(a.branches);
    expect(unset.objective).toBe(a.objective);
  });
});
