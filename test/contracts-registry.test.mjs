import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { bundledSemanticContracts, providerSemantics, semanticContractsJson } from "../packages/adapters/dist/index.js";

test("all 25 bundled adapters have conformant fingerprinted semantic contract fixtures", () => {
  const contracts = bundledSemanticContracts();
  assert.equal(contracts.length, 25);
  assert.equal(contracts.every((contract) => contract.conformanceValid), true);
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
