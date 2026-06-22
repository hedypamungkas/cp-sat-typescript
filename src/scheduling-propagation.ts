/**
 * Scheduling Constraint Propagation
 *
 * Implements propagation algorithms for NoOverlap and Cumulative constraints:
 * - Phase 1: Simple Precedences (NoOverlap), Time-Table (Cumulative)
 * - Phase 2: Detectable Precedences, Not-Last (NoOverlap)
 * - Phase 3: Edge-Finding with Theta Tree (both)
 *
 * Based on algorithms from:
 * - OR-Tools disjunctive.cc and timetable.cc
 * - Carlier & Pinson (1994), Baptiste et al. (2001), Vilim (2011)
 */

import { Domain, LinearExpr, IntVar, IntervalVar, BoolVar } from './types';
import { NoOverlapConstraint, CumulativeConstraint, ReservoirConstraint } from './constraints';

// ============================================================================
// Types
// ============================================================================

export type PropagationResult = 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE';

/** Pre-computed bounds for a single interval variable */
export interface IntervalBounds {
  readonly iv: IntervalVar;
  readonly startMin: number;
  readonly startMax: number;
  readonly endMin: number;
  readonly endMax: number;
  readonly sizeMin: number;
  readonly sizeMax: number;
  readonly presenceState: 'present' | 'absent' | 'maybe';
}

/** Callback for delegating linear constraint propagation to the engine */
export type LinearPropagateFn = (
  vars: IntVar[],
  coeffs: number[],
  lb: number,
  ub: number,
  domains: Map<number, Domain>
) => PropagationResult;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compute min/max bounds from a LinearExpr given current variable domains.
 * Returns null if any variable domain is empty.
 */
function getExprBounds(
  expr: LinearExpr,
  domains: Map<number, Domain>
): { min: number; max: number } | null {
  let min = expr.offset;
  let max = expr.offset;

  for (let i = 0; i < expr.vars.length; i++) {
    const d = domains.get(expr.vars[i].index);
    if (!d || d.isEmpty) return null;
    const c = expr.coeffs[i];
    if (c > 0) {
      min += c * d.min;
      max += c * d.max;
    } else if (c < 0) {
      min += c * d.max;
      max += c * d.min;
    }
  }
  return { min, max };
}

/**
 * Determine the presence state of an interval variable.
 */
function classifyPresence(
  iv: IntervalVar,
  domains: Map<number, Domain>
): 'present' | 'absent' | 'maybe' {
  if (!iv.isPresent) return 'present';
  const presDomain = domains.get(iv.isPresent.index);
  if (!presDomain) return 'maybe';
  if (presDomain.size === 1) {
    return presDomain.min === 1 ? 'present' : 'absent';
  }
  return 'maybe';
}

/**
 * Compute interval bounds from current variable domains.
 * Returns null if any component domain is empty.
 */
export function computeIntervalBounds(
  iv: IntervalVar,
  domains: Map<number, Domain>
): IntervalBounds | null {
  const start = getExprBounds(iv.start, domains);
  const size = getExprBounds(iv.size, domains);
  const end = getExprBounds(iv.end, domains);

  if (!start || !size || !end) return null;

  return {
    iv,
    startMin: start.min,
    startMax: start.max,
    endMin: end.min,
    endMax: end.max,
    sizeMin: size.min,
    sizeMax: size.max,
    presenceState: classifyPresence(iv, domains),
  };
}

/**
 * Check if a LinearExpr is a simple variable (single var, coeff=1, offset=0).
 * Returns the IntVar if simple, null otherwise.
 */
function getSimpleVar(expr: LinearExpr): IntVar | null {
  if (expr.vars.length === 1 && expr.coeffs[0] === 1 && expr.offset === 0) {
    return expr.vars[0];
  }
  return null;
}

/**
 * Tighten a variable's domain to be >= lb.
 * Returns true if domain changed, throws if infeasible.
 */
function tightenLB(
  domains: Map<number, Domain>,
  varIndex: number,
  lb: number
): boolean {
  const current = domains.get(varIndex);
  if (!current) return false;
  if (lb <= current.min) return false;
  const newDomain = current.greaterOrEqual(lb);
  if (newDomain.isEmpty) throw new Error('INFEASIBLE');
  domains.set(varIndex, newDomain);
  return true;
}

/**
 * Tighten a variable's domain to be <= ub.
 * Returns true if domain changed, throws if infeasible.
 */
function tightenUB(
  domains: Map<number, Domain>,
  varIndex: number,
  ub: number
): boolean {
  const current = domains.get(varIndex);
  if (!current) return false;
  if (ub >= current.max) return false;
  const newDomain = current.lessOrEqual(ub);
  if (newDomain.isEmpty) throw new Error('INFEASIBLE');
  domains.set(varIndex, newDomain);
  return true;
}

/**
 * Tighten start variable domain: start >= newMin.
 * For simple vars, directly tighten. For complex expressions, delegate.
 */
