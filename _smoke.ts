import { generateInstance, buildModel, runOne } from './benchmarks/campus-scaling-benchmark';
for (const N of [10, 25]) {
  const inst = generateInstance(42, N);
  const r = runOne(inst, false, 10);
  console.log(`N=${N}: status=${r.status} boolVars=${r.boolVars} constr=${r.constraints} build=${(r.buildMs/1000).toFixed(2)}s wall=${(r.wallMs/1000).toFixed(2)}s obj=${r.objective}`);
}
