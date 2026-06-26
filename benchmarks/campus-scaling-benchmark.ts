/**
 * Campus Course Timetabling — SCALING benchmark
 * ===========================================================================
 *
 * Goal: find where the cp-sat-ts Boolean-matrix timetabling model stops
 * scaling, so improvement priorities can be chosen on data (not intuition).
 *
 * The instance generator + model builder replicate the EXACT constraint
 * structure of examples/campus-timetabling.ts:
 *   - sparse boolean matrix assign[s,l,r,p] for valid tuples only
 *   - exactlyOne lecturer per section (teach[s,l])
 *   - atMostOne per (room,period), (lecturer,period), (section,period),
 *     (section,day)
 *   - per-section linear sum == sessionsPerWeek
 *   - curriculum cap[course,period] <=> OR(section assigns), reified by hand,
 *     atMostOne per (package,period)
 *   - soft objective: penalise lecturer disliked hours
 *   - minimize
 *
 * Only the SIZE varies. This isolates "scale" from "modelling idiom".
 *
 * Run:  npx tsx benchmarks/campus-scaling-benchmark.ts
 */

import { CpModel, CpSolver, CpSolverStatus, LinearExpr, BoolVarImpl } from '../src';

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — reproducible instances
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng: () => number, n: number): number => Math.floor(rng() * n);
const randInt = (rng: () => number, lo: number, hi: number): number => lo + pick(rng, hi - lo + 1);
const sample = <T,>(rng: () => number, arr: T[], k: number): T[] => {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < k && copy.length; i++) out.push(copy.splice(pick(rng, copy.length), 1)[0]);
  return out;
};

// ---------------------------------------------------------------------------
// Time grid (identical to the example)
// ---------------------------------------------------------------------------
const HOURS = [8, 9, 10, 11, 13, 14, 15, 16];
const DAYS = 5;
interface Period { p: number; day: number; hour: number; }
const PERIODS: Period[] = [];
for (let day = 0; day < DAYS; day++)
  for (let h = 0; h < HOURS.length; h++)
    PERIODS.push({ p: day * HOURS.length + h, day, hour: HOURS[h] });

// ---------------------------------------------------------------------------
// Instance data
// ---------------------------------------------------------------------------
interface RoomDef { capacity: number; facilities: string[]; avail: number[]; }
interface LectDef { unavail: number[]; disliked: number[]; }
interface CourseDef { sessionsPerWeek: number; students: number; facilities: string[]; pkg: string; }
interface SectionDef { courseIdx: number; lecturers: number[]; }
interface Instance {
  rooms: RoomDef[]; lecturers: LectDef[]; courses: CourseDef[]; sections: SectionDef[];
}

/**
 * Generate a campus instance of ~N sections. Rooms/lecturers/courses scale
 * proportionally so resource *density* is roughly constant.
 *
 * FEASIBILITY-GUARANTEED by construction: all rooms are full-availability and
 * large enough for any course, courses require no facility, and lecturers are
 * always available. This removes the capacity/facility/availability *matching*
 * bottleneck (which made an earlier random generator provably INFEASIBLE at
 * N>=25). What remains is the combinatorial timetabling core we actually want
 * to scale: room/lecturer/section non-overlap, curriculum (pkg) exclusivity,
 * day-spreading, and the disliked-hour objective.
 */
export function generateInstance(seed: number, N: number): Instance {
  const rng = mulberry32(seed);
  const numRooms = Math.ceil(N / 3);
  const numLecturers = Math.max(4, Math.ceil(N / 3.5));
  const numCourses = Math.max(4, Math.ceil(N / 2.5));
  const numPkgs = Math.max(2, Math.ceil(numCourses / 3));

  // Heterogeneous preferences (per-lecturer random disliked hours) break the
  // symmetry that an earlier uniform generator created — uniform instances make
  // naive MRV search flail among equivalent assignments. Feasibility stays
  // guaranteed (rooms big enough, all available, no facility needs).
  const rooms: RoomDef[] = [];
  for (let r = 0; r < numRooms; r++) {
    rooms.push({ capacity: 100, facilities: [], avail: [...HOURS] });
  }

  const lecturers: LectDef[] = [];
  for (let l = 0; l < numLecturers; l++) {
    lecturers.push({ unavail: [], disliked: sample(rng, HOURS, randInt(rng, 0, 2)) });
  }

  const courses: CourseDef[] = [];
  for (let c = 0; c < numCourses; c++) {
    courses.push({
      sessionsPerWeek: rng() < 0.5 ? 1 : 2,
      students: randInt(rng, 20, 90),
      facilities: [],
      pkg: `pkg${pick(rng, numPkgs)}`,
    });
  }

  const sections: SectionDef[] = [];
  for (let s = 0; s < N; s++) {
    const courseIdx = pick(rng, numCourses);
    const k = Math.min(2, numLecturers);
    sections.push({ courseIdx, lecturers: sample(rng, [...Array(numLecturers).keys()], k) });
  }

  return { rooms, lecturers, courses, sections };
}

