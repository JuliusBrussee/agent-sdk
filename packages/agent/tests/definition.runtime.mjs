import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agent,
  applyAgentDefinitionTransforms,
} from "../dist/index.js";

test("definition transforms are explicit, ordered, and uniquely identified", () => {
  const base = agent({
    id: "transform-test",
    instructions: "base",
    model: "anthropic/faux-1",
    sandbox: "fixture",
  });
  const transformed = applyAgentDefinitionTransforms(base, [
    { id: "first", apply: (definition) => agent({ ...definition, instructions: "first" }) },
    { id: "second", apply: (definition) => agent({ ...definition, instructions: `${definition.instructions}:second` }) },
  ]);
  assert.equal(transformed.instructions, "first:second");
  assert.throws(
    () => applyAgentDefinitionTransforms(base, [
      { id: "duplicate", apply: (definition) => definition },
      { id: "duplicate", apply: (definition) => definition },
    ]),
    /duplicate definition transform/,
  );
  assert.throws(
    () => applyAgentDefinitionTransforms(base, [
      { id: "invalid", apply: () => undefined },
    ]),
    /returned invalid definition/,
  );
});

test("workspace discovery stays off the root SDK surface", async () => {
  const [root, compatibility] = await Promise.all([
    import("../dist/index.js"),
    import("../dist/agent-environment.js"),
  ]);
  assert.equal(root.loadAgentEnvironment, undefined);
  assert.equal(typeof compatibility.loadAgentEnvironment, "function");
  assert.equal(typeof compatibility.createAgentEnvironmentTransform, "function");
});
