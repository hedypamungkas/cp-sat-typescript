/**
 * LP-Relaxation via the bounded-variable primal simplex method.
 *
 * Solves the continuous relaxation:
 *
 *     optimize  Σ cⱼ·xⱼ + offset          (maximize or minimize)
 *     s.t.      rowLbᵢ ≤ Σⱼ aᵢⱼ·xⱼ ≤ rowUbᵢ   for each row i
 *               colLbⱼ ≤ xⱼ ≤ colUbⱼ          for each column j
 *
 * into an optimal objective VALUE (or a status). It is used by the branch and
 * bound engine as a per-node BOUND: for maximize it yields an upper bound (the
 * LP optimum is ≥ the integer optimum, since the LP region is a superset of the
 * integer-feasible region); for minimize it yields a lower bound.
 *
 * ----------------------------------------------------------------------------
 * SOUNDNESS CONTRACT — the only invariant the engine relies on:
 *   `solveBoundedSimplex` either returns { status: 'optimal', value } where
 *   `value` is a PROVABLE bound on the optimum over the given column bounds, or
 *   returns a non-optimal status ({ infeasible | unbounded | unknown }) that the
 *   caller MUST treat as "no bound available → fall back to the interval bound".
 *   It NEVER returns a tighter-than-valid value. Any numerical trouble (NaN,
 *   a non-finite value where none is expected, a hit iteration cap) maps to
 *   { status: 'unknown' }, preserving soundness by construction.
 * ----------------------------------------------------------------------------
 *
 * ALGORITHM. Two-phase primal simplex with bounded variables:
 *   • Every variable (structural + the slack added per ranged row) carries its
 *     own [0, ub] box; upper bounds are tracked NATIVELY in the ratio test
 *     rather than expanded into explicit constraint rows (no row inflation).
 *   • Structural columns are shifted to be ≥ 0 (column lower bounds are always
 *     finite in this solver's CP setting), so each becomes yⱼ ∈ [0, ubⱼ].
 *   • Each ranged row `Lᵢ ≤ aᵢ·y ≤ Uᵢ` becomes an equality `aᵢ·y + qᵢ·sᵢ = rhsᵢ`
 *     with a bounded slack sᵢ ≥ 0 carrying the row's range.
 *   • Phase 1: one artificial per row, minimize their sum to find a feasible
 *     basis (or prove infeasibility). Phase 2: optimize the real objective.
 *   • Bland's rule (lowest eligible index, for BOTH entering and leaving)
 *     guarantees termination; a hard iteration cap is the practical backstop.
 *
 * The implementation is PURE: it takes flat number arrays in, returns a result,
 * and imports nothing from the solver. This lets the fast-check brute-force
 * oracle in `tests/simplex.isolation.test.ts` fuzz it with raw instances.
 */

// ============================================================================
// Public types (plain data)
// ============================================================================

/**
 * Static LP data: the constraint matrix (CSR, row-major), per-row bounds, and
 * the objective. Built ONCE per solve (the model is immutable); only the column
 * bounds change per node.
 */
export interface SimplexLpData {
  readonly numCols: number;
  readonly numRows: number;
  /** CSR row pointers. Row r occupies colIdx/coef[rowStart[r] .. rowStart[r+1]). Length numRows+1. */
  readonly rowStart: ReadonlyArray<number>;
  /** Column index of each nonzero. Length nnz. */
  readonly colIdx: ReadonlyArray<number>;
  /** Coefficient of each nonzero. Length nnz. */
  readonly coef: ReadonlyArray<number>;
  /** Lower bound on each row's activity. Length numRows. May be -Infinity (a ≤ row). */
  readonly rowLb: ReadonlyArray<number>;
  /** Upper bound on each row's activity. Length numRows. May be +Infinity (a ≥ row). */
  readonly rowUb: ReadonlyArray<number>;
  /** Objective coefficients (original sense). Length numCols. */
  readonly c: ReadonlyArray<number>;
  /** Objective constant. */
  readonly offset: number;
}

/** Per-node column bounds (always finite in this solver's CP setting).
 * `ArrayLike` so callers may pass either a plain `number[]` or a `Float64Array`. */
export interface ColumnBounds {
  readonly lb: ArrayLike<number>;
  readonly ub: ArrayLike<number>;
}

export type LpSense = 'maximize' | 'minimize';

