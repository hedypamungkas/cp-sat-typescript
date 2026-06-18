/**
 * CP-SAT TypeScript - N-Queens Example
 *
 * The N-queens problem is to place N queens on an NxN chessboard
 * so that no two queens attack each other.
 *
 * Queens attack horizontally, vertically, and diagonally.
 */

import { CpModel, CpSolver, CpSolverStatus, CpSolverSolutionCallback, IntVarImpl } from '../src';

/**
 * Solution callback to print each solution
 */
class NQueenSolutionPrinter extends CpSolverSolutionCallback {
  private _startTime: number;

  constructor(queens: IntVarImpl[]) {
    super();
    this._variables = queens;
    this._startTime = Date.now();
  }

  onSolutionCallback(): void {
    const elapsed = (Date.now() - this._startTime) / 1000;
    console.log(`Solution ${this._solutionCount}, time = ${elapsed.toFixed(3)} s`);

    const boardSize = this._variables.length;
    for (let i = 0; i < boardSize; i++) {
      for (let j = 0; j < boardSize; j++) {
        if (this.value(this._variables[j]) === i) {
          process.stdout.write('Q ');
        } else {
          process.stdout.write('_ ');
        }
      }
      console.log();
    }
    console.log();
  }
}

function solveNQueens(boardSize: number) {
  console.log(`Solving ${boardSize}-Queens problem...\n`);

  const model = new CpModel();

  // One variable per column; value = row where queen sits
  const queens = Array.from({ length: boardSize }, (_, i) =>
    model.newIntVar(0, boardSize - 1, `x_${i}`)
  );

  // All rows must differ
  model.addAllDifferent(queens);

  // No two queens on same diagonal
  // For diagonal: row + col must be unique
  model.addAllDifferent(queens.map((q, i) => q.add(i)));

  // For anti-diagonal: row - col must be unique
  model.addAllDifferent(queens.map((q, i) => q.sub(i)));

  // Create solver
  const solver = new CpSolver();
  solver.parameters.enumerateAllSolutions = true;

  // Solve with callback
  const printer = new NQueenSolutionPrinter(queens);
  solver.solve(model, printer);

  // Print statistics
  console.log('Statistics:');
  console.log(`  Conflicts: ${solver.numConflicts}`);
  console.log(`  Branches: ${solver.numBranches}`);
  console.log(`  Presolve: ${(solver.presolveTime * 1000).toFixed(1)} ms`);
  console.log(`  Search:   ${(solver.searchTime * 1000).toFixed(1)} ms`);
  console.log(`  Total:    ${(solver.wallTime * 1000).toFixed(1)} ms`);
  console.log(`  Solutions found: ${printer.solutionCount}`);
}

// Solve for different board sizes
const sizes = [4, 8];
for (const size of sizes) {
  solveNQueens(size);
  console.log('---');
}
