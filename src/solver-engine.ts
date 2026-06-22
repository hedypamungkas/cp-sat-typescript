/**
 * CP-SAT TypeScript Implementation
 * Solver Engine - Backtracking search with constraint propagation and branch-and-bound
 */

import { Domain, LinearExpr, CpSolverStatus, BoolVar, IntVar, SolverParameters } from './types';
import { IntVarImpl, BoolVarImpl, IntervalVarImpl } from './variables';
import {
  Constraint,
  LinearConstraint,
  NotEqualConstraint,
  AllDifferentConstraint,
  BoolOrConstraint,
  BoolAndConstraint,
  AtMostOneConstraint,
  ExactlyOneConstraint,
  BoolXorConstraint,
  ImplicationConstraint,
  MaxEqualityConstraint,
  MinEqualityConstraint,
  ElementConstraint,
  AbsEqualityConstraint,
  DivisionEqualityConstraint,
  ModuloEqualityConstraint,
  MultiplicationEqualityConstraint,
  AllowedAssignmentsConstraint,
  ForbiddenAssignmentsConstraint,
  InverseConstraint,
  NoOverlapConstraint,
  CumulativeConstraint,
  CircuitConstraint,
  MultipleCircuitConstraint,
  ReservoirConstraint,
  NoOverlap2DConstraint,
  MapDomainConstraint,
  AutomatonConstraint,
} from './constraints';
import { CpModel } from './model';
import { presolveModel, computeDerivedValue, DerivedVar } from './presolve';
import {
  propagateNoOverlap,
  propagateNoOverlapDetectable,
  propagateNoOverlapNotLast,
  propagateNoOverlapEdgeFinding,
  propagateCumulativeTimeTable,
  propagateCumulativeEdgeFinding,
  propagateReservoir,
  checkReservoir,
  PropagationResult,
  LinearPropagateFn,
} from './scheduling-propagation';
import {
  propagateCircuit,
  propagateMultipleCircuit,
  checkCircuit,
  checkMultipleCircuit,
} from './circuit-propagation';
import {
  propagateNoOverlap2D,
  checkNoOverlap2D,
} from './nooverlap2d-propagation';

// ============================================================================
// Solver Statistics
// ============================================================================

export interface SolverStats {
  numConflicts: number;
  numBranches: number;
  numBooleanPropagations: number;
  numIntegerPropagations: number;
  numSolutions: number;
  wallTime: number;
  presolveTime: number;
  searchTime: number;
}

// ============================================================================
// Solution Callback Interface
// ============================================================================

export interface SolutionCallback {
  onSolution(): boolean; // return true to continue, false to stop
}

// ============================================================================
// Solver Engine
// ============================================================================

/**
 * CP-SAT Solver Engine
 *
 * Implements backtracking search with constraint propagation and branch-and-bound.
 */
export class SolverEngine {
  private _model: CpModel;
  private _parameters: SolverParameters;
  private _stats: SolverStats;
  private _solution: Map<number, number> | null = null;
  private _allSolutions: Map<number, number>[] = [];
  private _callback: SolutionCallback | null = null;
  private _maxTime: number = Infinity;
  private _startTime: number = 0;
  private _stopped: boolean = false;
  private _enumerateAll: boolean = false;

  // Branch-and-bound state
  private _bestObjective: number | null = null;
  private _hasObjective: boolean = false;
  private _isMaximize: boolean = false;
  private _objectiveExpr: LinearExpr | null = null;
  private _searchExhausted: boolean = true;

  // Presolve state
  private _activeConstraints: Set<number> | null = null;
  private _derivedVars: Map<number, DerivedVar> | null = null;

  constructor(model: CpModel, parameters: SolverParameters = {}) {
    this._model = model;
    this._parameters = parameters;
    this._stats = {
      numConflicts: 0,
      numBranches: 0,
      numBooleanPropagations: 0,
      numIntegerPropagations: 0,
      numSolutions: 0,
      wallTime: 0,
      presolveTime: 0,
      searchTime: 0,
    };
  }

  /**
   * Set the objective for optimization
   */
  setObjective(expr: LinearExpr, maximize: boolean): void {
    this._hasObjective = true;
    this._isMaximize = maximize;
    this._objectiveExpr = expr;
  }

  /**
   * Solve the model
   */
  solve(callback?: SolutionCallback): CpSolverStatus {
    this._callback = callback || null;
    this._startTime = Date.now();
    this._stopped = false;
    this._solution = null;
    this._allSolutions = [];
    this._bestObjective = null;
    this._searchExhausted = true;
    this._stats = {
      numConflicts: 0,
      numBranches: 0,
      numBooleanPropagations: 0,
      numIntegerPropagations: 0,
      numSolutions: 0,
      wallTime: 0,
      presolveTime: 0,
      searchTime: 0,
    };

    // Validate model
    const validationError = this._model.validate();
    if (validationError) {
      return CpSolverStatus.MODEL_INVALID;
    }

    // Initialize domains
    const domains = this._initializeDomains();

    // Run presolve
    const presolveStart = Date.now();
    const presolveResult = this._runPresolve(domains);
    this._stats.presolveTime = (Date.now() - presolveStart) / 1000;

    if (presolveResult.status === 'INFEASIBLE') {
      this._stats.wallTime = (Date.now() - this._startTime) / 1000;
      return CpSolverStatus.INFEASIBLE;
    }

    // Note: _runPresolve has already populated this._activeConstraints.
    if (presolveResult.status === 'OPTIMAL') {
      // All variables fixed during presolve. Independently verify the candidate
      // against the active constraints before trusting it: presolve and the
      // checkers are separate code paths, and a disagreement must not silently
      // yield a wrong OPTIMAL answer.
      if (!this._checkAllConstraints(presolveResult.domains)) {
        console.warn(
          'cp-sat-ts: presolve reported OPTIMAL but independent checkers ' +
          'rejected the candidate. Treating as INFEASIBLE (this signals a ' +
          'propagation/presolve inconsistency).'
        );
        this._stats.wallTime = (Date.now() - this._startTime) / 1000;
        return CpSolverStatus.INFEASIBLE;
      }
      this._solution = this._extractSolution(presolveResult.domains);
      this._stats.wallTime = (Date.now() - this._startTime) / 1000;
      return CpSolverStatus.OPTIMAL;
    }

    // Apply hints
    this._applyHints(presolveResult.domains);

    // Start search
    const searchStart = Date.now();
    const status = this._search(presolveResult.domains, 0);
    this._stats.searchTime = (Date.now() - searchStart) / 1000;

    this._stats.wallTime = (Date.now() - this._startTime) / 1000;

    // Determine final status
    if (this._solution) {
      if (this._hasObjective) {
        // If we have an objective and exhausted search → OPTIMAL
        // If we have an objective but search was cut short → FEASIBLE
        return this._searchExhausted ? CpSolverStatus.OPTIMAL : CpSolverStatus.FEASIBLE;
      }
      // Pure feasibility: finding any solution = OPTIMAL
      return CpSolverStatus.OPTIMAL;
    }

    // No solution found
    if (status === CpSolverStatus.INFEASIBLE) {
      return CpSolverStatus.INFEASIBLE;
    }

    return status;
  }

  /**
   * Initialize domains for all variables
   */
  private _initializeDomains(): Map<number, Domain> {
    const domains = new Map<number, Domain>();

    for (const v of this._model.registry.allIntVars) {
      domains.set(v.index, new Domain(v.domain.intervals));
    }
    for (const v of this._model.registry.allBoolVars) {
      domains.set(v.index, new Domain([0, 1]));
    }

    return domains;
  }

  /**
   * Run presolve to tighten domains and detect affine relations.
   * Modifies domains in-place and stores active constraints / derived vars.
   */
  private _runPresolve(domains: Map<number, Domain>): {
    status: 'FEASIBLE' | 'INFEASIBLE' | 'OPTIMAL';
    domains: Map<number, Domain>;
  } {
    const result = presolveModel(this._model, domains);

    this._activeConstraints = result.activeConstraints;
    this._derivedVars = result.derivedVars;

    return { status: result.status, domains: result.domains };
  }

  /**
   * Apply solution hints
   */
  private _applyHints(domains: Map<number, Domain>): void {
    for (const [varIndex, value] of this._model.hints) {
      const domain = domains.get(varIndex);
      if (domain && domain.contains(value)) {
        domains.set(varIndex, domain.fixValue(value));
      }
    }
  }

  /**
   * Compute the objective value from a complete solution
   */
  private _computeObjective(domains: Map<number, Domain>): number | null {
    if (!this._objectiveExpr) return null;
    return this._evaluateExpression(this._objectiveExpr, domains);
  }