function tightenStartMin(
  task: IntervalBounds,
  newMin: number,
  domains: Map<number, Domain>,
  propagateLinear: LinearPropagateFn
): boolean {
  if (newMin <= task.startMin) return false;
  const simpleVar = getSimpleVar(task.iv.start);
  if (simpleVar) {
    return tightenLB(domains, simpleVar.index, newMin);
  }
  // Delegate: start >= newMin => sum(vars*coeffs) + offset >= newMin
  const result = propagateLinear(
    task.iv.start.vars,
    task.iv.start.coeffs,
    newMin - task.iv.start.offset,
    Infinity,
    domains
  );
  return result === 'CHANGED';
}

/**
 * Tighten end variable domain: end <= newMax.
 * For simple vars, directly tighten. For complex expressions, delegate.
 */
function tightenEndMax(
  task: IntervalBounds,
  newMax: number,
  domains: Map<number, Domain>,
  propagateLinear: LinearPropagateFn
): boolean {
  if (newMax >= task.endMax) return false;
  const simpleVar = getSimpleVar(task.iv.end);
  if (simpleVar) {
    return tightenUB(domains, simpleVar.index, newMax);
  }
  // Delegate: end <= newMax => sum(vars*coeffs) + offset <= newMax
  const result = propagateLinear(
    task.iv.end.vars,
    task.iv.end.coeffs,
    -Infinity,
    newMax - task.iv.end.offset,
    domains
  );
  return result === 'CHANGED';
}

/**
 * Build contiguous windows from tasks sorted by startMin.
 * Tasks in the same window overlap when packed left-to-right.
 */
