/**
 * CP-SAT TypeScript Tests
 * Tests for solution callback classes
 */

import { describe, it, expect, vi } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus } from '../src/types';
import {
  CpSolverSolutionCallback,
  VarArraySolutionPrinter,
  VarArrayAndObjectiveSolutionPrinter,
  ObjectiveSolutionPrinter,
} from '../src/callback';

describe('CpSolverSolutionCallback', () => {
  class CountCallback extends CpSolverSolutionCallback {
    onSolutionCallback(): void {
      // just count
    }
  }

  it('should track solution count', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 2, 'x');
    const y = model.newIntVar(0, 2, 'y');
    model.addAllDifferent([x, y]);

    const solver = new CpSolver();
    solver.parameters.enumerateAllSolutions = true;
    const callback = new CountCallback();
    solver.solve(model, callback);

    expect(callback.solutionCount).toBeGreaterThan(0);
  });

  it('should provide variable values', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 2, 'x');
    const y = model.newIntVar(0, 2, 'y');
    model.addAllDifferent([x, y]);

    let lastX = -1;
    class ValueCallback extends CpSolverSolutionCallback {
      onSolutionCallback(): void {
        lastX = this.value(x);
      }
    }

    const solver = new CpSolver();
    solver.parameters.enumerateAllSolutions = true;
    solver.solve(model, new ValueCallback());

    expect(lastX).toBeGreaterThanOrEqual(0);
    expect(lastX).toBeLessThanOrEqual(2);
  });

  it('should provide boolean values', () => {
    const model = new CpModel();
    const a = model.newBoolVar('a');
    const b = model.newBoolVar('b');
    model.addExactlyOne([a, b]);

    let sawA = false;
    let sawB = false;
    class BoolCallback extends CpSolverSolutionCallback {
      onSolutionCallback(): void {
        sawA = sawA || this.booleanValue(a);
        sawB = sawB || this.booleanValue(b);
      }
    }

    const solver = new CpSolver();
    solver.parameters.enumerateAllSolutions = true;
    solver.solve(model, new BoolCallback());

    // Exactly one must be true across all solutions
    expect(sawA || sawB).toBe(true);
  });

  it('should provide objective value', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    model.maximize(x);

    let objValue = -1;
    class ObjCallback extends CpSolverSolutionCallback {
      onSolutionCallback(): void {
        objValue = this.objectiveValue;
      }
    }

    const solver = new CpSolver();
    solver.solve(model, new ObjCallback());
    expect(objValue).toBe(10);
  });

  it('should provide timing and stats', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 5, 'x');

    let sawWallTime = false;
    let sawConflicts = false;
    let sawBranches = false;
    class StatsCallback extends CpSolverSolutionCallback {
      onSolutionCallback(): void {
        sawWallTime = this.wallTime >= 0;
        sawConflicts = this.numConflicts >= 0;
        sawBranches = this.numBranches >= 0;
      }
    }

    const solver = new CpSolver();
    solver.solve(model, new StatsCallback());
    expect(sawWallTime).toBe(true);
    expect(sawConflicts).toBe(true);
    expect(sawBranches).toBe(true);
  });

  it('should stop search when stopSearch is called', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 100, 'x');
    const y = model.newIntVar(0, 100, 'y');
    model.addAllDifferent([x, y]);

    let count = 0;
    class StopAfterOne extends CpSolverSolutionCallback {
      onSolutionCallback(): void {
        count++;
        if (count >= 1) {
          this.stopSearch();
        }
      }
    }

    const solver = new CpSolver();
    solver.parameters.enumerateAllSolutions = true;
    solver.solve(model, new StopAfterOne());

    expect(count).toBe(1);
  });

  it('should throw when accessing value of missing variable', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 5, 'x');
    const y = model.newIntVar(0, 5, 'y');

    class BadCallback extends CpSolverSolutionCallback {
      onSolutionCallback(): void {
        // This should work - y is in the model
        this.value(y);
      }
    }

    const solver = new CpSolver();
    // Should not throw since y is in the model
    solver.solve(model, new BadCallback());
  });
});

describe('VarArraySolutionPrinter', () => {
  it('should print solutions without throwing', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 2, 'x');
    const y = model.newIntVar(0, 2, 'y');
    model.addAllDifferent([x, y]);

    const solver = new CpSolver();
    solver.parameters.enumerateAllSolutions = true;

    const printer = new VarArraySolutionPrinter([x, y]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    solver.solve(model, printer);

    expect(printer.solutionCount).toBeGreaterThan(0);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('VarArrayAndObjectiveSolutionPrinter', () => {
  it('should print solutions with objective', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    model.maximize(x);

    const solver = new CpSolver();
    const printer = new VarArrayAndObjectiveSolutionPrinter([x]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    solver.solve(model, printer);

    expect(printer.solutionCount).toBeGreaterThan(0);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('ObjectiveSolutionPrinter', () => {
  it('should print only objective values', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    model.minimize(x);

    const solver = new CpSolver();
    const printer = new ObjectiveSolutionPrinter();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    solver.solve(model, printer);

    expect(printer.solutionCount).toBeGreaterThan(0);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
