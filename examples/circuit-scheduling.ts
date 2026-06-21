/**
 * Circuit Scheduling Example
 *
 * Demonstrates the Circuit constraint for solving:
 * 1. TSP (Traveling Salesman Problem)
 * 2. Job sequencing with setup times
 * 3. Hamiltonian cycle detection
 */

import { CpModel, CpSolver, CpSolverStatus, BoolVarImpl } from '../src';

// ============================================================================
// Example 1: Simple TSP (Traveling Salesman Problem)
// ============================================================================

function solveSimpleTSP() {
  console.log('=== Example 1: Simple TSP ===');
  console.log('Find the shortest route visiting all cities exactly once.\n');

  const model = new CpModel();

  // 4 cities with distance matrix
  const n = 4;
  const distances = [
    [0, 10, 15, 20],
    [10, 0, 35, 25],
    [15, 35, 0, 30],
    [20, 25, 30, 0],
  ];

  // Create arc variables: x[i][j] = 1 if we travel from city i to city j
  const arcs: [number, number, BoolVarImpl][] = [];
  const arcVars: { i: number; j: number; lit: BoolVarImpl }[] = [];

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) {
        const lit = model.newBoolVar(`x${i}_${j}`);
        arcs.push([i, j, lit]);
        arcVars.push({ i, j, lit });
      }
    }
  }

  // Add circuit constraint
  model.addCircuit(arcs);

  // Objective: minimize total distance
  const totalDistance = model.newIntVar(0, 1000, 'totalDistance');
  const distanceTerms = arcVars.map(({ i, j, lit }) =>
    lit.mul(distances[i][j])
  );
  model.add(totalDistance.eq(distanceTerms.reduce((a, b) => a.add(b))));
  model.minimize(totalDistance);

  // Solve
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    console.log(`Total distance: ${solver.objectiveValue}`);

    // Extract route
    const route: number[] = [0];
    let current = 0;
    for (let step = 0; step < n; step++) {
      for (const { i, j, lit } of arcVars) {
        if (i === current && solver.booleanValue(lit)) {
          route.push(j);
          current = j;
          break;
        }
      }
    }
    console.log(`Route: ${route.join(' -> ')}`);
  }
  console.log();
}

// ============================================================================
// Example 2: Job Sequencing with Setup Times
// ============================================================================

function solveJobSequencing() {
  console.log('=== Example 2: Job Sequencing with Setup Times ===');
  console.log('Schedule jobs in optimal order considering setup times.\n');

  const model = new CpModel();

  // 4 jobs with setup times between them
  const n = 4;
  const setupTimes = [
    [0, 2, 3, 1],  // Setup from job 0 to jobs 0,1,2,3
    [2, 0, 1, 4],  // Setup from job 1 to jobs 0,1,2,3
    [3, 1, 0, 2],  // Setup from job 2 to jobs 0,1,2,3
    [1, 4, 2, 0],  // Setup from job 3 to jobs 0,1,2,3
  ];

  // Create arc variables
  const arcs: [number, number, BoolVarImpl][] = [];
  const arcVars: { i: number; j: number; lit: BoolVarImpl }[] = [];

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) {
        const lit = model.newBoolVar(`seq${i}_${j}`);
        arcs.push([i, j, lit]);
        arcVars.push({ i, j, lit });
      }
    }
  }

  // Add circuit constraint
  model.addCircuit(arcs);

  // Objective: minimize total setup time
  const totalSetup = model.newIntVar(0, 100, 'totalSetup');
  const setupTerms = arcVars.map(({ i, j, lit }) =>
    lit.mul(setupTimes[i][j])
  );
  model.add(totalSetup.eq(setupTerms.reduce((a, b) => a.add(b))));
  model.minimize(totalSetup);

  // Solve
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    console.log(`Total setup time: ${solver.objectiveValue}`);

    // Extract sequence
    const sequence: number[] = [0];
    let current = 0;
    for (let step = 0; step < n; step++) {
      for (const { i, j, lit } of arcVars) {
        if (i === current && solver.booleanValue(lit)) {
          sequence.push(j);
          current = j;
          break;
        }
      }
    }
    console.log(`Job sequence: ${sequence.join(' -> ')}`);

    // Show setup times
    let total = 0;
    for (let i = 0; i < sequence.length - 1; i++) {
      const from = sequence[i];
      const to = sequence[i + 1];
      const setup = setupTimes[from][to];
      total += setup;
      console.log(`  Job ${from} -> Job ${to}: setup = ${setup}`);
    }
    console.log(`  Total setup: ${total}`);
  }
  console.log();
}

// ============================================================================
// Example 3: Hamiltonian Cycle Detection
// ============================================================================

function solveHamiltonianCycle() {
  console.log('=== Example 3: Hamiltonian Cycle Detection ===');
  console.log('Find a Hamiltonian cycle in a graph.\n');

  const model = new CpModel();

  // Graph with 5 nodes and specific edges
  const n = 5;
  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 4], [4, 0],
    [0, 2], [1, 3], [2, 4],
  ];

  // Create arc variables only for existing edges
  const arcs: [number, number, BoolVarImpl][] = [];

  for (const [i, j] of edges) {
    const lit = model.newBoolVar(`edge${i}_${j}`);
    arcs.push([i, j, lit]);

    // Also add reverse edge
    const reverseLit = model.newBoolVar(`edge${j}_${i}`);
    arcs.push([j, i, reverseLit]);
  }

  // Add self-loops for all nodes
  for (let i = 0; i < n; i++) {
    const selfLit = model.newBoolVar(`self${i}`);
    arcs.push([i, i, selfLit]);
  }

  // Add circuit constraint
  model.addCircuit(arcs);

  // Solve
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    // Extract cycle
    const cycle: number[] = [0];
    let current = 0;
    for (let step = 0; step < n; step++) {
      for (const [tail, head, lit] of arcs) {
        if (tail === current && solver.booleanValue(lit)) {
          if (head !== 0 || step === n - 1) {
            cycle.push(head);
          }
          current = head;
          break;
        }
      }
    }
    console.log(`Hamiltonian cycle: ${cycle.join(' -> ')}`);
  }
  console.log();
}

// ============================================================================
// Run all examples
// ============================================================================

solveSimpleTSP();
solveJobSequencing();
solveHamiltonianCycle();
