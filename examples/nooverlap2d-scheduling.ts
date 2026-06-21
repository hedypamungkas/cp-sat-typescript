/**
 * NoOverlap2D Scheduling Example
 *
 * Demonstrates the NoOverlap2D constraint for solving:
 * 1. Rectangle packing (2D bin packing)
 * 2. Task assignment (machine + time)
 * 3. Facility layout
 */

import { CpModel, CpSolver, CpSolverStatus } from '../src';

// ============================================================================
// Example 1: Simple Rectangle Packing
// ============================================================================

function solveRectanglePacking() {
  console.log('=== Example 1: Simple Rectangle Packing ===');
  console.log('Pack rectangles into a container without overlap.\n');

  const model = new CpModel();

  // Container size: 6x6
  const containerWidth = 6;
  const containerHeight = 6;

  // Rectangles with fixed sizes
  const rects = [
    { w: 2, h: 3, name: 'Rect A' },
    { w: 2, h: 2, name: 'Rect B' },
    { w: 3, h: 2, name: 'Rect C' },
  ];

  const xVars = [];
  const yVars = [];
  const xIntervals = [];
  const yIntervals = [];

  for (let i = 0; i < rects.length; i++) {
    const x = model.newIntVar(0, containerWidth - rects[i].w, `x${i}`);
    const y = model.newIntVar(0, containerHeight - rects[i].h, `y${i}`);
    xVars.push(x);
    yVars.push(y);
    xIntervals.push(model.newFixedSizeIntervalVar(x, rects[i].w, `xIv${i}`));
    yIntervals.push(model.newFixedSizeIntervalVar(y, rects[i].h, `yIv${i}`));
  }

  // Add 2D no-overlap constraint
  model.addNoOverlap2D(xIntervals, yIntervals);

  // Solve
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    console.log('Rectangle positions:');
    for (let i = 0; i < rects.length; i++) {
      const x = solver.value(xVars[i]);
      const y = solver.value(yVars[i]);
      console.log(`  ${rects[i].name}: (${x}, ${y}) size ${rects[i].w}x${rects[i].h}`);
    }

    // Visualize
    console.log('\nContainer layout:');
    const grid: string[][] = [];
    for (let y = 0; y < containerHeight; y++) {
      grid.push(new Array(containerWidth).fill('.'));
    }

    const labels = ['A', 'B', 'C'];
    for (let i = 0; i < rects.length; i++) {
      const x = solver.value(xVars[i]);
      const y = solver.value(yVars[i]);
      for (let dy = 0; dy < rects[i].h; dy++) {
        for (let dx = 0; dx < rects[i].w; dx++) {
          grid[y + dy][x + dx] = labels[i];
        }
      }
    }

    for (let y = containerHeight - 1; y >= 0; y--) {
      console.log(`  ${grid[y].join(' ')}`);
    }
  }
  console.log();
}

// ============================================================================
// Example 2: Task Assignment (Machine + Time)
// ============================================================================

