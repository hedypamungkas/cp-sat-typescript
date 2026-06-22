/**
 * Reservoir propagator ISOLATION + SOUNDNESS property test.
 *
 * Drives propagateReservoir directly and brute-force-checks "no feasible event
 * time assignment's value is ever removed, no false INFEASIBLE". This is the
 * safety net for the forward-sweep fix and the backward sweep (S6).
 *
 * Scope: all-present events (empty activeLiterals → activeState 'present'),
 * constant levelChanges, simple-variable time expressions. Two generators:
 *  - disjoint time domains (regression; no simultaneous events), and
 *  - OVERLAPPING time domains (exercises time tightening) — handled by an
 *    EXISTENTIAL oracle: an assignment is feasible iff some ordering of
 *    simultaneous events keeps every prefix-cumulative in [minLevel, maxLevel].
 * minLevel ≤ 0 ≤ maxLevel so the initial level 0 is feasible.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CpModel } from '../src/model';
import { LinearExpr, IntVar } from '../src/types';
import { ReservoirConstraint } from '../src/constraints';
import { propagateReservoir } from '../src/scheduling-propagation';
import { testPropagateLinear } from './helpers/propagate-linear';
import {
  buildDomains,
  snapshotDomains,
  checkPropagatorSoundness,
} from './helpers/propagator-test-utils';

function buildReservoir(
  timeVars: IntVar[],
  deltas: number[],
  minLevel: number,
  maxLevel: number
): ReservoirConstraint {
  const times = timeVars.map((v) => LinearExpr.fromVar(v));
  const levelChanges = deltas.map((d) => LinearExpr.fromConstant(d));
  return new ReservoirConstraint(0, times, levelChanges, [], minLevel, maxLevel, 'res');
}

/** All permutations of a small array (n ≤ ~5). */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr.slice()];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) result.push([arr[i], ...p]);
  }
  return result;
}

/**
 * Existential ground-truth oracle: an assignment is feasible iff some ordering
 * of simultaneous events keeps every prefix-cumulative level in bounds. Events
 * at distinct times are ordered by time; only simultaneous events may permute.
 */
function reservoirFeasible(
  timeVarIndices: number[],
  deltas: number[],
  minLevel: number,
  maxLevel: number
): (a: Map<number, number>) => boolean {
  return (a) => {
    const evs = timeVarIndices
      .map((idx, i) => ({ time: a.get(idx)!, delta: deltas[i] }))
      .sort((x, y) => x.time - y.time);
    // Group simultaneous events.
    const groups: { time: number; delta: number }[][] = [];
    for (const e of evs) {
      const last = groups[groups.length - 1];
      if (last && last[0].time === e.time) last.push(e);
      else groups.push([e]);
    }
    // DFS over groups; try every intra-group permutation, keep running level in bounds.
    const dfs = (gi: number, level: number): boolean => {
      if (gi === groups.length) return true;
      for (const perm of permutations(groups[gi])) {
        let lvl = level;
        let ok = true;
        for (const e of perm) {
          lvl += e.delta;
          if (lvl < minLevel || lvl > maxLevel) {
            ok = false;
            break;
          }
        }
        if (ok && dfs(gi + 1, lvl)) return true;
      }
      return false;
    };
    return dfs(0, 0);
  };
}

