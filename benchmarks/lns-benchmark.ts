/**
 * Benchmark: LNS vs B&B Comparison
 *
 * Compares Large Neighborhood Search (LNS) against pure Branch-and-Bound (B&B)
 * on optimization problems of varying difficulty.
 */

import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';

// ============================================================================
// Problem Generators
// ============================================================================

function createKnapsack(n: number): CpModel {
  const model = new CpModel();
  const items = Array.from({ length: n }, (_, i) => model.newBoolVar(`x${i}`));

  // Deterministic weights and values
  const weights = Array.from({ length: n }, (_, i) => (i * 7 + 3) % 10 + 1);
  const values = Array.from({ length: n }, (_, i) => (i * 13 + 5) % 20 + 1);
  const capacity = Math.floor(weights.reduce((a, b) => a + b, 0) * 0.6);

  // Weight constraint
  const weightExpr = items.reduce((expr, item, i) => expr.add(item.mul(weights[i])), model.newIntVar(0, 0, 'zero'));
  model.add(weightExpr.le(capacity));

  // Maximize value
  const valueExpr = items.reduce((expr, item, i) => expr.add(item.mul(values[i])), model.newIntVar(0, 0, 'zero'));
  model.maximize(valueExpr);

  return model;
}

function createGraphColoring(n: number): CpModel {
  const model = new CpModel();
  const colors = Array.from({ length: n }, (_, i) => model.newIntVar(0, n - 1, `c${i}`));

  // Each pair of adjacent nodes must have different colors
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      model.add(colors[i].ne(colors[j]));
    }
  }

  return model;
}

function createScheduling(numJobs: number): CpModel {
  const model = new CpModel();
  const horizon = numJobs * 10;

  // Job durations (deterministic)
  const durations = Array.from({ length: numJobs }, (_, i) => (i * 3 + 2) % 8 + 2);

  // Start times
  const starts = Array.from({ length: numJobs }, (_, i) => model.newIntVar(0, horizon, `s${i}`));

  // End times
  const ends = Array.from({ length: numJobs }, (_, i) => model.newIntVar(0, horizon, `e${i}`));

  // Start + duration = end
  for (let i = 0; i < numJobs; i++) {
    model.add(starts[i].add(durations[i]).eq(ends[i]));
  }

  // Minimize makespan (max end time)
  const makespan = model.newIntVar(0, horizon, 'makespan');
  for (let i = 0; i < numJobs; i++) {
    model.add(makespan.ge(ends[i]));
  }
  model.minimize(makespan);

  return model;
}

// ============================================================================
// Benchmark Runner
// ============================================================================

interface BenchmarkResult {
  name: string;
  method: string;
  status: string;
  objective: number;
  branches: number;
  conflicts: number;
  wallTimeMs: number;
}

function runBB(name: string, model: CpModel, maxTime: number): BenchmarkResult {
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = maxTime;

  const start = performance.now();
  const status = solver.solve(model);
  const wallTimeMs = performance.now() - start;

  return {
    name,
    method: 'B&B',
    status: CpSolverStatus[status],
    objective: solver.objectiveValue,
    branches: solver.numBranches,
    conflicts: solver.numConflicts,
    wallTimeMs,
  };
}

function runLNS(
  name: string,
  model: CpModel,
  maxTime: number,
  maxIterations: number,
  neighborhoodSize: number
): BenchmarkResult {
  const solver = new CpSolver();
  solver.parameters.enableLNS = true;
  solver.parameters.lnsMaxIterations = maxIterations;
  solver.parameters.lnsNeighborhoodSize = neighborhoodSize;
  solver.parameters.maxTimeInSeconds = maxTime;

  const start = performance.now();
  const status = solver.solve(model);
  const wallTimeMs = performance.now() - start;

  return {
    name,
    method: `LNS(${maxIterations}iter,${(neighborhoodSize * 100).toFixed(0)}%)`,
    status: CpSolverStatus[status],
    objective: solver.objectiveValue,
    branches: solver.numBranches,
    conflicts: solver.numConflicts,
    wallTimeMs,
  };
}

