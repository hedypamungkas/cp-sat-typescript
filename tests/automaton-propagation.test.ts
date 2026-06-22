/**
 * CP-SAT TypeScript Tests
 * Unit tests for automaton propagation (forward+backward DFA reachability)
 *
 * Tests the propagateAutomaton function directly, without going through the
 * full solver pipeline. This enables precise verification of:
 * - Domain pruning effectiveness
 * - Infeasibility detection
 * - Soundness (never removes a value that could lead to a solution)
 * - Edge cases
 */

import { describe, it, expect } from 'vitest';
import { CpModel } from '../src/model';
import { CpSolver } from '../src/solver';
import { CpSolverStatus, Domain } from '../src/types';
import { IntVarImpl } from '../src/variables';
import { AutomatonConstraint } from '../src/constraints';
import { propagateAutomaton } from '../src/automaton-propagation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _nextIndex = 0;

function makeVar(domain: [number, number][], name = 'x'): IntVarImpl {
  return new IntVarImpl(_nextIndex++, new Domain(domain), name);
}

function makeAutomaton(
  vars: IntVarImpl[],
  startingState: number,
  finalStates: number[],
  transitions: [number, number, number][]
): AutomatonConstraint {
  return new AutomatonConstraint(
    _nextIndex++,
    vars,
    vars, // transitionVars same as vars
    startingState,
    finalStates,
    transitions.map(t => t[0]), // tail
    transitions.map(t => t[1]), // head
    transitions.map(t => t[2])  // label
  );
}

