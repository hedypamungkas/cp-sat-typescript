/**
 * CP-SAT TypeScript Tests
 * Tests for core types: Domain, LinearExpr, BoundedLinearExpression
 */

import { describe, it, expect } from 'vitest';
import { Domain, LinearExpr, BoundedLinearExpression, IntVar } from '../src/types';

describe('Domain', () => {
  describe('constructor', () => {
    it('should create from single interval', () => {
      const d = new Domain([0, 10]);
      expect(d.min).toBe(0);
      expect(d.max).toBe(10);
      expect(d.size).toBe(11);
    });

    it('should create from multiple intervals', () => {
      const d = new Domain([[0, 5], [10, 15]]);
      expect(d.min).toBe(0);
      expect(d.max).toBe(15);
      expect(d.size).toBe(12);
    });

    it('should create empty domain', () => {
      const d = new Domain([]);
      expect(d.isEmpty).toBe(true);
    });

    it('should normalize overlapping intervals', () => {
      const d = new Domain([[0, 5], [3, 10]]);
      expect(d.intervals).toEqual([[0, 10]]);
    });

    it('should merge adjacent intervals', () => {
      const d = new Domain([[0, 5], [6, 10]]);
      expect(d.intervals).toEqual([[0, 10]]);
    });
  });

  describe('fromValues', () => {
    it('should create domain from values', () => {
      const d = Domain.fromValues([1, 3, 5, 7]);
      expect(d.size).toBe(4);
      expect(d.contains(1)).toBe(true);
      expect(d.contains(2)).toBe(false);
    });

    it('should handle consecutive values', () => {
      const d = Domain.fromValues([1, 2, 3, 4, 5]);
      expect(d.intervals).toEqual([[1, 5]]);
    });

    it('should handle empty values', () => {
      const d = Domain.fromValues([]);
      expect(d.isEmpty).toBe(true);
    });
  });

  describe('contains', () => {
    it('should check value in interval', () => {
      const d = new Domain([0, 10]);
      expect(d.contains(5)).toBe(true);
      expect(d.contains(0)).toBe(true);
      expect(d.contains(10)).toBe(true);
      expect(d.contains(-1)).toBe(false);
      expect(d.contains(11)).toBe(false);
    });

    it('should check value in multiple intervals', () => {
      const d = new Domain([[0, 5], [10, 15]]);
      expect(d.contains(3)).toBe(true);
      expect(d.contains(12)).toBe(true);
      expect(d.contains(7)).toBe(false);
    });
  });

  describe('values', () => {
    it('should list all values', () => {
      const d = new Domain([0, 4]);
      expect(d.values()).toEqual([0, 1, 2, 3, 4]);
    });

    it('should list values from multiple intervals', () => {
      const d = new Domain([[0, 2], [5, 7]]);
      expect(d.values()).toEqual([0, 1, 2, 5, 6, 7]);
    });
  });

  describe('operations', () => {
    it('should fix value', () => {
      const d = new Domain([0, 10]);
      const fixed = d.fixValue(5);
      expect(fixed.min).toBe(5);
      expect(fixed.max).toBe(5);
      expect(fixed.size).toBe(1);
    });

    it('should return empty when fixing value not in domain', () => {
      const d = new Domain([0, 10]);
      const fixed = d.fixValue(15);
      expect(fixed.isEmpty).toBe(true);
    });

    it('should filter greater or equal', () => {
      const d = new Domain([0, 10]);
      const filtered = d.greaterOrEqual(5);
      expect(filtered.min).toBe(5);
      expect(filtered.max).toBe(10);
    });

    it('should filter less or equal', () => {
      const d = new Domain([0, 10]);
      const filtered = d.lessOrEqual(5);
      expect(filtered.min).toBe(0);
      expect(filtered.max).toBe(5);
    });

    it('should remove value', () => {
      const d = new Domain([0, 4]);
      const removed = d.removeValue(2);
      expect(removed.values()).toEqual([0, 1, 3, 4]);
    });

    it('should intersect domains', () => {
      const d1 = new Domain([0, 10]);
      const d2 = new Domain([5, 15]);
      const intersection = d1.intersection(d2);
      expect(intersection.min).toBe(5);
      expect(intersection.max).toBe(10);
    });

    it('should union domains', () => {
      const d1 = new Domain([0, 5]);
      const d2 = new Domain([10, 15]);
      const union = d1.union(d2);
      expect(union.intervals).toEqual([[0, 5], [10, 15]]);
    });
  });

  describe('toString', () => {
    it('should format single interval', () => {
      const d = new Domain([0, 10]);
      expect(d.toString()).toBe('[0,10]');
    });

    it('should format multiple intervals', () => {
      const d = new Domain([[0, 5], [10, 15]]);
      expect(d.toString()).toBe('[0,5] ∪ [10,15]');
    });

    it('should format empty domain', () => {
      const d = new Domain([]);
      expect(d.toString()).toBe('{}');
    });
  });
});

