/**
 * CP-SAT TypeScript Implementation
 * CpSolver - The main solver class
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { LinearExpr, CpSolverStatus, SolverParameters } from './types';
import { IntVarImpl, BoolVarImpl } from './variables';
import { CpModel } from './model';
import { SolverEngine, SolverStats } from './solver-engine';
import { CpSolverSolutionCallback, SearchProgressCallback } from './callback';

// ============================================================================
// CpSolver Class
// ============================================================================

/**
 * CP-SAT Solver
 *
 * This class solves constraint programming models built with CpModel.
 *
 * @example
 * ```typescript
 * const model = new CpModel();
 * const x = model.newIntVar(0, 10, 'x');
 * const y = model.newIntVar(0, 10, 'y');
 * model.add(x.add(y).le(15));
 * model.maximize(x.add(y));
 *
 * const solver = new CpSolver();
 * const status = solver.solve(model);
 *
 * if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
 *   console.log(`x = ${solver.value(x)}`);
 *   console.log(`y = ${solver.value(y)}`);
 *   console.log(`Objective = ${solver.objectiveValue}`);
 * }
 * ```
 */
export class CpSolver {
  private _parameters: SolverParameters;
  private _engine: SolverEngine | null = null;
  private _solution: Map<number, number> | null = null;
  private _status: CpSolverStatus = CpSolverStatus.UNKNOWN;
  private _stats: SolverStats | null = null;
  private _objectiveValue: number = 0;
  private _bestObjectiveBound: number = 0;

  constructor() {
    this._parameters = {};
  }

  // ============================================================================
  // Parameters
  // ============================================================================

  /**
   * Get solver parameters
   */
  get parameters(): SolverParameters {
    return this._parameters;
  }

  /**
   * Set solver parameters
   */
  set parameters(params: SolverParameters) {
    this._parameters = params;
  }

  // ============================================================================
  // Core Solve Method
  // ============================================================================

  /**
   * Solve the model
   *
   * @param model - The CP model to solve
   * @param callback - Optional solution callback
   * @returns The solver status
   *
   * @example
   * ```typescript
   * const solver = new CpSolver();
   * const status = solver.solve(model);
   *
   * if (status === CpSolverStatus.OPTIMAL) {
   *   console.log('Optimal solution found!');
   * }
   * ```
   */
  solve(
    model: CpModel,
    callback?: CpSolverSolutionCallback,
    progressCallback?: SearchProgressCallback,
    options?: { initialDomains?: Map<number, import('./types').Domain>; initialBestObjective?: number | null }
  ): CpSolverStatus {
    // Create solver engine
    this._engine = new SolverEngine(model, this._parameters);

    // Apply parameters
    if (this._parameters.maxTimeInSeconds) {
      this._engine.maxTime = this._parameters.maxTimeInSeconds;
    }

    if (this._parameters.enumerateAllSolutions) {
      this._engine.enumerateAll = true;
    }

    // Set objective if present
    if (model.objective) {
      this._engine.setObjective(model.objective, model.isMaximize);
    }

    // Setup callback wrapper
    let engineCallback: import('./solver-engine').SolutionCallback | undefined;
    if (callback) {
      engineCallback = {
        onSolution: () => {
          // Get current solution from engine
          const solution = new Map<number, number>();
          for (const v of model.registry.allIntVars) {
            solution.set(v.index, this._engine!.getValue(v.index));
          }
          for (const v of model.registry.allBoolVars) {
            solution.set(v.index, this._engine!.getValue(v.index));
          }

          // Calculate objective value
          let objValue = 0;
          if (model.objective) {
            objValue = model.objective.evaluate((v) => solution.get(v.index) || 0);
          }

          // Update callback — use startTime for real-time wall time during
          // search (stats.wallTime is only written after solve completes).
          callback._setSolution(
            solution,
            objValue,
            (Date.now() - this._engine!.startTime) / 1000,
            this._engine!.stats.numConflicts,
            this._engine!.stats.numBranches
          );

          return !callback._shouldStop();
        },
      };
    }

    // Solve
    this._status = this._engine.solve(engineCallback, progressCallback, options);

    // Extract results
    if (this._status === CpSolverStatus.OPTIMAL || this._status === CpSolverStatus.FEASIBLE) {
      this._solution = new Map<number, number>();

      // Get solution from engine
      for (const v of model.registry.allIntVars) {
        this._solution.set(v.index, this._engine.getValue(v.index));
      }
      for (const v of model.registry.allBoolVars) {
        this._solution.set(v.index, this._engine.getValue(v.index));
      }

      // Calculate objective value
      if (model.objective) {
        this._objectiveValue = model.objective.evaluate((v) => this._solution!.get(v.index) || 0);
      }
    }

    // Extract best objective bound from engine
    if (model.objective) {
      const engineBound = this._engine.bestObjective;
      if (engineBound !== null) {
        this._bestObjectiveBound = engineBound;
      }
    }

    this._stats = this._engine.stats;

    return this._status;
  }

