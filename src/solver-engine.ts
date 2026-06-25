/**
 * CP-SAT TypeScript Implementation
 * Solver Engine - Backtracking search with constraint propagation and branch-and-bound
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Domain, LinearExpr, CpSolverStatus, BoolVar, IntVar, SolverParameters, SearchProgressInfo } from './types';
import { TrailMap, ReasonTrail } from './trail';
import { IntervalVarImpl } from './variables';
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
import type { SearchProgressCallback } from './callback';
import { presolveModel, computeDerivedValue, DerivedVar } from './presolve';
import { detectPackingConstraints, computeLpObjectiveBound, EMPTY_CLASSIFICATION } from './lp-bounds';
import type { PackingClassification } from './lp-bounds';
import { ClauseDatabase, litVar, isLitSatisfied } from './clause-engine';
import type { PropagationOutcome } from './clause-engine';
import { AssignmentTrail } from './assignment-trail';
import { analyzeConflict } from './conflict-analysis';
import { BoundLiteralRegistry } from './bound-literal-registry';
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
import { propagateAutomaton } from './automaton-propagation';

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
  numLearnedClauses: number;
  numIntBoundLiterals: number;
}

// ============================================================================
// Solution Callback Interface
// ============================================================================

export interface SolutionCallback {
  onSolution(): boolean; // return true to continue, false to stop
}

// ============================================================================
// Luby Sequence Generator
// ============================================================================

/**
 * Compute the i-th element of the Luby sequence.
 * The Luby sequence is defined as:
 *   luby(i) = luby(k) * luby(i - 2^k + 1) where 2^k <= i < 2^(k+1)
 * with luby(0) = 1.
 *
 * This produces the sequence: 1, 1, 2, 1, 1, 2, 4, 1, 1, 2, 1, 1, 2, 4, 8, ...
 * which has the property that the sum of the first n elements is O(n * log(n)).
 */