// ---------------------------------------------------------------------------
// Model builder (mirrors examples/campus-timetabling.ts buildModel)
// ---------------------------------------------------------------------------
interface BuiltModel { model: CpModel; numBoolVars: number; numConstraints: number; }

function validTuple(
  inst: Instance, s: number, l: number, r: number, p: number
): boolean {
  const sec = inst.sections[s];
  const course = inst.courses[sec.courseIdx];
  const room = inst.rooms[r];
  const lect = inst.lecturers[l];
  const per = PERIODS[p];
  if (!sec.lecturers.includes(l)) return false;
  if (room.capacity < course.students) return false;
  for (const f of course.facilities) if (!room.facilities.includes(f)) return false;
  if (!room.avail.includes(per.hour)) return false;
  if (lect.unavail.includes(per.hour)) return false;
  return true;
}

/** Hand-built reification result <=> OR(lits) (no onlyEnforceIf available). */
function reifyOr(model: CpModel, result: BoolVarImpl, lits: BoolVarImpl[]): void {
  if (lits.length === 0) { model.add(result.le(0)); return; }
  let sum: LinearExpr = LinearExpr.fromConstant(0);
  for (const lit of lits) sum = sum.add(lit);
  model.addLinearConstraint(sum.sub(result), 0, lits.length);
  for (const lit of lits) model.addImplication(lit, result);
}

