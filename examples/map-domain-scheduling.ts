/**
 * MAP_DOMAIN Scheduling Example
 *
 * Demonstrates the MAP_DOMAIN constraint for solving:
 * 1. Shift assignment (map shift type to boolean indicators)
 * 2. Color assignment (map color to boolean indicators)
 * 3. Resource allocation (map resource to boolean indicators)
 */

import { CpModel, CpSolver, CpSolverStatus } from '../src';

// ============================================================================
// Example 1: Shift Assignment
// ============================================================================

function solveShiftAssignment() {
  console.log('=== Example 1: Shift Assignment ===');
  console.log('Map shift type to boolean indicators for scheduling.\n');

  const model = new CpModel();

  // 3 employees, each assigned to one of 3 shift types
  // Shift types: 0=Morning, 1=Afternoon, 2=Night
  const numEmployees = 3;
  const numShifts = 3;

  const shifts: any[] = [];
  const shiftIndicators: any[][] = [];

  for (let e = 0; e < numEmployees; e++) {
    const shift = model.newIntVar(0, numShifts - 1, `shift_${e}`);
    const indicators = [
      model.newBoolVar(`isMorning_${e}`),
      model.newBoolVar(`isAfternoon_${e}`),
      model.newBoolVar(`isNight_${e}`),
    ];

    shifts.push(shift);
    shiftIndicators.push(indicators);

    // MAP_DOMAIN: shift == i iff indicators[i] == true
    model.addMapDomain(shift, indicators);
  }

  // Constraint: Each shift must be covered by at least one employee
  for (let s = 0; s < numShifts; s++) {
    const indicatorsForShift = shiftIndicators.map(inds => inds[s]);
    model.addBoolOr(indicatorsForShift);
  }

  // Constraint: No more than 2 employees on the same shift
  // Using linear constraint: sum of indicators <= 2
  for (let s = 0; s < numShifts; s++) {
    const indicatorsForShift = shiftIndicators.map(inds => inds[s]);
    const sum = indicatorsForShift.reduce((a, b) => a.add(b));
    model.add(sum.le(2));
  }

  // Solve
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    const shiftNames = ['Morning', 'Afternoon', 'Night'];
    console.log('Shift assignments:');
    for (let e = 0; e < numEmployees; e++) {
      const shiftVal = solver.value(shifts[e]);
      console.log(`  Employee ${e}: ${shiftNames[shiftVal]}`);
    }
  }
  console.log();
}

// ============================================================================
// Example 2: Color Assignment
// ============================================================================

function solveColorAssignment() {
  console.log('=== Example 2: Color Assignment ===');
  console.log('Map color index to boolean indicators for graph coloring.\n');

  const model = new CpModel();

  // 2 nodes, 3 colors available, must be different
  const numNodes = 2;
  const numColors = 3;

  const colors: any[] = [];
  const colorIndicators: any[][] = [];

  for (let n = 0; n < numNodes; n++) {
    const color = model.newIntVar(0, numColors - 1, `color_${n}`);
    const indicators = [];
    for (let c = 0; c < numColors; c++) {
      indicators.push(model.newBoolVar(`isColor${c}_${n}`));
    }

    colors.push(color);
    colorIndicators.push(indicators);

    // MAP_DOMAIN: color == c iff indicators[c] == true
    model.addMapDomain(color, indicators);
  }

  // Constraint: Nodes must have different colors
  model.add(colors[0].ne(colors[1]));

  // Solve
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    const colorNames = ['Red', 'Green', 'Blue'];
    console.log('Color assignments:');
    for (let n = 0; n < numNodes; n++) {
      const colorVal = solver.value(colors[n]);
      console.log(`  Node ${n}: ${colorNames[colorVal]}`);
    }
  }
  console.log();
}

// ============================================================================
// Example 3: Resource Allocation
// ============================================================================

function solveResourceAllocation() {
  console.log('=== Example 3: Resource Allocation ===');
  console.log('Map resource type to boolean indicators for task assignment.\n');

  const model = new CpModel();

  // 4 tasks, each assigned to one of 3 resource types
  // Resource types: 0=CPU, 1=GPU, 2=TPU
  const numTasks = 4;
  const numResources = 3;

  const resources: any[] = [];
  const resourceIndicators: any[][] = [];

  for (let t = 0; t < numTasks; t++) {
    const resource = model.newIntVar(0, numResources - 1, `resource_${t}`);
    const indicators = [
      model.newBoolVar(`isCPU_${t}`),
      model.newBoolVar(`isGPU_${t}`),
      model.newBoolVar(`isTPU_${t}`),
    ];

    resources.push(resource);
    resourceIndicators.push(indicators);

    // MAP_DOMAIN: resource == r iff indicators[r] == true
    model.addMapDomain(resource, indicators);
  }

  // Constraint: At most 2 tasks on GPU (resource type 1)
  const gpuIndicators = resourceIndicators.map(inds => inds[1]);
  const gpuSum = gpuIndicators.reduce((a, b) => a.add(b));
  model.add(gpuSum.le(2));

  // Constraint: At most 1 task on TPU (resource type 2)
  const tpuIndicators = resourceIndicators.map(inds => inds[2]);
  const tpuSum = tpuIndicators.reduce((a, b) => a.add(b));
  model.add(tpuSum.le(1));

  // Constraint: Task 0 must be on CPU or GPU (not TPU)
  model.add(resources[0].ne(2));

  // Solve
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    const resourceNames = ['CPU', 'GPU', 'TPU'];
    console.log('Resource assignments:');
    for (let t = 0; t < numTasks; t++) {
      const resourceVal = solver.value(resources[t]);
      console.log(`  Task ${t}: ${resourceNames[resourceVal]}`);
    }
  }
  console.log();
}

// ============================================================================
// Example 4: Enumerate All Solutions
// ============================================================================

function solveEnumerateAll() {
  console.log('=== Example 4: Enumerate All Solutions ===');
  console.log('Find all valid shift assignments.\n');

  const model = new CpModel();

  // 2 employees, 2 shifts
  const shifts: any[] = [];
  const shiftIndicators: any[][] = [];

  for (let e = 0; e < 2; e++) {
    const shift = model.newIntVar(0, 1, `shift_${e}`);
    const indicators = [
      model.newBoolVar(`isShift0_${e}`),
      model.newBoolVar(`isShift1_${e}`),
    ];

    shifts.push(shift);
    shiftIndicators.push(indicators);

    model.addMapDomain(shift, indicators);
  }

  // Constraint: Employees must be on different shifts
  model.add(shifts[0].ne(shifts[1]));

  // Enumerate all solutions
  const solver = new CpSolver();
  solver.parameters.enumerateAllSolutions = true;
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  console.log(`Total solutions: ${solver.numSolutions}`);
  console.log();
}

// ============================================================================
// Run all examples
// ============================================================================

solveShiftAssignment();
solveColorAssignment();
solveResourceAllocation();
solveEnumerateAll();
