/**
 * Benchmark Utilities
 *
 * Shared infrastructure for benchmarking CP-SAT constraints.
 */

import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';

// ============================================================================
// Types
// ============================================================================

export interface BenchmarkResult {
  name: string;
  status: string;
  branches: number;
  conflicts: number;
  solutions: number;
  wallTime: number;
  searchTime: number;
}

export interface BenchmarkConfig {
  name: string;
  buildModel: () => CpModel;
  maxTimeInSeconds?: number;
  disablePropagationForTypes?: string[];
}

// ============================================================================
// Benchmark Runner
// ============================================================================

/**
 * Run a single benchmark configuration
 */
export function runBenchmark(config: BenchmarkConfig): BenchmarkResult {
  const model = config.buildModel();
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = config.maxTimeInSeconds || 10;

  if (config.disablePropagationForTypes) {
    solver.parameters.disablePropagationForTypes = config.disablePropagationForTypes;
  }

  const status = solver.solve(model);

  return {
    name: config.name,
    status: CpSolverStatus[status],
    branches: solver.numBranches,
    conflicts: solver.numConflicts,
    solutions: solver.numSolutions,
    wallTime: solver.wallTime,
    searchTime: solver.searchTime,
  };
}

/**
 * Run a benchmark with and without propagation, return comparison
 */
export function runPropagationComparison(
  config: BenchmarkConfig,
  constraintTypes: string[]
): { withPropagation: BenchmarkResult; withoutPropagation: BenchmarkResult; speedup: number; branchReduction: number } {
  // Run with propagation
  const withPropagation = runBenchmark(config);

  // Run without propagation
  const withoutPropagation = runBenchmark({
    ...config,
    name: `${config.name} (no prop)`,
    disablePropagationForTypes: constraintTypes,
  });

  // Calculate speedup and branch reduction
  const speedup = withoutPropagation.wallTime > 0
    ? withoutPropagation.wallTime / withPropagation.wallTime
    : Infinity;

  const branchReduction = withoutPropagation.branches > 0
    ? (1 - withPropagation.branches / withoutPropagation.branches) * 100
    : 0;

  return { withPropagation, withoutPropagation, speedup, branchReduction };
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format a benchmark result for display
 */
export function formatResult(result: BenchmarkResult): string {
  return [
    `  Name:       ${result.name}`,
    `  Status:     ${result.status}`,
    `  Branches:   ${result.branches.toLocaleString()}`,
    `  Conflicts:  ${result.conflicts.toLocaleString()}`,
    `  Solutions:  ${result.solutions.toLocaleString()}`,
    `  Wall Time:  ${(result.wallTime * 1000).toFixed(1)}ms`,
    `  Search:     ${(result.searchTime * 1000).toFixed(1)}ms`,
  ].join('\n');
}

/**
 * Format a propagation comparison for display
 */
export function formatComparison(
  name: string,
  comparison: { withPropagation: BenchmarkResult; withoutPropagation: BenchmarkResult; speedup: number; branchReduction: number }
): string {
  return [
    `\n${'='.repeat(60)}`,
    `  ${name}`,
    `${'='.repeat(60)}`,
    `\n  WITH Propagation:`,
    formatResult(comparison.withPropagation),
    `\n  WITHOUT Propagation:`,
    formatResult(comparison.withoutPropagation),
    `\n  Speedup:          ${comparison.speedup === Infinity ? '>1000x' : comparison.speedup.toFixed(1) + 'x'}`,
    `  Branch Reduction: ${comparison.branchReduction.toFixed(1)}%`,
  ].join('\n');
}

/**
 * Print a summary table of all results
 */
export function printSummaryTable(results: { name: string; withProp: BenchmarkResult; withoutProp: BenchmarkResult; speedup: number; branchReduction: number }[]): void {
  console.log('\n' + '='.repeat(100));
  console.log('  SUMMARY');
  console.log('='.repeat(100));
  console.log('');

  // Header
  const header = [
    'Name'.padEnd(30),
    'Status'.padEnd(12),
    'Branches (w/)'.padEnd(15),
    'Branches (w/o)'.padEnd(15),
    'Reduction'.padEnd(12),
    'Speedup'.padEnd(10),
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(100));

  // Rows
  for (const r of results) {
    const row = [
      r.name.substring(0, 28).padEnd(30),
      r.withProp.status.padEnd(12),
      r.withProp.branches.toLocaleString().padEnd(15),
      r.withoutProp.branches.toLocaleString().padEnd(15),
      `${r.branchReduction.toFixed(1)}%`.padEnd(12),
      (r.speedup === Infinity ? '>1000x' : `${r.speedup.toFixed(1)}x`).padEnd(10),
    ].join(' | ');
    console.log(row);
  }
  console.log('');
}
