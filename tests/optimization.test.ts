/**
 * CP-SAT TypeScript Tests
 * Tests for optimization correctness (minimize/maximize)
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';

describe('Optimization', () => {
  describe('maximize', () => {
    it('should find optimal for simple maximize', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      // Maximize x + y, subject to x + y <= 10
      model.add(x.add(y).le(10));
      model.maximize(x.add(y));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.objectiveValue).toBe(10);
      expect(solver.value(x) + solver.value(y)).toBe(10);
    });

    it('should find optimal for maximize with multiple constraints', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 50, 'x');
      const y = model.newIntVar(0, 50, 'y');
      const z = model.newIntVar(0, 50, 'z');

      // Maximize 2x + 2y + 3z
      model.add(x.mul(2).add(y.mul(7)).add(z.mul(3)).le(50));
      model.add(x.mul(3).sub(y.mul(5)).add(z.mul(7)).le(45));
      model.add(x.mul(5).add(y.mul(2)).sub(z.mul(6)).le(37));
      model.maximize(x.mul(2).add(y.mul(2)).add(z.mul(3)));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      // Brute-force optimal: x=7, y=3, z=5, obj=35
      expect(solver.objectiveValue).toBe(35);
    });

    it('should find optimal with x + 2y maximize', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      // x + y >= 8, maximize x + 2y
      model.add(x.add(y).ge(8));
      model.maximize(x.add(y.mul(2)));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      // maximize x+2y with x+y>=8, x,y in [0,10]
      // Best: x=10, y=10 → obj=10+20=30
      expect(solver.objectiveValue).toBe(30);
    });
  });

  describe('minimize', () => {
    it('should find optimal for simple minimize', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');

      model.minimize(x);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.objectiveValue).toBe(0);
      expect(solver.value(x)).toBe(0);
    });

    it('should find optimal for minimize with lower bound constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');

      model.add(x.ge(5));
      model.minimize(x);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.objectiveValue).toBe(5);
    });

    it('should find optimal for minimize x + 2y with constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      // x + y >= 8, minimize x + 2y
      model.add(x.add(y).ge(8));
      model.minimize(x.add(y.mul(2)));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      // Best: x=8, y=0 → obj=8
      expect(solver.objectiveValue).toBe(8);
    });
  });

  describe('infeasible', () => {
    it('should detect infeasible optimization problem', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');

      model.add(x.ge(15)); // x >= 15 but domain is [0, 10]
      model.maximize(x);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });
  });

  describe('feasibility (no objective)', () => {
    it('should return OPTIMAL for pure feasibility', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      model.add(x.add(y).eq(10));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(x) + solver.value(y)).toBe(10);
    });
  });
});

describe('Optimization - edge cases', () => {
  describe('negative coefficients in objective', () => {
    it('should maximize with negative coefficients', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      // Maximize -(x + y) = minimize x + y
      model.maximize(x.mul(-1).add(y.mul(-1)));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      // Best: x=0, y=0 → obj = 0 (may be -0)
      expect(solver.objectiveValue).toBeCloseTo(0);
    });

    it('should minimize with negative coefficients', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      // Minimize -(x + y) = maximize x + y
      model.minimize(x.mul(-1).add(y.mul(-1)));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      // Best: x=10, y=10 → obj = -20
      expect(solver.objectiveValue).toBe(-20);
    });
  });

  describe('objective equals bound exactly', () => {
    it('should find exact bound for minimize', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');

      model.add(x.ge(5));
      model.minimize(x);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.objectiveValue).toBe(5);
    });

    it('should find exact bound for maximize', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');

      model.add(x.le(7));
      model.maximize(x);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.objectiveValue).toBe(7);
    });
  });

  describe('bestObjectiveBound', () => {
    it('should report consistent bestObjectiveBound for maximization', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');

      model.add(x.le(8));
      model.maximize(x);

      const solver = new CpSolver();
      solver.solve(model);

      // The bound should be >= the objective value
      expect(solver.bestObjectiveBound).toBeGreaterThanOrEqual(solver.objectiveValue);
    });

    it('should report consistent bestObjectiveBound for minimization', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');

      model.add(x.ge(3));
      model.minimize(x);

      const solver = new CpSolver();
      solver.solve(model);

      // The bound should be <= the objective value
      expect(solver.bestObjectiveBound).toBeLessThanOrEqual(solver.objectiveValue);
    });
  });

  describe('optimization with AllDifferent', () => {
    it('should maximize sum with allDifferent constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 3, 'x');
      const y = model.newIntVar(0, 3, 'y');
      const z = model.newIntVar(0, 3, 'z');

      model.addAllDifferent([x, y, z]);
      model.maximize(x.add(y).add(z));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      // Best: 3+2+1 = 6
      expect(solver.objectiveValue).toBe(6);
      const values = [solver.value(x), solver.value(y), solver.value(z)];
      expect(new Set(values).size).toBe(3); // all different
    });

    it('should minimize sum with allDifferent constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 3, 'x');
      const y = model.newIntVar(0, 3, 'y');
      const z = model.newIntVar(0, 3, 'z');

      model.addAllDifferent([x, y, z]);
      model.minimize(x.add(y).add(z));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      // Best: 0+1+2 = 3
      expect(solver.objectiveValue).toBe(3);
    });
  });

  describe('optimization with boolean variables', () => {
    it('should maximize boolean sum', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const c = model.newBoolVar('c');

      model.addAtMostOne([a, b, c]);
      model.maximize(a.add(b).add(c));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.objectiveValue).toBe(1); // AtMostOne → max 1
    });
  });
});
