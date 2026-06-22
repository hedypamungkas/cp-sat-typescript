/**
 * MaxEquality / MinEquality correctness property tests.
 *
 * The search propagators (_propagateMaxEquality/_propagateMinEquality) now
 * tighten bounds during search (not just check). These tests lock correctness
 * across random instances: the solved target must equal max/min of the
 * expressions. (The propagators are private, so we exercise them via solve().)
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';

describe('MaxEquality / MinEquality — correctness (property)', () => {
  // Each expression variable gets its own [lo, hi] domain (lo <= hi).
  const specArb = fc
    .array(
      fc.record({
        lo: fc.integer({ min: 0, max: 3 }),
        hi: fc.integer({ min: 3, max: 8 }),
      }),
      { minLength: 2, maxLength: 3 }
    )
    .filter((specs) => specs.every((s) => s.lo <= s.hi));

  it('addMaxEquality: target == max(expressions) for random instances', () => {
    fc.assert(
      fc.property(specArb, (specs) => {
        const model = new CpModel();
        const target = model.newIntVar(0, 12, 't'); // intentionally wider than expr max
        const vars = specs.map((s, i) => model.newIntVar(s.lo, s.hi, `v${i}`));
        model.addMaxEquality(target, vars);
        const solver = new CpSolver();
        solver.parameters.maxTimeInSeconds = 5;
        const status = solver.solve(model);
        expect([CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE]).toContain(status);
        const t = solver.value(target);
        const m = Math.max(...vars.map((v) => solver.value(v)));
        expect(t).toBe(m);
      }),
      { numRuns: 200 }
    );
  });

  it('addMinEquality: target == min(expressions) for random instances', () => {
    fc.assert(
      fc.property(specArb, (specs) => {
        const model = new CpModel();
        const target = model.newIntVar(0, 12, 't');
        const vars = specs.map((s, i) => model.newIntVar(s.lo, s.hi, `v${i}`));
        model.addMinEquality(target, vars);
        const solver = new CpSolver();
        solver.parameters.maxTimeInSeconds = 5;
        const status = solver.solve(model);
        expect([CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE]).toContain(status);
        const t = solver.value(target);
        const m = Math.min(...vars.map((v) => solver.value(v)));
        expect(t).toBe(m);
      }),
      { numRuns: 200 }
    );
  });
});
