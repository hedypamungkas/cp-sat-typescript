/**
 * LP-Relaxation Bounds (simplified — fractional knapsack)
 *
 * Computes a tighter UPPER bound on a MAXIMIZE objective for models that
 * contain a packing constraint of the form  Σ wᵢ·xᵢ ≤ W  (wᵢ ≥ 0). The bound
 * is the value of the LP relaxation restricted to a single such constraint,
 * obtained by Dantzig's fractional-knapsack greedy rule. Because the LP
 * relaxation is a superset of the integer-feasible region, this value is never
 * below the true integer optimum — i.e. it is a valid upper bound for maximize,
 * which the branch-and-bound engine uses to prune (see SolverEngine._canImprove).
 *
 * For minimize objectives, or models without a usable packing constraint, no
 * bound is available: every function here returns `null`, and the solver falls
 * back to the existing interval-arithmetic bound. This is Rank 1 ("LP
 * simplified") of the Tier 3 roadmap — the full pure-TS simplex (Rank 3) is a
 * later, separate effort.
 *
 * SOUNDNESS CONTRACT — the only invariant that matters:
 *   Every function below either returns a value that is a PROVABLE upper bound
 *   on the maximize optimum over the given domains, or returns `null` (meaning
 *   "no bound available — use the interval bound"). It NEVER returns a
 *   tighter-but-wrong value. The engine only ever tightens via
 *   `min(intervalMax, lpBound ?? intervalMax)`, so it can never prune the
 *   optimum.
 */

import type { Domain, LinearExpr } from './types';
import { LinearConstraint } from './constraints';
import type { Constraint } from './constraints';

// ============================================================================
// Types (plain data — no solver references; trivially cacheable)
// ============================================================================

/**
 * One detected packing constraint usable as an LP-relaxation source.
 * Represents:  lb ≤ Σ wᵢ·xᵢ ≤ ub  with all wᵢ > 0 and a finite `ub`.
 * (`varIndices` and `weights` are aligned; zero-coefficient terms are dropped
 * at detection time — they neither consume capacity nor restrict the bound, so
 * they are treated as free objective variables.)
 */
export interface PackingConstraint {
  readonly constraintIndex: number;
  readonly varIndices: readonly number[];
  readonly weights: readonly number[];
  /** Upper bound W (the capacity). Always finite. */
  readonly ub: number;
  /** Lower bound of the constraint (informational). */
  readonly lb: number;
}

/**
 * Result of one-time detection, stored verbatim by the engine. An empty
 * `packingConstraints` array means "no usable packing constraint" and makes
 * `computeLpObjectiveBound` return `null` (interval fallback).
 */
export interface PackingClassification {
  readonly packingConstraints: readonly PackingConstraint[];
}

/** Input bundle for the per-node bound computation. Pure data, no solver ref. */
export interface LpBoundContext {
  readonly objective: LinearExpr;
  readonly maximize: boolean;
  readonly domains: ReadonlyMap<number, Domain>;
  readonly classification: PackingClassification;
}

/** Shared empty classification (avoids allocating a fresh array per solve). */
export const EMPTY_CLASSIFICATION: PackingClassification = { packingConstraints: [] };

// Tiny tolerance for float dust in the greedy loop (all inputs are integers,
// so the violated-at-minima check is exact; this only guards the fill loop).
const EPS = 1e-9;

// ============================================================================
// Detection (one-time, O(C·n) — run from SolverEngine._runPresolve)
// ============================================================================

/**
 * Scan `constraints` and classify every ACTIVE LinearConstraint that can serve
 * as a packing constraint. A constraint qualifies iff ALL of:
 *   1. It is a LinearConstraint still active after presolve (`isActive`).
 *   2. Its upper bound is finite — that `ub` is the capacity W. A constraint
 *      with `ub = +Infinity` imposes no packing limit and is skipped.
 *   3. Every coefficient is ≥ 0. A negative weight means the LHS can grow
 *      without bound as that variable increases, so the relation is not a
 *      packing; such constraints are rejected (not re-signed, to avoid subtle
 *      soundness bugs).
 *
 * Zero-coefficient terms are dropped: they carry no weight and are correctly
 * treated as free objective variables by the bound computation.
 */
export function detectPackingConstraints(
  constraints: readonly Constraint[],
  isActive: (index: number) => boolean
): PackingClassification {
  const packingConstraints: PackingConstraint[] = [];

  for (let i = 0; i < constraints.length; i++) {
    if (!isActive(i)) continue;
    const ct = constraints[i];
    if (!(ct instanceof LinearConstraint)) continue;

    const { coeffs, vars, domain } = ct;

    // Requires a finite capacity (the ≤ W side).
    if (!Number.isFinite(domain.max)) continue;

    // Every weight must be non-negative.
    let allNonNeg = true;
    for (const c of coeffs) {
      if (c < 0) {
        allNonNeg = false;
        break;
      }
    }
    if (!allNonNeg) continue;

    // Sum non-negative weights per variable. A variable may appear in several
    // terms of one constraint (e.g. `x.add(x)` → vars [x,x], coeffs [1,1]);
    // folding it into a single weight keeps the bound SOUND — otherwise the
    // greedy would treat one variable as two independent items and could
    // under-bound it (notably for a negative objective coefficient). Zero-coeff
    // terms are dropped (they are free objective variables).
    const weightMap = new Map<number, number>();
    for (let j = 0; j < coeffs.length; j++) {
      if (coeffs[j] === 0) continue;
      const idx = vars[j].index;
      weightMap.set(idx, (weightMap.get(idx) ?? 0) + coeffs[j]);
    }
    const varIndices: number[] = [];
    const weights: number[] = [];
    for (const [idx, w] of weightMap) {
      varIndices.push(idx);
      weights.push(w);
    }
    if (varIndices.length === 0) continue;

    packingConstraints.push({
      constraintIndex: i,
      varIndices,
      weights,
      ub: domain.max,
      lb: domain.min,
    });
  }

  return { packingConstraints };
}

