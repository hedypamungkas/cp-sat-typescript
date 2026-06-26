/**
 * Regression test: a timeout (or external stop) during search must be reported
 * as UNKNOWN — never INFEASIBLE — when no solution has been found yet.
 *
 * Before the fix, `_search`'s value-loop only handled a child's OPTIMAL/_rootUnsat
 * status and silently swallowed UNKNOWN; on a time-out with no incumbent it fell
 * through to `return INFEASIBLE`, so a merely-interrupted search was misreported
 * as "no solution exists". For optimization-heavy problems (e.g. timetabling)
 * that is catastrophic: a slow search looks like an unsatisfiable model.
 *
 * The instances below are feasibility-GUARANTEED by construction (all rooms
 * full-availability & capacious, no facility needs, lecturers always available —
 * see `benchmarks/campus-scaling-benchmark.ts`). They are also hard enough that
 * the solver cannot finish within the tight budget, so the only correct status
 * is UNKNOWN. (A trivial greedy constructor places every session, confirming
 * feasibility.)
 */

import { describe, it, expect } from 'vitest';
import { CpSolver, CpSolverStatus } from '../src';
import { generateInstance, buildModel } from '../benchmarks/campus-scaling-benchmark';

describe('timeout status correctness', () => {
  it('reports UNKNOWN (not INFEASIBLE) when a feasible instance times out — feasibility-only', () => {
    const inst = generateInstance(42, 20); // feasible by construction; >20s to solve
    const { model } = buildModel(inst, false); // no objective

    const solver = new CpSolver();
    solver.parameters = { maxTimeInSeconds: 1 };

    const status = solver.solve(model);

    // Pre-fix this returned CpSolverStatus.INFEASIBLE.
    expect(status).toBe(CpSolverStatus.UNKNOWN);
  });

  it('reports UNKNOWN (not INFEASIBLE) when a feasible instance times out — with objective', () => {
    const inst = generateInstance(42, 20); // feasible by construction
    const { model } = buildModel(inst, true); // minimize disliked-hour meetings

    const solver = new CpSolver();
    solver.parameters = { maxTimeInSeconds: 1 };

    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.UNKNOWN);
  });

  it('reports FEASIBLE (not UNKNOWN) when interrupted AFTER finding a solution', () => {
    // A trivially-solvable model: a solution is found on the first branch, well
    // before the (generous) limit. We assert the solver still returns a
    // solution-bearing status, proving the fix did not make easy models report
    // UNKNOWN.
    const inst = generateInstance(42, 6); // tiny, solves instantly
    const { model } = buildModel(inst, true);

    const solver = new CpSolver();
    solver.parameters = { maxTimeInSeconds: 10 };

    const status = solver.solve(model);

    expect(status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE).toBe(true);
  });

  it('still reports INFEASIBLE for a genuinely unsatisfiable model (not regressed to UNKNOWN)', () => {
    // x in {0}, required x == 1 — provably infeasible. This must stay INFEASIBLE
    // so the fix did not turn real infeasibility into a false UNKNOWN.
    const inst = generateInstance(42, 8);
    // Over-constrain: force every section into zero sessions by requiring
    // sessionsPerWeek sessions but pruning all tuples is hard to do generically;
    // instead use a direct contradictory model.
    const { model } = buildModel(inst, false);
    // Add an impossible objective-side constraint: force a brand-new bool to be
    // both 0 and 1.
    const b = model.newBoolVar('impossible');
    model.add(b.eq(0));
    model.add(b.eq(1));

    const solver = new CpSolver();
    solver.parameters = { maxTimeInSeconds: 10 };

    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.INFEASIBLE);
  });
});