export type SimplexResult =
  | { status: 'optimal'; value: number }
  | { status: 'infeasible' }
  | { status: 'unbounded' }
  | { status: 'unknown' };

export interface SimplexOptions {
  /** Max total pivot iterations (Phase 1 + Phase 2) before bailing to 'unknown'. Default 2000. */
  readonly maxIterations?: number;
  /** Primal feasibility tolerance. Default 1e-7. */
  readonly feasibilityTol?: number;
  /** Reduced-cost (dual) tolerance. Default 1e-9. */
  readonly dualTol?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_ITERATIONS = 2000;
const FEAS_TOL = 1e-7; // primal feasibility slack
const DUAL_TOL = 1e-9; // reduced-cost significance

// ============================================================================
// Internal context (mutable tableau state for one solve)
// ============================================================================

interface SimplexCtx {
  readonly m: number;
  readonly nTotal: number;
  readonly tStride: number;
  T: Float64Array; // m × nTotal constraint tableau (row-major), = B⁻¹·A
  rhs: Float64Array; // length m, = B⁻¹·b (excludes non-basic-at-upper contributions)
  readonly ub: Float64Array; // length nTotal upper bounds (Infinity = unbounded above)
  basis: Int32Array; // length m, basic variable index per row
  atUpper: Uint8Array; // 1 if a non-basic variable sits at its upper bound
  isBasic: Uint8Array; // 1 if the variable is currently basic
  readonly feasTol: number;
  readonly dualTol: number;
}

interface RowEntry {
  readonly col: number;
  readonly coef: number;
}

interface EqualityRow {
  readonly entries: ReadonlyArray<RowEntry>;
  /** Slack sign in the equality, +1 or −1 (before any row sign flip). */
  readonly q: number;
  /** Right-hand side (before row sign flip). */
  readonly rhs: number;
  /** Slack upper bound. Infinity for one-sided rows. */
  readonly slackUb: number;
}

type RowBuild =
  | { ok: true; rows: EqualityRow[] }
  | { ok: false; reason: 'infeasible' | 'malformed' };

type LoopStatus = 'optimal' | 'unbounded' | 'capped';

interface LoopResult {
  readonly status: LoopStatus;
  /** Iterations consumed by this call. */
  readonly iterations: number;
}

// ============================================================================
// Public entry point
// ============================================================================

/**
 * Solve the bounded-variable LP relaxation and return the optimal objective
 * VALUE (in the requested sense, including the offset) or a status the caller
 * must treat as "no bound available".
 *
 * Returns { status: 'optimal', value } on success. The value is the LP optimum
 * of `sense(Σ cⱼ·xⱼ) + offset` over the column/row bounds — a valid bound on
 * the integer optimum (upper for maximize, lower for minimize).
 */
export function solveBoundedSimplex(
  data: SimplexLpData,
  colBounds: ColumnBounds,
  sense: LpSense,
  options: SimplexOptions = {}
): SimplexResult {
  const numCols = data.numCols;

  // ---- Trivial fast paths --------------------------------------------------
  if (numCols === 0) return { status: 'optimal', value: data.offset };

  // Validate column bounds (must be finite & well-ordered in the CP setting).
  for (let j = 0; j < numCols; j++) {
    const lo = colBounds.lb[j];
    const hi = colBounds.ub[j];
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi + FEAS_TOL) {
      return { status: 'unknown' };
    }
  }

  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const feasTol = options.feasibilityTol ?? FEAS_TOL;
  const dualTol = options.dualTol ?? DUAL_TOL;

  // Internal objective: always MAXIMIZE. For 'minimize', negate c and the
  // reported value.
  const maximize = sense === 'maximize';
  const sign = maximize ? 1 : -1;

  // K = Σ cⱼ·colLbⱼ + offset  (contribution of pinning each xⱼ at its lower bound).
  let K = data.offset;
  for (let j = 0; j < numCols; j++) K += data.c[j] * colBounds.lb[j];

  // Shifted objective coefficients (to maximize): cIntⱼ = sign·cⱼ.
  // Working variable yⱼ = xⱼ − colLbⱼ ∈ [0, ubⱼ] where ubⱼ = colUbⱼ − colLbⱼ.
  const cInt = new Float64Array(numCols);
  const ubCol = new Float64Array(numCols);
  for (let j = 0; j < numCols; j++) {
    cInt[j] = sign * data.c[j];
    ubCol[j] = colBounds.ub[j] - colBounds.lb[j];
  }

