/**
 * NoOverlap2D Propagation — Test Suite
 *
 * Tests for 2D rectangle non-overlap constraint propagation covering:
 * - Positive cases (feasible problems that should solve correctly)
 * - Negative cases (infeasible problems detected by propagation)
 * - Edge cases (boundary conditions, optional rectangles)
 * - Performance cases (verify propagation reduces search tree)
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';

// ============================================================================
// Test Helpers
// ============================================================================

function solveAndCheck(
  model: CpModel,
  maxTime = 5
): { status: CpSolverStatus; solver: CpSolver } {
  const solver = new CpSolver();
  solver.parameters.maxTimeInSeconds = maxTime;
  const status = solver.solve(model);
  return { status, solver };
}

/**
 * Verify that no two rectangles overlap in the solution
 */
function verifyNoOverlap2D(
  solver: CpSolver,
  xStarts: { index: number }[],
  xSizes: number[],
  yStarts: { index: number }[],
  ySizes: number[]
): boolean {
  for (let i = 0; i < xStarts.length; i++) {
    for (let j = i + 1; j < xStarts.length; j++) {
      const xi = solver.value(xStarts[i] as any);
      const xj = solver.value(xStarts[j] as any);
      const yi = solver.value(yStarts[i] as any);
      const yj = solver.value(yStarts[j] as any);

      const xOverlap = xi < xj + xSizes[j] && xj < xi + xSizes[i];
      const yOverlap = yi < yj + ySizes[j] && yj < yi + ySizes[i];

      if (xOverlap && yOverlap) {
        return false; // overlap detected
      }
    }
  }
  return true;
}

// ============================================================================
// NoOverlap2D — Positive Cases (Feasible)
// ============================================================================

