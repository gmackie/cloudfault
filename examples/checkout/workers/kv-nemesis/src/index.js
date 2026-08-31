import { WorkerEntrypoint } from "cloudflare:workers";

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
function viewKey(key, region = observer) { return `${region}\u0000${key}`; }
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
