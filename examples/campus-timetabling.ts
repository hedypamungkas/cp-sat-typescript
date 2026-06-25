/**
 * CP-SAT TypeScript - Campus Course Timetabling (Curriculum-based) Example
 * ===========================================================================
 *
 * Problem (curriculum-based course timetabling, CB-CTT style):
 *   Assign, for every SECTION (kelas) of a course: a lecturer, a room, and one
 *   or more weekly sessions (room + period). Constraints:
 *
 *   HARD
 *   - Each section is taught by exactly one of its eligible lecturers.
 *   - Each section holds exactly `sessionsPerWeek` sessions.
 *   - A section occupies at most one room per period (no double-booking itself).
 *   - Room capacity >= enrolled students; room must offer required facilities.
 *   - Room is only used during its available hours (e.g. opens 08-12, 13-16).
 *   - Lecturer is only scheduled during available hours.
 *   - No two sections share a room at the same period (room non-overlap).
 *   - A lecturer teaches at most one section per period (lecturer non-overlap).
 *   - CURRICULUM: courses in the same semester package (paket) cannot meet in
 *     the same period (students take them together). Parallel sections of the
 *     SAME course MAY share a period (different students) -> conflicts are
 *     tracked per-COURSE, not per-section.
 *   - SPREADING: a section's sessions land on distinct days (no clustering).
 *
 *   SOFT (in the objective)
 *   - Lecturer slot preferences: each meeting at a "disliked" hour costs 1.
 *
 *   RE-SCHEDULE / STABILITY
 *   - Given a reference (published) schedule and a perturbation (a room taken
 *     out for maintenance, a lecturer newly unavailable), re-solve while
 *     MINIMISING DISRUPTION: keep as many original (section,lecturer,room,
 *     period) placements as possible.
 *
 * Modelling notes (see chat assessment):
 *   - Decision var is a sparse boolean matrix assign[s,l,r,p], created ONLY
 *     for valid tuples. This makes every conflict a first-class atMostOne /
 *     exactlyOne (the solver's fast path) and sidesteps the absent
 *     `onlyEnforceIf` API entirely -> no reification needed for the hard part.
 *   - Curriculum needs a derived per-(course,period) flag `cap <=> OR(assigns)`.
 *     cp-sat-ts has no reified-constraint sugar, so we hand-build the
 *     equivalence with a linear constraint (cap => sum>=1) + implications.
 *   - Stability objective uses `.mul(-W)` (negative coefficients are fine on a
 *     whole LinearExpr) because a negated bool *literal* cannot be a term.
 *
 * Run:  npx tsx examples/campus-timetabling.ts
 */

import { CpModel, CpSolver, CpSolverStatus, LinearExpr, BoolVarImpl, IntVarImpl } from '../src';

// ---------------------------------------------------------------------------
// Time grid
// ---------------------------------------------------------------------------
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const HOURS = [8, 9, 10, 11, 13, 14, 15, 16]; // 08:00-12:00 and 13:00-17:00 (lunch gap)

interface Period {
  p: number; // flat index = day * HOURS.length + h
  day: number;
  hour: number;
}
const PERIODS: Period[] = [];
for (let day = 0; day < DAY_NAMES.length; day++) {
  for (let h = 0; h < HOURS.length; h++) {
    PERIODS.push({ p: day * HOURS.length + h, day, hour: HOURS[h] });
  }
}
const fmtHour = (h: number): string => `${String(h).padStart(2, '0')}:00-${String(h + 1).padStart(2, '0')}`;
const fmtPeriod = (per: Period): string => `${DAY_NAMES[per.day]} ${fmtHour(per.hour)}`;

// ---------------------------------------------------------------------------
// Problem data
// ---------------------------------------------------------------------------
interface RoomDef {
  id: string;
  capacity: number;
  facilities: string[];
  availableHours: number[]; // subset of HOURS (same every day, for simplicity)
}
interface LecturerDef {
  id: string;
  unavailableHours: number[]; // HARD: never scheduled here
  dislikedHours: number[]; // SOFT: penalised in the objective
}
interface CourseDef {
  id: string;
  sessionsPerWeek: number;
  students: number;
  facilities: string[]; // required facilities
  pkg: string; // semester package (curriculum group)
}
interface SectionDef {
  id: string;
  courseIdx: number;
  eligibleLecturerIdx: number[];
}

