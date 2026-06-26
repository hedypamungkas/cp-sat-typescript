/**
 * CP-SAT TypeScript Implementation
 * Presolve module - Domain compression and affine relation detection
 *
 * Presolve simplifies the model before search begins by:
 * 1. Tightening variable domains based on constraint bounds (compressDomains)
 * 2. Detecting linear relationships between variables and substituting (detectAffineRelations)
 * 3. Removing constraints that become trivially satisfied
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Domain } from './types';
import { CpModel } from './model';
import {
  Constraint,
  LinearConstraint,
  NotEqualConstraint,
  BoolOrConstraint,
  BoolAndConstraint,
  AtMostOneConstraint,
  ExactlyOneConstraint,
  ImplicationConstraint,
  MaxEqualityConstraint,
  MinEqualityConstraint,
} from './constraints';

// ============================================================================
// Presolve Types
// ============================================================================

/**
 * Result of the presolve phase
 */
export interface PresolveResult {
  /** Status after presolve */
  status: 'FEASIBLE' | 'INFEASIBLE' | 'OPTIMAL';
  /** Tightened domains */
  domains: Map<number, Domain>;
  /** Indices of constraints still active */
  activeConstraints: Set<number>;
  /** Derived variables: varIndex → { baseVarIndex, coeff, offset } where var = coeff * base + offset */
  derivedVars: Map<number, DerivedVar>;
  /** Number of variables fixed during presolve */
  numVarsFixed: number;
  /** Number of constraints removed during presolve */
  numConstraintsRemoved: number;
}

/**
 * Describes a derived variable in terms of a base variable
 */
export interface DerivedVar {
  baseVarIndex: number;
  coeff: number;
  offset: number;
}

// ============================================================================
// Compress Domains
// ============================================================================

/**
 * Tighten variable domains by propagating constraint bounds.
 * Repeats until no more changes occur (fixpoint) or infeasibility is detected.
 */
export function compressDomains(
  model: CpModel,
  domains: Map<number, Domain>,
  activeConstraints: Set<number>
): { status: 'FEASIBLE' | 'INFEASIBLE'; domains: Map<number, Domain>; numVarsFixed: number } {
  let numVarsFixed = 0;
  const MAX_ITERATIONS = 100;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;

    for (const ctIdx of activeConstraints) {
      const constraint = model.constraints[ctIdx];
      if (!constraint) continue;

      const result = propagateConstraint(constraint, domains);
      if (result === 'INFEASIBLE') {
        return { status: 'INFEASIBLE', domains, numVarsFixed };
      }
      if (result === 'CHANGED') {
        changed = true;
      }
    }

    // Check for newly fixed variables and empty domains
    for (const [, domain] of domains) {
      if (domain.isEmpty) {
        return { status: 'INFEASIBLE', domains, numVarsFixed };
      }
      if (domain.size === 1) {
        // Variable is fixed — nothing more to tighten
      }
    }

    if (!changed) break;
  }

  // Count fixed variables
  for (const [, domain] of domains) {
    if (domain.size === 1) {
      numVarsFixed++;
    }
  }

  return { status: 'FEASIBLE', domains, numVarsFixed };
}

/**
 * Propagate a single constraint, tightening domains.
 * Returns 'CHANGED' if any domain was reduced, 'CONSISTENT' if no change, 'INFEASIBLE' if contradiction.
 */
function propagateConstraint(
  constraint: Constraint,
  domains: Map<number, Domain>
): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
  switch (constraint.type) {
    case 'LINEAR':
      return propagateLinear(constraint as LinearConstraint, domains);
    case 'BOOL_OR':
      return propagateBoolOr(constraint as BoolOrConstraint, domains);
    case 'BOOL_AND':
      return propagateBoolAnd(constraint as BoolAndConstraint, domains);
    case 'AT_MOST_ONE':
      return propagateAtMostOne(constraint as AtMostOneConstraint, domains);
    case 'EXACTLY_ONE':
      return propagateExactlyOne(constraint as ExactlyOneConstraint, domains);
    case 'IMPLICATION':
      return propagateImplication(constraint as ImplicationConstraint, domains);
    case 'MAX_EQUALITY':
      return propagateMaxEquality(constraint as MaxEqualityConstraint, domains);
    case 'MIN_EQUALITY':
      return propagateMinEquality(constraint as MinEqualityConstraint, domains);
    // case 'RESERVOIR':
    //   return propagateReservoirPresolve(constraint as ReservoirConstraint, domains);
    default:
      return 'CONSISTENT';
  }
}

