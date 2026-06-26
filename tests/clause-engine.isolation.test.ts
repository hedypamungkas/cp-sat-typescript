/**
 * LCG Clause Engine — isolation tests.
 *
 * Tests `ClauseDatabase` DIRECTLY (no CpSolver): exact unit propagation,
 * edge cases (empty/unit/tautology/duplicate), and a fast-check oracle that
 * proves SOUNDNESS (the engine only assigns forced literals) and COMPLETENESS
 * (no clause is unit-and-unsatisfied at fixpoint). These are the load-bearing
 * correctness properties — a watched-literal bug would either assign a literal
 * that isn't forced (soundness) or miss a unit (completeness).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { Domain } from '../src/types';
import {
  ClauseDatabase,
  normalizeClause,
  litVar,
  litValue,
  isLitSatisfied,
  isLitFalsified,
} from '../src/clause-engine';
import type { Literal } from '../src/clause-engine';

// A no-op reason sink for isolation tests (reason tracking is not under test here).
const noopReasonTrail = { setReason: (_idx: number, _r: unknown) => undefined };
const allBool = (_idx: number) => true;
const N = 5; // number of bool vars in property tests

/** Build a domains map: seeded vars fixed, the rest unassigned {0,1}. */
function makeDomains(seed: Map<number, number>, n: number): Map<number, Domain> {
  const d = new Map<number, Domain>();
  for (let i = 0; i < n; i++) {
    const s = seed.get(i);
    d.set(i, s !== undefined ? new Domain([s, s]) : new Domain([0, 1]));
  }
  return d;
}

/** Literal value that satisfies `l` (1 if positive, 0 if negative). */
function litSatValue(l: Literal): number {
  return l >= 0 ? 1 : 0;
}

/** A pure literal generator: (var in 0..N-1, random polarity) → signed literal. */
const literalArb: fc.Arbitrary<Literal> = fc
  .integer({ min: 0, max: N - 1 })
  .chain(v => fc.boolean().map(isNeg => (isNeg ? -(v + 1) : v)));

/** A random instance: clauses + a partial seed assignment. */
const instanceArb = fc.record({
  clauses: fc.uniqueArray(fc.array(literalArb, { minLength: 1, maxLength: 4 }), {
    minLength: 1,
    maxLength: 6,
  }),
  seedMask: fc.integer({ min: 0, max: (1 << N) - 1 }),
  seedVals: fc.integer({ min: 0, max: (1 << N) - 1 }),
});

// ============================================================================
// normalizeClause
// ============================================================================

describe('normalizeClause', () => {
  it('drops duplicate literals', () => {
    expect(normalizeClause([0, 0, 1])).toEqual([0, 1]);
  });

  it('drops tautologies (returns null)', () => {
    expect(normalizeClause([0, -1])).toBeNull(); // 0 = v0 true, -1 = -(0+1) = v0 false
  });

  it('keeps distinct literals', () => {
    // -3 = -(2+1) = var 2 false; distinct from vars 0,1 → not a tautology.
    expect(normalizeClause([0, 1, -3])).toEqual([0, 1, -3]);
  });
});

// ============================================================================
// Exact unit propagation
// ============================================================================

