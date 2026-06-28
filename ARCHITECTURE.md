# Architecture

How the CP-SAT TypeScript solver is built and how its pieces fit together. Companion to [README.md](./README.md) (user API) and [CLAUDE.md](./CLAUDE.md) (contributor guide).

> Pure TypeScript, no native dependencies, single-threaded core. Advanced features (LP bounds, simplex, LCG, LNS) are **opt-in and default OFF**; each is soundness-tested against a property oracle (`fast-check`).

## Solve pipeline

```
CpModel (build) ──► presolve ──► SolverEngine.solve()
                                   │
                                   └─► loop:
                                         propagate-to-fixpoint  ──┐
                                           ├─ integer propagators │
                                           ├─ global constraints  │
                                           ├─ LP / simplex bounds │ (opt-in)
                                           └─ LCG clause engine   │ (opt-in)
                                         │                         │
                                         ├─ INFEASIBLE → backtrack (LCG: learn clause, backjump)
                                         ├─ solution  → record, update incumbent (B&B prune)
                                         └─ branch    → pick var/value, recurse
```

`solver.ts` (`CpSolver`) is a thin wrapper: it constructs a `SolverEngine`, applies parameters, wires callbacks, and exposes results (`objectiveValue`, `bestObjectiveBound`, stats). All search logic lives in `solver-engine.ts`.

## Module map

### Core search & model
| File | Purpose |
|------|---------|
| `solver-engine.ts` | Backtracking search, propagation fixpoint loop, branch-and-bound, restarts (Luby), LNS, LP/LCG/simplex wiring, statistics, timeout handling |
| `solver.ts` | `CpSolver` — public API wrapper, parameter application, solution extraction |
| `model.ts` | `CpModel` builder: variables, constraints, objective, hints, assumptions, decision strategies, JSON ser/de (~1750 lines) |
| `presolve.ts` | Domain compression, affine-relation detection, derived-variable computation |
| `types.ts` | Core types: `Domain`, `LinearExpr`, `BoundedLinearExpression`, `SolverParameters`, `SolverStatistics`, `CpSolverStatus`, `ModelJSON` |
| `variables.ts` | `IntVarImpl`, `BoolVarImpl`, `IntervalVarImpl`, `VariableRegistry` |
| `constraints.ts` | All constraint data structures |
| `callback.ts` | `CpSolverSolutionCallback` + built-in printers, `SearchProgressCallback` |
| `trail.ts` | Reversible state trail (undo stack for propagation) |

