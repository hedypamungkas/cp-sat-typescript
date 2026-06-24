/**
 * LP-Relaxation Bounds Benchmark
 *
 * Compares branch-and-bound with the LP (fractional-knapsack) bound ON vs OFF
 * on 0/1 knapsack instances — the problem class where the interval bound is
 * catastrophically loose and LP relaxation tightens it most.
 *
 * Run: npx tsx benchmarks/lp-bounds-benchmark.ts
 */

import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus, LinearExpr } from '../src/types';

interface BenchResult {
  n: number;
  status: CpSolverStatus;
  objective: number;
  branches: number;
  conflicts: number;
  wallMs: number;
  /** Analytic fractional-knapsack LP bound at the root (for reference). */
  lpBound: number;
  /** Trivial interval bound (sum of all values) at the root. */
  intervalBound: number;
}

function buildKnapsack(n: number): { model: CpModel; weights: number[]; values: number[]; capacity: number } {
  const weights = Array.from({ length: n }, (_, i) => (i * 7 + 3) % 10 + 1);
  const values = Array.from({ length: n }, (_, i) => (i * 13 + 5) % 20 + 1);
  const capacity = Math.floor(weights.reduce((a, b) => a + b, 0) * 0.6);

  const model = new CpModel();
  const items = Array.from({ length: n }, (_, i) => model.newBoolVar(`x${i}`));
  model.add(items.reduce((e, x, i) => e.add(x.mul(weights[i])), new LinearExpr([], [], 0)).le(capacity));
  model.maximize(items.reduce((e, x, i) => e.add(x.mul(values[i])), new LinearExpr([], [], 0)));
  return { model, weights, values, capacity };
}

/** Greedy fractional knapsack LP bound (the value the solver's bound converges to). */
function fractionalKnapsackBound(weights: number[], values: number[], capacity: number): number {
  const items = weights.map((w, i) => ({ w, v: values[i], ratio: values[i] / w }));
  items.sort((a, b) => b.ratio - a.ratio);
  let bound = 0;
  let remaining = capacity;
  for (const it of items) {
    if (remaining >= it.w) {
      bound += it.v;
      remaining -= it.w;
    } else {
      bound += it.ratio * remaining;
      break;
    }
  }
  return bound;
}

function runBench(n: number, enableLpBounds: boolean, maxTimeS: number): BenchResult {
  const { model, weights, values, capacity } = buildKnapsack(n);
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = maxTimeS;
  solver.parameters.enableLpBounds = enableLpBounds;

  const start = Date.now();
  const status = solver.solve(model);
  const wallMs = Date.now() - start;

  return {
    n,
    status,
    objective: solver.objectiveValue,
    branches: solver.numBranches,
    conflicts: solver.numConflicts,
    wallMs,
    lpBound: fractionalKnapsackBound(weights, values, capacity),
    intervalBound: values.reduce((a, b) => a + b, 0),
  };
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function main(): void {
  console.log('='.repeat(96));
  console.log('LP-Relaxation Bounds — Knapsack ON vs OFF');
  console.log('='.repeat(96));
  console.log('');

  const header = [
    'Instance'.padEnd(16),
    'Mode'.padEnd(8),
    'Status'.padEnd(10),
    'Objective'.padEnd(10),
    'Branches'.padEnd(14),
    'Conflicts'.padEnd(14),
    'Wall(ms)'.padEnd(10),
    'Reduction'.padEnd(12),
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(96));

  for (const n of [20, 30, 50]) {
    const maxTime = n >= 50 ? 30 : 30;
    const off = runBench(n, false, maxTime);
    const on = runBench(n, true, maxTime);

    const reduction = off.branches > 0
      ? ((1 - on.branches / off.branches) * 100).toFixed(1) + '%'
      : 'n/a';

    const row = (r: BenchResult, mode: string, reductionStr: string): string => [
      `Knapsack(${r.n})`.padEnd(16),
      mode.padEnd(8),
      CpSolverStatus[r.status].padEnd(10),
      (r.objective ?? 0).toString().padEnd(10),
      fmt(r.branches).padEnd(14),
      fmt(r.conflicts).padEnd(14),
      r.wallMs.toString().padEnd(10),
      reductionStr.padEnd(12),
    ].join(' | ');

    console.log(row(off, 'LP-off', ''));
    console.log(row(on, 'LP-on', reduction));

    console.log(
      `  ↳ LP bound ${on.lpBound.toFixed(1)} vs interval bound ${on.intervalBound} ` +
      `→ ${((1 - on.lpBound / on.intervalBound) * 100).toFixed(1)}% root-bound tightening`
    );
    console.log('');
  }

  console.log('='.repeat(96));
  console.log('Notes:');
  console.log('  - LP-on and LP-off MUST report the same objective (soundness: the tighter');
  console.log('    bound only prunes, it never changes the optimum).');
  console.log('  - Branch reduction reflects how much the fractional-knapsack bound prunes');
  console.log('    vs the trivial interval (sum-of-all-values) bound.');
  console.log('='.repeat(96));
}

main();