describe('ClauseDatabase — exact unit propagation', () => {
  it('forces a unit clause at setup', () => {
    // Clause [a] → a must be true.
    const db = new ClauseDatabase();
    db.addClause([0]);
    const domains = makeDomains(new Map(), 1);
    expect(db.setup(domains, noopReasonTrail, allBool)).toBe('CONSISTENT');
    expect(domains.get(0)).toEqual(new Domain([1, 1]));
  });

  it('propagates an implication chain (a → b → c) via incremental propagate', () => {
    // Clauses: [¬a, b] (a→b), [¬b, c] (b→c). Vars a=0, b=1, c=2. Seed a=1 → b=1 → c=1.
    // -1=¬v0, 1=v1, -2=¬v1, 2=v2.
    const db = new ClauseDatabase();
    db.addClause([-1, 1]); // v0 → v1
    db.addClause([-2, 2]); // v1 → v2
    // setup on an all-unassigned map just builds watches (no units).
    db.setup(makeDomains(new Map(), 3), noopReasonTrail, allBool);
    // Incremental propagate seeded from {a=true} cascades through the chain.
    const domains = makeDomains(new Map([[0, 1]]), 3);
    const r = db.propagate(domains, noopReasonTrail, new Set([0]), allBool);
    expect(r).toBe('CHANGED');
    expect(domains.get(1)).toEqual(new Domain([1, 1])); // b forced
    expect(domains.get(2)).toEqual(new Domain([1, 1])); // c forced
  });

  it('forces units during setup when the seed makes a clause unit', () => {
    // Same chain, but the seed is baked into the setup domains.
    const db = new ClauseDatabase();
    db.addClause([-1, 1]); // v0 → v1
    db.addClause([-2, 2]); // v1 → v2
    const domains = makeDomains(new Map([[0, 1]]), 3); // a=true
    expect(db.setup(domains, noopReasonTrail, allBool)).toBe('CONSISTENT');
    expect(domains.get(1)).toEqual(new Domain([1, 1])); // b forced at setup
    expect(domains.get(2)).toEqual(new Domain([1, 1])); // c forced at setup
  });

  it('detects a conflict (empty clause)', () => {
    const db = new ClauseDatabase();
    db.addClause([]); // empty clause → UNSAT
    const domains = makeDomains(new Map(), 1);
    expect(db.setup(domains, noopReasonTrail, allBool)).toBe('INFEASIBLE');
  });

  it('detects a conflict when a clause is fully falsified', () => {
    // Clause [a, b], seed a=0, b=0 → all false.
    const db = new ClauseDatabase();
    db.addClause([0, 1]);
    const domains = makeDomains(
      new Map([
        [0, 0],
        [1, 0],
      ]),
      2
    );
    expect(db.setup(domains, noopReasonTrail, allBool)).toBe('INFEASIBLE');
  });

  it('does not force when the clause has two live literals', () => {
    // Clause [a, b], seed empty → neither forced.
    const db = new ClauseDatabase();
    db.addClause([0, 1]);
    const domains = makeDomains(new Map(), 2);
    expect(db.setup(domains, noopReasonTrail, allBool)).toBe('CONSISTENT');
    expect(domains.get(0)!.size).toBe(2);
    expect(domains.get(1)!.size).toBe(2);
  });

  it('is stateless across simulated backtracks (re-derives from current domains)', () => {
    // Clause [¬a, b] (a→b). setup once; then propagate with different seeds.
    const db = new ClauseDatabase();
    db.addClause([-1, 1]); // a(0)→b(1)
    const setupDomains = makeDomains(new Map(), 2);
    db.setup(setupDomains, noopReasonTrail, allBool);

    // Branch a=1 → b forced.
    const d1 = makeDomains(new Map([[0, 1]]), 2);
    expect(db.propagate(d1, noopReasonTrail, new Set([0]), allBool)).toBe('CHANGED');
    expect(d1.get(1)).toEqual(new Domain([1, 1]));

    // Backtrack: a=0 → b NOT forced.
    const d2 = makeDomains(new Map([[0, 0]]), 2);
    expect(db.propagate(d2, noopReasonTrail, new Set([0]), allBool)).toBe('CONSISTENT');
    expect(d2.get(1)!.size).toBe(2);

    // Re-branch a=1 → b forced again (idempotent re-derivation; watches persisted).
    const d3 = makeDomains(new Map([[0, 1]]), 2);
    expect(db.propagate(d3, noopReasonTrail, new Set([0]), allBool)).toBe('CHANGED');
    expect(d3.get(1)).toEqual(new Domain([1, 1]));
  });

  it('forces the unit from a large clause with a single surviving literal', () => {
    // 15-literal clause: ¬v0..¬v6, ¬v8..¬v14, +v7. Falsify all ¬vi (set vi=1),
    // leaving +v7 as the sole survivor → must force v7=1.
    const lits: Literal[] = [];
    for (let i = 0; i < 15; i++) {
      lits.push(i === 7 ? 7 : -(i + 1));
    }
    const db = new ClauseDatabase();
    db.addClause(lits);
    db.setup(makeDomains(new Map(), 15), noopReasonTrail, allBool);
    const seed = new Map<number, number>();
    for (let i = 0; i < 15; i++) if (i !== 7) seed.set(i, 1);
    const domains = makeDomains(seed, 15);
    expect(db.propagate(domains, noopReasonTrail, new Set(seed.keys()), allBool)).toBe('CHANGED');
    expect(domains.get(7)).toEqual(new Domain([1, 1]));
  });

  it('propagates a 10-hop implication cascade in a single drain', () => {
    // x0 → x1 → ... → x10. Seed x0=1 → all forced to 1.
    const db = new ClauseDatabase();
    for (let i = 0; i < 10; i++) db.addClause([-(i + 1), i + 1]); // ¬x_i ∨ x_{i+1}
    db.setup(makeDomains(new Map(), 11), noopReasonTrail, allBool);
    const domains = makeDomains(new Map([[0, 1]]), 11);
    expect(db.propagate(domains, noopReasonTrail, new Set([0]), allBool)).toBe('CHANGED');
    for (let i = 1; i <= 10; i++) {
      expect(domains.get(i)).toEqual(new Domain([1, 1]));
    }
  });
});

// ============================================================================
// Soundness + Completeness oracle (fast-check)
// ============================================================================

