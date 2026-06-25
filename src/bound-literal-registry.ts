/**
 * Bound Literal Registry — LCG Phase 3.
 *
 * Maps `(varIndex, bound, direction)` triples to synthetic Boolean variable
 * indices ("bound literals") that participate in the clause engine:
 *
 *   synthIdx as positive literal  (+synthIdx)  = "varIndex >= bound" (if dir='geq')
 *                                               = "varIndex <= bound" (if dir='leq')
 *   synthIdx as negative literal  -(synthIdx+1) = "varIndex < bound"  (if dir='geq')
 *                                               = "varIndex > bound"  (if dir='leq')
 *
 * Allocation is ON-DEMAND (lazy): bound literals are created the first time a
 * propagator needs them for an explanation. The registry never backtracks — only
 * the bound literal's domain in the `TrailMap` does.
 *
 * `getOrCreate` initializes the domain immediately based on the current integer
 * variable state, so newly allocated literals are consistent from birth.
 */

import { Domain } from './types';

export type BoundDir = 'geq' | 'leq';

export interface BoundLitInfo {
  readonly varIndex: number;
  readonly bound: number;
  readonly dir: BoundDir;
}

export class BoundLiteralRegistry {
  private readonly _base: number;
  private _next: number;
  private readonly _fwd: Map<string, number> = new Map();
  private readonly _rev: Map<number, BoundLitInfo> = new Map();
  private readonly _byVar: Map<number, BoundLitInfo[]> = new Map();

  /**
   * @param firstSyntheticIndex All synthetic bool var indices are >= this value.
   *   Set to (max real var index + 1) before search begins.
   */
  constructor(firstSyntheticIndex: number) {
    this._base = firstSyntheticIndex;
    this._next = firstSyntheticIndex;
  }

  /** Total number of allocated bound literals. */
  get size(): number {
    return this._next - this._base;
  }

  /** Is `idx` a synthetic bound literal index (vs a real variable)? */
  isBoundLit(idx: number): boolean {
    return idx >= this._base;
  }

  /**
   * Get or allocate the synthetic variable index for `(varIndex dir bound)`.
   * Initializes (or re-initializes after backtrack) the domain in `domains`:
   *   - `[1,1]` if the integer variable already satisfies the bound
   *   - `[0,0]` if it already violates the bound
   *   - `[0,1]` otherwise (unknown)
   *
   * The registry itself never backtracks; only the `domains` entry does. On
   * re-entry after a backtrack that cleared the domain, re-initialize from the
   * current integer domain so the entry is always consistent on allocation.
   */
  getOrCreate(
    varIndex: number,
    bound: number,
    dir: BoundDir,
    domains: Map<number, Domain>
  ): number {
    const key = `${dir}:${varIndex}:${bound}`;
    let synthIdx = this._fwd.get(key);
    let needsInit: boolean;
    if (synthIdx === undefined) {
      synthIdx = this._next++;
      this._fwd.set(key, synthIdx);
      const info: BoundLitInfo = { varIndex, bound, dir };
      this._rev.set(synthIdx, info);
      let byVar = this._byVar.get(varIndex);
      if (!byVar) { byVar = []; this._byVar.set(varIndex, byVar); }
      byVar.push(info);
      needsInit = true;
    } else {
      // Re-initialize if the domain was reverted by a backtrack.
      needsInit = !domains.has(synthIdx);
    }

    if (needsInit) {
      const intD = domains.get(varIndex);
      let lo: number, hi: number;
      if (!intD) {
        lo = 0; hi = 1;
      } else if (dir === 'geq') {
        if (intD.min >= bound) { lo = 1; hi = 1; }
        else if (intD.max < bound) { lo = 0; hi = 0; }
        else { lo = 0; hi = 1; }
      } else {
        if (intD.max <= bound) { lo = 1; hi = 1; }
        else if (intD.min > bound) { lo = 0; hi = 0; }
        else { lo = 0; hi = 1; }
      }
      domains.set(synthIdx, new Domain([lo, hi]));
    }
    return synthIdx;
  }

  /**
   * Return the synthIdx if already allocated, undefined otherwise.
   * Used by _search to avoid forcing allocation at branch time.
   */
  getExisting(varIndex: number, bound: number, dir: BoundDir): number | undefined {
    return this._fwd.get(`${dir}:${varIndex}:${bound}`);
  }

  /** Decode a synthetic index to its bound-literal info. Returns undefined for real vars. */
  lookup(synthIdx: number): BoundLitInfo | undefined {
    return this._rev.get(synthIdx);
  }

  /** All allocated entries (synthIdx → info), for the channeling sweep. */
  allEntries(): Iterable<[number, BoundLitInfo]> {
    return this._rev;
  }

  /** All bound literals registered for a given integer variable. */
  forVar(varIndex: number): readonly BoundLitInfo[] {
    return this._byVar.get(varIndex) ?? [];
  }
}
