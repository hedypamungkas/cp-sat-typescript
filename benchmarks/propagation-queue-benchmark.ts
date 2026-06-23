/**
 * Benchmark: Propagation Queue Performance
 *
 * Measures the performance of the propagation queue optimization
 * across different problem types and sizes.
 */

import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';

// ============================================================================
// Problem Generators
// ============================================================================

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

function createNQueens(n: number): CpModel {
  const model = new CpModel();
  const queens = Array.from({ length: n }, (_, i) => model.newIntVar(0, n - 1, `q${i}`));

  // All different rows
  model.addAllDifferent(queens);

  // All different diagonals
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      model.add(queens[i].sub(queens[j]).ne(j - i));
      model.add(queens[i].sub(queens[j]).ne(i - j));
    }
  }

  return model;
}

function createScheduling(numJobs: number, numMachines: number): CpModel {
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

  // Each machine processes one job at a time (simplified)
  // For now, just ensure jobs don't overlap on the same machine
  // This is a simplified version - real scheduling would use NoOverlap

  return model;
}

// ============================================================================
// Benchmark Runner
// ============================================================================

interface BenchmarkResult {
  name: string;
  status: string;
  branches: number;
  conflicts: number;
  solutions: number;
  wallTimeMs: number;
  searchTimeMs: number;
}

function runBenchmark(name: string, model: CpModel, maxTime: number = 30): BenchmarkResult {
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = maxTime;

  const start = performance.now();
  const status = solver.solve(model);
  const wallTimeMs = performance.now() - start;

  return {
    name,
    status: CpSolverStatus[status],
    branches: solver.numBranches,
    conflicts: solver.numConflicts,
    solutions: solver.numSolutions,
    wallTimeMs,
    searchTimeMs: solver.searchTime * 1000,
  };
}

function formatResult(result: BenchmarkResult): string {
  return [
    `  Status:     ${result.status}`,
    `  Branches:   ${result.branches.toLocaleString()}`,
    `  Conflicts:  ${result.conflicts.toLocaleString()}`,
    `  Solutions:  ${result.solutions.toLocaleString()}`,
    `  Wall Time:  ${result.wallTimeMs.toFixed(1)}ms`,
    `  Search:     ${result.searchTimeMs.toFixed(1)}ms`,
  ].join('\n');
}

// ============================================================================
// Main Benchmark Suite
// ============================================================================

console.log('='.repeat(70));
console.log('  CP-SAT Propagation Queue Benchmark');
console.log('='.repeat(70));

const results: BenchmarkResult[] = [];

// Graph Coloring benchmarks
console.log('\n--- Graph Coloring ---');
for (const n of [5, 6, 7, 8]) {
  const result = runBenchmark(`Graph Coloring K${n}`, createGraphColoring(n));
  results.push(result);
  console.log(`\n${result.name}:`);
  console.log(formatResult(result));
}

// N-Queens benchmarks
console.log('\n--- N-Queens ---');
for (const n of [8, 10, 12]) {
  const result = runBenchmark(`N-Queens(${n})`, createNQueens(n));
  results.push(result);
  console.log(`\n${result.name}:`);
  console.log(formatResult(result));
}

// Knapsack benchmarks
console.log('\n--- 0/1 Knapsack ---');
for (const n of [10, 20, 30, 40]) {
  const result = runBenchmark(`Knapsack(${n} items)`, createKnapsack(n), n > 30 ? 60 : 30);
  results.push(result);
  console.log(`\n${result.name}:`);
  console.log(formatResult(result));
}

// Summary table
console.log('\n' + '='.repeat(70));
console.log('  SUMMARY');
console.log('='.repeat(70));
console.log('');

const header = [
  'Name'.padEnd(25),
  'Status'.padEnd(12),
  'Branches'.padEnd(12),
  'Conflicts'.padEnd(12),
  'Time (ms)'.padEnd(12),
].join(' | ');
console.log(header);
console.log('-'.repeat(70));

for (const r of results) {
  const row = [
    r.name.substring(0, 23).padEnd(25),
    r.status.padEnd(12),
    r.branches.toLocaleString().padEnd(12),
    r.conflicts.toLocaleString().padEnd(12),
    r.wallTimeMs.toFixed(1).padEnd(12),
  ].join(' | ');
  console.log(row);
}

console.log('\n' + '='.repeat(70));
