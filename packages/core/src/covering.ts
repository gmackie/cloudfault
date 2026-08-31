import type { FaultPoint, Perturbation, Scenario } from "./types.js";

interface ChoiceRef {
  point: number;
  choice: number;
  perturbation: Perturbation;
}

function pairKey(a: ChoiceRef, b: ChoiceRef): string {
  const [left, right] = a.point < b.point ? [a, b] : [b, a];
  return `${left.point}:${left.choice}|${right.point}:${right.choice}`;
}

function allPairs(points: readonly FaultPoint[]): Set<string> {
  const pairs = new Set<string>();
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      for (let ai = 0; ai < points[i]!.choices.length; ai++) {
        for (let bi = 0; bi < points[j]!.choices.length; bi++) {
          pairs.add(pairKey(
            { point: i, choice: ai, perturbation: points[i]!.choices[ai]! },
            { point: j, choice: bi, perturbation: points[j]!.choices[bi]! },
          ));
        }
      }
    }
  }
  return pairs;
}

function scenarioPairs(refs: readonly ChoiceRef[]): readonly string[] {
  const pairs: string[] = [];
  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) pairs.push(pairKey(refs[i]!, refs[j]!));
  }
  return pairs;
}

/**
 * Greedy pairwise covering strategy for large fault spaces. It keeps the
 * baseline and depth-1 tests, then chooses multi-point rows that cover as many
 * previously unseen perturbation pairs as possible. This is intentionally a
 * fast, deterministic approximation rather than a full IPOG implementation.
 */
export function pairwiseScenarios(
  points: readonly FaultPoint[],
  options: { includeBaseline?: boolean; seed?: number; maxScenarios?: number } = {},
): readonly Scenario[] {
  const rows: Scenario[] = [];
  const maxScenarios = options.maxScenarios ?? Number.POSITIVE_INFINITY;
  if (options.includeBaseline ?? true) rows.push({ id: "baseline", perturbations: [], seed: options.seed });

  // Depth-1 is cheap and diagnostically useful, so retain it even though it
  // does not contribute pair coverage.
  for (const point of points) {
    for (const choice of point.choices) {
      rows.push({ id: choice.id, perturbations: [choice], seed: options.seed });
      if (rows.length >= maxScenarios) return rows;
    }
  }

  const uncovered = allPairs(points);
  if (!uncovered.size || rows.length >= maxScenarios) return rows;

  // Candidate rows choose one perturbation from every point. Enumerating the
  // full cartesian product can itself explode, so build candidates greedily
  // from each uncovered pair and fill remaining points with their first choice.
  while (uncovered.size && rows.length < maxScenarios) {
    let bestRefs: ChoiceRef[] | undefined;
    let bestCoverage = -1;

    for (const wanted of uncovered) {
      const [aText, bText] = wanted.split("|");
      const [ap, ac] = aText!.split(":").map(Number);
      const [bp, bc] = bText!.split(":").map(Number);
      const refs: ChoiceRef[] = [];
      for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
        const point = points[pointIndex]!;
        if (!point.choices.length) continue;
        const choiceIndex = pointIndex === ap ? ac : pointIndex === bp ? bc : 0;
        const perturbation = point.choices[choiceIndex];
        if (perturbation) refs.push({ point: pointIndex, choice: choiceIndex, perturbation });
      }
      const coverage = scenarioPairs(refs).filter((key) => uncovered.has(key)).length;
      if (coverage > bestCoverage) {
        bestCoverage = coverage;
        bestRefs = refs;
      }
    }

    if (!bestRefs?.length) break;
    const perturbations = bestRefs.map((ref) => ref.perturbation);
    rows.push({
      id: `pairwise:${perturbations.map((item) => item.id).join("+")}`,
      perturbations,
      seed: options.seed,
      metadata: { strategy: "pairwise" },
    });
    for (const key of scenarioPairs(bestRefs)) uncovered.delete(key);
  }

  return rows;
}

/** Conservative Filibuster/LDFI-style pruning: never inject a fault point whose
 * target/operation was absent from the successful baseline history. */
export function pruneUnobservedFaultPoints(
  points: readonly FaultPoint[],
  observed: readonly { target: string; operation: string }[],
): readonly FaultPoint[] {
  const keys = new Set(observed.map((call) => `${call.target}|${call.operation}`));
  return points.filter((point) => point.choices.some((choice) => {
    const target = choice.selector?.target ?? choice.target;
    const operation = choice.selector?.operation ?? choice.operation;
    return operation ? keys.has(`${target}|${operation}`) : observed.some((call) => call.target === target);
  }));
}

export interface PairwiseCoverage {
  totalPairs: number;
  coveredPairs: number;
  ratio: number;
}

export function pairwiseCoverage(
  points: readonly FaultPoint[],
  scenarios: readonly Scenario[],
): PairwiseCoverage {
  const all = allPairs(points);
  if (!all.size) return { totalPairs: 0, coveredPairs: 0, ratio: 1 };
  const covered = new Set<string>();

  const refsById = new Map<string, ChoiceRef>();
  points.forEach((point, pointIndex) => point.choices.forEach((choice, choiceIndex) => {
    refsById.set(choice.id, { point: pointIndex, choice: choiceIndex, perturbation: choice });
  }));

  for (const scenario of scenarios) {
    const refs = scenario.perturbations.map((item) => refsById.get(item.id)).filter(Boolean) as ChoiceRef[];
    for (const key of scenarioPairs(refs)) if (all.has(key)) covered.add(key);
  }

  return { totalPairs: all.size, coveredPairs: covered.size, ratio: covered.size / all.size };
}
