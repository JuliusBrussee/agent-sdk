import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capabilityManifestFor,
  compileProfiled,
  executeCompiledPipeline,
  assertProfiledBuildTarget,
  nativePiCompilerTarget,
} from "../dist/compiler.js";
import { createHarnessAdapter } from "../dist/adapters.js";
import { catalogCost } from "../dist/catalog.js";
import {
  buildPolicySHA256,
  compilerPassIDsForPlanDiff,
  defineBuild,
  nativePiPlanLoweringErrors,
  nativePiRequiredSemanticsForPlanDiff,
  parseCaveBuildLockV3,
} from "../dist/build.js";
import {
  agent,
  auto,
  createCompilerWorkloadProfile,
  createWorkloadProfile,
  eval as defineEval,
  normalizeTrajectory,
  parseWorkloadProfile,
  schema,
  sha256,
  stableStringify,
  tool,
} from "../dist/index.js";

const hex = (value) => value.repeat(64);

function runResult(id, overrides = {}) {
  return {
    runId: id,
    agentId: "profiled-agent",
    text: `raw-secret-${id}`,
    contextIR: { schemaVersion: 1, segments: [] },
    contextBill: {},
    cachePrefixSHA256: hex("c"),
    cacheBoundaryKnown: true,
    cacheBust: false,
    usageBasis: "provider_reported",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningUsageBasis: "provider_reported",
    reasoningTokens: 0,
    costUsd: 0.01,
    priceBasis: "public_catalog",
    mode: "optimized",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    latencyMs: 20,
    toolCalls: [],
    evaluatedTransformIDs: [],
    transformIDs: [],
    transformFailures: [],
    transformTrace: [],
    recoveryResolved: true,
    stopReason: "complete",
    capBreached: false,
    overspent: 0,
    receipt: { calls: [{}], tools: [] },
    claimBasis: "inferred",
    unlocked: true,
    ...overrides,
  };
}

function trajectory(split, id, overrides = {}) {
  return normalizeTrajectory(runResult(id, overrides), {
    split,
    caseId: `case-${id}`,
    lineageId: `lineage-${id}`,
    inputSha256: sha256(`input-${id}`),
  });
}

function profile() {
  return createCompilerWorkloadProfile([trajectory("profile", "p")]);
}

function plan(id) {
  return {
    schema_version: 1,
    plan_id: id,
    model: "anthropic/claude-haiku-4-5",
    reasoning: "low",
    segment_routes: [],
    budgets: {
      instructions: 25_000,
      tools: 1_000,
      memory: 0,
      history: 1_000,
      results_artifacts: 1_000,
      reasoning: 500,
      output: 500,
      retry_cascade_reserve: 0,
    },
    recovery: { namespace: "profiled", tools: [] },
    fallbacks: { unknown: "original", transform_error: "original", not_smaller: "original" },
  };
}

function fixture(id) {
  return defineEval({
    id,
    lineageId: `lineage-${id}`,
    split: id.startsWith("development-") ? "development" : "holdout",
    approved: true,
    input: id,
    quality: [{ type: "exact_match", expected: "ok" }],
  });
}

function evidence({ cost = 0.01, passed = true, cacheRead = 0, latency = 10.25 } = {}) {
  const cacheWrite = 0;
  const inputTokens = Math.max(0, Math.round(cost * 1_000_000 - cacheRead * 0.1));
  return {
    terminal: true,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    usage_basis: "provider_reported",
    price_basis: "public_catalog",
    catalog_cost_usd: cost,
    input_tokens: inputTokens,
    output_tokens: 0,
    reasoning_tokens: 0,
    quality_score: passed ? 1 : 0,
    graders: [{ type: "exact_match", passed }],
    latency_ms: latency,
    provider_visible_tokens: inputTokens + cacheRead + cacheWrite,
    cache_prefix_sha256: hex("c"),
    cache_boundary_known: true,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    cache_bust: false,
    error: false,
    recovery_resolved: true,
    privacy_passed: true,
    sandbox_passed: true,
    output_digest: hex("a"),
  };
}

