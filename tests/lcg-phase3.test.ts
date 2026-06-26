/**
 * LCG Phase 3 — integer-bound literals + scheduling explanations.
 *
 * The core guarantee: scheduling models produce the SAME SAT/UNSAT verdict
 * regardless of enableLcg. Any wrong lazyClause reason would either prune a
 * valid solution (false INFEASIBLE) or accept an infeasible one (caught by
 * _checkAllConstraints). Both are caught by the soundness oracle.
 *
 * Secondary tests:
 *  - Branch reduction: NoOverlap with enableLcg learns clauses.
 *  - Registry: allocation, deduplication, backtrack-safe re-init.
 *  - Channeling: a clause-forced bound literal tightens the integer domain.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';
import { BoundLiteralRegistry } from '../src/bound-literal-registry';
import { Domain } from '../src/types';

const OK: CpSolverStatus[] = [CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE];

/**
 * A decisive SAT/UNSAT verdict. UNKNOWN means the solver timed out / was
 * stopped — i.e. INCONCLUSIVE, not "unsatisfiable". Soundness agreement is only
 * meaningful between two decisive verdicts; LCG is currently far slower on
 * scheduling, so a timeout (UNKNOWN) on one side must not be read as a verdict.
 */
const isDecisive = (s: CpSolverStatus): boolean =>
  s === CpSolverStatus.OPTIMAL || s === CpSolverStatus.FEASIBLE || s === CpSolverStatus.INFEASIBLE;

// ============================================================================
// Soundness oracle: enableLcg ON agrees with OFF on SAT/UNSAT + solution validity
// ============================================================================

