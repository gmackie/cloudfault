import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { importModule, safeFilePart, toPlain } from "./run.mjs";

const core = () => import("@cloudfault/core");

// Outside .cloudfault/ (run output, usually gitignored): the corpus is meant to be committed.
export const DEFAULT_REGRESSION_DIRECTORY = "cloudfault-regressions";

function failureSet(artifact) {
  return artifact.minimalFailureSet ?? artifact.scenario.perturbations;
}

/** Stable per (test, minimal failure set): re-pinning the same bug overwrites. */
export function pinFileName(artifact, name = artifact.testName) {
  const ids = failureSet(artifact).map((item) => item.id).sort();
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify([artifact.testName, ids])).digest("hex").slice(0, 10);
  return `${safeFilePart(name)}-${fingerprint}.json`;
}

/**
 * Copies a failure artifact into the regression corpus. A replay module that
 * is a file is rewritten relative to the corpus directory so committed pins
 * replay from any working directory.
 */
export async function pinFailure(artifactFile, { directory = DEFAULT_REGRESSION_DIRECTORY, name, cwd = process.cwd() } = {}) {
  const { parseFailureArtifact } = await core();
  const source = path.resolve(cwd, artifactFile);
  const artifact = parseFailureArtifact(fs.readFileSync(source, "utf8"));
  if (!artifact.replay?.module) throw new Error(`${artifactFile} has no replay.module, so it cannot be replayed as a regression`);
  const corpus = path.resolve(cwd, directory);
  let module = artifact.replay.module;
  const moduleFile = module.startsWith("file:") ? new URL(module).pathname : path.resolve(cwd, module);
  if (fs.existsSync(moduleFile)) {
    const relative = path.relative(corpus, moduleFile).split(path.sep).join("/");
    module = relative.startsWith(".") ? relative : `./${relative}`;
  }
  const pinned = {
    ...artifact,
    replay: { ...artifact.replay, module },
    metadata: { ...artifact.metadata, pinnedAt: new Date().toISOString(), pinnedFrom: path.basename(source) },
  };
  fs.mkdirSync(corpus, { recursive: true });
  const file = path.join(corpus, pinFileName(artifact, name));
  const existed = fs.existsSync(file);
  fs.writeFileSync(file, `${JSON.stringify(pinned, null, 2)}\n`);
  return { file, artifact: pinned, replaced: existed };
}

export function listPins(directory = DEFAULT_REGRESSION_DIRECTORY, cwd = process.cwd()) {
  const corpus = path.resolve(cwd, directory);
  if (!fs.existsSync(corpus)) return [];
  return fs.readdirSync(corpus).filter((file) => file.endsWith(".json")).sort().map((file) => path.join(corpus, file));
}

/**
 * Re-executes an artifact's minimal failure set. Uses the replay module's
 * named export, falling back to its config's execute() (generated configs
 * have no runScenario export). `bases` are tried in order to resolve a
 * relative module.
 */
export async function replayArtifact(artifact, { bases = [process.cwd()] } = {}) {
  const { checksFailed } = await core();
  if (!artifact.replay?.module) throw new Error("Artifact has no replay.module; execution cannot be repeated");
  const mod = await importModule(artifact.replay.module, bases);
  const exportName = artifact.replay.exportName ?? "runScenario";
  const execute = typeof mod[exportName] === "function" ? mod[exportName] : (mod.cloudfault ?? mod.default)?.execute;
  if (typeof execute !== "function") throw new Error(`Replay module ${artifact.replay.module} exports neither ${exportName}() nor a config with execute()`);
  const perturbations = failureSet(artifact);
  const scenario = {
    ...artifact.scenario,
    id: perturbations.length ? perturbations.map((item) => item.id).join("+") : "baseline",
    perturbations,
  };
  const result = await execute(scenario, artifact.replay.args);
  const run = { ...result, state: toPlain(result.state), history: toPlain(result.history) ?? [], checks: toPlain(result.checks) ?? [] };
  return { run, reproduced: checksFailed(run.checks) };
}

/**
 * Replays every pinned regression. A pin that still fails is `reproduced`
 * (the bug is back, or was never fixed); one that passes is `resolved`.
 */
export async function replayPins(directory = DEFAULT_REGRESSION_DIRECTORY, { cwd = process.cwd(), onResult } = {}) {
  const { parseFailureArtifact } = await core();
  const records = [];
  for (const file of listPins(directory, cwd)) {
    const started = performance.now();
    let record;
    try {
      const artifact = parseFailureArtifact(fs.readFileSync(file, "utf8"));
      const { run, reproduced } = await replayArtifact(artifact, { bases: [path.dirname(file), cwd] });
      record = { kind: "pin", name: artifact.testName, file, artifact, run, status: reproduced ? "reproduced" : "resolved" };
    } catch (error) {
      record = { kind: "pin", name: path.basename(file, ".json"), file, status: "error", error };
    }
    record.durationMs = performance.now() - started;
    records.push(record);
    onResult?.(record);
  }
  return records;
}
