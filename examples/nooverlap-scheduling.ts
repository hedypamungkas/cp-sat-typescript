/**
 * CP-SAT TypeScript - NoOverlap Scheduling Example
 *
 * Schedule non-overlapping tasks on a single machine.
 * Each task has a start time and duration. Tasks cannot overlap.
 *
 * With scheduling propagation enabled, the solver efficiently prunes
 * infeasible orderings using Simple Precedences, Detectable Precedences,
 * Not-Last, and Edge-Finding algorithms.
 */

import { CpModel, CpSolver, CpSolverStatus, IntVarImpl, IntervalVarImpl } from '../src';

function solveNoOverlapBasic() {
  console.log('=== NoOverlap Scheduling ===\n');

  const model = new CpModel();

  // 2 tasks with different durations
  const tasks = [
    { name: 'Job A', duration: 4 },
    { name: 'Job B', duration: 3 },
    { name: 'Job C', duration: 5 },
  ];

  const starts: IntVarImpl[] = [];
  const intervals: IntervalVarImpl[] = [];

  for (const t of tasks) {
    const s = model.newIntVar(0, 15, `start_${t.name}`);
    starts.push(s);
    intervals.push(model.newFixedSizeIntervalVar(s, t.duration, t.name));
  }

  // NoOverlap constraint — propagated via Simple Precedences + Edge-Finding
  model.addNoOverlap(intervals);

  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    console.log('Schedule:');
    const schedule = tasks.map((t, i) => ({
      name: t.name,
      start: solver.value(starts[i]),
      end: solver.value(starts[i]) + t.duration,
      duration: t.duration,
    }));

    schedule.sort((a, b) => a.start - b.start);

    for (const s of schedule) {
      const bar = '█'.repeat(s.duration);
      const pad = ' '.repeat(s.start);
      console.log(`  ${s.name.padEnd(8)} ${pad}${bar} (${s.start}-${s.end})`);
    }

    console.log(`\nStatistics:`);
    console.log(`  Branches:  ${solver.numBranches}`);
    console.log(`  Conflicts: ${solver.numConflicts}`);
    console.log(`  Time:      ${(solver.wallTime * 1000).toFixed(1)} ms`);
  } else {
    console.log('No solution found!');
  }
}

function solveNoOverlapWithPrecedence() {
  console.log('\n\n=== NoOverlap with Precedence Constraints ===\n');

  const model = new CpModel();

  // 4 tasks: A must finish before C starts, B must finish before D starts
  const sA = model.newIntVar(0, 20, 'sA');
  const sB = model.newIntVar(0, 20, 'sB');
  const sC = model.newIntVar(0, 20, 'sC');
  const sD = model.newIntVar(0, 20, 'sD');

  const ivA = model.newFixedSizeIntervalVar(sA, 3, 'tA');
  const ivB = model.newFixedSizeIntervalVar(sB, 4, 'tB');
  const ivC = model.newFixedSizeIntervalVar(sC, 2, 'tC');
  const ivD = model.newFixedSizeIntervalVar(sD, 5, 'tD');

  model.addNoOverlap([ivA, ivB, ivC, ivD]);

  // Precedence: A before C, B before D
  model.add(sA.add(3).le(sC));
  model.add(sB.add(4).le(sD));

  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 5;
  const status = solver.solve(model);

  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    console.log('Schedule:');
    console.log(`  A: ${solver.value(sA)}-${solver.value(sA) + 3}`);
    console.log(`  B: ${solver.value(sB)}-${solver.value(sB) + 4}`);
    console.log(`  C: ${solver.value(sC)}-${solver.value(sC) + 2}`);
    console.log(`  D: ${solver.value(sD)}-${solver.value(sD) + 5}`);
    console.log(`\nBranches: ${solver.numBranches}, Conflicts: ${solver.numConflicts}`);
  }
}

function solveNoOverlapInfeasible() {
  console.log('\n\n=== NoOverlap Infeasible (detected instantly) ===\n');

  const model = new CpModel();

  // 5 tasks of size 3 in domain [0,10] — needs 15 units but only 11 available
  const intervals = [];
  for (let i = 0; i < 5; i++) {
    const s = model.newIntVar(0, 10, `s${i}`);
    intervals.push(model.newFixedSizeIntervalVar(s, 3, `t${i}`));
  }
  model.addNoOverlap(intervals);

  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 5;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  console.log(`Branches: ${solver.numBranches} (should be 0 — detected in presolve)`);
  console.log(`Time: ${(solver.wallTime * 1000).toFixed(1)} ms`);
}

function solveNoOverlapPropagationDemo() {
  console.log('\n\n=== Propagation Impact Demo ===\n');

  // Compare: 2 tasks, domain [0,20], size 3
  // Without propagation: ~70 branches
  // With propagation: ~6 branches
  const model = new CpModel();
  const s1 = model.newIntVar(0, 20, 's1');
  const s2 = model.newIntVar(0, 20, 's2');
  const iv1 = model.newFixedSizeIntervalVar(s1, 3, 't1');
  const iv2 = model.newFixedSizeIntervalVar(s2, 3, 't2');
  model.addNoOverlap([iv1, iv2]);

  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 5;
  solver.solve(model);

  console.log(`2 tasks, domain [0,20], size 3:`);
  console.log(`  Branches: ${solver.numBranches}`);
  console.log(`  (Without propagation: ~70 branches)`);
}

solveNoOverlapBasic();
solveNoOverlapWithPrecedence();
solveNoOverlapInfeasible();
solveNoOverlapPropagationDemo();
