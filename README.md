# CP-SAT TypeScript

A TypeScript implementation of Google's CP-SAT constraint programming solver.

## Overview

This module provides a TypeScript/JavaScript API for constraint programming, inspired by Google's OR-Tools CP-SAT solver. It allows you to define optimization problems with integer variables, constraints, and objective functions, then find optimal or feasible solutions.

## Installation

```bash
npm install cp-sat-ts
```

### From Private Registry

```bash
# Set registry in .npmrc
echo "@your-org:registry=https://npm.your-registry.com" >> .npmrc
npm install @your-org/cp-sat-ts
```

### From Git

```bash
# Latest from main branch
npm install git+https://github.com/your-org/cp-sat-ts.git

# Specific branch or tag
npm install git+https://github.com/your-org/cp-sat-ts.git#v1.0.0
```

### From Local Path (Monorepo / Development)

```bash
npm install ../path/to/cp-sat-ts
```

## Integration

### CommonJS (Node.js `require`)

```javascript
const { CpModel, CpSolver, CpSolverStatus } = require('cp-sat-ts');

const model = new CpModel();
const x = model.newIntVar(0, 10, 'x');
const y = model.newIntVar(0, 10, 'y');
model.add(x.add(y).le(10));
model.maximize(x.add(y));

const solver = new CpSolver();
const status = solver.solve(model);
console.log(status === CpSolverStatus.OPTIMAL ? `x=${solver.value(x)}, y=${solver.value(y)}` : 'No solution');
```

### ES Modules (Node.js `import`)

```javascript
import { CpModel, CpSolver, CpSolverStatus } from 'cp-sat-ts';

const model = new CpModel();
const x = model.newIntVar(0, 10, 'x');
model.maximize(x);

const solver = new CpSolver();
solver.solve(model);
console.log(solver.value(x));
```

### TypeScript

```typescript
import { CpModel, CpSolver, CpSolverStatus, IntVar, BoolVar } from 'cp-sat-ts';

const model = new CpModel();

// Types are fully inferred, but you can annotate if needed
const x: IntVar = model.newIntVar(0, 100, 'x');
const y: IntVar = model.newIntVar(0, 100, 'y');
const z: IntVar = model.newIntVar(0, 100, 'z');

// Add constraints
model.add(x.add(y).le(80));
model.addAllDifferent([x, y, z]);

// Set objective
model.maximize(x.add(y).add(z));

const solver = new CpSolver();
const status = solver.solve(model);

if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
  console.log(`x = ${solver.value(x)}, y = ${solver.value(y)}, z = ${solver.value(z)}`);
  console.log(`Objective = ${solver.objectiveValue}`);
} else if (status === CpSolverStatus.INFEASIBLE) {
  console.log('No feasible solution exists');
}
```

### Bundler (Vite / Webpack / esbuild)

No special configuration needed — bundlers resolve the ESM entry automatically via the `exports` field:

```typescript
import { CpModel, CpSolver, CpSolverStatus } from 'cp-sat-ts';
// Tree-shaking works: unused constraints/variables are eliminated
```

## Quick Start

```typescript
import { CpModel, CpSolver, CpSolverStatus } from 'cp-sat-ts';

// Create a model
const model = new CpModel();

// Create variables
const x = model.newIntVar(0, 10, 'x');
const y = model.newIntVar(0, 10, 'y');

// Add constraints
model.add(x.add(y).le(15));

// Set objective
model.maximize(x.add(y.mul(2)));

// Solve
const solver = new CpSolver();
const status = solver.solve(model);

if (status === CpSolverStatus.OPTIMAL) {
  console.log(`x = ${solver.value(x)}`);
  console.log(`y = ${solver.value(y)}`);
  console.log(`Objective = ${solver.objectiveValue}`);
}
```

## Features

### Variables

- **IntVar**: Integer variables with specified domains
- **BoolVar**: Boolean variables (0 or 1)
- **IntervalVar**: Interval variables for scheduling problems

```typescript
// Integer variable with range [0, 100]
const x = model.newIntVar(0, 100, 'x');

// Boolean variable
const b = model.newBoolVar('b');

// Constant
const c = model.newConstant(42);
```

### Constraints

#### Linear Constraints

```typescript
// x + y <= 10
model.add(x.add(y).le(10));

// 2x - 3y >= 5
model.add(x.mul(2).sub(y.mul(3)).ge(5));

// x + y = 10
model.add(x.add(y).eq(10));
```

#### All Different

```typescript
// All variables must have different values
model.addAllDifferent([x, y, z]);
```

#### Boolean Constraints

```typescript
// At least one is true
model.addBoolOr([a, b, c]);

// All must be true
model.addBoolAnd([a, b]);

// Exactly one is true
model.addExactlyOne([a, b, c]);

// At most one is true
model.addAtMostOne([a, b, c]);

// Implication: a => b
model.addImplication(a, b);
```

