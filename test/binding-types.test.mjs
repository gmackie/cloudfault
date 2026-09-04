import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

/**
 * `test/types/bindings.ts` is a consumer-shaped fixture: it declares the real
 * `@cloudflare/workers-types` `D1Database`/`R2Bucket` shapes and wraps them
 * with no type assertions. It also pins the incompatibility itself with a
 * `@ts-expect-error`, so if `D1Database` ever becomes assignable to
 * `D1DatabaseLike` this test fails and the compatibility overload can be
 * removed rather than lingering.
 */
test("real Workers binding types wrap without assertions and keep their own type", () => {
  const tsc = path.join(root, "node_modules/typescript/bin/tsc");
  const output = execFileSync(process.execPath, [tsc, "-p", path.join(root, "test/types/tsconfig.json")], {
    encoding: "utf8",
    cwd: root,
  });
  assert.equal(output.trim(), "");
});
