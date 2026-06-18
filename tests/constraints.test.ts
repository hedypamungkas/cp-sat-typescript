/**
 * CP-SAT TypeScript Tests
 * Tests for all constraint types including previously unsupported ones
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';

describe('Constraints', () => {
  describe('BoolXor', () => {
    it('should enforce XOR: exactly one of two literals is true', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      model.addBoolXor([a, b]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      // XOR: exactly one true
      expect(solver.booleanValue(a) !== solver.booleanValue(b)).toBe(true);
    });

    it('should detect infeasible XOR with BoolAnd', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      // XOR: exactly one true
      model.addBoolXor([a, b]);
      // AND: both true — contradicts XOR
      model.addBoolAnd([a, b]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });

    it('should enforce XOR with 3 literals (odd number true)', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const c = model.newBoolVar('c');

      model.addBoolXor([a, b, c]);

      const solver = new CpSolver();
      solver.parameters.enumerateAllSolutions = true;
      const status = solver.solve(model);

      // XOR of 3: odd number true → 1 or 3 true
      // Should find valid solutions
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });
  });

  describe('Element', () => {
    it('should enforce vars[index] == target', () => {
      const model = new CpModel();
      const index = model.newIntVar(0, 2, 'index');
      const target = model.newIntVar(10, 30, 'target');

      const v0 = model.newIntVar(10, 10, 'v0');
      const v1 = model.newIntVar(20, 20, 'v1');
      const v2 = model.newIntVar(30, 30, 'v2');

      model.addElement(index, [v0, v1, v2], target);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      const idx = solver.value(index);
      const tgt = solver.value(target);
      const values = [10, 20, 30];
      expect(tgt).toBe(values[idx]);
    });

    it('should detect infeasible element constraint', () => {
      const model = new CpModel();
      const index = model.newIntVar(0, 2, 'index');
      // Target domain doesn't overlap with any vars value
      const target = model.newIntVar(0, 5, 'target');

      const v0 = model.newIntVar(10, 10, 'v0');
      const v1 = model.newIntVar(20, 20, 'v1');
      const v2 = model.newIntVar(30, 30, 'v2');

      model.addElement(index, [v0, v1, v2], target);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });
  });

  describe('AbsEquality', () => {
    it('should enforce target == |expr|', () => {
      const model = new CpModel();
      const x = model.newIntVar(-10, 10, 'x');
      const absX = model.newIntVar(0, 10, 'absX');

      model.addAbsEquality(absX, x);
      model.add(x.le(-3)); // x <= -3

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(absX)).toBe(Math.abs(solver.value(x)));
      expect(solver.value(absX)).toBeGreaterThanOrEqual(3);
    });
  });

  describe('DivisionEquality', () => {
    it('should enforce target == num / denom (integer division)', () => {
      const model = new CpModel();
      const num = model.newIntVar(10, 10, 'num');
      const denom = model.newIntVar(3, 3, 'denom');
      const result = model.newIntVar(0, 10, 'result');

      model.addDivisionEquality(result, num, denom);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(result)).toBe(3); // 10 / 3 = 3 (integer)
    });
  });

  describe('ModuloEquality', () => {
    it('should enforce target == expr % mod', () => {
      const model = new CpModel();
      const x = model.newIntVar(10, 10, 'x');
      const m = model.newIntVar(3, 3, 'm');
      const result = model.newIntVar(0, 2, 'result');

      model.addModuloEquality(result, x, m);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(result)).toBe(1); // 10 % 3 = 1
    });
  });

  describe('MultiplicationEquality', () => {
    it('should enforce target == product of expressions', () => {
      const model = new CpModel();
      const a = model.newIntVar(3, 3, 'a');
      const b = model.newIntVar(4, 4, 'b');
      const product = model.newIntVar(0, 20, 'product');

      model.addMultiplicationEquality(product, [a, b]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(product)).toBe(12);
    });
  });

  describe('AllowedAssignments', () => {
    it('should only allow specified tuples', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 2, 'x');
      const y = model.newIntVar(0, 2, 'y');

      // Only allow (0,1), (1,0), (1,1)
      model.addAllowedAssignments([x, y], [[0, 1], [1, 0], [1, 1]]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      const xv = solver.value(x);
      const yv = solver.value(y);
      expect([[0, 1], [1, 0], [1, 1]]).toContainEqual([xv, yv]);
    });

    it('should detect infeasible allowed assignments', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 0, 'x'); // fixed to 0
      const y = model.newIntVar(0, 0, 'y'); // fixed to 0

      // (0,0) not in allowed set
      model.addAllowedAssignments([x, y], [[0, 1], [1, 0], [1, 1]]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });
  });

  describe('ForbiddenAssignments', () => {
    it('should reject forbidden tuples', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 1, 'x');
      const y = model.newIntVar(0, 1, 'y');

      // Forbid (0,0)
      model.addForbiddenAssignments([x, y], [[0, 0]]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(x) === 0 && solver.value(y) === 0).toBe(false);
    });
  });

  describe('Inverse', () => {
    it('should enforce inverse permutation', () => {
      const model = new CpModel();
      const f = [
        model.newIntVar(0, 2, 'f0'),
        model.newIntVar(0, 2, 'f1'),
        model.newIntVar(0, 2, 'f2'),
      ];
      const g = [
        model.newIntVar(0, 2, 'g0'),
        model.newIntVar(0, 2, 'g1'),
        model.newIntVar(0, 2, 'g2'),
      ];

      model.addAllDifferent(f);
      model.addAllDifferent(g);
      model.addInverse(f, g);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      // Verify: f[i] = j iff g[j] = i
      for (let i = 0; i < 3; i++) {
        const j = solver.value(f[i]);
        expect(solver.value(g[j])).toBe(i);
      }
    });

    it('should enforce inverse with 4 variables', () => {
      const model = new CpModel();
      const n = 4;
      const f = Array.from({ length: n }, (_, i) => model.newIntVar(0, n - 1, `f${i}`));
      const g = Array.from({ length: n }, (_, i) => model.newIntVar(0, n - 1, `g${i}`));

      model.addAllDifferent(f);
      model.addAllDifferent(g);
      model.addInverse(f, g);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      for (let i = 0; i < n; i++) {
        const j = solver.value(f[i]);
        expect(solver.value(g[j])).toBe(i);
      }
    });
  });

  describe('BoolXor with 4 literals', () => {
    it('should enforce odd number of true literals', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const c = model.newBoolVar('c');
      const d = model.newBoolVar('d');

      model.addBoolXor([a, b, c, d]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      const trueCount = [a, b, c, d].filter(v => solver.booleanValue(v)).length;
      expect(trueCount % 2).toBe(1);
    });
  });

  describe('Element with larger array', () => {
    it('should select from 5-element array', () => {
      const model = new CpModel();
      const index = model.newIntVar(0, 4, 'index');
      const target = model.newIntVar(0, 100, 'target');

      const vars = Array.from({ length: 5 }, (_, i) =>
        model.newIntVar(i * 10, i * 10, `v${i}`)
      );

      model.addElement(index, vars, target);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      const idx = solver.value(index);
      expect(solver.value(target)).toBe(idx * 10);
    });
  });

  describe('AbsEquality with positive value', () => {
    it('should handle positive expression', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const absX = model.newIntVar(0, 10, 'absX');

      model.addAbsEquality(absX, x);
      model.add(x.ge(3));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(absX)).toBe(solver.value(x));
    });
  });

  describe('ModuloEquality with negative values', () => {
    it('should handle negative dividend', () => {
      const model = new CpModel();
      const x = model.newIntVar(-10, -5, 'x');
      const m = model.newIntVar(3, 3, 'm');
      const result = model.newIntVar(0, 2, 'result');

      model.addModuloEquality(result, x, m);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      const xv = solver.value(x);
      const mv = solver.value(m);
      // JS modulo: (-10 % 3) = -1, but CP-SAT uses positive modulo
      expect(solver.value(result)).toBe(((xv % mv) + mv) % mv);
    });
  });

  describe('MultiplicationEquality with 3 factors', () => {
    it('should compute product of 3 variables', () => {
      const model = new CpModel();
      const a = model.newIntVar(2, 2, 'a');
      const b = model.newIntVar(3, 3, 'b');
      const c = model.newIntVar(4, 4, 'c');
      const product = model.newIntVar(0, 100, 'product');

      model.addMultiplicationEquality(product, [a, b, c]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(product)).toBe(24);
    });
  });

  describe('AllowedAssignments with 3 variables', () => {
    it('should enforce 3-variable table constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 2, 'x');
      const y = model.newIntVar(0, 2, 'y');
      const z = model.newIntVar(0, 2, 'z');

      model.addAllowedAssignments([x, y, z], [
        [0, 0, 1],
        [1, 1, 0],
        [2, 2, 2],
      ]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      const xv = solver.value(x);
      const yv = solver.value(y);
      const zv = solver.value(z);
      const tuples = [[0, 0, 1], [1, 1, 0], [2, 2, 2]];
      expect(tuples).toContainEqual([xv, yv, zv]);
    });
  });

  describe('ForbiddenAssignments - all but one', () => {
    it('should force remaining tuple', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 1, 'x');
      const y = model.newIntVar(0, 1, 'y');

      // Forbid all but (1, 1)
      model.addForbiddenAssignments([x, y], [[0, 0], [0, 1], [1, 0]]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(x)).toBe(1);
      expect(solver.value(y)).toBe(1);
    });
  });

  describe('Cumulative constraint', () => {
    it('should enforce capacity on overlapping tasks', () => {
      const model = new CpModel();

      const s1 = model.newIntVar(0, 10, 's1');
      const s2 = model.newIntVar(0, 10, 's2');
      const e1 = model.newIntVar(0, 20, 'e1');
      const e2 = model.newIntVar(0, 20, 'e2');

      model.add(s1.add(5).eq(e1));
      model.add(s2.add(5).eq(e2));

      // Force both to start at 0
      model.add(s1.eq(0));
      model.add(s2.eq(0));

      const iv1 = model.newIntervalVar(s1, 5, e1, 't1');
      const iv2 = model.newIntervalVar(s2, 5, e2, 't2');

      // Demand 3+3=6 > capacity 5 → infeasible when overlapping
      model.addCumulative([iv1, iv2], [3, 3], 5);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });
  });

  describe('NoOverlap constraint', () => {
    it('should prevent interval overlap', () => {
      const model = new CpModel();

      const s1 = model.newIntVar(0, 10, 's1');
      const s2 = model.newIntVar(0, 10, 's2');
      const e1 = model.newIntVar(0, 20, 'e1');
      const e2 = model.newIntVar(0, 20, 'e2');

      model.add(s1.add(5).eq(e1));
      model.add(s2.add(5).eq(e2));

      const iv1 = model.newIntervalVar(s1, 5, e1, 't1');
      const iv2 = model.newIntervalVar(s2, 5, e2, 't2');

      model.addNoOverlap([iv1, iv2]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      const v1 = solver.value(s1);
      const v2 = solver.value(s2);
      expect(v1 + 5 <= v2 || v2 + 5 <= v1).toBe(true);
    });
  });

  describe('MinEquality', () => {
    it('should enforce target == min of expressions', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 10, 'target');
      const x = model.newIntVar(3, 3, 'x');
      const y = model.newIntVar(7, 7, 'y');

      model.addMinEquality(target, [x, y]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(target)).toBe(3);
    });
  });

  describe('MaxEquality', () => {
    it('should enforce target == max of expressions', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 10, 'target');
      const x = model.newIntVar(3, 3, 'x');
      const y = model.newIntVar(7, 7, 'y');

      model.addMaxEquality(target, [x, y]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(target)).toBe(7);
    });
  });

  describe('Implication - contrapositive', () => {
    it('should propagate false consequent to false antecedent', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      model.addImplication(a, b);
      model.add(b.le(0)); // b = false

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.booleanValue(a)).toBe(false);
      expect(solver.booleanValue(b)).toBe(false);
    });
  });

  describe('BoolAnd - all must be true', () => {
    it('should force all literals to true', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const c = model.newBoolVar('c');

      model.addBoolAnd([a, b, c]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.booleanValue(a)).toBe(true);
      expect(solver.booleanValue(b)).toBe(true);
      expect(solver.booleanValue(c)).toBe(true);
    });
  });

  describe('AtMostOne', () => {
    it('should allow zero true literals', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      model.addAtMostOne([a, b]);
      model.add(a.le(0));
      model.add(b.le(0));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.booleanValue(a)).toBe(false);
      expect(solver.booleanValue(b)).toBe(false);
    });

    it('should allow one true literal', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      model.addAtMostOne([a, b]);
      model.addBoolAnd([a]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.booleanValue(a)).toBe(true);
      expect(solver.booleanValue(b)).toBe(false);
    });
  });

  describe('DivisionEquality - edge cases', () => {
    it('should handle negative division', () => {
      const model = new CpModel();
      const num = model.newIntVar(-10, -10, 'num');
      const denom = model.newIntVar(3, 3, 'denom');
      const result = model.newIntVar(-5, 0, 'result');

      model.addDivisionEquality(result, num, denom);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(result)).toBe(-3); // -10 / 3 = -3 (truncated)
    });
  });

  describe('Constraint toString', () => {
    it('should format LinearConstraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');
      const ct = model.add(x.add(y).le(15));
      expect(ct.toString()).toContain('LinearConstraint');
    });

    it('should format AllDifferent', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 2, 'x');
      const y = model.newIntVar(0, 2, 'y');
      const ct = model.addAllDifferent([x, y]);
      expect(ct.toString()).toContain('AllDifferent');
    });

    it('should format BoolOr', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const ct = model.addBoolOr([a]);
      expect(ct.toString()).toContain('BoolOr');
    });

    it('should format BoolAnd', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const ct = model.addBoolAnd([a]);
      expect(ct.toString()).toContain('BoolAnd');
    });

    it('should format BoolXor', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const ct = model.addBoolXor([a]);
      expect(ct.toString()).toContain('BoolXor');
    });

    it('should format Implication', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const ct = model.addImplication(a, b);
      expect(ct.toString()).toContain('Implication');
    });

    it('should format Element', () => {
      const model = new CpModel();
      const idx = model.newIntVar(0, 1, 'idx');
      const target = model.newIntVar(0, 10, 'target');
      const v0 = model.newIntVar(1, 1, 'v0');
      const ct = model.addElement(idx, [v0], target);
      expect(ct.toString()).toContain('Element');
    });

    it('should format AllowedAssignments', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 1, 'x');
      const ct = model.addAllowedAssignments([x], [[0], [1]]);
      expect(ct.toString()).toContain('AllowedAssignments');
    });

    it('should format ForbiddenAssignments', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 1, 'x');
      const ct = model.addForbiddenAssignments([x], [[0]]);
      expect(ct.toString()).toContain('ForbiddenAssignments');
    });

    it('should format Inverse', () => {
      const model = new CpModel();
      const f = [model.newIntVar(0, 1, 'f')];
      const g = [model.newIntVar(0, 1, 'g')];
      const ct = model.addInverse(f, g);
      expect(ct.toString()).toContain('Inverse');
    });

    it('should format NoOverlap', () => {
      const model = new CpModel();
      const s = model.newIntVar(0, 10, 's');
      const e = model.newIntVar(0, 20, 'e');
      const iv = model.newIntervalVar(s, 5, e, 't');
      const ct = model.addNoOverlap([iv]);
      expect(ct.toString()).toContain('NoOverlap');
    });

    it('should format Cumulative', () => {
      const model = new CpModel();
      const s = model.newIntVar(0, 10, 's');
      const e = model.newIntVar(0, 20, 'e');
      const iv = model.newIntervalVar(s, 5, e, 't');
      const ct = model.addCumulative([iv], [3], 5);
      expect(ct.toString()).toContain('Cumulative');
    });

    it('should format MinEquality', () => {
      const model = new CpModel();
      const t = model.newIntVar(0, 10, 't');
      const x = model.newIntVar(0, 10, 'x');
      const ct = model.addMinEquality(t, [x]);
      expect(ct.toString()).toContain('MinEquality');
    });

    it('should format MaxEquality', () => {
      const model = new CpModel();
      const t = model.newIntVar(0, 10, 't');
      const x = model.newIntVar(0, 10, 'x');
      const ct = model.addMaxEquality(t, [x]);
      expect(ct.toString()).toContain('MaxEquality');
    });

    it('should format AbsEquality', () => {
      const model = new CpModel();
      const t = model.newIntVar(0, 10, 't');
      const x = model.newIntVar(-10, 10, 'x');
      const ct = model.addAbsEquality(t, x);
      expect(ct.toString()).toContain('AbsEquality');
    });

    it('should format DivisionEquality', () => {
      const model = new CpModel();
      const t = model.newIntVar(0, 10, 't');
      const a = model.newIntVar(1, 100, 'a');
      const b = model.newIntVar(1, 10, 'b');
      const ct = model.addDivisionEquality(t, a, b);
      expect(ct.toString()).toContain('DivisionEquality');
    });

    it('should format ModuloEquality', () => {
      const model = new CpModel();
      const t = model.newIntVar(0, 9, 't');
      const x = model.newIntVar(0, 100, 'x');
      const m = model.newIntVar(1, 10, 'm');
      const ct = model.addModuloEquality(t, x, m);
      expect(ct.toString()).toContain('ModuloEquality');
    });

    it('should format MultiplicationEquality', () => {
      const model = new CpModel();
      const t = model.newIntVar(0, 100, 't');
      const a = model.newIntVar(0, 10, 'a');
      const ct = model.addMultiplicationEquality(t, [a]);
      expect(ct.toString()).toContain('MultiplicationEquality');
    });

    it('should format AtMostOne', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const ct = model.addAtMostOne([a]);
      expect(ct.toString()).toContain('AtMostOne');
    });

    it('should format ExactlyOne', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const ct = model.addExactlyOne([a]);
      expect(ct.toString()).toContain('ExactlyOne');
    });
  });
});

describe('Constraints - edge cases', () => {
  describe('unimplemented constraints', () => {
    it('should throw for CIRCUIT constraint', () => {
      const model = new CpModel();
      const x = model.newBoolVar('x');
      model.addCircuit([[0, 1, x]]);

      const solver = new CpSolver();
      expect(() => solver.solve(model)).toThrow('not yet implemented');
    });

    it('should throw for MULTIPLE_CIRCUIT constraint', () => {
      const model = new CpModel();
      const x = model.newBoolVar('x');
      model.addMultipleCircuit([[0, 1, x]]);

      const solver = new CpSolver();
      expect(() => solver.solve(model)).toThrow('not yet implemented');
    });

    it('should throw for AUTOMATON constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 1, 'x');
      model.addAutomaton([x], 0, [0, 1], [[0, 0, 0], [0, 1, 1]]);

      const solver = new CpSolver();
      expect(() => solver.solve(model)).toThrow('not yet implemented');
    });

    it('should throw for MAP_DOMAIN constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 2, 'x');
      const vars = [
        model.newBoolVar('b0'),
        model.newBoolVar('b1'),
        model.newBoolVar('b2'),
      ];
      model.addMapDomain(x, vars);

      const solver = new CpSolver();
      expect(() => solver.solve(model)).toThrow('not yet implemented');
    });
  });

  describe('NoOverlap infeasibility', () => {
    it('should detect infeasible NoOverlap with 3 intervals', () => {
      const model = new CpModel();

      // 3 intervals of size 3, forced to start at 0 — can't all fit without overlap
      const s1 = model.newIntVar(0, 0, 's1');
      const s2 = model.newIntVar(0, 0, 's2');
      const s3 = model.newIntVar(0, 0, 's3');

      const iv1 = model.newFixedSizeIntervalVar(s1, 3, 't1');
      const iv2 = model.newFixedSizeIntervalVar(s2, 3, 't2');
      const iv3 = model.newFixedSizeIntervalVar(s3, 3, 't3');

      model.addNoOverlap([iv1, iv2, iv3]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      // All forced to start at 0 → all overlap → infeasible
      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });
  });

  describe('Cumulative with 3+ tasks', () => {
    it('should enforce capacity with 3 tasks', () => {
      const model = new CpModel();

      const s1 = model.newIntVar(0, 0, 's1');
      const s2 = model.newIntVar(0, 0, 's2');
      const s3 = model.newIntVar(0, 0, 's3');

      const iv1 = model.newFixedSizeIntervalVar(s1, 2, 't1');
      const iv2 = model.newFixedSizeIntervalVar(s2, 2, 't2');
      const iv3 = model.newFixedSizeIntervalVar(s3, 2, 't3');

      // 3 tasks all at time 0, demand 3 each = 9, capacity 5 → infeasible
      model.addCumulative([iv1, iv2, iv3], [3, 3, 3], 5);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });
  });

  describe('Element with single-element array', () => {
    it('should work with single-element array', () => {
      const model = new CpModel();
      const index = model.newIntVar(0, 0, 'index');
      const target = model.newIntVar(42, 42, 'target');
      const v0 = model.newIntVar(42, 42, 'v0');

      model.addElement(index, [v0], target);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(target)).toBe(42);
    });
  });

  describe('ForbiddenAssignments infeasibility', () => {
    it('should detect infeasibility when all tuples are forbidden', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 1, 'x');
      const y = model.newIntVar(0, 1, 'y');

      // Forbid all 4 possible tuples
      model.addForbiddenAssignments([x, y], [[0, 0], [0, 1], [1, 0], [1, 1]]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });
  });

  describe('DivisionEquality with negative denominator', () => {
    it('should handle negative divisor', () => {
      const model = new CpModel();
      const num = model.newIntVar(10, 10, 'num');
      const denom = model.newIntVar(-3, -3, 'denom');
      const result = model.newIntVar(-5, 0, 'result');

      model.addDivisionEquality(result, num, denom);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(result)).toBe(-3); // 10 / -3 = -3 (truncated toward zero)
    });
  });

  describe('MinEquality with 3 expressions', () => {
    it('should compute min of 3 values', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 10, 'target');
      const x = model.newIntVar(5, 5, 'x');
      const y = model.newIntVar(3, 3, 'y');
      const z = model.newIntVar(7, 7, 'z');

      model.addMinEquality(target, [x, y, z]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(target)).toBe(3);
    });
  });

  describe('MaxEquality with 3 expressions', () => {
    it('should compute max of 3 values', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 10, 'target');
      const x = model.newIntVar(5, 5, 'x');
      const y = model.newIntVar(3, 3, 'y');
      const z = model.newIntVar(7, 7, 'z');

      model.addMaxEquality(target, [x, y, z]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(target)).toBe(7);
    });
  });

  describe('AtMostOne with 4 literals', () => {
    it('should allow at most one true among 4 literals', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const c = model.newBoolVar('c');
      const d = model.newBoolVar('d');

      model.addAtMostOne([a, b, c, d]);
      model.addBoolAnd([a, b]); // force both true → violates AtMostOne

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });
  });

  describe('ExactlyOne with 4 literals', () => {
    it('should enforce exactly one true among 4 literals', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const c = model.newBoolVar('c');
      const d = model.newBoolVar('d');

      model.addExactlyOne([a, b, c, d]);

      const solver = new CpSolver();
      solver.parameters.enumerateAllSolutions = true;
      solver.solve(model);

      // Should find exactly 4 solutions (one for each variable being true)
      expect(solver.numSolutions).toBe(4);
    });
  });

  describe('Implication edge cases', () => {
    it('should handle both true (trivially satisfied)', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      model.addImplication(a, b);
      model.addBoolAnd([a, b]); // both true

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.booleanValue(a)).toBe(true);
      expect(solver.booleanValue(b)).toBe(true);
    });

    it('should handle both false (trivially satisfied)', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      model.addImplication(a, b);
      model.add(a.le(0)); // a = false
      model.add(b.le(0)); // b = false

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.booleanValue(a)).toBe(false);
      expect(solver.booleanValue(b)).toBe(false);
    });
  });

  describe('AllDifferent with expressions', () => {
    it('should enforce allDifferent on expressions', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 3, 'x');
      const y = model.newIntVar(0, 3, 'y');
      const z = model.newIntVar(0, 3, 'z');

      // AllDifferent on x+1, y+1, z+1
      model.addAllDifferent([x.add(1), y.add(1), z.add(1)]);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      // x, y, z must all be different
      const values = [solver.value(x), solver.value(y), solver.value(z)];
      expect(new Set(values).size).toBe(3);
    });
  });

  describe('Cumulative with variable start times', () => {
    it('should find feasible schedule with variable starts', () => {
      const model = new CpModel();

      const s1 = model.newIntVar(0, 10, 's1');
      const s2 = model.newIntVar(0, 10, 's2');

      const iv1 = model.newFixedSizeIntervalVar(s1, 3, 't1');
      const iv2 = model.newFixedSizeIntervalVar(s2, 3, 't2');

      // Capacity 4, demands 3 each — can overlap partially
      model.addCumulative([iv1, iv2], [3, 3], 4);

      const solver = new CpSolver();
      solver.parameters.maxTimeInSeconds = 5;
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });
  });
});
