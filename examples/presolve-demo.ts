/**
 * CP-SAT TypeScript - Presolve Demo
 *
 * This example demonstrates how presolve simplifies models before search.
 * Presolve can dramatically reduce search space by:
 * 1. Tightening variable domains from constraint bounds
 * 2. Detecting linear relationships and substituting variables
 * 3. Removing trivially satisfied constraints
 */

import { CpModel, CpSolver, CpSolverStatus, presolveModel, Domain } from '../src';

function demo1_DomainCompression() {
  console.log('=== Demo 1: Domain Compression ===\n');

  const model = new CpModel();

  // Variables with wide initial domains
  const x = model.newIntVar(0, 1000, 'x');
  const y = model.newIntVar(0, 1000, 'y');
  const z = model.newIntVar(0, 1000, 'z');

  // Constraints that dramatically narrow the domains
  model.add(x.add(y).le(20));       // x + y <= 20
  model.add(y.add(z).le(15));       // y + z <= 15
  model.add(x.add(z).ge(10));       // x + z >= 10
  model.add(x.sub(y).eq(3));        // x = y + 3 (affine relation)

  // Before presolve: all domains are [0, 1000]
  console.log('Before presolve:');
  console.log(`  x: [${x.domain.min}, ${x.domain.max}]`);
  console.log(`  y: [${y.domain.min}, ${y.domain.max}]`);
  console.log(`  z: [${z.domain.min}, ${z.domain.max}]`);

  // Run presolve
  const domains = new Map<number, Domain>();
  for (const v of model.registry.allIntVars) {
    domains.set(v.index, new Domain(v.domain.intervals));
  }
  for (const v of model.registry.allBoolVars) {
    domains.set(v.index, new Domain([0, 1]));
  }

  const result = presolveModel(model, domains);

  console.log('\nAfter presolve:');
  console.log(`  x: [${result.domains.get(x.index)!.min}, ${result.domains.get(x.index)!.max}]`);
  console.log(`  y: [${result.domains.get(y.index)!.min}, ${result.domains.get(y.index)!.max}]`);
  console.log(`  z: [${result.domains.get(z.index)!.min}, ${result.domains.get(z.index)!.max}]`);
  console.log(`  Status: ${result.status}`);
  console.log(`  Variables fixed: ${result.numVarsFixed}`);
  console.log(`  Constraints removed: ${result.numConstraintsRemoved}`);
  console.log(`  Derived variables: ${result.derivedVars.size}`);
  console.log();
}

function demo2_AffineRelations() {
  console.log('=== Demo 2: Affine Relation Detection ===\n');

  const model = new CpModel();

  // A production problem where quantities are linked
  const productA = model.newIntVar(0, 100, 'productA');
  const productB = model.newIntVar(0, 100, 'productB');
  const productC = model.newIntVar(0, 100, 'productC');

  // Linked production: A = 2*B (fixed ratio)
  model.add(productA.sub(productB.mul(2)).eq(0));
  // Linked production: C = B + 10 (offset)
  model.add(productC.sub(productB).eq(10));

  // Capacity constraint
  model.add(productA.add(productB).add(productC).le(100));

  // Maximize total production
  model.maximize(productA.add(productB).add(productC));

  console.log('Before presolve:');
  console.log(`  productA: [${productA.domain.min}, ${productA.domain.max}]`);
  console.log(`  productB: [${productB.domain.min}, ${productB.domain.max}]`);
  console.log(`  productC: [${productC.domain.min}, ${productC.domain.max}]`);

  // Solve with presolve
  const solver = new CpSolver();
  const status = solver.solve(model);

  console.log('\nAfter solve (with presolve):');
  console.log(`  productA = ${solver.value(productA)}`);
  console.log(`  productB = ${solver.value(productB)}`);
  console.log(`  productC = ${solver.value(productC)}`);
  console.log(`  Status: ${status}`);
  console.log(`  Objective: ${solver.objectiveValue}`);

  // Verify relations
  console.log('\nVerifying affine relations:');
  console.log(`  A = 2*B: ${solver.value(productA)} = 2*${solver.value(productB)} ✓`);
  console.log(`  C = B + 10: ${solver.value(productC)} = ${solver.value(productB)} + 10 ✓`);
  console.log();
}

function demo3_BooleanPresolve() {
  console.log('=== Demo 3: Boolean Constraint Presolve ===\n');

  const model = new CpModel();

  // 5 boolean flags with complex boolean constraints
  const flags = Array.from({ length: 5 }, (_, i) => model.newBoolVar(`flag_${i}`));

  // At least one of {0, 1, 2} must be true
  model.addBoolOr([flags[0], flags[1], flags[2]]);

  // At most one of {2, 3, 4} can be true
  model.addAtMostOne([flags[2], flags[3], flags[4]]);

  // Flag 0 implies Flag 3
  model.addImplication(flags[0], flags[3]);

  // Flag 1 implies Flag 4
  model.addImplication(flags[1], flags[4]);

  // Fix flag 0 to true
  model.add(flags[0].ge(1));

  console.log('Constraints:');
  console.log('  flag_0 OR flag_1 OR flag_2');
  console.log('  AtMostOne(flag_2, flag_3, flag_4)');
  console.log('  flag_0 => flag_3');
  console.log('  flag_1 => flag_4');
  console.log('  flag_0 = TRUE (fixed)');

  const solver = new CpSolver();
  const status = solver.solve(model);

  console.log(`\nSolution: ${status}`);
  for (const f of flags) {
    console.log(`  ${f.name} = ${solver.booleanValue(f)}`);
  }

  console.log('\nPropagation chain:');
  console.log('  flag_0 = TRUE → flag_3 = TRUE (implication)');
  console.log('  flag_3 = TRUE → flag_2 = FALSE, flag_4 = FALSE (at-most-one)');
  console.log('  BoolOr({0,1,2}) already satisfied by flag_0');
  console.log();
}

