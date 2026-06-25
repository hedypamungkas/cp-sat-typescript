/**
 * Clause Engine — Boolean clause database with 2-watched-literal unit propagation.
 *
 * This is LCG Phase 1: the *infrastructure* for Lazy Clause Generation. It
 * provides efficient unit propagation over Boolean clauses (disjunctions of
 * literals), gated behind `SolverParameters.enableLcg`. Phase 1 has NO conflict
 * analysis and NO clause learning — the database holds only the user-supplied
 * `model.addClause(...)` clauses. Phase 2 will add 1-UIP conflict analysis and
 * learned clauses on top of this engine; the watched-literal algorithm here is
 * unchanged by that future work.
 *
 * LITERAL ENCODING (identical to `BoolVarImpl.negated` and `_applyAssumptions`):
 *   +v       = "BoolVar v is TRUE"
 *   -(v + 1) = "BoolVar v is FALSE"
 *
 * INTEGRATION MODEL (stateless-per-call, Phase 1):
 *   The engine holds ONLY persistent watch lists. Each `propagate()` call seeds
 *   an internal queue from the caller-supplied "seed" variable set (the dirty
 *   set during search), drains it via 2-watched-literal unit propagation, and
 *   assigns forced literals through `domains.set(...)` (which re-dirties the
 *   variable, so the solver's outer `_propagate` fixpoint loop re-enters the
 *   engine — giving the clause↔CP mutual fixpoint). There is NO engine-level
 *   assignment trail and NO decision levels: watched literals need not be
 *   restored on chronological backtrack (the Chaff invariant), so the engine is
 *   stateless across backtracks and reads assignments live from `domains`.
 *
 * SOUNDNESS CONTRACT: the engine never assigns a literal unless its clause is
 * genuinely unit, and never reports INFEASIBLE unless a clause is fully
 * falsified. Returning 'INFEASIBLE' is always correct (no feasible extension).
 */

import { Domain } from './types';
import type { Reason } from './types';

// ============================================================================
// Literal helpers
// ============================================================================

/** A signed-int literal: +v = "v true", -(v+1) = "v false". */
export type Literal = number;
/** Opaque clause id (index into the clause store). */
export type ClauseId = number;

/** Outcome of a propagation pass, matching the solver's tri-state. */
export type PropagationOutcome = 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE';

/** The variable index underlying a literal. */
export function litVar(l: Literal): number {
  return l >= 0 ? l : -(l + 1);
}

/** The value (0 or 1) that satisfies a literal. */
export function litValue(l: Literal): 0 | 1 {
  return l >= 0 ? 1 : 0;
}

/**
 * The literal that is FALSIFIED when variable `varIndex` is assigned `value`.
 * (value 0 → the positive literal `varIndex` is false; value 1 → the negative
 * literal `-(varIndex+1)` is false.) This is the watch-list key.
 */
export function falsifyingLiteral(varIndex: number, value: 0 | 1): Literal {
  return value === 0 ? varIndex : -(varIndex + 1);
}

/** True iff `l` is satisfied (its var is forced to `l`'s value) under `domains`. */
export function isLitSatisfied(l: Literal, domains: ReadonlyMap<number, Domain>): boolean {
  const d = domains.get(litVar(l));
  if (!d) return false;
  return l >= 0 ? d.min === 1 : d.max === 0;
}

/** True iff `l` is falsified (its var is forced to the opposite value) under `domains`. */
export function isLitFalsified(l: Literal, domains: ReadonlyMap<number, Domain>): boolean {
  const d = domains.get(litVar(l));
  if (!d) return false;
  return l >= 0 ? d.max === 0 : d.min === 1;
}

/**
 * Normalize a raw clause (signed-int literals) into canonical form:
 *   - drop duplicate literals,
 *   - drop tautologies (a clause containing both v and ¬v is always satisfied),
 * Returns `null` for a tautology (caller drops it), or the deduped literal list.
 */
export function normalizeClause(literals: readonly Literal[]): Literal[] | null {
  const seen = new Set<Literal>();
  const out: Literal[] = [];
  for (const l of literals) {
    if (seen.has(l)) continue; // duplicate
    if (seen.has(l >= 0 ? -(l + 1) : -l - 1)) return null; // tautology (both polarities)
    seen.add(l);
    out.push(l);
  }
  return out;
}

