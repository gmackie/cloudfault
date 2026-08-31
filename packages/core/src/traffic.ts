export interface TrafficRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface TrafficRecord {
  id: string;
  request: TrafficRequest;
  expectedStatus?: number;
  startedAt?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface HarDocument {
  log?: {
    entries?: Array<{
      startedDateTime?: string;
      time?: number;
      request?: {
        method?: string;
        url?: string;
        headers?: Array<{ name?: string; value?: string }>;
        postData?: { text?: string; mimeType?: string };
      };
      response?: { status?: number };
    }>;
  };
}

function headerRecord(headers: Array<{ name?: string; value?: string }> | undefined): Record<string, string> {
  return Object.fromEntries(
    (headers ?? [])
      .filter((item): item is { name: string; value: string } => Boolean(item.name && item.value !== undefined))
      .map((item) => [item.name, item.value]),
  );
}

/** Convert ordinary HAR entries into a portable workload corpus. */
export function importHar(document: HarDocument): readonly TrafficRecord[] {
  const entries = document.log?.entries ?? [];
  return entries.flatMap((entry, index) => {
    const request = entry.request;
    if (!request?.method || !request.url) return [];
    const headers = headerRecord(request.headers);
    if (request.postData?.mimeType && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["content-type"] = request.postData.mimeType;
    }
    return [{
      id: `har:${index + 1}`,
      request: {
        method: request.method,
        url: request.url,
        headers,
        body: request.postData?.text,
      },
      expectedStatus: entry.response?.status,
      startedAt: entry.startedDateTime,
      durationMs: entry.time,
      metadata: { source: "har" },
    } satisfies TrafficRecord];
  });
}

export interface TrafficReplayOptions {
  baseUrl?: string;
  preserveHost?: boolean;
  transform?: (record: TrafficRecord) => TrafficRecord | Promise<TrafficRecord>;
}

export async function replayTraffic(
  records: readonly TrafficRecord[],
  fetcher: (request: Request) => Promise<Response>,
  options: TrafficReplayOptions = {},
): Promise<readonly { record: TrafficRecord; response: Response }[]> {
  const results: Array<{ record: TrafficRecord; response: Response }> = [];
  for (const original of records) {
    const record = options.transform ? await options.transform(original) : original;
    const originalUrl = new URL(record.request.url);
    const url = options.baseUrl
      ? new URL(`${originalUrl.pathname}${originalUrl.search}`, options.baseUrl)
      : originalUrl;
    const headers = new Headers(record.request.headers);
    if (!options.preserveHost) headers.delete("host");
    const response = await fetcher(new Request(url, {
      method: record.request.method,
      headers,
      body: ["GET", "HEAD"].includes(record.request.method.toUpperCase()) ? undefined : record.request.body,
    }));
    results.push({ record, response });
  }
  return results;
}

/**
 * Remove secrets and unstable tracing headers before a captured request corpus
 * is committed to a repository or used as a deterministic test fixture.
 */
export function sanitizeTraffic(
  records: readonly TrafficRecord[],
  options: { redactHeaders?: readonly string[]; redactQuery?: readonly string[] } = {},
): readonly TrafficRecord[] {
  const sensitiveHeaders = new Set((options.redactHeaders ?? [
    "authorization", "cookie", "set-cookie", "x-api-key", "api-key",
  ]).map((value) => value.toLowerCase()));
  const sensitiveQuery = new Set((options.redactQuery ?? ["token", "key", "api_key", "secret"]).map((value) => value.toLowerCase()));

  return records.map((record) => {
    const url = new URL(record.request.url);
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveQuery.has(key.toLowerCase())) url.searchParams.set(key, "[REDACTED]");
    }
    const headers = Object.fromEntries(
      Object.entries(record.request.headers ?? {}).map(([key, value]) => [
        key,
        sensitiveHeaders.has(key.toLowerCase()) ? "[REDACTED]" : value,
      ]),
    );
    return {
      ...record,
      request: { ...record.request, url: url.toString(), headers },
    };
  });
}
