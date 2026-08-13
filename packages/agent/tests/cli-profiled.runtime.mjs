import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateCandidatePlans } from "../dist/build.js";
import {
  importProfileTrajectories,
  observedDynamicKindsFromTrajectories,
  prepareProfiledPlanningState,
} from "../dist/cli.js";
import { compileProfiled, planNativePiCandidates } from "../dist/compiler.js";
import {
  agent,
  createCompilerWorkloadProfile,
  eval as defineEval,
  normalizeTrajectory,
  sha256,
  stableStringify,
} from "../dist/index.js";

const hex = (value) => value.repeat(64);

function fixture(id, split, input, quality = [{ type: "exact_match", expected: "ok" }]) {
  return defineEval({
    id,
    lineageId: `lineage-${id}`,
    split,
    approved: true,
    input,
    quality,
  });
}

function trajectory(split, id) {
  return normalizeTrajectory({
    runId: `run-${id}`,
    agentId: "holdout-isolation",
    text: "content-not-exported",
    contextIR: { schemaVersion: 1, segments: [] },
    contextBill: {},
    cachePrefixSHA256: hex("c"),
    cacheBoundaryKnown: true,
    cacheBust: false,
    usageBasis: "provider_reported",
    inputTokens: 10_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningUsageBasis: "provider_reported",
    reasoningTokens: 0,
    costUsd: 0.01,
    priceBasis: "public_catalog",
    mode: "optimized",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    latencyMs: 10,
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
  }, {
    split,
    caseId: id,
    lineageId: `lineage-${id}`,
    inputSha256: sha256(`input-${id}`),
  });
}

function evidence(fixtureDefinition) {
  return {
    terminal: true,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    usage_basis: "provider_reported",
    price_basis: "public_catalog",
    catalog_cost_usd: 0.01,
    input_tokens: 10_000,
    output_tokens: 0,
    reasoning_tokens: 0,
    quality_score: 1,
    graders: fixtureDefinition.quality.map(({ type }) => ({ type, passed: true })),
    latency_ms: 10,
    provider_visible_tokens: 10_000,
    cache_prefix_sha256: hex("c"),
    cache_boundary_known: true,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cache_bust: false,
    error: false,
    recovery_resolved: true,
    privacy_passed: true,
    sandbox_passed: true,
    output_digest: hex("a"),
  };
}

