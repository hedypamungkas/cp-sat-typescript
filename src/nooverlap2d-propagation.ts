/**
 * NoOverlap2D Constraint Propagation
 *
 * Implements propagation algorithms for 2D rectangle non-overlap constraint.
 *
 * Full dedicated 2D propagation with:
 * - Pairwise restriction discovery (4-direction analysis)
 * - Energy-based conflict detection
 * - Connected component decomposition
 *
 * Based on OR-Tools diffn_util.h and Beldiceanu & Poder (2008).
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { Domain, LinearExpr, IntVar, IntervalVar } from './types';
import { NoOverlap2DConstraint } from './constraints';

// ============================================================================
// Types
// ============================================================================

export type PropagationResult = 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE';

/** Callback for delegating linear constraint propagation to the engine */
export type LinearPropagateFn = (
  vars: IntVar[],
  coeffs: number[],
  lb: number,
  ub: number,
  domains: Map<number, Domain>
) => PropagationResult;

/** Pre-computed bounds for a single interval variable */
interface IntervalBounds {
  readonly iv: IntervalVar;
  readonly startMin: number;
  readonly startMax: number;
  readonly endMin: number;
  readonly endMax: number;
  readonly sizeMin: number;
  readonly sizeMax: number;
  readonly presenceState: 'present' | 'absent' | 'maybe';
}

/** Rectangle bounds in 2D */
interface RectangleBounds {
  readonly index: number;
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly xSizeMin: number;
  readonly xSizeMax: number;
  readonly ySizeMin: number;
  readonly ySizeMax: number;
  readonly presenceState: 'present' | 'absent' | 'maybe';
  readonly xBounds: IntervalBounds;
  readonly yBounds: IntervalBounds;
}

// ============================================================================
// Helpers
// ============================================================================

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

function computeIntervalBounds(
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

function getSimpleVar(expr: LinearExpr): IntVar | null {
  if (expr.vars.length === 1 && expr.coeffs[0] === 1 && expr.offset === 0) {
    return expr.vars[0];
  }
  return null;
}

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
  const result = propagateLinear(
    task.iv.start.vars,
    task.iv.start.coeffs,
    newMin - task.iv.start.offset,
    Infinity,
    domains
  );
  return result === 'CHANGED';
}

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
  const result = propagateLinear(
    task.iv.end.vars,
    task.iv.end.coeffs,
    -Infinity,
    newMax - task.iv.end.offset,
    domains
  );
  return result === 'CHANGED';
}


// ============================================================================
// Rectangle Bounds Computation
// ============================================================================

function computeRectangleBounds(
  ct: NoOverlap2DConstraint,
  index: number,
  domains: Map<number, Domain>
): RectangleBounds | null {
  const xBounds = computeIntervalBounds(ct.xIntervals[index], domains);
  const yBounds = computeIntervalBounds(ct.yIntervals[index], domains);

  if (!xBounds || !yBounds) return null;

  // Presence: both x and y must be present
  let presenceState: 'present' | 'absent' | 'maybe' = 'present';
  if (xBounds.presenceState === 'absent' || yBounds.presenceState === 'absent') {
    presenceState = 'absent';
  } else if (xBounds.presenceState === 'maybe' || yBounds.presenceState === 'maybe') {
    presenceState = 'maybe';
  }

  return {
    index,
    xMin: xBounds.startMin,
    xMax: xBounds.startMax,
    yMin: yBounds.startMin,
    yMax: yBounds.startMax,
    xSizeMin: xBounds.sizeMin,
    xSizeMax: xBounds.sizeMax,
    ySizeMin: yBounds.sizeMin,
    ySizeMax: yBounds.sizeMax,
    presenceState,
    xBounds,
    yBounds,
  };
}

// ============================================================================
// Pairwise Restriction Discovery
// ============================================================================

