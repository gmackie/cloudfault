import {
  askOracle,
  mintOperationToken,
  OPERATION_TOKEN_HEADER,
  outcomeMetadata,
  ScenarioController,
  type ActualOutcome,
  type Fault,
  type FaultPhase,
  type ObservedOutcome,
  type OperationRef,
  type OperationToken,
  type OutcomeOracle,
  type Perturbation,
} from "@cloudfault/core";

export type OperationEffect = "query" | "mutation" | "external-side-effect" | "async-side-effect";
export type RetrySafety = "safe" | "unsafe" | "conditional" | "unknown";

export interface SemanticOperation {
  name: string;
  effect: OperationEffect;
  resource?: string;
  retry: RetrySafety;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface RequestMatch {
  operation: SemanticOperation;
  params?: Record<string, string>;
}

export interface AdapterManifest {
  name: string;
  provider: string;
  version?: string;
  /** Human-readable contract/API version the semantics were authored against. */
  contractVersion?: string;
  unofficial?: boolean;
  /** Exact hosts or leading-wildcard patterns such as *.amazonaws.com. */
  hosts: readonly string[];
  capabilities: readonly string[];
}

export interface AdapterExecutionContext {
  request: Request;
  operation: SemanticOperation;
  perturbation?: Perturbation;
  upstream: () => Promise<Response>;
  controller: ScenarioController;
  operationRef: OperationRef;
}

export interface SemanticAdapter {
  manifest: AdapterManifest;
  match(request: Request): RequestMatch | null;
  faultSpace(operation: SemanticOperation, request?: Request): readonly Perturbation[];
  /** Optional provider-specific execution hook. Generic faults work without it. */
  execute?(context: AdapterExecutionContext): Promise<Response>;
}

export function defineAdapter(adapter: SemanticAdapter): SemanticAdapter {
  return adapter;
}

export function matchesHost(pattern: string, hostname: string): boolean {
  const normalizedPattern = pattern.toLowerCase();
  const normalizedHost = hostname.toLowerCase();
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
  }
  return normalizedHost === normalizedPattern;
}

export function matchesAnyHost(patterns: readonly string[], hostname: string): boolean {
  return patterns.some((pattern) => matchesHost(pattern, hostname));
}


export interface FaultOptions {
  id: string;
  target: string;
  operation?: string;
  description?: string;
  phase?: FaultPhase;
  actualOutcome?: ActualOutcome;
  observedOutcome?: ObservedOutcome;
  category?: Fault["category"];
  selector?: Fault["selector"];
  metadata?: Record<string, unknown>;
}

export function fault(kind: string, options: FaultOptions): Fault {
  return {
    id: options.id,
    target: options.target,
    operation: options.operation,
    kind,
    phase: options.phase ?? "before-commit",
    description: options.description ?? `${options.target}: ${kind}`,
    category: options.category ?? "provider",
    selector: options.selector,
    actualOutcome: options.actualOutcome,
    observedOutcome: options.observedOutcome,
    metadata: options.metadata,
  };
}

export function rejectBeforeCommit(options: Omit<FaultOptions, "phase" | "actualOutcome" | "observedOutcome">): Fault {
  return fault("reject-before-commit", {
    ...options,
    phase: "before-commit",
    actualOutcome: "not-committed",
    observedOutcome: "definite-failure",
  });
}

export function timeoutBeforeSend(options: Omit<FaultOptions, "phase" | "actualOutcome" | "observedOutcome">): Fault {
  return fault("timeout-before-send", {
    ...options,
    phase: "before-send",
    actualOutcome: "not-committed",
    observedOutcome: "definite-failure",
  });
}

export function commitThenTimeout(options: Omit<FaultOptions, "phase" | "actualOutcome" | "observedOutcome">): Fault {
  return fault("commit-then-timeout", {
    ...options,
    phase: "after-commit-before-response",
    actualOutcome: "committed",
    observedOutcome: "indeterminate",
  });
}

export function commitThenDisconnect(options: Omit<FaultOptions, "phase" | "actualOutcome" | "observedOutcome">): Fault {
  return fault("commit-then-disconnect", {
    ...options,
    phase: "during-response",
    actualOutcome: "committed",
    observedOutcome: "indeterminate",
  });
}

export function rateLimit(
  options: Omit<FaultOptions, "phase" | "actualOutcome" | "observedOutcome"> & { retryAfterSeconds?: number },
): Fault {
  return fault("rate-limit", {
    ...options,
    phase: "before-commit",
    actualOutcome: "not-committed",
    observedOutcome: "definite-failure",
    metadata: {
      ...options.metadata,
      status: 429,
      retryAfterSeconds: options.retryAfterSeconds,
    },
  });
}

