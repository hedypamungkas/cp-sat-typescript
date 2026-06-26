/**
 * Campus Course Timetabling — Skala Penuh (FILKOM)
 * =================================================
 * Skenario: Fakultas Ilmu Komputer — Semester Ganjil 2024/2025
 *   • 50 kelas (sections) dari 21 mata kuliah lintas 5 jurusan
 *   • 18 dosen (dengan preferensi jam lunak)
 *   • 14 ruangan (kelas biasa, ruang kuliah besar, lab komputer, ruang seminar)
 *   • 40 slot waktu (Senin–Jumat × 8 jam/hari)
 *
 * Pendekatan: interval-variable model + greedy hint → 0 branch, OPTIMAL instan
 *   Setiap sesi → sessionPeriod IntVar + optional NoOverlap (dosen/ruang)
 *   Greedy constructive mengisi semua slot terlebih dahulu,
 *   lalu CP solver memverifikasi dalam 0 branch.
 *
 * Demonstrasi:
 *   1. Jadwal awal (semua kelas terjadwal, 0 branch, OPTIMAL)
 *   2. Perturbasi: LAB-A rusak total
 *   3. Penjadwalan ulang minimal disruption (hanya kelas terdampak yang pindah)
 *
 * Run: npx tsx examples/campus-timetabling-full.ts
 */

import {
  CpModel, CpSolver, CpSolverStatus,
  BoolVarImpl, IntVarImpl, IntervalVarImpl,
} from '../src';

// ═══════════════════════════════════════════════════════════════════════════
// 1. TIME GRID
// ═══════════════════════════════════════════════════════════════════════════

const DAY_NAMES = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'];
const HOURS = [8, 9, 10, 11, 13, 14, 15, 16]; // 8 slot (istirahat 12:00)
const H_PER_DAY = HOURS.length;               // 8
const DAYS = 5;
const TOTAL_P = DAYS * H_PER_DAY;             // 40

interface Period { p: number; day: number; hour: number; }
const PERIODS: Period[] = [];
for (let d = 0; d < DAYS; d++)
  for (let h = 0; h < H_PER_DAY; h++)
    PERIODS.push({ p: d * H_PER_DAY + h, day: d, hour: HOURS[h] });

const fmtPeriod = (p: number): string =>
  `${DAY_NAMES[PERIODS[p].day]} ${String(PERIODS[p].hour).padStart(2,'0')}:00`;

// ═══════════════════════════════════════════════════════════════════════════
// 2. DEFINISI DATA
// ═══════════════════════════════════════════════════════════════════════════

interface RoomDef   { id: string; cap: number; fac: string[]; }
interface LectDef   { id: string; disliked: number[]; }
interface CourseDef { id: string; name: string; spw: number; students: number; fac: string[]; pkg: string; }
interface SectionDef{ id: string; courseIdx: number; lecturers: number[]; }

// ── 14 Ruangan ──────────────────────────────────────────────────────────────
const ROOMS: RoomDef[] = [
  { id: 'R-101',  cap:  40, fac: []           }, //  0
  { id: 'R-102',  cap:  40, fac: []           }, //  1
  { id: 'R-103',  cap:  40, fac: []           }, //  2
  { id: 'R-104',  cap:  40, fac: []           }, //  3
  { id: 'R-105',  cap:  35, fac: []           }, //  4
  { id: 'R-106',  cap:  35, fac: []           }, //  5
  { id: 'H-201',  cap:  80, fac: ['projector']}, //  6
  { id: 'H-202',  cap:  80, fac: ['projector']}, //  7
  { id: 'H-203',  cap: 100, fac: ['projector']}, //  8
  { id: 'LAB-A',  cap:  30, fac: ['computer'] }, //  9  ← diblokir saat reschedule
  { id: 'LAB-B',  cap:  30, fac: ['computer'] }, // 10
  { id: 'LAB-C',  cap:  30, fac: ['computer'] }, // 11
  { id: 'LAB-D',  cap:  30, fac: ['computer'] }, // 12
  { id: 'SEM-01', cap:  20, fac: []           }, // 13
];
const LAB_A_IDX = 9;

