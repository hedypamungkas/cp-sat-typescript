/**
 * CP-SAT TypeScript Implementation
 * Constraint definitions for the constraint programming solver
 */

import { LinearExpr, IntVar, BoolVar, IntervalVar, Domain } from './types';

// ============================================================================
// Constraint Types
// ============================================================================

export enum ConstraintType {
  LINEAR = 'LINEAR',
  ALL_DIFFERENT = 'ALL_DIFFERENT',
  ELEMENT = 'ELEMENT',
  CIRCUIT = 'CIRCUIT',
  MULTIPLE_CIRCUIT = 'MULTIPLE_CIRCUIT',
  ALLOWED_ASSIGNMENTS = 'ALLOWED_ASSIGNMENTS',
  FORBIDDEN_ASSIGNMENTS = 'FORBIDDEN_ASSIGNMENTS',
  AUTOMATON = 'AUTOMATON',
  INVERSE = 'INVERSE',
  RESERVOIR = 'RESERVOIR',
  IMPLICATION = 'IMPLICATION',
  BOOL_OR = 'BOOL_OR',
  BOOL_AND = 'BOOL_AND',
  AT_MOST_ONE = 'AT_MOST_ONE',
  EXACTLY_ONE = 'EXACTLY_ONE',
  BOOL_XOR = 'BOOL_XOR',
  MIN_EQUALITY = 'MIN_EQUALITY',
  MAX_EQUALITY = 'MAX_EQUALITY',
  DIVISION_EQUALITY = 'DIVISION_EQUALITY',
  ABS_EQUALITY = 'ABS_EQUALITY',
  MODULO_EQUALITY = 'MODULO_EQUALITY',
  MULTIPLICATION_EQUALITY = 'MULTIPLICATION_EQUALITY',
  NO_OVERLAP = 'NO_OVERLAP',
  NO_OVERLAP_2D = 'NO_OVERLAP_2D',
  CUMULATIVE = 'CUMULATIVE',
  MAP_DOMAIN = 'MAP_DOMAIN',
}

// ============================================================================
// Constraint Base Class
// ============================================================================

/**
 * Base class for all constraints
 */
export abstract class Constraint {
  readonly type: ConstraintType;
  readonly index: number;
  protected _name: string;

  constructor(type: ConstraintType, index: number, name: string = '') {
    this.type = type;
    this.index = index;
    this._name = name;
  }

  get name(): string {
    return this._name;
  }

  /**
   * String representation
   */
  abstract toString(): string;
}

// ============================================================================
// Linear Constraint
// ============================================================================

/**
 * Linear constraint: lb <= sum(vars[i] * coeffs[i]) <= ub
 */
export class LinearConstraint extends Constraint {
  readonly vars: IntVar[];
  readonly coeffs: number[];
  readonly domain: Domain;

  constructor(
    index: number,
    vars: IntVar[],
    coeffs: number[],
    domain: Domain,
    name: string = ''
  ) {
    super(ConstraintType.LINEAR, index, name);
    if (vars.length !== coeffs.length) {
      throw new Error(
        `LinearConstraint: vars length (${vars.length}) must equal coeffs length (${coeffs.length})`
      );
    }
    if (domain.isEmpty) {
      throw new Error('LinearConstraint: domain must not be empty');
    }
    this.vars = vars;
    this.coeffs = coeffs;
    this.domain = domain;
  }

  toString(): string {
    const parts: string[] = [];
    for (let i = 0; i < this.vars.length; i++) {
      const c = this.coeffs[i];
      const v = this.vars[i];
      if (c === 0) continue;
      if (c === 1) parts.push(v.name);
      else if (c === -1) parts.push(`-${v.name}`);
      else parts.push(`${c}*${v.name}`);
    }
    const expr = parts.join(' + ').replace(/\+ -/g, '- ') || '0';
    return `LinearConstraint(${this.domain} <= ${expr})`;
  }
}