const ROOMS: RoomDef[] = [
  { id: 'A101', capacity: 40, facilities: [], availableHours: [8, 9, 10, 11, 13, 14, 15, 16] },
  { id: 'A102', capacity: 40, facilities: [], availableHours: [8, 9, 10, 11, 13, 14, 15, 16] },
  { id: 'B201', capacity: 60, facilities: ['projector'], availableHours: [8, 9, 10, 11, 13, 14, 15, 16] },
  { id: 'L301', capacity: 30, facilities: ['computer'], availableHours: [8, 9, 10, 11] }, // lab, mornings only
  { id: 'L302', capacity: 30, facilities: ['computer'], availableHours: [13, 14, 15, 16] }, // lab, afternoons only
  { id: 'C105', capacity: 120, facilities: ['projector', 'audio'], availableHours: [8, 9, 10, 11, 13, 14, 15, 16] },
  { id: 'D401', capacity: 25, facilities: [], availableHours: [13, 14, 15, 16] }, // evenings only
  { id: 'E110', capacity: 50, facilities: ['projector'], availableHours: [8, 9, 10, 11] }, // mornings only
];

const LECTURERS: LecturerDef[] = [
  { id: 'L1', unavailableHours: [], dislikedHours: [15, 16] }, // prefers morning
  { id: 'L2', unavailableHours: [8], dislikedHours: [] }, // cannot do 08:00
  { id: 'L3', unavailableHours: [13, 14], dislikedHours: [] }, // unavailable early afternoon
  { id: 'L4', unavailableHours: [], dislikedHours: [8] },
  { id: 'L5', unavailableHours: [], dislikedHours: [] },
  { id: 'L6', unavailableHours: [16], dislikedHours: [15] },
];

const COURSES: CourseDef[] = [
  // --- Package S3-TI (semester 3) ---
  { id: 'Algo', sessionsPerWeek: 2, students: 35, facilities: ['projector'], pkg: 'S3-TI' },
  { id: 'BasisData', sessionsPerWeek: 2, students: 30, facilities: ['computer'], pkg: 'S3-TI' },
  { id: 'Matdis', sessionsPerWeek: 1, students: 30, facilities: [], pkg: 'S3-TI' },
  // --- Package S5-TI (semester 5) ---
  { id: 'AI', sessionsPerWeek: 2, students: 28, facilities: ['computer'], pkg: 'S5-TI' },
  { id: 'SoftEng', sessionsPerWeek: 1, students: 50, facilities: ['projector'], pkg: 'S5-TI' },
  { id: 'RisetOps', sessionsPerWeek: 2, students: 35, facilities: ['projector'], pkg: 'S5-TI' },
];

// Sections. Note "Algo" has TWO parallel sections (different students/lecturers).
const SECTIONS: SectionDef[] = [
  { id: 'Algo-A', courseIdx: 0, eligibleLecturerIdx: [0, 2] }, // L1, L3
  { id: 'Algo-B', courseIdx: 0, eligibleLecturerIdx: [1] }, // L2 (parallel section)
  { id: 'BasisData-A', courseIdx: 1, eligibleLecturerIdx: [3, 4] }, // L4, L5
  { id: 'Matdis-A', courseIdx: 2, eligibleLecturerIdx: [0, 5] }, // L1, L6
  { id: 'AI-A', courseIdx: 3, eligibleLecturerIdx: [1, 4] }, // L2, L5
  { id: 'SoftEng-A', courseIdx: 4, eligibleLecturerIdx: [2, 3] }, // L3, L4
  { id: 'RisetOps-A', courseIdx: 5, eligibleLecturerIdx: [5] }, // L6
];

// Derived helpers
const courseOfSection = (s: number): number => SECTIONS[s].courseIdx;

// ---------------------------------------------------------------------------
// Tuple key helpers
// ---------------------------------------------------------------------------
const tupleKey = (s: number, l: number, r: number, p: number): string => `${s}|${l}|${r}|${p}`;

interface ScheduledSession {
  section: number;
  course: number;
  lecturer: number;
  room: number;
  period: number;
}

// ---------------------------------------------------------------------------
// Build & solve
// ---------------------------------------------------------------------------
interface Perturbation {
  blockedRoomDay: { room: number; day: number }[];
  blockedLectHour: { lecturer: number; hour: number }[];
}
interface BuildOptions {
  reference?: Set<string>; // tuple keys of the published schedule (for stability)
  lockReference?: boolean; // hard-seed at reference via hints (default true)
  perturbation?: Perturbation;
}