// ── 18 Dosen ────────────────────────────────────────────────────────────────
const LECTURERS: LectDef[] = [
  { id: 'Dr. Andi',        disliked: [15, 16] }, //  0
  { id: 'Dr. Budi',        disliked: [8]      }, //  1
  { id: 'Prof. Candra',    disliked: []        }, //  2
  { id: 'Dr. Dewi',        disliked: [16]     }, //  3
  { id: 'Dr. Eko',         disliked: [8]      }, //  4
  { id: 'Prof. Farida',    disliked: []        }, //  5
  { id: 'Dr. Gunawan',     disliked: [13, 14] }, //  6
  { id: 'Dr. Hendra',      disliked: [16]     }, //  7
  { id: 'Prof. Indah',     disliked: []        }, //  8
  { id: 'Dr. Joko',        disliked: [8, 9]   }, //  9
  { id: 'Dr. Kartika',     disliked: [15]     }, // 10
  { id: 'Dr. Lestari',     disliked: [8]      }, // 11
  { id: 'Prof. Malik',     disliked: []        }, // 12
  { id: 'Dr. Nanda',       disliked: [16]     }, // 13
  { id: 'Dr. Oktavia',     disliked: [8, 9]   }, // 14
  { id: 'Prof. Prasetyo',  disliked: []        }, // 15
  { id: 'Dr. Qori',        disliked: [15, 16] }, // 16
  { id: 'Dr. Rizki',       disliked: [8]      }, // 17
];

// ── 21 Mata Kuliah ───────────────────────────────────────────────────────────
const COURSES: CourseDef[] = [
  // pkg TI-3 ─────────────────────────────────────────────────────────────────
  { id:'AlStr',    name:'Algoritma & Struktur Data',      spw:2, students:35, fac:[],           pkg:'TI-3' }, //  0
  { id:'JarKom',   name:'Jaringan Komputer',              spw:2, students:32, fac:[],           pkg:'TI-3' }, //  1
  { id:'BasDat',   name:'Basis Data',                     spw:2, students:28, fac:['computer'], pkg:'TI-3' }, //  2
  { id:'MatDis',   name:'Matematika Diskrit',             spw:1, students:35, fac:[],           pkg:'TI-3' }, //  3
  { id:'PemWeb',   name:'Pemrograman Web',                spw:2, students:25, fac:['computer'], pkg:'TI-3' }, //  4
  // pkg TI-5 ─────────────────────────────────────────────────────────────────
  { id:'KecBut',   name:'Kecerdasan Buatan',              spw:2, students:28, fac:['computer'], pkg:'TI-5' }, //  5
  { id:'SoftEng',  name:'Software Engineering',           spw:2, students:35, fac:[],           pkg:'TI-5' }, //  6
  { id:'RisOps',   name:'Riset Operasi',                  spw:2, students:28, fac:[],           pkg:'TI-5' }, //  7
  { id:'KemKom',   name:'Keamanan Komputer',              spw:1, students:30, fac:[],           pkg:'TI-5' }, //  8
  // pkg SI-3 ─────────────────────────────────────────────────────────────────
  { id:'AnasSis',  name:'Analisis & Desain Sistem',       spw:2, students:35, fac:[],           pkg:'SI-3' }, //  9
  { id:'ManPro',   name:'Manajemen Proyek TI',            spw:2, students:32, fac:[],           pkg:'SI-3' }, // 10
  { id:'StatBis',  name:'Statistika Bisnis',              spw:2, students:30, fac:[],           pkg:'SI-3' }, // 11
  { id:'BasDatSI', name:'Basis Data Sistem Informasi',    spw:2, students:25, fac:['computer'], pkg:'SI-3' }, // 12
  // pkg SI-5 ─────────────────────────────────────────────────────────────────
  { id:'ERP',      name:'Enterprise Resource Planning',   spw:2, students:22, fac:['computer'], pkg:'SI-5' }, // 13
  { id:'DataWH',   name:'Data Warehouse',                 spw:2, students:22, fac:['computer'], pkg:'SI-5' }, // 14
  { id:'BusInt',   name:'Business Intelligence',          spw:2, students:20, fac:['computer'], pkg:'SI-5' }, // 15
  { id:'ManPeng',  name:'Manajemen Pengetahuan',          spw:1, students:25, fac:[],           pkg:'SI-5' }, // 16
  // pkg DS-1 ─────────────────────────────────────────────────────────────────
  { id:'PengDS',   name:'Pengantar Data Science',         spw:2, students:30, fac:['computer'], pkg:'DS-1' }, // 17
  { id:'StatInf',  name:'Statistik Inferensi',            spw:2, students:25, fac:[],           pkg:'DS-1' }, // 18
  // pkg DS-3 ─────────────────────────────────────────────────────────────────
  { id:'MLDas',    name:'Machine Learning Dasar',         spw:2, students:25, fac:['computer'], pkg:'DS-3' }, // 19
  { id:'VizData',  name:'Visualisasi Data',               spw:1, students:22, fac:['computer'], pkg:'DS-3' }, // 20
];

