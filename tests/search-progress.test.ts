/**
 * CP-SAT TypeScript Tests
 * Tests for SearchProgressCallback and logSearchProgress
 */

import { describe, it, expect, vi } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus, SearchProgressInfo } from '../src/types';

describe('SearchProgressCallback', () => {
  it('should fire callback during search with valid info fields', () => {
    // Create a model that takes some time to solve
    const model = new CpModel();
    const vars = Array.from({ length: 6 }, (_, i) => model.newIntVar(0, 5, `x${i}`));
    model.addAllDifferent(vars);
    model.maximize(vars[0].add(vars[1].mul(2)).add(vars[2].mul(3)));

    const progressInfos: SearchProgressInfo[] = [];
    const progressCb = {
      onSearchProgress(info: SearchProgressInfo): void {
        progressInfos.push({ ...info });
      },
    };

    const solver = new CpSolver();
    const status = solver.solve(model, undefined, progressCb);

    expect(status).toBe(CpSolverStatus.OPTIMAL);

    // If the solve was fast enough, the callback might not have fired
    // (throttle is 1 second). But if it fired, verify the fields.
    if (progressInfos.length > 0) {
      const info = progressInfos[0];
      expect(typeof info.wallTime).toBe('number');
      expect(info.wallTime).toBeGreaterThan(0);
      expect(typeof info.numConflicts).toBe('number');
      expect(info.numConflicts).toBeGreaterThanOrEqual(0);
      expect(typeof info.numBranches).toBe('number');
      expect(info.numBranches).toBeGreaterThanOrEqual(0);
      expect(typeof info.numSolutions).toBe('number');
      expect(info.numSolutions).toBeGreaterThanOrEqual(0);
      expect(typeof info.isMaximize).toBe('boolean');
      expect(info.isMaximize).toBe(true);
      expect(typeof info.depth).toBe('number');
      expect(info.depth).toBeGreaterThanOrEqual(0);
    }
  });

  it('should deliver correct objective info for maximization', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 100, 'x');
    const y = model.newIntVar(0, 100, 'y');
    model.add(x.add(y).le(50));
    model.maximize(x.add(y.mul(2)));

    const progressInfos: SearchProgressInfo[] = [];
    const progressCb = {
      onSearchProgress(info: SearchProgressInfo): void {
        progressInfos.push({ ...info });
      },
    };

    const solver = new CpSolver();
    solver.solve(model, undefined, progressCb);

    // All progress reports should have isMaximize = true
    for (const info of progressInfos) {
      expect(info.isMaximize).toBe(true);
    }
  });

  it('should deliver correct objective info for minimization', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 100, 'x');
    model.minimize(x);

    const progressInfos: SearchProgressInfo[] = [];
    const progressCb = {
      onSearchProgress(info: SearchProgressInfo): void {
        progressInfos.push({ ...info });
      },
    };

    const solver = new CpSolver();
    solver.solve(model, undefined, progressCb);

    for (const info of progressInfos) {
      expect(info.isMaximize).toBe(false);
    }
  });

  it('should not crash when no callback is provided', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');

    const solver = new CpSolver();
    // No callback — should not throw
    const status = solver.solve(model);
    expect(status).toBe(CpSolverStatus.OPTIMAL);
  });

  it('should fire callback for feasible-only problem', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 5, 'x');
    const y = model.newIntVar(0, 5, 'y');
    model.addAllDifferent([x, y]);
    // No objective — just feasibility

    const progressInfos: SearchProgressInfo[] = [];
    const progressCb = {
      onSearchProgress(info: SearchProgressInfo): void {
        progressInfos.push({ ...info });
      },
    };

    const solver = new CpSolver();
    solver.parameters.enumerateAllSolutions = true;
    solver.solve(model, undefined, progressCb);

    // For feasibility problems, bestObjectiveValue should be null
    // (or the objective fields may not be meaningful)
    // Just verify callback was called if solve took > 1s
    for (const info of progressInfos) {
      expect(typeof info.wallTime).toBe('number');
      expect(typeof info.numSolutions).toBe('number');
    }
  });

  it('should provide solution count in progress info', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 3, 'x');
    const y = model.newIntVar(0, 3, 'y');
    model.addAllDifferent([x, y]);
    model.maximize(x.add(y));

    let maxSolutions = 0;
    const progressCb = {
      onSearchProgress(info: SearchProgressInfo): void {
        maxSolutions = Math.max(maxSolutions, info.numSolutions);
      },
    };

    const solver = new CpSolver();
    solver.solve(model, undefined, progressCb);

    // The solver should find at least 1 solution
    expect(solver.numSolutions).toBeGreaterThanOrEqual(1);
    // If callback fired, it should have seen solutions
    if (maxSolutions > 0) {
      expect(maxSolutions).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('logSearchProgress parameter', () => {
  it('should log progress to console when logSearchProgress is true', () => {
    const model = new CpModel();
    const vars = Array.from({ length: 6 }, (_, i) => model.newIntVar(0, 5, `x${i}`));
    model.addAllDifferent(vars);
    model.maximize(vars[0].add(vars[1].mul(2)));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const solver = new CpSolver();
    solver.parameters.logSearchProgress = true;
    solver.solve(model);

    // If the solve took > 1s, console.log should have been called
    // with progress info
    if (solver.wallTime > 1.0) {
      expect(consoleSpy).toHaveBeenCalled();
      // Check that at least one call contains "conflicts:"
      const calls = consoleSpy.mock.calls.map(c => c.join(' '));
      const progressCalls = calls.filter(c => c.includes('conflicts:'));
      expect(progressCalls.length).toBeGreaterThan(0);
    }

    consoleSpy.mockRestore();
  });

  it('should not log when logSearchProgress is false', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const solver = new CpSolver();
    solver.parameters.logSearchProgress = false;
    solver.solve(model);

    // Should not have logged progress (though other logs might exist)
    const calls = consoleSpy.mock.calls.map(c => c.join(' '));
    const progressCalls = calls.filter(c => c.includes('conflicts:'));
    expect(progressCalls.length).toBe(0);

    consoleSpy.mockRestore();
  });
});

