/**
 * Regression tests for the Phase 1 soundness fixes:
 *   S1  — `.ne()` now produces a real disequality (NOT_EQUAL), not x <= c-1.
 *   S9  — presolve OPTIMAL candidates are independently verified by checkers.
 *   S10 — AT_MOST_ONE satisfaction counts true literals (presolve checker).
 *   S4  — NoOverlap Not-Last bound uses startMax (covered by property tests).
 *   S5b — Cumulative Time-Table does not self-conflict (covered by property tests).
 */
import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';

describe('S1 — .ne() is a real disequality', () => {
  it('x.ne(5) with x in [5,10] leaves x >= 6 (was INFEASIBLE when encoded as x<=4)', () => {
    const model = new CpModel();
    const x = model.newIntVar(5, 10, 'x');
    model.add(x.ne(5));
    const solver = new CpSolver();
    const status = solver.solve(model);
    expect(status).toBe(CpSolverStatus.OPTIMAL);
    const v = solver.value(x);
    expect(v).not.toBe(5);
    expect(v).toBeGreaterThanOrEqual(6);
  });

  it('x.ne(5) with x in [0,10] then maximize x reaches 10 (was 4 under the old x<=4 encoding)', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    model.add(x.ne(5));
    model.maximize(x);
    const solver = new CpSolver();
    const status = solver.solve(model);
    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(x)).toBe(10);
  });

  it('x.ne(y) keeps two variables distinct (graph-coloring style)', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 2, 'x');
    const y = model.newIntVar(0, 2, 'y');
    model.add(x.ne(y));
    const solver = new CpSolver();
    const status = solver.solve(model);
    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(x)).not.toBe(solver.value(y));
  });

  it('triangle graph with 2 colors is infeasible (odd cycle, all pairs differ)', () => {
    const model = new CpModel();
    const c0 = model.newIntVar(0, 1, 'c0');
    const c1 = model.newIntVar(0, 1, 'c1');
    const c2 = model.newIntVar(0, 1, 'c2');
    model.add(c0.ne(c1));
    model.add(c1.ne(c2));
    model.add(c0.ne(c2));
    const solver = new CpSolver();
    const status = solver.solve(model);
    expect(status).toBe(CpSolverStatus.INFEASIBLE);
  });
});

describe('S9 — presolve OPTIMAL is verified by checkers', () => {
  it('a presolve-determined model returns OPTIMAL with the correct value', () => {
    const model = new CpModel();
    const x = model.newIntVar(3, 3, 'x'); // fixed in presolve
    const solver = new CpSolver();
    const status = solver.solve(model);
    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(x)).toBe(3);
  });
});

describe('S10 — AT_MOST_ONE counts true literals', () => {
  it('two literals forced true with addAtMostOne is INFEASIBLE', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');
    model.add(a.eq(1));
    model.add(b.eq(1));
    model.addAtMostOne([a, b]);
    const solver = new CpSolver();
    const status = solver.solve(model);
    expect(status).toBe(CpSolverStatus.INFEASIBLE);
  });

  it('one literal forced true with addAtMostOne is feasible', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');
    model.add(a.eq(1));
    model.addAtMostOne([a, b]);
    const solver = new CpSolver();
    const status = solver.solve(model);
    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.booleanValue(a)).toBe(true);
    expect(solver.booleanValue(b)).toBe(false);
  });
});

describe('C3a — assumptions are applied during solve', () => {
  it('forces an assumed boolean to true', () => {
    const model = new CpModel();
    const b = model.newBoolVar('b');
    model.addAssumption(b); // b is otherwise free in {0,1}
    const solver = new CpSolver();
    const status = solver.solve(model);
    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.booleanValue(b)).toBe(true);
  });

  it('returns INFEASIBLE when an assumption contradicts the model', () => {
    const model = new CpModel();
    const b = model.newBoolVar('b');
    model.add(b.eq(0)); // force b false
    model.addAssumption(b); // assume b true → contradiction
    const solver = new CpSolver();
    const status = solver.solve(model);
    expect(status).toBe(CpSolverStatus.INFEASIBLE);
  });
});

describe('P3b — DivisionEquality propagation (constant positive divisor)', () => {
  it('tightens target to floor(num/denom) over the numerator range', () => {
    // num in [10,20], denom = 3 → result in {3,4,5,6}. Maximizing/minimizing
    // the (wide) result must reach 6 / 3 respectively — only possible if the
    // Div propagator prunes result to [3,6].
    const modelMax = new CpModel();
    const num = modelMax.newIntVar(10, 20, 'num');
    const denom = modelMax.newIntVar(3, 3, 'denom');
    const result = modelMax.newIntVar(0, 100, 'result');
    modelMax.addDivisionEquality(result, num, denom);
    modelMax.maximize(result);
    const sMax = new CpSolver();
    expect(sMax.solve(modelMax)).toBe(CpSolverStatus.OPTIMAL);
    expect(sMax.value(result)).toBe(6);

    const modelMin = new CpModel();
    const num2 = modelMin.newIntVar(10, 20, 'num');
    const denom2 = modelMin.newIntVar(3, 3, 'denom');
    const result2 = modelMin.newIntVar(0, 100, 'result');
    modelMin.addDivisionEquality(result2, num2, denom2);
    modelMin.minimize(result2);
    const sMin = new CpSolver();
    expect(sMin.solve(modelMin)).toBe(CpSolverStatus.OPTIMAL);
    expect(sMin.value(result2)).toBe(3);
  });
});
