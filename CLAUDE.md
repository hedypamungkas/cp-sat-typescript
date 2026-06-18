# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TypeScript implementation of Google OR-Tools CP-SAT constraint programming solver. Pure TypeScript, no native dependencies or env vars required.

## Commands

- **Build**: `npm run build` — dual CJS (`dist/`) + ESM (`dist/esm/`) output. The ESM build intentionally disables declarations and source maps. The build script creates a synthetic `dist/esm/package.json` with `{"type":"module"}`.
- **Test**: `npm test` (vitest, single run) | `npm run test:watch` | `npm run test:coverage`
- **Lint**: `npm run lint` (eslint on `src/` and `tests/`)
- **Run a single test**: `npx vitest run -t "test name pattern"` or `npx vitest run path/to/file.test.ts`

## Code Style

ESLint enforces these rules (see `.eslintrc.json`):

- `prefer-const: error` — always use `const` unless reassignment is required
- `no-var: error`
- `no-console: warn` in src (only `console.warn`/`console.error` acceptable)
- `@typescript-eslint/no-unused-vars: warn` with `argsIgnorePattern: ^_`
- `@typescript-eslint/no-explicit-any: warn` in src, off in tests
- No formatter (Prettier/dprint) is configured — match existing code style manually

## Architecture

- `solver-engine.ts` (~58 KB) is the core backtracking search with constraint propagation and branch-and-bound
- `presolve.ts` handles domain compression, affine relation detection, and derived value computation
- `model.ts` is the model builder (variables, constraints, objectives, decision strategies)
- `types.ts` defines core types including `Domain`, `LinearExpr`, and the `createVarProxy` operator-overloading helper

## Conventions

- **Negated boolean literals**: `BoolVarImpl.negated` returns `-(index + 1)` following CP-SAT convention
- **Examples import from `../src`**, not the built package — they work in dev without building
- **`dist/` is gitignored** — always rebuild before verifying published output
- **`sufficientAssumptionsForInfeasibility()`** is stubbed (returns `[]`) with a TODO in `solver.ts`
