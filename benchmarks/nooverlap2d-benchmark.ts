/**
 * NoOverlap2D Constraint Benchmark
 *
 * Measures propagation effectiveness for NoOverlap2D constraints.
 */

import { CpModel } from '../src/model';
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
 * Create a rectangle packing model
 */
function createPackingModel(numRects: number, containerSize: number, rectSize: number): CpModel {
  const model = new CpModel();

  const xIntervals = [];
  const yIntervals = [];

  for (let i = 0; i < numRects; i++) {
    const x = model.newIntVar(0, containerSize - rectSize, `x${i}`);
    const y = model.newIntVar(0, containerSize - rectSize, `y${i}`);
    xIntervals.push(model.newFixedSizeIntervalVar(x, rectSize, `xIv${i}`));
    yIntervals.push(model.newFixedSizeIntervalVar(y, rectSize, `yIv${i}`));
  }

  model.addNoOverlap2D(xIntervals, yIntervals);
  return model;
}

/**
 * Create a mixed-size rectangle packing model
 */
function createMixedPackingModel(numRects: number, containerSize: number): CpModel {
  const model = new CpModel();

  const xIntervals = [];
  const yIntervals = [];

  // Alternate between different rectangle sizes
  const sizes = [
    { w: 2, h: 3 },
    { w: 3, h: 2 },
    { w: 2, h: 2 },
    { w: 1, h: 3 },
  ];

  for (let i = 0; i < numRects; i++) {
    const size = sizes[i % sizes.length];
    const x = model.newIntVar(0, containerSize - size.w, `x${i}`);
    const y = model.newIntVar(0, containerSize - size.h, `y${i}`);
    xIntervals.push(model.newFixedSizeIntervalVar(x, size.w, `xIv${i}`));
    yIntervals.push(model.newFixedSizeIntervalVar(y, size.h, `yIv${i}`));
  }

  model.addNoOverlap2D(xIntervals, yIntervals);
  return model;
}

/**
 * Create an infeasible packing model (too many rectangles)
 */
function createInfeasiblePackingModel(numRects: number, containerSize: number, rectSize: number): CpModel {
  const model = new CpModel();

  const xIntervals = [];
  const yIntervals = [];

  // Force all rectangles to start at (0,0)
  for (let i = 0; i < numRects; i++) {
    const x = model.newIntVar(0, 0, `x${i}`);
    const y = model.newIntVar(0, 0, `y${i}`);
    xIntervals.push(model.newFixedSizeIntervalVar(x, rectSize, `xIv${i}`));
    yIntervals.push(model.newFixedSizeIntervalVar(y, rectSize, `yIv${i}`));
  }

  model.addNoOverlap2D(xIntervals, yIntervals);
  return model;
}

/**
 * Create a task assignment model (machine + time)
 */
function createTaskAssignmentModel(numTasks: number, numMachines: number, timeHorizon: number, duration: number): CpModel {
  const model = new CpModel();

  const timeIntervals = [];
  const machineIntervals = [];

  for (let i = 0; i < numTasks; i++) {
    const t = model.newIntVar(0, timeHorizon - duration, `time${i}`);
    const m = model.newIntVar(0, numMachines - 1, `machine${i}`);
    timeIntervals.push(model.newFixedSizeIntervalVar(t, duration, `tIv${i}`));
    machineIntervals.push(model.newFixedSizeIntervalVar(m, 1, `mIv${i}`));
  }

  model.addNoOverlap2D(timeIntervals, machineIntervals);
  return model;
}

// ============================================================================
// Main Benchmark
// ============================================================================

function main(): void {
  console.log('NoOverlap2D Constraint Benchmark');
  console.log('================================\n');

  const results: { name: string; withProp: BenchmarkResult; withoutProp: BenchmarkResult; speedup: number; branchReduction: number }[] = [];

  // Packing benchmarks (uniform size)
  const packingConfigs = [
    { rects: 3, container: 6, size: 2 },
    { rects: 5, container: 8, size: 2 },
    { rects: 8, container: 10, size: 2 },
    { rects: 10, container: 12, size: 2 },
    { rects: 15, container: 14, size: 2 },
  ];

  for (const cfg of packingConfigs) {
    const name = `Pack r=${cfg.rects} c=${cfg.container}`;
    console.log(`\nRunning ${name}...`);

    const comparison = runPropagationComparison(
      {
        name,
        buildModel: () => createPackingModel(cfg.rects, cfg.container, cfg.size),
        maxTimeInSeconds: 30,
      },
      ['NO_OVERLAP_2D']
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

  // Mixed-size packing benchmarks
  const mixedConfigs = [
    { rects: 4, container: 8 },
    { rects: 8, container: 10 },
    { rects: 12, container: 12 },
  ];

  for (const cfg of mixedConfigs) {
    const name = `Mixed r=${cfg.rects} c=${cfg.container}`;
    console.log(`\nRunning ${name}...`);

    const comparison = runPropagationComparison(
      {
        name,
        buildModel: () => createMixedPackingModel(cfg.rects, cfg.container),
        maxTimeInSeconds: 30,
      },
      ['NO_OVERLAP_2D']
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

  // Task assignment benchmarks
  const taskConfigs = [
    { tasks: 4, machines: 2, horizon: 8, duration: 2 },
    { tasks: 6, machines: 2, horizon: 10, duration: 2 },
    { tasks: 10, machines: 3, horizon: 12, duration: 2 },
  ];

  for (const cfg of taskConfigs) {
    const name = `Task t=${cfg.tasks} m=${cfg.machines}`;
    console.log(`\nRunning ${name}...`);

    const comparison = runPropagationComparison(
      {
        name,
        buildModel: () => createTaskAssignmentModel(cfg.tasks, cfg.machines, cfg.horizon, cfg.duration),
        maxTimeInSeconds: 30,
      },
      ['NO_OVERLAP_2D']
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
    const name = `Infeasible r=${n}`;
    console.log(`\nRunning ${name}...`);

    const comparison = runPropagationComparison(
      {
        name,
        buildModel: () => createInfeasiblePackingModel(n, 4, 3),
        maxTimeInSeconds: 10,
      },
      ['NO_OVERLAP_2D']
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
