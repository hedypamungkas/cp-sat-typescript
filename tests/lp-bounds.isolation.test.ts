/**
 * LP-Relaxation Bounds — isolation tests.
 *
 * Tests src/lp-bounds.ts DIRECTLY (no CpSolver pipeline):
 *   - exact-value unit tests for the Dantzig greedy (hand-derived),
 *   - detection classification rules,
 *   - a brute-force SOUNDNESS oracle (fast-check): the LP upper bound is NEVER
 *     below the true integer optimum, over hundreds of random instances.
 *
 * The soundness oracle is the single most important test in this feature — a
 * bound that is too tight would make the solver prune the optimum and return
 * WRONG answers. If it ever fails, the implementation is unsound.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { Domain, LinearExpr } from '../src/types';
import type { IntVar } from '../src/types';
import { CpModel } from '../src/model';
import {
  computeLpObjectiveBound,
  fractionalKnapsackUpperBound,
  detectPackingConstraints,
  EMPTY_CLASSIFICATION,
} from '../src/lp-bounds';
import type { PackingConstraint, LpBoundContext } from '../src/lp-bounds';

const EPS = 1e-9;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** Build a knapsack instance: vars (in order), domains, objective, one packing. */
function buildInstance(
  ranges: [number, number][],
  weights: number[],
  coeffs: number[],
  offset: number,
  W: number,
  maximize = true
): { ctx: LpBoundContext; vars: IntVar[] } {
  const m = new CpModel();
  const vars = ranges.map(([lo, hi], i) => m.newIntVar(lo, hi, `x${i}`));
  const domains = new Map<number, Domain>();
  for (const v of vars) domains.set(v.index, new Domain(v.domain.intervals));
  const objective = new LinearExpr(vars, coeffs, offset);
  const packing: PackingConstraint = {
    constraintIndex: 0,
    varIndices: vars.map(v => v.index),
    weights,
    ub: W,
    lb: -Infinity,
  };
  const ctx: LpBoundContext = {
    objective,
    maximize,
    domains,
    classification: { packingConstraints: [packing] },
  };
  return { ctx, vars };
}

/**
 * Brute-force TRUE integer optimum of  maximize Σ coeffsᵢ·xᵢ + offset
 * s.t.  Σ weightsᵢ·xᵢ ≤ W,  xᵢ ∈ [loᵢ, hiᵢ]. Returns null if infeasible.
 */
