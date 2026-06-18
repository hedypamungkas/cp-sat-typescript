/**
 * CP-SAT TypeScript Implementation
 * Core type definitions for the constraint programming solver
 */

// ============================================================================
// Solver Status
// ============================================================================

/**
 * Status returned by the CP-SAT solver
 */
export enum CpSolverStatus {
  /** The solver did not start or was interrupted before finding a solution */
  UNKNOWN = 'UNKNOWN',
  /** The model is invalid (failed validation) */
  MODEL_INVALID = 'MODEL_INVALID',
  /** A feasible solution was found, but optimality is not proven */
  FEASIBLE = 'FEASIBLE',
  /** The problem is proven to have no solution */
  INFEASIBLE = 'INFEASIBLE',
  /** An optimal solution was found */
  OPTIMAL = 'OPTIMAL',
}

// ============================================================================
// Variable Selection Strategy
// ============================================================================

/**
 * Strategy for selecting the next variable to branch on
 */
export enum VariableSelectionStrategy {
  /** Choose the first unassigned variable */
  CHOOSE_FIRST = 'CHOOSE_FIRST',
  /** Choose the variable with the smallest minimum value */
  CHOOSE_LOWEST_MIN = 'CHOOSE_LOWEST_MIN',
  /** Choose the variable with the largest maximum value */
  CHOOSE_HIGHEST_MAX = 'CHOOSE_HIGHEST_MAX',
  /** Choose the variable with the smallest domain */
  CHOOSE_MIN_DOMAIN_SIZE = 'CHOOSE_MIN_DOMAIN_SIZE',
  /** Choose the variable with the largest domain */
  CHOOSE_MAX_DOMAIN_SIZE = 'CHOOSE_MAX_DOMAIN_SIZE',
}

// ============================================================================
// Domain Reduction Strategy
// ============================================================================

/**
 * Strategy for selecting which value to try first when branching
 */
export enum DomainReductionStrategy {
  /** Try the minimum value first */
  SELECT_MIN_VALUE = 'SELECT_MIN_VALUE',
  /** Try the maximum value first */
  SELECT_MAX_VALUE = 'SELECT_MAX_VALUE',
  /** Try values from the lower half first */
  SELECT_LOWER_HALF = 'SELECT_LOWER_HALF',
  /** Try values from the upper half first */
  SELECT_UPPER_HALF = 'SELECT_UPPER_HALF',
  /** Try the median value first */
  SELECT_MEDIAN_VALUE = 'SELECT_MEDIAN_VALUE',
  /** Try a random half first */
  SELECT_RANDOM_HALF = 'SELECT_RANDOM_HALF',
}

// ============================================================================
// Domain Types
// ============================================================================

/**
 * Represents a domain as a sorted list of intervals [start, end]
 * Example: [[0, 5], [10, 15]] represents values 0-5 and 10-15
 */
export type DomainIntervals = [number, number][];

/**
 * Domain for integer variables - can be specified as:
 * - A single interval [lb, ub]
 * - A list of intervals [[lb1, ub1], [lb2, ub2], ...]
 */
export type DomainSpec = [number, number] | DomainIntervals;

// ============================================================================
// Linear Expression Types
// ============================================================================

/**
 * Represents a linear expression: sum(vars[i] * coeffs[i]) + offset
 */
export interface LinearExpressionData {
  vars: number[];
  coeffs: number[];
  offset: number;
}

/**
 * Types that can be used in linear expressions
 */
export type LinearExprLike = number | IntVar | LinearExpr;

/**
 * Types that can be used as literals (boolean expressions)
 */
export type LiteralLike = number | BoolVar | boolean;

// ============================================================================
// Variable Interfaces
// ============================================================================

/**
 * Base interface for all variables
 */
export interface Variable {
  /** Unique index in the model */
  readonly index: number;
  /** Variable name */
  readonly name: string;
  /** The domain of the variable */
  readonly domain: Domain;
}

/**
 * Integer variable with a finite domain
 */
export interface IntVar extends Variable {
  /** Type discriminator */
  readonly type: 'int' | 'bool';
}

/**
 * Boolean variable (domain [0, 1])
 */