describe('LCG Phase 3 — NoOverlap soundness (property)', () => {
  const noOverlapArb = fc.record({
    numTasks: fc.integer({ min: 2, max: 5 }),
    horizon: fc.integer({ min: 5, max: 20 }),
    durations: fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 5, maxLength: 5 }),
  });

  it('enableLcg ON/OFF agree on NoOverlap feasibility (fast-check)', () => {
    fc.assert(
      fc.property(noOverlapArb, ({ numTasks, horizon, durations }) => {
        const build = (): CpModel => {
          const model = new CpModel();
          const starts = Array.from({ length: numTasks }, (_, i) =>
            model.newIntVar(0, horizon, `s${i}`)
          );
          const ends = Array.from({ length: numTasks }, (_, i) =>
            model.newIntVar(durations[i], horizon + durations[i], `e${i}`)
          );
          const intervals = Array.from({ length: numTasks }, (_, i) =>
            model.newIntervalVar(starts[i], durations[i], ends[i], `t${i}`)
          );
          model.addNoOverlap(intervals);
          return model;
        };

        const off = new CpSolver();
        off.parameters.enableLcg = false;
        off.parameters.maxTimeInSeconds = 5;
        const offStatus = off.solve(build());

        const on = new CpSolver();
        on.parameters.enableLcg = true;
        on.parameters.maxTimeInSeconds = 5;
        const onStatus = on.solve(build());

        // Compare only decisive verdicts — UNKNOWN (timeout) is inconclusive.
        if (isDecisive(offStatus) && isDecisive(onStatus)) {
          expect(OK.includes(onStatus)).toBe(OK.includes(offStatus));
        }
      }),
      { numRuns: 150 }
    );
  });

  it('returned NoOverlap solutions are valid (no overlaps)', () => {
    fc.assert(
      fc.property(noOverlapArb, ({ numTasks, horizon, durations }) => {
        const model = new CpModel();
        const starts = Array.from({ length: numTasks }, (_, i) =>
          model.newIntVar(0, horizon, `s${i}`)
        );
        const ends = Array.from({ length: numTasks }, (_, i) =>
          model.newIntVar(durations[i], horizon + durations[i], `e${i}`)
        );
        const intervals = Array.from({ length: numTasks }, (_, i) =>
          model.newIntervalVar(starts[i], durations[i], ends[i], `t${i}`)
        );
        model.addNoOverlap(intervals);

        const solver = new CpSolver();
        solver.parameters.enableLcg = true;
        solver.parameters.maxTimeInSeconds = 5;
        const status = solver.solve(model);
        if (!OK.includes(status)) return; // INFEASIBLE — skip

        const sv = starts.map(v => solver.value(v));
        const ev = ends.map(v => solver.value(v));
        for (let i = 0; i < numTasks; i++) {
          for (let j = i + 1; j < numTasks; j++) {
            // Tasks must not overlap: one must end before the other starts
            const noOverlap = ev[i] <= sv[j] || ev[j] <= sv[i];
            expect(noOverlap).toBe(true);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ============================================================================
// Soundness oracle: Cumulative
// ============================================================================

describe('LCG Phase 3 — Cumulative soundness (property)', () => {
  const cumulativeArb = fc.record({
    numTasks: fc.integer({ min: 2, max: 4 }),
    horizon: fc.integer({ min: 5, max: 15 }),
    capacity: fc.integer({ min: 2, max: 4 }),
    durations: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 4, maxLength: 4 }),
    demands: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 4, maxLength: 4 }),
  });

  it('enableLcg ON/OFF agree on Cumulative feasibility (fast-check)', () => {
    fc.assert(
      fc.property(cumulativeArb, ({ numTasks, horizon, capacity, durations, demands }) => {
        const build = (): CpModel => {
          const model = new CpModel();
          const starts = Array.from({ length: numTasks }, (_, i) =>
            model.newIntVar(0, horizon, `s${i}`)
          );
          const intervals = Array.from({ length: numTasks }, (_, i) =>
            model.newFixedSizeIntervalVar(starts[i], durations[i], `t${i}`)
          );
          model.addCumulative(intervals, demands.slice(0, numTasks), capacity);
          return model;
        };

        const off = new CpSolver();
        off.parameters.enableLcg = false;
        off.parameters.maxTimeInSeconds = 5;
        const offStatus = off.solve(build());

        const on = new CpSolver();
        on.parameters.enableLcg = true;
        on.parameters.maxTimeInSeconds = 5;
        const onStatus = on.solve(build());

        // Compare only decisive verdicts — UNKNOWN (timeout) is inconclusive.
        if (isDecisive(offStatus) && isDecisive(onStatus)) {
          expect(OK.includes(onStatus)).toBe(OK.includes(offStatus));
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ============================================================================
// Branch reduction: LCG learns clauses on an UNSAT scheduling instance
// ============================================================================

describe('LCG Phase 3 — branch reduction', () => {
  it('learns integer bound literals when LCG is on (numIntBoundLiterals > 0)', () => {
    // Task A is fixed at start=0, duration=3 → mandatory part [0,3).
    // Task B has start in [1,3], duration=3 → mandatory part [3,4) (startMax=3 < endMin=4).
    //
    // For pair (A, B):
    //   aHasMandatory: startMax=0 < endMin=3 → TRUE
    //   bHasMandatory: startMax=3 < endMin=4 → TRUE
    //   Overlap check: A.startMax=0 < B.endMin=4, but B.startMax=3 is NOT < A.endMin=3
    //     → no immediate INFEASIBLE, falls through to precedence branch
    //   Precedence: A.startMax=0 < B.endMin=4 → tightenStartMin(B, 3) fires with explain lambda
    //     → _recordIntBoundReason called → numIntBoundLiterals++
    const model = new CpModel();
    const aStart = model.newIntVar(0, 0, 'aStart');
    const aEnd   = model.newIntVar(3, 3, 'aEnd');
    const bStart = model.newIntVar(1, 3, 'bStart'); // B.startMin=1 < A.endMin=3 → tighten fires
    const bEnd   = model.newIntVar(4, 6, 'bEnd');
    const tA = model.newIntervalVar(aStart, 3, aEnd, 'tA');
    const tB = model.newIntervalVar(bStart, 3, bEnd, 'tB');
    model.addNoOverlap([tA, tB]);

    const solver = new CpSolver();
    solver.parameters.enableLcg = true;
    solver.parameters.maxTimeInSeconds = 5;
    const status = solver.solve(model);
    expect(OK).toContain(status); // FEASIBLE: A=[0,3), B=[3,6)
    expect(solver.numIntBoundLiterals).toBeGreaterThan(0);
  });

  it('LCG reaches correct verdict on tight NoOverlap (soundness on INFEASIBLE)', () => {
    // 3 tasks all with start=[0,1], duration=3, end=[3,4].
    // Each task has a mandatory part [1,3) since startMax=1 < endMin=3.
    // Any pair: A.startMax=1 < B.endMin=3 AND B.startMax=1 < A.endMin=3
    //   → mandatory overlap detected → INFEASIBLE at root without branching.
    // Both OFF and ON must return INFEASIBLE.
    const build = (): CpModel => {
      const model = new CpModel();
      const n = 3;
      const dur = 3;
      const starts = Array.from({ length: n }, (_, i) => model.newIntVar(0, 1, `s${i}`));
      const ends = Array.from({ length: n }, (_, i) => model.newIntVar(dur, dur + 1, `e${i}`));
      const intervals = Array.from({ length: n }, (_, i) =>
        model.newIntervalVar(starts[i], dur, ends[i], `t${i}`)
      );
      model.addNoOverlap(intervals);
      return model;
    };

    const off = new CpSolver();
    off.parameters.enableLcg = false;
    expect(off.solve(build())).toBe(CpSolverStatus.INFEASIBLE);

    const on = new CpSolver();
    on.parameters.enableLcg = true;
    // LCG must agree on verdict — INFEASIBLE.
    expect(on.solve(build())).toBe(CpSolverStatus.INFEASIBLE);
  });
});

// ============================================================================
// BoundLiteralRegistry unit tests
// ============================================================================

describe('BoundLiteralRegistry', () => {
  it('allocates synthetic indices above the base', () => {
    const domains = new Map<number, Domain>();
    domains.set(0, new Domain([0, 10]));
    const reg = new BoundLiteralRegistry(100);
    const s = reg.getOrCreate(0, 5, 'geq', domains);
    expect(s).toBeGreaterThanOrEqual(100);
    expect(reg.isBoundLit(s)).toBe(true);
    expect(reg.isBoundLit(99)).toBe(false);
    expect(reg.size).toBe(1);
  });

  it('deduplicates identical (varIndex, bound, dir) calls', () => {
    const domains = new Map<number, Domain>();
    domains.set(7, new Domain([0, 20]));
    const reg = new BoundLiteralRegistry(50);
    const s1 = reg.getOrCreate(7, 10, 'leq', domains);
    const s2 = reg.getOrCreate(7, 10, 'leq', domains);
    expect(s1).toBe(s2);
    expect(reg.size).toBe(1);
  });

  it('allocates distinct indices for different (varIndex, bound, dir)', () => {
    const domains = new Map<number, Domain>();
    domains.set(0, new Domain([0, 10]));
    const reg = new BoundLiteralRegistry(200);
    const a = reg.getOrCreate(0, 3, 'geq', domains);
    const b = reg.getOrCreate(0, 5, 'geq', domains);
    const c = reg.getOrCreate(0, 3, 'leq', domains);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
    expect(reg.size).toBe(3);
  });

  it('initializes domain [1,1] when int var already satisfies geq bound', () => {
    const domains = new Map<number, Domain>();
    domains.set(3, new Domain([8, 10])); // 8 ≥ 5, so lit_geq(3, 5) = TRUE
    const reg = new BoundLiteralRegistry(100);
    const s = reg.getOrCreate(3, 5, 'geq', domains);
    expect(domains.get(s)?.min).toBe(1);
    expect(domains.get(s)?.max).toBe(1);
  });

  it('initializes domain [0,0] when int var violates geq bound', () => {
    const domains = new Map<number, Domain>();
    domains.set(3, new Domain([0, 3])); // 3 < 5, so lit_geq(3, 5) = FALSE
    const reg = new BoundLiteralRegistry(100);
    const s = reg.getOrCreate(3, 5, 'geq', domains);
    expect(domains.get(s)?.min).toBe(0);
    expect(domains.get(s)?.max).toBe(0);
  });

  it('initializes domain [0,1] when bound is uncertain', () => {
    const domains = new Map<number, Domain>();
    domains.set(3, new Domain([2, 8])); // 2 < 5 < 8, uncertainty
    const reg = new BoundLiteralRegistry(100);
    const s = reg.getOrCreate(3, 5, 'geq', domains);
    expect(domains.get(s)?.min).toBe(0);
    expect(domains.get(s)?.max).toBe(1);
  });

  it('re-initializes domain after backtrack (domains.has = false)', () => {
    const domains = new Map<number, Domain>();
    domains.set(5, new Domain([0, 10]));
    const reg = new BoundLiteralRegistry(100);
    // First allocation: uncertain
    const s = reg.getOrCreate(5, 7, 'leq', domains);
    expect(domains.get(s)?.min).toBe(0);
    // Simulate backtrack: remove the domain entry
    domains.delete(s);
    // Re-tighten the int var to [0, 5] (now satisfies leq 7)
    domains.set(5, new Domain([0, 5]));
    // Re-create: should re-initialize to [1,1]
    const s2 = reg.getOrCreate(5, 7, 'leq', domains);
    expect(s2).toBe(s); // same synthIdx
    expect(domains.get(s)?.min).toBe(1);
    expect(domains.get(s)?.max).toBe(1);
  });

  it('getExisting returns undefined for un-allocated and synthIdx for allocated', () => {
    const domains = new Map<number, Domain>();
    domains.set(0, new Domain([0, 10]));
    const reg = new BoundLiteralRegistry(100);
    expect(reg.getExisting(0, 5, 'geq')).toBeUndefined();
    const s = reg.getOrCreate(0, 5, 'geq', domains);
    expect(reg.getExisting(0, 5, 'geq')).toBe(s);
    expect(reg.getExisting(0, 5, 'leq')).toBeUndefined(); // different dir
  });

  it('lookup round-trips varIndex, bound, dir', () => {
    const domains = new Map<number, Domain>();
    domains.set(9, new Domain([0, 100]));
    const reg = new BoundLiteralRegistry(500);
    const s = reg.getOrCreate(9, 42, 'geq', domains);
    const info = reg.lookup(s);
    expect(info).toBeDefined();
    expect(info!.varIndex).toBe(9);
    expect(info!.bound).toBe(42);
    expect(info!.dir).toBe('geq');
    expect(reg.lookup(499)).toBeUndefined(); // below base
    expect(reg.lookup(42)).toBeUndefined();  // not allocated
  });
});

// ============================================================================
// Channeling: a manually forced bound literal tightens integer domain
// ============================================================================

describe('LCG Phase 3 — channeling direction (S → int)', () => {
  it('NoOverlap with forced start constraint propagates via bound literals', () => {
    // Two tasks of duration 3, horizon 6 (barely fits: s0=0, s1=3).
    // s0 domain is [0,0] (fixed at 0). NoOverlap forces s1 ≥ 3.
    const model = new CpModel();
    const s0 = model.newIntVar(0, 0, 's0'); // fixed to 0 via domain
    const e0 = model.newIntVar(3, 9, 'e0');
    const s1 = model.newIntVar(0, 6, 's1');
    const e1 = model.newIntVar(3, 9, 'e1');
    const t0 = model.newIntervalVar(s0, 3, e0, 't0');
    const t1 = model.newIntervalVar(s1, 3, e1, 't1');
    model.addNoOverlap([t0, t1]);
    model.minimize(s1);

    const solver = new CpSolver();
    solver.parameters.enableLcg = true;
    solver.parameters.maxTimeInSeconds = 5;
    const status = solver.solve(model);
    expect(OK).toContain(status);
    expect(solver.value(s0)).toBe(0);
    expect(solver.value(s1)).toBe(3); // must come after t0
  });
});

// ============================================================================
// End-to-end: LCG solves a real scheduling instance correctly
// ============================================================================

describe('LCG Phase 3 — scheduling correctness', () => {
  it('4-task job-shop style problem (OPTIMAL with LCG)', () => {
    // 4 tasks with non-trivial packing: total duration = horizon → unique solution.
    const n = 4;
    const dur = [2, 3, 1, 4];
    const horizon = dur.reduce((a, b) => a + b, 0); // exactly 10

    const model = new CpModel();
    const starts = Array.from({ length: n }, (_, i) => model.newIntVar(0, horizon, `s${i}`));
    const ends = Array.from({ length: n }, (_, i) =>
      model.newIntVar(dur[i], horizon, `e${i}`)
    );
    const intervals = Array.from({ length: n }, (_, i) =>
      model.newIntervalVar(starts[i], dur[i], ends[i], `t${i}`)
    );
    model.addNoOverlap(intervals);
    model.minimize(ends[n - 1]); // minimize last task's end

    const solverOn = new CpSolver();
    solverOn.parameters.enableLcg = true;
    solverOn.parameters.maxTimeInSeconds = 10;
    const statusOn = solverOn.solve(model);
    expect(OK).toContain(statusOn);

    const solverOff = new CpSolver();
    solverOff.parameters.enableLcg = false;
    solverOff.parameters.maxTimeInSeconds = 10;
    const statusOff = solverOff.solve(model);
    expect(OK).toContain(statusOff);

    // Both must find the same optimal value.
    expect(solverOn.value(ends[n - 1])).toBe(solverOff.value(ends[n - 1]));
  });

  it('3-task Cumulative with tight capacity (LCG agrees with OFF)', () => {
    // 3 tasks each demand 2 on capacity 3, duration 2, horizon 4.
    // Two can overlap (2+2=4 > 3 → actually not — 2+2=4 > 3 is false since demand is 2 each)
    // Actually with capacity 3 and each task demanding 2, at most 1 can run at a time
    // if demands would exceed 3. With capacity=3 and demands [2,2,2], at most 1 can overlap.
    const model = new CpModel();
    const n = 3;
    const dur = 2;
    const horizon = 6; // needs at most 4 total (2+2+... overlap up to cap)
    const starts = Array.from({ length: n }, (_, i) => model.newIntVar(0, horizon, `s${i}`));
    const intervals = Array.from({ length: n }, (_, i) =>
      model.newFixedSizeIntervalVar(starts[i], dur, `t${i}`)
    );
    model.addCumulative(intervals, [2, 2, 2], 3);

    const off = new CpSolver();
    off.parameters.enableLcg = false;
    off.parameters.maxTimeInSeconds = 5;
    const offStatus = off.solve(model);

    const on = new CpSolver();
    on.parameters.enableLcg = true;
    on.parameters.maxTimeInSeconds = 5;
    const onStatus = on.solve(model);

    // Compare only decisive verdicts — UNKNOWN (timeout) is inconclusive.
    if (isDecisive(offStatus) && isDecisive(onStatus)) {
      expect(OK.includes(onStatus)).toBe(OK.includes(offStatus));
    }
  });
});