// ── 50 Kelas ─────────────────────────────────────────────────────────────────
const SECTIONS: SectionDef[] = [
  // ── TI-3 (13 kelas) ───────────────────────────────────────────────────────
  { id:'AlStr-A',    courseIdx: 0, lecturers:[ 0, 1] },
  { id:'AlStr-B',    courseIdx: 0, lecturers:[ 2, 3] },
  { id:'AlStr-C',    courseIdx: 0, lecturers:[ 0, 2] },
  { id:'JarKom-A',   courseIdx: 1, lecturers:[ 4, 5] },
  { id:'JarKom-B',   courseIdx: 1, lecturers:[ 4, 6] },
  { id:'JarKom-C',   courseIdx: 1, lecturers:[ 5, 7] },
  { id:'BasDat-A',   courseIdx: 2, lecturers:[ 8, 9] },
  { id:'BasDat-B',   courseIdx: 2, lecturers:[ 8,10] },
  { id:'BasDat-C',   courseIdx: 2, lecturers:[ 9,11] },
  { id:'MatDis-A',   courseIdx: 3, lecturers:[ 1,12] },
  { id:'MatDis-B',   courseIdx: 3, lecturers:[ 2,13] },
  { id:'PemWeb-A',   courseIdx: 4, lecturers:[10,14] },
  { id:'PemWeb-B',   courseIdx: 4, lecturers:[11,15] },
  // ── TI-5 (10 kelas) ───────────────────────────────────────────────────────
  { id:'KecBut-A',   courseIdx: 5, lecturers:[16,17] },
  { id:'KecBut-B',   courseIdx: 5, lecturers:[ 0,16] },
  { id:'KecBut-C',   courseIdx: 5, lecturers:[12,17] },
  { id:'SoftEng-A',  courseIdx: 6, lecturers:[ 3, 4] },
  { id:'SoftEng-B',  courseIdx: 6, lecturers:[ 5, 6] },
  { id:'SoftEng-C',  courseIdx: 6, lecturers:[ 3, 7] },
  { id:'RisOps-A',   courseIdx: 7, lecturers:[ 8,13] },
  { id:'RisOps-B',   courseIdx: 7, lecturers:[ 9,14] },
  { id:'KemKom-A',   courseIdx: 8, lecturers:[15,16] },
  { id:'KemKom-B',   courseIdx: 8, lecturers:[ 1,17] },
  // ── SI-3 (9 kelas) ────────────────────────────────────────────────────────
  { id:'AnasSis-A',  courseIdx: 9, lecturers:[ 2, 4] },
  { id:'AnasSis-B',  courseIdx: 9, lecturers:[ 5, 7] },
  { id:'AnasSis-C',  courseIdx: 9, lecturers:[ 2, 6] },
  { id:'ManPro-A',   courseIdx:10, lecturers:[10,13] },
  { id:'ManPro-B',   courseIdx:10, lecturers:[11,14] },
  { id:'StatBis-A',  courseIdx:11, lecturers:[ 7,15] },
  { id:'StatBis-B',  courseIdx:11, lecturers:[ 8,16] },
  { id:'BasDatSI-A', courseIdx:12, lecturers:[ 9,17] },
  { id:'BasDatSI-B', courseIdx:12, lecturers:[12, 0] },
  // ── SI-5 (8 kelas) ────────────────────────────────────────────────────────
  { id:'ERP-A',      courseIdx:13, lecturers:[ 1, 3] },
  { id:'ERP-B',      courseIdx:13, lecturers:[ 6,13] },
  { id:'DataWH-A',   courseIdx:14, lecturers:[ 2,14] },
  { id:'DataWH-B',   courseIdx:14, lecturers:[ 4,15] },
  { id:'BusInt-A',   courseIdx:15, lecturers:[ 5,11] },
  { id:'BusInt-B',   courseIdx:15, lecturers:[ 7,16] },
  { id:'ManPeng-A',  courseIdx:16, lecturers:[ 8,12] },
  { id:'ManPeng-B',  courseIdx:16, lecturers:[ 0,17] },
  // ── DS-1 (6 kelas) ────────────────────────────────────────────────────────
  { id:'PengDS-A',   courseIdx:17, lecturers:[ 9,13] },
  { id:'PengDS-B',   courseIdx:17, lecturers:[10,14] },
  { id:'PengDS-C',   courseIdx:17, lecturers:[11,15] },
  { id:'StatInf-A',  courseIdx:18, lecturers:[ 3,16] },
  { id:'StatInf-B',  courseIdx:18, lecturers:[ 4,17] },
  { id:'StatInf-C',  courseIdx:18, lecturers:[12, 0] },
  // ── DS-3 (4 kelas) ────────────────────────────────────────────────────────
  { id:'MLDas-A',    courseIdx:19, lecturers:[ 1, 6] },
  { id:'MLDas-B',    courseIdx:19, lecturers:[ 7,13] },
  { id:'VizData-A',  courseIdx:20, lecturers:[ 5,14] },
  { id:'VizData-B',  courseIdx:20, lecturers:[ 9,15] },
];

