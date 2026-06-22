/**
 * CP-SAT TypeScript Implementation
 * Variable classes for the constraint programming solver
 */

import { Domain, LinearExpr, IntVar, BoolVar, IntervalVar, IntVarWithOps, createVarProxy } from './types';

// ============================================================================
// Variable Registry
// ============================================================================

/**
 * Registry for tracking variables in a model
 */
export class VariableRegistry {
  private _intVars: Map<number, IntVarImpl> = new Map();
  private _boolVars: Map<number, BoolVarImpl> = new Map();
  private _intervalVars: Map<number, IntervalVarImpl> = new Map();
  private _nextIndex: number = 0;

  /**
   * Get the next available index
   */
  getNextIndex(): number {
    return this._nextIndex++;
  }

  /**
   * Register an integer variable
   */
  registerIntVar(v: IntVarImpl): void {
    this._intVars.set(v.index, v);
  }

  /**
   * Register a boolean variable
   */
  registerBoolVar(v: BoolVarImpl): void {
    this._boolVars.set(v.index, v);
  }

  /**
   * Register an interval variable
   */
  registerIntervalVar(v: IntervalVarImpl): void {
    this._intervalVars.set(v.index, v);
  }

  /**
   * Get an integer variable by index
   */
  getIntVar(index: number): IntVarImpl | undefined {
    return this._intVars.get(index);
  }

  /**
   * Get a boolean variable by index
   */
  getBoolVar(index: number): BoolVarImpl | undefined {
    return this._boolVars.get(index);
  }

  /**
   * Get an interval variable by index
   */
  getIntervalVar(index: number): IntervalVarImpl | undefined {
    return this._intervalVars.get(index);
  }

  /**
   * Get all integer variables
   */
  get allIntVars(): IntVarImpl[] {
    return Array.from(this._intVars.values());
  }

  /**
   * Get all boolean variables
   */
  get allBoolVars(): BoolVarImpl[] {
    return Array.from(this._boolVars.values());
  }

  /**
   * Get all interval variables
   */
  get allIntervalVars(): IntervalVarImpl[] {
    return Array.from(this._intervalVars.values());
  }

  /**
   * Get total number of variables
   */
  get count(): number {
    return this._intVars.size + this._boolVars.size;
  }
}

// ============================================================================
// IntVar Implementation
// ============================================================================

/**
 * Integer variable implementation
 */
export class IntVarImpl implements IntVarWithOps {
  readonly type = 'int' as const;
  readonly index: number;
  readonly name: string;
  readonly domain: Domain;

  constructor(index: number, domain: Domain, name: string) {
    this.index = index;
    this.domain = domain;
    this.name = name;
  }

  add(other: import('./types').LinearExprLike): LinearExpr {
    return LinearExpr.fromVar(this).add(other);
  }

  sub(other: import('./types').LinearExprLike): LinearExpr {
    return LinearExpr.fromVar(this).sub(other);
  }

  mul(constant: number): LinearExpr {
    return LinearExpr.fromVar(this).mul(constant);
  }

  neg(): LinearExpr {
    return LinearExpr.fromVar(this).neg();
  }

  le(other: import('./types').LinearExprLike | number): import('./types').BoundedLinearExpression {
    return createVarProxy(this).le(other);
  }

  ge(other: import('./types').LinearExprLike | number): import('./types').BoundedLinearExpression {
    return createVarProxy(this).ge(other);
  }

  eq(other: import('./types').LinearExprLike | number): import('./types').BoundedLinearExpression {
    return createVarProxy(this).eq(other);
  }

  ne(other: import('./types').LinearExprLike | number): import('./types').NotEqualExpression {
    return createVarProxy(this).ne(other);
  }

  toString(): string {
    return `IntVar(${this.name}: ${this.domain})`;
  }
}

// ============================================================================
// BoolVar Implementation
// ============================================================================

/**
 * Boolean variable implementation (domain [0, 1])
 */
export class BoolVarImpl implements BoolVar {
  readonly type = 'bool' as const;
  readonly index: number;
  readonly name: string;
  readonly domain: Domain;

  constructor(index: number, name: string) {
    this.index = index;
    this.domain = new Domain([0, 1]);
    this.name = name;
  }

  /**
   * Get the negated literal (NOT this variable)
   */
  get negated(): number {
    // Negated literal is represented as -(index + 1) in CP-SAT
    return -(this.index + 1);
  }

  add(other: import('./types').LinearExprLike): LinearExpr {
    return LinearExpr.fromVar(this).add(other);
  }

  sub(other: import('./types').LinearExprLike): LinearExpr {
    return LinearExpr.fromVar(this).sub(other);
  }

  mul(constant: number): LinearExpr {
    return LinearExpr.fromVar(this).mul(constant);
  }

  neg(): LinearExpr {
    return LinearExpr.fromVar(this).neg();
  }

  le(other: import('./types').LinearExprLike | number): import('./types').BoundedLinearExpression {
    return createVarProxy(this).le(other);
  }

  ge(other: import('./types').LinearExprLike | number): import('./types').BoundedLinearExpression {
    return createVarProxy(this).ge(other);
  }

  eq(other: import('./types').LinearExprLike | number): import('./types').BoundedLinearExpression {
    return createVarProxy(this).eq(other);
  }

  ne(other: import('./types').LinearExprLike | number): import('./types').NotEqualExpression {
    return createVarProxy(this).ne(other);
  }

  toString(): string {
    return `BoolVar(${this.name})`;
  }
}

// ============================================================================
// IntervalVar Implementation
// ============================================================================

/**
 * Interval variable implementation for scheduling constraints
 */
export class IntervalVarImpl implements IntervalVar {
  readonly index: number;
  readonly name: string;
  readonly start: LinearExpr;
  readonly size: LinearExpr;
  readonly end: LinearExpr;
  readonly isPresent?: BoolVar;

  constructor(
    index: number,
    start: LinearExpr,
    size: LinearExpr,
    end: LinearExpr,
    name: string,
    isPresent?: BoolVar
  ) {
    this.index = index;
    this.start = start;
    this.size = size;
    this.end = end;
    this.name = name;
    this.isPresent = isPresent;
  }

  toString(): string {
    return `IntervalVar(${this.name})`;
  }
}