export function httpError(
  options: Omit<FaultOptions, "phase" | "actualOutcome" | "observedOutcome"> & { status: number; body?: string },
): Fault {
  return fault("http-error", {
    ...options,
    phase: "before-commit",
    actualOutcome: "not-committed",
    observedOutcome: "definite-failure",
    metadata: { ...options.metadata, status: options.status, body: options.body },
  });
}

export function latency(
  options: Omit<FaultOptions, "phase" | "actualOutcome" | "observedOutcome"> & { delayMs: number },
): Fault {
  return fault("latency", {
    ...options,
    phase: "before-send",
    actualOutcome: "unknown",
    observedOutcome: "indeterminate",
    metadata: { ...options.metadata, delayMs: options.delayMs },
  });
}

export function malformedJson(options: Omit<FaultOptions, "phase" | "actualOutcome" | "observedOutcome">): Fault {
  return fault("malformed-json", {
    ...options,
    phase: "during-response",
    // The provider-specific operation decides whether the upstream response
    // implies a durable commit. Generic malformed JSON alone cannot.
    actualOutcome: "unknown",
    observedOutcome: "indeterminate",
  });
}


export type RuleValue<T> = T | ((request: Request, match: RegExpMatchArray | null) => T);

export interface AdapterRule {
  methods?: readonly string[];
  path: RegExp | string;
  name: RuleValue<string>;
  effect: RuleValue<OperationEffect>;
  retry?: RuleValue<RetrySafety>;
  resource?: (request: Request, match: RegExpMatchArray | null) => string | undefined;
  idempotencyHeader?: string;
  metadata?: (request: Request, match: RegExpMatchArray | null) => Record<string, unknown>;
}

export interface RulesAdapterOptions {
  manifest: AdapterManifest;
  rules: readonly AdapterRule[];
  fallback?: {
    queryName?: string;
    mutationName?: string;
    mutationEffect?: OperationEffect;
    idempotencyHeader?: string;
  };
  faults?: (operation: SemanticOperation, request?: Request) => readonly Perturbation[];
}

function ruleValue<T>(value: RuleValue<T>, request: Request, match: RegExpMatchArray | null): T {
  return typeof value === "function"
    ? (value as (request: Request, match: RegExpMatchArray | null) => T)(request, match)
    : value;
}

function matchRulePath(rule: AdapterRule, pathname: string): RegExpMatchArray | null | false {
  if (typeof rule.path === "string") return rule.path === pathname ? null : false;
  const match = pathname.match(rule.path);
  return match ?? false;
}

/**
 * Declarative adapter builder for community/provider packs. It deliberately
 * models semantic operations, not full provider schemas, so a useful adapter
 * can be authored without reimplementing an API server.
 */
export function defineRulesAdapter(options: RulesAdapterOptions): SemanticAdapter {
  const manifest = options.manifest;
  return defineAdapter({
    manifest,
    match(request) {
      const url = new URL(request.url);
      if (!matchesAnyHost(manifest.hosts, url.hostname)) return null;
      const method = request.method.toUpperCase();

      for (const rule of options.rules) {
        if (rule.methods && !rule.methods.some((candidate) => candidate.toUpperCase() === method)) continue;
        const pathMatch = matchRulePath(rule, url.pathname);
        if (pathMatch === false) continue;
        const idempotencyHeader = rule.idempotencyHeader;
        const idempotencyKey = idempotencyHeader ? request.headers.get(idempotencyHeader) ?? undefined : undefined;
        return {
          operation: {
            name: ruleValue(rule.name, request, pathMatch),
            effect: ruleValue(rule.effect, request, pathMatch),
            retry: rule.retry ? ruleValue(rule.retry, request, pathMatch) : method === "GET" || method === "HEAD" ? "safe" : idempotencyKey ? "conditional" : "unknown",
            idempotencyKey,
            resource: rule.resource?.(request, pathMatch),
            metadata: {
              method,
              path: url.pathname,
              ...rule.metadata?.(request, pathMatch),
            },
          },
        };
      }

      const fallback = options.fallback;
      if (!fallback) return null;
      const query = method === "GET" || method === "HEAD" || method === "OPTIONS";
      const key = fallback.idempotencyHeader ? request.headers.get(fallback.idempotencyHeader) ?? undefined : undefined;
      return {
        operation: {
          name: query ? fallback.queryName ?? `${manifest.name}.query` : fallback.mutationName ?? `${manifest.name}.mutation`,
          effect: query ? "query" : fallback.mutationEffect ?? "mutation",
          retry: query ? "safe" : key ? "conditional" : "unknown",
          idempotencyKey: key,
          metadata: { method, path: url.pathname },
        },
      };
    },
    faultSpace(operation, request) {
      if (options.faults) return options.faults(operation, request);
      const faults: Perturbation[] = [
        rateLimit({
          id: `${manifest.name}:${operation.name}:rate-limit`,
          target: manifest.name,
          operation: operation.name,
          retryAfterSeconds: 2,
        }),
        httpError({
          id: `${manifest.name}:${operation.name}:unavailable`,
          target: manifest.name,
          operation: operation.name,
          status: 503,
          body: "CloudFault injected provider unavailability",
        }),
      ];
      if (operation.effect !== "query") {
        faults.push(
          commitThenTimeout({
            id: `${manifest.name}:${operation.name}:commit-timeout`,
            target: manifest.name,
            operation: operation.name,
          }),
          commitThenDisconnect({
            id: `${manifest.name}:${operation.name}:commit-disconnect`,
            target: manifest.name,
            operation: operation.name,
          }),
        );
      }
      return faults;
    },
  });
}

