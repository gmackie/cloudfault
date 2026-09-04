#!/usr/bin/env node

/**
 * Assembles the single publishable package, @gmacko/cloudfault, from the
 * built output of the private @cloudfault/* workspace packages.
 *
 * The workspace packages are never published, so any bare "@cloudfault/*"
 * specifier that survives into the tarball would fail to resolve for a
 * consumer. Rather than bundling (which would duplicate every declaration
 * once per entry point and break nominal identity for the classes that use
 * ES #private fields), this copies each package's `tsc -b` output into
 * dist/<name>/ and rewrites the cross-package specifiers to relative paths.
 *
 * One declaration of every type survives, so `AdapterRuntime` obtained from
 * "@gmacko/cloudfault/adapters" is the same type as the one "./adapter-sdk"
 * expects, and `instanceof CloudFaultIndeterminateError` holds across
 * subpaths at runtime.
 *
 * Usage: node scripts/build-package.mjs
 */

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "packages/cloudfault");
const outDir = join(target, "dist");

/** Workspace package name -> directory name inside dist/. */
const LIBRARIES = {
  "@cloudfault/core": "core",
  "@cloudfault/adapter-sdk": "adapter-sdk",
  "@cloudfault/cloudflare": "cloudflare",
  "@cloudfault/stripe": "stripe",
  "@cloudfault/adapters": "adapters",
  "@cloudfault/fast-check": "fast-check",
};

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*)(["'])(@cloudfault\/[a-z-]+)(\/[a-z-]+)?\2/g;

function rewrite(source, fileDir) {
  return source.replace(SPECIFIER, (match, lead, quote, pkg, sub) => {
    const dir = LIBRARIES[pkg];
    if (!dir) throw new Error(`Unknown workspace specifier ${pkg} in ${fileDir}`);
    const file = sub ? `${sub.slice(1)}.js` : "index.js";
    let rel = posix.relative(fileDir, posix.join(dir, file));
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return `${lead}${quote}${rel}${quote}`;
  });
}

/** Drops sourceMappingURL comments; the .map files and sources are not shipped. */
function stripMapComments(source) {
  return source.replace(/\r?\n?\/\/# sourceMappingURL=.*$/gm, "");
}

function copyTree(from, to, distRelative) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dest, posix.join(distRelative, entry.name));
      continue;
    }
    if (entry.name.endsWith(".map")) continue;
    if (/\.(js|mjs|cjs|ts)$/.test(entry.name)) {
      const text = readFileSync(src, "utf8");
      writeFileSync(dest, `${stripMapComments(rewrite(text, distRelative)).trimEnd()}\n`, {
        mode: statSync(src).mode,
      });
    } else {
      cpSync(src, dest);
    }
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const [name, dir] of Object.entries(LIBRARIES)) {
  const from = join(root, "packages", dir, "dist");
  if (!statSync(from, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${name} has no dist/. Run \`tsc -b\` before scripts/build-package.mjs.`);
  }
  copyTree(from, join(outDir, dir), dir);
}

// The CLI is plain .mjs, so it is copied rather than compiled.
copyTree(join(root, "packages/cli/bin"), join(outDir, "cli/bin"), "cli/bin");
copyTree(join(root, "packages/cli/lib"), join(outDir, "cli/lib"), "cli/lib");

// cloudfault.mjs is a superseded copy of the v2 CLI that nothing dispatches to.
rmSync(join(outDir, "cli/bin/cloudfault.mjs"), { force: true });

const version = JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version;

const leaked = [];
const scan = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (/\.(js|mjs|cjs|ts)$/.test(entry.name)) {
      for (const match of readFileSync(path, "utf8").matchAll(SPECIFIER)) leaked.push(`${relative(root, path)}: ${match[0]}`);
    }
  }
};
scan(outDir);
if (leaked.length > 0) {
  console.error("Unresolved @cloudfault/* specifiers survived into dist/:");
  for (const line of leaked) console.error(`  ${line}`);
  process.exit(1);
}

console.log(`Assembled @gmacko/cloudfault@${version} into ${relative(root, outDir)}`);
