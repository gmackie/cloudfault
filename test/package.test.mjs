import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const packageDir = path.join(root, "packages/cloudfault");
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));

const SUBPATHS = [".", "./cloudflare", "./stripe", "./adapter-sdk", "./adapters", "./fast-check"];

test("the published package declares the public subpaths consumers depend on", () => {
  assert.equal(manifest.name, "@gmacko/cloudfault");
  assert.equal(manifest.type, "module");
  // Scoped packages publish restricted by default; without this the publish
  // silently produces a private package.
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.bin?.cloudfault, "./dist/cli/bin/cloudfault-v4.mjs");
  for (const subpath of SUBPATHS) {
    assert.ok(manifest.exports[subpath], `missing exports entry for ${subpath}`);
  }
});

test("every exports entry points at a file that exists in dist/", () => {
  for (const [subpath, entry] of Object.entries(manifest.exports)) {
    const targets = typeof entry === "string" ? { default: entry } : entry;
    for (const [condition, target] of Object.entries(targets)) {
      const absolute = path.join(packageDir, target);
      assert.ok(fs.existsSync(absolute), `${subpath} (${condition}) -> missing ${target}`);
    }
  }
  const bin = path.join(packageDir, manifest.bin.cloudfault);
  assert.ok(fs.existsSync(bin), "bin target is missing");
  assert.match(fs.readFileSync(bin, "utf8"), /^#!\/usr\/bin\/env node\n/, "bin lacks a shebang");
});

test("every exports entry imports cleanly with no @cloudfault/* specifiers left", async () => {
  for (const [subpath, entry] of Object.entries(manifest.exports)) {
    if (subpath === "./package.json") continue;
    const target = path.join(packageDir, entry.import);
    const mod = await import(pathToFileURL(target).href);
    assert.ok(Object.keys(mod).length > 0, `${subpath} exported nothing`);
  }

  const leaked = [];
  const scan = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) scan(file);
      else if (/\.(js|mjs|cjs|ts)$/.test(item.name)) {
        const text = fs.readFileSync(file, "utf8");
        if (/(\bfrom\s*|\bimport\s*\(\s*)(["'])@cloudfault\//.test(text)) leaked.push(path.relative(root, file));
      }
    }
  };
  scan(path.join(packageDir, "dist"));
  assert.deepEqual(leaked, [], "unpublishable @cloudfault/* specifiers survived into dist/");
});

test("the CLI runs from the assembled package and generates public-name configs", () => {
  const bin = path.join(packageDir, manifest.bin.cloudfault);
  const output = execFileSync(process.execPath, [bin, "adapters"], { encoding: "utf8" });
  assert.match(output, /CloudFault bundled unofficial adapters/);

  const template = fs.readFileSync(path.join(packageDir, "dist/cli/lib/project.mjs"), "utf8");
  assert.ok(template.includes('from "@gmacko/cloudfault";'), "init template must import the published name");
  assert.ok(template.includes('from "@gmacko/cloudfault/cloudflare";'), "init template must use the published subpath");
});

test("workspace versions stay in sync with the published package", () => {
  execFileSync(process.execPath, [path.join(root, "scripts/sync-versions.mjs"), "--check"], { encoding: "utf8" });
});