function profiledInput(target, overrides = {}) {
  const baseline = plan("baseline");
  return {
    agent: agent({ id: "profiled-agent", instructions: "Be exact.", model: auto(), sandbox: "fixture" }),
    contextIR: { schemaVersion: 1, segments: [] },
    profile: profile(),
    developmentEvals: [fixture("development-a"), fixture("development-b")],
    holdoutEvals: [fixture("holdout-a"), fixture("holdout-b")],
    developmentSeeds: [1, 2, 3, 4, 5],
    holdoutSeeds: [1, 2, 3, 4, 5],
    candidates: [
      { plan: baseline, estimated_cost_usd_per_run: 0.02 },
    ],
    baselinePlan: baseline,
    config: {
      entry: "src/agent.ts",
      evals: "evals/*.ts",
      efficiency: "max",
      requiredFixturePassRate: 1,
      qualityRetention: 0.98,
      maxSearchCostUsd: 10,
      lock: "strict",
      sandbox: "required",
    },
    sourceSha256: hex("1"),
    catalogSha256: hex("2"),
    transformRegistrySha256: hex("3"),
    runtimeVersion: "0.2.0",
    target,
    developmentRunner: async ({ plan: candidate }) =>
      evidence({ cost: candidate.plan_id === "optimized" ? 0.01 : 0.02 }),
    holdoutRunner: async ({ plan: candidate }) =>
      evidence({ cost: candidate.plan_id === "optimized" ? 0.01 : 0.02 }),
    ...overrides,
  };
}

test("workload profile is deterministic, content-blind, and reports evidence completeness", () => {
  const rows = [
    trajectory("profile", "p"),
    trajectory("development", "d"),
    trajectory("holdout", "h"),
  ];
  const first = createWorkloadProfile(rows);
  const second = createWorkloadProfile([...rows].reverse());
  assert.equal(first.profile_sha256, second.profile_sha256);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).includes("raw-secret"), false);
  assert.equal(first.partitions.development.provider_reported_count, 1);
  assert.equal(first.partitions.development.usage_incomplete_count, 0);
  assert.equal(first.partitions.development.priced_count, 1);
  assert.equal(first.partitions.development.unpriced_count, 0);
});

test("compiler profile permits both validation partitions pending, never one", () => {
  const pending = createCompilerWorkloadProfile([trajectory("profile", "profile-only")]);
  assert.equal(pending.partitions.development.trajectory_count, 0);
  assert.equal(pending.partitions.holdout.trajectory_count, 0);
  assert.deepEqual(parseWorkloadProfile(pending), pending);

  const partial = structuredClone(pending);
  partial.partitions.development.trajectory_count = 1;
  assert.throws(
    () => parseWorkloadProfile(partial),
    /cave_profile_invalid:partial_validation_partition/,
  );
});

test("span import rejects raw prompt/result attributes", () => {
  assert.throws(() => normalizeTrajectory({
    traceId: "trace",
    spanId: "span",
    attributes: {
      "llm.input.value": "raw secret",
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "claude-haiku-4-5",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 2,
      "cave.latency_ms": 1,
    },
  }, { split: "profile", caseId: "case", lineageId: "family", inputSha256: hex("f") }), /cave_trajectory_raw_content_refused/);
  assert.throws(() => normalizeTrajectory({
    traceId: "trace",
    spanId: "span",
    attributes: { "llm.output_messages.0.message.content": "raw secret" },
  }, { split: "profile", caseId: "case", lineageId: "family", inputSha256: hex("f") }), /cave_trajectory_raw_content_refused/);
});

test("context bills accept only canonical context kinds", () => {
  for (const key of ["unknown_bucket", "api_key"]) {
    assert.throws(() => normalizeTrajectory(runResult(`context-${key}`, {
      contextBill: { [key]: 1 },
    }), {
      split: "profile",
      caseId: `case-${key}`,
      lineageId: `family-${key}`,
      inputSha256: hex("f"),
    }), /cave_trajectory_invalid:context_bill/);
  }
  assert.deepEqual(trajectory("profile", "canonical-context", {
    contextBill: { instruction: 3, history: 2, tool_result: 1 },
  }).context_bill, { history: 2, instruction: 3, tool_result: 1 });
});

test("Caveman-shaped trace cost is recomputed from pinned catalog", () => {
  const repriced = trajectory("profile", "forged-cost", { costUsd: 999 });
  assert.equal(repriced.price_basis, "public_catalog");
  assert.equal(repriced.cost_usd, 0.00015);

  const unknown = trajectory("profile", "unknown-model", {
    model: "unknown-model",
    costUsd: 999,
  });
  assert.equal(unknown.price_basis, "unpriced");
  assert.equal(unknown.cost_usd, 0);
});

