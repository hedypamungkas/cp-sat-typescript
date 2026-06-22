/**
 * CP-SAT TypeScript Tests
 * Tests for UNSAT core extraction via sufficientAssumptionsForInfeasibility()
 *
 * The UNSAT core is the minimal subset of assumption literals that together
 * make the model infeasible. The core is extracted by walking the reason trail
 * backward from the point of infeasibility.
 *
 * Reason tracking is implemented for: BoolOr, BoolAnd, AtMostOne, ExactlyOne,
 * Implication, BoolXor, Linear, NotEqual, AllDifferent, MaxEquality,
 * MinEquality, DivisionEquality, Element, AbsEquality, AllowedAssignments,
 * ForbiddenAssignments.
 *
 * CURRENT LIMITATIONS:
 * - Scheduling propagators (NoOverlap, Cumulative, Circuit, etc.) don't track
 *   reasons yet.
 * - Negated assumption literals are not supported.
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';

describe('UNSAT Core — sufficientAssumptionsForInfeasibility', () => {
  describe('basic functionality', () => {
    it('should return empty array when no assumptions', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      model.add(x.eq(5));

      const solver = new CpSolver();
      solver.solve(model);

      expect(solver.sufficientAssumptionsForInfeasibility()).toEqual([]);
    });

    it('should return empty array when model is feasible', () => {
      const model = new CpModel();
      const b = model.newBoolVar('b');
      model.addAssumption(b);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).not.toBe(CpSolverStatus.INFEASIBLE);
      expect(solver.sufficientAssumptionsForInfeasibility()).toEqual([]);
    });

    it('should return empty array before any solve', () => {
      const solver = new CpSolver();
      expect(solver.sufficientAssumptionsForInfeasibility()).toEqual([]);
    });
  });

  describe('assumption contradicts Linear constraint', () => {
    it('should extract core when assumption contradicts model via Linear', () => {
      // b must be 0 (Linear b in [0,0]), assumption b=true → contradiction
      // Core: assumption 0 (b)
      const model = new CpModel();
      const b = model.newBoolVar('b');
      model.add(b.eq(0));
      model.addAssumption(b);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
      const core = solver.sufficientAssumptionsForInfeasibility();
      expect(core).toContain(0);
    });

    it('should extract core for multiple contradicting assumptions', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      model.add(a.eq(0));
      model.add(b.eq(0));
      model.addAssumption(a);
      model.addAssumption(b);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
      const core = solver.sufficientAssumptionsForInfeasibility();
      expect(core).toContain(0);
      expect(core).toContain(1);
    });
  });

  describe('ExactlyOne — direct two-true conflict', () => {
    it('should extract core from ExactlyOne violation', () => {
      // ExactlyOne([a,b,c]) + assumption a=true, b=true → conflict
      // Core: both assumptions
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const c = model.newBoolVar('c');

      model.addExactlyOne([a, b, c]);
      model.addAssumption(a);
      model.addAssumption(b);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
      const core = solver.sufficientAssumptionsForInfeasibility();
      expect(core).toContain(0);
      expect(core).toContain(1);
    });
  });

  describe('AtMostOne — direct two-true conflict', () => {
    it('should extract core from AtMostOne violation', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      model.addAtMostOne([a, b]);
      model.addAssumption(a);
      model.addAssumption(b);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
      const core = solver.sufficientAssumptionsForInfeasibility();
      expect(core).toContain(0);
      expect(core).toContain(1);
    });
  });

  describe('BoolOr with negated assumptions', () => {
    it('should extract core when BoolOr violated via negated assumptions', () => {
      // BoolOr([a,b]) + na=true (forces a=false) + nb=true (forces b=false)
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const na = model.newBoolVar('na');
      const nb = model.newBoolVar('nb');

      model.addBoolOr([a, b]);
      model.addAtMostOne([a, na]); // na → NOT a
      model.addAtMostOne([b, nb]); // nb → NOT b
      model.addAssumption(na);
      model.addAssumption(nb);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
      const core = solver.sufficientAssumptionsForInfeasibility();
      expect(core).toContain(0);
      expect(core).toContain(1);
    });
  });

  describe('BoolAnd with assumption', () => {
    it('should extract core when BoolAnd forces value conflicting with assumption', () => {
      // BoolAnd([a,b]) + na=true (forces a=false via AtMostOne)
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const na = model.newBoolVar('na');

      model.addBoolAnd([a, b]);
      model.addAtMostOne([a, na]);
      model.addAssumption(na);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
      const core = solver.sufficientAssumptionsForInfeasibility();
      expect(core).toContain(0);
    });
  });

  describe('Linear — integer variable contradiction', () => {
    it('should extract core when Linear constraint contradicts assumption', () => {
      // x in [0,5] AND x in [8,10] → infeasible, no assumptions needed
      // But with an irrelevant assumption, core should be empty
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      model.add(x.le(5));
      model.add(x.ge(8));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
      // No assumptions → core is empty
      expect(solver.sufficientAssumptionsForInfeasibility()).toEqual([]);
    });

    it('should extract core when assumption + Linear conflict', () => {
      // b must be 0, assumption b=true
      const model = new CpModel();
      const b = model.newBoolVar('b');
      model.add(b.eq(0));
      model.addAssumption(b);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
      const core = solver.sufficientAssumptionsForInfeasibility();
      expect(core).toContain(0);
    });
  });

  describe('core is sorted', () => {
    it('should return assumption indices in sorted order', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const c = model.newBoolVar('c');

      model.addExactlyOne([a, b, c]);
      model.addAssumption(a);
      model.addAssumption(b);
      model.addAssumption(c);

      const solver = new CpSolver();
      solver.solve(model);

      const core = solver.sufficientAssumptionsForInfeasibility();
      for (let i = 1; i < core.length; i++) {
        expect(core[i]).toBeGreaterThan(core[i - 1]);
      }
    });
  });

  describe('reset between solves', () => {
    it('should reset core when solver is reused', () => {
      const model1 = new CpModel();
      const b1 = model1.newBoolVar('b');
      model1.add(b1.eq(0));
      model1.addAssumption(b1);

      const solver = new CpSolver();
      solver.solve(model1);
      expect(solver.sufficientAssumptionsForInfeasibility().length).toBeGreaterThan(0);

      // Solve a feasible model with same solver
      const model2 = new CpModel();
      model2.newIntVar(0, 10, 'x');
      solver.solve(model2);

      // Core should be empty after feasible solve
      expect(solver.sufficientAssumptionsForInfeasibility()).toEqual([]);
    });
  });

  describe('negated assumption literals', () => {
    it('negated literals are not supported as assumptions', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      model.addBoolOr([a, b]);
      model.addAssumption(a.negated as any);

      const solver = new CpSolver();
      const status = solver.solve(model);

      // Negated assumption is ignored, model is feasible
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });
  });
});