  /**
   * Compute the objective bound (min or max possible) from current domains
   */
  private _computeObjectiveBound(domains: Map<number, Domain>): { min: number; max: number } | null {
    if (!this._objectiveExpr) return null;
    const exprDomain = this._getExpressionDomain(this._objectiveExpr, domains);
    return { min: exprDomain.min, max: exprDomain.max };
  }

  /**
   * Check if the current objective bound can still improve on the incumbent
   */
  private _canImprove(domains: Map<number, Domain>): boolean {
    if (!this._hasObjective || this._bestObjective === null) return true;

    const bound = this._computeObjectiveBound(domains);
    if (!bound) return true;

    if (this._isMaximize) {
      // For maximize: if upper bound <= best, we can't improve
      return bound.max > this._bestObjective;
    } else {
      // For minimize: if lower bound >= best, we can't improve
      return bound.min < this._bestObjective;
    }
  }

  /**
   * Main search loop using recursive backtracking with branch-and-bound
   */
  private _search(domains: Map<number, Domain>, depth: number): CpSolverStatus {
    // Check time limit
    if (this._checkTimeLimit()) {
      this._searchExhausted = false;
      return this._solution ? CpSolverStatus.FEASIBLE : CpSolverStatus.UNKNOWN;
    }

    // Check if stopped
    if (this._stopped) {
      this._searchExhausted = false;
      return this._solution ? CpSolverStatus.FEASIBLE : CpSolverStatus.UNKNOWN;
    }

    // Branch-and-bound: prune if we can't improve on incumbent
    if (this._hasObjective && !this._canImprove(domains)) {
      this._stats.numConflicts++;
      return CpSolverStatus.INFEASIBLE;
    }

    // Propagate constraints
    const propagatedDomains = this._cloneDomains(domains);

    // Update derived variables' domains from base variable domains
    this._updateDerivedDomains(propagatedDomains);

    const propagationResult = this._propagate(propagatedDomains);

    if (!propagationResult) {
      this._stats.numConflicts++;
      return CpSolverStatus.INFEASIBLE;
    }

    // Re-check after propagation
    if (this._hasObjective && !this._canImprove(propagatedDomains)) {
      this._stats.numConflicts++;
      return CpSolverStatus.INFEASIBLE;
    }

    // Check if all variables are assigned
    if (this._isComplete(propagatedDomains)) {
      // Verify all constraints are satisfied
      if (!this._checkAllConstraints(propagatedDomains)) {
        this._stats.numConflicts++;
        return CpSolverStatus.INFEASIBLE;
      }

      // Found a solution!
      const objValue = this._computeObjective(propagatedDomains);

      // Update incumbent if this is better
      if (this._hasObjective && objValue !== null) {
        if (this._bestObjective === null) {
          this._bestObjective = objValue;
        } else if (this._isMaximize && objValue > this._bestObjective) {
          this._bestObjective = objValue;
        } else if (!this._isMaximize && objValue < this._bestObjective) {
          this._bestObjective = objValue;
        } else if (!this._enumerateAll) {
          // Not better than incumbent — skip (unless enumerating all)
          return CpSolverStatus.INFEASIBLE;
        }
      }

      this._stats.numSolutions++;
      this._solution = this._extractSolution(propagatedDomains);

      if (this._enumerateAll) {
        this._allSolutions.push(new Map(this._solution));
      }

      // Call callback
      if (this._callback) {
        const continueSearch = this._callback.onSolution();
        if (!continueSearch) {
          this._stopped = true;
        }
      }

      // For pure feasibility or enumerateAll, return OPTIMAL
      if (!this._hasObjective || this._enumerateAll) {
        return CpSolverStatus.OPTIMAL;
      }

      // For optimization: we found/improved incumbent, continue searching
      return CpSolverStatus.OPTIMAL;
    }

    // Select variable to branch on (MRV heuristic)
    const varIndex = this._selectVariable(propagatedDomains);
    if (varIndex === -1) {
      // Should not happen if isComplete is false
      return CpSolverStatus.INFEASIBLE;
    }

    const domain = propagatedDomains.get(varIndex)!;
    if (domain.isEmpty) {
      this._stats.numConflicts++;
      return CpSolverStatus.INFEASIBLE;
    }

    // Try each value in the domain
    const values = domain.values();

    for (const value of values) {
      if (this._stopped) {
        this._searchExhausted = false;
        break;
      }

      this._stats.numBranches++;

      // Create new domain with this variable fixed
      const newDomains = this._cloneDomains(propagatedDomains);
      newDomains.set(varIndex, new Domain([value, value]));

      // Recurse
      const status = this._search(newDomains, depth + 1);

      if (status === CpSolverStatus.OPTIMAL) {
        if (!this._enumerateAll && !this._hasObjective) {
          return CpSolverStatus.OPTIMAL;
        }
        // Continue searching for better solutions or more solutions
      }
    }

    // If we found any solution, return FEASIBLE (for optimization) or INFEASIBLE
    if (this._solution) {
      return CpSolverStatus.FEASIBLE;
    }

    return CpSolverStatus.INFEASIBLE;
  }

  /**
   * Check if all non-derived variables are assigned
   */
  private _isComplete(domains: Map<number, Domain>): boolean {
    for (const [index, domain] of domains) {
      // Skip derived variables — they don't need to be assigned during search
      if (this._derivedVars && this._derivedVars.has(index)) continue;
      if (domain.size > 1) return false;
    }
    return true;
  }

  /**
   * Extract solution from domains, computing derived variable values.
   */
  private _extractSolution(domains: Map<number, Domain>): Map<number, number> {
    const solution = new Map<number, number>();

    // First, extract all non-derived variables
    for (const [index, domain] of domains) {
      if (domain.size === 1) {
        solution.set(index, domain.min);
      }
    }

    // Then compute derived variable values
    if (this._derivedVars) {
      for (const [varIdx, derived] of this._derivedVars) {
        const value = computeDerivedValue(derived, solution);
        solution.set(varIdx, value);
      }
    }

    return solution;
  }

  /**
   * Select the next variable to branch on (Minimum Remaining Values)
   */
  private _selectVariable(domains: Map<number, Domain>): number {
    let bestIndex = -1;
    let bestSize = Infinity;

    for (const [index, domain] of domains) {
      if (domain.size <= 1) continue; // Already assigned
      // Skip derived variables — their values are computed from base variables
      if (this._derivedVars && this._derivedVars.has(index)) continue;

      if (domain.size < bestSize) {
        bestSize = domain.size;
        bestIndex = index;
      }
    }

    return bestIndex;
  }

  /**
   * Update derived variables' domains based on current base variable domains.
   * For derived var = coeff * base + offset:
   *   - Compute the new domain from the base variable's current domain
   *   - Intersect with the derived variable's existing domain
   */
  private _updateDerivedDomains(domains: Map<number, Domain>): void {
    if (!this._derivedVars) return;

    for (const [varIdx, derived] of this._derivedVars) {
      if (derived.coeff === 0) {
        // Constant: domain is just {offset}
        domains.set(varIdx, new Domain([derived.offset, derived.offset]));
        continue;
      }

      const baseDomain = domains.get(derived.baseVarIndex);
      if (!baseDomain || baseDomain.isEmpty) continue;

      // Compute derived domain: coeff * base + offset
      let newMin: number;
      let newMax: number;

      if (derived.coeff > 0) {
        newMin = derived.coeff * baseDomain.min + derived.offset;
        newMax = derived.coeff * baseDomain.max + derived.offset;
      } else {
        newMin = derived.coeff * baseDomain.max + derived.offset;
        newMax = derived.coeff * baseDomain.min + derived.offset;
      }

      const derivedDomain = domains.get(varIdx);
      if (!derivedDomain) {
        domains.set(varIdx, new Domain([newMin, newMax]));
      } else {
        // Intersect with existing domain
        const computed = new Domain([newMin, newMax]);
        domains.set(varIdx, derivedDomain.intersection(computed));
      }
    }
  }

  /**
   * Check time limit
   */
  private _checkTimeLimit(): boolean {
    if (this._maxTime === Infinity) return false;
    const elapsed = (Date.now() - this._startTime) / 1000;
    return elapsed >= this._maxTime;
  }

  /**
   * Clone domains map
   */
  private _cloneDomains(domains: Map<number, Domain>): Map<number, Domain> {
    const cloned = new Map<number, Domain>();
    for (const [index, domain] of domains) {
      cloned.set(index, new Domain(domain.intervals));
    }
    return cloned;
  }

