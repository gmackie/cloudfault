import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { discoverWranglerTopology } from "@cloudfault/cloudflare";
import { detectAdaptersFromSource, mergeAdapterEvidence, recommendCloudFaultCoverage, recommendationMarkdown } from "@cloudfault/adapters";

const require = createRequire(import.meta.url);
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx"]);
const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".wrangler", ".cloudfault", "coverage"]);

export function sourceFiles(root) {
  const output = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) output.push(candidate);
    }
  };
  visit(root);
  return output;
}

export function findWrangler(root) {
  const names = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];
  for (const name of names) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function detectProject(root = process.cwd()) {
  const absolute = path.resolve(root);
  const wrangler = fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()
    ? absolute
    : findWrangler(absolute);
  const projectRoot = wrangler ? path.dirname(wrangler) : absolute;
  let topology;
  if (wrangler && !wrangler.endsWith(".toml")) topology = discoverWranglerTopology(fs.readFileSync(wrangler, "utf8"));

  const findings = [];
  for (const candidate of sourceFiles(projectRoot)) {
    let source;
    try { source = fs.readFileSync(candidate, "utf8"); } catch { continue; }
    for (const finding of detectAdaptersFromSource(source)) {
      findings.push({
        ...finding,
        evidence: finding.evidence.map((item) => `${path.relative(projectRoot, candidate)}:${item}`),
      });
    }
  }
  const adapters = mergeAdapterEvidence(findings);
  const recommendations = recommendCloudFaultCoverage(topology?.bindings ?? [], adapters);
  return { root: projectRoot, wrangler, topology, adapters, recommendations };
}

function resolvePackage(name) {
  try { return require.resolve(`${name}/package.json`); } catch {
    try { return require.resolve(name); } catch { return undefined; }
  }
}

function versionOf(name) {
  const resolved = resolvePackage(name);
  if (!resolved) return undefined;
  try {
    let current = resolved;
    while (current !== path.dirname(current)) {
      const candidate = path.join(current, "package.json");
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, "utf8")).version;
      current = path.dirname(current);
    }
  } catch { /* ignore */ }
  return "installed";
}

export function doctorProject(root = process.cwd()) {
  const project = detectProject(root);
  const major = Number(process.versions.node.split(".")[0]);
  const dependencies = ["wrangler", "msw", "fast-check"].map((name) => ({ name, version: versionOf(name) }));
  const checks = [
    { name: "Node.js >= 20", valid: major >= 20, detail: process.version },
    { name: "Wrangler configuration", valid: Boolean(project.wrangler), detail: project.wrangler ?? "not found" },
    { name: "Wrangler runtime", valid: Boolean(dependencies.find((item) => item.name === "wrangler")?.version), detail: dependencies.find((item) => item.name === "wrangler")?.version ?? "not installed" },
    { name: "MSW outbound interception", valid: Boolean(dependencies.find((item) => item.name === "msw")?.version), detail: dependencies.find((item) => item.name === "msw")?.version ?? "optional/not installed" },
    { name: "fast-check generation", valid: Boolean(dependencies.find((item) => item.name === "fast-check")?.version), detail: dependencies.find((item) => item.name === "fast-check")?.version ?? "optional/not installed" },
  ];
  const supportedBindingTypes = new Set(["kv", "d1", "r2", "queue-producer", "queue-consumer", "durable-object", "service", "workflow"]);
  const unsupported = (project.topology?.bindings ?? []).filter((binding) => !supportedBindingTypes.has(binding.type));
  return {
    project,
    checks,
    dependencies,
    unsupportedBindings: unsupported,
    valid: checks.filter((check) => check.name !== "MSW outbound interception" && check.name !== "fast-check generation").every((check) => check.valid),
  };
}

