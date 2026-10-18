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

const WRANGLER_NAMES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];
// Test and fixture trees routinely carry throwaway Wrangler configs that are
// not deployed Workers, so repository-wide discovery does not descend into them.
const FIXTURE_DIRECTORIES = new Set(["test", "tests", "__tests__", "fixtures", "__fixtures__"]);

export function findWrangler(root) {
  for (const name of WRANGLER_NAMES) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Every Worker in a repository: at most one Wrangler config per directory, in findWrangler order. */
export function findWranglers(root) {
  const output = [];
  const visit = (directory) => {
    const config = findWrangler(directory);
    if (config) output.push(config);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || IGNORED.has(entry.name) || FIXTURE_DIRECTORIES.has(entry.name)) continue;
      visit(path.join(directory, entry.name));
    }
  };
  visit(path.resolve(root));
  return output;
}

/**
 * Reads a Wrangler config into its raw object form. JSON/JSONC needs nothing
 * extra; TOML is read through Wrangler itself (an optional peer dependency),
 * so it returns undefined when Wrangler is not installed.
 */
export function readWranglerConfig(file) {
  if (!file.endsWith(".toml")) return discoverWranglerTopology(fs.readFileSync(file, "utf8"));
  let wrangler;
  try { wrangler = require("wrangler"); } catch { return undefined; }
  return discoverWranglerTopology(wrangler.experimental_readRawConfig({ config: file }).rawConfig);
}

function detectAdapters(root) {
  const findings = [];
  for (const candidate of sourceFiles(root)) {
    let source;
    try { source = fs.readFileSync(candidate, "utf8"); } catch { continue; }
    for (const finding of detectAdaptersFromSource(source)) {
      findings.push({
        ...finding,
        evidence: finding.evidence.map((item) => `${path.relative(root, candidate)}:${item}`),
      });
    }
  }
  return mergeAdapterEvidence(findings);
}

export function detectProject(root = process.cwd()) {
  const absolute = path.resolve(root);
  const wrangler = fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()
    ? absolute
    : findWrangler(absolute);
  const projectRoot = wrangler ? path.dirname(wrangler) : absolute;
  const topology = wrangler ? readWranglerConfig(wrangler) : undefined;

  const adapters = detectAdapters(projectRoot);
  const recommendations = recommendCloudFaultCoverage(topology?.bindings ?? [], adapters);
  return { root: projectRoot, wrangler, topology, adapters, recommendations };
}

/**
 * Every Worker in a repository (monorepos included), each with its topology
 * and the provider adapters detected beneath its directory. A TOML config that
 * cannot be read without Wrangler is kept, with `topology` undefined.
 */
export function inspectRepository(root = process.cwd()) {
  const absolute = path.resolve(root);
  return findWranglers(absolute).map((wrangler) => {
    const directory = path.dirname(wrangler);
    const topology = readWranglerConfig(wrangler);
    return {
      config: path.relative(absolute, wrangler),
      directory,
      wrangler,
      topology,
      adapters: detectAdapters(directory),
    };
  });
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
  const supportedBindingTypes = new Set(Object.keys(STARTER_FAULTS));
  const unsupported = (project.topology?.bindings ?? []).filter((binding) => !supportedBindingTypes.has(binding.type));
  return {
    project,
    checks,
    dependencies,
    unsupportedBindings: unsupported,
    valid: checks.filter((check) => check.name !== "MSW outbound interception" && check.name !== "fast-check generation").every((check) => check.valid),
  };
}

// The starter fault set per binding type: [constructor, ...arguments after the binding name].
// Both the generated config and in-process baseline planning read this one table.
const QUEUE_FAULTS = [["duplicateQueueDelivery"], ["rebatchQueueDelivery"], ["queueConsumerFailure"]];
const STARTER_FAULTS = {
  kv: [["staleKvRead", { region: "remote", versionsBehind: 1 }], ["staleNegativeKvRead", "remote"]],
  d1: [["d1TransientNetworkError"], ["d1OperationTimeout"], ["d1CommitThenTimeout"]],
  r2: [["r2CapacityError"], ["r2CommitThenTimeout"]],
  "queue-producer": QUEUE_FAULTS,
  "queue-consumer": QUEUE_FAULTS,
  "durable-object": [["duplicateAlarmDelivery"], ["durableObjectReset"]],
  service: [["serviceTimeout"], ["serviceUnavailable"]],
  workflow: [["workflowStepRetry"], ["workflowRetryDelay", 2000]],
};
export const STARTER_BINDING_TYPES = Object.keys(STARTER_FAULTS);
const STARTER_IMPORTS = [...new Set(Object.values(STARTER_FAULTS).flat().map(([name]) => name))];

function literal(value) {
  if (value && typeof value === "object") return `{ ${Object.entries(value).map(([key, item]) => `${key}: ${literal(item)}`).join(", ")} }`;
  return JSON.stringify(value);
}

function pointExpression(binding) {
  const faults = STARTER_FAULTS[binding.type];
  if (!faults) return undefined;
  const escaped = JSON.stringify(binding.binding);
  const choices = faults.map(([name, ...extra]) => `${name}(${[escaped, ...extra.map(literal)].join(", ")})`);
  return `{ id: ${escaped}, target: ${escaped}, choices: [${choices.join(", ")}] }`;
}

/**
 * The starter config's fault points, built in-process. `cloudflare` is the
 * @cloudfault/cloudflare module; `prefix` keeps IDs unique across Workers.
 */
export function starterFaultPoints(bindings, cloudflare, prefix = "") {
  return bindings.flatMap((binding) => {
    const faults = STARTER_FAULTS[binding.type];
    if (!faults) return [];
    return [{
      id: `${prefix}${binding.binding}`,
      target: binding.binding,
      choices: faults.map(([name, ...extra]) => cloudflare[name](binding.binding, ...extra)),
    }];
  });
}

export function generateStarterConfig(project) {
  const points = (project.topology?.bindings ?? []).map(pointExpression).filter(Boolean);
  const imports = STARTER_IMPORTS;
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
