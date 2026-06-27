/**
 * Deterministic generator for large-scale campus data.
 * =======================================================
 * Produces courses.csv, sections.csv, lecturers.csv with target utilization
 * ~TARGET_UTIL against the total room-slot count (R × 40).
 *
 * Feasibility guards:
 *   - Per-package session budget ≤ PKG_BUDGET (so distinct-period need ≤ 40 slots)
 *   - Per-facility session load ≤ 0.85 × capacity of that facility's rooms
 *   - Balanced lecturer load (round-robin lecturer-eligibility assignment)
 *
 * Run:
 *   npx tsx examples/data/campus/gen-scale.ts
 *   npx tsx examples/data/campus/gen-scale.ts --util=0.80
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HERE = __dirname;

// ─────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────
const TARGET_UTIL = parseFloat(
  (process.argv.find(a => a.startsWith('--util=')) ?? '--util=0.60').slice(7),
);
const SLOTS_PER_ROOM = 40; // 5 days × 8 hours
const PKG_BUDGET = 24;     // max sessions per package (≤ 40 slots is safe)
const FAC_HEADROOM = 0.85; // facility load ≤ 85% of capacity
const PKG_PER_PRODI = 6;   // packages (cohorts) per prodi → more = looser
const SECTION_CAP = 6;     // max sections per course
const FAC_SCALE = 0.4;     // scale the proportion of facility-bound courses (computer/smartboard/lab)

// ─────────────────────────────────────────────────────────────────────────
// ROOMS (from the curated rooms.csv)
// ─────────────────────────────────────────────────────────────────────────
interface RoomDef { id: string; cap: number; fac: string[]; building: string; }

function parseCSVRow(line: string): string[] {
  const fields: string[] = [];
  let inQ = false, cur = '';
  for (const ch of [...line]) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { fields.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  fields.push(cur.trim());
  return fields;
}

const ROOMS: RoomDef[] = readFileSync(join(HERE, 'rooms.csv'), 'utf8')
  .split(/\r?\n/).map(l => l.trim()).filter(l => l.length && !l.startsWith('id,'))
  .map(parseCSVRow)
  .map(r => ({
    id: r[0],
    cap: parseInt(r[1], 10),
    fac: r[2] ? r[2].split(';').map(f => f.trim()).filter(Boolean) : [],
    building: r[3] ?? '',
  }));
const R = ROOMS.length;
const TOTAL_SLOTS = R * SLOTS_PER_ROOM;
const TARGET_SESSIONS = Math.round(TOTAL_SLOTS * TARGET_UTIL);

// Slot capacity per facility (rooms that HAVE that facility)
const facCapacity = (f: string): number =>
  ROOMS.filter(rm => rm.fac.includes(f)).reduce(s => s + SLOTS_PER_ROOM, 0);

console.log(`Rooms: ${R} | Total slots: ${TOTAL_SLOTS} | Target util: ${TARGET_UTIL} → ${TARGET_SESSIONS} sessions`);
for (const f of ['whiteboard', 'smartboard', 'computer', 'lab_software', 'projector'])
  console.log(`  capacity ${f}: ${facCapacity(f)} slots`);

// ─────────────────────────────────────────────────────────────────────────
// PRODI → BUILDING → FACILITY PROFILE
// ─────────────────────────────────────────────────────────────────────────
// 5 faculties × 3 prodi = 15 prodi. Each prodi has a home building.
// Facility profile = proportion of courses that need a given facility.
interface ProdiDef {
  key: string; name: string; faculty: string; building: string;
  facProfile: { computer?: number; smartboard?: number; lab_soft?: number };
}
const PRODI: ProdiDef[] = [
  { key: 'TI',   name: 'Informatics Engineering',      faculty: 'FTI',   building: 'Building-A', facProfile: { computer: 0.55 } },
  { key: 'SI',   name: 'Information Systems',          faculty: 'FTI',   building: 'Building-A', facProfile: { computer: 0.45, lab_soft: 0.20 } },
  { key: 'TK',   name: 'Computer Engineering',         faculty: 'FTI',   building: 'Building-A', facProfile: { computer: 0.55, lab_soft: 0.20 } },
  { key: 'DS',   name: 'Data Science',                 faculty: 'FMIPA', building: 'Building-C', facProfile: { computer: 0.55, lab_soft: 0.25 } },
  { key: 'STAT', name: 'Statistics',                   faculty: 'FMIPA', building: 'Building-C', facProfile: { computer: 0.30, lab_soft: 0.25 } },
  { key: 'MAT',  name: 'Mathematics',                  faculty: 'FMIPA', building: 'Building-C', facProfile: { computer: 0.30 } },
  { key: 'MI',   name: 'Informatics Management',       faculty: 'FBIS',  building: 'Building-D', facProfile: { computer: 0.45, lab_soft: 0.20 } },
  { key: 'EB',   name: 'E-Business',                   faculty: 'FBIS',  building: 'Building-D', facProfile: { computer: 0.30, smartboard: 0.40 } },
  { key: 'KT',   name: 'Digital Communication',        faculty: 'FBIS',  building: 'Building-D', facProfile: { smartboard: 0.50, computer: 0.20 } },
  { key: 'DKV',  name: 'Visual Communication Design',  faculty: 'FDes',  building: 'Building-E', facProfile: { computer: 0.40, smartboard: 0.50 } },
  { key: 'AD',   name: 'Digital Animation',            faculty: 'FDes',  building: 'Building-E', facProfile: { computer: 0.55, smartboard: 0.45 } },
  { key: 'MDA',  name: 'Digital Multimedia',           faculty: 'FDes',  building: 'Building-E', facProfile: { computer: 0.45, smartboard: 0.30 } },
  { key: 'IK',   name: 'Health Informatics',           faculty: 'FKes',  building: 'Building-F', facProfile: { computer: 0.45, lab_soft: 0.20 } },
  { key: 'TB',   name: 'Biomedical Technology',        faculty: 'FKes',  building: 'Building-F', facProfile: { computer: 0.50, lab_soft: 0.20 } },
  { key: 'RM',   name: 'Medical Records',              faculty: 'FKes',  building: 'Building-F', facProfile: { computer: 0.40 } },
];

// Course-name pool per prodi (varied enough for ~10 courses/prodi)
const COURSE_WORDS: Record<string, string[]> = {
  TI:   ['Algorithms & Data Structures', 'Computer Networks', 'Object-Oriented Programming', 'Artificial Intelligence', 'Software Engineering', 'Cybersecurity', 'Databases', 'Distributed Systems', 'Computer Graphics', 'Mobile Programming'],
  SI:   ['Systems Analysis & Design', 'IT Project Management', 'Enterprise Resource Planning', 'Business Intelligence', 'IT Governance', 'Information Systems Audit', 'Human-Computer Interaction', 'Decision Support Systems', 'E-Government', 'Data Warehouse'],
  TK:   ['Computer Architecture', 'Operating Systems', 'Embedded Systems', 'Wireless Networks', 'Internet of Things', 'Intro to Robotics', 'Microcontrollers', 'Digital Signal Processing', 'Cloud Computing', 'Network Security'],
  DS:   ['Intro to Data Science', 'Inferential Statistics', 'Intro to Machine Learning', 'Data Visualization', 'Data Programming in Python', 'Data Mining', 'Deep Learning', 'Big Data Analytics', 'Intro to NLP', 'Exploratory Data Analysis'],
  STAT: ['Introductory Statistics', 'Probability & Bayes', 'Computational Statistics', 'Regression Analysis', 'Design of Experiments', 'Nonparametric Statistics', 'Time Series Analysis', 'Survey Sampling', 'Spatial Statistics', 'Numerical Methods for Statistics'],
  MAT:  ['Numerical Algorithms', 'Discrete Mathematics', 'Calculus & Vectors', 'Linear Algebra', 'Differential Equations', 'Graph Theory', 'Mathematical Logic', 'Financial Mathematics', 'Real Analysis', 'Optimization'],
  MI:   ['IT Accounting Systems', 'IT HR Management', 'Business Analytics', 'IT Organizational Communication', 'Resource Planning', 'IT Risk Management', 'Management Information Systems', 'Digital Business Processes', 'Data Governance', 'Digital Business Innovation'],
  EB:   ['Digital Communication', 'UX Design & Research', 'E-Commerce Systems', 'Digital Marketing', 'Digital Business', 'Supply Chain Management', 'Intro to Fintech', 'Digital Market Analysis', 'E-Business Strategy', 'Digital Business Law'],
  KT:   ['Digital Media', 'Digital Content Production', 'Social Media Strategy', 'Digital Journalism', 'Digital Photography', 'Podcasting', 'Community Management', 'Visual Communication Design', 'Brand Storytelling', 'Digital Media Ethics'],
  DKV:  ['Design Fundamentals', 'Digital Graphic Design', 'Brand & Identity Design', 'Digital Illustration', 'Typography', 'Packaging Design', 'Editorial Design', 'Design Photography', 'Motion Graphics', 'Information Design'],
  AD:   ['Intro to Animation', '3D Modeling & Rigging', 'Digital Visual Effects', 'Intro to Game Design', 'Character Animation', 'Storyboarding', 'Advanced Rigging', '2D Animation', 'Compositing', 'Stop Motion Animation'],
  MDA:  ['Digital Archive Management', 'Interactive Media Production', 'Interactive Web Design', 'Multimedia Animation', 'Digital Audio', 'Video Editing', 'Interactive Game Design', 'Intro to VR/AR', 'Multimedia Project Management', 'Digital Experience Design'],
  IK:   ['Health Information Systems', 'Health Data Management', 'Digital Health Communication', 'Health Data Analytics', 'Epidemiology & Informatics', 'Hospital Information Systems', 'Quality of Service Management', 'Telemedicine', 'Health Information Ethics', 'Health Data Security'],
  TB:   ['Biomedical Informatics', 'Biomedical Signal Processing', 'Digital Medical Technology', 'Health Ethics & Law', 'Medical Instrumentation', 'Digital Medical Imaging', 'Biomaterials', 'Medical Embedded Systems', 'Medical Robotics', 'Clinical Signal Analysis'],
  RM:   ['Electronic Medical Records', 'Clinical Coding (ICD)', 'Medical Records Management', 'Epidemiology & Informatics', 'Disease Classification', 'Health Information Systems', 'Health Statistics', 'Medical Records Law & Ethics', 'Digital Health Insurance', 'Medical Records Quality Management'],
};

// Lecturer name pool (first + last) for generating unique names
const FIRST = ['Adam','Benjamin','Catherine','Daniel','Emily','Felix','Grace','Henry','Isaac','Julia','Kevin','Laura','Michael','Nathan','Olivia','Patrick','Quentin','Rachel','Sarah','Thomas','Ulysses','Victoria','William','Youssef','Zachary','Alice','Bob','Charles','Diana','Edward','Fiona','George','Hannah','Ian','Jennifer','Kyle','Linda','Mark','Natalie','Oscar','Paula','Quinn','Robert','Sophia','Tara','Vera','Wendy','Xavier','Yvonne','Zane','Angela','Brandon','Colin','Dorothy','Evan','Frank','Gina','Harry','Iris','Jacob','Kelly','Leo','Mason','Nora','Owen','Penny','Quincy','Rita','Sam','Tina','Victor','Walter','Xena','Yara','Zoe','Bella','Adrian','Brian','Camila','David','Elena','Gregory','Holly','Ivan','Katie','Lily','Marcus','Noah','Penelope','Ryan','Steven','Tyler','Uma','Vincent','Will','Yusuf','Bryan','Diana','Emma'];
const LAST  = ['Anderson','Bennett','Carter','Davis','Edwards','Foster','Graham','Harris','Ingram','Johnson','King','Lewis','Mitchell','Nelson','Owens','Parker','Quinn','Roberts','Smith','Taylor','Underwood','Vasquez','Walker','Young','Zimmerman','Allen','Baker','Clark','Davis2','Evans','Fisher','Green','Hall','Irwin','Jones','Kelly','Lee','Moore','Norton','Olson','Phillips','Quigley','Reed','Stewart','Turner','Vega','Walsh','Xu','Yates','Ziegler','Adams','Brown','Cooper','Dixon','Ellis','Faulkner','Gibson','Hughes','Ibarra',' Jenkins','King2','Long','Miller','Newman','OConnor','Pierce','Reyes','Scott','Turnbull','Vaughn','Watson','Yoder','Adler','Barton','Chandler','Doyle','Easton','Flynn','Gordon','Holden','Iverson','Knox','Logan','Murray','Norris','Ortiz','Powell','Reynolds','Spencer','Tucker','Vargas','Webb','Young2','Zane'];
const TITLES = ['Prof.', 'Prof.', 'Dr.', 'Dr.', 'Dr.', 'Dr.']; // mostly Dr.

// Deterministic PRNG (mulberry32)
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260627);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
const chance = (p: number): boolean => rng() < p;

// Dedicated RNG for NAME generation only. Decouples cosmetic name choices
// (incl. collision-retry loops) from the structural RNG, so changing the name
// pools never perturbs which courses/sections/cohorts are generated.
const nameRng = mulberry32(77777);
const pickName = <T,>(arr: T[]): T => arr[Math.floor(nameRng() * arr.length)];

// ─────────────────────────────────────────────────────────────────────────
// GENERATE LECTURERS (per prodi, ~8 lecturers → 120 total)
// ─────────────────────────────────────────────────────────────────────────
interface LectOut { id: string; disliked: string; preferredFac: string; preferredCourses: string; }

const FAC_BY_BUILDING: Record<string, string[]> = {}; // building → available facilities
for (const r of ROOMS)
  FAC_BY_BUILDING[r.building] = Array.from(new Set([...(FAC_BY_BUILDING[r.building] ?? []), ...r.fac]));

interface CourseOut { id: string; name: string; spw: number; duration: number; students: number; fac: string; pkg: string; home: string; }
const COURSES: CourseOut[] = [];
const SECTIONS: { id: string; course: string; lects: string[]; students: string }[] = [];
const LECTURERS: LectOut[] = [];
const lecturerIdByProdi: Record<string, string[]> = {};   // prodi key → [lecturer id]

const usedNames = new Set<string>();
function newLectName(): string {
  for (let tries = 0; tries < 50; tries++) {
    const name = `${pickName(TITLES)} ${pickName(FIRST)} ${pickName(LAST)}`;
    if (!usedNames.has(name)) { usedNames.add(name); return name; }
  }
  return `${pickName(TITLES)} ${pickName(FIRST)} ${pickName(LAST)}-${usedNames.size}`;
}

// Phase 1: create courses first (needed for lecturer preferredCourses)
// Temporarily build the course structure for the id→fac mapping
interface CourseTmp { id: string; prodi: string; fac: string[]; }
function makeCourse(prodi: ProdiDef, wordIdx: number): CourseOut {
  const baseId = `${prodi.key}${wordIdx + 1}`;
  const words = COURSE_WORDS[prodi.key];
  const name = words[wordIdx % words.length] + (wordIdx >= words.length ? ' Advanced' : '');
  const spw = chance(0.78) ? 2 : 1;

  // 1) Decide facility FIRST, then cap students to the capacity of rooms that
  //    have that facility — so there is always a valid room (≥3 rooms) for the course.
  const fac: string[] = [];
  const roll = rng();
  const p = prodi.facProfile;
  const pc = (p.computer ?? 0) * FAC_SCALE;
  const pl = (p.lab_soft ?? 0) * FAC_SCALE;
  const ps = (p.smartboard ?? 0) * FAC_SCALE;
  const isLab = pc > 0 && roll < pc;            // lab course (computer)
  if (isLab) fac.push('computer');
  else if (pl > 0 && roll < pc + pl) { fac.push('computer'); fac.push('lab_software'); }
  else if (ps > 0 && roll < pc + pl + ps) fac.push('smartboard');
  // default: whiteboard (empty = any room, the majority)

  // 2) Duration (hours/session, contiguous). Labs usually 2-3 hours, theory 1-2 hours.
  //    sks = duration × spw. Example: duration 3 × spw 2 = 6 SKS/week (2 days).
  let duration: number;
  if (isLab) duration = chance(0.5) ? 3 : 2;
  else duration = chance(0.6) ? 1 : 2;

  // Rooms that satisfy the facility requirement (all rooms if fac is empty); take
  // the capacity at the 0.45 percentile so ≥ ~55% of those rooms are valid.
  const qualRooms = ROOMS.filter(r => fac.every(f => r.fac.includes(f)));
  const caps = (qualRooms.length ? qualRooms : ROOMS).map(r => r.cap).sort((a, b) => a - b);
  const maxCap = caps[Math.floor(caps.length * 0.45)] ?? 30;

  // PKG_PER_PRODI packages per prodi (cohorts A..D). More packages =
  // lighter per-cohort load → fewer constraint violations.
  const pkgLetter = String.fromCharCode(65 + (wordIdx % PKG_PER_PRODI)); // A,B,C,D
  const pkg = `${prodi.key}-${pkgLetter}`;

  return { id: baseId, name, spw, duration, students: maxCap, fac: fac.join(';'), pkg, home: prodi.building };
}

// Build all courses first (12 courses per prodi → 3 courses/package)
for (const prodi of PRODI) {
  const nCourses = 12;
  for (let w = 0; w < nCourses; w++)
    COURSES.push(makeCourse(prodi, w));
}

// Map course id → prodi & fac for lecturer reference
const courseMeta = new Map<string, CourseTmp>();
for (const prodi of PRODI)
  for (const c of COURSES.filter(c => c.id.startsWith(prodi.key)))
    courseMeta.set(c.id, { id: c.id, prodi: prodi.key, fac: c.fac ? c.fac.split(';') : [] });

// Generate lecturers per prodi
const LECT_PER_PRODI = 8;
for (const prodi of PRODI) {
  const ids: string[] = [];
  const availFac = FAC_BY_BUILDING[prodi.building] ?? [];
  for (let i = 0; i < LECT_PER_PRODI; i++) {
    const name = newLectName();
    ids.push(name);
    // disliked hours: ~45% of lecturers have 1-2 disliked hours
    const dislikedNums: number[] = [];
    if (chance(0.45)) {
      dislikedNums.push(pick([8, 9, 15, 16]));
      if (chance(0.4)) dislikedNums.push(pick([8, 9, 15, 16]));
    }
    const disliked = Array.from(new Set(dislikedNums)).sort((a, b) => a - b).join(',');
    // preferredFac: 1 facility available in the prodi's building (or empty)
    let preferredFac = '';
    if (availFac.length && chance(0.7))
      preferredFac = pick(availFac.filter(f => f !== 'projector'));
    // preferredCourses is filled LATER after sections are built (aligned with teaching load).
    LECTURERS.push({ id: name, disliked, preferredFac, preferredCourses: '' });
  }
  lecturerIdByProdi[prodi.key] = ids;
}

// ─────────────────────────────────────────────────────────────────────────
// COURSE → SPECIALIST LECTURERS
// Each course has 2 specialist lecturers (rotated through the prodi pool). All
// sections of that course use those 2 specialists → lecturers teach few courses
// (specialization) → preferredCourses aligned → high "Course Preference" score.
// ─────────────────────────────────────────────────────────────────────────
const courseSpecialists: Record<string, string[]> = {};
for (const prodi of PRODI) {
  const lects = lecturerIdByProdi[prodi.key];
  const courses = COURSES.filter(c => c.id.startsWith(prodi.key));
  courses.forEach((c, j) => {
    courseSpecialists[c.id] = [lects[(2 * j) % lects.length], lects[(2 * j + 1) % lects.length]];
  });
}

// ─────────────────────────────────────────────────────────────────────────
// FEASIBILITY-AWARE SECTION GENERATION
// ─────────────────────────────────────────────────────────────────────────
// Recompute the facility & package load, and incrementally generate sections
// until the target session count is reached WITHOUT violating the guards.
// ─────────────────────────────────────────────────────────────────────────

const facLoad: Record<string, number> = {};   // facility → sessions used
const pkgLoad: Record<string, number> = {};   // package → sessions used
const initFac = (f: string) => { if (!(f in facLoad)) facLoad[f] = 0; };
['computer', 'lab_software', 'smartboard', 'whiteboard', 'projector'].forEach(initFac);

function facCapWithHeadroom(f: string): number {
  return Math.floor(facCapacity(f) * FAC_HEADROOM);
}

let totalSlotHours = 0;   // total room-slot-hours used (sessions × duration)
const sectionCountByCourse: Record<string, number> = {};

// Slot-hour load of a course section (spw sessions × hours per session).
const slotHours = (c: CourseOut): number => c.spw * c.duration;

// Try adding 1 section to course c. Returns true on success (guards passed).
function tryAddSection(c: CourseOut, prodiKey: string): boolean {
  const sh = slotHours(c);
  const facs = c.fac ? c.fac.split(';') : [];
  const pkg = c.pkg;
  void prodiKey;

  if ((sectionCountByCourse[c.id] ?? 0) >= SECTION_CAP) return false;
  if ((pkgLoad[pkg] ?? 0) + sh > PKG_BUDGET) return false;     // slot-hours per package ≤ 40
  for (const f of facs)
    if ((facLoad[f] ?? 0) + sh > facCapWithHeadroom(f)) return false;

  const n = (sectionCountByCourse[c.id] ?? 0) + 1;
  sectionCountByCourse[c.id] = n;
  const secId = `${c.id}-${String.fromCharCode(64 + n)}`; // A, B, C...
  // 2 specialist lecturers for this course (the same for all its sections) → high specialization.
  const [l1, l2] = courseSpecialists[c.id];
  SECTIONS.push({ id: secId, course: c.id, lects: [l1, l2], students: '' });

  totalSlotHours += sh;
  pkgLoad[pkg] = (pkgLoad[pkg] ?? 0) + sh;
  for (const f of facs) facLoad[f] = (facLoad[f] ?? 0) + sh;
  return true;
}

// Deterministic & exhaustive fill: sweep repeatedly until one full sweep adds
// nothing (all guards saturated) or the target is reached. Round-robin courses
// to spread the load. The target is measured in SLOT-HOURS (not session count).
const courseOrder = [...COURSES];
while (totalSlotHours < TARGET_SESSIONS) {
  let addedAny = false;
  for (const c of courseOrder) {
    if (totalSlotHours >= TARGET_SESSIONS) break;
    const prodiKey = PRODI.find(p => c.id.startsWith(p.key))!.key;
    if (tryAddSection(c, prodiKey)) addedAny = true;
  }
  if (!addedAny) {
    console.warn(`\n[gen] All guards saturated. Stopping at  slot-hours.`);
    break;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// COHORTS & STUDENTS (roster fixed per section)
// A cohort is a set of sections taken together by a group of students. Each
// cohort = 1 curriculum (NoOverlap in the solver). Students in a cohort share
// constraints → the constraint count is bounded (~COHORTS_PER_PKG × #packages)
// even with thousands of students.
// ~25% of cohorts take 1 cross-prodi elective → many unique curricula (stress test).
// ─────────────────────────────────────────────────────────────────────────
const courseById = new Map(COURSES.map(c => [c.id, c]));
const sectionsByCourse = new Map<string, string[]>();
for (const s of SECTIONS) {
  const a = sectionsByCourse.get(s.course) ?? []; a.push(s.id); sectionsByCourse.set(s.course, a);
}
const coursesByPkg = new Map<string, string[]>();
for (const c of COURSES) {
  const a = coursesByPkg.get(c.pkg) ?? []; a.push(c.id); coursesByPkg.set(c.pkg, a);
}
const sectionCourse = new Map<string, string>();
for (const s of SECTIONS) sectionCourse.set(s.id, s.course);
const roster = new Map<string, string[]>();          // sectionId → student ids
for (const s of SECTIONS) roster.set(s.id, []);
const capCeil = (courseId: string): number => courseById.get(courseId)!.students; // max room cap

const COHORTS_PER_PKG_BASE = 2;  // minimum cohorts per package
const P_ELECTIVE = 0.45;        // proportion of cohorts taking 1 cross-prodi elective
const ELECTIVE_RESERVE = 4;
const MAX_COHORT_SIZE = 16;     // capped so a section (cap~35) fits 2 cohorts (core+elective)

interface Cohort { id: string; sections: string[]; size: number; courses: string[]; stuIds: string[]; }
const COHORTS: Cohort[] = [];
const STUDENTS: { id: string; name: string; courses: string[] }[] = [];
let cohortSeq = 0, studentSeq = 0;
const usedStuNames = new Set<string>();
const newStuName = (): string => {
  for (let t = 0; t < 60; t++) {
    const n = `${pickName(FIRST)} ${pickName(LAST)}`;
    if (!usedStuNames.has(n)) { usedStuNames.add(n); return n; }
  }
  return `${pickName(FIRST)} ${pickName(LAST)}-${studentSeq}`;
};

// Pass 1: core cohort per package — assign section, compute size, generate
// students, and FILL THE ROSTER immediately (so Pass 2 electives see actual
// capacity).
// COHORTS_PER_PKG = max section-count in that package → ALL sections are filled.
for (const [pkg, courseIds] of coursesByPkg) {
  if (!courseIds.every(cid => (sectionsByCourse.get(cid)?.length ?? 0) > 0)) continue; // incomplete pkg
  void pkg;
  const cohortsThisPkg = Math.max(COHORTS_PER_PKG_BASE,
    ...courseIds.map(cid => sectionsByCourse.get(cid)!.length));
  for (let ci = 0; ci < cohortsThisPkg; ci++) {
    const core: string[] = courseIds.map(cid => {
      const secs = sectionsByCourse.get(cid)!;
      return secs[ci % secs.length];
    });
    // size is capped by the smallest room among the core sections (divided by
    // the number of core cohorts sharing that section).
    let size = MAX_COHORT_SIZE;
    for (const sid of core) {
      const numSections = sectionsByCourse.get(sectionCourse.get(sid)!)!.length;
      const coresTaking = Math.ceil(cohortsThisPkg / numSections);
      size = Math.min(size, Math.floor((capCeil(sectionCourse.get(sid)!) - ELECTIVE_RESERVE) / coresTaking));
    }
    size = Math.max(8, size);
    const courses = core.map(sid => sectionCourse.get(sid)!);
    // generate students & fill the core roster immediately.
    const stuIds: string[] = [];
    for (let i = 0; i < size; i++) {
      const id = `M${++studentSeq}`;
      STUDENTS.push({ id, name: newStuName(), courses: [...courses] });
      stuIds.push(id);
    }
    const co: Cohort = { id: `C${++cohortSeq}`, sections: core, size, courses, stuIds };
    COHORTS.push(co);
    for (const sid of core) roster.get(sid)!.push(...stuIds);
  }
}

// Pass 2: (cross-prodi) electives for ~25% of cohorts — add 1 elective section,
// checking the ACTUAL roster capacity (already filled with core in Pass 1).
const allSectionIds = SECTIONS.map(s => s.id);
for (const co of COHORTS) {
  if (!chance(P_ELECTIVE)) continue;
  const homeProdi = co.courses[0].match(/^[A-Z]+/)?.[0] ?? '';
  const candidates = allSectionIds.filter(sid => {
    const cid = sectionCourse.get(sid)!;
    const cProdi = cid.match(/^[A-Z]+/)?.[0] ?? '';
    if (cProdi === homeProdi) return false;            // must be cross-prodi
    if (co.sections.includes(sid)) return false;
    if (co.courses.includes(cid)) return false;        // not already taking this course
    return roster.get(sid)!.length + co.size <= capCeil(cid);
  });
  if (candidates.length === 0) continue;
  const pickSid = pick(candidates);
  const cid = sectionCourse.get(pickSid)!;
  co.sections.push(pickSid);
  co.courses.push(cid);
  // add this cohort's students to the elective section's roster + update their course_ids.
  roster.get(pickSid)!.push(...co.stuIds);
  for (const st of co.stuIds) {
    const rec = STUDENTS.find(s => s.id === st)!;
    rec.courses.push(cid);
  }
}
// Write the roster back to SECTIONS (student_ids).
for (const s of SECTIONS) s.students = roster.get(s.id)!.join(',');

// ─────────────────────────────────────────────────────────────────────────
// DERIVE preferredCourses FROM SPECIALIZATION
// A lecturer's preferredCourses = the courses they are a specialist for → every
// section they teach is necessarily a preferred course → "Course Preference"
// score ~100%.
// ─────────────────────────────────────────────────────────────────────────
const lectPreferred: Map<string, Set<string>> = new Map();
for (const [courseId, specs] of Object.entries(courseSpecialists))
  for (const lectId of specs) {
    if (!lectPreferred.has(lectId)) lectPreferred.set(lectId, new Set());
    lectPreferred.get(lectId)!.add(courseId);
  }
for (const lect of LECTURERS)
  lect.preferredCourses = [...(lectPreferred.get(lect.id) ?? [])].join(';');

// ─────────────────────────────────────────────────────────────────────────
// REPORT
// ─────────────────────────────────────────────────────────────────────────
const util = totalSlotHours / TOTAL_SLOTS;
console.log(`\nGeneration results:`);
console.log(`  Courses   : ${COURSES.length}`);
console.log(`  Lecturers : ${LECTURERS.length}`);
console.log(`  Sections  : ${SECTIONS.length}`);
console.log(`  Slot-hours:  ( section)`);
console.log(`  Utilization: ${(util * 100).toFixed(1)}% (target ${(TARGET_UTIL * 100).toFixed(0)}%)`);
console.log(`\nFacility load (used / 85% capacity):`);
for (const f of ['computer', 'lab_software', 'smartboard'])
  console.log(`  ${f.padEnd(12)}: ${facLoad[f] ?? 0} / ${facCapWithHeadroom(f)}`);
console.log(`\nPackage load (max ${PKG_BUDGET}):`);
const pkgs = Object.keys(pkgLoad).sort();
let maxPkg = 0;
for (const p of pkgs) { maxPkg = Math.max(maxPkg, pkgLoad[p]); }
console.log(`  max per-pkg: ${maxPkg} (${pkgs.length} packages)`);
// estimated lecturer load
const lectLoad: Record<string, number> = {};
for (const s of SECTIONS) {
  const c = COURSES.find(c => c.id === s.course)!;
  for (const l of s.lects) lectLoad[l] = (lectLoad[l] ?? 0) + c.spw / 2; // split between 2 eligible
}
const loads = Object.values(lectLoad);
console.log(`  lecturer load (eligible-share): avg ${(loads.reduce((a, b) => a + b, 0) / loads.length).toFixed(1)}, max ${Math.max(...loads).toFixed(1)} sessions`);
console.log(`\nStudents & Cohorts:`);
console.log(`  Cohorts (curricula)   : ${COHORTS.length}`);
console.log(`  Students              : ${STUDENTS.length}`);
const rosterSizes = SECTIONS.map(s => roster.get(s.id)!.length).filter(n => n > 0);
const electCohorts = COHORTS.filter(c => c.sections.length > COURSES.filter(x => x.pkg === courseById.get(sectionCourse.get(c.sections[0])!)?.pkg).length).length;
console.log(`  Sections with roster  : ${rosterSizes.length}/${SECTIONS.length} (avg ${Math.round(rosterSizes.reduce((a, b) => a + b, 0) / rosterSizes.length)} students, max ${Math.max(...rosterSizes)})`);
console.log(`  Cohorts with electives: ${electCohorts}/${COHORTS.length}`);

// ─────────────────────────────────────────────────────────────────────────
// WRITE CSV
// ─────────────────────────────────────────────────────────────────────────
function csvCell(v: string): string {
  return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
}
function writeCSV(name: string, header: string[], rows: string[][]): void {
  const out = [header.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n');
  writeFileSync(join(HERE, name), out, 'utf8');
  console.log(`  Wrote ${name} (${rows.length} rows)`);
}

console.log(`\nWriting CSV...`);
writeCSV('courses.csv',
  ['id', 'name', 'sessions_per_week', 'duration', 'sks', 'students', 'facilities', 'package', 'home_building'],
  COURSES.map(c => [c.id, c.name, String(c.spw), String(c.duration), String(c.duration * c.spw), String(c.students), c.fac, c.pkg, c.home]),
);
writeCSV('lecturers.csv',
  ['id', 'disliked_hours', 'preferred_facilities', 'preferred_courses'],
  LECTURERS.map(l => [l.id, l.disliked, l.preferredFac, l.preferredCourses]),
);
writeCSV('sections.csv',
  ['id', 'course_id', 'lecturer_ids', 'student_ids'],
  SECTIONS.map(s => [s.id, s.course, s.lects.join(','), s.students]),
);
writeCSV('students.csv',
  ['id', 'name', 'course_ids'],
  STUDENTS.map(st => [st.id, st.name, st.courses.join(';')]),
);

console.log('\nDone. Run the solver: npx tsx examples/campus-timetabling-csv.ts');
