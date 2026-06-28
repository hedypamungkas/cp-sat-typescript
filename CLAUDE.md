# CLAUDE.md

Guidance for Claude Code working in this repository. User-facing docs: [README.md](./README.md). Engine internals: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Project Overview

Pure-TypeScript implementation of Google OR-Tools **CP-SAT** constraint-programming solver. No native dependencies, no env vars required. Runs in Node (CJS + ESM), bundlers, and the browser. `engines: node >= 18`.

Core is **traditional CP**: presolve + constraint propagation + branch-and-bound + restarts/LNS. LP-relaxation bounds (`enableLpBounds`, `enableSimplexBounds`), Lazy Clause Generation (`enableLcg`), and a Web Worker portfolio (`cp-sat-ts/worker`) are **opt-in, default OFF** — each soundness-tested. The solver's real strength is scheduling propagation (`NoOverlap`, `Cumulative`).

## Commands

- **Build**: `npm run build` — `tsc` (CJS `dist/` + ESM `dist/esm/` + worker `tsconfig.worker.json`) then esbuild bundles the worker bootstrap to `dist/cp-sat-worker.cjs`, then writes `{"type":"module"}` to `dist/esm/package.json`.
- **Test**: `npm test` (vitest, single run, ~800 tests) | `npm run test:watch` | `npm run test:coverage`
- **Lint**: `npm run lint` (eslint on `src/` and `tests/`)
- **Run a single test**: `npx vitest run -t "test name pattern"` or `npx vitest run path/to/file.test.ts`
- **Examples**: `npx tsx examples/<name>.ts` (e.g. `examples/campus-timetabling-csv.ts --input=./examples/data/campus/ --output-dir=./output/`)
- **Benchmarks**: `npm run benchmark` or a specific one (`benchmark:portfolio`, `benchmark:nooverlap2d`, `benchmark:lns`, …)

## Code Style

ESLint enforces (see `.eslintrc.json`):

- `prefer-const: error` — use `const` unless reassignment is required
- `no-var: error`
- `no-console: warn` in src (only `console.warn`/`console.error` acceptable)
- `@typescript-eslint/no-unused-vars: warn` with `argsIgnorePattern: ^_`
- `@typescript-eslint/no-explicit-any: warn` in src, off in tests
- No formatter (Prettier/dprint) — match existing style manually

## Architecture (compact)

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full pipeline and module map. Key files:

- `solver-engine.ts` — core backtracking search, propagation fixpoint, branch-and-bound, restarts/LNS; wires LP/LCG/simplex bounds
- `solver.ts` — `CpSolver` public wrapper
- `model.ts` (~1750 lines) — model builder + JSON ser/de (`toJSON` / `CpModel.fromJSON`)
- `presolve.ts` — domain compression, affine-relation & derived-var detection
- `types.ts`, `variables.ts`, `constraints.ts`, `callback.ts`, `trail.ts`
- LP: `lp-bounds.ts`, `simplex.ts`, `lp-problem.ts`
- LCG: `clause-engine.ts` (2-watched literals), `conflict-analysis.ts` (1-UIP), `assignment-trail.ts`, `bound-literal-registry.ts` (integer-bound literals)
- Propagators: `scheduling-propagation.ts` (NoOverlap/Cumulative/Reservoir), `nooverlap2d-propagation.ts`, `circuit-propagation.ts`, `automaton-propagation.ts`
- `worker/` — portfolio solver (`solvePortfolio`, ESM-only subpath)

## Conventions & gotchas

- **Negated Boolean literals**: `BoolVarImpl.negated` returns `-(index + 1)` (CP-SAT convention). Clauses/assumptions accept `BoolVarImpl` or signed integer literals.
- **`addHint(var, value)` fixes the domain** (hard), not a soft seed. Objective warm-starting uses `solve()` `options.initialBestObjective`.
- **`numWorkers` is a no-op on `solve()`** (single-threaded) — kept for OR-Tools source compat. Real parallelism = `solvePortfolio()` from `cp-sat-ts/worker`.
- **Workers are ESM-only** (`import.meta.url`); bootstrap bundled by esbuild to `dist/cp-sat-worker.cjs`.
- **`UNKNOWN` ≠ `INFEASIBLE`**: timeout/interruption with no solution is `UNKNOWN`. Constraint code returning an infeasibility flag must not conflate "timeout mid-propagation" with a proven conflict (see `timeout-status.test.ts`).
- **LCG's win is Boolean models.** On pure integer `NoOverlap` scheduling it can add overhead — benchmark before enabling `enableLcg` there.
- **All advanced bounds/LCG default OFF.** Enabling changes behavior (and performance) — verify against the property oracles in `tests/`.
- **`dist/` is gitignored** — always rebuild before verifying published output.
- **Examples import from `../src`**, not the built package — they run in dev without building.

## Testing

~800 vitest tests across `tests/`, including per-module suites, property-based soundness oracles (`fast-check`), and dedicated `soundness-fixes`, `dual-bound`, `timeout-status`, `unsat-core`, `lcg-phase2/3`, `json-serialization`, and `worker/` suites. When changing propagation or bounds, run the relevant soundness tests — they are the safety net for the opt-in features.