/** Error thrown to the caller when the provider may have committed. */
export class CloudFaultIndeterminateError extends Error {
  readonly perturbation: Perturbation;
  readonly operation: OperationRef;

  constructor(message: string, perturbation: Perturbation, operation: OperationRef, options?: ErrorOptions) {
    super(message, options);
    this.name = "CloudFaultIndeterminateError";
    this.perturbation = perturbation;
    this.operation = operation;
  }
}

export class CloudFaultInjectedError extends Error {
  readonly perturbation: Perturbation;

  constructor(message: string, perturbation: Perturbation, options?: ErrorOptions) {
    super(message, options);
    this.name = "CloudFaultInjectedError";
    this.perturbation = perturbation;
  }
}

export interface AdapterPlugin {
  name: string;
  version?: string;
  adapters: readonly SemanticAdapter[];
}

export function defineAdapterPlugin(plugin: AdapterPlugin): AdapterPlugin {
  return plugin;
}

export interface AdapterPluginModule {
  default?: SemanticAdapter | AdapterPlugin;
  adapter?: SemanticAdapter;
  adapters?: readonly SemanticAdapter[];
  plugin?: AdapterPlugin;
}

function isSemanticAdapter(value: unknown): value is SemanticAdapter {
  return Boolean(value && typeof value === "object" && "manifest" in value && "match" in value && "faultSpace" in value);
}

function isAdapterPlugin(value: unknown): value is AdapterPlugin {
  return Boolean(value && typeof value === "object" && "name" in value && Array.isArray((value as AdapterPlugin).adapters));
}

export function adaptersFromPluginModule(module: AdapterPluginModule): readonly SemanticAdapter[] {
  if (module.plugin) return module.plugin.adapters;
  if (module.adapters) return module.adapters;
  if (module.adapter) return [module.adapter];
  if (isAdapterPlugin(module.default)) return module.default.adapters;
  if (isSemanticAdapter(module.default)) return [module.default];
  throw new Error("CloudFault adapter plugin module must export adapter, adapters, plugin, or a compatible default export");
}

export async function loadAdapterPlugin(specifier: string): Promise<readonly SemanticAdapter[]> {
  const module = await Function("specifier", "return import(specifier)")(specifier) as AdapterPluginModule;
  return adaptersFromPluginModule(module);
}

export class AdapterRegistry {
  readonly #adapters = new Map<string, SemanticAdapter>();

  register(adapter: SemanticAdapter): this {
    if (this.#adapters.has(adapter.manifest.name)) {
      throw new Error(`Adapter '${adapter.manifest.name}' is already registered`);
    }
    this.#adapters.set(adapter.manifest.name, adapter);
    return this;
  }

  registerAll(adapters: readonly SemanticAdapter[]): this {
    for (const adapter of adapters) this.register(adapter);
    return this;
  }

  registerPlugin(plugin: AdapterPlugin): this {
    return this.registerAll(plugin.adapters);
  }

  async loadPlugin(specifier: string): Promise<this> {
    return this.registerAll(await loadAdapterPlugin(specifier));
  }

  get(name: string): SemanticAdapter | undefined {
    return this.#adapters.get(name);
  }

