/**
 * CP-SAT TypeScript Implementation
 * Automaton constraint propagation via forward+backward DFA reachability.
 *
 * The automaton constraint requires that a sequence of integer variables forms
 * a word accepted by a deterministic finite automaton (DFA). This module
 * implements domain filtering by computing:
 *
 *   1. Forward sweep: which states are reachable at each position
 *   2. Backward sweep: which states can reach a final state from each position
 *   3. Pruning: remove variable values that cannot participate in any
 *      accepting run
 *
 * The algorithm is sound (never removes a value that could lead to a solution)
 * and achieves arc-consistency for the DFA structure.
 */

import { Domain } from './types';
import { AutomatonConstraint } from './constraints';

export type PropagationResult = 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE';

/**
 * Propagate the automaton constraint by forward+backward reachability analysis.
 *
 * @param ct - The automaton constraint
 * @param domains - Current variable domains (mutated in place on success)
 * @returns 'CHANGED' if any domain was reduced, 'CONSISTENT' if no change,
 *          'INFEASIBLE' if no accepting run exists
 */
export function propagateAutomaton(
  ct: AutomatonConstraint,
  domains: Map<number, Domain>
): PropagationResult {
  const n = ct.vars.length;
  if (n === 0) return 'CONSISTENT';

  // Build transition lookup: Map<tailState, Map<label, headState>>
  const transMap = new Map<number, Map<number, number>>();
  for (let t = 0; t < ct.transitionTail.length; t++) {
    const tail = ct.transitionTail[t];
    const label = ct.transitionLabel[t];
    const head = ct.transitionHead[t];
    let labelMap = transMap.get(tail);
    if (!labelMap) {
      labelMap = new Map();
      transMap.set(tail, labelMap);
    }
    labelMap.set(label, head);
  }

  // ---- FORWARD SWEEP ----
  // reachable[i] = set of states reachable at position i (before reading vars[i])
  // reachable[0] = {startingState}
  // reachable[i+1] = { transMap[s][v] | s in reachable[i], v in vars[i].domain }
  const reachable: Set<number>[] = new Array(n + 1);
  reachable[0] = new Set<number>([ct.startingState]);

  for (let i = 0; i < n; i++) {
    const vDomain = domains.get(ct.vars[i].index);
    if (!vDomain || vDomain.isEmpty) return 'INFEASIBLE';

    const next = new Set<number>();
    const prev = reachable[i];
    const values = vDomain.values();

    for (const s of prev) {
      const labelMap = transMap.get(s);
      if (!labelMap) continue;
      for (const v of values) {
        const head = labelMap.get(v);
        if (head !== undefined) {
          next.add(head);
        }
      }
    }

    if (next.size === 0) return 'INFEASIBLE';
    reachable[i + 1] = next;
  }

  // Check that at least one final state is reachable
  const finalSet = new Set(ct.finalStates);
  let hasFinal = false;
  for (const s of reachable[n]) {
    if (finalSet.has(s)) {
      hasFinal = true;
      break;
    }
  }
  if (!hasFinal) return 'INFEASIBLE';

  // ---- BACKWARD SWEEP ----
  // canReachFinal[i] = set of states from which a final state is reachable
  //   by reading vars[i..n-1]
  // canReachFinal[n] = finalStates
  // canReachFinal[i] = { s | exists v in vars[i].domain s.t.
  //   transMap[s][v] in canReachFinal[i+1] }
  const canReachFinal: Set<number>[] = new Array(n + 1);
  canReachFinal[n] = new Set(ct.finalStates);

  for (let i = n - 1; i >= 0; i--) {
    const vDomain = domains.get(ct.vars[i].index);
    if (!vDomain || vDomain.isEmpty) return 'INFEASIBLE';

    const current = new Set<number>();
    const next = canReachFinal[i + 1];
    const values = vDomain.values();

    // For each state s that was reachable at position i,
    // check if it can reach a final state
    for (const s of reachable[i]) {
      const labelMap = transMap.get(s);
      if (!labelMap) continue;
      for (const v of values) {
        const head = labelMap.get(v);
        if (head !== undefined && next.has(head)) {
          current.add(s);
          break; // one valid transition is enough
        }
      }
    }

    canReachFinal[i] = current;
  }

  // ---- PRUNE ----
  // For each position i, for each value v in vars[i].domain:
  //   Keep v if there exists s in reachable[i] such that
  //     transMap[s][v] exists AND transMap[s][v] is in canReachFinal[i+1]
  let changed = false;

  for (let i = 0; i < n; i++) {
    const vDomain = domains.get(ct.vars[i].index);
    if (!vDomain || vDomain.size <= 1) continue;

    const next = canReachFinal[i + 1];
    const newIntervals: [number, number][] = [];

    for (const [start, end] of vDomain.intervals) {
      let intervalStart = -1;
      for (let v = start; v <= end; v++) {
        let supported = false;
        for (const s of reachable[i]) {
          const labelMap = transMap.get(s);
          if (labelMap) {
            const head = labelMap.get(v);
            if (head !== undefined && next.has(head)) {
              supported = true;
              break;
            }
          }
        }
        if (supported) {
          if (intervalStart === -1) intervalStart = v;
        } else {
          if (intervalStart !== -1) {
            newIntervals.push([intervalStart, v - 1]);
            intervalStart = -1;
          }
        }
      }
      if (intervalStart !== -1) {
        newIntervals.push([intervalStart, end]);
      }
    }

    if (newIntervals.length === 0) return 'INFEASIBLE';
    const newDomain = new Domain(newIntervals);
    if (newDomain.size < vDomain.size) {
      domains.set(ct.vars[i].index, newDomain);
      changed = true;
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}
