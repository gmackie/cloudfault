#!/usr/bin/env node

/**
 * packages/cloudfault/package.json holds the canonical version — it is the
 * only package that is published. This copies that version to the root
 * manifest and to every private @cloudfault/* workspace package, and rewrites
 * the `file:` cross-dependencies so nothing drifts.
 *
 * Usage:
 *   node scripts/sync-versions.mjs          # sync
 *   node scripts/sync-versions.mjs --check  # CI check (exit 1 if out of sync)
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");
const canonicalPath = join(packagesDir, "cloudfault/package.json");

const version = JSON.parse(readFileSync(canonicalPath, "utf8")).version;
const check = process.argv.includes("--check");
const mismatches = [];

const targets = [join(root, "package.json")];
for (const dir of readdirSync(packagesDir)) {
  if (dir === "cloudfault") continue;
  targets.push(join(packagesDir, dir, "package.json"));
}

for (const path of targets) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    continue;
  }
  if (pkg.version === version) continue;
  if (check) {
    mismatches.push(`${pkg.name}: ${pkg.version} (expected ${version})`);
  } else {
    pkg.version = version;
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`Updated ${pkg.name} to ${version}`);
  }
}

if (check && mismatches.length > 0) {
  console.error("Version mismatch — run `npm run sync-versions`:");
  for (const line of mismatches) console.error(`  ${line}`);
  process.exit(1);
}
if (check) console.log(`All workspace packages are at ${version}`);