/**
 * For each pair of rectangles, determine which directional separations are possible.
 *
 * Returns a 4-bit state per pair:
 * - Bit 0: rect1 can be left of rect2 (x_end1 <= x_start2)
 * - Bit 1: rect1 can be right of rect2 (x_end2 <= x_start1)
 * - Bit 2: rect1 can be below rect2 (y_end1 <= y_start2)
 * - Bit 3: rect1 can be above rect2 (y_end2 <= y_start1)
 *
 * If state == 0, the pair is infeasible (no separation possible).
 * If exactly one bit is set, the separation is forced.
 */
function computePairwiseRestrictions(
  rect1: RectangleBounds,
  rect2: RectangleBounds
): number {
  let state = 0;

  // Can rect1 be left of rect2? (x_end1 <= x_start2)
  // Minimum possible x_end1 = xMin1 + xSizeMin1
  // Maximum possible x_start2 = xMax2
  if (rect1.xMin + rect1.xSizeMin <= rect2.xMax) {
    state |= 1;
  }

  // Can rect1 be right of rect2? (x_end2 <= x_start1)
  if (rect2.xMin + rect2.xSizeMin <= rect1.xMax) {
    state |= 2;
  }

  // Can rect1 be below rect2? (y_end1 <= y_start2)
  if (rect1.yMin + rect1.ySizeMin <= rect2.yMax) {
    state |= 4;
  }

  // Can rect1 be above rect2? (y_end2 <= y_start1)
  if (rect2.yMin + rect2.ySizeMin <= rect1.yMax) {
    state |= 8;
  }

  return state;
}

// ============================================================================
// Energy-Based Conflict Detection
// ============================================================================

/**
 * Check if a set of rectangles can fit within a bounding box without overlapping.
 *
 * For any bounding box region R:
 *   sum(min_intersection_area(rect_i, R)) <= Area(R)
 *
 * If this is violated, the rectangles cannot all fit in R without overlapping.
 */
function checkEnergyConflict(
  rects: RectangleBounds[],
  boxXMin: number,
  boxXMax: number,
  boxYMin: number,
  boxYMax: number
): boolean {
  const boxArea = (boxXMax - boxXMin) * (boxYMax - boxYMin);
  if (boxArea <= 0) return false;

  let totalMinArea = 0;

  for (const rect of rects) {
    if (rect.presenceState === 'absent') continue;

    // Compute minimum intersection area with the bounding box
    // The rectangle can move within [xMin, xMax] x [yMin, yMax]
    // Minimum intersection = max(0, min(width) - max(gap)) * max(0, min(height) - max(gap))

    // X dimension
    const xOverlapMin = Math.max(0,
      Math.min(rect.xSizeMin, boxXMax - rect.xMin) -
      Math.max(0, rect.xMax + rect.xSizeMin - boxXMax)
    );

    // Y dimension
    const yOverlapMin = Math.max(0,
      Math.min(rect.ySizeMin, boxYMax - rect.yMin) -
      Math.max(0, rect.yMax + rect.ySizeMin - boxYMax)
    );

    totalMinArea += xOverlapMin * yOverlapMin;
  }

  return totalMinArea > boxArea;
}

// ============================================================================
// Connected Component Decomposition
// ============================================================================

/**
 * Build overlap graph and find connected components.
 * Two rectangles are connected if their bounding boxes overlap.
 */