  // ---- Build equality rows with bounded slacks -----------------------------
  const built = buildEqualityRows(data, colBounds.lb);
  if (!built.ok) {
    return built.reason === 'infeasible' ? { status: 'infeasible' } : { status: 'unknown' };
  }
  if (built.rows.length === 0) {
    // Every row was free (−∞ ≤ activity ≤ +∞): optimize each column independently.
    return { status: 'optimal', value: separatedBound(data, colBounds, sense) };
  }
  const rows = built.rows;

  const m = rows.length;
  // Total structural vars for the tableau = numCols (y) + m (slacks).
  // Artificials are appended for Phase 1 → indices [nStruct .. nStruct + m).
  const nStruct = numCols + m;
  const nTotal = nStruct + m;
  const tStride = nTotal;
  const tIndex = (i: number, k: number) => i * tStride + k;

  // Per-variable upper bound (Infinity = unbounded above). Lower bound is 0 for all.
  const ub = new Float64Array(nTotal);
  ub.fill(Infinity);
  for (let j = 0; j < numCols; j++) ub[j] = ubCol[j];
  for (let i = 0; i < m; i++) ub[numCols + i] = rows[i].slackUb;

  // ---- Tableau setup -------------------------------------------------------
  const T = new Float64Array(m * nTotal);
  const rhs = new Float64Array(m);
  const basis = new Int32Array(m);

  for (let i = 0; i < m; i++) {
    const r = rows[i];
    for (let e = 0; e < r.entries.length; e++) {
      T[tIndex(i, r.entries[e].col)] += r.entries[e].coef; // sum repeats (sound)
    }
    T[tIndex(i, numCols + i)] += r.q; // slack sᵢ with sign qᵢ

    // Ensure rhs ≥ 0: flip the whole structural+slack row if needed, so the
    // artificial-start basis is feasible (wᵢ = rhsᵢ ≥ 0).
    let rhsI = r.rhs;
    if (rhsI < 0) {
      for (let k = 0; k < nStruct; k++) T[tIndex(i, k)] = -T[tIndex(i, k)];
      rhsI = -rhsI;
    }
    rhs[i] = rhsI;
  }

  const ctx: SimplexCtx = {
    m,
    nTotal,
    tStride,
    T,
    rhs,
    ub,
    basis,
    atUpper: new Uint8Array(nTotal),
    isBasic: new Uint8Array(nTotal),
    feasTol,
    dualTol,
  };

  // ---- Phase 1: minimize Σ artificials via artificials-as-starting-basis ----
  // Add artificial wᵢ (coeff +1) to each row; cost −1 on each (maximize −Σwᵢ).
  const cost1 = new Float64Array(nTotal);
  for (let i = 0; i < m; i++) {
    T[tIndex(i, nStruct + i)] += 1; // artificial wᵢ
    cost1[nStruct + i] = -1;
    basis[i] = nStruct + i;
    ctx.isBasic[basis[i]] = 1;
  }

  let remaining = maxIterations;
  // Artificials (indices ≥ nStruct) start as the Phase-1 basis and must only
  // ever LEAVE it — they are never eligible to enter in either phase (a
  // non-basic artificial's reduced cost is generally nonzero, so allowing it to
  // re-enter would corrupt the basis and can cycle). Real vars + slacks occupy
  // [0, nStruct); that is the eligible entering range throughout.
  const r1 = simplexLoop(ctx, cost1, remaining, nStruct);
  remaining -= r1.iterations;
  if (r1.status === 'capped') return { status: 'unknown' };
  if (r1.status === 'unbounded') return { status: 'unknown' }; // Phase-1 cost is bounded; defensive

  // Feasibility: the Phase-1 objective (max of −Σwᵢ) ≈ 0 means all artificials ≈ 0.
  if (phase1Residual(ctx, nStruct) > feasTol) return { status: 'infeasible' };

