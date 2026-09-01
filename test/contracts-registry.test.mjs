import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { runAdapterConformance } from "../packages/adapter-sdk/dist/conformance.js";
import {
  bundledContractFixtures,
  bundledSemanticContracts,
  providerSemantics,
  semanticAdapter,
  semanticContractsJson,
} from "../packages/adapters/dist/index.js";

test("all 25 bundled adapters have conformant fingerprinted semantic contract fixtures", () => {
  const contracts = bundledSemanticContracts();
  assert.equal(contracts.length, 25);
  const invalid = bundledContractFixtures.flatMap(({ adapter: name, cases }) => {
    const adapter = semanticAdapter(name);
    if (!adapter) return [{ adapter: name, failures: ["missing adapter"] }];
    const result = runAdapterConformance(adapter, cases);
    if (result.valid) return [];
    return [{
      adapter: name,
      failures: result.checks.filter((check) => !check.valid).map((check) => `${check.case}: ${check.message ?? "failed"}`),
    }];
  });
  assert.deepEqual(invalid, []);
  assert.equal(contracts.every((contract) => /^fnv1a32:[0-9a-f]{8}$/.test(contract.fingerprint)), true);
  assert.equal(new Set(contracts.map((contract) => contract.adapter)).size, contracts.length);
});

test("provider semantics registry corrects Firestore default consistency semantics", () => {
  const firebase = providerSemantics("firebase");
  assert.ok(firebase);
  assert.ok(firebase.capabilities.includes("strong-consistency"));
  assert.equal(firebase.capabilities.includes("eventual-observation"), false);
});

test("semantic contract registry JSON and CLI expose the same contract set", () => {
  const library = JSON.parse(semanticContractsJson());
  const cli = JSON.parse(execFileSync(process.execPath, ["packages/cli/bin/cloudfault-v3.mjs", "contracts", "-"], { encoding: "utf8" }));
  assert.equal(library.schema, "cloudfault.semantic-contract-registry");
  assert.deepEqual(cli.contracts.map((item) => item.fingerprint), library.contracts.map((item) => item.fingerprint));
});