// ============================================================================
// Clause database
// ============================================================================

/**
 * Callback invoked once per literal the engine forces via unit propagation.
 * Receives the FORCED LITERAL (signed int); the solver uses it to bump
 * `numBooleanPropagations` and record the assignment on its LCG trail.
 */
export type OnAssignCallback = (literal: Literal) => void;

/**
 * Boolean clause database with 2-watched-literal unit propagation.
 *
 * Watch scheme: `_watches` maps a literal `L` to the clause ids that currently
 * watch `L`. When `L` becomes FALSE (its variable is fixed to the opposite
 * value), those clauses are visited and each either finds a fresh literal to
 * watch, or (if the clause is unit) forces its remaining literal, or (if the
 * clause is empty) signals conflict.
 */
export class ClauseDatabase {
  /** Clause storage: `_lits[i]` is the literal array of clause i. */
  private _lits: Literal[][] = [];
  /** `_watchPos[i] = [p0, p1]` — the two watched positions in `_lits[i]`. */
  private _watchPos: Array<[number, number]> = [];
  /** Reverse index: watched literal → clause ids watching it. */
  private _watches: Map<Literal, ClauseId[]> = new Map();
  /** True once `setup()` has built watch lists and run initial propagation. */
  private _initialized = false;
  /** The clause id that conflicted in the last `propagate()`/`setup()` (−1 if none). */
  private _lastConflictClauseId: ClauseId = -1;

  /** Number of stored clauses. */
  get size(): number {
    return this._lits.length;
  }

  /** Whether `setup()` has been run. */
  get initialized(): boolean {
    return this._initialized;
  }

  /** The literals of a clause (used by the UNSAT-core reason walker). */
  getClauseLiterals(clauseId: ClauseId): readonly Literal[] {
    return this._lits[clauseId];
  }

  /** The clause id that conflicted last (−1 if the last propagate was clean). */
  getConflictClauseId(): ClauseId {
    return this._lastConflictClauseId;
  }

  /**
   * Add a NORMALIZED clause (caller runs `normalizeClause`). The literal list
   * is stored as-is. Watch lists are chosen later in `setup()` so they reflect
   * the post-presolve domains. Returns the clause id.
   */
  addClause(literals: readonly Literal[]): ClauseId {
    const id = this._lits.length;
    // Store a defensive copy (callers may reuse their array).
    this._lits.push([...literals]);
    this._watchPos.push([0, 0]);
    return id;
  }

  /**
   * Build watch lists once (before the first search propagation) and run an
   * initial full unit-propagation pass over the current domains.
   *
   * For each clause:
   *   - 0 non-falsified literals → all-false → INFEASIBLE.
   *   - 1 non-falsified literal  → unit → force it immediately (root-level fact).
   *   - ≥2 non-falsified literals → watch the first two.
   * Then drain unit propagation seeded from every currently-assigned bool var.
   *
   * @param isBool  predicate: is var index `v` a registered BoolVar?
   *                (Only bool vars participate; Phase 1 has no int-bound literals.)
   * @returns 'INFEASIBLE' if a clause is all-false / a unit contradicts the
   *          domains; otherwise 'CONSISTENT'.
   */
  setup(
    domains: Map<number, Domain>,
    reasonTrail: { setReason(idx: number, reason: Reason): void },
    isBool: (varIndex: number) => boolean,
    onAssign?: OnAssignCallback
  ): PropagationOutcome {
    // Mark initialized up front: watch lists are being built, and even on an
    // early INFEASIBLE return the solver stops (so propagate() is never reached
    // in that case). Setting it here avoids a stale `!_initialized` early-out.
    this._initialized = true;
    this._lastConflictClauseId = -1;
    // Choose watches per clause and force immediately-unit clauses.
    for (let cid = 0; cid < this._lits.length; cid++) {
      if (this._installWatches(cid, domains, reasonTrail, onAssign) === 'INFEASIBLE') {
        this._lastConflictClauseId = cid;
        return 'INFEASIBLE';
      }
    }

    // Initial full propagation: seed from every currently-assigned bool var.
    const seed: number[] = [];
    for (const [v, d] of domains) {
      if (d.size === 1 && (d.min === 0 || d.min === 1) && isBool(v)) seed.push(v);
    }
    const outcome = this._drain(domains, reasonTrail, seed, onAssign);
    return outcome === 'INFEASIBLE' ? 'INFEASIBLE' : 'CONSISTENT';
  }