// ============================================================================
// AllDifferent Constraint
// ============================================================================

/**
 * AllDifferent constraint: all variables must have different values
 */
export class AllDifferentConstraint extends Constraint {
  readonly expressions: LinearExpr[];

  constructor(index: number, expressions: LinearExpr[], name: string = '') {
    super(ConstraintType.ALL_DIFFERENT, index, name);
    if (expressions.length === 0) {
      throw new Error('AllDifferentConstraint: expressions must not be empty');
    }
    this.expressions = expressions;
  }

  toString(): string {
    return `AllDifferent(${this.expressions.join(', ')})`;
  }
}

// ============================================================================
// Element Constraint
// ============================================================================

/**
 * Element constraint: vars[index] == target
 */
export class ElementConstraint extends Constraint {
  readonly indexVar: IntVar;
  readonly vars: IntVar[];
  readonly target: IntVar;

  constructor(
    index: number,
    indexVar: IntVar,
    vars: IntVar[],
    target: IntVar,
    name: string = ''
  ) {
    super(ConstraintType.ELEMENT, index, name);
    if (vars.length === 0) {
      throw new Error('ElementConstraint: vars must not be empty');
    }
    this.indexVar = indexVar;
    this.vars = vars;
    this.target = target;
  }

  toString(): string {
    return `Element(${this.vars.join(', ')}[${this.indexVar}] == ${this.target})`;
  }
}

// ============================================================================
// Circuit Constraint
// ============================================================================

/**
 * Circuit constraint: forms a Hamiltonian cycle
 */
export class CircuitConstraint extends Constraint {
  readonly arcs: [number, number, BoolVar][];

  constructor(index: number, arcs: [number, number, BoolVar][], name: string = '') {
    super(ConstraintType.CIRCUIT, index, name);
    this.arcs = arcs;
  }

  toString(): string {
    return `Circuit(${this.arcs.length} arcs)`;
  }
}

// ============================================================================
// AllowedAssignments Constraint (Table)
// ============================================================================

/**
 * Allowed assignments constraint: variables must take one of the specified tuples
 */
export class AllowedAssignmentsConstraint extends Constraint {
  readonly vars: IntVar[];
  readonly tuples: number[][];

  constructor(
    index: number,
    vars: IntVar[],
    tuples: number[][],
    name: string = ''
  ) {
    super(ConstraintType.ALLOWED_ASSIGNMENTS, index, name);
    this.vars = vars;
    this.tuples = tuples;
  }

  toString(): string {
    return `AllowedAssignments(${this.vars.length} vars, ${this.tuples.length} tuples)`;
  }
}

// ============================================================================
// ForbiddenAssignments Constraint
// ============================================================================

/**
 * Forbidden assignments constraint: variables must NOT take any of the specified tuples
 */
export class ForbiddenAssignmentsConstraint extends Constraint {
  readonly vars: IntVar[];
  readonly tuples: number[][];

  constructor(
    index: number,
    vars: IntVar[],
    tuples: number[][],
    name: string = ''
  ) {
    super(ConstraintType.FORBIDDEN_ASSIGNMENTS, index, name);
    this.vars = vars;
    this.tuples = tuples;
  }

  toString(): string {
    return `ForbiddenAssignments(${this.vars.length} vars, ${this.tuples.length} tuples)`;
  }
}

// ============================================================================
// Automaton Constraint
// ============================================================================

/**
 * Automaton constraint: variables form a word accepted by a finite automaton
 */
export class AutomatonConstraint extends Constraint {
  readonly vars: IntVar[];
  readonly transitionVars: IntVar[];
  readonly startingState: number;
  readonly finalStates: number[];
  readonly transitionTail: number[];
  readonly transitionHead: number[];
  readonly transitionLabel: number[];