export interface BoolVar extends IntVar {
  /** Type discriminator */
  readonly type: 'bool';
}

/**
 * Interval variable for scheduling constraints
 */
export interface IntervalVar {
  /** Unique index in the model */
  readonly index: number;
  /** Variable name */
  readonly name: string;
  /** Start time expression */
  readonly start: LinearExpr;
  /** Size/duration expression */
  readonly size: LinearExpr;
  /** End time expression */
  readonly end: LinearExpr;
  /** Optional presence literal */
  readonly isPresent?: BoolVar;
}

// ============================================================================
// Domain Class
// ============================================================================

/**
 * Represents the domain of an integer variable as a sorted list of intervals
 */
export class Domain {
  private _intervals: [number, number][];
  private _size: number;

  constructor(spec?: DomainSpec) {
    if (spec === undefined) {
      this._intervals = [];
    } else if (spec.length === 0) {
      this._intervals = [];
    } else if (Array.isArray(spec[0])) {
      // DomainIntervals format - check if first element is a tuple [number, number]
      this._intervals = (spec as DomainIntervals).map(([lb, ub]) => [lb, ub] as [number, number]);
    } else {
      // Single interval format [lb, ub]
      const [lb, ub] = spec as [number, number];
      this._intervals = [[lb, ub]];
    }
    this._size = 0; // will be computed by normalize()
    this.normalize();
  }

  /**
   * Create a domain from a single interval
   */
  static fromInterval(lb: number, ub: number): Domain {
    return new Domain([lb, ub]);
  }

