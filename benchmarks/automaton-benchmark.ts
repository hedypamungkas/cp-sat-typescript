/**
 * Automaton Propagation Benchmark
 *
 * Measures solver stats (branches, conflicts, time) for sequence problems
 * constrained by a DFA (Deterministic Finite Automaton), comparing
 * performance with and without automaton propagation.
 *
 * Problem: Find a sequence of N variables, each in domain {0,1,2},
 * such that the sequence is accepted by a DFA that forbids consecutive 1s.
 *
 * DFA: State 0 (start, final) --0--> 0, --1--> 1, --2--> 0
 *      State 1 (final)          --0--> 0, --2--> 0
 *      (no transition on 1 from state 1 → forbids "11")
 *
 * Expected speedup: Without propagation, the solver explores 3^N branches.
 * With propagation, the DFA prunes values at each position, reducing to
 * O(N × |states|) work. For N=15, this is ~135 vs 14M — a ~100,000x
 * theoretical reduction.
 */

import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';
import {
  runBenchmark,
  runPropagationComparison,
  formatResult,
  formatComparison,
  printSummaryTable,
  BenchmarkResult,
} from './benchmark-utils';

// ============================================================================
// DFA: Forbids consecutive 1s
// ============================================================================

/**
 * Create a sequence model with a DFA that forbids consecutive 1s.
 * Variables: x_0, ..., x_{N-1}, each in {0,1,2}
 * DFA transitions:
 *   state 0 --0--> 0, --1--> 1, --2--> 0
 *   state 1 --0--> 0, --2--> 0
 * Final states: {0, 1}
 */
function createForbidConsecutiveOnesModel(n: number): CpModel {
  const model = new CpModel();
  const vars = Array.from({ length: n }, (_, i) => model.newIntVar(0, 2, `x${i}`));

  model.addAutomaton(
    vars,
    0,         // starting state
    [0, 1],    // final states
    [
      // From state 0
      [0, 0, 0],  // 0 --0--> 0
      [0, 1, 1],  // 0 --1--> 1
      [0, 0, 2],  // 0 --2--> 0
      // From state 1
      [1, 0, 0],  // 1 --0--> 0
      [1, 0, 2],  // 1 --2--> 0
      // (no 1--> from state 1, forbids "11")
    ]
  );

  return model;
}

/**
 * Create a sequence model with a more complex DFA: forbids "11" and "22".
 * Variables: x_0, ..., x_{N-1}, each in {0,1,2}
 * This is a 4-state automaton.
 */
function createForbidConsecutiveEqualModel(n: number): CpModel {
  const model = new CpModel();
  const vars = Array.from({ length: n }, (_, i) => model.newIntVar(0, 2, `x${i}`));

  model.addAutomaton(
    vars,
    0,            // starting state
    [0, 1, 2, 3], // all states are final
    [
      // From state 0 (last was 0 or start)
      [0, 1, 1],  // read 1 → state 1
      [0, 2, 2],  // read 2 → state 2
      [0, 0, 0],  // read 0 → state 0
      // From state 1 (last was 1)
      [1, 0, 0],  // read 0 → state 0
      [1, 3, 2],  // read 2 → state 3
      // (no read 1 from state 1 → forbids "11")
      // From state 2 (last was 2)
      [2, 0, 0],  // read 0 → state 0
      [2, 1, 1],  // read 1 → state 1
      // (no read 2 from state 2 → forbids "22")
      // From state 3 (last was ...2, read after 1)
      [3, 0, 0],  // read 0 → state 0
      [3, 1, 1],  // read 1 → state 1
      [3, 2, 2],  // read 2 → state 2 (2 after 1 is fine)
    ]
  );

  return model;
}

// ============================================================================
// Main Benchmark
// ============================================================================

/**
 * Create an optimization model: maximize sum of variables, subject to DFA constraint.
 * This forces the solver to explore many branches to find the optimal solution,
 * making the propagation impact visible.
 */
function createOptimizationModel(n: number): CpModel {
  const model = new CpModel();
  const vars = Array.from({ length: n }, (_, i) => model.newIntVar(0, 2, `x${i}`));

  // DFA: forbids consecutive 1s
  model.addAutomaton(
    vars,
    0,
    [0, 1],
    [
      [0, 0, 0], [0, 1, 1], [0, 0, 2],
      [1, 0, 0], [1, 0, 2],
    ]
  );

  // Maximize sum — forces solver to try higher values
  const sum = vars.reduce((acc, v) => acc.add(v));
  model.maximize(sum);

  return model;
}

/**
 * Create an infeasible model: DFA that accepts no words of length N.
 * This forces the solver to exhaust the entire search tree.
 */
function createInfeasibleModel(n: number): CpModel {
  const model = new CpModel();
  const vars = Array.from({ length: n }, (_, i) => model.newIntVar(0, 2, `x${i}`));

  // DFA with no accepting states → always infeasible
  model.addAutomaton(
    vars,
    0,
    [],  // no final states
    [
      [0, 0, 0], [0, 1, 1], [0, 2, 2],
    ]
  );

  return model;
}

function main(): void {
  console.log('Automaton Propagation Benchmark');
  console.log('================================\n');
  console.log('Problem: Sequence of N variables in {0,1,2} accepted by DFA\n');

  const results: { name: string; withProp: BenchmarkResult; withoutProp: BenchmarkResult; speedup: number; branchReduction: number }[] = [];

  // Optimization: maximize sum with DFA constraint
  console.log('--- Optimization: maximize sum (forbids consecutive 1s) ---');
  const optSizes = [5, 8, 10, 12, 15, 20];
  for (const n of optSizes) {
    const name = `OptSum N=${n}`;
    console.log(`\nRunning ${name}...`);

    const comparison = runPropagationComparison(
      {
        name,
        buildModel: () => createOptimizationModel(n),
        maxTimeInSeconds: 30,
      },
      ['AUTOMATON']
    );

    console.log(formatComparison(name, comparison));
    results.push({
      name,
      withProp: comparison.withPropagation,
      withoutProp: comparison.withoutPropagation,
      speedup: comparison.speedup,
      branchReduction: comparison.branchReduction,
    });
  }

  // Infeasible: forces exhaustive search
  console.log('\n--- Infeasible: no accepting states ---');
  const infSizes = [3, 5, 8, 10];
  for (const n of infSizes) {
    const name = `Infeasible N=${n}`;
    console.log(`\nRunning ${name}...`);

    const comparison = runPropagationComparison(
      {
        name,
        buildModel: () => createInfeasibleModel(n),
        maxTimeInSeconds: 30,
      },
      ['AUTOMATON']
    );

    console.log(formatComparison(name, comparison));
    results.push({
      name,
      withProp: comparison.withPropagation,
      withoutProp: comparison.withoutPropagation,
      speedup: comparison.speedup,
      branchReduction: comparison.branchReduction,
    });
  }

  // Print summary
  printSummaryTable(results);

  // Analysis
  console.log('=== Analysis ===\n');
  console.log('For feasibility-only problems, the solver finds solutions quickly');
  console.log('by assigning the minimum value (0) to each variable. Since 0 is');
  console.log('always a valid transition in the DFA, no backtracking is needed.\n');
  console.log('For optimization problems, the solver must explore higher values,');
  console.log('and the automaton propagation prunes invalid branches.\n');
  console.log('For infeasible problems, the solver must exhaust the entire search');
  console.log('tree, and propagation can dramatically reduce the tree size.');
}

main();