### LP relaxation (opt-in bounds)
| File | Purpose |
|------|---------|
| `lp-bounds.ts` | Rank-1 fractional-knapsack upper bound for **maximize** with a packing constraint (`Σ wᵢ·xᵢ ≤ W`) |
| `simplex.ts` | Full bounded-variable **two-phase primal simplex** (Bland's rule, iteration cap) for min & max |
| `lp-problem.ts` | Builds the LP from linear constraints; extracts column bounds |

### Lazy Clause Generation (opt-in)
| File | Purpose |
|------|---------|
| `clause-engine.ts` | `ClauseDatabase` + 2-watched-literal unit propagation (Phase 1) |
| `conflict-analysis.ts` | 1-UIP conflict analysis → learned clauses (Phase 2) |
| `assignment-trail.ts` | Decision levels + reason trail for conflict analysis |
| `bound-literal-registry.ts` | Integer-bound literals + channeling propagators (Phase 3, scheduling explanations) |

### Propagators (global constraints)
| File | Algorithms |
|------|-----------|
| `scheduling-propagation.ts` | `NoOverlap` (detectable precedence, not-last, edge-finding), `Cumulative` (timetable, edge-finding), `Reservoir`, interval-bound computation |
| `nooverlap2d-propagation.ts` | 2D rectangle NoOverlap |
| `circuit-propagation.ts` | Circuit / sub-tour elimination, multiple-circuit |
| `automaton-propagation.ts` | Regular-language `Automaton` propagation |

### Portfolio (parallel workers)
| File | Purpose |
|------|---------|
| `worker/portfolio.ts` | `solvePortfolio()` — diversified workers, best-result aggregation, dual bound + gap |
| `worker/orchestrator.ts` | Worker lifecycle, terminate-on-OPTIMAL/INFEASIBLE |
| `worker/{protocol,port,spawn,worker-entry,worker-bootstrap}.ts` | Message protocol, Node/browser port abstraction, worker entrypoint, esbuild bootstrap |

## Opt-in flags (all default OFF)

| Flag | Effect | Notes |
|------|--------|-------|
| `enableLpBounds` | Rank-1 fractional-knapsack bound at the prune site (maximize only) | Tightens B&B pruning on knapsack-like models |
| `enableSimplexBounds` | Full bounded-variable simplex bound over all linear constraints (min & max) | Non-linear constraints ignored (sound but loose); falls back to interval bound on numerical trouble |
| `enableLcg` | Boolean clause DB + 2-WL unit propagation + 1-UIP clause learning + integer-bound literals | **Win is Boolean models.** On pure integer scheduling (`NoOverlap`) LCG can add overhead — benchmark before enabling |
| `enableLNS` | Large Neighborhood Search for optimization | Fixes a neighborhood of vars, re-optimizes the rest |
| `restartStrategy: 'luby'` | Luby-sequence restarts (`restartBaseInterval` = 256 conflicts) | Default `'none'` |

When off, the engine uses interval-arithmetic bounds and the standard propagator fixpoint — the historical core.

## How the pieces combine

- **Bounds feed B&B**: after each propagation fixpoint, the engine computes a dual bound via interval arithmetic (always) and, if enabled, LP/simplex. Tighter bounds → more pruning. `bestObjectiveBound` is the sound dual reported to the user.
- **LCG layers on top of CP**: when `enableLcg` is on, the clause engine participates in the fixpoint; on conflict, 1-UIP analysis derives an explanation clause and the engine backjumps (currently ChronoBT). Integer propagators emit lazy-clause reasons via `bound-literal-registry` so scheduling decisions are explainable (Phase 3).
- **LCG is orthogonal to LP**: LCG improves *search* (fewer redundant branches); LP/simplex improve *bounding* (tighter dual). Both can be on simultaneously.
- **Portfolio is orthogonal to the engine**: each worker runs an independent `CpModel` clone with a diversified `SolverParameters` (seed, strategy). The portfolio aggregates the best objective and the tightest dual bound across workers and computes `gapPercent`.

## Conventions & invariants

- **Negated Boolean literals**: `BoolVarImpl.negated` returns `-(index + 1)` (CP-SAT convention). Assumptions and clauses accept `BoolVarImpl` or signed integer literals.
- **`addHint(var, value)` fixes the domain** (it is not a soft warm-start seed). True objective warm-starting uses `solve()` `options.initialBestObjective`.
- **`numWorkers` on `SolverParameters` is a no-op** on the synchronous `solve()` path — kept for OR-Tools source compatibility. Real parallelism is `solvePortfolio()` from `cp-sat-ts/worker`.
- **Workers are ESM-only** (module workers need `import.meta.url`); the bootstrap is bundled by esbuild to `dist/cp-sat-worker.cjs` because TypeScript can't be loaded directly in Node `worker_threads`.
- **`UNKNOWN` is a real outcome**: a timeout or interruption without a solution is `UNKNOWN`, **not** `INFEASIBLE`. Constraint code that returns an infeasibility flag must distinguish "timeout reached mid-propagation" from a proven conflict.
- **`dist/` is gitignored** — always `npm run build` before verifying published output.
- **Examples import from `../src`**, not the built package, so they run in dev without building.

## Soundness testing

Property-based oracles (`fast-check`) verify the core invariants: propagation reaches a fixpoint, LP/simplex bounds are valid duals, LCG never derives unsound clauses, and ON/OFF agreement on decisive verdicts (UNSAT/OPTIMAL). The test suite (~800 tests, `tests/`) covers each module plus dedicated `soundness-fixes.test.ts`, `dual-bound.test.ts`, `timeout-status.test.ts`, and `unsat-core.test.ts`.
