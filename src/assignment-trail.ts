/**
 * Assignment Trail — the CDCL implication-graph substrate for LCG Phase 2.
 *
 * An ordered record of every Boolean literal assigned during search (decisions
 * and clause/Boolean propagations), partitioned by DECISION LEVEL. The trail
 * mirrors `TrailMap`'s chronological `pushLevel`/`popLevel` discipline, but
 * tracks levels + assignment order — the two things 1-UIP conflict analysis
 * needs that `ReasonTrail` (an unordered var→reason map) cannot provide.
 *
 * LEVEL DISCIPLINE: the solver pushes a level at the ROOT (level 0, holding
 * presolve/setup facts) and once per BRANCH DECISION. It does NOT push at the
 * per-node propagation-only `pushLevel` (that is a `TrailMap` checkpoint only).
 * So `currentLevel` == the number of branch decisions on the stack.
 *
 * The trail is the SOLVER's responsibility (it already owns `TrailMap` and
 * `ReasonTrail`); the clause engine stays stateless for propagation.
 */

import type { Literal } from './clause-engine';

export class AssignmentTrail {
  /** Ordered assigned literals (the assignment sequence). */
  private _lits: Literal[] = [];
  /** `_levels[i]` = decision level of `_lits[i]`. */
  private _levels: number[] = [];
  /** Trail-length marks, one per `pushLevel`. */
  private _marks: number[] = [];
  /** Variable → its assigned decision level. Absent = unassigned (treated as root, level 0). */
  private _varLevel: Map<number, number> = new Map();

  /** Current decision level (−1 before the first pushLevel). */
  get currentLevel(): number {
    return this._marks.length - 1;
  }

  /** Number of assigned literals on the trail. */
  get length(): number {
    return this._lits.length;
  }

  /** Begin a new decision level. */
  pushLevel(): void {
    this._marks.push(this._lits.length);
  }

  /** Record a DECISION literal at the current level. */
  recordDecision(lit: Literal): void {
    const level = this.currentLevel;
    this._lits.push(lit);
    this._levels.push(level);
    this._varLevel.set(lit >= 0 ? lit : -(lit + 1), level);
  }

  /** Record a PROPAGATED literal at the current level. */
  recordPropagation(lit: Literal): void {
    this.recordDecision(lit);
  }

  /** Undo to the matching pushLevel (restore the trail + var levels). */
  popLevel(): void {
    const mark = this._marks.pop();
    if (mark === undefined) return;
    while (this._lits.length > mark) {
      const lit = this._lits.pop()!;
      this._levels.pop();
      this._varLevel.delete(lit >= 0 ? lit : -(lit + 1));
    }
  }

  /** The literal at trail index `i`. */
  litAt(i: number): Literal {
    return this._lits[i];
  }

  /** Decision level of a variable. Absent ⇒ 0 (a root fact). */
  levelOf(varIndex: number): number {
    return this._varLevel.get(varIndex) ?? 0;
  }

  /** Trail index where `level` begins (the first literal at that level). */
  startIndexAtLevel(level: number): number {
    return level < this._marks.length ? this._marks[level] : this._lits.length;
  }

  /** Fully reset (called at solve start and at each restart / LNS boundary). */
  reset(): void {
    this._lits.length = 0;
    this._levels.length = 0;
    this._marks.length = 0;
    this._varLevel.clear();
  }
}
