export interface NemesisProjectFile {
  path: string;
  content: string;
}

export interface NemesisTemplateOptions {
  name: string;
  compatibilityDate?: string;
  upstreamService?: string;
}

const DEFAULT_DATE = "2026-08-31";

/** Generic service-binding nemesis controlled via JSRPC getExport(). */
export function serviceNemesisProject(options: NemesisTemplateOptions): readonly NemesisProjectFile[] {
  const upstream = options.upstreamService ?? "upstream-worker";
  return [
    {
      path: "wrangler.jsonc",
      content: JSON.stringify({
        name: options.name,
        main: "src/index.js",
        compatibility_date: options.compatibilityDate ?? DEFAULT_DATE,
        services: [{ binding: "UPSTREAM", service: upstream }],
      }, null, 2) + "\n",
    },
    {
      path: "src/index.js",
      content: `import { WorkerEntrypoint } from "cloudflare:workers";

let plan = [];
let events = [];
let occurrences = new Map();

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function key(request) { const url = new URL(request.url); return request.method + " " + url.pathname; }
function nextRule(request) {
  const k = key(request);
  const occurrence = (occurrences.get(k) ?? 0) + 1;
  occurrences.set(k, occurrence);
  return plan.find((rule) => (!rule.method || rule.method === request.method) && (!rule.path || rule.path === new URL(request.url).pathname) && (!rule.occurrence || rule.occurrence === occurrence));
}

export default class ServiceNemesis extends WorkerEntrypoint {
  async fetch(request) {
    const rule = nextRule(request);
    if (!rule) return this.env.UPSTREAM.fetch(request);
    events.push({ at: Date.now(), type: "fault", rule: clone(rule), method: request.method, url: request.url });
    if (rule.kind === "latency") await new Promise((resolve) => setTimeout(resolve, Math.max(0, rule.delayMs ?? 0)));
    if (rule.kind === "reject" || rule.kind === "http-error") return new Response(rule.body ?? "CloudFault injected failure", { status: rule.status ?? 503 });
    if (rule.kind === "commit-then-error" || rule.kind === "commit-then-timeout" || rule.kind === "commit-then-disconnect") {
      const response = await this.env.UPSTREAM.fetch(request);
      events.push({ at: Date.now(), type: "upstream-committed", status: response.status, method: request.method, url: request.url });
      throw new Error(rule.kind === "commit-then-timeout" ? "CloudFault timeout after commit" : "CloudFault connection lost after commit");
    }
    return this.env.UPSTREAM.fetch(request);
  }

  setPlan(value) { plan = clone(value ?? []); occurrences = new Map(); }
  clearPlan() { plan = []; occurrences = new Map(); }
  events() { return clone(events); }
  reset() { plan = []; events = []; occurrences = new Map(); }
}
`,
    },
  ];
}