test("scheduled Caveman trace requires one explicit unchanged accounting window", () => {
  const value = runResult("scheduled-trace", {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    inputTokens: 100,
    outputTokens: 10,
    costUsd: 999,
  });
  const options = {
    split: "profile",
    caseId: "scheduled-case",
    lineageId: "scheduled-family",
    inputSha256: hex("f"),
  };
  const missing = normalizeTrajectory(value, options);
  assert.equal(missing.price_basis, "unpriced");
  assert.equal(missing.cost_usd, 0);
  const stable = normalizeTrajectory(value, {
    ...options,
    accountingStartedAt: new Date("2026-08-17T01:00:00Z"),
    accountingFinishedAt: new Date("2026-08-17T03:59:59Z"),
  });
  assert.equal(stable.price_basis, "public_catalog");
  assert.equal(stable.cost_usd, 0.0000572);
  const crossing = normalizeTrajectory(value, {
    ...options,
    accountingStartedAt: new Date("2026-08-17T00:59:59Z"),
    accountingFinishedAt: new Date("2026-08-17T01:00:00Z"),
  });
  assert.equal(crossing.price_basis, "unpriced");
  assert.equal(crossing.cost_usd, 0);
});

test("OpenInference numeric usage attributes remain content-blind", () => {
  const imported = normalizeTrajectory({
    traceId: "openinference-trace",
    spanId: "openinference-span",
    status: { code: 1 },
    attributes: {
      "openinference.span.kind": "LLM",
      "llm.provider": "anthropic",
      "llm.model_name": "claude-haiku-4-5",
      "llm.token_count.prompt": 10,
      "llm.token_count.completion": 2,
      "cave.latency_ms": 1,
      "cave.price_basis": "public_catalog",
      "cave.cost_usd": 0.001,
    },
  }, { split: "profile", caseId: "case", lineageId: "family", inputSha256: hex("f") });
  assert.equal(imported.source, "openinference_span");
  assert.equal(imported.input_tokens, 10);
  assert.equal(imported.output_tokens, 2);
  assert.equal(imported.outcome, "complete");
  assert.equal(imported.price_basis, "unpriced");
  assert.equal(imported.cost_usd, 0);

  assert.throws(() => normalizeTrajectory({
    traceId: "trace",
    spanId: "span",
    attributes: { "llm.token_count.prompt": "10" },
  }, { split: "profile", caseId: "case", lineageId: "family", inputSha256: hex("f") }), /cave_trajectory_raw_content_refused/);
});

test("OTLP ProtoJSON integer usage and string status normalize safely", () => {
  const imported = normalizeTrajectory({
    traceId: "otlp-trace",
    spanId: "otlp-span",
    status: { code: "STATUS_CODE_OK" },
    attributes: [
      { key: "openinference.span.kind", value: { stringValue: "LLM" } },
      { key: "llm.provider", value: { stringValue: "anthropic" } },
      { key: "llm.model_name", value: { stringValue: "claude-haiku-4-5" } },
      { key: "llm.token_count.prompt", value: { intValue: "10" } },
      { key: "llm.token_count.completion", value: { intValue: "2" } },
      { key: "cave.latency_ms", value: { intValue: "7" } },
    ],
  }, { split: "profile", caseId: "case", lineageId: "family", inputSha256: hex("f") });
  assert.equal(imported.input_tokens, 10);
  assert.equal(imported.output_tokens, 2);
  assert.equal(imported.latency_ms, 7);
  assert.equal(imported.outcome, "complete");

  for (const intValue of ["-1", "1.5", "1e3", "9007199254740992"]) {
    assert.throws(() => normalizeTrajectory({
      traceId: `bad-${intValue}`,
      spanId: "span",
      attributes: [
        { key: "gen_ai.system", value: { stringValue: "anthropic" } },
        { key: "gen_ai.request.model", value: { stringValue: "claude-haiku-4-5" } },
        { key: "gen_ai.usage.input_tokens", value: { intValue } },
        { key: "gen_ai.usage.output_tokens", value: { intValue: "2" } },
        { key: "cave.latency_ms", value: { intValue: "1" } },
      ],
    }, { split: "profile", caseId: "case", lineageId: "family", inputSha256: hex("f") }),
    /cave_trajectory_span_attribute_value_invalid/);
  }
});

test("span tool effects come only from caller-owned declarations", () => {
  const span = {
    traceId: "tool-trace",
    spanId: "tool-span",
    status: { code: 1 },
    attributes: {
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "claude-haiku-4-5",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 2,
      "cave.latency_ms": 1,
      "tool.name": "dangerous_shell",
      "tool.effect": "read",
    },
  };
  const untrusted = normalizeTrajectory(span, {
    split: "profile", caseId: "case-untrusted", lineageId: "family-untrusted",
    inputSha256: hex("f"),
  });
  assert.equal(untrusted.tools[0].effect, "external");
  const declared = normalizeTrajectory(span, {
    split: "profile", caseId: "case-declared", lineageId: "family-declared",
    inputSha256: hex("e"),
    toolEffects: { dangerous_shell: "write" },
  });
  assert.equal(declared.tools[0].effect, "write");
});

