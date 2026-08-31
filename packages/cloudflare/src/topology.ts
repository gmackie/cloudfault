export type CloudflareBindingType =
  | "kv"
  | "d1"
  | "r2"
  | "queue-producer"
  | "queue-consumer"
  | "durable-object"
  | "service"
  | "workflow"
  | "vectorize"
  | "hyperdrive"
  | "ai"
  | "browser"
  | "images"
  | "pipeline";

export interface CloudflareBindingDescriptor {
  type: CloudflareBindingType;
  binding: string;
  metadata?: Record<string, unknown>;
}

export interface WranglerTopology {
  name?: string;
  bindings: readonly CloudflareBindingDescriptor[];
  raw: Record<string, unknown>;
}

/** Strip // and /* *\/ comments while respecting JSON string literals. */
export function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escape = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    const next = input[i + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += char;
      } else output += " ";
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        output += "  ";
        i++;
      } else output += char === "\n" ? "\n" : " ";
      continue;
    }
    if (inString) {
      output += char;
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      output += "  ";
      i++;
      continue;
    }
    output += char;
  }
  return output;
}

function removeTrailingCommas(input: string): string {
  let output = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (inString) {
      output += char;
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) j++;
      if (input[j] === "}" || input[j] === "]") continue;
    }
    output += char;
  }
  return output;
}

export function parseJsonc(input: string): Record<string, unknown> {
  const value = JSON.parse(removeTrailingCommas(stripJsonComments(input))) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Wrangler config must be a JSON object");
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function discoverWranglerTopology(input: string | Record<string, unknown>): WranglerTopology {
  const raw = typeof input === "string" ? parseJsonc(input) : input;
  const bindings: CloudflareBindingDescriptor[] = [];
  const add = (type: CloudflareBindingType, entries: readonly Record<string, unknown>[], field = "binding") => {
    for (const entry of entries) {
      const binding = string(entry[field]) ?? string(entry.name);
      if (binding) bindings.push({ type, binding, metadata: { ...entry } });
    }
  };

  add("kv", array(raw.kv_namespaces));
  add("d1", array(raw.d1_databases));
  add("r2", array(raw.r2_buckets));

  const queues = record(raw.queues);
  add("queue-producer", array(queues.producers));
  add("queue-consumer", array(queues.consumers), "queue");

  const durable = record(raw.durable_objects);
  add("durable-object", array(durable.bindings), "name");
  add("service", array(raw.services));
  add("workflow", array(raw.workflows));
  add("vectorize", array(raw.vectorize));
  add("hyperdrive", array(raw.hyperdrive));
  add("pipeline", array(raw.pipelines));

  if (raw.ai && typeof raw.ai === "object") {
    const binding = string(record(raw.ai).binding) ?? "AI";
    bindings.push({ type: "ai", binding, metadata: { ...record(raw.ai) } });
  }
  if (raw.browser && typeof raw.browser === "object") {
    const binding = string(record(raw.browser).binding) ?? "BROWSER";
    bindings.push({ type: "browser", binding, metadata: { ...record(raw.browser) } });
  }
  if (raw.images && typeof raw.images === "object") {
    const binding = string(record(raw.images).binding) ?? "IMAGES";
    bindings.push({ type: "images", binding, metadata: { ...record(raw.images) } });
  }

  return { name: string(raw.name), bindings, raw };
}