function luby(i: number): number {
  // Find the largest power of 2 that is <= i+1
  let size = 1;
  const index = i + 1;
  while (size < index) {
    size *= 2;
  }
  // Now size/2 <= index <= size
  while (size > index) {
    size /= 2;
  }
  // Now size <= index < 2*size
  if (index === size) {
    return size / 2;
  }
  return luby(i - size + 1);
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
  private _lastPresolveDomains: Map<number, Domain> | null = null;

  // Propagation queue: reverse index (variable → constraint indices that depend on it)
  private _varToConstraints: Map<number, number[]> | null = null;

  // Reason tracking for UNSAT core extraction
  private _reasonTrail: ReasonTrail = new ReasonTrail();
  private _infeasibleAfterAssumptions: boolean = false;

  // Search progress reporting
  private _progressCallback: SearchProgressCallback | null = null;
  private _lastLogTime: number = 0;
  private _logIntervalMs: number = 1000;

  // Restart state
  private _restartCount: number = 0;
  private _restartBaseInterval: number = 256;
  private _restartEnabled: boolean = false;

  // Random state (LCG)
  private _randomState: number = 1;

  // LNS state
  private _lnsEnabled: boolean = false;
  private _lnsMaxIterations: number = 100;
  private _lnsNeighborhoodSize: number = 0.5;
  private _lnsIteration: number | null = null;

  // LP-relaxation bound state (detection is cached once per solve() by _runPresolve)
  private _lpBoundsEnabled: boolean = false;
  private _packingClassification: PackingClassification = EMPTY_CLASSIFICATION;

  // LCG clause engine state (Phase 1: clause DB + 2-watched-literal unit propagation)
  private _lcgEnabled: boolean = false;
  private _clauseDb: ClauseDatabase | null = null;
  private _boolVarSet: Set<number> = new Set();
  // LCG Phase 2: CDCL assignment trail + conflict learning state.
  private _assignTrail: AssignmentTrail = new AssignmentTrail();
  /** Conflict explanation literals (all false) from the last conflict, or null if not analyzable. */
  private _lastConflictLiterals: number[] | null = null;
  /** Set true when conflict analysis derives the empty clause (root UNSAT). */
  private _rootUnsat = false;
  // LCG Phase 3: integer bound-literal registry (x ≥ k / x ≤ k as synthetic bools).
  private _boundLitReg: BoundLiteralRegistry | null = null;
  // Reused callbacks for the clause engine (avoid per-call closure allocation).
  // Phase 3: _isBoolVar also covers synthetic bound-literal indices so the clause
  // engine seeds + propagates them correctly.
  private readonly _isBoolVar = (idx: number): boolean =>
    this._boolVarSet.has(idx) || (this._boundLitReg?.isBoundLit(idx) ?? false);
  private readonly _onClauseAssign = (lit: number): void => {
    this._stats.numBooleanPropagations++;
    this._assignTrail.recordPropagation(lit);
  };

  /**
   * Record the reason for a Boolean-family propagation. When LCG is on, store a
   * clausal explanation (lazyClause) + record on the assignment trail (for 1-UIP
   * resolution). When off, store the legacy constraint-index reason (for UNSAT
   * cores). `explanation` is the FULL clause including the forced literal.
   */
  private _recordBoolReason(
    varIdx: number,
    value: 0 | 1,
    constraintIndex: number,
    explanation: number[]
  ): void {
    this._stats.numBooleanPropagations++;
    if (this._lcgEnabled) {
      this._reasonTrail.setReason(varIdx, { type: 'lazyClause', literals: explanation });
      this._assignTrail.recordPropagation(value === 1 ? varIdx : -(varIdx + 1));
    } else {
      this._reasonTrail.setReason(varIdx, { type: 'propagation', constraintIndex });
    }
  }

  /** Capture a Boolean-family conflict explanation (for 1-UIP analysis). */
  private _recordBoolConflict(explanation: number[]): void {
    if (this._lcgEnabled) this._lastConflictLiterals = explanation;
  }

  constructor(model: CpModel, parameters: SolverParameters = {}) {
    this._model = model;
    this._parameters = parameters;
    this._logIntervalMs = parameters.progressCallbackIntervalMs ?? 1000;
    this._restartEnabled = parameters.restartStrategy === 'luby';
    this._restartBaseInterval = parameters.restartBaseInterval ?? 256;
    this._randomState = parameters.randomSeed ?? 1;
    this._lnsEnabled = parameters.enableLNS ?? false;
    this._lnsMaxIterations = parameters.lnsMaxIterations ?? 100;
    this._lnsNeighborhoodSize = parameters.lnsNeighborhoodSize ?? 0.5;
    this._lpBoundsEnabled = parameters.enableLpBounds ?? false;
    this._lcgEnabled = parameters.enableLcg ?? false;
    this._stats = {
      numConflicts: 0,
      numBranches: 0,
      numBooleanPropagations: 0,
      numIntegerPropagations: 0,
      numSolutions: 0,
      wallTime: 0,
      presolveTime: 0,
      searchTime: 0,
      numLearnedClauses: 0,
      numIntBoundLiterals: 0,
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
   * Solve the model.
   *
   * @param options - Optional warm-restart options:
   *   - `initialDomains`: pre-set domains from a previous solve (warm start)
   *   - `initialBestObjective`: incumbent bound from a previous solve (enables B&B pruning from node 0)
   */
  solve(
    callback?: SolutionCallback,
    progressCallback?: SearchProgressCallback,
    options?: { initialDomains?: Map<number, Domain>; initialBestObjective?: number | null }
  ): CpSolverStatus {
    this._callback = callback || null;
    this._progressCallback = progressCallback || null;
    this._startTime = Date.now();
    this._lastLogTime = 0;
    this._stopped = false;
    this._reasonTrail = new ReasonTrail();
    this._infeasibleAfterAssumptions = false;
    this._solution = null;
    this._allSolutions = [];
    this._bestObjective = options?.initialBestObjective ?? null;
    this._searchExhausted = true;
    this._restartCount = 0;
    this._packingClassification = EMPTY_CLASSIFICATION;
    this._assignTrail.reset();
    this._lastConflictLiterals = null;
    this._rootUnsat = false;
    this._stats = {
      numConflicts: 0,
      numBranches: 0,
      numBooleanPropagations: 0,
      numIntegerPropagations: 0,
      numSolutions: 0,
      wallTime: 0,
      presolveTime: 0,
      searchTime: 0,
      numLearnedClauses: 0,
      numIntBoundLiterals: 0,
    };

    // Validate model
    const validationError = this._model.validate();
    if (validationError) {
      return CpSolverStatus.MODEL_INVALID;
    }

    // Initialize domains — use warm-start domains if provided, otherwise fresh
    const domains = options?.initialDomains
      ? new TrailMap([...options.initialDomains])
      : this._initializeDomains();

    // Apply assumptions BEFORE presolve: they are hard constraints, so the
    // entire presolve + search pipeline must be consistent with them. Applying
    // them after presolve would let presolve remove constraints the assumption
    // contradicts. A contradictory assumption (vs the initial domain) is
    // infeasible.
    if (!this._applyAssumptions(domains)) {
      this._stats.wallTime = (Date.now() - this._startTime) / 1000;
      return CpSolverStatus.INFEASIBLE;
    }

    // Run presolve
    const presolveStart = Date.now();
    const presolveResult = this._runPresolve(domains);
    this._stats.presolveTime = (Date.now() - presolveStart) / 1000;

    // Store presolve domains for warm restart
    this._lastPresolveDomains = new Map(presolveResult.domains);

    if (presolveResult.status === 'INFEASIBLE') {
      if (this._model.assumptions.length > 0) this._infeasibleAfterAssumptions = true;
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

    // Build reverse index for propagation queue optimization
    this._buildVarToConstraintsIndex();

    // LCG: set up the clause database once per solve (post-presolve so unit
    // clauses force against the tightened domains). When enableLcg is off OR
    // there are no clauses, the engine stays null (zero overhead); clauses are
    // still checked at solution completion via _checkAllConstraints.
    if (this._lcgEnabled && this._model.clauses.length > 0) {
      this._clauseDb = new ClauseDatabase();
      this._boolVarSet = new Set(this._model.registry.allBoolVars.map(v => v.index));
      for (const lits of this._model.clauses) {
        this._clauseDb.addClause(lits);
      }
      // Phase 2: initialize the assignment trail at decision level 0 (root
      // facts), so setup's unit-forced literals are recorded at level 0.
      this._assignTrail.reset();
      this._assignTrail.pushLevel();
      const setupResult = this._clauseDb.setup(
        presolveResult.domains,
        this._reasonTrail,
        this._isBoolVar,
        this._onClauseAssign
      );
      if (setupResult === 'INFEASIBLE') {
        this._stats.wallTime = (Date.now() - this._startTime) / 1000;
        return CpSolverStatus.INFEASIBLE;
      }
    } else {
      this._clauseDb = null;
    }

    // LCG Phase 3: initialize the bound-literal registry when LCG is active.
    // The registry's synthetic indices start above all real variable indices so
    // they are disjoint from model variables.
    if (this._lcgEnabled) {
      let maxVarIndex = 0;
      for (const [idx] of presolveResult.domains) {
        if (idx > maxVarIndex) maxVarIndex = idx;
      }
      this._boundLitReg = new BoundLiteralRegistry(maxVarIndex + 1);
    } else {
      this._boundLitReg = null;
    }

    // Start search (with optional restarts and LNS)
    const searchStart = Date.now();
    let status: CpSolverStatus;

    if (this._lnsEnabled && this._hasObjective) {
      // LNS mode: initial B&B solve followed by neighborhood search iterations
      status = this._searchWithLNS(presolveResult.domains);
    } else if (this._restartEnabled && this._hasObjective) {
      // Search with Luby restarts — only for optimization problems
      status = this._searchWithRestarts(presolveResult.domains);
    } else {
      // Standard single-shot search
      status = this._search(presolveResult.domains, 0);
    }
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
      if (this._model.assumptions.length > 0) this._infeasibleAfterAssumptions = true;
      return CpSolverStatus.INFEASIBLE;
    }

    return status;
  }

  /**
   * Initialize domains for all variables
   */
  private _initializeDomains(): TrailMap {
    const domains = new TrailMap();

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
  private _runPresolve(domains: TrailMap): {
    status: 'FEASIBLE' | 'INFEASIBLE' | 'OPTIMAL';
    domains: TrailMap;
  } {
    const result = presolveModel(this._model, domains);

    this._activeConstraints = result.activeConstraints;
    this._derivedVars = result.derivedVars;

    // Detect packing constraints once per solve for the LP-relaxation bound.
    // Runs after presolve so removed constraints are skipped; only meaningful
    // for maximize objectives (the fractional-knapsack bound is an upper bound).
    if (this._lpBoundsEnabled && this._isMaximize && this._objectiveExpr) {
      this._packingClassification = detectPackingConstraints(
        this._model.constraints,
        i => this._activeConstraints !== null && this._activeConstraints.has(i)
      );
    } else {
      this._packingClassification = EMPTY_CLASSIFICATION;
    }

    // presolveModel mutates `domains` in place and returns the same object.
    return { status: result.status, domains };
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
   * Apply assumption literals as hard constraints. Each assumption is either:
   *   - A BoolVar (positive literal): force the variable to 1
   *   - A number (negated literal, -(index+1)): force the underlying variable to 0
   *
   * Returns false if an assumption contradicts the current domains
   * (model infeasible under the assumptions).
   */
  private _applyAssumptions(domains: Map<number, Domain>): boolean {
    for (let i = 0; i < this._model.assumptions.length; i++) {
      const lit = this._model.assumptions[i];

      // Decode the literal: positive index → force to 1; negative → force to 0
      let varIndex: number;
      let targetValue: number;
      if (typeof lit === 'number') {
        // Negated literal: -(index + 1) → actual var index, force to 0
        varIndex = -(lit + 1);
        targetValue = 0;
      } else {
        // Positive BoolVar: force to 1
        varIndex = lit.index;
        targetValue = 1;
      }

      const domain = domains.get(varIndex);
      if (!domain) continue;

      // Always record the assumption reason for core extraction,
      // even if the domain already contains the assumed value.
      this._reasonTrail.setReason(varIndex, { type: 'assumption', assumptionIndex: i });

      if (!domain.contains(targetValue)) {
        // Assumption contradicts current domain
        this._infeasibleAfterAssumptions = true;
        return false;
      }
      if (domain.min !== targetValue || domain.max !== targetValue) {
        domains.set(varIndex, domain.fixValue(targetValue));
      }
    }
    return true;
  }

  /**
   * Compute the objective value from a complete solution
   */
  private _computeObjective(domains: Map<number, Domain>): number | null {
    if (!this._objectiveExpr) return null;
    return this._evaluateExpression(this._objectiveExpr, domains);
  }

  /**
   * Compute the objective bound (min or max possible) from current domains.
   *
   * When `strong` is true (used at the post-propagation prune site and in
   * throttled progress logging) and LP bounds are enabled for a maximize
   * objective, tighten the upper bound via the fractional-knapsack LP
   * relaxation. The cheap interval-arithmetic bound is always computed first,
   * so the result is never looser than today's behavior.
   *
   * `strong` is only passed at the post-propagation site on purpose: the LP
   * bound is O(n log n) per packing constraint, while the interval bound is
   * O(objective terms). Running the strong bound pre-propagation would slow
   * every node for little gain, since domains there are looser.
   */
  private _computeObjectiveBound(
    domains: Map<number, Domain>,
    strong: boolean = false
  ): { min: number; max: number } | null {
    if (!this._objectiveExpr) return null;
    const exprDomain = this._getExpressionDomain(this._objectiveExpr, domains);
    const min = exprDomain.min;
    let max = exprDomain.max;
    if (strong && this._lpBoundsEnabled && this._isMaximize) {
      const lp = computeLpObjectiveBound({
        objective: this._objectiveExpr,
        maximize: true,
        domains,
        classification: this._packingClassification,
      });
      if (lp !== null && lp < max) {
        max = lp; // tighten the upper bound only (never unsound: lp ≥ true optimum)
      }
    }
    return { min, max };
  }

  /**
   * Check if the current objective bound can still improve on the incumbent.
   * `strong` forwards the LP-relaxation tightening request to _computeObjectiveBound.
   */
  private _canImprove(domains: Map<number, Domain>, strong: boolean = false): boolean {
    if (!this._hasObjective || this._bestObjective === null) return true;

    const bound = this._computeObjectiveBound(domains, strong);
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
  private _search(domains: TrailMap, depth: number): CpSolverStatus {
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

    // LCG: root UNSAT short-circuit (1-UIP derived the empty clause at level 0).
    if (this._rootUnsat) {
      return CpSolverStatus.INFEASIBLE;
    }

    // Report search progress (throttled by wall-clock time)
    this._maybeLogProgress(depth, domains);

    // Branch-and-bound: prune if we can't improve on incumbent
    if (this._hasObjective && !this._canImprove(domains)) {
      this._stats.numConflicts++;
      return CpSolverStatus.INFEASIBLE;
    }

    // Propagate constraints in place. The trail records this node's mutations
    // and the try/finally restores them on EVERY return path — replacing the
    // former per-node domain clone (and the per-value clone below).
    domains.pushLevel();
    this._reasonTrail.pushLevel();
    try {
      // Update derived variables' domains from base variable domains
      this._updateDerivedDomains(domains);

      const propagationResult = this._propagate(domains);

      if (!propagationResult) {
        this._stats.numConflicts++;
        // LCG Phase 2: analyze the conflict (1-UIP) and learn a clause (ChronoBT).
        if (this._lcgEnabled) this._analyzeAndLearn();
        return CpSolverStatus.INFEASIBLE;
      }

      // Re-check after propagation — use the strong (LP) bound here, where
      // domains are tightest and pruning has the best chance to fire.
      if (this._hasObjective && !this._canImprove(domains, true)) {
        this._stats.numConflicts++;
        return CpSolverStatus.INFEASIBLE;
      }

      // Check if all variables are assigned
      if (this._isComplete(domains)) {
        // Verify all constraints are satisfied
        if (!this._checkAllConstraints(domains)) {
          this._stats.numConflicts++;
          return CpSolverStatus.INFEASIBLE;
        }

        // Found a solution!
        const objValue = this._computeObjective(domains);

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
        this._solution = this._extractSolution(domains);

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
      const varIndex = this._selectVariable(domains);
      if (varIndex === -1) {
        // Should not happen if isComplete is false
        return CpSolverStatus.INFEASIBLE;
      }

      const branchDomain = domains.get(varIndex)!;
      if (branchDomain.isEmpty) {
        this._stats.numConflicts++;
        return CpSolverStatus.INFEASIBLE;
      }

      // Try each value in the domain. Each value gets its own trail level so
      // the variable fix and the child search's mutations are undone before the
      // next value — replacing the former per-value domain clone.
      const values = branchDomain.values();

      for (const value of values) {
        if (this._stopped) {
          this._searchExhausted = false;
          break;
        }

        this._stats.numBranches++;

        domains.pushLevel();
        this._reasonTrail.pushLevel();
        if (this._lcgEnabled) this._assignTrail.pushLevel();
        try {
          // Fix this variable to the value and recurse.
          domains.set(varIndex, new Domain([value, value]));
          // LCG: record the decision literal on the assignment trail.
          if (this._lcgEnabled) {
            if (this._boolVarSet.has(varIndex)) {
              // Real boolean variable — record as positive/negative literal.
              this._assignTrail.recordDecision(value === 1 ? varIndex : -(varIndex + 1));
            } else if (this._boundLitReg && !this._boundLitReg.isBoundLit(varIndex)) {
              // Integer variable — record as a "leq" bound literal if already allocated.
              const existing = this._boundLitReg.getExisting(varIndex, value, 'leq');
              if (existing !== undefined) {
                this._assignTrail.recordDecision(existing);
              }
            }
          }
          const status = this._search(domains, depth + 1);

          if (this._rootUnsat) return CpSolverStatus.INFEASIBLE;

          if (status === CpSolverStatus.OPTIMAL) {
            if (!this._enumerateAll && !this._hasObjective) {
              return CpSolverStatus.OPTIMAL;
            }
            // Continue searching for better solutions or more solutions
          }
        } finally {
          if (this._lcgEnabled) this._assignTrail.popLevel();
          this._reasonTrail.popLevel();
          domains.popLevel();
        }
      }

      // If we found any solution, return FEASIBLE (for optimization) or INFEASIBLE
      if (this._solution) {
        return CpSolverStatus.FEASIBLE;
      }

      return CpSolverStatus.INFEASIBLE;
    } finally {
      this._reasonTrail.popLevel();
      domains.popLevel();
    }
  }

  /**
   * Search with Luby restarts. Keeps the best objective bound across restarts.
   * Only called for optimization problems when restartStrategy === 'luby'.
   */
  private _searchWithRestarts(initialDomains: TrailMap): CpSolverStatus {
    const maxRestarts = 1000; // Safety limit

    while (this._restartCount < maxRestarts) {
      // Compute the conflict threshold for this restart
      const lubyInterval = luby(this._restartCount) * this._restartBaseInterval;
      const conflictThreshold = this._stats.numConflicts + lubyInterval;

      // Run search from the initial domains (fresh copy each restart)
      const domains = new TrailMap();
      for (const [idx, domain] of initialDomains) {
        domains.set(idx, domain);
      }
      // LCG: reset the assignment trail to level 0 for the fresh search.
      if (this._lcgEnabled) {
        this._assignTrail.reset();
        this._assignTrail.pushLevel();
      }
      const status = this._search(domains, 0);

      // LCG: root UNSAT — stop immediately (no solution exists).
      if (this._rootUnsat) {
        return CpSolverStatus.INFEASIBLE;
      }

      // Check if we should stop
      if (this._stopped || this._checkTimeLimit()) {
        return this._solution ? CpSolverStatus.FEASIBLE : CpSolverStatus.UNKNOWN;
      }

      // If we found an optimal solution, we're done
      if (status === CpSolverStatus.OPTIMAL && !this._hasObjective) {
        return CpSolverStatus.OPTIMAL;
      }

      // If search exhausted all possibilities, we're done
      if (this._searchExhausted) {
        return this._solution ? CpSolverStatus.OPTIMAL : CpSolverStatus.INFEASIBLE;
      }

      // Check if we should restart (conflict threshold reached)
      if (this._stats.numConflicts >= conflictThreshold) {
        this._restartCount++;
        // Continue to next restart
      } else {
        // Search completed without hitting conflict threshold — done
        return this._solution ? CpSolverStatus.FEASIBLE : CpSolverStatus.UNKNOWN;
      }
    }

    // Hit restart limit
    return this._solution ? CpSolverStatus.FEASIBLE : CpSolverStatus.UNKNOWN;
  }

  /**
   * Search with Large Neighborhood Search (LNS).
   * 1. Initial B&B solve to find a feasible solution
   * 2. Iterate: relax a random subset of variables, re-solve with warm start
   * 3. Keep the best solution found across all iterations
   */
  private _searchWithLNS(initialDomains: TrailMap): CpSolverStatus {
    // Phase 1: Initial B&B solve
    this._lnsIteration = 0;
    const domains = new TrailMap();
    for (const [idx, domain] of initialDomains) {
      domains.set(idx, domain);
    }
    let status = this._search(domains, 0);

    // If no solution found in initial solve, LNS can't help
    if (!this._solution) {
      this._lnsIteration = null;
      return status;
    }

    // Get all non-derived variable indices for neighborhood selection
    const allVarIndices: number[] = [];
    for (const [index] of initialDomains) {
      if (this._derivedVars && this._derivedVars.has(index)) continue;
      allVarIndices.push(index);
    }

    // Phase 2: LNS iterations
    for (let iter = 1; iter <= this._lnsMaxIterations; iter++) {
      // Check time limit
      if (this._checkTimeLimit() || this._stopped) break;

      this._lnsIteration = iter;

      // Select random neighborhood: fix a subset of variables to their current values
      const neighborhoodSize = Math.max(1, Math.floor(allVarIndices.length * this._lnsNeighborhoodSize));
      const fixedVars = this._selectRandomSubset(allVarIndices, neighborhoodSize);

      // Create restricted domains: fix selected variables to their current values
      const restrictedDomains = new TrailMap();
      for (const [idx, domain] of initialDomains) {
        restrictedDomains.set(idx, domain);
      }

      // Fix the selected variables to their current solution values
      for (const varIdx of fixedVars) {
        const currentVal = this._solution?.get(varIdx);
        if (currentVal !== undefined) {
          restrictedDomains.set(varIdx, new Domain([currentVal, currentVal]));
        }
      }

      // Re-solve with warm start (preserve incumbent bound)
      const prevBest = this._bestObjective;
      const prevSolution: Map<number, number> | null = this._solution ? new Map(this._solution) : null;

      // Reset search state for this iteration
      this._searchExhausted = true;
      const iterDomains = new TrailMap();
      for (const [idx, domain] of restrictedDomains) {
        iterDomains.set(idx, domain);
      }

      // LCG: reset the assignment trail to level 0 for this LNS iteration.
      if (this._lcgEnabled) {
        this._assignTrail.reset();
        this._assignTrail.pushLevel();
      }

      status = this._search(iterDomains, 0);

      // If we found a better solution, it's already been updated in _search()
      // If we didn't find any solution in this iteration, restore the previous best
      if (!this._solution && prevSolution) {
        this._solution = prevSolution;
        this._bestObjective = prevBest;
      }
    }

    this._lnsIteration = null;
    return this._solution ? CpSolverStatus.FEASIBLE : CpSolverStatus.UNKNOWN;
  }

  /**
   * Select a random subset of `size` elements from `array`.
   * Uses Fisher-Yates shuffle for unbiased selection.
   */
  private _selectRandomSubset(array: number[], size: number): number[] {
    const result = [...array];
    const n = result.length;
    const k = Math.min(size, n);

    // Fisher-Yates partial shuffle
    for (let i = 0; i < k; i++) {
      const j = i + this._nextInt(n - i);
      [result[i], result[j]] = [result[j], result[i]];
    }

    return result.slice(0, k);
  }

  /**
   * Check if all non-derived variables are assigned
   */
  private _isComplete(domains: Map<number, Domain>): boolean {
    for (const [index, domain] of domains) {
      // Skip derived variables — they don't need to be assigned during search
      if (this._derivedVars && this._derivedVars.has(index)) continue;
      // Skip synthetic bound-literal variables — they're determined by channeling
      if (this._boundLitReg?.isBoundLit(index)) continue;
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
   * with random tie-breaking for restart diversity.
   */
  private _selectVariable(domains: Map<number, Domain>): number {
    let bestSize = Infinity;
    const candidates: number[] = [];

    for (const [index, domain] of domains) {
      if (domain.size <= 1) continue; // Already assigned
      // Skip derived variables — their values are computed from base variables
      if (this._derivedVars && this._derivedVars.has(index)) continue;
      // Skip synthetic bound-literal variables — not part of the search space
      if (this._boundLitReg?.isBoundLit(index)) continue;

      if (domain.size < bestSize) {
        bestSize = domain.size;
        candidates.length = 0;
        candidates.push(index);
      } else if (domain.size === bestSize) {
        candidates.push(index);
      }
    }

    if (candidates.length === 0) return -1;
    if (candidates.length === 1) return candidates[0];

    // Random tie-breaking for restart diversity
    return candidates[this._nextInt(candidates.length)];
  }

  /**
   * Generate a random integer in [0, n) using a simple LCG.
   * Used for random tie-breaking in variable selection.
   */
  private _nextInt(n: number): number {
    // Linear Congruential Generator (Numerical Recipes parameters)
    this._randomState = (this._randomState * 1664525 + 1013904223) & 0x7fffffff;
    return this._randomState % n;
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
   * Report search progress if enough time has elapsed.
   * Called from _search() on every recursive invocation but throttled by
   * wall-clock time (default 1 second interval).
   */
  private _maybeLogProgress(depth: number, domains: Map<number, Domain>): void {
    if (!this._parameters.logSearchProgress && !this._progressCallback) return;

    const now = Date.now();
    if (this._logIntervalMs > 0 && now - this._lastLogTime < this._logIntervalMs) return;
    this._lastLogTime = now;

    const bound = this._computeObjectiveBound(domains, true);
    const bestBound = bound ? (this._isMaximize ? bound.max : bound.min) : null;

    // Compute gap percentage: |objective - bound| / max(1, |objective|) * 100
    let gapPercent: number | null = null;
    if (this._bestObjective !== null && bestBound !== null) {
      const numerator = Math.abs(this._bestObjective - bestBound);
      const denominator = Math.max(1, Math.abs(this._bestObjective));
      gapPercent = (numerator / denominator) * 100;
    }

    const info: SearchProgressInfo = {
      wallTime: (now - this._startTime) / 1000,
      numConflicts: this._stats.numConflicts,
      numBranches: this._stats.numBranches,
      numSolutions: this._stats.numSolutions,
      bestObjectiveValue: this._bestObjective,
      bestObjectiveBound: bestBound,
      gapPercent,
      isMaximize: this._isMaximize,
      depth,
      phase: this._lnsIteration !== null ? 'LNS' : 'B&B',
      lnsIteration: this._lnsIteration,
    };

    if (this._parameters.logSearchProgress) {
      const parts = [
        `[${info.wallTime.toFixed(1)}s]`,
        `conflicts: ${info.numConflicts}`,
        `branches: ${info.numBranches}`,
        `solutions: ${info.numSolutions}`,
      ];
      if (this._hasObjective) {
        parts.push(`obj: ${info.bestObjectiveValue ?? '-'}`);
        parts.push(`bound: ${info.bestObjectiveBound ?? '-'}`);
        if (gapPercent !== null) {
          parts.push(`gap: ${gapPercent.toFixed(1)}%`);
        }
      }
      console.warn(parts.join('  '));
    }

    if (this._progressCallback) {
      this._progressCallback.onSearchProgress(info);
    }
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
    // Clauses are model constraints too: verify each is satisfied at a complete
    // assignment. (When enableLcg is on they are also propagated; this check is
    // the sound backstop and the only enforcement when enableLcg is off.)
    if (this._model.clauses.length > 0) {
      for (const lits of this._model.clauses) {
        let satisfied = false;
        for (const l of lits) {
          if (isLitSatisfied(l, domains)) {
            satisfied = true;
            break;
          }
        }
        if (!satisfied) return false;
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
   * Build reverse index: variable → constraint indices that depend on it.
   * Used by the propagation queue to only re-run affected constraints.
   */
  private _buildVarToConstraintsIndex(): void {
    const index = new Map<number, number[]>();

    for (let i = 0; i < this._model.constraints.length; i++) {
      // Skip inactive constraints
      if (this._activeConstraints && !this._activeConstraints.has(i)) continue;

      const constraint = this._model.constraints[i];
      const varIndices = this._getConstraintVarIndices(constraint);

      for (const varIdx of varIndices) {
        let list = index.get(varIdx);
        if (!list) {
          list = [];
          index.set(varIdx, list);
        }
        list.push(i);
      }
    }

    this._varToConstraints = index;
  }

  /**
   * Get variable indices involved in a constraint (for building reverse index).
   */
  private _getConstraintVarIndices(ct: Constraint): number[] {
    const indices: number[] = [];
    switch (ct.type) {
      case 'LINEAR': {
        const c = ct as LinearConstraint;
        for (const v of c.vars) indices.push(v.index);
        break;
      }
      case 'NOT_EQUAL': {
        const c = ct as NotEqualConstraint;
        for (const v of c.expr.vars) indices.push(v.index);
        break;
      }
      case 'ALL_DIFFERENT': {
        const c = ct as AllDifferentConstraint;
        for (const expr of c.expressions) {
          for (const v of expr.vars) indices.push(v.index);
        }
        break;
      }
      case 'BOOL_OR':
      case 'BOOL_AND':
      case 'AT_MOST_ONE':
      case 'EXACTLY_ONE':
      case 'BOOL_XOR': {
        const c = ct as BoolOrConstraint;
        for (const v of c.literals) indices.push(v.index);
        break;
      }
      case 'IMPLICATION': {
        const c = ct as ImplicationConstraint;
        indices.push(c.a.index, c.b.index);
        break;
      }
      case 'MAX_EQUALITY':
      case 'MIN_EQUALITY': {
        const c = ct as MaxEqualityConstraint;
        indices.push(c.target.index);
        for (const expr of c.expressions) {
          for (const v of expr.vars) indices.push(v.index);
        }
        break;
      }
      case 'ELEMENT': {
        const c = ct as ElementConstraint;
        indices.push(c.indexVar.index, c.target.index);
        for (const v of c.vars) indices.push(v.index);
        break;
      }
      case 'ABS_EQUALITY': {
        const c = ct as AbsEqualityConstraint;
        indices.push(c.target.index);
        for (const v of c.expr.vars) indices.push(v.index);
        break;
      }
      case 'DIVISION_EQUALITY': {
        const c = ct as DivisionEqualityConstraint;
        indices.push(c.target.index);
        for (const v of c.num.vars) indices.push(v.index);
        for (const v of c.denom.vars) indices.push(v.index);
        break;
      }
      case 'MODULO_EQUALITY': {
        const c = ct as ModuloEqualityConstraint;
        indices.push(c.target.index);
        for (const v of c.expr.vars) indices.push(v.index);
        for (const v of c.mod.vars) indices.push(v.index);
        break;
      }
      case 'MULTIPLICATION_EQUALITY': {
        const c = ct as MultiplicationEqualityConstraint;
        indices.push(c.target.index);
        for (const expr of c.expressions) {
          for (const v of expr.vars) indices.push(v.index);
        }
        break;
      }
      case 'ALLOWED_ASSIGNMENTS':
      case 'FORBIDDEN_ASSIGNMENTS': {
        const c = ct as AllowedAssignmentsConstraint;
        for (const v of c.vars) indices.push(v.index);
        break;
      }
      case 'AUTOMATON': {
        const c = ct as AutomatonConstraint;
        for (const v of c.vars) indices.push(v.index);
        break;
      }
      case 'INVERSE': {
        const c = ct as InverseConstraint;
        for (const v of c.fDirect) indices.push(v.index);
        for (const v of c.fInverse) indices.push(v.index);
        break;
      }
      case 'RESERVOIR': {
        const c = ct as ReservoirConstraint;
        for (const expr of c.times) {
          for (const v of expr.vars) indices.push(v.index);
        }
        for (const expr of c.levelChanges) {
          for (const v of expr.vars) indices.push(v.index);
        }
        for (const v of c.activeLiterals) indices.push(v.index);
        break;
      }
      case 'CIRCUIT':
      case 'MULTIPLE_CIRCUIT': {
        const c = ct as CircuitConstraint;
        for (const [, , lit] of c.arcs) indices.push(lit.index);
        break;
      }
      case 'NO_OVERLAP': {
        const c = ct as NoOverlapConstraint;
        for (const iv of c.intervals) {
          const ivImpl = iv as IntervalVarImpl;
          for (const v of ivImpl.start.vars) indices.push(v.index);
          for (const v of ivImpl.end.vars) indices.push(v.index);
        }
        break;
      }
      case 'NO_OVERLAP_2D': {
        const c = ct as NoOverlap2DConstraint;
        for (const iv of c.xIntervals) {
          const ivImpl = iv as IntervalVarImpl;
          for (const v of ivImpl.start.vars) indices.push(v.index);
          for (const v of ivImpl.end.vars) indices.push(v.index);
        }
        for (const iv of c.yIntervals) {
          const ivImpl = iv as IntervalVarImpl;
          for (const v of ivImpl.start.vars) indices.push(v.index);
          for (const v of ivImpl.end.vars) indices.push(v.index);
        }
        break;
      }
      case 'CUMULATIVE': {
        const c = ct as CumulativeConstraint;
        for (const iv of c.intervals) {
          const ivImpl = iv as IntervalVarImpl;
          for (const v of ivImpl.start.vars) indices.push(v.index);
          for (const v of ivImpl.end.vars) indices.push(v.index);
        }
        for (const expr of c.demands) {
          for (const v of expr.vars) indices.push(v.index);
        }
        for (const v of c.capacity.vars) indices.push(v.index);
        break;
      }
      case 'MAP_DOMAIN': {
        const c = ct as MapDomainConstraint;
        indices.push(c.var_.index);
        for (const v of c.boolVars) indices.push(v.index);
        break;
      }
      default:
        break;
    }
    return indices;
  }

  /**
   * Run the LCG clause engine over the given seed variables. Returns null when
   * the engine is disabled (zero overhead); otherwise the propagation outcome.
   * The clause engine's forced assignments go through `domains.set` (re-dirtying
   * the vars) so the caller's fixpoint loop re-enters — the clause↔CP fixpoint.
   */
  private _propagateClauses(domains: TrailMap, seed: ReadonlySet<number>): PropagationOutcome | null {
    if (!this._lcgEnabled || !this._clauseDb) return null;
    const outcome = this._clauseDb.propagate(
      domains,
      this._reasonTrail,
      seed,
      this._isBoolVar,
      this._onClauseAssign
    );
    if (outcome === 'INFEASIBLE') {
      // Capture the conflict clause literals for 1-UIP analysis.
      const cid = this._clauseDb.getConflictClauseId();
      if (cid >= 0) this._lastConflictLiterals = [...this._clauseDb.getClauseLiterals(cid)];
    }
    return outcome;
  }

  /**
   * LCG Phase 2: analyze the current conflict (1-UIP) and learn a clause.
   * Called at the conflict site when `_lastConflictLiterals` is set (clause
   * conflict or an explained Boolean-propagator conflict). Uses ChronoBT — the
   * learned clause is added; the caller backtracks chronologically as usual.
   * Sets `_rootUnsat` if the analysis derives the empty clause (level-0 conflict).
   */
  private _analyzeAndLearn(): void {
    if (!this._clauseDb || this._lastConflictLiterals === null) return;
    const result = analyzeConflict(
      this._lastConflictLiterals,
      this._assignTrail,
      this._clauseDb,
      this._reasonTrail
    );
    if (result === null) return; // conflict not analyzable → plain chronological backtrack
    this._stats.numLearnedClauses++;
    if (result.isEmptyClause || result.learnedLiterals.length === 0) {
      this._rootUnsat = true; // root UNSAT — empty learned clause
      return;
    }
    this._clauseDb.addLearnedClause(result.learnedLiterals);
  }

  /**
   * LCG Phase 3: bidirectional channeling between integer variable domains and
   * their associated synthetic bound literals (x ≥ k / x ≤ k).
   *
   * Forward  (int → S): if the integer domain already satisfies (or violates)
   *   the bound, force the bound literal to 1 (or 0).
   * Backward (S → int): if a clause or prior inference forced the bound literal,
   *   tighten the integer domain accordingly.
   *
   * Returns false on infeasibility (empty domain after tightening).
   */
  private _propagateBoundLiterals(domains: TrailMap): boolean {
    const reg = this._boundLitReg;
    if (!reg) return true;

    for (const [synthIdx, info] of reg.allEntries()) {
      const synthD = domains.get(synthIdx);
      if (!synthD || synthD.isEmpty) continue; // not initialized or reverted

      const intD = domains.get(info.varIndex);
      if (!intD || intD.isEmpty) continue;

      if (info.dir === 'geq') {
        // Forward: x ≥ k provably true → force S = 1
        if (intD.min >= info.bound && synthD.min !== 1) {
          domains.set(synthIdx, new Domain([1, 1]));
          this._reasonTrail.setReason(synthIdx, { type: 'propagation', constraintIndex: -1 });
          this._assignTrail.recordPropagation(synthIdx);
        }
        // Forward: x ≥ k provably false → force S = 0
        else if (intD.max < info.bound && synthD.max !== 0) {
          domains.set(synthIdx, new Domain([0, 0]));
          this._reasonTrail.setReason(synthIdx, { type: 'propagation', constraintIndex: -1 });
          this._assignTrail.recordPropagation(-(synthIdx + 1));
        }

        // Re-read after potential forward update
        const sd = domains.get(synthIdx)!;
        // Backward: S = 1 → x ≥ k
        if (sd.min === 1 && intD.min < info.bound) {
          const newD = intD.greaterOrEqual(info.bound);
          if (newD.isEmpty) return false;
          domains.set(info.varIndex, newD);
          this._reasonTrail.setReason(info.varIndex, { type: 'propagation', constraintIndex: -1 });
        }
        // Backward: S = 0 → x < k → x ≤ k − 1
        else if (sd.max === 0 && intD.max >= info.bound) {
          const newD = intD.lessOrEqual(info.bound - 1);
          if (newD.isEmpty) return false;
          domains.set(info.varIndex, newD);
          this._reasonTrail.setReason(info.varIndex, { type: 'propagation', constraintIndex: -1 });
        }
      } else {
        // dir === 'leq'
        // Forward: x ≤ k provably true → force S = 1
        if (intD.max <= info.bound && synthD.min !== 1) {
          domains.set(synthIdx, new Domain([1, 1]));
          this._reasonTrail.setReason(synthIdx, { type: 'propagation', constraintIndex: -1 });
          this._assignTrail.recordPropagation(synthIdx);
        }
        // Forward: x ≤ k provably false → force S = 0
        else if (intD.min > info.bound && synthD.max !== 0) {
          domains.set(synthIdx, new Domain([0, 0]));
          this._reasonTrail.setReason(synthIdx, { type: 'propagation', constraintIndex: -1 });
          this._assignTrail.recordPropagation(-(synthIdx + 1));
        }

        const sd = domains.get(synthIdx)!;
        // Backward: S = 1 → x ≤ k
        if (sd.min === 1 && intD.max > info.bound) {
          const newD = intD.lessOrEqual(info.bound);
          if (newD.isEmpty) return false;
          domains.set(info.varIndex, newD);
          this._reasonTrail.setReason(info.varIndex, { type: 'propagation', constraintIndex: -1 });
        }
        // Backward: S = 0 → x > k → x ≥ k + 1
        else if (sd.max === 0 && intD.min <= info.bound) {
          const newD = intD.greaterOrEqual(info.bound + 1);
          if (newD.isEmpty) return false;
          domains.set(info.varIndex, newD);
          this._reasonTrail.setReason(info.varIndex, { type: 'propagation', constraintIndex: -1 });
        }
      }
    }
    return true;
  }

  /**
   * LCG Phase 3: record a scheduling-propagated integer bound tightening as a
   * bound literal with a lazyClause reason.
   *
   * Called from `_propagateLinearCallback` after a scheduling propagator fires.
   * `anteLits` are the NEGATED antecedent literals from the `explain` lambda
   * (all currently FALSE). The full nogood clause adds `synthIdx` (the forced
   * literal) at the end.
   */
  private _recordIntBoundReason(
    varIndex: number,
    bound: number,
    dir: 'geq' | 'leq',
    anteLits: number[],
    domains: TrailMap
  ): void {
    const reg = this._boundLitReg;
    if (!reg) return;
    const synthIdx = reg.getOrCreate(varIndex, bound, dir, domains);
    // Skip if a reason is already recorded for this bound literal (idempotent).
    // NOTE: we check the reason trail, NOT the domain: getOrCreate may have
    // initialized the domain to [1,1] when the int-var already satisfied the
    // bound, but that does not mean the lazyClause explanation was recorded yet.
    if (this._reasonTrail.getReason(synthIdx) !== undefined) return;
    // Ensure domain is forced to TRUE.
    const synthD = domains.get(synthIdx);
    if (!synthD || synthD.min !== 1) {
      domains.set(synthIdx, new Domain([1, 1]));
    }
    // Full clause: negated antecedents + the forced literal.
    const fullClause = [...anteLits, synthIdx];
    this._reasonTrail.setReason(synthIdx, { type: 'lazyClause', literals: fullClause });
    this._assignTrail.recordPropagation(synthIdx);
    this._stats.numIntBoundLiterals++;
  }

  /**
   * Propagate all constraints until fixpoint
   * Returns false if inconsistency detected
   */
  private _propagate(domains: TrailMap): boolean {
    this._lastConflictLiterals = null;
    let changed = true;
    let iterations = 0;
    // Safety ceiling only: a correct (monotonic) fixpoint converges well below
    // this. If it is ever hit, propagation is stopped early AND a warning is
    // emitted — never silently. Hitting it signals non-monotonic propagators
    // that should be fixed, not a "consistent" result to trust.
    const maxIterations = 1000;

    // LCG: process incoming dirty (branch decisions / prior propagations) via
    // clauses BEFORE the first CP pass clears it. The clause engine drains to
    // its own fixpoint; its forced assignments are then seen by the all-CP pass.
    {
      const r = this._propagateClauses(domains, domains.getDirtyVariables());
      if (r === 'INFEASIBLE') return false;
    }
    // Phase 3: channel bound literals ↔ integer domains.
    if (!this._propagateBoundLiterals(domains)) return false;

    // First pass: propagate all constraints
    domains.clearDirty();
    for (let i = 0; i < this._model.constraints.length; i++) {
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
    for (const [, domain] of domains) {
      if (domain.isEmpty) return false;
    }

    // Subsequent passes: only propagate constraints affected by changed variables
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

      // Get dirty variables for this pass. NOTE: clearDirty() is deferred until
      // AFTER the toPropagate collection below — getDirtyVariables() returns the
      // live Set, so clearing first would empty it before collection (a latent
      // bug that made this loop effectively single-pass). The clause engine
      // (LCG) also reads `dirty` before this clear.
      const dirty = domains.getDirtyVariables();
      if (dirty.size === 0) break;

      // LCG: clause propagation seeded from `dirty`. The clause engine adds its
      // forced assignments back into `dirty`, so the CP collection below reacts
      // to them — the clause↔CP mutual fixpoint. clearDirty() runs after that
      // collection, so both consumers see the same augmented set.
      {
        const r = this._propagateClauses(domains, dirty);
        if (r === 'INFEASIBLE') return false;
        if (r === 'CHANGED') changed = true;
      }
      // Phase 3: channel bound literals ↔ integer domains (after each clause pass).
      if (!this._propagateBoundLiterals(domains)) return false;

      // Collect constraints to propagate (deduplicated)
      const toPropagate = new Set<number>();
      if (this._varToConstraints) {
        for (const varIdx of dirty) {
          const constraintIndices = this._varToConstraints.get(varIdx);
          if (constraintIndices) {
            for (const idx of constraintIndices) {
              toPropagate.add(idx);
            }
          }
        }
      } else {
        // Fallback: propagate all constraints
        for (let i = 0; i < this._model.constraints.length; i++) {
          if (this._activeConstraints && !this._activeConstraints.has(i)) continue;
          toPropagate.add(i);
        }
      }

      domains.clearDirty();

      // Propagate only the affected constraints
      for (const i of toPropagate) {
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
      for (const [, domain] of domains) {
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
      case 'FORBIDDEN_ASSIGNMENTS':
        return this._propagateForbiddenAssignments(constraint as ForbiddenAssignmentsConstraint, domains);
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
      case 'DIVISION_EQUALITY':
        return this._propagateDivisionEquality(constraint as DivisionEqualityConstraint, domains);
      case 'AUTOMATON':
        return propagateAutomaton(constraint as AutomatonConstraint, domains);
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
          this._reasonTrail.setReason(v.index, { type: 'propagation', constraintIndex: ct.index });
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
        this._reasonTrail.setReason(vars[i].index, { type: 'propagation', constraintIndex: ct.index });
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
              this._reasonTrail.setReason(other.varIndex, { type: 'propagation', constraintIndex: ct.index });
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
              this._reasonTrail.setReason(varIdx, { type: 'propagation', constraintIndex: ct.index });
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

    if (falseCount === ct.literals.length) {
      // Clause (l0 ∨ ... ∨ ln) fully falsified.
      this._recordBoolConflict(ct.literals.map(l => l.index));
      return 'INFEASIBLE';
    }

    if (falseCount === ct.literals.length - 1 && lastUnassigned) {
      domains.set(lastUnassigned.index, new Domain([1, 1]));
      // Explanation = the full clause (l0 ∨ ... ∨ ln).
      this._recordBoolReason(lastUnassigned.index, 1, ct.index, ct.literals.map(l => l.index));
      return 'CHANGED';
    }

    return 'CONSISTENT';
  }

  private _propagateBoolAnd(ct: BoolAndConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    let changed = false;

    for (const lit of ct.literals) {
      const d = domains.get(lit.index)!;
      if (d.max === 0) {
        // Unit clause (li) falsified — li must be true but is false.
        this._recordBoolConflict([lit.index]);
        return 'INFEASIBLE';
      }

      if (d.size > 1) {
        domains.set(lit.index, new Domain([1, 1]));
        // Explanation = unit clause {li}.
        this._recordBoolReason(lit.index, 1, ct.index, [lit.index]);
        changed = true;
      }
    }

    return changed ? 'CHANGED' : 'CONSISTENT';
  }

  private _propagateAtMostOne(ct: AtMostOneConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    const trueLits: BoolVar[] = [];
    for (const lit of ct.literals) {
      const d = domains.get(lit.index)!;
      if (d.min === 1) trueLits.push(lit);
    }

    if (trueLits.length > 1) {
      // Pairwise clause (¬li ∨ ¬lj) falsified by two true literals.
      this._recordBoolConflict([-(trueLits[0].index + 1), -(trueLits[1].index + 1)]);
      return 'INFEASIBLE';
    }

    if (trueLits.length === 1) {
      const trueLit = trueLits[0];
      let changed = false;
      for (const lit of ct.literals) {
        if (lit.index === trueLit.index) continue;
        const d = domains.get(lit.index)!;
        if (d.size > 1) {
          domains.set(lit.index, new Domain([0, 0]));
          // Explanation = pairwise clause (¬li ∨ ¬lj).
          this._recordBoolReason(lit.index, 0, ct.index, [-(lit.index + 1), -(trueLit.index + 1)]);
          changed = true;
        }
      }
      return changed ? 'CHANGED' : 'CONSISTENT';
    }

    return 'CONSISTENT';
  }

  private _propagateExactlyOne(ct: ExactlyOneConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    const trueLits: BoolVar[] = [];
    let falseCount = 0;
    let lastUnassigned: BoolVar | null = null;

    for (const lit of ct.literals) {
      const d = domains.get(lit.index)!;
      if (d.min === 1) trueLits.push(lit);
      else if (d.max === 0) falseCount++;
      else lastUnassigned = lit;
    }
    const allLits = ct.literals.map(l => l.index); // at-least-one clause (l0 ∨ ... ∨ ln)

    if (trueLits.length > 1) {
      this._recordBoolConflict([-(trueLits[0].index + 1), -(trueLits[1].index + 1)]); // (¬li ∨ ¬lj)
      return 'INFEASIBLE';
    }
    if (falseCount === ct.literals.length) {
      this._recordBoolConflict(allLits); // (l0 ∨ ... ∨ ln)
      return 'INFEASIBLE';
    }

    if (trueLits.length === 1) {
      const trueLit = trueLits[0];
      let changed = false;
      for (const lit of ct.literals) {
        if (lit.index === trueLit.index) continue;
        const d = domains.get(lit.index)!;
        if (d.size > 1) {
          domains.set(lit.index, new Domain([0, 0]));
          this._recordBoolReason(lit.index, 0, ct.index, [-(lit.index + 1), -(trueLit.index + 1)]);
          changed = true;
        }
      }
      return changed ? 'CHANGED' : 'CONSISTENT';
    }

    if (falseCount === ct.literals.length - 1 && lastUnassigned) {
      domains.set(lastUnassigned.index, new Domain([1, 1]));
      this._recordBoolReason(lastUnassigned.index, 1, ct.index, allLits); // at-least-one
      return 'CHANGED';
    }

    return 'CONSISTENT';
  }

  /**
   * Propagate BoolXor: odd number of literals must be true.
   *
   * NOTE: BoolXor intentionally opts OUT of LCG Phase 2 — it records a legacy
   * `{type:'propagation'}` reason (not a lazyClause). XOR's clausal explanation
   * is exponential (2^(n-1) clauses), so conflict analysis cannot resolve
   * through it; `analyzeConflict` aborts on `{type:'propagation'}` reasons,
   * falling back to plain chronological backtracking (sound, just no learning).
   */
  private _propagateBoolXor(ct: BoolXorConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    let trueCount = 0;
    const unassigned: BoolVar[] = [];

    for (const lit of ct.literals) {
      const d = domains.get(lit.index)!;
      if (d.min === 1) trueCount++;
      else if (d.max > 0) unassigned.push(lit);
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
      this._reasonTrail.setReason(unassigned[0].index, { type: 'propagation', constraintIndex: ct.index });
      this._stats.numBooleanPropagations++;
      return 'CHANGED';
    }

    return 'CONSISTENT';
  }

  private _propagateImplication(ct: ImplicationConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    const aDomain = domains.get(ct.a.index)!;
    const bDomain = domains.get(ct.b.index)!;
    // The implication (a → b) is the binary clause (¬a ∨ b).
    const expl: number[] = [-(ct.a.index + 1), ct.b.index];

    let changed = false;

    // If a is true, b must be true
    if (aDomain.min === 1) {
      if (bDomain.max === 0) {
        this._recordBoolConflict(expl);
        return 'INFEASIBLE';
      }
      if (bDomain.size > 1) {
        domains.set(ct.b.index, new Domain([1, 1]));
        this._recordBoolReason(ct.b.index, 1, ct.index, expl);
        changed = true;
      }
    }

    // If b is false, a must be false
    if (bDomain.max === 0) {
      if (aDomain.min === 1) {
        this._recordBoolConflict(expl);
        return 'INFEASIBLE';
      }
      if (aDomain.size > 1) {
        domains.set(ct.a.index, new Domain([0, 0]));
        this._recordBoolReason(ct.a.index, 0, ct.index, expl);
        changed = true;
      }
    }

    return changed ? 'CHANGED' : 'CONSISTENT';
  }

  private _propagateMaxEquality(ct: MaxEqualityConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    const targetDomain = domains.get(ct.target.index);
    if (!targetDomain || targetDomain.isEmpty) return 'INFEASIBLE';

    // Largest expression upper bound; track whether all expressions are fixed.
    let maxUb = -Infinity;
    let allAssigned = true;
    for (const expr of ct.expressions) {
      const exprDomain = this._getExpressionDomain(expr, domains);
      if (exprDomain.isEmpty) return 'INFEASIBLE';
      maxUb = Math.max(maxUb, exprDomain.max);
      if (exprDomain.size > 1) allAssigned = false;
    }

    // target = max(exprs) cannot exceed the largest expression bound.
    if (targetDomain.min > maxUb) return 'INFEASIBLE';

    let changed = false;

    // target <= maxUb
    if (maxUb < targetDomain.max) {
      const nd = targetDomain.lessOrEqual(maxUb);
      if (nd.isEmpty) return 'INFEASIBLE';
      domains.set(ct.target.index, nd);
      this._reasonTrail.setReason(ct.target.index, { type: 'propagation', constraintIndex: ct.index });
      this._stats.numIntegerPropagations++;
      changed = true;
    }

    // Each (simple-var) expression <= target, since target = max(exprs) >= expr.
    const targetMax = domains.get(ct.target.index)!.max;
    for (const expr of ct.expressions) {
      if (expr.vars.length === 1 && expr.coeffs[0] === 1 && expr.offset === 0) {
        const varIdx = expr.vars[0].index;
        const varDomain = domains.get(varIdx);
        if (!varDomain) continue;
        if (targetMax < varDomain.max) {
          const nd = varDomain.lessOrEqual(targetMax);
          if (nd.isEmpty) return 'INFEASIBLE';
          domains.set(varIdx, nd);
          this._reasonTrail.setReason(varIdx, { type: 'propagation', constraintIndex: ct.index });
          this._stats.numIntegerPropagations++;
          changed = true;
        }
      }
    }

    // Equality check when everything is fixed.
    if (allAssigned && domains.get(ct.target.index)!.size === 1) {
      const targetVal = domains.get(ct.target.index)!.min;
      let maxVal = -Infinity;
      for (const expr of ct.expressions) {
        const val = this._evaluateExpression(expr, domains);
        if (val !== null) {
          maxVal = Math.max(maxVal, val);
        }
      }
      if (targetVal !== maxVal) return 'INFEASIBLE';
    }

    return changed ? 'CHANGED' : 'CONSISTENT';
  }

  private _propagateMinEquality(ct: MinEqualityConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    const targetDomain = domains.get(ct.target.index);
    if (!targetDomain || targetDomain.isEmpty) return 'INFEASIBLE';

    // Smallest expression lower bound; track whether all expressions are fixed.
    let minLb = Infinity;
    let allAssigned = true;
    for (const expr of ct.expressions) {
      const exprDomain = this._getExpressionDomain(expr, domains);
      if (exprDomain.isEmpty) return 'INFEASIBLE';
      minLb = Math.min(minLb, exprDomain.min);
      if (exprDomain.size > 1) allAssigned = false;
    }

    // target = min(exprs) cannot be below the smallest expression bound.
    if (targetDomain.max < minLb) return 'INFEASIBLE';

    let changed = false;

    // target >= minLb
    if (minLb > targetDomain.min) {
      const nd = targetDomain.greaterOrEqual(minLb);
      if (nd.isEmpty) return 'INFEASIBLE';
      domains.set(ct.target.index, nd);
      this._reasonTrail.setReason(ct.target.index, { type: 'propagation', constraintIndex: ct.index });
      this._stats.numIntegerPropagations++;
      changed = true;
    }

    // Each (simple-var) expression >= target, since target = min(exprs) <= expr.
    const targetMin = domains.get(ct.target.index)!.min;
    for (const expr of ct.expressions) {
      if (expr.vars.length === 1 && expr.coeffs[0] === 1 && expr.offset === 0) {
        const varIdx = expr.vars[0].index;
        const varDomain = domains.get(varIdx);
        if (!varDomain) continue;
        if (targetMin > varDomain.min) {
          const nd = varDomain.greaterOrEqual(targetMin);
          if (nd.isEmpty) return 'INFEASIBLE';
          domains.set(varIdx, nd);
          this._reasonTrail.setReason(varIdx, { type: 'propagation', constraintIndex: ct.index });
          this._stats.numIntegerPropagations++;
          changed = true;
        }
      }
    }

    // Equality check when everything is fixed.
    if (allAssigned && domains.get(ct.target.index)!.size === 1) {
      const targetVal = domains.get(ct.target.index)!.min;
      let minVal = Infinity;
      for (const expr of ct.expressions) {
        const val = this._evaluateExpression(expr, domains);
        if (val !== null) {
          minVal = Math.min(minVal, val);
        }
      }
      if (targetVal !== minVal) return 'INFEASIBLE';
    }

    return changed ? 'CHANGED' : 'CONSISTENT';
  }

  /**
   * Propagate DivisionEquality (target == trunc(num / denom)).
   *
   * Handles the common case — a fixed positive divisor and a non-negative
   * numerator — where target = floor(num / c) and the bounds are closed-form.
   * Other cases (variable/negative divisor, negative numerator with the
   * trunc-toward-zero semantics) fall through to CONSISTENT and are verified by
   * the leaf checker, so this is always sound.
   */
  private _propagateDivisionEquality(ct: DivisionEqualityConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    const denomDom = this._getExpressionDomain(ct.denom, domains);
    if (!denomDom || denomDom.isEmpty || denomDom.size !== 1) return 'CONSISTENT';
    const c = denomDom.min;
    if (c <= 0) return 'CONSISTENT';

    const numDom = this._getExpressionDomain(ct.num, domains);
    if (!numDom || numDom.isEmpty) return 'INFEASIBLE';
    if (numDom.min < 0) return 'CONSISTENT';

    const targetDom = domains.get(ct.target.index);
    if (!targetDom || targetDom.isEmpty) return 'INFEASIBLE';

    let changed = false;

    // Forward: target = floor(num / c) ∈ [floor(numMin/c), floor(numMax/c)].
    const fwdTarget = targetDom.intersection(
      new Domain([Math.floor(numDom.min / c), Math.floor(numDom.max / c)])
    );
    if (fwdTarget.isEmpty) return 'INFEASIBLE';
    if (fwdTarget.size < targetDom.size) {
      domains.set(ct.target.index, fwdTarget);
      this._reasonTrail.setReason(ct.target.index, { type: 'propagation', constraintIndex: ct.index });
      this._stats.numIntegerPropagations++;
      changed = true;
    }

    // Reverse: num ∈ [target*c, target*c + c - 1]; over target's range that is
    // [tMin*c, tMax*c + c - 1]. Tighten num only when it is a simple variable.
    const tDom = domains.get(ct.target.index)!;
    if (ct.num.vars.length === 1 && ct.num.coeffs[0] === 1 && ct.num.offset === 0) {
      const numVarIdx = ct.num.vars[0].index;
      const numVarDom = domains.get(numVarIdx);
      if (numVarDom && !numVarDom.isEmpty) {
        const lo = tDom.min * c;
        const hi = tDom.max * c + (c - 1);
        let nd = numVarDom;
        if (lo > nd.min) {
          const tighter = nd.greaterOrEqual(lo);
          if (tighter.isEmpty) return 'INFEASIBLE';
          nd = tighter;
        }
        if (hi < nd.max) {
          const tighter = nd.lessOrEqual(hi);
          if (tighter.isEmpty) return 'INFEASIBLE';
          nd = tighter;
        }
        if (nd.size < numVarDom.size) {
          domains.set(numVarIdx, nd);
          this._reasonTrail.setReason(numVarIdx, { type: 'propagation', constraintIndex: ct.index });
          this._stats.numIntegerPropagations++;
          changed = true;
        }
      }
    }

    return changed ? 'CHANGED' : 'CONSISTENT';
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
        this._reasonTrail.setReason(ct.target.index, { type: 'propagation', constraintIndex: ct.index });
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
        this._reasonTrail.setReason(ct.indexVar.index, { type: 'propagation', constraintIndex: ct.index });
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
        this._reasonTrail.setReason(ct.target.index, { type: 'propagation', constraintIndex: ct.index });
        return 'CHANGED';
      }
    }

    // target range must intersect with [|expr_min|, |expr_max|] (rough bounds)
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
        this._reasonTrail.setReason(ct.target.index, { type: 'propagation', constraintIndex: ct.index });
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
        this._reasonTrail.setReason(ct.target.index, { type: 'propagation', constraintIndex: ct.index });
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
            this._reasonTrail.setReason(exprVar.index, { type: 'propagation', constraintIndex: ct.index });
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
            this._reasonTrail.setReason(exprVar.index, { type: 'propagation', constraintIndex: ct.index });
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
        this._reasonTrail.setReason(v.index, { type: 'propagation', constraintIndex: ct.index });
        changed = true;
      }
    }

    return changed ? 'CHANGED' : 'CONSISTENT';
  }

  /**
   * Propagate ForbiddenAssignments: remove domain values for which every
   * extension (every combination of other variables' domain values) results
   * in a forbidden tuple. A value v at position i is safe if there exists at
   * least one tuple (v, ..., ...) that is NOT in the forbidden set and whose
   * other values are all in their respective domains.
   *
   * To avoid exponential blowup, propagation is skipped when the Cartesian
   * product of other variables' domains exceeds MAX_CANDIDATES — the leaf
   * checker (_checkForbiddenAssignments) still guarantees correctness.
   */
  private _propagateForbiddenAssignments(ct: ForbiddenAssignmentsConstraint, domains: Map<number, Domain>): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
    // Build a Set of forbidden tuples for O(1) lookup
    const forbiddenSet = new Set<string>();
    for (const tuple of ct.tuples) {
      forbiddenSet.add(tuple.join(','));
    }

    const nVars = ct.vars.length;
    const MAX_CANDIDATES = 10000;

    let changed = false;

    for (let i = 0; i < nVars; i++) {
      const v = ct.vars[i];
      const d = domains.get(v.index)!;
      if (d.size <= 1) continue;

      // Build Cartesian product of other variables' domain values.
      // Guard against exponential blowup.
      const otherValues: number[][] = [];
      let productSize = 1;
      let tooLarge = false;
      for (let j = 0; j < nVars; j++) {
        if (j === i) continue;
        const vals = domains.get(ct.vars[j].index)!.values();
        otherValues.push(vals);
        productSize *= vals.length;
        if (productSize > MAX_CANDIDATES) {
          tooLarge = true;
          break;
        }
      }
      if (tooLarge) continue; // skip propagation for this position

      // Enumerate all combinations of other variables' values
      let candidates: number[][] = [[]];
      for (const vals of otherValues) {
        const next: number[][] = [];
        for (const combo of candidates) {
          for (const val of vals) {
            next.push([...combo, val]);
          }
        }
        candidates = next;
      }

      // For each value in vars[i]'s domain, check if it has a safe extension
      const safeValues = new Set<number>();
      for (const val of d.values()) {
        for (const combo of candidates) {
          // Build the full tuple: insert val at position i
          const fullTuple: number[] = [];
          let comboIdx = 0;
          for (let j = 0; j < nVars; j++) {
            if (j === i) {
              fullTuple.push(val);
            } else {
              fullTuple.push(combo[comboIdx++]);
            }
          }
          if (!forbiddenSet.has(fullTuple.join(','))) {
            safeValues.add(val);
            break; // one safe extension is enough
          }
        }
      }

      // Build new domain from safe values only
      const newIntervals: [number, number][] = [];
      for (const [start, end] of d.intervals) {
        let intervalStart = -1;
        for (let val = start; val <= end; val++) {
          if (safeValues.has(val)) {
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
        this._reasonTrail.setReason(v.index, { type: 'propagation', constraintIndex: ct.index });
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
   *
   * When `explain` is provided AND LCG + bound-literal registry are active,
   * records a lazyClause reason for every variable bound tightened — the core
   * of LCG Phase 3's integer-explanation machinery.
   */
  private _propagateLinearCallback(
    vars: IntVar[],
    coeffs: number[],
    lb: number,
    ub: number,
    domains: Map<number, Domain>,
    parentConstraintIndex: number = -1,
    explain?: () => number[] | null
  ): PropagationResult {
    if (!explain || !this._lcgEnabled || !this._boundLitReg) {
      // Fast path: no LCG explanation — just run propagation.
      const bounds = new Domain([lb, ub]);
      const ct = new LinearConstraint(parentConstraintIndex, vars, coeffs, bounds);
      return this._propagateLinear(ct, domains);
    }

    // LCG explain path: snapshot lower/upper bounds, propagate, detect changes.
    const prev = new Map<number, { min: number; max: number }>();
    for (const v of vars) {
      const d = domains.get(v.index);
      if (d) prev.set(v.index, { min: d.min, max: d.max });
    }

    const bounds = new Domain([lb, ub]);
    const ct = new LinearConstraint(parentConstraintIndex, vars, coeffs, bounds);
    const result = this._propagateLinear(ct, domains);

    if (result === 'CHANGED') {
      const anteLits = explain();
      if (anteLits !== null) {
        for (const v of vars) {
          const p = prev.get(v.index);
          const curr = domains.get(v.index);
          if (!p || !curr) continue;
          if (curr.min > p.min) {
            this._recordIntBoundReason(v.index, curr.min, 'geq', anteLits, domains as TrailMap);
          }
          if (curr.max < p.max) {
            this._recordIntBoundReason(v.index, curr.max, 'leq', anteLits, domains as TrailMap);
          }
        }
      }
    }

    return result;
  }

  /**
   * Orchestrate NoOverlap propagation: Simple Precedences → Detectable Precedences → Not-Last → Edge-Finding
   */
  private _propagateNoOverlapConstraint(
    ct: NoOverlapConstraint,
    domains: Map<number, Domain>
  ): PropagationResult {
    const linFn: LinearPropagateFn = (vars, coeffs, lb, ub, d, _pci, explain) =>
      this._propagateLinearCallback(vars, coeffs, lb, ub, d, ct.index, explain);

    // LCG Phase 3: bound-literal allocator closure for explain lambdas.
    const alloc = (this._lcgEnabled && this._boundLitReg)
      ? (vi: number, b: number, dir: 'geq' | 'leq'): number =>
          this._boundLitReg!.getOrCreate(vi, b, dir, domains)
      : null;

    const result = propagateNoOverlap(ct, domains, linFn, alloc);
    if (result === 'INFEASIBLE') return 'INFEASIBLE';

    const result2 = propagateNoOverlapDetectable(ct, domains, linFn, alloc);
    if (result2 === 'INFEASIBLE') return 'INFEASIBLE';

    const result3 = propagateNoOverlapNotLast(ct, domains, linFn, alloc);
    if (result3 === 'INFEASIBLE') return 'INFEASIBLE';

    const result4 = propagateNoOverlapEdgeFinding(ct, domains, linFn, alloc);
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
    const linFn: LinearPropagateFn = (vars, coeffs, lb, ub, d, _pci, explain) =>
      this._propagateLinearCallback(vars, coeffs, lb, ub, d, ct.index, explain);

    const alloc = (this._lcgEnabled && this._boundLitReg)
      ? (vi: number, b: number, dir: 'geq' | 'leq'): number =>
          this._boundLitReg!.getOrCreate(vi, b, dir, domains)
      : null;

    const result = propagateCumulativeTimeTable(ct, domains, linFn, alloc);
    if (result === 'INFEASIBLE') return 'INFEASIBLE';

    const result2 = propagateCumulativeEdgeFinding(ct, domains, linFn, alloc);
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
      this._propagateLinearCallback(vars, coeffs, lb, ub, d, ct.index);

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
      this._propagateLinearCallback(vars, coeffs, lb, ub, d, ct.index);

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
   * Get the timestamp (Date.now() value) when solve() was called.
   * Used by callbacks to compute real-time wall time during search.
   */
  get startTime(): number {
    return this._startTime;
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

  /**
   * Get the current variable domains. Useful for warm restart: pass the
   * returned map as `initialDomains` to a subsequent solve() call.
   * Returns null if solve() has not been called yet.
   */
  getCurrentDomains(): Map<number, Domain> | null {
    // Return a copy of the initial domains (before search modified them)
    // For warm restart, we want the domains after presolve but before search
    return this._lastPresolveDomains ? new Map(this._lastPresolveDomains) : null;
  }

  /**
   * Return the subset of assumption indices that together make the model
   * infeasible (the UNSAT core). Returns an empty array if the model was
   * not proven infeasible or if no assumptions were used.
   *
   * The core is extracted by walking the reason trail: every domain
   * restriction caused by an assumption is recorded, and the transitive
   * closure over propagation reasons identifies all assumptions involved
   * in the conflict.
   */
  sufficientAssumptionsForInfeasibility(): number[] {
    if (!this._infeasibleAfterAssumptions) return [];

    const assumptionsNeeded = new Set<number>();
    const model = this._model;

    // Helper: get all variable indices involved in a constraint
    const getConstraintVarIndices = (ct: Constraint): number[] => {
      const indices: number[] = [];
      switch (ct.type) {
        case 'LINEAR': {
          const c = ct as LinearConstraint;
          for (const v of c.vars) indices.push(v.index);
          break;
        }
        case 'NOT_EQUAL': {
          const c = ct as NotEqualConstraint;
          for (const v of c.expr.vars) indices.push(v.index);
          break;
        }
        case 'ALL_DIFFERENT': {
          const c = ct as AllDifferentConstraint;
          for (const expr of c.expressions) {
            for (const v of expr.vars) indices.push(v.index);
          }
          break;
        }
        case 'BOOL_OR':
        case 'BOOL_AND':
        case 'AT_MOST_ONE':
        case 'EXACTLY_ONE':
        case 'BOOL_XOR': {
          const c = ct as BoolOrConstraint;
          for (const v of c.literals) indices.push(v.index);
          break;
        }
        case 'IMPLICATION': {
          const c = ct as ImplicationConstraint;
          indices.push(c.a.index, c.b.index);
          break;
        }
        case 'MAX_EQUALITY':
        case 'MIN_EQUALITY': {
          const c = ct as MaxEqualityConstraint;
          indices.push(c.target.index);
          for (const expr of c.expressions) {
            for (const v of expr.vars) indices.push(v.index);
          }
          break;
        }
        case 'ELEMENT': {
          const c = ct as ElementConstraint;
          indices.push(c.indexVar.index, c.target.index);
          for (const v of c.vars) indices.push(v.index);
          break;
        }
        case 'ABS_EQUALITY': {
          const c = ct as AbsEqualityConstraint;
          indices.push(c.target.index);
          for (const v of c.expr.vars) indices.push(v.index);
          break;
        }
        case 'DIVISION_EQUALITY': {
          const c = ct as DivisionEqualityConstraint;
          indices.push(c.target.index);
          for (const v of c.num.vars) indices.push(v.index);
          for (const v of c.denom.vars) indices.push(v.index);
          break;
        }
        case 'MODULO_EQUALITY': {
          const c = ct as ModuloEqualityConstraint;
          indices.push(c.target.index);
          for (const v of c.expr.vars) indices.push(v.index);
          for (const v of c.mod.vars) indices.push(v.index);
          break;
        }
        case 'MULTIPLICATION_EQUALITY': {
          const c = ct as MultiplicationEqualityConstraint;
          indices.push(c.target.index);
          for (const expr of c.expressions) {
            for (const v of expr.vars) indices.push(v.index);
          }
          break;
        }
        case 'ALLOWED_ASSIGNMENTS':
        case 'FORBIDDEN_ASSIGNMENTS': {
          const c = ct as AllowedAssignmentsConstraint;
          for (const v of c.vars) indices.push(v.index);
          break;
        }
        case 'AUTOMATON': {
          const c = ct as AutomatonConstraint;
          for (const v of c.vars) indices.push(v.index);
          break;
        }
        case 'INVERSE': {
          const c = ct as InverseConstraint;
          for (const v of c.fDirect) indices.push(v.index);
          for (const v of c.fInverse) indices.push(v.index);
          break;
        }
        case 'RESERVOIR': {
          const c = ct as ReservoirConstraint;
          for (const expr of c.times) {
            for (const v of expr.vars) indices.push(v.index);
          }
          for (const expr of c.levelChanges) {
            for (const v of expr.vars) indices.push(v.index);
          }
          for (const v of c.activeLiterals) indices.push(v.index);
          break;
        }
        case 'CIRCUIT':
        case 'MULTIPLE_CIRCUIT': {
          const c = ct as CircuitConstraint;
          for (const [, , lit] of c.arcs) indices.push(lit.index);
          break;
        }
        case 'NO_OVERLAP': {
          const c = ct as NoOverlapConstraint;
          for (const iv of c.intervals) {
            const ivImpl = iv as IntervalVarImpl;
            for (const v of ivImpl.start.vars) indices.push(v.index);
            for (const v of ivImpl.end.vars) indices.push(v.index);
          }
          break;
        }
        case 'NO_OVERLAP_2D': {
          const c = ct as NoOverlap2DConstraint;
          for (const iv of c.xIntervals) {
            const ivImpl = iv as IntervalVarImpl;
            for (const v of ivImpl.start.vars) indices.push(v.index);
            for (const v of ivImpl.end.vars) indices.push(v.index);
          }
          for (const iv of c.yIntervals) {
            const ivImpl = iv as IntervalVarImpl;
            for (const v of ivImpl.start.vars) indices.push(v.index);
            for (const v of ivImpl.end.vars) indices.push(v.index);
          }
          break;
        }
        case 'CUMULATIVE': {
          const c = ct as CumulativeConstraint;
          for (const iv of c.intervals) {
            const ivImpl = iv as IntervalVarImpl;
            for (const v of ivImpl.start.vars) indices.push(v.index);
            for (const v of ivImpl.end.vars) indices.push(v.index);
          }
          for (const expr of c.demands) {
            for (const v of expr.vars) indices.push(v.index);
          }
          for (const v of c.capacity.vars) indices.push(v.index);
          break;
        }
        case 'MAP_DOMAIN': {
          const c = ct as MapDomainConstraint;
          indices.push(c.var_.index);
          for (const v of c.boolVars) indices.push(v.index);
          break;
        }
        default:
          break;
      }
      return indices;
    };

    // Walk the reason chain: start from all variables that have reasons,
    // follow propagation reasons back to their constraint's input variables,
    // and collect all assumption reasons encountered.
    const visited = new Set<number>();
    const queue: number[] = [];

    // Seed the queue with all variables that have reasons
    for (const [varIdx] of this._reasonTrail.allReasons()) {
      queue.push(varIdx);
    }

    while (queue.length > 0) {
      const varIdx = queue.pop()!;
      if (visited.has(varIdx)) continue;
      visited.add(varIdx);

      const reason = this._reasonTrail.getReason(varIdx);
      if (!reason) continue;

      if (reason.type === 'assumption') {
        assumptionsNeeded.add(reason.assumptionIndex);
      } else if (reason.type === 'clause') {
        // Clause propagation: follow the chain through the clause's literals.
        const lits = this._clauseDb?.getClauseLiterals(reason.clauseId);
        if (lits) {
          for (const l of lits) {
            const idx = litVar(l);
            if (!visited.has(idx)) {
              queue.push(idx);
            }
          }
        }
      } else if (reason.type === 'lazyClause') {
        // Boolean-propagator explanation: follow the explanation literals.
        for (const l of reason.literals) {
          const idx = litVar(l);
          if (!visited.has(idx)) {
            queue.push(idx);
          }
        }
      } else {
        // Propagation reason: follow the chain to the constraint's variables
        const ct = model.constraints[reason.constraintIndex];
        if (ct) {
          for (const idx of getConstraintVarIndices(ct)) {
            if (!visited.has(idx)) {
              queue.push(idx);
            }
          }
        }
      }
    }

    return Array.from(assumptionsNeeded).sort((a, b) => a - b);
  }
}