test("span public-catalog label without cost evidence downgrades to unpriced", () => {
  const imported = normalizeTrajectory({
    traceId: "unpriced-trace",
    spanId: "unpriced-span",
    status: { code: "STATUS_CODE_OK" },
    attributes: {
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "claude-haiku-4-5",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 2,
      "cave.latency_ms": 1,
      "cave.price_basis": "public_catalog",
    },
  }, { split: "profile", caseId: "case", lineageId: "family", inputSha256: hex("f") });
  assert.equal(imported.price_basis, "unpriced");
  assert.equal(imported.cost_usd, 0);
});

test("span caller cost cannot mint public-catalog evidence", () => {
  const imported = normalizeTrajectory({
    traceId: "priced-trace",
    spanId: "priced-span",
    status: { code: "STATUS_CODE_OK" },
    attributes: {
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "claude-haiku-4-5",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 2,
      "cave.usage_basis": "provider_reported",
      "cave.price_basis": "public_catalog",
      "cave.cost_usd": 999,
      "cave.latency_ms": 1,
    },
  }, { split: "profile", caseId: "priced-case", lineageId: "priced-family", inputSha256: hex("f") });
  assert.equal(imported.usage_basis, "unavailable");
  assert.equal(imported.price_basis, "unpriced");
  assert.equal(imported.cost_usd, 0);
});

test("case variants from one lineage cannot cross workload splits", () => {
  const profileRow = normalizeTrajectory(runResult("p"), {
    split: "profile", caseId: "variant-a", lineageId: "shared-family",
    inputSha256: sha256("profile-variant"),
  });
  const developmentRow = normalizeTrajectory(runResult("d"), {
    split: "development", caseId: "variant-b", lineageId: "shared-family",
    inputSha256: sha256("development-variant"),
  });
  assert.throws(() => createWorkloadProfile([
    profileRow,
    developmentRow,
    trajectory("holdout", "h"),
  ]), /cave_profile_lineage_overlap/);
});

test("profile-only workload keeps validation partitions unopened until runners", async () => {
  const target = {
    id: "pi",
    adapterVersion: "0.2.0",
    upstreamVersion: "0.83.0",
    adapterContractSHA256: hex("4"),
  };
  const pending = createCompilerWorkloadProfile([trajectory("profile", "p")]);
  assert.equal(pending.partitions.development.trajectory_count, 0);
  assert.equal(pending.partitions.holdout.trajectory_count, 0);
  const result = await compileProfiled(profiledInput(target, { profile: pending }));
  assert.equal(result.status, "locked");
  assert.equal(result.lock.selected_plan_id, "baseline");
});

test("compiler refuses pre-opened development or holdout trajectories", async () => {
  const target = {
    id: "pi",
    adapterVersion: "0.2.0",
    upstreamVersion: "0.83.0",
    adapterContractSHA256: hex("4"),
  };
  const opened = createWorkloadProfile([
    trajectory("profile", "p"),
    trajectory("development", "development-a"),
    trajectory("holdout", "holdout-a"),
  ]);
  await assert.rejects(
    compileProfiled(profiledInput(target, { profile: opened })),
    /cave_compiler_validation_profile_must_be_unopened/,
  );
});

test("profiled compiler snapshots policy and refuses cross-stage proof splicing", async () => {
  const target = {
    id: "pi",
    adapterVersion: "0.2.0",
    upstreamVersion: "0.83.0",
    adapterContractSHA256: hex("4"),
  };
  const config = { ...profiledInput(target).config };
  const expectedPolicy = buildPolicySHA256(defineBuild(config));
  const stable = await compileProfiled(profiledInput(target, {
    config,
    developmentRunner: async () => {
      config.maxSearchCostUsd = 0;
      config.qualityRetention = 0;
      return evidence({ cost: 0.02 });
    },
  }));
  assert.equal(stable.status, "locked");
  assert.equal(stable.lock.compiler.policy_sha256, expectedPolicy);

  const mutableAgent = { ...profiledInput(target).agent };
  let changed = false;
  const spliced = await compileProfiled(profiledInput(target, {
    agent: mutableAgent,
    developmentRunner: async () => {
      if (!changed) {
        changed = true;
        mutableAgent.instructions = "mutated after development identity capture";
      }
      return evidence({ cost: 0.02 });
    },
  }));
  assert.equal(spliced.status, "holdout_failed");
  assert.equal(spliced.reason, "cave_compiler_stage_identity_mismatch");
  assert.equal(spliced.lock, undefined);
});