  /**
   * Check all constraints are satisfied
   */
  private _checkAllConstraints(domains: Map<number, Domain>): boolean {
    for (let i = 0; i < this._model.constraints.length; i++) {
      // Skip inactive constraints (removed during presolve)
      if (this._activeConstraints && !this._activeConstraints.has(i)) continue;

      const constraint = this._model.constraints[i];
      if (!this._checkConstraint(constraint, domains)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check a single constraint
   */
  private _checkConstraint(constraint: Constraint, domains: Map<number, Domain>): boolean {
    switch (constraint.type) {
      case 'LINEAR':
        return this._checkLinear(constraint as LinearConstraint, domains);
      case 'NOT_EQUAL':
        return this._checkNotEqual(constraint as NotEqualConstraint, domains);
      case 'ALL_DIFFERENT':
        return this._checkAllDifferent(constraint as AllDifferentConstraint, domains);
      case 'BOOL_OR':
        return this._checkBoolOr(constraint as BoolOrConstraint, domains);
      case 'BOOL_AND':
        return this._checkBoolAnd(constraint as BoolAndConstraint, domains);
      case 'AT_MOST_ONE':
        return this._checkAtMostOne(constraint as AtMostOneConstraint, domains);
      case 'EXACTLY_ONE':
        return this._checkExactlyOne(constraint as ExactlyOneConstraint, domains);
      case 'BOOL_XOR':
        return this._checkBoolXor(constraint as BoolXorConstraint, domains);
      case 'IMPLICATION':
        return this._checkImplication(constraint as ImplicationConstraint, domains);
      case 'MAX_EQUALITY':
        return this._checkMaxEquality(constraint as MaxEqualityConstraint, domains);
      case 'MIN_EQUALITY':
        return this._checkMinEquality(constraint as MinEqualityConstraint, domains);
      case 'ELEMENT':
        return this._checkElement(constraint as ElementConstraint, domains);
      case 'ABS_EQUALITY':
        return this._checkAbsEquality(constraint as AbsEqualityConstraint, domains);
      case 'DIVISION_EQUALITY':
        return this._checkDivisionEquality(constraint as DivisionEqualityConstraint, domains);
      case 'MODULO_EQUALITY':
        return this._checkModuloEquality(constraint as ModuloEqualityConstraint, domains);
      case 'MULTIPLICATION_EQUALITY':
        return this._checkMultiplicationEquality(constraint as MultiplicationEqualityConstraint, domains);
      case 'ALLOWED_ASSIGNMENTS':
        return this._checkAllowedAssignments(constraint as AllowedAssignmentsConstraint, domains);
      case 'FORBIDDEN_ASSIGNMENTS':
        return this._checkForbiddenAssignments(constraint as ForbiddenAssignmentsConstraint, domains);
      case 'INVERSE':
        return this._checkInverse(constraint as InverseConstraint, domains);
      case 'NO_OVERLAP':
        return this._checkNoOverlap(constraint as NoOverlapConstraint, domains);
      case 'CUMULATIVE':
        return this._checkCumulative(constraint as CumulativeConstraint, domains);
      case 'CIRCUIT':
        return this._checkCircuit(constraint as CircuitConstraint, domains);
      case 'MULTIPLE_CIRCUIT':
        return this._checkMultipleCircuit(constraint as MultipleCircuitConstraint, domains);
      case 'RESERVOIR':
        return this._checkReservoir(constraint as ReservoirConstraint, domains);
      case 'NO_OVERLAP_2D':
        return this._checkNoOverlap2D(constraint as NoOverlap2DConstraint, domains);
      case 'MAP_DOMAIN':
        // MAP_DOMAIN is decomposed into ExactlyOne + Linear constraints at model time
        // The decomposed constraints handle verification
        return true;
      case 'AUTOMATON':
        return this._checkAutomaton(constraint as AutomatonConstraint, domains);
      default:
        return true;
    }
  }

  // ============================================================================
  // Constraint Checking (solution verification)
  // ============================================================================

  /**
   * Check Automaton: simulate the DFA over the fixed variable word and verify
   * it ends in an accepting state. Replaces a former mid-solve throw.
   * Assumes a deterministic automaton (OR-Tools automata are deterministic).
   */
  private _checkAutomaton(ct: AutomatonConstraint, domains: Map<number, Domain>): boolean {
    let state = ct.startingState;
    for (const v of ct.vars) {
      const d = domains.get(v.index);
      if (!d || d.size !== 1) return false; // not fully fixed at this leaf
      const label = d.min;
      let next = -1;
      for (let i = 0; i < ct.transitionTail.length; i++) {
        if (ct.transitionTail[i] === state && ct.transitionLabel[i] === label) {
          next = ct.transitionHead[i];
          break;
        }
      }
      if (next === -1) return false; // no transition for this label → rejected
      state = next;
    }
    return ct.finalStates.includes(state);
  }

  private _checkLinear(ct: LinearConstraint, domains: Map<number, Domain>): boolean {
    const { vars, coeffs, domain: bounds } = ct;
    const lb = bounds.min;
    const ub = bounds.max;

    let sum = 0;
    for (let i = 0; i < vars.length; i++) {
      const d = domains.get(vars[i].index);
      if (!d || d.size !== 1) return false;
      sum += coeffs[i] * d.min;
    }

    return sum >= lb && sum <= ub;
  }

  private _checkAllDifferent(ct: AllDifferentConstraint, domains: Map<number, Domain>): boolean {
    const values = new Set<number>();

    for (const expr of ct.expressions) {
      const val = this._evaluateExpression(expr, domains);
      if (val === null) return false;
      if (values.has(val)) return false;
      values.add(val);
    }

    return true;
  }

  private _checkBoolOr(ct: BoolOrConstraint, domains: Map<number, Domain>): boolean {
    for (const lit of ct.literals) {
      const d = domains.get(lit.index);
      if (d && d.min === 1) return true;
    }
    return false;
  }

  private _checkBoolAnd(ct: BoolAndConstraint, domains: Map<number, Domain>): boolean {
    for (const lit of ct.literals) {
      const d = domains.get(lit.index);
      if (!d || d.max === 0) return false;
    }
    return true;
  }

  private _checkAtMostOne(ct: AtMostOneConstraint, domains: Map<number, Domain>): boolean {
    let trueCount = 0;
    for (const lit of ct.literals) {
      const d = domains.get(lit.index);
      if (d && d.min === 1) trueCount++;
    }
    return trueCount <= 1;
  }

  private _checkExactlyOne(ct: ExactlyOneConstraint, domains: Map<number, Domain>): boolean {
    let trueCount = 0;
    for (const lit of ct.literals) {
      const d = domains.get(lit.index);
      if (d && d.min === 1) trueCount++;
    }
    return trueCount === 1;
  }

  /**
   * Check BoolXor: odd number of literals must be true
   */
  private _checkBoolXor(ct: BoolXorConstraint, domains: Map<number, Domain>): boolean {
    let trueCount = 0;
    for (const lit of ct.literals) {
      const d = domains.get(lit.index);
      if (!d || d.size !== 1) return false;
      if (d.min === 1) trueCount++;
    }
    return trueCount % 2 === 1;
  }

  private _checkImplication(ct: ImplicationConstraint, domains: Map<number, Domain>): boolean {
    const aDomain = domains.get(ct.a.index);
    const bDomain = domains.get(ct.b.index);

    if (!aDomain || !bDomain) return false;
    if (aDomain.size !== 1 || bDomain.size !== 1) return false;

    // If a is true, b must be true
    if (aDomain.min === 1 && bDomain.min === 0) return false;
    return true;
  }

  private _checkMaxEquality(ct: MaxEqualityConstraint, domains: Map<number, Domain>): boolean {
    const targetDomain = domains.get(ct.target.index);
    if (!targetDomain || targetDomain.size !== 1) return false;

    const targetVal = targetDomain.min;
    let maxVal = -Infinity;

    for (const expr of ct.expressions) {
      const val = this._evaluateExpression(expr, domains);
      if (val === null) return false;
      maxVal = Math.max(maxVal, val);
    }

    return targetVal === maxVal;
  }

  private _checkMinEquality(ct: MinEqualityConstraint, domains: Map<number, Domain>): boolean {
    const targetDomain = domains.get(ct.target.index);
    if (!targetDomain || targetDomain.size !== 1) return false;

    const targetVal = targetDomain.min;
    let minVal = Infinity;

    for (const expr of ct.expressions) {
      const val = this._evaluateExpression(expr, domains);
      if (val === null) return false;
      minVal = Math.min(minVal, val);
    }

    return targetVal === minVal;
  }

  /**
   * Check Element constraint: vars[index] == target
   */
  private _checkElement(ct: ElementConstraint, domains: Map<number, Domain>): boolean {
    const indexDomain = domains.get(ct.indexVar.index);
    const targetDomain = domains.get(ct.target.index);

    if (!indexDomain || !targetDomain) return false;
    if (indexDomain.size !== 1 || targetDomain.size !== 1) return false;

    const idx = indexDomain.min;
    if (idx < 0 || idx >= ct.vars.length) return false;

    const varDomain = domains.get(ct.vars[idx].index);
    if (!varDomain || varDomain.size !== 1) return false;

    return varDomain.min === targetDomain.min;
  }

  /**
   * Check AbsEquality: target == |expr|
   */
  private _checkAbsEquality(ct: AbsEqualityConstraint, domains: Map<number, Domain>): boolean {
    const targetDomain = domains.get(ct.target.index);
    if (!targetDomain || targetDomain.size !== 1) return false;

    const val = this._evaluateExpression(ct.expr, domains);
    if (val === null) return false;

    return targetDomain.min === Math.abs(val);
  }

  /**
   * Check DivisionEquality: target == num / denom (integer division)
   */
  private _checkDivisionEquality(ct: DivisionEqualityConstraint, domains: Map<number, Domain>): boolean {
    const targetDomain = domains.get(ct.target.index);
    if (!targetDomain || targetDomain.size !== 1) return false;

    const numVal = this._evaluateExpression(ct.num, domains);
    const denomVal = this._evaluateExpression(ct.denom, domains);
    if (numVal === null || denomVal === null) return false;
    if (denomVal === 0) return false;

    return targetDomain.min === Math.trunc(numVal / denomVal);
  }

  /**
   * Check ModuloEquality: target == expr % mod
   */
  private _checkModuloEquality(ct: ModuloEqualityConstraint, domains: Map<number, Domain>): boolean {
    const targetDomain = domains.get(ct.target.index);
    if (!targetDomain || targetDomain.size !== 1) return false;

    const exprVal = this._evaluateExpression(ct.expr, domains);
    const modVal = this._evaluateExpression(ct.mod, domains);
    if (exprVal === null || modVal === null) return false;
    if (modVal === 0) return false;

    return targetDomain.min === ((exprVal % modVal) + modVal) % modVal;
  }

  /**
   * Check MultiplicationEquality: target == product of expressions
   */
  private _checkMultiplicationEquality(ct: MultiplicationEqualityConstraint, domains: Map<number, Domain>): boolean {
    const targetDomain = domains.get(ct.target.index);
    if (!targetDomain || targetDomain.size !== 1) return false;

    let product = 1;
    for (const expr of ct.expressions) {
      const val = this._evaluateExpression(expr, domains);
      if (val === null) return false;
      product *= val;
    }

    return targetDomain.min === product;
  }

  /**
   * Check AllowedAssignments: variable values must be in allowed tuples
   */
  private _checkAllowedAssignments(ct: AllowedAssignmentsConstraint, domains: Map<number, Domain>): boolean {
    const values: number[] = [];
    for (const v of ct.vars) {
      const d = domains.get(v.index);
      if (!d || d.size !== 1) return false;
      values.push(d.min);
    }

    for (const tuple of ct.tuples) {
      if (tuple.length !== values.length) continue;
      let match = true;
      for (let i = 0; i < values.length; i++) {
        if (values[i] !== tuple[i]) { match = false; break; }
      }
      if (match) return true;
    }
    return false;
  }

  /**
   * Check ForbiddenAssignments: variable values must NOT be in forbidden tuples
   */
  private _checkForbiddenAssignments(ct: ForbiddenAssignmentsConstraint, domains: Map<number, Domain>): boolean {
    const values: number[] = [];
    for (const v of ct.vars) {
      const d = domains.get(v.index);
      if (!d || d.size !== 1) return false;
      values.push(d.min);
    }

    for (const tuple of ct.tuples) {
      if (tuple.length !== values.length) continue;
      let match = true;
      for (let i = 0; i < values.length; i++) {
        if (values[i] !== tuple[i]) { match = false; break; }
      }
      if (match) return false; // Found a forbidden tuple
    }
    return true;
  }

  /**
   * Check Inverse: f_direct[i] = j iff f_inverse[j] = i
   */
  private _checkInverse(ct: InverseConstraint, domains: Map<number, Domain>): boolean {
    const fValues: number[] = [];
    const gValues: number[] = [];

    for (const v of ct.fDirect) {
      const d = domains.get(v.index);
      if (!d || d.size !== 1) return false;
      fValues.push(d.min);
    }

    for (const v of ct.fInverse) {
      const d = domains.get(v.index);
      if (!d || d.size !== 1) return false;
      gValues.push(d.min);
    }

    // Check: f[i] = j iff g[j] = i
    for (let i = 0; i < fValues.length; i++) {
      const j = fValues[i];
      if (j < 0 || j >= gValues.length) return false;
      if (gValues[j] !== i) return false;
    }

    return true;
  }

  /**
   * Check NoOverlap: intervals cannot overlap
   */
  private _checkNoOverlap(ct: NoOverlapConstraint, domains: Map<number, Domain>): boolean {
    const intervals: { start: number; end: number }[] = [];

    for (const iv of ct.intervals) {
      const startD = domains.get(iv.start.vars[0]?.index ?? -1);
      const endD = domains.get(iv.end.vars[0]?.index ?? -1);

      // Try to evaluate start and end
      const startVal = this._evaluateExpression(iv.start, domains);
      const endVal = this._evaluateExpression(iv.end, domains);

      if (startVal === null || endVal === null) return false;
      intervals.push({ start: startVal, end: endVal });
    }

    // Check pairwise non-overlap
    for (let i = 0; i < intervals.length; i++) {
      for (let j = i + 1; j < intervals.length; j++) {
        if (intervals[i].start < intervals[j].end && intervals[j].start < intervals[i].end) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Check Cumulative: sum of demands <= capacity at any time point
   */
  private _checkCumulative(ct: CumulativeConstraint, domains: Map<number, Domain>): boolean {
    // Simplified check: at the solution, verify demands don't exceed capacity
    const capacityVal = this._evaluateExpression(ct.capacity, domains);
    if (capacityVal === null) return false;

    // For each pair of overlapping intervals, check demand sum
    for (let i = 0; i < ct.intervals.length; i++) {
      const startI = this._evaluateExpression(ct.intervals[i].start, domains);
      const endI = this._evaluateExpression(ct.intervals[i].end, domains);
      const demandI = this._evaluateExpression(ct.demands[i], domains);
      if (startI === null || endI === null || demandI === null) return false;

      let totalDemand = demandI;
      for (let j = 0; j < ct.intervals.length; j++) {
        if (i === j) continue;
        const startJ = this._evaluateExpression(ct.intervals[j].start, domains);
        const endJ = this._evaluateExpression(ct.intervals[j].end, domains);
        const demandJ = this._evaluateExpression(ct.demands[j], domains);
        if (startJ === null || endJ === null || demandJ === null) return false;

        // Check if intervals overlap
        if (startJ < endI && startI < endJ) {
          totalDemand += demandJ;
        }
      }

      if (totalDemand > capacityVal) return false;
    }

    return true;
  }

  /**
   * Check Circuit constraint: solution must form a single Hamiltonian cycle
   */
  private _checkCircuit(ct: CircuitConstraint, domains: Map<number, Domain>): boolean {
    return checkCircuit(ct, domains);
  }

  /**
   * Check MultipleCircuit constraint: solution must form valid routes through depot
   */
  private _checkMultipleCircuit(ct: MultipleCircuitConstraint, domains: Map<number, Domain>): boolean {
    return checkMultipleCircuit(ct, domains);
  }

  /**
   * Check Reservoir constraint: level must stay within bounds
   */
  private _checkReservoir(ct: ReservoirConstraint, domains: Map<number, Domain>): boolean {
    return checkReservoir(ct, domains);
  }

  /**
   * Check NoOverlap2D constraint: rectangles must not overlap
   */
  private _checkNoOverlap2D(ct: NoOverlap2DConstraint, domains: Map<number, Domain>): boolean {
    return checkNoOverlap2D(ct, domains);
  }

  // ============================================================================
  // Constraint Propagation
  // ============================================================================

  /**
   * Propagate all constraints until fixpoint
   * Returns false if inconsistency detected
   */
  private _propagate(domains: Map<number, Domain>): boolean {
    let changed = true;
    let iterations = 0;
    // Safety ceiling only: a correct (monotonic) fixpoint converges well below
    // this. If it is ever hit, propagation is stopped early AND a warning is
    // emitted — never silently. Hitting it signals non-monotonic propagators
    // that should be fixed, not a "consistent" result to trust.
    const maxIterations = 1000;

    while (changed) {
      changed = false;
      iterations++;
      if (iterations > maxIterations) {
        console.warn(
          `cp-sat-ts: propagation fixpoint exceeded ${maxIterations} iterations; ` +
          'stopping early. This indicates non-monotonic propagators.'
        );
        break;
      }

      for (let i = 0; i < this._model.constraints.length; i++) {
        // Skip inactive constraints (removed during presolve)
        if (this._activeConstraints && !this._activeConstraints.has(i)) continue;

        const constraint = this._model.constraints[i];
        const result = this._propagateConstraint(constraint, domains);
        if (result === 'INFEASIBLE') {
          return false;
        }
        if (result === 'CHANGED') {
          changed = true;
        }
      }

      // Check for empty domains
      for (const [_index, domain] of domains) {
        if (domain.isEmpty) return false;
      }
    }

    return true;
  }

  /**
   * Propagate a single constraint
   */
  private _propagateConstraint(constraint: Constraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    // Skip propagation if this constraint type is disabled (for benchmarking)
    if (this._parameters.disablePropagationForTypes?.includes(constraint.type)) {
      return 'CONSISTENT';
    }

    switch (constraint.type) {
      case 'LINEAR':
        return this._propagateLinear(constraint as LinearConstraint, domains);
      case 'NOT_EQUAL':
        return this._propagateNotEqual(constraint as NotEqualConstraint, domains);
      case 'ALL_DIFFERENT':
        return this._propagateAllDifferent(constraint as AllDifferentConstraint, domains);
      case 'BOOL_OR':
        return this._propagateBoolOr(constraint as BoolOrConstraint, domains);
      case 'BOOL_AND':
        return this._propagateBoolAnd(constraint as BoolAndConstraint, domains);
      case 'AT_MOST_ONE':
        return this._propagateAtMostOne(constraint as AtMostOneConstraint, domains);
      case 'EXACTLY_ONE':
        return this._propagateExactlyOne(constraint as ExactlyOneConstraint, domains);
      case 'BOOL_XOR':
        return this._propagateBoolXor(constraint as BoolXorConstraint, domains);
      case 'IMPLICATION':
        return this._propagateImplication(constraint as ImplicationConstraint, domains);
      case 'MAX_EQUALITY':
        return this._propagateMaxEquality(constraint as MaxEqualityConstraint, domains);
      case 'MIN_EQUALITY':
        return this._propagateMinEquality(constraint as MinEqualityConstraint, domains);
      case 'ELEMENT':
        return this._propagateElement(constraint as ElementConstraint, domains);
      case 'ABS_EQUALITY':
        return this._propagateAbsEquality(constraint as AbsEqualityConstraint, domains);
      case 'ALLOWED_ASSIGNMENTS':
        return this._propagateAllowedAssignments(constraint as AllowedAssignmentsConstraint, domains);
      case 'NO_OVERLAP':
        return this._propagateNoOverlapConstraint(constraint as NoOverlapConstraint, domains);
      case 'CUMULATIVE':
        return this._propagateCumulativeConstraint(constraint as CumulativeConstraint, domains);
      case 'CIRCUIT':
        return this._propagateCircuitConstraint(constraint as CircuitConstraint, domains);
      case 'MULTIPLE_CIRCUIT':
        return this._propagateMultipleCircuitConstraint(constraint as MultipleCircuitConstraint, domains);
      case 'RESERVOIR':
        return this._propagateReservoirConstraint(constraint as ReservoirConstraint, domains);
      case 'NO_OVERLAP_2D':
        return this._propagateNoOverlap2DConstraint(constraint as NoOverlap2DConstraint, domains);
      default:
        return 'CONSISTENT';
    }
  }

  /**
   * Propagate linear constraint with variable bound tightening
   * lb <= sum(vars[i] * coeffs[i]) <= ub
   */
  private _propagateLinear(ct: LinearConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    const { vars, coeffs, domain: bounds } = ct;
    const lb = bounds.min;
    const ub = bounds.max;

    // Compute current min and max of the expression
    let exprMin = 0;
    let exprMax = 0;

    for (let i = 0; i < vars.length; i++) {
      const v = vars[i];
      const c = coeffs[i];
      const d = domains.get(v.index);
      if (!d || d.isEmpty) return 'INFEASIBLE';

      if (c > 0) {
        exprMin += c * d.min;
        exprMax += c * d.max;
      } else if (c < 0) {
        exprMin += c * d.max;
        exprMax += c * d.min;
      }
    }

    // Check consistency
    if (exprMax < lb || exprMin > ub) {
      return 'INFEASIBLE';
    }

    // Tighten variable bounds
    let changed = false;

    for (let i = 0; i < vars.length; i++) {
      const v = vars[i];
      const c = coeffs[i];
      const d = domains.get(v.index);
      if (!d || d.isEmpty) return 'INFEASIBLE';

      if (c === 0) continue;

      // Compute min/max of all other terms
      let otherMin = 0;
      let otherMax = 0;
      for (let j = 0; j < vars.length; j++) {
        if (j === i) continue;
        const vj = vars[j];
        const cj = coeffs[j];
        const dj = domains.get(vj.index);
        if (!dj || dj.isEmpty) return 'INFEASIBLE';

        if (cj > 0) {
          otherMin += cj * dj.min;
          otherMax += cj * dj.max;
        } else if (cj < 0) {
          otherMin += cj * dj.max;
          otherMax += cj * dj.min;
        }
      }

      // lb <= c * x_i + other <= ub
      // c * x_i >= lb - other_max  →  x_i >= ceil((lb - otherMax) / c)  if c > 0
      // c * x_i <= ub - other_min  →  x_i <= floor((ub - otherMin) / c) if c > 0

      let newMin: number;
      let newMax: number;

      if (c > 0) {
        newMin = Math.ceil((lb - otherMax) / c);
        newMax = Math.floor((ub - otherMin) / c);
      } else {
        // c < 0: inequality reverses
        newMin = Math.ceil((ub - otherMin) / c);
        newMax = Math.floor((lb - otherMax) / c);
      }

      // Intersect with current domain
      const tightenedMin = Math.max(d.min, newMin);
      const tightenedMax = Math.min(d.max, newMax);

      if (tightenedMin > tightenedMax) {
        return 'INFEASIBLE';
      }

      if (tightenedMin > d.min || tightenedMax < d.max) {
        // Create new domain with tightened bounds
        // Handle multi-interval domains by filtering
        const newIntervals: [number, number][] = [];
        for (const [start, end] of d.intervals) {
          const s = Math.max(start, tightenedMin);
          const e = Math.min(end, tightenedMax);
          if (s <= e) {
            newIntervals.push([s, e]);
          }
        }

        if (newIntervals.length === 0) {
          return 'INFEASIBLE';
        }

        const newDomain = new Domain(newIntervals);
        if (newDomain.size < d.size) {
          domains.set(v.index, newDomain);
          this._stats.numIntegerPropagations++;
          changed = true;
        }
      }
    }

    return changed ? 'CHANGED' : 'CONSISTENT';
  }

  /**
   * Propagate NotEqual: expr != value.
   *
   * For each variable, when ALL other variables in the expression are fixed,
   * the expression becomes affine in that variable, and the single value that
   * would make it equal `value` can be removed. This is sound — it only removes
   * values that are genuinely infeasible — and covers x != c (immediately) and
   * x != y once one side is fixed.
   */
  private _propagateNotEqual(ct: NotEqualConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    const { vars, coeffs, offset } = ct.expr;
    let changed = false;

    for (let i = 0; i < vars.length; i++) {
      const c = coeffs[i];
      if (c === 0) continue;

      // Sum of the other (fixed) terms + offset; skip if any other var is unfixed.
      let othersFixed = true;
      let othersSum = offset;
      for (let j = 0; j < vars.length; j++) {
        if (j === i) continue;
        const dj = domains.get(vars[j].index);
        if (!dj || dj.isEmpty) return 'INFEASIBLE';
        if (dj.size !== 1) {
          othersFixed = false;
          break;
        }
        othersSum += coeffs[j] * dj.min;
      }
      if (!othersFixed) continue;

      // expr == value  <=>  c * x_i + othersSum == value  <=>  x_i == (value - othersSum) / c
      const numerator = ct.value - othersSum;
      if (numerator % c !== 0) continue; // forbidden value is non-integer → irrelevant
      const forbidden = numerator / c;

      const d = domains.get(vars[i].index);
      if (!d || d.isEmpty) return 'INFEASIBLE';
      if (d.contains(forbidden)) {
        const newDomain = d.removeValue(forbidden);
        if (newDomain.isEmpty) return 'INFEASIBLE';
        domains.set(vars[i].index, newDomain);
        this._stats.numIntegerPropagations++;
        changed = true;
      }
    }

    return changed ? 'CHANGED' : 'CONSISTENT';
  }

  /**
   * Check NotEqual at a complete solution: evaluate expr, ensure != value.
   */
  private _checkNotEqual(ct: NotEqualConstraint, domains: Map<number, Domain>): boolean {
    const value = ct.expr.evaluate(v => domains.get(v.index)!.min);
    return value !== ct.value;
  }

  /**
   * Propagate AllDifferent constraint — handles both simple vars and expressions
   */
  private _propagateAllDifferent(ct: AllDifferentConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    // Compute domain for each expression
    const exprDomains: { expr: LinearExpr; domain: Domain; isSimpleVar: boolean; varIndex: number }[] = [];

    for (const expr of ct.expressions) {
      const isSimple = expr.vars.length === 1 && expr.coeffs[0] === 1 && expr.offset === 0;
      const exprDomain = this._getExpressionDomain(expr, domains);

      exprDomains.push({
        expr,
        domain: exprDomain,
        isSimpleVar: isSimple,
        varIndex: isSimple ? expr.vars[0].index : -1,
      });
    }

    // Check for assigned value conflicts
    const assignedValues = new Map<number, number>(); // value -> expression index
    for (let i = 0; i < exprDomains.length; i++) {
      const ed = exprDomains[i];
      if (ed.domain.size === 1) {
        const val = ed.domain.min;
        if (assignedValues.has(val)) {
          return 'INFEASIBLE';
        }
        assignedValues.set(val, i);
      }
    }

    // Forward checking: remove assigned expression values from other expression domains
    let changed = false;

    for (let i = 0; i < exprDomains.length; i++) {
      const ed = exprDomains[i];
      if (ed.domain.size !== 1) continue;

      const val = ed.domain.min;

      for (let j = 0; j < exprDomains.length; j++) {
        if (i === j) continue;
        const other = exprDomains[j];

        if (!other.domain.contains(val)) continue;

        if (other.isSimpleVar) {
          // For simple variables, remove the value from the variable's domain
          const otherD = domains.get(other.varIndex)!;
          if (otherD.size > 1) {
            const newDomain = otherD.removeValue(val);
            if (newDomain.isEmpty) return 'INFEASIBLE';
            if (newDomain.size < otherD.size) {
              domains.set(other.varIndex, newDomain);
              changed = true;
            }
          }
        }
        // For complex expressions, we can't easily remove a single value
        // unless it's a single-variable expression with offset
        else if (other.expr.vars.length === 1 && other.expr.coeffs[0] === 1) {
          // Expression is var + offset; to exclude val, exclude (val - offset) from var
          const varIdx = other.expr.vars[0].index;
          const offset = other.expr.offset;
          const excludeVal = val - offset;
          const varD = domains.get(varIdx)!;
          if (varD.contains(excludeVal) && varD.size > 1) {
            const newDomain = varD.removeValue(excludeVal);
            if (newDomain.isEmpty) return 'INFEASIBLE';
            if (newDomain.size < varD.size) {
              domains.set(varIdx, newDomain);
              changed = true;
            }
          }
        }
      }
    }

    return changed ? 'CHANGED' : 'CONSISTENT';
  }

  private _propagateBoolOr(ct: BoolOrConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    let falseCount = 0;
    let lastUnassigned: BoolVar | null = null;

    for (const lit of ct.literals) {
      const d = domains.get(lit.index)!;
      if (d.min === 1) return 'CONSISTENT'; // Already satisfied
      if (d.max === 0) {
        falseCount++;
      } else {
        lastUnassigned = lit;
      }
    }

    if (falseCount === ct.literals.length) return 'INFEASIBLE';

    if (falseCount === ct.literals.length - 1 && lastUnassigned) {
      domains.set(lastUnassigned.index, new Domain([1, 1]));
      this._stats.numBooleanPropagations++;
      return 'CHANGED';
    }

    return 'CONSISTENT';
  }

  private _propagateBoolAnd(ct: BoolAndConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    let changed = false;

    for (const lit of ct.literals) {
      const d = domains.get(lit.index)!;
      if (d.max === 0) return 'INFEASIBLE';

      if (d.size > 1) {
        domains.set(lit.index, new Domain([1, 1]));
        this._stats.numBooleanPropagations++;
        changed = true;
      }
    }

    return changed ? 'CHANGED' : 'CONSISTENT';
  }

  private _propagateAtMostOne(ct: AtMostOneConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    let trueCount = 0;
    let trueLit: BoolVar | null = null;

    for (const lit of ct.literals) {
      const d = domains.get(lit.index)!;
      if (d.min === 1) {
        trueCount++;
        trueLit = lit;
      }
    }

    if (trueCount > 1) return 'INFEASIBLE';

    if (trueCount === 1 && trueLit) {
      let changed = false;
      for (const lit of ct.literals) {
        if (lit.index === trueLit.index) continue;
        const d = domains.get(lit.index)!;
        if (d.size > 1) {
          domains.set(lit.index, new Domain([0, 0]));
          this._stats.numBooleanPropagations++;
          changed = true;
        }
      }
      return changed ? 'CHANGED' : 'CONSISTENT';
    }

    return 'CONSISTENT';
  }

  private _propagateExactlyOne(ct: ExactlyOneConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    let trueCount = 0;
    let falseCount = 0;
    let lastUnassigned: BoolVar | null = null;

    for (const lit of ct.literals) {
      const d = domains.get(lit.index)!;
      if (d.min === 1) trueCount++;
      else if (d.max === 0) falseCount++;
      else lastUnassigned = lit;
    }

    if (trueCount > 1) return 'INFEASIBLE';
    if (falseCount === ct.literals.length) return 'INFEASIBLE';

    if (trueCount === 1) {
      let changed = false;
      for (const lit of ct.literals) {
        const d = domains.get(lit.index)!;
        if (d.size > 1) {
          domains.set(lit.index, new Domain([0, 0]));
          this._stats.numBooleanPropagations++;
          changed = true;
        }
      }
      return changed ? 'CHANGED' : 'CONSISTENT';
    }

    if (falseCount === ct.literals.length - 1 && lastUnassigned) {
      domains.set(lastUnassigned.index, new Domain([1, 1]));
      this._stats.numBooleanPropagations++;
      return 'CHANGED';
    }

    return 'CONSISTENT';
  }

  /**
   * Propagate BoolXor: odd number of literals must be true
   */
  private _propagateBoolXor(ct: BoolXorConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    let trueCount = 0;
    let falseCount = 0;
    const unassigned: BoolVar[] = [];

    for (const lit of ct.literals) {
      const d = domains.get(lit.index)!;
      if (d.min === 1) trueCount++;
      else if (d.max === 0) falseCount++;
      else unassigned.push(lit);
    }

    // If all assigned, check XOR
    if (unassigned.length === 0) {
      return trueCount % 2 === 1 ? 'CONSISTENT' : 'INFEASIBLE';
    }

    // If only one unassigned, we can deduce its value
    if (unassigned.length === 1) {
      // XOR: trueCount + (unassigned ? 1 : 0) must be odd
      const needed = (trueCount % 2 === 0) ? 1 : 0; // need odd total
      domains.set(unassigned[0].index, new Domain([needed, needed]));
      this._stats.numBooleanPropagations++;
      return 'CHANGED';
    }

    return 'CONSISTENT';
  }

  private _propagateImplication(ct: ImplicationConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    const aDomain = domains.get(ct.a.index)!;
    const bDomain = domains.get(ct.b.index)!;

    let changed = false;

    // If a is true, b must be true
    if (aDomain.min === 1) {
      if (bDomain.max === 0) return 'INFEASIBLE';
      if (bDomain.size > 1) {
        domains.set(ct.b.index, new Domain([1, 1]));
        this._stats.numBooleanPropagations++;
        changed = true;
      }
    }

    // If b is false, a must be false
    if (bDomain.max === 0) {
      if (aDomain.min === 1) return 'INFEASIBLE';
      if (aDomain.size > 1) {
        domains.set(ct.a.index, new Domain([0, 0]));
        this._stats.numBooleanPropagations++;
        changed = true;
      }
    }

    return changed ? 'CHANGED' : 'CONSISTENT';
  }

  private _propagateMaxEquality(ct: MaxEqualityConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    const targetDomain = domains.get(ct.target.index)!;

    let maxPossible = -Infinity;
    let allAssigned = true;

    for (const expr of ct.expressions) {
      const exprDomain = this._getExpressionDomain(expr, domains);
      maxPossible = Math.max(maxPossible, exprDomain.max);
      if (exprDomain.size > 1) allAssigned = false;
    }

    if (targetDomain.min > maxPossible) return 'INFEASIBLE';

    if (allAssigned && targetDomain.size === 1) {
      const targetVal = targetDomain.min;
      let maxVal = -Infinity;
      for (const expr of ct.expressions) {
        const val = this._evaluateExpression(expr, domains);
        if (val !== null) {
          maxVal = Math.max(maxVal, val);
        }
      }
      if (targetVal !== maxVal) return 'INFEASIBLE';
    }

    return 'CONSISTENT';
  }

  private _propagateMinEquality(ct: MinEqualityConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    const targetDomain = domains.get(ct.target.index)!;

    let minPossible = Infinity;
    let allAssigned = true;

    for (const expr of ct.expressions) {
      const exprDomain = this._getExpressionDomain(expr, domains);
      minPossible = Math.min(minPossible, exprDomain.min);
      if (exprDomain.size > 1) allAssigned = false;
    }

    if (targetDomain.max < minPossible) return 'INFEASIBLE';

    if (allAssigned && targetDomain.size === 1) {
      const targetVal = targetDomain.min;
      let minVal = Infinity;
      for (const expr of ct.expressions) {
        const val = this._evaluateExpression(expr, domains);
        if (val !== null) {
          minVal = Math.min(minVal, val);
        }
      }
      if (targetVal !== minVal) return 'INFEASIBLE';
    }

    return 'CONSISTENT';
  }

  /**
   * Propagate Element constraint: vars[index] == target
   */
  private _propagateElement(ct: ElementConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    const indexDomain = domains.get(ct.indexVar.index)!;
    const targetDomain = domains.get(ct.target.index)!;

    let changed = false;

    // Compute possible target values based on index domain
    const possibleValues = new Set<number>();
    for (const idx of indexDomain.values()) {
      if (idx >= 0 && idx < ct.vars.length) {
        const varD = domains.get(ct.vars[idx].index)!;
        for (const v of varD.values()) {
          possibleValues.add(v);
        }
      }
    }

    // Filter target domain to only possible values
    if (targetDomain.size > 1) {
      const newIntervals: [number, number][] = [];
      for (const [start, end] of targetDomain.intervals) {
        for (let v = start; v <= end; v++) {
          if (possibleValues.has(v)) {
            // Found a possible value in this interval
            // For simplicity, keep the whole interval if any value is possible
            newIntervals.push([start, end]);
            break;
          }
        }
      }
      if (newIntervals.length === 0) return 'INFEASIBLE';
      const newTargetDomain = new Domain(newIntervals);
      if (newTargetDomain.size < targetDomain.size) {
        domains.set(ct.target.index, newTargetDomain);
        changed = true;
      }
    }

    // Filter index domain: remove indices whose vars can't match target
    if (targetDomain.size === 1) {
      const targetVal = targetDomain.min;
      const newIntervals: [number, number][] = [];
      for (const [start, end] of indexDomain.intervals) {
        let intervalStart = -1;
        for (let idx = start; idx <= end; idx++) {
          if (idx >= 0 && idx < ct.vars.length) {
            const varD = domains.get(ct.vars[idx].index)!;
            if (varD.contains(targetVal)) {
              if (intervalStart === -1) intervalStart = idx;
            } else {
              if (intervalStart !== -1) {
                newIntervals.push([intervalStart, idx - 1]);
                intervalStart = -1;
              }
            }
          }
        }
        if (intervalStart !== -1) {
          newIntervals.push([intervalStart, end]);
        }
      }
      if (newIntervals.length === 0) return 'INFEASIBLE';
      const newIndexDomain = new Domain(newIntervals);
      if (newIndexDomain.size < indexDomain.size) {
        domains.set(ct.indexVar.index, newIndexDomain);
        changed = true;
      }
    }

    return changed ? 'CHANGED' : 'CONSISTENT';
  }

  /**
   * Propagate AbsEquality: target == |expr|
   */
  private _propagateAbsEquality(ct: AbsEqualityConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    const targetDomain = domains.get(ct.target.index)!;
    const exprDomain = this._getExpressionDomain(ct.expr, domains);

    // target must be >= 0
    if (targetDomain.min < 0) {
      const newTargetDomain = targetDomain.greaterOrEqual(0);
      if (newTargetDomain.isEmpty) return 'INFEASIBLE';
      if (newTargetDomain.size < targetDomain.size) {
        domains.set(ct.target.index, newTargetDomain);
        return 'CHANGED';
      }
    }

    // target range must intersect with [|expr_min|, |expr_max|] (rough bounds)
    const absMin = Math.min(Math.abs(exprDomain.min), Math.abs(exprDomain.max));
    const absMax = Math.max(Math.abs(exprDomain.min), Math.abs(exprDomain.max));

    // If expr can be both positive and negative, absMin might be 0
    const exprCanBePositive = exprDomain.max >= 0;
    const exprCanBeNegative = exprDomain.min <= 0;

    let effectiveAbsMin = absMax;
    if (exprCanBePositive && exprCanBeNegative) {
      effectiveAbsMin = 0;
    } else if (exprCanBePositive) {
      effectiveAbsMin = Math.max(0, exprDomain.min);
    } else {
      effectiveAbsMin = Math.abs(exprDomain.max);
    }

    let changed = false;

    // Tighten target >= effectiveAbsMin
    if (targetDomain.min < effectiveAbsMin) {
      const newTarget = targetDomain.greaterOrEqual(effectiveAbsMin);
      if (newTarget.isEmpty) return 'INFEASIBLE';
      if (newTarget.size < targetDomain.size) {
        domains.set(ct.target.index, newTarget);
        changed = true;
      }
    }

    // Tighten target <= absMax
    const currentTarget = domains.get(ct.target.index)!;
    if (currentTarget.max > absMax) {
      const newTarget = currentTarget.lessOrEqual(absMax);
      if (newTarget.isEmpty) return 'INFEASIBLE';
      if (newTarget.size < currentTarget.size) {
        domains.set(ct.target.index, newTarget);
        changed = true;
      }
    }

    // If expr is always non-negative: target = expr, so tighten expr >= target.min
    if (exprCanBePositive && !exprCanBeNegative) {
      const currentTarget2 = domains.get(ct.target.index)!;
      const exprVar = ct.expr.vars.length === 1 && ct.expr.coeffs[0] === 1 && ct.expr.offset === 0
        ? ct.expr.vars[0] : null;
      if (exprVar) {
        const exprVarDomain = domains.get(exprVar.index);
        if (exprVarDomain) {
          const newExprDomain = exprVarDomain.greaterOrEqual(currentTarget2.min).lessOrEqual(currentTarget2.max);
          if (newExprDomain.isEmpty) return 'INFEASIBLE';
          if (newExprDomain.size < exprVarDomain.size) {
            domains.set(exprVar.index, newExprDomain);
            changed = true;
          }
        }
      }
    }

    // If expr is always non-positive: target = -expr, so tighten -expr in [target.min, target.max]
    if (!exprCanBePositive && exprCanBeNegative) {
      const currentTarget2 = domains.get(ct.target.index)!;
      const exprVar = ct.expr.vars.length === 1 && ct.expr.coeffs[0] === 1 && ct.expr.offset === 0
        ? ct.expr.vars[0] : null;
      if (exprVar) {
        const exprVarDomain = domains.get(exprVar.index);
        if (exprVarDomain) {
          // target = -expr → expr = -target → expr in [-target.max, -target.min]
          const newExprDomain = exprVarDomain.greaterOrEqual(-currentTarget2.max).lessOrEqual(-currentTarget2.min);
          if (newExprDomain.isEmpty) return 'INFEASIBLE';
          if (newExprDomain.size < exprVarDomain.size) {
            domains.set(exprVar.index, newExprDomain);
            changed = true;
          }
        }
      }
    }

    return changed ? 'CHANGED' : 'CONSISTENT';
  }

  /**
   * Propagate AllowedAssignments: filter domains based on allowed tuples
   */
  private _propagateAllowedAssignments(ct: AllowedAssignmentsConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    // For each variable, compute which values appear in at least one allowed tuple
    let changed = false;

    for (let i = 0; i < ct.vars.length; i++) {
      const v = ct.vars[i];
      const d = domains.get(v.index)!;
      if (d.size <= 1) continue;

      const possibleValues = new Set<number>();
      for (const tuple of ct.tuples) {
        // Check if this tuple is compatible with all other variables' domains
        let compatible = true;
        for (let j = 0; j < ct.vars.length; j++) {
          if (j === i) continue;
          const otherD = domains.get(ct.vars[j].index)!;
          if (!otherD.contains(tuple[j])) {
            compatible = false;
            break;
          }
        }
        if (compatible) {
          possibleValues.add(tuple[i]);
        }
      }

      // Filter variable domain to only possible values
      const newIntervals: [number, number][] = [];
      for (const [start, end] of d.intervals) {
        let intervalStart = -1;
        for (let val = start; val <= end; val++) {
          if (possibleValues.has(val)) {
            if (intervalStart === -1) intervalStart = val;
          } else {
            if (intervalStart !== -1) {
              newIntervals.push([intervalStart, val - 1]);
              intervalStart = -1;
            }
          }
        }
        if (intervalStart !== -1) {
          newIntervals.push([intervalStart, end]);
        }
      }

      if (newIntervals.length === 0) return 'INFEASIBLE';
      const newDomain = new Domain(newIntervals);
      if (newDomain.size < d.size) {
        domains.set(v.index, newDomain);
        changed = true;
      }
    }

    return changed ? 'CHANGED' : 'CONSISTENT';
  }

  // ============================================================================
  // Scheduling Propagation
  // ============================================================================

  /**
   * Adapter: delegate linear constraint propagation to _propagateLinear.
   * Converts the simple (vars, coeffs, lb, ub) interface to a LinearConstraint.
   */
  private _propagateLinearCallback(
    vars: IntVar[],
    coeffs: number[],
    lb: number,
    ub: number,
    domains: Map<number, Domain>
  ): PropagationResult {
    const bounds = new Domain([lb, ub]);
    const ct = new LinearConstraint(-1, vars, coeffs, bounds);
    return this._propagateLinear(ct, domains);
  }

  /**
   * Orchestrate NoOverlap propagation: Simple Precedences → Detectable Precedences → Not-Last → Edge-Finding
   */
  private _propagateNoOverlapConstraint(
    ct: NoOverlapConstraint,
    domains: Map<number, Domain>
  ): PropagationResult {
    const linFn: LinearPropagateFn = (vars, coeffs, lb, ub, d) =>
      this._propagateLinearCallback(vars, coeffs, lb, ub, d);

    const result = propagateNoOverlap(ct, domains, linFn);
    if (result === 'INFEASIBLE') return 'INFEASIBLE';

    const result2 = propagateNoOverlapDetectable(ct, domains, linFn);
    if (result2 === 'INFEASIBLE') return 'INFEASIBLE';

    const result3 = propagateNoOverlapNotLast(ct, domains, linFn);
    if (result3 === 'INFEASIBLE') return 'INFEASIBLE';

    const result4 = propagateNoOverlapEdgeFinding(ct, domains, linFn);
    if (result4 === 'INFEASIBLE') return 'INFEASIBLE';

    if (result === 'CHANGED' || result2 === 'CHANGED' || result3 === 'CHANGED' || result4 === 'CHANGED') {
      return 'CHANGED';
    }
    return 'CONSISTENT';
  }

  /**
   * Orchestrate Cumulative propagation: Time-Table → Edge-Finding
   */
  private _propagateCumulativeConstraint(
    ct: CumulativeConstraint,
    domains: Map<number, Domain>
  ): PropagationResult {
    const linFn: LinearPropagateFn = (vars, coeffs, lb, ub, d) =>
      this._propagateLinearCallback(vars, coeffs, lb, ub, d);

    const result = propagateCumulativeTimeTable(ct, domains, linFn);
    if (result === 'INFEASIBLE') return 'INFEASIBLE';

    const result2 = propagateCumulativeEdgeFinding(ct, domains, linFn);
    if (result2 === 'INFEASIBLE') return 'INFEASIBLE';

    if (result === 'CHANGED' || result2 === 'CHANGED') {
      return 'CHANGED';
    }
    return 'CONSISTENT';
  }

  /**
   * Orchestrate Circuit propagation: degree → path tracing → subtour detection
   */
  private _propagateCircuitConstraint(
    ct: CircuitConstraint,
    domains: Map<number, Domain>
  ): PropagationResult {
    const boolFn = (varIndex: number, value: boolean, d: Map<number, Domain>): PropagationResult => {
      try {
        const current = d.get(varIndex);
        if (!current) return 'CONSISTENT';
        const target = value ? 1 : 0;
        if (current.size === 1 && current.min === target) return 'CONSISTENT';
        const newDomain = current.intersection(new Domain([target, target]));
        if (newDomain.isEmpty) return 'INFEASIBLE';
        d.set(varIndex, newDomain);
        return 'CHANGED';
      } catch {
        return 'INFEASIBLE';
      }
    };

    return propagateCircuit(ct, domains, boolFn);
  }

  /**
   * Orchestrate MultipleCircuit propagation
   */
  private _propagateMultipleCircuitConstraint(
    ct: MultipleCircuitConstraint,
    domains: Map<number, Domain>
  ): PropagationResult {
    const boolFn = (varIndex: number, value: boolean, d: Map<number, Domain>): PropagationResult => {
      try {
        const current = d.get(varIndex);
        if (!current) return 'CONSISTENT';
        const target = value ? 1 : 0;
        if (current.size === 1 && current.min === target) return 'CONSISTENT';
        const newDomain = current.intersection(new Domain([target, target]));
        if (newDomain.isEmpty) return 'INFEASIBLE';
        d.set(varIndex, newDomain);
        return 'CHANGED';
      } catch {
        return 'INFEASIBLE';
      }
    };

    return propagateMultipleCircuit(ct, domains, boolFn);
  }

  /**
   * Orchestrate Reservoir propagation: forward/backward sweep + active literal propagation
   */
  private _propagateReservoirConstraint(
    ct: ReservoirConstraint,
    domains: Map<number, Domain>
  ): PropagationResult {
    const linFn: LinearPropagateFn = (vars, coeffs, lb, ub, d) =>
      this._propagateLinearCallback(vars, coeffs, lb, ub, d);

    return propagateReservoir(ct, domains, linFn);
  }

  /**
   * Orchestrate NoOverlap2D propagation: pairwise restriction + energy-based conflict
   */
  private _propagateNoOverlap2DConstraint(
    ct: NoOverlap2DConstraint,
    domains: Map<number, Domain>
  ): PropagationResult {
    const linFn: LinearPropagateFn = (vars, coeffs, lb, ub, d) =>
      this._propagateLinearCallback(vars, coeffs, lb, ub, d);

    return propagateNoOverlap2D(ct, domains, linFn);
  }

  // ============================================================================
  // Expression Utilities
  // ============================================================================

  /**
   * Get the domain of a linear expression
   */
  private _getExpressionDomain(expr: LinearExpr, domains: Map<number, Domain>): Domain {
    if (expr.vars.length === 0) {
      return new Domain([expr.offset, expr.offset]);
    }

    let min = expr.offset;
    let max = expr.offset;

    for (let i = 0; i < expr.vars.length; i++) {
      const v = expr.vars[i];
      const c = expr.coeffs[i];
      const d = domains.get(v.index)!;

      if (c > 0) {
        min += c * d.min;
        max += c * d.max;
      } else if (c < 0) {
        min += c * d.max;
        max += c * d.min;
      }
    }

    return new Domain([min, max]);
  }

  /**
   * Evaluate a linear expression
   */
  private _evaluateExpression(expr: LinearExpr, domains: Map<number, Domain>): number | null {
    let result = expr.offset;

    for (let i = 0; i < expr.vars.length; i++) {
      const d = domains.get(expr.vars[i].index);
      if (!d || d.size !== 1) return null;
      result += expr.coeffs[i] * d.min;
    }

    return result;
  }

  // ============================================================================
  // Results
  // ============================================================================

  /**
   * Get the solution value for a variable
   */
  getValue(varIndex: number): number {
    if (!this._solution) {
      throw new Error('No solution available');
    }
    const value = this._solution.get(varIndex);
    if (value === undefined) {
      throw new Error(`Variable with index ${varIndex} not found in solution`);
    }
    return value;
  }

  /**
   * Get all solutions
   */
  getAllSolutions(): Map<number, number>[] {
    return this._allSolutions;
  }

  /**
   * Get solver statistics
   */
  get stats(): SolverStats {
    return this._stats;
  }

  /**
   * Get the best objective bound found during search
   *
   * For optimization problems, this is the best bound on the objective
   * value that could be achieved. Combined with the best objective value,
   * this gives the optimality gap: |objective - bound|.
   */
  get bestObjective(): number | null {
    return this._bestObjective;
  }

  /**
   * Set maximum time in seconds
   */
  set maxTime(seconds: number) {
    this._maxTime = seconds;
  }

  /**
   * Set whether to enumerate all solutions
   */
  set enumerateAll(value: boolean) {
    this._enumerateAll = value;
  }

  /**
   * Stop the search
   */
  stop(): void {
    this._stopped = true;
  }
}
