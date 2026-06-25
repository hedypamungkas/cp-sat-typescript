/**
 * 1-UIP Conflict Analysis (LCG Phase 2).
 *
 * Given a conflicting clause (all literals false under the current assignment),
 * derive the 1-UIP learned clause by resolving literals at the current decision
 * level against their antecedents until exactly one remains (the Unique
 * Implication Point). The result is a NOGOOD (all literals false now) that is a
 * logical consequence of the existing clauses — adding it never prunes a
 * feasible assignment.
 *
 * SOUNDNESS: resolution preserves logical consequence. Every antecedent is a
 * clause (`getClauseLiterals`) or a Boolean propagator's lazy-clause
 * explanation (`reason.literals`); in both, all literals except the forced one
 * are false, so resolution is valid. If the chain hits a non-explained CP
 * propagation (`{type:'propagation'}`) — which has no clausal explanation — the
 * analysis ABORTS (returns null); the caller falls back to plain chronological
 * backtracking. This is sound (it only *misses* learning, never learns wrongly).
 */

import { AssignmentTrail } from './assignment-trail';
import { ClauseDatabase, litVar } from './clause-engine';
import type { Literal } from './clause-engine';
import type { Reason } from './types';

export interface AnalysisResult {
  /** The learned clause — all literals are FALSE under the current assignment. */
  learnedLiterals: Literal[];
  /** True iff the conflict is at decision level 0 (root UNSAT — empty clause). */
  isEmptyClause: boolean;
}

/** Negate a literal: +v ⇄ -(v+1). */
function negate(lit: Literal): Literal {
  return lit >= 0 ? -(lit + 1) : -lit - 1;
}

/**
 * @param conflictLiterals  the literals of the conflicting clause (all false).
 * @returns the learned clause, or null if the conflict cannot be analyzed
 *          (a non-explained propagation is in the chain).
 */
export function analyzeConflict(
  conflictLiterals: readonly Literal[],
  trail: AssignmentTrail,
  clauseDb: ClauseDatabase,
  reasonTrail: { getReason(idx: number): Reason | undefined }
): AnalysisResult | null {
  const curLevel = trail.currentLevel;
  if (curLevel < 0) return null;

  const seen = new Set<number>(); // variables in the current resolvent
  let counter = 0; // seen vars at curLevel not yet resolved
  const learned: Literal[] = []; // accumulated false literals at level > 0 (level-0 dropped)

  /**
   * Mark a variable seen; abort if its assignment has no clausal explanation.
   * Returns false to signal abort.
   */
  const mark = (lit: Literal): boolean => {
    const v = litVar(lit);
    if (seen.has(v)) return true;
    const reason = reasonTrail.getReason(v);
    if (reason !== undefined && reason.type === 'propagation') return false; // non-explained CP → abort
    seen.add(v);
    const lvl = trail.levelOf(v);
    if (lvl === curLevel) counter++;
    else if (lvl > 0) learned.push(lit);
    return true;
  };

  // Seed from the conflict clause.
  for (const l of conflictLiterals) {
    if (!mark(l)) return null;
  }

  // Root conflict (level 0): every conflict literal is a root fact ⇒ UNSAT.
  if (curLevel === 0) {
    return { learnedLiterals: [], isEmptyClause: true };
  }

  // Resolve current-level literals in reverse trail order until one remains.
  let trailIdx = trail.length - 1;
  while (counter > 1) {
    // Find the most-recent seen var at curLevel.
    while (trailIdx >= 0) {
      const v = litVar(trail.litAt(trailIdx));
      if (seen.has(v) && trail.levelOf(v) === curLevel) break;
      trailIdx--;
    }
    if (trailIdx < 0) return null; // could not reduce to a single UIP — abort
    const resolveVar = litVar(trail.litAt(trailIdx));
    trailIdx--;

    const reason = reasonTrail.getReason(resolveVar);
    if (!reason) return null; // decision with counter > 1 (trail-order anomaly) — abort
    let ante: readonly Literal[];
    if (reason.type === 'clause') {
      ante = clauseDb.getClauseLiterals(reason.clauseId);
    } else if (reason.type === 'lazyClause') {
      ante = reason.literals;
    } else {
      return null; // 'propagation' / 'assumption' with counter > 1 — abort
    }

    counter--; // resolveVar resolved away
    for (const al of ante) {
      const av = litVar(al);
      if (av === resolveVar) continue; // the resolved literal itself
      if (!mark(al)) return null;
    }
  }

  // The UIP: the single UNRESOLVED seen var at curLevel. Scan CONTINUING from
  // `trailIdx` (where the resolution loop stopped) downwards — NOT from the
  // trail end, which would re-find already-resolved vars (they remain in `seen`
  // at curLevel). The first seen curLevel var below the resolved region is the UIP.
  let uipTrailLit: Literal | null = null;
  for (let i = trailIdx; i >= 0; i--) {
    const lit = trail.litAt(i);
    const v = litVar(lit);
    if (seen.has(v) && trail.levelOf(v) === curLevel) {
      uipTrailLit = lit;
      break;
    }
  }
  if (uipTrailLit === null) return null; // defensive

  learned.unshift(negate(uipTrailLit));
  return { learnedLiterals: learned, isEmptyClause: false };
}
