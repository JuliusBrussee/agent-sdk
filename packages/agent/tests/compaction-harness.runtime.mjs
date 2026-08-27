import test from "node:test";
import assert from "node:assert/strict";
import {
  runContextCompactionHarness,
} from "../dist/compaction-harness.js";

const constraint = "Never publish while release checks fail.";

const fixture = {
  id: "release-contract",
  rounds: [
    {
      messages: [{ role: "user", content: `${constraint}\n${"x".repeat(8_000)}`, timestamp: 1 }],
      expected: [{
        key: "release-gate",
        kind: "constraint",
        text: constraint,
        critical: true,
        weight: 5,
      }],
    },
    {
      messages: [{
        role: "assistant",
        content: `Implementation complete.\n${"y".repeat(8_000)}`,
        timestamp: 2,
      }],
      expected: [{
        key: "release-gate",
        kind: "constraint",
        text: constraint,
        critical: true,
        weight: 5,
      }],
    },
  ],
};

function oracle(request) {
  const source = request.round === 1
    ? request.sources[0]
    : request.previous.anchors[0];
  return JSON.stringify({
    schema_version: 2,
    generation: request.round,
    objective: "Ship safely.",
    anchors: [{
      key: "release-gate",
      kind: "constraint",
      text: constraint,
      critical: true,
      source_segment_id: source.segmentId ?? source.sourceSegmentId,
      source_digest: source.digest ?? source.sourceDigest,
    }],
    constraints_restated: [constraint],
    decisions: [],
    artifacts: [],
    facts: [],
    state: { completed: [], active: ["implementation"], blocked: [] },
    next: ["run checks"],
    citations: [],
    lookup_hints: [],
  });
}

test("injected summarizer harness repeats full generational fixture", async () => {
  const result = await runContextCompactionHarness(fixture, oracle, { repetitions: 25 });
  assert.equal(result.rounds, 50);
  assert.equal(result.validRounds, 50);
  assert.equal(result.criticalAnchorRecall, 1);
  assert.equal(result.weightedAnchorRecall, 1);
  assert.equal(result.exactRecoveryCoverage, 1);
  assert.equal(result.stable, true);
  assert.deepEqual(result.failures, []);
});

test("harness fails closed and identifies nondeterministic semantic drift", async () => {
  const result = await runContextCompactionHarness(
    fixture,
    (request) => {
      if (request.repetition === 3 && request.round === 2) {
        return JSON.stringify({
          ...JSON.parse(oracle(request)),
          anchors: [{
            ...JSON.parse(oracle(request)).anchors[0],
            text: "Publish when likely safe.",
          }],
        });
      }
      return oracle(request);
    },
    { repetitions: 5 },
  );
  assert.equal(result.stable, false);
  assert.equal(result.validRounds, 9);
  assert.equal(result.failures.some((item) =>
    item === "repetition_3:round_2:critical_anchor_lost:release-gate"), true);
  assert.equal(result.failures.includes("repetition_3:round_2:evaluation"), true);
});

test("harness rejects malformed adapter output without treating it as an empty summary", async () => {
  const result = await runContextCompactionHarness(
    fixture,
    (request) => request.round === 1 ? "not-json" : oracle(request),
    { repetitions: 1 },
  );
  assert.equal(result.stable, false);
  assert.equal(result.validRounds, 0);
  assert.equal(result.failures[0], "repetition_1:round_1:parse");
});

test("harness validates repeat count before invoking adapter", async () => {
  await assert.rejects(
    runContextCompactionHarness(fixture, oracle, { repetitions: 0 }),
    /cave_compaction_repetitions_invalid/,
  );
});
