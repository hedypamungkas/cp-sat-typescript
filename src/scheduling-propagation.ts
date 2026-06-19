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

import { Domain, LinearExpr, IntVar, IntervalVar } from './types';
import { NoOverlapConstraint, CumulativeConstraint } from './constraints';

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

  // Build profile from mandatory parts of present tasks
  const events: ProfileEvent[] = [];
  for (const task of tasks) {
    if (task.bounds.presenceState === 'absent') continue;
    // Mandatory part: [startMax, endMin)
    const mpStart = task.bounds.startMax;
    const mpEnd = task.bounds.endMin;
    if (mpStart < mpEnd) {
      events.push({ time: mpStart, delta: task.demandMin });
      events.push({ time: mpEnd, delta: -task.demandMin });
    }
  }

  if (events.length === 0) return 'CONSISTENT';

  // Sort: by time, start events before end events at same time
  // (positive delta before negative delta at same time point)
  events.sort((a, b) => a.time - b.time || (b.delta - a.delta));

  // Sweep to build profile
  const profile: { time: number; height: number }[] = [];
  let height = 0;

  for (const event of events) {
    if (profile.length === 0 || event.time !== profile[profile.length - 1].time) {
      profile.push({ time: event.time, height });
    }
    height += event.delta;
    profile[profile.length - 1].height = height;
  }

  // Overload detection
  for (const rect of profile) {
    if (rect.height > capacityMax) {
      return 'INFEASIBLE';
    }
  }

  // Forward sweep — prune startMin for unfixed tasks only
  // Fixed tasks are already in the profile, so checking them would double-count
  for (const task of tasks) {
    if (task.bounds.presenceState === 'absent') continue;
    if (task.demandMin >= capacityMax) continue;
    // Skip fixed tasks — they're already in the profile
    if (task.bounds.startMin === task.bounds.startMax) continue;

    // conflictHeight: max profile height where task can still fit
    const conflictHeight = capacityMax - task.demandMin;
    let newStartMin = task.bounds.startMin;

    for (let i = 0; i < profile.length - 1; i++) {
      const rect = profile[i];
      const nextRect = profile[i + 1];

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

  // Backward sweep — prune endMax for unfixed tasks only
  const reversedProfile = profile
    .map(r => ({ time: -r.time, height: r.height }))
    .reverse();

  for (const task of tasks) {
    if (task.bounds.presenceState === 'absent') continue;
    if (task.demandMin >= capacityMax) continue;
    // Skip fixed tasks — they're already in the profile
    if (task.bounds.startMin === task.bounds.startMax) continue;

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
        // Find the latest endMin among tasks that could precede this one
        let latestPredecessorEnd = -Infinity;
        for (const t of others) {
          if (t.endMin > latestPredecessorEnd) {
            latestPredecessorEnd = t.endMin;
          }
        }

        if (latestPredecessorEnd === -Infinity) {
          return 'INFEASIBLE';
        }

        // Decrease endMax of task
        try {
          if (tightenEndMax(task, latestPredecessorEnd, domains, propagateLinear)) {
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
// Phase 3: Theta Tree
// ============================================================================

/**
 * Theta tree for efficient energy computation in edge-finding.
 *
 * Maintains a segment tree where each leaf represents a task sorted by startMin.
 * Internal nodes store:
 * - energy: total energy (sum of children's energy)
 * - envelope: max energy in any suffix of the subtree
 *
 * The envelope captures: for the tasks in this subtree sorted by startMin,
 * what is the maximum total energy of any suffix?
 */
export class ThetaTree {
  private _n: number;
  private _size: number;
  private _energy: number[];
  private _envelope: number[];

  constructor(n: number) {
    this._n = 1;
    while (this._n < n) this._n *= 2;
    this._size = 2 * this._n;
    this._energy = new Array(this._size).fill(0);
    this._envelope = new Array(this._size).fill(0);
  }

  /**
   * Update a leaf node with task energy.
   * i is 0-based leaf index.
   */
  update(i: number, energy: number): void {
    const leaf = i + this._n;
    this._energy[leaf] = energy;
    this._envelope[leaf] = energy;
    this._recalcUp(leaf);
  }

  /**
   * Remove a task at position i (set energy to 0).
   */
  remove(i: number): void {
    this.update(i, 0);
  }

  /**
   * Get the maximum envelope across the entire tree.
   * For NoOverlap: this is the max total size of any suffix of tasks.
   */
  getEnvelope(): number {
    return this._envelope[1];
  }

  /**
   * Get total energy of all tasks in the tree.
   */
  getTotalEnergy(): number {
    return this._energy[1];
  }

  /**
   * Reset all nodes to zero.
   */
  reset(): void {
    this._energy.fill(0);
    this._envelope.fill(0);
  }

  private _recalcUp(leaf: number): void {
    let node = Math.floor(leaf / 2);
    while (node >= 1) {
      this._recalc(node);
      node = Math.floor(node / 2);
    }
  }

  private _recalc(node: number): void {
    const left = 2 * node;
    const right = 2 * node + 1;

    this._energy[node] = this._energy[left] + this._energy[right];
    this._envelope[node] = Math.max(
      this._envelope[left],
      this._envelope[right] + this._energy[left]
    );
  }
}

// ============================================================================
// Phase 3: Edge-Finding (Disjunctive)
// ============================================================================

/**
 * Edge-finding for NoOverlap using Theta Tree.
 *
 * For each contiguous window, check if the total mandatory energy (sum of sizes)
 * exceeds the window duration. If so, the window is infeasible.
 *
 * For each task in the window, if removing it makes the remaining energy fit,
 * then the task must start after the remaining tasks finish.
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

  const activeTasks = tasks.filter(t => t.presenceState !== 'absent');
  if (activeTasks.length <= 2) return 'CONSISTENT';

  let changed = false;

  // Build contiguous windows
  const windows = buildContiguousWindows(activeTasks);

  for (const window of windows) {
    if (window.length <= 2) continue;

    // Compute window bounds
    const windowStart = Math.min(...window.map(t => t.startMin));
    const windowEnd = Math.max(...window.map(t => t.endMax));
    const windowSize = windowEnd - windowStart;

    // Compute total mandatory energy (sum of sizes)
    let totalEnergy = 0;
    for (const task of window) {
      totalEnergy += task.sizeMin;
    }

    // If total energy exceeds window size → INFEASIBLE
    if (totalEnergy > windowSize) {
      return 'INFEASIBLE';
    }

    // For each task, check if removing it makes the rest fit
    // If so, the task can be "gray" and must start after the mandatory envelope
    for (const task of window) {
      const otherEnergy = totalEnergy - task.sizeMin;

      // If other tasks' energy exceeds the window without this task,
      // this task must be scheduled after the others
      if (otherEnergy > windowSize - task.sizeMin) {
        // The other tasks fill the window — this task must start after them
        // Push startMin to windowStart + otherEnergy
        const newStartMin = windowStart + otherEnergy;

        if (newStartMin > task.startMin) {
          try {
            if (tightenStartMin(task, newStartMin, domains, propagateLinear)) {
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
