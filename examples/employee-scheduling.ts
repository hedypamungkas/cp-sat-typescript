/**
 * CP-SAT TypeScript - Employee Scheduling Example
 *
 * This example demonstrates how to use CP-SAT for shift scheduling.
 *
 * Problem: Schedule nurses to shifts with constraints:
 * - Each shift must have exactly one nurse
 * - Each nurse works at most one shift per day
 * - Shifts are distributed fairly among nurses
 */

import { CpModel, CpSolver, CpSolverStatus, BoolVarImpl } from '../src';

interface ScheduleResult {
  nurse: number;
  day: number;
  shift: number;
}

function solveEmployeeScheduling() {
  console.log('Employee Scheduling Example\n');

  // Problem parameters
  const numNurses = 4;
  const numDays = 3;
  const numShifts = 3;

  console.log(`Nurses: ${numNurses}`);
  console.log(`Days: ${numDays}`);
  console.log(`Shifts per day: ${numShifts}`);
  console.log();

  const model = new CpModel();

  // Create boolean variables: shifts[n][d][s] = 1 if nurse n works shift s on day d
  const shifts: Record<string, BoolVarImpl> = {};
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      for (let s = 0; s < numShifts; s++) {
        shifts[`${n}_${d}_${s}`] = model.newBoolVar(`shift_n${n}_d${d}_s${s}`);
      }
    }
  }

  // Constraint 1: Each shift each day is assigned to exactly one nurse
  for (let d = 0; d < numDays; d++) {
    for (let s = 0; s < numShifts; s++) {
      const nursesForShift = [];
      for (let n = 0; n < numNurses; n++) {
        nursesForShift.push(shifts[`${n}_${d}_${s}`]);
      }
      model.addExactlyOne(nursesForShift);
    }
  }

  // Constraint 2: Each nurse works at most one shift per day
  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays; d++) {
      const shiftsForDay = [];
      for (let s = 0; s < numShifts; s++) {
        shiftsForDay.push(shifts[`${n}_${d}_${s}`]);
      }
      model.addAtMostOne(shiftsForDay);
    }
  }

  // Constraint 3: Fair distribution of shifts
  const totalShifts = numDays * numShifts;
  const minShifts = Math.floor(totalShifts / numNurses);
  const maxShifts = Math.ceil(totalShifts / numNurses);

  for (let n = 0; n < numNurses; n++) {
    const nurseShifts = [];
    for (let d = 0; d < numDays; d++) {
      for (let s = 0; s < numShifts; s++) {
        nurseShifts.push(shifts[`${n}_${d}_${s}`]);
      }
    }
    const sum = nurseShifts.reduce((a, b) => a.add(b));
    model.add(sum.ge(minShifts));
    model.add(sum.le(maxShifts));
  }

  // Solve
  const solver = new CpSolver();
  const status = solver.solve(model);

  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    console.log('Schedule found!\n');

    // Extract schedule
    const schedule: ScheduleResult[] = [];
    for (let d = 0; d < numDays; d++) {
      console.log(`Day ${d + 1}:`);
      for (let s = 0; s < numShifts; s++) {
        for (let n = 0; n < numNurses; n++) {
          if (solver.booleanValue(shifts[`${n}_${d}_${s}`])) {
            console.log(`  Shift ${s + 1}: Nurse ${n + 1}`);
            schedule.push({ nurse: n, day: d, shift: s });
          }
        }
      }
    }

    // Print statistics
    console.log('\nStatistics:');
    console.log(solver.responseStats());
    console.log(`\nTiming breakdown:`);
    console.log(`  Presolve: ${(solver.presolveTime * 1000).toFixed(1)} ms`);
    console.log(`  Search:   ${(solver.searchTime * 1000).toFixed(1)} ms`);
    console.log(`  Total:    ${(solver.wallTime * 1000).toFixed(1)} ms`);
  } else {
    console.log('No solution found.');
  }
}

solveEmployeeScheduling();
