/// <reference types="vite/client" />
/**
 * Browser demo: solvePortfolio running natively in the browser via Web Workers.
 *
 * Vite's `?worker` import explicitly tells Vite to bundle worker-bootstrap as a
 * worker chunk (the generic `new URL(...)` pattern in spawn.ts isn't detected from
 * nested library imports — Vite's worker plugin only scans entry-point source).
 * The orchestrator's injectable `spawner` option receives this Vite-aware spawner.
 */
import { CpModel } from '../../../src/model';
import { solvePortfolio } from '../../../src/worker/portfolio';
import { BrowserMainThreadPort } from '../../../src/worker/port';
import type { BrowserWorkerHandle, MainThreadPort } from '../../../src/worker/port';
// Vite ?worker import — produces a Worker constructor bundled as a separate chunk.
import PortfolioWorker from '../../../src/worker/worker-bootstrap?worker';

/** Vite-aware spawner: creates a Worker via Vite's bundled chunk. */
async function viteSpawner(): Promise<MainThreadPort> {
  const worker = new PortfolioWorker();
  return new BrowserMainThreadPort(worker as unknown as BrowserWorkerHandle);
}

/** Small optimization model: maximize x+y with allDifferent (optimal = 9). */
function buildModel(): CpModel {
  const m = new CpModel();
  const x = m.newIntVar(0, 5, 'x');
  const y = m.newIntVar(0, 5, 'y');
  m.addAllDifferent([x, y]);
  m.maximize(x.add(y));
  return m;
}

const output = document.getElementById('output')!;
const portfolioBtn = document.getElementById('portfolio')!;
const singleBtn = document.getElementById('single')!;

function log(msg: string): void {
  output.textContent += msg + '\n';
}

portfolioBtn.addEventListener('click', async () => {
  output.textContent = '';
  portfolioBtn.disabled = true;
  log('Spawning 4-worker portfolio...');
  const t0 = performance.now();
  const res = await solvePortfolio(buildModel(), { numWorkers: 4, spawner: viteSpawner });
  const ms = (performance.now() - t0).toFixed(0);
  log('');
  log(`status   : ${res.status}`);
  log(`objective: ${res.objectiveValue}`);
  log(`bound    : ${res.bestObjectiveBound}`);
  log(`gap %    : ${res.gapPercent}`);
  log(`winner   : worker ${res.winningWorker}`);
  log(`time     : ${ms}ms`);
  portfolioBtn.disabled = false;
});

singleBtn.addEventListener('click', async () => {
  output.textContent = '';
  singleBtn.disabled = true;
  log('Single-worker solve...');
  const t0 = performance.now();
  const res = await solvePortfolio(buildModel(), { numWorkers: 1, spawner: viteSpawner });
  const ms = (performance.now() - t0).toFixed(0);
  log('');
  log(`status   : ${res.status}`);
  log(`objective: ${res.objectiveValue}`);
  log(`time     : ${ms}ms`);
  singleBtn.disabled = false;
});
