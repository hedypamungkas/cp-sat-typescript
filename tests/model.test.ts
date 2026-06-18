/**
 * CP-SAT TypeScript Tests
 * Tests for CpModel class
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { IntVarImpl, BoolVarImpl } from '../src/variables';
import { Domain, LinearExpr, VariableSelectionStrategy, DomainReductionStrategy } from '../src/types';

describe('CpModel', () => {
  describe('constructor', () => {
    it('should create model with default name', () => {
      const model = new CpModel();
      expect(model.name).toBe('');
    });

    it('should create model with name', () => {
      const model = new CpModel('TestModel');
      expect(model.name).toBe('TestModel');
    });
  });

  describe('newIntVar', () => {
    it('should create integer variable', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');

      expect(x).toBeInstanceOf(IntVarImpl);
      expect(x.name).toBe('x');
      expect(x.domain.min).toBe(0);
      expect(x.domain.max).toBe(10);
    });

    it('should throw on invalid domain', () => {
      const model = new CpModel();
      expect(() => model.newIntVar(10, 5, 'x')).toThrow();
    });

    it('should create multiple variables', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      expect(x.index).not.toBe(y.index);
      expect(model.registry.allIntVars).toHaveLength(2);
    });
  });

  describe('newBoolVar', () => {
    it('should create boolean variable', () => {
      const model = new CpModel();
      const b = model.newBoolVar('b');

      expect(b).toBeInstanceOf(BoolVarImpl);
      expect(b.name).toBe('b');
      expect(b.domain.min).toBe(0);
      expect(b.domain.max).toBe(1);
    });
  });

  describe('newConstant', () => {
    it('should create constant', () => {
      const model = new CpModel();
      const c = model.newConstant(42);

      expect(c.domain.min).toBe(42);
      expect(c.domain.max).toBe(42);
    });
  });

  describe('add', () => {
    it('should add linear constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      const constraint = model.add(x.add(y).le(15));
      expect(model.constraints).toHaveLength(1);
      expect(constraint.type).toBe('LINEAR');
    });

    it('should add equality constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      model.add(x.eq(y));
      expect(model.constraints).toHaveLength(1);
    });

    it('should add inequality constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      model.add(x.ge(y));
      expect(model.constraints).toHaveLength(1);
    });
  });

  describe('addAllDifferent', () => {
    it('should add all-different constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 2, 'x');
      const y = model.newIntVar(0, 2, 'y');
      const z = model.newIntVar(0, 2, 'z');

      const constraint = model.addAllDifferent([x, y, z]);
      expect(constraint.type).toBe('ALL_DIFFERENT');
    });
  });

  describe('boolean constraints', () => {
    it('should add bool or constraint', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      const constraint = model.addBoolOr([a, b]);
      expect(constraint.type).toBe('BOOL_OR');
    });

    it('should add bool and constraint', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      const constraint = model.addBoolAnd([a, b]);
      expect(constraint.type).toBe('BOOL_AND');
    });

    it('should add at most one constraint', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const c = model.newBoolVar('c');

      const constraint = model.addAtMostOne([a, b, c]);
      expect(constraint.type).toBe('AT_MOST_ONE');
    });

    it('should add exactly one constraint', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      const constraint = model.addExactlyOne([a, b]);
      expect(constraint.type).toBe('EXACTLY_ONE');
    });

    it('should add implication constraint', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');

      const constraint = model.addImplication(a, b);
      expect(constraint.type).toBe('IMPLICATION');
    });
  });

  describe('arithmetic constraints', () => {
    it('should add min equality', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 10, 'target');
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      const constraint = model.addMinEquality(target, [x, y]);
      expect(constraint.type).toBe('MIN_EQUALITY');
    });

    it('should add max equality', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 10, 'target');
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      const constraint = model.addMaxEquality(target, [x, y]);
      expect(constraint.type).toBe('MAX_EQUALITY');
    });
  });

  describe('objective', () => {
    it('should set minimize objective', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');

      model.minimize(x);
      expect(model.hasObjective()).toBe(true);
      expect(model.isMaximize).toBe(false);
    });

    it('should set maximize objective', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');

      model.maximize(x);
      expect(model.hasObjective()).toBe(true);
      expect(model.isMaximize).toBe(true);
    });

    it('should clear objective', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');

      model.maximize(x);
      model.clearObjective();
      expect(model.hasObjective()).toBe(false);
    });
  });

  describe('hints', () => {
    it('should add hint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');

      model.addHint(x, 5);
      expect(model.hints.get(x.index)).toBe(5);
    });

    it('should clear hints', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');

      model.addHint(x, 5);
      model.clearHints();
      expect(model.hints.size).toBe(0);
    });
  });

  describe('assumptions', () => {
    it('should add assumption', () => {
      const model = new CpModel();
      const b = model.newBoolVar('b');

      model.addAssumption(b);
      expect(model.assumptions).toHaveLength(1);
    });

    it('should clear assumptions', () => {
      const model = new CpModel();
      const b = model.newBoolVar('b');

      model.addAssumption(b);
      model.clearAssumptions();
      expect(model.assumptions).toHaveLength(0);
    });
  });

  describe('validate', () => {
    it('should validate valid model', () => {
      const model = new CpModel();
      model.newIntVar(0, 10, 'x');
      expect(model.validate()).toBe('');
    });

    it('should throw on empty domain', () => {
      const model = new CpModel();
      expect(() => model.newIntVarFromDomain(new Domain([]), 'x')).toThrow();
    });
  });

  describe('modelStats', () => {
    it('should return model statistics', () => {
      const model = new CpModel('Test');
      model.newIntVar(0, 10, 'x');
      model.newBoolVar('b');

      const stats = model.modelStats();
      expect(stats).toContain('Model: Test');
      expect(stats).toContain('Variables: 1 int, 1 bool');
    });

    it('should include unnamed model', () => {
      const model = new CpModel();
      const stats = model.modelStats();
      expect(stats).toContain('(unnamed)');
    });

    it('should report interval variables', () => {
      const model = new CpModel();
      const start = model.newIntVar(0, 100, 'start');
      const end = model.newIntVar(0, 100, 'end');
      model.newIntervalVar(start, 5, end, 'task');

      const stats = model.modelStats();
      expect(stats).toContain('interval');
    });

    it('should report objective type', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      model.maximize(x);
      expect(model.modelStats()).toContain('maximize');

      model.minimize(x);
      expect(model.modelStats()).toContain('minimize');

      model.clearObjective();
      expect(model.modelStats()).toContain('none');
    });
  });

  describe('toString', () => {
    it('should return same as modelStats', () => {
      const model = new CpModel('Test');
      expect(model.toString()).toBe(model.modelStats());
    });
  });

  describe('newIntVarFromDomain', () => {
    it('should create variable from multi-interval domain', () => {
      const model = new CpModel();
      const x = model.newIntVarFromDomain(new Domain([[0, 5], [10, 15]]), 'x');
      expect(x.domain.intervals).toEqual([[0, 5], [10, 15]]);
      expect(x.domain.size).toBe(12);
    });

    it('should throw on empty domain', () => {
      const model = new CpModel();
      expect(() => model.newIntVarFromDomain(new Domain([]), 'x')).toThrow('empty domain');
    });
  });

  describe('addLinearExpressionInDomain', () => {
    it('should add expression in domain constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 20, 'x');
      model.addLinearExpressionInDomain(
        LinearExpr.fromVar(x),
        new Domain([[0, 5], [10, 15]])
      );
      expect(model.constraints).toHaveLength(1);
    });
  });

  describe('add - boolean input', () => {
    it('should accept true as no-op constraint', () => {
      const model = new CpModel();
      model.add(true);
      expect(model.constraints).toHaveLength(1);
    });

    it('should accept false as infeasible constraint', () => {
      const model = new CpModel();
      model.add(false);
      expect(model.constraints).toHaveLength(1);
    });
  });

  describe('additional constraint types', () => {
    it('should add BoolXor constraint', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const ct = model.addBoolXor([a, b]);
      expect(ct.type).toBe('BOOL_XOR');
    });

    it('should add AtLeastOne constraint (alias)', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      const ct = model.addAtLeastOne([a, b]);
      expect(ct.type).toBe('BOOL_OR');
    });

    it('should add Inverse constraint', () => {
      const model = new CpModel();
      const f = [model.newIntVar(0, 2, 'f0'), model.newIntVar(0, 2, 'f1')];
      const g = [model.newIntVar(0, 2, 'g0'), model.newIntVar(0, 2, 'g1')];
      const ct = model.addInverse(f, g);
      expect(ct.type).toBe('INVERSE');
    });

    it('should add AbsEquality constraint', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 10, 'target');
      const x = model.newIntVar(-10, 10, 'x');
      const ct = model.addAbsEquality(target, x);
      expect(ct.type).toBe('ABS_EQUALITY');
    });

    it('should add DivisionEquality constraint', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 10, 'target');
      const a = model.newIntVar(1, 100, 'a');
      const b = model.newIntVar(1, 10, 'b');
      const ct = model.addDivisionEquality(target, a, b);
      expect(ct.type).toBe('DIVISION_EQUALITY');
    });

    it('should add ModuloEquality constraint', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 9, 'target');
      const x = model.newIntVar(0, 100, 'x');
      const m = model.newIntVar(1, 10, 'm');
      const ct = model.addModuloEquality(target, x, m);
      expect(ct.type).toBe('MODULO_EQUALITY');
    });

    it('should add MultiplicationEquality constraint', () => {
      const model = new CpModel();
      const target = model.newIntVar(0, 100, 'target');
      const a = model.newIntVar(0, 10, 'a');
      const b = model.newIntVar(0, 10, 'b');
      const ct = model.addMultiplicationEquality(target, [a, b]);
      expect(ct.type).toBe('MULTIPLICATION_EQUALITY');
    });

    it('should add AllowedAssignments constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 2, 'x');
      const y = model.newIntVar(0, 2, 'y');
      const ct = model.addAllowedAssignments([x, y], [[0, 1], [1, 0]]);
      expect(ct.type).toBe('ALLOWED_ASSIGNMENTS');
    });

    it('should add ForbiddenAssignments constraint', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 2, 'x');
      const y = model.newIntVar(0, 2, 'y');
      const ct = model.addForbiddenAssignments([x, y], [[0, 0]]);
      expect(ct.type).toBe('FORBIDDEN_ASSIGNMENTS');
    });

    it('should add Element constraint', () => {
      const model = new CpModel();
      const idx = model.newIntVar(0, 2, 'idx');
      const target = model.newIntVar(0, 10, 'target');
      const vars = [
        model.newIntVar(1, 1, 'v0'),
        model.newIntVar(2, 2, 'v1'),
        model.newIntVar(3, 3, 'v2'),
      ];
      const ct = model.addElement(idx, vars, target);
      expect(ct.type).toBe('ELEMENT');
    });

    it('should add NoOverlap constraint', () => {
      const model = new CpModel();
      const s1 = model.newIntVar(0, 10, 's1');
      const s2 = model.newIntVar(0, 10, 's2');
      const e1 = model.newIntVar(0, 20, 'e1');
      const e2 = model.newIntVar(0, 20, 'e2');
      const iv1 = model.newIntervalVar(s1, 5, e1, 't1');
      const iv2 = model.newIntervalVar(s2, 5, e2, 't2');
      const ct = model.addNoOverlap([iv1, iv2]);
      expect(ct.type).toBe('NO_OVERLAP');
    });

    it('should add Cumulative constraint', () => {
      const model = new CpModel();
      const s = model.newIntVar(0, 10, 's');
      const e = model.newIntVar(0, 20, 'e');
      const iv = model.newIntervalVar(s, 5, e, 't');
      const ct = model.addCumulative([iv], [3], 5);
      expect(ct.type).toBe('CUMULATIVE');
    });
  });

  describe('decision strategy', () => {
    it('should add decision strategy', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');

      model.addDecisionStrategy(
        [x, y],
        VariableSelectionStrategy.CHOOSE_FIRST,
        DomainReductionStrategy.SELECT_MIN_VALUE
      );

      expect(model.decisionStrategies).toHaveLength(1);
      expect(model.decisionStrategies[0].variables).toHaveLength(2);
    });

    it('should use default strategies', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      model.addDecisionStrategy([x]);

      expect(model.decisionStrategies[0].varStrategy).toBe(VariableSelectionStrategy.CHOOSE_FIRST);
      expect(model.decisionStrategies[0].domainStrategy).toBe(DomainReductionStrategy.SELECT_MIN_VALUE);
    });
  });

  describe('name setter', () => {
    it('should allow setting model name', () => {
      const model = new CpModel();
      model.name = 'NewName';
      expect(model.name).toBe('NewName');
    });
  });

  describe('clone', () => {
    it('should throw not implemented', () => {
      const model = new CpModel();
      expect(() => model.clone()).toThrow('not yet implemented');
    });
  });

  describe('addAssumptions', () => {
    it('should add multiple assumptions', () => {
      const model = new CpModel();
      const a = model.newBoolVar('a');
      const b = model.newBoolVar('b');
      model.addAssumptions([a, b]);
      expect(model.assumptions).toHaveLength(2);
    });
  });

  describe('registry', () => {
    it('should expose variable registry', () => {
      const model = new CpModel();
      model.newIntVar(0, 10, 'x');
      model.newBoolVar('b');
      expect(model.registry.allIntVars).toHaveLength(1);
      expect(model.registry.allBoolVars).toHaveLength(1);
    });
  });

  describe('constraints getter', () => {
    it('should return all constraints', () => {
      const model = new CpModel();
      const x = model.newIntVar(0, 10, 'x');
      const y = model.newIntVar(0, 10, 'y');
      model.add(x.add(y).le(10));
      model.add(x.ge(0));

      expect(model.constraints).toHaveLength(2);
    });
  });
});