function findConnectedComponents(
  rects: RectangleBounds[]
): RectangleBounds[][] {
  const n = rects.length;
  const visited = new Set<number>();
  const components: RectangleBounds[][] = [];

  // Build adjacency: two rects are adjacent if their bounding boxes overlap
  const adj = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    adj.set(i, []);
  }

  for (let i = 0; i < n; i++) {
    if (rects[i].presenceState === 'absent') continue;
    for (let j = i + 1; j < n; j++) {
      if (rects[j].presenceState === 'absent') continue;

      // Check if bounding boxes overlap
      const xOverlap = rects[i].xMin < rects[j].xMax && rects[j].xMin < rects[i].xMax;
      const yOverlap = rects[i].yMin < rects[j].yMax && rects[j].yMin < rects[i].yMax;

      if (xOverlap && yOverlap) {
        adj.get(i)!.push(j);
        adj.get(j)!.push(i);
      }
    }
  }

  // DFS to find connected components
  for (let i = 0; i < n; i++) {
    if (visited.has(i) || rects[i].presenceState === 'absent') continue;

    const component: RectangleBounds[] = [];
    const stack = [i];

    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined || visited.has(node)) continue;
      visited.add(node);
      component.push(rects[node]);

      const neighbors = adj.get(node);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            stack.push(neighbor);
          }
        }
      }
    }

    if (component.length > 0) {
      components.push(component);
    }
  }

  return components;
}

// ============================================================================
// Main Propagation
// ============================================================================

/**
 * Propagate NoOverlap2D constraint.
 *
 * Two rectangles don't overlap if they are separated in X or Y.
 * For each pair (i, j), at least one of these must hold:
 * - x_end[i] <= x_start[j] (i left of j)
 * - x_end[j] <= x_start[i] (j left of i)
 * - y_end[i] <= y_start[j] (i below j)
 * - y_end[j] <= y_start[i] (j below i)
 */