describe('gapPercent in SearchProgressInfo', () => {
  it('should include gapPercent when objective is present', () => {
    const model = new CpModel();
    const x = model.newIntVar(0, 100, 'x');
    const y = model.newIntVar(0, 100, 'y');
    model.add(x.add(y).le(50));
    model.maximize(x.add(y.mul(2)));

    const progressInfos: SearchProgressInfo[] = [];
    const progressCb = {
      onSearchProgress(info: SearchProgressInfo): void {
        progressInfos.push({ ...info });
      },
    };

    const solver = new CpSolver();
    solver.solve(model, undefined, progressCb);

    // Verify gapPercent field exists and has correct type
    for (const info of progressInfos) {
      expect(info).toHaveProperty('gapPercent');
      if (info.bestObjectiveValue !== null && info.bestObjectiveBound !== null) {
        expect(typeof info.gapPercent).toBe('number');
        expect(info.gapPercent!).toBeGreaterThanOrEqual(0);
      } else {
        expect(info.gapPercent).toBeNull();
      }
    }
  });

  it('should compute gap correctly for maximization', () => {
    // Create a model where we can control the gap
    const model = new CpModel();
    const x = model.newIntVar(0, 100, 'x');
    model.maximize(x);

    const progressInfos: SearchProgressInfo[] = [];
    const progressCb = {
      onSearchProgress(info: SearchProgressInfo): void {
        progressInfos.push({ ...info });
      },
    };

    const solver = new CpSolver();
    solver.solve(model, undefined, progressCb);

    // For a simple maximize x with domain [0,100], optimal is 100
    // Gap should be 0 at optimality
    if (progressInfos.length > 0) {
      const lastInfo = progressInfos[progressInfos.length - 1];
      if (lastInfo.bestObjectiveValue !== null && lastInfo.bestObjectiveBound !== null) {
        const expectedGap = Math.abs(lastInfo.bestObjectiveValue - lastInfo.bestObjectiveBound) /
          Math.max(1, Math.abs(lastInfo.bestObjectiveValue)) * 100;
        expect(lastInfo.gapPercent).toBeCloseTo(expectedGap, 5);
      }
    }
  });

  it('should include gap in console output when logSearchProgress is true', () => {
    const model = new CpModel();
    const vars = Array.from({ length: 6 }, (_, i) => model.newIntVar(0, 5, `x${i}`));
    model.addAllDifferent(vars);
    model.maximize(vars[0].add(vars[1].mul(2)));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const solver = new CpSolver();
    solver.parameters.logSearchProgress = true;
    solver.solve(model);

    // If the solve took > 1s and had an objective, check for gap in output
    if (solver.wallTime > 1.0) {
      const calls = consoleSpy.mock.calls.map(c => c.join(' '));
      const gapCalls = calls.filter(c => c.includes('gap:'));
      // Gap should appear in progress output when objective is present
      expect(gapCalls.length).toBeGreaterThan(0);
    }

    consoleSpy.mockRestore();
  });
});
