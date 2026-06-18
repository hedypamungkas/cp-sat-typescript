/**
 * CP-SAT TypeScript - 0/1 Knapsack Example
 *
 * Given a set of items with weights and values, determine which items
 * to include in a collection so that the total weight is within a given
 * capacity and the total value is maximized.
 */

import { CpModel, CpSolver, CpSolverStatus, LinearExpr } from '../src';

interface Item {
  name: string;
  weight: number;
  value: number;
}

function solveKnapsack() {
  console.log('0/1 Knapsack Problem\n');

  // Items available
  const items: Item[] = [
    { name: 'Laptop', weight: 3, value: 4 },
    { name: 'Camera', weight: 2, value: 3 },
    { name: 'Book', weight: 1, value: 1 },
    { name: 'Headphones', weight: 1, value: 2 },
    { name: 'Water Bottle', weight: 2, value: 2 },
    { name: 'Snacks', weight: 1, value: 1 },
    { name: 'Jacket', weight: 3, value: 3 },
    { name: 'Umbrella', weight: 1, value: 1 },
  ];
  const capacity = 7;

  console.log(`Capacity: ${capacity} kg`);
  console.log('Items:');
  items.forEach((item, i) => {
    console.log(`  ${i}: ${item.name} - weight: ${item.weight} kg, value: ${item.value}`);
  });
  console.log();

  const model = new CpModel();

  // Decision variables: take[i] = 1 if item i is selected
  const take = items.map((_, i) => model.newBoolVar(`take_${i}`));

  // Weight constraint: total weight <= capacity
  const totalWeight = items.reduce(
    (expr, item, i) => expr.add(take[i].mul(item.weight)),
    new LinearExpr([], [], 0)
  );
  model.add(totalWeight.le(capacity));

  // Objective: maximize total value
  const totalValue = items.reduce(
    (expr, item, i) => expr.add(take[i].mul(item.value)),
    new LinearExpr([], [], 0)
  );
  model.maximize(totalValue);

  // Solve
  const solver = new CpSolver();
  const status = solver.solve(model);

  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    console.log('Solution:');
    let totalW = 0;
    let totalV = 0;

    for (let i = 0; i < items.length; i++) {
      if (solver.booleanValue(take[i])) {
        console.log(`  ✓ ${items[i].name} (${items[i].weight} kg, value ${items[i].value})`);
        totalW += items[i].weight;
        totalV += items[i].value;
      }
    }

    console.log(`\nTotal weight: ${totalW} / ${capacity} kg`);
    console.log(`Total value: ${totalV}`);

    console.log('\nStatistics:');
    console.log(solver.responseStats());
  } else {
    console.log('No solution found!');
  }
}

solveKnapsack();
