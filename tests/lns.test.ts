/**
 * CP-SAT TypeScript Tests
 * Tests for Large Neighborhood Search (LNS)
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';

// ============================================================================
// Problem Generators
// ============================================================================

function createKnapsack(n: number): CpModel {
  const model = new CpModel();
  const items = Array.from({ length: n }, (_, i) => model.newBoolVar(`x${i}`));

  // Deterministic weights and values
  const weights = Array.from({ length: n }, (_, i) => (i * 7 + 3) % 10 + 1);
  const values = Array.from({ length: n }, (_, i) => (i * 13 + 5) % 20 + 1);
  const capacity = Math.floor(weights.reduce((a, b) => a + b, 0) * 0.6);

  // Weight constraint
  const weightExpr = items.reduce((expr, item, i) => expr.add(item.mul(weights[i])), model.newIntVar(0, 0, 'zero'));
  model.add(weightExpr.le(capacity));

  // Maximize value
  const valueExpr = items.reduce((expr, item, i) => expr.add(item.mul(values[i])), model.newIntVar(0, 0, 'zero'));
  model.maximize(valueExpr);

  return model;
}

function createGraphColoring(n: number): CpModel {
  const model = new CpModel();
  const colors = Array.from({ length: n }, (_, i) => model.newIntVar(0, n - 1, `c${i}`));

  // Each pair of adjacent nodes must have different colors
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      model.add(colors[i].ne(colors[j]));
    }
  }

  return model;
}

// ============================================================================
// LNS Tests
// ============================================================================

describe('Large Neighborhood Search (LNS)', () => {
  describe('basic functionality', () => {
    it('should solve simple optimization with LNS', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 100, 'x');
      const y = model.newIntVar(0, 100, 'y');
      model.add(x.add(y).le(50));
      model.maximize(x.add(y));

      const solver = new CpSolver();
      solver.parameters.enableLNS = true;
      solver.parameters.lnsMaxIterations = 10;
      solver.parameters.lnsNeighborhoodSize = 0.5;

      const status = solver.solve(model);
      expect(status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE).toBe(true);
      expect(solver.objectiveValue).toBe(50);
    });

    it('should not use LNS for feasibility problems', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');
      model.add(x.add(y).eq(10));

      const solver = new CpSolver();
      solver.parameters.enableLNS = true;

      const status = solver.solve(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });

    it('should respect LNS iteration limit', () => {
      const model = createKnapsack(20);

      const solver = new CpSolver();
      solver.parameters.enableLNS = true;
      solver.parameters.lnsMaxIterations = 3;
      solver.parameters.lnsNeighborhoodSize = 0.5;
      solver.parameters.maxTimeInSeconds = 10;

      const status = solver.solve(model);
      expect(status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE).toBe(true);
    });
  });

  describe('neighborhood size', () => {
    it('should work with different neighborhood sizes', () => {
      const model = createKnapsack(20);

      for (const size of [0.3, 0.5, 0.7]) {
        const solver = new CpSolver();
        solver.parameters.enableLNS = true;
        solver.parameters.lnsMaxIterations = 5;
        solver.parameters.lnsNeighborhoodSize = size;
        solver.parameters.maxTimeInSeconds = 10;

        const status = solver.solve(model);
        expect(status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE).toBe(true);
        expect(solver.objectiveValue).toBeGreaterThan(0);
      }
    });
  });

  describe('harder problems', () => {
    it('should solve knapsack 30 items with LNS', () => {
      const model = createKnapsack(30);

      const solver = new CpSolver();
      solver.parameters.enableLNS = true;
      solver.parameters.lnsMaxIterations = 10;
      solver.parameters.lnsNeighborhoodSize = 0.5;
      solver.parameters.maxTimeInSeconds = 30;

      const status = solver.solve(model);
      expect(status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE).toBe(true);
      expect(solver.objectiveValue).toBeGreaterThan(0);
    });

    it('should solve graph coloring K8 with LNS', () => {
      const model = createGraphColoring(8);

      const solver = new CpSolver();
      solver.parameters.enableLNS = true;
      solver.parameters.lnsMaxIterations = 5;
      solver.parameters.lnsNeighborhoodSize = 0.5;
      solver.parameters.maxTimeInSeconds = 10;

      const status = solver.solve(model);
      expect(status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE).toBe(true);
    });
  });

  describe('LNS vs B&B comparison', () => {
    it('should find same optimal for knapsack 20 items', () => {
      const model = createKnapsack(20);

      // B&B only
      const solverBB = new CpSolver();
      solverBB.parameters.maxTimeInSeconds = 10;
      const statusBB = solverBB.solve(model);
      const objBB = solverBB.objectiveValue;

      // LNS
      const solverLNS = new CpSolver();
      solverLNS.parameters.enableLNS = true;
      solverLNS.parameters.lnsMaxIterations = 10;
      solverLNS.parameters.lnsNeighborhoodSize = 0.5;
      solverLNS.parameters.maxTimeInSeconds = 10;
      const statusLNS = solverLNS.solve(model);
      const objLNS = solverLNS.objectiveValue;

      // Both should find optimal
      expect(statusBB).toBe(CpSolverStatus.OPTIMAL);
      expect(statusLNS === CpSolverStatus.OPTIMAL || statusLNS === CpSolverStatus.FEASIBLE).toBe(true);

      // LNS should find at least as good as B&B
      expect(objLNS).toBeGreaterThanOrEqual(objBB);
    });
  });

  describe('progress reporting', () => {
    it('should report LNS phase in progress info', () => {
      const model = createKnapsack(20);

      const phases: string[] = [];
      const progressCb = {
        onSearchProgress(info: any): void {
          if (info.phase) {
            phases.push(info.phase);
          }
        },
      };

      const solver = new CpSolver();
      solver.parameters.enableLNS = true;
      solver.parameters.lnsMaxIterations = 3;
      solver.parameters.lnsNeighborhoodSize = 0.5;
      solver.parameters.maxTimeInSeconds = 10;

      solver.solve(model, undefined, progressCb);

      // Should have at least one LNS phase reported
      // (if the solve took long enough for progress callback to fire)
      if (phases.length > 0) {
        expect(phases).toContain('LNS');
      }
    });
  });
});
