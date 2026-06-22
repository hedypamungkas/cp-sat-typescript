/**
 * CP-SAT TypeScript Tests
 * Tests for Variable classes: VariableRegistry, IntVarImpl, BoolVarImpl, IntervalVarImpl
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { IntVarImpl, BoolVarImpl, IntervalVarImpl, VariableRegistry } from '../src/variables';
import { Domain, LinearExpr } from '../src/types';

describe('VariableRegistry', () => {
  it('should assign sequential indices', () => {
    const registry = new VariableRegistry();
    expect(registry.getNextIndex()).toBe(0);
    expect(registry.getNextIndex()).toBe(1);
    expect(registry.getNextIndex()).toBe(2);
  });

  it('should register and retrieve int vars', () => {
    const registry = new VariableRegistry();
    const v = new IntVarImpl(0, new Domain([0, 10]), 'x');
    registry.registerIntVar(v);

    expect(registry.getIntVar(0)).toBe(v);
    expect(registry.getIntVar(1)).toBeUndefined();
    expect(registry.allIntVars).toHaveLength(1);
  });

  it('should register and retrieve bool vars', () => {
    const registry = new VariableRegistry();
    const v = new BoolVarImpl(0, 'b');
    registry.registerBoolVar(v);

    expect(registry.getBoolVar(0)).toBe(v);
    expect(registry.getBoolVar(1)).toBeUndefined();
    expect(registry.allBoolVars).toHaveLength(1);
  });

  it('should register and retrieve interval vars', () => {
    const registry = new VariableRegistry();
    const start = LinearExpr.fromConstant(0);
    const size = LinearExpr.fromConstant(5);
    const end = LinearExpr.fromConstant(5);
    const v = new IntervalVarImpl(0, start, size, end, 'iv');
    registry.registerIntervalVar(v);

    expect(registry.getIntervalVar(0)).toBe(v);
    expect(registry.getIntervalVar(1)).toBeUndefined();
    expect(registry.allIntervalVars).toHaveLength(1);
  });

  it('should track total count of int + bool vars', () => {
    const registry = new VariableRegistry();
    registry.registerIntVar(new IntVarImpl(0, new Domain([0, 10]), 'x'));
    registry.registerIntVar(new IntVarImpl(1, new Domain([0, 10]), 'y'));
    registry.registerBoolVar(new BoolVarImpl(2, 'b'));
    expect(registry.count).toBe(3);
  });

  it('should keep int and bool vars separate', () => {
    const registry = new VariableRegistry();
    registry.registerIntVar(new IntVarImpl(0, new Domain([0, 10]), 'x'));
    registry.registerBoolVar(new BoolVarImpl(1, 'b'));

    expect(registry.allIntVars).toHaveLength(1);
    expect(registry.allBoolVars).toHaveLength(1);
    expect(registry.getIntVar(1)).toBeUndefined();
    expect(registry.getBoolVar(0)).toBeUndefined();
  });
});

describe('IntVarImpl', () => {
  it('should have correct type discriminator', () => {
    const v = new IntVarImpl(0, new Domain([0, 10]), 'x');
    expect(v.type).toBe('int');
  });

  it('should support add', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');
    const expr = x.add(y);
    expect(expr).toBeInstanceOf(LinearExpr);
    expect(expr.vars).toHaveLength(2);
    expect(expr.coeffs).toEqual([1, 1]);
  });

  it('should support sub', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');
    const expr = x.sub(y);
    expect(expr.vars).toHaveLength(2);
    expect(expr.coeffs).toEqual([1, -1]);
  });

  it('should support mul', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const expr = x.mul(3);
    expect(expr.coeffs).toEqual([3]);
  });

  it('should support neg', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const expr = x.neg();
    expect(expr.coeffs).toEqual([-1]);
  });

  it('should support le comparison', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const bounded = x.le(5);
    expect(bounded.ub).toBe(0);
  });

  it('should support ge comparison', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const bounded = x.ge(5);
    expect(bounded.lb).toBe(0);
  });

  it('should support eq comparison', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const bounded = x.eq(5);
    expect(bounded.lb).toBe(0);
    expect(bounded.ub).toBe(0);
  });

  it('should support ne comparison', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const ne = x.ne(5);
    // x.ne(5) => NotEqualExpression(x - 5, 0): a disequality, not a one-sided bound.
    expect(ne.value).toBe(0);
    expect(ne.expr.offset).toBe(-5);
  });

  it('should have toString', () => {
    const v = new IntVarImpl(0, new Domain([0, 10]), 'x');
    expect(v.toString()).toContain('x');
    expect(v.toString()).toContain('IntVar');
  });

  it('should support chained arithmetic', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');
    const z = model.newIntVar(0, 10, 'z');

    // x + 2*y - z + 5
    const expr = x.add(y.mul(2)).sub(z).add(5);
    expect(expr.vars).toHaveLength(3);
    expect(expr.coeffs).toEqual([1, 2, -1]);
    expect(expr.offset).toBe(5);
  });
});

describe('BoolVarImpl', () => {
  it('should have correct type discriminator', () => {
    const v = new BoolVarImpl(0, 'b');
    expect(v.type).toBe('bool');
  });

  it('should have domain [0, 1]', () => {
    const v = new BoolVarImpl(0, 'b');
    expect(v.domain.min).toBe(0);
    expect(v.domain.max).toBe(1);
    expect(v.domain.size).toBe(2);
  });

  it('should compute negated literal', () => {
    const v = new BoolVarImpl(5, 'b');
    expect(v.negated).toBe(-6); // -(index + 1)
  });

  it('should support arithmetic operations', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');

    const sum = a.add(b);
    expect(sum.coeffs).toEqual([1, 1]);

    const diff = a.sub(b);
    expect(diff.coeffs).toEqual([1, -1]);

    const scaled = a.mul(3);
    expect(scaled.coeffs).toEqual([3]);
  });

  it('should have toString', () => {
    const v = new BoolVarImpl(0, 'b');
    expect(v.toString()).toBe('BoolVar(b)');
  });
});

describe('IntervalVarImpl', () => {
  it('should store start, size, end expressions', () => {
    const model = new CpModel();
    const start = model.newIntVar(0, 100, 'start');
    const end = model.newIntVar(0, 100, 'end');
    const interval = model.newIntervalVar(start, 5, end, 'task');

    expect(interval.name).toBe('task');
    expect(interval.start.vars).toHaveLength(1);
    expect(interval.end.vars).toHaveLength(1);
  });

  it('should support optional presence literal', () => {
    const model = new CpModel();
    const start = model.newIntVar(0, 100, 'start');
    const end = model.newIntVar(0, 100, 'end');
    const presence = model.newBoolVar('present');
    const interval = model.newOptionalIntervalVar(start, 5, end, presence, 'task');

    expect(interval.isPresent).toBe(presence);
  });

  it('should have toString', () => {
    const model = new CpModel();
    const start = model.newIntVar(0, 100, 'start');
    const end = model.newIntVar(0, 100, 'end');
    const interval = model.newIntervalVar(start, 5, end, 'myTask');
    expect(interval.toString()).toContain('myTask');
  });

  it('should create fixed-size interval', () => {
    const model = new CpModel();
    const start = model.newIntVar(0, 100, 'start');
    const interval = model.newFixedSizeIntervalVar(start, 10, 'fixed');

    expect(interval.name).toBe('fixed');
    // Size should be constant 10
    expect(interval.size.offset).toBe(10);
    expect(interval.size.vars).toHaveLength(0);
  });

  it('should create optional fixed-size interval', () => {
    const model = new CpModel();
    const start = model.newIntVar(0, 100, 'start');
    const presence = model.newBoolVar('present');
    const interval = model.newOptionalFixedSizeIntervalVar(start, 10, presence, 'opt');

    expect(interval.isPresent).toBe(presence);
    expect(interval.size.offset).toBe(10);
  });
});
