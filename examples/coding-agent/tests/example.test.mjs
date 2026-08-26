import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../agent.mjs";
import { defaultCodingPlan, RECOVERABLE_CODING_TRANSFORMS } from "@caveman-ai/coding-agent";

test("example exposes a session entry point without running one", () => {
  assert.equal(typeof main, "function");
});

test("the default plan this example ships routes only recoverable transforms", () => {
  const plan = defaultCodingPlan("anthropic/claude-sonnet-4-6", "caveman-code");
  assert.equal(plan.segment_routes.length > 0, true);
  for (const route of plan.segment_routes) {
    assert.equal(RECOVERABLE_CODING_TRANSFORMS.includes(route.transform_id), true);
  }
});