function formatResult(result: BenchmarkResult): string {
  return [
    `  Method:     ${result.method}`,
    `  Status:     ${result.status}`,
    `  Objective:  ${result.objective}`,
    `  Branches:   ${result.branches.toLocaleString()}`,
    `  Conflicts:  ${result.conflicts.toLocaleString()}`,
    `  Time:       ${result.wallTimeMs.toFixed(1)}ms`,
  ].join('\n');
}

// ============================================================================
// Main Benchmark Suite
// ============================================================================

console.log('='.repeat(70));
console.log('  LNS vs B&B Benchmark');
console.log('='.repeat(70));

const allResults: BenchmarkResult[] = [];

// Knapsack benchmarks
console.log('\n--- 0/1 Knapsack ---');
for (const n of [20, 30, 40]) {
  const model = createKnapsack(n);
  const maxTime = n > 30 ? 60 : 30;

  console.log(`\nKnapsack(${n} items):`);

  // B&B
  const bbResult = runBB(`Knapsack(${n})`, model, maxTime);
  allResults.push(bbResult);
  console.log(`\n  B&B:`);
  console.log(formatResult(bbResult));

  // LNS with different configurations
  for (const [iters, size] of [[5, 0.3], [10, 0.5], [20, 0.7]] as [number, number][]) {
    const lnsResult = runLNS(`Knapsack(${n})`, model, maxTime, iters, size);
    allResults.push(lnsResult);
    console.log(`\n  LNS(${iters}iter,${(size * 100).toFixed(0)}%):`);
    console.log(formatResult(lnsResult));
  }
}

// Graph Coloring benchmarks
console.log('\n--- Graph Coloring ---');
for (const n of [7, 8, 9]) {
  const model = createGraphColoring(n);
  const maxTime = 30;

  console.log(`\nGraph Coloring K${n}:`);

  // B&B
  const bbResult = runBB(`GraphColor(K${n})`, model, maxTime);
  allResults.push(bbResult);
  console.log(`\n  B&B:`);
  console.log(formatResult(bbResult));

  // LNS
  const lnsResult = runLNS(`GraphColor(K${n})`, model, maxTime, 10, 0.5);
  allResults.push(lnsResult);
  console.log(`\n  LNS(10iter,50%):`);
  console.log(formatResult(lnsResult));
}

// Scheduling benchmarks
console.log('\n--- Scheduling ---');
for (const n of [10, 15, 20]) {
  const model = createScheduling(n);
  const maxTime = 30;

  console.log(`\nScheduling(${n} jobs):`);

  // B&B
  const bbResult = runBB(`Scheduling(${n})`, model, maxTime);
  allResults.push(bbResult);
  console.log(`\n  B&B:`);
  console.log(formatResult(bbResult));

  // LNS
  const lnsResult = runLNS(`Scheduling(${n})`, model, maxTime, 10, 0.5);
  allResults.push(lnsResult);
  console.log(`\n  LNS(10iter,50%):`);
  console.log(formatResult(lnsResult));
}

// Summary table
console.log('\n' + '='.repeat(90));
console.log('  SUMMARY');
console.log('='.repeat(90));
console.log('');

const header = [
  'Problem'.padEnd(20),
  'Method'.padEnd(20),
  'Status'.padEnd(12),
  'Objective'.padEnd(12),
  'Branches'.padEnd(12),
  'Time (ms)'.padEnd(12),
].join(' | ');
console.log(header);
console.log('-'.repeat(90));

for (const r of allResults) {
  const row = [
    r.name.substring(0, 18).padEnd(20),
    r.method.substring(0, 18).padEnd(20),
    r.status.padEnd(12),
    r.objective.toString().padEnd(12),
    r.branches.toLocaleString().padEnd(12),
    r.wallTimeMs.toFixed(1).padEnd(12),
  ].join(' | ');
  console.log(row);
}

console.log('\n' + '='.repeat(90));