describe('NoOverlap2D Propagation', () => {
  describe('positive cases (feasible)', () => {
    it('should place 2 non-overlapping rectangles', () => {
      const model = new CpModel();

      // Rectangle 1: 2x2 at variable position
      const x1 = model.newIntVar(0, 5, 'x1');
      const y1 = model.newIntVar(0, 5, 'y1');
      const w1 = 2;
      const h1 = 2;

      // Rectangle 2: 2x2 at variable position
      const x2 = model.newIntVar(0, 5, 'x2');
      const y2 = model.newIntVar(0, 5, 'y2');
      const w2 = 2;
      const h2 = 2;

      const xIv1 = model.newFixedSizeIntervalVar(x1, w1, 'xIv1');
      const yIv1 = model.newFixedSizeIntervalVar(y1, h1, 'yIv1');
      const xIv2 = model.newFixedSizeIntervalVar(x2, w2, 'xIv2');
      const yIv2 = model.newFixedSizeIntervalVar(y2, h2, 'yIv2');

      model.addNoOverlap2D([xIv1, xIv2], [yIv1, yIv2]);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Verify no overlap
      expect(verifyNoOverlap2D(
        solver,
        [x1, x2], [w1, w2],
        [y1, y2], [h1, h2]
      )).toBe(true);
    });

    it('should place 3 non-overlapping rectangles', () => {
      const model = new CpModel();

      const rects = [];
      for (let i = 0; i < 3; i++) {
        const x = model.newIntVar(0, 6, `x${i}`);
        const y = model.newIntVar(0, 6, `y${i}`);
        rects.push({ x, y, w: 2, h: 2 });
      }

      const xIntervals = rects.map((r, i) =>
        model.newFixedSizeIntervalVar(r.x, r.w, `xIv${i}`)
      );
      const yIntervals = rects.map((r, i) =>
        model.newFixedSizeIntervalVar(r.y, r.h, `yIv${i}`)
      );

      model.addNoOverlap2D(xIntervals, yIntervals);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Verify no overlap
      expect(verifyNoOverlap2D(
        solver,
        rects.map(r => r.x), rects.map(r => r.w),
        rects.map(r => r.y), rects.map(r => r.h)
      )).toBe(true);
    });

    it('should place rectangles of different sizes', () => {
      const model = new CpModel();

      // Rectangle 1: 3x1
      const x1 = model.newIntVar(0, 5, 'x1');
      const y1 = model.newIntVar(0, 5, 'y1');
      const xIv1 = model.newFixedSizeIntervalVar(x1, 3, 'xIv1');
      const yIv1 = model.newFixedSizeIntervalVar(y1, 1, 'yIv1');

      // Rectangle 2: 1x3
      const x2 = model.newIntVar(0, 5, 'x2');
      const y2 = model.newIntVar(0, 5, 'y2');
      const xIv2 = model.newFixedSizeIntervalVar(x2, 1, 'xIv2');
      const yIv2 = model.newFixedSizeIntervalVar(y2, 3, 'yIv2');

      model.addNoOverlap2D([xIv1, xIv2], [yIv1, yIv2]);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      expect(verifyNoOverlap2D(
        solver,
        [x1, x2], [3, 1],
        [y1, y2], [1, 3]
      )).toBe(true);
    });
  });

  // ============================================================================
  // NoOverlap2D — Negative Cases (Infeasible)
  // ============================================================================

  describe('negative cases (infeasible)', () => {
    it('should detect infeasible 2D overlap with forced positions', () => {
      const model = new CpModel();

      // Both rectangles at (0,0) with size 2x2
      const x1 = model.newIntVar(0, 0, 'x1');
      const y1 = model.newIntVar(0, 0, 'y1');
      const x2 = model.newIntVar(0, 0, 'x2');
      const y2 = model.newIntVar(0, 0, 'y2');

      const xIv1 = model.newFixedSizeIntervalVar(x1, 2, 'xIv1');
      const yIv1 = model.newFixedSizeIntervalVar(y1, 2, 'yIv1');
      const xIv2 = model.newFixedSizeIntervalVar(x2, 2, 'xIv2');
      const yIv2 = model.newFixedSizeIntervalVar(y2, 2, 'yIv2');

      model.addNoOverlap2D([xIv1, xIv2], [yIv1, yIv2]);

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });

    it('should detect infeasible 2D overlap with small domain', () => {
      const model = new CpModel();

      // Two 3x3 rectangles in a 4x4 space
      const x1 = model.newIntVar(0, 1, 'x1');
      const y1 = model.newIntVar(0, 1, 'y1');
      const x2 = model.newIntVar(0, 1, 'x2');
      const y2 = model.newIntVar(0, 1, 'y2');

      const xIv1 = model.newFixedSizeIntervalVar(x1, 3, 'xIv1');
      const yIv1 = model.newFixedSizeIntervalVar(y1, 3, 'yIv1');
      const xIv2 = model.newFixedSizeIntervalVar(x2, 3, 'xIv2');
      const yIv2 = model.newFixedSizeIntervalVar(y2, 3, 'yIv2');

      model.addNoOverlap2D([xIv1, xIv2], [yIv1, yIv2]);

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });
  });

  // ============================================================================
  // NoOverlap2D — Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('should handle single rectangle', () => {
      const model = new CpModel();

      const x1 = model.newIntVar(0, 5, 'x1');
      const y1 = model.newIntVar(0, 5, 'y1');
      const xIv1 = model.newFixedSizeIntervalVar(x1, 2, 'xIv1');
      const yIv1 = model.newFixedSizeIntervalVar(y1, 2, 'yIv1');

      model.addNoOverlap2D([xIv1], [yIv1]);

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });

    it('should handle zero-size rectangles', () => {
      const model = new CpModel();

      const x1 = model.newIntVar(0, 5, 'x1');
      const y1 = model.newIntVar(0, 5, 'y1');
      const x2 = model.newIntVar(0, 5, 'x2');
      const y2 = model.newIntVar(0, 5, 'y2');

      const xIv1 = model.newFixedSizeIntervalVar(x1, 0, 'xIv1');
      const yIv1 = model.newFixedSizeIntervalVar(y1, 0, 'yIv1');
      const xIv2 = model.newFixedSizeIntervalVar(x2, 0, 'xIv2');
      const yIv2 = model.newFixedSizeIntervalVar(y2, 0, 'yIv2');

      model.addNoOverlap2D([xIv1, xIv2], [yIv1, yIv2]);

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });
  });

  // ============================================================================
  // NoOverlap2D — Performance
  // ============================================================================

  describe('performance', () => {
    it('should place 4 rectangles efficiently', () => {
      const model = new CpModel();

      const rects = [];
      for (let i = 0; i < 4; i++) {
        const x = model.newIntVar(0, 6, `x${i}`);
        const y = model.newIntVar(0, 6, `y${i}`);
        rects.push({ x, y, w: 2, h: 2 });
      }

      const xIntervals = rects.map((r, i) =>
        model.newFixedSizeIntervalVar(r.x, r.w, `xIv${i}`)
      );
      const yIntervals = rects.map((r, i) =>
        model.newFixedSizeIntervalVar(r.y, r.h, `yIv${i}`)
      );

      model.addNoOverlap2D(xIntervals, yIntervals);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.numBranches).toBeLessThan(100);
    });

    it('should place 6 rectangles efficiently', () => {
      const model = new CpModel();

      const rects = [];
      for (let i = 0; i < 6; i++) {
        const x = model.newIntVar(0, 8, `x${i}`);
        const y = model.newIntVar(0, 8, `y${i}`);
        rects.push({ x, y, w: 2, h: 2 });
      }

      const xIntervals = rects.map((r, i) =>
        model.newFixedSizeIntervalVar(r.x, r.w, `xIv${i}`)
      );
      const yIntervals = rects.map((r, i) =>
        model.newFixedSizeIntervalVar(r.y, r.h, `yIv${i}`)
      );

      model.addNoOverlap2D(xIntervals, yIntervals);

      const { status, solver } = solveAndCheck(model, 30);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.numBranches).toBeLessThan(10000);
    });
  });

  // ============================================================================
  // NoOverlap2D — Solution Verification
  // ============================================================================

  describe('solution verification', () => {
    it('should verify rectangles fit within container', () => {
      const model = new CpModel();

      const containerWidth = 6;
      const containerHeight = 6;
      const rects = [
        { w: 2, h: 3 },
        { w: 3, h: 2 },
        { w: 2, h: 2 },
      ];

      const xVars = [];
      const yVars = [];
      const xIntervals = [];
      const yIntervals = [];

      for (let i = 0; i < rects.length; i++) {
        const x = model.newIntVar(0, containerWidth - rects[i].w, `x${i}`);
        const y = model.newIntVar(0, containerHeight - rects[i].h, `y${i}`);
        xVars.push(x);
        yVars.push(y);
        xIntervals.push(model.newFixedSizeIntervalVar(x, rects[i].w, `xIv${i}`));
        yIntervals.push(model.newFixedSizeIntervalVar(y, rects[i].h, `yIv${i}`));
      }

      model.addNoOverlap2D(xIntervals, yIntervals);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Verify each rectangle is within the container
      for (let i = 0; i < rects.length; i++) {
        const x = solver.value(xVars[i]);
        const y = solver.value(yVars[i]);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x + rects[i].w).toBeLessThanOrEqual(containerWidth);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y + rects[i].h).toBeLessThanOrEqual(containerHeight);
      }

      // Verify no overlap
      expect(verifyNoOverlap2D(
        solver,
        xVars, rects.map(r => r.w),
        yVars, rects.map(r => r.h)
      )).toBe(true);
    });

    it('should verify task assignment pattern', () => {
      const model = new CpModel();

      // 4 tasks, 2 machines, time horizon 8
      const numTasks = 4;
      const numMachines = 2;
      const timeHorizon = 8;
      const duration = 2;

      const timeVars = [];
      const machineVars = [];
      const timeIntervals = [];
      const machineIntervals = [];

      for (let i = 0; i < numTasks; i++) {
        const t = model.newIntVar(0, timeHorizon - duration, `time${i}`);
        const m = model.newIntVar(0, numMachines - 1, `machine${i}`);
        timeVars.push(t);
        machineVars.push(m);
        timeIntervals.push(model.newFixedSizeIntervalVar(t, duration, `tIv${i}`));
        machineIntervals.push(model.newFixedSizeIntervalVar(m, 1, `mIv${i}`));
      }

      model.addNoOverlap2D(timeIntervals, machineIntervals);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Verify each task is assigned to a valid machine
      for (let i = 0; i < numTasks; i++) {
        const m = solver.value(machineVars[i]);
        expect(m).toBeGreaterThanOrEqual(0);
        expect(m).toBeLessThan(numMachines);
      }

      // Verify no two tasks overlap on the same machine
      for (let i = 0; i < numTasks; i++) {
        for (let j = i + 1; j < numTasks; j++) {
          const mi = solver.value(machineVars[i]);
          const mj = solver.value(machineVars[j]);
          const ti = solver.value(timeVars[i]);
          const tj = solver.value(timeVars[j]);

          if (mi === mj) {
            // Same machine - must not overlap in time
            expect(ti + duration <= tj || tj + duration <= ti).toBe(true);
          }
        }
      }
    });
  });

  // ============================================================================
  // NoOverlap2D — Additional Negative Cases
  // ============================================================================

  describe('additional negative cases', () => {
    it('should detect infeasible packing with 3 rectangles', () => {
      const model = new CpModel();

      // Three 2x2 rectangles forced to (0,0)
      const x1 = model.newIntVar(0, 0, 'x1');
      const y1 = model.newIntVar(0, 0, 'y1');
      const x2 = model.newIntVar(0, 0, 'x2');
      const y2 = model.newIntVar(0, 0, 'y2');
      const x3 = model.newIntVar(0, 0, 'x3');
      const y3 = model.newIntVar(0, 0, 'y3');

      const xIv1 = model.newFixedSizeIntervalVar(x1, 2, 'xIv1');
      const yIv1 = model.newFixedSizeIntervalVar(y1, 2, 'yIv1');
      const xIv2 = model.newFixedSizeIntervalVar(x2, 2, 'xIv2');
      const yIv2 = model.newFixedSizeIntervalVar(y2, 2, 'yIv2');
      const xIv3 = model.newFixedSizeIntervalVar(x3, 2, 'xIv3');
      const yIv3 = model.newFixedSizeIntervalVar(y3, 2, 'yIv3');

      model.addNoOverlap2D([xIv1, xIv2, xIv3], [yIv1, yIv2, yIv3]);

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });

    it('should detect infeasible packing with tight container', () => {
      const model = new CpModel();

      // Two 3x3 rectangles in a 4x5 container
      const x1 = model.newIntVar(0, 1, 'x1');
      const y1 = model.newIntVar(0, 2, 'y1');
      const x2 = model.newIntVar(0, 1, 'x2');
      const y2 = model.newIntVar(0, 2, 'y2');

      const xIv1 = model.newFixedSizeIntervalVar(x1, 3, 'xIv1');
      const yIv1 = model.newFixedSizeIntervalVar(y1, 3, 'yIv1');
      const xIv2 = model.newFixedSizeIntervalVar(x2, 3, 'xIv2');
      const yIv2 = model.newFixedSizeIntervalVar(y2, 3, 'yIv2');

      model.addNoOverlap2D([xIv1, xIv2], [yIv1, yIv2]);

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });
  });

  // ============================================================================
  // NoOverlap2D — Additional Edge Cases
  // ============================================================================

  describe('additional edge cases', () => {
    it('should handle rectangles with different aspect ratios', () => {
      const model = new CpModel();

      // Wide rectangle: 4x1
      const x1 = model.newIntVar(0, 5, 'x1');
      const y1 = model.newIntVar(0, 5, 'y1');
      const xIv1 = model.newFixedSizeIntervalVar(x1, 4, 'xIv1');
      const yIv1 = model.newFixedSizeIntervalVar(y1, 1, 'yIv1');

      // Tall rectangle: 1x4
      const x2 = model.newIntVar(0, 5, 'x2');
      const y2 = model.newIntVar(0, 5, 'y2');
      const xIv2 = model.newFixedSizeIntervalVar(x2, 1, 'xIv2');
      const yIv2 = model.newFixedSizeIntervalVar(y2, 4, 'yIv2');

      // Square: 2x2
      const x3 = model.newIntVar(0, 5, 'x3');
      const y3 = model.newIntVar(0, 5, 'y3');
      const xIv3 = model.newFixedSizeIntervalVar(x3, 2, 'xIv3');
      const yIv3 = model.newFixedSizeIntervalVar(y3, 2, 'yIv3');

      model.addNoOverlap2D([xIv1, xIv2, xIv3], [yIv1, yIv2, yIv3]);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      expect(verifyNoOverlap2D(
        solver,
        [x1, x2, x3], [4, 1, 2],
        [y1, y2, y3], [1, 4, 2]
      )).toBe(true);
    });

    it('should handle rectangles with 1x1 size', () => {
      const model = new CpModel();

      const rects = [];
      for (let i = 0; i < 4; i++) {
        const x = model.newIntVar(0, 3, `x${i}`);
        const y = model.newIntVar(0, 3, `y${i}`);
        rects.push({ x, y, w: 1, h: 1 });
      }

      const xIntervals = rects.map((r, i) =>
        model.newFixedSizeIntervalVar(r.x, r.w, `xIv${i}`)
      );
      const yIntervals = rects.map((r, i) =>
        model.newFixedSizeIntervalVar(r.y, r.h, `yIv${i}`)
      );

      model.addNoOverlap2D(xIntervals, yIntervals);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      expect(verifyNoOverlap2D(
        solver,
        rects.map(r => r.x), rects.map(r => r.w),
        rects.map(r => r.y), rects.map(r => r.h)
      )).toBe(true);
    });

    it('should handle many small rectangles', () => {
      const model = new CpModel();

      const rects = [];
      for (let i = 0; i < 8; i++) {
        const x = model.newIntVar(0, 10, `x${i}`);
        const y = model.newIntVar(0, 10, `y${i}`);
        rects.push({ x, y, w: 2, h: 2 });
      }

      const xIntervals = rects.map((r, i) =>
        model.newFixedSizeIntervalVar(r.x, r.w, `xIv${i}`)
      );
      const yIntervals = rects.map((r, i) =>
        model.newFixedSizeIntervalVar(r.y, r.h, `yIv${i}`)
      );

      model.addNoOverlap2D(xIntervals, yIntervals);

      const { status, solver } = solveAndCheck(model, 30);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      expect(verifyNoOverlap2D(
        solver,
        rects.map(r => r.x), rects.map(r => r.w),
        rects.map(r => r.y), rects.map(r => r.h)
      )).toBe(true);
    });
  });

  // ============================================================================
  // TightenEndMax Verification
  // ============================================================================

  describe('tightenEndMax propagation', () => {
    it('should solve tight packing with bidirectional pruning', () => {
      const model = new CpModel();

      // Two 3x2 rectangles that must be side-by-side
      // X range [0,6], Y range [0,4] — enough for two side-by-side
      const xv1 = model.newFixedSizeIntervalVar(0, 3, 3, 'xv1');
      const xv2 = model.newFixedSizeIntervalVar(3, 3, 3, 'xv2');
      const yv1 = model.newFixedSizeIntervalVar(0, 2, 2, 'yv1');
      const yv2 = model.newFixedSizeIntervalVar(0, 2, 2, 'yv2');

      model.addNoOverlap2D([xv1, xv2], [yv1, yv2]);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Verify no overlap
      const x1Val = solver.value(xv1.start);
      const x2Val = solver.value(xv2.start);
      const y1Val = solver.value(yv1.start);
      const y2Val = solver.value(yv2.start);

      const xSeparated = x1Val + 3 <= x2Val || x2Val + 3 <= x1Val;
      const ySeparated = y1Val + 2 <= y2Val || y2Val + 2 <= y1Val;
      expect(xSeparated || ySeparated).toBe(true);
    });
  });
});
