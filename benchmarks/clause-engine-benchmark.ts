/**
 * LCG Clause Engine Benchmark
 *
 * Compares branch-and-bound with the clause engine ON (enableLcg: 2-watched-
 * literal unit propagation) vs OFF (clauses enforced only at solution
 * completion) on Boolean-clause workloads.
 *
 * Run: npx tsx benchmarks/clause-engine-benchmark.ts
 */

import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';
import { BoolVarImpl } from '../src/variables';

interface BenchResult {
  name: string;
  status: CpSolverStatus;
  branches: number;
  conflicts: number;
  wallMs: number;
}

/** Pigeonhole(p, h): p pigeons into h holes, at-most-one per hole. UNSAT when p > h. */
function buildPigeonhole(pigeons: number, holes: number): CpModel {
  const model = new CpModel();
  const pp: BoolVarImpl[][] = [];
  for (let i = 0; i < pigeons; i++) {
    pp.push([]);
    for (let h = 0; h < holes; h++) pp[i].push(model.newBoolVar(`p${i}_${h}`));
  }
  for (let i = 0; i < pigeons; i++) model.addClause(pp[i]); // ≥1 hole
  for (let h = 0; h < holes; h++) {
    for (let i = 0; i < pigeons; i++) {
      for (let j = i + 1; j < pigeons; j++) {
        model.addClause([pp[i][h].negated, pp[j][h].negated]); // ≤1 per hole
      }
    }
  }
  return model;
}

function runBench(name: string, model: CpModel, enableLcg: boolean, maxTimeS: number): BenchResult {
  const solver = new CpSolver();
  solver.parameters.enableLcg = enableLcg;
  solver.parameters.maxTimeInSeconds = maxTimeS;
  const start = Date.now();
  const status = solver.solve(model);
  return {
    name,
    status,
    branches: solver.numBranches,
    conflicts: solver.numConflicts,
    wallMs: Date.now() - start,
  };
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function main(): void {
  console.log('='.repeat(92));
  console.log('LCG Clause Engine — enableLcg ON vs OFF (Boolean clause workloads)');
  console.log('='.repeat(92));
  console.log('');

  const header = [
    'Instance'.padEnd(22),
    'Mode'.padEnd(8),
    'Status'.padEnd(12),
    'Branches'.padEnd(16),
    'Conflicts'.padEnd(16),
    'Wall(ms)'.padEnd(10),
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(92));

  const cases: Array<{ name: string; p: number; h: number }> = [
    { name: 'Pigeonhole(3,2)', p: 3, h: 2 },
    { name: 'Pigeonhole(4,3)', p: 4, h: 3 },
  ];

  for (const { name, p, h } of cases) {
    const off = runBench(name, buildPigeonhole(p, h), false, 30);
    const on = runBench(name, buildPigeonhole(p, h), true, 30);

    const row = (r: BenchResult, mode: string): string =>
      [
        r.name.padEnd(22),
        mode.padEnd(8),
        CpSolverStatus[r.status].padEnd(12),
        fmt(r.branches).padEnd(16),
        fmt(r.conflicts).padEnd(16),
        r.wallMs.toString().padEnd(10),
      ].join(' | ');

    console.log(row(off, 'LCG-off'));
    console.log(row(on, 'LCG-on'));
    const reduction =
      off.branches > 0 ? ((1 - on.branches / off.branches) * 100).toFixed(1) + '%' : 'n/a';
    console.log(`  ↳ branch reduction: ${reduction}`);
    console.log('');
  }

  console.log('='.repeat(92));
  console.log('Notes:');
  console.log('  - Both modes MUST report the same status (soundness: enableLcg only prunes).');
  console.log('  - With enableLcg OFF, clauses are enforced only at solution completion (brute force);');
  console.log('    ON adds 2-watched-literal unit propagation during search — hence the large');
  console.log('    reduction even without clause learning (Phase 2).');
  console.log('  - With enableLcg ON the engine does 2-watched-literal unit propagation (Phase 1)');
  console.log('    AND 1-UIP conflict analysis + clause learning (Phase 2, ChronoBT).');
  console.log('='.repeat(92));
}

main();
