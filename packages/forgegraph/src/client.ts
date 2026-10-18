import type { ForgeGraphTestRunEvidence } from "./evidence.js";

export interface ForgeGraphClientOptions {
  /** e.g. https://forgegraf.com */
  server: string;
  token: string;
  fetch?: typeof fetch;
  userAgent?: string;
}

export interface ForgeGraphApp {
  id: string;
  slug: string;
  name?: string;
  deploymentPlatform?: string | null;
  repositoryId?: string | null;
  repositoryOwner?: string | null;
  repositoryName?: string | null;
  repositoryDefaultBranch?: string | null;
}

export interface ForgeGraphChangesetSummary {
  id: string;
  title: string;
  status: string;
  createdAt: string;
}

export interface ForgeGraphChangeset extends ForgeGraphChangesetSummary {
  headSha?: string | null;
}

export type ExecutionEnvironment = "staging" | "prod_canary" | "prod_main";
export type ExecutionMode = "auto" | "manual" | "approval_gated";

export interface ExecutionPolicy {
  environment: ExecutionEnvironment;
  executionMode: ExecutionMode;
}

export const EXECUTION_ENVIRONMENTS: readonly ExecutionEnvironment[] = ["staging", "prod_canary", "prod_main"];

export interface DispatchExposure {
  /** True when posting a terminal test run cannot create a deployment or an approval request. */
  safe: boolean;
  policies: readonly ExecutionPolicy[];
  reasons: readonly string[];
}

/**
 * Whether a terminal test run on this repository's changesets can trigger
 * delivery. ForgeGraph re-evaluates every non-manual lane whenever passed or
 * failed evidence lands: `auto` lanes may create an execution request and
 * `approval_gated` lanes open an approval intervention.
 */
export function dispatchExposure(policies: readonly ExecutionPolicy[]): DispatchExposure {
  const reasons = policies
    .filter((policy) => policy.executionMode !== "manual")
    .map((policy) => `${policy.environment} is ${policy.executionMode}`);
  return { safe: reasons.length === 0, policies, reasons };
}

export class ForgeGraphError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
    this.name = "ForgeGraphError";
  }
}

export class ForgeGraphClient {
  readonly server: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #userAgent: string;

  constructor(options: ForgeGraphClientOptions) {
    if (!options.server) throw new Error("ForgeGraph server URL is required");
    if (!options.token) throw new Error("ForgeGraph token is required");
    this.server = options.server.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#userAgent = options.userAgent ?? "cloudfault";
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${this.server}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        "user-agent": this.#userAgent,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new ForgeGraphError(`${method} ${path} -> ${response.status}`, response.status, text.slice(0, 500));
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async apps(): Promise<readonly ForgeGraphApp[]> {
    const body = await this.#request<ForgeGraphApp[] | { apps: ForgeGraphApp[] }>("GET", "/api/fg/apps");
    return Array.isArray(body) ? body : body.apps;
  }

  app(slug: string): Promise<ForgeGraphApp> {
    return this.#request("GET", `/api/fg/apps/${encodeURIComponent(slug)}`);
  }

  async changesets(appSlug: string): Promise<readonly ForgeGraphChangesetSummary[]> {
    const body = await this.#request<{ changesets: ForgeGraphChangesetSummary[] }>("GET", `/api/fg/changesets?app=${encodeURIComponent(appSlug)}`);
    return body.changesets;
  }

  changeset(id: string): Promise<ForgeGraphChangeset> {
    return this.#request("GET", `/api/fg/changesets/${encodeURIComponent(id)}`);
  }

  /**
   * The changeset whose head is exactly `sha`. ForgeGraph lists changesets
   * without their SHAs, so this checks the newest `lookback` of them, trying
   * the ones titled with the short SHA (push-to-main changesets) first.
   */
  async changesetForSha(appSlug: string, sha: string, options: { lookback?: number } = {}): Promise<ForgeGraphChangeset | undefined> {
    const lookback = options.lookback ?? 25;
    const recent = [...await this.changesets(appSlug)]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, lookback);
    const short = sha.slice(0, 8);
    const ordered = [...recent.filter((item) => item.title === short), ...recent.filter((item) => item.title !== short)];
    for (const candidate of ordered) {
      const detail = await this.changeset(candidate.id);
      if (detail.headSha === sha) return detail;
    }
    return undefined;
  }

  async executionPolicies(repositoryId: string): Promise<readonly ExecutionPolicy[]> {
    const policies: ExecutionPolicy[] = [];
    for (const environment of EXECUTION_ENVIRONMENTS) {
      const input = encodeURIComponent(JSON.stringify({ json: { repositoryId, environment } }));
      const body = await this.#request<{ result: { data: { json: ExecutionPolicy | null } } }>("GET", `/api/trpc/executionPolicy.get?input=${input}`);
      const policy = body.result.data.json;
      if (policy) policies.push({ environment: policy.environment, executionMode: policy.executionMode });
    }
    return policies;
  }

  pushTestRun(evidence: ForgeGraphTestRunEvidence): Promise<{ testRunId?: string; status: string }> {
    return this.#request("POST", "/api/evidence", evidence);
  }
}
