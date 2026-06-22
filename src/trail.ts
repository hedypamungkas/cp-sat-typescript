import { Domain, Reason } from './types';

/**
 * A Map<number, Domain> that records every mutation on an undo trail, so the
 * search can mutate domains in place and restore them on backtrack — replacing
 * the copy-on-write `_cloneDomains` that used to run at every search node and
 * every branch value.
 *
 * `Domain` objects are immutable, so each trail entry stores only the PREVIOUS
 * Domain reference (no copy). Within a level, a variable may be set multiple
 * times as propagation converges; recording every set and restoring in LIFO
 * order correctly unwinds to the pre-level state.
 *
 * Usage in the search loop:
 *   domains.pushLevel();
 *   try { ...propagate / branch / recurse... } finally { domains.popLevel(); }
 */
export class TrailMap extends Map<number, Domain> {
  private _trail: Array<{ idx: number; prev: Domain | undefined }> = [];
  private _marks: number[] = [];

  /** Begin a new backtrack level. */
  pushLevel(): void {
    this._marks.push(this._trail.length);
  }

  /** Undo all mutations made since the matching pushLevel. */
  popLevel(): void {
    const mark = this._marks.pop();
    if (mark === undefined) return;
    const trail = this._trail;
    while (trail.length > mark) {
      const entry = trail.pop()!;
      if (entry.prev === undefined) {
        super.delete(entry.idx);
      } else {
        super.set(entry.idx, entry.prev);
      }
    }
  }

  override set(idx: number, domain: Domain): this {
    this._trail.push({ idx, prev: super.get(idx) });
    super.set(idx, domain);
    return this;
  }

  override delete(idx: number): boolean {
    this._trail.push({ idx, prev: super.get(idx) });
    return super.delete(idx);
  }
}

/**
 * A trailable map from variable index to Reason. Mirrors TrailMap's
 * pushLevel/popLevel discipline so reasons are undone on backtrack.
 *
 * Used for UNSAT core extraction: when a propagator or assumption restricts a
 * variable's domain, the reason is recorded here. On infeasibility the reason
 * chain is walked backwards to find which assumptions were involved.
 */
export class ReasonTrail {
  private _reasons: Map<number, Reason> = new Map();
  private _trail: Array<{ idx: number; prev: Reason | undefined }> = [];
  private _marks: number[] = [];

  pushLevel(): void {
    this._marks.push(this._trail.length);
  }

  popLevel(): void {
    const mark = this._marks.pop();
    if (mark === undefined) return;
    while (this._trail.length > mark) {
      const entry = this._trail.pop()!;
      if (entry.prev === undefined) {
        this._reasons.delete(entry.idx);
      } else {
        this._reasons.set(entry.idx, entry.prev);
      }
    }
  }

  setReason(idx: number, reason: Reason): void {
    this._trail.push({ idx, prev: this._reasons.get(idx) });
    this._reasons.set(idx, reason);
  }

  getReason(idx: number): Reason | undefined {
    return this._reasons.get(idx);
  }

  /** Return all current reasons (for core extraction). */
  allReasons(): Map<number, Reason> {
    return this._reasons;
  }
}
