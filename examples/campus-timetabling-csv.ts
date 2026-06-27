/**
 * Campus Course Timetabling — CSV I/O Version (Full Scale)
 * =======================================================
 * 5 Faculties · 15 Programs · ~60 Courses · ~184 Sections · ~80 Lecturers · 52 Rooms · 8 Buildings
 *
 * Hard constraint:
 *   - A lecturer cannot be in 2 different buildings in a single day
 *
 * Soft (greedy + CP objective):
 *   - Lecturer preference for courses (course preference)
 *   - Room facility preference (facility preference)
 *   - Room continuity: adjacent sections on the same day → same room
 *
 * Run:
 *   npx tsx examples/campus-timetabling-csv.ts
 *   npx tsx examples/campus-timetabling-csv.ts --blocked-rooms=B-LAB1,B-LAB2
 *   npx tsx examples/campus-timetabling-csv.ts --input=./examples/data/campus/ --output-dir=./output/
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import {
  CpModel, CpSolver, CpSolverStatus,
  BoolVarImpl, IntVarImpl, IntervalVarImpl,
  LinearExpr,
} from '../src';

// ═══════════════════════════════════════════════════════════════════════════
// 1. TIME GRID
// ═══════════════════════════════════════════════════════════════════════════

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const HOURS = [8, 9, 10, 11, 13, 14, 15, 16];
const H_PER_DAY = HOURS.length;
const DAYS = 5;
const TOTAL_P = DAYS * H_PER_DAY;

interface Period { p: number; day: number; hour: number; }
const PERIODS: Period[] = [];
for (let d = 0; d < DAYS; d++)
  for (let h = 0; h < H_PER_DAY; h++)
    PERIODS.push({ p: d * H_PER_DAY + h, day: d, hour: HOURS[h] });

const fmtPeriod = (p: number): string =>
  `${DAY_NAMES[PERIODS[p].day]} ${String(PERIODS[p].hour).padStart(2, '0')}:00`;

// Lunch gap: hour-index 3 = 11:00 (before lunch 12:00), 4 = 13:00 (after).
const LUNCH_GAP_START = 3;
const LUNCH_GAP_END = 4;

// Valid start periods for a session of duration `dur`: must fit within a day and not cross lunch.
function validStartPeriods(dur: number): number[] {
  const out: number[] = [];
  for (let day = 0; day < DAYS; day++)
    for (let i = 0; i + dur - 1 < H_PER_DAY; i++) {
      // block [i, i+dur-1] must not contain the lunch gap (indices 3 and 4 together)
      if (i <= LUNCH_GAP_START && i + dur - 1 >= LUNCH_GAP_END) continue;
      out.push(day * H_PER_DAY + i);
    }
  return out;
}
const VALID_STARTS: number[][] = [1, 2, 3, 4].map(d => validStartPeriods(d));

// ═══════════════════════════════════════════════════════════════════════════
// 2. INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

interface RoomDef    { id: string; cap: number; fac: string[]; building: string; }
interface LectDef    { id: string; disliked: number[]; preferredFac: string[]; preferredCourses: string[]; }
interface CourseDef  { id: string; name: string; spw: number; duration: number; students: number; fac: string[]; pkg: string; home: string; }
interface SectionDef { id: string; courseIdx: number; lecturers: number[]; roster: number[]; }
interface StudentDef { id: string; name: string; courseIds: string[]; }

// ═══════════════════════════════════════════════════════════════════════════
// 3. MODULE-LEVEL DATA (populated by loadData())
// ═══════════════════════════════════════════════════════════════════════════

let ROOMS:     RoomDef[]    = [];
let LECTURERS: LectDef[]    = [];
let COURSES:   CourseDef[]  = [];
let SECTIONS:  SectionDef[] = [];
let STUDENTS:  StudentDef[] = [];
let S = 0, R = 0, L = 0, C = 0, M = 0;

const sessCount = (s: number): number => COURSES[SECTIONS[s].courseIdx].spw;
const duration  = (s: number): number => COURSES[SECTIONS[s].courseIdx].duration;

// ═══════════════════════════════════════════════════════════════════════════
// 4. CLI ARGS
// ═══════════════════════════════════════════════════════════════════════════

interface CliArgs {
  inputDir:     string;
  outputDir:    string;
  blockedRooms: string[];
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let inputDir     = join(__dirname, 'data', 'campus');
  let outputDir    = join(process.cwd(), 'output');
  let blockedRooms: string[] = [];

  for (const arg of args) {
    if (arg.startsWith('--input='))
      inputDir = resolve(arg.slice(8));
    else if (arg.startsWith('--output-dir='))
      outputDir = resolve(arg.slice(13));
    else if (arg.startsWith('--blocked-rooms='))
      blockedRooms = arg.slice(16).split(',').map(r => r.trim()).filter(Boolean);
  }

  return { inputDir, outputDir, blockedRooms };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. CSV PARSING & DATA LOADING
// ═══════════════════════════════════════════════════════════════════════════

function parseCSVRow(line: string): string[] {
  const fields: string[] = [];
  let inQuotes = false;
  let current = '';
  const chars = [...line];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '"') {
      if (inQuotes && chars[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCSV(content: string): string[][] {
  return content
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(parseCSVRow);
}

function loadData(inputDir: string): void {
  // rooms.csv: id,capacity,facilities,building
  const roomRows = parseCSV(readFileSync(join(inputDir, 'rooms.csv'), 'utf8')).slice(1);
  ROOMS = roomRows.map(r => ({
    id:       r[0],
    cap:      parseInt(r[1], 10),
    fac:      r[2] ? r[2].split(';').map(f => f.trim()).filter(Boolean) : [],
    building: r[3] ? r[3].trim() : '',
  }));

  // lecturers.csv: id,disliked_hours,preferred_facilities,preferred_courses
  const lectRows = parseCSV(readFileSync(join(inputDir, 'lecturers.csv'), 'utf8')).slice(1);
  LECTURERS = lectRows.map(r => ({
    id:               r[0],
    disliked:         r[1] ? r[1].split(',').map(h => parseInt(h.trim(), 10)).filter(h => !isNaN(h)) : [],
    preferredFac:     r[2] ? r[2].split(';').map(f => f.trim()).filter(Boolean) : [],
    preferredCourses: r[3] ? r[3].split(';').map(c => c.trim()).filter(Boolean) : [],
  }));

  // courses.csv: id,name,sessions_per_week,duration,sks,students,facilities,package,home_building
  const courseRows = parseCSV(readFileSync(join(inputDir, 'courses.csv'), 'utf8')).slice(1);
  COURSES = courseRows.map(r => ({
    id:       r[0],
    name:     r[1],
    spw:      parseInt(r[2], 10),
    duration: parseInt(r[3], 10) || 1,
    students: parseInt(r[5], 10),
    fac:      r[6] ? r[6].split(';').map(f => f.trim()).filter(Boolean) : [],
    pkg:      r[7],
    home:     r[8] ? r[8].trim() : '',
  }));

  const courseIdToIdx = new Map(COURSES.map((c, i) => [c.id, i]));
  const lectIdToIdx   = new Map(LECTURERS.map((l, i) => [l.id, i]));

  // students.csv: id,name,course_ids
  const stuRows = parseCSV(readFileSync(join(inputDir, 'students.csv'), 'utf8')).slice(1);
  const stuIdToLocal = new Map<string, number>();
  STUDENTS = stuRows.map((r, i) => {
    stuIdToLocal.set(r[0], i);
    return {
      id:        r[0],
      name:      r[1],
      courseIds: r[2] ? r[2].split(';').map(c => c.trim()).filter(Boolean) : [],
    };
  });

  // sections.csv: id,course_id,lecturer_ids,student_ids
  const sectRows = parseCSV(readFileSync(join(inputDir, 'sections.csv'), 'utf8')).slice(1);
  SECTIONS = sectRows.map(r => {
    const courseIdx = courseIdToIdx.get(r[1]);
    if (courseIdx === undefined)
      throw new Error(`Course not found: "${r[1]}" (section ${r[0]})`);
    const lectIds = r[2] ? r[2].split(',').map(id => id.trim()).filter(Boolean) : [];
    if (lectIds.length === 0)
      throw new Error(`Section "${r[0]}" has no lecturer (lecturer_ids column is empty)`);
    const lecturers = lectIds.map(id => {
      const idx = lectIdToIdx.get(id);
      if (idx === undefined)
        throw new Error(`Lecturer not found: "${id}" (section ${r[0]})`);
      return idx;
    });
    const rosterIds = r[3] ? r[3].split(',').map(id => id.trim()).filter(Boolean) : [];
    const roster = rosterIds.map(id => {
      const idx = stuIdToLocal.get(id);
      if (idx === undefined)
        throw new Error(`Student not found: "${id}" (section ${r[0]})`);
      return idx;
    });
    return { id: r[0], courseIdx, lecturers, roster };
  });

  S = SECTIONS.length;
  R = ROOMS.length;
  L = LECTURERS.length;
  C = COURSES.length;
  M = STUDENTS.length;

  // Precompute building → room indices, and order buildings from largest to smallest.
  // Used by greedy to keep lecturers clustered in their home building.
  BUILDING_ROOMS = new Map<string, number[]>();
  for (let r = 0; r < R; r++) {
    const b = ROOMS[r].building;
    const arr = BUILDING_ROOMS.get(b) ?? [];
    arr.push(r);
    BUILDING_ROOMS.set(b, arr);
  }
  BIG_BUILDINGS = [...BUILDING_ROOMS.keys()].sort(
    (a, b) => (BUILDING_ROOMS.get(b)?.length ?? 0) - (BUILDING_ROOMS.get(a)?.length ?? 0),
  );

  buildCohorts();
}
let BUILDING_ROOMS: Map<string, number[]> = new Map();
let BIG_BUILDINGS: string[] = [];

// ═══════════════════════════════════════════════════════════════════════════
// 6. VALID-ROOM MAPPING PER SECTION
// ═══════════════════════════════════════════════════════════════════════════

function computeSectionValidRooms(excludedRooms: number[] = []): number[][] {
  return SECTIONS.map(sec => {
    const course = COURSES[sec.courseIdx];
    const need = Math.max(sec.roster.length, 1);   // capacity ≥ number of students in the roster
    return Array.from({ length: R }, (_, r) => r).filter(r => {
      if (excludedRooms.includes(r)) return false;
      const room = ROOMS[r];
      if (room.cap < need) return false;
      return course.fac.every(f => room.fac.includes(f));
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 6b. COHORT (curriculum) — a group of students with an identical section-set.
// Each cohort = one NoOverlap in the solver (hybrid: group for efficiency).
// ═══════════════════════════════════════════════════════════════════════════
let COHORTS: number[][] = [];          // each element = list of sectionIdx in the cohort
let SECTION_COHORTS: number[][] = [];  // sectionIdx → list of cohortIdx containing it

function buildCohorts(): void {
  // student → section-set
  const stuSections: number[][] = Array.from({ length: M }, () => []);
  for (let s = 0; s < S; s++)
    for (const stu of SECTIONS[s].roster) stuSections[stu].push(s);
  // group by identical section-set (key = sorted sectionIdx joined)
  const byKey = new Map<string, number[]>();
  for (let stu = 0; stu < M; stu++) {
    const key = [...stuSections[stu]].sort((a, b) => a - b).join(',');
    const arr = byKey.get(key) ?? [];
    arr.push(stu);
    byKey.set(key, arr);
  }
  COHORTS = [];
  const keyToCohort = new Map<string, number>();
  for (const [key, stus] of byKey) {
    // section-set = stuSections[stus[0]]
    const cIdx = COHORTS.length;
    COHORTS.push(stuSections[stus[0]]);
    keyToCohort.set(key, cIdx);
  }
  // section → cohorts
  SECTION_COHORTS = Array.from({ length: S }, () => []);
  for (let ci = 0; ci < COHORTS.length; ci++)
    for (const s of COHORTS[ci]) SECTION_COHORTS[s].push(ci);
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. GREEDY CONSTRUCTIVE SOLVER
// ═══════════════════════════════════════════════════════════════════════════

interface GreedySolution {
  periods:   number[][];
  lecturers: number[];
  rooms:     number[][];
  unplaced?: Set<number>;
}

// Target building for a lecturer: the most frequently used building (home),
// or the largest building that has a valid room (for first placement).
function lectHomeBuilding(
  lect: number,
  lectDayBuilding: Map<number, string>[],
  allValid: number[],
): string | undefined {
  const counts = new Map<string, number>();
  for (const b of lectDayBuilding[lect].values()) counts.set(b, (counts.get(b) ?? 0) + 1);
  let home: string | undefined, best = -1;
  for (const [b, n] of counts) if (n > best) { home = b; best = n; }
  if (home) return home;
  for (const b of BIG_BUILDINGS)
    if (allValid.some(r => ROOMS[r].building === b)) return b;
  return undefined;
}

// Deterministic PRNG (mulberry32) for greedy jitter.
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const GREEDY_RESTARTS = 250;  // max randomized-restart attempts

// Stability hint for reschedule: the phase-1 solution. If not null, greedy
// keeps the old placements that are still valid (minimal disruption).
let STABILITY: DecodedSolution | null = null;
let greedyRng: () => number = Math.random;
const greedyRand = (n: number): number => Math.floor(greedyRng() * n);

function greedySolve(sectionValidRooms: number[][], stability?: DecodedSolution | null): GreedySolution | null {
  STABILITY = stability ?? null;
  // Base order fail-first (most constrained first); jittered per attempt.
  // Priority: fewest valid rooms, most cohorts (student-conflict),
  // longest duration, then spw & students.
  const baseOrder = Array.from({ length: S }, (_, i) => i)
    .map(s => ({
      s,
      key1: sectionValidRooms[s].length,
      key2: -SECTION_COHORTS[s].length,
      key3: -duration(s),
      key4: -sessCount(s),
      key5: -COURSES[SECTIONS[s].courseIdx].students,
    }))
    .sort((a, b) => a.key1 - b.key1 || a.key2 - b.key2 || a.key3 - b.key3 || a.key4 - b.key4 || a.key5 - b.key5)
    .map(o => o.s);

  let best: GreedySolution | null = null;
  for (let attempt = 0; attempt < GREEDY_RESTARTS; attempt++) {
    greedyRng = mulberry32(12345 + attempt * 7919);

    const periods:   number[][] = Array.from({ length: S }, () => []);
    const rooms:     number[][] = Array.from({ length: S }, () => []);
    const lecturers: number[]   = new Array(S).fill(-1);
    const lectUsed:   Set<number>[] = Array.from({ length: L }, () => new Set());
    const roomUsed:   Set<number>[] = Array.from({ length: R }, () => new Set());
    const cohortBusy: Set<number>[] = Array.from({ length: COHORTS.length }, () => new Set());
    const lectDayBuilding: Map<number, string>[] = Array.from({ length: L }, () => new Map());
    const lectPeriodRoom:  Map<number, number>[] = Array.from({ length: L }, () => new Map());

    // Jitter: shuffle sections that have the same number of valid rooms (fail-first group).
    const order = jitterOrder(baseOrder, sectionValidRooms);

    // Place sections; failures are SKIPPED (recorded as unplaced) then continue
    // to the next section. The CP solver will fill in the unplaced sections from
    // this partial hint. This way greedy does not fail entirely just because a few
    // trailing sections are too tight at high density.
    const unplaced = new Set<number>();
    for (const s of order) {
      if (!greedyPlaceSection(
        s, sectionValidRooms[s], lectUsed, roomUsed, cohortBusy,
        periods, rooms, lecturers,
        lectDayBuilding, lectPeriodRoom,
      )) unplaced.add(s);
    }
    if (unplaced.size === 0) return { periods, lecturers, rooms, unplaced };

    // Keep the attempt with the fewest unplaced sections.
    const bestUnplaced = best?.unplaced;
    if (!best || !bestUnplaced || unplaced.size < bestUnplaced.size) {
      best = { periods, lecturers, rooms, unplaced };
    }
  }
  if (process.env.GREEDY_DEBUG && best?.unplaced)
    console.log(`[DEBUG] Best greedy partial: ${best.unplaced.size} sections unplaced (CP will fill in). Examples: ${[...best.unplaced].slice(0, 5).map(s => SECTIONS[s].id).join(', ')}`);
  return best;
}

// Shuffle the order within a group that shares the same first key (number of valid rooms),
// so each restart tries a different placement order without breaking fail-first.
function jitterOrder(base: number[], sectionValidRooms: number[][]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < base.length) {
    let j = i;
    const k = sectionValidRooms[base[i]].length;
    while (j < base.length && sectionValidRooms[base[j]].length === k) j++;
    const grp = base.slice(i, j);
    for (let m = grp.length - 1; m > 0; m--) {
      const r = greedyRand(m + 1);
      [grp[m], grp[r]] = [grp[r], grp[m]];
    }
    out.push(...grp);
    i = j;
  }
  return out;
}

// Check whether the range [start, start+dur-1] is free of cohort conflicts for section s.
function cohortRangeFree(s: number, start: number, dur: number, cohortBusy: Set<number>[]): boolean {
  for (const ci of SECTION_COHORTS[s])
    for (let k = 0; k < dur; k++)
      if (cohortBusy[ci].has(start + k)) return false;
  return true;
}

// Commit the placement of section s (all sessions) to the greedy state.
function commitPlacement(
  s: number, lect: number, chosenP: number[], chosenR: number[], dur: number,
  lectUsed: Set<number>[], roomUsed: Set<number>[], cohortBusy: Set<number>[],
  periods: number[][], rooms: number[][], lecturers: number[],
  lectDayBuilding: Map<number, string>[], lectPeriodRoom: Map<number, number>[],
): void {
  lecturers[s] = lect;
  periods[s] = [...chosenP];
  rooms[s] = [...chosenR];
  for (let k = 0; k < chosenP.length; k++) {
    const p = chosenP[k], r = chosenR[k];
    for (let j = 0; j < dur; j++) {
      lectUsed[lect].add(p + j);
      roomUsed[r].add(p + j);
    }
    for (const ci of SECTION_COHORTS[s])
      for (let j = 0; j < dur; j++) cohortBusy[ci].add(p + j);
    if (!lectDayBuilding[lect].has(PERIODS[p].day))
      lectDayBuilding[lect].set(PERIODS[p].day, ROOMS[r].building);
    lectPeriodRoom[lect].set(p, r);
  }
}

// Try to keep the old placement (STABILITY) for section s. Return true if
// all sessions of s at the old positions are still valid (room free, cohort free, etc).
function tryStablePlacement(
  s: number, validRooms: number[], eligLects: number[], dur: number,
  lectUsed: Set<number>[], roomUsed: Set<number>[], cohortBusy: Set<number>[],
  periods: number[][], rooms: number[][], lecturers: number[],
  lectDayBuilding: Map<number, string>[], lectPeriodRoom: Map<number, number>[],
): boolean {
  const sol = STABILITY!;
  if (s >= sol.period.length || sol.lect[s] < 0) return false;
  const lect = sol.lect[s];
  if (!eligLects.includes(lect)) return false;
  const numSess = sessCount(s);
  const ps = sol.period[s], rs = sol.room[s];
  if (ps.length !== numSess) return false;

  const usedDays = new Set<number>();
  const tentativeDayBldg = new Map(lectDayBuilding[lect]);
  for (let k = 0; k < numSess; k++) {
    const p = ps[k], r = rs[k];
    if (!validRooms.includes(r)) return false;
    for (let j = 0; j < dur; j++)
      if (lectUsed[lect].has(p + j) || roomUsed[r].has(p + j)) return false;
    if (!cohortRangeFree(s, p, dur, cohortBusy)) return false;
    const day = PERIODS[p].day;
    if (numSess > 1 && usedDays.has(day)) return false;
    const dayBldg = tentativeDayBldg.get(day);
    if (dayBldg && ROOMS[r].building !== dayBldg) return false;
    if (!tentativeDayBldg.has(day)) tentativeDayBldg.set(day, ROOMS[r].building);
    usedDays.add(day);
  }
  commitPlacement(s, lect, ps, rs, dur, lectUsed, roomUsed, cohortBusy, periods, rooms, lecturers, lectDayBuilding, lectPeriodRoom);
  return true;
}

function greedyPlaceSection(
  s: number,
  validRooms: number[],
  lectUsed:   Set<number>[],
  roomUsed:   Set<number>[],
  cohortBusy: Set<number>[],
  periods:    number[][],
  rooms:      number[][],
  lecturers:  number[],
  lectDayBuilding: Map<number, string>[],
  lectPeriodRoom:  Map<number, number>[],
): boolean {
  const courseIdx = SECTIONS[s].courseIdx;
  const courseId  = COURSES[courseIdx].id;
  const numSess   = sessCount(s);
  const dur       = duration(s);
  const eligLects = SECTIONS[s].lecturers;
  const starts    = VALID_STARTS[Math.min(dur, 4) - 1];

  // Stability fast-path (reschedule).
  if (STABILITY && tryStablePlacement(
    s, validRooms, eligLects, dur,
    lectUsed, roomUsed, cohortBusy, periods, rooms, lecturers, lectDayBuilding, lectPeriodRoom,
  )) return true;

  // Prefer lecturers who have this course in their preferredCourses list.
  const sortedLects = [...eligLects].sort((a, b) => {
    const aPref = LECTURERS[a].preferredCourses.includes(courseId) ? 0 : 1;
    const bPref = LECTURERS[b].preferredCourses.includes(courseId) ? 0 : 1;
    return aPref - bPref;
  });
  for (let i = 1; i < sortedLects.length; i++) {
    const aPref = LECTURERS[sortedLects[i]].preferredCourses.includes(courseId) ? 0 : 1;
    const j = i - 1;
    if ((LECTURERS[sortedLects[j]].preferredCourses.includes(courseId) ? 0 : 1) === aPref) {
      const r = greedyRand(i + 1);
      [sortedLects[i], sortedLects[r]] = [sortedLects[r], sortedLects[i]];
    }
  }

  for (const lect of sortedLects) {
    const disliked = new Set(LECTURERS[lect].disliked);
    const prefFac  = LECTURERS[lect].preferredFac;

    const startOffset = greedyRand(starts.length);
    for (let pass = 0; pass < 2; pass++) {
      const tentativeDayBldg = new Map(lectDayBuilding[lect]);
      const chosenPeriods: number[] = [];
      const chosenRooms:   number[] = [];
      const usedDays = new Set<number>();

      for (let i = 0; i < starts.length && chosenPeriods.length < numSess; i++) {
        const p = starts[(startOffset + i) % starts.length];
        const day = PERIODS[p].day;
        // pass-0: skip if any hour is covered by disliked.
        if (pass === 0) {
          let bad = false;
          for (let j = 0; j < dur; j++) if (disliked.has(PERIODS[p + j].hour)) { bad = true; break; }
          if (bad) continue;
        }
        // lecturer & cohort free across the range
        let occ = false;
        for (let j = 0; j < dur; j++) if (lectUsed[lect].has(p + j)) { occ = true; break; }
        if (occ) continue;
        if (!cohortRangeFree(s, p, dur, cohortBusy)) continue;
        if (numSess > 1 && usedDays.has(day)) continue;

        const dayBldg = tentativeDayBldg.get(day);
        const allValid = validRooms.filter(r => {
          for (let j = 0; j < dur; j++) if (roomUsed[r].has(p + j)) return false;
          return !dayBldg || ROOMS[r].building === dayBldg;
        });
        if (allValid.length === 0) continue;

        const targetBldg = COURSES[courseIdx].home || lectHomeBuilding(lect, lectDayBuilding, allValid);
        const adjRoom = [p - 1, p + dur]
          .filter(ap => ap >= 0 && ap < TOTAL_P && PERIODS[ap].day === day)
          .map(ap => lectPeriodRoom[lect].get(ap))
          .find((r): r is number => r !== undefined && allValid.includes(r));
        const matchesPref = (r: number) => prefFac.every(f => ROOMS[r].fac.includes(f));
        const inTarget   = (r: number) => !targetBldg || ROOMS[r].building === targetBldg;
        const orderedRooms: number[] = [
          ...(adjRoom !== undefined && matchesPref(adjRoom) ? [adjRoom] : []),
          ...(adjRoom !== undefined && !matchesPref(adjRoom) ? [adjRoom] : []),
          ...allValid.filter(r => r !== adjRoom && matchesPref(r) && inTarget(r)),
          ...allValid.filter(r => r !== adjRoom && !matchesPref(r) && inTarget(r)),
          ...allValid.filter(r => r !== adjRoom && matchesPref(r) && !inTarget(r)),
          ...allValid.filter(r => r !== adjRoom && !matchesPref(r) && !inTarget(r)),
        ];
        const topK = orderedRooms.slice(0, Math.min(3, orderedRooms.length));
        const foundRoom = topK[greedyRand(topK.length)];
        if (foundRoom === undefined) continue;

        if (!tentativeDayBldg.has(day))
          tentativeDayBldg.set(day, ROOMS[foundRoom].building);
        chosenPeriods.push(p);
        chosenRooms.push(foundRoom);
        usedDays.add(day);
      }

      if (chosenPeriods.length === numSess) {
        commitPlacement(s, lect, chosenPeriods, chosenRooms, dur,
          lectUsed, roomUsed, cohortBusy, periods, rooms, lecturers, lectDayBuilding, lectPeriodRoom);
        return true;
      }
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// 7b. REPAIR (eviction) to finish the unplaced greedy sections.
// Used at high density: greedy places ~99% of sections, repair
// evicts 1 conflicting section + re-plans so the unplaced section fits.
// ═══════════════════════════════════════════════════════════════════════════

interface GreedyState {
  periods: number[][];
  rooms: number[][];
  lecturers: number[];
  lectUsed: Set<number>[];
  roomUsed: Set<number>[];
  cohortBusy: Set<number>[];
  lectDayBuilding: Map<number, string>[];
  lectPeriodRoom: Map<number, number>[];
  slotOccupant: Map<number, number>; // key (period)*R + room → section (occupant per period)
}

function commitSectionST(st: GreedyState, s: number, lect: number, ps: number[], rs: number[]): void {
  st.lecturers[s] = lect;
  st.periods[s] = [...ps];
  st.rooms[s] = [...rs];
  const dur = duration(s);
  for (let k = 0; k < ps.length; k++) {
    const p = ps[k], r = rs[k];
    for (let j = 0; j < dur; j++) {
      st.lectUsed[lect].add(p + j);
      st.roomUsed[r].add(p + j);
      st.slotOccupant.set((p + j) * R + r, s);
    }
    for (const ci of SECTION_COHORTS[s])
      for (let j = 0; j < dur; j++) st.cohortBusy[ci].add(p + j);
    st.lectPeriodRoom[lect].set(p, r);
    if (!st.lectDayBuilding[lect].has(PERIODS[p].day))
      st.lectDayBuilding[lect].set(PERIODS[p].day, ROOMS[r].building);
  }
}

function rebuildLectDayBuilding(st: GreedyState, lect: number): void {
  st.lectDayBuilding[lect] = new Map();
  for (let s2 = 0; s2 < S; s2++) {
    if (st.lecturers[s2] !== lect) continue;
    for (let k = 0; k < st.periods[s2].length; k++) {
      const p = st.periods[s2][k], r = st.rooms[s2][k];
      if (!st.lectDayBuilding[lect].has(PERIODS[p].day))
        st.lectDayBuilding[lect].set(PERIODS[p].day, ROOMS[r].building);
    }
  }
}

function evictSectionST(st: GreedyState, s: number): void {
  const lect = st.lecturers[s];
  if (lect < 0) return;
  const dur = duration(s);
  for (let k = 0; k < st.periods[s].length; k++) {
    const p = st.periods[s][k], r = st.rooms[s][k];
    for (let j = 0; j < dur; j++) {
      st.lectUsed[lect].delete(p + j);
      st.roomUsed[r].delete(p + j);
      st.slotOccupant.delete((p + j) * R + r);
    }
    // cohortBusy: remove this period from s's cohort ONLY if no other session of s uses that period.
    for (const ci of SECTION_COHORTS[s])
      for (let j = 0; j < dur; j++) {
        // check whether section s has another session that also uses p+j (rare) — safe to remove
        st.cohortBusy[ci].delete(p + j);
      }
    st.lectPeriodRoom[lect].delete(p);
  }
  rebuildLectDayBuilding(st, lect);
  st.periods[s] = [];
  st.rooms[s] = [];
  st.lecturers[s] = -1;
}

function reconstructState(sol: GreedySolution): GreedyState {
  const st: GreedyState = {
    periods: sol.periods.map(p => [...p]),
    rooms: sol.rooms.map(r => [...r]),
    lecturers: [...sol.lecturers],
    lectUsed: Array.from({ length: L }, () => new Set<number>()),
    roomUsed: Array.from({ length: R }, () => new Set<number>()),
    cohortBusy: Array.from({ length: COHORTS.length }, () => new Set<number>()),
    lectDayBuilding: Array.from({ length: L }, () => new Map<number, string>()),
    lectPeriodRoom: Array.from({ length: L }, () => new Map<number, number>()),
    slotOccupant: new Map<number, number>(),
  };
  for (let s = 0; s < S; s++) {
    if (st.lecturers[s] < 0) continue;
    commitSectionST(st, s, st.lecturers[s], st.periods[s], st.rooms[s]);
  }
  return st;
}

// Check cohort-free for repair (on a GreedyState).
function cohortRangeFreeST(s: number, start: number, dur: number, st: GreedyState): boolean {
  for (const ci of SECTION_COHORTS[s])
    for (let j = 0; j < dur; j++)
      if (st.cohortBusy[ci].has(start + j)) return false;
  return true;
}

// Try to place section s; on failure, evict 1 conflicting section & re-plan.
// `movable` (optional): only sections in this set may be evicted.
function repairSection(
  s: number,
  st: GreedyState,
  sectionValidRooms: number[][],
  movable?: Set<number>,
): boolean {
  const vr = sectionValidRooms[s];
  if (greedyPlaceSectionST(s, vr, st)) return true;

  const dur = duration(s);
  const starts = VALID_STARTS[Math.min(dur, 4) - 1];
  let attempts = 0;
  for (const lect of SECTIONS[s].lecturers) {
    for (const p of starts) {
      if (attempts >= 200) break;
      let lectFree = true;
      for (let j = 0; j < dur; j++) if (st.lectUsed[lect].has(p + j)) { lectFree = false; break; }
      if (!lectFree) continue;
      if (!cohortRangeFreeST(s, p, dur, st)) continue;
      const dayBldg = st.lectDayBuilding[lect].get(PERIODS[p].day);
      for (const r of vr) {
        if (dayBldg && ROOMS[r].building !== dayBldg) continue;
        // find the occupant in range [p, p+dur-1] in room r (busy room = eviction candidate)
        let sOcc = -1;
        for (let j = 0; j < dur; j++) {
          const occ = st.slotOccupant.get((p + j) * R + r);
          if (occ !== undefined && occ !== s) { sOcc = occ; break; }
        }
        if (sOcc < 0) continue;
        if (movable && !movable.has(sOcc)) continue;
        attempts++;
        const occLect = st.lecturers[sOcc], occPs = [...st.periods[sOcc]], occRs = [...st.rooms[sOcc]];
        evictSectionST(st, sOcc);
        if (greedyPlaceSectionST(sOcc, sectionValidRooms[sOcc], st)) {
          if (greedyPlaceSectionST(s, vr, st)) return true;
          evictSectionST(st, sOcc);
          commitSectionST(st, sOcc, occLect, occPs, occRs);
        } else {
          commitSectionST(st, sOcc, occLect, occPs, occRs);
        }
      }
    }
  }
  return false;
}

// Version of greedyPlaceSection that works on a GreedyState (for repair).
function greedyPlaceSectionST(s: number, validRooms: number[], st: GreedyState): boolean {
  return greedyPlaceSection(
    s, validRooms, st.lectUsed, st.roomUsed, st.cohortBusy,
    st.periods, st.rooms, st.lecturers, st.lectDayBuilding, st.lectPeriodRoom,
  );
}

// Run repair on the partial greedy solution. Return true if all unplaced are resolved.
function repairSolution(sol: GreedySolution, sectionValidRooms: number[][], movable?: Set<number>): boolean {
  if (!sol.unplaced || sol.unplaced.size === 0) return true;
  greedyRng = mulberry32(99999);
  const st = reconstructState(sol);
  let allOk = true;
  for (const s of [...sol.unplaced]) {
    if (repairSection(s, st, sectionValidRooms, movable)) sol.unplaced.delete(s);
    else allOk = false;
  }
  sol.periods = st.periods;
  sol.rooms = st.rooms;
  sol.lecturers = st.lecturers;
  return allOk;
}

function greedyReschedulePartial(
  sol1: DecodedSolution,
  _affectedSet: Set<number>,
  sectionValidRooms: number[][],
): GreedySolution | null {
  // Reschedule = re-run the full greedy pipeline (restart + repair) with
  // rooms blocked, but BIASED to the phase-1 solution (stability) so that sections
  // not affected stay in their positions (minimal disruption). Sections that
  // use a blocked room automatically fail stability (room invalid) → re-placed.
  return greedySolve(sectionValidRooms, sol1);
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. INTERVAL MODEL BUILDER
// ═══════════════════════════════════════════════════════════════════════════

const COURSE_PREF_WEIGHT = 3;
const FAC_PREF_WEIGHT    = 1;

interface BuiltModel {
  model:             CpModel;
  sessionPeriod:     IntVarImpl[][];
  lectPresVars:      BoolVarImpl[][];
  roomPresVars:      BoolVarImpl[][][];
  sectionValidRooms: number[][];
}

function buildIntervalModel(
  sectionValidRooms: number[][],
  greedy: GreedySolution,
  fixedSections?: Set<number>,
): BuiltModel {
  const model = new CpModel();

  // Period variables per section per session — domain restricted to start-valid
  // (fit in a day, no lunch crossing) according to course duration.
  const sessionPeriod: IntVarImpl[][] = [];
  for (let s = 0; s < S; s++) {
    const dur = duration(s);
    const starts = VALID_STARTS[Math.min(dur, 4) - 1];
    const arr: IntVarImpl[] = [];
    for (let k = 0; k < sessCount(s); k++) {
      const v = model.newIntVar(0, TOTAL_P - 1, `p${s}_${k}`);
      model.addAllowedAssignments([v], starts.map(p => [p]));
      arr.push(v);
    }
    sessionPeriod.push(arr);
  }

  // Section intervals (non-optional, size=duration) — used by cohort NoOverlap.
  const sectionInterval: IntervalVarImpl[][] = [];
  for (let s = 0; s < S; s++) {
    const arr: IntervalVarImpl[] = [];
    for (let k = 0; k < sessCount(s); k++)
      arr.push(model.newFixedSizeIntervalVar(sessionPeriod[s][k], duration(s), `ivs${s}_${k}`));
    sectionInterval.push(arr);
  }

  // Multi-session sections: sessions on different days
  for (let s = 0; s < S; s++) {
    const ps = sessionPeriod[s];
    if (ps.length < 2) continue;
    model.addAllDifferent(ps);
    const dayVars: IntVarImpl[] = [];
    for (let k = 0; k < ps.length; k++) {
      const d = model.newIntVar(0, DAYS - 1, `d${s}_${k}`);
      dayVars.push(d);
      model.addLinearConstraint(ps[k].sub(d.mul(H_PER_DAY)), 0, H_PER_DAY - 1);
    }
    model.addAllDifferent(dayVars);
  }

  // Lecturer intervals & NoOverlap (size = course duration)
  const lectIntervals: IntervalVarImpl[][] = Array.from({ length: L }, () => []);
  const lectPresVars: BoolVarImpl[][] = [];
  for (let s = 0; s < S; s++) {
    const eligLects = SECTIONS[s].lecturers;
    const dur = duration(s);
    const presVars: BoolVarImpl[] = [];
    for (let li = 0; li < eligLects.length; li++) {
      const l    = eligLects[li];
      const pres = model.newBoolVar(`lp${s}_${l}`);
      presVars.push(pres);
      for (let k = 0; k < sessCount(s); k++) {
        lectIntervals[l].push(
          model.newOptionalFixedSizeIntervalVar(sessionPeriod[s][k], dur, pres, `ivl${s}_${l}_${k}`)
        );
      }
    }
    model.addExactlyOne(presVars);
    lectPresVars.push(presVars);
  }
  for (let l = 0; l < L; l++) {
    if (lectIntervals[l].length > 1) model.addNoOverlap(lectIntervals[l]);
  }

  // Room intervals & NoOverlap (size = course duration)
  const roomIntervals: IntervalVarImpl[][] = Array.from({ length: R }, () => []);
  const roomPresVars: BoolVarImpl[][][] = [];
  for (let s = 0; s < S; s++) {
    const sessionRoomVars: BoolVarImpl[][] = [];
    const validRooms = sectionValidRooms[s];
    const dur = duration(s);
    for (let k = 0; k < sessCount(s); k++) {
      const presVars: BoolVarImpl[] = [];
      for (let ri = 0; ri < validRooms.length; ri++) {
        const r    = validRooms[ri];
        const pres = model.newBoolVar(`rp${s}_${k}_${r}`);
        presVars.push(pres);
        roomIntervals[r].push(
          model.newOptionalFixedSizeIntervalVar(sessionPeriod[s][k], dur, pres, `ivr${s}_${k}_${r}`)
        );
      }
      model.addExactlyOne(presVars);
      sessionRoomVars.push(presVars);
    }
    roomPresVars.push(sessionRoomVars);
  }
  for (let r = 0; r < R; r++) {
    if (roomIntervals[r].length > 1) model.addNoOverlap(roomIntervals[r]);
  }

  // Student NoOverlap via COHORT (curriculum): each cohort = a set of sections
  // taken together by a group of students → all their sessions must not overlap.
  // Replaces the old package constraint (more general & accurate per-student).
  for (let ci = 0; ci < COHORTS.length; ci++) {
    const secs = COHORTS[ci];
    if (secs.length < 2) continue;
    const ivls: IntervalVarImpl[] = [];
    for (const s of secs) for (let k = 0; k < sessCount(s); k++) ivls.push(sectionInterval[s][k]);
    if (ivls.length > 1) model.addNoOverlap(ivls);
  }

  // Hints & fixed-section hard constraints
  const unplaced = greedy.unplaced ?? new Set<number>();
  for (let s = 0; s < S; s++) {
    const validRooms = sectionValidRooms[s];
    const numSess    = sessCount(s);
    const chosenLect = greedy.lecturers[s];

    // Section unplaced by greedy → no hint; CP solver is free to place it.
    if (unplaced.has(s)) continue;

    if (fixedSections && fixedSections.has(s)) {
      for (let k = 0; k < numSess; k++)
        model.add(sessionPeriod[s][k].eq(greedy.periods[s][k]));
      for (let li = 0; li < SECTIONS[s].lecturers.length; li++) {
        if (SECTIONS[s].lecturers[li] === chosenLect) model.addBoolAnd([lectPresVars[s][li]]);
        else model.add(lectPresVars[s][li].le(0));
      }
      for (let k = 0; k < numSess; k++) {
        for (let ri = 0; ri < validRooms.length; ri++) {
          if (greedy.rooms[s][k] === validRooms[ri]) model.addBoolAnd([roomPresVars[s][k][ri]]);
          else model.add(roomPresVars[s][k][ri].le(0));
        }
      }
    } else {
      for (let k = 0; k < numSess; k++)
        model.addHint(sessionPeriod[s][k], greedy.periods[s][k]);
      for (let li = 0; li < SECTIONS[s].lecturers.length; li++)
        model.addHint(lectPresVars[s][li], SECTIONS[s].lecturers[li] === chosenLect ? 1 : 0);
      for (let k = 0; k < numSess; k++)
        for (let ri = 0; ri < validRooms.length; ri++)
          model.addHint(roomPresVars[s][k][ri], greedy.rooms[s][k] === validRooms[ri] ? 1 : 0);
    }
  }

  // Objective: maximize course-preference + facility-preference bonuses
  const objTerms: LinearExpr[] = [];

  for (let s = 0; s < S; s++) {
    const courseId   = COURSES[SECTIONS[s].courseIdx].id;
    const validRooms = sectionValidRooms[s];

    for (let li = 0; li < SECTIONS[s].lecturers.length; li++) {
      const l       = SECTIONS[s].lecturers[li];
      const lect    = LECTURERS[l];
      const lectPres = lectPresVars[s][li];

      // Course preference bonus (linear, cheap — no extra BoolVar).
      if (lect.preferredCourses.includes(courseId))
        objTerms.push(LinearExpr.fromVar(lectPres).mul(COURSE_PREF_WEIGHT));

      // Facility preference bonus: sum of roomPres (selected room) matching the
      // lecturer's preferredFac. Linear with existing roomPresVars — no conjunction
      // BoolVar (conjunctions bloat the model & slow down CP search).
      if (lect.preferredFac.length > 0) {
        for (let k = 0; k < sessCount(s); k++) {
          for (let ri = 0; ri < validRooms.length; ri++) {
            const r = validRooms[ri];
            if (!lect.preferredFac.every(f => ROOMS[r].fac.includes(f))) continue;
            objTerms.push(LinearExpr.fromVar(roomPresVars[s][k][ri]).mul(FAC_PREF_WEIGHT));
          }
        }
      }
    }
  }

  if (objTerms.length > 0) {
    let obj = objTerms[0];
    for (let i = 1; i < objTerms.length; i++) obj = obj.add(objTerms[i]);
    model.maximize(obj);
  }

  return { model, sessionPeriod, lectPresVars, roomPresVars, sectionValidRooms };
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. DECODE SOLUTION
// ═══════════════════════════════════════════════════════════════════════════

interface DecodedSolution {
  period: number[][];
  lect:   number[];
  room:   number[][];
}

function decodeSolution(built: BuiltModel, solver: CpSolver): DecodedSolution {
  const period: number[][] = [];
  const lect:   number[]   = [];
  const room:   number[][] = [];

  for (let s = 0; s < S; s++) {
    const numSess    = sessCount(s);
    const validRooms = built.sectionValidRooms[s];

    period.push(Array.from({ length: numSess }, (_, k) => solver.value(built.sessionPeriod[s][k])));

    const liFound = SECTIONS[s].lecturers.findIndex((_, li) =>
      solver.value(built.lectPresVars[s][li]) === 1);
    if (liFound === -1) throw new Error(`No lecturer selected for section ${s}`);
    lect.push(SECTIONS[s].lecturers[liFound]);

    const rs: number[] = [];
    for (let k = 0; k < numSess; k++) {
      const riFound = validRooms.findIndex((_, ri) =>
        solver.value(built.roomPresVars[s][k][ri]) === 1);
      if (riFound === -1) throw new Error(`No room selected for section ${s}, session ${k}`);
      rs.push(validRooms[riFound]);
    }
    room.push(rs);
  }

  return { period, lect, room };
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. PREFERENCE STATISTICS
// ═══════════════════════════════════════════════════════════════════════════

function printStats(sol: DecodedSolution, label: string): void {
  let totalSessions   = 0;
  let dislikedViol    = 0;
  let coursePref      = 0;
  let facPref         = 0;
  let contiguousSame  = 0;
  let contiguousTotal = 0;
  let bldgViol        = 0;

  // Building violation check: same lect, same day, different building
  const lectDayBuildings: Map<number, Map<number, Set<string>>> = new Map();
  for (let s = 0; s < S; s++) {
    const l = sol.lect[s];
    if (!lectDayBuildings.has(l)) lectDayBuildings.set(l, new Map());
    const dayMap = lectDayBuildings.get(l)!;
    for (let k = 0; k < sessCount(s); k++) {
      const day  = PERIODS[sol.period[s][k]].day;
      const bldg = ROOMS[sol.room[s][k]].building;
      if (!dayMap.has(day)) dayMap.set(day, new Set());
      dayMap.get(day)!.add(bldg);
    }
  }
  for (const dayMap of lectDayBuildings.values())
    for (const bldgs of dayMap.values())
      if (bldgs.size > 1) bldgViol++;

  // Preferences and continuity
  let slotHours = 0;
  for (let s = 0; s < S; s++) {
    const l      = sol.lect[s];
    const lect   = LECTURERS[l];
    const cId    = COURSES[SECTIONS[s].courseIdx].id;
    const numSess = sessCount(s);
    const dur    = duration(s);

    if (lect.preferredCourses.includes(cId)) coursePref++;

    for (let k = 0; k < numSess; k++) {
      totalSessions++;
      slotHours += dur;
      const start = sol.period[s][k];
      const room = ROOMS[sol.room[s][k]];
      // disliked-hour violation if any hour covered by the session (duration).
      for (let j = 0; j < dur; j++)
        if (lect.disliked.includes(PERIODS[start + j].hour)) { dislikedViol++; break; }
      if (lect.preferredFac.length > 0 && lect.preferredFac.every(f => room.fac.includes(f)))
        facPref++;
    }
  }

  // Per-student clash VERIFICATION (hybrid: groups for the solver, individual verification).
  // Check each student: the sections they take must not overlap in time.
  const stuSections: number[][] = Array.from({ length: M }, () => []);
  for (let s = 0; s < S; s++) for (const stu of SECTIONS[s].roster) stuSections[stu].push(s);
  let studentClashes = 0;
  for (let stu = 0; stu < M; stu++) {
    const occupied: number[] = [];   // period-level (already accounts for duration)
    for (const s of stuSections[stu]) {
      const dur = duration(s);
      for (let k = 0; k < sessCount(s); k++) {
        const start = sol.period[s][k];
        for (let j = 0; j < dur; j++) occupied.push(start + j);
      }
    }
    const uniq = new Set(occupied);
    if (uniq.size !== occupied.length) studentClashes++;
  }

  // Continuity: check adjacent periods for same lect same day
  const lectPeriodRoom: Map<number, Map<number, number>> = new Map();
  for (let s = 0; s < S; s++) {
    const l = sol.lect[s];
    if (!lectPeriodRoom.has(l)) lectPeriodRoom.set(l, new Map());
    const pr = lectPeriodRoom.get(l)!;
    for (let k = 0; k < sessCount(s); k++)
      pr.set(sol.period[s][k], sol.room[s][k]);
  }
  for (const periodMap of lectPeriodRoom.values()) {
    const periods = [...periodMap.keys()].sort((a, b) => a - b);
    for (let i = 0; i < periods.length - 1; i++) {
      const p1 = periods[i], p2 = periods[i + 1];
      if (p2 === p1 + 1 && PERIODS[p1].day === PERIODS[p2].day) {
        contiguousTotal++;
        if (periodMap.get(p1) === periodMap.get(p2)) contiguousSame++;
      }
    }
  }

  console.log(`\n  [${label}] Preferences & Constraints:`);
  console.log(`    Building violations  : ${bldgViol} (0 = perfect)`);
  console.log(`    Student clashes      : ${studentClashes}/${M} students (0 = perfect)`);
  console.log(`    Course preference    : ${coursePref}/${S} sections (${Math.round(100*coursePref/S)}%)`);
  console.log(`    Facility preference  : ${facPref}/${totalSessions} sessions (${Math.round(100*facPref/totalSessions)}%)`);
  console.log(`    Disliked hours       : ${dislikedViol}/${totalSessions} sessions (${Math.round(100*dislikedViol/totalSessions)}% violations)`);
  if (contiguousTotal > 0)
    console.log(`    Room continuity      : ${contiguousSame}/${contiguousTotal} adjacent pairs in same room (${Math.round(100*contiguousSame/contiguousTotal)}%)`);
  const util = slotHours / (R * TOTAL_P);
  console.log(`    Room utilization     : ${slotHours}/${R * TOTAL_P} slot-hours (${Math.round(100 * util)}%)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. CSV WRITING
// ═══════════════════════════════════════════════════════════════════════════

function csvCell(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n'))
    return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function writeCSV(filePath: string, rows: string[][]): void {
  writeFileSync(
    filePath,
    rows.map(row => row.map(csvCell).join(',')).join('\n'),
    'utf8',
  );
}

function shortName(lectId: string): string {
  return lectId.replace(/^(Dr\.|Prof\.)\s*/, '');
}