function bruteForceKnapsackMax(
  ranges: [number, number][],
  weights: number[],
  coeffs: number[],
  offset: number,
  W: number
): number | null {
  const n = ranges.length;
  const valueLists: number[][] = ranges.map(([lo, hi]) => {
    const a: number[] = [];
    for (let v = lo; v <= hi; v++) a.push(v);
    return a;
  });
  let combos = 1;
  for (const v of valueLists) combos *= v.length;
  if (combos === 0) return null;

  let best: number | null = null;
  const idx = new Array(n).fill(0);
  let more = true;
  while (more) {
    let weight = 0;
    let val = offset;
    for (let i = 0; i < n; i++) {
      const x = valueLists[i][idx[i]];
      weight += weights[i] * x;
      val += coeffs[i] * x;
    }
    if (weight <= W && (best === null || val > best)) best = val;

    // increment odometer
    let d = n - 1;
    while (d >= 0) {
      idx[d]++;
      if (idx[d] < valueLists[d].length) break;
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

describe('fractionalKnapsackUpperBound — exact values', () => {
  it('0/1 knapsack, no fractional split (bound equals optimum)', () => {
    // bool vars, weights [2,3,4], values [3,4,5], W=5.
    // ratios 1.5,1.33,1.25 → take x0 (w2) + x1 (w3) = weight 5, value 7.
    const { ctx } = buildInstance([[0, 1], [0, 1], [0, 1]], [2, 3, 4], [3, 4, 5], 0, 5);
    expect(computeLpObjectiveBound(ctx)).toBeCloseTo(7, 9);
  });

  it('0/1 knapsack with a fractional split (bound strictly above optimum)', () => {
    // bool, weights [2,3], values [3,4], W=4. x0 whole (w2,v3,r1.5), then x1
    // fractional: 2/3 of it → +4*(2/3)=2.667. LP=5.667. Integer opt=4.
    const { ctx } = buildInstance([[0, 1], [0, 1]], [2, 3], [3, 4], 0, 4);
    expect(computeLpObjectiveBound(ctx)).toBeCloseTo(3 + (4 * 2) / 3, 9);
  });

  it('bounded integer vars [lo,hi] (not just 0/1)', () => {
    // x0∈[2,5] w1 c2 ; x1∈[0,3] w1 c3 ; W=4. Opt = 2*2 + 3*2 = 10.
    const { ctx } = buildInstance([[2, 5], [0, 3]], [1, 1], [2, 3], 0, 4);
    expect(computeLpObjectiveBound(ctx)).toBeCloseTo(10, 9);
  });

  it('objective variable NOT in the constraint contributes its domain max', () => {
    // x0 (c2) packed w1 W2 ∈[0,3]; x1 (c5) free ∈[0,4]. Opt = 2*2 + 5*4 = 24.
    const m = new CpModel();
    const x0 = m.newIntVar(0, 3, 'x0');
    const x1 = m.newIntVar(0, 4, 'x1');
    const domains = new Map<number, Domain>([
      [x0.index, new Domain([0, 3])],
      [x1.index, new Domain([0, 4])],
    ]);
    const objective = new LinearExpr([x0, x1], [2, 5], 0);
    const packing: PackingConstraint = {
      constraintIndex: 0,
      varIndices: [x0.index],
      weights: [1],
      ub: 2,
      lb: -Infinity,
    };
    const ctx: LpBoundContext = {
      objective,
      maximize: true,
      domains,
      classification: { packingConstraints: [packing] },
    };
    expect(computeLpObjectiveBound(ctx)).toBeCloseTo(24, 9);
  });

  it('constraint variable NOT in the objective consumes capacity but adds no value', () => {
    // obj 3*x0 ; packing x0(w1) + x1(w2) ≤ 4 ; x0∈[0,3], x1∈[0,2]. Opt = 9 (x0=3, x1=0).
    const m = new CpModel();
    const x0 = m.newIntVar(0, 3, 'x0');
    const x1 = m.newIntVar(0, 2, 'x1');
    const domains = new Map<number, Domain>([
      [x0.index, new Domain([0, 3])],
      [x1.index, new Domain([0, 2])],
    ]);
    const objective = new LinearExpr([x0], [3], 0);
    const packing: PackingConstraint = {
      constraintIndex: 0,
      varIndices: [x0.index, x1.index],
      weights: [1, 2],
      ub: 4,
      lb: -Infinity,
    };
    const ctx: LpBoundContext = {
      objective,
      maximize: true,
      domains,
      classification: { packingConstraints: [packing] },
    };
    expect(computeLpObjectiveBound(ctx)).toBeCloseTo(9, 9);
  });

  it('multiple packing constraints → tightest (min) bound', () => {
    // x0 c10 ∈[0,10]. p1: w1 W2 → bound 20. p2: w1 W5 → bound 50. min = 20.
    const m = new CpModel();
    const x0 = m.newIntVar(0, 10, 'x0');
    const domains = new Map<number, Domain>([[x0.index, new Domain([0, 10])]]);
    const objective = new LinearExpr([x0], [10], 0);
    const p1: PackingConstraint = { constraintIndex: 0, varIndices: [x0.index], weights: [1], ub: 2, lb: -Infinity };
    const p2: PackingConstraint = { constraintIndex: 1, varIndices: [x0.index], weights: [1], ub: 5, lb: -Infinity };
    const ctx: LpBoundContext = {
      objective, maximize: true, domains,
      classification: { packingConstraints: [p1, p2] },
    };
    expect(computeLpObjectiveBound(ctx)).toBeCloseTo(20, 9);
  });

  it('negative objective coefficient is pinned at the lower bound', () => {
    // x0 c=-3 ∈[2,5], packing w1 W10. Max of -3x0 is at x0=2 → -6.
    const { ctx } = buildInstance([[2, 5]], [1], [-3], 0, 10);
    expect(computeLpObjectiveBound(ctx)).toBeCloseTo(-6, 9);
  });

  it('objective offset is added to the bound', () => {
    const { ctx } = buildInstance([[0, 1], [0, 1]], [2, 3], [3, 4], 7, 5);
    expect(computeLpObjectiveBound(ctx)).toBeCloseTo(7 + 7, 9);
  });

  it('returns null when the constraint is violated at variable minima', () => {
    // x0∈[3,5], w1 W2 → minimum weight 3 > 2. Infeasible; no sound bound.
    const { ctx } = buildInstance([[3, 5]], [1], [3], 0, 2);
    expect(computeLpObjectiveBound(ctx)).toBeNull();
  });

  it('returns null for a minimize objective', () => {
    const { ctx } = buildInstance([[0, 1], [0, 1]], [2, 3], [3, 4], 0, 5, false);
    expect(computeLpObjectiveBound(ctx)).toBeNull();
  });

  it('returns null for an empty classification', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 1, 'x');
    const ctx: LpBoundContext = {
      objective: new LinearExpr([x], [1], 0),
      maximize: true,
      domains: new Map([[x.index, new Domain([0, 1])]]),
      classification: EMPTY_CLASSIFICATION,
    };
    expect(computeLpObjectiveBound(ctx)).toBeNull();
  });

  it('fractionalKnapsackUpperBound mirrors computeLpObjectiveBound for one packing', () => {
    const { ctx, vars } = buildInstance([[0, 1], [0, 1]], [2, 3], [3, 4], 0, 4);
    const packing = ctx.classification.packingConstraints[0];
    const direct = fractionalKnapsackUpperBound(ctx.objective, packing, ctx.domains);
    expect(direct).toBeCloseTo(computeLpObjectiveBound(ctx)!, 9);
    expect(vars.length).toBe(2);
  });
});

// ============================================================================
// Detection classification
// ============================================================================

describe('detectPackingConstraints', () => {
  it('classifies a valid packing constraint', () => {
    const m = new CpModel();
    const x = m.newBoolVar('x');
    const y = m.newBoolVar('y');
    m.add(x.mul(2).add(y.mul(3)).le(5));
    const result = detectPackingConstraints(m.constraints, () => true);
    expect(result.packingConstraints).toHaveLength(1);
    const p = result.packingConstraints[0];
    expect(p.ub).toBe(5);
    expect([...p.weights]).toEqual([2, 3]);
    expect(p.varIndices).toContain(x.index);
    expect(p.varIndices).toContain(y.index);
  });

  it('rejects a constraint with a negative coefficient', () => {
    const m = new CpModel();
    const x = m.newBoolVar('x');
    const y = m.newBoolVar('y');
    m.add(x.mul(-1).add(y.mul(3)).le(5)); // coeff -1 → not a packing
    const result = detectPackingConstraints(m.constraints, () => true);
    expect(result.packingConstraints).toHaveLength(0);
  });

  it('rejects a constraint with no finite upper bound (no capacity)', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 10, 'x');
    m.add(x.ge(0)); // domain [0, +Infinity] → ub infinite
    const result = detectPackingConstraints(m.constraints, () => true);
    expect(result.packingConstraints).toHaveLength(0);
  });

  it('drops zero-coefficient terms (they are free objective vars)', () => {
    const m = new CpModel();
    const x = m.newBoolVar('x');
    const y = m.newBoolVar('y');
    m.add(x.mul(2).add(y.mul(0)).le(5)); // y has weight 0 → dropped
    const result = detectPackingConstraints(m.constraints, () => true);
    expect(result.packingConstraints).toHaveLength(1);
    const p = result.packingConstraints[0];
    expect([...p.weights]).toEqual([2]);
    expect(p.varIndices).toEqual([x.index]);
  });

  it('respects the isActive filter (skips presolve-removed constraints)', () => {
    const m = new CpModel();
    const x = m.newBoolVar('x');
    const y = m.newBoolVar('y');
    m.add(x.mul(2).le(5));
    const c1 = m.add(y.mul(3).le(5));
    const result = detectPackingConstraints(m.constraints, i => i === c1.index);
    expect(result.packingConstraints).toHaveLength(1);
    expect(result.packingConstraints[0].constraintIndex).toBe(c1.index);
  });

  it('returns an empty classification when nothing qualifies', () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 10, 'x');
    m.add(x.ge(0));
    expect(detectPackingConstraints(m.constraints, () => true).packingConstraints).toHaveLength(0);
  });

  it('folds duplicate variable occurrences within one constraint into a single weight', () => {
    // x + x ≤ 6  (vars [x,x], coeffs [1,1]) → one variable with total weight 2.
    const m = new CpModel();
    const x = m.newIntVar(2, 4, 'x');
    m.add(x.add(x).le(6));
    const result = detectPackingConstraints(m.constraints, () => true);
    expect(result.packingConstraints).toHaveLength(1);
    const p = result.packingConstraints[0];
    expect(p.varIndices).toEqual([x.index]);
    expect([...p.weights]).toEqual([2]);
  });

  it('stays SOUND when a duplicated constraint variable has a negative objective coefficient', () => {
    // max -3x  s.t.  x + x ≤ 6,  x ∈ [2,4]. Feasible x ∈ [2,3]; optimum = -6 (at x=2).
    // Without weight-folding the bound would double-count x and compute -12 (< optimum → unsound).
    const m = new CpModel();
    const x = m.newIntVar(2, 4, 'x');
    const domains = new Map<number, Domain>([[x.index, new Domain([2, 4])]]);
    m.add(x.add(x).le(6));
    const classification = detectPackingConstraints(m.constraints, () => true);
    const ctx: LpBoundContext = {
      objective: new LinearExpr([x], [-3], 0),
      maximize: true,
      domains,
      classification,
    };
    const lp = computeLpObjectiveBound(ctx);
    expect(lp).not.toBeNull();
    expect(lp!).toBeGreaterThanOrEqual(-6 - EPS); // sound: ≥ true optimum
  });
});