function buildContiguousWindows(tasks: IntervalBounds[]): IntervalBounds[][] {
  const sorted = [...tasks].sort((a, b) => a.startMin - b.startMin);
  const windows: IntervalBounds[][] = [];
  let current: IntervalBounds[] = [];
  let windowEnd = -Infinity;

  for (const task of sorted) {
    if (task.startMin >= windowEnd && current.length > 0) {
      windows.push(current);
      current = [];
    }
    current.push(task);
    windowEnd = Math.max(windowEnd, task.startMin + task.sizeMin);
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

// ============================================================================
// Phase 1: NoOverlap — Simple Precedences
// ============================================================================

/**
 * Detect blocking tasks and generate precedences for NoOverlap.
 *
 * For each pair (A, B) of present tasks:
 * - If mandatory parts overlap → INFEASIBLE
 * - If A's mandatory start is before B's mandatory end, and A's endMin is
 *   after B's startMax, then B must finish before A starts → push A's startMin
 */
export function propagateNoOverlap(
  ct: NoOverlapConstraint,
  domains: Map<number, Domain>,
  propagateLinear: LinearPropagateFn
): PropagationResult {
  const tasks: IntervalBounds[] = [];
  for (const iv of ct.intervals) {
    const bounds = computeIntervalBounds(iv, domains);
    if (!bounds) return 'CONSISTENT';
    tasks.push(bounds);
  }

  let changed = false;

  // Filter to present tasks only (skip maybe for precedence detection)
  const presentTasks = tasks.filter(t => t.presenceState === 'present');
  if (presentTasks.length <= 1) return 'CONSISTENT';

  for (let i = 0; i < presentTasks.length; i++) {
    for (let j = i + 1; j < presentTasks.length; j++) {
      const a = presentTasks[i];
      const b = presentTasks[j];

      // Mandatory parts: [startMax, endMin) — only exists if startMax < endMin
      const aHasMandatory = a.startMax < a.endMin;
      const bHasMandatory = b.startMax < b.endMin;

      // Check mandatory part overlap → INFEASIBLE
      if (aHasMandatory && bHasMandatory) {
        if (a.startMax < b.endMin && b.startMax < a.endMin) {
          return 'INFEASIBLE';
        }
      }

      // Precedence: if A's mandatory part is before B's mandatory part,
      // then B must start after A finishes
      // A must finish before B: detected when startMax_A < endMin_B
      // This means A must start before B finishes → B's start is constrained
      if (aHasMandatory && bHasMandatory) {
        // If A must start before B finishes, and A has a mandatory part,
        // then B must start after A's mandatory end
        if (a.startMax < b.endMin) {
          // B must start after A finishes
          try {
            if (tightenStartMin(b, a.endMin, domains, propagateLinear)) {
              changed = true;
            }
          } catch {
            return 'INFEASIBLE';
          }
        }

        // Symmetric: if B must start before A finishes
        if (b.startMax < a.endMin) {
          try {
            if (tightenStartMin(a, b.endMin, domains, propagateLinear)) {
              changed = true;
            }
          } catch {
            return 'INFEASIBLE';
          }
        }
      }
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

// ============================================================================
// Phase 1: Cumulative — Time-Table Propagation
// ============================================================================

interface ProfileEvent {
  time: number;
  delta: number;
}

/**
 * Build a resource profile from mandatory parts of fixed-start tasks
 * and prune unfixed tasks that conflict with the profile.
 *
 * A task is "fixed" if startMin == startMax (exact start time known).
 * Only fixed tasks contribute to the profile.
 */
export function propagateCumulativeTimeTable(
  ct: CumulativeConstraint,
  domains: Map<number, Domain>,
  propagateLinear: LinearPropagateFn
): PropagationResult {
  // Extract capacity bounds
  const capBounds = getExprBounds(ct.capacity, domains);
  if (!capBounds) return 'CONSISTENT';
  const capacityMax = capBounds.max;

  // Extract task bounds
  const tasks: { bounds: IntervalBounds; demandMin: number }[] = [];
  for (let i = 0; i < ct.intervals.length; i++) {
    const bounds = computeIntervalBounds(ct.intervals[i], domains);
    if (!bounds) return 'CONSISTENT';
    const dBounds = getExprBounds(ct.demands[i], domains);
    if (!dBounds) return 'CONSISTENT';
    tasks.push({ bounds, demandMin: dBounds.min });
  }

  let changed = false;

  // Build the mandatory-part time-table profile, optionally excluding one task.
  // The overload check uses the FULL profile; per-task placement uses a profile
  // EXCLUDING that task, so a task is never counted as conflicting with its own
  // mandatory part (which caused false INFEASIBLE — see the
  // propagateCumulativeTimeTable property test).
  const buildProfile = (excludeIdx: number): { time: number; height: number }[] => {
    const events: ProfileEvent[] = [];
    tasks.forEach((task, idx) => {
      if (idx === excludeIdx) return;
      if (task.bounds.presenceState === 'absent') return;
      // Mandatory part: [startMax, endMin)
      const mpStart = task.bounds.startMax;
      const mpEnd = task.bounds.endMin;
      if (mpStart < mpEnd) {
        events.push({ time: mpStart, delta: task.demandMin });
        events.push({ time: mpEnd, delta: -task.demandMin });
      }
    });
    if (events.length === 0) return [];
    // Sort: by time, start events before end events at the same time point.
    events.sort((a, b) => a.time - b.time || (b.delta - a.delta));
    const profile: { time: number; height: number }[] = [];
    let height = 0;
    for (const event of events) {
      if (profile.length === 0 || event.time !== profile[profile.length - 1].time) {
        profile.push({ time: event.time, height });
      }
      height += event.delta;
      profile[profile.length - 1].height = height;
    }
    return profile;
  };

  // Overload detection uses the FULL profile (all mandatory parts).
  const profile = buildProfile(-1);
  for (const rect of profile) {
    if (rect.height > capacityMax) {
      return 'INFEASIBLE';
    }
  }
  if (profile.length === 0) return 'CONSISTENT';

  // Forward sweep — prune startMin for unfixed tasks. Use a profile excluding
  // the task itself so its own mandatory part is not a self-conflict.
  for (let ti = 0; ti < tasks.length; ti++) {
    const task = tasks[ti];
    if (task.bounds.presenceState === 'absent') continue;
    if (task.demandMin >= capacityMax) continue;
    // Skip fixed tasks — their mandatory part is already fixed in place.
    if (task.bounds.startMin === task.bounds.startMax) continue;

    const othersProfile = buildProfile(ti);
    const conflictHeight = capacityMax - task.demandMin;
    let newStartMin = task.bounds.startMin;

    for (let i = 0; i < othersProfile.length - 1; i++) {
      const rect = othersProfile[i];
      const nextRect = othersProfile[i + 1];

      if (rect.time >= task.bounds.endMin) break;
      if (rect.height <= conflictHeight) continue;

      // This rectangle conflicts — task can't start before nextRect.time
      if (nextRect.time > newStartMin) {
        newStartMin = nextRect.time;
      }
    }

    if (newStartMin > task.bounds.startMin) {
      try {
        if (tightenStartMin(task.bounds, newStartMin, domains, propagateLinear)) {
          changed = true;
        }
      } catch {
        return 'INFEASIBLE';
      }
    }
  }

  // Backward sweep — prune endMax for unfixed tasks (profile excludes the task).
  for (let ti = 0; ti < tasks.length; ti++) {
    const task = tasks[ti];
    if (task.bounds.presenceState === 'absent') continue;
    if (task.demandMin >= capacityMax) continue;
    if (task.bounds.startMin === task.bounds.startMax) continue;

    const reversedProfile = buildProfile(ti)
      .map(r => ({ time: -r.time, height: r.height }))
      .reverse();

    const conflictHeight = capacityMax - task.demandMin;
    const negEndMax = -task.bounds.endMax;
    let newNegEndMax = negEndMax;

    for (let i = 0; i < reversedProfile.length - 1; i++) {
      const rect = reversedProfile[i];
      const nextRect = reversedProfile[i + 1];

      if (rect.time >= -task.bounds.startMin) break;
      if (rect.height <= conflictHeight) continue;

      if (nextRect.time > newNegEndMax) {
        newNegEndMax = nextRect.time;
      }
    }

    const newEndMax = -newNegEndMax;
    if (newEndMax < task.bounds.endMax) {
      try {
        if (tightenEndMax(task.bounds, newEndMax, domains, propagateLinear)) {
          changed = true;
        }
      } catch {
        return 'INFEASIBLE';
      }
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

// ============================================================================
// Phase 2: NoOverlap — Detectable Precedences (Not-First)
// ============================================================================

/**
 * Detect tasks that cannot be first in a packing window.
 *
 * Assign ranks based on packing: tasks that overlap when packed left-to-right
 * get the same rank. For each task with rank > 0, the max endMin of all
 * lower-rank tasks gives a lower bound on its startMin.
 */
export function propagateNoOverlapDetectable(
  ct: NoOverlapConstraint,
  domains: Map<number, Domain>,
  propagateLinear: LinearPropagateFn
): PropagationResult {
  const tasks: IntervalBounds[] = [];
  for (const iv of ct.intervals) {
    const bounds = computeIntervalBounds(iv, domains);
    if (!bounds) return 'CONSISTENT';
    tasks.push(bounds);
  }

  const activeTasks = tasks.filter(t => t.presenceState !== 'absent');
  if (activeTasks.length <= 1) return 'CONSISTENT';

  let changed = false;

  // Sort by startMin
  const sorted = [...activeTasks].sort((a, b) => a.startMin - b.startMin);

  // Assign ranks based on packing windows
  let rank = 0;
  let windowEnd = -Infinity;
  const ranked: { task: IntervalBounds; rank: number }[] = [];

  for (const task of sorted) {
    if (task.startMin >= windowEnd && ranked.length > 0) {
      rank++;
      windowEnd = task.startMin + task.sizeMin;
    } else if (ranked.length === 0) {
      windowEnd = task.startMin + task.sizeMin;
    } else {
      windowEnd = Math.max(windowEnd, task.startMin + task.sizeMin);
    }
    ranked.push({ task, rank });
  }

  // For each task, compute endMin of all tasks with lower rank
  for (const entry of ranked) {
    if (entry.rank === 0) continue;

    let maxEndMinOfPredecessors = -Infinity;
    for (const other of ranked) {
      if (other === entry) continue;
      if (other.rank < entry.rank && other.task.endMin > maxEndMinOfPredecessors) {
        maxEndMinOfPredecessors = other.task.endMin;
      }
    }

    if (maxEndMinOfPredecessors > entry.task.startMin) {
      try {
        if (tightenStartMin(entry.task, maxEndMinOfPredecessors, domains, propagateLinear)) {
          changed = true;
        }
      } catch {
        return 'INFEASIBLE';
      }
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

// ============================================================================
// Phase 2: NoOverlap — Not-Last Rule
// ============================================================================

/**
 * Detect tasks that cannot be last in a contiguous window.
 *
 * If packing all other tasks left-to-right produces an endMin that exceeds
 * task A's startMax, then A cannot be last — decrease A's endMax.
 */
export function propagateNoOverlapNotLast(
  ct: NoOverlapConstraint,
  domains: Map<number, Domain>,
  propagateLinear: LinearPropagateFn
): PropagationResult {
  const tasks: IntervalBounds[] = [];
  for (const iv of ct.intervals) {
    const bounds = computeIntervalBounds(iv, domains);
    if (!bounds) return 'CONSISTENT';
    tasks.push(bounds);
  }

  const activeTasks = tasks.filter(t => t.presenceState !== 'absent');
  if (activeTasks.length <= 1) return 'CONSISTENT';

  let changed = false;

  // Build contiguous windows
  const windows = buildContiguousWindows(activeTasks);

  // For each window, apply not-last rule
  for (const window of windows) {
    if (window.length <= 1) continue;

    for (const task of window) {
      // Pack all other tasks left-to-right
      const others = window.filter(t => t !== task);
      others.sort((a, b) => a.startMin - b.startMin);

      let packEnd = -Infinity;
      for (const t of others) {
        if (t.startMin >= packEnd) {
          packEnd = t.startMin + t.sizeMin;
        } else {
          packEnd += t.sizeMin;
        }
      }

      // If others pack past task's startMax → task cannot be last
      if (packEnd > task.startMax) {
        // Not-last bound: if the task cannot be last, it must end before the
        // start of the task that DOES come last. The sound upper bound on
        // endMax(task) is therefore max(startMax) of the other tasks (their
        // latest start). Using endMin (earliest end) here over-tightens and is
        // unsound — see the propagateNoOverlapNotLast property test.
        let latestFollowingStart = -Infinity;
        for (const t of others) {
          if (t.startMax > latestFollowingStart) {
            latestFollowingStart = t.startMax;
          }
        }

        if (latestFollowingStart === -Infinity) {
          return 'INFEASIBLE';
        }

        // Decrease endMax of task
        try {
          if (tightenEndMax(task, latestFollowingStart, domains, propagateLinear)) {
            changed = true;
          }
        } catch {
          return 'INFEASIBLE';
        }
      }
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

// ============================================================================
// (Theta tree removed.) The edge-finding propagators below use direct loops
// over scheduling windows — sound, but O(n^2)/O(n^3) rather than O(n log n).
// A real Θ-tree would be a strength improvement, not a correctness one; it was
// previously dead code that was never instantiated.
// ============================================================================

// ============================================================================
// Phase 3: Edge-Finding (Disjunctive)
// ============================================================================

/**
 * Edge-finding for NoOverlap (disjunctive), Baptiste-Le Pape-Nuijten / Vilím.
 *
 * est = startMin, lct = endMax (latest completion), p = sizeMin. NOTE: lct is
 * endMax throughout — a previous attempt used endMin and was unsound (over-pruned);
 * see the propagateNoOverlapEdgeFinding property test.
 *
 * 1. Overload: for a prefix Ω (tasks sorted by lct), if est(Ω) + p(Ω) > lct(Ω)
 *    the present tasks cannot all fit → INFEASIBLE.
 * 2. Edge-finding (start update): for task i and Ω ⊆ T\{i}, if
 *    est(Ω∪{i}) + p(Ω∪{i}) > lct(Ω) then i cannot run after all of Ω, so
 *    est_i ← max(est_i, est(Ω) + p(Ω)).
 *
 * Only definitely-present tasks participate (a 'maybe' task may not execute, so
 * its size is not mandatory). O(n²), single pass.
 */
export function propagateNoOverlapEdgeFinding(
  ct: NoOverlapConstraint,
  domains: Map<number, Domain>,
  propagateLinear: LinearPropagateFn
): PropagationResult {
  const tasks: IntervalBounds[] = [];
  for (const iv of ct.intervals) {
    const bounds = computeIntervalBounds(iv, domains);
    if (!bounds) return 'CONSISTENT';
    tasks.push(bounds);
  }

  // Reason only about definitely-present tasks (soundness w.r.t. optional
  // intervals): a 'maybe' task may not execute, so its size is not mandatory.
  const present = tasks.filter(t => t.presenceState === 'present');
  if (present.length <= 1) return 'CONSISTENT';

  // Sort by lct = endMax ascending.
  const byLct = [...present].sort((a, b) => a.endMax - b.endMax);

  let changed = false;

  // ---- Overload detection: for each prefix Ω (ascending lct), if
  // est(Ω) + p(Ω) > lct(Ω) the tasks cannot all fit → INFEASIBLE. ----
  {
    let estMin = Infinity;
    let pSum = 0;
    for (const task of byLct) {
      estMin = Math.min(estMin, task.startMin);
      pSum += task.sizeMin;
      if (estMin + pSum > task.endMax) {
        return 'INFEASIBLE';
      }
    }
  }

  // ---- Edge-finding: start-time update. For each task i, sweep prefixes Ω of
  // (T \ {i}) by ascending lct; when est(Ω ∪ {i}) + p(Ω ∪ {i}) > lct(Ω), i
  // cannot be scheduled after all of Ω, so est_i ≥ est(Ω) + p(Ω). ----
  for (let i = 0; i < byLct.length; i++) {
    const taskI = byLct[i];
    const estI = taskI.startMin;
    const pI = taskI.sizeMin;

    let bestBound = estI;
    let estMinPref = Infinity;
    let pPref = 0;
    for (let k = 0; k < byLct.length; k++) {
      if (k === i) continue;
      const j = byLct[k];
      estMinPref = Math.min(estMinPref, j.startMin);
      pPref += j.sizeMin;
      const lctOmega = j.endMax;
      // Qualifying: est(Ω ∪ {i}) + p(Ω ∪ {i}) > lct(Ω)?
      if (Math.min(estMinPref, estI) + (pPref + pI) > lctOmega) {
        const cand = estMinPref + pPref;
        if (cand > bestBound) bestBound = cand;
      }
    }

    if (bestBound > estI) {
      try {
        if (tightenStartMin(taskI, bestBound, domains, propagateLinear)) {
          changed = true;
        }
      } catch {
        return 'INFEASIBLE';
      }
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

// ============================================================================
// Phase 3: Cumulative Edge-Finding
// ============================================================================

/**
 * Energy-based edge-finding for Cumulative constraint.
 *
 * For each task, compute the mandatory energy in its window [startMin, endMax].
 * If the energy exceeds available capacity, the task must be rescheduled.
 */
export function propagateCumulativeEdgeFinding(
  ct: CumulativeConstraint,
  domains: Map<number, Domain>,
  propagateLinear: LinearPropagateFn
): PropagationResult {
  // Extract capacity bounds
  const capBounds = getExprBounds(ct.capacity, domains);
  if (!capBounds) return 'CONSISTENT';
  const capacityMax = capBounds.max;

  // Extract task bounds
  const tasks: { bounds: IntervalBounds; demandMin: number }[] = [];
  for (let i = 0; i < ct.intervals.length; i++) {
    const bounds = computeIntervalBounds(ct.intervals[i], domains);
    if (!bounds) return 'CONSISTENT';
    const dBounds = getExprBounds(ct.demands[i], domains);
    if (!dBounds) return 'CONSISTENT';
    tasks.push({ bounds, demandMin: dBounds.min });
  }

  const activeTasks = tasks.filter(t => t.bounds.presenceState !== 'absent');
  if (activeTasks.length <= 1) return 'CONSISTENT';

  let changed = false;

  // For each window [windowMin, windowMax], compute total mandatory energy
  // and check if any task's free energy exceeds available space
  const sortedByEndMax = [...activeTasks].sort(
    (a, b) => a.bounds.endMax - b.bounds.endMax
  );

  for (let i = 0; i < sortedByEndMax.length; i++) {
    const task = sortedByEndMax[i];
    const windowMin = task.bounds.startMin;
    const windowMax = task.bounds.endMax;
    const windowSize = windowMax - windowMin;

    if (windowSize <= 0) continue;

    // Compute mandatory energy in this window from other tasks
    let mandatoryEnergy = 0;
    for (const other of activeTasks) {
      if (other === task) continue;

      // Other task's mandatory part overlap with [windowMin, windowMax)
      const otherMandStart = Math.max(other.bounds.startMax, windowMin);
      const otherMandEnd = Math.min(other.bounds.endMin, windowMax);

      if (otherMandStart < otherMandEnd) {
        mandatoryEnergy += other.demandMin * (otherMandEnd - otherMandStart);
      }
    }

    // Available energy for this task
    const availableEnergy = capacityMax * windowSize - mandatoryEnergy;
    const taskEnergy = task.demandMin * task.bounds.sizeMin;

    // If task's minimum energy exceeds available → push startMin forward
    if (taskEnergy > availableEnergy) {
      const neededSize = Math.ceil(taskEnergy / capacityMax);
      const newStartMin = windowMax - neededSize;

      if (newStartMin > task.bounds.startMin && newStartMin < windowMax) {
        try {
          if (tightenStartMin(task.bounds, newStartMin, domains, propagateLinear)) {
            changed = true;
          }
        } catch {
          return 'INFEASIBLE';
        }
      }
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

// ============================================================================
// Reservoir Constraint Propagation
// ============================================================================

/**
 * Reservoir constraint: maintains a resource level over time.
 *
 * At every time point t, the reservoir level L(t) must satisfy:
 *   minLevel <= L(t) <= maxLevel
 *
 * where L(t) = sum of levelChanges for all active events with time <= t.
 *
 * Propagation uses forward/backward sweep to tighten time domains and
 * active literals based on level bounds.
 */
export function propagateReservoir(
  ct: ReservoirConstraint,
  domains: Map<number, Domain>,
  propagateLinear: LinearPropagateFn
): PropagationResult {
  const n = ct.times.length;
  if (n === 0) return 'CONSISTENT';

  // Extract bounds for all events
  interface EventBounds {
    index: number;
    timeMin: number;
    timeMax: number;
    deltaMin: number;
    deltaMax: number;
    activeState: 'present' | 'absent' | 'maybe';
  }

  const events: EventBounds[] = [];
  for (let i = 0; i < n; i++) {
    const timeBounds = getExprBounds(ct.times[i], domains);
    if (!timeBounds) return 'CONSISTENT';
    const deltaBounds = getExprBounds(ct.levelChanges[i], domains);
    if (!deltaBounds) return 'CONSISTENT';

    let activeState: 'present' | 'absent' | 'maybe' = 'present';
    if (ct.activeLiterals[i]) {
      const d = domains.get(ct.activeLiterals[i].index);
      if (d) {
        if (d.size === 1) {
          activeState = d.min === 1 ? 'present' : 'absent';
        } else {
          activeState = 'maybe';
        }
      }
    }

    events.push({
      index: i,
      timeMin: timeBounds.min,
      timeMax: timeBounds.max,
      deltaMin: deltaBounds.min,
      deltaMax: deltaBounds.max,
      activeState,
    });
  }

  let changed = false;

  // Collect all unique time points for level checking
  const timePoints = new Set<number>();
  for (const event of events) {
    if (event.activeState !== 'absent') {
      timePoints.add(event.timeMin);
      timePoints.add(event.timeMax);
    }
  }
  const sortedTimes = [...timePoints].sort((a, b) => a - b);

  // For each time point, compute the min/max possible level and check bounds
  for (const t of sortedTimes) {
    let minLevel = 0;
    let maxLevel = 0;

    for (const event of events) {
      if (event.activeState === 'absent') continue;

      if (event.timeMax <= t) {
        // Event definitely occurs before t
        if (event.activeState === 'present') {
          minLevel += Math.min(event.deltaMin, event.deltaMax);
          maxLevel += Math.max(event.deltaMin, event.deltaMax);
        } else {
          // maybe: could be 0 or delta
          minLevel += Math.min(0, event.deltaMin, event.deltaMax);
          maxLevel += Math.max(0, event.deltaMin, event.deltaMax);
        }
      } else if (event.timeMin <= t) {
        // Event might occur before t
        if (event.activeState === 'present') {
          minLevel += Math.min(0, event.deltaMin, event.deltaMax);
          maxLevel += Math.max(0, event.deltaMin, event.deltaMax);
        } else {
          minLevel += Math.min(0, event.deltaMin, event.deltaMax);
          maxLevel += Math.max(0, event.deltaMin, event.deltaMax);
        }
      }
    }

    // Check for level violations
    if (minLevel > ct.maxLevel || maxLevel < ct.minLevel) {
      return 'INFEASIBLE';
    }
  }

  // ---- Time domain tightening via forward + backward sweeps ----

  // Helper: tighten timeMin of a time expression (time >= newMin)
  function tightenTimeMin(expr: LinearExpr, newMin: number): boolean {
    const sv = getSimpleVar(expr);
    if (sv) {
      return tightenLB(domains, sv.index, newMin);
    }
    const result = propagateLinear(
      expr.vars, expr.coeffs, newMin - expr.offset, Infinity, domains
    );
    return result === 'CHANGED';
  }

  // Helper: tighten timeMax of a time expression (time <= newMax)
  function tightenTimeMax(expr: LinearExpr, newMax: number): boolean {
    const sv = getSimpleVar(expr);
    if (sv) {
      return tightenUB(domains, sv.index, newMax);
    }
    const result = propagateLinear(
      expr.vars, expr.coeffs, -Infinity, newMax - expr.offset, domains
    );
    return result === 'CHANGED';
  }

  // Forward sweep: tighten time domains when level would be violated
  {
    const activeEvents = events.filter(e => e.activeState !== 'absent');

    // Collect all unique boundary time points
    const timePointSet = new Set<number>();
    for (const ev of activeEvents) {
      timePointSet.add(ev.timeMin);
      timePointSet.add(ev.timeMax);
    }
    const sortedTimes = [...timePointSet].sort((a, b) => a - b);

    for (let ti = 0; ti < sortedTimes.length; ti++) {
      const t = sortedTimes[ti];
      const nextTime = ti + 1 < sortedTimes.length ? sortedTimes[ti + 1] : undefined;

      // Compute cumulative level range at time t.
      // An event contributes to the level at t only if it has occurred by t.
      // - Definitely occurred (timeMax <= t): contributes its full delta range
      // - Might have occurred (timeMin <= t < timeMax): contributes 0 to delta range
      //   (could be 0 if hasn't occurred, or delta if has)
      // - Definitely not yet (timeMin > t): contributes 0
      let levelMin = 0;
      let levelMax = 0;
      for (const ev of activeEvents) {
        if (ev.timeMax <= t) {
          // Definitely occurred by t
          if (ev.activeState === 'present') {
            levelMin += Math.min(ev.deltaMin, ev.deltaMax);
            levelMax += Math.max(ev.deltaMin, ev.deltaMax);
          } else {
            // 'maybe' active: might not fire at all
            levelMin += Math.min(0, ev.deltaMin, ev.deltaMax);
            levelMax += Math.max(0, ev.deltaMin, ev.deltaMax);
          }
        } else if (ev.timeMin <= t) {
          // Might have occurred by t (tentative)
          // Contribution is 0 (hasn't occurred) to delta (has occurred)
          levelMin += Math.min(0, ev.deltaMin, ev.deltaMax);
          levelMax += Math.max(0, ev.deltaMin, ev.deltaMax);
        }
        // else: definitely not yet → contributes 0
      }

      // Overflow: a positive tentative event ev, if it occurred by t, would
      // force the minimum level above maxLevel (levelMin already excludes ev's
      // delta since it is tentative) → ev must occur after t.
      // NOTE: the previous `levelMin > maxLevel` guard was unreachable (identical
      // to the feasibility scan above); the per-event `+ ev.deltaMin` term is the
      // fix that makes this actually tighten.
      if (nextTime !== undefined) {
        for (const ev of activeEvents) {
          if (ev.timeMin <= t && ev.timeMax > t && ev.deltaMin > 0
            && levelMin + ev.deltaMin > ct.maxLevel) {
            try {
              if (tightenTimeMin(ct.times[ev.index], nextTime)) changed = true;
            } catch {
              return 'INFEASIBLE';
            }
          }
        }
      }

      // Underflow: a negative tentative event ev, if it occurred by t, would
      // force the maximum level below minLevel → ev must occur after t.
      if (nextTime !== undefined) {
        for (const ev of activeEvents) {
          if (ev.timeMin <= t && ev.timeMax > t && ev.deltaMax < 0
            && levelMax + ev.deltaMax < ct.minLevel) {
            try {
              if (tightenTimeMin(ct.times[ev.index], nextTime)) changed = true;
            } catch {
              return 'INFEASIBLE';
            }
          }
        }
      }

      // Backward: ev must be <= t (tighten timeMax to t) if excluding ev from
      // the prefix at t (ev > t) would violate a bound. Symmetric to the
      // forward checks above but subtracting ev's tentative contribution.
      for (const ev of activeEvents) {
        if (!(ev.timeMin <= t && ev.timeMax > t)) continue; // tentative at t
        // Positive ev excluded → lower max level → underflow → ev must be <= t.
        if (ev.deltaMax > 0 && levelMax - ev.deltaMax < ct.minLevel) {
          try {
            if (tightenTimeMax(ct.times[ev.index], t)) changed = true;
          } catch {
            return 'INFEASIBLE';
          }
        }
        // Negative ev excluded → higher min level → overflow → ev must be <= t.
        if (ev.deltaMin < 0 && levelMin - ev.deltaMin > ct.maxLevel) {
          try {
            if (tightenTimeMax(ct.times[ev.index], t)) changed = true;
          } catch {
            return 'INFEASIBLE';
          }
        }
      }
    }
  }

  // Propagation: tighten active literals based on level requirements
  for (const event of events) {
    if (event.activeState !== 'maybe') continue;
    if (!ct.activeLiterals[event.index]) continue;

    const activeLit = ct.activeLiterals[event.index];

    // Compute level without this event at the latest possible time
    let levelWithoutMin = 0;
    let levelWithoutMax = 0;

    for (const other of events) {
      if (other.index === event.index) continue;
      if (other.activeState === 'absent') continue;

      if (other.timeMax <= event.timeMax) {
        if (other.activeState === 'present') {
          levelWithoutMin += Math.min(other.deltaMin, other.deltaMax);
          levelWithoutMax += Math.max(other.deltaMin, other.deltaMax);
        } else {
          levelWithoutMin += Math.min(0, other.deltaMin, other.deltaMax);
          levelWithoutMax += Math.max(0, other.deltaMin, other.deltaMax);
        }
      }
    }

    // If levelWithout < minLevel and this event is positive, it must be active
    if (levelWithoutMax < ct.minLevel && event.deltaMin > 0) {
      try {
        const d = domains.get(activeLit.index);
        if (d && d.size > 1) {
          const newDomain = d.intersection(new Domain([1, 1]));
          if (!newDomain.isEmpty && newDomain.size < d.size) {
            domains.set(activeLit.index, newDomain);
            changed = true;
          }
        }
      } catch {
        return 'INFEASIBLE';
      }
    }

    // If levelWithout + delta > maxLevel and this event is positive, it must be inactive
    if (levelWithoutMin + event.deltaMax > ct.maxLevel && event.deltaMax > 0) {
      try {
        const d = domains.get(activeLit.index);
        if (d && d.size > 1) {
          const newDomain = d.intersection(new Domain([0, 0]));
          if (!newDomain.isEmpty && newDomain.size < d.size) {
            domains.set(activeLit.index, newDomain);
            changed = true;
          }
        }
      } catch {
        return 'INFEASIBLE';
      }
    }

    // If levelWithout > maxLevel and this event is negative, it must be active
    if (levelWithoutMin > ct.maxLevel && event.deltaMax < 0) {
      try {
        const d = domains.get(activeLit.index);
        if (d && d.size > 1) {
          const newDomain = d.intersection(new Domain([1, 1]));
          if (!newDomain.isEmpty && newDomain.size < d.size) {
            domains.set(activeLit.index, newDomain);
            changed = true;
          }
        }
      } catch {
        return 'INFEASIBLE';
      }
    }

    // If levelWithout + delta < minLevel and this event is negative, it must be inactive
    if (levelWithoutMax + event.deltaMin < ct.minLevel && event.deltaMin < 0) {
      try {
        const d = domains.get(activeLit.index);
        if (d && d.size > 1) {
          const newDomain = d.intersection(new Domain([0, 0]));
          if (!newDomain.isEmpty && newDomain.size < d.size) {
            domains.set(activeLit.index, newDomain);
            changed = true;
          }
        }
      } catch {
        return 'INFEASIBLE';
      }
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

/**
 * Check if a reservoir constraint is satisfied in the solution.
 * All variables must be fixed (domain size === 1).
 */
export function checkReservoir(
  ct: ReservoirConstraint,
  domains: Map<number, Domain>
): boolean {
  const n = ct.times.length;

  interface Event {
    time: number;
    delta: number;
  }

  const events: Event[] = [];
  for (let i = 0; i < n; i++) {
    // Check if event is active
    if (ct.activeLiterals[i]) {
      const d = domains.get(ct.activeLiterals[i].index);
      if (!d || d.size !== 1) return false;
      if (d.min === 0) continue; // inactive
    }

    // Get time value
    const timeExpr = ct.times[i];
    let timeVal = timeExpr.offset;
    for (let j = 0; j < timeExpr.vars.length; j++) {
      const vd = domains.get(timeExpr.vars[j].index);
      if (!vd || vd.size !== 1) return false;
      timeVal += timeExpr.coeffs[j] * vd.min;
    }

    // Get delta value
    const deltaExpr = ct.levelChanges[i];
    let deltaVal = deltaExpr.offset;
    for (let j = 0; j < deltaExpr.vars.length; j++) {
      const vd = domains.get(deltaExpr.vars[j].index);
      if (!vd || vd.size !== 1) return false;
      deltaVal += deltaExpr.coeffs[j] * vd.min;
    }

    events.push({ time: timeVal, delta: deltaVal });
  }

  // Sort events by time
  events.sort((a, b) => a.time - b.time);

  // Check level at each event
  let level = 0;
  for (const event of events) {
    level += event.delta;
    if (level < ct.minLevel || level > ct.maxLevel) {
      return false;
    }
  }

  return true;
}