describe('ClauseDatabase — soundness & completeness (property based)', () => {
  it('never over-forces a literal, and reaches a sound unit-propagation fixpoint', () => {
    fc.assert(
      fc.property(instanceArb, ({ clauses, seedMask, seedVals }) => {
        // Normalize/drop tautologies so the engine and oracle agree.
        const norm: Literal[][] = [];
        for (const c of clauses) {
          const x = normalizeClause(c);
          if (x !== null && x.length > 0) norm.push(x);
        }
        const seed = new Map<number, number>();
        for (let i = 0; i < N; i++) {
          if ((seedMask >> i) & 1) seed.set(i, (seedVals >> i) & 1);
        }

        // Brute force: satisfying completions of (clauses ∧ seed).
        const all: number[] = [];
        const total = 1 << N;
        for (let mask = 0; mask < total; mask++) {
          let consistent = true;
          for (const [v, val] of seed) if (((mask >> v) & 1) !== val) consistent = false;
          if (!consistent) continue;
          let sat = true;
          for (const clause of norm) {
            let s = false;
            for (const l of clause) {
              if (((mask >> litVar(l)) & 1) === litSatValue(l)) {
                s = true;
                break;
              }
            }
            if (!s) {
              sat = false;
              break;
            }
          }
          if (sat) all.push(mask);
        }

        const db = new ClauseDatabase();
        for (const c of norm) db.addClause(c);
        const domains = makeDomains(seed, N);
        const setupR = db.setup(domains, noopReasonTrail, allBool);
        const propR = db.propagate(domains, noopReasonTrail, new Set(seed.keys()), allBool);
        const engineInfeasible = setupR === 'INFEASIBLE' || propR === 'INFEASIBLE';

        // SOUNDNESS of INFEASIBLE: a satisfiable instance must never be reported
        // as a conflict...
        if (all.length > 0) {
          expect(engineInfeasible).toBe(false);
          // ...and every literal the engine fixed must hold in ALL satisfying
          // completions (it never over-forces).
          for (let v = 0; v < N; v++) {
            const d = domains.get(v)!;
            if (d.size === 1) {
              const forcedVal = d.min;
              for (const mask of all) {
                expect((mask >> v) & 1).toBe(forcedVal);
              }
            }
          }
        }

        // COMPLETENESS of UNIT PROPAGATION — NOT of satisfiability. Unit
        // propagation is sound but INCOMPLETE: it cannot detect UNSAT that
        // requires resolution / clause learning (e.g. (¬x3∨x4) ∧ (¬x3∨¬x4)
        // entails ¬x3, but neither binary clause is unit until x4 is assigned).
        // So we do NOT assert the engine detects every UNSAT instance. We assert
        // it reached a genuine propagation fixpoint: when no conflict was found,
        // every clause is satisfied, has ≥2 non-falsified literals, or (if unit)
        // has its literal already forced. A fully-falsified clause without
        // INFEASIBLE, or a unit-and-unforced clause, would be a real bug.
        if (!engineInfeasible) {
          for (const clause of norm) {
            let satisfied = false;
            let nonFalsified = 0;
            let unitLit: Literal | null = null;
            for (const l of clause) {
              if (isLitSatisfied(l, domains)) {
                satisfied = true;
                break;
              }
              if (!isLitFalsified(l, domains)) {
                nonFalsified++;
                unitLit = l;
              }
            }
            if (satisfied) continue;
            if (nonFalsified === 0) {
              // Fully falsified at a "clean" fixpoint → a missed conflict.
              expect(engineInfeasible).toBe(true);
            } else if (nonFalsified === 1) {
              // Unit at fixpoint → its single literal must already be forced.
              const d = domains.get(litVar(unitLit!))!;
              expect(d.size === 1).toBe(true);
              expect(d.min).toBe(litValue(unitLit!));
            }
          }
        }
      }),
      { numRuns: 300 }
    );
  });

  it('leaves no clause unit-and-unsatisfied at fixpoint (completeness)', () => {
    fc.assert(
      fc.property(instanceArb, ({ clauses, seedMask, seedVals }) => {
        const norm: Literal[][] = [];
        for (const c of clauses) {
          const x = normalizeClause(c);
          if (x !== null && x.length > 0) norm.push(x);
        }
        const seed = new Map<number, number>();
        for (let i = 0; i < N; i++) {
          if ((seedMask >> i) & 1) seed.set(i, (seedVals >> i) & 1);
        }

        const db = new ClauseDatabase();
        for (const c of norm) db.addClause(c);
        const domains = makeDomains(seed, N);
        const setupR = db.setup(domains, noopReasonTrail, allBool);
        const propR = db.propagate(domains, noopReasonTrail, new Set(seed.keys()), allBool);
        if (setupR === 'INFEASIBLE' || propR === 'INFEASIBLE') return; // conflict → not a fixpoint

        // For every clause: it must be satisfied, or have ≥2 non-falsified literals.
        for (const clause of norm) {
          let satisfied = false;
          let nonFalsified = 0;
          for (const l of clause) {
            if (isLitSatisfied(l, domains)) satisfied = true;
            if (!isLitFalsified(l, domains)) nonFalsified++;
          }
          if (satisfied) continue;
          // Not satisfied: needs ≥2 non-falsified literals (else it's a missed unit).
          expect(nonFalsified).toBeGreaterThanOrEqual(2);
        }
      }),
      { numRuns: 300 }
    );
  });
});
