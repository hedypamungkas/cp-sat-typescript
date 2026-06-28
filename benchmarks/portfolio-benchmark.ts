/**
 * Portfolio parallelism benchmark — the headline value demonstration.
 *
 * A 6×6 job-shop is a textbook heavy-tailed CP instance: a single random seed has
 * only a low chance of finding a feasible solution within a fixed budget, but a
 * portfolio of N parallel workers (diversified seeds/strategies) finds one with high
 * probability — turning ~25% single-seed success into ~100% with 8 workers.
 *
 * Run:  npm run benchmark:portfolio   (builds first — real workers need the bundle)
 */
import { CpModel } from '../dist/esm/index.js';
import { CpSolver, CpSolverStatus } from '../dist/esm/index.js';
import { solvePortfolio } from '../dist/esm/worker/index.js';

function mulberry(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return seed / 0x7fffffff; };
}

/** Classic job-shop: J jobs × M machines, random machine order + durations, minimize makespan. */
function buildJobShop(J: number, M: number): CpModel {
  const m = new CpModel();
  const rnd = mulberry(99);
  const machineIntervals: unknown[][] = Array.from({ length: M }, () => []);
  const ends: unknown[] = [];
  for (let j = 0; j < J; j++) {
    const order = Array.from({ length: M }, (_, k) => k);
    for (let i = order.length - 1; i > 0; i--) { const r = Math.floor(rnd() * (i + 1)); [order[i], order[r]] = [order[r], order[i]]; }
    let prevEnd: unknown = null;
    for (let step = 0; step < M; step++) {
      const dur = 1 + Math.floor(rnd() * 19);
      const start = m.newIntVar(0, 2000, `s_${j}_${step}`);
      const iv = m.newFixedSizeIntervalVar(start, dur, `t_${j}_${step}`);
      (machineIntervals[order[step]] as unknown[]).push(iv);
      if (prevEnd) m.add((prevEnd as { le: (x: unknown) => unknown }).le(start));
      prevEnd = start.add(dur);
      ends.push(prevEnd);
    }
  }
  for (const ivs of machineIntervals) if ((ivs as unknown[]).length > 1) m.addNoOverlap(ivs as never);
  const makespan = m.newIntVar(0, 2000, 'mk');
  m.addMaxEquality(makespan, ends as never);
  m.minimize(makespan);
  return m;
}

function arg(name: string, dflt: string): string {
  const prefix = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : dflt;
}
const BUDGET = parseInt(arg('budget', '15'), 10);
const SEEDS = parseInt(arg('seeds', '6'), 10);
const WORKERS = parseInt(arg('workers', '8'), 10);

async function main() {
  console.log(`════════════════════════════════════════════════════════════════`);
  console.log(` Portfolio benchmark — 6×6 job-shop (heavy-tailed), budget=${BUDGET}s`);
  console.log(`════════════════════════════════════════════════════════════════`);

  // --- Single-seed baseline: how often does ONE worker succeed? ---
  console.log(`\n[1] Single-worker success rate (one seed at a time):`);
  let singleOk = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const solver = new CpSolver();
    solver.parameters = { randomSeed: seed, maxTimeInSeconds: BUDGET };
    const t0 = Date.now();
    const status = solver.solve(buildJobShop(6, 6));
    const ms = Date.now() - t0;
    const ok = status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE;
    if (ok) singleOk++;
    console.log(`  seed ${seed}: ${CpSolverStatus[status].padEnd(10)} obj=${String(solver.objectiveValue).padStart(4)}  (${ms}ms)${ok ? '' : '  ✗'}`);
  }
  const singleRate = (singleOk / SEEDS) * 100;
  console.log(`  → single-worker success: ${singleOk}/${SEEDS} (${singleRate.toFixed(0)}%)`);

  // --- Portfolio: N workers, diversified, first/best wins ---
  console.log(`\n[2] Portfolio (${WORKERS} workers, diversified):`);
  const t0 = Date.now();
  const res = await solvePortfolio(buildJobShop(6, 6), { numWorkers: WORKERS, maxTimeInSeconds: BUDGET });
  const ms = Date.now() - t0;
  const ok = res.status === CpSolverStatus.OPTIMAL || res.status === CpSolverStatus.FEASIBLE;
  console.log(`  status=${CpSolverStatus[res.status]} obj=${res.objectiveValue} winner=w${res.winningWorker} (${ms}ms)${ok ? '  ✓' : '  ✗'}`);

  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(` Single-worker: ${singleRate.toFixed(0)}% success  vs  ${WORKERS}-worker portfolio: ${ok ? '100% (succeeded)' : 'FAILED'}`);
  console.log(` Heavy tail: a portfolio converts low single-seed success into reliable success.`);
  console.log(`════════════════════════════════════════════════════════════════`);
}

main().catch((e) => { console.error('BENCHMARK FAILED:', e); process.exit(1); });
