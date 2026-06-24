/**
 * CP-SAT TypeScript Implementation
 * Main entry point - exports all public APIs
 *
 * @packageDocumentation
 */

// ============================================================================
// Core Types
// ============================================================================

export {
  CpSolverStatus,
  VariableSelectionStrategy,
  DomainReductionStrategy,
  Domain,
  LinearExpr,
  BoundedLinearExpression,
  SolverParameters,
  SolverStatistics,
  SearchProgressInfo,
  ModelJSON,
  VariableData,
  IntervalVarData,
  ConstraintData,
  DecisionStrategyData,
  IntVar,
  BoolVar,
  IntervalVar,
  LinearExprLike,
  LiteralLike,
} from './types';

// ============================================================================
// Variables
// ============================================================================

export {
  IntVarImpl,
  BoolVarImpl,
  IntervalVarImpl,
  VariableRegistry,
} from './variables';

// ============================================================================
// Constraints
// ============================================================================

export {
  Constraint,
  ConstraintType,
  LinearConstraint,
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

// ============================================================================
// Model
// ============================================================================

export { CpModel } from './model';

// ============================================================================
// Solver
// ============================================================================

export { CpSolver } from './solver';

// ============================================================================
// Callbacks
// ============================================================================

export {
  CpSolverSolutionCallback,
  VarArraySolutionPrinter,
  VarArrayAndObjectiveSolutionPrinter,
  ObjectiveSolutionPrinter,
  SearchProgressCallback,
} from './callback';

// ============================================================================
// Solver Engine (advanced)
// ============================================================================

export { SolverEngine, SolverStats, SolutionCallback } from './solver-engine';

// ============================================================================
// Presolve
// ============================================================================

export { presolveModel, compressDomains, detectAffineRelations, computeDerivedValue, PresolveResult, DerivedVar } from './presolve';

// ============================================================================
// Scheduling Propagation
// ============================================================================

export {
  propagateNoOverlap,
  propagateNoOverlapDetectable,
  propagateNoOverlapNotLast,
  propagateNoOverlapEdgeFinding,
  propagateCumulativeTimeTable,
  propagateCumulativeEdgeFinding,
  propagateReservoir,
  checkReservoir,
  computeIntervalBounds,
  PropagationResult,
  IntervalBounds,
  LinearPropagateFn,
} from './scheduling-propagation';

// ============================================================================
// Circuit Propagation
// ============================================================================

export {
  propagateCircuit,
  propagateMultipleCircuit,
  checkCircuit,
  checkMultipleCircuit,
} from './circuit-propagation';

// ============================================================================
// NoOverlap2D Propagation
// ============================================================================

export {
  propagateNoOverlap2D,
  checkNoOverlap2D,
} from './nooverlap2d-propagation';

// ============================================================================
// Automaton Propagation
// ============================================================================

export {
  propagateAutomaton,
} from './automaton-propagation';

// ============================================================================
// LP Relaxation Bounds
// ============================================================================

export {
  detectPackingConstraints,
  computeLpObjectiveBound,
  fractionalKnapsackUpperBound,
  EMPTY_CLASSIFICATION,
} from './lp-bounds';
export type {
  PackingConstraint,
  PackingClassification,
  LpBoundContext,
} from './lp-bounds';

// ============================================================================
// Version
// ============================================================================

export const VERSION = '1.0.0';
