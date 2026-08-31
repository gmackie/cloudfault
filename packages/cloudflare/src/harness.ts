export interface HarnessOptions {
  root?: string;
  wranglerConfig?: string;
  bindings?: Record<string, unknown>;
}

export interface CloudFaultHarness {
  raw: unknown;
  close(): Promise<void>;
}

/**
 * Thin lazy bridge around Wrangler's createTestHarness. Wrangler is an optional
 * peer so CloudFault core can be installed without pulling the full runtime.
 *
 * The exact harness APIs are intentionally kept behind `raw` in V0 while the
 * runtime-injection layer is built against current Wrangler releases.
 */
export async function createCloudFaultHarness(options: HarnessOptions = {}): Promise<CloudFaultHarness> {
  let wrangler: Record<string, unknown>;
  try {
    wrangler = await import("wrangler") as Record<string, unknown>;
  } catch {
    throw new Error(
      "CloudFault runtime integration requires Wrangler. Install a current Wrangler 4.x release in the project under test.",
    );
  }

  const create = wrangler.createTestHarness;
  if (typeof create !== "function") {
    throw new Error(
      "The installed Wrangler does not expose createTestHarness(). Upgrade Wrangler before using CloudFault runtime integration.",
    );
  }

  const harness = await (create as (opts: Record<string, unknown>) => Promise<Record<string, unknown>>)({
    root: options.root,
    config: options.wranglerConfig,
    bindingOverrides: options.bindings,
  });

  return {
    raw: harness,
    async close() {
      const dispose = harness.dispose ?? harness.close;
      if (typeof dispose === "function") await (dispose as () => Promise<void>).call(harness);
    },
  };
}
