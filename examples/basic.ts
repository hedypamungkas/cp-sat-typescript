/**
 * CP-SAT TypeScript - Basic Usage Example
 *
 * This example demonstrates the basic usage of the CP-SAT solver
 * to solve a simple optimization problem.
 *
 * Problem: Maximize 2x + 2y + 3z
 * Subject to:
 *   2x + 7y + 3z <= 50
 *   3x - 5y + 7z <= 45
 *   5x + 2y - 6z <= 37
 *   x, y, z >= 0 (integers)
 */

import { CpModel, CpSolver, CpSolverStatus } from '../src';

function main() {
  // Create a new model
  const model = new CpModel();

  // Create variables with bounds
  const varUpperBound = Math.max(50, 45, 37);
  const x = model.newIntVar(0, varUpperBound, 'x');
  const y = model.newIntVar(0, varUpperBound, 'y');
  const z = model.newIntVar(0, varUpperBound, 'z');

  // Add constraints
  // 2x + 7y + 3z <= 50
  model.add(x.mul(2).add(y.mul(7)).add(z.mul(3)).le(50));

  // 3x - 5y + 7z <= 45
  model.add(x.mul(3).sub(y.mul(5)).add(z.mul(7)).le(45));

  // 5x + 2y - 6z <= 37
  model.add(x.mul(5).add(y.mul(2)).sub(z.mul(6)).le(37));

  // Set objective: maximize 2x + 2y + 3z
  model.maximize(x.mul(2).add(y.mul(2)).add(z.mul(3)));

  // Create solver and solve
  const solver = new CpSolver();
  const status = solver.solve(model);

  // Check result
  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    console.log('Solution found!');
    console.log(`  x = ${solver.value(x)}`);
    console.log(`  y = ${solver.value(y)}`);
    console.log(`  z = ${solver.value(z)}`);
    console.log(`  Objective = ${solver.objectiveValue}`);
  } else {
    console.log('No solution found.');
  }

  // Print statistics
  console.log('\nStatistics:');
  console.log(solver.responseStats());
  console.log(`\nTiming breakdown:`);
  console.log(`  Presolve: ${(solver.presolveTime * 1000).toFixed(1)} ms`);
  console.log(`  Search:   ${(solver.searchTime * 1000).toFixed(1)} ms`);
  console.log(`  Total:    ${(solver.wallTime * 1000).toFixed(1)} ms`);
}

main();
