/**
 * LP-Relaxation problem builder.
 *
 * Translates the solver's model (linear constraints + objective) into the flat
 * `SimplexLpData` the bounded-variable simplex consumes. This mirrors the
 * existing `detectPackingConstraints` walk in `lp-bounds.ts` (filter
 * `LinearConstraint`, fold coefficients per column via a Map) but generalizes it
 * to the FULL linear system instead of a single packing constraint.
 *
 * The constraint matrix A and objective c are STATIC across a solve — the model
 * is immutable — so `buildLpProblem` runs ONCE (from `_runPresolve`) and the
 * result is cached. Only the COLUMN bounds (variable domains) change per node;
 * `extractColumnBounds` reads those fresh each call.
 *
 * SOUNDNESS CONTRACT — same as the simplex:
 *   Only `ConstraintType.LINEAR` constraints feed the matrix. Every other
 *   constraint type (AllDifferent, NoOverlap/scheduling, Element, etc.) is
 *   IGNORED. Ignoring constraints can only make the relaxation LOOSER (a larger
 *   feasible region), so the resulting bound can never be tighter than valid —
 *   it is sound to use for pruning. `buildLpProblem` returns null when there is
 *   nothing to relax; the caller then falls back to the interval bound.
 */

import type { Constraint } from './constraints';
import { LinearConstraint } from './constraints';
import type { Domain, LinearExpr } from './types';
import type { SimplexLpData } from './simplex';

/**
 * Static LP problem + the column→variable index map used for per-node bound
 * extraction. Plain data: trivially cacheable across an entire `solve()`.
 */
export interface LpProblem {
  /** Sparse matrix, objective, and static row bounds — consumed by the simplex. */
  readonly data: SimplexLpData;
  /** Variable index for each column (length numCols). Used to read domains per node. */
  readonly colVars: ReadonlyArray<number>;
  /** Objective sense (mirrors the model's). */
  readonly maximize: boolean;
}

/**
 * Build the static LP problem from the active linear constraints and objective.
 * Returns null when there are no columns to optimize (no objective terms and no
 * linear constraints) — in that case the simplex has nothing to tighten.
 *
 * `isActive` filters constraints removed by presolve (mirrors
 * `detectPackingConstraints`).
 */
export function buildLpProblem(
  constraints: readonly Constraint[],
  isActive: (index: number) => boolean,
  objective: LinearExpr,
  maximize: boolean
): LpProblem | null {
  // ---- Collect columns: union of objective vars and active linear-constraint vars
  const varToCol = new Map<number, number>();
  for (let i = 0; i < objective.vars.length; i++) {
    const idx = objective.vars[i].index;
    if (!varToCol.has(idx)) varToCol.set(idx, varToCol.size);
  }
  for (let i = 0; i < constraints.length; i++) {
    if (!isActive(i)) continue;
    const ct = constraints[i];
    if (!(ct instanceof LinearConstraint)) continue; // only LINEAR feeds the LP
    if (ct.domain.isEmpty) continue; // defensive; presolve removes these
    const { vars } = ct;
    for (let j = 0; j < vars.length; j++) {
      const idx = vars[j].index;
      if (!varToCol.has(idx)) varToCol.set(idx, varToCol.size);
    }
  }

  if (varToCol.size === 0) return null; // nothing to relax

  const numCols = varToCol.size;
  const colVars = new Array<number>(numCols);
  for (const [varIdx, col] of varToCol) colVars[col] = varIdx;

  // ---- Objective vector c (fold duplicate terms per column — soundness-critical).
  const c = new Array<number>(numCols).fill(0);
  for (let i = 0; i < objective.vars.length; i++) {
    const col = varToCol.get(objective.vars[i].index);
    if (col !== undefined) c[col] += objective.coeffs[i];
  }

  // ---- Constraint rows (CSR, row-major). Fold duplicate var indices per row.
  const rowStart: number[] = [0];
  const colIdx: number[] = [];
  const coef: number[] = [];
  const rowLb: number[] = [];
  const rowUb: number[] = [];

  for (let i = 0; i < constraints.length; i++) {
    if (!isActive(i)) continue;
    const ct = constraints[i];
    if (!(ct instanceof LinearConstraint)) continue;
    if (ct.domain.isEmpty) continue;

    // Sum coefficients per column for this row (a variable may appear twice).
    const rowCoeffs = new Map<number, number>();
    const { vars, coeffs } = ct;
    for (let j = 0; j < vars.length; j++) {
      const cf = coeffs[j];
      if (cf === 0) continue;
      const col = varToCol.get(vars[j].index);
      if (col === undefined) continue; // a var not in our column set (shouldn't happen)
      rowCoeffs.set(col, (rowCoeffs.get(col) ?? 0) + cf);
    }
    for (const [col, cf] of rowCoeffs) {
      colIdx.push(col);
      coef.push(cf);
    }
    rowStart.push(colIdx.length);
    rowLb.push(ct.domain.min);
    rowUb.push(ct.domain.max);
  }

  const data: SimplexLpData = {
    numCols,
    numRows: rowLb.length,
    rowStart,
    colIdx,
    coef,
    rowLb,
    rowUb,
    c,
    offset: objective.offset,
  };

  return { data, colVars, maximize };
}

/**
 * Read per-node column bounds from the current variable domains.
 * Returns null if any column's variable is missing or has an empty domain —
 * the caller then falls back to the interval bound (sound).
 */
export function extractColumnBounds(
  problem: LpProblem,
  domains: ReadonlyMap<number, Domain>
): { lb: Float64Array; ub: Float64Array } | null {
  const n = problem.colVars.length;
  const lb = new Float64Array(n);
  const ub = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const d = domains.get(problem.colVars[j]);
    if (!d || d.isEmpty) return null;
    lb[j] = d.min;
    ub[j] = d.max;
  }
  return { lb, ub };
}
