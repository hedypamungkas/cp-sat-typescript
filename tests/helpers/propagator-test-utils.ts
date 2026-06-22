/**
 * Propagator isolation & soundness test harness.
 *
 * Lets a test call a constraint propagator DIRECTLY (no CpSolver pipeline) and
 * assert exact pruned bounds, plus a brute-force soundness oracle:
 *
 *   "A sound propagator never removes a value that participates in a feasible
 *    complete assignment, and never reports INFEASIBLE when a feasible
 *    assignment exists."
 *
 * The oracle enumerates the full Cartesian product of small domains and a
 * user-supplied `isFeasible(assignment)` predicate to compute, per variable,
 * the set of values that have support. Any value the propagator removed that
 * still has support is a soundness bug.
 */
import { Domain, IntVar, LinearExpr, IntervalVar } from '../../src/types';
import type { PropagationResult } from '../../src/scheduling-propagation';

// ----------------------------------------------------------------------------
// Builders
// ----------------------------------------------------------------------------

let _nextIntervalIndex = 100000;

/**
 * Build a fixed-size IntervalVar over a single start variable, with
 * end = start + size expressed over the SAME variable (no separate end var).
 * This keeps the domains map minimal for isolation tests while staying
 * consistent with how fixed-size intervals behave.
 */
export function makeFixedInterval(sv: IntVar, size: number, name = 'iv'): IntervalVar {
  return {
    index: _nextIntervalIndex++,
    name,
    start: LinearExpr.fromVar(sv),
    size: LinearExpr.fromConstant(size),
    end: LinearExpr.fromVar(sv).add(size),
  };
}

/**
 * Build a domains map (cloned) from a list of variables.
 */
export function buildDomains(vars: IntVar[]): Map<number, Domain> {
  const domains = new Map<number, Domain>();
  for (const v of vars) {
    domains.set(v.index, v.domain.clone());
  }
  return domains;
}

/** Read a cloned snapshot of the current domains for the given vars. */
export function snapshotDomains(vars: IntVar[], domains: Map<number, Domain>): Map<number, Domain> {
  const snap = new Map<number, Domain>();
  for (const v of vars) {
    snap.set(v.index, domains.get(v.index)!.clone());
  }
  return snap;
}

// ----------------------------------------------------------------------------
// Brute-force soundness oracle
// ----------------------------------------------------------------------------

/** Maximum assignments the oracle will enumerate before bailing out. */
const MAX_ASSIGNMENTS = 200000;

/** A variable + its (original) domain for enumeration. */
export interface OracleVar {
  index: number;
  domain: Domain;
}

/**
 * Enumerate every complete assignment over the given variable domains and,
 * for each feasible one (per `isFeasible`), record which values are supported
 * for each variable. Returns the per-variable support sets and the total count
 * of feasible assignments.
 */
export function bruteForceSupport(
  vars: OracleVar[],
  isFeasible: (assignment: Map<number, number>) => boolean
): { support: Map<number, Set<number>>; feasibleCount: number } {
  // Guard against combinatorial explosion; tests should use tiny domains.
  let combos = 1;
  const valueLists: number[][] = [];
  for (const v of vars) {
    const vals = v.domain.values();
    combos *= vals.length;
    valueLists.push(vals);
  }
  if (combos > MAX_ASSIGNMENTS) {
    throw new Error(`bruteForceSupport: too many assignments (${combos}); shrink the instance`);
  }

  const support = new Map<number, Set<number>>();
  for (const v of vars) support.set(v.index, new Set<number>());

  let feasibleCount = 0;

  // Iterative Cartesian product.
  const indices = new Array(vars.length).fill(0);
  if (vars.length === 0) {
    // Nothing to enumerate; feasibility of an empty model is "feasible".
    return { support, feasibleCount: isFeasible(new Map()) ? 1 : 0 };
  }

  let more = true;
  while (more) {
    const assignment = new Map<number, number>();
    for (let d = 0; d < vars.length; d++) {
      assignment.set(vars[d].index, valueLists[d][indices[d]]);
    }
    if (isFeasible(assignment)) {
      feasibleCount++;
      for (let d = 0; d < vars.length; d++) {
        support.get(vars[d].index)!.add(valueLists[d][indices[d]]);
      }
    }

    // Increment odometer.
    let d = vars.length - 1;
    while (d >= 0) {
      indices[d]++;
      if (indices[d] < valueLists[d].length) break;
      indices[d] = 0;
      d--;
    }
    if (d < 0) more = false;
  }

  return { support, feasibleCount };
}