  /**
   * Create a domain from a list of values
   */
  static fromValues(values: number[]): Domain {
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    if (sorted.length === 0) return new Domain([]);

    const intervals: [number, number][] = [];
    let start = sorted[0];
    let end = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === end + 1) {
        end = sorted[i];
      } else {
        intervals.push([start, end]);
        start = sorted[i];
        end = sorted[i];
      }
    }
    intervals.push([start, end]);

    return new Domain(intervals as DomainIntervals);
  }

  /**
   * Create an empty domain
   */
  static empty(): Domain {
    return new Domain([]);
  }

  /**
   * Get the intervals
   */
  get intervals(): [number, number][] {
    return this._intervals;
  }

  /**
   * Check if the domain is empty
   */
  get isEmpty(): boolean {
    return this._intervals.length === 0;
  }

  /**
   * Get the minimum value in the domain
   */
  get min(): number {
    if (this.isEmpty) throw new Error('Cannot get min of empty domain');
    return this._intervals[0][0];
  }

  /**
   * Get the maximum value in the domain
   */
  get max(): number {
    if (this.isEmpty) throw new Error('Cannot get max of empty domain');
    return this._intervals[this._intervals.length - 1][1];
  }

  /**
   * Get the size of the domain (number of possible values)
   */
  get size(): number {
    return this._size;
  }

  /**
   * Compute the size from intervals
   */
  private _computeSize(): number {
    let size = 0;
    for (const [lb, ub] of this._intervals) {
      size += ub - lb + 1;
    }
    return size;
  }

  /**
   * Check if a value is in the domain
   */
  contains(value: number): boolean {
    for (const [lb, ub] of this._intervals) {
      if (value >= lb && value <= ub) return true;
      if (value < lb) return false;
    }
    return false;
  }

  /**
   * Get all values in the domain
   */
  values(): number[] {
    const values: number[] = [];
    for (const [lb, ub] of this._intervals) {
      for (let v = lb; v <= ub; v++) {
        values.push(v);
      }
    }
    return values;
  }

  /**
   * Create a new domain with a single value
   */
  fixValue(value: number): Domain {
    if (!this.contains(value)) return Domain.empty();
    return new Domain([value, value]);
  }

  /**
   * Create a new domain with values >= lb
   */
  greaterOrEqual(lb: number): Domain {
    const newIntervals: [number, number][] = [];
    for (const [start, end] of this._intervals) {
      if (end >= lb) {
        newIntervals.push([Math.max(start, lb), end]);
      }
    }
    return new Domain(newIntervals as DomainIntervals);
  }

  /**
   * Create a new domain with values <= ub
   */
  lessOrEqual(ub: number): Domain {
    const newIntervals: [number, number][] = [];
    for (const [start, end] of this._intervals) {
      if (start <= ub) {
        newIntervals.push([start, Math.min(end, ub)]);
      }
    }
    return new Domain(newIntervals as DomainIntervals);
  }

  /**
   * Create a new domain without a specific value
   */
  removeValue(value: number): Domain {
    const newIntervals: [number, number][] = [];
    for (const [start, end] of this._intervals) {
      if (value < start || value > end) {
        newIntervals.push([start, end]);
      } else {
        if (start < value) newIntervals.push([start, value - 1]);
        if (value < end) newIntervals.push([value + 1, end]);
      }
    }
    return new Domain(newIntervals as DomainIntervals);
  }

  /**
   * Intersect with another domain
   */
  intersection(other: Domain): Domain {
    const result: [number, number][] = [];
    let i = 0, j = 0;

    while (i < this._intervals.length && j < other._intervals.length) {
      const [a1, a2] = this._intervals[i];
      const [b1, b2] = other._intervals[j];

      const start = Math.max(a1, b1);
      const end = Math.min(a2, b2);

      if (start <= end) {
        result.push([start, end]);
      }

      if (a2 < b2) i++;
      else j++;
    }

    return new Domain(result as DomainIntervals);
  }

  /**
   * Union with another domain
   */
  union(other: Domain): Domain {
    const allIntervals = [...this._intervals, ...other._intervals]
      .sort((a, b) => a[0] - b[0]);

    if (allIntervals.length === 0) return Domain.empty();

    const merged: [number, number][] = [allIntervals[0]];
    for (let i = 1; i < allIntervals.length; i++) {
      const last = merged[merged.length - 1];
      const current = allIntervals[i];

      if (current[0] <= last[1] + 1) {
        last[1] = Math.max(last[1], current[1]);
      } else {
        merged.push(current);
      }
    }

    return new Domain(merged as DomainIntervals);
  }

  /**
   * Normalize intervals (merge overlapping/adjacent)
   */
  private normalize(): void {
    if (this._intervals.length <= 1) {
      this._size = this._computeSize();
      return;
    }

    const merged: [number, number][] = [this._intervals[0]];
    for (let i = 1; i < this._intervals.length; i++) {
      const last = merged[merged.length - 1];
      const current = this._intervals[i];

      if (current[0] <= last[1] + 1) {
        last[1] = Math.max(last[1], current[1]);
      } else {
        merged.push(current);
      }
    }

    this._intervals = merged;
    this._size = this._computeSize();
  }

  /**
   * Create the complement of this domain (all integers NOT in the domain)
   * Returns intervals bounded by the given range.
   */
  complement(boundLb: number = -1000000, boundUb: number = 1000000): Domain {
    if (this.isEmpty) {
      return new Domain([boundLb, boundUb]);
    }

    const result: [number, number][] = [];
    let current = boundLb;

    for (const [start, end] of this._intervals) {
      if (current < start) {
        result.push([current, start - 1]);
      }
      current = Math.max(current, end + 1);
    }

    if (current <= boundUb) {
      result.push([current, boundUb]);
    }

    return new Domain(result as DomainIntervals);
  }

  /**
   * String representation
   */
  toString(): string {
    if (this.isEmpty) return '{}';
    return this._intervals
      .map(([lb, ub]) => lb === ub ? `${lb}` : `[${lb},${ub}]`)
      .join(' ∪ ');
  }
}

// ============================================================================
// LinearExpr Class
// ============================================================================

/**
 * Represents a linear expression: sum(vars[i] * coeffs[i]) + offset
 */
export class LinearExpr {
  /** Variables in the expression */
  readonly vars: IntVar[];
  /** Coefficients for each variable */
  readonly coeffs: number[];
  /** Constant offset */
  readonly offset: number;

  constructor(vars: IntVar[] = [], coeffs: number[] = [], offset: number = 0) {
    if (vars.length !== coeffs.length) {
      throw new Error('vars and coeffs must have the same length');
    }
    this.vars = vars;
    this.coeffs = coeffs;
    this.offset = offset;
  }