  /**
   * Stop the search
   */
  stopSearch(): void {
    if (this._engine) {
      this._engine.stop();
    }
  }

  // ============================================================================
  // Solution Inspection
  // ============================================================================

  /**
   * Get the value of a variable in the solution
   *
   * @param expression - The variable or expression
   * @returns The value
   *
   * @example
   * ```typescript
   * const xValue = solver.value(x);
   * const sumValue = solver.value(x.add(y));
   * ```
   */
  value(expression: IntVarImpl | BoolVarImpl | LinearExpr): number {
    if (!this._solution) {
      throw new Error('No solution available');
    }

    if (expression instanceof LinearExpr) {
      return expression.evaluate((v) => this._solution!.get(v.index) || 0);
    }

    // It's a variable (IntVarImpl or BoolVarImpl)
    const val = this._solution.get(expression.index);
    if (val === undefined) {
      throw new Error(`Variable ${expression.name} not found in solution`);
    }
    return val;
  }

  /**
   * Get the boolean value of a literal in the solution
   *
   * @param literal - The boolean variable
   * @returns The boolean value
   */
  booleanValue(literal: BoolVarImpl): boolean {
    return this.value(literal) === 1;
  }

  // ============================================================================
  // Properties
  // ============================================================================

  /**
   * Get the objective value
   */
  get objectiveValue(): number {
    return this._objectiveValue;
  }

  /**
   * Get the best objective bound
   */
  get bestObjectiveBound(): number {
    return this._bestObjectiveBound;
  }

  /**
   * Get the number of Boolean propagations
   */
  get numBooleans(): number {
    return this._stats?.numBooleanPropagations || 0;
  }

  /**
   * Get the number of conflicts
   */
  get numConflicts(): number {
    return this._stats?.numConflicts || 0;
  }

  /**
   * Get the number of branches
   */
  get numBranches(): number {
    return this._stats?.numBranches || 0;
  }

  /**
   * Get the number of clauses learned via 1-UIP conflict analysis (LCG Phase 2).
   */
  get numLearnedClauses(): number {
    return this._stats?.numLearnedClauses || 0;
  }

  /**
   * Get the number of integer bound literals recorded with lazyClause reasons
   * (LCG Phase 3 — scheduling explanation events).
   */
  get numIntBoundLiterals(): number {
    return this._stats?.numIntBoundLiterals || 0;
  }

  /**
   * Get the number of Boolean propagations
   */
  get numBooleanPropagations(): number {
    return this._stats?.numBooleanPropagations || 0;
  }

  /**
   * Get the number of integer propagations
   */
  get numIntegerPropagations(): number {
    return this._stats?.numIntegerPropagations || 0;
  }

  /**
   * Get the wall time in seconds
   */
  get wallTime(): number {
    return this._stats?.wallTime || 0;
  }

  /**
   * Get the presolve time in seconds
   */
  get presolveTime(): number {
    return this._stats?.presolveTime || 0;
  }

  /**
   * Get the search time in seconds
   */
  get searchTime(): number {
    return this._stats?.searchTime || 0;
  }

  /**
   * Get the number of solutions found
   */
  get numSolutions(): number {
    return this._stats?.numSolutions || 0;
  }

  // ============================================================================
  // Status
  // ============================================================================

  /**
   * Get the solver status name
   *
   * @param status - Optional status to get name for
   * @returns Human-readable status name
   */
  statusName(status?: CpSolverStatus): string {
    const s = status || this._status;
    return s.toString();
  }

  /**
   * Get solver response statistics as a string
   *
   * @returns Formatted statistics
   */
  responseStats(): string {
    if (!this._stats) {
      return 'No solve performed yet';
    }

    return [
      `Status: ${this._status}`,
      `Objective: ${this._objectiveValue}`,
      `Conflicts: ${this._stats.numConflicts}`,
      `Branches: ${this._stats.numBranches}`,
      `Boolean propagations: ${this._stats.numBooleanPropagations}`,
      `Integer propagations: ${this._stats.numIntegerPropagations}`,
      `Solutions found: ${this._stats.numSolutions}`,
      `Wall time: ${this._stats.wallTime.toFixed(3)} s`,
      `Presolve time: ${this._stats.presolveTime.toFixed(3)} s`,
      `Search time: ${this._stats.searchTime.toFixed(3)} s`,
    ].join('\n');
  }

  /**
   * Get sufficient assumptions for infeasibility
   *
   * @returns Array of assumption indices that caused infeasibility
   */
  sufficientAssumptionsForInfeasibility(): number[] {
    if (!this._engine) return [];
    return this._engine.sufficientAssumptionsForInfeasibility();
  }

  /**
   * Get the solve information
   *
   * @returns Information about how the solution was found
   */
  solutionInfo(): string {
    return `Status: ${this._status}`;
  }
}