function writeTimeGridCSV(sol: DecodedSolution, outputDir: string, prefix = 'timetable'): void {
  const grid = new Map<string, string[]>();
  for (const h of HOURS)
    for (let d = 0; d < DAYS; d++)
      grid.set(`${h}:${d}`, []);

  for (let s = 0; s < S; s++) {
    for (let k = 0; k < sessCount(s); k++) {
      const per    = PERIODS[sol.period[s][k]];
      const roomId = ROOMS[sol.room[s][k]].id;
      const lect   = shortName(LECTURERS[sol.lect[s]].id);
      grid.get(`${per.hour}:${per.day}`)!.push(`${SECTIONS[s].id} (${roomId}, ${lect})`);
    }
  }

  const rows: string[][] = [['Hour', ...DAY_NAMES]];
  for (const h of HOURS) {
    const row = [`${String(h).padStart(2, '0')}:00`];
    for (let d = 0; d < DAYS; d++)
      row.push((grid.get(`${h}:${d}`) ?? []).join(' | '));
    rows.push(row);
  }

  const filePath = join(outputDir, `${prefix}-time-grid.csv`);
  writeCSV(filePath, rows);
  console.log(`  Wrote: ${filePath}`);
}

function writeRoomGridCSV(sol: DecodedSolution, outputDir: string, prefix = 'timetable'): void {
  const grid: string[][] = Array.from({ length: TOTAL_P }, () => new Array(R).fill(''));

  for (let s = 0; s < S; s++) {
    for (let k = 0; k < sessCount(s); k++) {
      const p    = sol.period[s][k];
      const r    = sol.room[s][k];
      const lect = shortName(LECTURERS[sol.lect[s]].id);
      grid[p][r] = `${SECTIONS[s].id} (${lect})`;
    }
  }

  const rows: string[][] = [['Time', ...ROOMS.map(r => `${r.id} [${r.building}]`)]];
  for (let p = 0; p < TOTAL_P; p++)
    rows.push([fmtPeriod(p), ...grid[p]]);

  const filePath = join(outputDir, `${prefix}-room-grid.csv`);
  writeCSV(filePath, rows);
  console.log(`  Wrote: ${filePath}`);
}