interface BuiltModel {
  model: CpModel;
  assign: Map<string, BoolVarImpl>;
  teach: Map<string, BoolVarImpl>; // key `${s}|${l}`
  referenceKeptExpr: LinearExpr | null;
}

function validTuple(s: number, l: number, r: number, p: number, pert?: Perturbation): boolean {
  const sec = SECTIONS[s];
  const course = COURSES[sec.courseIdx];
  const room = ROOMS[r];
  const lect = LECTURERS[l];
  const per = PERIODS[p];

  if (!sec.eligibleLecturerIdx.includes(l)) return false;
  if (room.capacity < course.students) return false;
  for (const f of course.facilities) {
    if (!room.facilities.includes(f)) return false;
  }
  if (!room.availableHours.includes(per.hour)) return false;
  if (lect.unavailableHours.includes(per.hour)) return false;

  if (pert) {
    if (pert.blockedRoomDay.some(b => b.room === r && b.day === per.day)) return false;
    if (pert.blockedLectHour.some(b => b.lecturer === l && b.hour === per.hour)) return false;
  }
  return true;
}

function buildModel(opts: BuildOptions = {}): BuiltModel {
  const model = new CpModel();
  const pert = opts.perturbation;

  // --- Lecturer-to-section assignment: teach[s,l] ---
  const teach = new Map<string, BoolVarImpl>();
  for (let s = 0; s < SECTIONS.length; s++) {
    const eligible: BoolVarImpl[] = [];
    for (const l of SECTIONS[s].eligibleLecturerIdx) {
      const t = model.newBoolVar(`teach_s${s}_l${LECTURERS[l].id}`);
      teach.set(`${s}|${l}`, t);
      eligible.push(t);
    }
    model.addExactlyOne(eligible); // exactly one lecturer per section
  }

  // --- Decision matrix: assign[s,l,r,p] for valid tuples only ---
  const assign = new Map<string, BoolVarImpl>();
  const byRoomPeriod = new Map<string, BoolVarImpl[]>(); // room|period
  const byLectPeriod = new Map<string, BoolVarImpl[]>(); // lecturer|period
  const bySectionPeriod = new Map<string, BoolVarImpl[]>(); // section|period
  const bySectionDay = new Map<string, BoolVarImpl[]>(); // section|day
  const byCoursePeriod = new Map<string, BoolVarImpl[]>(); // course|period

  const push = (m: Map<string, BoolVarImpl[]>, k: string, v: BoolVarImpl) => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };

  for (let s = 0; s < SECTIONS.length; s++) {
    const courseIdx = courseOfSection(s);
    for (const l of SECTIONS[s].eligibleLecturerIdx) {
      const teachVar = teach.get(`${s}|${l}`)!;
      for (let r = 0; r < ROOMS.length; r++) {
        for (let p = 0; p < PERIODS.length; p++) {
          if (!validTuple(s, l, r, p, pert)) continue;
          const key = tupleKey(s, l, r, p);
          const v = model.newBoolVar(`a_s${SECTIONS[s].id}_l${LECTURERS[l].id}_r${ROOMS[r].id}_p${p}`);
          assign.set(key, v);
          model.addImplication(v, teachVar); // assign => teach (lecturer consistency)
          push(byRoomPeriod, `${r}|${p}`, v);
          push(byLectPeriod, `${l}|${p}`, v);
          push(bySectionPeriod, `${s}|${p}`, v);
          push(bySectionDay, `${s}|${PERIODS[p].day}`, v);
          push(byCoursePeriod, `${courseIdx}|${p}`, v);
        }
      }
    }
  }

  // --- Hard constraints from the group maps ---
  for (const arr of byRoomPeriod.values()) model.addAtMostOne(arr); // room non-overlap
  for (const arr of byLectPeriod.values()) model.addAtMostOne(arr); // lecturer non-overlap
  for (const arr of bySectionPeriod.values()) model.addAtMostOne(arr); // one room/period/section
  for (const arr of bySectionDay.values()) model.addAtMostOne(arr); // spreading: <=1 session/day

  // Each section holds exactly sessionsPerWeek sessions.
  for (let s = 0; s < SECTIONS.length; s++) {
    const k = COURSES[courseOfSection(s)].sessionsPerWeek;
    const terms: BoolVarImpl[] = [];
    for (const [key, v] of assign) {
      if (key.startsWith(`${s}|`)) terms.push(v);
    }
    if (terms.length === 0) continue;
    let sum: LinearExpr = LinearExpr.fromConstant(0);
    for (const t of terms) sum = sum.add(t);
    model.addLinearConstraint(sum, k, k);
  }

  // --- Curriculum: cap[course,p] <=> OR(assign of its sections) ---
  const cap = new Map<string, BoolVarImpl>();
  for (const [cpKey, lits] of byCoursePeriod) {
    const capVar = model.newBoolVar(`cap_${cpKey}`);
    cap.set(cpKey, capVar);
    reifyOr(model, capVar, lits);
  }
  // Per package + period: at most one distinct course active.
  const byPkgPeriod = new Map<string, BoolVarImpl[]>();
  for (const [cpKey, capVar] of cap) {
    const [courseIdxStr, pStr] = cpKey.split('|');
    const courseIdx = Number(courseIdxStr);
    const pkg = COURSES[courseIdx].pkg;
    const pk = `${pkg}|${pStr}`;
    const arr = byPkgPeriod.get(pk);
    if (arr) arr.push(capVar);
    else byPkgPeriod.set(pk, [capVar]);
  }
  for (const arr of byPkgPeriod.values()) model.addAtMostOne(arr);

  // --- Objective ---
  // Soft: penalise meetings at disliked lecturer hours (uses byLectPeriod).
  let obj: LinearExpr = LinearExpr.fromConstant(0);
  for (let l = 0; l < LECTURERS.length; l++) {
    if (LECTURERS[l].dislikedHours.length === 0) continue;
    for (let p = 0; p < PERIODS.length; p++) {
      if (!LECTURERS[l].dislikedHours.includes(PERIODS[p].hour)) continue;
      const vars = byLectPeriod.get(`${l}|${p}`);
      if (vars) for (const v of vars) obj = obj.add(v);
    }
  }

  // Stability: reward keeping reference placements (negative coefficient).
  let referenceKeptExpr: LinearExpr | null = null;
  if (opts.reference) {
    const STABILITY_WEIGHT = 10;
    let kept: LinearExpr = LinearExpr.fromConstant(0);
    let any = false;
    for (const key of opts.reference) {
      const v = assign.get(key);
      if (!v) continue; // tuple pruned by perturbation -> cannot be kept
      kept = kept.add(v);
      any = true;
      if (opts.lockReference) {
        // Hard-seed the search at the reference (addHint fixes the domain).
        // Makes the solver only re-place the perturbed sessions. Note: on very
        // tight instances this can cause false infeasibility -> caller falls
        // back to the objective-only mode (lockReference: false).
        model.addHint(v as unknown as IntVarImpl, 1);
      }
    }
    if (any) {
      referenceKeptExpr = kept;
      obj = obj.add(kept.mul(-STABILITY_WEIGHT));
    }
  }
  model.minimize(obj);

  return { model, assign, teach, referenceKeptExpr };
}