// ============================================================================
// Soundness oracle (fast-check) — the critical correctness guarantee
// ============================================================================

describe('computeLpObjectiveBound — soundness & tightness (property-based)', () => {
  // Per-variable generator: lower bound, span (hi = lo + span), weight, coeff.
  const varArb = fc.record({
    lo: fc.integer({ min: 0, max: 3 }),
    span: fc.integer({ min: 0, max: 4 }),
    w: fc.integer({ min: 1, max: 6 }),
    c: fc.integer({ min: -3, max: 6 }),
  });

  const instanceArb = fc
    .record({
      offset: fc.integer({ min: -5, max: 5 }),
      vars: fc.array(varArb, { minLength: 2, maxLength: 4 }),
    })
    .chain(inst => {
      const totalMax = inst.vars.reduce((s, v) => s + v.w * (v.lo + v.span), 0);
      return fc.record({
        inst: fc.constant(inst),
        W: fc.integer({ min: 0, max: Math.max(0, totalMax) }),
      });
    });

  it('LP bound is a valid upper bound: lp >= true integer optimum', () => {
    fc.assert(
      fc.property(instanceArb, ({ inst, W }) => {
        const ranges = inst.vars.map(v => [v.lo, v.lo + v.span] as [number, number]);
        const weights = inst.vars.map(v => v.w);
        const coeffs = inst.vars.map(v => v.c);
        const truth = bruteForceKnapsackMax(ranges, weights, coeffs, inst.offset, W);

        const { ctx } = buildInstance(ranges, weights, coeffs, inst.offset, W);
        const lp = computeLpObjectiveBound(ctx);

        if (truth === null) {
          // Infeasible instance: LP must also report no bound (consistency).
          expect(lp).toBeNull();
        } else {
          expect(lp).not.toBeNull();
          // SOUNDNESS: the relaxation bound never underestimates the optimum.
          expect(lp!).toBeGreaterThanOrEqual(truth - EPS);
        }
      }),
      { numRuns: 500 }
    );
  });

  it('LP bound is never looser than the interval-arithmetic bound', () => {
    fc.assert(
      fc.property(instanceArb, ({ inst, W }) => {
        const ranges = inst.vars.map(v => [v.lo, v.lo + v.span] as [number, number]);
        const weights = inst.vars.map(v => v.w);
        const coeffs = inst.vars.map(v => v.c);
        if (bruteForceKnapsackMax(ranges, weights, coeffs, inst.offset, W) === null) return;

        const { ctx } = buildInstance(ranges, weights, coeffs, inst.offset, W);
        const lp = computeLpObjectiveBound(ctx);
        expect(lp).not.toBeNull();
        // Interval max: positive coeffs at hi, negative at lo.
        const intervalMax =
          inst.offset +
          inst.vars.reduce((s, v) => s + (v.c > 0 ? v.c * (v.lo + v.span) : v.c * v.lo), 0);
        // TIGHTNESS: LP bound respects the packing, so it is at most the interval bound.
        expect(lp!).toBeLessThanOrEqual(intervalMax + EPS);
      }),
      { numRuns: 500 }
    );
  });
});
