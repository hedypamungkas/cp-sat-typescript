/**
 * NoOverlap2D propagator ISOLATION + SOUNDNESS tests.
 *
 * Drives propagateNoOverlap2D directly and asserts the brute-force soundness
 * property (no supported x/y value removed; no false INFEASIBLE). This locks
 * the S7 fix (energy min-overlap over-count) and confirms the S8 pairwise
 * forced-separation logic is sound.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CpModel } from '../src/model';
import { NoOverlap2DConstraint } from '../src/constraints';
import type { IntervalVar } from '../src/types';
import { propagateNoOverlap2D } from '../src/nooverlap2d-propagation';
import { testPropagateLinear } from './helpers/propagate-linear';
import {
  makeFixedInterval,
  buildDomains,
  snapshotDomains,
  checkPropagatorSoundness,
  noOverlap2DFeasible,
} from './helpers/propagator-test-utils';

describe('NoOverlap2D propagator — brute-force soundness property', () => {
  const rectSpecArb = fc.array(
    fc.record({
      xDom: fc.integer({ min: 2, max: 6 }),
      yDom: fc.integer({ min: 2, max: 6 }),
      w: fc.integer({ min: 1, max: 3 }),
      h: fc.integer({ min: 1, max: 3 }),
    }),
    { minLength: 2, maxLength: 3 }
  );

  it('propagateNoOverlap2D: never removes a supported value, never false-INFEASIBLE', () => {
    fc.assert(
      fc.property(rectSpecArb, (specs) => {
        const model = new CpModel();
        const xStarts = [];
        const yStarts = [];
        const xIvs: IntervalVar[] = [];
        const yIvs: IntervalVar[] = [];
        const widths: number[] = [];
        const heights: number[] = [];
        for (let i = 0; i < specs.length; i++) {
          const x = model.newIntVar(0, specs[i].xDom, `x${i}`);
          const y = model.newIntVar(0, specs[i].yDom, `y${i}`);
          xStarts.push(x);
          yStarts.push(y);
          xIvs.push(makeFixedInterval(x, specs[i].w, `xi${i}`));
          yIvs.push(makeFixedInterval(y, specs[i].h, `yi${i}`));
          widths.push(specs[i].w);
          heights.push(specs[i].h);
        }
        const ct = new NoOverlap2DConstraint(0, xIvs, yIvs);
        const allVars = [...xStarts, ...yStarts];
        const original = buildDomains(allVars);
        const domains = snapshotDomains(allVars, original);
        const result = propagateNoOverlap2D(ct, domains, testPropagateLinear);
        const feasible = noOverlap2DFeasible(
          xStarts.map((s) => s.index),
          yStarts.map((s) => s.index),
          widths,
          heights
        );
        const v = checkPropagatorSoundness(allVars, original, domains, result, feasible);
        expect(v, v.map((x) => x.message).join(' | ')).toEqual([]);
      }),
      { numRuns: 300 }
    );
  });
});

describe('NoOverlap2D — S7 energy min-overlap counterexample (regression)', () => {
  it('does not declare a placeable-aside rectangle infeasible', () => {
    // A rectangle that can be pushed entirely outside the box on the left must
    // not be counted as mandatory-overlap. Construct two rectangles where one
    // can sit beside the other; the propagator must stay sound.
    const model = new CpModel();
    // Rect A: x in [0,4], width 2 (can sit at x=0..4). Rect B: x in [5,9], width 2.
    // They never need to overlap in x; feasible in x alone. Give them room in y too.
    const xa = model.newIntVar(0, 4, 'xa');
    const xb = model.newIntVar(5, 9, 'xb');
    const ya = model.newIntVar(0, 3, 'ya');
    const yb = model.newIntVar(0, 3, 'yb');
    const xIvs = [makeFixedInterval(xa, 2, 'xa'), makeFixedInterval(xb, 2, 'xb')];
    const yIvs = [makeFixedInterval(ya, 2, 'ya'), makeFixedInterval(yb, 2, 'yb')];
    const ct = new NoOverlap2DConstraint(0, xIvs, yIvs);
    const allVars = [xa, xb, ya, yb];
    const original = buildDomains(allVars);
    const domains = snapshotDomains(allVars, original);
    const result = propagateNoOverlap2D(ct, domains, testPropagateLinear);
    expect(result).not.toBe('INFEASIBLE');
    const feasible = noOverlap2DFeasible([xa.index, xb.index], [ya.index, yb.index], [2, 2], [2, 2]);
    const v = checkPropagatorSoundness(allVars, original, domains, result, feasible);
    expect(v).toEqual([]);
  });
});
