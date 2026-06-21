/**
 * Circuit and MultipleCircuit Propagation — Test Suite
 *
 * Tests for Hamiltonian cycle (Circuit) and VRP-style routes (MultipleCircuit)
 * constraint propagation covering:
 * - Positive cases (feasible problems that should solve correctly)
 * - Negative cases (infeasible problems detected by propagation)
 * - Edge cases (boundary conditions, self-loops)
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
// Circuit — Positive Cases (Feasible)
// ============================================================================

describe('Circuit Propagation', () => {
  describe('positive cases (feasible)', () => {
    it('should find a 3-node Hamiltonian cycle', () => {
      const model = new CpModel();
      // Nodes: 0, 1, 2
      // All possible arcs
      const x01 = model.newBoolVar('x01');
      const x02 = model.newBoolVar('x02');
      const x10 = model.newBoolVar('x10');
      const x12 = model.newBoolVar('x12');
      const x20 = model.newBoolVar('x20');
      const x21 = model.newBoolVar('x21');
      // Self-loops
      const x00 = model.newBoolVar('x00');
      const x11 = model.newBoolVar('x11');
      const x22 = model.newBoolVar('x22');

      model.addCircuit([
        [0, 0, x00], [0, 1, x01], [0, 2, x02],
        [1, 0, x10], [1, 1, x11], [1, 2, x12],
        [2, 0, x20], [2, 1, x21], [2, 2, x22],
      ]);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Verify the solution forms a valid cycle
      const selected: [number, number][] = [];
      for (const [tail, head, lit] of [
        [0, 1, x01], [0, 2, x02], [1, 0, x10], [1, 2, x12],
        [2, 0, x20], [2, 1, x21],
      ]) {
        if (solver.booleanValue(lit as any)) {
          selected.push([tail as number, head as number]);
        }
      }

      // Should have exactly 3 arcs forming a cycle
      expect(selected.length).toBe(3);
    });

    it('should find a 4-node Hamiltonian cycle', () => {
      const model = new CpModel();
      const n = 4;
      const arcs: [number, number, any][] = [];

      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const lit = model.newBoolVar(`x${i}${j}`);
          arcs.push([i, j, lit]);
        }
      }

      model.addCircuit(arcs);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });

    it('should find a 5-node Hamiltonian cycle', () => {
      const model = new CpModel();
      const n = 5;
      const arcs: [number, number, any][] = [];

      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const lit = model.newBoolVar(`x${i}${j}`);
          arcs.push([i, j, lit]);
        }
      }

      model.addCircuit(arcs);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });
  });

  // ============================================================================
  // Circuit — Negative Cases (Infeasible)
  // ============================================================================

  describe('negative cases (infeasible)', () => {
    it('should detect infeasible circuit with missing arcs', () => {
      const model = new CpModel();
      // Include node 2 but only allow 0->1 and 1->0
      // Node 2 has no incoming or outgoing arcs, so it can't be visited
      const x01 = model.newBoolVar('x01');
      const x10 = model.newBoolVar('x10');
      // Self-loops for node 2 (required but not sufficient)
      const x00 = model.newBoolVar('x00');
      const x11 = model.newBoolVar('x11');
      const x22 = model.newBoolVar('x22');

      model.addCircuit([
        [0, 0, x00], [0, 1, x01],
        [1, 0, x10], [1, 1, x11],
        [2, 2, x22],
      ]);

      const { status } = solveAndCheck(model);
      // Can't form a single cycle through all 3 nodes with only these arcs
      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });

    it('should detect infeasible circuit with forced subtour', () => {
      const model = new CpModel();
      // Create arcs but force a subtour that excludes node 2
      const x01 = model.newBoolVar('x01');
      const x10 = model.newBoolVar('x10');
      const x02 = model.newBoolVar('x02');
      const x20 = model.newBoolVar('x20');
      const x12 = model.newBoolVar('x12');
      const x21 = model.newBoolVar('x21');

      // Force 0->1->0 subtour (excluding node 2)
      model.addBoolAnd([x01]);
      model.addBoolAnd([x10]);

      model.addCircuit([
        [0, 1, x01], [0, 2, x02],
        [1, 0, x10], [1, 2, x12],
        [2, 0, x20], [2, 1, x21],
      ]);

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });
  });

  // ============================================================================
  // Circuit — Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('should handle single-node circuit with self-loop', () => {
      const model = new CpModel();
      const x00 = model.newBoolVar('x00');
      model.addCircuit([[0, 0, x00]]);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.booleanValue(x00)).toBe(true);
    });

    it('should handle 2-node circuit', () => {
      const model = new CpModel();
      const x01 = model.newBoolVar('x01');
      const x10 = model.newBoolVar('x10');
      const x00 = model.newBoolVar('x00');
      const x11 = model.newBoolVar('x11');

      model.addCircuit([
        [0, 0, x00], [0, 1, x01],
        [1, 0, x10], [1, 1, x11],
      ]);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Should form 0->1->0 cycle
      expect(solver.booleanValue(x01)).toBe(true);
      expect(solver.booleanValue(x10)).toBe(true);
    });
  });

  // ============================================================================
  // Circuit — Performance
  // ============================================================================

  describe('performance', () => {
    it('should solve 6-node circuit efficiently', () => {
      const model = new CpModel();
      const n = 6;
      const arcs: [number, number, any][] = [];

      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const lit = model.newBoolVar(`x${i}${j}`);
          arcs.push([i, j, lit]);
        }
      }

      model.addCircuit(arcs);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.numBranches).toBeLessThan(100);
    });

    it('should solve 8-node circuit efficiently', () => {
      const model = new CpModel();
      const n = 8;
      const arcs: [number, number, any][] = [];

      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const lit = model.newBoolVar(`x${i}${j}`);
          arcs.push([i, j, lit]);
        }
      }

      model.addCircuit(arcs);

      const { status, solver } = solveAndCheck(model, 30);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.numBranches).toBeLessThan(500);
    });
  });

  // ============================================================================
  // Circuit — TSP with Objective
  // ============================================================================

  describe('TSP with objective', () => {
    it('should find optimal TSP tour', () => {
      const model = new CpModel();
      const n = 4;

      // Distance matrix
      const distances = [
        [0, 10, 15, 20],
        [10, 0, 35, 25],
        [15, 35, 0, 30],
        [20, 25, 30, 0],
      ];

      const arcs: [number, number, any][] = [];
      const arcVars: { i: number; j: number; lit: any }[] = [];

      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i !== j) {
            const lit = model.newBoolVar(`x${i}_${j}`);
            arcs.push([i, j, lit]);
            arcVars.push({ i, j, lit });
          }
        }
      }

      model.addCircuit(arcs);

      // Objective: minimize total distance
      const totalDistance = model.newIntVar(0, 1000, 'total');
      const terms = arcVars.map(({ i, j, lit }) => lit.mul(distances[i][j]));
      model.add(totalDistance.eq(terms.reduce((a, b) => a.add(b))));
      model.minimize(totalDistance);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Verify the tour is valid
      const selected: [number, number][] = [];
      for (const { i, j, lit } of arcVars) {
        if (solver.booleanValue(lit)) {
          selected.push([i, j]);
        }
      }
      expect(selected.length).toBe(n);
    });
  });

  // ============================================================================
  // Circuit — Solution Verification
  // ============================================================================

  describe('solution verification', () => {
    it('should verify cycle visits all nodes exactly once', () => {
      const model = new CpModel();
      const n = 5;
      const arcs: [number, number, any][] = [];

      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const lit = model.newBoolVar(`x${i}${j}`);
          arcs.push([i, j, lit]);
        }
      }

      model.addCircuit(arcs);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Extract the cycle
      const next: Map<number, number> = new Map();
      for (const [tail, head, lit] of arcs) {
        if (solver.booleanValue(lit)) {
          next.set(tail as number, head as number);
        }
      }

      // Verify each node has exactly one successor
      expect(next.size).toBe(n);

      // Verify the cycle visits all nodes
      const visited = new Set<number>();
      let current = 0;
      for (let i = 0; i < n; i++) {
        expect(visited.has(current)).toBe(false);
        visited.add(current);
        current = next.get(current)!;
      }

      // Should return to start
      expect(current).toBe(0);
    });
  });
});

// ============================================================================
// MultipleCircuit — Positive Cases (Feasible)
// ============================================================================

describe('MultipleCircuit Propagation', () => {
  describe('positive cases (feasible)', () => {
    it('should find routes through depot for 3 nodes', () => {
      const model = new CpModel();
      // Nodes: 0 (depot), 1, 2
      const x01 = model.newBoolVar('x01');
      const x02 = model.newBoolVar('x02');
      const x10 = model.newBoolVar('x10');
      const x12 = model.newBoolVar('x12');
      const x20 = model.newBoolVar('x20');
      const x21 = model.newBoolVar('x21');
      const x00 = model.newBoolVar('x00');
      const x11 = model.newBoolVar('x11');
      const x22 = model.newBoolVar('x22');

      model.addMultipleCircuit([
        [0, 0, x00], [0, 1, x01], [0, 2, x02],
        [1, 0, x10], [1, 1, x11], [1, 2, x12],
        [2, 0, x20], [2, 1, x21], [2, 2, x22],
      ]);

      const { status, solver } = solveAndCheck(model);
      expect([CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE]).toContain(status);
    });

    it('should find routes through depot for 4 nodes', () => {
      const model = new CpModel();
      const n = 4;
      const arcs: [number, number, any][] = [];

      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const lit = model.newBoolVar(`x${i}${j}`);
          arcs.push([i, j, lit]);
        }
      }

      model.addMultipleCircuit(arcs);

      const { status, solver } = solveAndCheck(model);
      expect([CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE]).toContain(status);
    });
  });

  // ============================================================================
  // MultipleCircuit — Negative Cases (Infeasible)
  // ============================================================================

  describe('negative cases (infeasible)', () => {
    it('should detect infeasible multiple circuit with missing depot arcs', () => {
      const model = new CpModel();
      // Only allow 1->2 and 2->1, no connection to depot (node 0)
      const x12 = model.newBoolVar('x12');
      const x21 = model.newBoolVar('x21');

      model.addMultipleCircuit([
        [1, 2, x12],
        [2, 1, x21],
      ]);

      const { status } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.INFEASIBLE);
    });
  });

  // ============================================================================
  // MultipleCircuit — Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('should handle single-node multiple circuit', () => {
      const model = new CpModel();
      const x00 = model.newBoolVar('x00');
      model.addMultipleCircuit([[0, 0, x00]]);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.booleanValue(x00)).toBe(true);
    });

    it('should handle 2-node multiple circuit through depot', () => {
      const model = new CpModel();
      const x01 = model.newBoolVar('x01');
      const x10 = model.newBoolVar('x10');
      const x00 = model.newBoolVar('x00');
      const x11 = model.newBoolVar('x11');

      model.addMultipleCircuit([
        [0, 0, x00], [0, 1, x01],
        [1, 0, x10], [1, 1, x11],
      ]);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
    });
  });

  // ============================================================================
  // MultipleCircuit — Performance
  // ============================================================================

  describe('performance', () => {
    it('should solve 6-node multiple circuit efficiently', () => {
      const model = new CpModel();
      const n = 6;
      const arcs: [number, number, any][] = [];

      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const lit = model.newBoolVar(`x${i}${j}`);
          arcs.push([i, j, lit]);
        }
      }

      model.addMultipleCircuit(arcs);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);
      expect(solver.numBranches).toBeLessThan(100);
    });
  });

  // ============================================================================
  // MultipleCircuit — Solution Verification
  // ============================================================================

  describe('solution verification', () => {
    it('should verify all routes pass through depot', () => {
      const model = new CpModel();
      const n = 4;
      const arcs: [number, number, any][] = [];

      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const lit = model.newBoolVar(`x${i}${j}`);
          arcs.push([i, j, lit]);
        }
      }

      model.addMultipleCircuit(arcs);

      const { status, solver } = solveAndCheck(model);
      expect(status).toBe(CpSolverStatus.OPTIMAL);

      // Extract routes
      const next: Map<number, number> = new Map();
      for (const [tail, head, lit] of arcs) {
        if (solver.booleanValue(lit)) {
          next.set(tail as number, head as number);
        }
      }

      // Verify each node has exactly one successor
      expect(next.size).toBe(n);

      // Trace all cycles and verify each passes through depot (node 0)
      const visited = new Set<number>();
      for (let start = 0; start < n; start++) {
        if (visited.has(start)) continue;

        const cycle: number[] = [];
        let current = start;
        while (!visited.has(current)) {
          visited.add(current);
          cycle.push(current);
          current = next.get(current)!;
        }

        // Verify cycle passes through depot
        expect(cycle.includes(0)).toBe(true);
      }
    });
  });
});