describe('Reservoir propagator — brute-force soundness property', () => {
  // (A) Disjoint time domains — regression (no simultaneous events).
  const W = 2;
  const K = 4;
  const disjointArb = fc
    .integer({ min: 2, max: 3 })
    .chain((nEvents) =>
      fc.record({
        nEvents: fc.constant(nEvents),
        deltas: fc.array(
          fc.integer({ min: -3, max: 3 }).filter((d) => d !== 0),
          { minLength: nEvents, maxLength: nEvents }
        ),
        minLevel: fc.integer({ min: -3, max: 0 }),
        maxLevel: fc.integer({ min: 1, max: 5 }),
      })
    );

  it('disjoint domains: never removes a supported value, never false-INFEASIBLE', () => {
    fc.assert(
      fc.property(disjointArb, (spec) => {
        const model = new CpModel();
        const timeVars: IntVar[] = [];
        for (let i = 0; i < spec.nEvents; i++) {
          timeVars.push(model.newIntVar(i * K, i * K + W, `t${i}`));
        }
        const ct = buildReservoir(timeVars, spec.deltas, spec.minLevel, spec.maxLevel);
        const original = buildDomains(timeVars);
        const domains = snapshotDomains(timeVars, original);
        const result = propagateReservoir(ct, domains, testPropagateLinear);
        const feasible = reservoirFeasible(
          timeVars.map((v) => v.index),
          spec.deltas,
          spec.minLevel,
          spec.maxLevel
        );
        const v = checkPropagatorSoundness(timeVars, original, domains, result, feasible);
        expect(v, v.map((x) => x.message).join(' | ')).toEqual([]);
      }),
      { numRuns: 300 }
    );
  });

  // (B) Overlapping time domains — exercises time tightening (forward/backward).
  const overlapArb = fc.record({
    nEvents: fc.integer({ min: 2, max: 3 }),
    deltas: fc.array(
      fc.integer({ min: -4, max: 4 }).filter((d) => d !== 0),
      { minLength: 3, maxLength: 3 }
    ),
    minLevel: fc.integer({ min: -4, max: 0 }),
    maxLevel: fc.integer({ min: 1, max: 6 }),
  });

  it('overlapping domains: never removes a supported value, never false-INFEASIBLE', () => {
    fc.assert(
      fc.property(overlapArb, (spec) => {
        const n = spec.nEvents;
        const model = new CpModel();
        const timeVars: IntVar[] = [];
        for (let i = 0; i < n; i++) {
          timeVars.push(model.newIntVar(0, 8, `t${i}`));
        }
        const deltas = spec.deltas.slice(0, n);
        const ct = buildReservoir(timeVars, deltas, spec.minLevel, spec.maxLevel);
        const original = buildDomains(timeVars);
        const domains = snapshotDomains(timeVars, original);
        const result = propagateReservoir(ct, domains, testPropagateLinear);
        const feasible = reservoirFeasible(
          timeVars.map((v) => v.index),
          deltas,
          spec.minLevel,
          spec.maxLevel
        );
        const v = checkPropagatorSoundness(timeVars, original, domains, result, feasible);
        expect(v, v.map((x) => x.message).join(' | ')).toEqual([]);
      }),
      { numRuns: 300 }
    );
  });
});

describe('Reservoir propagator — forward tightening (strength)', () => {
  it('pushes a tentative positive event later when forcing it in would overflow', () => {
    // A=+5 @0 (definite), R=-5 @2 (definite), B=+3 in [0,4] (tentative), maxLevel=5.
    // Forcing B into the prefix @0 gives level 5+3=8 > 5, so B must occur >= nextTime=2.
    // Feasible with B in {2,3,4} (R removes A's +5 before B arrives). Supported: {2,3,4}.
    const model = new CpModel();
    const ta = model.newIntVar(0, 0, 'ta');
    const tr = model.newIntVar(2, 2, 'tr');
    const tb = model.newIntVar(0, 4, 'tb');
    const ct = buildReservoir([ta, tr, tb], [5, -5, 3], 0, 5);
    const original = buildDomains([ta, tr, tb]);
    const domains = snapshotDomains([ta, tr, tb], original);
    const result = propagateReservoir(ct, domains, testPropagateLinear);
    expect(result).toBe('CHANGED');
    expect(domains.get(tb.index)!.min).toBe(2); // pushed from 0 to 2
    // Sound: only unsupported values {0,1} removed.
    const feasible = reservoirFeasible([ta.index, tr.index, tb.index], [5, -5, 3], 0, 5);
    const v = checkPropagatorSoundness([ta, tr, tb], original, domains, result, feasible);
    expect(v).toEqual([]);
  });

  it('pushes a tentative positive event earlier when excluding it would underflow', () => {
    // A=+3 @0 (definite), R=-5 @2 (definite), B=+3 in [0,4] (tentative),
    // minLevel=1. Excluding B from the prefix @2 gives level 3-5=-2 < 1, so B
    // must occur <= 2 (provide its +3 before the removal). Supported: {0,1,2}.
    const model = new CpModel();
    const ta = model.newIntVar(0, 0, 'ta');
    const tr = model.newIntVar(2, 2, 'tr');
    const tb = model.newIntVar(0, 4, 'tb');
    const ct = buildReservoir([ta, tr, tb], [3, -5, 3], 1, 6);
    const original = buildDomains([ta, tr, tb]);
    const domains = snapshotDomains([ta, tr, tb], original);
    const result = propagateReservoir(ct, domains, testPropagateLinear);
    expect(result).toBe('CHANGED');
    expect(domains.get(tb.index)!.max).toBe(2); // timeMax pushed from 4 to 2
    // Sound: only unsupported values {3,4} removed.
    const feasible = reservoirFeasible([ta.index, tr.index, tb.index], [3, -5, 3], 1, 6);
    const v = checkPropagatorSoundness([ta, tr, tb], original, domains, result, feasible);
    expect(v).toEqual([]);
  });
});
