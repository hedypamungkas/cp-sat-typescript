/**
 * Scheduling propagator ISOLATION + SOUNDNESS tests.
 *
 * Unlike tests/scheduling-propagation.test.ts (which drives the full CpSolver
 * pipeline), these call each propagator directly and assert:
 *   (a) exact pruned bounds for known cases, and
 *   (b) a brute-force soundness property: a propagator never removes a value
 *       that participates in a feasible complete assignment, and never reports
 *       INFEASIBLE when a feasible assignment exists.
 *
 * The property tests are what adjudicate the disputed S2 (precedence) and
 * S4 (not-last) claims, and lock the S3/S5 edge-finding fixes.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CpModel } from '../src/model';
import { NoOverlapConstraint, CumulativeConstraint } from '../src/constraints';
import type { Domain } from '../src/types';
import {
  propagateNoOverlap,
  propagateNoOverlapDetectable,
  propagateNoOverlapNotLast,
  propagateNoOverlapEdgeFinding,
  propagateCumulativeTimeTable,
  propagateCumulativeEdgeFinding,
} from '../src/scheduling-propagation';
import { testPropagateLinear } from './helpers/propagate-linear';
import {
  makeFixedInterval,
  buildDomains,
  snapshotDomains,
  checkPropagatorSoundness,
  noOverlapFeasible,
  cumulativeFeasible,
} from './helpers/propagator-test-utils';

type Propagator = (
  ct: NoOverlapConstraint | CumulativeConstraint,
  domains: Map<number, Domain>,
  p: typeof testPropagateLinear
) => 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE';

// Run a NoOverlap-family propagator on a fresh clone and return soundness violations.
function runNoOverlapSound(
  fn: Propagator,
  ct: NoOverlapConstraint,
  starts: { index: number }[],
  sizes: number[],
  original: Map<number, Domain>
) {
  const domains = snapshotDomains(starts as any, original);
  const result = fn(ct, domains, testPropagateLinear);
  const feasible = noOverlapFeasible(starts.map((s) => s.index), sizes);
  return checkPropagatorSoundness(starts as any, original, domains, result, feasible);
}

describe('NoOverlap propagators — exact bound isolation', () => {
  it('propagateNoOverlap detects mandatory overlap as INFEASIBLE', () => {
    const model = new CpModel();
    const s1 = model.newIntVar(0, 0, 's1');
    const s2 = model.newIntVar(0, 0, 's2');
    const ct = new NoOverlapConstraint(0, [makeFixedInterval(s1, 3, 'a'), makeFixedInterval(s2, 3, 'b')]);
    const domains = buildDomains([s1, s2]);
    const result = propagateNoOverlap(ct, domains, testPropagateLinear);
    expect(result).toBe('INFEASIBLE');
  });

  it('propagateNoOverlap tightens start bounds for adjacent forced tasks', () => {
    // Two size-3 tasks both in [0,5]: if s1=0 then s2>=3. Propagation should at
    // least not be INFEASIBLE and keep the model feasible (sound).
    const model = new CpModel();
    const s1 = model.newIntVar(0, 5, 's1');
    const s2 = model.newIntVar(0, 5, 's2');
    const ct = new NoOverlapConstraint(0, [makeFixedInterval(s1, 3, 'a'), makeFixedInterval(s2, 3, 'b')]);
    const original = buildDomains([s1, s2]);
    const domains = snapshotDomains([s1, s2], original);
    const result = propagateNoOverlap(ct, domains, testPropagateLinear);
    expect(result).not.toBe('INFEASIBLE');
    const v = runNoOverlapSound(propagateNoOverlap, ct, [s1, s2], [3, 3], original);
    expect(v).toEqual([]);
  });

  it('propagateNoOverlapEdgeFinding pushes a start past a busy period (BLN)', () => {
    // Two size-2 tasks est=0/lct=5; one size-2 task est=3/lct=7. The third task
    // cannot be scheduled after the first two within their window, so BLN
    // edge-finding forces its startMin from 3 to 4 (the old finder did nothing).
    const model = new CpModel();
    const s0 = model.newIntVar(0, 3, 's0');
    const s1 = model.newIntVar(0, 3, 's1');
    const s2 = model.newIntVar(3, 5, 's2');
    const ct = new NoOverlapConstraint(0, [
      makeFixedInterval(s0, 2, 'a'),
      makeFixedInterval(s1, 2, 'b'),
      makeFixedInterval(s2, 2, 'c'),
    ]);
    const original = buildDomains([s0, s1, s2]);
    const domains = snapshotDomains([s0, s1, s2], original);
    const result = propagateNoOverlapEdgeFinding(ct, domains, testPropagateLinear);
    expect(result).toBe('CHANGED');
    expect(domains.get(s2.index)!.min).toBe(4);
    expect(domains.get(s0.index)!.min).toBe(0);
    expect(domains.get(s1.index)!.min).toBe(0);
    // And sound against the brute-force oracle.
    const sound = runNoOverlapSound(
      propagateNoOverlapEdgeFinding, ct, [s0, s1, s2], [2, 2, 2], original
    );
    expect(sound).toEqual([]);
  });
});

describe('NoOverlap propagators — brute-force soundness property', () => {
  // Each task: its own start domain [0, domMax] and a fixed size.
  const taskSpecArb = fc.array(
    fc.record({
      domMax: fc.integer({ min: 2, max: 8 }),
      size: fc.integer({ min: 1, max: 4 }),
    }),
    { minLength: 2, maxLength: 3 }
  );

  const NOVERLAP_PROPAGATORS: Array<[string, Propagator]> = [
    ['propagateNoOverlap', propagateNoOverlap as unknown as Propagator],
    ['propagateNoOverlapDetectable', propagateNoOverlapDetectable as unknown as Propagator],
    ['propagateNoOverlapNotLast', propagateNoOverlapNotLast as unknown as Propagator],
    ['propagateNoOverlapEdgeFinding', propagateNoOverlapEdgeFinding as unknown as Propagator],
  ];

  for (const [name, fn] of NOVERLAP_PROPAGATORS) {
    it(`${name}: never removes a supported value, never false-INFEASIBLE`, () => {
      fc.assert(
        fc.property(taskSpecArb, (specs) => {
          const model = new CpModel();
          const starts = [];
          const ivs = [];
          const sizes: number[] = [];
          for (let i = 0; i < specs.length; i++) {
            const s = model.newIntVar(0, specs[i].domMax, `s${i}`);
            starts.push(s);
            ivs.push(makeFixedInterval(s, specs[i].size, `t${i}`));
            sizes.push(specs[i].size);
          }
          const ct = new NoOverlapConstraint(0, ivs);
          const original = buildDomains(starts);
          const v = runNoOverlapSound(fn, ct, starts, sizes, original);
          expect(v, v.map((x) => x.message).join(' | ')).toEqual([]);
        }),
        { numRuns: 300 }
      );
    });
  }
});

describe('NoOverlap propagators — edge-finding stress (heterogeneous domains)', () => {
  // Heterogeneous startMin/startMax so edge-finding's distinguishing case
  // (a task forced past another's busy period) actually triggers — the base
  // generator uses all-zero startMin, which reduces edge-finding to overload.
  const strongSpecArb = fc
    .array(
      fc.record({
        lo: fc.integer({ min: 0, max: 4 }),
        hi: fc.integer({ min: 4, max: 8 }),
        size: fc.integer({ min: 1, max: 3 }),
      }),
      { minLength: 3, maxLength: 4 }
    )
    .filter((specs) => specs.every((s) => s.lo <= s.hi));

  const EDGE_PROPAGATORS: Array<[string, Propagator]> = [
    ['propagateNoOverlap', propagateNoOverlap as unknown as Propagator],
    ['propagateNoOverlapDetectable', propagateNoOverlapDetectable as unknown as Propagator],
    ['propagateNoOverlapNotLast', propagateNoOverlapNotLast as unknown as Propagator],
    ['propagateNoOverlapEdgeFinding', propagateNoOverlapEdgeFinding as unknown as Propagator],
  ];

  for (const [name, fn] of EDGE_PROPAGATORS) {
    it(`${name}: sound under heterogeneous startMin/startMax (edge-finding stress)`, () => {
      fc.assert(
        fc.property(strongSpecArb, (specs) => {
          const model = new CpModel();
          const starts = [];
          const ivs = [];
          const sizes: number[] = [];
          for (let i = 0; i < specs.length; i++) {
            const s = model.newIntVar(specs[i].lo, specs[i].hi, `s${i}`);
            starts.push(s);
            ivs.push(makeFixedInterval(s, specs[i].size, `t${i}`));
            sizes.push(specs[i].size);
          }
          const ct = new NoOverlapConstraint(0, ivs);
          const original = buildDomains(starts);
          const v = runNoOverlapSound(fn, ct, starts, sizes, original);
          expect(v, v.map((x) => x.message).join(' | ')).toEqual([]);
        }),
        { numRuns: 300 }
      );
    });
  }
});

describe('Cumulative propagators — brute-force soundness property', () => {
  const taskSpecArb = fc.array(
    fc.record({
      domMax: fc.integer({ min: 2, max: 7 }),
      size: fc.integer({ min: 1, max: 3 }),
      demand: fc.integer({ min: 1, max: 3 }),
    }),
    { minLength: 2, maxLength: 3 }
  );
  const capacityArb = fc.integer({ min: 1, max: 6 });

  const CUMUL_PROPAGATORS: Array<[string, Propagator]> = [
    ['propagateCumulativeTimeTable', propagateCumulativeTimeTable as unknown as Propagator],
    ['propagateCumulativeEdgeFinding', propagateCumulativeEdgeFinding as unknown as Propagator],
  ];

  for (const [name, fn] of CUMUL_PROPAGATORS) {
    it(`${name}: never removes a supported value, never false-INFEASIBLE`, () => {
      fc.assert(
        fc.property(taskSpecArb, capacityArb, (specs, capacity) => {
          const model = new CpModel();
          const starts = [];
          const ivs = [];
          const sizes: number[] = [];
          const demands: number[] = [];
          for (let i = 0; i < specs.length; i++) {
            const s = model.newIntVar(0, specs[i].domMax, `s${i}`);
            starts.push(s);
            ivs.push(makeFixedInterval(s, specs[i].size, `t${i}`));
            sizes.push(specs[i].size);
            demands.push(specs[i].demand);
          }
          // capacity as a constant expression
          const ct = new CumulativeConstraint(0, ivs, demands.map((d) => makeConstant(d)), makeConstant(capacity));
          const original = buildDomains(starts);
          const feasible = cumulativeFeasible(starts.map((s) => s.index), sizes, demands, capacity);

          const domains = snapshotDomains(starts, original);
          const result = fn(ct, domains, testPropagateLinear);
          const v = checkPropagatorSoundness(starts, original, domains, result, feasible);
          expect(v, v.map((x) => x.message).join(' | ')).toEqual([]);
        }),
        { numRuns: 300 }
      );
    });
  }
});

// Helper: build a constant LinearExpr (capacity / demand values are constants).
import { LinearExpr } from '../src/types';
function makeConstant(value: number): LinearExpr {
  return LinearExpr.fromConstant(value);
}
