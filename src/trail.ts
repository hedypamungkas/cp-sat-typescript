import { Domain } from './types';

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
