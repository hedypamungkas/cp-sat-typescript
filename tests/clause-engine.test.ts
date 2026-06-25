/**
 * LCG Clause Engine — end-to-end integration tests (through CpSolver).
 *
 * These exercise the full pipeline: `model.addClause(...)` → presolve → search,
 * with the clause engine participating in the `_propagate` fixpoint (when
 * `enableLcg` is on) and `_checkAllConstraints` enforcing clauses always. The
 * isolation tests (clause-engine.isolation.test.ts) prove the watched-literal
 * engine is sound and complete; here we prove the integration preserves
 * correctness and that clauses are enforced regardless of the flag.
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus, LinearExpr } from '../src/types';
import { BoolVarImpl } from '../src/variables';

const OK = [CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE] as const;

/** Build the pigeonhole(3,2) UNSAT instance purely from Boolean clauses. */
function pigeonhole(model: CpModel): BoolVarImpl[][] {
  const pigeons = 3;
  const holes = 2;
  const p: BoolVarImpl[][] = [];
  for (let i = 0; i < pigeons; i++) {
    p.push([]);
    for (let h = 0; h < holes; h++) p[i].push(model.newBoolVar(`p${i}_${h}`));
  }
  // Each pigeon in at least one hole.
  for (let i = 0; i < pigeons; i++) model.addClause(p[i]);
  // Each hole has at most one pigeon (pairwise ¬p_i,h ∨ ¬p_j,h).
  for (let h = 0; h < holes; h++) {
    for (let i = 0; i < pigeons; i++) {
      for (let j = i + 1; j < pigeons; j++) {
        model.addClause([p[i][h].negated, p[j][h].negated]);
      }
    }
  }
  return p;
}

describe('LCG clause engine — end-to-end', () => {
  it('propagates a unit + implication chain with zero branching', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');
    const c = model.newBoolVar('c');
    model.addClause([a]); // unit: a = true
    model.addClause([a.negated, b]); // a → b
    model.addClause([b.negated, c]); // b → c
    const solver = new CpSolver();
    solver.parameters.enableLcg = true;
    const status = solver.solve(model);
    expect(OK).toContain(status);
    expect(solver.booleanValue(a)).toBe(true);
    expect(solver.booleanValue(b)).toBe(true);
    expect(solver.booleanValue(c)).toBe(true);
    expect(solver.numBranches).toBe(0); // all forced by propagation
  });

  it('detects pigeonhole UNSAT (3 pigeons, 2 holes) with enableLcg', () => {
    const model = new CpModel();
    pigeonhole(model);
    const solver = new CpSolver();
    solver.parameters.enableLcg = true;
    solver.parameters.maxTimeInSeconds = 10;
    expect(solver.solve(model)).toBe(CpSolverStatus.INFEASIBLE);
  });

  it('interacts with a LINEAR constraint (CP propagation triggers a clause unit)', () => {
    // a ≥ 1 (LINEAR forces a=true) → clause (a→b) forces b=true.
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');
    model.addClause([a.negated, b]); // a → b
    model.add(a.ge(1)); // a ≥ 1 → a = true
    const solver = new CpSolver();
    solver.parameters.enableLcg = true;
    solver.solve(model);
    expect(solver.booleanValue(a)).toBe(true);
    expect(solver.booleanValue(b)).toBe(true); // forced by clause after LINEAR
  });

  it('is a no-op for models with no clauses (enableLcg on == off)', () => {
    const run = (enableLcg: boolean): number => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      model.addImplication(a, b); // existing Boolean constraint, not a clause
      model.addBoolOr([a, b]);
      const solver = new CpSolver();
      solver.parameters.enableLcg = enableLcg;
      solver.solve(model);
      return solver.numBranches;
    };
    expect(run(true)).toBe(run(false));
  });

  it('enforces clauses even when enableLcg is OFF (via solution checking)', () => {
    // Pigeonhole UNSAT with enableLcg=false: clauses are not propagated, only
    // checked at completion. The result must still be INFEASIBLE.
    const solve = (enableLcg: boolean): CpSolverStatus => {
      const model = new CpModel();
      pigeonhole(model);
      const solver = new CpSolver();
      solver.parameters.enableLcg = enableLcg;
      solver.parameters.maxTimeInSeconds = 10;
      return solver.solve(model);
    };
    expect(solve(false)).toBe(CpSolverStatus.INFEASIBLE);
    expect(solve(true)).toBe(CpSolverStatus.INFEASIBLE);
  });

  it('finds a satisfying assignment for a SAT clause set', () => {
    // (a ∨ b) ∧ (¬a ∨ c) ∧ (¬b ∨ c): c is forced true once a or b is decided.
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');
    const c = model.newBoolVar('c');
    model.addClause([a, b]);
    model.addClause([a.negated, c]);
    model.addClause([b.negated, c]);
    const solver = new CpSolver();
    solver.parameters.enableLcg = true;
    const status = solver.solve(model);
    expect(OK).toContain(status);
    expect(solver.booleanValue(c)).toBe(true);
  });

  it('survives a JSON round-trip (clauses preserved, same solve result)', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');
    model.addClause([a, b]);
    model.addClause([a.negated, b]);

    const restored = CpModel.fromJSON(model.toJSON());
    expect(restored.clauses).toEqual(model.clauses);

    const solve = (m: CpModel): boolean => {
      const s = new CpSolver();
      s.parameters.enableLcg = true;
      s.solve(m);
      return s.booleanValue(b);
    };
    // Both models force b=true: (a→b) ∧ (a∨b) ⇒ b.
    expect(solve(model)).toBe(true);
    expect(solve(restored)).toBe(true);
  });

  it('rejects a clause literal that references a non-bool variable', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 5, 'x');
    expect(() => model.addClause([x as unknown as BoolVarImpl])).toThrow(/bool/);
  });

  it('works correctly with Luby restarts (clause DB persists across restarts)', () => {
    // maximize Σ xᵢ with an implication chain x0→x1→…→x5. The optimum sets
    // x0=1, which the chain forces through to x5=1 (objective 6). Restarts
    // build fresh domains but reuse the clause DB's persistent watch lists.
    const build = (): CpModel => {
      const model = new CpModel();
      const xs = Array.from({ length: 6 }, (_, i) => model.newBoolVar(`x${i}`));
      for (let i = 0; i < 5; i++) model.addClause([xs[i].negated, xs[i + 1]]);
      model.maximize(xs.reduce((e, x) => e.add(x), new LinearExpr([], [], 0)));
      return model;
    };
    const solve = (restart: boolean): number => {
      const s = new CpSolver();
      s.parameters.enableLcg = true;
      if (restart) s.parameters.restartStrategy = 'luby';
      s.parameters.maxTimeInSeconds = 10;
      s.solve(build());
      return s.objectiveValue;
    };
    expect(solve(true)).toBe(solve(false)); // restart and non-restart agree
    expect(solve(true)).toBe(6); // optimum: all six forced true via the chain
  });
});
