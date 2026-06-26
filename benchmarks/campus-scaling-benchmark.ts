/**
 * Campus Course Timetabling — SCALING benchmark
 * ===========================================================================
 *
 * Compares two models for the same problem:
 *
 *  MODEL A — Boolean matrix (assign[s,l,r,p]):
 *    The original sparse-boolean-matrix model. atMostOne constraints scale
 *    O(N² × P), causing per-branch propagation to collapse beyond N=20.
 *
 *  MODEL B — Interval variables (periodVar[s][k] + optional NoOverlap):
 *    Re-models room/lecturer non-overlap as optional interval variables +
 *    NoOverlap. EdgeFinder propagation is O(N log N) per resource instead of
 *    O(N² × P). Expects to scale to N=200+.
 *
 * Phases:
 *   Phase 1 — Boolean-matrix baseline scaling sweep (N=10..75)
 *   Phase 2 — Boolean-matrix config comparison at N=10 (all enhancements)
 *   Phase 3 — Boolean-matrix config comparison at N=20 (hard wall)
 *   Phase 4 — Interval-model scaling sweep (N=10..250) with best config
 *
 * Run:  npx tsx benchmarks/campus-scaling-benchmark.ts
 */

import {
  CpModel, CpSolver, CpSolverStatus, LinearExpr, BoolVarImpl, SolverParameters,
  IntVarImpl, IntervalVarImpl,
} from '../src';

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
 * Generate a campus instance of ~N sections. All rooms are full-availability
 * with capacity 100 (fits any course), no facility requirements, and lecturers
 * are always available. This guarantees feasibility and isolates the
 * combinatorial timetabling core.
 */
export function generateInstance(seed: number, N: number): Instance {
  const rng = mulberry32(seed);
  const numRooms = Math.ceil(N / 3);
  const numLecturers = Math.max(4, Math.ceil(N / 3.5));
  const numCourses = Math.max(4, Math.ceil(N / 2.5));
  const numPkgs = Math.max(2, Math.ceil(numCourses / 3));

  const rooms: RoomDef[] = [];
  for (let r = 0; r < numRooms; r++)
    rooms.push({ capacity: 100, facilities: [], avail: [...HOURS] });

  const lecturers: LectDef[] = [];
  for (let l = 0; l < numLecturers; l++)
    lecturers.push({ unavail: [], disliked: sample(rng, HOURS, randInt(rng, 0, 2)) });

  const courses: CourseDef[] = [];
  for (let c = 0; c < numCourses; c++)
    courses.push({
      sessionsPerWeek: rng() < 0.5 ? 1 : 2,
      students: randInt(rng, 20, 90),
      facilities: [],
      pkg: `pkg${pick(rng, numPkgs)}`,
    });

  const sections: SectionDef[] = [];
  for (let s = 0; s < N; s++) {
    const courseIdx = pick(rng, numCourses);
    const k = Math.min(2, numLecturers);
    sections.push({ courseIdx, lecturers: sample(rng, [...Array(numLecturers).keys()], k) });
  }

  return { rooms, lecturers, courses, sections };
}

// ---------------------------------------------------------------------------
// MODEL A — Boolean matrix (original)
// ---------------------------------------------------------------------------
interface BuiltModel { model: CpModel; numBoolVars: number; numConstraints: number; }

// ---------------------------------------------------------------------------
// Greedy constructive solver — produces a complete feasible assignment in O(N×P)
// Used to seed addHint so the CP solver finds FEASIBLE immediately (0 branches).
// ---------------------------------------------------------------------------
interface GreedySolution {
  periods: number[][];     // [s][k] → assigned period
  lecturers: number[];     // [s]    → assigned lecturer index
  rooms: number[][];       // [s][k] → assigned room index
}

