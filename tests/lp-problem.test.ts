/**
 * LP-problem builder — unit tests for src/lp-problem.ts.
 *
 * Verifies the model→SimplexLpData translation: column collection, per-column
 * coefficient folding (soundness-critical), the isActive filter, non-linear
 * constraint skipping, objective offset, and per-node column-bound extraction.
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { LinearExpr } from '../src/types';
import { Domain } from '../src/types';
import { buildLpProblem, extractColumnBounds } from '../src/lp-problem';
import { solveBoundedSimplex } from '../src/simplex';

describe('buildLpProblem — column & matrix construction', () => {
  it('collects columns from the objective and constraints', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    const y = m.newIntVar(0, 5, 'y');
    m.add(x.add(y).le(7));
    m.maximize(x.mul(2).add(y.mul(3))); // objective uses x, y

    const p = buildLpProblem(m.constraints, () => true, m.objective!, m.isMaximize);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p!.data.numCols).toBe(2);
    expect(p!.colVars).toContain(x.index);
    expect(p!.colVars).toContain(y.index);
    expect(p!.data.numRows).toBe(1);
  });

  it('includes constraint-only variables as columns (objective coeff 0)', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    const z = m.newIntVar(0, 5, 'z'); // only in a constraint, not the objective
    m.add(x.add(z.mul(2)).le(7));
    m.maximize(x); // z absent from objective

    const p = buildLpProblem(m.constraints, () => true, m.objective!, m.isMaximize);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p!.data.numCols).toBe(2);
    expect(p!.colVars).toContain(z.index);
  });

  it('folds duplicate variable occurrences within a constraint into one coefficient', () => {
    // x + x ≤ 6  (vars [x,x], coeffs [1,1]) → one column, coeff 2.
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    m.add(x.add(x).le(6));
    m.maximize(x);

    const p = buildLpProblem(m.constraints, () => true, m.objective!, m.isMaximize);
    if (!p) return;
    expect(p.data.numCols).toBe(1);
    // The single row has one nonzero: coeff 2 at column 0.
    expect(p.data.coef).toEqual([2]);
  });

  it('folds duplicate terms in the objective vector', () => {
    // maximize x + x → objective coeff 2 on x's column.
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    m.maximize(x.add(x));

    const p = buildLpProblem(m.constraints, () => true, m.objective!, m.isMaximize);
    if (!p) return;
    expect(p.data.c).toEqual([2]);
  });

  it('preserves the objective offset', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    const obj = new LinearExpr([x], [1], 9); // x + 9
    m.maximize(obj);
    const p = buildLpProblem(m.constraints, () => true, m.objective!, m.isMaximize);
    if (!p) return;
    expect(p.data.offset).toBe(9);
  });

  it('extracts row bounds from each LinearConstraint domain (≤, ≥, ==)', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 10, 'x');
    m.add(x.le(4)); // ≤  → rowUb 4, rowLb -Inf
    m.add(x.ge(1)); // ≥  → rowLb 1, rowUb +Inf
    m.add(x.eq(2)); // == → rowLb == rowUb == 2  (note: these together are infeasible, but the
    // builder only translates; presolve/solver handles infeasibility)
    m.maximize(x);

    const p = buildLpProblem(m.constraints, () => true, m.objective!, m.isMaximize);
    if (!p) return;
    expect(p.data.numRows).toBe(3);
    expect(p.data.rowUb[0]).toBe(4);
    expect(p.data.rowLb[0]).toBe(-Infinity);
    expect(p.data.rowLb[1]).toBe(1);
    expect(p.data.rowUb[1]).toBe(Infinity);
    expect(p.data.rowLb[2]).toBe(2);
    expect(p.data.rowUb[2]).toBe(2);
  });

  it('respects the isActive filter (skips presolve-removed constraints)', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    const c1 = m.add(x.le(4));
    m.add(x.le(9)); // second constraint, will be filtered out
    m.maximize(x);

    const p = buildLpProblem(m.constraints, i => i === c1.index, m.objective!, m.isMaximize);
    if (!p) return;
    expect(p.data.numRows).toBe(1);
    expect(p.data.rowUb[0]).toBe(4);
  });

  it('skips non-linear constraint types (sound-but-loose)', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    const y = m.newIntVar(0, 5, 'y');
    const z = m.newIntVar(0, 5, 'z');
    m.add(x.add(y).le(7)); // linear → kept
    m.addAllDifferent([x, y, z]); // non-linear → skipped
    m.maximize(x);

    const p = buildLpProblem(m.constraints, () => true, m.objective!, m.isMaximize);
    if (!p) return;
    expect(p.data.numRows).toBe(1); // only the linear row
  });

  it('returns null when there is nothing to relax', () => {
    const m = new CpModel();
    const obj = new LinearExpr([], [], 3); // constant objective, no vars
    m.maximize(obj);
    const p = buildLpProblem(m.constraints, () => true, m.objective!, m.isMaximize);
    expect(p).toBeNull();
  });
});

describe('extractColumnBounds — per-node domain read', () => {
  it('reads lb/ub from the current domains', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    const y = m.newIntVar(0, 5, 'y');
    m.add(x.add(y).le(7));
    m.maximize(x.add(y));

    const p = buildLpProblem(m.constraints, () => true, m.objective!, m.isMaximize);
    if (!p) return;
    const domains = new Map<number, Domain>([
      [x.index, new Domain([1, 4])],
      [y.index, new Domain([0, 2])],
    ]);
    const cb = extractColumnBounds(p, domains);
    expect(cb).not.toBeNull();
    if (!cb) return;
    // Column order matches colVars; find x's and y's columns.
    const xCol = p.colVars.indexOf(x.index);
    const yCol = p.colVars.indexOf(y.index);
    expect(cb.lb[xCol]).toBe(1);
    expect(cb.ub[xCol]).toBe(4);
    expect(cb.lb[yCol]).toBe(0);
    expect(cb.ub[yCol]).toBe(2);
  });

  it('returns null when a column variable has an empty domain', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    m.maximize(x);
    const p = buildLpProblem(m.constraints, () => true, m.objective!, m.isMaximize);
    if (!p) return;
    const cb = extractColumnBounds(p, new Map([[x.index, Domain.empty()]]));
    expect(cb).toBeNull();
  });

  it('returns null when a column variable is missing from the domains', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    m.maximize(x);
    const p = buildLpProblem(m.constraints, () => true, m.objective!, m.isMaximize);
    if (!p) return;
    const cb = extractColumnBounds(p, new Map()); // x missing
    expect(cb).toBeNull();
  });
});

describe('buildLpProblem + simplex — end-to-end translation', () => {
  it('a knapsack built via the builder solves to the fractional-knapsack value', () => {
    // max 3x + 4y  s.t. 2x + 3y ≤ 4, x,y ∈ [0,1] → LP value 3 + 4·(2/3) = 5.667.
    const m = new CpModel();
    const x = m.newBoolVar('x');
    const y = m.newBoolVar('y');
    m.add(x.mul(2).add(y.mul(3)).le(4));
    m.maximize(x.mul(3).add(y.mul(4)));

    const p = buildLpProblem(m.constraints, () => true, m.objective!, m.isMaximize);
    if (!p) return;
    const cb = extractColumnBounds(
      p,
      new Map<number, Domain>([
        [x.index, new Domain([0, 1])],
        [y.index, new Domain([0, 1])],
      ])
    );
    expect(cb).not.toBeNull();
    if (!cb) return;
    const r = solveBoundedSimplex(p.data, cb, 'maximize');
    expect(r.status).toBe('optimal');
    if (r.status === 'optimal') expect(r.value).toBeCloseTo(3 + (4 * 2) / 3, 6);
  });
});