describe('LinearExpr', () => {
  describe('constructor', () => {
    it('should create empty expression', () => {
      const expr = new LinearExpr();
      expect(expr.vars).toEqual([]);
      expect(expr.coeffs).toEqual([]);
      expect(expr.offset).toBe(0);
    });

    it('should create expression with variables', () => {
      const mockVar = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr = new LinearExpr([mockVar], [2], 5);
      expect(expr.vars).toEqual([mockVar]);
      expect(expr.coeffs).toEqual([2]);
      expect(expr.offset).toBe(5);
    });
  });

  describe('fromConstant', () => {
    it('should create constant expression', () => {
      const expr = LinearExpr.fromConstant(42);
      expect(expr.vars).toEqual([]);
      expect(expr.coeffs).toEqual([]);
      expect(expr.offset).toBe(42);
    });
  });

  describe('evaluate', () => {
    it('should evaluate simple expression', () => {
      const mockVar = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr = new LinearExpr([mockVar], [2], 5);
      const result = expr.evaluate((v) => 3);
      expect(result).toBe(11); // 2*3 + 5
    });

    it('should evaluate multi-variable expression', () => {
      const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const y = { index: 1, name: 'y', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr = new LinearExpr([x, y], [2, 3], 1);
      const result = expr.evaluate((v) => v.index === 0 ? 4 : 5);
      expect(result).toBe(24); // 2*4 + 3*5 + 1
    });
  });

  describe('operations', () => {
    it('should add expressions', () => {
      const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const y = { index: 1, name: 'y', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr1 = new LinearExpr([x], [2], 3);
      const expr2 = new LinearExpr([y], [3], 4);
      const result = expr1.add(expr2);
      expect(result.vars).toEqual([x, y]);
      expect(result.coeffs).toEqual([2, 3]);
      expect(result.offset).toBe(7);
    });

    it('should subtract expressions', () => {
      const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const y = { index: 1, name: 'y', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr1 = new LinearExpr([x], [2], 10);
      const expr2 = new LinearExpr([y], [3], 4);
      const result = expr1.sub(expr2);
      expect(result.vars).toEqual([x, y]);
      expect(result.coeffs).toEqual([2, -3]);
      expect(result.offset).toBe(6);
    });

    it('should multiply by constant', () => {
      const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr = new LinearExpr([x], [2], 3);
      const result = expr.mul(4);
      expect(result.coeffs).toEqual([8]);
      expect(result.offset).toBe(12);
    });

    it('should negate expression', () => {
      const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr = new LinearExpr([x], [2], 3);
      const result = expr.neg();
      expect(result.coeffs).toEqual([-2]);
      expect(result.offset).toBe(-3);
    });
  });

  describe('toString', () => {
    it('should format simple expression', () => {
      const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr = new LinearExpr([x], [1], 0);
      expect(expr.toString()).toBe('x');
    });

    it('should format expression with coefficient', () => {
      const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr = new LinearExpr([x], [2], 0);
      expect(expr.toString()).toBe('2*x');
    });

    it('should format expression with offset', () => {
      const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr = new LinearExpr([x], [1], 5);
      expect(expr.toString()).toBe('5 + x');
    });

    it('should format complex expression', () => {
      const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const y = { index: 1, name: 'y', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr = new LinearExpr([x, y], [2, -3], 5);
      expect(expr.toString()).toBe('5 + 2*x - 3*y');
    });
  });
});

describe('Domain - additional coverage', () => {
  describe('fromInterval', () => {
    it('should create domain from interval static method', () => {
      const d = Domain.fromInterval(3, 7);
      expect(d.min).toBe(3);
      expect(d.max).toBe(7);
      expect(d.size).toBe(5);
    });
  });

  describe('empty', () => {
    it('should create empty domain via static method', () => {
      const d = Domain.empty();
      expect(d.isEmpty).toBe(true);
      expect(d.size).toBe(0);
    });
  });

  describe('min/max on empty domain', () => {
    it('should throw on min of empty domain', () => {
      const d = new Domain([]);
      expect(() => d.min).toThrow('Cannot get min of empty domain');
    });

    it('should throw on max of empty domain', () => {
      const d = new Domain([]);
      expect(() => d.max).toThrow('Cannot get max of empty domain');
    });
  });

  describe('complement', () => {
    it('should compute complement of empty domain', () => {
      const d = Domain.empty();
      const comp = d.complement(-10, 10);
      expect(comp.min).toBe(-10);
      expect(comp.max).toBe(10);
      expect(comp.size).toBe(21);
    });

    it('should compute complement of single interval', () => {
      const d = new Domain([3, 7]);
      const comp = d.complement(0, 10);
      expect(comp.intervals).toEqual([[0, 2], [8, 10]]);
    });

    it('should compute complement with default bounds', () => {
      const d = new Domain([0, 0]);
      const comp = d.complement();
      // Should exclude 0 from [-1000000, 1000000]
      expect(comp.contains(0)).toBe(false);
      expect(comp.contains(-1)).toBe(true);
      expect(comp.contains(1)).toBe(true);
    });

    it('should handle complement when domain covers entire range', () => {
      const d = new Domain([-10, 10]);
      const comp = d.complement(-10, 10);
      expect(comp.isEmpty).toBe(true);
    });
  });

  describe('toString single value', () => {
    it('should format single value domain', () => {
      const d = new Domain([5, 5]);
      expect(d.toString()).toBe('5');
    });
  });

  describe('intersection edge cases', () => {
    it('should return empty for non-overlapping domains', () => {
      const d1 = new Domain([0, 5]);
      const d2 = new Domain([10, 15]);
      const intersection = d1.intersection(d2);
      expect(intersection.isEmpty).toBe(true);
    });

    it('should handle contained domain', () => {
      const d1 = new Domain([0, 10]);
      const d2 = new Domain([3, 7]);
      const intersection = d1.intersection(d2);
      expect(intersection.min).toBe(3);
      expect(intersection.max).toBe(7);
    });
  });

  describe('union edge cases', () => {
    it('should union overlapping domains', () => {
      const d1 = new Domain([0, 5]);
      const d2 = new Domain([3, 10]);
      const union = d1.union(d2);
      expect(union.intervals).toEqual([[0, 10]]);
    });

    it('should union with empty domain', () => {
      const d1 = new Domain([0, 5]);
      const d2 = Domain.empty();
      const union = d1.union(d2);
      expect(union.intervals).toEqual([[0, 5]]);
    });
  });

  describe('removeValue edge cases', () => {
    it('should handle removing first value', () => {
      const d = new Domain([0, 4]);
      const removed = d.removeValue(0);
      expect(removed.intervals).toEqual([[1, 4]]);
    });

    it('should handle removing last value', () => {
      const d = new Domain([0, 4]);
      const removed = d.removeValue(4);
      expect(removed.intervals).toEqual([[0, 3]]);
    });

    it('should handle removing value not in domain', () => {
      const d = new Domain([0, 4]);
      const removed = d.removeValue(10);
      expect(removed.intervals).toEqual([[0, 4]]);
    });
  });

  describe('greaterOrEqual edge cases', () => {
    it('should return empty when lb exceeds max', () => {
      const d = new Domain([0, 5]);
      const filtered = d.greaterOrEqual(10);
      expect(filtered.isEmpty).toBe(true);
    });

    it('should handle multiple intervals', () => {
      const d = new Domain([[0, 3], [7, 10]]);
      const filtered = d.greaterOrEqual(5);
      expect(filtered.intervals).toEqual([[7, 10]]);
    });
  });

  describe('lessOrEqual edge cases', () => {
    it('should return empty when ub is below min', () => {
      const d = new Domain([5, 10]);
      const filtered = d.lessOrEqual(2);
      expect(filtered.isEmpty).toBe(true);
    });
  });

  describe('fromValues with duplicates', () => {
    it('should deduplicate values', () => {
      const d = Domain.fromValues([1, 1, 2, 2, 3]);
      expect(d.size).toBe(3);
      expect(d.intervals).toEqual([[1, 3]]);
    });
  });
});

describe('LinearExpr - additional coverage', () => {
  describe('from', () => {
    it('should create from number', () => {
      const expr = LinearExpr.from(42);
      expect(expr.offset).toBe(42);
      expect(expr.vars).toHaveLength(0);
    });

    it('should create from IntVar', () => {
      const mockVar = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr = LinearExpr.from(mockVar);
      expect(expr.vars).toHaveLength(1);
      expect(expr.coeffs).toEqual([1]);
    });

    it('should pass through LinearExpr', () => {
      const original = new LinearExpr([], [], 5);
      const expr = LinearExpr.from(original);
      expect(expr).toBe(original);
    });
  });

  describe('fromVar', () => {
    it('should create from variable', () => {
      const mockVar = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr = LinearExpr.fromVar(mockVar);
      expect(expr.vars).toEqual([mockVar]);
      expect(expr.coeffs).toEqual([1]);
      expect(expr.offset).toBe(0);
    });
  });

  describe('getDomain', () => {
    it('should compute domain of constant expression', () => {
      const expr = LinearExpr.fromConstant(5);
      const domain = expr.getDomain(new Map());
      expect(domain.min).toBe(5);
      expect(domain.max).toBe(5);
    });

    it('should compute domain of single variable', () => {
      const mockVar = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr = LinearExpr.fromVar(mockVar);
      const domain = expr.getDomain(new Map());
      expect(domain.min).toBe(0);
      expect(domain.max).toBe(10);
    });

    it('should compute domain with positive coefficient', () => {
      const mockVar = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([2, 8]) };
      const expr = new LinearExpr([mockVar], [3], 1);
      const domain = expr.getDomain(new Map());
      expect(domain.min).toBe(7);  // 3*2 + 1
      expect(domain.max).toBe(25); // 3*8 + 1
    });

    it('should compute domain with negative coefficient', () => {
      const mockVar = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([2, 8]) };
      const expr = new LinearExpr([mockVar], [-2], 10);
      const domain = expr.getDomain(new Map());
      expect(domain.min).toBe(-6);  // -2*8 + 10
      expect(domain.max).toBe(6);   // -2*2 + 10
    });

    it('should compute domain with custom domain map', () => {
      const mockVar = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 100]) };
      const expr = LinearExpr.fromVar(mockVar);
      const customDomains = new Map([[0, new Domain([5, 15])]]);
      const domain = expr.getDomain(customDomains);
      expect(domain.min).toBe(5);
      expect(domain.max).toBe(15);
    });
  });

  describe('comparison operators', () => {
    const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
    const y = { index: 1, name: 'y', type: 'int' as const, domain: new Domain([0, 10]) };

    it('should create le bounded expression', () => {
      const expr = new LinearExpr([x], [1], 0);
      const bounded = expr.le(5);
      expect(bounded.ub).toBe(0);
    });

    it('should create ge bounded expression', () => {
      const expr = new LinearExpr([x], [1], 0);
      const bounded = expr.ge(5);
      expect(bounded.lb).toBe(0);
    });

    it('should create eq bounded expression', () => {
      const expr = new LinearExpr([x], [1], 0);
      const bounded = expr.eq(5);
      expect(bounded.lb).toBe(0);
      expect(bounded.ub).toBe(0);
    });

    it('should create ne not-equal expression', () => {
      const expr = new LinearExpr([x], [1], 0);
      const ne = expr.ne(5);
      // expr.ne(5) => NotEqualExpression(expr - 5, 0).
      expect(ne.value).toBe(0);
      expect(ne.expr.offset).toBe(-5);
    });

    it('should create le with another expression', () => {
      const expr1 = new LinearExpr([x], [1], 0);
      const expr2 = new LinearExpr([y], [1], 0);
      const bounded = expr1.le(expr2);
      expect(bounded.ub).toBe(0);
    });
  });

  describe('constructor validation', () => {
    it('should throw when vars and coeffs length mismatch', () => {
      const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      expect(() => new LinearExpr([x], [1, 2], 0)).toThrow('vars and coeffs must have the same length');
    });
  });

  describe('toString edge cases', () => {
    it('should format zero-only expression', () => {
      const expr = new LinearExpr([], [], 0);
      expect(expr.toString()).toBe('0');
    });

    it('should format negative coefficient', () => {
      const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr = new LinearExpr([x], [-1], 0);
      expect(expr.toString()).toBe('-x');
    });

    it('should skip zero coefficients', () => {
      const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
      const y = { index: 1, name: 'y', type: 'int' as const, domain: new Domain([0, 10]) };
      const expr = new LinearExpr([x, y], [2, 0], 5);
      expect(expr.toString()).toBe('5 + 2*x');
    });
  });
});