  constructor(
    index: number,
    vars: IntVar[],
    transitionVars: IntVar[],
    startingState: number,
    finalStates: number[],
    transitionTail: number[],
    transitionHead: number[],
    transitionLabel: number[],
    name: string = ''
  ) {
    super(ConstraintType.AUTOMATON, index, name);
    this.vars = vars;
    this.transitionVars = transitionVars;
    this.startingState = startingState;
    this.finalStates = finalStates;
    this.transitionTail = transitionTail;
    this.transitionHead = transitionHead;
    this.transitionLabel = transitionLabel;
  }

  toString(): string {
    return `Automaton(${this.vars.length} vars, ${this.transitionTail.length} transitions)`;
  }
}

// ============================================================================
// Inverse Constraint
// ============================================================================

/**
 * Inverse constraint: f_direct[i] = j iff f_inverse[j] = i
 */
export class InverseConstraint extends Constraint {
  readonly fDirect: IntVar[];
  readonly fInverse: IntVar[];

  constructor(
    index: number,
    fDirect: IntVar[],
    fInverse: IntVar[],
    name: string = ''
  ) {
    super(ConstraintType.INVERSE, index, name);
    this.fDirect = fDirect;
    this.fInverse = fInverse;
  }

  toString(): string {
    return `Inverse(${this.fDirect.length} vars)`;
  }
}

// ============================================================================
// Reservoir Constraint
// ============================================================================

/**
 * Reservoir constraint: maintains a reservoir level over time
 */
export class ReservoirConstraint extends Constraint {
  readonly times: LinearExpr[];
  readonly levelChanges: LinearExpr[];
  readonly activeLiterals: BoolVar[];
  readonly minLevel: number;
  readonly maxLevel: number;

  constructor(
    index: number,
    times: LinearExpr[],
    levelChanges: LinearExpr[],
    activeLiterals: BoolVar[],
    minLevel: number,
    maxLevel: number,
    name: string = ''
  ) {
    super(ConstraintType.RESERVOIR, index, name);
    this.times = times;
    this.levelChanges = levelChanges;
    this.activeLiterals = activeLiterals;
    this.minLevel = minLevel;
    this.maxLevel = maxLevel;
  }

  toString(): string {
    return `Reservoir(min=${this.minLevel}, max=${this.maxLevel})`;
  }
}

// ============================================================================
// Boolean Constraints
// ============================================================================

/**
 * Boolean OR constraint: at least one literal is true
 */
export class BoolOrConstraint extends Constraint {
  readonly literals: BoolVar[];

  constructor(index: number, literals: BoolVar[], name: string = '') {
    super(ConstraintType.BOOL_OR, index, name);
    if (literals.length === 0) {
      throw new Error('BoolOrConstraint: literals must not be empty');
    }
    this.literals = literals;
  }

  toString(): string {
    return `BoolOr(${this.literals.join(' | ')})`;
  }
}

/**
 * Boolean AND constraint: all literals must be true
 */
export class BoolAndConstraint extends Constraint {
  readonly literals: BoolVar[];

  constructor(index: number, literals: BoolVar[], name: string = '') {
    super(ConstraintType.BOOL_AND, index, name);
    if (literals.length === 0) {
      throw new Error('BoolAndConstraint: literals must not be empty');
    }
    this.literals = literals;
  }

  toString(): string {
    return `BoolAnd(${this.literals.join(' & ')})`;
  }
}

/**
 * At Most One constraint: at most one literal is true
 */
export class AtMostOneConstraint extends Constraint {
  readonly literals: BoolVar[];

  constructor(index: number, literals: BoolVar[], name: string = '') {
    super(ConstraintType.AT_MOST_ONE, index, name);
    if (literals.length === 0) {
      throw new Error('AtMostOneConstraint: literals must not be empty');
    }
    this.literals = literals;
  }

  toString(): string {
    return `AtMostOne(${this.literals.join(', ')})`;
  }
}

/**
 * Exactly One constraint: exactly one literal is true
 */
export class ExactlyOneConstraint extends Constraint {
  readonly literals: BoolVar[];