function pointExpression(binding) {
  const escaped = JSON.stringify(binding.binding);
  switch (binding.type) {
    case "kv":
      return `{ id: ${escaped}, target: ${escaped}, choices: [staleKvRead(${escaped}, { region: "remote", versionsBehind: 1 }), staleNegativeKvRead(${escaped}, "remote")] }`;
    case "d1":
      return `{ id: ${escaped}, target: ${escaped}, choices: [d1TransientNetworkError(${escaped}), d1OperationTimeout(${escaped}), d1CommitThenTimeout(${escaped})] }`;
    case "r2":
      return `{ id: ${escaped}, target: ${escaped}, choices: [r2CapacityError(${escaped}), r2CommitThenTimeout(${escaped})] }`;
    case "queue-producer":
    case "queue-consumer":
      return `{ id: ${escaped}, target: ${escaped}, choices: [duplicateQueueDelivery(${escaped}), rebatchQueueDelivery(${escaped}), queueConsumerFailure(${escaped})] }`;
    case "durable-object":
      return `{ id: ${escaped}, target: ${escaped}, choices: [duplicateAlarmDelivery(${escaped}), durableObjectReset(${escaped})] }`;
    case "service":
      return `{ id: ${escaped}, target: ${escaped}, choices: [serviceTimeout(${escaped}), serviceUnavailable(${escaped})] }`;
    case "workflow":
      return `{ id: ${escaped}, target: ${escaped}, choices: [workflowStepRetry(${escaped}), workflowRetryDelay(${escaped}, 2000)] }`;
    default:
      return undefined;
  }
}

export function generateStarterConfig(project) {
  const points = (project.topology?.bindings ?? []).map(pointExpression).filter(Boolean);
  const imports = [
    "staleKvRead", "staleNegativeKvRead",
    "d1TransientNetworkError", "d1OperationTimeout", "d1CommitThenTimeout",
    "r2CapacityError", "r2CommitThenTimeout",
    "duplicateQueueDelivery", "rebatchQueueDelivery", "queueConsumerFailure",
    "duplicateAlarmDelivery", "durableObjectReset",
    "serviceTimeout", "serviceUnavailable",
    "workflowStepRetry", "workflowRetryDelay",
  ];
  const adapterComments = project.adapters.length
    ? `\n// Detected external adapters: ${project.adapters.map((item) => item.adapter).join(", ")}\n// Run \`cloudfault inspect ${project.wrangler ? path.basename(project.wrangler) : "wrangler.jsonc"}\` for evidence and recommendations.\n`
    : "";
  return `import { defineCloudFault } from "@gmacko/cloudfault";\nimport {\n  ${imports.join(",\n  ")}\n} from "@gmacko/cloudfault/cloudflare";\n${adapterComments}\nexport const cloudfault = defineCloudFault({\n  name: ${JSON.stringify(project.topology?.name ?? "worker-correctness")},\n  // Hybrid runs depth-1 diagnostics first, then curated incidents/pairwise\n  // coverage and feedback-guided candidates without immediately exploding the\n  // full Cartesian product. Use \`cloudfault plan cloudfault.config.mjs\` to inspect it.\n  strategy: "hybrid",\n  maxDepth: 2,\n  maxScenarios: 100,\n  cache: "file",\n  faultPoints: [\n${points.map((item) => `    ${item},`).join("\n")}\n  ],\n\n  async execute(scenario) {\n    // Start createTestHarness()/Miniflare/Workers Vitest as appropriate, apply\n    // scenario perturbations, run a production-shaped workload, inspect\n    // privileged state, and return { scenario, history, checks, state }.\n    throw new Error("Implement execute(scenario)");\n  },\n});\n`;
}

export function initProject(target = process.cwd()) {
  const targetPath = path.resolve(target);
  const stat = fs.statSync(targetPath, { throwIfNoEntry: false });
  const root = stat?.isFile() ? path.dirname(targetPath) : targetPath;
  const project = detectProject(root);
  const configPath = path.join(root, "cloudfault.config.mjs");
  if (fs.existsSync(configPath)) throw new Error(`${configPath} already exists`);
  fs.writeFileSync(configPath, generateStarterConfig(project));
  const recommendationDir = path.join(root, ".cloudfault");
  fs.mkdirSync(recommendationDir, { recursive: true });
  fs.writeFileSync(path.join(recommendationDir, "recommendations.md"), `# CloudFault recommendations\n\n${recommendationMarkdown(project.recommendations)}\n`);
  return { configPath, recommendationPath: path.join(recommendationDir, "recommendations.md"), project };
}
