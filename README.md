# CP-SAT TypeScript

A pure-TypeScript implementation of Google OR-Tools' **CP-SAT** constraint-programming solver — integer variables, rich global constraints, scheduling propagation, branch-and-bound optimization, LP-relaxation bounds, optional Lazy Clause Generation (LCG), and a Web Worker portfolio solver. **Zero native dependencies.**

```bash
npm install cp-sat-ts
```

## Quick start

```typescript
import { CpModel, CpSolver, CpSolverStatus } from 'cp-sat-ts';

const model = new CpModel();
const x = model.newIntVar(0, 10, 'x');
const y = model.newIntVar(0, 10, 'y');

model.add(x.add(y).le(15));          // x + y <= 15
model.maximize(x.add(y.mul(2)));     // maximize x + 2y

const solver = new CpSolver();
const status = solver.solve(model);

if (status === CpSolverStatus.OPTIMAL) {
  console.log(`x=${solver.value(x)}, y=${solver.value(y)}, obj=${solver.objectiveValue}`);
  console.log(`proven bound=${solver.bestObjectiveBound}, branches=${solver.numBranches}`);
}
```

## Features

- **Variables**: `IntVar` (with domains), `BoolVar`, `IntervalVar` (+ optional / fixed-size variants), constants.
- **Global constraints**: `AllDifferent`, `Element`, `Circuit`/`MultipleCircuit`, `AllowedAssignments`/`ForbiddenAssignments`, `Automaton`, `Inverse`, `Reservoir`, `MapDomain`.
- **Scheduling**: `NoOverlap`, `NoOverlap2D`, `Cumulative` — with detectable-precedence, not-last, edge-finding, and time-timetable propagation.
- **Boolean modelling**: `BoolOr`/`BoolAnd`/`BoolXor`, `AtLeastOne`/`AtMostOne`/`ExactlyOne`, `Implication`, explicit `Clause`s.
- **Reification / arithmetic**: `MinEquality`, `MaxEquality`, `AbsEquality`, `DivisionEquality`, `ModuloEquality`, `MultiplicationEquality`, linear `<,<=,==,!=,>=,>`.
- **Objectives**: `minimize` / `maximize` over any `LinearExpr`, with a sound dual bound (`bestObjectiveBound`) and optimality gap.
- **Search**: presolve (domain compression, affine-relation & derived-var detection), constraint propagation, branch-and-bound, Luby restarts, Large Neighborhood Search (LNS), decision strategies, hints, assumptions + UNSAT core.
- **LP relaxation bounds** (opt-in): rank-1 fractional-knapsack bound (`enableLpBounds`, maximize) and a full bounded-variable two-phase simplex (`enableSimplexBounds`, both directions).
- **Lazy Clause Generation** (opt-in): 2-watched-literal Boolean propagation + 1-UIP conflict-driven clause learning + integer-bound literals (`enableLcg`).
- **Portfolio solver**: run N diversified Web Workers / `worker_threads` in parallel and keep the best result (`cp-sat-ts/worker` subpath).
- **JSON serialization**: `model.toJSON()` / `CpModel.fromJSON()`.
- **Pure TypeScript** — runs in Node (CJS + ESM), bundlers, and the browser.

## Installation

```bash
npm install cp-sat-ts
```

### CommonJS

```javascript
const { CpModel, CpSolver, CpSolverStatus } = require('cp-sat-ts');
```

### ES Modules / TypeScript

```typescript
import { CpModel, CpSolver, CpSolverStatus, IntVar, BoolVar } from 'cp-sat-ts';
```

### Bundler (Vite / Webpack / esbuild)

No special config — the `exports` field resolves the ESM entry automatically and tree-shaking works (`sideEffects: false`).

### From Git / local path

```bash
npm install git+https://github.com/your-org/cp-sat-ts.git
npm install ../path/to/cp-sat-ts      # monorepo / development
```

## Variables & expressions

```typescript
const x = model.newIntVar(0, 100, 'x');     // integer in [0, 100]
const b = model.newBoolVar('b');            // 0 or 1
const c = model.newConstant(42);            // fixed constant

// Intervals for scheduling (start, size, end)
const task = model.newIntervalVar(startVar, 3, endVar, 'task');

// Operator-overloaded LinearExpr: +, -, *, with .le/.ge/.eq/.ne
model.add(x.add(y).le(80));
model.add(x.mul(2).sub(y).ge(5));
model.add(x.add(y).eq(10));
```

## Constraints (selection)

```typescript
model.addAllDifferent([x, y, z]);

// Boolean
model.addBoolOr([a, b, c]);
model.addExactlyOne([a, b, c]);
model.addAtMostOne([a, b, c]);
model.addImplication(a, b);
model.addClause([a, b.not()]);          // a ∨ ¬b   (LCG clause engine)

// Reified arithmetic
model.addMaxEquality(target, [x, y, z]);
model.addAbsEquality(absX, x);
model.addMultiplicationEquality(z, [x, y]);

// Scheduling — non-overlapping intervals
model.addNoOverlap([taskA, taskB, taskC]);
model.addCumulative(tasks, capacities, capacityLimit);
```