  /**
   * Create a LinearExpr from a variable
   */
  static fromVar(v: IntVar): LinearExpr {
    return new LinearExpr([v], [1], 0);
  }

  /**
   * Create a LinearExpr from a constant
   */
  static fromConstant(value: number): LinearExpr {
    return new LinearExpr([], [], value);
  }

  /**
   * Create a LinearExpr from a value (number or variable)
   */
  static from(value: LinearExprLike): LinearExpr {
    if (typeof value === 'number') {
      return LinearExpr.fromConstant(value);
    }
    if (value instanceof LinearExpr) {
      return value;
    }
    // It's a variable
    return LinearExpr.fromVar(value as IntVar);
  }

  /**
   * Evaluate the expression given a value assignment
   */
  evaluate(valueFn: (v: IntVar) => number): number {
    let result = this.offset;
    for (let i = 0; i < this.vars.length; i++) {
      result += this.coeffs[i] * valueFn(this.vars[i]);
    }
    return result;
  }

  /**
   * Get the domain of this expression given variable domains
   */
  getDomain(varDomains: Map<number, Domain>): Domain {
    if (this.vars.length === 0) {
      return new Domain([this.offset, this.offset]);
    }

    // Compute min and max possible values
    let min = this.offset;
    let max = this.offset;

    for (let i = 0; i < this.vars.length; i++) {
      const v = this.vars[i];
      const c = this.coeffs[i];
      const domain = varDomains.get(v.index) ?? v.domain;

      if (c > 0) {
        min += c * domain.min;
        max += c * domain.max;
      } else if (c < 0) {
        min += c * domain.max;
        max += c * domain.min;
      }
    }

    return new Domain([min, max]);
  }

  /**
   * Add two linear expressions
   */
  add(other: LinearExprLike): LinearExpr {
    const o = LinearExpr.from(other);
    return new LinearExpr(
      [...this.vars, ...o.vars],
      [...this.coeffs, ...o.coeffs],
      this.offset + o.offset
    );
  }

  /**
   * Subtract a linear expression
   */
  sub(other: LinearExprLike): LinearExpr {
    const o = LinearExpr.from(other);
    return new LinearExpr(
      [...this.vars, ...o.vars],
      [...this.coeffs, ...o.coeffs.map(c => -c)],
      this.offset - o.offset
    );
  }

  /**
   * Multiply by a constant
   */
  mul(constant: number): LinearExpr {
    return new LinearExpr(
      [...this.vars],
      this.coeffs.map(c => c * constant),
      this.offset * constant
    );
  }

  /**
   * Negate the expression
   */
  neg(): LinearExpr {
    return this.mul(-1);
  }

  /**
   * Create a less-than-or-equal constraint expression
   */
  le(other: LinearExprLike | number): BoundedLinearExpression {
    const expr = LinearExpr.from(other);
    return new BoundedLinearExpression(
      this.sub(expr),
      -Infinity,
      0
    );
  }

  /**
   * Create a greater-than-or-equal constraint expression
   */
  ge(other: LinearExprLike | number): BoundedLinearExpression {
    const expr = LinearExpr.from(other);
    return new BoundedLinearExpression(
      this.sub(expr),
      0,
      Infinity
    );
  }

  /**
   * Create an equality constraint expression
   */
  eq(other: LinearExprLike | number): BoundedLinearExpression {
    const expr = LinearExpr.from(other);
    return new BoundedLinearExpression(
      this.sub(expr),
      0,
      0
    );
  }

  /**
   * Create a not-equal constraint expression
   */
  ne(other: LinearExprLike | number): BoundedLinearExpression {
    const expr = LinearExpr.from(other);
    return new BoundedLinearExpression(
      this.sub(expr),
      -Infinity,
      -1
    );
  }

  /**
   * String representation
   */
  toString(): string {
    const parts: string[] = [];

    if (this.offset !== 0 || this.vars.length === 0) {
      parts.push(this.offset.toString());
    }

    for (let i = 0; i < this.vars.length; i++) {
      const c = this.coeffs[i];
      const v = this.vars[i];

      if (c === 0) continue;

      let part = '';
      if (c === 1) {
        part = v.name;
      } else if (c === -1) {
        part = `-${v.name}`;
      } else {
        part = `${c}*${v.name}`;
      }

      parts.push(part);
    }

    return parts.join(' + ').replace(/\+ -/g, '- ');
  }
}