export interface SoundnessViolation {
  kind: 'removed-supported-value' | 'false-infeasible';
  varIndex?: number;
  value?: number;
  message: string;
}

/**
 * Assert a single propagator call is sound against the brute-force oracle.
 *
 * @param vars          the variables (start vars, in order) with their ORIGINAL domains
 * @param originalDomains snapshot of domains BEFORE the propagator ran
 * @param outputDomains  domains AFTER the propagator ran
 * @param result         the propagator's return value
 * @param isFeasible     ground-truth feasibility predicate over a full assignment
 * @returns list of violations (empty === sound)
 */
export function checkPropagatorSoundness(
  vars: IntVar[],
  originalDomains: Map<number, Domain>,
  outputDomains: Map<number, Domain>,
  result: PropagationResult,
  isFeasible: (assignment: Map<number, number>) => boolean
): SoundnessViolation[] {
  const oracleVars: OracleVar[] = vars.map(v => ({
    index: v.index,
    domain: originalDomains.get(v.index)!,
  }));
  const { support, feasibleCount } = bruteForceSupport(oracleVars, isFeasible);

  const violations: SoundnessViolation[] = [];

  // 1. The propagator must not remove any value that still has support.
  for (const v of vars) {
    const original = originalDomains.get(v.index)!;
    const output = outputDomains.get(v.index);
    if (!output) continue; // variable untouched is fine
    for (const val of original.values()) {
      if (!output.contains(val) && support.get(v.index)!.has(val)) {
        violations.push({
          kind: 'removed-supported-value',
          varIndex: v.index,
          value: val,
          message: `Removed supported value ${val} from var index ${v.index} (a feasible assignment exists with that value)`,
        });
      }
    }
  }

  // 2. If the propagator declared INFEASIBLE, there must be no feasible assignment.
  if (result === 'INFEASIBLE' && feasibleCount > 0) {
    violations.push({
      kind: 'false-infeasible',
      message: `Propagator returned INFEASIBLE but ${feasibleCount} feasible assignment(s) exist`,
    });
  }

  return violations;
}

// ----------------------------------------------------------------------------
// Ground-truth feasibility predicates
// ----------------------------------------------------------------------------

/** NoOverlap ground truth: no two intervals [s, s+size) overlap. */
export function noOverlapFeasible(
  startIndices: number[],
  sizes: number[]
): (assignment: Map<number, number>) => boolean {
  return (a) => {
    for (let i = 0; i < startIndices.length; i++) {
      for (let j = i + 1; j < startIndices.length; j++) {
        const si = a.get(startIndices[i])!;
        const sj = a.get(startIndices[j])!;
        if (si < sj + sizes[j] && sj < si + sizes[i]) return false; // overlap
      }
    }
    return true;
  };
}

/** Cumulative ground truth: at every time, sum of active demands <= capacity. */
export function cumulativeFeasible(
  startIndices: number[],
  sizes: number[],
  demands: number[],
  capacity: number
): (assignment: Map<number, number>) => boolean {
  return (a) => {
    // Collect all time points to check (interval starts).
    const points = startIndices.map((idx) => a.get(idx)!);
    for (const t of points) {
      let load = 0;
      for (let i = 0; i < startIndices.length; i++) {
        const s = a.get(startIndices[i])!;
        if (t >= s && t < s + sizes[i]) load += demands[i];
      }
      if (load > capacity) return false;
    }
    return true;
  };
}

/** NoOverlap2D ground truth: no two rectangles overlap in BOTH dimensions. */
export function noOverlap2DFeasible(
  xIndices: number[],
  yIndices: number[],
  widths: number[],
  heights: number[]
): (assignment: Map<number, number>) => boolean {
  return (a) => {
    for (let i = 0; i < xIndices.length; i++) {
      for (let j = i + 1; j < xIndices.length; j++) {
        const xi = a.get(xIndices[i])!, xj = a.get(xIndices[j])!;
        const yi = a.get(yIndices[i])!, yj = a.get(yIndices[j])!;
        const overlapX = xi < xj + widths[j] && xj < xi + widths[i];
        const overlapY = yi < yj + heights[j] && yj < yi + heights[i];
        if (overlapX && overlapY) return false;
      }
    }
    return true;
  };
}
