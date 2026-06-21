/**
 * Reservoir Propagation — Test Suite
 *
 * Tests for reservoir constraint propagation covering:
 * - Positive cases (feasible problems that should solve correctly)
 * - Negative cases (infeasible problems detected by propagation)
 * - Edge cases (boundary conditions, active literals)
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

// ============================================================================
// Reservoir — Positive Cases (Feasible)
// ============================================================================

describe('Reservoir Propagation', () => {
  describe('positive cases (feasible)', () => {
    it('should schedule events that maintain level within bounds', () => {
      const model = new CpModel();

      // Two events: +3 at time 0-2, -2 at time 1-3
      // Level must stay in [0, 10]
      const t1 = model.newIntVar(0, 2, 't1');
      const t2 = model.newIntVar(1, 3, 't2');

      model.addReservoirConstraint(
        [t1, t2],
        [3, -2],
        0,
        10
      );

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Verify level stays in bounds
      const t1Val = solver.value(t1);
      const t2Val = solver.value(t2);

      // At each time point, level should be in [0, 10]
      let level = 0;
      const events = [
        { time: t1Val, delta: 3 },
        { time: t2Val, delta: -2 },
      ].sort((a, b) => a.time - b.time);

      for (const event of events) {
        level += event.delta;
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(10);
      }
    });

    it('should schedule events with fixed times', () => {
      const model = new CpModel();

      // Fixed events: +5 at time 0, -3 at time 2
      const t1 = model.newIntVar(0, 0, 't1');
      const t2 = model.newIntVar(2, 2, 't2');

      model.addReservoirConstraint(
        [t1, t2],
        [5, -3],
        0,
        10
      );

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });

    it('should schedule multiple events with varying times', () => {
      const model = new CpModel();

      // 4 events with different deltas
      const t1 = model.newIntVar(0, 3, 't1');
      const t2 = model.newIntVar(0, 3, 't2');
      const t3 = model.newIntVar(0, 3, 't3');
      const t4 = model.newIntVar(0, 3, 't4');

      model.addReservoirConstraint(
        [t1, t2, t3, t4],
        [5, -3, 4, -6],
        0,
        10
      );

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Verify solution
      const t1Val = solver.value(t1);
      const t2Val = solver.value(t2);
      const t3Val = solver.value(t3);
      const t4Val = solver.value(t4);

      const events = [
        { time: t1Val, delta: 5 },
        { time: t2Val, delta: -3 },
        { time: t3Val, delta: 4 },
        { time: t4Val, delta: -6 },
      ].sort((a, b) => a.time - b.time);

      let level = 0;
      for (const event of events) {
        level += event.delta;
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(10);
      }
    });
  });

  // ============================================================================
  // Reservoir — Negative Cases (Infeasible)
  // ============================================================================

  describe('negative cases (infeasible)', () => {
    it('should detect infeasible reservoir with events at same time', () => {
      const model = new CpModel();

      // Both events at time 0: +5 and -3
      // If both at time 0, level goes 0 -> 5 -> 2 (ok)
      // But if we force both at time 0 with larger deltas...
      const t1 = model.newIntVar(0, 0, 't1');
      const t2 = model.newIntVar(0, 0, 't2');

      model.addReservoirConstraint(
        [t1, t2],
        [5, -8],
        0,
        10
      );

      const { status } = solveAndCheck(model);
      // Level would go 0 -> 5 -> -3 which violates minLevel=0
      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });

    it('should detect infeasible reservoir with too large positive delta', () => {
      const model = new CpModel();

      // Single event with delta > maxLevel
      const t1 = model.newIntVar(0, 0, 't1');

      model.addReservoirConstraint(
        [t1],
        [15],
        0,
        10
      );

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });

    it('should detect infeasible reservoir with too large negative delta', () => {
      const model = new CpModel();

      // Single event with delta < minLevel
      const t1 = model.newIntVar(0, 0, 't1');

      model.addReservoirConstraint(
        [t1],
        [-5],
        0,
        10
      );

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });
  });

  // ============================================================================
  // Reservoir — Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('should handle empty reservoir constraint', () => {
      const model = new CpModel();

      // No events - always feasible
      model.addReservoirConstraint([], [], 0, 10);

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });

    it('should handle reservoir with single event', () => {
      const model = new CpModel();

      const t1 = model.newIntVar(0, 0, 't1');
      model.addReservoirConstraint([t1], [5], 0, 10);

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });

    it('should handle reservoir with zero delta', () => {
      const model = new CpModel();

      const t1 = model.newIntVar(0, 5, 't1');
      model.addReservoirConstraint([t1], [0], 0, 10);

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });
  });

  // ============================================================================
  // Reservoir with Active Literals
  // ============================================================================

  describe('with active literals', () => {
    it('should schedule optional events with active literals', () => {
      const model = new CpModel();

      // Two optional events, only one can be active
      const t1 = model.newIntVar(0, 2, 't1');
      const t2 = model.newIntVar(0, 2, 't2');
      const a1 = model.newBoolVar('a1');
      const a2 = model.newBoolVar('a2');

      // Force at most one to be active
      model.addAtMostOne([a1, a2]);

      model.addReservoirConstraintWithActive(
        [t1, t2],
        [8, 8],
        [a1, a2],
        0,
        10
      );

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });

    it('should handle mixed active and inactive events', () => {
      const model = new CpModel();

      const t1 = model.newIntVar(0, 0, 't1');
      const t2 = model.newIntVar(1, 1, 't2');
      const a1 = model.newBoolVar('a1');
      const a2 = model.newBoolVar('a2');

      // Force a1 to be active, a2 to be inactive
      model.addBoolAnd([a1]);
      model.add(a2.le(0));

      model.addReservoirConstraintWithActive(
        [t1, t2],
        [5, -3],
        [a1, a2],
        0,
        10
      );

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });
  });

  // ============================================================================
  // Reservoir — Performance
  // ============================================================================

  describe('performance', () => {
    it('should solve 6-event reservoir efficiently', () => {
      const model = new CpModel();

      const times = [];
      const deltas = [];

      for (let i = 0; i < 6; i++) {
        times.push(model.newIntVar(0, 5, `t${i}`));
        deltas.push(i % 2 === 0 ? 3 : -2);
      }

      model.addReservoirConstraint(times, deltas, 0, 10);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.numBranches).toBeLessThan(50);
    });

    it('should solve 10-event reservoir efficiently', () => {
      const model = new CpModel();

      const times = [];
      const deltas = [];

      for (let i = 0; i < 10; i++) {
        times.push(model.newIntVar(0, 10, `t${i}`));
        deltas.push(i % 2 === 0 ? 3 : -2);
      }

      model.addReservoirConstraint(times, deltas, 0, 15);

      const { status, solver } = solveAndCheck(model, 30);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.numBranches).toBeLessThan(200);
    });
  });

  // ============================================================================
  // Reservoir — Solution Verification
  // ============================================================================

  describe('solution verification', () => {
    it('should verify level stays within bounds at all times', () => {
      const model = new CpModel();

      const t1 = model.newIntVar(0, 3, 't1');
      const t2 = model.newIntVar(0, 3, 't2');
      const t3 = model.newIntVar(0, 3, 't3');

      model.addReservoirConstraint(
        [t1, t2, t3],
        [5, -3, 4],
        0,
        10
      );

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Verify solution
      const events = [
        { time: solver.value(t1), delta: 5 },
        { time: solver.value(t2), delta: -3 },
        { time: solver.value(t3), delta: 4 },
      ].sort((a, b) => a.time - b.time);

      let level = 0;
      for (const event of events) {
        level += event.delta;
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(10);
      }
    });

    it('should verify inventory scheduling pattern', () => {
      const model = new CpModel();

      // Production and order events
      const tProd1 = model.newIntVar(0, 2, 'tProd1');
      const tProd2 = model.newIntVar(1, 3, 'tProd2');
      const tOrder1 = model.newIntVar(2, 4, 'tOrder1');
      const tOrder2 = model.newIntVar(3, 5, 'tOrder2');

      // Stock level must stay between 2 (safety stock) and 10 (capacity)
      model.addReservoirConstraint(
        [tProd1, tProd2, tOrder1, tOrder2],
        [5, 3, -4, -2],
        2,
        10
      );

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Verify stock level
      const events = [
        { time: solver.value(tProd1), delta: 5, name: 'Prod1' },
        { time: solver.value(tProd2), delta: 3, name: 'Prod2' },
        { time: solver.value(tOrder1), delta: -4, name: 'Order1' },
        { time: solver.value(tOrder2), delta: -2, name: 'Order2' },
      ].sort((a, b) => a.time - b.time);

      let level = 0;
      for (const event of events) {
        level += event.delta;
        expect(level).toBeGreaterThanOrEqual(2); // Safety stock
        expect(level).toBeLessThanOrEqual(10); // Capacity
      }
    });
  });

  // ============================================================================
  // Reservoir — Additional Negative Cases
  // ============================================================================

  describe('additional negative cases', () => {
    it('should detect infeasible reservoir with tight bounds', () => {
      const model = new CpModel();

      // Events that cannot fit in tight bounds
      const t1 = model.newIntVar(0, 0, 't1');
      const t2 = model.newIntVar(0, 0, 't2');
      const t3 = model.newIntVar(0, 0, 't3');

      model.addReservoirConstraint(
        [t1, t2, t3],
        [5, 5, 5],
        0,
        10
      );

      const { status } = solveAndCheck(model);
      // Total delta is 15, but maxLevel is 10
      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });

    it('should detect infeasible reservoir with negative overflow', () => {
      const model = new CpModel();

      const t1 = model.newIntVar(0, 0, 't1');
      const t2 = model.newIntVar(0, 0, 't2');

      model.addReservoirConstraint(
        [t1, t2],
        [-3, -5],
        0,
        10
      );

      const { status } = solveAndCheck(model);
      // Level would go 0 -> -3 -> -8 which violates minLevel=0
      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });
  });

  // ============================================================================
  // Reservoir — Additional Edge Cases
  // ============================================================================

  describe('additional edge cases', () => {
    it('should handle reservoir with equal min and max level', () => {
      const model = new CpModel();

      const t1 = model.newIntVar(0, 0, 't1');
      const t2 = model.newIntVar(1, 1, 't2');

      model.addReservoirConstraint(
        [t1, t2],
        [5, -5],
        0,
        10
      );

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });

    it('should handle reservoir with large time horizon', () => {
      const model = new CpModel();

      const t1 = model.newIntVar(0, 100, 't1');
      const t2 = model.newIntVar(0, 100, 't2');

      model.addReservoirConstraint(
        [t1, t2],
        [5, -3],
        0,
        10
      );

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });

    it('should handle reservoir with many events', () => {
      const model = new CpModel();

      const times = [];
      const deltas = [];

      for (let i = 0; i < 20; i++) {
        times.push(model.newIntVar(0, 20, `t${i}`));
        deltas.push(i % 2 === 0 ? 2 : -1);
      }

      model.addReservoirConstraint(times, deltas, 0, 15);

      const { status, solver } = solveAndCheck(model, 30);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });
  });

  // ============================================================================
  // Reservoir with Active Literals — Additional Tests
  // ============================================================================

  describe('active literals — additional tests', () => {
    it('should handle all events inactive', () => {
      const model = new CpModel();

      const t1 = model.newIntVar(0, 2, 't1');
      const t2 = model.newIntVar(0, 2, 't2');
      const a1 = model.newBoolVar('a1');
      const a2 = model.newBoolVar('a2');

      // Force both to be inactive
      model.add(a1.le(0));
      model.add(a2.le(0));

      model.addReservoirConstraintWithActive(
        [t1, t2],
        [8, 8],
        [a1, a2],
        0,
        10
      );

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });

    it('should handle all events active', () => {
      const model = new CpModel();

      const t1 = model.newIntVar(0, 2, 't1');
      const t2 = model.newIntVar(2, 4, 't2');
      const a1 = model.newBoolVar('a1');
      const a2 = model.newBoolVar('a2');

      // Force both to be active
      model.addBoolAnd([a1]);
      model.addBoolAnd([a2]);

      model.addReservoirConstraintWithActive(
        [t1, t2],
        [5, -3],
        [a1, a2],
        0,
        10
      );

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });

    it('should handle mixed active/inactive with constraints', () => {
      const model = new CpModel();

      const t1 = model.newIntVar(0, 2, 't1');
      const t2 = model.newIntVar(0, 2, 't2');
      const t3 = model.newIntVar(2, 4, 't3');
      const a1 = model.newBoolVar('a1');
      const a2 = model.newBoolVar('a2');
      const a3 = model.newBoolVar('a3');

      // Exactly one of a1, a2 must be active
      model.addExactlyOne([a1, a2]);
      // a3 is always active
      model.addBoolAnd([a3]);

      model.addReservoirConstraintWithActive(
        [t1, t2, t3],
        [8, 8, -5],
        [a1, a2, a3],
        0,
        10
      );

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });
  });

  // ============================================================================
  // Reservoir — Time Tightening Verification
  // ============================================================================

  describe('time tightening', () => {
    it('should solve events with overlapping time windows and tight capacity', () => {
      const model = new CpModel();

      // Events with different time ranges that force specific ordering
      // Positive events can happen early, negative events can happen late
      // Tight capacity forces interleaving
      const t1 = model.newIntVar(0, 3, 't1'); // +5, early
      const t2 = model.newIntVar(0, 3, 't2'); // +5, early
      const t3 = model.newIntVar(2, 5, 't3'); // -4, late
      const t4 = model.newIntVar(2, 5, 't4'); // -4, late

      model.addReservoirConstraint(
        [t1, t2, t3, t4],
        [5, 5, -4, -4],
        0,
        8
      );

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Verify solution is valid
      const events = [
        { time: solver.value(t1), delta: 5 },
        { time: solver.value(t2), delta: 5 },
        { time: solver.value(t3), delta: -4 },
        { time: solver.value(t4), delta: -4 },
      ].sort((a, b) => a.time - b.time);

      let level = 0;
      for (const event of events) {
        level += event.delta;
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(8);
      }
    });

    it('should handle tight level bounds with mixed deltas', () => {
      const model = new CpModel();

      // Events that must be interleaved: +6, -3, +6, -3
      // Level [0, 8] forces positive events to be separated by negative events
      const t1 = model.newIntVar(0, 3, 't1');
      const t2 = model.newIntVar(0, 3, 't2');
      const t3 = model.newIntVar(0, 3, 't3');
      const t4 = model.newIntVar(0, 3, 't4');

      model.addReservoirConstraint(
        [t1, t2, t3, t4],
        [6, -3, 6, -3],
        0,
        8
      );

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Verify solution is valid
      const events = [
        { time: solver.value(t1), delta: 6 },
        { time: solver.value(t2), delta: -3 },
        { time: solver.value(t3), delta: 6 },
        { time: solver.value(t4), delta: -3 },
      ].sort((a, b) => a.time - b.time);

      let level = 0;
      for (const event of events) {
        level += event.delta;
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(8);
      }
    });
  });
});