## Objectives & parameters

```typescript
model.minimize(cost);
model.maximize(profit);

const solver = new CpSolver();
solver.parameters.maxTimeInSeconds = 30;
solver.parameters.logSearchProgress = true;
solver.parameters.enableLpBounds = true;       // rank-1 LP bound (maximize)
solver.parameters.enableSimplexBounds = true;  // full simplex bound
solver.parameters.enableLcg = true;            // lazy clause generation
solver.parameters.restartStrategy = 'luby';
solver.parameters.enableLNS = true;

const status = solver.solve(model);
console.log(solver.responseStats());
```

All advanced bounds and LCG are **off by default** (sound, opt-in). See [ARCHITECTURE.md](./ARCHITECTURE.md) for how they combine.

## Solution callbacks

```typescript
import { VarArraySolutionPrinter, CpSolverSolutionCallback } from 'cp-sat-ts';

solver.parameters.enumerateAllSolutions = true;
const printer = new VarArraySolutionPrinter([x, y, z]);
solver.solve(model, printer);
console.log(`Found ${printer.solutionCount} solutions`);

// or extend CpSolverSolutionCallback for custom onSolutionCallback logic
```

## Portfolio solving (parallel Web Workers)

`solve()` is synchronous and single-threaded. For real parallelism, use the **`cp-sat-ts/worker`** subpath (ESM only), which fans out N diversified workers and returns the best result:

```typescript
import { solvePortfolio } from 'cp-sat-ts/worker';

const result = await solvePortfolio(model, {
  numWorkers: 8,
  maxTimeInSeconds: 30,
  stopOnOptimal: true,
});

console.log(result.status, result.objectiveValue, `gap=${result.gapPercent}%`);
// result.solution: Map<varIndex, value> from the winning worker
```

On 6×6 jobshop-style instances a 4-worker portfolio reaches OPTIMAL where a single worker times out. See [examples/browser-vite](./examples/browser-vite) for a browser-worker setup.

## Examples

Run any example with `npx tsx`:

```bash
npx tsx examples/n-queens.ts
npx tsx examples/sudoku.ts
npx tsx examples/knapsack.ts
npx tsx examples/campus-timetabling-csv.ts --input=./examples/data/campus/ --output-dir=./output/
```

| Example | Demonstrates |
|---------|-------------|
| `basic.ts` | Variables, linear constraints, objective |
| `n-queens.ts` | AllDifferent + diagonals |
| `sudoku.ts` | AllDifferent, allowed-assignments |
| `knapsack.ts` | 0/1 Boolean model + maximize |
| `graph-coloring.ts` | AllDifferent, conflict graph |
| `employee-scheduling.ts` | ExactlyOne / AtMostOne shift model |
| `nooverlap-scheduling.ts` | Interval NoOverlap |
| `nooverlap2d-scheduling.ts` | 2D rectangle packing |
| `cumulative-scheduling.ts` | Cumulative resource |
| `reservoir-scheduling.ts` | Reservoir constraint |
| `circuit-scheduling.ts` | Circuit / TSP-style |
| `map-domain-scheduling.ts` | MapDomain |
| `presolve-demo.ts` | Presolve reductions |
| `campus-timetabling.ts` | Curriculum-based CB-CTT (in-file data) |
| `campus-timetabling-full.ts` | FILKOM-scale (50 sections) |
| `campus-timetabling-csv.ts` | Full-scale CSV I/O (`--input`, `--output-dir`, `--blocked-rooms`) |
| `examples/browser-vite/` | Solver in the browser via Vite + Web Workers |

### Campus timetabling data (`examples/data/campus/`)

Five CSV files consumed by the CSV example; `gen-scale.ts` is a deterministic generator:

| File | Columns |
|------|---------|
| `courses.csv` | `id,name,sessions_per_week,duration,sks,students,facilities,package,home_building` |
| `lecturers.csv` | `id,disliked_hours,preferred_facilities,preferred_courses` |
| `rooms.csv` | `id,capacity,facilities,building` |
| `sections.csv` | `id,course_id,lecturer_ids,student_ids` |
| `students.csv` | `id,name,course_ids` |

## API reference

### `CpModel` — building blocks

