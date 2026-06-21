/**
 * Circuit and MultipleCircuit Constraint Propagation
 *
 * Implements propagation algorithms for Hamiltonian cycle (Circuit) and
 * VRP-style multiple routes (MultipleCircuit) constraints.
 *
 * Layer 2 implementation: path-based propagation with subtour detection.
 *
 * Algorithms:
 * - Degree propagation: each node must have exactly 1 incoming and 1 outgoing arc
 * - Subtour detection: closed cycles not covering all nodes → INFEASIBLE
 * - Path-based propagation: if closing a path creates a subtour, propagate closing arc to false
 * - Force self-loops: when a complete valid circuit is found, force remaining nodes to self-loops
 *
 * Based on OR-Tools circuit.cc CircuitPropagator.
 */

import { Domain, BoolVar } from './types';
import { CircuitConstraint, MultipleCircuitConstraint } from './constraints';

// ============================================================================
// Types
// ============================================================================

export type PropagationResult = 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE';

/** Callback for delegating boolean variable propagation to the engine */
export type BoolPropagateFn = (
  varIndex: number,
  value: boolean,
  domains: Map<number, Domain>
) => PropagationResult;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get the current state of a boolean variable.
 * Returns 'true' if fixed to 1, 'false' if fixed to 0, 'undecided' otherwise.
 */
function getBoolState(
  boolVar: BoolVar,
  domains: Map<number, Domain>
): 'true' | 'false' | 'undecided' {
  const d = domains.get(boolVar.index);
  if (!d) return 'undecided';
  if (d.size === 1) {
    return d.min === 1 ? 'true' : 'false';
  }
  return 'undecided';
}

/**
 * Force a boolean variable to a specific value.
 * Returns true if domain changed, false if already at value.
 * Throws if setting to value would make domain empty.
 */
function forceBool(
  boolVar: BoolVar,
  value: boolean,
  domains: Map<number, Domain>
): boolean {
  const d = domains.get(boolVar.index);
  if (!d) return false;
  const target = value ? 1 : 0;
  if (d.size === 1 && d.min === target) return false;
  const newDomain = d.intersection(new Domain([target, target]));
  if (newDomain.isEmpty) throw new Error('INFEASIBLE');
  domains.set(boolVar.index, newDomain);
  return true;
}

// ============================================================================
// Circuit Propagation (Hamiltonian Cycle)
// ============================================================================

/**
 * Propagate a Circuit constraint.
 *
 * Ensures the selected arcs form a single Hamiltonian cycle through all nodes.
 *
 * Algorithm:
 * 1. Build adjacency from fixed arcs
 * 2. Check degree constraints (no node can have 2+ incoming or 2+ outgoing)
 * 3. Trace paths and detect premature cycles
 * 4. If a cycle exists that doesn't cover all nodes → INFEASIBLE
 * 5. If a path would close into a subtour, propagate closing arc to false
 * 6. If a complete valid cycle is found, force remaining arcs to self-loops
 */