// ============================================================================
// BoundedLinearExpression
// ============================================================================

/**
 * Represents a bounded linear expression: lb <= expr <= ub
 */
export class BoundedLinearExpression {
  readonly expr: LinearExpr;
  readonly lb: number;
  readonly ub: number;

  constructor(expr: LinearExpr, lb: number, ub: number) {
    this.expr = expr;
    this.lb = lb;
    this.ub = ub;
  }

  toString(): string {
    if (this.lb === this.ub) {
      return `${this.expr} == ${this.lb}`;
    }
    const parts: string[] = [];
    if (this.lb > -Infinity) parts.push(`${this.lb} <= ${this.expr}`);
    if (this.ub < Infinity) parts.push(`${this.expr} <= ${this.ub}`);
    return parts.join(' && ');
  }
}

// ============================================================================
// Operator Overloading for IntVar and LinearExpr
// ============================================================================

/**
 * Extend IntVar with operator-like methods
 */
export function createVarProxy(v: IntVar): IntVarWithOps {
  return Object.assign(v, {
    add: (other: LinearExprLike) => LinearExpr.fromVar(v).add(other),
    sub: (other: LinearExprLike) => LinearExpr.fromVar(v).sub(other),
    mul: (constant: number) => LinearExpr.fromVar(v).mul(constant),
    neg: () => LinearExpr.fromVar(v).neg(),
    le: (other: LinearExprLike | number) => {
      const expr = LinearExpr.from(other);
      return new BoundedLinearExpression(
        LinearExpr.fromVar(v).sub(expr),
        -Infinity,
        0
      );
    },
    ge: (other: LinearExprLike | number) => {
      const expr = LinearExpr.from(other);
      return new BoundedLinearExpression(
        LinearExpr.fromVar(v).sub(expr),
        0,
        Infinity
      );
    },
    eq: (other: LinearExprLike | number) => {
      const expr = LinearExpr.from(other);
      return new BoundedLinearExpression(
        LinearExpr.fromVar(v).sub(expr),
        0,
        0
      );
    },
    ne: (other: LinearExprLike | number) => {
      const expr = LinearExpr.from(other);
      return new BoundedLinearExpression(
        LinearExpr.fromVar(v).sub(expr),
        -Infinity,
        -1
      );
    },
  });
}

export interface IntVarWithOps extends IntVar {
  add(other: LinearExprLike): LinearExpr;
  sub(other: LinearExprLike): LinearExpr;
  mul(constant: number): LinearExpr;
  neg(): LinearExpr;
  le(other: LinearExprLike | number): BoundedLinearExpression;
  ge(other: LinearExprLike | number): BoundedLinearExpression;
  eq(other: LinearExprLike | number): BoundedLinearExpression;
  ne(other: LinearExprLike | number): BoundedLinearExpression;
}

// ============================================================================
// Solver Parameters
// ============================================================================

/**
 * Parameters for the CP-SAT solver
 */
export interface SolverParameters {
  /** Maximum time in seconds */
  maxTimeInSeconds?: number;
  /** Enumerate all solutions */
  enumerateAllSolutions?: boolean;
  /** Number of workers (threads) */
  numWorkers?: number;
  /** Log search progress */
  logSearchProgress?: boolean;
  /** Random seed */
  randomSeed?: number;
  /** Linearization level */
  linearizationLevel?: number;
  /** Symmetry level */
  symmetryLevel?: number;
}

// ============================================================================
// Solver Statistics
// ============================================================================

/**
 * Statistics returned by the solver
 */
export interface SolverStatistics {
  /** Number of conflicts encountered */
  numConflicts: number;
  /** Number of branches explored */
  numBranches: number;
  /** Number of Boolean propagations */
  numBooleanPropagations: number;
  /** Number of integer propagations */
  numIntegerPropagations: number;
  /** Wall time in seconds */
  wallTime: number;
  /** Number of solutions found */
  numSolutions: number;
  /** Presolve time in seconds */
  presolveTime: number;
  /** Search time in seconds */
  searchTime: number;
}