// ============================================================================
// Per-node bound (O(n log n) per packing constraint)
// ============================================================================

/**
 * Upper bound on `objective` from a single packing constraint, via the LP
 * relaxation. Exported for white-box unit tests; the engine routes through
 * `computeLpObjectiveBound` → `fractionalKnapsackForPacking` (which holds the
 * math). Returns `null` when no sound bound can be produced.
 */
export function fractionalKnapsackUpperBound(
  objective: LinearExpr,
  packing: PackingConstraint,
  domains: ReadonlyMap<number, Domain>
): number | null {
  const objCoeffs = sumObjectiveCoeffs(objective);
  return fractionalKnapsackForPacking(objective.offset, objCoeffs, packing, domains);
}

/**
 * Tightest (minimum) upper bound across all classified packing constraints.
 * Each constraint independently yields a valid relaxation upper bound; the
 * tightest valid statement is their minimum. Returns `null` if every
 * constraint failed to produce a bound (→ interval fallback).
 */
export function computeLpObjectiveBound(ctx: LpBoundContext): number | null {
  if (!ctx.maximize) return null;
  const packings = ctx.classification.packingConstraints;
  if (packings.length === 0) return null;

  const objCoeffs = sumObjectiveCoeffs(ctx.objective);
  const offset = ctx.objective.offset;

  let best = Infinity;
  for (const packing of packings) {
    const b = fractionalKnapsackForPacking(offset, objCoeffs, packing, ctx.domains);
    if (b === null) continue; // this constraint gave no bound; others may
    if (b < best) best = b;
  }
  return best === Infinity ? null : best;
}

// ============================================================================
// Internals
// ============================================================================

/**
 * Fold the objective's term list into a varIndex → summed-coefficient map.
 * Deduplication is load-bearing: a variable can appear in several terms
 * (e.g. `x.add(x)`), and the per-variable ratio lookup in the greedy step must
 * see its true total coefficient or the bound could be unsound.
 */
function sumObjectiveCoeffs(objective: LinearExpr): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < objective.vars.length; i++) {
    const idx = objective.vars[i].index;
    map.set(idx, (map.get(idx) ?? 0) + objective.coeffs[i]);
  }
  return map;
}

/**
 * Fractional-knapsack upper bound for ONE packing constraint.
 *
 * Math (maximize  Σ cⱼ·xⱼ + offset  s.t.  Σ_{i∈P} wᵢ·xᵢ ≤ W,  xⱼ ∈ [lo,hi]):
 *   1. Free objective vars (j ∉ P) contribute their interval max
 *      (cⱼ·hi if cⱼ>0, else cⱼ·lo).
 *   2. Constrained vars start at their lower bound loᵢ: they contribute cᵢ·loᵢ
 *      and consume wᵢ·loᵢ of capacity. Residual W′ = W − Σ wᵢ·loᵢ.
 *      If W′ < 0 the constraint is violated at minima → return null.
 *   3. Raise positive-ratio items (cᵢ/wᵢ, wᵢ>0, cᵢ>0) into the residual in
 *      descending ratio order (Dantzig), taking one fractional item at the end.
 *      Items with cᵢ ≤ 0 are never raised (they cannot improve a maximum).
 */
function fractionalKnapsackForPacking(
  offset: number,
  objCoeffs: Map<number, number>,
  packing: PackingConstraint,
  domains: ReadonlyMap<number, Domain>
): number | null {
  const member = new Set(packing.varIndices);
  const n = packing.varIndices.length;

  // Step 1: free objective variables contribute their interval max.
  let bound = offset;
  for (const [varIndex, c] of objCoeffs) {
    if (member.has(varIndex)) continue;
    const d = domains.get(varIndex);
    if (!d || d.isEmpty) return null; // unknown / infeasible var — bail safely
    bound += c > 0 ? c * d.max : c * d.min;
  }

  // Step 2: pin every constrained variable at its lower bound.
  let residual = packing.ub;
  for (let j = 0; j < n; j++) {
    const varIndex = packing.varIndices[j];
    const d = domains.get(varIndex);
    if (!d || d.isEmpty) return null;
    const lo = d.min;
    residual -= packing.weights[j] * lo;
    bound += (objCoeffs.get(varIndex) ?? 0) * lo;
  }
  if (residual < -EPS) return null; // violated at minima — no sound bound

  // Step 3: Dantzig greedy on positive-ratio items into the residual.
  const items: { ratio: number; c: number; w: number; span: number }[] = [];
  for (let j = 0; j < n; j++) {
    const w = packing.weights[j]; // w > 0 (zero-coeff terms were dropped)
    const c = objCoeffs.get(packing.varIndices[j]) ?? 0;
    if (c <= 0) continue; // cannot improve a maximum
    const d = domains.get(packing.varIndices[j]);
    if (!d) return null; // presence guaranteed by step 2; defensive
    const span = d.max - d.min;
    if (span <= 0) continue; // variable is fixed — nothing to raise
    items.push({ ratio: c / w, c, w, span });
  }
  items.sort((a, b) => b.ratio - a.ratio);

  for (const it of items) {
    if (residual <= EPS) break;
    const cost = it.w * it.span;
    let take: number;
    if (cost <= residual) {
      take = it.span; // whole item fits
    } else {
      take = residual / it.w; // fractional fill — exhausts the residual
    }
    bound += it.c * take;
    residual -= it.w * take;
  }

  return Number.isFinite(bound) ? bound : null;
}
