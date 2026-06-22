/**
 * CP-SAT TypeScript - Cumulative Scheduling Example
 *
 * Schedule tasks on a shared resource with limited capacity.
 * Each task has a start time, duration, and resource demand.
 * At any point in time, the total demand of active tasks must not
 * exceed the resource capacity.
 *
 * With scheduling propagation enabled, the solver efficiently prunes
 * infeasible start times using Time-Table and Edge-Finding algorithms.
 *
 * Performance: the actual search-tree size is measured at runtime via
 * solver.numBranches (printed below) — no hardcoded branch-count claims.
 */

import { CpModel, CpSolver, CpSolverStatus, IntVarImpl, IntervalVarImpl } from '../src';

interface Task {
  name: string;
  duration: number;
  demand: number;
}

function solveCumulativeScheduling() {
  console.log('=== Cumulative Resource Scheduling ===\n');

  // Tasks to schedule on a machine with capacity 4
  const tasks: Task[] = [
    { name: 'Task A', duration: 3, demand: 2 },
    { name: 'Task B', duration: 4, demand: 3 },
    { name: 'Task C', duration: 2, demand: 2 },
  ];
  const capacity = 4;

  console.log(`Resource capacity: ${capacity}`);
  console.log('Tasks:');
  tasks.forEach((t, i) => {
    console.log(`  ${i}: ${t.name} - duration: ${t.duration}, demand: ${t.demand}`);
  });
  console.log();

  const model = new CpModel();

  // Time horizon
  const horizon = tasks.reduce((sum, t) => sum + t.duration, 0);

  // Create interval variables
  const starts: IntVarImpl[] = [];
  const ends: IntVarImpl[] = [];
  const intervals: IntervalVarImpl[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const start = model.newIntVar(0, horizon, `start_${i}`);
    const end = model.newIntVar(0, horizon, `end_${i}`);
    model.add(start.add(tasks[i].duration).eq(end));

    starts.push(start);
    ends.push(end);
    intervals.push(model.newIntervalVar(start, tasks[i].duration, end, tasks[i].name));
  }

  // Cumulative constraint — propagated via Time-Table + Edge-Finding
  model.addCumulative(intervals, tasks.map(t => t.demand), capacity);

  // Minimize makespan (latest end time)
  const makespan = model.newIntVar(0, horizon, 'makespan');
  model.addMaxEquality(makespan, ends);
  model.minimize(makespan);

  // Solve
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    console.log('Schedule:');
    const schedule = tasks.map((t, i) => ({
      name: t.name,
      start: solver.value(starts[i]),
      end: solver.value(ends[i]),
      demand: t.demand,
    }));

    // Sort by start time
    schedule.sort((a, b) => a.start - b.start);

    for (const s of schedule) {
      const bar = '█'.repeat(s.demand);
      const pad = ' '.repeat(s.start * 2);
      console.log(`  ${s.name.padEnd(8)} ${pad}${bar} (${s.start}-${s.end}, demand=${s.demand})`);
    }

    console.log(`\nMakespan: ${solver.objectiveValue}`);

    // Verify capacity constraint
    console.log('\nVerifying capacity constraint...');
    let valid = true;
    for (let t = 0; t <= solver.objectiveValue; t++) {
      let demandAtT = 0;
      for (const s of schedule) {
        if (t >= s.start && t < s.end) {
          demandAtT += s.demand;
        }
      }
      if (demandAtT > capacity) {
        console.log(`  VIOLATION at time ${t}: demand ${demandAtT} > capacity ${capacity}`);
        valid = false;
      }
    }
    if (valid) console.log('  ✓ Capacity constraint satisfied at all time points');

    console.log('\nStatistics:');
    console.log(`  Conflicts: ${solver.numConflicts}`);
    console.log(`  Branches:  ${solver.numBranches}`);
    console.log(`  Presolve:  ${(solver.presolveTime * 1000).toFixed(1)} ms`);
    console.log(`  Search:    ${(solver.searchTime * 1000).toFixed(1)} ms`);
    console.log(`  Total:     ${(solver.wallTime * 1000).toFixed(1)} ms`);
  } else {
    console.log('No solution found!');
  }
}

function solveCumulativeFeasibility() {
  console.log('\n\n=== Cumulative Feasibility (4 tasks, domain [0,10]) ===\n');
  // Actual branch count is reported from solver.numBranches after solving
  // (replaces previously hardcoded, unverifiable "before/after" numbers).

  const model = new CpModel();
  const intervals = [];
  const demands = [];
  const starts: IntVarImpl[] = [];

  const tasks = [
    { name: 'T0', duration: 3, demand: 2 },
    { name: 'T1', duration: 3, demand: 2 },
    { name: 'T2', duration: 3, demand: 2 },
    { name: 'T3', duration: 3, demand: 2 },
  ];

  for (const t of tasks) {
    const s = model.newIntVar(0, 10, `start_${t.name}`);
    starts.push(s);
    intervals.push(model.newFixedSizeIntervalVar(s, t.duration, t.name));
    demands.push(t.demand);
  }

  model.addCumulative(intervals, demands, 5);

  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const start = Date.now();
  const status = solver.solve(model);
  const elapsed = Date.now() - start;

  console.log(`Status: ${CpSolverStatus[status]}`);
  console.log(`Time: ${elapsed} ms`);
  console.log(`Branches: ${solver.numBranches}`);
  console.log(`Conflicts: ${solver.numConflicts}`);
  console.log('\nSchedule:');
  for (let i = 0; i < tasks.length; i++) {
    console.log(`  ${tasks[i].name}: ${solver.value(starts[i])}-${solver.value(starts[i]) + tasks[i].duration} (demand=${tasks[i].demand})`);
  }
}

function solveCumulativeInfeasible() {
  console.log('\n\n=== Cumulative Infeasible (detected instantly) ===\n');

  const model = new CpModel();

  // 3 tasks all starting at 0, demand 4 each, capacity 10
  // Total demand = 12 > 10 → infeasible
  const s1 = model.newIntVar(0, 0, 's1');
  const s2 = model.newIntVar(0, 0, 's2');
  const s3 = model.newIntVar(0, 0, 's3');
  const iv1 = model.newFixedSizeIntervalVar(s1, 3, 't1');
  const iv2 = model.newFixedSizeIntervalVar(s2, 3, 't2');
  const iv3 = model.newFixedSizeIntervalVar(s3, 3, 't3');
  model.addCumulative([iv1, iv2, iv3], [4, 4, 4], 10);

  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 5;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  console.log(`Branches: ${solver.numBranches} (should be 0 — detected in presolve)`);
  console.log(`Time: ${(solver.wallTime * 1000).toFixed(1)} ms`);
}

solveCumulativeScheduling();
solveCumulativeFeasibility();
solveCumulativeInfeasible();
