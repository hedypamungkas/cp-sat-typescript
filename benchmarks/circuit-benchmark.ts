/**
 * Circuit / MultipleCircuit Benchmark
 *
 * Measures propagation effectiveness for Circuit and MultipleCircuit constraints.
 */

import { CpModel } from '../src/model';
import { BoolVarImpl } from '../src/variables';
import {
  runBenchmark,
  runPropagationComparison,
  formatResult,
  formatComparison,
  printSummaryTable,
  BenchmarkResult,
} from './benchmark-utils';

// ============================================================================
// Benchmark Functions
// ============================================================================

/**
 * Create a TSP model with n nodes (complete graph)
 */
function createTSPModel(n: number): CpModel {
  const model = new CpModel();
  const arcs: [number, number, BoolVarImpl][] = [];

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const lit = model.newBoolVar(`x${i}_${j}`);
      arcs.push([i, j, lit]);
    }
  }

  model.addCircuit(arcs);
  return model;
}

/**
 * Create a MultipleCircuit model with n nodes through depot (node 0)
 */
function createVRPModel(n: number): CpModel {
  const model = new CpModel();
  const arcs: [number, number, BoolVarImpl][] = [];

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const lit = model.newBoolVar(`x${i}_${j}`);
      arcs.push([i, j, lit]);
    }
  }

  model.addMultipleCircuit(arcs);
  return model;
}

/**
 * Create an infeasible circuit model (isolated node)
 */
function createInfeasibleCircuitModel(n: number): CpModel {
  const model = new CpModel();
  const arcs: [number, number, BoolVarImpl][] = [];

  // Create arcs but isolate node n-1
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // Skip arcs to/from the last node (except self-loop)
      if ((i === n - 1 || j === n - 1) && i !== j) {
        continue;
      }
      const lit = model.newBoolVar(`x${i}_${j}`);
      arcs.push([i, j, lit]);
    }
  }

  model.addCircuit(arcs);
  return model;
}

// ============================================================================
// Main Benchmark
// ============================================================================

function main(): void {
  console.log('Circuit / MultipleCircuit Benchmark');
  console.log('===================================\n');

  const results: { name: string; withProp: BenchmarkResult; withoutProp: BenchmarkResult; speedup: number; branchReduction: number }[] = [];

  // TSP benchmarks
  const tspSizes = [4, 6, 8, 10, 12];
  for (const n of tspSizes) {
    const name = `TSP n=${n}`;
    console.log(`\nRunning ${name}...`);

    const comparison = runPropagationComparison(
      {
        name,
        buildModel: () => createTSPModel(n),
        maxTimeInSeconds: 30,
      },
      ['CIRCUIT']
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

  // VRP benchmarks
  const vrpSizes = [4, 6, 8, 10];
  for (const n of vrpSizes) {
    const name = `VRP n=${n}`;
    console.log(`\nRunning ${name}...`);

    const comparison = runPropagationComparison(
      {
        name,
        buildModel: () => createVRPModel(n),
        maxTimeInSeconds: 30,
      },
      ['MULTIPLE_CIRCUIT']
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

  // TSP with objective benchmarks
  const tspObjectiveSizes = [4, 6, 8];
  for (const n of tspObjectiveSizes) {
    const name = `TSP-Obj n=${n}`;
    console.log(`\nRunning ${name}...`);

    const comparison = runPropagationComparison(
      {
        name,
        buildModel: () => {
          const model = new CpModel();
          const arcs: [number, number, BoolVarImpl][] = [];
          const arcVars: { i: number; j: number; lit: BoolVarImpl }[] = [];

          for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
              if (i !== j) {
                const lit = model.newBoolVar(`x${i}_${j}`);
                arcs.push([i, j, lit]);
                arcVars.push({ i, j, lit });
              }
            }
          }

          model.addCircuit(arcs);

          // Random distances
          const distances: number[][] = [];
          for (let i = 0; i < n; i++) {
            distances[i] = [];
            for (let j = 0; j < n; j++) {
              distances[i][j] = i === j ? 0 : Math.floor(Math.random() * 100) + 1;
            }
          }

          // Objective: minimize total distance
          const totalDistance = model.newIntVar(0, 10000, 'total');
          const terms = arcVars.map(({ i, j, lit }) => lit.mul(distances[i][j]));
          model.add(totalDistance.eq(terms.reduce((a, b) => a.add(b))));
          model.minimize(totalDistance);

          return model;
        },
        maxTimeInSeconds: 30,
      },
      ['CIRCUIT']
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

  // Infeasible circuit benchmarks
  const infeasibleSizes = [4, 6, 8];
  for (const n of infeasibleSizes) {
    const name = `Infeasible n=${n}`;
    console.log(`\nRunning ${name}...`);

    const comparison = runPropagationComparison(
      {
        name,
        buildModel: () => createInfeasibleCircuitModel(n),
        maxTimeInSeconds: 10,
      },
      ['CIRCUIT']
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
}

main();
