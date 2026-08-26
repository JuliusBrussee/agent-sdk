import assert from "node:assert/strict";
import test from "node:test";
import {
  CODING_CACHE_INPUT_TOKEN_HIT_TARGET,
  analyzeProviderCachePerformance,
} from "../dist/cache-planner/index.js";

test("provider cache performance measures cached share of all provider input", () => {
  const performance = analyzeProviderCachePerformance([{
    usageBasis: "provider_reported",
    inputTokens: 1_000,
    cacheReadTokens: 98_000,
    cacheWriteTokens: 1_000,
  }]);

  assert.equal(CODING_CACHE_INPUT_TOKEN_HIT_TARGET, 0.98);
  assert.deepEqual(performance, {
    basis: "provider_reported",
    target: 0.98,
    providerInputTokens: 100_000,
    uncachedInputTokens: 1_000,
    cacheReadTokens: 98_000,
    cacheWriteTokens: 1_000,
    cacheInputTokenHitRatio: 0.98,
    targetMet: true,
  });
});

test("cache performance fails closed when provider usage is unavailable", () => {
  const performance = analyzeProviderCachePerformance([
    {
      usageBasis: "provider_reported",
      inputTokens: 100,
      cacheReadTokens: 9_900,
      cacheWriteTokens: 0,
    },
    {
      usageBasis: "unavailable",
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ]);

  assert.equal(performance.basis, "unavailable");
  assert.equal(performance.cacheInputTokenHitRatio, null);
  assert.equal(performance.targetMet, null);
});

test("zero provider input and invalid target never mint a hit rate", () => {
  const empty = analyzeProviderCachePerformance([]);
  assert.equal(empty.basis, "unavailable");
  assert.equal(empty.cacheInputTokenHitRatio, null);
  assert.equal(empty.targetMet, null);
  assert.throws(
    () => analyzeProviderCachePerformance([], 1.01),
    /cave_cache_hit_target_invalid/,
  );
});