  list(): readonly AdapterManifest[] {
    return [...this.#adapters.values()].map((adapter) => adapter.manifest);
  }

  classify(request: Request): { adapter: SemanticAdapter; match: RequestMatch } | null {
    for (const adapter of this.#adapters.values()) {
      const match = adapter.match(request);
      if (match) return { adapter, match };
    }
    return null;
  }

  hosts(): readonly string[] {
    return [...new Set([...this.#adapters.values()].flatMap((adapter) => adapter.manifest.hosts))];
  }
}

export interface AdapterRuntimeOptions {
  registry: AdapterRegistry;
  controller: ScenarioController;
  upstream: (request: Request) => Promise<Response>;
  process?: string | number | ((request: Request, operation: SemanticOperation) => string | number);
  parentId?: string;
  /**
   * A privileged backend that can be *asked* what actually happened.
   *
   * Without one, `actual` is whatever the fault declares (sound only where
   * CloudFault chose the moment of failure), or a deduction from the upstream
   * status, or `unknown`. With one, it is the backend's own answer and the
   * history says so via `actualSource: "oracle"`.
   */
  oracle?: OutcomeOracle;
  /**
   * Mints the correlation token sent with each classified request. Defaults to
   * minting one whenever an oracle is configured; return `undefined` to skip
   * the oracle for a particular operation.
   *
   * The token is minted *before* the request is sent. That is the whole point:
   * under commit-then-response-lost there is no response to read a correlation
   * id off, so only a caller-minted token can still be asked about.
   */
  mintToken?: (request: Request, operation: SemanticOperation) => OperationToken | undefined;
  /** Header the token travels on. Defaults to `x-emulate-operation`. */
  tokenHeader?: string;
}

function responseFromFault(faultValue: Fault): Response | undefined {
  if (faultValue.kind === "rate-limit") {
    const retryAfter = faultValue.metadata?.retryAfterSeconds;
    const headers = new Headers();
    if (typeof retryAfter === "number") headers.set("retry-after", String(retryAfter));
    return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "CloudFault injected rate limit" } }), {
      status: 429,
      headers: { ...Object.fromEntries(headers), "content-type": "application/json" },
    });
  }
  if (faultValue.kind === "http-error" || faultValue.kind === "reject-before-commit") {
    const status = typeof faultValue.metadata?.status === "number" ? faultValue.metadata.status : 503;
    const body = typeof faultValue.metadata?.body === "string" ? faultValue.metadata.body : "CloudFault injected provider failure";
    return new Response(body, { status });
  }
  return undefined;
}