  /**
   * Add a LEARNED clause mid-search (LCG Phase 2). A learned clause is a nogood:
   * all its literals are FALSE under the current assignment (it was derived from
   * a conflict). Watches are set on the first two literals (the asserting
   * literal — the UIP's negation — is at position 0) WITHOUT forcing or
   * all-false rejection. After chronological backtrack the UIP becomes
   * unassigned; the clause then fires (asserts the UIP flip, or detects
   * conflict) when a watched literal is re-falsified — pruning the search.
   */
  addLearnedClause(literals: readonly Literal[]): ClauseId {
    const id = this._lits.length;
    this._lits.push([...literals]);
    if (literals.length <= 1) {
      this._watchPos.push([0, 0]);
      if (literals.length === 1) this._watchList(literals[0]).push(id);
    } else {
      this._watchPos.push([0, 1]);
      this._watchList(literals[0]).push(id);
      this._watchList(literals[1]).push(id);
    }
    return id;
  }

  /**
   * Incremental 2-watched-literal unit propagation.
   *
   * @param seedVars  variables whose domains just changed (the solver passes
   *                  `domains.getDirtyVariables()` BEFORE it clears it). Only
   *                  singleton bool vars among them seed the propagation queue.
   * @returns 'INFEASIBLE' if a clause became fully falsified; 'CHANGED' if at
   *          least one literal was forced; else 'CONSISTENT'.
   *
   * The engine writes forced assignments via `domains.set(...)`, which re-dirties
   * the variable so the solver's outer `_propagate` loop re-enters this method —
   * yielding the clause↔CP mutual fixpoint without an engine-level trail.
   */
  propagate(
    domains: Map<number, Domain>,
    reasonTrail: { setReason(idx: number, reason: Reason): void },
    seedVars: ReadonlySet<number>,
    isBool: (varIndex: number) => boolean,
    onAssign?: OnAssignCallback
  ): PropagationOutcome {
    if (!this._initialized) return 'CONSISTENT';
    this._lastConflictClauseId = -1;
    const seed: number[] = [];
    for (const v of seedVars) {
      const d = domains.get(v);
      if (d && d.size === 1 && (d.min === 0 || d.min === 1) && isBool(v)) seed.push(v);
    }
    return this._drain(domains, reasonTrail, seed, onAssign);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /** Get (or create) the watch list for a literal. */
  private _watchList(l: Literal): ClauseId[] {
    let list = this._watches.get(l);
    if (!list) {
      list = [];
      this._watches.set(l, list);
    }
    return list;
  }

  /**
   * Choose two watched literals for clause `cid` against `domains` and register
   * them. Used by `setup()` for initial clauses. (`addLearnedClause()` installs
   * its own watches inline — it must NOT force units or reject all-false,
   * because a learned nogood has all literals false at learn time.)
   * Forces the clause immediately if it is unit under the current domains;
   * returns 'INFEASIBLE' if it is all-false.
   */
  private _installWatches(
    cid: ClauseId,
    domains: Map<number, Domain>,
    reasonTrail: { setReason(idx: number, reason: Reason): void },
    onAssign?: OnAssignCallback
  ): 'OK' | 'INFEASIBLE' {
    const lits = this._lits[cid];
    let first = -1;
    let second = -1;
    let allFalse = true;
    for (let k = 0; k < lits.length; k++) {
      if (!isLitFalsified(lits[k], domains)) {
        allFalse = false;
        if (first === -1) first = k;
        else if (second === -1) {
          second = k;
          break;
        }
      }
    }
    if (allFalse) return 'INFEASIBLE';

    if (second === -1) {
      // Unit (exactly one non-falsified literal). Force it as a fact.
      const unit = lits[first];
      if (!isLitSatisfied(unit, domains)) {
        const v = litVar(unit);
        const val = litValue(unit);
        const d = domains.get(v);
        if (d && !d.contains(val)) return 'INFEASIBLE';
        domains.set(v, new Domain([val, val]));
        reasonTrail.setReason(v, { type: 'clause', clauseId: cid });
        onAssign?.(unit);
      }
      this._watchPos[cid] = [first, first];
      this._watchList(unit).push(cid);
    } else {
      this._watchPos[cid] = [first, second];
      this._watchList(lits[first]).push(cid);
      this._watchList(lits[second]).push(cid);
    }
    return 'OK';
  }

  /**
   * Core 2-watched-literal unit-propagation drain.
   *
   * Seeds the queue with the falsifying literal of every assigned bool var in
   * `seedVars`, then drains: for each falsified watched literal, visit its
   * clauses and either move the watch, force a unit, or signal conflict.
   *
   * Soundness crux — the watch-move step: when a fresh non-falsified literal is
   * found, the clause is moved OFF the falsified literal's watch list and ON to
   * the new literal's list (it is NOT re-added to the survivor list). When no
   * fresh literal exists, the clause STAYS on the falsified literal's list
   * (re-watched) and its other watched literal is forced (unit) or reported
   * conflict.
   */
  private _drain(
    domains: Map<number, Domain>,
    reasonTrail: { setReason(idx: number, reason: Reason): void },
    seedVars: readonly number[],
    onAssign?: OnAssignCallback
  ): PropagationOutcome {
    // Seed the queue with the falsifying literal of each assigned seed var.
    const queue: Literal[] = [];
    for (const v of seedVars) {
      const d = domains.get(v);
      if (!d || d.size !== 1) continue;
      const val = d.min;
      if (val !== 0 && val !== 1) continue;
      queue.push(falsifyingLiteral(v, val as 0 | 1));
    }

    let changed = false;
    let head = 0;
    while (head < queue.length) {
      const falseLit = queue[head++];

      const ws = this._watches.get(falseLit);
      if (!ws || ws.length === 0) continue;

      // In-place compaction: `i` reads, `j` writes survivors.
      let i = 0;
      let j = 0;
      while (i < ws.length) {
        const cid = ws[i];
        const lits = this._lits[cid];
        let p0 = this._watchPos[cid][0];
        let p1 = this._watchPos[cid][1];

        // Canonicalize so the falsified watch is at p1 (p0 is the "other" watch).
        if (lits[p0] === falseLit) {
          const t = p0;
          p0 = p1;
          p1 = t;
          this._watchPos[cid] = [p0, p1];
        }

        const otherLit = lits[p0];

        // Fast path: the other watch is already satisfied → keep watching falseLit.
        if (isLitSatisfied(otherLit, domains)) {
          ws[j++] = cid;
          i++;
          continue;
        }

        // Try to find a fresh non-falsified literal to watch.
        let foundK = -1;
        for (let k = 0; k < lits.length; k++) {
          if (k === p0 || k === p1) continue;
          if (!isLitFalsified(lits[k], domains)) {
            foundK = k;
            break;
          }
        }
        if (foundK !== -1) {
          // Move watch off falseLit onto lits[foundK] (clause NOT kept in ws).
          this._watchPos[cid] = [p0, foundK];
          this._watchList(lits[foundK]).push(cid);
          i++;
          continue;
        }

        // No fresh watch: the clause is unit (or conflict). Keep watching falseLit.
        ws[j++] = cid;
        i++;

        const unitLit = otherLit;
        if (isLitFalsified(unitLit, domains)) {
          // Both watches falsified → all literals false → CONFLICT.
          this._lastConflictClauseId = cid;
          // Preserve the remaining unprocessed clauses in the watch list.
          while (i < ws.length) ws[j++] = ws[i++];
          ws.length = j;
          return 'INFEASIBLE';
        }
        if (!isLitSatisfied(unitLit, domains)) {
          // Force the unit literal.
          const uv = litVar(unitLit);
          const uval = litValue(unitLit);
          const d = domains.get(uv);
          if (d && !d.contains(uval)) {
            this._lastConflictClauseId = cid;
            ws.length = j;
            return 'INFEASIBLE';
          }
          domains.set(uv, new Domain([uval, uval]));
          reasonTrail.setReason(uv, { type: 'clause', clauseId: cid });
          onAssign?.(unitLit);
          changed = true;
          // The assignment falsifies the opposite literal → enqueue it.
          queue.push(falsifyingLiteral(uv, uval));
        }
      }
      ws.length = j; // truncate to survivors
    }

    return changed ? 'CHANGED' : 'CONSISTENT';
  }
}
