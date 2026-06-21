/**
 * Reservoir Constraint Benchmark
 *
 * Measures propagation effectiveness for Reservoir constraints.
 */

import { CpModel } from '../src/model';
import { LinearExpr } from '../src/types';
import {
  runBenchmark,
  runPropagationComparison,
  formatResult,
  formatComparison,
  printSummaryTable,
  BenchmarkResult,
} from './benchmark-utils';

// ============================================================================
// Benchmark Functions
// ============================================================================

/**
 * Create an inventory scheduling model
 */
function createInventoryModel(numEvents: number, horizon: number, capacity: number): CpModel {
  const model = new CpModel();

  const times = [];
  const deltas = [];

  // Alternate between supply (+) and demand (-) events
  for (let i = 0; i < numEvents; i++) {
    times.push(model.newIntVar(0, horizon, `t${i}`));
    deltas.push(i % 2 === 0 ? 3 : -2);
  }

  model.addReservoirConstraint(times, deltas, 0, capacity);
  return model;
}

/**
 * Create an energy storage scheduling model
 */
function createEnergyStorageModel(numChargeEvents: number, numDischargeEvents: number, horizon: number): CpModel {
  const model = new CpModel();

  const times = [];
  const deltas = [];

  // Charge events
  for (let i = 0; i < numChargeEvents; i++) {
    times.push(model.newIntVar(0, horizon, `charge${i}`));
    deltas.push(5);
  }

  // Discharge events
  for (let i = 0; i < numDischargeEvents; i++) {
    times.push(model.newIntVar(0, horizon, `discharge${i}`));
    deltas.push(-3);
  }

  model.addReservoirConstraint(times, deltas, 0, 20);
  return model;
}

/**
 * Create a reservoir model with active literals
 */
function createActiveLiteralModel(numEvents: number, horizon: number, maxActive: number): CpModel {
  const model = new CpModel();

  const times = [];
  const deltas = [];
  const actives = [];

  for (let i = 0; i < numEvents; i++) {
    times.push(model.newIntVar(0, horizon, `t${i}`));
    deltas.push(i % 2 === 0 ? 4 : -3);
    actives.push(model.newBoolVar(`a${i}`));
  }

  // Limit number of active events: sum(actives) <= maxActive
  if (maxActive < numEvents) {
    let sum = LinearExpr.fromConstant(0);
    for (const a of actives) {
      sum = sum.add(a);
    }
    model.addLinearConstraint(sum, 0, maxActive);
  }

  model.addReservoirConstraintWithActive(times, deltas, actives, 0, 15);
  return model;
}

/**
 * Create an infeasible reservoir model
 */
function createInfeasibleReservoirModel(numEvents: number): CpModel {
  const model = new CpModel();

  const times = [];
  const deltas = [];

  // All events at time 0 with large positive deltas
  for (let i = 0; i < numEvents; i++) {
    times.push(model.newIntVar(0, 0, `t${i}`));
    deltas.push(5);
  }

  // Capacity too small for all events
  model.addReservoirConstraint(times, deltas, 0, 5 * numEvents - 1);
  return model;
}

// ============================================================================
// Main Benchmark
// ============================================================================

function main(): void {
  console.log('Reservoir Constraint Benchmark');
  console.log('==============================\n');

  const results: { name: string; withProp: BenchmarkResult; withoutProp: BenchmarkResult; speedup: number; branchReduction: number }[] = [];

  // Inventory scheduling benchmarks
  const inventoryConfigs = [
    { events: 5, horizon: 10, capacity: 10 },
    { events: 10, horizon: 15, capacity: 15 },
    { events: 15, horizon: 20, capacity: 20 },
    { events: 20, horizon: 25, capacity: 25 },
    { events: 30, horizon: 30, capacity: 30 },
  ];

  for (const cfg of inventoryConfigs) {
    const name = `Inventory e=${cfg.events} h=${cfg.horizon}`;
    console.log(`\nRunning ${name}...`);

    const comparison = runPropagationComparison(
      {
        name,
        buildModel: () => createInventoryModel(cfg.events, cfg.horizon, cfg.capacity),
        maxTimeInSeconds: 30,
      },
      ['RESERVOIR']
    );

    console.log(formatComparison(name, comparison));
    results.push({
      name,
      withProp: comparison.withPropagation,
      withoutProp: comparison.withoutPropagation,
      speedup: comparison.speedup,
      branchReduction: comparison.branchReduction,
    });
  }

  // Energy storage benchmarks
  const energyConfigs = [
    { charge: 3, discharge: 3, horizon: 12 },
    { charge: 5, discharge: 5, horizon: 20 },
    { charge: 8, discharge: 8, horizon: 30 },
  ];

  for (const cfg of energyConfigs) {
    const name = `Energy c=${cfg.charge} d=${cfg.discharge}`;
    console.log(`\nRunning ${name}...`);

    const comparison = runPropagationComparison(
      {
        name,
        buildModel: () => createEnergyStorageModel(cfg.charge, cfg.discharge, cfg.horizon),
        maxTimeInSeconds: 30,
      },
      ['RESERVOIR']
    );

    console.log(formatComparison(name, comparison));
    results.push({
      name,
      withProp: comparison.withPropagation,
      withoutProp: comparison.withoutPropagation,
      speedup: comparison.speedup,
      branchReduction: comparison.branchReduction,
    });
  }

  // Active literal benchmarks
  const activeConfigs = [
    { events: 6, horizon: 10, maxActive: 4 },
    { events: 10, horizon: 15, maxActive: 6 },
    { events: 15, horizon: 20, maxActive: 8 },
  ];

  for (const cfg of activeConfigs) {
    const name = `Active e=${cfg.events} max=${cfg.maxActive}`;
    console.log(`\nRunning ${name}...`);

    const comparison = runPropagationComparison(
      {
        name,
        buildModel: () => createActiveLiteralModel(cfg.events, cfg.horizon, cfg.maxActive),
        maxTimeInSeconds: 30,
      },
      ['RESERVOIR']
    );

    console.log(formatComparison(name, comparison));
    results.push({
      name,
      withProp: comparison.withPropagation,
      withoutProp: comparison.withoutPropagation,
      speedup: comparison.speedup,
      branchReduction: comparison.branchReduction,
    });
  }

  // Infeasible benchmarks
  const infeasibleSizes = [3, 5, 8];
  for (const n of infeasibleSizes) {
    const name = `Infeasible e=${n}`;
    console.log(`\nRunning ${name}...`);

    const comparison = runPropagationComparison(
      {
        name,
        buildModel: () => createInfeasibleReservoirModel(n),
        maxTimeInSeconds: 10,
      },
      ['RESERVOIR']
    );

    console.log(formatComparison(name, comparison));
    results.push({
      name,
      withProp: comparison.withPropagation,
      withoutProp: comparison.withoutPropagation,
      speedup: comparison.speedup,
      branchReduction: comparison.branchReduction,
    });
  }

  // Print summary
  printSummaryTable(results);
}

main();
