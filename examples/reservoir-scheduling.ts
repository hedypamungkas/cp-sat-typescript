/**
 * Reservoir Scheduling Example
 *
 * Demonstrates the Reservoir constraint for solving:
 * 1. Inventory management (stock levels)
 * 2. Cash flow scheduling
 * 3. Energy storage scheduling
 */

import { CpModel, CpSolver, CpSolverStatus } from '../src';

// ============================================================================
// Example 1: Inventory Management
// ============================================================================

function solveInventoryManagement() {
  console.log('=== Example 1: Inventory Management ===');
  console.log('Schedule production and orders while maintaining stock levels.\n');

  const model = new CpModel();

  // Production events (positive deltas) and order events (negative deltas)
  // Production: +5 units at time 0-2, +3 units at time 1-3
  // Orders: -4 units at time 2-4, -2 units at time 3-5
  const tProd1 = model.newIntVar(0, 2, 'tProd1');
  const tProd2 = model.newIntVar(1, 3, 'tProd2');
  const tOrder1 = model.newIntVar(2, 4, 'tOrder1');
  const tOrder2 = model.newIntVar(3, 5, 'tOrder2');

  // Stock level must stay between 2 (safety stock) and 10 (warehouse capacity)
  model.addReservoirConstraint(
    [tProd1, tProd2, tOrder1, tOrder2],
    [5, 3, -4, -2],
    2,  // minLevel (safety stock)
    10  // maxLevel (warehouse capacity)
  );

  // Solve
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    const events = [
      { time: solver.value(tProd1), delta: 5, name: 'Production 1' },
      { time: solver.value(tProd2), delta: 3, name: 'Production 2' },
      { time: solver.value(tOrder1), delta: -4, name: 'Order 1' },
      { time: solver.value(tOrder2), delta: -2, name: 'Order 2' },
    ].sort((a, b) => a.time - b.time);

    console.log('Schedule:');
    let level = 0;
    for (const event of events) {
      level += event.delta;
      console.log(`  t=${event.time}: ${event.name} (${event.delta > 0 ? '+' : ''}${event.delta}) -> level = ${level}`);
    }
  }
  console.log();
}

// ============================================================================
// Example 2: Cash Flow Scheduling
// ============================================================================

function solveCashFlowScheduling() {
  console.log('=== Example 2: Cash Flow Scheduling ===');
  console.log('Schedule payments and income while maintaining cash balance.\n');

  const model = new CpModel();

  // Income events (positive) and expense events (negative)
  const tIncome1 = model.newIntVar(0, 1, 'tIncome1');  // Salary
  const tIncome2 = model.newIntVar(3, 4, 'tIncome2');  // Bonus
  const tExpense1 = model.newIntVar(1, 2, 'tExpense1'); // Rent
  const tExpense2 = model.newIntVar(2, 3, 'tExpense2'); // Utilities
  const tExpense3 = model.newIntVar(0, 5, 'tExpense3'); // Shopping

  // Cash balance must stay between 0 (minimum) and 1000 (credit limit)
  model.addReservoirConstraint(
    [tIncome1, tIncome2, tExpense1, tExpense2, tExpense3],
    [100, 50, -80, -20, -30],
    0,    // minLevel (can't go negative)
    1000  // maxLevel (credit limit)
  );

  // Solve
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    const events = [
      { time: solver.value(tIncome1), delta: 100, name: 'Salary' },
      { time: solver.value(tIncome2), delta: 50, name: 'Bonus' },
      { time: solver.value(tExpense1), delta: -80, name: 'Rent' },
      { time: solver.value(tExpense2), delta: -20, name: 'Utilities' },
      { time: solver.value(tExpense3), delta: -30, name: 'Shopping' },
    ].sort((a, b) => a.time - b.time);

    console.log('Cash flow schedule:');
    let balance = 0;
    for (const event of events) {
      balance += event.delta;
      console.log(`  t=${event.time}: ${event.name} (${event.delta > 0 ? '+' : ''}${event.delta}) -> balance = ${balance}`);
    }
  }
  console.log();
}