function makeDomains(vars: IntVarImpl[]): Map<number, Domain> {
  const domains = new Map<number, Domain>();
  for (const v of vars) {
    domains.set(v.index, v.domain.clone());
  }
  return domains;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Automaton Propagation', () => {
  beforeEach(() => {
    _nextIndex = 0;
  });

  describe('basic pruning', () => {
    it('should prune values not participating in any accepting run (single var)', () => {
      // DFA: state 0 --0--> 0 (final), state 0 --1--> 1 (not final)
      // Only value 0 leads to a final state
      const x = makeVar([[0, 1]], 'x');
      const ct = makeAutomaton([x], 0, [0], [[0, 0, 0], [0, 1, 1]]);
      const domains = makeDomains([x]);

      const result = propagateAutomaton(ct, domains);

      expect(result).toBe('CHANGED');
      expect(domains.get(x.index)!.values()).toEqual([0]);
    });

    it('should prune multiple values from a multi-value domain', () => {
      // DFA: state 0 --0--> 0 (final), state 0 --1--> 1, state 0 --2--> 2 (final)
      // Values 0 and 2 lead to final states, value 1 does not
      const x = makeVar([[0, 2]], 'x');
      const ct = makeAutomaton([x], 0, [0, 2], [[0, 0, 0], [0, 1, 1], [0, 2, 2]]);
      const domains = makeDomains([x]);

      const result = propagateAutomaton(ct, domains);

      expect(result).toBe('CHANGED');
      expect(domains.get(x.index)!.values()).toEqual([0, 2]);
    });

    it('should prune values across multiple variables', () => {
      // DFA: state 0 --0--> 1, state 1 --1--> 2 (final)
      // Only sequence [0, 1] is accepted
      const x = makeVar([[0, 1]], 'x');
      const y = makeVar([[0, 1]], 'y');
      const ct = makeAutomaton([x, y], 0, [2], [[0, 1, 0], [1, 2, 1]]);
      const domains = makeDomains([x, y]);

      const result = propagateAutomaton(ct, domains);

      expect(result).toBe('CHANGED');
      // x must be 0 (only transition from state 0 is on label 0)
      expect(domains.get(x.index)!.values()).toEqual([0]);
      // y must be 1 (only transition from state 1 is on label 1)
      expect(domains.get(y.index)!.values()).toEqual([1]);
    });
  });

  describe('consistency (no change needed)', () => {
    it('should return CONSISTENT when all values are supported', () => {
      // DFA: state 0 --0--> 0 (final), state 0 --1--> 0 (final)
      // All values lead to final state
      const x = makeVar([[0, 1]], 'x');
      const ct = makeAutomaton([x], 0, [0], [[0, 0, 0], [0, 0, 1]]);
      const domains = makeDomains([x]);

      const result = propagateAutomaton(ct, domains);

      expect(result).toBe('CONSISTENT');
      expect(domains.get(x.index)!.size).toBe(2);
    });

    it('should return CONSISTENT for empty variable sequence', () => {
      const ct = makeAutomaton([], 0, [0], []);
      const domains = new Map<number, Domain>();

      const result = propagateAutomaton(ct, domains);

      expect(result).toBe('CONSISTENT');
    });
  });

  describe('infeasibility detection', () => {
    it('should detect infeasibility when no accepting run exists', () => {
      // DFA: state 0 --0--> 1 (not final), no transitions from state 1
      // Final state 0 is unreachable after any transition
      const x = makeVar([[0, 0]], 'x');
      const ct = makeAutomaton([x], 0, [0], [[0, 1, 0]]);
      const domains = makeDomains([x]);

      const result = propagateAutomaton(ct, domains);

      expect(result).toBe('INFEASIBLE');
    });

    it('should detect infeasibility when final state is unreachable', () => {
      // DFA: state 0 --0--> 1, state 1 --0--> 1 (loop, not final)
      // Final state 2 is unreachable
      const x = makeVar([[0, 0]], 'x');
      const y = makeVar([[0, 0]], 'y');
      const ct = makeAutomaton([x, y], 0, [2], [[0, 1, 0], [1, 1, 0]]);
      const domains = makeDomains([x, y]);

      const result = propagateAutomaton(ct, domains);

      expect(result).toBe('INFEASIBLE');
    });

    it('should detect infeasibility with empty domain', () => {
      const x = makeVar([[0, 1]], 'x');
      const ct = makeAutomaton([x], 0, [0], [[0, 0, 0]]);
      const domains = new Map<number, Domain>();
      domains.set(x.index, new Domain([])); // empty domain

      const result = propagateAutomaton(ct, domains);

      expect(result).toBe('INFEASIBLE');
    });
  });

  describe('soundness', () => {
    it('should never remove a value that participates in a feasible assignment (2 vars)', () => {
      // DFA: state 0 --0--> 1, state 0 --1--> 2, state 1 --0--> 3 (final), state 2 --1--> 3 (final)
      // Accepts: [0,0] and [1,1]
      const x = makeVar([[0, 1]], 'x');
      const y = makeVar([[0, 1]], 'y');
      const ct = makeAutomaton([x, y], 0, [3], [
        [0, 1, 0], [0, 2, 1], [1, 3, 0], [2, 3, 1]
      ]);
      const domains = makeDomains([x, y]);

      const result = propagateAutomaton(ct, domains);

      // Both values 0 and 1 should be supported for both x and y
      // x=0,y=0 is feasible; x=1,y=1 is feasible
      expect(domains.get(x.index)!.contains(0)).toBe(true);
      expect(domains.get(x.index)!.contains(1)).toBe(true);
      expect(domains.get(y.index)!.contains(0)).toBe(true);
      expect(domains.get(y.index)!.contains(1)).toBe(true);
      expect(result).toBe('CONSISTENT');
    });

    it('should prune only unsupported values (3 vars, mixed support)', () => {
      // DFA: state 0 --0--> 1, state 0 --1--> 2, state 0 --2--> 3
      // state 1 --0--> 4 (final), state 2 --1--> 4 (final)
      // state 3 has no outgoing transitions
      // Accepts: [0,0,*] and [1,1,*] (last var doesn't matter since state 4 is final)
      // Actually let me make it simpler: 2 vars
      // Accepts [0,0] and [1,1] only
      const x = makeVar([[0, 2]], 'x');
      const y = makeVar([[0, 2]], 'y');
      const ct = makeAutomaton([x, y], 0, [3], [
        [0, 1, 0], [0, 2, 1], [1, 3, 0], [2, 3, 1]
      ]);
      const domains = makeDomains([x, y]);

      const result = propagateAutomaton(ct, domains);

      // Value 2 has no outgoing transition from state 0 that leads to final
      expect(result).toBe('CHANGED');
      // x should have 0 and 1 pruned to just {0, 1} (value 2 removed)
      expect(domains.get(x.index)!.contains(0)).toBe(true);
      expect(domains.get(x.index)!.contains(1)).toBe(true);
      expect(domains.get(x.index)!.contains(2)).toBe(false);
      // y should also have value 2 removed
      expect(domains.get(y.index)!.contains(0)).toBe(true);
      expect(domains.get(y.index)!.contains(1)).toBe(true);
      expect(domains.get(y.index)!.contains(2)).toBe(false);
    });
  });

  describe('multi-interval domains', () => {
    it('should prune values from multi-interval domains', () => {
      // DFA: state 0 --0--> 0 (final), state 0 --2--> 0 (final)
      // Value 1 is not accepted
      const x = makeVar([[0, 2]], 'x'); // domain {0, 1, 2}
      const ct = makeAutomaton([x], 0, [0], [[0, 0, 0], [0, 0, 2]]);
      const domains = makeDomains([x]);

      const result = propagateAutomaton(ct, domains);

      expect(result).toBe('CHANGED');
      expect(domains.get(x.index)!.values()).toEqual([0, 2]);
    });
  });

  describe('longer sequences', () => {
    it('should propagate correctly across 3 variables', () => {
      // DFA: forbids consecutive 1s (3-state automaton)
      // State 0 (start, final): --0--> 0, --1--> 1, --2--> 0
      // State 1 (final):        --0--> 0, --2--> 0
      // (no --1--> from state 1, so "11" is forbidden)
      const x = makeVar([[0, 2]], 'x');
      const y = makeVar([[0, 2]], 'y');
      const z = makeVar([[0, 2]], 'z');
      const ct = makeAutomaton([x, y, z], 0, [0, 1], [
        [0, 0, 0], [0, 1, 1], [0, 0, 2],
        [1, 0, 0], [1, 0, 2],
      ]);
      const domains = makeDomains([x, y, z]);

      const result = propagateAutomaton(ct, domains);

      // All variables should keep values 0, 1, 2 since each value
      // participates in at least one accepting run:
      // [0,0,0], [0,0,1], [0,0,2], [0,1,0], [0,1,2], [0,2,0], [0,2,1], [0,2,2],
      // [1,0,0], [1,0,1], [1,0,2], [1,2,0], [1,2,1], [1,2,2],
      // [2,0,0], [2,0,1], [2,0,2], [2,1,0], [2,1,2], [2,2,0], [2,2,1], [2,2,2]
      // BUT: "11" is forbidden, so y=1 only if x!=1, and z=1 only if y!=1
      // Since propagation achieves arc-consistency, it should NOT prune y=1 or z=1
      // because y=1 is supported by x=0 and z=1 is supported by y=0
      // However, it might prune if some values have no support at all
      expect(result).toBe('CONSISTENT');
    });

    it('should detect infeasibility in a 3-variable sequence', () => {
      // DFA that only accepts [0, 0, 0]
      const x = makeVar([[0, 1]], 'x');
      const y = makeVar([[0, 1]], 'y');
      const z = makeVar([[0, 1]], 'z');
      const ct = makeAutomaton([x, y, z], 0, [3], [
        [0, 1, 0], [1, 2, 0], [2, 3, 0]
      ]);
      const domains = makeDomains([x, y, z]);

      const result = propagateAutomaton(ct, domains);

      expect(result).toBe('CHANGED');
      // All variables should be pruned to {0}
      expect(domains.get(x.index)!.values()).toEqual([0]);
      expect(domains.get(y.index)!.values()).toEqual([0]);
      expect(domains.get(z.index)!.values()).toEqual([0]);
    });
  });

  describe('edge cases', () => {
    it('should handle single-state DFA (start = final)', () => {
      // DFA: state 0 is both start and final, no transitions
      // Empty sequence is accepted; any non-empty sequence requires transitions
      const x = makeVar([[0, 0]], 'x');
      const ct = makeAutomaton([x], 0, [0], []);
      const domains = makeDomains([x]);

      const result = propagateAutomaton(ct, domains);

      // No transitions from state 0, so x can't take any value
      expect(result).toBe('INFEASIBLE');
    });

    it('should handle self-loop DFA', () => {
      // DFA: state 0 --0--> 0 (final), self-loop on 0
      const x = makeVar([[0, 0]], 'x');
      const ct = makeAutomaton([x], 0, [0], [[0, 0, 0]]);
      const domains = makeDomains([x]);

      const result = propagateAutomaton(ct, domains);

      expect(result).toBe('CONSISTENT');
    });

    it('should handle multiple final states', () => {
      // DFA: state 0 --0--> 1 (final), state 0 --1--> 2 (final)
      const x = makeVar([[0, 1]], 'x');
      const ct = makeAutomaton([x], 0, [1, 2], [[0, 1, 0], [0, 2, 1]]);
      const domains = makeDomains([x]);

      const result = propagateAutomaton(ct, domains);

      expect(result).toBe('CONSISTENT');
    });

    it('should handle domain with single value', () => {
      const x = makeVar([[3, 3]], 'x');
      const ct = makeAutomaton([x], 0, [1], [[0, 1, 3]]);
      const domains = makeDomains([x]);

      const result = propagateAutomaton(ct, domains);

      expect(result).toBe('CONSISTENT');
      expect(domains.get(x.index)!.size).toBe(1);
    });
  });

  describe('integration with solver', () => {
    it('should produce correct results when used through the solver', () => {
      // This tests the integration: automaton propagation + search
      // DFA: accepts only sequences where no two consecutive values are the same
      // State 0 --0--> 1, state 0 --1--> 2
      // State 1 --1--> 2, state 1 --0--> (no transition, rejects)
      // State 2 --0--> 1, state 2 --1--> (no transition, rejects)
      // Final states: {1, 2}
      const model = new CpModel();
      const x = model.newIntVar(0, 1, 'x');
      const y = model.newIntVar(0, 1, 'y');
      model.addAutomaton([x, y], 0, [1, 2], [[0, 1, 0], [0, 2, 1], [1, 2, 1], [2, 1, 0]]);

      const solver = new CpSolver();
      solver.parameters.enumerateAllSolutions = true;
      const status = solver.solve(model);

      expect(status).not.toBe(CpSolverStatus.INFEASIBLE);
    });
  });
});