/** KVNamespace-shaped JSRPC test Worker used as a bindingOverride target. */
export function kvNemesisProject(options: Omit<NemesisTemplateOptions, "upstreamService">): readonly NemesisProjectFile[] {
  return [
    {
      path: "wrangler.jsonc",
      content: JSON.stringify({
        name: options.name,
        main: "src/index.js",
        compatibility_date: options.compatibilityDate ?? DEFAULT_DATE,
      }, null, 2) + "\n",
    },
    {
      path: "src/index.js",
      content: `import { WorkerEntrypoint } from "cloudflare:workers";

let versions = new Map();
let metadata = new Map();
let views = new Map();
let manual = new Map();
let observer = "local";
let events = [];

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function readType(options) { return typeof options === "string" ? options : options?.type; }
function decode(value, type) {
  if (value == null) return null;
  if (!type || type === "text") return String(value);
  if (type === "json") return JSON.parse(String(value));
  if (type === "arrayBuffer") return new TextEncoder().encode(String(value)).buffer;
  return String(value);
}
function historyFor(key) { return versions.get(key) ?? []; }
function append(key, value, meta) {
  const history = historyFor(key);
  history.push({ value: value == null ? null : String(value), metadata: clone(meta ?? null) });
  versions.set(key, history);
  if (meta !== undefined) metadata.set(key, clone(meta));
}
function viewKey(key, region = observer) { return \`\${region}\u0000\${key}\`; }
function consumeManual(key) {
  const rule = manual.get(key);
  if (!rule) return undefined;
  rule.remaining--;
  if (rule.remaining <= 0) manual.delete(key);
  return rule;
}
function observed(key) {
  const override = consumeManual(key);
  if (override) return { value: override.value, metadata: override.metadata, semantic: override.kind };
  const history = historyFor(key);
  const lagRule = views.get(viewKey(key));
  if (!lagRule) return { ...(history.at(-1) ?? { value: null, metadata: null }), semantic: undefined };
  const index = Math.max(-1, history.length - 1 - lagRule.versionsBehind);
  lagRule.remaining--;
  if (lagRule.remaining <= 0) views.delete(viewKey(key));
  const entry = index < 0 ? { value: null, metadata: null } : history[index];
  return { ...entry, semantic: "stale-read", versionsBehind: lagRule.versionsBehind };
}

export default class KvNemesis extends WorkerEntrypoint {
  get(key, options) {
    const result = observed(key);
    events.push({ at: Date.now(), type: result.semantic ? "semantic" : "read", kind: result.semantic, observer, key, value: result.value, versionsBehind: result.versionsBehind });
    return decode(result.value, readType(options));
  }
  getWithMetadata(key, options) {
    const result = observed(key);
    events.push({ at: Date.now(), type: result.semantic ? "semantic" : "read", kind: result.semantic, observer, key, value: result.value, versionsBehind: result.versionsBehind });
    return { value: decode(result.value, readType(options)), metadata: clone(result.metadata ?? null), cacheStatus: null };
  }
  put(key, value, options) {
    append(key, value, options?.metadata);
    events.push({ at: Date.now(), type: "write", key, value: String(value), version: historyFor(key).length });
  }
  delete(key) {
    append(key, null, null);
    events.push({ at: Date.now(), type: "delete", key, version: historyFor(key).length });
  }
  list(options = {}) {
    const prefix = options.prefix ?? "";
    const keys = [...versions.keys()]
      .filter((key) => key.startsWith(prefix) && historyFor(key).at(-1)?.value != null)
      .sort()
      .map((name) => ({ name, metadata: clone(historyFor(name).at(-1)?.metadata ?? null) }));
    return { keys, list_complete: true, cacheStatus: null };
  }
  seed(key, value, meta = null) { versions.set(key, [{ value: value == null ? null : String(value), metadata: clone(meta) }]); }
  seedVersion(key, value, meta = null) { append(key, value, meta); }
  setObserver(value) { observer = String(value ?? "local"); }
  setLag(key, versionsBehind = 1, reads = 1, region = observer) {
    views.set(viewKey(key, region), { versionsBehind: Math.max(0, Number(versionsBehind)), remaining: Math.max(1, Number(reads)) });
  }
  setStale(key, value, reads = 1, meta = null) { manual.set(key, { kind: "stale-read", value: value == null ? null : String(value), remaining: Math.max(1, Number(reads)), metadata: clone(meta) }); }
  setNegative(key, reads = 1) { manual.set(key, { kind: "stale-negative-read", value: null, remaining: Math.max(1, Number(reads)), metadata: null }); }
  clearStale() { views = new Map(); manual = new Map(); }
  snapshot() {
    return {
      observer,
      versions: Object.fromEntries([...versions].map(([key, value]) => [key, clone(value)])),
      views: Object.fromEntries(views),
      manual: Object.fromEntries(manual),
      events: clone(events),
    };
  }
  reset() { versions = new Map(); metadata = new Map(); views = new Map(); manual = new Map(); observer = "local"; events = []; }
}
`,
    },
  ];
}

/** Queue producer-shaped JSRPC target that can fail or duplicate sends. */
export function queueNemesisProject(options: Omit<NemesisTemplateOptions, "upstreamService">): readonly NemesisProjectFile[] {
  return [
    {
      path: "wrangler.jsonc",
      content: JSON.stringify({
        name: options.name,
        main: "src/index.js",
        compatibility_date: options.compatibilityDate ?? DEFAULT_DATE,
      }, null, 2) + "\n",
    },
    {
      path: "src/index.js",
      content: `import { WorkerEntrypoint } from "cloudflare:workers";

let mode = "pass";
let messages = [];
let events = [];
function clone(value) { return JSON.parse(JSON.stringify(value)); }

export default class QueueNemesis extends WorkerEntrypoint {
  send(body, options) {
    events.push({ at: Date.now(), type: "send", mode, body: clone(body) });
    if (mode === "fail") throw new Error("CloudFault injected queue producer failure");
    messages.push({ body: clone(body), options: clone(options ?? null) });
    if (mode === "duplicate") messages.push({ body: clone(body), options: clone(options ?? null), duplicate: true });
  }
  sendBatch(batch) {
    for (const item of batch) this.send(item.body, item);
  }
  setMode(value) { mode = value; }
  snapshot() { return { mode, messages: clone(messages), events: clone(events) }; }
  reset() { mode = "pass"; messages = []; events = []; }
}
`,
    },
  ];
}