// ============================================================================
// Example 3: Energy Storage Scheduling
// ============================================================================

function solveEnergyStorageScheduling() {
  console.log('=== Example 3: Energy Storage Scheduling ===');
  console.log('Schedule battery charging and discharging.\n');

  const model = new CpModel();

  // Charging events (positive) and discharging events (negative)
  // Start with initial level of 40% (by setting minLevel to 40)
  const tCharge1 = model.newIntVar(0, 3, 'tCharge1');
  const tCharge2 = model.newIntVar(4, 6, 'tCharge2');
  const tDischarge1 = model.newIntVar(2, 5, 'tDischarge1');
  const tDischarge2 = model.newIntVar(5, 7, 'tDischarge2');

  // Battery level must stay between 20% (minimum) and 80% (maximum)
  // Initial level is implicitly 0, so we need to ensure events don't violate bounds
  model.addReservoirConstraint(
    [tCharge1, tCharge2, tDischarge1, tDischarge2],
    [20, 15, -10, -8],
    0,   // minLevel
    80   // maxLevel
  );

  // Solve
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    const events = [
      { time: solver.value(tCharge1), delta: 20, name: 'Charge 1' },
      { time: solver.value(tCharge2), delta: 15, name: 'Charge 2' },
      { time: solver.value(tDischarge1), delta: -10, name: 'Discharge 1' },
      { time: solver.value(tDischarge2), delta: -8, name: 'Discharge 2' },
    ].sort((a, b) => a.time - b.time);

    console.log('Battery schedule:');
    let level = 0;
    console.log(`  Initial level: ${level}%`);
    for (const event of events) {
      level += event.delta;
      console.log(`  t=${event.time}: ${event.name} (${event.delta > 0 ? '+' : ''}${event.delta}%) -> level = ${level}%`);
    }
  }
  console.log();
}

// ============================================================================
// Example 4: Reservoir with Active Literals
// ============================================================================

function solveReservoirWithActiveLiterals() {
  console.log('=== Example 4: Reservoir with Active Literals ===');
  console.log('Schedule optional events that may or may not occur.\n');

  const model = new CpModel();

  // Optional production events
  const tProd1 = model.newIntVar(0, 3, 'tProd1');
  const tProd2 = model.newIntVar(2, 5, 'tProd2');
  const a1 = model.newBoolVar('active1');
  const a2 = model.newBoolVar('active2');

  // Fixed order event
  const tOrder = model.newIntVar(3, 4, 'tOrder');

  // Stock level must stay between 0 and 10
  // Use addReservoirConstraintWithActive for optional events
  model.addReservoirConstraintWithActive(
    [tProd1, tProd2, tOrder],
    [6, 4, -5],
    [a1, a2, null as any],  // null means always active
    0,
    10
  );

  // Solve
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = 10;
  const status = solver.solve(model);

  console.log(`Status: ${CpSolverStatus[status]}`);
  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    const events = [
      { time: solver.value(tProd1), delta: 6, name: 'Production 1', active: solver.booleanValue(a1) },
      { time: solver.value(tProd2), delta: 4, name: 'Production 2', active: solver.booleanValue(a2) },
      { time: solver.value(tOrder), delta: -5, name: 'Order', active: true },
    ].sort((a, b) => a.time - b.time);

    console.log('Schedule:');
    let level = 0;
    for (const event of events) {
      if (event.active) {
        level += event.delta;
        console.log(`  t=${event.time}: ${event.name} (${event.delta > 0 ? '+' : ''}${event.delta}) -> level = ${level} [ACTIVE]`);
      } else {
        console.log(`  t=${event.time}: ${event.name} [INACTIVE]`);
      }
    }
  }
  console.log();
}

// ============================================================================
// Run all examples
// ============================================================================

solveInventoryManagement();
solveCashFlowScheduling();
solveEnergyStorageScheduling();
solveReservoirWithActiveLiterals();