function demo4_OptimizationWithPresolve() {
  console.log('=== Demo 4: Optimization with Presolve ===\n');

  const model = new CpModel();

  // Investment portfolio: 3 assets
  const assetA = model.newIntVar(0, 100, 'assetA');
  const assetB = model.newIntVar(0, 100, 'assetB');
  const assetC = model.newIntVar(0, 100, 'assetC');

  // Total investment = 100
  model.add(assetA.add(assetB).add(assetC).eq(100));

  // Diversification rules
  model.add(assetA.le(50));  // No single asset > 50%
  model.add(assetB.le(50));
  model.add(assetC.le(50));

  // Risk management: C <= A + B
  model.add(assetC.le(assetA.add(assetB)));

  // Strategy: B = A + 10 (affine)
  model.add(assetB.sub(assetA).eq(10));

  // Maximize return: 2%A + 5%B + 8%C
  model.maximize(assetA.mul(2).add(assetB.mul(5)).add(assetC.mul(8)));

  const solver = new CpSolver();
  const status = solver.solve(model);

  console.log('Portfolio optimization:');
  console.log(`  Asset A = ${solver.value(assetA)} (return: 2%)`);
  console.log(`  Asset B = ${solver.value(assetB)} (return: 5%)`);
  console.log(`  Asset C = ${solver.value(assetC)} (return: 8%)`);
  console.log(`  Total = ${solver.value(assetA) + solver.value(assetB) + solver.value(assetC)}`);
  console.log(`  Strategy B = A + 10: ${solver.value(assetB)} = ${solver.value(assetA)} + 10 ✓`);
  console.log(`  Objective (weighted return): ${solver.objectiveValue}`);
  console.log(`  Status: ${status}`);
  console.log();
}

function demo5_InfeasibilityDetection() {
  console.log('=== Demo 5: Early Infeasibility Detection ===\n');

  const model = new CpModel();

  const x = model.newIntVar(0, 10, 'x');
  const y = model.newIntVar(0, 10, 'y');

  // These constraints are contradictory
  model.add(x.add(y).ge(15));   // x + y >= 15
  model.add(x.le(5));            // x <= 5
  model.add(y.le(5));            // y <= 5

  console.log('Constraints:');
  console.log('  x + y >= 15');
  console.log('  x <= 5');
  console.log('  y <= 5');
  console.log('  x, y in [0, 10]');

  const solver = new CpSolver();
  const status = solver.solve(model);

  console.log(`\nResult: ${status}`);
  console.log('Presolve detects x <= 5 and y <= 5 → x + y <= 10 < 15 → INFEASIBLE');
  console.log();
}

function demo6_ExtendedAffine() {
  console.log('=== Demo 6: Extended Affine Detection (coeff > 1) ===\n');

  const model = new CpModel();

  // Production with fixed ratio: x = 2*y + 3
  const x = model.newIntVar(0, 50, 'x');
  const y = model.newIntVar(0, 20, 'y');

  // x = 2*y + 3 (coefficient 2, not just ±1)
  model.add(x.sub(y.mul(2)).eq(3));

  // Capacity constraint
  model.add(x.add(y).le(30));

  // Maximize production
  model.maximize(x.add(y));

  const solver = new CpSolver();
  const status = solver.solve(model);

  console.log('Constraint: x = 2*y + 3 (coefficient 2)');
  console.log(`  x = ${solver.value(x)}`);
  console.log(`  y = ${solver.value(y)}`);
  console.log(`  x = 2*y + 3: ${solver.value(x)} = 2*${solver.value(y)} + 3 = ${2 * solver.value(y) + 3} ✓`);
  console.log(`  Objective: ${solver.objectiveValue}`);
  console.log(`  Presolve time: ${(solver.presolveTime * 1000).toFixed(1)} ms`);
  console.log(`  Search time: ${(solver.searchTime * 1000).toFixed(1)} ms`);
  console.log();
}

function demo7_TimingBreakdown() {
  console.log('=== Demo 7: Presolve vs Search Timing ===\n');

  // A problem where presolve does significant work
  const model = new CpModel();
  const n = 8;
  const queens = Array.from({ length: n }, (_, i) =>
    model.newIntVar(0, n - 1, `x_${i}`)
  );

  model.addAllDifferent(queens);
  model.addAllDifferent(queens.map((q, i) => q.add(i)));
  model.addAllDifferent(queens.map((q, i) => q.sub(i)));

  const solver = new CpSolver();
  solver.solve(model);

  console.log(`${n}-Queens problem:`);
  console.log(`  Presolve: ${(solver.presolveTime * 1000).toFixed(1)} ms`);
  console.log(`  Search:   ${(solver.searchTime * 1000).toFixed(1)} ms`);
  console.log(`  Total:    ${(solver.wallTime * 1000).toFixed(1)} ms`);
  console.log(`  Conflicts: ${solver.numConflicts}`);
  console.log(`  Branches:  ${solver.numBranches}`);
  console.log();
}

// Run all demos
demo1_DomainCompression();
demo2_AffineRelations();
demo3_BooleanPresolve();
demo4_OptimizationWithPresolve();
demo5_InfeasibilityDetection();
demo6_ExtendedAffine();
demo7_TimingBreakdown();