| Method | Description |
|--------|-------------|
| `newIntVar(lb, ub, name)` / `newIntVarFromDomain(domain, name)` | Integer variable |
| `newBoolVar(name)` / `newConstant(value)` | Boolean / constant |
| `newIntervalVar(start, size, end, name)` (+ `newFixedSizeIntervalVar`, optional variants) | Interval variable |
| `add(ct)` | Add a linear / not-equal / boolean constraint |
| `addLinearConstraint(expr, lb, ub)` / `addLinearExpressionInDomain(expr, domain)` | Bounded linear |
| `addAllDifferent(exprs)` / `addElement(index, vars, target)` | Global |
| `addCircuit(arcs)` / `addMultipleCircuit(arcs)` | Circuit / sub-tour elimination |
| `addAllowedAssignments(...)` / `addForbiddenAssignments(...)` | Table |
| `addAutomaton(...)` / `addInverse(...)` | Regular / inverse |
| `addReservoirConstraint(...)` / `addMapDomain(...)` | Reservoir / map-domain |
| `addBoolOr/BoolAnd/BoolXor(lits)` | Boolean ops |
| `addAtLeastOne/AtMostOne/ExactlyOne(lits)` | Cardinality |
| `addImplication(a, b)` / `addClause(lits)` / `addClauses(list)` | Implication / clauses (LCG) |
| `addMinEquality/addMaxEquality(target, exprs)` | min/max reification |
| `addAbsEquality/addDivisionEquality/addModuloEquality/addMultiplicationEquality` | arithmetic reification |
| `addNoOverlap(intervals)` / `addNoOverlap2D(...)` / `addCumulative(...)` | Scheduling |
| `minimize(obj)` / `maximize(obj)` / `clearObjective()` | Objective |
| `addHint(var, value)` / `clearHints()` | Decision hints (fix domains) |
| `addAssumption(lit)` / `addAssumptions(lits)` / `clearAssumptions()` | Assumptions → UNSAT core |
| `addDecisionStrategy(...)` | Search strategy |
| `toJSON()` / `CpModel.fromJSON(json)` | Serialize / deserialize |
| `clone()` / `validate()` / `modelStats()` | Inspection |

### `CpSolver` — solving & inspection

| Member | Description |
|--------|-------------|
| `solve(model, callback?, progressCallback?, options?)` | Solve; returns `CpSolverStatus` |
| `value(var)` / `booleanValue(lit)` | Read solution values |
| `stopSearch()` | Interrupt an in-progress search |
| `parameters` | `SolverParameters` (get/set) — see below |
| `objectiveValue` / `bestObjectiveBound` | Primal / sound dual bound |
| `wallTime` / `presolveTime` / `searchTime` | Timing |
| `numSolutions` / `numBranches` / `numConflicts` | Search stats |
| `numBooleanPropagations` / `numIntegerPropagations` / `numBooleans` | Propagation stats |
| `numLearnedClauses` / `numIntBoundLiterals` | LCG activity |
| `responseStats()` / `statusName()` | Formatted stats |
| `sufficientAssumptionsForInfeasibility()` | Assumption indices explaining INFEASIBLE |

`solve()` `options`: `{ initialDomains?, initialBestObjective? }` (warm-start / partial domains).

### `SolverParameters`

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxTimeInSeconds` | — | Wall-clock limit |
| `enumerateAllSolutions` | `false` | Emit every solution via callback |
| `logSearchProgress` | `false` | Print progress to console |
| `progressCallbackIntervalMs` | `1000` | Throttle for progress callback (`0` = none) |
| `randomSeed` | `1` | RNG seed |
| `numWorkers` | — | **No-op** on sync `solve()`; use `solvePortfolio()` for parallelism |
| `restartStrategy` | `'none'` | `'luby'` enables Luby restarts (`restartBaseInterval` = 256) |
| `enableLNS` / `lnsMaxIterations` / `lnsNeighborhoodSize` | `false` / `100` / `0.5` | Large Neighborhood Search |
| `enableLpBounds` | `false` | Rank-1 fractional-knapsack bound (maximize) |
| `enableSimplexBounds` | `false` | Full bounded-variable simplex bound (min & max) |
| `enableLcg` | `false` | Lazy Clause Generation (Phases 1–3) |
| `disablePropagationForTypes` | — | Benchmarking: skip a constraint type |

### `CpSolverStatus`

| Status | Meaning |
|--------|---------|
| `OPTIMAL` | Optimal solution proven |
| `FEASIBLE` | Solution found, optimality not proven |
| `INFEASIBLE` | Proven unsolvable |
| `MODEL_INVALID` | Failed validation |
| `UNKNOWN` | Not started / interrupted / no solution yet |

## Development

```bash
npm run build            # tsc (CJS + ESM + worker) + esbuild worker bundle
npm test                 # vitest (single run) — ~800 tests
npm run test:watch       # vitest watch
npm run test:coverage    # vitest with coverage
npm run lint             # eslint src tests
npx vitest run -t "name" # run a single test by name
npx vitest run path/to/file.test.ts
```

Benchmarks live under `benchmarks/` (`npm run benchmark`, or specific ones like `npm run benchmark:portfolio`, `benchmark:nooverlap2d`, `benchmark:lns`).

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the engine internals (search loop, presolve, LCG phases, LP/simplex bounds, propagators) and [CLAUDE.md](./CLAUDE.md) for contributor/agent guidance.

## License

Apache License 2.0. Inspired by [Google OR-Tools](https://developers.google.com/optimization) CP-SAT.
