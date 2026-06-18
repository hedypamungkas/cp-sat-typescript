/**
 * CP-SAT TypeScript Implementation
 * Solution Callback classes
 */

import { LinearExpr, CpSolverStatus } from './types';
import { IntVarImpl, BoolVarImpl } from './variables';

// ============================================================================
// CpSolverSolutionCallback
// ============================================================================

/**
 * Base class for solution callbacks
 *
 * Override onSolutionCallback() to receive notifications when solutions are found.
 *
 * @example
 * ```typescript
 * class MyCallback extends CpSolverSolutionCallback {
 *   onSolutionCallback(): void {
 *     console.log('Solution found!');
 *     for (const v of this._variables) {
 *       console.log(`${v.name} = ${this.value(v)}`);
 *     }
 *   }
 * }
 * ```
 */
export abstract class CpSolverSolutionCallback {
  protected _variables: IntVarImpl[] = [];
  protected _solution: Map<number, number> = new Map();
  protected _objectiveValue: number = 0;
  protected _wallTime: number = 0;
  protected _numConflicts: number = 0;
  protected _numBranches: number = 0;
  protected _solutionCount: number = 0;
  protected _stopSearch: boolean = false;

  /**
   * Called when a new solution is found
   * Override this method to process solutions
   */
  abstract onSolutionCallback(): void;

  /**
   * Set the current solution
   * @internal
   */
  _setSolution(
    solution: Map<number, number>,
    objectiveValue: number,
    wallTime: number,
    numConflicts: number,
    numBranches: number
  ): void {
    this._solution = new Map(solution);
    this._objectiveValue = objectiveValue;
    this._wallTime = wallTime;
    this._numConflicts = numConflicts;
    this._numBranches = numBranches;
    this._solutionCount++;

    this.onSolutionCallback();
  }

  /**
   * Get the value of a variable in the current solution
   *
   * @param var_ - The variable
   * @returns The value of the variable
   */
  value(var_: import('./types').IntVar): number {
    const val = this._solution.get(var_.index);
    if (val === undefined) {
      throw new Error(`Variable ${var_.name} not found in solution`);
    }
    return val;
  }

  /**
   * Get the boolean value of a literal in the current solution
   *
   * @param lit - The boolean variable
   * @returns The boolean value
   */
  booleanValue(lit: BoolVarImpl): boolean {
    return this.value(lit) === 1;
  }

  /**
   * Get the objective value
   */
  get objectiveValue(): number {
    return this._objectiveValue;
  }

  /**
   * Get the wall time
   */
  get wallTime(): number {
    return this._wallTime;
  }

  /**
   * Get the number of conflicts
   */
  get numConflicts(): number {
    return this._numConflicts;
  }

  /**
   * Get the number of branches
   */
  get numBranches(): number {
    return this._numBranches;
  }

  /**
   * Get the number of solutions found
   */
  get solutionCount(): number {
    return this._solutionCount;
  }

  /**
   * Stop the search
   */
  stopSearch(): void {
    this._stopSearch = true;
  }

  /**
   * Check if search should stop
   * @internal
   */
  _shouldStop(): boolean {
    return this._stopSearch;
  }
}

// ============================================================================
// VarArraySolutionPrinter
// ============================================================================

/**
 * Callback that prints variable values for each solution
 *
 * @example
 * ```typescript
 * const printer = new VarArraySolutionPrinter([x, y, z]);
 * solver.solve(model, printer);
 * console.log(`Found ${printer.solutionCount} solutions`);
 * ```
 */
export class VarArraySolutionPrinter extends CpSolverSolutionCallback {
  private _startTime: number = 0;

  constructor(variables: IntVarImpl[]) {
    super();
    this._variables = variables;
    this._startTime = Date.now();
  }

  onSolutionCallback(): void {
    const elapsed = (Date.now() - this._startTime) / 1000;
    console.log(`Solution ${this._solutionCount}, time = ${elapsed.toFixed(3)} s`);

    for (const v of this._variables) {
      console.log(`  ${v.name} = ${this.value(v)}`);
    }
    console.log();
  }
}

// ============================================================================
// VarArrayAndObjectiveSolutionPrinter
// ============================================================================

/**
 * Callback that prints variable values and objective for each solution
 *
 * @example
 * ```typescript
 * const printer = new VarArrayAndObjectiveSolutionPrinter([x, y, z]);
 * solver.solve(model, printer);
 * ```
 */
export class VarArrayAndObjectiveSolutionPrinter extends CpSolverSolutionCallback {
  private _startTime: number = 0;

  constructor(variables: IntVarImpl[]) {
    super();
    this._variables = variables;
    this._startTime = Date.now();
  }

  onSolutionCallback(): void {
    const elapsed = (Date.now() - this._startTime) / 1000;
    console.log(`Solution ${this._solutionCount}, time = ${elapsed.toFixed(3)} s`);
    console.log(`  Objective: ${this._objectiveValue}`);

    for (const v of this._variables) {
      console.log(`  ${v.name} = ${this.value(v)}`);
    }
    console.log();
  }
}

// ============================================================================
// ObjectiveSolutionPrinter
// ============================================================================

/**
 * Callback that prints only the objective value for each solution
 *
 * @example
 * ```typescript
 * const printer = new ObjectiveSolutionPrinter();
 * solver.solve(model, printer);
 * ```
 */
export class ObjectiveSolutionPrinter extends CpSolverSolutionCallback {
  private _startTime: number = 0;

  constructor() {
    super();
    this._startTime = Date.now();
  }

  onSolutionCallback(): void {
    const elapsed = (Date.now() - this._startTime) / 1000;
    console.log(`Solution ${this._solutionCount}: objective = ${this._objectiveValue}, time = ${elapsed.toFixed(3)} s`);
  }
}