/**
 * Hand-built reification: result <=> OR(lits), without onlyEnforceIf.
 *   result => OR(lits) : sum(lits) - result >= 0   (linear, lb = 0)
 *   OR(lits) => result : each lit => result         (implications)
 */
function reifyOr(model: CpModel, result: BoolVarImpl, lits: BoolVarImpl[]): void {
  if (lits.length === 0) {
    model.add(result.le(0)); // forced false
    return;
  }
  let sum: LinearExpr = LinearExpr.fromConstant(0);
  for (const lit of lits) sum = sum.add(lit);
  model.addLinearConstraint(sum.sub(result), 0, lits.length);
  for (const lit of lits) model.addImplication(lit, result);
}

// ---------------------------------------------------------------------------
// Decode & validate
// ---------------------------------------------------------------------------
function decode(solver: CpSolver, assign: Map<string, BoolVarImpl>): ScheduledSession[] {
  const out: ScheduledSession[] = [];
  for (const [key, v] of assign) {
    if (!solver.booleanValue(v)) continue;
    const [s, l, r, p] = key.split('|').map(Number);
    out.push({ section: s, course: courseOfSection(s), lecturer: l, room: r, period: p });
  }
  return out;
}

function validate(sessions: ScheduledSession[]): string[] {
  const issues: string[] = [];
  const roomPeriod = new Map<string, number>();
  const lectPeriod = new Map<string, number>();
  const sectPeriod = new Map<string, number>();
  const pkgPeriod = new Map<string, Set<number>>(); // key -> set of courses
  const perSectDay = new Map<string, number>();
  const perSectCount = new Map<number, number>();

  for (const ses of sessions) {
    const bump = (m: Map<string, number>, k: string, label: string) => {
      const n = (m.get(k) ?? 0) + 1;
      m.set(k, n);
      if (n > 1) issues.push(`${label} double-booked: ${k}`);
    };
    bump(roomPeriod, `${ses.room}|${ses.period}`, `Room ${ROOMS[ses.room].id}`);
    bump(lectPeriod, `${ses.lecturer}|${ses.period}`, `Lecturer ${LECTURERS[ses.lecturer].id}`);
    bump(sectPeriod, `${ses.section}|${ses.period}`, `Section ${SECTIONS[ses.section].id}`);
    bump(perSectDay, `${ses.section}|${PERIODS[ses.period].day}`, `Section ${SECTIONS[ses.section].id} (spread)`);

    const pkg = COURSES[ses.course].pkg;
    const pk = `${pkg}|${ses.period}`;
    const set = pkgPeriod.get(pk) ?? new Set<number>();
    set.add(ses.course);
    if (pkgPeriod.has(pk) && set.size > 1) {
      issues.push(`Curriculum conflict at ${fmtPeriod(PERIODS[ses.period])} in pkg ${pkg}: courses ${[...set].map(c => COURSES[c].id).join(',')}`);
    }
    pkgPeriod.set(pk, set);

    perSectCount.set(ses.section, (perSectCount.get(ses.section) ?? 0) + 1);
  }
  for (const [s, n] of perSectCount) {
    const want = COURSES[courseOfSection(s)].sessionsPerWeek;
    if (n !== want) issues.push(`Section ${SECTIONS[s].id} has ${n} sessions, expected ${want}`);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------
function printSchedule(label: string, status: CpSolverStatus, sessions: ScheduledSession[], solver: CpSolver): void {
  console.log(`\n================ ${label} ================`);
  console.log(`Status: ${CpSolverStatus[status]}  |  ${solver.responseStats().split('\n').join(' | ')}`);

  if (status !== CpSolverStatus.OPTIMAL && status !== CpSolverStatus.FEASIBLE) {
    console.log('No feasible schedule.');
    return;
  }

  // Per-section view
  const bySection = new Map<number, ScheduledSession[]>();
  for (const ses of sessions) {
    const arr = bySection.get(ses.section) ?? [];
    arr.push(ses);
    bySection.set(ses.section, arr);
  }
  console.log('\nSection schedule:');
  for (let s = 0; s < SECTIONS.length; s++) {
    const arr = (bySection.get(s) ?? []).sort((a, b) => a.period - b.period);
    const course = COURSES[courseOfSection(s)];
    const lectOf = (ses: ScheduledSession) => LECTURERS[ses.lecturer].id;
    const lines = arr.map(ses => `    ${fmtPeriod(PERIODS[ses.period])}  room ${ROOMS[ses.room].id}  (${lectOf(ses)})`);
    console.log(`  ${SECTIONS[s].id} [${course.id}, pkg ${course.pkg}, ${course.students} sts, ${course.sessionsPerWeek}x/wk]:`);
    console.log(lines.join('\n') || '    (none)');
  }

  // Soft-pref violations
  let prefViolations = 0;
  for (const ses of sessions) {
    if (LECTURERS[ses.lecturer].dislikedHours.includes(PERIODS[ses.period].hour)) prefViolations++;
  }
  console.log(`\nLecturer slot-preference violations (soft): ${prefViolations}`);

  // Validation
  const issues = validate(sessions);
  if (issues.length === 0) {
    console.log('Hard-constraint validation: OK (no double-booking, spreading & curriculum respected)');
  } else {
    console.log('Hard-constraint validation FAILED:');
    for (const i of issues) console.log(`  - ${i}`);
  }
}

function referenceKeys(sessions: ScheduledSession[]): Set<string> {
  return new Set(sessions.map(ses => tupleKey(ses.section, ses.lecturer, ses.room, ses.period)));
}

function printDiff(before: ScheduledSession[], after: ScheduledSession[]): void {
  const beforeKeys = referenceKeys(before);
  const afterKeys = referenceKeys(after);
  const dropped = [...beforeKeys].filter(k => !afterKeys.has(k));
  const added = [...afterKeys].filter(k => !beforeKeys.has(k));
  console.log(`\n----- Re-schedule disruption -----`);
  console.log(`Sessions kept unchanged : ${beforeKeys.size - dropped.length} / ${beforeKeys.size}`);
  console.log(`Sessions moved          : ${dropped.length}`);
  const desc = (k: string) => {
    const [s, l, r, p] = k.split('|').map(Number);
    return `${SECTIONS[s].id} @ ${fmtPeriod(PERIODS[p])} room ${ROOMS[r].id} (${LECTURERS[l].id})`;
  };
  for (const k of dropped) console.log(`  removed: ${desc(k)}`);
  for (const k of added) console.log(`  added  : ${desc(k)}`);
}

// ---------------------------------------------------------------------------
// Main: initial solve, then re-schedule under a perturbation
// ---------------------------------------------------------------------------
function main(): void {
  console.log('Campus Course Timetabling (curriculum-based) — cp-sat-ts prototype\n');
  console.log(`${SECTIONS.length} sections, ${COURSES.length} courses, ${ROOMS.length} rooms, ${LECTURERS.length} lecturers, ${PERIODS.length} periods`);

  // 1) Initial schedule: minimise lecturer slot-preference violations.
  const solver1 = new CpSolver();
  solver1.parameters = { maxTimeInSeconds: 20 };
  const built1 = buildModel();
  const status1 = solver1.solve(built1.model);
  const sessions1 = status1 === CpSolverStatus.OPTIMAL || status1 === CpSolverStatus.FEASIBLE
    ? decode(solver1, built1.assign)
    : [];
  printSchedule('INITIAL SCHEDULE', status1, sessions1, solver1);

  if (sessions1.length === 0) {
    console.log('\nInitial schedule infeasible — aborting re-schedule demo.');
    return;
  }

  // 2) Perturbation: room B201 under maintenance all Monday + lecturer L1 newly
  //    unavailable at 10:00. Re-solve keeping the published schedule as stable
  //    as possible (stability objective).
  const perturbation: Perturbation = {
    blockedRoomDay: [{ room: ROOMS.findIndex(r => r.id === 'B201'), day: DAY_NAMES.indexOf('Mon') }],
    blockedLectHour: [{ lecturer: LECTURERS.findIndex(l => l.id === 'L1'), hour: 10 }],
  };
  console.log('\n\n>> Perturbation: room B201 closed on Mon; lecturer L1 unavailable at 10:00. Re-scheduling with stability objective...');

  const solver2 = new CpSolver();
  solver2.parameters = { maxTimeInSeconds: 20 };
  const ref = referenceKeys(sessions1);
  let built2 = buildModel({ reference: ref, lockReference: true, perturbation });
  let status2 = solver2.solve(built2.model);

  // Fallback: hard-locking at the reference can over-constrain on tight
  // instances. If it proves infeasible, retry in objective-only mode.
  let lockNote = 'hint-locked at reference';
  if (status2 === CpSolverStatus.INFEASIBLE) {
    lockNote = 'objective-only (lock was infeasible)';
    const solver2b = new CpSolver();
    solver2b.parameters = { maxTimeInSeconds: 20 };
    built2 = buildModel({ reference: ref, lockReference: false, perturbation });
    status2 = solver2b.solve(built2.model);
    const sessions2b = status2 === CpSolverStatus.OPTIMAL || status2 === CpSolverStatus.FEASIBLE
      ? decode(solver2b, built2.assign)
      : [];
    printSchedule(`RE-SCHEDULED (minimal disruption) — ${lockNote}`, status2, sessions2b, solver2b);
    printDiff(sessions1, sessions2b);
    return;
  }

  const sessions2 = status2 === CpSolverStatus.OPTIMAL || status2 === CpSolverStatus.FEASIBLE
    ? decode(solver2, built2.assign)
    : [];
  printSchedule(`RE-SCHEDULED (minimal disruption) — ${lockNote}`, status2, sessions2, solver2);
  printDiff(sessions1, sessions2);
}

main();