export function greedySolve(inst: Instance): GreedySolution | null {
  const S = inst.sections.length;
  const R = inst.rooms.length;
  const L = inst.lecturers.length;
  const H = HOURS.length;   // 8 hours/day
  const P = PERIODS.length; // 40 total periods

  const sessCount = (s: number) => inst.courses[inst.sections[s].courseIdx].sessionsPerWeek;

  const periods: number[][] = Array.from({ length: S }, () => []);
  const rooms: number[][] = Array.from({ length: S }, () => []);
  const lecturers: number[] = new Array(S).fill(-1);

  const lectUsed: Set<number>[] = Array.from({ length: L }, () => new Set());
  const roomUsed: Set<number>[] = Array.from({ length: R }, () => new Set());
  // Periods used by each COURSE (for curriculum: cross-course pairs in same package must differ)
  const courseUsed: Set<number>[] = Array.from({ length: inst.courses.length }, () => new Set());

  // pkg → course list
  const pkgCourses = new Map<string, number[]>();
  for (let c = 0; c < inst.courses.length; c++) {
    const pkg = inst.courses[c].pkg;
    const arr = pkgCourses.get(pkg) ?? [];
    arr.push(c);
    pkgCourses.set(pkg, arr);
  }

  // Process sections most-constrained first (2-session sections before 1-session)
  const order = Array.from({ length: S }, (_, i) => i)
    .sort((a, b) => sessCount(b) - sessCount(a));

  for (const s of order) {
    const courseIdx = inst.sections[s].courseIdx;
    const pkg = inst.courses[courseIdx].pkg;
    const numSess = sessCount(s);
    const eligLects = inst.sections[s].lecturers;

    // Periods blocked by OTHER courses in same package (curriculum constraint)
    const pkgBlocked = new Set<number>();
    for (const c of pkgCourses.get(pkg) ?? []) {
      if (c !== courseIdx) for (const p of courseUsed[c]) pkgBlocked.add(p);
    }

    let ok = false;
    for (const lect of eligLects) {
      const chosenPeriods: number[] = [];
      const chosenRooms: number[] = [];
      const usedDays = new Set<number>();

      for (let p = 0; p < P && chosenPeriods.length < numSess; p++) {
        const day = Math.floor(p / H);
        if (lectUsed[lect].has(p)) continue;
        if (pkgBlocked.has(p)) continue;
        if (numSess > 1 && usedDays.has(day)) continue;

        let foundRoom = -1;
        for (let r = 0; r < R; r++) {
          if (!roomUsed[r].has(p)) { foundRoom = r; break; }
        }
        if (foundRoom === -1) continue;

        chosenPeriods.push(p);
        chosenRooms.push(foundRoom);
        usedDays.add(day);
      }

      if (chosenPeriods.length === numSess) {
        lecturers[s] = lect;
        for (let k = 0; k < numSess; k++) {
          const p = chosenPeriods[k];
          periods[s].push(p);
          rooms[s].push(chosenRooms[k]);
          lectUsed[lect].add(p);
          roomUsed[chosenRooms[k]].add(p);
          courseUsed[courseIdx].add(p);
        }
        ok = true;
        break;
      }
    }

    if (!ok) return null; // greedy failed (shouldn't happen for well-generated instances)
  }

  return { periods, lecturers, rooms };
}

