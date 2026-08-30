import assert from "node:assert/strict";
import { test } from "node:test";

import { SUPPORTED_GRADER_TYPES, grade, modelFamily } from "../dist/index.js";

const expectedTypes = [
  "exact_match",
  "contains",
  "not_contains",
  "regex",
  "not_regex",
  "blocklist",
  "json_schema",
  "json_path_assertion",
  "tool_called",
  "tool_not_called",
  "tool_sequence",
  "tool_argument_assertion",
  "http_status",
  "latency_threshold",
  "cost_threshold",
  "token_threshold",
  "bleu_score",
  "rouge_score",
  "context_f1",
  "no_pii",
  "custom_webhook",
  "localization_f1",
  "llm_judge",
  "llm_score",
  "llm_category",
  "llm_pairwise",
  "llm_answer_match",
];

const probes = {
  exact_match: [{ type: "exact_match", expected: "x" }, "x"],
  contains: [{ type: "contains", fragments: ["x"] }, "x"],
  not_contains: [{ type: "not_contains", fragments: ["z"] }, "x"],
  regex: [{ type: "regex", pattern: "x" }, "x"],
  not_regex: [{ type: "not_regex", pattern: "z" }, "x"],
  blocklist: [{ type: "blocklist", terms: ["z"] }, "x"],
  json_schema: [{ type: "json_schema", schema: { type: "string" } }, "x"],
  json_path_assertion: [{ type: "json_path_assertion", path: "x", exists: true }, { x: 1 }],
  tool_called: [{ type: "tool_called", tools: ["x"] }, { tool_calls: [{ name: "x" }] }],
  tool_not_called: [{ type: "tool_not_called", tools: ["z"] }, { tool_calls: [{ name: "x" }] }],
  tool_sequence: [{ type: "tool_sequence", tools: ["x"] }, { tool_calls: [{ name: "x" }] }],
  tool_argument_assertion: [
    { type: "tool_argument_assertion", tool: "x", path: "n", equals: 1 },
    { tool_calls: [{ name: "x", arguments: { n: 1 } }] },
  ],
  http_status: [{ type: "http_status", status: 200 }, { status: 200 }],
  latency_threshold: [{ type: "latency_threshold", p95_ms: 1 }, { p95_ms: 1 }],
  cost_threshold: [{ type: "cost_threshold", max_usd: 1 }, { cost_usd: 1 }],
  token_threshold: [{ type: "token_threshold", max_tokens: 1 }, { tokens: 1 }],
  bleu_score: [{ type: "bleu_score", reference: "x" }, "x"],
  rouge_score: [{ type: "rouge_score", reference: "x" }, "x"],
  context_f1: [{ type: "context_f1", retrieved: ["x"], expected: ["x"] }, null],
  no_pii: [{ type: "no_pii" }, "clean"],
  custom_webhook: [{ type: "custom_webhook", url: "" }, null],
  localization_f1: [
    { type: "localization_f1", reference: [{ path: "a.ts", lines: [[1, 1]] }] },
    [{ path: "a.ts", lines: [[1, 1]] }],
  ],
  llm_judge: [{ type: "llm_judge", rubric: "" }, "x"],
  llm_score: [{ type: "llm_score", rubric: "", min_score: 1 }, "x"],
  llm_category: [
    { type: "llm_category", prompt: "", categories: [], passing_categories: [] },
    "x",
  ],
  llm_pairwise: [{ type: "llm_pairwise", baseline: "", criteria: "" }, "x"],
  llm_answer_match: [{ type: "llm_answer_match", expected: "" }, "x"],
};

test("published taxonomy has exactly 27 unique canonical names", () => {
  assert.equal(SUPPORTED_GRADER_TYPES.size, 27);
  assert.deepEqual([...SUPPORTED_GRADER_TYPES], expectedTypes);
});

test("published taxonomy cannot be mutated by a consumer", () => {
  assert.equal(Object.isFrozen(SUPPORTED_GRADER_TYPES), true);
  assert.equal("add" in SUPPORTED_GRADER_TYPES, false);
  assert.throws(
    () => Set.prototype.add.call(SUPPORTED_GRADER_TYPES, "consumer_minted"),
    TypeError,
  );
  assert.deepEqual([...SUPPORTED_GRADER_TYPES], expectedTypes);
});

test("every published taxonomy entry reaches a dispatch branch without network I/O", async () => {
  for (const type of expectedTypes) {
    const [grader, candidate] = probes[type];
    const result = await grade(grader, candidate, {
      fetch: async () => {
        throw new Error("taxonomy probe reached network");
      },
      resolutionPinnedFetch: async () => {
        throw new Error("taxonomy probe reached network");
      },
    });
    assert.equal(result.reason.startsWith("unknown grader type"), false, type);
  }
});

test("unknown taxonomy entry fails closed", async () => {
  const result = await grade({ type: "unknown" }, "x");
  assert.deepEqual(result, { passed: false, reason: "unknown grader type: unknown" });
});

test("model family classification is stable for known and unknown ids", () => {
  assert.equal(modelFamily("anthropic/claude-sonnet-4-6"), "anthropic");
  assert.equal(modelFamily("openai/gpt-5.5"), "openai");
  assert.equal(modelFamily("vendor/custom-v1"), "custom-v1");
  assert.equal(modelFamily(""), "");
});
