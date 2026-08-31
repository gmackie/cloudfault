import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = process.cwd();
const core = await import(pathToFileURL(path.join(root, "packages/core/dist/index.js")));

test("history represents indeterminate outcomes with info", () => {
  const history = new core.History(() => 42);
  const op = { id: "1", name: "charge", process: 1 };
  history.invoke(op);
  history.complete(op, "info", undefined, { actual: "committed", observed: "indeterminate" });
  const events = history.snapshot();
  assert.equal(events[1].type, "info");
  assert.equal(events[1].outcome.actual, "committed");
});

test("bounded search explores multi-point combinations", () => {
  const f = (id, target) => ({ id, target, kind: id, phase: "before-commit", description: id });
  const scenarios = core.enumerateScenarios([
    { id: "a", target: "a", choices: [f("a1", "a")] },
    { id: "b", target: "b", choices: [f("b1", "b")] },
  ], { maxDepth: 2 });
  assert.deepEqual(scenarios.map((x) => x.id), ["a1", "b1", "a1+b1"]);
});

test("minimal failure set removes irrelevant perturbations", async () => {
  const p = (id) => ({ id, target: id, kind: id, phase: "before-commit", description: id });
  const values = [p("stale"), p("timeout"), p("irrelevant")];
  const result = await core.minimizeFailureSet(values, (candidate) => {
    const ids = new Set(candidate.map((x) => x.id));
    return ids.has("stale") && ids.has("timeout");
  });
  assert.deepEqual(result.minimal.map((x) => x.id), ["stale", "timeout"]);
});