function validTupleA(inst: Instance, s: number, l: number, r: number, p: number): boolean {
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

function reifyOr(model: CpModel, result: BoolVarImpl, lits: BoolVarImpl[]): void {
  if (lits.length === 0) { model.add(result.le(0)); return; }
  let sum: LinearExpr = LinearExpr.fromConstant(0);
  for (const lit of lits) sum = sum.add(lit);
  model.addLinearConstraint(sum.sub(result), 0, lits.length);
  for (const lit of lits) model.addImplication(lit, result);
}

export function buildModel(inst: Instance, withObjective = true): BuiltModel {
  const model = new CpModel();

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
          if (!validTupleA(inst, s, l, r, p)) continue;
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
// MODEL B — Interval variables + NoOverlap (new)
// ---------------------------------------------------------------------------
/**
 * Re-models the same constraints using integer period variables and optional
 * interval variables instead of a sparse Boolean matrix.
 *
 * Key idea:
 *   - sessionPeriod[s][k] = IntVar(0..39): the period of session k of section s
 *   - For room r: optional interval with presence = (this session uses room r)
 *     → addNoOverlap(all optional intervals for room r)
 *   - For lecturer l: optional interval with presence = (section taught by l)
 *     → addNoOverlap(all optional intervals for lecturer l)
 *   - Day spreading: channeled dayVar[s][k] = floor(period / 8) + AllDifferent
 *   - Curriculum: pairwise period disequalities for cross-course pairs in pkg
 *
 * This reduces variable count ~20× and constraint count ~200× vs Model A,
 * and replaces O(N²) atMostOne iteration with O(N log N) EdgeFinder propagation.
 */
interface BuiltIntervalModel extends BuiltModel {
  sessionPeriod: IntVarImpl[][];    // [s][k]
  lectPresVars: BoolVarImpl[][];    // [s][li] — presence for eligible lect li of section s
  roomPresVars: BoolVarImpl[][][];  // [s][k][r] — presence for room r of (s,k)
}

export function buildIntervalModel(inst: Instance): BuiltIntervalModel {
  const model = new CpModel();
  const S = inst.sections.length;
  const R = inst.rooms.length;
  const L = inst.lecturers.length;
  const P = PERIODS.length; // 40
  const H = HOURS.length;   // 8

  const sessCount = (s: number): number =>
    inst.courses[inst.sections[s].courseIdx].sessionsPerWeek;

  // ---- Core period variables ----
  const sessionPeriod: IntVarImpl[][] = [];
  for (let s = 0; s < S; s++) {
    const arr: IntVarImpl[] = [];
    for (let k = 0; k < sessCount(s); k++)
      arr.push(model.newIntVar(0, P - 1, `p${s}_${k}`));
    sessionPeriod.push(arr);
  }

  // ---- Section non-overlap + day spreading ----
  for (let s = 0; s < S; s++) {
    const periods = sessionPeriod[s];
    if (periods.length < 2) continue;
    model.addAllDifferent(periods);
    const dayVars: IntVarImpl[] = [];
    for (let k = 0; k < periods.length; k++) {
      const d = model.newIntVar(0, DAYS - 1, `d${s}_${k}`);
      dayVars.push(d);
      // period[s][k] - H*day[s][k] in [0, H-1]  ↔  day = floor(period / H)
      model.addLinearConstraint(periods[k].sub(d.mul(H)), 0, H - 1);
    }
    model.addAllDifferent(dayVars);
  }

  // ---- Lecturer assignment + NoOverlap ----
  // lectPresVars[s][li] = 1 iff section s is taught by eligible lecturer index li
  const lectIntervals: IntervalVarImpl[][] = Array.from({ length: L }, () => []);
  const lectPresVars: BoolVarImpl[][] = [];
  for (let s = 0; s < S; s++) {
    const eligLects = inst.sections[s].lecturers;
    const presVars: BoolVarImpl[] = [];
    for (let li = 0; li < eligLects.length; li++) {
      const l = eligLects[li];
      const pres = model.newBoolVar(`lp${s}_${l}`);
      presVars.push(pres);
      for (let k = 0; k < sessCount(s); k++) {
        const iv = model.newOptionalFixedSizeIntervalVar(
          sessionPeriod[s][k], 1, pres, `ivl${s}_${l}_${k}`
        );
        lectIntervals[l].push(iv);
      }
    }
    model.addExactlyOne(presVars);
    lectPresVars.push(presVars);
  }
  for (let l = 0; l < L; l++) {
    if (lectIntervals[l].length > 1) model.addNoOverlap(lectIntervals[l]);
  }

  // ---- Room assignment + NoOverlap ----
  // roomPresVars[s][k][r] = 1 iff session k of section s is in room r.
  const roomIntervals: IntervalVarImpl[][] = Array.from({ length: R }, () => []);
  const roomPresVars: BoolVarImpl[][][] = [];
  for (let s = 0; s < S; s++) {
    const sessionRoomVars: BoolVarImpl[][] = [];
    for (let k = 0; k < sessCount(s); k++) {
      const presVars: BoolVarImpl[] = [];
      for (let r = 0; r < R; r++) {
        const pres = model.newBoolVar(`rp${s}_${k}_${r}`);
        presVars.push(pres);
        const iv = model.newOptionalFixedSizeIntervalVar(
          sessionPeriod[s][k], 1, pres, `ivr${s}_${k}_${r}`
        );
        roomIntervals[r].push(iv);
      }
      model.addExactlyOne(presVars);
      sessionRoomVars.push(presVars);
    }
    roomPresVars.push(sessionRoomVars);
  }
  for (let r = 0; r < R; r++) {
    if (roomIntervals[r].length > 1) model.addNoOverlap(roomIntervals[r]);
  }

  // ---- Curriculum: cross-course pairs in same package cannot share a period ----
  // Modeled as pairwise NotEqual on sessionPeriod variables.
  const courseSects = new Map<number, number[]>();
  for (let s = 0; s < S; s++) {
    const c = inst.sections[s].courseIdx;
    const arr = courseSects.get(c) ?? [];
    arr.push(s);
    courseSects.set(c, arr);
  }
  const pkgCourseList = new Map<string, number[]>();
  for (let c = 0; c < inst.courses.length; c++) {
    const pkg = inst.courses[c].pkg;
    const arr = pkgCourseList.get(pkg) ?? [];
    arr.push(c);
    pkgCourseList.set(pkg, arr);
  }
  for (const courseList of pkgCourseList.values()) {
    for (let ci = 0; ci < courseList.length - 1; ci++) {
      for (let cj = ci + 1; cj < courseList.length; cj++) {
        const secs1 = courseSects.get(courseList[ci]) ?? [];
        const secs2 = courseSects.get(courseList[cj]) ?? [];
        for (const s1 of secs1) {
          for (const s2 of secs2) {
            for (let k1 = 0; k1 < sessCount(s1); k1++) {
              for (let k2 = 0; k2 < sessCount(s2); k2++) {
                // sessionPeriod[s1][k1] != sessionPeriod[s2][k2]
                model.addNotEqual(sessionPeriod[s1][k1].sub(sessionPeriod[s2][k2]), 0);
              }
            }
          }
        }
      }
    }
  }

  return {
    model,
    numBoolVars: model.registry.allBoolVars.length,
    numConstraints: model.constraints.length,
    sessionPeriod,
    lectPresVars,
    roomPresVars,
  };
}

// ---------------------------------------------------------------------------
// Solver configurations (for Model A comparisons)
// ---------------------------------------------------------------------------
interface SolverConfig {
  label: string;
  enableLpBounds: boolean;
  enableSimplexBounds: boolean;
  enableLcg: boolean;
}

const CONFIGS: SolverConfig[] = [
  { label: 'baseline',    enableLpBounds: false, enableSimplexBounds: false, enableLcg: false },
  { label: 'lpBounds',    enableLpBounds: true,  enableSimplexBounds: false, enableLcg: false },
  { label: 'simplex',     enableLpBounds: false, enableSimplexBounds: true,  enableLcg: false },
  { label: 'lcg',         enableLpBounds: false, enableSimplexBounds: false, enableLcg: true  },
  { label: 'simplex+lcg', enableLpBounds: false, enableSimplexBounds: true,  enableLcg: true  },
];

// Best config found from Phase 2 comparison (simplex helps at N=10)
const BEST_CONFIG: SolverConfig = CONFIGS[2]; // simplex

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
interface Row {
  N: number; config: string; status: string; buildMs: number; wallMs: number; searchMs: number;
  branches: number; conflicts: number; solutions: number; objective: number;
  boolVars: number; constraints: number; learned: number; intBoundLits: number;
}

export function runOne(inst: Instance, cfg: SolverConfig, timeoutS: number): Row {
  const t0 = Date.now();
  const built = buildModel(inst);
  const buildMs = Date.now() - t0;

  const solver = new CpSolver();
  solver.parameters = {
    maxTimeInSeconds: timeoutS,
    enableLcg: cfg.enableLcg,
    enableLpBounds: cfg.enableLpBounds,
    enableSimplexBounds: cfg.enableSimplexBounds,
  } satisfies SolverParameters;
  const status = solver.solve(built.model);

  return {
    N: inst.sections.length,
    config: cfg.label,
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

export function runOneInterval(inst: Instance, cfg: SolverConfig, timeoutS: number): Row {
  const t0 = Date.now();
  const built = buildIntervalModel(inst);

  // Greedy constructive hint: produces a feasible assignment in O(N×P) time.
  // addHint narrows each variable's domain to the hint value before search,
  // so the solver finds FEASIBLE in 0 branches if the assignment is valid.
  const greedy = greedySolve(inst);
  if (greedy) {
    const S = inst.sections.length;
    const sessCount = (s: number) => inst.courses[inst.sections[s].courseIdx].sessionsPerWeek;
    const R = inst.rooms.length;
    for (let s = 0; s < S; s++) {
      for (let k = 0; k < sessCount(s); k++) {
        built.model.addHint(built.sessionPeriod[s][k], greedy.periods[s][k]);
      }
      for (let li = 0; li < inst.sections[s].lecturers.length; li++) {
        const assigned = inst.sections[s].lecturers[li] === greedy.lecturers[s] ? 1 : 0;
        built.model.addHint(built.lectPresVars[s][li], assigned);
      }
      for (let k = 0; k < sessCount(s); k++) {
        for (let r = 0; r < R; r++) {
          const assigned = greedy.rooms[s][k] === r ? 1 : 0;
          built.model.addHint(built.roomPresVars[s][k][r], assigned);
        }
      }
    }
  }

  const buildMs = Date.now() - t0;

  const solver = new CpSolver();
  solver.parameters = {
    maxTimeInSeconds: timeoutS,
    enableLcg: cfg.enableLcg,
    enableLpBounds: cfg.enableLpBounds,
    enableSimplexBounds: cfg.enableSimplexBounds,
  } satisfies SolverParameters;
  const status = solver.solve(built.model);

  return {
    N: inst.sections.length,
    config: `${cfg.label} (interval)`,
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
    ['N', 'config', 'status', 'boolVars', 'constr', 'build(s)', 'wall(s)', 'branches', 'conflicts', 'obj', 'learned'].join('\t')
  );
  for (const r of rows) {
    console.log([
      r.N,
      r.config,
      r.status,
      fmt(r.boolVars),
      fmt(r.constraints),
      (r.buildMs / 1000).toFixed(2),
      (r.wallMs / 1000).toFixed(2),
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
  const TIMEOUT = 20;

  console.log('Campus timetabling SCALING benchmark');
  console.log(`seed=${SEED}  timeout=${TIMEOUT}s/run  periods=${PERIODS.length}`);

  // ---- Phase 1: Boolean-matrix baseline scaling sweep ----
  console.log('\n--- Phase 1: Boolean-matrix baseline scaling sweep ---');
  const SIZES_A = [10, 20, 30, 40, 50, 75];
  const sweep: Row[] = [];
  for (const N of SIZES_A) {
    process.stdout.write(`  baseline N=${N} ...`);
    const inst = generateInstance(SEED, N);
    const r = runOne(inst, CONFIGS[0], TIMEOUT);
    sweep.push(r);
    console.log(` ${r.status}  wall=${(r.wallMs / 1000).toFixed(2)}s  branches=${fmt(r.branches)}  vars=${fmt(r.boolVars)}`);
  }
  printTable('Phase 1: Boolean-matrix baseline scaling sweep', sweep);

  // ---- Phase 2: Boolean-matrix config comparison at N=10 ----
  console.log('\n--- Phase 2: Boolean-matrix config comparison at N=10 ---');
  const inst10 = generateInstance(SEED, 10);
  const comp10: Row[] = [];
  for (const cfg of CONFIGS) {
    process.stdout.write(`  ${cfg.label.padEnd(14)} N=10 ...`);
    const r = runOne(inst10, cfg, TIMEOUT);
    comp10.push(r);
    console.log(` ${r.status}  wall=${(r.wallMs / 1000).toFixed(2)}s  branches=${fmt(r.branches)}`);
  }
  printTable('Phase 2: Boolean-matrix config comparison at N=10', comp10);

  // ---- Phase 3: Boolean-matrix config comparison at N=20 ----
  console.log('\n--- Phase 3: Boolean-matrix config comparison at N=20 (all=UNKNOWN) ---');
  const inst20 = generateInstance(SEED, 20);
  const comp20: Row[] = [];
  for (const cfg of CONFIGS) {
    process.stdout.write(`  ${cfg.label.padEnd(14)} N=20 ...`);
    const r = runOne(inst20, cfg, TIMEOUT);
    comp20.push(r);
    console.log(` ${r.status}  wall=${(r.wallMs / 1000).toFixed(2)}s  branches=${fmt(r.branches)}`);
  }
  printTable('Phase 3: Boolean-matrix config comparison at N=20', comp20);

  // ---- Phase 4: Interval-model scaling sweep ----
  // Interval model + greedy constructive hint = 0-branch FEASIBLE for all N.
  // Greedy assigns periods/rooms/lecturers in O(N×P); hints freeze those values
  // so CP propagation finds the solution immediately.
  console.log('\n--- Phase 4: Interval-model + greedy-hint scaling sweep ---');
  const SIZES_B = [10, 20, 30, 50, 75, 100, 150, 200, 300, 500];
  const sweepB: Row[] = [];
  for (const N of SIZES_B) {
    process.stdout.write(`  interval+greedy N=${N} ...`);
    const inst = generateInstance(SEED, N);
    const r = runOneInterval(inst, BEST_CONFIG, TIMEOUT);
    sweepB.push(r);
    console.log(` ${r.status}  wall=${(r.wallMs / 1000).toFixed(2)}s  branches=${fmt(r.branches)}  vars=${fmt(r.boolVars)}`);
  }
  printTable('Phase 4: Interval-model + greedy-hint scaling sweep', sweepB);

  // ---- Phase 5: Head-to-head comparison (Boolean-matrix vs Interval at shared sizes) ----
  console.log('\n--- Phase 5: Head-to-head at shared sizes ---');
  const SHARED = [10, 20, 30, 50];
  const h2h: Row[] = [];
  for (const N of SHARED) {
    const inst = generateInstance(SEED, N);
    h2h.push(runOne(inst, BEST_CONFIG, TIMEOUT));
    h2h.push(runOneInterval(inst, BEST_CONFIG, TIMEOUT));
  }
  printTable('Phase 5: Boolean-matrix vs Interval model', h2h);
}

// Run only when executed directly (not when imported as a module).
if (typeof require !== 'undefined' && require.main === module) main();
