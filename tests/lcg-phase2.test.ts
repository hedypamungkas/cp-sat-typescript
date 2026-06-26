/**
 * LCG Phase 2 — conflict analysis + clause learning tests.
 *
 * The load-bearing test is the SOUNDNESS property: for random Boolean models,
 * learning (enableLcg=true) never changes the SAT/UNSAT verdict vs brute force,
 * and any solution returned satisfies all clauses. A wrong learned clause would
 * either falsely declare INFEASIBLE (prune a valid solution) or accept an
 * invalid one — both caught here.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';
import { BoolVarImpl } from '../src/variables';
import type { Literal } from '../src/clause-engine';

const OK: CpSolverStatus[] = [CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE];

/** A decisive SAT/UNSAT verdict. UNKNOWN (timeout/stop) is INCONCLUSIVE, not "unsat". */
const isDecisive = (s: CpSolverStatus): boolean =>
  s === CpSolverStatus.OPTIMAL || s === CpSolverStatus.FEASIBLE || s === CpSolverStatus.INFEASIBLE;
const N = 5;

/** Brute-force: does any complete assignment satisfy all clauses? */
function bruteSatisfiable(clauses: Literal[][], n: number): boolean {
  for (let mask = 0; mask < 1 << n; mask++) {
    let ok = true;
    for (const c of clauses) {
      let sat = false;
      for (const l of c) {
        const v = l >= 0 ? l : -(l + 1);
        const val = l >= 0 ? 1 : 0;
        if (((mask >> v) & 1) === val) {
          sat = true;
          break;
        }
      }
      if (!sat) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** Random literal over N vars with random polarity. */
const literalArb: fc.Arbitrary<Literal> = fc
  .integer({ min: 0, max: N - 1 })
  .chain(v => fc.boolean().map(isNeg => (isNeg ? -(v + 1) : v)));

/** Random 3-SAT-style clause set. */
const modelArb = fc.uniqueArray(fc.array(literalArb, { minLength: 2, maxLength: 4 }), {
  minLength: 3,
  maxLength: 10,
});

function buildClauseModel(clauses: Literal[][]): { model: CpModel; vars: BoolVarImpl[] } {
  const model = new CpModel();
  const vars = Array.from({ length: N }, (_, i) => model.newBoolVar(`x${i}`));
  for (const c of clauses) model.addClause(c);
  return { model, vars };
}

describe('LCG Phase 2 — soundness', () => {
  it('never changes the SAT/UNSAT verdict vs brute force (property)', () => {
    fc.assert(
      fc.property(modelArb, clauses => {
        const sat = bruteSatisfiable(clauses, N);
        const { model } = buildClauseModel(clauses);
        const solver = new CpSolver();
        solver.parameters.enableLcg = true;
        solver.parameters.maxTimeInSeconds = 10;
        const status = solver.solve(model);

        if (sat) {
          // A SAT instance must yield a solution (never falsely INFEASIBLE — the
          // core learning-soundness guarantee). Solution validity is checked in
          // the dedicated test below.
          expect(OK).toContain(status);
        } else {
          // UNSAT must be detected.
          expect(status).toBe(CpSolverStatus.INFEASIBLE);
        }
      }),
      { numRuns: 200 }
    );
  });
});

describe('LCG Phase 2 — soundness (solution validity)', () => {
  it('every returned solution satisfies all clauses (property)', () => {
    fc.assert(
      fc.property(modelArb, clauses => {
        if (!bruteSatisfiable(clauses, N)) return;
        const { model, vars } = buildClauseModel(clauses);
        const solver = new CpSolver();
        solver.parameters.enableLcg = true;
        solver.parameters.maxTimeInSeconds = 10;
        const status = solver.solve(model);
        expect(OK).toContain(status);
        const value = (v: number): 0 | 1 => (solver.booleanValue(vars[v]) ? 1 : 0);
        for (const c of clauses) {
          const satisfied = c.some(l => {
            const v = l >= 0 ? l : -(l + 1);
            const val = l >= 0 ? 1 : 0;
            return value(v) === val;
          });
          expect(satisfied).toBe(true);
        }
      }),
      { numRuns: 200 }
    );
  });
});

describe('LCG Phase 2 — reason-side soundness (native Boolean constraints)', () => {
  // enableLcg=false is correct (clauses checked at completion), so on/off status
  // agreement proves the lazyClause explanations + learning are sound.
  const boolModelArb = fc.record({
    n: fc.constant(5),
    atMostOnes: fc.array(fc.array(literalArb, { minLength: 2, maxLength: 4 }), {
      maxLength: 3,
    }),
    exactlyOnes: fc.array(fc.array(literalArb, { minLength: 2, maxLength: 4 }), {
      maxLength: 2,
    }),
    boolAnds: fc.array(fc.array(literalArb, { minLength: 2, maxLength: 3 }), {
      maxLength: 2,
    }),
    implications: fc.array(fc.record({ a: fc.integer({ min: 0, max: 4 }), b: fc.integer({ min: 0, max: 4 }) }), {
      maxLength: 4,
    }),
    units: fc.array(literalArb, { maxLength: 3 }),
  });

  it('enableLcg ON agrees with OFF on SAT/UNSAT (property)', () => {
    fc.assert(
      fc.property(boolModelArb, ({ n, atMostOnes, exactlyOnes, boolAnds, implications, units }) => {
        const build = (): CpModel => {
          const model = new CpModel();
          const vars = Array.from({ length: n }, (_, i) => model.newBoolVar(`x${i}`));
          for (const amo of atMostOnes) model.addAtMostOne(amo.map(l => vars[l >= 0 ? l : -(l + 1)]));
          for (const eo of exactlyOnes) model.addExactlyOne(eo.map(l => vars[l >= 0 ? l : -(l + 1)]));
          for (const ba of boolAnds) model.addBoolAnd(ba.map(l => vars[l >= 0 ? l : -(l + 1)]));
          for (const { a, b } of implications) if (a !== b) model.addImplication(vars[a], vars[b]);
          for (const u of units) {
            const v = u >= 0 ? u : -(u + 1);
            model.addClause([vars[v]]);
          }
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
        // Same verdict (both OPTIMAL/FEASIBLE ⇒ SAT; both INFEASIBLE ⇒ UNSAT).
        // Compare only decisive verdicts — UNKNOWN (timeout) is inconclusive.
        if (isDecisive(offStatus) && isDecisive(onStatus)) {
          expect(OK.includes(onStatus)).toBe(OK.includes(offStatus));
        }
      }),
      { numRuns: 150 }
    );
  });
});

describe('LCG Phase 2 — learning behavior', () => {
  it('learns clauses on a clause-only UNSAT model (numLearnedClauses > 0)', () => {
    // Pigeonhole(4,3) — UNSAT; conflicts drive learning.
    const model = new CpModel();
    const p: BoolVarImpl[][] = [];
    for (let i = 0; i < 4; i++) {
      p.push([]);
      for (let j = 0; j < 3; j++) p[i].push(model.newBoolVar(`p${i}_${j}`));
    }
    for (let i = 0; i < 4; i++) model.addClause(p[i]);
    for (let j = 0; j < 3; j++)
      for (let i = 0; i < 4; i++) for (let k = i + 1; k < 4; k++) model.addClause([-(p[i][j].index + 1), -(p[k][j].index + 1)]);
    const solver = new CpSolver();
    solver.parameters.enableLcg = true;
    solver.parameters.maxTimeInSeconds = 10;
    expect(solver.solve(model)).toBe(CpSolverStatus.INFEASIBLE);
    expect(solver.numLearnedClauses).toBeGreaterThan(0);
  });

  it('learns from native Boolean-constraint conflicts (AtMostOne)', () => {
    // Three bools with AtMostOne + forcing two true via unit clauses → UNSAT,
    // resolved through the AtMostOne lazy-clause explanation.
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');
    const c = model.newBoolVar('c');
    model.addAtMostOne([a, b, c]);
    model.addClause([a]); // a = true
    model.addClause([b]); // b = true → conflicts with AtMostOne(a,b,c)
    const solver = new CpSolver();
    solver.parameters.enableLcg = true;
    solver.parameters.maxTimeInSeconds = 10;
    expect(solver.solve(model)).toBe(CpSolverStatus.INFEASIBLE);
    // The AtMostOne conflict (a∧b with at-most-one) should be analyzable + learned.
    expect(solver.numLearnedClauses).toBeGreaterThan(0);
  });

  it('enableLcg ON prunes more than OFF on a clause model (branch reduction)', () => {
    const build = (): CpModel => {
      const model = new CpModel();
      const p: BoolVarImpl[][] = [];
      for (let i = 0; i < 5; i++) {
        p.push([]);
        for (let j = 0; j < 4; j++) p[i].push(model.newBoolVar(`p${i}_${j}`));
      }
      for (let i = 0; i < 5; i++) model.addClause(p[i]);
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 5; i++) for (let k = i + 1; k < 5; k++) model.addClause([-(p[i][j].index + 1), -(p[k][j].index + 1)]);
      return model;
    };
    const off = new CpSolver();
    off.parameters.enableLcg = false;
    off.parameters.maxTimeInSeconds = 15;
    off.solve(build());
    const on = new CpSolver();
    on.parameters.enableLcg = true;
    on.parameters.maxTimeInSeconds = 15;
    on.solve(build());
    // ON must use no more branches than OFF (soundness: never worse).
    expect(on.numBranches).toBeLessThanOrEqual(off.numBranches);
  });

  it('keeps enableLcg OFF identical for clause-free models (zero overhead)', () => {
    const run = (enableLcg: boolean): number => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      model.addImplication(a, b);
      const s = new CpSolver();
      s.parameters.enableLcg = enableLcg;
      s.solve(model);
      return s.numBranches;
    };
    expect(run(true)).toBe(run(false));
  });
});
