import type { CloudFaultConfig } from "./runner.js";

export interface ConfigIssue {
  path: string;
  severity: "error" | "warning";
  message: string;
}

const STRATEGIES = new Set(["exhaustive", "pairwise", "guided", "coverage-guided", "incidents", "hybrid"]);

export function validateCloudFaultConfig(config: CloudFaultConfig): readonly ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const error = (path: string, message: string) => issues.push({ path, severity: "error", message });
  const warn = (path: string, message: string) => issues.push({ path, severity: "warning", message });

  if (!config.name?.trim()) error("name", "CloudFault config requires a non-empty name");
  if (!Array.isArray(config.faultPoints)) error("faultPoints", "faultPoints must be an array");
  if (typeof config.execute !== "function") error("execute", "execute(scenario) must be a function");
  if (config.strategy && !STRATEGIES.has(config.strategy)) error("strategy", `Unknown search strategy '${config.strategy}'`);
  if (config.maxDepth !== undefined && (!Number.isInteger(config.maxDepth) || config.maxDepth < 0)) error("maxDepth", "maxDepth must be a non-negative integer");
  if (config.maxScenarios !== undefined && (!Number.isInteger(config.maxScenarios) || config.maxScenarios <= 0)) error("maxScenarios", "maxScenarios must be a positive integer");
  if (config.seed !== undefined && (!Number.isInteger(config.seed) || !Number.isFinite(config.seed))) error("seed", "seed must be a finite integer");
  if (config.concurrency !== undefined && (!Number.isInteger(config.concurrency) || config.concurrency <= 0)) error("concurrency", "concurrency must be a positive integer");
  if (config.budget?.maxRuns !== undefined && (!Number.isInteger(config.budget.maxRuns) || config.budget.maxRuns <= 0)) error("budget.maxRuns", "maxRuns must be a positive integer");
  if (config.budget?.maxEstimatedCost !== undefined && (!Number.isFinite(config.budget.maxEstimatedCost) || config.budget.maxEstimatedCost <= 0)) error("budget.maxEstimatedCost", "maxEstimatedCost must be positive and finite");
  if (config.budget?.maxWallTimeMs !== undefined && (!Number.isFinite(config.budget.maxWallTimeMs) || config.budget.maxWallTimeMs <= 0)) error("budget.maxWallTimeMs", "maxWallTimeMs must be positive and finite");

  const pointIds = new Set<string>();
  const perturbationIds = new Set<string>();
  for (const [index, point] of (config.faultPoints ?? []).entries()) {
    const prefix = `faultPoints[${index}]`;
    if (!point.id?.trim()) error(`${prefix}.id`, "fault point requires an id");
    else if (pointIds.has(point.id)) error(`${prefix}.id`, `duplicate fault point id '${point.id}'`);
    else pointIds.add(point.id);
    if (!point.target?.trim()) error(`${prefix}.target`, "fault point requires a target");
    if (!point.choices?.length) warn(`${prefix}.choices`, "fault point has no perturbations and will never be exercised");
    for (const [choiceIndex, choice] of (point.choices ?? []).entries()) {
      const choicePath = `${prefix}.choices[${choiceIndex}]`;
      if (!choice.id?.trim()) error(`${choicePath}.id`, "perturbation requires an id");
      else if (perturbationIds.has(choice.id)) error(`${choicePath}.id`, `duplicate perturbation id '${choice.id}'`);
      else perturbationIds.add(choice.id);
      if (!choice.target?.trim()) error(`${choicePath}.target`, "perturbation requires a target");
      if (!choice.kind?.trim()) error(`${choicePath}.kind`, "perturbation requires a semantic kind");
      if (!choice.description?.trim()) warn(`${choicePath}.description`, "perturbation should explain the behavior it models");
      if (choice.selector?.occurrence !== undefined && (!Number.isInteger(choice.selector.occurrence) || choice.selector.occurrence <= 0)) {
        error(`${choicePath}.selector.occurrence`, "occurrence must be a positive integer");
      }
    }
  }

  if (config.strategy === "incidents" && !config.incidents?.length) warn("incidents", "incidents strategy has no incident profiles");
  if (config.strategy === "guided" && !config.previousRuns?.length) warn("previousRuns", "guided strategy has no previous feedback and will behave mostly as novelty ordering");
  if (config.strategy === "coverage-guided" && !config.previousRuns?.length) warn("previousRuns", "coverage-guided strategy has no prior run feedback; the first plan will prioritize unseen faults/pairs only");
  if (config.strategy === "exhaustive" && (config.maxDepth ?? 1) > 3 && config.faultPoints.length > 8 && config.maxScenarios === undefined) {
    warn("maxScenarios", "deep exhaustive search over many fault points can grow combinatorially; set maxScenarios or use hybrid/pairwise/coverage-guided");
  }
  if ((config.concurrency ?? 1) > 1) warn("concurrency", "parallel scenarios must not share mutable harness/runtime state unless the execute() implementation isolates each scenario");

  return issues;
}

export function assertValidCloudFaultConfig(config: CloudFaultConfig): void {
  const issues = validateCloudFaultConfig(config);
  const errors = issues.filter((issue) => issue.severity === "error");
  if (!errors.length) return;
  throw new Error(`Invalid CloudFault config:\n${errors.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`);
}
