import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunResult, Scenario } from "./types.js";

export interface ScenarioCacheKeyOptions {
  testName?: string;
  workloadFingerprint?: string;
  environmentFingerprint?: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function scenarioFingerprint(
  scenario: Scenario,
  options: ScenarioCacheKeyOptions = {},
): string {
  const canonical = JSON.stringify(stableValue({
    testName: options.testName,
    workload: options.workloadFingerprint,
    environment: options.environmentFingerprint,
    seed: scenario.seed,
    perturbations: scenario.perturbations.map((item) => ({
      id: item.id,
      target: item.target,
      operation: item.operation,
      kind: item.kind,
      selector: item.selector,
      metadata: item.metadata,
    })),
  }));
  return createHash("sha256").update(canonical).digest("hex");
}

export interface ScenarioCache<State = unknown> {
  get(key: string): Promise<RunResult<State> | undefined>;
  set(key: string, result: RunResult<State>): Promise<void>;
  delete?(key: string): Promise<void>;
  clear?(): Promise<void>;
}

export class MemoryScenarioCache<State = unknown> implements ScenarioCache<State> {
  readonly #entries = new Map<string, RunResult<State>>();

  async get(key: string): Promise<RunResult<State> | undefined> {
    return this.#entries.get(key);
  }

  async set(key: string, result: RunResult<State>): Promise<void> {
    this.#entries.set(key, result);
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async clear(): Promise<void> {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

interface FileCacheDocument<State> {
  schema: "cloudfault.scenario-cache";
  version: 1;
  entries: Record<string, RunResult<State>>;
}

/**
 * Small JSON-backed cache intended for developer machines and CI workspaces.
 * It deliberately stores portable RunResults rather than runtime handles.
 */
export class FileScenarioCache<State = unknown> implements ScenarioCache<State> {
  readonly #file: string;
  #loaded = false;
  #entries = new Map<string, RunResult<State>>();

  constructor(file = path.join(".cloudfault", "scenario-cache.json")) {
    this.#file = file;
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const document = JSON.parse(await readFile(this.#file, "utf8")) as FileCacheDocument<State>;
      if (document.schema !== "cloudfault.scenario-cache" || document.version !== 1) return;
      this.#entries = new Map(Object.entries(document.entries));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }

  async #flush(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const document: FileCacheDocument<State> = {
      schema: "cloudfault.scenario-cache",
      version: 1,
      entries: Object.fromEntries(this.#entries),
    };
    await writeFile(this.#file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }

  async get(key: string): Promise<RunResult<State> | undefined> {
    await this.#load();
    return this.#entries.get(key);
  }

  async set(key: string, result: RunResult<State>): Promise<void> {
    await this.#load();
    this.#entries.set(key, result);
    await this.#flush();
  }

  async delete(key: string): Promise<void> {
    await this.#load();
    this.#entries.delete(key);
    await this.#flush();
  }

  async clear(): Promise<void> {
    await this.#load();
    this.#entries.clear();
    await this.#flush();
  }
}

export interface CachedExecutorOptions extends ScenarioCacheKeyOptions {
  cache: ScenarioCache;
  bypass?: boolean;
}

export function withScenarioCache<State>(
  execute: (scenario: Scenario) => Promise<RunResult<State>>,
  options: CachedExecutorOptions,
): (scenario: Scenario) => Promise<RunResult<State>> {
  return async (scenario) => {
    if (options.bypass) return execute(scenario);
    const key = scenarioFingerprint(scenario, options);
    const cached = await options.cache.get(key) as RunResult<State> | undefined;
    if (cached) return cached;
    const result = await execute(scenario);
    await options.cache.set(key, result);
    return result;
  };
}
