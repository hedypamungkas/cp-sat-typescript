/**
 * CP-SAT TypeScript - Sudoku Solver Example
 *
 * Solves a 9x9 Sudoku puzzle using CP-SAT constraints.
 * Each cell contains a value 1-9, with all-different constraints
 * on rows, columns, and 3x3 boxes.
 */

import { CpModel, CpSolver, CpSolverStatus, IntVarImpl } from '../src';

// A sample Sudoku puzzle (0 = empty)
const PUZZLE: number[][] = [
  [5, 3, 0, 0, 7, 0, 0, 0, 0],
  [6, 0, 0, 1, 9, 5, 0, 0, 0],
  [0, 9, 8, 0, 0, 0, 0, 6, 0],
  [8, 0, 0, 0, 6, 0, 0, 0, 3],
  [4, 0, 0, 8, 0, 3, 0, 0, 1],
  [7, 0, 0, 0, 2, 0, 0, 0, 6],
  [0, 6, 0, 0, 0, 0, 2, 8, 0],
  [0, 0, 0, 4, 1, 9, 0, 0, 5],
  [0, 0, 0, 0, 8, 0, 0, 7, 9],
];

function solveSudoku() {
  console.log('Sudoku Solver\n');
  console.log('Puzzle:');
  printGrid(PUZZLE);
  console.log();

  const model = new CpModel();
  const size = 9;
  const boxSize = 3;

  // Create variables: grid[r][c] in [1, 9]
  const grid: IntVarImpl[][] = [];
  for (let r = 0; r < size; r++) {
    grid[r] = [];
    for (let c = 0; c < size; c++) {
      grid[r][c] = model.newIntVar(1, size, `cell_${r}_${c}`);
    }
  }

  // Fix known values from the puzzle
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (PUZZLE[r][c] !== 0) {
        model.add(grid[r][c].eq(PUZZLE[r][c]));
      }
    }
  }

  // Row constraints: all different in each row
  for (let r = 0; r < size; r++) {
    model.addAllDifferent(grid[r]);
  }

  // Column constraints: all different in each column
  for (let c = 0; c < size; c++) {
    model.addAllDifferent(grid.map(row => row[c]));
  }

  // Box constraints: all different in each 3x3 box
  for (let br = 0; br < boxSize; br++) {
    for (let bc = 0; bc < boxSize; bc++) {
      const boxVars: IntVarImpl[] = [];
      for (let r = br * boxSize; r < (br + 1) * boxSize; r++) {
        for (let c = bc * boxSize; c < (bc + 1) * boxSize; c++) {
          boxVars.push(grid[r][c]);
        }
      }
      model.addAllDifferent(boxVars);
    }
  }

  // Solve
  const solver = new CpSolver();
  const status = solver.solve(model);

  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    console.log('Solution:');
    const solution: number[][] = [];
    for (let r = 0; r < size; r++) {
      solution[r] = [];
      for (let c = 0; c < size; c++) {
        solution[r][c] = solver.value(grid[r][c]);
      }
    }
    printGrid(solution);

    console.log('\nStatistics:');
    console.log(`  Conflicts: ${solver.numConflicts}`);
    console.log(`  Branches:  ${solver.numBranches}`);
    console.log(`  Presolve:  ${(solver.presolveTime * 1000).toFixed(1)} ms`);
    console.log(`  Search:    ${(solver.searchTime * 1000).toFixed(1)} ms`);
    console.log(`  Total:     ${(solver.wallTime * 1000).toFixed(1)} ms`);
  } else {
    console.log('No solution found!');
  }
}

function printGrid(grid: number[][]) {
  for (let r = 0; r < 9; r++) {
    if (r % 3 === 0 && r > 0) console.log('------+-------+------');
    const row = grid[r].map((v, c) => {
      const sep = c % 3 === 2 && c < 8 ? ' | ' : ' ';
      return `${v || '.'}${sep}`;
    });
    console.log(row.join(''));
  }
}

solveSudoku();
