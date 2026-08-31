import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)),
      },
    }),
  ],
  test: {
    setupFiles: [fileURLToPath(new URL("./test/setup.js", import.meta.url))],
    include: [fileURLToPath(new URL("./test/**/*.test.js", import.meta.url))],
  },
});
