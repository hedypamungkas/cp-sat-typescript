/**
 * CP-SAT TypeScript - Graph Coloring Example
 *
 * Assign colors to vertices of a graph such that no two adjacent
 * vertices share the same color, minimizing the number of colors used.
 */

import { CpModel, CpSolver, CpSolverStatus, IntVarImpl } from '../src';

interface Edge {
  from: number;
  to: number;
}

function solveGraphColoring() {
  console.log('Graph Coloring Problem\n');

  // Define graph: Petersen graph (10 vertices, 15 edges)
  const numVertices = 10;
  const maxColors = 4; // Upper bound on chromatic number

  const edges: Edge[] = [
    // Outer pentagon
    { from: 0, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 3 },
    { from: 3, to: 4 }, { from: 4, to: 0 },
    // Inner pentagram
    { from: 5, to: 7 }, { from: 7, to: 9 }, { from: 9, to: 6 },
    { from: 6, to: 8 }, { from: 8, to: 5 },
    // Spokes
    { from: 0, to: 5 }, { from: 1, to: 6 }, { from: 2, to: 7 },
    { from: 3, to: 8 }, { from: 4, to: 9 },
  ];

  console.log(`Vertices: ${numVertices}`);
  console.log(`Edges: ${edges.length}`);
  console.log(`Max colors: ${maxColors}`);
  console.log();

  const model = new CpModel();

  // Color variables: color[v] in [0, maxColors-1]
  const colors = Array.from({ length: numVertices }, (_, i) =>
    model.newIntVar(0, maxColors - 1, `color_${i}`)
  );

  // Adjacent vertices must have different colors
  // Build allowed tuples: all pairs (a, b) where a != b
  const allowedTuples: number[][] = [];
  for (let a = 0; a < maxColors; a++) {
    for (let b = 0; b < maxColors; b++) {
      if (a !== b) allowedTuples.push([a, b]);
    }
  }

  for (const edge of edges) {
    model.addAllowedAssignments([colors[edge.from], colors[edge.to]], allowedTuples);
  }

  // Minimize the number of colors used
  const maxColor = model.newIntVar(0, maxColors - 1, 'maxColor');
  model.addMaxEquality(maxColor, colors);
  model.minimize(maxColor);

  // Solve
  const solver = new CpSolver();
  const status = solver.solve(model);

  if (status === CpSolverStatus.OPTIMAL || status === CpSolverStatus.FEASIBLE) {
    const numColorsUsed = solver.objectiveValue + 1; // 0-indexed
    console.log(`Chromatic number: ${numColorsUsed}`);
    console.log('\nVertex coloring:');
    for (let v = 0; v < numVertices; v++) {
      console.log(`  Vertex ${v}: color ${solver.value(colors[v])}`);
    }

    // Verify no adjacent vertices share a color
    let valid = true;
    for (const edge of edges) {
      if (solver.value(colors[edge.from]) === solver.value(colors[edge.to])) {
        console.log(`  ERROR: vertices ${edge.from} and ${edge.to} share color!`);
        valid = false;
      }
    }
    if (valid) console.log('\n✓ Coloring is valid!');

    console.log('\nStatistics:');
    console.log(`  Conflicts: ${solver.numConflicts}`);
    console.log(`  Branches:  ${solver.numBranches}`);
    console.log(`  Presolve:  ${(solver.presolveTime * 1000).toFixed(1)} ms`);
    console.log(`  Search:    ${(solver.searchTime * 1000).toFixed(1)} ms`);
    console.log(`  Total:     ${(solver.wallTime * 1000).toFixed(1)} ms`);
  } else {
    console.log('No solution found!');
  }
}

solveGraphColoring();