#### Arithmetic Constraints

```typescript
// target = max(x, y, z)
model.addMaxEquality(target, [x, y, z]);

// target = min(x, y, z)
model.addMinEquality(target, [x, y, z]);

// target = |expr|
model.addAbsEquality(target, expr);

// target = a * b
model.addMultiplicationEquality(target, [a, b]);
```

### Objective Functions

```typescript
// Minimize
model.minimize(cost);

// Maximize
model.maximize(profit);

// Complex objective
model.maximize(x.mul(2).add(y.mul(3)).add(z));
```

### Solver

```typescript
const solver = new CpSolver();

// Set parameters
solver.parameters.maxTimeInSeconds = 10;
solver.parameters.enumerateAllSolutions = true;

// Solve
const status = solver.solve(model);

// Get results
if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
  console.log(solver.value(x));
  console.log(solver.objectiveValue);
  console.log(solver.wallTime);
}
```

### Solution Callbacks

```typescript
import { VarArraySolutionPrinter } from 'cp-sat-ts';

// Built-in callback that prints variable values for each solution
const printer = new VarArraySolutionPrinter([x, y, z]);
solver.solve(model, printer);
console.log(`Found ${printer.solutionCount} solutions`);
```

To create a custom callback, extend `CpSolverSolutionCallback`:

```typescript
import { CpSolverSolutionCallback } from 'cp-sat-ts';

class MyCallback extends CpSolverSolutionCallback {
  constructor(private variables: IntVar[]) {
    super();
  }

  onSolutionCallback(): void {
    console.log(`Solution ${this.solutionCount}:`);
    for (const v of this.variables) {
      console.log(`  ${v.name} = ${this.value(v)}`);
    }
  }
}

const callback = new MyCallback([x, y, z]);
solver.solve(model, callback);
```

## Examples

### N-Queens Problem

```typescript
const boardSize = 8;
const model = new CpModel();

// One variable per column; value = row
const queens = Array.from({ length: boardSize }, (_, i) =>
  model.newIntVar(0, boardSize - 1, `x_${i}`)
);

// All rows must differ
model.addAllDifferent(queens);

// No two queens on same diagonal
model.addAllDifferent(queens.map((q, i) => q.add(i)));
model.addAllDifferent(queens.map((q, i) => q.sub(i)));

const solver = new CpSolver();
const status = solver.solve(model);
```

### Employee Scheduling

```typescript
const model = new CpModel();

// Create shift variables
const shifts: Record<string, BoolVar> = {};
for (let n = 0; n < numNurses; n++) {
  for (let d = 0; d < numDays; d++) {
    for (let s = 0; s < numShifts; s++) {
      shifts[`${n}_${d}_${s}`] = model.newBoolVar(`shift_n${n}_d${d}_s${s}`);
    }
  }
}

// Each shift has exactly one nurse
for (let d = 0; d < numDays; d++) {
  for (let s = 0; s < numShifts; s++) {
    model.addExactlyOne(
      Array.from({ length: numNurses }, (_, n) => shifts[`${n}_${d}_${s}`])
    );
  }
}

// Each nurse works at most one shift per day
for (let n = 0; n < numNurses; n++) {
  for (let d = 0; d < numDays; d++) {
    model.addAtMostOne(
      Array.from({ length: numShifts }, (_, s) => shifts[`${n}_${d}_${s}`])
    );
  }
}
```

## API Reference

### CpModel

| Method | Description |
|--------|-------------|
| `newIntVar(lb, ub, name)` | Create integer variable |
| `newBoolVar(name)` | Create boolean variable |
| `newConstant(value)` | Create constant |
| `add(ct)` | Add constraint |
| `addAllDifferent(vars)` | All-different constraint |
| `addBoolOr(literals)` | Boolean OR |
| `addBoolAnd(literals)` | Boolean AND |
| `addExactlyOne(literals)` | Exactly one true |
| `addAtMostOne(literals)` | At most one true |
| `addImplication(a, b)` | Implication |
| `addMaxEquality(target, exprs)` | Max equality |
| `addMinEquality(target, exprs)` | Min equality |
| `minimize(obj)` | Set minimize objective |
| `maximize(obj)` | Set maximize objective |

### CpSolver

| Method | Description |
|--------|-------------|
| `solve(model)` | Solve the model |
| `value(var)` | Get variable value |
| `booleanValue(var)` | Get boolean value |
| `stopSearch()` | Stop search |

### CpSolverStatus

| Status | Description |
|--------|-------------|
| `OPTIMAL` | Optimal solution found |
| `FEASIBLE` | Feasible solution found |
| `INFEASIBLE` | No solution exists |
| `MODEL_INVALID` | Model validation failed |
| `UNKNOWN` | Search stopped early |

## License

Apache License 2.0

## Credits

Inspired by [Google OR-Tools](https://developers.google.com/optimization) CP-SAT solver.