test("compileProfiled withholds a lock when baseline fails untouched holdout", async () => {
  const target = {
    id: "pi",
    adapterVersion: "0.2.0",
    upstreamVersion: "0.83.0",
    adapterContractSHA256: hex("4"),
  };
  const input = profiledInput(target, {
    holdoutRunner: async () => evidence({ cost: 0.02, passed: false }),
  });
  const result = await compileProfiled(input);
  assert.equal(result.status, "holdout_failed");
  assert.equal(result.development.lock.selected_plan_id, "baseline");
  assert.equal(result.lock, undefined);
});

test("development and holdout reject duplicate fixture inputs even under different ids", async () => {
  const target = {
    id: "pi",
    adapterVersion: "0.2.0",
    upstreamVersion: "0.83.0",
    adapterContractSHA256: hex("4"),
  };
  const duplicateInput = defineEval({
    id: "holdout-different-id",
    lineageId: "lineage-holdout-a",
    split: "holdout",
    approved: true,
    input: "development-a",
    quality: [{ type: "exact_match", expected: "ok" }],
  });
  await assert.rejects(
    compileProfiled(profiledInput(target, { holdoutEvals: [duplicateInput] })),
    /cave_compiler_eval_input_overlap/,
  );
});

test("profile task input cannot reappear in development or holdout", async () => {
  const target = {
    id: "vercel-ai-sdk",
    adapterVersion: "0.2.0",
    upstreamVersion: "7.0.43",
    adapterContractSHA256: hex("4"),
  };
  const profileRow = normalizeTrajectory(runResult("profile-duplicate"), {
    split: "profile",
    caseId: "different-case",
    lineageId: "different-family",
    inputSha256: sha256(stableStringify("development-a")),
  });
  await assert.rejects(
    compileProfiled(profiledInput(target, {
      profile: createCompilerWorkloadProfile([profileRow]),
    })),
    /cave_compiler_profile_eval_input_overlap/,
  );
});

test("invalid target and immutable identities refuse before paid search", async () => {
  let runs = 0;
  const target = {
    id: "vercel-ai-sdk",
    adapterVersion: "",
    upstreamVersion: "7.0.43",
    adapterContractSHA256: hex("4"),
  };
  const result = await compileProfiled(profiledInput(target, {
    developmentRunner: async () => { runs++; return evidence(); },
  }));
  assert.equal(result.status, "capability_refused");
  assert.equal(result.reason, "cave_compiler_identity_invalid:adapter_version");
  assert.equal(runs, 0);

  const badSource = await compileProfiled(profiledInput({ ...target, adapterVersion: "0.2.0" }, {
    sourceSha256: "bad",
    developmentRunner: async () => { runs++; return evidence(); },
  }));
  assert.equal(badSource.status, "capability_refused");
  assert.equal(badSource.reason, "cave_compiler_identity_invalid:source_sha256");
  assert.equal(runs, 0);
});

test("Claude profiled compilation refuses before any paid runner", async () => {
  let runs = 0;
  const result = await compileProfiled(profiledInput({
    id: "claude",
    adapterVersion: "0.2.0",
    upstreamVersion: "agent-sdk-0.3.220+claude-code-2.1.220",
    adapterContractSHA256: hex("4"),
  }, {
    developmentRunner: async () => { runs++; return evidence(); },
    holdoutRunner: async () => { runs++; return evidence(); },
  }));
  assert.equal(result.status, "capability_refused");
  assert.equal(result.reason, "cave_compiler_target_not_executable:claude");
  assert.equal(runs, 0);
});

test("development and holdout reject shared task lineage with different inputs", async () => {
  const target = {
    id: "pi",
    adapterVersion: "0.2.0",
    upstreamVersion: "0.83.0",
    adapterContractSHA256: hex("4"),
  };
  const development = defineEval({
    id: "development-family-a",
    lineageId: "shared-eval-family",
    split: "development",
    approved: true,
    input: "variant a",
    quality: [{ type: "exact_match", expected: "ok" }],
  });
  const holdout = defineEval({
    id: "holdout-family-a",
    lineageId: "shared-eval-family",
    split: "holdout",
    approved: true,
    input: "variant b",
    quality: [{ type: "exact_match", expected: "ok" }],
  });
  await assert.rejects(
    compileProfiled(profiledInput(target, {
      developmentEvals: [development],
      holdoutEvals: [holdout],
    })),
    /cave_compiler_eval_lineage_overlap/,
  );
});

