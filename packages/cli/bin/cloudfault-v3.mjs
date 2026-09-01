#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

async function adapters() { return import("@cloudfault/adapters"); }

function writeOrPrint(value, output) {
  if (!output || output === "-") {
    process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
    return;
  }
  const absolute = path.resolve(output);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, value.endsWith("\n") ? value : `${value}\n`);
  console.log(`Wrote ${absolute}`);
}

async function semanticContracts(output) {
  const { semanticContractsJson } = await adapters();
  writeOrPrint(semanticContractsJson(), output);
}

async function semanticsRegistry(output) {
  const { semanticsRegistryJson } = await adapters();
  writeOrPrint(semanticsRegistryJson(), output);
}

async function semanticContract(name, output) {
  const { bundledSemanticContract } = await adapters();
  const contract = bundledSemanticContract(name);
  if (!contract) throw new Error(`No bundled semantic contract fixture for '${name}'`);
  writeOrPrint(JSON.stringify(contract, null, 2), output);
}

async function providerLifecycle(name) {
  const { providerLifecyclePerturbations, semanticAdapter } = await adapters();
  const adapter = semanticAdapter(name);
  if (!adapter) throw new Error(`Unknown bundled adapter '${name}'`);
  const items = providerLifecyclePerturbations(adapter);
  console.log(`CloudFault lifecycle perturbations — ${adapter.manifest.provider}\n`);
  if (!items.length) console.log("(none modeled)");
  for (const item of items) console.log(`${item.kind.padEnd(28)} ${item.description}`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "contracts") await semanticContracts(args[0]);
  else if (command === "contract" && args[0]) await semanticContract(args[0], args[1]);
  else if (command === "semantics") await semanticsRegistry(args[0]);
  else if (command === "lifecycle" && args[0]) await providerLifecycle(args[0]);
  else await import("./cloudfault-v2.mjs");
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}
