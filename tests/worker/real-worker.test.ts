/**
 * Real worker integration test — spawns actual Node worker_threads (requires the
 * esbuild bundle at dist/cp-sat-worker.cjs, produced by `npm run build`).
 *
 * Skips automatically if the bundle doesn't exist (fresh checkout without build).
 * This catches serialization/protocol/transport bugs that the in-process fake
 * spawner (portfolio.test.ts) cannot see.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { CpModel } from '../../src/model';
import { CpSolver } from '../../src/solver';
import { CpSolverStatus } from '../../src/types';
import { solvePortfolio } from '../../src/worker/portfolio';
import { NodeMainThreadPort } from '../../src/worker/port';
import type { MainThreadPort } from '../../src/worker/port';

const BUNDLE = pathToFileURL(join(process.cwd(), 'dist/cp-sat-worker.cjs'));
const hasBundle = existsSync(BUNDLE);

/** Real spawner: creates an actual worker_thread from the bundled worker. */
function realSpawner(): Promise<MainThreadPort> {
  return Promise.resolve(new NodeMainThreadPort(new Worker(BUNDLE)));
}

describe.skipIf(!hasBundle)('Real worker integration (requires `npm run build`)', () => {
  it('a real worker_thread solves a model and returns the correct result', async () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 5, 'x');
    const y = m.newIntVar(0, 5, 'y');
    m.addAllDifferent([x, y]);
    m.maximize(x.add(y));

    const res = await solvePortfolio(m, { numWorkers: 1, spawner: realSpawner });
    expect(res.status).toBe(CpSolverStatus.OPTIMAL);
    expect(res.objectiveValue).toBe(9); // 5 + 4
    expect(res.solution?.get(x.index)).not.toBe(res.solution?.get(y.index));
  }, 15000);

  it('solvePortfolio with 3 real workers produces a sound solution', async () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 7, 'x');
    const y = m.newIntVar(0, 7, 'y');
    const z = m.newIntVar(0, 7, 'z');
    m.addAllDifferent([x, y, z]);
    m.maximize(x.add(y).add(z));

    const res = await solvePortfolio(m, { numWorkers: 3, spawner: realSpawner });
    expect([CpSolverStatus.OPTIMAL, CpSolverStatus.FEASIBLE]).toContain(res.status);
    expect(res.objectiveValue).not.toBeNull();
    // soundness: allDifferent satisfied
    const xv = res.solution!.get(x.index)!;
    const yv = res.solution!.get(y.index)!;
    const zv = res.solution!.get(z.index)!;
    expect(new Set([xv, yv, zv]).size).toBe(3);
    expect(xv + yv + zv).toBe(res.objectiveValue);
  }, 15000);

  it('portfolio with real workers matches a direct in-process solve', async () => {
    const m = new CpModel();
    const x = m.newIntVar(0, 9, 'x');
    const y = m.newIntVar(0, 9, 'y');
    m.addAllDifferent([x, y]);
    m.maximize(x.add(y));

    // Direct solve
    const direct = new CpSolver();
    direct.parameters = { randomSeed: 1 };
    const directStatus = direct.solve(m);

    // Portfolio solve (real workers, same model via clone for JSON round-trip)
    const portfolioRes = await solvePortfolio(m.clone(), { numWorkers: 2, spawner: realSpawner });

    expect(directStatus).toBe(CpSolverStatus.OPTIMAL);
    expect(portfolioRes.status).toBe(CpSolverStatus.OPTIMAL);
    expect(portfolioRes.objectiveValue).toBe(direct.objectiveValue);
  }, 15000);
});
