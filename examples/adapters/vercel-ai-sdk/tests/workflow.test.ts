import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { reviewProcurementRequest } from "../src/workflow.ts";

const request = {
  requestId: "pr-1042",
  vendorName: "Acme Analytics",
  annualSpendUsd: 75_000,
  dataClasses: ["customer_contact_data"],
  controlEvidence: [
    "SOC 2 Type II report valid through 2027-01-31",
    "DPA includes 72-hour incident notification",
  ],
};

test("exact native ToolLoopAgent uses Caveman boundary, lifecycle, and usage seams", async () => {
  const model = mockModel(JSON.stringify({
    disposition: "conditional",
    summary: "Security evidence is current; retention terms remain unresolved.",
    conditions: ["Resolve retention schedule before contract execution"],
    evidence: request.controlEvidence,
    executionStatus: "not_executed",
  }));
  const result = await reviewProcurementRequest({ request, model });

  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(model.doGenerateCalls[0]?.temperature, 0);
  assert.equal(result.recommendation.disposition, "conditional");
  assert.equal(result.recommendation.executionStatus, "not_executed");
  assert.equal(result.integration.adapterId, "vercel-ai-sdk");
  assert.equal(result.integration.upstreamVersion, "7.0.84");
  assert.deepEqual(result.integration.lifecycle.map((event) => event.phase), [
    "run.started",
    "model.requested",
    "model.responded",
    "run.completed",
  ]);
  assert.equal(result.integration.usage.length, 1);
  assert.deepEqual(result.integration.usage[0], {
    schemaVersion: 1,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 12,
    cost: { status: "unpriced" },
  });
});

test("application rejects invented evidence", async () => {
  const model = mockModel(JSON.stringify({
    disposition: "proceed",
    summary: "Looks complete.",
    conditions: [],
    evidence: ["ISO 27001 certified"],
    executionStatus: "not_executed",
  }));
  await assert.rejects(
    reviewProcurementRequest({ request, model }),
    /procurement_evidence_not_supplied/,
  );
});

test("pre-aborted request never reaches native model", async () => {
  const model = mockModel("unreachable");
  const controller = new AbortController();
  controller.abort(new Error("fixture-abort"));
  await assert.rejects(reviewProcurementRequest({
    request,
    model,
    signal: controller.signal,
  }));
  assert.equal(model.doGenerateCalls.length, 0);
});

function mockModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 2, text: 2, reasoning: 0 },
      },
      warnings: [],
    },
  });
}
