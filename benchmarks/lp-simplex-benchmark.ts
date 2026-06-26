/**
 * LP-Relaxation (full simplex) Bounds Benchmark
 * ===========================================================================
 *
 * Compares branch-and-bound with the full simplex LP bound
 * (`enableSimplexBounds`) ON vs OFF on three problem classes where interval
 * arithmetic is loose and the LP relaxation tightens it most:
 *
 *   1. 0/1 knapsack (maximize, single ≤ row) — the classic case.
 *   2. Multi-constraint 2-D knapsack (maximize, two competing ≤ rows) — beyond
 *      what the single-packing fractional-knapsack bound can see.
 *   3. Set-cover (minimize, a ≥ row) — exercises the LOWER-bound direction.
 *
 * Soundness is asserted on every instance: the optimum is identical ON vs OFF.
 *
 * Run:  npx tsx benchmarks/lp-simplex-benchmark.ts
 */

import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus, LinearExpr } from '../src/types';

interface Result {
  label: string;
  status: CpSolverStatus;
  objective: number;
  branches: number;
  conflicts: number;
  wallMs: number;
}

function time(fn: () => void): number {
  const t0 = Date.now();
  fn();
  return Date.now() - t0;
}

function run(label: string, model: CpModel, enableSimplex: boolean, maxTimeS: number): Result {
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = maxTimeS;
  solver.parameters.enableSimplexBounds = enableSimplex;
  let status: CpSolverStatus = CpSolverStatus.UNKNOWN;
  const wallMs = time(() => {
    status = solver.solve(model);
  });
  return {
    label,
    status,
    objective: solver.objectiveValue,
    branches: solver.numBranches,
    conflicts: solver.numConflicts,
    wallMs,
  };
}

// ---------------------------------------------------------------------------
// Instance builders
// ---------------------------------------------------------------------------

function knapsack(n: number): CpModel {
  const weights = Array.from({ length: n }, (_, i) => (i * 7 + 3) % 10 + 1);
  const values = Array.from({ length: n }, (_, i) => (i * 13 + 5) % 20 + 1);
  const capacity = Math.floor(weights.reduce((a, b) => a + b, 0) * 0.6);
  const m = new CpModel();
  const xs = Array.from({ length: n }, (_, i) => m.newBoolVar(`x${i}`));
  m.add(xs.reduce((e, x, i) => e.add(x.mul(weights[i])), new LinearExpr([], [], 0)).le(capacity));
  m.maximize(xs.reduce((e, x, i) => e.add(x.mul(values[i])), new LinearExpr([], [], 0)));
  return m;
}

function twoDKnapsack(n: number): CpModel {
  const w1 = Array.from({ length: n }, (_, i) => (i * 5 + 2) % 9 + 1);
  const w2 = Array.from({ length: n }, (_, i) => (i * 11 + 3) % 7 + 1);
  const c = Array.from({ length: n }, (_, i) => (i * 13 + 5) % 17 + 2);
  const cap1 = Math.floor(w1.reduce((a, b) => a + b, 0) * 0.5);
  const cap2 = Math.floor(w2.reduce((a, b) => a + b, 0) * 0.5);
  const m = new CpModel();
  const xs = Array.from({ length: n }, (_, i) => m.newBoolVar(`x${i}`));
  m.add(xs.reduce((e, x, i) => e.add(x.mul(w1[i])), new LinearExpr([], [], 0)).le(cap1));
  m.add(xs.reduce((e, x, i) => e.add(x.mul(w2[i])), new LinearExpr([], [], 0)).le(cap2));
  m.maximize(xs.reduce((e, x, i) => e.add(x.mul(c[i])), new LinearExpr([], [], 0)));
  return m;
}

function setCover(n: number): CpModel {
  const costs = Array.from({ length: n }, (_, i) => (i * 5 + 2) % 11 + 1);
  const covers = Array.from({ length: n }, (_, i) => (i * 3 + 1) % 8 + 1);
  const demand = Math.floor(covers.reduce((a, b) => a + b, 0) * 0.5);
  const m = new CpModel();
  const xs = Array.from({ length: n }, (_, i) => m.newBoolVar(`x${i}`));
  m.add(xs.reduce((e, x, i) => e.add(x.mul(covers[i])), new LinearExpr([], [], 0)).ge(demand));
  m.minimize(xs.reduce((e, x, i) => e.add(x.mul(costs[i])), new LinearExpr([], [], 0)));
  return m;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function pct(after: number, before: number): string {
  if (before === 0) return '—';
  const r = ((before - after) / before) * 100;
  return `${r >= 0 ? '−' : '+'}${Math.abs(r).toFixed(1)}%`;
}

function compare(label: string, build: () => CpModel, maxTimeS: number): void {
  console.log(`\n=== ${label} ===`);
  const off = run('simplex OFF', build(), false, maxTimeS);
  const on = run('simplex ON ', build(), true, maxTimeS);
  const rows = [off, on];
  for (const r of rows) {
    console.log(
      `  ${r.label}  obj=${r.objective}  status=${r.status}  ` +
        `branches=${r.branches}  conflicts=${r.conflicts}  time=${r.wallMs}ms`
    );
  }
  // SOUNDNESS: identical optimum (allowing for FEASIBLE vs OPTIMAL on timeout).
  if (off.objective !== on.objective) {
    console.log(`  !! SOUNDNESS VIOLATION: optimum changed ${off.objective} → ${on.objective}`);
  }
  console.log(`  branches ${pct(on.branches, off.branches)}  conflicts ${pct(on.conflicts, off.conflicts)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('LP-Relaxation (full simplex) benchmark — enableSimplexBounds ON vs OFF');
compare('Knapsack n=20 (max, 1 row)', () => knapsack(20), 20);
compare('Knapsack n=30 (max, 1 row)', () => knapsack(30), 20);
compare('2D-knapsack n=18 (max, 2 rows)', () => twoDKnapsack(18), 20);
compare('Set-cover n=18 (min, ≥ row)', () => setCover(18), 20);
