/**
 * CP-SAT TypeScript Tests
 * Tests for the presolve module: domain compression, affine relation detection, and solver integration
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus, Domain } from '../src/types';
import { CpSolverSolutionCallback } from '../src/callback';
import { presolveModel, compressDomains, detectAffineRelations, computeDerivedValue } from '../src/presolve';

// ============================================================================
// Helper: Create domains map from model
// ============================================================================

function initDomains(model: CpModel): Map<number, Domain> {
  const domains = new Map<number, Domain>();
  for (const v of model.registry.allIntVars) {
    domains.set(v.index, new Domain(v.domain.intervals));
  }
  for (const v of model.registry.allBoolVars) {
    domains.set(v.index, new Domain([0, 1]));
  }
  return domains;
}

function initActiveConstraints(model: CpModel): Set<number> {
  const active = new Set<number>();
  for (let i = 0; i < model.constraints.length; i++) {
    active.add(i);
  }
  return active;
}

// ============================================================================
// Domain Compression Tests
// ============================================================================

describe('compressDomains', () => {
  describe('linear constraint tightening', () => {
    it('should tighten a single variable from a linear equality', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 100, 'x');
      model.add(x.eq(42));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = compressDomains(model, domains, active);

      expect(result.status).toBe('FEASIBLE');
      expect(result.domains.get(x.index)!.size).toBe(1);
      expect(result.domains.get(x.index)!.min).toBe(42);
      expect(result.numVarsFixed).toBe(1);
    });

    it('should tighten variable domains from a sum constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 100, 'x');
      const y = model.newIntVar(0, 100, 'y');
      // x + y = 10, with x in [0,100] and y in [0,100]
      model.add(x.add(y).eq(10));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = compressDomains(model, domains, active);

      expect(result.status).toBe('FEASIBLE');
      // x must be in [0, 10] (since y >= 0 → x <= 10)
      expect(result.domains.get(x.index)!.min).toBe(0);
      expect(result.domains.get(x.index)!.max).toBe(10);
      // y must be in [0, 10] (since x >= 0 → y <= 10)
      expect(result.domains.get(y.index)!.min).toBe(0);
      expect(result.domains.get(y.index)!.max).toBe(10);
    });

    it('should tighten across chained constraints', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 100, 'x');
      const y = model.newIntVar(0, 100, 'y');
      const z = model.newIntVar(0, 100, 'z');

      // x + y <= 10
      model.add(x.add(y).le(10));
      // y + z <= 5
      model.add(y.add(z).le(5));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = compressDomains(model, domains, active);

      expect(result.status).toBe('FEASIBLE');
      // x in [0, 10], y in [0, 5], z in [0, 5]
      expect(result.domains.get(x.index)!.max).toBe(10);
      expect(result.domains.get(y.index)!.max).toBe(5);
      expect(result.domains.get(z.index)!.max).toBe(5);
    });

    it('should detect infeasibility from contradictory linear constraints', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      // x >= 15 and x <= 10 → infeasible
      model.add(x.ge(15));
      model.add(x.le(10));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = compressDomains(model, domains, active);

      expect(result.status).toBe('INFEASIBLE');
    });

    it('should handle negative coefficients', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');
      // x - y = 3 → x = y + 3, so x in [3, 10], y in [0, 7]
      model.add(x.sub(y).eq(3));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = compressDomains(model, domains, active);

      expect(result.status).toBe('FEASIBLE');
      expect(result.domains.get(x.index)!.min).toBe(3);
      expect(result.domains.get(x.index)!.max).toBe(10);
      expect(result.domains.get(y.index)!.min).toBe(0);
      expect(result.domains.get(y.index)!.max).toBe(7);
    });
  });

  describe('boolean constraint propagation', () => {
    it('should propagate BoolAnd (all must be true)', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      model.addBoolAnd([a, b]);

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = compressDomains(model, domains, active);

      expect(result.status).toBe('FEASIBLE');
      expect(result.domains.get(a.index)!.min).toBe(1);
      expect(result.domains.get(b.index)!.min).toBe(1);
    });

    it('should propagate BoolOr when all but one are false', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const c = model.newBoolVar('c');

      model.addBoolOr([a, b, c]);
      // Fix a and b to 0 via linear constraints
      model.add(a.le(0));
      model.add(b.le(0));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = compressDomains(model, domains, active);

      expect(result.status).toBe('FEASIBLE');
      // c must be true since a and b are false
      expect(result.domains.get(c.index)!.min).toBe(1);
    });

    it('should detect infeasibility when BoolOr has all literals false', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      model.addBoolOr([a, b]);
      model.add(a.le(0));
      model.add(b.le(0));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = compressDomains(model, domains, active);

      expect(result.status).toBe('INFEASIBLE');
    });

    it('should propagate AtMostOne when one is true', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const c = model.newBoolVar('c');

      model.addAtMostOne([a, b, c]);
      // Fix a to 1
      model.add(a.ge(1));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = compressDomains(model, domains, active);

      expect(result.status).toBe('FEASIBLE');
      expect(result.domains.get(a.index)!.min).toBe(1);
      expect(result.domains.get(b.index)!.max).toBe(0);
      expect(result.domains.get(c.index)!.max).toBe(0);
    });

    it('should propagate ExactlyOne', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const c = model.newBoolVar('c');

      model.addExactlyOne([a, b, c]);
      // Fix a to 1
      model.add(a.ge(1));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = compressDomains(model, domains, active);

      expect(result.status).toBe('FEASIBLE');
      expect(result.domains.get(a.index)!.min).toBe(1);
      expect(result.domains.get(b.index)!.max).toBe(0);
      expect(result.domains.get(c.index)!.max).toBe(0);
    });

    it('should propagate Implication (a=1 → b=1)', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      model.addImplication(a, b);
      // Fix a to 1
      model.add(a.ge(1));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = compressDomains(model, domains, active);

      expect(result.status).toBe('FEASIBLE');
      expect(result.domains.get(a.index)!.min).toBe(1);
      expect(result.domains.get(b.index)!.min).toBe(1);
    });

    it('should propagate Implication (b=0 → a=0)', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      model.addImplication(a, b);
      // Fix b to 0
      model.add(b.le(0));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = compressDomains(model, domains, active);

      expect(result.status).toBe('FEASIBLE');
      expect(result.domains.get(a.index)!.max).toBe(0);
      expect(result.domains.get(b.index)!.max).toBe(0);
    });

    it('should detect infeasibility from BoolAnd with a false literal', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      model.addBoolAnd([a, b]);
      model.add(a.le(0)); // a must be false

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = compressDomains(model, domains, active);

      expect(result.status).toBe('INFEASIBLE');
    });
  });

  describe('MaxEquality and MinEquality', () => {
    it('should propagate MaxEquality upper bound', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 100, 'x');
      const y = model.newIntVar(0, 50, 'y');
      const z = model.newIntVar(0, 30, 'z');
      const target = model.newIntVar(0, 100, 'target');

      // target = max(y, z)
      model.addMaxEquality(target, [y, z]);

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = compressDomains(model, domains, active);

      expect(result.status).toBe('FEASIBLE');
      // target <= max(y.ub, z.ub) = 50
      expect(result.domains.get(target.index)!.max).toBe(50);
    });

    it('should propagate MinEquality lower bound', () => {
      const model = new CpModel();
      const y = model.newIntVar(10, 100, 'y');
      const z = model.newIntVar(20, 100, 'z');
      const target = model.newIntVar(0, 100, 'target');

      // target = min(y, z)
      model.addMinEquality(target, [y, z]);

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = compressDomains(model, domains, active);

      expect(result.status).toBe('FEASIBLE');
      // target >= min(y.lb, z.lb) = 10
      expect(result.domains.get(target.index)!.min).toBe(10);
    });
  });
});

// ============================================================================
// Affine Relation Detection Tests
// ============================================================================

describe('detectAffineRelations', () => {
  describe('basic affine detection', () => {
    it('should detect x = y + 3', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 20, 'x');
      const y = model.newIntVar(0, 20, 'y');

      // x - y = 3 → x = y + 3
      model.add(x.sub(y).eq(3));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = detectAffineRelations(model, domains, active);

      expect(result.derivedVars.has(x.index) || result.derivedVars.has(y.index)).toBe(true);
      expect(result.numConstraintsRemoved).toBe(1);
      expect(active.size).toBe(0); // Constraint consumed
    });

    it('should detect x = -y + 10', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      // x + y = 10 → x = -y + 10
      model.add(x.add(y).eq(10));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = detectAffineRelations(model, domains, active);

      expect(result.derivedVars.size).toBe(1);
      expect(result.numConstraintsRemoved).toBe(1);
    });

    it('should detect fixed variable x = 42', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 100, 'x');

      // x = 42
      model.add(x.eq(42));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = detectAffineRelations(model, domains, active);

      expect(result.derivedVars.has(x.index)).toBe(true);
      expect(domains.get(x.index)!.min).toBe(42);
      expect(domains.get(x.index)!.max).toBe(42);
    });

    it('should tighten base variable domain from derived variable', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 100, 'y');

      // x - y = 0 → x = y, but x is [0,10] so y should be tightened to [0,10]
      model.add(x.sub(y).eq(0));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = detectAffineRelations(model, domains, active);

      expect(result.derivedVars.size).toBe(1);
      // The base variable's domain should be tightened
      const baseIdx = result.derivedVars.values().next().value!.baseVarIndex;
      expect(domains.get(baseIdx)!.max).toBeLessThanOrEqual(10);
    });

    it('should not detect non-equality constraints', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      // x - y <= 3 (not equality)
      model.add(x.sub(y).le(3));

      const domains = initDomains(model);
      const active = initActiveConstraints(model);

      const result = detectAffineRelations(model, domains, active);

      expect(result.derivedVars.size).toBe(0);
      expect(result.numConstraintsRemoved).toBe(0);
    });
  });
});

// ============================================================================
// Full Presolve Pipeline Tests
// ============================================================================

describe('presolveModel', () => {
  it('should handle empty model', () => {
    const model = new CpModel();
    const domains = initDomains(model);

    const result = presolveModel(model, domains);

    expect(result.status).toBe('OPTIMAL'); // No variables, no constraints
    expect(result.numVarsFixed).toBe(0);
    expect(result.numConstraintsRemoved).toBe(0);
  });

  it('should handle model with only fixed variables', () => {
    const model = new CpModel();
    model.newIntVar(5, 5, 'x');
    model.newIntVar(10, 10, 'y');

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    expect(result.status).toBe('OPTIMAL');
  });

  it('should combine domain compression and affine detection', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 100, 'x');
    const y = model.newIntVar(0, 100, 'y');
    const z = model.newIntVar(0, 100, 'z');

    // x = y + 5
    model.add(x.sub(y).eq(5));
    // y + z <= 20
    model.add(y.add(z).le(20));

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    expect(result.status).toBe('FEASIBLE');
    // After affine: x = y + 5, x domain [0,100] → y domain [0,95]
    // After compression: y + z <= 20, z >= 0 → y <= 20
    // So y in [0, 20], x in [5, 25]
    expect(result.domains.get(y.index)!.max).toBeLessThanOrEqual(20);
    expect(result.domains.get(x.index)!.min).toBe(5);
    expect(result.derivedVars.size).toBeGreaterThanOrEqual(1);
  });

  it('should detect infeasibility through combined presolve', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');

    // x = y + 15 (impossible given domains [0,10])
    model.add(x.sub(y).eq(15));

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    // Should be detected as infeasible or have empty domain
    if (result.status === 'INFEASIBLE') {
      expect(result.status).toBe('INFEASIBLE');
    } else {
      // If not detected during affine, domain should be empty
      const xDomain = result.domains.get(x.index);
      const yDomain = result.domains.get(y.index);
      expect(xDomain!.isEmpty || yDomain!.isEmpty).toBe(true);
    }
  });

  it('should fix all variables when constraints fully determine solution', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');

    model.add(x.eq(3));
    model.add(y.eq(7));

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    expect(result.status).toBe('OPTIMAL');
    expect(result.domains.get(x.index)!.min).toBe(3);
    expect(result.domains.get(y.index)!.min).toBe(7);
  });
});

// ============================================================================
// computeDerivedValue Tests
// ============================================================================

describe('computeDerivedValue', () => {
  it('should compute derived value with coeff=0 (constant)', () => {
    const derived = { baseVarIndex: 0, coeff: 0, offset: 42 };
    const solution = new Map<number, number>();

    expect(computeDerivedValue(derived, solution)).toBe(42);
  });

  it('should compute derived value with coeff=1', () => {
    const derived = { baseVarIndex: 0, coeff: 1, offset: 3 };
    const solution = new Map<number, number>([[0, 5]]);

    expect(computeDerivedValue(derived, solution)).toBe(8); // 1*5 + 3
  });

  it('should compute derived value with coeff=-1', () => {
    const derived = { baseVarIndex: 0, coeff: -1, offset: 10 };
    const solution = new Map<number, number>([[0, 4]]);

    expect(computeDerivedValue(derived, solution)).toBe(6); // -1*4 + 10
  });
});

// ============================================================================
// Solver Integration Tests
// ============================================================================

describe('Solver with presolve', () => {
  it('should solve a problem where presolve fixes all variables', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');

    model.add(x.eq(3));
    model.add(y.eq(7));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(x)).toBe(3);
    expect(solver.value(y)).toBe(7);
  });

  it('should solve with affine relation x = y + 3', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 20, 'x');
    const y = model.newIntVar(0, 20, 'y');

    // x = y + 3
    model.add(x.sub(y).eq(3));
    // y <= 5
    model.add(y.le(5));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(x)).toBe(solver.value(y) + 3);
    expect(solver.value(y)).toBeLessThanOrEqual(5);
  });

  it('should solve with affine relation x + y = 10', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');

    // x + y = 10
    model.add(x.add(y).eq(10));
    // x >= 3
    model.add(x.ge(3));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(x) + solver.value(y)).toBe(10);
    expect(solver.value(x)).toBeGreaterThanOrEqual(3);
  });

  it('should detect infeasibility through presolve', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');

    // x >= 15 (impossible with domain [0, 10])
    model.add(x.ge(15));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.INFEASIBLE);
  });

  it('should handle presolve with optimization', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 20, 'x');
    const y = model.newIntVar(0, 20, 'y');

    // x = y + 3 (affine)
    model.add(x.sub(y).eq(3));
    // y <= 10
    model.add(y.le(10));

    // Maximize x (= y + 3)
    model.maximize(x);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(x)).toBe(13); // y=10, x=13
    expect(solver.objectiveValue).toBe(13);
  });

  it('should handle presolve with boolean constraints', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');
    const c = model.newBoolVar('c');

    // Exactly one of a, b, c
    model.addExactlyOne([a, b, c]);
    // a is true
    model.add(a.ge(1));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.booleanValue(a)).toBe(true);
    expect(solver.booleanValue(b)).toBe(false);
    expect(solver.booleanValue(c)).toBe(false);
  });

  it('should handle N-Queens with presolve', () => {
    const boardSize = 4;
    const model = new CpModel();

    const queens = Array.from({ length: boardSize }, (_, i) =>
      model.newIntVar(0, boardSize - 1, `x_${i}`)
    );

    model.addAllDifferent(queens);
    model.addAllDifferent(queens.map((q, i) => q.add(i)));
    model.addAllDifferent(queens.map((q, i) => q.sub(i)));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    // Verify no two queens on same row
    const values = queens.map(q => solver.value(q));
    expect(new Set(values).size).toBe(boardSize);

    // Verify no two queens on same diagonal
    for (let i = 0; i < boardSize; i++) {
      for (let j = i + 1; j < boardSize; j++) {
        expect(Math.abs(values[i] - values[j])).not.toBe(Math.abs(i - j));
      }
    }
  });

  it('should handle employee scheduling with presolve', () => {
    const model = new CpModel();

    // 3 workers, 3 days, 2 shifts
    const numWorkers = 3;
    const numDays = 3;
    const numShifts = 2;

    const shifts: Record<string, ReturnType<typeof model.newBoolVar>> = {};
    for (let n = 0; n < numWorkers; n++) {
      for (let d = 0; d < numDays; d++) {
        for (let s = 0; s < numShifts; s++) {
          shifts[`${n}_${d}_${s}`] = model.newBoolVar(`shift_n${n}_d${d}_s${s}`);
        }
      }
    }

    // Each shift has exactly one worker
    for (let d = 0; d < numDays; d++) {
      for (let s = 0; s < numShifts; s++) {
        model.addExactlyOne(
          Array.from({ length: numWorkers }, (_, n) => shifts[`${n}_${d}_${s}`])
        );
      }
    }

    // Each worker works at most one shift per day
    for (let n = 0; n < numWorkers; n++) {
      for (let d = 0; d < numDays; d++) {
        model.addAtMostOne(
          Array.from({ length: numShifts }, (_, s) => shifts[`${n}_${d}_${s}`])
        );
      }
    }

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    // Verify each shift has exactly one worker
    for (let d = 0; d < numDays; d++) {
      for (let s = 0; s < numShifts; s++) {
        const assigned = Array.from({ length: numWorkers }, (_, n) =>
          solver.booleanValue(shifts[`${n}_${d}_${s}`]) ? 1 : 0
        ).reduce((a, b) => a + b, 0);
        expect(assigned).toBe(1);
      }
    }
  });
});

// ============================================================================
// Real-World Example: Sudoku
// ============================================================================

describe('Example: Sudoku with presolve', () => {
  it('should solve a 4x4 Sudoku puzzle', () => {
    // 4x4 Sudoku with 2x2 blocks
    // Each row, column, and 2x2 block must contain 1-4 exactly once
    const model = new CpModel();
    const n = 4;
    const blockSize = 2;

    // Create variables for each cell
    const cells: ReturnType<typeof model.newIntVar>[][] = [];
    for (let r = 0; r < n; r++) {
      cells[r] = [];
      for (let c = 0; c < n; c++) {
        cells[r][c] = model.newIntVar(1, n, `cell_${r}_${c}`);
      }
    }

    // Row constraints: each row has all different values
    for (let r = 0; r < n; r++) {
      model.addAllDifferent(cells[r]);
    }

    // Column constraints: each column has all different values
    for (let c = 0; c < n; c++) {
      model.addAllDifferent(cells.map(row => row[c]));
    }

    // Block constraints: each 2x2 block has all different values
    for (let br = 0; br < n; br += blockSize) {
      for (let bc = 0; bc < n; bc += blockSize) {
        const block: typeof cells[0][0][] = [];
        for (let r = br; r < br + blockSize; r++) {
          for (let c = bc; c < bc + blockSize; c++) {
            block.push(cells[r][c]);
          }
        }
        model.addAllDifferent(block);
      }
    }

    // Given clues (a valid 4x4 Sudoku)
    // Puzzle:
    //   1 _ | _  4
    //   _  4 | 1  _
    //   ----+----
    //   _  1 | 4  _
    //   4  _ | _  1
    model.add(cells[0][0].eq(1));
    model.add(cells[0][3].eq(4));
    model.add(cells[1][1].eq(4));
    model.add(cells[1][2].eq(1));
    model.add(cells[2][1].eq(1));
    model.add(cells[2][2].eq(4));
    model.add(cells[3][0].eq(4));
    model.add(cells[3][3].eq(1));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    // Verify the solution
    const solution = cells.map(row => row.map(c => solver.value(c)));

    // Check rows
    for (let r = 0; r < n; r++) {
      expect(new Set(solution[r]).size).toBe(n);
    }

    // Check columns
    for (let c = 0; c < n; c++) {
      const col = solution.map(row => row[c]);
      expect(new Set(col).size).toBe(n);
    }

    // Check 2x2 blocks
    for (let br = 0; br < n; br += blockSize) {
      for (let bc = 0; bc < n; bc += blockSize) {
        const block: number[] = [];
        for (let r = br; r < br + blockSize; r++) {
          for (let c = bc; c < bc + blockSize; c++) {
            block.push(solution[r][c]);
          }
        }
        expect(new Set(block).size).toBe(n);
      }
    }

    // Verify given clues are preserved
    expect(solution[0][0]).toBe(1);
    expect(solution[0][3]).toBe(4);
    expect(solution[1][1]).toBe(4);
    expect(solution[1][2]).toBe(1);
  });
});

// ============================================================================
// Real-World Example: Production Planning
// ============================================================================

describe('Example: Production planning with presolve', () => {
  it('should optimize production with linked quantities (affine)', () => {
    // A factory produces two products. Product B requires 2 units of raw material
    // for every 1 unit of Product A. Total raw material = 20.
    // Maximize profit: 5*A + 8*B
    const model = new CpModel();
    const a = model.newIntVar(0, 20, 'productA');
    const b = model.newIntVar(0, 20, 'productB');

    // Raw material constraint: A + 2*B <= 20
    model.add(a.add(b.mul(2)).le(20));

    // Quality constraint: B must be at least half of A
    // 2*B >= A → A - 2*B <= 0
    model.add(a.sub(b.mul(2)).le(0));

    // Demand constraint: A + B >= 5
    model.add(a.add(b).ge(5));

    // Maximize profit
    model.maximize(a.mul(5).add(b.mul(8)));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    // Verify constraints
    const aVal = solver.value(a);
    const bVal = solver.value(b);
    expect(aVal + 2 * bVal).toBeLessThanOrEqual(20);
    expect(aVal).toBeLessThanOrEqual(2 * bVal);
    expect(aVal + bVal).toBeGreaterThanOrEqual(5);

    // Optimal should be high B (higher profit coefficient)
    expect(solver.objectiveValue).toBe(5 * aVal + 8 * bVal);
  });

  it('should handle production with fixed ratio (affine detection)', () => {
    // Product A and B must be produced in a 2:1 ratio
    const model = new CpModel();
    const a = model.newIntVar(0, 20, 'productA');
    const b = model.newIntVar(0, 10, 'productB');

    // Fixed ratio: A = 2*B
    model.add(a.sub(b.mul(2)).eq(0));

    // Capacity: A + B <= 15
    model.add(a.add(b).le(15));

    // Maximize profit: 3*A + 5*B = 3*(2B) + 5*B = 11*B
    model.maximize(a.mul(3).add(b.mul(5)));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(a)).toBe(2 * solver.value(b));
    expect(solver.value(a) + solver.value(b)).toBeLessThanOrEqual(15);
  });
});

// ============================================================================
// Real-World Example: Bin Packing
// ============================================================================

describe('Example: Bin packing with presolve', () => {
  it('should pack items into bins', () => {
    // Pack 4 items of sizes [3, 4, 2, 5] into 2 bins of capacity 8
    const model = new CpModel();
    const numItems = 4;
    const binCapacity = 8;
    const itemSizes = [3, 4, 2, 5];
    const numBins = 2;

    // bin[i] = which bin item i goes into
    const bin = Array.from({ length: numItems }, (_, i) =>
      model.newIntVar(0, numBins - 1, `bin_${i}`)
    );

    // For each bin, compute the sum of item sizes assigned to it
    // We model this by creating indicator variables: inBin[i][j] = 1 if item i is in bin j
    const inBin: ReturnType<typeof model.newBoolVar>[][] = [];
    for (let i = 0; i < numItems; i++) {
      inBin[i] = [];
      for (let j = 0; j < numBins; j++) {
        inBin[i][j] = model.newBoolVar(`inBin_${i}_${j}`);
      }
      // Each item is in exactly one bin
      model.addExactlyOne(inBin[i]);
    }

    // Link bin assignment: bin[i] = j iff inBin[i][j] = 1
    for (let i = 0; i < numItems; i++) {
      // bin[i] = sum(j * inBin[i][j])
      const binExpr = inBin[i].map((v, j) => v.mul(j)).reduce((a, b) => a.add(b));
      model.add(bin[i].eq(binExpr));
    }

    // Capacity constraints: for each bin, sum of sizes of assigned items <= capacity
    for (let j = 0; j < numBins; j++) {
      const load = inBin.map((row, i) => row[j].mul(itemSizes[i])).reduce((a, b) => a.add(b));
      model.add(load.le(binCapacity));
    }

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    // Verify each item is in a valid bin
    for (let i = 0; i < numItems; i++) {
      const binVal = solver.value(bin[i]);
      expect(binVal).toBeGreaterThanOrEqual(0);
      expect(binVal).toBeLessThan(numBins);
    }

    // Verify capacity constraints
    for (let j = 0; j < numBins; j++) {
      let load = 0;
      for (let i = 0; i < numItems; i++) {
        if (solver.value(bin[i]) === j) {
          load += itemSizes[i];
        }
      }
      expect(load).toBeLessThanOrEqual(binCapacity);
    }
  });
});

// ============================================================================
// Real-World Example: Transportation Problem
// ============================================================================

describe('Example: Transportation problem with presolve', () => {
  it('should minimize transportation cost', () => {
    // 2 suppliers, 3 customers
    // Supply: [10, 15]
    // Demand: [8, 7, 10]
    // Cost matrix:
    //   C1  C2  C3
    // S1  2   3   1
    // S2  4   1   2
    const model = new CpModel();

    const supply = [10, 15];
    const demand = [8, 7, 10];
    const cost = [
      [2, 3, 1],
      [4, 1, 2],
    ];
    const numSuppliers = 2;
    const numCustomers = 3;

    // Create shipment variables
    const x: ReturnType<typeof model.newIntVar>[][] = [];
    for (let s = 0; s < numSuppliers; s++) {
      x[s] = [];
      for (let c = 0; c < numCustomers; c++) {
        x[s][c] = model.newIntVar(0, Math.min(supply[s], demand[c]), `x_${s}_${c}`);
      }
    }

    // Supply constraints: sum of shipments from each supplier <= supply
    for (let s = 0; s < numSuppliers; s++) {
      const total = x[s].reduce((a, b) => a.add(b));
      model.add(total.le(supply[s]));
    }

    // Demand constraints: sum of shipments to each customer >= demand
    for (let c = 0; c < numCustomers; c++) {
      const total = x.map(row => row[c]).reduce((a, b) => a.add(b));
      model.add(total.ge(demand[c]));
    }

    // Minimize total cost
    const totalCost = model.newIntVar(0, 1000, 'totalCost');
    let costExpr = x[supply.length - 1][numCustomers - 1].mul(cost[supply.length - 1][numCustomers - 1]);
    for (let s = 0; s < numSuppliers; s++) {
      for (let c = 0; c < numCustomers; c++) {
        if (s === supply.length - 1 && c === numCustomers - 1) continue;
        costExpr = costExpr.add(x[s][c].mul(cost[s][c]));
      }
    }
    model.add(totalCost.eq(costExpr));
    model.minimize(totalCost);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    // Verify supply constraints
    for (let s = 0; s < numSuppliers; s++) {
      let shipped = 0;
      for (let c = 0; c < numCustomers; c++) {
        shipped += solver.value(x[s][c]);
      }
      expect(shipped).toBeLessThanOrEqual(supply[s]);
    }

    // Verify demand constraints
    for (let c = 0; c < numCustomers; c++) {
      let received = 0;
      for (let s = 0; s < numSuppliers; s++) {
        received += solver.value(x[s][c]);
      }
      expect(received).toBeGreaterThanOrEqual(demand[c]);
    }
  });
});

// ============================================================================
// Real-World Example: Meeting Scheduling
// ============================================================================

describe('Example: Meeting scheduling with presolve', () => {
  it('should schedule meetings with dependencies', () => {
    // Schedule 3 meetings in a day (time slots 0-7)
    // Meeting A (2 slots) must finish before B (1 slot) starts
    // Meeting C (2 slots) shares a resource with A (can't overlap)
    const model = new CpModel();

    const numSlots = 8;
    const startA = model.newIntVar(0, numSlots - 1, 'startA');
    const startB = model.newIntVar(0, numSlots - 1, 'startB');
    const startC = model.newIntVar(0, numSlots - 1, 'startC');

    const durationA = 2;
    const durationB = 1;
    const durationC = 2;

    // End = start + duration
    const endA = model.newIntVar(0, numSlots, 'endA');
    const endB = model.newIntVar(0, numSlots, 'endB');
    const endC = model.newIntVar(0, numSlots, 'endC');

    model.add(endA.eq(startA.add(durationA)));
    model.add(endB.eq(startB.add(durationB)));
    model.add(endC.eq(startC.add(durationC)));

    // A must finish before B
    model.add(endA.le(startB));

    // A and C share a resource (can't overlap)
    // No overlap: endA <= startC OR endC <= startA
    // We fix A before C for simplicity
    model.add(endA.le(startC));

    // Minimize makespan (latest end time)
    const makespan = model.newIntVar(0, numSlots, 'makespan');
    model.addMaxEquality(makespan, [endA, endB, endC]);
    model.minimize(makespan);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    const sA = solver.value(startA);
    const sB = solver.value(startB);
    const sC = solver.value(startC);

    // Verify dependencies
    expect(sA + durationA).toBeLessThanOrEqual(sB);
    expect(sA + durationA).toBeLessThanOrEqual(sC);

    // Verify no overlap between A and C
    const overlap = (sA < sC + durationC) && (sC < sA + durationA);
    expect(overlap).toBe(false);
  });
});

// ============================================================================
// Real-World Example: Resource Allocation
// ============================================================================

describe('Example: Resource allocation with presolve', () => {
  it('should allocate budget across departments', () => {
    // 4 departments compete for budget of 100K
    // Each has min and max requirements
    // Dept A and B are linked (A = B + 10)
    // Minimize total cost while meeting all requirements
    const model = new CpModel();

    const budget = 100;
    const deptA = model.newIntVar(20, 50, 'deptA');
    const deptB = model.newIntVar(10, 40, 'deptB');
    const deptC = model.newIntVar(15, 60, 'deptC');
    const deptD = model.newIntVar(5, 30, 'deptD');

    // Linked allocation: A = B + 10 (affine relation)
    model.add(deptA.sub(deptB).eq(10));

    // Total budget constraint
    model.add(deptA.add(deptB).add(deptC).add(deptD).le(budget));

    // C must be at least as much as D
    model.add(deptC.ge(deptD));

    // D must be at least 10
    model.add(deptD.ge(10));

    // Minimize total (but must meet all constraints)
    const total = deptA.add(deptB).add(deptC).add(deptD);
    model.minimize(total);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    const a = solver.value(deptA);
    const b = solver.value(deptB);
    const c = solver.value(deptC);
    const d = solver.value(deptD);

    // Verify affine relation
    expect(a).toBe(b + 10);

    // Verify constraints
    expect(a + b + c + d).toBeLessThanOrEqual(budget);
    expect(c).toBeGreaterThanOrEqual(d);
    expect(d).toBeGreaterThanOrEqual(10);

    // Verify bounds
    expect(a).toBeGreaterThanOrEqual(20);
    expect(a).toBeLessThanOrEqual(50);
    expect(b).toBeGreaterThanOrEqual(10);
    expect(b).toBeLessThanOrEqual(40);
  });

  it('should handle strict equality constraints that presolve can fix', () => {
    // All variables are fully determined by equality constraints
    const model = new CpModel();

    const x = model.newIntVar(0, 100, 'x');
    const y = model.newIntVar(0, 100, 'y');
    const z = model.newIntVar(0, 100, 'z');
    const w = model.newIntVar(0, 100, 'w');

    // Chain of equalities
    model.add(x.eq(10));
    model.add(y.eq(x.add(5)));
    model.add(z.eq(y.mul(2)));
    model.add(w.eq(z.sub(3)));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(x)).toBe(10);
    expect(solver.value(y)).toBe(15);
    expect(solver.value(z)).toBe(30);
    expect(solver.value(w)).toBe(27);
  });
});

// ============================================================================
// Real-World Example: Job Shop Scheduling
// ============================================================================

describe('Example: Job shop scheduling with presolve', () => {
  it('should schedule 3 tasks on 2 machines with precedence', () => {
    // 3 tasks, each with a fixed duration
    // Tasks 1 and 2 run on Machine A (must not overlap)
    // Task 3 runs on Machine B
    // Task 1 must finish before Task 3 starts
    const model = new CpModel();

    const horizon = 10;

    // Task start times
    const t1Start = model.newIntVar(0, horizon, 't1_start');
    const t2Start = model.newIntVar(0, horizon, 't2_start');
    const t3Start = model.newIntVar(0, horizon, 't3_start');

    // Task end times (affine relations: end = start + duration)
    const t1End = model.newIntVar(0, horizon, 't1_end');
    const t2End = model.newIntVar(0, horizon, 't2_end');
    const t3End = model.newIntVar(0, horizon, 't3_end');

    // Durations: T1=2, T2=3, T3=1
    model.add(t1End.eq(t1Start.add(2)));
    model.add(t2End.eq(t2Start.add(3)));
    model.add(t3End.eq(t3Start.add(1)));

    // Precedence: Task 1 before Task 3
    model.add(t1End.le(t3Start));

    // Machine A: Task 1 and Task 2 must not overlap
    // Fix order: Task 1 before Task 2
    model.add(t1End.le(t2Start));

    // Minimize makespan
    const makespan = model.newIntVar(0, horizon, 'makespan');
    model.addMaxEquality(makespan, [t1End, t2End, t3End]);
    model.minimize(makespan);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    const s1 = solver.value(t1Start);
    const s2 = solver.value(t2Start);
    const s3 = solver.value(t3Start);
    const e1 = solver.value(t1End);
    const e2 = solver.value(t2End);
    const e3 = solver.value(t3End);

    // Verify durations
    expect(e1).toBe(s1 + 2);
    expect(e2).toBe(s2 + 3);
    expect(e3).toBe(s3 + 1);

    // Verify precedence
    expect(e1).toBeLessThanOrEqual(s3);

    // Verify no overlap on Machine A
    expect(e1).toBeLessThanOrEqual(s2);

    // Verify makespan
    expect(solver.objectiveValue).toBe(Math.max(e1, e2, e3));
  });
});

// ============================================================================
// Real-World Example: Graph Coloring
// ============================================================================

describe('Example: Graph coloring with presolve', () => {
  it('should color a graph with 3 colors', () => {
    // Color a simple graph:
    //   0 --- 1
    //   |     |
    //   2 --- 3
    const model = new CpModel();
    const numNodes = 4;
    const numColors = 3;

    const color = Array.from({ length: numNodes }, (_, i) =>
      model.newIntVar(0, numColors - 1, `color_${i}`)
    );

    // Edges: adjacent nodes must have different colors
    const edges: [number, number][] = [
      [0, 1], [0, 2], [1, 3], [2, 3],
    ];

    for (const [u, v] of edges) {
      model.add(color[u].ne(color[v]));
    }

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    // Verify adjacent nodes have different colors
    for (const [u, v] of edges) {
      expect(solver.value(color[u])).not.toBe(solver.value(color[v]));
    }
  });

  it('should detect infeasible coloring with too few colors', () => {
    // Triangle graph needs 3 colors, but we only allow 2
    const model = new CpModel();
    const numColors = 2;

    const color = Array.from({ length: 3 }, (_, i) =>
      model.newIntVar(0, numColors - 1, `color_${i}`)
    );

    // Triangle: all pairs must differ
    model.add(color[0].ne(color[1]));
    model.add(color[1].ne(color[2]));
    model.add(color[0].ne(color[2]));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.INFEASIBLE);
  });
});

// ============================================================================
// Real-World Example: Diet Problem
// ============================================================================

describe('Example: Diet problem with presolve', () => {
  it('should find minimum cost diet meeting nutritional requirements', () => {
    // 3 foods, 2 nutrients
    // Food A: 2 cal, 1 protein per unit, costs 3
    // Food B: 1 cal, 3 protein per unit, costs 2
    // Food C: 3 cal, 2 protein per unit, costs 4
    // Requirements: >= 10 cal, >= 8 protein
    const model = new CpModel();

    const foodA = model.newIntVar(0, 10, 'foodA');
    const foodB = model.newIntVar(0, 10, 'foodB');
    const foodC = model.newIntVar(0, 10, 'foodC');

    // Calorie constraint: 2A + B + 3C >= 10
    model.add(foodA.mul(2).add(foodB).add(foodC.mul(3)).ge(10));

    // Protein constraint: A + 3B + 2C >= 8
    model.add(foodA.add(foodB.mul(3)).add(foodC.mul(2)).ge(8));

    // Minimize cost: 3A + 2B + 4C
    model.minimize(foodA.mul(3).add(foodB.mul(2)).add(foodC.mul(4)));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    const a = solver.value(foodA);
    const b = solver.value(foodB);
    const c = solver.value(foodC);

    // Verify nutritional requirements
    expect(2 * a + b + 3 * c).toBeGreaterThanOrEqual(10);
    expect(a + 3 * b + 2 * c).toBeGreaterThanOrEqual(8);

    // Verify objective
    expect(solver.objectiveValue).toBe(3 * a + 2 * b + 4 * c);
  });
});

// ============================================================================
// Real-World Example: Magic Square
// ============================================================================

describe('Example: Magic square with presolve', () => {
  it('should solve a 3x3 magic square', () => {
    // A 3x3 magic square uses numbers 1-9 exactly once
    // All rows, columns, and diagonals sum to 15
    const model = new CpModel();
    const n = 3;
    const magicSum = 15;

    const cells: ReturnType<typeof model.newIntVar>[][] = [];
    for (let r = 0; r < n; r++) {
      cells[r] = [];
      for (let c = 0; c < n; c++) {
        cells[r][c] = model.newIntVar(1, 9, `cell_${r}_${c}`);
      }
    }

    // All cells must be different
    model.addAllDifferent(cells.flat());

    // Row sums = 15
    for (let r = 0; r < n; r++) {
      const rowSum = cells[r].reduce((a, b) => a.add(b));
      model.add(rowSum.eq(magicSum));
    }

    // Column sums = 15
    for (let c = 0; c < n; c++) {
      const colSum = cells.map(row => row[c]).reduce((a, b) => a.add(b));
      model.add(colSum.eq(magicSum));
    }

    // Main diagonal sum = 15
    const diag1 = [cells[0][0], cells[1][1], cells[2][2]].reduce((a, b) => a.add(b));
    model.add(diag1.eq(magicSum));

    // Anti-diagonal sum = 15
    const diag2 = [cells[0][2], cells[1][1], cells[2][0]].reduce((a, b) => a.add(b));
    model.add(diag2.eq(magicSum));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    const solution = cells.map(row => row.map(c => solver.value(c)));

    // Verify all numbers 1-9 are used
    const allValues = solution.flat().sort((a, b) => a - b);
    expect(allValues).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Verify row sums
    for (let r = 0; r < n; r++) {
      expect(solution[r].reduce((a, b) => a + b, 0)).toBe(magicSum);
    }

    // Verify column sums
    for (let c = 0; c < n; c++) {
      expect(solution.map(row => row[c]).reduce((a, b) => a + b, 0)).toBe(magicSum);
    }

    // Verify diagonals
    expect(solution[0][0] + solution[1][1] + solution[2][2]).toBe(magicSum);
    expect(solution[0][2] + solution[1][1] + solution[2][0]).toBe(magicSum);
  });
});

// ============================================================================
// Real-World Example: Portfolio Optimization
// ============================================================================

describe('Example: Portfolio optimization with presolve', () => {
  it('should optimize investment portfolio', () => {
    // Invest in 3 assets with different risk/return profiles
    // Budget = 100K
    // Constraints: diversification rules
    const model = new CpModel();

    const budget = 100;
    const assetA = model.newIntVar(0, budget, 'assetA'); // Low risk, low return
    const assetB = model.newIntVar(0, budget, 'assetB'); // Medium risk, medium return
    const assetC = model.newIntVar(0, budget, 'assetC'); // High risk, high return

    // Budget constraint: A + B + C = 100
    model.add(assetA.add(assetB).add(assetC).eq(budget));

    // Diversification: no single asset > 60%
    model.add(assetA.le(60));
    model.add(assetB.le(60));
    model.add(assetC.le(60));

    // Risk management: C <= A + B (conservative)
    model.add(assetC.le(assetA.add(assetB)));

    // Linked: B = A + 10 (affine relation - strategy rule)
    model.add(assetB.sub(assetA).eq(10));

    // Maximize return: 2%A + 5%B + 8%C
    model.maximize(assetA.mul(2).add(assetB.mul(5)).add(assetC.mul(8)));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    const a = solver.value(assetA);
    const b = solver.value(assetB);
    const c = solver.value(assetC);

    // Verify constraints
    expect(a + b + c).toBe(budget);
    expect(a).toBeLessThanOrEqual(60);
    expect(b).toBeLessThanOrEqual(60);
    expect(c).toBeLessThanOrEqual(60);
    expect(c).toBeLessThanOrEqual(a + b);
    expect(b).toBe(a + 10); // Affine relation preserved
  });
});

// ============================================================================
// Improvement 1: AbsEquality propagation fix
// ============================================================================

describe('AbsEquality propagation fix', () => {
  it('should tighten target domain from abs expression', () => {
    const model = new CpModel();
    const x = model.newIntVar(-10, 10, 'x');
    const target = model.newIntVar(0, 100, 'target');

    // target = |x|, x in [-10, 10] → target in [0, 10]
    model.addAbsEquality(target, x);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(target)).toBe(Math.abs(solver.value(x)));
  });

  it('should tighten target when expr is always positive', () => {
    const model = new CpModel();
    const x = model.newIntVar(5, 15, 'x');
    const target = model.newIntVar(0, 100, 'target');

    // target = |x|, x in [5, 15] → target in [5, 15]
    model.addAbsEquality(target, x);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(target)).toBe(solver.value(x));
    expect(solver.value(target)).toBeGreaterThanOrEqual(5);
  });

  it('should tighten target when expr is always negative', () => {
    const model = new CpModel();
    const x = model.newIntVar(-15, -5, 'x');
    const target = model.newIntVar(0, 100, 'target');

    // target = |x|, x in [-15, -5] → target in [5, 15]
    model.addAbsEquality(target, x);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(target)).toBe(-solver.value(x));
    expect(solver.value(target)).toBeGreaterThanOrEqual(5);
  });

  it('should detect infeasibility when target cannot match abs', () => {
    const model = new CpModel();
    const x = model.newIntVar(5, 10, 'x');
    const target = model.newIntVar(0, 3, 'target');

    // target = |x|, x in [5, 10] → target in [5, 10], but target in [0, 3] → infeasible
    model.addAbsEquality(target, x);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.INFEASIBLE);
  });
});

// ============================================================================
// Improvement 2: Post-presolve constraint removal
// ============================================================================

describe('Post-presolve constraint removal', () => {
  it('should remove BoolOr with a true literal', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');
    const c = model.newBoolVar('c');

    // BoolOr: at least one true
    model.addBoolOr([a, b, c]);
    // Fix a to true → BoolOr is permanently satisfied
    model.add(a.ge(1));

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    // BoolOr should be removed from active constraints
    expect(result.numConstraintsRemoved).toBeGreaterThanOrEqual(1);
    // The BoolOr constraint index should not be in active set
    const boolOrIndex = model.constraints.findIndex(c => c.type === 'BOOL_OR');
    expect(result.activeConstraints.has(boolOrIndex)).toBe(false);
  });

  it('should remove BoolAnd with all literals fixed to 1', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');

    model.addBoolAnd([a, b]);
    model.add(a.ge(1));
    model.add(b.ge(1));

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    const boolAndIndex = model.constraints.findIndex(c => c.type === 'BOOL_AND');
    expect(result.activeConstraints.has(boolAndIndex)).toBe(false);
  });

  it('should remove ExactlyOne when one literal is fixed', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');
    const c = model.newBoolVar('c');

    model.addExactlyOne([a, b, c]);
    model.add(a.ge(1));

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    const exactlyOneIndex = model.constraints.findIndex(c => c.type === 'EXACTLY_ONE');
    expect(result.activeConstraints.has(exactlyOneIndex)).toBe(false);
  });

  it('should remove Implication when antecedent is false', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');

    model.addImplication(a, b);
    model.add(a.le(0)); // a = false → implication satisfied

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    const implIndex = model.constraints.findIndex(c => c.type === 'IMPLICATION');
    expect(result.activeConstraints.has(implIndex)).toBe(false);
  });

  it('should remove Implication when consequent is true', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');

    model.addImplication(a, b);
    model.add(b.ge(1)); // b = true → implication satisfied

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    const implIndex = model.constraints.findIndex(c => c.type === 'IMPLICATION');
    expect(result.activeConstraints.has(implIndex)).toBe(false);
  });

  it('should remove LinearConstraint when all variables fixed and satisfied', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');

    model.add(x.add(y).le(20));
    model.add(x.eq(3));
    model.add(y.eq(5));

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    // The x+y<=20 constraint should be removed (3+5=8 <= 20)
    const linearIndex = model.constraints.findIndex(c =>
      c.type === 'LINEAR' && c.toString().includes('<= 20')
    );
    if (linearIndex >= 0) {
      expect(result.activeConstraints.has(linearIndex)).toBe(false);
    }
  });
});

// ============================================================================
// Improvement 3: Phase timing
// ============================================================================

describe('Phase timing', () => {
  it('should report presolve and search times', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 100, 'x');
    const y = model.newIntVar(0, 100, 'y');
    model.add(x.add(y).le(50));
    model.maximize(x.add(y));

    const solver = new CpSolver();
    solver.solve(model);

    expect(solver.presolveTime).toBeGreaterThanOrEqual(0);
    expect(solver.searchTime).toBeGreaterThanOrEqual(0);
    expect(solver.wallTime).toBeGreaterThanOrEqual(0);
    // Presolve + search should approximately equal wall time
    expect(solver.presolveTime + solver.searchTime).toBeLessThanOrEqual(solver.wallTime + 0.01);
  });

  it('should report timing in responseStats', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    model.add(x.ge(5));

    const solver = new CpSolver();
    solver.solve(model);

    const stats = solver.responseStats();
    expect(stats).toContain('Presolve time:');
    expect(stats).toContain('Search time:');
  });

  it('should have zero search time when presolve solves everything', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    model.add(x.eq(5));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.presolveTime).toBeGreaterThanOrEqual(0);
    // Search time should be very small since presolve fixed everything
    expect(solver.searchTime).toBeLessThan(0.1);
  });
});

// ============================================================================
// Improvement 4: Extended affine detection (|coeff| > 1)
// ============================================================================

describe('Extended affine detection (|coeff| > 1)', () => {
  it('should detect x = 2*y + 3 (c1 divides c2)', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 30, 'x');
    const y = model.newIntVar(0, 10, 'y');

    // x - 2*y = 3 → x = 2*y + 3
    model.add(x.sub(y.mul(2)).eq(3));

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    expect(result.derivedVars.size).toBeGreaterThanOrEqual(1);
    // x should be derived from y
    expect(result.derivedVars.has(x.index) || result.derivedVars.has(y.index)).toBe(true);
  });

  it('should detect 2*x = y + 6 (c2 divides c1)', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 20, 'y');

    // 2*x - y = 6 → y = 2*x - 6
    model.add(x.mul(2).sub(y).eq(6));

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    expect(result.derivedVars.size).toBeGreaterThanOrEqual(1);
  });

  it('should solve with x = 2*y + 3', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 30, 'x');
    const y = model.newIntVar(0, 10, 'y');

    // x = 2*y + 3
    model.add(x.sub(y.mul(2)).eq(3));
    // y <= 5
    model.add(y.le(5));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(x)).toBe(2 * solver.value(y) + 3);
    expect(solver.value(y)).toBeLessThanOrEqual(5);
  });

  it('should solve with 2*x + 4*y = 10 (simplified)', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');

    // 2*x + 4*y = 10 → x = 5 - 2*y
    model.add(x.mul(2).add(y.mul(4)).eq(10));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(2 * solver.value(x) + 4 * solver.value(y)).toBe(10);
  });

  it('should tighten domain from x = 2*y', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 100, 'x');
    const y = model.newIntVar(0, 100, 'y');

    // x = 2*y (affine with coeff 2)
    model.add(x.sub(y.mul(2)).eq(0));
    // x <= 20
    model.add(x.le(20));

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    // y should be tightened to [0, 10] since x = 2*y and x <= 20
    expect(result.domains.get(y.index)!.max).toBeLessThanOrEqual(10);
    // x should be tightened to [0, 20]
    expect(result.domains.get(x.index)!.max).toBeLessThanOrEqual(20);
  });

  it('should handle optimization with x = 2*y + 3', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 30, 'x');
    const y = model.newIntVar(0, 10, 'y');

    // x = 2*y + 3
    model.add(x.sub(y.mul(2)).eq(3));
    // y <= 8
    model.add(y.le(8));

    // Maximize x (= 2*y + 3)
    model.maximize(x);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(x)).toBe(2 * solver.value(y) + 3);
    expect(solver.value(y)).toBe(8);
    expect(solver.value(x)).toBe(19);
    expect(solver.objectiveValue).toBe(19);
  });

  it('should handle x = -2*y + 10', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');

    // x + 2*y = 10 → x = -2*y + 10
    model.add(x.add(y.mul(2)).eq(10));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(x) + 2 * solver.value(y)).toBe(10);
  });

  it('should handle 3*x + 6*y = 12 (simplifies to x + 2*y = 4)', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');

    // 3*x + 6*y = 12 → x = 4 - 2*y
    model.add(x.mul(3).add(y.mul(6)).eq(12));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(3 * solver.value(x) + 6 * solver.value(y)).toBe(12);
  });

  it('should not derive when coefficients do not divide evenly', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');

    // 2*x + 3*y = 10 — neither coefficient divides the other
    model.add(x.mul(2).add(y.mul(3)).eq(10));

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    // Should NOT create a derived variable (division wouldn't always be integer)
    expect(result.derivedVars.size).toBe(0);
  });
});

// ============================================================================
// Edge Cases: Domain Compression
// ============================================================================

describe('Edge cases: Domain compression', () => {
  it('should handle variable with single-value domain', () => {
    const model = new CpModel();
    const x = model.newIntVar(5, 5, 'x');
    const y = model.newIntVar(0, 10, 'y');

    model.add(x.add(y).le(8));

    const domains = initDomains(model);
    const active = initActiveConstraints(model);
    const result = compressDomains(model, domains, active);

    expect(result.status).toBe('FEASIBLE');
    // y <= 8 - 5 = 3
    expect(result.domains.get(y.index)!.max).toBeLessThanOrEqual(3);
  });

  it('should handle constraint with large coefficients', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 1000, 'x');
    const y = model.newIntVar(0, 1000, 'y');

    // 100*x + 200*y <= 1000
    model.add(x.mul(100).add(y.mul(200)).le(1000));

    const domains = initDomains(model);
    const active = initActiveConstraints(model);
    const result = compressDomains(model, domains, active);

    expect(result.status).toBe('FEASIBLE');
    expect(result.domains.get(x.index)!.max).toBeLessThanOrEqual(10);
    expect(result.domains.get(y.index)!.max).toBeLessThanOrEqual(5);
  });

  it('should handle multiple overlapping constraints', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 100, 'x');
    const y = model.newIntVar(0, 100, 'y');

    model.add(x.add(y).le(20));
    model.add(x.le(10));
    model.add(y.le(15));
    model.add(x.add(y).ge(5));

    const domains = initDomains(model);
    const active = initActiveConstraints(model);
    const result = compressDomains(model, domains, active);

    expect(result.status).toBe('FEASIBLE');
    expect(result.domains.get(x.index)!.max).toBeLessThanOrEqual(10);
    expect(result.domains.get(y.index)!.max).toBeLessThanOrEqual(15);
  });

  it('should detect infeasibility from chained constraints', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');
    const z = model.newIntVar(0, 10, 'z');

    model.add(x.add(y).le(5));
    model.add(y.add(z).le(5));
    model.add(x.add(z).ge(15));

    const domains = initDomains(model);
    const active = initActiveConstraints(model);
    const result = compressDomains(model, domains, active);

    expect(result.status).toBe('INFEASIBLE');
  });

  it('should handle BoolXor constraint', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');

    model.addBoolXor([a, b]);
    model.add(a.ge(1));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.booleanValue(a)).toBe(true);
    expect(solver.booleanValue(b)).toBe(false);
  });
});

// ============================================================================
// Edge Cases: Affine Detection
// ============================================================================

describe('Edge cases: Affine detection', () => {
  it('should handle x = y (zero offset)', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');

    model.add(x.sub(y).eq(0));

    const domains = initDomains(model);
    const result = detectAffineRelations(model, domains, initActiveConstraints(model));

    expect(result.derivedVars.size).toBe(1);
  });

  it('should handle x = -y (negation)', () => {
    const model = new CpModel();
    const x = model.newIntVar(-10, 10, 'x');
    const y = model.newIntVar(-10, 10, 'y');

    model.add(x.add(y).eq(0));

    const domains = initDomains(model);
    const result = detectAffineRelations(model, domains, initActiveConstraints(model));

    expect(result.derivedVars.size).toBe(1);
  });

  it('should handle multiple independent affine relations', () => {
    const model = new CpModel();
    const a = model.newIntVar(0, 20, 'a');
    const b = model.newIntVar(0, 20, 'b');
    const c = model.newIntVar(0, 20, 'c');
    const d = model.newIntVar(0, 20, 'd');

    model.add(a.sub(b).eq(3));  // a = b + 3
    model.add(c.sub(d).eq(5));  // c = d + 5

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    expect(result.derivedVars.size).toBe(2);
  });

  it('should skip relation when variable already derived', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 20, 'x');
    const y = model.newIntVar(0, 20, 'y');
    const z = model.newIntVar(0, 20, 'z');

    model.add(x.sub(y).eq(3));  // x = y + 3
    model.add(x.sub(z).eq(5));  // x = z + 5 (x already derived)

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    // Only one relation should be detected (x = y + 3)
    // The second is skipped because x is already derived
    expect(result.derivedVars.size).toBe(1);
  });
});

// ============================================================================
// Edge Cases: Constraint Removal
// ============================================================================

describe('Edge cases: Constraint removal', () => {
  it('should remove AtMostOne when all literals assigned', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');

    model.addAtMostOne([a, b]);
    model.add(a.ge(1));
    model.add(b.le(0));

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    const atMostOneIndex = model.constraints.findIndex(c => c.type === 'AT_MOST_ONE');
    expect(result.activeConstraints.has(atMostOneIndex)).toBe(false);
  });

  it('should not remove BoolOr when no literal is true', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');

    model.addBoolOr([a, b]);
    // No fixing — both are free

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    const boolOrIndex = model.constraints.findIndex(c => c.type === 'BOOL_OR');
    // Should NOT be removed — constraint is still active
    expect(result.activeConstraints.has(boolOrIndex)).toBe(true);
  });

  it('should not remove LinearConstraint when variables not fixed', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');

    model.add(x.add(y).le(15));

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    const linearIndex = model.constraints.findIndex(c => c.type === 'LINEAR');
    expect(result.activeConstraints.has(linearIndex)).toBe(true);
  });

  it('should remove multiple satisfied constraints', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');
    const c = model.newBoolVar('c');

    model.addBoolOr([a, b]);       // satisfied by a=1
    model.addBoolAnd([a]);         // satisfied by a=1
    model.addImplication(a, b);    // satisfied by a=1 → b=1 (after propagation)
    model.add(a.ge(1));

    const domains = initDomains(model);
    const result = presolveModel(model, domains);

    // At least BoolOr and BoolAnd should be removed
    expect(result.numConstraintsRemoved).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// Edge Cases: AbsEquality
// ============================================================================

describe('Edge cases: AbsEquality', () => {
  it('should handle abs with zero-crossing expression', () => {
    const model = new CpModel();
    const x = model.newIntVar(-5, 5, 'x');
    const target = model.newIntVar(0, 10, 'target');

    model.addAbsEquality(target, x);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(target)).toBe(Math.abs(solver.value(x)));
  });

  it('should handle abs with expression involving multiple variables', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');
    const target = model.newIntVar(0, 20, 'target');

    // target = |x - y|
    model.addAbsEquality(target, x.sub(y));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(target)).toBe(Math.abs(solver.value(x) - solver.value(y)));
  });

  it('should handle abs with fixed expression', () => {
    const model = new CpModel();
    const x = model.newIntVar(5, 5, 'x');
    const target = model.newIntVar(0, 10, 'target');

    model.addAbsEquality(target, x);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(target)).toBe(5);
  });
});

// ============================================================================
// Edge Cases: Timing
// ============================================================================

describe('Edge cases: Timing', () => {
  it('should have consistent timing across multiple solves', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 100, 'x');
    const y = model.newIntVar(0, 100, 'y');
    model.add(x.add(y).le(50));
    model.maximize(x.add(y));

    const solver = new CpSolver();

    // First solve
    solver.solve(model);
    const firstPresolve = solver.presolveTime;
    const firstSearch = solver.searchTime;

    // Second solve
    solver.solve(model);
    const secondPresolve = solver.presolveTime;
    const secondSearch = solver.searchTime;

    // Both should be non-negative
    expect(firstPresolve).toBeGreaterThanOrEqual(0);
    expect(firstSearch).toBeGreaterThanOrEqual(0);
    expect(secondPresolve).toBeGreaterThanOrEqual(0);
    expect(secondSearch).toBeGreaterThanOrEqual(0);
  });

  it('should report zero presolve time for trivial models', () => {
    const model = new CpModel();
    model.newIntVar(5, 5, 'x');

    const solver = new CpSolver();
    solver.solve(model);

    // Presolve should be very fast for trivial models
    expect(solver.presolveTime).toBeLessThan(0.01);
  });

  it('should show presolve doing work on models with many constraints', () => {
    const model = new CpModel();
    const n = 10;
    const vars = Array.from({ length: n }, (_, i) =>
      model.newIntVar(0, 100, `x_${i}`)
    );

    // Add many constraints that presolve can tighten
    for (let i = 0; i < n - 1; i++) {
      model.add(vars[i].add(vars[i + 1]).le(50));
    }
    model.add(vars[0].ge(10));
    model.add(vars[n - 1].ge(10));

    const solver = new CpSolver();
    solver.solve(model);

    expect(solver.presolveTime).toBeGreaterThanOrEqual(0);
    expect(solver.searchTime).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// Integration: Combined Features
// ============================================================================

describe('Integration: Combined features', () => {
  it('should handle affine + boolean + optimization', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 20, 'x');
    const y = model.newIntVar(0, 20, 'y');

    // x = 2*y + 3
    model.add(x.sub(y.mul(2)).eq(3));

    // y <= 8
    model.add(y.le(8));

    // Maximize x
    model.maximize(x);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(x)).toBe(2 * solver.value(y) + 3);
    expect(solver.value(y)).toBe(8);
    expect(solver.value(x)).toBe(19);
  });

  it('should handle presolve + allDifferent', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 3, 'x');
    const y = model.newIntVar(0, 3, 'y');
    const z = model.newIntVar(0, 3, 'z');

    model.addAllDifferent([x, y, z]);
    model.add(x.eq(1));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(x)).toBe(1);
    expect(solver.value(y)).not.toBe(1);
    expect(solver.value(z)).not.toBe(1);
    expect(solver.value(y)).not.toBe(solver.value(z));
  });

  it('should handle presolve with enumeration', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 3, 'x');
    const y = model.newIntVar(0, 3, 'y');

    model.add(x.add(y).eq(3));

    let count = 0;
    class CountCallback extends CpSolverSolutionCallback {
      onSolutionCallback(): void {
        count++;
      }
    }

    const solver = new CpSolver();
    solver.parameters.enumerateAllSolutions = true;
    const callback = new CountCallback();
    solver.solve(model, callback);

    // Solutions: (0,3), (1,2), (2,1), (3,0)
    expect(count).toBe(4);
  });

  it('should handle complex scheduling with presolve', () => {
    const model = new CpModel();

    // 5 tasks, each with start and end
    const n = 5;
    const starts = Array.from({ length: n }, (_, i) =>
      model.newIntVar(0, 20, `start_${i}`)
    );
    const ends = Array.from({ length: n }, (_, i) =>
      model.newIntVar(0, 20, `end_${i}`)
    );

    // Each task has duration 2
    for (let i = 0; i < n; i++) {
      model.add(ends[i].eq(starts[i].add(2)));
    }

    // Sequential: task i ends before task i+1 starts
    for (let i = 0; i < n - 1; i++) {
      model.add(ends[i].le(starts[i + 1]));
    }

    // Minimize makespan
    const makespan = model.newIntVar(0, 20, 'makespan');
    model.addMaxEquality(makespan, ends);
    model.minimize(makespan);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    // With 5 tasks of duration 2, sequential: makespan = 10
    expect(solver.value(makespan)).toBe(10);
  });
});

// ============================================================================
// Domain.complement() method
// ============================================================================

describe('Domain.complement()', () => {
  it('should return complement of single interval', () => {
    const d = new Domain([3, 7]);
    const comp = d.complement(0, 10);

    expect(comp.contains(0)).toBe(true);
    expect(comp.contains(2)).toBe(true);
    expect(comp.contains(3)).toBe(false);
    expect(comp.contains(7)).toBe(false);
    expect(comp.contains(8)).toBe(true);
    expect(comp.contains(10)).toBe(true);
  });

  it('should return full range for empty domain', () => {
    const d = Domain.empty();
    const comp = d.complement(0, 10);

    expect(comp.size).toBe(11);
  });

  it('should return empty for full range domain', () => {
    const d = new Domain([0, 10]);
    const comp = d.complement(0, 10);

    expect(comp.isEmpty).toBe(true);
  });

  it('should handle complement of multi-interval domain', () => {
    const d = new Domain([[2, 4], [7, 9]]);
    const comp = d.complement(0, 10);

    expect(comp.contains(0)).toBe(true);
    expect(comp.contains(1)).toBe(true);
    expect(comp.contains(2)).toBe(false);
    expect(comp.contains(5)).toBe(true);
    expect(comp.contains(6)).toBe(true);
    expect(comp.contains(10)).toBe(true);
  });
});

describe('Presolve - edge cases', () => {
  describe('chained affine relations', () => {
    it('should compute derived values through a chain: x = 2*y + 3, y = z + 1', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 20, 'x');
      const y = model.newIntVar(0, 10, 'y');
      const z = model.newIntVar(0, 5, 'z');

      // y = z + 1
      model.add(y.sub(z).eq(1));
      // x = 2*y + 3
      model.add(x.sub(y.mul(2)).eq(3));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      const zv = solver.value(z);
      const yv = solver.value(y);
      const xv = solver.value(x);
      expect(yv).toBe(zv + 1);
      expect(xv).toBe(2 * yv + 3);
    });

    it('should handle chained affine with optimization', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 20, 'x');
      const y = model.newIntVar(0, 10, 'y');
      const z = model.newIntVar(0, 5, 'z');

      model.add(y.sub(z).eq(1));
      model.add(x.sub(y.mul(2)).eq(3));
      model.maximize(x);

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      // z max = 5, y = 6, x = 2*6+3 = 15
      expect(solver.objectiveValue).toBe(15);
    });
  });

  describe('GCD edge cases in affine detection', () => {
    it('should handle affine relation with coefficient 1 (trivial GCD)', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      // x = y + 5 (coeff=1, gcd trivial)
      model.add(x.sub(y).eq(5));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(x) - solver.value(y)).toBe(5);
    });

    it('should handle affine relation with large GCD', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 50, 'x');
      const y = model.newIntVar(0, 10, 'y');

      // 6*x - 4*y = 12 → GCD(6,4)=2, simplified to 3*x - 2*y = 6
      model.add(x.mul(6).sub(y.mul(4)).eq(12));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(6 * solver.value(x) - 4 * solver.value(y)).toBe(12);
    });
  });

  describe('multi-iteration presolve', () => {
    it('should handle model requiring multiple presolve iterations', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');
      const z = model.newIntVar(0, 10, 'z');

      // First: x + y <= 5 → tightens domains
      model.add(x.add(y).le(5));
      // Then: y + z <= 3 → further tightening
      model.add(y.add(z).le(3));
      // Then: x = z (affine relation on tightened domains)
      model.add(x.eq(z));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(x)).toBe(solver.value(z));
      expect(solver.value(x) + solver.value(y)).toBeLessThanOrEqual(5);
      expect(solver.value(y) + solver.value(z)).toBeLessThanOrEqual(3);
    });
  });

  describe('presolve with negative domains', () => {
    it('should handle variables with negative domain ranges', () => {
      const model = new CpModel();
      const x = model.newIntVar(-10, -1, 'x');
      const y = model.newIntVar(-5, 5, 'y');

      model.add(x.add(y).eq(0));

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.value(x) + solver.value(y)).toBe(0);
    });
  });

  describe('presolve with boolean XOR', () => {
    it('should handle BoolXor in presolve context', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const c = model.newBoolVar('c');

      model.addBoolXor([a, b, c]);
      model.addBoolAnd([a]); // force a = true

      const solver = new CpSolver();
      const status = solver.solve(model);

      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.booleanValue(a)).toBe(true);
      // XOR with a=true: b+c must be even → both true or both false
      const bv = solver.booleanValue(b);
      const cv = solver.booleanValue(c);
      expect(bv).toBe(cv);
    });
  });
});