function solveTaskAssignment() {
  console.log('=== Example 2: Task Assignment (Machine + Time) ===');
  console.log('Assign tasks to machines at specific times without conflict.\n');

  const model = new CpModel();

  // 3 tasks, each can be on 2 machines
  const tasks = [
    { duration: 2, machines: [0, 1], name: 'Task 1' },
    { duration: 3, machines: [0, 1], name: 'Task 2' },
    { duration: 2, machines: [0, 1], name: 'Task 3' },
  ];

  // Time horizon: 0-8
  const timeHorizon = 8;
  const numMachines = 2;

  // For each task, create time and machine variables
  const timeVars = [];
  const machineVars = [];
  const timeIntervals = [];
  const machineIntervals = [];

  for (let i = 0; i < tasks.length; i++) {
    const t = model.newIntVar(0, timeHorizon - tasks[i].duration, `time${i}`);
    const m = model.newIntVar(0, numMachines - 1, `machine${i}`);
    timeVars.push(t);
    machineVars.push(m);
    timeIntervals.push(model.newFixedSizeIntervalVar(t, tasks[i].duration, `tIv${i}`));
    machineIntervals.push(model.newFixedSizeIntervalVar(m, 1, `mIv${i}`));
  }

  // Add 2D no-overlap constraint (time x machine)
  model.addNoOverlap2D(timeIntervals, machineIntervals);

  // Solve
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    console.log('Task schedule:');
    for (let i = 0; i < tasks.length; i++) {
      const t = solver.value(timeVars[i]);
      const m = solver.value(machineVars[i]);
      console.log(`  ${tasks[i].name}: machine ${m}, time ${t}-${t + tasks[i].duration}`);
    }

    // Visualize timeline
    console.log('\nTimeline:');
    for (let m = 0; m < numMachines; m++) {
      const timeline: string[] = new Array(timeHorizon).fill('-');
      for (let i = 0; i < tasks.length; i++) {
        if (solver.value(machineVars[i]) === m) {
          const t = solver.value(timeVars[i]);
          for (let d = 0; d < tasks[i].duration; d++) {
            timeline[t + d] = `${i + 1}`;
          }
        }
      }
      console.log(`  Machine ${m}: ${timeline.join(' ')}`);
    }
  }
  console.log();
}

// ============================================================================
// Example 3: Facility Layout
// ============================================================================

function solveFacilityLayout() {
  console.log('=== Example 3: Facility Layout ===');
  console.log('Place facilities on a grid without overlap.\n');

  const model = new CpModel();

  // Grid size: 8x8
  const gridWidth = 8;
  const gridHeight = 8;

  // Facilities with sizes
  const facilities = [
    { w: 3, h: 2, name: 'Warehouse' },
    { w: 2, h: 3, name: 'Office' },
    { w: 2, h: 2, name: 'Parking' },
    { w: 3, h: 3, name: 'Factory' },
  ];

  const xVars = [];
  const yVars = [];
  const xIntervals = [];
  const yIntervals = [];

  for (let i = 0; i < facilities.length; i++) {
    const x = model.newIntVar(0, gridWidth - facilities[i].w, `x${i}`);
    const y = model.newIntVar(0, gridHeight - facilities[i].h, `y${i}`);
    xVars.push(x);
    yVars.push(y);
    xIntervals.push(model.newFixedSizeIntervalVar(x, facilities[i].w, `xIv${i}`));
    yIntervals.push(model.newFixedSizeIntervalVar(y, facilities[i].h, `yIv${i}`));
  }

  // Add 2D no-overlap constraint
  model.addNoOverlap2D(xIntervals, yIntervals);

  // Solve
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    console.log('Facility positions:');
    for (let i = 0; i < facilities.length; i++) {
      const x = solver.value(xVars[i]);
      const y = solver.value(yVars[i]);
      console.log(`  ${facilities[i].name}: (${x}, ${y}) size ${facilities[i].w}x${facilities[i].h}`);
    }

    // Visualize grid
    console.log('\nGrid layout:');
    const grid: string[][] = [];
    for (let y = 0; y < gridHeight; y++) {
      grid.push(new Array(gridWidth).fill('.'));
    }

    const labels = ['W', 'O', 'P', 'F'];
    for (let i = 0; i < facilities.length; i++) {
      const x = solver.value(xVars[i]);
      const y = solver.value(yVars[i]);
      for (let dy = 0; dy < facilities[i].h; dy++) {
        for (let dx = 0; dx < facilities[i].w; dx++) {
          grid[y + dy][x + dx] = labels[i];
        }
      }
    }

    for (let y = gridHeight - 1; y >= 0; y--) {
      console.log(`  ${grid[y].join(' ')}`);
    }
  }
  console.log();
}

// ============================================================================
// Run all examples
// ============================================================================

solveRectanglePacking();
solveTaskAssignment();
solveFacilityLayout();
