/**
 * CP-SAT TypeScript Implementation
 * CpModel - The main model builder class
 */

import {
  Domain,
  LinearExpr,
  LinearExprLike,
  LinearExpressionData,
  BoundedLinearExpression,
  NotEqualExpression,
  VariableSelectionStrategy,
  DomainReductionStrategy,
  BoolVar,
  ModelJSON,
  VariableData,
  IntervalVarData,
  ConstraintData,
  DecisionStrategyData,
} from './types';

import {
  IntVarImpl,
  BoolVarImpl,
  IntervalVarImpl,
  VariableRegistry,
} from './variables';

import {
  Constraint,
  LinearConstraint,
  NotEqualConstraint,
  AllDifferentConstraint,
  ElementConstraint,
  CircuitConstraint,
  MultipleCircuitConstraint,
  AllowedAssignmentsConstraint,
  ForbiddenAssignmentsConstraint,
  AutomatonConstraint,
  InverseConstraint,
  ReservoirConstraint,
  BoolOrConstraint,
  BoolAndConstraint,
  AtMostOneConstraint,
  ExactlyOneConstraint,
  BoolXorConstraint,
  ImplicationConstraint,
  MinEqualityConstraint,
  MaxEqualityConstraint,
  DivisionEqualityConstraint,
  AbsEqualityConstraint,
  ModuloEqualityConstraint,
  MultiplicationEqualityConstraint,
  NoOverlapConstraint,
  NoOverlap2DConstraint,
  CumulativeConstraint,
  MapDomainConstraint,
} from './constraints';

import { normalizeClause } from './clause-engine';

// ============================================================================
// CpModel Class
// ============================================================================

/**
 * CP-SAT Model Builder
 *
 * This is the main class for building constraint programming models.
 * It provides methods to create variables, add constraints, and set objectives.
 *
 * @example
 * ```typescript
 * const model = new CpModel();
 * const x = model.newIntVar(0, 10, 'x');
 * const y = model.newIntVar(0, 10, 'y');
 * model.add(x.add(y).le(15));
 * model.maximize(x.add(y.mul(2)));
 * ```
 */
export class CpModel {
  private _name: string;
  private _registry: VariableRegistry;
  private _constraints: Constraint[] = [];
  private _objective: LinearExpr | null = null;
  private _maximize: boolean = false;
  private _hints: Map<number, number> = new Map();
  private _assumptions: (BoolVar | number)[] = [];
  /** Boolean clauses (signed-int literals) for the LCG clause engine. */
  private _clauses: number[][] = [];
  private _decisionStrategies: Array<{
    variables: IntVarImpl[];
    varStrategy: VariableSelectionStrategy;
    domainStrategy: DomainReductionStrategy;
  }> = [];

  constructor(name: string = '') {
    this._name = name;
    this._registry = new VariableRegistry();
  }

  // ============================================================================
  // Properties
  // ============================================================================

  /**
   * Get or set the model name
   */
  get name(): string {
    return this._name;
  }

  set name(value: string) {
    this._name = value;
  }

  /**
   * Get the variable registry
   */
  get registry(): VariableRegistry {
    return this._registry;
  }

  /**
   * Get all constraints
   */
  get constraints(): Constraint[] {
    return this._constraints;
  }

  /**
   * Get the objective expression
   */
  get objective(): LinearExpr | null {
    return this._objective;
  }

  /**
   * Check if maximizing
   */
  get isMaximize(): boolean {
    return this._maximize;
  }

  /**
   * Check if an objective is set
   */
  hasObjective(): boolean {
    return this._objective !== null;
  }

  /**
   * Get solution hints
   */
  get hints(): Map<number, number> {
    return this._hints;
  }

  /**
   * Get assumptions. Each element is either a BoolVar (force to true) or a
   * negated literal number (force the underlying BoolVar to false).
   */
  get assumptions(): (BoolVar | number)[] {
    return this._assumptions;
  }

  /**
   * Get decision strategies
   */
  get decisionStrategies(): Array<{
    variables: IntVarImpl[];
    varStrategy: VariableSelectionStrategy;
    domainStrategy: DomainReductionStrategy;
  }> {
    return this._decisionStrategies;
  }

  // ============================================================================
  // Variable Creation
  // ============================================================================

  /**
   * Create an integer variable with domain [lb, ub]
   *
   * @param lb - Lower bound
   * @param ub - Upper bound
   * @param name - Variable name
   * @returns The created integer variable
   *
   * @example
   * ```typescript
   * const x = model.newIntVar(0, 100, 'x');
   * ```
   */
  newIntVar(lb: number, ub: number, name: string): IntVarImpl {
    if (lb > ub) {
      throw new Error(`Invalid domain for ${name}: lower bound ${lb} > upper bound ${ub}`);
    }
    const index = this._registry.getNextIndex();
    const domain = new Domain([lb, ub]);
    const v = new IntVarImpl(index, domain, name);
    this._registry.registerIntVar(v);
    return v;
  }

  /**
   * Create an integer variable from a domain specification
   *
   * @param domain - Domain specification (intervals or values)
   * @param name - Variable name
   * @returns The created integer variable
   *
   * @example
   * ```typescript
   * const x = model.newIntVarFromDomain(new Domain([[0, 5], [10, 15]]), 'x');
   * ```
   */
  newIntVarFromDomain(domain: Domain, name: string): IntVarImpl {
    if (domain.isEmpty) {
      throw new Error(`Cannot create variable ${name} with empty domain`);
    }
    const index = this._registry.getNextIndex();
    const v = new IntVarImpl(index, domain, name);
    this._registry.registerIntVar(v);
    return v;
  }

  /**
   * Create a boolean variable (domain [0, 1])
   *
   * @param name - Variable name
   * @returns The created boolean variable
   *
   * @example
   * ```typescript
   * const b = model.newBoolVar('b');
   * ```
   */
  newBoolVar(name: string): BoolVarImpl {
    const index = this._registry.getNextIndex();
    const v = new BoolVarImpl(index, name);
    this._registry.registerBoolVar(v);
    return v;
  }

  /**
   * Create a constant (fixed value)
   *
   * @param value - The constant value
   * @returns An integer variable fixed to the given value
   *
   * @example
   * ```typescript
   * const c = model.newConstant(42);
   * ```
   */
  newConstant(value: number): IntVarImpl {
    return this.newIntVar(value, value, `constant_${value}`);
  }

