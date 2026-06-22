/**
 * CP-SAT TypeScript Tests
 * JSON serialization round-trip tests for CpModel.toJSON() / CpModel.fromJSON()
 *
 * Every constraint type must survive: build → toJSON → fromJSON → solve
 * and produce the same solution.
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus, Domain, VariableSelectionStrategy, DomainReductionStrategy } from '../src/types';
import { BoolVarImpl } from '../src/variables';

/**
 * Helper: serialize a model, deserialize it, solve both, and verify
 * they produce the same status and variable values.
 */
function expectRoundTrip(model: CpModel): void {
  const json = model.toJSON();
  const restored = CpModel.fromJSON(json);

  // Both should solve to the same status
  const solver1 = new CpSolver();
  const solver2 = new CpSolver();

  const status1 = solver1.solve(model);
  const status2 = solver2.solve(restored);

  expect(status2).toBe(status1);

  // If feasible, variable values should match
  if (status1 === CpSolverStatus.OPTIMAL || status1 === CpSolverStatus.FEASIBLE) {
    for (const v of model.registry.allIntVars) {
      expect(solver2.value(restored.registry.getIntVar(v.index)!)).toBe(solver1.value(v));
    }
    for (const v of model.registry.allBoolVars) {
      expect(solver2.booleanValue(restored.registry.getBoolVar(v.index)!)).toBe(solver1.booleanValue(v));
    }
  }
}

