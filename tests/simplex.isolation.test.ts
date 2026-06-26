/**
 * LP simplex solver — isolation tests (tests src/simplex.ts DIRECTLY).
 *
 *   - exact-value unit tests for hand-derived LPs,
 *   - infeasible / unbounded / degenerate cases,
 *   - the iteration-cap backstop,
 *   - a brute-force SOUNDNESS oracle (fast-check): the LP optimum is a valid
 *     bound on the true integer optimum (≥ for maximize, ≤ for minimize), over
 *     hundreds of random instances.
 *
 * The soundness oracle is the single most important test in this feature — a
 * bound that is too tight would make the solver prune the optimum and return
 * WRONG answers. If it ever fails, the simplex is unsound.
 *
 * Note: with finite column bounds (always the case here), the LP can never be
 * unbounded — the objective is bounded by Σ |cⱼ|·max(|lo|,|hi|). So the solver
 * is expected to return 'optimal' or 'infeasible' for every instance below
 * (the 'unknown'/iteration-cap path is exercised separately).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { solveBoundedSimplex } from '../src/simplex';
import type { SimplexLpData, LpSense } from '../src/simplex';

const EPS = 1e-7;

// ----------------------------------------------------------------------------
// Helpers: build a SimplexLpData from a dense description
// ----------------------------------------------------------------------------

interface RowSpec {
  coeffs: number[]; // length numCols
  lb: number; // -Infinity allowed
  ub: number; // +Infinity allowed
}

function buildLp(
  colLb: number[],
  colUb: number[],
  rows: RowSpec[],
  c: number[],
  offset: number,
  sense: LpSense
): { data: SimplexLpData; colBounds: { lb: number[]; ub: number[] }; sense: LpSense } {
  const numCols = colLb.length;
  const rowStart: number[] = [0];
  const colIdx: number[] = [];
  const coef: number[] = [];
  for (const r of rows) {
    for (let j = 0; j < numCols; j++) {
      if (r.coeffs[j] !== 0) {
        colIdx.push(j);
        coef.push(r.coeffs[j]);
      }
    }
    rowStart.push(colIdx.length);
  }
  const data: SimplexLpData = {
    numCols,
    numRows: rows.length,
    rowStart,
    colIdx,
    coef,
    rowLb: rows.map(r => r.lb),
    rowUb: rows.map(r => r.ub),
    c,
    offset,
  };
  return { data, colBounds: { lb: colLb, ub: colUb }, sense };
}

function solve(
  colLb: number[],
  colUb: number[],
  rows: RowSpec[],
  c: number[],
  offset: number,
  sense: LpSense
) {
  const { data, colBounds } = buildLp(colLb, colUb, rows, c, offset, sense);
  return solveBoundedSimplex(data, colBounds, sense);
}

// ----------------------------------------------------------------------------
// Brute-force oracle: true INTEGER optimum over the box, respecting all rows.
// ----------------------------------------------------------------------------

function bruteForce(
  colLb: number[],
  colUb: number[],
  rows: RowSpec[],
  c: number[],
  offset: number,
  sense: LpSense
): number | null {
  const n = colLb.length;
  const lists: number[][] = [];
  let combos = 1;
  for (let j = 0; j < n; j++) {
    const a: number[] = [];
    for (let v = colLb[j]; v <= colUb[j]; v++) a.push(v);
    lists.push(a);
    combos *= a.length;
  }
  if (combos === 0) return null;

  const idx = new Array(n).fill(0);
  let best: number | null = null;
  let more = true;
  while (more) {
    // Check row feasibility.
    let feasible = true;
    for (const r of rows) {
      let act = 0;
      for (let j = 0; j < n; j++) act += r.coeffs[j] * lists[j][idx[j]];
      if (act < r.lb - EPS || act > r.ub + EPS) {
        feasible = false;
        break;
      }
    }
    if (feasible) {
      let val = offset;
      for (let j = 0; j < n; j++) val += c[j] * lists[j][idx[j]];
      if (best === null) best = val;
      else if (sense === 'maximize') best = Math.max(best, val);
      else best = Math.min(best, val);
    }
    // increment odometer
    let d = n - 1;
    while (d >= 0) {
      idx[d]++;
      if (idx[d] < lists[d].length) break;
      idx[d] = 0;
      d--;
    }
    if (d < 0) more = false;
  }
  return best;
}

// ============================================================================
// Exact-value unit tests (hand-derived)
// ============================================================================

describe('solveBoundedSimplex — exact values', () => {
  it('0/1 knapsack (single ≤ row) matches the fractional-knapsack LP value', () => {
    // max 3x + 4y  s.t. 2x + 3y ≤ 4, x,y ∈ [0,1].
    // Dantzig: x whole (w2,v3), then y fractional 2/3 → +4·(2/3) = 2.667. LP = 5.667.
    const r = solve([0, 0], [1, 1], [{ coeffs: [2, 3], lb: -Infinity, ub: 4 }], [3, 4], 0, 'maximize');
    expect(r.status).toBe('optimal');
    if (r.status === 'optimal') expect(r.value).toBeCloseTo(3 + (4 * 2) / 3, 6);
  });

  it('two constraints → vertex optimum at the intersection', () => {
    // max x + y  s.t. x + 2y ≤ 4, 3x + y ≤ 6, x,y ≥ 0.
    // Intersection: x=8/5, y=6/5 → x+y = 14/5 = 2.8.
    const r = solve(
      [0, 0],
      [10, 10],
      [
        { coeffs: [1, 2], lb: -Infinity, ub: 4 },
        { coeffs: [3, 1], lb: -Infinity, ub: 6 },
      ],
      [1, 1],
      0,
      'maximize'
    );
    expect(r.status).toBe('optimal');
    if (r.status === 'optimal') expect(r.value).toBeCloseTo(14 / 5, 6);
  });

  it('minimization LP returns a valid lower bound', () => {
    // min 5x + 4y  s.t. x + y ≥ 4, x,y ∈ [0,5]. Optimum = 16 at (4,0)... wait: x cheaper? 5x vs 4y,
    // y is cheaper so set y=4,x=0 → 16. Actually min of 5x+4y with x+y≥4: put all on cheaper coeff y → 16.
    const r = solve(
      [0, 0],
      [5, 5],
      [{ coeffs: [1, 1], lb: 4, ub: Infinity }],
      [5, 4],
      0,
      'minimize'
    );
    expect(r.status).toBe('optimal');
    if (r.status === 'optimal') expect(r.value).toBeCloseTo(16, 6);
  });

  it('objective offset is applied', () => {
    const r = solve([0, 0], [1, 1], [{ coeffs: [2, 3], lb: -Infinity, ub: 5 }], [3, 4], 7, 'maximize');
    expect(r.status).toBe('optimal');
    // max 3x+4y s.t. 2x+3y≤5 → x=1,y=1 (w5,v7); LP whole, value 7 + offset 7 = 14.
    if (r.status === 'optimal') expect(r.value).toBeCloseTo(14, 6);
  });

  it('ranged (both-sided) row L ≤ a·x ≤ U', () => {
    // max x  s.t. 1 ≤ x ≤ 3, x ∈ [0,5] → max x = 3.
    const r = solve([0], [5], [{ coeffs: [1], lb: 1, ub: 3 }], [1], 0, 'maximize');
    expect(r.status).toBe('optimal');
    if (r.status === 'optimal') expect(r.value).toBeCloseTo(3, 6);
  });

  it('equality row lb == ub', () => {
    // max x + y  s.t. x + y = 3, x,y ∈ [0,5] → 3.
    const r = solve(
      [0, 0],
      [5, 5],
      [{ coeffs: [1, 1], lb: 3, ub: 3 }],
      [1, 1],
      0,
      'maximize'
    );
    expect(r.status).toBe('optimal');
    if (r.status === 'optimal') expect(r.value).toBeCloseTo(3, 6);
  });

  it('negative objective coefficient is bounded correctly', () => {
    // max −3x  s.t. x ∈ [2,5] (column bound), no row → −3·2 = −6.
    const r = solve([2], [5], [], [-3], 0, 'maximize');
    expect(r.status).toBe('optimal');
    if (r.status === 'optimal') expect(r.value).toBeCloseTo(-6, 6);
  });

  it('detects infeasibility (contradictory equality)', () => {
    // x = 1 and x = 2 simultaneously → infeasible.
    const r = solve(
      [0, 0],
      [1, 1],
      [
        { coeffs: [1, 0], lb: 1, ub: 1 },
        { coeffs: [1, 0], lb: 2, ub: 2 },
      ],
      [1, 1],
      0,
      'maximize'
    );
    expect(r.status).toBe('infeasible');
  });

  it('detects infeasibility (column bound violated by row)', () => {
    // x ≥ 5 but x ∈ [0,3] → infeasible.
    const r = solve([0], [3], [{ coeffs: [1], lb: 5, ub: Infinity }], [1], 0, 'maximize');
    expect(r.status).toBe('infeasible');
  });

  it('degenerate LP (multiple optima) terminates at an optimum', () => {
    // max x + y  s.t. x + y ≤ 2, x,y ∈ [0,2] → optimum 2 (many vertices). Must terminate.
    const r = solve(
      [0, 0],
      [2, 2],
      [{ coeffs: [1, 1], lb: -Infinity, ub: 2 }],
      [1, 1],
      0,
      'maximize'
    );
    expect(r.status).toBe('optimal');
    if (r.status === 'optimal') expect(r.value).toBeCloseTo(2, 6);
  });

  it('iteration cap → unknown (no wrong answer)', () => {
    // A feasible LP solved with maxIterations = 0 → must bail to 'unknown'.
    const { data, colBounds } = buildLp(
      [0, 0],
      [1, 1],
      [{ coeffs: [2, 3], lb: -Infinity, ub: 4 }],
      [3, 4],
      0,
      'maximize'
    );
    const r = solveBoundedSimplex(data, colBounds, 'maximize', { maxIterations: 0 });
    expect(r.status).toBe('unknown');
  });

  it('no columns → returns the offset', () => {
    const r = solve([], [], [], [], 42, 'maximize');
    expect(r.status).toBe('optimal');
    if (r.status === 'optimal') expect(r.value).toBe(42);
  });

  it('REDUNDANT constraints (Phase-1 leaves a basic artificial) still solve soundly', () => {
    // max x + y  s.t. x + y = 4, x − y = 0, 2x = 4.  The third row is redundant
    // (implied by the first two → x = y = 2), so Phase 1 ends with a basic
    // artificial that the drive-out loop must swap out correctly. Optimum = 4.
    const r = solve(
      [0, 0],
      [10, 10],
      [
        { coeffs: [1, 1], lb: 4, ub: 4 },
        { coeffs: [1, -1], lb: 0, ub: 0 },
        { coeffs: [2, 0], lb: 4, ub: 4 },
      ],
      [1, 1],
      0,
      'maximize'
    );
    expect(r.status).toBe('optimal');
    if (r.status === 'optimal') expect(r.value).toBeCloseTo(4, 6);
  });

  it('DUPLICATE equality rows stay sound', () => {
    // max x  s.t. x = 5 (twice). Redundant duplicate; optimum = 5.
    const r = solve(
      [0],
      [10],
      [
        { coeffs: [1], lb: 5, ub: 5 },
        { coeffs: [1], lb: 5, ub: 5 },
      ],
      [1],
      0,
      'maximize'
    );
    expect(r.status).toBe('optimal');
    if (r.status === 'optimal') expect(r.value).toBeCloseTo(5, 6);
  });
});

// ============================================================================
// Soundness & tightness oracle (fast-check) — the critical correctness test
// ============================================================================

describe('solveBoundedSimplex — soundness & tightness (property based)', () => {
  // Per-variable generator: lower bound, span (hi = lo + span), objective coeff.
  const varArb = fc.record({
    lo: fc.integer({ min: 0, max: 3 }),
    span: fc.integer({ min: 0, max: 4 }),
    c: fc.integer({ min: -4, max: 6 }),
  });

  // A row: per-var coefficients + (lb, ub). Each side is finite or one-sided.
  const rowArb = fc.record({
    coeffs: fc.array(fc.integer({ min: -3, max: 5 }), { minLength: 2, maxLength: 4 }),
    lb: fc.oneof(fc.integer({ min: -6, max: 0 }), fc.constant(-Infinity)),
    ub: fc.oneof(fc.integer({ min: 0, max: 12 }), fc.constant(Infinity)),
  });

  const instanceArb = fc
    .record({
      vars: fc.array(varArb, { minLength: 2, maxLength: 4 }),
      baseRows: fc.array(rowArb, { minLength: 1, maxLength: 3 }),
      offset: fc.integer({ min: -5, max: 5 }),
      sense: fc.constantFrom('maximize' as LpSense, 'minimize' as LpSense),
      // Inject a redundant DUPLICATE row ~50% of the time. This forces Phase 1
      // to end with a basic artificial (degenerate), exercising the
      // "drive artificials out of the basis" path — a known soundness trap.
      addRedundant: fc.boolean(),
    })
    .map(r => ({
      vars: r.vars,
      rows: r.addRedundant ? [...r.baseRows, { ...r.baseRows[0] }] : r.baseRows,
      offset: r.offset,
      sense: r.sense,
    }));

  const materialize = (inst: {
    vars: { lo: number; span: number; c: number }[];
    rows: { coeffs: number[]; lb: number; ub: number }[];
    offset: number;
    sense: LpSense;
  }) => {
    const n = inst.vars.length;
    const colLb = inst.vars.map(v => v.lo);
    const colUb = inst.vars.map(v => v.lo + v.span);
    // Align row coeffs to the variable count (trim/pad).
    const rows: RowSpec[] = inst.rows.map(r => ({
      coeffs: Array.from({ length: n }, (_, j) => r.coeffs[j] ?? 0),
      lb: r.lb,
      ub: r.ub,
    }));
    const c = inst.vars.map(v => v.c);
    return { colLb, colUb, rows, c, offset: inst.offset, sense: inst.sense };
  };

  it('LP optimum is a valid bound on the true integer optimum', () => {
    fc.assert(
      fc.property(instanceArb, inst => {
        const { colLb, colUb, rows, c, offset, sense } = materialize(inst);
        const truth = bruteForce(colLb, colUb, rows, c, offset, sense);
        const r = solve(colLb, colUb, rows, c, offset, sense);

        if (truth === null) {
          // No integer-feasible point: LP may still be feasible (fractional).
          // Soundness imposes nothing on the value here; accept optimal/infeasible.
          expect(['optimal', 'infeasible']).toContain(r.status);
          return;
        }

        // An integer-feasible point exists ⇒ the LP (a superset) is feasible.
        expect(r.status).toBe('optimal');
        if (r.status !== 'optimal') return;
        if (sense === 'maximize') {
          // SOUNDNESS: relaxation bound never underestimates the integer optimum.
          expect(r.value).toBeGreaterThanOrEqual(truth - EPS);
        } else {
          expect(r.value).toBeLessThanOrEqual(truth + EPS);
        }
      }),
      { numRuns: 600 }
    );
  });

  it('LP optimum is no looser than the interval-arithmetic bound', () => {
    fc.assert(
      fc.property(instanceArb, inst => {
        const { colLb, colUb, rows, c, offset, sense } = materialize(inst);
        const truth = bruteForce(colLb, colUb, rows, c, offset, sense);
        if (truth === null) return;
        const r = solve(colLb, colUb, rows, c, offset, sense);
        if (r.status !== 'optimal') return;

        // Interval bound: each term pushed to its extreme independently.
        const interval =
          offset +
          c.reduce((s, cj, j) => {
            const hi = colUb[j];
            const lo = colLb[j];
            if (sense === 'maximize') return s + (cj >= 0 ? cj * hi : cj * lo);
            return s + (cj >= 0 ? cj * lo : cj * hi);
          }, 0);

        if (sense === 'maximize') {
          // The LP respects the rows, so it is at most the interval max.
          expect(r.value).toBeLessThanOrEqual(interval + EPS);
        } else {
          expect(r.value).toBeGreaterThanOrEqual(interval - EPS);
        }
      }),
      { numRuns: 600 }
    );
  });

  it('is deterministic: the same instance solves to the same value', () => {
    fc.assert(
      fc.property(instanceArb, inst => {
        const a = materialize(inst);
        const b = materialize(inst);
        const r1 = solve(a.colLb, a.colUb, a.rows, a.c, a.offset, a.sense);
        const r2 = solve(b.colLb, b.colUb, b.rows, b.c, b.offset, b.sense);
        expect(r1.status).toBe(r2.status);
        if (r1.status === 'optimal' && r2.status === 'optimal') {
          expect(r1.value).toBeCloseTo(r2.value, 9);
        }
      }),
      { numRuns: 200 }
    );
  });
});
