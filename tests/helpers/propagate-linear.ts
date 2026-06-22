/**
 * Test oracle for LinearPropagateFn.
 *
 * The scheduling propagators delegate tightening of complex start/size/end
 * expressions through a `LinearPropagateFn` callback. In production this is
 * `CpSolver._propagateLinear`. For isolation tests we need a *correct* linear
 * bounds-tightening routine; this is a faithful reimplementation of the
 * `lb <= sum(vars[i]*coeffs[i]) <= ub` propagation (bounds consistency) that
 * does not depend on solver internals, so propagator tests stay isolated.
 *
 * It only tightens the outer [min,max] envelope of each domain (intersecting
 * multi-interval domains with the new envelope), matching the production
 * behaviour for the cases the scheduling propagators actually delegate.
 */
import { Domain, IntVar, type DomainIntervals } from '../../src/types';
import type { LinearPropagateFn } from '../../src/scheduling-propagation';

export const testPropagateLinear: LinearPropagateFn = (
  vars: IntVar[],
  coeffs: number[],
  lb: number,
  ub: number,
  domains: Map<number, Domain>
): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' => {
  // Compute current min/max of the expression.
  let exprMin = 0;
  let exprMax = 0;
  for (let i = 0; i < vars.length; i++) {
    const d = domains.get(vars[i].index);
    if (!d || d.isEmpty) return 'INFEASIBLE';
    const c = coeffs[i];
    if (c > 0) {
      exprMin += c * d.min;
      exprMax += c * d.max;
    } else if (c < 0) {
      exprMin += c * d.max;
      exprMax += c * d.min;
    }
  }

  if (exprMax < lb || exprMin > ub) return 'INFEASIBLE';

  let changed = false;
  for (let i = 0; i < vars.length; i++) {
    const c = coeffs[i];
    if (c === 0) continue;
    const d = domains.get(vars[i].index);
    if (!d || d.isEmpty) return 'INFEASIBLE';

    // Min/max of all other terms.
    let otherMin = 0;
    let otherMax = 0;
    for (let j = 0; j < vars.length; j++) {
      if (j === i) continue;
      const dj = domains.get(vars[j].index);
      if (!dj || dj.isEmpty) return 'INFEASIBLE';
      const cj = coeffs[j];
      if (cj > 0) {
        otherMin += cj * dj.min;
        otherMax += cj * dj.max;
      } else if (cj < 0) {
        otherMin += cj * dj.max;
        otherMax += cj * dj.min;
      }
    }

    let newMin: number;
    let newMax: number;
    if (c > 0) {
      newMin = Math.ceil((lb - otherMax) / c);
      newMax = Math.floor((ub - otherMin) / c);
    } else {
      // c < 0: inequality reverses
      newMin = Math.ceil((ub - otherMin) / c);
      newMax = Math.floor((lb - otherMax) / c);
    }

    const tightenedMin = Math.max(d.min, newMin);
    const tightenedMax = Math.min(d.max, newMax);
    if (tightenedMin > tightenedMax) return 'INFEASIBLE';

    if (tightenedMin > d.min || tightenedMax < d.max) {
      const newIntervals: DomainIntervals = [];
      for (const [start, end] of d.intervals) {
        const s = Math.max(start, tightenedMin);
        const e = Math.min(end, tightenedMax);
        if (s <= e) newIntervals.push([s, e]);
      }
      if (newIntervals.length === 0) return 'INFEASIBLE';
      const newDomain = new Domain(newIntervals);
      if (newDomain.size < d.size) {
        domains.set(vars[i].index, newDomain);
        changed = true;
      }
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
};