test("explicit unsupported target semantics refuse before paid search", async () => {
  let runs = 0;
  const target = {
    id: "vercel-ai-sdk",
    adapterVersion: "0.2.0",
    upstreamVersion: "7.0.43",
    adapterContractSHA256: hex("4"),
  };
  const definition = agent({
    id: "profiled-agent",
    instructions: "Be exact.",
    model: auto(),
    sandbox: "fixture",
    tools: [tool({
      name: "write_file",
      description: "write",
      input: schema.object({ value: schema.string() }),
      effect: "write",
      async execute() { return "ok"; },
    })],
  });
  const result = await compileProfiled(profiledInput(target, {
    agent: definition,
    requiredSemantics: ["tool_effect:write"],
    developmentRunner: async () => { runs++; return evidence(); },
  }));
  assert.equal(result.status, "capability_refused");
  assert.match(result.reason, /tool_effect:write/);
  assert.equal(runs, 0);
  assert.throws(() => capabilityManifestFor(target, ["tool_effect:external"]),
    /cave_compiler_capability_unsupported/);
});

test("native Pi plan subset derives exact passes and required semantics", () => {
  const baseline = plan("baseline");
  const selected = {
    ...baseline,
    plan_id: "optimized",
    model: "openai/gpt-5.4-mini",
    reasoning: "minimal",
    segment_routes: [{
      segment_kind: "history",
      transform_id: "caveman.engine.text.v1",
      fallback: "original",
    }],
    budgets: { ...baseline.budgets, output: 250 },
    recovery: { ...baseline.recovery, tools: ["cave_retrieve"] },
  };
  assert.deepEqual(nativePiPlanLoweringErrors(baseline, selected), []);
  assert.deepEqual(compilerPassIDsForPlanDiff(baseline, selected), [
    "context_route:history:caveman.engine.text.v1",
    "model_selection",
    "output_budget_selection",
    "profile_guided_selection",
    "reasoning_selection",
  ]);
  assert.deepEqual(nativePiRequiredSemanticsForPlanDiff(baseline, selected), [
    "abort_signal",
    "context_ir_binding",
    "model_binding",
    "output_budget_binding",
    "reasoning_binding",
    "recovery_evidence",
    "single_agent",
    "transform_evidence",
  ]);
  assert.ok(nativePiPlanLoweringErrors(baseline, {
    ...selected,
    plan_id: baseline.plan_id,
  }).includes("native_behavior_delta_plan_id_unchanged"));
  assert.ok(nativePiPlanLoweringErrors(baseline, {
    ...baseline,
    plan_id: "renamed-only",
  }).includes("native_plan_id_only_delta"));
  assert.ok(nativePiPlanLoweringErrors(baseline, {
    ...selected,
    reasoning: "high",
  }).includes("native_reasoning_increase"));
  assert.ok(nativePiPlanLoweringErrors(baseline, {
    ...selected,
    segment_routes: [
      ...selected.segment_routes,
      {
        segment_kind: "history",
        transform_id: "caveman.engine.repetition.v1",
        fallback: "original",
      },
    ],
  }).includes("native_duplicate_route_target"));
});

test("generic targets execute only the baseline from caller-supplied candidates", async () => {
  let runs = 0;
  const target = {
    id: "vercel-ai-sdk",
    adapterVersion: "0.2.0",
    upstreamVersion: "7.0.43",
    adapterContractSHA256: hex("4"),
  };
  const baseline = plan("baseline");
  const result = await compileProfiled(profiledInput(target, {
    candidates: [
      { plan: baseline, estimated_cost_usd_per_run: 0.02 },
      { plan: plan("optimized"), estimated_cost_usd_per_run: 0.01 },
    ],
    developmentRunner: async () => { runs++; return evidence(); },
  }));
  assert.equal(result.status, "locked");
  assert.equal(result.lock.selected_plan_id, "baseline");
  assert.equal(result.lock.selected_plan.budgets.output, baseline.budgets.output);
  assert.equal(runs, 10);
});