export function propagateNoOverlap2D(
  ct: NoOverlap2DConstraint,
  domains: Map<number, Domain>,
  propagateLinear: LinearPropagateFn
): PropagationResult {
  const n = ct.xIntervals.length;
  if (n <= 1) return 'CONSISTENT';

  // Compute rectangle bounds
  const rects: RectangleBounds[] = [];
  for (let i = 0; i < n; i++) {
    const bounds = computeRectangleBounds(ct, i, domains);
    if (!bounds) return 'CONSISTENT';
    rects.push(bounds);
  }

  let changed = false;

  // Filter to present/active rectangles
  const activeRects = rects.filter(r => r.presenceState !== 'absent');
  if (activeRects.length <= 1) return 'CONSISTENT';

  // Phase 1: Pairwise restriction discovery
  for (let i = 0; i < activeRects.length; i++) {
    for (let j = i + 1; j < activeRects.length; j++) {
      const r1 = activeRects[i];
      const r2 = activeRects[j];

      const state = computePairwiseRestrictions(r1, r2);

      if (state === 0) {
        // No separation possible → INFEASIBLE
        return 'INFEASIBLE';
      }

      // If exactly one direction is possible, we can propagate
      // For now, we check if we can tighten bounds based on forced separations

      // Forced: r1 left of r2 (x_end1 <= x_start2)
      if (state === 1) {
        try {
          // r2.start >= r1.endMin
          if (tightenStartMin(r2.xBounds, r1.xBounds.endMin, domains, propagateLinear)) {
            changed = true;
          }
          // r1.end <= r2.startMax
          if (tightenEndMax(r1.xBounds, r2.xBounds.startMax, domains, propagateLinear)) {
            changed = true;
          }
        } catch {
          return 'INFEASIBLE';
        }
      }

      // Forced: r1 right of r2 (x_end2 <= x_start1)
      if (state === 2) {
        try {
          if (tightenStartMin(r1.xBounds, r2.xBounds.endMin, domains, propagateLinear)) {
            changed = true;
          }
          if (tightenEndMax(r2.xBounds, r1.xBounds.startMax, domains, propagateLinear)) {
            changed = true;
          }
        } catch {
          return 'INFEASIBLE';
        }
      }

      // Forced: r1 below r2 (y_end1 <= y_start2)
      if (state === 4) {
        try {
          if (tightenStartMin(r2.yBounds, r1.yBounds.endMin, domains, propagateLinear)) {
            changed = true;
          }
          if (tightenEndMax(r1.yBounds, r2.yBounds.startMax, domains, propagateLinear)) {
            changed = true;
          }
        } catch {
          return 'INFEASIBLE';
        }
      }

      // Forced: r1 above r2 (y_end2 <= y_start1)
      if (state === 8) {
        try {
          if (tightenStartMin(r1.yBounds, r2.yBounds.endMin, domains, propagateLinear)) {
            changed = true;
          }
          if (tightenEndMax(r2.yBounds, r1.yBounds.startMax, domains, propagateLinear)) {
            changed = true;
          }
        } catch {
          return 'INFEASIBLE';
        }
      }
    }
  }

  // Phase 2: Energy-based conflict detection
  // For each connected component, check if the total area exceeds the bounding box
  const components = findConnectedComponents(activeRects);

  for (const component of components) {
    if (component.length <= 1) continue;

    // Compute bounding box of the component
    const boxXMin = Math.min(...component.map(r => r.xMin));
    const boxXMax = Math.max(...component.map(r => r.xMax + r.xSizeMax));
    const boxYMin = Math.min(...component.map(r => r.yMin));
    const boxYMax = Math.max(...component.map(r => r.yMax + r.ySizeMax));

    if (checkEnergyConflict(component, boxXMin, boxXMax, boxYMin, boxYMax)) {
      return 'INFEASIBLE';
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

// ============================================================================
// Solution Checker
// ============================================================================

/**
 * Check if the solution satisfies NoOverlap2D.
 * All variables must be fixed (domain size === 1).
 */
export function checkNoOverlap2D(
  ct: NoOverlap2DConstraint,
  domains: Map<number, Domain>
): boolean {
  const n = ct.xIntervals.length;

  interface Rect {
    xStart: number;
    xEnd: number;
    yStart: number;
    yEnd: number;
  }

  const rects: Rect[] = [];
  for (let i = 0; i < n; i++) {
    // Check presence
    const xIv = ct.xIntervals[i];
    if (xIv.isPresent) {
      const d = domains.get(xIv.isPresent.index);
      if (d && d.size === 1 && d.min === 0) continue; // absent
    }

    // Get x bounds
    const xStartExpr = xIv.start;
    let xStartVal = xStartExpr.offset;
    for (let j = 0; j < xStartExpr.vars.length; j++) {
      const vd = domains.get(xStartExpr.vars[j].index);
      if (!vd || vd.size !== 1) return false;
      xStartVal += xStartExpr.coeffs[j] * vd.min;
    }

    const xEndExpr = xIv.end;
    let xEndVal = xEndExpr.offset;
    for (let j = 0; j < xEndExpr.vars.length; j++) {
      const vd = domains.get(xEndExpr.vars[j].index);
      if (!vd || vd.size !== 1) return false;
      xEndVal += xEndExpr.coeffs[j] * vd.min;
    }

    // Get y bounds
    const yIv = ct.yIntervals[i];
    const yStartExpr = yIv.start;
    let yStartVal = yStartExpr.offset;
    for (let j = 0; j < yStartExpr.vars.length; j++) {
      const vd = domains.get(yStartExpr.vars[j].index);
      if (!vd || vd.size !== 1) return false;
      yStartVal += yStartExpr.coeffs[j] * vd.min;
    }

    const yEndExpr = yIv.end;
    let yEndVal = yEndExpr.offset;
    for (let j = 0; j < yEndExpr.vars.length; j++) {
      const vd = domains.get(yEndExpr.vars[j].index);
      if (!vd || vd.size !== 1) return false;
      yEndVal += yEndExpr.coeffs[j] * vd.min;
    }

    rects.push({ xStart: xStartVal, xEnd: xEndVal, yStart: yStartVal, yEnd: yEndVal });
  }

  // Check all pairs for overlap
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const r1 = rects[i];
      const r2 = rects[j];

      // Overlap if both X and Y overlap
      const xOverlap = r1.xStart < r2.xEnd && r2.xStart < r1.xEnd;
      const yOverlap = r1.yStart < r2.yEnd && r2.yStart < r1.yEnd;

      if (xOverlap && yOverlap) {
        return false; // overlap detected
      }
    }
  }

  return true;
}