const S = SECTIONS.length;   // 50
const R = ROOMS.length;       // 14
const L = LECTURERS.length;   // 18
const C = COURSES.length;     // 21

const sessCount = (s: number): number => COURSES[SECTIONS[s].courseIdx].spw;

// ═══════════════════════════════════════════════════════════════════════════
// 3. VALID-ROOM MAPPING PER SECTION
// ═══════════════════════════════════════════════════════════════════════════

function computeSectionValidRooms(excludedRooms: number[] = []): number[][] {
  return SECTIONS.map(sec => {
    const course = COURSES[sec.courseIdx];
    return Array.from({ length: R }, (_, r) => r).filter(r => {
      if (excludedRooms.includes(r)) return false;
      const room = ROOMS[r];
      if (room.cap < course.students) return false;
      return course.fac.every(f => room.fac.includes(f));
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. GREEDY CONSTRUCTIVE SOLVER
// ═══════════════════════════════════════════════════════════════════════════

interface GreedySolution {
  periods:   number[][];  // [s][k] → period index
  lecturers: number[];    // [s]    → lecturer index
  rooms:     number[][];  // [s][k] → room index
}

function buildPkgCourses(): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (let c = 0; c < C; c++) {
    const arr = m.get(COURSES[c].pkg) ?? [];
    arr.push(c);
    m.set(COURSES[c].pkg, arr);
  }
  return m;
}

function greedySolve(sectionValidRooms: number[][]): GreedySolution | null {
  const periods:   number[][] = Array.from({ length: S }, () => []);
  const rooms:     number[][] = Array.from({ length: S }, () => []);
  const lecturers: number[]   = new Array(S).fill(-1);

  const lectUsed:   Set<number>[] = Array.from({ length: L }, () => new Set());
  const roomUsed:   Set<number>[] = Array.from({ length: R }, () => new Set());
  const courseUsed: Set<number>[] = Array.from({ length: C }, () => new Set());
  const pkgCourses  = buildPkgCourses();

  const order = Array.from({ length: S }, (_, i) => i)
    .sort((a, b) => sessCount(b) - sessCount(a));

  for (const s of order) {
    if (!greedyPlaceSection(s, sectionValidRooms[s], lectUsed, roomUsed, courseUsed,
                             pkgCourses, periods, rooms, lecturers)) {
      return null;
    }
  }
  return { periods, lecturers, rooms };
}

function greedyPlaceSection(
  s: number,
  validRooms: number[],
  lectUsed:   Set<number>[],
  roomUsed:   Set<number>[],
  courseUsed: Set<number>[],
  pkgCourses: Map<string, number[]>,
  periods:    number[][],
  rooms:      number[][],
  lecturers:  number[],
): boolean {
  const courseIdx  = SECTIONS[s].courseIdx;
  const pkg        = COURSES[courseIdx].pkg;
  const numSess    = sessCount(s);
  const eligLects  = SECTIONS[s].lecturers;

  const pkgBlocked = new Set<number>();
  for (const c of pkgCourses.get(pkg) ?? [])
    if (c !== courseIdx) for (const p of courseUsed[c]) pkgBlocked.add(p);

  for (const lect of eligLects) {
    const chosenPeriods: number[] = [];
    const chosenRooms:   number[] = [];
    const usedDays = new Set<number>();
    const disliked  = new Set(LECTURERS[lect].disliked);

    // Two passes: prefer non-disliked hours first
    for (let pass = 0; pass < 2 && chosenPeriods.length < numSess; pass++) {
      for (let p = 0; p < TOTAL_P && chosenPeriods.length < numSess; p++) {
        const day  = PERIODS[p].day;
        const hour = PERIODS[p].hour;
        if (pass === 0 && disliked.has(hour)) continue;
        if (lectUsed[lect].has(p)) continue;
        if (pkgBlocked.has(p)) continue;
        if (numSess > 1 && usedDays.has(day)) continue;

        const foundRoom = validRooms.find(r => !roomUsed[r].has(p));
        if (foundRoom === undefined) continue;

        chosenPeriods.push(p);
        chosenRooms.push(foundRoom);
        usedDays.add(day);
      }
    }

    if (chosenPeriods.length === numSess) {
      lecturers[s] = lect;
      periods[s]   = [];
      rooms[s]     = [];
      for (let k = 0; k < numSess; k++) {
        const p = chosenPeriods[k];
        periods[s].push(p);
        rooms[s].push(chosenRooms[k]);
        lectUsed[lect].add(p);
        roomUsed[chosenRooms[k]].add(p);
        courseUsed[courseIdx].add(p);
      }
      return true;
    }
  }
  return false;
}

// Partial greedy: re-schedule only affectedSections on top of a fixed base solution.
// Non-affected sections keep their original assignments.
function greedyReschedulePartial(
  sol1: DecodedSolution,
  affectedSet: Set<number>,
  sectionValidRooms: number[][],    // already excludes blocked rooms
): GreedySolution | null {
  const periods:   number[][] = sol1.period.map(p => [...p]);
  const rooms:     number[][] = sol1.room.map(r => [...r]);
  const lecturers: number[]   = [...sol1.lect];

  // Pre-fill occupancy from NON-affected sections (their slots are fixed)
  const lectUsed:   Set<number>[] = Array.from({ length: L }, () => new Set());
  const roomUsed:   Set<number>[] = Array.from({ length: R }, () => new Set());
  const courseUsed: Set<number>[] = Array.from({ length: C }, () => new Set());

  for (let s = 0; s < S; s++) {
    if (affectedSet.has(s)) continue;
    const l     = sol1.lect[s];
    const cIdx  = SECTIONS[s].courseIdx;
    for (let k = 0; k < sessCount(s); k++) {
      lectUsed[l].add(sol1.period[s][k]);
      roomUsed[sol1.room[s][k]].add(sol1.period[s][k]);
      courseUsed[cIdx].add(sol1.period[s][k]);
    }
  }

  const pkgCourses = buildPkgCourses();
  const affectedOrder = [...affectedSet].sort((a, b) => sessCount(b) - sessCount(a));

  for (const s of affectedOrder) {
    periods[s]   = [];
    rooms[s]     = [];
    lecturers[s] = -1;
    if (!greedyPlaceSection(s, sectionValidRooms[s], lectUsed, roomUsed, courseUsed,
                             pkgCourses, periods, rooms, lecturers)) {
      return null;
    }
  }

  return { periods, lecturers, rooms };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. INTERVAL MODEL BUILDER
// ═══════════════════════════════════════════════════════════════════════════

interface BuiltModel {
  model:             CpModel;
  sessionPeriod:     IntVarImpl[][];    // [s][k]
  lectPresVars:      BoolVarImpl[][];   // [s][li]
  roomPresVars:      BoolVarImpl[][][]; // [s][k][ri] — ri = index in sectionValidRooms[s]
  sectionValidRooms: number[][];
}

function buildIntervalModel(
  sectionValidRooms: number[][],
  greedy: GreedySolution,
  fixedSections?: Set<number>,
): BuiltModel {
  const model = new CpModel();

  // ── Period variables ──────────────────────────────────────────────────────
  const sessionPeriod: IntVarImpl[][] = [];
  for (let s = 0; s < S; s++) {
    const arr: IntVarImpl[] = [];
    for (let k = 0; k < sessCount(s); k++)
      arr.push(model.newIntVar(0, TOTAL_P - 1, `p${s}_${k}`));
    sessionPeriod.push(arr);
  }

  // ── Day spreading ─────────────────────────────────────────────────────────
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

  // ── Lecturer NoOverlap ────────────────────────────────────────────────────
  const lectIntervals: IntervalVarImpl[][] = Array.from({ length: L }, () => []);
  const lectPresVars: BoolVarImpl[][] = [];
  for (let s = 0; s < S; s++) {
    const eligLects = SECTIONS[s].lecturers;
    const presVars: BoolVarImpl[] = [];
    for (let li = 0; li < eligLects.length; li++) {
      const l    = eligLects[li];
      const pres = model.newBoolVar(`lp${s}_${l}`);
      presVars.push(pres);
      for (let k = 0; k < sessCount(s); k++) {
        lectIntervals[l].push(
          model.newOptionalFixedSizeIntervalVar(sessionPeriod[s][k], 1, pres, `ivl${s}_${l}_${k}`)
        );
      }
    }
    model.addExactlyOne(presVars);
    lectPresVars.push(presVars);
  }
  for (let l = 0; l < L; l++) {
    if (lectIntervals[l].length > 1) model.addNoOverlap(lectIntervals[l]);
  }

  // ── Room NoOverlap (only valid rooms per section) ─────────────────────────
  const roomIntervals: IntervalVarImpl[][] = Array.from({ length: R }, () => []);
  const roomPresVars: BoolVarImpl[][][] = [];
  for (let s = 0; s < S; s++) {
    const sessionRoomVars: BoolVarImpl[][] = [];
    const validRooms = sectionValidRooms[s];
    for (let k = 0; k < sessCount(s); k++) {
      const presVars: BoolVarImpl[] = [];
      for (let ri = 0; ri < validRooms.length; ri++) {
        const r    = validRooms[ri];
        const pres = model.newBoolVar(`rp${s}_${k}_${r}`);
        presVars.push(pres);
        roomIntervals[r].push(
          model.newOptionalFixedSizeIntervalVar(sessionPeriod[s][k], 1, pres, `ivr${s}_${k}_${r}`)
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

  // ── Curriculum: cross-course pairs in same package → distinct periods ──────
  const courseSects = new Map<number, number[]>();
  for (let s = 0; s < S; s++) {
    const c   = SECTIONS[s].courseIdx;
    const arr = courseSects.get(c) ?? [];
    arr.push(s);
    courseSects.set(c, arr);
  }
  const pkgCourseList = new Map<string, number[]>();
  for (let c = 0; c < C; c++) {
    const pkg = COURSES[c].pkg;
    const arr = pkgCourseList.get(pkg) ?? [];
    arr.push(c);
    pkgCourseList.set(pkg, arr);
  }
  for (const courseList of pkgCourseList.values()) {
    for (let ci = 0; ci < courseList.length - 1; ci++) {
      for (let cj = ci + 1; cj < courseList.length; cj++) {
        const secs1 = courseSects.get(courseList[ci]) ?? [];
        const secs2 = courseSects.get(courseList[cj]) ?? [];
        for (const s1 of secs1) for (const s2 of secs2)
          for (let k1 = 0; k1 < sessCount(s1); k1++)
            for (let k2 = 0; k2 < sessCount(s2); k2++)
              model.addNotEqual(sessionPeriod[s1][k1].sub(sessionPeriod[s2][k2]), 0);
      }
    }
  }

  // ── Apply hints or hard fixes ─────────────────────────────────────────────
  for (let s = 0; s < S; s++) {
    const validRooms = sectionValidRooms[s];
    const numSess    = sessCount(s);
    const chosenLect = greedy.lecturers[s];

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

  return { model, sessionPeriod, lectPresVars, roomPresVars, sectionValidRooms };
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. DECODE SOLUTION
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

    let chosenLect = SECTIONS[s].lecturers[0];
    for (let li = 0; li < SECTIONS[s].lecturers.length; li++) {
      if (solver.value(built.lectPresVars[s][li]) === 1) {
        chosenLect = SECTIONS[s].lecturers[li];
        break;
      }
    }
    lect.push(chosenLect);

    const rs: number[] = [];
    for (let k = 0; k < numSess; k++) {
      let chosenRoom = validRooms[0];
      for (let ri = 0; ri < validRooms.length; ri++) {
        if (solver.value(built.roomPresVars[s][k][ri]) === 1) {
          chosenRoom = validRooms[ri];
          break;
        }
      }
      rs.push(chosenRoom);
    }
    room.push(rs);
  }

  return { period, lect, room };
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. PRINT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function printGrid(label: string, sol: DecodedSolution): void {
  let totalSess = 0;
  let prefViol  = 0;
  for (let s = 0; s < S; s++) {
    totalSess += sessCount(s);
    const disliked = new Set(LECTURERS[sol.lect[s]].disliked);
    for (let k = 0; k < sessCount(s); k++)
      if (disliked.has(PERIODS[sol.period[s][k]].hour)) prefViol++;
  }

  const W = 72;
  console.log(`\n${'═'.repeat(W)}`);
  console.log(` JADWAL PERKULIAHAN — ${label}`);
  console.log(`${'═'.repeat(W)}`);
  console.log(` ${S} kelas | ${totalSess} sesi total | Pelanggaran preferensi dosen: ${prefViol}`);

  for (let d = 0; d < DAYS; d++) {
    // Collect all (hour → items) for this day
    const byHour = new Map<number, string[]>();
    for (let s = 0; s < S; s++) {
      for (let k = 0; k < sessCount(s); k++) {
        const per = PERIODS[sol.period[s][k]];
        if (per.day !== d) continue;
        const roomId = ROOMS[sol.room[s][k]].id.padEnd(6);
        const lName  = LECTURERS[sol.lect[s]].id.replace(/^(Dr\.|Prof\.)\s*/, '').slice(0, 9).padEnd(9);
        const entry  = `${SECTIONS[s].id.padEnd(11)}${roomId} ${lName}`;
        const arr    = byHour.get(per.hour) ?? [];
        arr.push(entry);
        byHour.set(per.hour, arr);
      }
    }
    if (byHour.size === 0) continue;

    const LINE = '─'.repeat(W);
    console.log(`\n  ┌${LINE}┐`);
    console.log(`  │  ${DAY_NAMES[d].toUpperCase().padEnd(W - 2)}│`);
    console.log(`  ├${LINE}┤`);

    for (let h = 0; h < H_PER_DAY; h++) {
      const hour  = HOURS[h];
      const items = byHour.get(hour);
      if (!items) continue;

      const COL_W = 28;
      const COLS  = Math.floor((W - 10) / COL_W);
      for (let row = 0; row * COLS < items.length; row++) {
        const chunk  = items.slice(row * COLS, (row + 1) * COLS);
        const prefix = row === 0
          ? `  │  ${String(hour).padStart(2,'0')}:00  `
          : `  │         `;
        const line   = chunk.map(it => it.padEnd(COL_W)).join('').padEnd(W - 10);
        console.log(`${prefix}${line}│`);
      }
      console.log(`  │${' '.repeat(W)}│`);
    }
    console.log(`  └${LINE}┘`);
  }
}

function printDiff(before: DecodedSolution, after: DecodedSolution): void {
  const W = 72;
  console.log(`\n${'═'.repeat(W)}`);
  console.log(' PERUBAHAN JADWAL (sebelum → sesudah perturbasi)');
  console.log(`${'═'.repeat(W)}`);

  let movedCount = 0, roomChanged = 0, unchanged = 0;

  for (let s = 0; s < S; s++) {
    const numSess = sessCount(s);
    for (let k = 0; k < numSess; k++) {
      const pB = before.period[s][k], pA = after.period[s][k];
      const rB = before.room[s][k],   rA = after.room[s][k];
      const lB = before.lect[s],      lA = after.lect[s];
      const secId = SECTIONS[s].id.padEnd(12);

      if (pB !== pA) {
        console.log(`  PINDAH WAKTU  ${secId} Sesi${k+1}: ${fmtPeriod(pB).padEnd(16)} → ${fmtPeriod(pA)}` +
          (rB !== rA ? `  [${ROOMS[rB].id} → ${ROOMS[rA].id}]` : ''));
        movedCount++;
      } else if (rB !== rA) {
        console.log(`  GANTI RUANG   ${secId} Sesi${k+1}: ${fmtPeriod(pA).padEnd(16)}   ${ROOMS[rB].id} → ${ROOMS[rA].id}` +
          (lB !== lA ? `  [${LECTURERS[lB].id} → ${LECTURERS[lA].id}]` : ''));
        roomChanged++;
      } else {
        unchanged++;
      }
    }
  }

  console.log('─'.repeat(W));
  const total = movedCount + roomChanged + unchanged;
  console.log(` Pindah waktu: ${movedCount}  |  Ganti ruang: ${roomChanged}  |  Tidak berubah: ${unchanged}/${total}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. MAIN
// ═══════════════════════════════════════════════════════════════════════════

function main(): void {
  const t0 = Date.now();

  console.log('════════════════════════════════════════════════════════════════════════');
  console.log(' CP-SAT Campus Timetabling — FILKOM (Skala Penuh)');
  console.log('════════════════════════════════════════════════════════════════════════');
  console.log(` Instance: ${S} kelas | ${C} mata kuliah | ${L} dosen | ${R} ruangan | ${TOTAL_P} slot waktu`);

  // ── FASE 1: JADWAL AWAL ──────────────────────────────────────────────────
  console.log('\n[FASE 1] Menyusun jadwal awal...');
  const validRooms1 = computeSectionValidRooms();

  const greedy1 = greedySolve(validRooms1);
  if (!greedy1) { console.error('  Greedy gagal!'); return; }
  console.log(`  Greedy selesai: ${Date.now() - t0}ms`);

  const built1  = buildIntervalModel(validRooms1, greedy1);
  const solver1 = new CpSolver();
  solver1.parameters.maxTimeInSeconds = 30;

  const t1     = Date.now();
  const stat1  = solver1.solve(built1.model);
  console.log(`  CP Solver: ${CpSolverStatus[stat1]} | ${solver1.numBranches} branch | ${Date.now() - t1}ms`);

  if (stat1 !== CpSolverStatus.OPTIMAL && stat1 !== CpSolverStatus.FEASIBLE) {
    console.error('  Gagal!'); return;
  }
  const sol1 = decodeSolution(built1, solver1);
  printGrid('JADWAL AWAL', sol1);

  // ── FASE 2: PERTURBASI ───────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════════════');
  console.log(' PERTURBASI: LAB-A mengalami kerusakan hardware — tidak bisa digunakan');
  console.log('════════════════════════════════════════════════════════════════════════');

  const affectedSet = new Set<number>();
  for (let s = 0; s < S; s++)
    for (let k = 0; k < sessCount(s); k++)
      if (sol1.room[s][k] === LAB_A_IDX) affectedSet.add(s);

  console.log(`\n  Kelas terdampak (menggunakan LAB-A): ${affectedSet.size} kelas`);
  for (const s of affectedSet) {
    const sec = SECTIONS[s];
    for (let k = 0; k < sessCount(s); k++) {
      if (sol1.room[s][k] === LAB_A_IDX)
        console.log(`    ${sec.id.padEnd(12)} Sesi${k+1}: ${fmtPeriod(sol1.period[s][k])}, LAB-A`);
    }
  }

  // ── FASE 3: PENJADWALAN ULANG ────────────────────────────────────────────
  console.log('\n[FASE 3] Penjadwalan ulang minimal disruption...');

  const validRooms2 = computeSectionValidRooms([LAB_A_IDX]);

  // Re-greedy hanya untuk affected sections (di atas fixed base = sol1 non-affected)
  const greedyR = greedyReschedulePartial(sol1, affectedSet, validRooms2);
  if (!greedyR) { console.error('  Partial greedy gagal!'); return; }

  // Non-affected sections: hard-fix ke jadwal lama
  const fixedSections = new Set<number>();
  for (let s = 0; s < S; s++)
    if (!affectedSet.has(s)) fixedSections.add(s);

  const built2  = buildIntervalModel(validRooms2, greedyR, fixedSections);
  const solver2 = new CpSolver();
  solver2.parameters.maxTimeInSeconds = 30;

  const t2    = Date.now();
  const stat2 = solver2.solve(built2.model);
  console.log(`  CP Solver: ${CpSolverStatus[stat2]} | ${solver2.numBranches} branch | ${Date.now() - t2}ms`);

  if (stat2 !== CpSolverStatus.OPTIMAL && stat2 !== CpSolverStatus.FEASIBLE) {
    console.error('  Gagal menemukan jadwal pengganti!'); return;
  }
  const sol2 = decodeSolution(built2, solver2);

  // Verify non-affected unchanged
  let same = 0;
  for (let s = 0; s < S; s++) {
    if (affectedSet.has(s)) continue;
    if (sol1.period[s].every((p, k) => p === sol2.period[s][k]) &&
        sol1.lect[s] === sol2.lect[s] &&
        sol1.room[s].every((r, k) => r === sol2.room[s][k])) same++;
  }
  console.log(`  Kelas tidak terdampak yang tetap sama: ${same}/${S - affectedSet.size}`);

  printGrid('JADWAL SETELAH RESCHEDULE (LAB-A DIBLOKIR)', sol2);
  printDiff(sol1, sol2);

  console.log(`\n  Total waktu keseluruhan: ${Date.now() - t0}ms`);
}

main();