  /**
   * Create an interval variable
   *
   * @param start - Start time expression
   * @param size - Duration expression
   * @param end - End time expression
   * @param name - Variable name
   * @returns The created interval variable
   *
   * @example
   * ```typescript
   * const start = model.newIntVar(0, 100, 'start');
   * const interval = model.newIntervalVar(start, 5, model.newIntVar(0, 100, 'end'), 'task');
   * ```
   */
  newIntervalVar(
    start: LinearExprLike,
    size: LinearExprLike,
    end: LinearExprLike,
    name: string
  ): IntervalVarImpl {
    const startExpr = LinearExpr.from(start);
    const sizeExpr = LinearExpr.from(size);
    const endExpr = LinearExpr.from(end);

    const index = this._registry.getNextIndex();
    const v = new IntervalVarImpl(index, startExpr, sizeExpr, endExpr, name);
    this._registry.registerIntervalVar(v);
    return v;
  }

  /**
   * Create a fixed-size interval variable
   *
   * @param start - Start time expression
   * @param size - Fixed duration
   * @param name - Variable name
   * @returns The created interval variable
   *
   * @example
   * ```typescript
   * const start = model.newIntVar(0, 100, 'start');
   * const interval = model.newFixedSizeIntervalVar(start, 5, 'task');
   * ```
   */
  newFixedSizeIntervalVar(
    start: LinearExprLike,
    size: number,
    name: string
  ): IntervalVarImpl {
    const startExpr = LinearExpr.from(start);
    const sizeExpr = LinearExpr.fromConstant(size);

    // Compute end domain from start domain + size
    // end = start + size, so endDomain = [startMin + size, startMax + size]
    let endMin: number;
    let endMax: number;
    if (start instanceof IntVarImpl || start instanceof BoolVarImpl) {
      // Single variable: end domain = start domain shifted by size
      endMin = start.domain.min + size;
      endMax = start.domain.max + size;
    } else if (start instanceof LinearExpr) {
      // Linear expression: use variable bounds + offset + size
      // For a single-var expr like x + c: end in [x.min + c + size, x.max + c + size]
      if (startExpr.vars.length === 1 && startExpr.coeffs[0] === 1) {
        const v = startExpr.vars[0];
        endMin = v.domain.min + startExpr.offset + size;
        endMax = v.domain.max + startExpr.offset + size;
      } else {
        // Multi-var or complex expression: conservative bounds
        endMin = startExpr.offset + size;
        endMax = startExpr.offset + size + 10000;
      }
    } else {
      // Constant: end = start + size
      endMin = (start as number) + size;
      endMax = (start as number) + size;
    }

    const endVar = this.newIntVar(endMin, endMax, `${name}_end`);
    const endExpr = LinearExpr.fromVar(endVar);

    // Link end = start + size
    this.add(startExpr.add(sizeExpr).eq(endExpr));

    const index = this._registry.getNextIndex();
    const v = new IntervalVarImpl(index, startExpr, sizeExpr, endExpr, name);
    this._registry.registerIntervalVar(v);
    return v;
  }

  /**
   * Create an optional interval variable
   *
   * @param start - Start time expression
   * @param size - Duration expression
   * @param end - End time expression
   * @param isPresent - Presence literal
   * @param name - Variable name
   * @returns The created interval variable
   *
   * @example
   * ```typescript
   * const present = model.newBoolVar('present');
   * const interval = model.newOptionalIntervalVar(start, 5, end, present, 'task');
   * ```
   */
  newOptionalIntervalVar(
    start: LinearExprLike,
    size: LinearExprLike,
    end: LinearExprLike,
    isPresent: BoolVarImpl,
    name: string
  ): IntervalVarImpl {
    const startExpr = LinearExpr.from(start);
    const sizeExpr = LinearExpr.from(size);
    const endExpr = LinearExpr.from(end);

    const index = this._registry.getNextIndex();
    const v = new IntervalVarImpl(index, startExpr, sizeExpr, endExpr, name, isPresent);
    this._registry.registerIntervalVar(v);
    return v;
  }

  /**
   * Create a fixed-size optional interval variable
   *
   * @param start - Start time expression
   * @param size - Fixed duration
   * @param isPresent - Presence literal
   * @param name - Variable name
   * @returns The created interval variable
   */
  newOptionalFixedSizeIntervalVar(
    start: LinearExprLike,
    size: number,
    isPresent: BoolVarImpl,
    name: string
  ): IntervalVarImpl {
    const startExpr = LinearExpr.from(start);
    const sizeExpr = LinearExpr.fromConstant(size);

    // Compute end domain from start domain + size
    let endMin: number;
    let endMax: number;
    if (start instanceof IntVarImpl || start instanceof BoolVarImpl) {
      endMin = start.domain.min + size;
      endMax = start.domain.max + size;
    } else if (start instanceof LinearExpr) {
      if (startExpr.vars.length === 1 && startExpr.coeffs[0] === 1) {
        const v = startExpr.vars[0];
        endMin = v.domain.min + startExpr.offset + size;
        endMax = v.domain.max + startExpr.offset + size;
      } else {
        endMin = startExpr.offset + size;
        endMax = startExpr.offset + size + 10000;
      }
    } else {
      endMin = (start as number) + size;
      endMax = (start as number) + size;
    }

    const endVar = this.newIntVar(endMin, endMax, `${name}_end`);
    const endExpr = LinearExpr.fromVar(endVar);

    // Link end = start + size
    this.add(startExpr.add(sizeExpr).eq(endExpr));

    const index = this._registry.getNextIndex();
    const v = new IntervalVarImpl(index, startExpr, sizeExpr, endExpr, name, isPresent);
    this._registry.registerIntervalVar(v);
    return v;
  }

  // ============================================================================
  // Constraint Addition
  // ============================================================================

  /**
   * Add a constraint from a bounded linear expression
   *
   * @param ct - The bounded linear expression
   * @returns The added constraint
   *
   * @example
   * ```typescript
   * model.add(x.add(y).le(10));
   * model.add(x.ge(5));
   * model.add(x.eq(y));
   * ```
   */
  add(ct: BoundedLinearExpression | NotEqualExpression | boolean): Constraint {
    if (typeof ct === 'boolean') {
      if (!ct) {
        // Adding false constraint - model will be infeasible
        return this.addLinearConstraint(
          new LinearExpr([], [], 0),
          1,
          0
        );
      }
      // Adding true constraint - no-op
      return this.addLinearConstraint(
        new LinearExpr([], [], 0),
        0,
        0
      );
    }

    if (ct instanceof NotEqualExpression) {
      return this.addNotEqual(ct.expr, ct.value);
    }

    return this.addLinearConstraint(ct.expr, ct.lb, ct.ub);
  }