describe('BoundedLinearExpression', () => {
  it('should create equality expression', () => {
    const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
    const expr = new LinearExpr([x], [1], 0);
    const bounded = new BoundedLinearExpression(expr, 5, 5);
    expect(bounded.toString()).toBe('x == 5');
  });

  it('should create inequality expression', () => {
    const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
    const expr = new LinearExpr([x], [1], 0);
    const bounded = new BoundedLinearExpression(expr, 0, 5);
    expect(bounded.toString()).toBe('0 <= x && x <= 5');
  });

  it('should create lower-bounded expression', () => {
    const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
    const expr = new LinearExpr([x], [1], 0);
    const bounded = new BoundedLinearExpression(expr, 3, Infinity);
    expect(bounded.toString()).toBe('3 <= x');
  });

  it('should create upper-bounded expression', () => {
    const x = { index: 0, name: 'x', type: 'int' as const, domain: new Domain([0, 10]) };
    const expr = new LinearExpr([x], [1], 0);
    const bounded = new BoundedLinearExpression(expr, -Infinity, 7);
    expect(bounded.toString()).toBe('x <= 7');
  });
});

describe('Domain - edge cases', () => {
  describe('multi-interval intersection', () => {
    it('should intersect overlapping multi-interval domains', () => {
      const d1 = new Domain([[0, 5], [10, 15]]);
      const d2 = new Domain([[3, 12]]);
      const result = d1.intersection(d2);

      // [[0,5] ∩ [3,12]] = [3,5], [[10,15] ∩ [3,12]] = [10,12]
      expect(result.contains(2)).toBe(false);
      expect(result.contains(3)).toBe(true);
      expect(result.contains(5)).toBe(true);
      expect(result.contains(6)).toBe(false);
      expect(result.contains(9)).toBe(false);
      expect(result.contains(10)).toBe(true);
      expect(result.contains(12)).toBe(true);
      expect(result.contains(13)).toBe(false);
    });

    it('should return empty for disjoint multi-interval domains', () => {
      const d1 = new Domain([[0, 3]]);
      const d2 = new Domain([[5, 8]]);
      const result = d1.intersection(d2);

      expect(result.isEmpty).toBe(true);
    });
  });

  describe('multi-interval union that merges', () => {
    it('should merge adjacent intervals', () => {
      const d1 = new Domain([[0, 3]]);
      const d2 = new Domain([[4, 7]]);
      const result = d1.union(d2);

      // Adjacent intervals should merge into [0, 7]
      expect(result.contains(0)).toBe(true);
      expect(result.contains(3)).toBe(true);
      expect(result.contains(4)).toBe(true);
      expect(result.contains(7)).toBe(true);
      expect(result.size).toBe(8);
    });

    it('should merge overlapping intervals', () => {
      const d1 = new Domain([[0, 5]]);
      const d2 = new Domain([[3, 8]]);
      const result = d1.union(d2);

      // Overlapping → [0, 8]
      expect(result.contains(0)).toBe(true);
      expect(result.contains(8)).toBe(true);
      expect(result.size).toBe(9);
    });

    it('should keep non-adjacent intervals separate', () => {
      const d1 = new Domain([[0, 2]]);
      const d2 = new Domain([[5, 7]]);
      const result = d1.union(d2);

      expect(result.contains(0)).toBe(true);
      expect(result.contains(2)).toBe(true);
      expect(result.contains(3)).toBe(false);
      expect(result.contains(4)).toBe(false);
      expect(result.contains(5)).toBe(true);
      expect(result.contains(7)).toBe(true);
    });
  });

  describe('Domain.complement with multi-interval', () => {
    it('should compute complement of multi-interval within bounds', () => {
      const d = new Domain([[1, 3], [7, 9]]);
      const comp = d.complement(0, 10);

      // Complement: [0,0], [4,6], [10,10]
      expect(comp.contains(0)).toBe(true);
      expect(comp.contains(1)).toBe(false);
      expect(comp.contains(3)).toBe(false);
      expect(comp.contains(4)).toBe(true);
      expect(comp.contains(6)).toBe(true);
      expect(comp.contains(7)).toBe(false);
      expect(comp.contains(9)).toBe(false);
      expect(comp.contains(10)).toBe(true);
    });

    it('should return empty when domain covers full range', () => {
      const d = new Domain([[0, 10]]);
      const comp = d.complement(0, 10);

      expect(comp.isEmpty).toBe(true);
    });

    it('should return full range for empty domain', () => {
      const d = Domain.empty();
      const comp = d.complement(0, 5);

      expect(comp.contains(0)).toBe(true);
      expect(comp.contains(5)).toBe(true);
      expect(comp.size).toBe(6);
    });
  });

  describe('Domain with single value', () => {
    it('should have size 1 for fixed domain', () => {
      const d = new Domain([5, 5]);
      expect(d.size).toBe(1);
      expect(d.min).toBe(5);
      expect(d.max).toBe(5);
      expect(d.contains(5)).toBe(true);
      expect(d.contains(4)).toBe(false);
    });
  });
});
