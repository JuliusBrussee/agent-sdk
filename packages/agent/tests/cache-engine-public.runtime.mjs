import assert from "node:assert/strict";
import test from "node:test";
import {
  CacheEngine,
  CachePlanEngine,
  ReasonNoExpectedReuse,
  detectVolatile,
} from "@caveman-ai/agent/cache-engine";

test("public CacheEngine subpath exposes deterministic planner contract", () => {
  assert.equal(CacheEngine, CachePlanEngine);
  assert.equal(detectVolatile(new TextEncoder().encode("stable")), false);
  const result = new CacheEngine().plan({
    scope: "agent/workflow",
    epoch: "session/epoch",
    expectedCalls: 1,
    profile: {
      id: "test-explicit",
      mode: "explicit",
      attribution: "causal",
      minPrefixTokens: 1,
      maxBreakpoints: 1,
      economicsKnown: true,
      writeMultiplier: 1.25,
      readMultiplier: 0.1,
      ttlSeconds: 300,
      rolling: true,
      routingKey: false,
      optimizerId: "test-cache",
    },
    segments: [{
      name: "instructions",
      content: "stable prefix",
      tokens: 10,
      stable: true,
      cacheable: true,
    }],
  });
  assert.equal(result.decision, "pass_through");
  assert.equal(result.reason, ReasonNoExpectedReuse);
});