function writeLecturerGridCSV(sol: DecodedSolution, outputDir: string, prefix = 'timetable'): void {
  const grid: string[][] = Array.from({ length: TOTAL_P }, () => new Array(L).fill(''));

  for (let s = 0; s < S; s++) {
    for (let k = 0; k < sessCount(s); k++) {
      const p      = sol.period[s][k];
      const l      = sol.lect[s];
      const roomId = ROOMS[sol.room[s][k]].id;
      grid[p][l]   = `${SECTIONS[s].id} (${roomId})`;
    }
  }

  const rows: string[][] = [['Time', ...LECTURERS.map(l => l.id)]];
  for (let p = 0; p < TOTAL_P; p++)
    rows.push([fmtPeriod(p), ...grid[p]]);

  const filePath = join(outputDir, `${prefix}-lecturer-grid.csv`);
  writeCSV(filePath, rows);
  console.log(`  Wrote: ${filePath}`);
}

function writeAllCSV(sol: DecodedSolution, outputDir: string, prefix: string): void {
  writeTimeGridCSV(sol, outputDir, prefix);
  writeWeekGridCSV(sol, outputDir, prefix);
  writeRoomGridCSV(sol, outputDir, prefix);
  writeLecturerGridCSV(sol, outputDir, prefix);
}

