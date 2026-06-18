/**
 * CP-SAT TypeScript Tests
 * Tests for example problems
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus, LinearExpr } from '../src/types';
import { CpSolverSolutionCallback } from '../src/callback';

describe('Example: Variable Assignment', () => {
  it('should solve simple variable assignment', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');

    // x + y = 10
    model.add(x.add(y).eq(10));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.value(x) + solver.value(y)).toBe(10);
  });

  it('should solve with allDifferent', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 2, 'x');
    const y = model.newIntVar(0, 2, 'y');
    const z = model.newIntVar(0, 2, 'z');

    model.addAllDifferent([x, y, z]);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    const values = [solver.value(x), solver.value(y), solver.value(z)];
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(3);
  });
});

describe('Example: Boolean Constraints', () => {
  it('should solve OR constraint', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');
    const c = model.newBoolVar('c');

    // At least one must be true
    model.addBoolOr([a, b, c]);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.booleanValue(a) || solver.booleanValue(b) || solver.booleanValue(c)).toBe(true);
  });

  it('should solve AND constraint', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');

    // Both must be true
    model.addBoolAnd([a, b]);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.booleanValue(a)).toBe(true);
    expect(solver.booleanValue(b)).toBe(true);
  });

  it('should solve implication', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');

    // a => b
    model.addImplication(a, b);
    // Force a to be true
    model.addBoolAnd([a]);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    expect(solver.booleanValue(a)).toBe(true);
    expect(solver.booleanValue(b)).toBe(true);
  });
});

describe('Example: Solution Callbacks', () => {
  it('should enumerate solutions with callback', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 2, 'x');
    const y = model.newIntVar(0, 2, 'y');

    model.addAllDifferent([x, y]);

    let solutionCount = 0;
    class CountCallback extends CpSolverSolutionCallback {
      onSolutionCallback(): void {
        solutionCount++;
      }
    }

    const solver = new CpSolver();
    solver.parameters.enumerateAllSolutions = true;
    const callback = new CountCallback();
    solver.solve(model, callback);

    // Should find multiple solutions
    expect(solutionCount).toBeGreaterThan(0);
  });
});

describe('Example: N-Queens', () => {
  it('should solve 4-Queens problem', () => {
    const boardSize = 4;
    const model = new CpModel();

    // One variable per column; value = row where queen sits
    const queens = Array.from({ length: boardSize }, (_, i) =>
      model.newIntVar(0, boardSize - 1, `x_${i}`)
    );

    // All rows must differ
    model.addAllDifferent(queens);

    // No two queens on same diagonal
    model.addAllDifferent(queens.map((q, i) => q.add(i)));
    model.addAllDifferent(queens.map((q, i) => q.sub(i)));

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    // Verify solution
    const solution = queens.map(q => solver.value(q));
    const uniqueRows = new Set(solution);
    expect(uniqueRows.size).toBe(boardSize);
  });
});

describe('Example: Knapsack', () => {
  it('should solve 0/1 knapsack problem', () => {
    const model = new CpModel();

    // Items: (weight, value)
    const items = [
      { weight: 2, value: 3 },
      { weight: 3, value: 4 },
      { weight: 4, value: 5 },
      { weight: 5, value: 8 },
    ];
    const capacity = 8;

    // Boolean: take item i?
    const take = items.map((_, i) => model.newBoolVar(`take_${i}`));

    // Weight constraint
    const totalWeight = items.reduce(
      (expr, item, i) => expr.add(take[i].mul(item.weight)),
      new LinearExpr([], [], 0)
    );
    model.add(totalWeight.le(capacity));

    // Maximize total value
    const totalValue = items.reduce(
      (expr, item, i) => expr.add(take[i].mul(item.value)),
      new LinearExpr([], [], 0)
    );
    model.maximize(totalValue);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    // Verify weight constraint
    const w = items.reduce((sum, item, i) =>
      sum + (solver.booleanValue(take[i]) ? item.weight : 0), 0
    );
    expect(w).toBeLessThanOrEqual(capacity);

    // Expected optimal: items 0,1,3 (weight=2+3+5=10 > 8) or items 0,3 (weight=7, value=11)
    // or items 1,3 (weight=8, value=12) — best is items 1,3
    expect(solver.objectiveValue).toBe(12);
  });
});

describe('Example: Graph Coloring', () => {
  it('should color a graph with minimum colors', () => {
    const model = new CpModel();

    // Graph: triangle (3 nodes, each connected to others)
    const numNodes = 3;
    const numColors = 3;

    // color[i] = color assigned to node i
    const colors = Array.from({ length: numNodes }, (_, i) =>
      model.newIntVar(0, numColors - 1, `color_${i}`)
    );

    // Adjacent nodes must have different colors
    // Build allowed tuples: all pairs (a, b) where a != b
    const allowedTuples: number[][] = [];
    for (let a = 0; a < numColors; a++) {
      for (let b = 0; b < numColors; b++) {
        if (a !== b) allowedTuples.push([a, b]);
      }
    }

    const edges = [[0, 1], [1, 2], [0, 2]];
    for (const [u, v] of edges) {
      model.addAllowedAssignments([colors[u], colors[v]], allowedTuples);
    }

    // Minimize the number of colors used (makespan of colors)
    const maxColor = model.newIntVar(0, numColors - 1, 'maxColor');
    model.addMaxEquality(maxColor, colors);
    model.minimize(maxColor);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    // Triangle needs 3 colors
    expect(solver.objectiveValue).toBe(2);

    // Verify all adjacent nodes have different colors
    for (const [u, v] of edges) {
      expect(solver.value(colors[u])).not.toBe(solver.value(colors[v]));
    }
  });
});

describe('Example: Sudoku-like', () => {
  it('should solve a 4x4 Latin square', () => {
    const model = new CpModel();
    const size = 4;

    // Grid of variables
    const grid: import('../src/variables').IntVarImpl[][] = [];
    for (let r = 0; r < size; r++) {
      grid[r] = [];
      for (let c = 0; c < size; c++) {
        grid[r][c] = model.newIntVar(1, size, `cell_${r}_${c}`);
      }
    }

    // All different in each row
    for (let r = 0; r < size; r++) {
      model.addAllDifferent(grid[r]);
    }

    // All different in each column
    for (let c = 0; c < size; c++) {
      model.addAllDifferent(grid.map(row => row[c]));
    }

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    // Verify rows have all different values
    for (let r = 0; r < size; r++) {
      const rowValues = grid[r].map(v => solver.value(v));
      expect(new Set(rowValues).size).toBe(size);
    }

    // Verify columns have all different values
    for (let c = 0; c < size; c++) {
      const colValues = grid.map(row => solver.value(row[c]));
      expect(new Set(colValues).size).toBe(size);
    }
  });
});

describe('Example: Scheduling with Cumulative', () => {
  it('should schedule tasks with resource capacity', () => {
    const model = new CpModel();

    // 3 tasks with durations and demands
    const tasks = [
      { duration: 3, demand: 2 },
      { duration: 4, demand: 3 },
      { duration: 2, demand: 2 },
    ];
    const capacity = 4;

    const starts = tasks.map((_, i) => model.newIntVar(0, 20, `start${i}`));
    const ends = tasks.map((_, i) => model.newIntVar(0, 20, `end${i}`));

    for (let i = 0; i < tasks.length; i++) {
      model.add(starts[i].add(tasks[i].duration).eq(ends[i]));
    }

    const intervals = tasks.map((t, i) =>
      model.newIntervalVar(starts[i], t.duration, ends[i], `task${i}`)
    );

    model.addCumulative(intervals, tasks.map(t => t.demand), capacity);

    // Minimize makespan
    const makespan = model.newIntVar(0, 20, 'makespan');
    model.addMaxEquality(makespan, ends);
    model.minimize(makespan);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    // Verify all tasks are scheduled
    for (let i = 0; i < tasks.length; i++) {
      expect(solver.value(ends[i])).toBe(solver.value(starts[i]) + tasks[i].duration);
    }

    // Verify capacity constraint: at each task start, check overlapping demand
    for (let i = 0; i < tasks.length; i++) {
      const si = solver.value(starts[i]);
      const ei = solver.value(ends[i]);
      let totalDemand = tasks[i].demand;
      for (let j = 0; j < tasks.length; j++) {
        if (i === j) continue;
        const sj = solver.value(starts[j]);
        const ej = solver.value(ends[j]);
        if (sj < ei && si < ej) {
          totalDemand += tasks[j].demand;
        }
      }
      expect(totalDemand).toBeLessThanOrEqual(capacity);
    }
  });
});

describe('Example: Employee Scheduling', () => {
  it('should assign shifts with fairness', () => {
    const model = new CpModel();

    const numNurses = 3;
    const numDays = 2;
    const numShifts = 2;

    // shifts[n][d][s] = 1 if nurse n works shift s on day d
    const shifts: import('../src/variables').BoolVarImpl[][][] = [];
    for (let n = 0; n < numNurses; n++) {
      shifts[n] = [];
      for (let d = 0; d < numDays; d++) {
        shifts[n][d] = [];
        for (let s = 0; s < numShifts; s++) {
          shifts[n][d][s] = model.newBoolVar(`s_${n}_${d}_${s}`);
        }
      }
    }

    // Each shift each day assigned to exactly one nurse
    for (let d = 0; d < numDays; d++) {
      for (let s = 0; s < numShifts; s++) {
        model.addExactlyOne(shifts.map(n => n[d][s]));
      }
    }

    // Each nurse at most one shift per day
    for (let n = 0; n < numNurses; n++) {
      for (let d = 0; d < numDays; d++) {
        model.addAtMostOne(shifts[n][d]);
      }
    }

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    // Verify exactly one nurse per shift
    for (let d = 0; d < numDays; d++) {
      for (let s = 0; s < numShifts; s++) {
        const assigned = shifts.map(n => solver.booleanValue(n[d][s]));
        expect(assigned.filter(Boolean).length).toBe(1);
      }
    }

    // Verify at most one shift per nurse per day
    for (let n = 0; n < numNurses; n++) {
      for (let d = 0; d < numDays; d++) {
        const dayShifts = shifts[n][d].map(s => solver.booleanValue(s));
        expect(dayShifts.filter(Boolean).length).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('Example: Pure Feasibility', () => {
  it('should find feasible solution with multiple constraints', () => {
    const model = new CpModel();

    const x = model.newIntVar(0, 10, 'x');
    const y = model.newIntVar(0, 10, 'y');
    const z = model.newIntVar(0, 10, 'z');

    model.add(x.add(y).le(12));
    model.add(y.add(z).le(12));
    model.add(x.add(z).ge(5));
    model.addAllDifferent([x, y, z]);

    const solver = new CpSolver();
    const status = solver.solve(model);

    expect(status).toBe(CpSolverStatus.OPTIMAL);
    const vals = [solver.value(x), solver.value(y), solver.value(z)];
    expect(new Set(vals).size).toBe(3);
  });
});