export function buildModel(inst: Instance, withObjective = true): BuiltModel {
  const model = new CpModel();

  // teach[s,l] exactlyOne per section
  const teach = new Map<string, BoolVarImpl>();
  for (let s = 0; s < inst.sections.length; s++) {
    const eligible: BoolVarImpl[] = [];
    for (const l of inst.sections[s].lecturers) {
      const t = model.newBoolVar(`t_${s}_${l}`);
      teach.set(`${s}|${l}`, t);
      eligible.push(t);
    }
    model.addExactlyOne(eligible);
  }

  const assign = new Map<string, BoolVarImpl>();
  const byRoomPeriod = new Map<string, BoolVarImpl[]>();
  const byLectPeriod = new Map<string, BoolVarImpl[]>();
  const bySectionPeriod = new Map<string, BoolVarImpl[]>();
  const bySectionDay = new Map<string, BoolVarImpl[]>();
  const byCoursePeriod = new Map<string, BoolVarImpl[]>();
  const bySectionTerms: BoolVarImpl[][] = Array.from({ length: inst.sections.length }, () => []);

  const push = (m: Map<string, BoolVarImpl[]>, k: string, v: BoolVarImpl) => {
    const arr = m.get(k);
    if (arr) arr.push(v); else m.set(k, [v]);
  };

  for (let s = 0; s < inst.sections.length; s++) {
    const courseIdx = inst.sections[s].courseIdx;
    for (const l of inst.sections[s].lecturers) {
      const teachVar = teach.get(`${s}|${l}`)!;
      for (let r = 0; r < inst.rooms.length; r++) {
        for (let p = 0; p < PERIODS.length; p++) {
          if (!validTuple(inst, s, l, r, p)) continue;
          const v = model.newBoolVar(`a_${s}_${l}_${r}_${p}`);
          assign.set(`${s}|${l}|${r}|${p}`, v);
          model.addImplication(v, teachVar);
          push(byRoomPeriod, `${r}|${p}`, v);
          push(byLectPeriod, `${l}|${p}`, v);
          push(bySectionPeriod, `${s}|${p}`, v);
          push(bySectionDay, `${s}|${PERIODS[p].day}`, v);
          push(byCoursePeriod, `${courseIdx}|${p}`, v);
          bySectionTerms[s].push(v);
        }
      }
    }
  }

  for (const arr of byRoomPeriod.values()) model.addAtMostOne(arr);
  for (const arr of byLectPeriod.values()) model.addAtMostOne(arr);
  for (const arr of bySectionPeriod.values()) model.addAtMostOne(arr);
  for (const arr of bySectionDay.values()) model.addAtMostOne(arr);

  for (let s = 0; s < inst.sections.length; s++) {
    const terms = bySectionTerms[s];
    if (terms.length === 0) continue;
    const k = inst.courses[inst.sections[s].courseIdx].sessionsPerWeek;
    let sum: LinearExpr = LinearExpr.fromConstant(0);
    for (const t of terms) sum = sum.add(t);
    model.addLinearConstraint(sum, k, k);
  }

  // curriculum cap[course,p] <=> OR(section assigns)
  const cap = new Map<string, BoolVarImpl>();
  for (const [cpKey, lits] of byCoursePeriod) {
    const capVar = model.newBoolVar(`cap_${cpKey}`);
    cap.set(cpKey, capVar);
    reifyOr(model, capVar, lits);
  }
  const byPkgPeriod = new Map<string, BoolVarImpl[]>();
  for (const [cpKey, capVar] of cap) {
    const [cStr, pStr] = cpKey.split('|');
    const pkg = inst.courses[Number(cStr)].pkg;
    const pk = `${pkg}|${pStr}`;
    const arr = byPkgPeriod.get(pk);
    if (arr) arr.push(capVar); else byPkgPeriod.set(pk, [capVar]);
  }
  for (const arr of byPkgPeriod.values()) model.addAtMostOne(arr);

  // soft objective: lecturer disliked hours
  let obj: LinearExpr = LinearExpr.fromConstant(0);
  for (let l = 0; l < inst.lecturers.length; l++) {
    if (inst.lecturers[l].disliked.length === 0) continue;
    for (let p = 0; p < PERIODS.length; p++) {
      if (!inst.lecturers[l].disliked.includes(PERIODS[p].hour)) continue;
      const vars = byLectPeriod.get(`${l}|${p}`);
      if (vars) for (const v of vars) obj = obj.add(v);
    }
  }
  if (withObjective) model.minimize(obj);

  return {
    model,
    numBoolVars: model.registry.allBoolVars.length,
    numConstraints: model.constraints.length,
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
interface Row {
  N: number; status: string; buildMs: number; wallMs: number; searchMs: number;
  branches: number; conflicts: number; solutions: number; objective: number;
  boolVars: number; constraints: number; learned: number; intBoundLits: number;
}

export function runOne(inst: Instance, enableLcg: boolean, timeoutS: number): Row {
  const t0 = Date.now();
  const built = buildModel(inst);
  const buildMs = Date.now() - t0;

  const solver = new CpSolver();
  solver.parameters = { maxTimeInSeconds: timeoutS, enableLcg } as never;
  const status = solver.solve(built.model);

  return {
    N: inst.sections.length,
    status: CpSolverStatus[status],
    buildMs,
    wallMs: Math.round(solver.wallTime * 1000),
    searchMs: Math.round(solver.searchTime * 1000),
    branches: solver.numBranches,
    conflicts: solver.numConflicts,
    solutions: solver.numSolutions,
    objective: status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE ? solver.objectiveValue : NaN,
    boolVars: built.numBoolVars,
    constraints: built.numConstraints,
    learned: solver.numLearnedClauses,
    intBoundLits: solver.numIntBoundLiterals,
  };
}

const fmt = (n: number): string => (Number.isFinite(n) ? n.toLocaleString() : '-');

function printTable(title: string, rows: Row[]): void {
  console.log(`\n=== ${title} ===`);
  console.log(
    ['N', 'status', 'boolVars', 'constr', 'build(s)', 'wall(s)', 'search(s)', 'branches', 'conflicts', 'obj', 'learned'].join('\t')
  );
  for (const r of rows) {
    console.log([
      r.N,
      r.status,
      fmt(r.boolVars),
      fmt(r.constraints),
      (r.buildMs / 1000).toFixed(2),
      (r.wallMs / 1000).toFixed(2),
      (r.searchMs / 1000).toFixed(2),
      fmt(r.branches),
      fmt(r.conflicts),
      Number.isFinite(r.objective) ? r.objective : '-',
      fmt(r.learned),
    ].join('\t'));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export function main(): void {
  const SEED = 42;
  // Working regime only — the N>=100 propagation choke/hang is documented
  // separately (timeout is not honoured mid-propagation). Feasibility-guaranteed
  // generator, so every size here is solvable.
  const SIZES = [10, 20, 30, 40, 50, 75];
  const TIMEOUT = 20;

  console.log('Campus timetabling SCALING benchmark (Boolean-matrix model)');
  console.log(`seed=${SEED}  timeout=${TIMEOUT}s/size  periods=${PERIODS.length}  enableLcg=OFF (default)`);

  // Phase 1: scaling sweep (LCG off — the default the example would run with).
  const sweep: Row[] = [];
  for (const N of SIZES) {
    process.stdout.write(`  building+solving N=${N} ...`);
    const inst = generateInstance(SEED, N);
    const r = runOne(inst, false, TIMEOUT);
    sweep.push(r);
    console.log(` ${r.status} wall=${(r.wallMs / 1000).toFixed(2)}s vars=${fmt(r.boolVars)}`);
  }
  printTable('SCALING SWEEP (enableLcg OFF)', sweep);

  // Phase 2: enableLcg ON/OFF at two representative sizes.
  console.log('\n=== enableLcg ON vs OFF (clause-learning inert check) ===');
  for (const N of [30, 50]) {
    const inst = generateInstance(SEED, N);
    const off = runOne(inst, false, TIMEOUT);
    const on = runOne(inst, true, TIMEOUT);
    console.log(`\nN=${N}  boolVars=${fmt(off.boolVars)}  constraints=${fmt(off.constraints)}`);
    console.log(`  OFF: ${off.status.padEnd(10)} wall=${(off.wallMs / 1000).toFixed(2)}s  branches=${fmt(off.branches)}  conflicts=${fmt(off.conflicts)}  learned=${fmt(off.learned)}`);
    console.log(`  ON : ${on.status.padEnd(10)} wall=${(on.wallMs / 1000).toFixed(2)}s  branches=${fmt(on.branches)}  conflicts=${fmt(on.conflicts)}  learned=${fmt(on.learned)}  intBoundLits=${fmt(on.intBoundLits)}`);
  }
}

// Run only when executed directly (not when imported as a module). The
// `typeof require` guard keeps this import-safe under ESM loaders (vitest),
// where `require` is undefined.
if (typeof require !== 'undefined' && require.main === module) main();
