/**
 * CP-SAT TypeScript Tests
 * Tests for scheduling constraints: NoOverlap and Cumulative
 *
 * Note: The solver engine does not propagate NoOverlap/Cumulative constraints,
 * so tests use small domains to avoid long search times.
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';

describe('Scheduling Constraints', () => {
  describe('NoOverlap', () => {
    it('should schedule two non-overlapping tasks', () => {
      const model = new CpModel();

      const start1 = model.newIntVar(0, 5, 'start1');
      const start2 = model.newIntVar(0, 5, 'start2');

      const iv1 = model.newFixedSizeIntervalVar(start1, 3, 'task1');
      const iv2 = model.newFixedSizeIntervalVar(start2, 3, 'task2');

      model.addNoOverlap([iv1, iv2]);

      const solver = new CpSolver();
      solver.parameters.maxTimeInSeconds = 5;
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);

      const s1 = solver.value(start1);
      const s2 = solver.value(start2);
      // Tasks must not overlap
      expect(s1 + 3 <= s2 || s2 + 3 <= s1).toBe(true);
    });

    it('should handle fixed-size intervals', () => {
      const model = new CpModel();

      const start1 = model.newIntVar(0, 3, 'start1');
      const start2 = model.newIntVar(0, 3, 'start2');

      const iv1 = model.newFixedSizeIntervalVar(start1, 2, 'task1');
      const iv2 = model.newFixedSizeIntervalVar(start2, 2, 'task2');

      model.addNoOverlap([iv1, iv2]);

      const solver = new CpSolver();
      solver.parameters.maxTimeInSeconds = 5;
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);

      const s1 = solver.value(start1);
      const s2 = solver.value(start2);
      expect(s1 + 2 <= s2 || s2 + 2 <= s1).toBe(true);
    });
  });

  describe('Cumulative', () => {
    it('should enforce capacity on overlapping tasks', () => {
      const model = new CpModel();

      const start1 = model.newIntVar(0, 3, 'start1');
      const start2 = model.newIntVar(0, 3, 'start2');

      const iv1 = model.newFixedSizeIntervalVar(start1, 3, 'task1');
      const iv2 = model.newFixedSizeIntervalVar(start2, 3, 'task2');

      // Force both to start at 0
      model.add(start1.eq(0));
      model.add(start2.eq(0));

      // Demand 3+3=6 > capacity 5 → infeasible when overlapping
      model.addCumulative([iv1, iv2], [3, 3], 5);

      const solver = new CpSolver();
      solver.parameters.maxTimeInSeconds = 5;
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });

    it('should allow overlapping tasks within capacity', () => {
      const model = new CpModel();

      const start1 = model.newIntVar(0, 3, 'start1');
      const start2 = model.newIntVar(0, 3, 'start2');

      const iv1 = model.newFixedSizeIntervalVar(start1, 3, 'task1');
      const iv2 = model.newFixedSizeIntervalVar(start2, 3, 'task2');

      // Force both to start at 0
      model.add(start1.eq(0));
      model.add(start2.eq(0));

      // Demand 2+2=4 <= capacity 5 → feasible
      model.addCumulative([iv1, iv2], [2, 2], 5);

      const solver = new CpSolver();
      solver.parameters.maxTimeInSeconds = 5;
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(start1)).toBe(0);
      expect(solver.value(start2)).toBe(0);
    });
  });
});

describe('Scheduling Constraints - edge cases', () => {
  describe('NoOverlap infeasibility with 3 intervals', () => {
    it('should detect infeasibility when 3 intervals forced to same start', () => {
      const model = new CpModel();

      // All forced to start at 0, sizes 2, 2, 2 — can't avoid overlap
      const s1 = model.newIntVar(0, 0, 's1');
      const s2 = model.newIntVar(0, 0, 's2');
      const s3 = model.newIntVar(0, 0, 's3');

      const iv1 = model.newFixedSizeIntervalVar(s1, 2, 't1');
      const iv2 = model.newFixedSizeIntervalVar(s2, 2, 't2');
      const iv3 = model.newFixedSizeIntervalVar(s3, 2, 't3');

      model.addNoOverlap([iv1, iv2, iv3]);

      const solver = new CpSolver();
      solver.parameters.maxTimeInSeconds = 5;
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });
  });

  describe('NoOverlap with 3 intervals - feasible', () => {
    it('should find feasible sequence for 3 non-overlapping tasks', () => {
      const model = new CpModel();

      // Small domains so brute-force search is fast
      const s1 = model.newIntVar(0, 4, 's1');
      const s2 = model.newIntVar(0, 4, 's2');
      const s3 = model.newIntVar(0, 4, 's3');

      const iv1 = model.newFixedSizeIntervalVar(s1, 2, 't1');
      const iv2 = model.newFixedSizeIntervalVar(s2, 2, 't2');
      const iv3 = model.newFixedSizeIntervalVar(s3, 2, 't3');

      model.addNoOverlap([iv1, iv2, iv3]);

      const solver = new CpSolver();
      solver.parameters.maxTimeInSeconds = 5;
      const status = solver.solve(model);

      // Solver should find a feasible schedule
      expect([CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE]).toContain(status);
    });
  });

  describe('Cumulative with 3 tasks', () => {
    it('should schedule 3 tasks respecting capacity', () => {
      const model = new CpModel();

      // Small domains for brute-force feasibility
      const s1 = model.newIntVar(0, 4, 's1');
      const s2 = model.newIntVar(0, 4, 's2');
      const s3 = model.newIntVar(0, 4, 's3');

      const iv1 = model.newFixedSizeIntervalVar(s1, 2, 't1');
      const iv2 = model.newFixedSizeIntervalVar(s2, 2, 't2');
      const iv3 = model.newFixedSizeIntervalVar(s3, 2, 't3');

      // Capacity 4, each task demand 3 — at most 1 can run at a time
      model.addCumulative([iv1, iv2, iv3], [3, 3, 3], 4);

      const solver = new CpSolver();
      solver.parameters.maxTimeInSeconds = 5;
      const status = solver.solve(model);

      // Should find a valid schedule where tasks don't overlap
      expect([CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE]).toContain(status);
    });
  });

  describe('optional intervals (presence literal)', () => {
    it('should handle optional interval that is absent', () => {
      const model = new CpModel();

      const s1 = model.newIntVar(0, 10, 's1');
      const s2 = model.newIntVar(0, 10, 's2');
      const present = model.newBoolVar('present');

      // s2 is optional — when present=false, interval is ignored
      const iv1 = model.newFixedSizeIntervalVar(s1, 5, 't1');
      const iv2 = model.newOptionalIntervalVar(s2, 5, present, 't2');

      // Force present = false
      model.add(present.le(0));

      // NoOverlap — iv2 is absent so only iv1 matters
      model.addNoOverlap([iv1, iv2]);

      const solver = new CpSolver();
      solver.parameters.maxTimeInSeconds = 5;
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.booleanValue(present)).toBe(false);
    });

    it('should handle optional interval that is present', () => {
      const model = new CpModel();

      const s1 = model.newIntVar(0, 10, 's1');
      const s2 = model.newIntVar(0, 10, 's2');
      const present = model.newBoolVar('present');

      const iv1 = model.newFixedSizeIntervalVar(s1, 3, 't1');
      const iv2 = model.newOptionalIntervalVar(s2, 3, present, 't2');

      // Force present = true
      model.addBoolAnd([present]);

      // NoOverlap — both intervals must not overlap
      model.addNoOverlap([iv1, iv2]);

      const solver = new CpSolver();
      solver.parameters.maxTimeInSeconds = 5;
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.booleanValue(present)).toBe(true);

      // Verify no overlap
      const v1 = solver.value(s1);
      const v2 = solver.value(s2);
      expect(v1 + 3 <= v2 || v2 + 3 <= v1).toBe(true);
    });
  });
});