  // ---- Drive residual artificials out of the basis (best effort) -----------
  // Phase 1 may end with an artificial still basic at value 0 (a degenerate
  // optimum, common with redundant/duplicate constraints). Swap it for a
  // non-basic-at-lower real column via a degenerate pivot. The bookkeeping MUST
  // mirror simplexLoop's pivot site — `pivot()` only updates T/rhs, not the
  // basis arrays, so a bare call would corrupt the basis and (via wrong reduced
  // costs in Phase 2) could return an unsound bound.
  for (let i = 0; i < m; i++) {
    if (basis[i] < nStruct) continue; // already a real variable
    let pivotCol = -1;
    for (let k = 0; k < nStruct; k++) {
      // Only a non-basic-at-lower column gives a value-preserving (degenerate)
      // swap; a basic or at-upper column would change values and corrupt state.
      if (!ctx.isBasic[k] && !ctx.atUpper[k] && Math.abs(T[tIndex(i, k)]) > feasTol) {
        pivotCol = k;
        break;
      }
    }
    if (pivotCol < 0) continue; // redundant zero row — leave artificial basic at 0
    const leaving = basis[i];
    ctx.isBasic[leaving] = 0; // artificial leaves at lower (artificials are never at upper)
    ctx.isBasic[pivotCol] = 1;
    ctx.basis[i] = pivotCol;
    ctx.atUpper[pivotCol] = 0; // entering was at lower; now basic
    pivot(ctx, pivotCol, i);
  }

  // ---- Phase 2: optimize the real objective --------------------------------
  // Cost: cInt on yⱼ, 0 on slacks and artificials. Artificials keep cost 0 and
  // reduced cost 0, so they never re-enter the basis.
  const cost2 = new Float64Array(nTotal);
  for (let j = 0; j < numCols; j++) cost2[j] = cInt[j];

  const r2 = simplexLoop(ctx, cost2, remaining, nStruct);
  if (r2.status === 'capped') return { status: 'unknown' };
  if (r2.status === 'unbounded') return { status: 'unbounded' };

  // ---- Recover the optimal value -------------------------------------------
  // value = sign · g + K, where g = Σ cIntⱼ·valueⱼ at the optimum.
  const g = recoverObjective(ctx, cost2);
  const value = g * sign + K;
  if (!Number.isFinite(value)) return { status: 'unknown' };
  return { status: 'optimal', value };
}

// ============================================================================
// Row construction (shift + bounded slack)
// ============================================================================

/**
 * Convert ranged rows `rowLbᵢ ≤ aᵢ·x ≤ rowUbᵢ` into equalities with bounded
 * slacks in the shifted y-space. Returns the kept (non-free) rows, or an
 * infeasible/malformed signal.
 */
function buildEqualityRows(data: SimplexLpData, colLb: ArrayLike<number>): RowBuild {
  const { numRows, rowStart, colIdx, coef, rowLb, rowUb } = data;
  const rows: EqualityRow[] = [];

  for (let i = 0; i < numRows; i++) {
    const start = rowStart[i];
    const end = rowStart[i + 1];
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end <= colIdx.length)) {
      return { ok: false, reason: 'malformed' };
    }

    // Shifted activity bounds: L = rowLb − Σ aⱼ·colLbⱼ, U = rowUb − Σ aⱼ·colLbⱼ.
    let shift = 0;
    for (let e = start; e < end; e++) shift += coef[e] * colLb[colIdx[e]];

    const L = rowLb[i] === -Infinity ? -Infinity : rowLb[i] - shift;
    const U = rowUb[i] === Infinity ? Infinity : rowUb[i] - shift;

    if (L !== -Infinity && U !== Infinity && L > U) {
      return { ok: false, reason: 'infeasible' }; // empty row range
    }

    const lbFinite = L !== -Infinity;
    const ubFinite = U !== Infinity;
    if (!lbFinite && !ubFinite) continue; // free row — drop it

    const entries: RowEntry[] = [];
    for (let e = start; e < end; e++) {
      const c = coef[e];
      if (c === 0) continue;
      entries.push({ col: colIdx[e], coef: c });
    }

    if (lbFinite && ubFinite) {
      // L ≤ a·y ≤ U  →  a·y − s = L, s ∈ [0, U−L].
      rows.push({ entries, q: -1, rhs: L, slackUb: U - L });
    } else if (ubFinite) {
      // a·y ≤ U (L = −∞)  →  a·y + s = U, s ≥ 0.
      rows.push({ entries, q: 1, rhs: U, slackUb: Infinity });
    } else {
      // a·y ≥ L (U = +∞)  →  a·y − s = L, s ≥ 0.
      rows.push({ entries, q: -1, rhs: L, slackUb: Infinity });
    }
  }

  return { ok: true, rows };
}