test("trace import is content-blind and unlocks observed dynamic candidates", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "caveman-profile-traces-"));
  try {
    const directory = resolve(root, ".caveman/traces");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "profile.jsonl"), `${JSON.stringify({
      schema_version: 1,
      case_id: "production-case",
      lineage_id: "production-family",
      input_sha256: sha256("production-input"),
      agent_sha256: sha256("trace-profile"),
      trace: {
        runId: "production-run",
        agentId: "trace-profile",
        text: "raw-result-must-not-survive",
        contextIR: { schemaVersion: 1, segments: [] },
        contextBill: { history: 7_000, tool_result: 3_000 },
        cachePrefixSHA256: hex("c"),
        cacheBoundaryKnown: true,
        cacheBust: false,
        usageBasis: "provider_reported",
        inputTokens: 10_000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningUsageBasis: "provider_reported",
        reasoningTokens: 0,
        costUsd: 0.01,
        priceBasis: "public_catalog",
        mode: "optimized",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        latencyMs: 10,
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
      },
    })}\n`, { mode: 0o600 });
    const definition = agent({
      id: "trace-profile",
      instructions: "Answer exactly.",
      model: "anthropic/claude-haiku-4-5",
      sandbox: "fixture",
    });
    const rows = await importProfileTrajectories(root, definition);
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(rows).includes("raw-result-must-not-survive"), false);
    assert.deepEqual(rows[0].context_bill, { history: 7_000, tool_result: 3_000 });
    assert.deepEqual(
      [...observedDynamicKindsFromTrajectories(rows)].sort(),
      ["history", "tool_result"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trace import rejects symlink escape before reading untrusted bytes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "caveman-profile-root-"));
  const outside = await mkdtemp(resolve(tmpdir(), "caveman-profile-outside-"));
  try {
    const directory = resolve(root, ".caveman/traces");
    await mkdir(directory, { recursive: true });
    const outsideFile = resolve(outside, "secret.json");
    await writeFile(outsideFile, JSON.stringify({ secret: "must-not-import" }));
    await symlink(outsideFile, resolve(directory, "escaped.json"));
    const definition = agent({
      id: "trace-profile",
      instructions: "Answer exactly.",
      model: "anthropic/claude-haiku-4-5",
      sandbox: "fixture",
    });
    await assert.rejects(
      importProfileTrajectories(root, definition),
      /cave_compiler_trace_path_escape/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("profiled CLI planning cannot inspect holdout input or dynamic context hints", async () => {
  const definition = agent({
    id: "holdout-isolation",
    instructions: "Answer exactly.",
    model: "anthropic/claude-haiku-4-5",
    sandbox: "fixture",
  });
  const profileEvals = [fixture("profile-a", "profile", "profile input")];
  const developmentEvals = [
    fixture("development-a", "development", "development input a"),
    fixture("development-b", "development", "development input b"),
  ];
  const holdoutA = [
    fixture("holdout-a", "holdout", "holdout input a"),
    fixture("holdout-b", "holdout", "holdout input b"),
  ];
  const holdoutB = [
    fixture(
      "holdout-a",
      "holdout",
      "changed holdout-only input",
      [{ type: "tool_called", tools: ["holdout-only-tool"] }],
    ),
    fixture("holdout-b", "holdout", "changed holdout input b"),
  ];

  const planningA = await prepareProfiledPlanningState(process.cwd(), definition, {
    profile: profileEvals,
    development: developmentEvals,
    holdout: holdoutA,
  });
  const planningB = await prepareProfiledPlanningState(process.cwd(), definition, {
    profile: profileEvals,
    development: developmentEvals,
    holdout: holdoutB,
  });
  const unreadableHoldout = new Proxy(holdoutA[0], {
    get() {
      throw new Error("holdout fixture inspected during planning");
    },
  });
  await prepareProfiledPlanningState(process.cwd(), definition, {
    profile: profileEvals,
    development: developmentEvals,
    holdout: [unreadableHoldout],
  });
  assert.deepEqual(planningA.planningEvals.map(({ id }) => id), [
    "profile-a",
    "development-a",
    "development-b",
  ]);
  assert.equal(planningA.contextByEvalID.has("holdout-a"), false);
  assert.deepEqual([...planningA.observedDynamicKinds], []);
  assert.equal(stableStringify(planningA.baseline), stableStringify(planningB.baseline));

  const proposed = (planning) => generateCandidatePlans(
    definition,
    planning.lowered.ir,
    planning.baseline,
    [planning.baseline.model],
    true,
    new Map(),
    [{
      transformID: "caveman.engine.s4.v1",
      segmentKinds: ["history", "tool_result"],
    }],
    planning.observedDynamicKinds,
  );
  const candidatesA = proposed(planningA);
  const candidatesB = proposed(planningB);
  assert.equal(
    sha256(stableStringify(candidatesA)),
    sha256(stableStringify(candidatesB)),
  );

  const workloadProfile = createCompilerWorkloadProfile([
    trajectory("profile", "profile-a"),
  ]);
  const compile = async (planning, holdoutEvals) => {
    const events = [];
    const result = await compileProfiled({
      agent: definition,
      contextIR: planning.lowered.ir,
      profile: workloadProfile,
      developmentEvals,
      holdoutEvals,
      developmentSeeds: [1, 2, 3, 4, 5],
      holdoutSeeds: [1, 2, 3, 4, 5],
      candidates: proposed(planning),
      baselinePlan: planning.baseline,
      config: {
        entry: "src/agent.ts",
        evals: "evals/*.ts",
        efficiency: "max",
        requiredFixturePassRate: 1,
        qualityRetention: 0.98,
        maxSearchCostUsd: 2,
        lock: "strict",
        sandbox: "required",
      },
      sourceSha256: hex("1"),
      catalogSha256: hex("2"),
      transformRegistrySha256: hex("3"),
      runtimeVersion: "0.2.0",
      target: {
        id: "pi",
        adapterVersion: "0.2.0",
        upstreamVersion: "0.83.0",
        adapterContractSHA256: hex("4"),
      },
      developmentRunner: async ({ eval: fixtureDefinition }) => {
        events.push(`development:${fixtureDefinition.id}`);
        return evidence(fixtureDefinition);
      },
      holdoutRunner: async ({ eval: fixtureDefinition }) => {
        events.push(`holdout:${fixtureDefinition.id}:${String(fixtureDefinition.input)}`);
        return evidence(fixtureDefinition);
      },
    });
    return { events, result };
  };

  const first = await compile(planningA, holdoutA);
  const second = await compile(planningB, holdoutB);
  assert.equal(first.result.status, "locked");
  assert.equal(second.result.status, "locked");
  assert.equal(
    first.result.development.lock.plan_sha256,
    second.result.development.lock.plan_sha256,
  );
  for (const { events } of [first, second]) {
    const firstHoldout = events.findIndex((event) => event.startsWith("holdout:"));
    const lastDevelopment = events.findLastIndex((event) => event.startsWith("development:"));
    assert.ok(firstHoldout > lastDevelopment);
  }
  assert.ok(second.events.some((event) => event.includes("changed holdout-only input")));
});

test("profiled CLI uses the compiler-owned native output frontier", () => {
  const plan = (plan_id, output) => ({
    schema_version: 1,
    plan_id,
    model: "anthropic/claude-haiku-4-5",
    reasoning: "none",
    segment_routes: [],
    budgets: {
      instructions: 1_000,
      tools: 0,
      memory: 0,
      history: 1_000,
      results_artifacts: 1_000,
      reasoning: 0,
      output,
      retry_cascade_reserve: 0,
    },
    recovery: { namespace: "cli-native", tools: [] },
    fallbacks: { unknown: "original", transform_error: "original", not_smaller: "original" },
  });
  const baseline = plan("baseline", 512);
  const definition = agent({
    id: "cli-native",
    instructions: "Be exact.",
    model: "anthropic/claude-haiku-4-5",
    sandbox: "fixture",
  });
  const selected = planNativePiCandidates({
    agent: definition,
    contextIR: { schemaVersion: 1, segments: [] },
    baselinePlan: baseline,
    config: {
      entry: "src/agent.ts",
      evals: "evals/*.ts",
      efficiency: "max",
      requiredFixturePassRate: 1,
      qualityRetention: 0.98,
      maxSearchCostUsd: 2,
      lock: "strict",
      sandbox: "required",
    },
    observedDynamicKinds: new Set(),
  });
  assert.ok(selected.some(({ plan: candidate }) => candidate.plan_id === "baseline"));
  assert.ok(selected.some(({ plan: candidate }) => candidate.budgets.output < baseline.budgets.output));
});
