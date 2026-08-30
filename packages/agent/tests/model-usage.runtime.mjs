import assert from "node:assert/strict";
import test from "node:test";

import {
  defineModelUsage,
  modelUsageAccountingStatus,
  requireCompleteModelUsage,
} from "../dist/model-usage.js";

function complete(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "openai",
    model: "gpt-5.4",
    inputTokens: 10,
    outputTokens: 7,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 3,
    totalTokens: 20,
    cost: { status: "estimated", basis: "public_catalog", usd: 0.002 },
    ...overrides,
  };
}

test("model usage preserves complete disjoint accounting", () => {
  const usage = defineModelUsage(complete());
  assert.equal(modelUsageAccountingStatus(usage), "complete_priced");
  assert.deepEqual(requireCompleteModelUsage(usage), usage);
  assert.equal(Object.isFrozen(usage), true);
  assert.equal(Object.isFrozen(usage.cost), true);
});

test("unknown usage remains null and never becomes zero", () => {
  const usage = defineModelUsage(complete({
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: 19,
    cost: { status: "unknown" },
  }));
  assert.equal(usage.cacheWriteTokens, null);
  assert.equal(usage.reasoningTokens, null);
  assert.equal(modelUsageAccountingStatus(usage), "incomplete");
  assert.throws(() => requireCompleteModelUsage(usage), /cave_model_usage_incomplete/);
});

test("zero is known while malformed totals and reasoning fail closed", () => {
  assert.equal(defineModelUsage(complete({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cost: { status: "unpriced" },
  })).totalTokens, 0);
  assert.throws(
    () => defineModelUsage(complete({ totalTokens: 19 })),
    /cave_model_usage_invalid:totalTokens/,
  );
  assert.throws(
    () => defineModelUsage(complete({ reasoningTokens: 8 })),
    /cave_model_usage_invalid:reasoningTokens/,
  );
});

test("estimated and unpriced cost require complete token evidence", () => {
  assert.throws(
    () => defineModelUsage(complete({ inputTokens: null })),
    /cave_model_usage_invalid:cost/,
  );
  assert.throws(
    () => defineModelUsage(complete({
      inputTokens: null,
      cost: { status: "unpriced" },
    })),
    /cave_model_usage_invalid:cost/,
  );
  assert.equal(modelUsageAccountingStatus(defineModelUsage(complete({
    cost: { status: "unpriced" },
  }))), "complete_unpriced");
});

test("usage boundaries reject extra inherited accessor and custom data", () => {
  assert.throws(
    () => defineModelUsage({ ...complete(), extra: true }),
    /cave_model_usage_invalid/,
  );
  const accessor = complete();
  let reads = 0;
  Object.defineProperty(accessor, "model", {
    enumerable: true,
    get() {
      reads++;
      return "gpt-5.4";
    },
  });
  assert.throws(() => defineModelUsage(accessor), /cave_model_usage_invalid/);
  assert.equal(reads, 0);
  assert.throws(
    () => defineModelUsage(Object.assign(Object.create({ model: "forged" }), complete())),
    /cave_model_usage_invalid/,
  );
});

test("partial totals cannot be below known disjoint usage", () => {
  const partial = complete({
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: 12,
    cost: { status: "unknown" },
  });
  assert.throws(
    () => defineModelUsage(partial),
    /cave_model_usage_invalid:totalTokens/,
  );
  assert.equal(defineModelUsage({ ...partial, totalTokens: 13 }).totalTokens, 13);
});