// ============================================================================
// Pricing (reduced costs from the current basis) — recomputed, drift-free
// ============================================================================

/** Reduced-cost row: objrow[k] = cost[k] − Σ_{basic i} cost[basis[i]]·T[i][k]. */
function reducedCosts(ctx: SimplexCtx, cost: Float64Array): Float64Array {
  const { m, nTotal, tStride, T, basis } = ctx;
  const objrow = cost.slice();
  for (let i = 0; i < m; i++) {
    const cb = objrow[basis[i]];
    if (cb === 0) continue;
    const base = i * tStride;
    for (let k = 0; k < nTotal; k++) objrow[k] -= cb * T[base + k];
  }
  return objrow;
}

// ============================================================================
// Basic-variable value (recomputed — drift-free)
// ============================================================================

/**
 * Fill `out[i]` with the current value of the basic variable in row i.
 * value[basic_i] = rhs[i] − Σ_{k at upper} T[i][k]·ub[k].
 */
function fillBasicValues(ctx: SimplexCtx, out: Float64Array): void {
  const { m, nTotal, tStride, T, rhs, ub, atUpper } = ctx;
  for (let i = 0; i < m; i++) {
    const base = i * tStride;
    let v = rhs[i];
    for (let k = 0; k < nTotal; k++) {
      if (atUpper[k]) v -= T[base + k] * ub[k];
    }
    out[i] = v;
  }
}

// ============================================================================
// Phase-1 residual (sum of artificial values) — feasibility check
// ============================================================================

function phase1Residual(ctx: SimplexCtx, nStruct: number): number {
  const { m, basis } = ctx;
  const vals = new Float64Array(m);
  fillBasicValues(ctx, vals);
  let residual = 0;
  for (let i = 0; i < m; i++) {
    if (basis[i] >= nStruct) residual += vals[i];
  }
  return residual;
}

// ============================================================================
// Recover the objective value from the final solution
// ============================================================================

function recoverObjective(ctx: SimplexCtx, cost: Float64Array): number {
  const { nTotal, m, basis, ub, atUpper, isBasic } = ctx;
  const vals = new Float64Array(m);
  fillBasicValues(ctx, vals);
  let g = 0;
  for (let k = 0; k < nTotal; k++) {
    if (isBasic[k]) continue;
    if (cost[k] === 0) continue;
    g += cost[k] * (atUpper[k] ? ub[k] : 0);
  }
  for (let i = 0; i < m; i++) {
    const b = basis[i];
    if (cost[b] === 0) continue;
    g += cost[b] * vals[i];
  }
  return g;
}

// ============================================================================
// The simplex loop (bounded-variable primal, Bland's rule)
// ============================================================================

/**
 * Run primal simplex iterations to MAXIMIZE cost·value from the current basis.
 * Returns the loop status and iterations consumed. `budget` bounds iterations.
 * `maxCol` is the exclusive upper bound on eligible entering variable indices
 * (artificials, at indices ≥ nStruct, are never eligible to enter).
 */
