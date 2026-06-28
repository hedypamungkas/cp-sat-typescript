/**
 * Soundness property test (fast-check): for random optimization models, every
 * solution returned by solvePortfolio satisfies ALL constraints, and the dual
 * bound respects the sound direction.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CpModel } from '../../src/model';
import type { IntVarImpl } from '../../src/variables';
import { CpSolverStatus } from '../../src/types';
import { solvePortfolio } from '../../src/worker/portfolio';
import { runWorkerSolve } from '../../src/worker/worker-entry';
import type { MainThreadPort } from '../../src/worker/port';
import type { WorkerIn, WorkerOut } from '../../src/worker/protocol';

// In-process fake spawner (same pattern as portfolio.test.ts).
function fakeSpawner(): Promise<MainThreadPort> {
  let h: ((d: unknown) => void) | null = null;
  const port: MainThreadPort = {
    postMessage: (msg: unknown) => {
      const m = msg as WorkerIn;
      if (m.kind === 'solve') {
        setTimeout(() => {
          const result = runWorkerSolve(m.model, m.params, (obj, wall) => {
            h?.({ kind: 'incumbent', workerId: m.workerId, objectiveValue: obj, wallTime: wall } as WorkerOut);
          });
          h?.({ kind: 'done', workerId: m.workerId, ...result } as WorkerOut);
        }, 0);
      }
    },
    onMessage: (cb) => { h = cb; return () => { h = null; }; },
    onError: () => () => {},
    terminate: () => {},
  };
  return Promise.resolve(port);
}

const modelSpec = fc.record({
  numVars: fc.integer({ min: 2, max: 5 }),
  maxVal: fc.integer({ min: 3, max: 8 }),
  seed: fc.integer({ min: 1, max: 100 }),
});

function buildModel(numVars: number, maxVal: number): { model: CpModel; vars: IntVarImpl[] } {
  const m = new CpModel();
  const vars = Array.from({ length: numVars }, (_, i) => m.newIntVar(0, maxVal, `x${i}`));
  m.addAllDifferent(vars);
  let obj = vars[0];
  for (let i = 1; i < vars.length; i++) obj = obj.add(vars[i]);
  m.maximize(obj);
  return { model: m, vars };
}

describe('Portfolio soundness property (fast-check)', () => {
  it('every returned solution satisfies allDifferent + bounds + objective = sum', async () => {
    await fc.assert(
      fc.asyncProperty(modelSpec, async (spec) => {
        const { model, vars } = buildModel(spec.numVars, spec.maxVal);
        const res = await solvePortfolio(model, { numWorkers: 2, spawner: fakeSpawner, randomSeed: spec.seed });

        if (res.status !== CpSolverStatus.OPTIMAL && res.status !== CpSolverStatus.FEASIBLE) return true;
        if (!res.solution) return true;

        // allDifferent: all values distinct
        const values = vars.map((v) => res.solution!.get(v.index));
        if (values.some((v) => v === undefined)) return false;
        const distinct = new Set(values);
        if (distinct.size !== values.length) return false;

        // bounds: all within [0, maxVal]
        if (values.some((v) => v! < 0 || v! > spec.maxVal)) return false;

        // objective = sum of values
        const sum = values.reduce((a, b) => a! + b!, 0);
        if (sum !== res.objectiveValue) return false;

        return true;
      }),
      { numRuns: 50 },
    );
  });

  it('dual bound respects the sound direction (>= primal for maximize)', async () => {
    await fc.assert(
      fc.asyncProperty(modelSpec, async (spec) => {
        const { model } = buildModel(spec.numVars, spec.maxVal);
        const res = await solvePortfolio(model, {
          numWorkers: 2,
          spawner: fakeSpawner,
          randomSeed: spec.seed,
          strategies: [
            { randomSeed: spec.seed, enableSimplexBounds: true },
            { randomSeed: spec.seed + 1, enableLpBounds: true },
          ],
        });

        if (res.objectiveValue !== null && res.bestObjectiveBound !== null) {
          // maximize: dual (upper bound) >= primal
          return res.bestObjectiveBound >= res.objectiveValue;
        }
        return true;
      }),
      { numRuns: 30 },
    );
  });
});
