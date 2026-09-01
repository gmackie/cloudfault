import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: fileURLToPath(new URL("../workflow-retry/worker/wrangler.jsonc", import.meta.url)),
      },
    }),
  ],
  test: {
    include: [fileURLToPath(new URL("./test/**/*.test.js", import.meta.url))],
  },
});