  /**
   * Add a not-equal constraint: expr != value.
   * Reached via the `.ne()` operator, e.g. `model.add(x.ne(5))`.
   * Unlike a linear inequality, this prunes a single value from a domain.
   */
  addNotEqual(expr: LinearExpr, value: number): NotEqualConstraint {
    const index = this._constraints.length;
    const constraint = new NotEqualConstraint(index, expr, value);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add a linear constraint: lb <= expr <= ub
   *
   * @param expr - The linear expression
   * @param lb - Lower bound
   * @param ub - Upper bound
   * @returns The added constraint
   */
  addLinearConstraint(expr: LinearExpr, lb: number, ub: number): LinearConstraint {
    // Adjust bounds for offset: lb <= sum(vars[i] * coeffs[i]) + offset <= ub
    // becomes: lb - offset <= sum(vars[i] * coeffs[i]) <= ub - offset
    const adjustedLb = lb - expr.offset;
    const adjustedUb = ub - expr.offset;

    const index = this._constraints.length;
    const constraint = new LinearConstraint(index, expr.vars, expr.coeffs, new Domain([adjustedLb, adjustedUb]));
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add a linear expression in domain constraint
   *
   * @param expr - The linear expression
   * @param domain - The domain
   * @returns The added constraint
   */
  addLinearExpressionInDomain(expr: LinearExpr, domain: Domain): LinearConstraint {
    // Adjust domain for offset: domain contains allowed values for expr = sum(vars[i] * coeffs[i]) + offset
    // The constraint stores only the variable part, so we shift the domain by -offset
    const adjustedDomain = domain.isEmpty
      ? domain
      : new Domain(domain.intervals.map(([lb, ub]) => [lb - expr.offset, ub - expr.offset] as [number, number]));
    const index = this._constraints.length;
    const constraint = new LinearConstraint(index, expr.vars, expr.coeffs, adjustedDomain);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add an all-different constraint
   *
   * @param expressions - List of expressions that must all be different
   * @returns The added constraint
   *
   * @example
   * ```typescript
   * model.addAllDifferent([x, y, z]);
   * ```
   */
  addAllDifferent(expressions: LinearExprLike[]): AllDifferentConstraint {
    const exprs = expressions.map(e => LinearExpr.from(e));
    const index = this._constraints.length;
    const constraint = new AllDifferentConstraint(index, exprs);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add an element constraint: vars[index] == target
   *
   * @param index - Index variable
   * @param vars - Array of variables
   * @param target - Target variable
   * @returns The added constraint
   *
   * @example
   * ```typescript
   * model.addElement(indexVar, [a, b, c], targetVar);
   * ```
   */
  addElement(
    index: IntVarImpl,
    vars: IntVarImpl[],
    target: IntVarImpl
  ): ElementConstraint {
    const constraintIndex = this._constraints.length;
    const constraint = new ElementConstraint(constraintIndex, index, vars, target);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add a circuit constraint (Hamiltonian cycle)
   *
   * @param arcs - List of arcs as [tail, head, literal] triples
   * @returns The added constraint
   *
   * @example
   * ```typescript
   * model.addCircuit([
   *   [0, 1, x01],
   *   [1, 2, x12],
   *   [2, 0, x20],
   * ]);
   * ```
   */
  addCircuit(arcs: [number, number, BoolVarImpl][]): CircuitConstraint {
    const index = this._constraints.length;
    const constraint = new CircuitConstraint(index, arcs);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add a multiple circuit constraint (VRP-style routes)
   *
   * @param arcs - List of arcs as [tail, head, literal] triples
   * @returns The added constraint
   */
  addMultipleCircuit(arcs: [number, number, BoolVarImpl][]): MultipleCircuitConstraint {
    const index = this._constraints.length;
    const constraint = new MultipleCircuitConstraint(index, arcs);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add allowed assignments constraint (table constraint)
   *
   * @param vars - Variables
   * @param tuples - Allowed value tuples
   * @returns The added constraint
   *
   * @example
   * ```typescript
   * model.addAllowedAssignments([x, y], [[0, 1], [1, 0], [1, 1]]);
   * ```
   */
  addAllowedAssignments(
    vars: IntVarImpl[],
    tuples: number[][]
  ): AllowedAssignmentsConstraint {
    const index = this._constraints.length;
    const constraint = new AllowedAssignmentsConstraint(index, vars, tuples);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add forbidden assignments constraint
   *
   * @param vars - Variables
   * @param tuples - Forbidden value tuples
   * @returns The added constraint
   */
  addForbiddenAssignments(
    vars: IntVarImpl[],
    tuples: number[][]
  ): ForbiddenAssignmentsConstraint {
    const index = this._constraints.length;
    const constraint = new ForbiddenAssignmentsConstraint(index, vars, tuples);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add an automaton constraint
   *
   * @param transitionExpressions - Transition expressions
   * @param startingState - Starting state
   * @param finalStates - Final states
   * @param transitionTriples - Transition triples [tail, head, label]
   * @returns The added constraint
   */
  addAutomaton(
    transitionExpressions: IntVarImpl[],
    startingState: number,
    finalStates: number[],
    transitionTriples: [number, number, number][]
  ): AutomatonConstraint {
    const index = this._constraints.length;
    const constraint = new AutomatonConstraint(
      index,
      transitionExpressions,
      transitionExpressions,
      startingState,
      finalStates,
      transitionTriples.map(t => t[0]),
      transitionTriples.map(t => t[1]),
      transitionTriples.map(t => t[2])
    );
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add an inverse constraint
   *
   * @param fDirect - Direct permutation
   * @param fInverse - Inverse permutation
   * @returns The added constraint
   */
  addInverse(
    fDirect: IntVarImpl[],
    fInverse: IntVarImpl[]
  ): InverseConstraint {
    const index = this._constraints.length;
    const constraint = new InverseConstraint(index, fDirect, fInverse);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add a reservoir constraint
   *
   * @param times - Time expressions
   * @param levelChanges - Level change expressions
   * @param minLevel - Minimum level
   * @param maxLevel - Maximum level
   * @returns The added constraint
   */
  addReservoirConstraint(
    times: LinearExprLike[],
    levelChanges: LinearExprLike[],
    minLevel: number,
    maxLevel: number
  ): ReservoirConstraint {
    const index = this._constraints.length;
    const constraint = new ReservoirConstraint(
      index,
      times.map(t => LinearExpr.from(t)),
      levelChanges.map(l => LinearExpr.from(l)),
      [],
      minLevel,
      maxLevel
    );
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add a reservoir constraint with active literals
   *
   * @param times - Time expressions
   * @param levelChanges - Level change expressions
   * @param actives - Active literals
   * @param minLevel - Minimum level
   * @param maxLevel - Maximum level
   * @returns The added constraint
   */
  addReservoirConstraintWithActive(
    times: LinearExprLike[],
    levelChanges: LinearExprLike[],
    actives: BoolVarImpl[],
    minLevel: number,
    maxLevel: number
  ): ReservoirConstraint {
    const index = this._constraints.length;
    const constraint = new ReservoirConstraint(
      index,
      times.map(t => LinearExpr.from(t)),
      levelChanges.map(l => LinearExpr.from(l)),
      actives,
      minLevel,
      maxLevel
    );
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add a map domain constraint
   *
   * Maps an integer variable to a set of boolean variables:
   *   var_ == i + offset  <=>  boolVarArray[i] == true, for all i
   *
   * Decomposed into:
   * 1. ExactlyOne(boolVarArray) — exactly one boolean must be true
   * 2. var_ == sum((i + offset) * boolVarArray[i]) — var_ equals the selected value
   *
   * @param var_ - Integer variable
   * @param boolVarArray - Boolean variables
   * @param offset - Offset
   */
  addMapDomain(
    var_: IntVarImpl,
    boolVarArray: BoolVarImpl[],
    offset: number = 0
  ): MapDomainConstraint {
    // Constraint 1: Exactly one boolean must be true
    this.addExactlyOne(boolVarArray);

    // Constraint 2: var_ == sum((i + offset) * boolVarArray[i])
    // This ensures var_ equals the value corresponding to the true boolean
    const terms: LinearExpr[] = [];
    for (let i = 0; i < boolVarArray.length; i++) {
      terms.push(boolVarArray[i].mul(i + offset));
    }
    const sumExpr = terms.reduce((a, b) => a.add(b));
    this.add(var_.eq(sumExpr));

    const index = this._constraints.length;
    const constraint = new MapDomainConstraint(index, var_, boolVarArray, offset);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add an implication constraint: a => b
   *
   * @param a - Antecedent literal
   * @param b - Consequent literal
   * @returns The added constraint
   */
  addImplication(a: BoolVarImpl, b: BoolVarImpl): ImplicationConstraint {
    const index = this._constraints.length;
    const constraint = new ImplicationConstraint(index, a, b);
    this._constraints.push(constraint);
    return constraint;
  }

  // ============================================================================
  // Boolean Constraints
  // ============================================================================

  /**
   * Add a boolean OR constraint: at least one literal is true
   *
   * @param literals - Boolean variables
   * @returns The added constraint
   */
  addBoolOr(literals: BoolVarImpl[]): BoolOrConstraint {
    const index = this._constraints.length;
    const constraint = new BoolOrConstraint(index, literals);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add an at-least-one constraint (alias for addBoolOr)
   *
   * @param literals - Boolean variables
   * @returns The added constraint
   */
  addAtLeastOne(literals: BoolVarImpl[]): BoolOrConstraint {
    return this.addBoolOr(literals);
  }

  /**
   * Add an at-most-one constraint
   *
   * @param literals - Boolean variables
   * @returns The added constraint
   */
  addAtMostOne(literals: BoolVarImpl[]): AtMostOneConstraint {
    const index = this._constraints.length;
    const constraint = new AtMostOneConstraint(index, literals);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add an exactly-one constraint
   *
   * @param literals - Boolean variables
   * @returns The added constraint
   */
  addExactlyOne(literals: BoolVarImpl[]): ExactlyOneConstraint {
    const index = this._constraints.length;
    const constraint = new ExactlyOneConstraint(index, literals);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add a boolean AND constraint: all literals must be true
   *
   * @param literals - Boolean variables
   * @returns The added constraint
   */
  addBoolAnd(literals: BoolVarImpl[]): BoolAndConstraint {
    const index = this._constraints.length;
    const constraint = new BoolAndConstraint(index, literals);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add a boolean XOR constraint
   *
   * @param literals - Boolean variables
   * @returns The added constraint
   */
  addBoolXor(literals: BoolVarImpl[]): BoolXorConstraint {
    const index = this._constraints.length;
    const constraint = new BoolXorConstraint(index, literals);
    this._constraints.push(constraint);
    return constraint;
  }

  // ============================================================================
  // Arithmetic Constraints
  // ============================================================================

  /**
   * Add a min equality constraint: target == min(expressions)
   *
   * @param target - Target variable
   * @param expressions - Expressions
   * @returns The added constraint
   */
  addMinEquality(
    target: IntVarImpl,
    expressions: LinearExprLike[]
  ): MinEqualityConstraint {
    const index = this._constraints.length;
    const constraint = new MinEqualityConstraint(
      index,
      target,
      expressions.map(e => LinearExpr.from(e))
    );
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add a max equality constraint: target == max(expressions)
   *
   * @param target - Target variable
   * @param expressions - Expressions
   * @returns The added constraint
   *
   * @example
   * ```typescript
   * const makespan = model.newIntVar(0, 100, 'makespan');
   * model.addMaxEquality(makespan, [end1, end2, end3]);
   * ```
   */
  addMaxEquality(
    target: IntVarImpl,
    expressions: LinearExprLike[]
  ): MaxEqualityConstraint {
    const index = this._constraints.length;
    const constraint = new MaxEqualityConstraint(
      index,
      target,
      expressions.map(e => LinearExpr.from(e))
    );
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add a division equality constraint: target == num / denom
   *
   * @param target - Target variable
   * @param num - Numerator
   * @param denom - Denominator
   * @returns The added constraint
   */
  addDivisionEquality(
    target: IntVarImpl,
    num: LinearExprLike,
    denom: LinearExprLike
  ): DivisionEqualityConstraint {
    const index = this._constraints.length;
    const constraint = new DivisionEqualityConstraint(
      index,
      target,
      LinearExpr.from(num),
      LinearExpr.from(denom)
    );
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add an absolute value equality constraint: target == |expr|
   *
   * @param target - Target variable
   * @param expr - Expression
   * @returns The added constraint
   */
  addAbsEquality(
    target: IntVarImpl,
    expr: LinearExprLike
  ): AbsEqualityConstraint {
    const index = this._constraints.length;
    const constraint = new AbsEqualityConstraint(
      index,
      target,
      LinearExpr.from(expr)
    );
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add a modulo equality constraint: target == expr % mod
   *
   * @param target - Target variable
   * @param expr - Expression
   * @param mod - Modulus
   * @returns The added constraint
   */
  addModuloEquality(
    target: IntVarImpl,
    expr: LinearExprLike,
    mod: LinearExprLike
  ): ModuloEqualityConstraint {
    const index = this._constraints.length;
    const constraint = new ModuloEqualityConstraint(
      index,
      target,
      LinearExpr.from(expr),
      LinearExpr.from(mod)
    );
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add a multiplication equality constraint: target == product of expressions
   *
   * @param target - Target variable
   * @param expressions - Expressions to multiply
   * @returns The added constraint
   */
  addMultiplicationEquality(
    target: IntVarImpl,
    expressions: LinearExprLike[]
  ): MultiplicationEqualityConstraint {
    const index = this._constraints.length;
    const constraint = new MultiplicationEqualityConstraint(
      index,
      target,
      expressions.map(e => LinearExpr.from(e))
    );
    this._constraints.push(constraint);
    return constraint;
  }

  // ============================================================================
  // Scheduling Constraints
  // ============================================================================

  /**
   * Add a no-overlap constraint
   *
   * @param intervals - Interval variables
   * @returns The added constraint
   *
   * @example
   * ```typescript
   * model.addNoOverlap([task1, task2, task3]);
   * ```
   */
  addNoOverlap(intervals: IntervalVarImpl[]): NoOverlapConstraint {
    const index = this._constraints.length;
    const constraint = new NoOverlapConstraint(index, intervals);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add a 2D no-overlap constraint
   *
   * @param xIntervals - X-axis intervals
   * @param yIntervals - Y-axis intervals
   * @returns The added constraint
   */
  addNoOverlap2D(
    xIntervals: IntervalVarImpl[],
    yIntervals: IntervalVarImpl[]
  ): NoOverlap2DConstraint {
    const index = this._constraints.length;
    const constraint = new NoOverlap2DConstraint(index, xIntervals, yIntervals);
    this._constraints.push(constraint);
    return constraint;
  }

  /**
   * Add a cumulative constraint
   *
   * @param intervals - Interval variables
   * @param demands - Demand expressions
   * @param capacity - Capacity expression
   * @returns The added constraint
   *
   * @example
   * ```typescript
   * model.addCumulative([task1, task2], [2, 3], 5);
   * ```
   */
  addCumulative(
    intervals: IntervalVarImpl[],
    demands: LinearExprLike[],
    capacity: LinearExprLike
  ): CumulativeConstraint {
    const index = this._constraints.length;
    const constraint = new CumulativeConstraint(
      index,
      intervals,
      demands.map(d => LinearExpr.from(d)),
      LinearExpr.from(capacity)
    );
    this._constraints.push(constraint);
    return constraint;
  }

  // ============================================================================
  // Objective
  // ============================================================================

  /**
   * Set the objective to minimize
   *
   * @param obj - The objective expression
   *
   * @example
   * ```typescript
   * model.minimize(cost);
   * model.minimize(x.add(y.mul(2)));
   * ```
   */
  minimize(obj: LinearExprLike): void {
    this._objective = LinearExpr.from(obj);
    this._maximize = false;
  }

  /**
   * Set the objective to maximize
   *
   * @param obj - The objective expression
   *
   * @example
   * ```typescript
   * model.maximize(profit);
   * model.maximize(x.add(y.mul(2)));
   * ```
   */
  maximize(obj: LinearExprLike): void {
    this._objective = LinearExpr.from(obj);
    this._maximize = true;
  }

  /**
   * Clear the objective
   */
  clearObjective(): void {
    this._objective = null;
  }

  // ============================================================================
  // Hints
  // ============================================================================

  /**
   * Add a solution hint
   *
   * @param var_ - Variable
   * @param value - Hint value
   */
  addHint(var_: IntVarImpl | BoolVarImpl, value: number): void {
    this._hints.set(var_.index, value);
  }

  /**
   * Clear all hints
   */
  clearHints(): void {
    this._hints.clear();
  }

  // ============================================================================
  // Assumptions
  // ============================================================================

  /**
   * Add an assumption literal.
   *
   * @param lit - A BoolVar (force to true) or a negated literal number
   *   from `boolVar.negated` (force the underlying BoolVar to false).
   */
  addAssumption(lit: BoolVarImpl | number): void {
    this._assumptions.push(lit);
  }

  /**
   * Add multiple assumption literals
   *
   * @param literals - Boolean variables or negated literal numbers
   */
  addAssumptions(literals: (BoolVarImpl | number)[]): void {
    this._assumptions.push(...literals);
  }

  /**
   * Clear all assumptions
   */
  clearAssumptions(): void {
    this._assumptions = [];
  }

  /** All Boolean clauses added via `addClause` (signed-int literals). */
  get clauses(): number[][] {
    return this._clauses;
  }

  /**
   * Add a Boolean clause (disjunction): at least one literal must be true.
   *
   * Each literal is either a `BoolVar` (positive — "this var is true") or a
   * number from `boolVar.negated` (i.e. `-(index+1)` — "this var is false").
   * Literals must reference registered bool variables. Tautologies (containing
   * both a literal and its negation) are silently dropped; duplicate literals
   * are folded. An empty clause declares the model UNSAT (handled at solve time).
   *
   * Clauses are propagated by the dedicated 2-watched-literal clause engine
   * (`enableLcg`), not by the per-constraint loop.
   */
  addClause(literals: (BoolVarImpl | number)[]): void {
    const raw: number[] = [];
    for (const lit of literals) {
      raw.push(typeof lit === 'number' ? lit : lit.index);
    }
    // Validate every literal references a registered bool var.
    for (const l of raw) {
      const varIdx = l >= 0 ? l : -(l + 1);
      if (!this._registry.getBoolVar(varIdx)) {
        throw new Error(`addClause: literal ${l} does not refer to a registered bool variable (${varIdx})`);
      }
    }
    const norm = normalizeClause(raw);
    if (norm === null) return; // tautology — always satisfied, drop silently
    this._clauses.push(norm);
  }

  /** Add multiple Boolean clauses. */
  addClauses(list: (BoolVarImpl | number)[][]): void {
    for (const lits of list) this.addClause(lits);
  }

  /** Clear all clauses. */
  clearClauses(): void {
    this._clauses = [];
  }

  // ============================================================================
  // Decision Strategy
  // ============================================================================

  /**
   * Add a decision strategy
   *
   * @param variables - Variables to apply strategy to
   * @param varStrategy - Variable selection strategy
   * @param domainStrategy - Domain reduction strategy
   */
  addDecisionStrategy(
    variables: IntVarImpl[],
    varStrategy: VariableSelectionStrategy = VariableSelectionStrategy.CHOOSE_FIRST,
    domainStrategy: DomainReductionStrategy = DomainReductionStrategy.SELECT_MIN_VALUE
  ): void {
    this._decisionStrategies.push({
      variables,
      varStrategy,
      domainStrategy,
    });
  }

  // ============================================================================
  // Utility
  // ============================================================================

  /**
   * Clone the model
   *
   * @throws Error — not yet implemented
   */
  clone(): CpModel {
    throw new Error('Clone not yet implemented');
  }

  /**
   * Validate the model
   *
   * @returns Empty string if valid, error message otherwise
   */
  validate(): string {
    // Check for empty domains
    for (const v of this._registry.allIntVars) {
      if (v.domain.isEmpty) {
        return `Variable ${v.name} has empty domain`;
      }
    }

    // Check constraints reference valid variables
    // (simplified validation)
    return '';
  }

  /**
   * Get model statistics as a string
   *
   * @returns Human-readable model statistics
   */
  modelStats(): string {
    const intVars = this._registry.allIntVars.length;
    const boolVars = this._registry.allBoolVars.length;
    const intervals = this._registry.allIntervalVars.length;
    const constraints = this._constraints.length;

    return [
      `Model: ${this._name || '(unnamed)'}`,
      `Variables: ${intVars} int, ${boolVars} bool, ${intervals} interval`,
      `Constraints: ${constraints}`,
      `Objective: ${this._objective ? (this._maximize ? 'maximize' : 'minimize') : 'none'}`,
    ].join('\n');
  }

  // ============================================================================
  // JSON Serialization
  // ============================================================================

  /**
   * Serialize the model to a JSON-serializable object.
   * Variable references are stored as numeric indices.
   */
  toJSON(): ModelJSON {
    const toExprData = (expr: LinearExpr): LinearExpressionData => ({
      vars: expr.vars.map(v => v.index),
      coeffs: [...expr.coeffs],
      offset: expr.offset,
    });

    const toIntervalData = (iv: IntervalVarImpl): IntervalVarData => ({
      index: iv.index,
      name: iv.name,
      start: toExprData(iv.start),
      size: toExprData(iv.size),
      end: toExprData(iv.end),
      isPresent: iv.isPresent ? iv.isPresent.index : undefined,
    });

    const varIdx = (v: { index: number }) => v.index;

    // Serialize variables
    const variables: VariableData[] = [];
    for (const v of this._registry.allIntVars) {
      variables.push({ index: v.index, name: v.name, type: 'int', domain: v.domain.intervals.map(([a, b]) => [a, b]) });
    }
    for (const v of this._registry.allBoolVars) {
      variables.push({ index: v.index, name: v.name, type: 'bool', domain: [[0, 1]] });
    }

    const intervalVariables: IntervalVarData[] = [];
    for (const iv of this._registry.allIntervalVars) {
      intervalVariables.push(toIntervalData(iv));
    }

    // Serialize constraints
    const constraints: ConstraintData[] = [];
    for (const ct of this._constraints) {
      const base: ConstraintData = { type: ct.type, index: ct.index, name: ct.name || undefined };

      switch (ct.type) {
        case 'LINEAR': {
          const c = ct as LinearConstraint;
          base.vars = c.vars.map(varIdx);
          base.coeffs = [...c.coeffs];
          base.domain = c.domain.intervals.map(([a, b]) => [a, b]);
          break;
        }
        case 'NOT_EQUAL': {
          const c = ct as NotEqualConstraint;
          base.expr = toExprData(c.expr);
          base.value = c.value;
          break;
        }
        case 'ALL_DIFFERENT': {
          const c = ct as AllDifferentConstraint;
          base.expressions = c.expressions.map(toExprData);
          break;
        }
        case 'ELEMENT': {
          const c = ct as ElementConstraint;
          base.indexVar = c.indexVar.index;
          base.vars = c.vars.map(varIdx);
          base.target = c.target.index;
          break;
        }
        case 'CIRCUIT':
        case 'MULTIPLE_CIRCUIT': {
          const c = ct as CircuitConstraint;
          base.arcs = c.arcs.map(([t, h, l]) => [t, h, l.index]);
          break;
        }
        case 'ALLOWED_ASSIGNMENTS':
        case 'FORBIDDEN_ASSIGNMENTS': {
          const c = ct as AllowedAssignmentsConstraint;
          base.vars = c.vars.map(varIdx);
          base.tuples = c.tuples.map(t => [...t]);
          break;
        }
        case 'AUTOMATON': {
          const c = ct as AutomatonConstraint;
          base.vars = c.vars.map(varIdx);
          base.transitionVars = c.transitionVars.map(varIdx);
          base.startingState = c.startingState;
          base.finalStates = [...c.finalStates];
          base.transitionTail = [...c.transitionTail];
          base.transitionHead = [...c.transitionHead];
          base.transitionLabel = [...c.transitionLabel];
          break;
        }
        case 'INVERSE': {
          const c = ct as InverseConstraint;
          base.fDirect = c.fDirect.map(varIdx);
          base.fInverse = c.fInverse.map(varIdx);
          break;
        }
        case 'RESERVOIR': {
          const c = ct as ReservoirConstraint;
          base.times = c.times.map(toExprData);
          base.levelChanges = c.levelChanges.map(toExprData);
          base.activeLiterals = c.activeLiterals.map(varIdx);
          base.minLevel = c.minLevel;
          base.maxLevel = c.maxLevel;
          break;
        }
        case 'BOOL_OR':
        case 'BOOL_AND':
        case 'AT_MOST_ONE':
        case 'EXACTLY_ONE':
        case 'BOOL_XOR': {
          const c = ct as BoolOrConstraint;
          base.literals = c.literals.map(varIdx);
          break;
        }
        case 'IMPLICATION': {
          const c = ct as ImplicationConstraint;
          base.a = c.a.index;
          base.b = c.b.index;
          break;
        }
        case 'MIN_EQUALITY':
        case 'MAX_EQUALITY': {
          const c = ct as MinEqualityConstraint;
          base.target = c.target.index;
          base.expressions = c.expressions.map(toExprData);
          break;
        }
        case 'DIVISION_EQUALITY': {
          const c = ct as DivisionEqualityConstraint;
          base.target = c.target.index;
          base.num = toExprData(c.num);
          base.denom = toExprData(c.denom);
          break;
        }
        case 'ABS_EQUALITY': {
          const c = ct as AbsEqualityConstraint;
          base.target = c.target.index;
          base.expr = toExprData(c.expr);
          break;
        }
        case 'MODULO_EQUALITY': {
          const c = ct as ModuloEqualityConstraint;
          base.target = c.target.index;
          base.expr = toExprData(c.expr);
          base.mod = toExprData(c.mod);
          break;
        }
        case 'MULTIPLICATION_EQUALITY': {
          const c = ct as MultiplicationEqualityConstraint;
          base.target = c.target.index;
          base.expressions = c.expressions.map(toExprData);
          break;
        }
        case 'NO_OVERLAP': {
          const c = ct as NoOverlapConstraint;
          base.intervals = c.intervals.map(iv => toIntervalData(iv as IntervalVarImpl));
          break;
        }
        case 'NO_OVERLAP_2D': {
          const c = ct as NoOverlap2DConstraint;
          base.xIntervals = c.xIntervals.map(iv => toIntervalData(iv as IntervalVarImpl));
          base.yIntervals = c.yIntervals.map(iv => toIntervalData(iv as IntervalVarImpl));
          break;
        }
        case 'CUMULATIVE': {
          const c = ct as CumulativeConstraint;
          base.intervals = c.intervals.map(iv => toIntervalData(iv as IntervalVarImpl));
          base.demands = c.demands.map(toExprData);
          base.capacity = toExprData(c.capacity);
          break;
        }
        case 'MAP_DOMAIN': {
          const c = ct as MapDomainConstraint;
          base.target = c.var_.index;
          base.boolVars = c.boolVars.map(varIdx);
          base.offset = c.offset;
          break;
        }
      }
      constraints.push(base);
    }

    // Serialize objective
    let objective: ModelJSON['objective'] = null;
    if (this._objective) {
      objective = { expr: toExprData(this._objective), maximize: this._maximize };
    }

    // Serialize hints
    const hints: Record<number, number> = {};
    for (const [k, v] of this._hints) {
      hints[k] = v;
    }

    // Serialize assumptions (BoolVar → index; a negated literal is already a number)
    const assumptions = this._assumptions.map(a => (typeof a === 'number' ? a : a.index));

    // Serialize clauses (already signed-int literals)
    const clauses = this._clauses.map(c => [...c]);

    // Serialize decision strategies
    const decisionStrategies: DecisionStrategyData[] = this._decisionStrategies.map(ds => ({
      variables: ds.variables.map(varIdx),
      varStrategy: ds.varStrategy,
      domainStrategy: ds.domainStrategy,
    }));

    return { name: this._name, variables, intervalVariables, constraints, objective, hints, assumptions, clauses, decisionStrategies };
  }

  /**
   * Reconstruct a model from a JSON object produced by toJSON().
   */
  static fromJSON(json: ModelJSON): CpModel {
    const model = new CpModel(json.name);

    // Reconstruct variables — must register with the correct indices
    for (const v of json.variables) {
      if (v.type === 'bool') {
        const bv = new BoolVarImpl(v.index, v.name);
        model._registry.registerBoolVar(bv);
      } else {
        const iv = new IntVarImpl(v.index, new Domain(v.domain as [number, number][]), v.name);
        model._registry.registerIntVar(iv);
      }
    }
    // Advance the registry's index counter past all variable indices
    const maxVarIdx = json.variables.reduce((m, v) => Math.max(m, v.index), -1);
    while (model._registry.getNextIndex() <= maxVarIdx) { /* pad */ }

    // Reconstruct interval variables
    const intervalVarMap = new Map<number, IntervalVarImpl>();
    for (const iv of json.intervalVariables) {
      const startExpr = CpModel._exprFromData(iv.start, model._registry);
      const sizeExpr = CpModel._exprFromData(iv.size, model._registry);
      const endExpr = CpModel._exprFromData(iv.end, model._registry);
      const isPresent = iv.isPresent !== undefined ? model._registry.getBoolVar(iv.isPresent) : undefined;
      const intervalVar = new IntervalVarImpl(iv.index, startExpr, sizeExpr, endExpr, iv.name, isPresent);
      model._registry.registerIntervalVar(intervalVar);
      intervalVarMap.set(iv.index, intervalVar);
    }
    // Advance index counter past interval variable indices
    const maxIvIdx = json.intervalVariables.reduce((m, v) => Math.max(m, v.index), maxVarIdx);
    while (model._registry.getNextIndex() <= maxIvIdx) { /* pad */ }

    // Helper: look up variable by index (returns IntVarImpl for int vars, BoolVarImpl for bool vars)
    const getVar = (idx: number): IntVarImpl => {
      const v = model._registry.getIntVar(idx) || model._registry.getBoolVar(idx);
      if (!v) throw new Error(`Variable index ${idx} not found during deserialization`);
      return v as IntVarImpl;
    };
    const getBoolVar = (idx: number): BoolVarImpl => {
      const v = model._registry.getBoolVar(idx);
      if (!v) throw new Error(`BoolVar index ${idx} not found during deserialization`);
      return v;
    };

    // Reconstruct constraints
    /* eslint-disable @typescript-eslint/no-non-null-assertion */
    for (const cd of json.constraints) {
      switch (cd.type) {
        case 'LINEAR': {
          const vars = cd.vars!.map(getVar);
          model._constraints.push(new LinearConstraint(cd.index, vars, cd.coeffs!, new Domain(cd.domain as [number, number][]), cd.name));
          break;
        }
        case 'NOT_EQUAL': {
          model._constraints.push(new NotEqualConstraint(cd.index, CpModel._exprFromData(cd.expr!, model._registry), cd.value!, cd.name));
          break;
        }
        case 'ALL_DIFFERENT': {
          model._constraints.push(new AllDifferentConstraint(cd.index, cd.expressions!.map(e => CpModel._exprFromData(e, model._registry)), cd.name));
          break;
        }
        case 'ELEMENT': {
          model._constraints.push(new ElementConstraint(cd.index, getVar(cd.indexVar!), cd.vars!.map(getVar), getVar(cd.target!), cd.name));
          break;
        }
        case 'CIRCUIT': {
          const arcs: [number, number, BoolVarImpl][] = cd.arcs!.map(([t, h, l]) => [t, h, getBoolVar(l)]);
          model._constraints.push(new CircuitConstraint(cd.index, arcs, cd.name));
          break;
        }
        case 'MULTIPLE_CIRCUIT': {
          const arcs: [number, number, BoolVarImpl][] = cd.arcs!.map(([t, h, l]) => [t, h, getBoolVar(l)]);
          model._constraints.push(new MultipleCircuitConstraint(cd.index, arcs, cd.name));
          break;
        }
        case 'ALLOWED_ASSIGNMENTS': {
          model._constraints.push(new AllowedAssignmentsConstraint(cd.index, cd.vars!.map(getVar), cd.tuples!, cd.name));
          break;
        }
        case 'FORBIDDEN_ASSIGNMENTS': {
          model._constraints.push(new ForbiddenAssignmentsConstraint(cd.index, cd.vars!.map(getVar), cd.tuples!, cd.name));
          break;
        }
        case 'AUTOMATON': {
          model._constraints.push(new AutomatonConstraint(
            cd.index, cd.vars!.map(getVar), cd.transitionVars!.map(getVar),
            cd.startingState!, cd.finalStates!, cd.transitionTail!, cd.transitionHead!, cd.transitionLabel!, cd.name
          ));
          break;
        }
        case 'INVERSE': {
          model._constraints.push(new InverseConstraint(cd.index, cd.fDirect!.map(getVar), cd.fInverse!.map(getVar), cd.name));
          break;
        }
        case 'RESERVOIR': {
          model._constraints.push(new ReservoirConstraint(
            cd.index,
            cd.times!.map(e => CpModel._exprFromData(e, model._registry)),
            cd.levelChanges!.map(e => CpModel._exprFromData(e, model._registry)),
            cd.activeLiterals!.map(i => getBoolVar(i)),
            cd.minLevel!, cd.maxLevel!, cd.name
          ));
          break;
        }
        case 'BOOL_OR': {
          model._constraints.push(new BoolOrConstraint(cd.index, cd.literals!.map(i => getBoolVar(i)), cd.name));
          break;
        }
        case 'BOOL_AND': {
          model._constraints.push(new BoolAndConstraint(cd.index, cd.literals!.map(i => getBoolVar(i)), cd.name));
          break;
        }
        case 'AT_MOST_ONE': {
          model._constraints.push(new AtMostOneConstraint(cd.index, cd.literals!.map(i => getBoolVar(i)), cd.name));
          break;
        }
        case 'EXACTLY_ONE': {
          model._constraints.push(new ExactlyOneConstraint(cd.index, cd.literals!.map(i => getBoolVar(i)), cd.name));
          break;
        }
        case 'BOOL_XOR': {
          model._constraints.push(new BoolXorConstraint(cd.index, cd.literals!.map(i => getBoolVar(i)), cd.name));
          break;
        }
        case 'IMPLICATION': {
          model._constraints.push(new ImplicationConstraint(cd.index, getBoolVar(cd.a!), getBoolVar(cd.b!), cd.name));
          break;
        }
        case 'MIN_EQUALITY': {
          model._constraints.push(new MinEqualityConstraint(cd.index, getVar(cd.target!), cd.expressions!.map(e => CpModel._exprFromData(e, model._registry)), cd.name));
          break;
        }
        case 'MAX_EQUALITY': {
          model._constraints.push(new MaxEqualityConstraint(cd.index, getVar(cd.target!), cd.expressions!.map(e => CpModel._exprFromData(e, model._registry)), cd.name));
          break;
        }
        case 'DIVISION_EQUALITY': {
          model._constraints.push(new DivisionEqualityConstraint(
            cd.index, getVar(cd.target!),
            CpModel._exprFromData(cd.num!, model._registry),
            CpModel._exprFromData(cd.denom!, model._registry), cd.name
          ));
          break;
        }
        case 'ABS_EQUALITY': {
          model._constraints.push(new AbsEqualityConstraint(cd.index, getVar(cd.target!), CpModel._exprFromData(cd.expr!, model._registry), cd.name));
          break;
        }
        case 'MODULO_EQUALITY': {
          model._constraints.push(new ModuloEqualityConstraint(
            cd.index, getVar(cd.target!),
            CpModel._exprFromData(cd.expr!, model._registry),
            CpModel._exprFromData(cd.mod!, model._registry), cd.name
          ));
          break;
        }
        case 'MULTIPLICATION_EQUALITY': {
          model._constraints.push(new MultiplicationEqualityConstraint(cd.index, getVar(cd.target!), cd.expressions!.map(e => CpModel._exprFromData(e, model._registry)), cd.name));
          break;
        }
        case 'NO_OVERLAP': {
          const intervals = cd.intervals!.map(iv => intervalVarMap.get(iv.index)!);
          model._constraints.push(new NoOverlapConstraint(cd.index, intervals, cd.name));
          break;
        }
        case 'NO_OVERLAP_2D': {
          const xIv = cd.xIntervals!.map(iv => intervalVarMap.get(iv.index)!);
          const yIv = cd.yIntervals!.map(iv => intervalVarMap.get(iv.index)!);
          model._constraints.push(new NoOverlap2DConstraint(cd.index, xIv, yIv, cd.name));
          break;
        }
        case 'CUMULATIVE': {
          const intervals = cd.intervals!.map(iv => intervalVarMap.get(iv.index)!);
          const demands = cd.demands!.map(e => CpModel._exprFromData(e, model._registry));
          const capacity = CpModel._exprFromData(cd.capacity!, model._registry);
          model._constraints.push(new CumulativeConstraint(cd.index, intervals, demands, capacity, cd.name));
          break;
        }
        case 'MAP_DOMAIN': {
          model._constraints.push(new MapDomainConstraint(cd.index, getVar(cd.target!), cd.boolVars!.map(i => getBoolVar(i)), cd.offset!, cd.name));
          break;
        }
      }
    }

    /* eslint-enable @typescript-eslint/no-non-null-assertion */
    // Reconstruct objective
    if (json.objective) {
      model._objective = CpModel._exprFromData(json.objective.expr, model._registry);
      model._maximize = json.objective.maximize;
    }

    // Reconstruct hints
    for (const [k, v] of Object.entries(json.hints)) {
      model._hints.set(Number(k), v);
    }

    // Reconstruct assumptions
    model._assumptions = json.assumptions.map(i => getBoolVar(i));

    // Reconstruct clauses
    model._clauses = (json.clauses ?? []).map((c: number[]) => [...c]);

    // Reconstruct decision strategies
    for (const ds of json.decisionStrategies) {
      model._decisionStrategies.push({
        variables: ds.variables.map(getVar),
        varStrategy: ds.varStrategy as VariableSelectionStrategy,
        domainStrategy: ds.domainStrategy as DomainReductionStrategy,
      });
    }

    return model;
  }

  /** Reconstruct a LinearExpr from serialized data */
  private static _exprFromData(data: LinearExpressionData, registry: VariableRegistry): LinearExpr {
    const vars = data.vars.map(idx => {
      const v = registry.getIntVar(idx) || registry.getBoolVar(idx);
      if (!v) throw new Error(`Variable index ${idx} not found during deserialization`);
      return v;
    });
    return new LinearExpr(vars, [...data.coeffs], data.offset);
  }

  /**
   * String representation
   */
  toString(): string {
    return this.modelStats();
  }
}
