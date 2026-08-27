import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contextSummarySources,
  parseContextSummary,
} from "../dist/compaction.js";
import {
  evaluateContextSummary,
  evaluateContextSummaryStability,
} from "../dist/compaction-eval.js";

function capsule(generation, source, text = "Never publish while release checks fail.") {
  return parseContextSummary(JSON.stringify({
    schema_version: 2,
    generation,
    objective: "Ship safely.",
    anchors: [{
      key: "release-gate",
      kind: "constraint",
      text,
      critical: true,
      source_segment_id: source.segmentId,
      source_digest: source.digest,
    }],
    constraints_restated: [text],
    decisions: [],
    artifacts: [],
    facts: [],
    state: { completed: [], active: ["implementation"], blocked: [] },
    next: ["run checks"],
    citations: [{
      segment_id: "runtime.tool_result.4",
      digest: "b".repeat(64),
      what: "recoverable output",
    }],
    lookup_hints: [],
  }));
}

test("50 repeated rounds retain every critical anchor byte-for-byte", () => {
  const message = {
    role: "user",
    content: "Never publish while release checks fail.",
    timestamp: 1,
  };
  const [source] = contextSummarySources([message], [0]);
  const rounds = Array.from({ length: 50 }, (_, index) => ({
    summary: capsule(index + 1, source),
    sources: index === 0 ? [source] : [],
  }));
  const result = evaluateContextSummaryStability(rounds);
  assert.deepEqual(result, {
    rounds: 50,
    validTransitions: 50,
    criticalAnchorRetention: 1,
    stable: true,
    failures: [],
  });
});

test("stability evaluator exposes exact round and failure on drift", () => {
  const [source] = contextSummarySources([
    { role: "user", content: "Never publish while release checks fail.", timestamp: 1 },
  ], [0]);
  const result = evaluateContextSummaryStability([
    { summary: capsule(1, source), sources: [source] },
    { summary: capsule(2, source, "Publish when likely safe."), sources: [] },
  ]);
  assert.equal(result.stable, false);
  assert.equal(result.validTransitions, 1);
  assert.equal(result.criticalAnchorRetention, 0);
  assert.equal(result.failures.includes("round_2:critical_anchor_lost:release-gate"), true);
});

test("evaluation reports recall, recoverability, compression, and density separately", () => {
  const [source] = contextSummarySources([
    { role: "user", content: "Never publish while release checks fail.", timestamp: 1 },
  ], [0]);
  const summary = capsule(1, source);
  const result = evaluateContextSummary(summary, {
    expected: [{
      key: "release-gate",
      kind: "constraint",
      text: "Never publish while release checks fail.",
      critical: true,
      weight: 5,
    }],
    sourceTokens: 1_000,
    compactedTokens: 100,
    expectedRecoveryDigests: ["b".repeat(64)],
  });
  assert.deepEqual(result, {
    criticalAnchorRecall: 1,
    weightedAnchorRecall: 1,
    exactRecoveryCoverage: 1,
    compressionRatio: 10,
    commitmentDensity: 0.01,
    stable: true,
  });
});

test("user-grounded supersession counts as stable critical continuity", () => {
  const [firstSource] = contextSummarySources([
    { role: "user", content: "Use port 3000.", timestamp: 1 },
  ], [0]);
  const [secondSource] = contextSummarySources([
    { role: "user", content: "Change port to 4000; this replaces port 3000.", timestamp: 2 },
  ], [0]);
  const base = (generation, anchor) => parseContextSummary(JSON.stringify({
    schema_version: 2,
    generation,
    objective: "Run service.",
    anchors: [anchor],
    constraints_restated: [anchor.text],
    decisions: [],
    artifacts: [],
    facts: [],
    state: { completed: [], active: [], blocked: [] },
    next: [],
    citations: [],
    lookup_hints: [],
  }));
  const first = base(1, {
    key: "port-3000",
    kind: "constraint",
    text: "Use port 3000.",
    critical: true,
    source_segment_id: firstSource.segmentId,
    source_digest: firstSource.digest,
  });
  const second = base(2, {
    key: "port-4000",
    kind: "constraint",
    text: "Use port 4000.",
    critical: true,
    source_segment_id: secondSource.segmentId,
    source_digest: secondSource.digest,
    supersedes: ["port-3000"],
  });
  const result = evaluateContextSummaryStability([
    { summary: first, sources: [firstSource] },
    { summary: second, sources: [secondSource] },
  ]);
  assert.deepEqual(result, {
    rounds: 2,
    validTransitions: 2,
    criticalAnchorRetention: 1,
    stable: true,
    failures: [],
  });
});