// Grid between DAY (rows) × TIME/HOUR (columns): weekly occupancy matrix.
// Each cell = "number of sections · total students" running in that slot.
// Useful for viewing a utilization heat-map: which slots are dense/empty.
function writeWeekGridCSV(sol: DecodedSolution, outputDir: string, prefix = 'timetable'): void {
  // counts[day][hourIdx] = { classes, students }
  const counts: { classes: number; students: number }[][] =
    Array.from({ length: DAYS }, () => Array.from({ length: H_PER_DAY }, () => ({ classes: 0, students: 0 })));

  for (let s = 0; s < S; s++) {
    const students = SECTIONS[s].roster.length;   // actual students in the section
    const dur = duration(s);
    for (let k = 0; k < sessCount(s); k++) {
      const startHi = HOURS.indexOf(PERIODS[sol.period[s][k]].hour);
      const day = PERIODS[sol.period[s][k]].day;
      // a duration-hour section occupies each hour in its range (slot-hour occupancy).
      for (let j = 0; j < dur; j++) {
        const hi = startHi + j;
        if (hi < 0 || hi >= H_PER_DAY) continue;
        counts[day][hi].classes++;
        counts[day][hi].students += students;
      }
    }
  }

  const rows: string[][] = [['Day', ...HOURS.map(h => `${String(h).padStart(2, '0')}:00`), 'Total']];
  let grandClasses = 0;
  for (let d = 0; d < DAYS; d++) {
    let dayClasses = 0;
    const row = [DAY_NAMES[d]];
    for (let hi = 0; hi < H_PER_DAY; hi++) {
      const c = counts[d][hi];
      dayClasses += c.classes;
      row.push(c.classes > 0 ? `${c.classes}·${c.students}` : '-');
    }
    grandClasses += dayClasses;
    row.push(String(dayClasses));
    rows.push(row);
  }
  // Total row per hour
  const totalRow = ['Total'];
  for (let hi = 0; hi < H_PER_DAY; hi++) {
    let n = 0;
    for (let d = 0; d < DAYS; d++) n += counts[d][hi].classes;
    totalRow.push(String(n));
  }
  totalRow.push(String(grandClasses));
  rows.push(totalRow);

  const filePath = join(outputDir, `${prefix}-week-grid.csv`);
  writeCSV(filePath, rows);
  console.log(`  Wrote: ${filePath}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 12. MAIN
// ═══════════════════════════════════════════════════════════════════════════

function main(): void {
  const t0   = Date.now();
  const opts = parseArgs();

  console.log('════════════════════════════════════════════════════════════════');
  console.log(' CP-SAT Campus Timetabling — 5 Faculties · 15 Programs · 8 Buildings');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(` Input: ${opts.inputDir}`);
  console.log(` Output: ${opts.outputDir}`);
  if (opts.blockedRooms.length > 0)
    console.log(` Blocked: ${opts.blockedRooms.join(', ')}`);

  loadData(opts.inputDir);
  console.log(`\n Instance: ${S} sections | ${C} courses | ${L} lecturers | ${M} students | ${COHORTS.length} cohort | ${R} rooms | ${TOTAL_P} slots`);

  if (!existsSync(opts.outputDir))
    mkdirSync(opts.outputDir, { recursive: true });

  // ── PHASE 1: INITIAL SCHEDULE ─────────────────────────────────────────────
  console.log('\n[PHASE 1] Building initial schedule...');
  const validRooms1 = computeSectionValidRooms();

  const tG1    = Date.now();
  const greedy1 = greedySolve(validRooms1);
  if (!greedy1) { console.error('  Greedy failed!'); process.exit(1); }
  const nUnplaced1 = greedy1.unplaced?.size ?? 0;
  console.log(`  Greedy done: ${Date.now() - tG1}ms` + (nUnplaced1 > 0
    ? ` (${S - nUnplaced1}/${S} sections; ${nUnplaced1} unplaced)` : ''));

  // Repair eviction to finish unplaced sections (high density).
  if (greedy1.unplaced && greedy1.unplaced.size > 0) {
    const tR = Date.now();
    const ok = repairSolution(greedy1, validRooms1);
    const after = greedy1.unplaced?.size ?? 0;
    console.log(`  Repair eviction: ${Date.now() - tR}ms → ${after === 0 ? 'ALL resolved' : `${after} still unplaced`}` + (ok ? '' : ' (partial)'));
  }

  // If greedy is partial (some sections unplaced), FIX the already-placed sections
  // as a hard constraint → CP only searches placement for unplaced sections (fast).
  const fixed1 = (greedy1.unplaced && greedy1.unplaced.size > 0)
    ? new Set(Array.from({ length: S }, (_, i) => i).filter(i => !greedy1.unplaced!.has(i)))
    : undefined;
  const built1  = buildIntervalModel(validRooms1, greedy1, fixed1);
  const solver1 = new CpSolver();
  solver1.parameters.maxTimeInSeconds = parseInt(process.env.CP_TIMEOUT ?? "60", 10);

  const tCP1   = Date.now();
  const stat1  = solver1.solve(built1.model);
  const objVal1 = solver1.objectiveValue;
  console.log(`  CP Solver: ${CpSolverStatus[stat1]} | ${solver1.numBranches} branch | ${Date.now() - tCP1}ms | obj=${objVal1}`);

  if (stat1 !== CpSolverStatus.OPTIMAL && stat1 !== CpSolverStatus.FEASIBLE) {
    console.error('  Failed to find a schedule!'); process.exit(1);
  }

  const sol1 = decodeSolution(built1, solver1);
  printStats(sol1, 'Initial Schedule');

  console.log('\n[PHASE 1] Saving initial schedule CSV...');
  writeAllCSV(sol1, opts.outputDir, 'timetable');

  // ── PHASE 2+3: RESCHEDULING (if there are blocks) ─────────────────────────
  if (opts.blockedRooms.length === 0) {
    console.log(`\n Total time: ${Date.now() - t0}ms`);
    return;
  }

  const blockedIdxs = opts.blockedRooms.map(id => {
    const idx = ROOMS.findIndex(r => r.id === id);
    if (idx === -1) console.warn(`  Warning: room "${id}" not found, ignored.`);
    return idx;
  }).filter(i => i !== -1);

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(` PERTURBATION: ${opts.blockedRooms.join(', ')} blocked`);
  console.log('════════════════════════════════════════════════════════════════');

  const affectedSet = new Set<number>();
  for (let s = 0; s < S; s++)
    for (let k = 0; k < sessCount(s); k++)
      if (blockedIdxs.includes(sol1.room[s][k])) affectedSet.add(s);

  console.log(`\n[PHASE 2] Impact analysis: ${affectedSet.size} affected sections`);
  for (const s of affectedSet) {
    for (let k = 0; k < sessCount(s); k++) {
      if (blockedIdxs.includes(sol1.room[s][k]))
        console.log(`    ${SECTIONS[s].id.padEnd(14)} Session${k+1}: ${fmtPeriod(sol1.period[s][k])}, ${ROOMS[sol1.room[s][k]].id}`);
    }
  }

  console.log('\n[PHASE 3] Rescheduling with minimal disruption...');
  const validRooms2 = computeSectionValidRooms(blockedIdxs);
  const tG2     = Date.now();
  const greedyR = greedyReschedulePartial(sol1, affectedSet, validRooms2);
  if (!greedyR) { console.error('  Partial greedy failed!'); process.exit(1); }
  const nUnplaced2 = greedyR.unplaced?.size ?? 0;
  console.log(`  Greedy reschedule: ${Date.now() - tG2}ms` + (nUnplaced2 > 0
    ? ` (${S - nUnplaced2}/${S} sections; ${nUnplaced2} unplaced)` : ''));

  if (greedyR.unplaced && greedyR.unplaced.size > 0) {
    const tR = Date.now();
    repairSolution(greedyR, validRooms2);
    const after = greedyR.unplaced?.size ?? 0;
    console.log(`  Repair eviction: ${Date.now() - tR}ms → ${after === 0 ? 'ALL resolved' : `${after} still unplaced`}`);
  }

  // greedyR is the full solution (stability-biased); hint all sections, CP validates.
  const built2  = buildIntervalModel(validRooms2, greedyR);
  const solver2 = new CpSolver();
  solver2.parameters.maxTimeInSeconds = 60;

  const tCP2   = Date.now();
  const stat2  = solver2.solve(built2.model);
  const objVal2 = solver2.objectiveValue;
  console.log(`  CP Solver: ${CpSolverStatus[stat2]} | ${solver2.numBranches} branch | ${Date.now() - tCP2}ms | obj=${objVal2}`);

  if (stat2 !== CpSolverStatus.OPTIMAL && stat2 !== CpSolverStatus.FEASIBLE) {
    console.error('  Failed to find a replacement schedule!'); process.exit(1);
  }

  const sol2 = decodeSolution(built2, solver2);
  printStats(sol2, 'Rescheduled');

  let same = 0;
  for (let s = 0; s < S; s++) {
    if (affectedSet.has(s)) continue;
    if (sol1.period[s].every((p, k) => p === sol2.period[s][k]) &&
        sol1.lect[s] === sol2.lect[s] &&
        sol1.room[s].every((r, k) => r === sol2.room[s][k])) same++;
  }
  console.log(`\n  Unaffected sections kept identical: ${same}/${S - affectedSet.size}`);

  console.log('\n[PHASE 3] Saving rescheduled CSV...');
  writeAllCSV(sol2, opts.outputDir, 'reschedule');

  console.log(`\n Total time: ${Date.now() - t0}ms`);
}

main();