/** Clone a Request with one extra header, preserving method/body/credentials. */
function withHeader(request: Request, name: string, value: string): Request {
  const headers = new Headers(request.headers);
  headers.set(name, value);
  return new Request(request, { headers });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Provider-neutral semantic runtime. It classifies a Request, assigns a stable
 * logical operation, activates the scenario perturbation, and preserves the
 * distinction between definite failure and an indeterminate committed result.
 */
export class AdapterRuntime {
  readonly #registry: AdapterRegistry;
  readonly #controller: ScenarioController;
  readonly #upstream: (request: Request) => Promise<Response>;
  readonly #process: AdapterRuntimeOptions["process"];
  readonly #parentId?: string;
  readonly #oracle?: OutcomeOracle;
  readonly #mintToken?: AdapterRuntimeOptions["mintToken"];
  readonly #tokenHeader: string;
  #operationId = 0;

  constructor(options: AdapterRuntimeOptions) {
    this.#registry = options.registry;
    this.#controller = options.controller;
    this.#upstream = options.upstream;
    this.#process = options.process ?? "external";
    this.#parentId = options.parentId;
    this.#oracle = options.oracle;
    this.#mintToken = options.mintToken
      ?? (options.oracle ? () => mintOperationToken() : undefined);
    this.#tokenHeader = options.tokenHeader ?? OPERATION_TOKEN_HEADER;
  }

  /** The oracle answer, or undefined. Never a guess: see `askOracle`. */
  #ask(token: OperationToken | undefined) {
    return askOracle(this.#oracle, token);
  }

  async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
    const original = input instanceof Request ? input : new Request(input, init);
    const classified = this.#registry.classify(original);
    if (!classified) return this.#upstream(original);

    const { adapter, match } = classified;
    // Minted before anything is sent, so the attempt stays askable even when
    // CloudFault destroys the response it would otherwise have read it from.
    const token = this.#mintToken?.(original, match.operation);
    const request = token ? withHeader(original, this.#tokenHeader, token) : original;
    const process = typeof this.#process === "function"
      ? this.#process(request, match.operation)
      : this.#process ?? "external";
    const operation = this.#controller.begin({
      id: `adapter-${++this.#operationId}`,
      name: match.operation.name,
      process,
      target: adapter.manifest.name,
      adapter: adapter.manifest.name,
      resource: match.operation.resource,
      parentId: this.#parentId,
      token,
    }, {
      method: request.method,
      url: request.url,
      effect: match.operation.effect,
      retry: match.operation.retry,
      idempotencyKey: match.operation.idempotencyKey,
    });

    const eligible = this.#controller.eligible(operation);
    const perturbation = eligible[0];
    if (perturbation) this.#controller.activate(perturbation, operation);

    const upstream = () => this.#upstream(request.clone());
    if (adapter.execute) {
      return adapter.execute({ request, operation: match.operation, perturbation, upstream, controller: this.#controller, operationRef: operation });
    }

    try {
      if (perturbation && "phase" in perturbation) {
        const immediate = responseFromFault(perturbation);
        if (immediate) {
          this.#controller.complete(operation, "fail", { status: immediate.status }, outcomeMetadata(
            await this.#ask(token),
            {
              observed: perturbation.observedOutcome ?? "definite-failure",
              declared: perturbation.actualOutcome ?? "not-committed",
            },
          ));
          return immediate;
        }

        if (perturbation.kind === "timeout-before-send") {
          this.#controller.complete(operation, "fail", undefined, {
            actual: "not-committed",
            observed: "definite-failure",
            // Nothing was sent, so nothing could have happened. Establishing
            // that needs no oracle.
            actualSource: "declared",
            detail: "timeout before provider request was sent",
          });
          throw new CloudFaultInjectedError("CloudFault injected timeout before send", perturbation, { cause: undefined });
        }

        if (perturbation.kind === "latency") {
          const delayMs = Number(perturbation.metadata?.delayMs ?? 0);
          await delay(delayMs);
        }

        if (perturbation.kind === "malformed-json") {
          const response = await upstream();
          // Truncated JSON is exactly where an oracle earns its keep: the bytes
          // the caller never received may well have said `success: true`. Only
          // a privileged backend can say. Absent one this stays `unknown`,
          // which is what `malformedJson()` itself documents.
          this.#controller.complete(operation, "info", { upstreamStatus: response.status }, outcomeMetadata(
            await this.#ask(token),
            {
              observed: "indeterminate",
              declared: perturbation.actualOutcome,
              detail: "malformed-json",
            },
          ));
          const headers = new Headers(response.headers);
          headers.set("content-type", "application/json");
          return new Response('{"cloudfault":', { status: response.status, statusText: response.statusText, headers });
        }

        if (perturbation.kind === "commit-then-timeout" || perturbation.kind === "commit-then-disconnect") {
          const response = await upstream();
          // The response is deliberately not consumed: the caller is about to be
          // told the transport failed. What actually happened is asked of the
          // oracle by the token that was minted before the request went out. If
          // there is no oracle, the fault's own declaration stands -- sound here
          // only because CloudFault chose this moment itself, after a call that
          // returned. It is labelled `declared`, not `oracle`, so the difference
          // survives into the history.
          this.#controller.complete(operation, "info", { upstreamStatus: response.status }, outcomeMetadata(
            await this.#ask(token),
            {
              observed: "indeterminate",
              declared: perturbation.actualOutcome,
              detail: perturbation.kind,
            },
          ));
          throw new CloudFaultIndeterminateError(
            perturbation.kind === "commit-then-timeout"
              ? "CloudFault injected timeout after provider commit"
              : "CloudFault injected disconnect after provider commit",
            perturbation,
            operation,
          );
        }
      }

      const response = await upstream();
      this.#controller.complete(operation, response.ok ? "ok" : "fail", { status: response.status }, outcomeMetadata(
        await this.#ask(token),
        {
          observed: response.ok ? "success" : "definite-failure",
          // A 2xx is a deduction, not privileged knowledge: it is sound for a
          // backend whose success implies durability and unsound for one that
          // reports application errors with HTTP 200. Labelled `inferred`.
          inferred: match.operation.effect === "query" ? "unknown" : response.ok ? "committed" : "unknown",
        },
      ));
      return response;
    } catch (error) {
      if (error instanceof CloudFaultIndeterminateError || error instanceof CloudFaultInjectedError) throw error;
      this.#controller.complete(operation, "info", { error: error instanceof Error ? error.message : String(error) }, outcomeMetadata(
        await this.#ask(token),
        { observed: "indeterminate" },
      ));
      throw error;
    }
  }
}