/**
 * Propagate a linear constraint: lb <= sum(vars[i] * coeffs[i]) <= ub
 *
 * For each variable, compute the contribution range of all OTHER variables,
 * then derive the required range for this variable.
 */
function propagateLinear(
  constraint: LinearConstraint,
  domains: Map<number, Domain>
): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
  const { vars, coeffs, domain: bounds } = constraint;
  const lb = bounds.min;
  const ub = bounds.max;

  // Compute total expression range
  let exprMin = 0;
  let exprMax = 0;
  for (let i = 0; i < vars.length; i++) {
    const varDomain = domains.get(vars[i].index);
    if (!varDomain || varDomain.isEmpty) return 'INFEASIBLE';

    const c = coeffs[i];
    if (c > 0) {
      exprMin += c * varDomain.min;
      exprMax += c * varDomain.max;
    } else if (c < 0) {
      exprMin += c * varDomain.max;
      exprMax += c * varDomain.min;
    }
  }

  // Check if constraint is already infeasible
  if (exprMax < lb || exprMin > ub) {
    return 'INFEASIBLE';
  }

  // If the entire expression range fits within bounds, no tightening needed
  if (exprMin >= lb && exprMax <= ub) {
    return 'CONSISTENT';
  }

  let changed = false;

  // For each variable, tighten its domain
  for (let i = 0; i < vars.length; i++) {
    const varIdx = vars[i].index;
    const varDomain = domains.get(varIdx);
    if (!varDomain) continue;

    const c = coeffs[i];
    if (c === 0) continue;

    // Compute range of all OTHER terms
    let otherMin = 0;
    let otherMax = 0;
    for (let j = 0; j < vars.length; j++) {
      if (j === i) continue;
      const otherDomain = domains.get(vars[j].index);
      if (!otherDomain) continue;

      const cj = coeffs[j];
      if (cj > 0) {
        otherMin += cj * otherDomain.min;
        otherMax += cj * otherDomain.max;
      } else if (cj < 0) {
        otherMin += cj * otherDomain.max;
        otherMax += cj * otherDomain.min;
      }
    }

    // lb <= c*xi + other <= ub
    // => (lb - otherMax) <= c*xi <= (ub - otherMin)  [when c > 0]
    // => (lb - otherMin) <= c*xi <= (ub - otherMax)  [when c < 0]
    let newDomain: Domain;

    if (c > 0) {
      const varLb = Math.ceil((lb - otherMax) / c);
      const varUb = Math.floor((ub - otherMin) / c);
      newDomain = varDomain.greaterOrEqual(varLb).lessOrEqual(varUb);
    } else {
      const varLb = Math.ceil((ub - otherMin) / c); // c is negative, so this is the lower bound
      const varUb = Math.floor((lb - otherMax) / c); // c is negative, so this is the upper bound
      newDomain = varDomain.greaterOrEqual(varLb).lessOrEqual(varUb);
    }

    if (newDomain.isEmpty) {
      return 'INFEASIBLE';
    }

    if (newDomain.size < varDomain.size) {
      domains.set(varIdx, newDomain);
      changed = true;
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

/**
 * Propagate BoolOr: at least one literal must be true.
 * If any literal is fixed to 1 → constraint satisfied, remove.
 * If all literals fixed to 0 → INFEASIBLE.
 */
function propagateBoolOr(
  constraint: BoolOrConstraint,
  domains: Map<number, Domain>
): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
  const { literals } = constraint;

  let numFalse = 0;
  let lastUnfixed = -1;

  for (const lit of literals) {
    const domain = domains.get(lit.index);
    if (!domain) continue;

    if (domain.min === 1) {
      // At least one is true → constraint satisfied
      return 'CONSISTENT';
    }
    if (domain.max === 0) {
      numFalse++;
    } else {
      lastUnfixed = lit.index;
    }
  }

  if (numFalse === literals.length) {
    return 'INFEASIBLE';
  }

  // Exactly one unfixed → it must be true
  if (numFalse === literals.length - 1 && lastUnfixed >= 0) {
    const domain = domains.get(lastUnfixed);
    if (domain && domain.size > 1) {
      domains.set(lastUnfixed, domain.fixValue(1));
      return 'CHANGED';
    }
  }

  return 'CONSISTENT';
}

/**
 * Propagate BoolAnd: all literals must be true.
 * If any literal is fixed to 0 → INFEASIBLE.
 * Otherwise, fix all unfixed literals to 1.
 */
function propagateBoolAnd(
  constraint: BoolAndConstraint,
  domains: Map<number, Domain>
): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
  let changed = false;

  for (const lit of constraint.literals) {
    const domain = domains.get(lit.index);
    if (!domain) continue;

    if (domain.max === 0) {
      return 'INFEASIBLE';
    }

    if (domain.size > 1) {
      domains.set(lit.index, domain.fixValue(1));
      changed = true;
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

/**
 * Propagate AtMostOne: at most one literal can be true.
 * If one literal is fixed to 1 → fix all others to 0.
 * If two or more are fixed to 1 → INFEASIBLE.
 */
function propagateAtMostOne(
  constraint: AtMostOneConstraint,
  domains: Map<number, Domain>
): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
  const { literals } = constraint;

  let numTrue = 0;
  let trueIdx = -1;

  for (let i = 0; i < literals.length; i++) {
    const domain = domains.get(literals[i].index);
    if (!domain) continue;

    if (domain.min === 1) {
      numTrue++;
      trueIdx = i;
    }
  }

  if (numTrue > 1) {
    return 'INFEASIBLE';
  }

  if (numTrue === 1) {
    // Fix all others to 0
    let changed = false;
    for (let i = 0; i < literals.length; i++) {
      if (i === trueIdx) continue;
      const domain = domains.get(literals[i].index);
      if (domain && domain.size > 1) {
        domains.set(literals[i].index, domain.fixValue(0));
        changed = true;
      }
    }
    return changed ? 'CHANGED' : 'CONSISTENT';
  }

  return 'CONSISTENT';
}

/**
 * Propagate ExactlyOne: exactly one literal must be true.
 * Combination of BoolOr and AtMostOne logic.
 */
function propagateExactlyOne(
  constraint: ExactlyOneConstraint,
  domains: Map<number, Domain>
): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
  const { literals } = constraint;

  let numTrue = 0;
  let numFalse = 0;
  let trueIdx = -1;
  let lastUnfixedIdx = -1;

  for (let i = 0; i < literals.length; i++) {
    const domain = domains.get(literals[i].index);
    if (!domain) continue;

    if (domain.min === 1) {
      numTrue++;
      trueIdx = i;
    } else if (domain.max === 0) {
      numFalse++;
    } else {
      lastUnfixedIdx = i;
    }
  }

  if (numTrue > 1) return 'INFEASIBLE';
  if (numTrue === 0 && numFalse === literals.length) return 'INFEASIBLE';

  let changed = false;

  if (numTrue === 1) {
    // Fix all others to 0
    for (let i = 0; i < literals.length; i++) {
      if (i === trueIdx) continue;
      const domain = domains.get(literals[i].index);
      if (domain && domain.size > 1) {
        domains.set(literals[i].index, domain.fixValue(0));
        changed = true;
      }
    }
  } else if (numFalse === literals.length - 1 && lastUnfixedIdx >= 0) {
    // Exactly one unfixed → it must be true
    const domain = domains.get(literals[lastUnfixedIdx].index);
    if (domain && domain.size > 1) {
      domains.set(literals[lastUnfixedIdx].index, domain.fixValue(1));
      changed = true;
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

/**
 * Propagate Implication: a => b
 * If a=1 → b=1. If b=0 → a=0.
 */
function propagateImplication(
  constraint: ImplicationConstraint,
  domains: Map<number, Domain>
): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
  const { a, b } = constraint;
  const aDomain = domains.get(a.index);
  const bDomain = domains.get(b.index);

  if (!aDomain || !bDomain) return 'CONSISTENT';

  let changed = false;

  // If a is true, b must be true
  if (aDomain.min === 1 && bDomain.size > 1) {
    domains.set(b.index, bDomain.fixValue(1));
    changed = true;
  }

  // If b is false, a must be false
  if (bDomain.max === 0 && aDomain.size > 1) {
    domains.set(a.index, aDomain.fixValue(0));
    changed = true;
  }

  // Check for contradiction
  if (aDomain.min === 1 && bDomain.max === 0) {
    return 'INFEASIBLE';
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

/**
 * Propagate MaxEquality: target == max(expressions)
 * target >= each expression. target <= max of expression upper bounds.
 */
function propagateMaxEquality(
  constraint: MaxEqualityConstraint,
  domains: Map<number, Domain>
): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
  const { target, expressions } = constraint;
  const targetDomain = domains.get(target.index);
  if (!targetDomain || targetDomain.isEmpty) return 'INFEASIBLE';

  let changed = false;

  // Compute max of expression upper bounds
  let maxUb = -Infinity;
  for (const expr of expressions) {
    const exprDomain = expr.getDomain(domains);
    if (exprDomain.isEmpty) return 'INFEASIBLE';
    maxUb = Math.max(maxUb, exprDomain.max);
  }

  // target <= maxUb
  const newTargetDomain = targetDomain.lessOrEqual(maxUb);
  if (newTargetDomain.isEmpty) return 'INFEASIBLE';
  if (newTargetDomain.size < targetDomain.size) {
    domains.set(target.index, newTargetDomain);
    changed = true;
  }

  // Each expression <= target (since target = max of expressions)
  for (const expr of expressions) {
    if (expr.vars.length === 1 && expr.coeffs[0] === 1 && expr.offset === 0) {
      const varIdx = expr.vars[0].index;
      const varDomain = domains.get(varIdx);
      if (!varDomain) continue;

      const currentTargetDomain = domains.get(target.index)!;
      const newVarDomain = varDomain.lessOrEqual(currentTargetDomain.max);
      if (newVarDomain.isEmpty) return 'INFEASIBLE';
      if (newVarDomain.size < varDomain.size) {
        domains.set(varIdx, newVarDomain);
        changed = true;
      }
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

/**
 * Propagate MinEquality: target == min(expressions)
 * target <= each expression. target >= min of expression lower bounds.
 */
function propagateMinEquality(
  constraint: MinEqualityConstraint,
  domains: Map<number, Domain>
): 'CHANGED' | 'CONSISTENT' | 'INFEASIBLE' {
  const { target, expressions } = constraint;
  const targetDomain = domains.get(target.index);
  if (!targetDomain || targetDomain.isEmpty) return 'INFEASIBLE';

  let changed = false;

  // Compute min of expression lower bounds
  let minLb = Infinity;
  for (const expr of expressions) {
    const exprDomain = expr.getDomain(domains);
    if (exprDomain.isEmpty) return 'INFEASIBLE';
    minLb = Math.min(minLb, exprDomain.min);
  }

  // target >= minLb
  const newTargetDomain = targetDomain.greaterOrEqual(minLb);
  if (newTargetDomain.isEmpty) return 'INFEASIBLE';
  if (newTargetDomain.size < targetDomain.size) {
    domains.set(target.index, newTargetDomain);
    changed = true;
  }

  // Each expression >= target (since target = min of expressions)
  for (const expr of expressions) {
    if (expr.vars.length === 1 && expr.coeffs[0] === 1 && expr.offset === 0) {
      const varIdx = expr.vars[0].index;
      const varDomain = domains.get(varIdx);
      if (!varDomain) continue;

      const currentTargetDomain = domains.get(target.index)!;
      const newVarDomain = varDomain.greaterOrEqual(currentTargetDomain.min);
      if (newVarDomain.isEmpty) return 'INFEASIBLE';
      if (newVarDomain.size < varDomain.size) {
        domains.set(varIdx, newVarDomain);
        changed = true;
      }
    }
  }

  return changed ? 'CHANGED' : 'CONSISTENT';
}

// ============================================================================
// Affine Relation Detection
// ============================================================================

/**
 * Detect affine relationships between variables (x = coeff * y + offset).
 * For each relationship found:
 * - Substitute x with (coeff * y + offset) in all constraints
 * - Tighten y's domain from x's domain
 * - Mark x as derived (solver won't branch on it)
 */
export function detectAffineRelations(
  model: CpModel,
  domains: Map<number, Domain>,
  activeConstraints: Set<number>,
  alreadyDerived: Map<number, DerivedVar> = new Map()
): { derivedVars: Map<number, DerivedVar>; domains: Map<number, Domain>; numConstraintsRemoved: number } {
  const derivedVars = new Map<number, DerivedVar>();
  let numConstraintsRemoved = 0;

  // Find affine relations from linear constraints with 1-2 variables
  for (const ctIdx of activeConstraints) {
    const constraint = model.constraints[ctIdx];
    if (!(constraint instanceof LinearConstraint)) continue;

    const { vars, coeffs, domain: bounds } = constraint;

    // Only handle equality constraints (single value in domain)
    if (bounds.size !== 1) continue;

    const rhs = bounds.min;

    if (vars.length === 1) {
      // c * x = rhs → x = rhs / c
      const c = coeffs[0];
      const xIdx = vars[0].index;

      if (derivedVars.has(xIdx) || alreadyDerived.has(xIdx)) continue;

      if (rhs % c !== 0) continue; // Not an integer solution

      const value = rhs / c;
      const xDomain = domains.get(xIdx);
      if (xDomain && !xDomain.contains(value)) {
        // Infeasible — value not in domain
        continue;
      }

      // Fix x to value (treat as derived with base = self, coeff = 0, offset = value)
      derivedVars.set(xIdx, { baseVarIndex: xIdx, coeff: 0, offset: value });
      domains.set(xIdx, new Domain([value, value]));
      activeConstraints.delete(ctIdx);
      numConstraintsRemoved++;

    } else if (vars.length === 2) {
      // c1 * x + c2 * y = rhs
      const c1 = coeffs[0];
      const c2 = coeffs[1];
      const xIdx = vars[0].index;
      const yIdx = vars[1].index;

      // Skip if either is already derived (in this pass or a prior presolve iteration)
      if (derivedVars.has(xIdx) || derivedVars.has(yIdx) ||
          alreadyDerived.has(xIdx) || alreadyDerived.has(yIdx)) continue;

      // Try to express x in terms of y: x = (rhs - c2*y) / c1
      if (c1 !== 0 && (rhs % gcd(Math.abs(c1), Math.abs(c2)) !== 0)) continue;

      // Prefer to derive the variable with the larger domain
      const xDomain = domains.get(xIdx);
      const yDomain = domains.get(yIdx);
      if (!xDomain || !yDomain) continue;

      let derivedIdx: number;
      let baseIdx: number;
      let derivedCoeff: number;
      let derivedOffset: number;

      if (xDomain.size >= yDomain.size) {
        // Derive x from y: x = (rhs - c2*y) / c1
        // Always integer when c1 divides c2
        if (c2 % c1 === 0 && rhs % c1 === 0) {
          derivedIdx = xIdx;
          baseIdx = yIdx;
          derivedCoeff = -c2 / c1;
          derivedOffset = rhs / c1;
        } else {
          continue;
        }
      } else {
        // Derive y from x: y = (rhs - c1*x) / c2
        // Always integer when c2 divides c1
        if (c1 % c2 === 0 && rhs % c2 === 0) {
          derivedIdx = yIdx;
          baseIdx = xIdx;
          derivedCoeff = -c1 / c2;
          derivedOffset = rhs / c2;
        } else {
          continue;
        }
      }

      // Tighten base variable domain from derived variable domain
      const derivedDomain = domains.get(derivedIdx)!;
      const baseDomain = domains.get(baseIdx)!;

      // derived = derivedCoeff * base + derivedOffset
      // So base = (derived - derivedOffset) / derivedCoeff
      let newBaseDomain: Domain;
      if (derivedCoeff > 0) {
        const baseLb = Math.ceil((derivedDomain.min - derivedOffset) / derivedCoeff);
        const baseUb = Math.floor((derivedDomain.max - derivedOffset) / derivedCoeff);
        newBaseDomain = baseDomain.greaterOrEqual(baseLb).lessOrEqual(baseUb);
      } else if (derivedCoeff < 0) {
        const baseLb = Math.ceil((derivedDomain.max - derivedOffset) / derivedCoeff);
        const baseUb = Math.floor((derivedDomain.min - derivedOffset) / derivedCoeff);
        newBaseDomain = baseDomain.greaterOrEqual(baseLb).lessOrEqual(baseUb);
      } else {
        continue;
      }

      if (newBaseDomain.isEmpty) continue; // Would be infeasible, skip this relation

      if (newBaseDomain.size < baseDomain.size) {
        domains.set(baseIdx, newBaseDomain);
      }

      derivedVars.set(derivedIdx, { baseVarIndex: baseIdx, coeff: derivedCoeff, offset: derivedOffset });
      activeConstraints.delete(ctIdx);
      numConstraintsRemoved++;
    }
  }

  return { derivedVars, domains, numConstraintsRemoved };
}

/**
 * Compute GCD of two numbers
 */
function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

// ============================================================================
// Constraint Removal
// ============================================================================

/**
 * Check if a constraint is permanently satisfied given current domains.
 * A permanently satisfied constraint can never become violated regardless
 * of how remaining unfixed variables are assigned.
 */
function isConstraintSatisfied(
  constraint: Constraint,
  domains: Map<number, Domain>
): boolean {
  switch (constraint.type) {
    case 'LINEAR': {
      const ct = constraint as LinearConstraint;
      // All variables fixed and sum within bounds
      const allFixed = ct.vars.every(v => {
        const d = domains.get(v.index);
        return d && d.size === 1;
      });
      if (!allFixed) return false;
      let sum = 0;
      for (let i = 0; i < ct.vars.length; i++) {
        sum += ct.coeffs[i] * domains.get(ct.vars[i].index)!.min;
      }
      return ct.domain.contains(sum);
    }
    case 'BOOL_OR': {
      const ct = constraint as BoolOrConstraint;
      // Any literal fixed to 1 → satisfied
      return ct.literals.some(lit => {
        const d = domains.get(lit.index);
        return d && d.min === 1;
      });
    }
    case 'BOOL_AND': {
      const ct = constraint as BoolAndConstraint;
      // All literals fixed to 1
      return ct.literals.every(lit => {
        const d = domains.get(lit.index);
        return d && d.size === 1 && d.min === 1;
      });
    }
    case 'AT_MOST_ONE': {
      const ct = constraint as AtMostOneConstraint;
      // Satisfied (and safe to drop) only when every literal is fixed AND at
      // most one of them is true. Counting true literals matters: two literals
      // fixed to 1 violate the constraint and must NOT be treated as satisfied.
      let trueCount = 0;
      for (const lit of ct.literals) {
        const d = domains.get(lit.index);
        if (!d || d.size !== 1) return false; // not all fixed → keep active
        if (d.min === 1) trueCount++;
      }
      return trueCount <= 1;
    }
    case 'NOT_EQUAL': {
      const ct = constraint as NotEqualConstraint;
      const allFixed = ct.expr.vars.every(v => {
        const d = domains.get(v.index);
        return d && d.size === 1;
      });
      if (!allFixed) return false;
      const value = ct.expr.evaluate(v => domains.get(v.index)!.min);
      return value !== ct.value;
    }
    case 'EXACTLY_ONE': {
      const ct = constraint as ExactlyOneConstraint;
      // One literal fixed to 1 → others forced to 0 by presolve
      return ct.literals.some(lit => {
        const d = domains.get(lit.index);
        return d && d.size === 1 && d.min === 1;
      });
    }
    case 'IMPLICATION': {
      const ct = constraint as ImplicationConstraint;
      const aDomain = domains.get(ct.a.index);
      const bDomain = domains.get(ct.b.index);
      if (!aDomain || !bDomain) return false;
      // a=0 → satisfied regardless of b; b=1 → satisfied regardless of a
      return (aDomain.size === 1 && aDomain.min === 0) ||
             (bDomain.size === 1 && bDomain.min === 1);
    }
    case 'MAX_EQUALITY':
    case 'MIN_EQUALITY': {
      const ct = constraint as MaxEqualityConstraint | MinEqualityConstraint;
      // All expressions and target fixed, equality holds
      const targetDomain = domains.get(ct.target.index);
      if (!targetDomain || targetDomain.size > 1) return false;
      const allExprFixed = ct.expressions.every(expr => {
        const d = expr.getDomain(domains);
        return d.size === 1;
      });
      if (!allExprFixed) return false;
      const targetVal = targetDomain.min;
      if (constraint.type === 'MAX_EQUALITY') {
        const maxVal = Math.max(...ct.expressions.map(e => e.getDomain(domains).min));
        return targetVal === maxVal;
      } else {
        const minVal = Math.min(...ct.expressions.map(e => e.getDomain(domains).min));
        return targetVal === minVal;
      }
    }
    default:
      return false;
  }
}

/**
 * Remove permanently satisfied constraints from the active set.
 * Called after the compression/affine loop converges.
 */
export function removeSatisfiedConstraints(
  model: CpModel,
  domains: Map<number, Domain>,
  activeConstraints: Set<number>
): number {
  let removed = 0;
  for (const ctIdx of activeConstraints) {
    const constraint = model.constraints[ctIdx];
    if (!constraint) continue;
    if (isConstraintSatisfied(constraint, domains)) {
      activeConstraints.delete(ctIdx);
      removed++;
    }
  }
  return removed;
}

// ============================================================================
// Main Presolve Entry Point
// ============================================================================

/**
 * Run the full presolve pipeline on a model.
 *
 * @param model - The CP model
 * @param domains - Current variable domains (will be modified in-place)
 * @returns PresolveResult with tightened domains, active constraints, and derived variables
 */
export function presolveModel(
  model: CpModel,
  domains: Map<number, Domain>
): PresolveResult {
  // Initialize active constraints — all constraints start as active
  const activeConstraints = new Set<number>();
  for (let i = 0; i < model.constraints.length; i++) {
    activeConstraints.add(i);
  }

  const derivedVars = new Map<number, DerivedVar>();
  let totalVarsFixed = 0;
  let totalConstraintsRemoved = 0;

  const MAX_ITERATIONS = 10;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    // Phase 1: Domain compression
    const compressionResult = compressDomains(model, domains, activeConstraints);
    totalVarsFixed += compressionResult.numVarsFixed;

    if (compressionResult.status === 'INFEASIBLE') {
      return {
        status: 'INFEASIBLE',
        domains,
        activeConstraints,
        derivedVars,
        numVarsFixed: totalVarsFixed,
        numConstraintsRemoved: totalConstraintsRemoved,
      };
    }

    // Phase 2: Affine relation detection
    // Pass the accumulated derivedVars so it won't re-derive variables already
    // derived in a prior iteration (which would orphan their former base variable).
    const affineResult = detectAffineRelations(model, domains, activeConstraints, derivedVars);
    totalConstraintsRemoved += affineResult.numConstraintsRemoved;

    // Merge derived vars (only new ones — alreadyDerived guard prevents overwrite)
    for (const [varIdx, derived] of affineResult.derivedVars) {
      if (!derivedVars.has(varIdx)) {
        derivedVars.set(varIdx, derived);
      }
    }

    // If nothing changed in this iteration, we're done
    if (affineResult.numConstraintsRemoved === 0 && compressionResult.numVarsFixed === 0) {
      break;
    }
  }

  // Phase 3: Remove permanently satisfied constraints
  const removedSatisfied = removeSatisfiedConstraints(model, domains, activeConstraints);
  totalConstraintsRemoved += removedSatisfied;

  // Check if all non-derived variables are fixed
  let allFixed = true;
  for (const [varIdx, domain] of domains) {
    if (!derivedVars.has(varIdx) && domain.size > 1) {
      allFixed = false;
      break;
    }
  }

  // Only report OPTIMAL if all variables are fixed AND no active constraints remain
  // (removed constraints were verified during presolve).
  // If active constraints remain, we can't guarantee optimality — let the solver verify.
  const status = (allFixed && activeConstraints.size === 0) ? 'OPTIMAL' : 'FEASIBLE';

  return {
    status,
    domains,
    activeConstraints,
    derivedVars,
    numVarsFixed: totalVarsFixed,
    numConstraintsRemoved: totalConstraintsRemoved,
  };
}

/**
 * Compute the value of a derived variable from the solution.
 *
 * @param derived - The derived variable description
 * @param solution - Map of variable index to assigned value
 * @returns The computed value
 */
export function computeDerivedValue(derived: DerivedVar, solution: Map<number, number>): number {
  if (derived.coeff === 0) {
    return derived.offset;
  }
  const baseValue = solution.get(derived.baseVarIndex) ?? 0;
  return derived.coeff * baseValue + derived.offset;
}