  constructor(index: number, literals: BoolVar[], name: string = '') {
    super(ConstraintType.EXACTLY_ONE, index, name);
    if (literals.length === 0) {
      throw new Error('ExactlyOneConstraint: literals must not be empty');
    }
    this.literals = literals;
  }

  toString(): string {
    return `ExactlyOne(${this.literals.join(', ')})`;
  }
}

/**
 * Boolean XOR constraint: odd number of literals are true
 */
export class BoolXorConstraint extends Constraint {
  readonly literals: BoolVar[];

  constructor(index: number, literals: BoolVar[], name: string = '') {
    super(ConstraintType.BOOL_XOR, index, name);
    this.literals = literals;
  }

  toString(): string {
    return `BoolXor(${this.literals.join(' ^ ')})`;
  }
}

// ============================================================================
// Implication Constraint
// ============================================================================

/**
 * Implication constraint: a => b
 */
export class ImplicationConstraint extends Constraint {
  readonly a: BoolVar;
  readonly b: BoolVar;

  constructor(index: number, a: BoolVar, b: BoolVar, name: string = '') {
    super(ConstraintType.IMPLICATION, index, name);
    this.a = a;
    this.b = b;
  }

  toString(): string {
    return `Implication(${this.a} => ${this.b})`;
  }
}

// ============================================================================
// Arithmetic Constraints
// ============================================================================

/**
 * Min equality: target == min(expressions)
 */
export class MinEqualityConstraint extends Constraint {
  readonly target: IntVar;
  readonly expressions: LinearExpr[];

  constructor(
    index: number,
    target: IntVar,
    expressions: LinearExpr[],
    name: string = ''
  ) {
    super(ConstraintType.MIN_EQUALITY, index, name);
    this.target = target;
    this.expressions = expressions;
  }

  toString(): string {
    return `MinEquality(${this.target} == min(${this.expressions.join(', ')}))`;
  }
}

/**
 * Max equality: target == max(expressions)
 */
export class MaxEqualityConstraint extends Constraint {
  readonly target: IntVar;
  readonly expressions: LinearExpr[];

  constructor(
    index: number,
    target: IntVar,
    expressions: LinearExpr[],
    name: string = ''
  ) {
    super(ConstraintType.MAX_EQUALITY, index, name);
    this.target = target;
    this.expressions = expressions;
  }

  toString(): string {
    return `MaxEquality(${this.target} == max(${this.expressions.join(', ')}))`;
  }
}

/**
 * Division equality: target == num / denom
 */
export class DivisionEqualityConstraint extends Constraint {
  readonly target: IntVar;
  readonly num: LinearExpr;
  readonly denom: LinearExpr;

  constructor(
    index: number,
    target: IntVar,
    num: LinearExpr,
    denom: LinearExpr,
    name: string = ''
  ) {
    super(ConstraintType.DIVISION_EQUALITY, index, name);
    this.target = target;
    this.num = num;
    this.denom = denom;
  }

  toString(): string {
    return `DivisionEquality(${this.target} == ${this.num} / ${this.denom})`;
  }
}

/**
 * Absolute value equality: target == |expr|
 */
export class AbsEqualityConstraint extends Constraint {
  readonly target: IntVar;
  readonly expr: LinearExpr;

  constructor(
    index: number,
    target: IntVar,
    expr: LinearExpr,
    name: string = ''
  ) {
    super(ConstraintType.ABS_EQUALITY, index, name);
    this.target = target;
    this.expr = expr;
  }

  toString(): string {
    return `AbsEquality(${this.target} == |${this.expr}|)`;
  }
}

/**
 * Modulo equality: target == expr % mod
 */
export class ModuloEqualityConstraint extends Constraint {
  readonly target: IntVar;
  readonly expr: LinearExpr;
  readonly mod: LinearExpr;

  constructor(
    index: number,
    target: IntVar,
    expr: LinearExpr,
    mod: LinearExpr,
    name: string = ''
  ) {
    super(ConstraintType.MODULO_EQUALITY, index, name);
    this.target = target;
    this.expr = expr;
    this.mod = mod;
  }