test("profile observations cannot claim unavailable behavioral lowering", async () => {
  const target = {
    id: "pi",
    adapterVersion: "0.2.0",
    upstreamVersion: "0.83.0",
    adapterContractSHA256: hex("4"),
  };
  const observedPlans = [];
  const dynamicProfile = createCompilerWorkloadProfile([
    trajectory("profile", "p", { contextBill: { history: 500 } }),
  ]);
  const input = profiledInput(target, {
    profile: dynamicProfile,
    config: { ...profiledInput(target).config, maxSearchCostUsd: 100 },
    developmentRunner: async ({ plan: candidate, seed }) => {
      observedPlans.push(candidate);
      const routed = candidate.segment_routes.some((route) => route.segment_kind === "history");
      return evidence({ cost: routed ? 0.005 : 0.02, cacheRead: routed && seed > 1 ? 10 : 0 });
    },
    holdoutRunner: async ({ plan: candidate, seed }) => {
      const routed = candidate.segment_routes.some((route) => route.segment_kind === "history");
      return evidence({ cost: routed ? 0.005 : 0.02, cacheRead: routed && seed > 1 ? 10 : 0 });
    },
  });
  delete input.candidates;
  const compiled = await compileProfiled(input);
  assert.equal(compiled.status, "locked");
  assert.ok(observedPlans.every((candidate) => candidate.plan_id === "baseline"));
  assert.deepEqual(compiled.lock.capability_manifest.supported_semantics, []);
  assert.deepEqual(compiled.lock.capability_manifest.required_semantics, []);
  assert.deepEqual(compiled.lock.passes.map((pass) => pass.pass_id), ["profile_guided_selection"]);
});

test("copied native Pi identity plus caller runners cannot mint optimized evidence", async () => {
  let runs = 0;
  const target = nativePiCompilerTarget();
  const input = profiledInput(target, {
    developmentRunner: async () => { runs++; return evidence(); },
    holdoutRunner: async () => { runs++; return evidence(); },
  });
  const result = await compileProfiled(input);
  assert.equal(result.status, "capability_refused");
  assert.equal(result.reason, "cave_compiler_native_runner_required");
  assert.equal(runs, 0);
  assert.throws(
    () => capabilityManifestFor(target, []),
    /cave_compiler_native_runner_required/,
  );
});

test("each target revalidates before executing the same semantic plan digest", async () => {
  const priced = catalogCost({
    provider: "anthropic",
    model: "claude-haiku-4-5",
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  });
  assert.equal(priced.priced, true);
  const invoke = async (request) => ({
    terminal: true,
    text: "ok",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 12,
    costUsd: priced.usd,
    usageBasis: "provider_reported",
    priceBasis: "public_catalog",
    evaluatedTransformIDs: [...request.evaluatedTransformIDs],
    appliedTransformIDs: [...request.appliedTransformIDs],
    recoveryResolved: request.recoveryResolved,
    latencyMs: 1,
  });
  const identity = (upstreamVersion) => ({
    adapterVersion: "0.2.0",
    upstreamVersion,
    bundleSHA256: hex("b"),
    dependencyLockSHA256: hex("d"),
  });
  const pi = createHarnessAdapter("pi", identity("0.83.0"), { kind: "test-pi" }, invoke);
  const piTarget = {
    id: "pi",
    adapterVersion: pi.version,
    upstreamVersion: pi.manifest.upstreamVersion,
    adapterContractSHA256: pi.contractSHA256,
  };
  const compiled = await compileProfiled(profiledInput(piTarget));
  assert.equal(compiled.status, "locked");
  const piBuild = parseCaveBuildLockV3(compiled.lock);
  assert.equal(piBuild.evidence.p95_latency_ms, 11);
  assert.equal(piBuild.compiler.profile_sha256, profile().profile_sha256);
  assert.ok(piBuild.passes.some((pass) => pass.pass_id === "profile_guided_selection"));
  assert.throws(() => parseCaveBuildLockV3({
    ...piBuild,
    passes: [{ ...piBuild.passes[0], pass_id: "invented_pass" }],
  }), /cave_invalid_lock_v3:shape/);
  const malformedUnicode = { ...piBuild, agent_id: "\ud800" };
  const { build_sha256: _oldUnicodeBuild, ...malformedUnicodePayload } = malformedUnicode;
  assert.throws(() => parseCaveBuildLockV3({
    ...malformedUnicodePayload,
    build_sha256: sha256(stableStringify(malformedUnicodePayload)),
  }), /cave_invalid_lock_v3:unicode/);
  const alteredValidation = {
    ...piBuild,
    validation: {
      ...piBuild.validation,
      development: {
        ...piBuild.validation.development,
        actual_cost_usd: piBuild.validation.development.actual_cost_usd + 1,
      },
    },
  };
  const { build_sha256: _oldValidationBuild, ...alteredValidationPayload } = alteredValidation;
  assert.throws(() => parseCaveBuildLockV3({
    ...alteredValidationPayload,
    build_sha256: sha256(stableStringify(alteredValidationPayload)),
  }), /pass_evidence_digest/);

  const vercel = createHarnessAdapter(
    "vercel-ai-sdk", identity("7.0.43"), { kind: "test-vercel" }, invoke,
  );
  const vercelTarget = {
    id: "vercel-ai-sdk",
    adapterVersion: vercel.version,
    upstreamVersion: vercel.manifest.upstreamVersion,
    adapterContractSHA256: vercel.contractSHA256,
  };
  assert.throws(() => assertProfiledBuildTarget(piBuild, vercelTarget),
    /cave_compiler_target_revalidation_required/);
  const vercelCompiled = await compileProfiled(profiledInput(vercelTarget));
  assert.equal(vercelCompiled.status, "locked");
  const vercelBuild = vercelCompiled.lock;
  assert.equal(vercelBuild.selected_plan_id, "baseline");
  assert.equal(vercelBuild.plan_sha256, piBuild.plan_sha256);
  assert.notEqual(vercelBuild.build_sha256, piBuild.build_sha256);
  assert.equal(vercelBuild.executable_pipeline.steps[0].on_error, "abort");
  const executed = await executeCompiledPipeline({
    build: vercelBuild,
    adapter: vercel,
    contextIR: { schemaVersion: 1, segments: [] },
    prompt: "runtime-only prompt",
    runID: "run",
    evaluatedTransformIDs: [],
    appliedTransformIDs: [],
    recoveryResolved: true,
  });
  assert.equal(executed.target, "vercel-ai-sdk");
  assert.equal(executed.semanticPlanSHA256, vercelBuild.plan_sha256);
  assert.equal(executed.fallbackUsed, false);
});

