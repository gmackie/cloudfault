export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface CloudFaultWorkerConfig {
  configPath?: string | URL;
  /** Inline Wrangler config. Kept unknown so CloudFault does not pin Wrangler's config type. */
  config?: Record<string, unknown>;
  env?: string;
  vars?: Record<string, JsonValue>;
  secrets?: Record<string, string>;
  /** Test-only service binding overrides: binding name -> Worker name. */
  bindingOverrides?: Record<string, string>;
}

export interface CloudFaultHarnessConfig {
  workers: readonly CloudFaultWorkerConfig[];
  root?: string;
}

export interface WorkerHandle<Env = Record<string, unknown>, Export = unknown> {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  scheduled?(options?: { scheduledTime?: Date | number; cron?: string }): Promise<{ outcome: "ok" | "canceled" | "exception"; noRetry: boolean }>;
  getEnv(): Promise<Env>;
  getExport(): Promise<Export>;
  applyD1Migrations?(bindingName: string): Promise<void>;
  getDurableObjectStorage?(classNameOrBindingName: string, options?: Record<string, unknown>): Promise<unknown>;
  introspectWorkflow?(bindingName: string): Promise<unknown>;
  introspectWorkflowInstance?(bindingName: string, instanceId: string): Promise<unknown>;
}

export interface CloudFaultHarness {
  listen(): Promise<{ url: URL }>;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  getWorker<Env = Record<string, unknown>, Export = unknown>(name?: string): WorkerHandle<Env, Export>;
  update(options: CloudFaultHarnessConfig | ((current: CloudFaultHarnessConfig) => CloudFaultHarnessConfig)): Promise<void>;
  reset(): Promise<void>;
  debug(): void;
  close(): Promise<void>;
}

async function optionalImport(specifier: string): Promise<unknown> {
  // Keep wrangler optional for semantic-only consumers of this package.
  return Function("specifier", "return import(specifier)")(specifier) as Promise<unknown>;
}

/**
 * Thin wrapper over Wrangler's official createTestHarness(). CloudFault uses
 * bindingOverrides to route application bindings through controllable Nemesis
 * Workers instead of patching production application code.
 */
export async function createCloudFaultHarness(config: CloudFaultHarnessConfig): Promise<CloudFaultHarness> {
  let mod: unknown;
  try {
    mod = await optionalImport("wrangler");
  } catch (error) {
    throw new Error("createCloudFaultHarness() requires wrangler >= 4.106.0", { cause: error });
  }

  const createTestHarness = (mod as { createTestHarness?: (config: unknown) => unknown }).createTestHarness;
  if (typeof createTestHarness !== "function") {
    throw new Error("Installed wrangler does not export createTestHarness(); install a current Wrangler release");
  }

  return createTestHarness(config) as CloudFaultHarness;
}

/** Convenience lifecycle helper for scripts that do not use test-runner hooks. */
export async function startCloudFaultHarness(config: CloudFaultHarnessConfig): Promise<{
  harness: CloudFaultHarness;
  url: URL;
  close(): Promise<void>;
}> {
  const harness = await createCloudFaultHarness(config);
  const { url } = await harness.listen();
  return {
    harness,
    url,
    close: () => harness.close(),
  };
}