describe('JSON Serialization Round-Trip', () => {
  describe('basic model', () => {
    it('should round-trip an empty model', () => {
      const model = new CpModel('empty');
      const json = model.toJSON();
      const restored = CpModel.fromJSON(json);
      expect(restored.name).toBe('empty');
      expect(restored.constraints).toHaveLength(0);
    });

    it('should round-trip variables only', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(5, 15, 'y');
      const b = model.newBoolVar('b');

      const json = model.toJSON();
      const restored = CpModel.fromJSON(json);

      expect(restored.registry.allIntVars).toHaveLength(2);
      expect(restored.registry.allBoolVars).toHaveLength(1);
      expect(restored.registry.getIntVar(x.index)!.domain.intervals).toEqual([[0, 10]]);
      expect(restored.registry.getIntVar(y.index)!.domain.intervals).toEqual([[5, 15]]);
    });

    it('should round-trip multi-interval domain variables', () => {
      const model = new CpModel();
      const x = model.newIntVarFromDomain(new Domain([[0, 5], [10, 15]]), 'x');

      const json = model.toJSON();
      const restored = CpModel.fromJSON(json);

      const rx = restored.registry.getIntVar(x.index)!;
      expect(rx.domain.intervals).toEqual([[0, 5], [10, 15]]);
      expect(rx.domain.size).toBe(12);
    });
  });

  describe('LINEAR constraint', () => {
    it('should round-trip linear inequality', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');
      model.add(x.add(y).le(15));
      model.maximize(x.add(y));

      expectRoundTrip(model);
    });

    it('should round-trip linear equality', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');
      model.add(x.eq(y));

      expectRoundTrip(model);
    });

    it('should round-trip linear expression in domain', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 20, 'x');
      model.addLinearExpressionInDomain(x.add(0), new Domain([[0, 5], [10, 15]]));

      expectRoundTrip(model);
    });
  });

  describe('NOT_EQUAL constraint', () => {
    it('should round-trip not-equal constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 5, 'x');
      model.add(x.ne(3));

      expectRoundTrip(model);
    });
  });

  describe('ALL_DIFFERENT constraint', () => {
    it('should round-trip all-different constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 2, 'x');
      const y = model.newIntVar(0, 2, 'y');
      const z = model.newIntVar(0, 2, 'z');
      model.addAllDifferent([x, y, z]);

      expectRoundTrip(model);
    });
  });

  describe('ELEMENT constraint', () => {
    it('should round-trip element constraint', () => {
      const model = new CpModel();
      const idx = model.newIntVar(0, 2, 'idx');
      const target = model.newIntVar(0, 30, 'target');
      const v0 = model.newIntVar(10, 10, 'v0');
      const v1 = model.newIntVar(20, 20, 'v1');
      const v2 = model.newIntVar(30, 30, 'v2');
      model.addElement(idx, [v0, v1, v2], target);

      expectRoundTrip(model);
    });
  });

  describe('CIRCUIT constraint', () => {
    it('should round-trip circuit constraint', () => {
      const model = new CpModel();
      const arcs: [number, number, BoolVarImpl][] = [];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          arcs.push([i, j, model.newBoolVar(`x${i}_${j}`)]);
        }
      }
      model.addCircuit(arcs);

      expectRoundTrip(model);
    });
  });

  describe('MULTIPLE_CIRCUIT constraint', () => {
    it('should round-trip multiple circuit constraint', () => {
      const model = new CpModel();
      const arcs: [number, number, BoolVarImpl][] = [];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          arcs.push([i, j, model.newBoolVar(`x${i}_${j}`)]);
        }
      }
      model.addMultipleCircuit(arcs);

      expectRoundTrip(model);
    });
  });

  describe('ALLOWED_ASSIGNMENTS constraint', () => {
    it('should round-trip allowed assignments', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 2, 'x');
      const y = model.newIntVar(0, 2, 'y');
      model.addAllowedAssignments([x, y], [[0, 1], [1, 0], [1, 1]]);

      expectRoundTrip(model);
    });
  });

  describe('FORBIDDEN_ASSIGNMENTS constraint', () => {
    it('should round-trip forbidden assignments', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 2, 'x');
      const y = model.newIntVar(0, 2, 'y');
      model.addForbiddenAssignments([x, y], [[0, 0]]);

      expectRoundTrip(model);
    });
  });

  describe('AUTOMATON constraint', () => {
    it('should round-trip automaton constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 1, 'x');
      const y = model.newIntVar(0, 1, 'y');
      model.addAutomaton([x, y], 0, [2], [[0, 1, 0], [1, 2, 1]]);

      expectRoundTrip(model);
    });
  });

  describe('INVERSE constraint', () => {
    it('should round-trip inverse constraint', () => {
      const model = new CpModel();
      const f = [model.newIntVar(0, 2, 'f0'), model.newIntVar(0, 2, 'f1'), model.newIntVar(0, 2, 'f2')];
      const g = [model.newIntVar(0, 2, 'g0'), model.newIntVar(0, 2, 'g1'), model.newIntVar(0, 2, 'g2')];
      model.addInverse(f, g);

      expectRoundTrip(model);
    });
  });

  describe('RESERVOIR constraint', () => {
    it('should round-trip reservoir constraint', () => {
      const model = new CpModel();
      const t1 = model.newIntVar(0, 10, 't1');
      const t2 = model.newIntVar(0, 10, 't2');
      model.addReservoirConstraint([t1, t2], [1, -1], 0, 5);

      expectRoundTrip(model);
    });

    it('should round-trip reservoir with active literals', () => {
      const model = new CpModel();
      const t1 = model.newIntVar(0, 10, 't1');
      const t2 = model.newIntVar(0, 10, 't2');
      const a1 = model.newBoolVar('a1');
      const a2 = model.newBoolVar('a2');
      model.addReservoirConstraintWithActive([t1, t2], [1, -1], [a1, a2], 0, 5);

      expectRoundTrip(model);
    });
  });

  describe('BOOL constraints', () => {
    it('should round-trip BoolOr', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      model.addBoolOr([a, b]);

      expectRoundTrip(model);
    });

    it('should round-trip BoolAnd', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      model.addBoolAnd([a, b]);

      expectRoundTrip(model);
    });

    it('should round-trip AtMostOne', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const c = model.newBoolVar('c');
      model.addAtMostOne([a, b, c]);

      expectRoundTrip(model);
    });

    it('should round-trip ExactlyOne', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      model.addExactlyOne([a, b]);

      expectRoundTrip(model);
    });

    it('should round-trip BoolXor', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      model.addBoolXor([a, b]);

      expectRoundTrip(model);
    });

    it('should round-trip Implication', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      model.addImplication(a, b);

      expectRoundTrip(model);
    });
  });

  describe('arithmetic constraints', () => {
    it('should round-trip MinEquality', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 10, 'target');
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');
      model.addMinEquality(target, [x, y]);
      model.minimize(target);

      expectRoundTrip(model);
    });

    it('should round-trip MaxEquality', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 10, 'target');
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');
      model.addMaxEquality(target, [x, y]);
      model.maximize(target);

      expectRoundTrip(model);
    });

    it('should round-trip DivisionEquality', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 10, 'target');
      const num = model.newIntVar(10, 20, 'num');
      const denom = model.newIntVar(3, 3, 'denom');
      model.addDivisionEquality(target, num, denom);

      expectRoundTrip(model);
    });

    it('should round-trip AbsEquality', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 10, 'target');
      const x = model.newIntVar(-10, 10, 'x');
      model.addAbsEquality(target, x);

      expectRoundTrip(model);
    });

    it('should round-trip ModuloEquality', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 9, 'target');
      const x = model.newIntVar(0, 100, 'x');
      const m = model.newIntVar(3, 3, 'm');
      model.addModuloEquality(target, x, m);

      expectRoundTrip(model);
    });

    it('should round-trip MultiplicationEquality', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 100, 'target');
      const a = model.newIntVar(0, 10, 'a');
      const b = model.newIntVar(0, 10, 'b');
      model.addMultiplicationEquality(target, [a, b]);

      expectRoundTrip(model);
    });
  });

  describe('scheduling constraints', () => {
    it('should round-trip NoOverlap', () => {
      const model = new CpModel();
      const s1 = model.newIntVar(0, 10, 's1');
      const s2 = model.newIntVar(0, 10, 's2');
      const e1 = model.newIntVar(0, 20, 'e1');
      const e2 = model.newIntVar(0, 20, 'e2');
      const iv1 = model.newIntervalVar(s1, 5, e1, 't1');
      const iv2 = model.newIntervalVar(s2, 5, e2, 't2');
      model.addNoOverlap([iv1, iv2]);

      expectRoundTrip(model);
    });

    it('should round-trip NoOverlap2D', () => {
      const model = new CpModel();
      const sx1 = model.newIntVar(0, 10, 'sx1');
      const sx2 = model.newIntVar(0, 10, 'sx2');
      const ex1 = model.newIntVar(0, 20, 'ex1');
      const ex2 = model.newIntVar(0, 20, 'ex2');
      const sy1 = model.newIntVar(0, 10, 'sy1');
      const sy2 = model.newIntVar(0, 10, 'sy2');
      const ey1 = model.newIntVar(0, 20, 'ey1');
      const ey2 = model.newIntVar(0, 20, 'ey2');
      const xiv1 = model.newIntervalVar(sx1, 3, ex1, 'xt1');
      const xiv2 = model.newIntervalVar(sx2, 3, ex2, 'xt2');
      const yiv1 = model.newIntervalVar(sy1, 3, ey1, 'yt1');
      const yiv2 = model.newIntervalVar(sy2, 3, ey2, 'yt2');
      model.addNoOverlap2D([xiv1, xiv2], [yiv1, yiv2]);

      expectRoundTrip(model);
    });

    it('should round-trip Cumulative', () => {
      const model = new CpModel();
      const s = model.newIntVar(0, 10, 's');
      const e = model.newIntVar(0, 20, 'e');
      const iv = model.newIntervalVar(s, 5, e, 't');
      model.addCumulative([iv], [3], 5);

      expectRoundTrip(model);
    });
  });

  describe('MAP_DOMAIN constraint', () => {
    it('should round-trip map domain', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 2, 'x');
      const b0 = model.newBoolVar('b0');
      const b1 = model.newBoolVar('b1');
      const b2 = model.newBoolVar('b2');
      model.addMapDomain(x, [b0, b1, b2]);

      expectRoundTrip(model);
    });
  });

  describe('objective', () => {
    it('should round-trip maximize objective', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      model.maximize(x);

      const json = model.toJSON();
      const restored = CpModel.fromJSON(json);

      expect(restored.hasObjective()).toBe(true);
      expect(restored.isMaximize).toBe(true);
    });

    it('should round-trip minimize objective', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      model.minimize(x);

      const json = model.toJSON();
      const restored = CpModel.fromJSON(json);

      expect(restored.hasObjective()).toBe(true);
      expect(restored.isMaximize).toBe(false);
    });

    it('should round-trip no objective', () => {
      const model = new CpModel();
      model.newIntVar(0, 10, 'x');

      const json = model.toJSON();
      const restored = CpModel.fromJSON(json);

      expect(restored.hasObjective()).toBe(false);
    });
  });

  describe('hints', () => {
    it('should round-trip hints', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');
      model.addHint(x, 5);
      model.addHint(y, 3);

      const json = model.toJSON();
      const restored = CpModel.fromJSON(json);

      expect(restored.hints.get(x.index)).toBe(5);
      expect(restored.hints.get(y.index)).toBe(3);
    });
  });

  describe('assumptions', () => {
    it('should round-trip assumptions', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      model.addAssumptions([a, b]);

      const json = model.toJSON();
      const restored = CpModel.fromJSON(json);

      expect(restored.assumptions).toHaveLength(2);
    });
  });

  describe('decision strategies', () => {
    it('should round-trip decision strategies', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');
      model.addDecisionStrategy(
        [x, y],
        VariableSelectionStrategy.CHOOSE_FIRST,
        DomainReductionStrategy.SELECT_MIN_VALUE
      );

      const json = model.toJSON();
      const restored = CpModel.fromJSON(json);

      expect(restored.decisionStrategies).toHaveLength(1);
      expect(restored.decisionStrategies[0].variables).toHaveLength(2);
      expect(restored.decisionStrategies[0].varStrategy).toBe(VariableSelectionStrategy.CHOOSE_FIRST);
    });
  });

  describe('optional interval variables', () => {
    it('should round-trip optional interval variable', () => {
      const model = new CpModel();
      const start = model.newIntVar(0, 10, 'start');
      const size = model.newIntVar(1, 5, 'size');
      const end = model.newIntVar(0, 20, 'end');
      const present = model.newBoolVar('present');
      model.newOptionalIntervalVar(start, size, end, present, 'task');

      const json = model.toJSON();
      const restored = CpModel.fromJSON(json);

      expect(restored.registry.allIntervalVars).toHaveLength(1);
    });
  });

  describe('complex model', () => {
    it('should round-trip a model with many constraint types', () => {
      const model = new CpModel('complex');
      const x = model.newIntVar(0, 5, 'x');
      const y = model.newIntVar(0, 5, 'y');
      const z = model.newIntVar(0, 5, 'z');
      const b = model.newBoolVar('b');

      // Linear
      model.add(x.add(y).le(8));
      // AllDifferent
      model.addAllDifferent([x, y, z]);
      // BoolOr
      model.addBoolOr([b]);
      // NotEqual
      model.add(x.ne(0));
      // Objective
      model.maximize(x.add(y).add(z));
      // Hint
      model.addHint(x, 3);
      // Assumption
      model.addAssumption(b);

      expectRoundTrip(model);
    });
  });
});