function simplexLoop(ctx: SimplexCtx, cost: Float64Array, budget: number, maxCol: number): LoopResult {
  const { m, tStride, T, ub, basis, atUpper, isBasic, feasTol, dualTol } = ctx;
  const basicVal = new Float64Array(m);
  let iterations = 0;

  for (;;) {
    const objrow = reducedCosts(ctx, cost);
    fillBasicValues(ctx, basicVal);

    // ---- Choose entering variable (Bland: lowest beneficial index) ---------
    let entering = -1;
    for (let k = 0; k < maxCol; k++) {
      if (isBasic[k]) continue;
      const rc = objrow[k];
      if (atUpper[k] ? rc < -dualTol : rc > dualTol) {
        entering = k;
        break;
      }
    }
    if (entering === -1) return { status: 'optimal', iterations };
    if (iterations >= budget) return { status: 'capped', iterations };

    // ---- Pass 1: find the minimum step tMin --------------------------------
    // Direction coefficient for basic var i: coef[i] = (e at upper ? +1 : −1)·T[i][e].
    // Basic var i changes by coef[i]·t as the entering variable moves by t ≥ 0.
    const eUp = atUpper[entering] === 1;
    let tMin = ub[entering]; // entering's own travel: lower→upper or upper→lower
    for (let i = 0; i < m; i++) {
      const a = (eUp ? 1 : -1) * T[i * tStride + entering];
      if (a > dualTol) {
        const t = (ub[basis[i]] - basicVal[i]) / a; // increasing → capped by upper
        if (t < tMin) tMin = t;
      } else if (a < -dualTol) {
        const t = basicVal[i] / -a; // decreasing → capped by lower (0)
        if (t < tMin) tMin = t;
      }
    }

    if (tMin === Infinity) return { status: 'unbounded', iterations };
    if (tMin < 0) tMin = 0; // numerical guard against tiny negatives

    // ---- Pass 2: among blockers at tMin, pick the smallest variable index --
    // (Bland's rule for the leaving variable). The entering's own bound flip
    // counts as a pseudo-blocker with index = entering.
    let bestVar = Infinity;
    let bestRow = -1;
    let bestAtUpper = false;
    let flip = false;
    if (Math.abs(ub[entering] - tMin) <= feasTol) {
      bestVar = entering;
      flip = true;
    }
    for (let i = 0; i < m; i++) {
      const a = (eUp ? 1 : -1) * T[i * tStride + entering];
      let t: number;
      let hitUpper: boolean;
      if (a > dualTol) {
        t = (ub[basis[i]] - basicVal[i]) / a;
        hitUpper = true;
      } else if (a < -dualTol) {
        t = basicVal[i] / -a;
        hitUpper = false;
      } else {
        continue;
      }
      if (Math.abs(t - tMin) <= feasTol && basis[i] < bestVar) {
        bestVar = basis[i];
        bestRow = i;
        bestAtUpper = hitUpper;
        flip = false;
      }
    }

    iterations++;

    // ---- Apply the step ----------------------------------------------------
    if (flip) {
      // Bound flip: entering toggles lower↔upper; no basis change.
      atUpper[entering] = atUpper[entering] ? 0 : 1;
      continue;
    }

    if (bestRow === -1) {
      // No basic blocker but tMin < ∞ → must be the entering's own flip (covered
      // above). Defensive: treat as a flip to avoid a bad pivot.
      atUpper[entering] = atUpper[entering] ? 0 : 1;
      continue;
    }

    // Leaving variable exits at the bound it hit; entering becomes basic.
    const leaving = basis[bestRow];
    atUpper[leaving] = bestAtUpper ? 1 : 0;
    isBasic[leaving] = 0;
    isBasic[entering] = 1;
    basis[bestRow] = entering;
    atUpper[entering] = 0;

    pivot(ctx, entering, bestRow);
  }
}

// ============================================================================
// Pivot (Gauss-Jordan) on (row=bestRow, col=entering)
// ============================================================================

function pivot(ctx: SimplexCtx, col: number, row: number): void {
  const { m, nTotal, tStride, T, rhs } = ctx;
  const base = row * tStride;
  const pivotVal = T[base + col];
  if (pivotVal === 0) return; // degenerate row — leave as-is
  const inv = 1 / pivotVal;
  for (let k = 0; k < nTotal; k++) T[base + k] *= inv;
  rhs[row] *= inv;

  for (let i = 0; i < m; i++) {
    if (i === row) continue;
    const f = T[i * tStride + col];
    if (f === 0) continue;
    const bi = i * tStride;
    for (let k = 0; k < nTotal; k++) T[bi + k] -= f * T[base + k];
    rhs[i] -= f * rhs[row];
  }
}

// ============================================================================
// Separated bound (no usable rows): optimize each box independently
// ============================================================================

function separatedBound(data: SimplexLpData, colBounds: ColumnBounds, sense: LpSense): number {
  const maximize = sense === 'maximize';
  let value = data.offset;
  for (let j = 0; j < data.numCols; j++) {
    const c = data.c[j];
    const lo = colBounds.lb[j];
    const hi = colBounds.ub[j];
    // maximize: push toward hi if c ≥ 0, toward lo if c < 0.
    // minimize: push toward lo if c ≥ 0, toward hi if c < 0.
    const at = maximize ? (c >= 0 ? hi : lo) : c >= 0 ? lo : hi;
    value += c * at;
  }
  return value;
}