test("opaque target failure never baseline-replays hidden effects", async () => {
  let invocations = 0;
  const adapter = createHarnessAdapter("vercel-ai-sdk", {
    adapterVersion: "0.2.0",
    upstreamVersion: "7.0.43",
    bundleSHA256: hex("e"),
    dependencyLockSHA256: hex("f"),
  }, { kind: "opaque-hidden-tool-test" }, async () => {
    invocations++;
    throw new Error("failure_after_hidden_effect");
  });
  const compiled = await compileProfiled(profiledInput({
    id: "vercel-ai-sdk",
    adapterVersion: adapter.version,
    upstreamVersion: adapter.manifest.upstreamVersion,
    adapterContractSHA256: adapter.contractSHA256,
  }));
  assert.equal(compiled.status, "locked");
  assert.equal(compiled.lock.executable_pipeline.steps[0].on_error, "abort");
  await assert.rejects(executeCompiledPipeline({
    build: compiled.lock,
    adapter,
    contextIR: { schemaVersion: 1, segments: [] },
    prompt: "opaque failure",
    runID: "opaque-run",
    evaluatedTransformIDs: [],
    appliedTransformIDs: [],
    recoveryResolved: true,
  }), /cave_compiler_baseline_replay_unsafe/);
  assert.equal(invocations, 1);
});

test("generic target refuses write-tool semantics before any invocation", async () => {
  let invocations = 0;
  const identity = {
    adapterVersion: "0.2.0",
    upstreamVersion: "0.83.0",
    bundleSHA256: hex("e"),
    dependencyLockSHA256: hex("f"),
  };
  const adapter = createHarnessAdapter("pi", identity, { kind: "write-test" }, async () => {
    invocations++;
    throw new Error("failure_after_possible_write");
  });
  const definition = agent({
    id: "profiled-agent",
    instructions: "Be exact.",
    model: auto(),
    sandbox: "fixture",
    tools: [tool({
      name: "write_file",
      description: "write",
      input: schema.object({ value: schema.string() }),
      effect: "write",
      async execute() { return "ok"; },
    })],
  });
  const compiled = await compileProfiled(profiledInput({
    id: "pi",
    adapterVersion: adapter.version,
    upstreamVersion: adapter.manifest.upstreamVersion,
    adapterContractSHA256: adapter.contractSHA256,
  }, { agent: definition }));
  assert.equal(compiled.status, "capability_refused");
  assert.match(compiled.reason, /tool_effect:write/);
  assert.equal(invocations, 0);
});