  toString(): string {
    return `ModuloEquality(${this.target} == ${this.expr} % ${this.mod})`;
  }
}

/**
 * Multiplication equality: target == product of expressions
 */
export class MultiplicationEqualityConstraint extends Constraint {
  readonly target: IntVar;
  readonly expressions: LinearExpr[];

  constructor(
    index: number,
    target: IntVar,
    expressions: LinearExpr[],
    name: string = ''
  ) {
    super(ConstraintType.MULTIPLICATION_EQUALITY, index, name);
    this.target = target;
    this.expressions = expressions;
  }

  toString(): string {
    return `MultiplicationEquality(${this.target} == ${this.expressions.join(' * ')})`;
  }
}

// ============================================================================
// Scheduling Constraints
// ============================================================================

/**
 * No overlap constraint: intervals cannot overlap
 */
export class NoOverlapConstraint extends Constraint {
  readonly intervals: IntervalVar[];

  constructor(index: number, intervals: IntervalVar[], name: string = '') {
    super(ConstraintType.NO_OVERLAP, index, name);
    this.intervals = intervals;
  }

  toString(): string {
    return `NoOverlap(${this.intervals.length} intervals)`;
  }
}

/**
 * No overlap 2D constraint: rectangles cannot overlap in 2D
 */
export class NoOverlap2DConstraint extends Constraint {
  readonly xIntervals: IntervalVar[];
  readonly yIntervals: IntervalVar[];

  constructor(
    index: number,
    xIntervals: IntervalVar[],
    yIntervals: IntervalVar[],
    name: string = ''
  ) {
    super(ConstraintType.NO_OVERLAP_2D, index, name);
    this.xIntervals = xIntervals;
    this.yIntervals = yIntervals;
  }

  toString(): string {
    return `NoOverlap2D(${this.xIntervals.length} intervals)`;
  }
}

/**
 * Cumulative constraint: sum of demands <= capacity at any time
 */
export class CumulativeConstraint extends Constraint {
  readonly intervals: IntervalVar[];
  readonly demands: LinearExpr[];
  readonly capacity: LinearExpr;

  constructor(
    index: number,
    intervals: IntervalVar[],
    demands: LinearExpr[],
    capacity: LinearExpr,
    name: string = ''
  ) {
    super(ConstraintType.CUMULATIVE, index, name);
    this.intervals = intervals;
    this.demands = demands;
    this.capacity = capacity;
  }

  toString(): string {
    return `Cumulative(${this.intervals.length} intervals, capacity=${this.capacity})`;
  }
}

/**
 * Map domain constraint: maps an integer variable to boolean variables
 */
export class MapDomainConstraint extends Constraint {
  readonly var_: IntVar;
  readonly boolVars: BoolVar[];
  readonly offset: number;

  constructor(
    index: number,
    var_: IntVar,
    boolVars: BoolVar[],
    offset: number,
    name: string = ''
  ) {
    super(ConstraintType.MAP_DOMAIN, index, name);
    this.var_ = var_;
    this.boolVars = boolVars;
    this.offset = offset;
  }

  toString(): string {
    return `MapDomain(${this.var_.name} -> ${this.boolVars.length} bools, offset=${this.offset})`;
  }
}

// ============================================================================
// Multiple Circuit Constraint
// ============================================================================

/**
 * Multiple circuit constraint: forms multiple routes (VRP-style)
 */
export class MultipleCircuitConstraint extends Constraint {
  readonly arcs: [number, number, BoolVar][];

  constructor(index: number, arcs: [number, number, BoolVar][], name: string = '') {
    super(ConstraintType.MULTIPLE_CIRCUIT, index, name);
    this.arcs = arcs;
  }

  toString(): string {
    return `MultipleCircuit(${this.arcs.length} arcs)`;
  }
}