export function propagateCircuit(
  ct: CircuitConstraint,
  domains: Map<number, Domain>,
  _propagateBool: BoolPropagateFn
): PropagationResult {
  const arcs = ct.arcs;
  if (arcs.length === 0) return 'CONSISTENT';

  // Collect all nodes
  const nodeSet = new Set<number>();
  for (const [tail, head] of arcs) {
    nodeSet.add(tail);
    nodeSet.add(head);
  }
  const nodes = [...nodeSet];
  const n = nodes.length;

  // Build arc lookup: (tail, head) → BoolVar using numeric key
  const maxNode = Math.max(...nodes) + 1;
  const arcMap = new Map<number, BoolVar>();
  for (const [tail, head, lit] of arcs) {
    arcMap.set(tail * maxNode + head, lit);
  }

  let changed = false;

  // Phase 1: Degree propagation
  // Each node must have exactly 1 outgoing and 1 incoming arc
  for (const node of nodes) {
    // Count outgoing arcs
    const outgoing = arcs.filter(([t, _, _2]) => t === node);
    const outgoingFixed = outgoing.filter(([_, __, lit]) => getBoolState(lit, domains) === 'true');
    const outgoingPossible = outgoing.filter(([_, __, lit]) => getBoolState(lit, domains) !== 'false');

    // If exactly 1 outgoing is fixed, all others must be false
    if (outgoingFixed.length === 1) {
      for (const [_, head, lit] of outgoing) {
        if (getBoolState(lit, domains) === 'undecided' && !outgoingFixed.some(([_, h, _2]) => h === head)) {
          try {
            if (forceBool(lit, false, domains)) changed = true;
          } catch {
            return 'INFEASIBLE';
          }
        }
      }
    }

    // If no outgoing arcs are possible → INFEASIBLE
    if (outgoingPossible.length === 0) return 'INFEASIBLE';

    // If exactly 1 outgoing is possible, fix it to true
    if (outgoingPossible.length === 1 && getBoolState(outgoingPossible[0][2], domains) === 'undecided') {
      try {
        if (forceBool(outgoingPossible[0][2], true, domains)) changed = true;
      } catch {
        return 'INFEASIBLE';
      }
    }

    // Count incoming arcs
    const incoming = arcs.filter(([_, h, _2]) => h === node);
    const incomingFixed = incoming.filter(([_, __, lit]) => getBoolState(lit, domains) === 'true');
    const incomingPossible = incoming.filter(([_, __, lit]) => getBoolState(lit, domains) !== 'false');

    // If exactly 1 incoming is fixed, all others must be false
    if (incomingFixed.length === 1) {
      for (const [tail, _, lit] of incoming) {
        if (getBoolState(lit, domains) === 'undecided' && !incomingFixed.some(([t, _, _2]) => t === tail)) {
          try {
            if (forceBool(lit, false, domains)) changed = true;
          } catch {
            return 'INFEASIBLE';
          }
        }
      }
    }

    // If no incoming arcs are possible → INFEASIBLE
    if (incomingPossible.length === 0) return 'INFEASIBLE';

    // If exactly 1 incoming is possible, fix it to true
    if (incomingPossible.length === 1 && getBoolState(incomingPossible[0][2], domains) === 'undecided') {
      try {
        if (forceBool(incomingPossible[0][2], true, domains)) changed = true;
      } catch {
        return 'INFEASIBLE';
      }
    }
  }

  // Phase 2: Path tracing and subtour detection
  // Build adjacency from fixed arcs
  const next = new Map<number, number>(); // node → next node
  const prev = new Map<number, number>(); // node → prev node

  for (const [tail, head, lit] of arcs) {
    if (getBoolState(lit, domains) === 'true') {
      if (next.has(tail)) return 'INFEASIBLE'; // 2 outgoing
      if (prev.has(head)) return 'INFEASIBLE'; // 2 incoming
      next.set(tail, head);
      prev.set(head, tail);
    }
  }

  // Trace paths and detect cycles
  const visited = new Set<number>();
  const cycles: number[][] = [];
  const paths: number[][] = [];

  for (const start of nodes) {
    if (visited.has(start)) continue;

    // Trace forward from start
    const path: number[] = [];
    let current: number | undefined = start;
    let isCycle = false;

    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      path.push(current);
      current = next.get(current);

      // Check if we've completed a cycle
      if (current === start) {
        isCycle = true;
        break;
      }
    }

    if (path.length > 0) {
      if (isCycle) {
        cycles.push(path);
      } else {
        paths.push(path);
      }
    }
  }

  // Phase 3: Subtour detection
  // If there's a cycle that doesn't include all nodes → INFEASIBLE
  for (const cycle of cycles) {
    if (cycle.length < n) {
      return 'INFEASIBLE';
    }
  }

  // Phase 4: Path-based propagation
  // If a path would close into a subtour, propagate the closing arc to false
  for (const path of paths) {
    if (path.length < 2) continue;

    const first = path[0];
    const last = path[path.length - 1];

    // Check if there's a closing arc from last to first
    const closingLit = arcMap.get(last * maxNode + first);
    if (closingLit && getBoolState(closingLit, domains) === 'undecided') {
      // If closing this path would create a cycle shorter than n → false
      if (path.length < n) {
        try {
          if (forceBool(closingLit, false, domains)) changed = true;
        } catch {
          return 'INFEASIBLE';
        }
      }
    }

    // Also check arcs that would create cycles through intermediate nodes
    // For each node in the path (except first and last), check if there's an arc
    // from last to that node that would create a subtour
    for (let i = 1; i < path.length - 1; i++) {
      const midNode = path[i];
      const closingToMid = arcMap.get(last * maxNode + midNode);
      if (closingToMid && getBoolState(closingToMid, domains) === 'undecided') {
        // This would create a cycle of length (path.length - i) which is < n
        if (path.length - i < n) {
          try {
            if (forceBool(closingToMid, false, domains)) changed = true;
          } catch {
            return 'INFEASIBLE';
          }
        }
      }
    }
  }

  // Phase 5: If a complete valid cycle exists, force remaining undecided arcs to false
  if (cycles.length === 1 && cycles[0].length === n) {
    // Build a Set of cycle arcs for O(1) membership check
    const cycleArcs = new Set<number>();
    for (let i = 0; i < cycles[0].length; i++) {
      const from = cycles[0][i];
      const to = cycles[0][(i + 1) % cycles[0].length];
      cycleArcs.add(from * maxNode + to);
    }

    for (const [tail, head, lit] of arcs) {
      if (getBoolState(lit, domains) === 'undecided') {
        // Check if this arc is part of the cycle using Set lookup
        if (!cycleArcs.has(tail * maxNode + head)) {
          try {
            if (forceBool(lit, false, domains)) changed = true;
          } catch {
            return 'INFEASIBLE';
          }
        }
      }
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

// ============================================================================
// MultipleCircuit Propagation (VRP-style Routes)
// ============================================================================

/**
 * Propagate a MultipleCircuit constraint.
 *
 * Ensures the selected arcs form one or more routes that collectively cover
 * all nodes. Each route must pass through node 0 (the depot).
 *
 * Algorithm:
 * 1. Degree propagation (same as Circuit)
 * 2. Path tracing and cycle detection
 * 3. If a cycle exists that doesn't pass through node 0 → INFEASIBLE
 * 4. If a path would close into a cycle without node 0, propagate closing arc to false
 */
export function propagateMultipleCircuit(
  ct: MultipleCircuitConstraint,
  domains: Map<number, Domain>,
  _propagateBool: BoolPropagateFn
): PropagationResult {
  const arcs = ct.arcs;
  if (arcs.length === 0) return 'CONSISTENT';

  // Collect all nodes
  const nodeSet = new Set<number>();
  for (const [tail, head] of arcs) {
    nodeSet.add(tail);
    nodeSet.add(head);
  }
  const nodes = [...nodeSet];

  // Node 0 is the depot (must be in every cycle)
  const depot = 0;

  // Build arc lookup: (tail, head) → BoolVar using numeric key
  const maxNode = Math.max(...nodes) + 1;
  const arcMap = new Map<number, BoolVar>();
  for (const [tail, head, lit] of arcs) {
    arcMap.set(tail * maxNode + head, lit);
  }

  let changed = false;

  // Phase 1: Degree propagation (same as Circuit)
  for (const node of nodes) {
    // Count outgoing arcs
    const outgoing = arcs.filter(([t, _, _2]) => t === node);
    const outgoingFixed = outgoing.filter(([_, __, lit]) => getBoolState(lit, domains) === 'true');
    const outgoingPossible = outgoing.filter(([_, __, lit]) => getBoolState(lit, domains) !== 'false');

    if (outgoingFixed.length === 1) {
      for (const [_, head, lit] of outgoing) {
        if (getBoolState(lit, domains) === 'undecided' && !outgoingFixed.some(([_, h, _2]) => h === head)) {
          try {
            if (forceBool(lit, false, domains)) changed = true;
          } catch {
            return 'INFEASIBLE';
          }
        }
      }
    }

    if (outgoingPossible.length === 0) return 'INFEASIBLE';

    if (outgoingPossible.length === 1 && getBoolState(outgoingPossible[0][2], domains) === 'undecided') {
      try {
        if (forceBool(outgoingPossible[0][2], true, domains)) changed = true;
      } catch {
        return 'INFEASIBLE';
      }
    }

    // Count incoming arcs
    const incoming = arcs.filter(([_, h, _2]) => h === node);
    const incomingFixed = incoming.filter(([_, __, lit]) => getBoolState(lit, domains) === 'true');
    const incomingPossible = incoming.filter(([_, __, lit]) => getBoolState(lit, domains) !== 'false');

    if (incomingFixed.length === 1) {
      for (const [tail, _, lit] of incoming) {
        if (getBoolState(lit, domains) === 'undecided' && !incomingFixed.some(([t, _, _2]) => t === tail)) {
          try {
            if (forceBool(lit, false, domains)) changed = true;
          } catch {
            return 'INFEASIBLE';
          }
        }
      }
    }

    if (incomingPossible.length === 0) return 'INFEASIBLE';

    if (incomingPossible.length === 1 && getBoolState(incomingPossible[0][2], domains) === 'undecided') {
      try {
        if (forceBool(incomingPossible[0][2], true, domains)) changed = true;
      } catch {
        return 'INFEASIBLE';
      }
    }
  }

  // Phase 2: Path tracing
  const next = new Map<number, number>();
  const prev = new Map<number, number>();

  for (const [tail, head, lit] of arcs) {
    if (getBoolState(lit, domains) === 'true') {
      if (next.has(tail)) return 'INFEASIBLE';
      if (prev.has(head)) return 'INFEASIBLE';
      next.set(tail, head);
      prev.set(head, tail);
    }
  }

  // Trace paths and detect cycles
  const visited = new Set<number>();
  const cycles: number[][] = [];
  const paths: number[][] = [];

  for (const start of nodes) {
    if (visited.has(start)) continue;

    const path: number[] = [];
    let current: number | undefined = start;
    let isCycle = false;

    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      path.push(current);
      current = next.get(current);

      if (current === start) {
        isCycle = true;
        break;
      }
    }

    if (path.length > 0) {
      if (isCycle) {
        cycles.push(path);
      } else {
        paths.push(path);
      }
    }
  }

  // Phase 3: Subtour detection for MultipleCircuit
  // Each cycle must pass through the depot (node 0)
  for (const cycle of cycles) {
    if (!cycle.includes(depot)) {
      return 'INFEASIBLE';
    }
  }

  // Phase 4: Path-based propagation
  for (const path of paths) {
    if (path.length < 2) continue;

    const first = path[0];
    const last = path[path.length - 1];

    // If closing this path would create a cycle without depot → false
    const closingLit = arcMap.get(last * maxNode + first);
    if (closingLit && getBoolState(closingLit, domains) === 'undecided') {
      // Check if depot is in this path
      if (!path.includes(depot)) {
        try {
          if (forceBool(closingLit, false, domains)) changed = true;
        } catch {
          return 'INFEASIBLE';
        }
      }
    }

    // Also check arcs that would create cycles through intermediate nodes
    for (let i = 1; i < path.length - 1; i++) {
      const midNode = path[i];
      const closingToMid = arcMap.get(last * maxNode + midNode);
      if (closingToMid && getBoolState(closingToMid, domains) === 'undecided') {
        // Check if the resulting cycle would include depot
        const cycleNodes = path.slice(i);
        if (!cycleNodes.includes(depot)) {
          try {
            if (forceBool(closingToMid, false, domains)) changed = true;
          } catch {
            return 'INFEASIBLE';
          }
        }
      }
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

// ============================================================================
// Solution Checkers
// ============================================================================

/**
 * Check if the solution forms a valid Hamiltonian cycle.
 * All variables must be fixed (domain size === 1).
 */
export function checkCircuit(
  ct: CircuitConstraint,
  domains: Map<number, Domain>
): boolean {
  const arcs = ct.arcs;
  if (arcs.length === 0) return true;

  // Collect all nodes
  const nodeSet = new Set<number>();
  for (const [tail, head, _] of arcs) {
    nodeSet.add(tail);
    nodeSet.add(head);
  }
  const nodes = [...nodeSet];
  const n = nodes.length;

  // Build adjacency from selected arcs
  const next = new Map<number, number>();

  for (const [tail, head, lit] of arcs) {
    const d = domains.get(lit.index);
    if (!d || d.size !== 1) return false; // not fixed
    if (d.min === 1) {
      if (next.has(tail)) return false; // 2 outgoing
      next.set(tail, head);
    }
  }

  // Check that every node has exactly 1 outgoing
  for (const node of nodes) {
    if (!next.has(node)) return false;
  }

  // Trace the cycle starting from node 0
  const start = nodes[0];
  let current = start;
  const visited = new Set<number>();

  for (let i = 0; i < n; i++) {
    if (visited.has(current)) return false; // premature cycle
    visited.add(current);
    const nextNode = next.get(current);
    if (nextNode === undefined) return false;
    current = nextNode;
  }

  // Must return to start
  return current === start;
}

/**
 * Check if the solution forms valid routes covering all nodes.
 * Each route must pass through node 0 (depot).
 */
export function checkMultipleCircuit(
  ct: MultipleCircuitConstraint,
  domains: Map<number, Domain>
): boolean {
  const arcs = ct.arcs;
  if (arcs.length === 0) return true;

  // Collect all nodes
  const nodeSet = new Set<number>();
  for (const [tail, head, _] of arcs) {
    nodeSet.add(tail);
    nodeSet.add(head);
  }
  const nodes = [...nodeSet];
  const depot = 0;

  // Build adjacency from selected arcs
  const next = new Map<number, number>();

  for (const [tail, head, lit] of arcs) {
    const d = domains.get(lit.index);
    if (!d || d.size !== 1) return false;
    if (d.min === 1) {
      if (next.has(tail)) return false; // 2 outgoing
      next.set(tail, head);
    }
  }

  // Check that every node has exactly 1 outgoing
  for (const node of nodes) {
    if (!next.has(node)) return false;
  }

  // Trace all cycles and verify each passes through depot
  const visited = new Set<number>();

  for (const start of nodes) {
    if (visited.has(start)) continue;

    let current = start;
    const cycleNodes: number[] = [];
    let isCycle = false;

    while (!visited.has(current)) {
      visited.add(current);
      cycleNodes.push(current);
      const nextNode = next.get(current);
      if (nextNode === undefined) return false;
      current = nextNode;
      if (current === start) {
        isCycle = true;
        break;
      }
    }

    if (!isCycle) return false; // path didn't close

    // Each cycle must pass through depot
    if (!cycleNodes.includes(depot)) return false;
  }

  return true;
}
