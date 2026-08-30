import { test } from "node:test";
import assert from "node:assert/strict";
import { Client as EveClient } from "eve/client";
import {
  createClaudeAdapter,
  createEveAdapter,
  createPiAdapter,
} from "../dist/adapters.js";
import { compile, defineBuild } from "../dist/build.js";
import { catalogCost } from "../dist/catalog.js";
import { agent, auto, eval as defineEval } from "../dist/index.js";

const hex = (value) => value.repeat(64);
const adapterIdentity = (overrides = {}) => ({
  adapterVersion: "0.1.0",
  upstreamVersion: "0.83.0",
  bundleSHA256: hex("a"),
  dependencyLockSHA256: hex("b"),
  ...overrides,
});

function baselinePlan() {
  return {
    schema_version: 1,
    plan_id: "baseline",
    model: "anthropic/claude-haiku-4-5",
    reasoning: "low",
    segment_routes: [],
    budgets: {
      instructions: 1_000,
      tools: 1_000,
      memory: 0,
      history: 2_000,
      results_artifacts: 1_000,
      reasoning: 1_000,
      output: 500,
      retry_cascade_reserve: 0,
    },
    recovery: { namespace: "adapter", tools: [] },
    fallbacks: { unknown: "original", transform_error: "original", not_smaller: "original" },
  };
}

async function buildLock({
  harnessId = "pi",
  adapterVersion = "0.1.0",
  upstreamVersion = "0.83.0",
  reasoning = "low",
  model = "anthropic/claude-haiku-4-5",
} = {}) {
  const plan = baselinePlan();
  plan.reasoning = reasoning;
  plan.model = model;
  const [provider, ...modelParts] = model.split("/");
  const modelID = modelParts.join("/");
  const result = await compile({
    agent: agent({ id: "adapter", instructions: "test", model: auto() }),
    contextIR: { schemaVersion: 1, segments: [] },
    evals: ["a", "b"].map((suffix) => defineEval({
      id: `adapter-${suffix}`,
      input: `x-${suffix}`,
      quality: [{ type: "exact_match", expected: "ok" }],
    })),
    candidates: [{ plan, estimated_cost_usd_per_run: 0.001 }],
    baselinePlan: plan,
    seeds: [1, 2, 3, 4, 5],
    config: defineBuild({ entry: "src/agent.ts", evals: "evals/*.ts" }),
    sourceSha256: hex("1"),
    catalogSha256: hex("2"),
    transformRegistrySha256: hex("3"),
    runtimeVersion: "0.1.0",
    adapterVersion,
    upstreamVersion,
    harnessId,
    runner: async () => ({
      terminal: true,
      provider,
      model: modelID,
      usage_basis: "provider_reported",
      price_basis: "public_catalog",
      catalog_cost_usd: 0.001,
      input_tokens: 1_000,
      output_tokens: 0,
      reasoning_tokens: 0,
      quality_score: 1,
      graders: [{ type: "exact_match", passed: true }],
      latency_ms: 1,
      provider_visible_tokens: 1_000,
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
    }),
  });
  return result.lock;
}

test("Pi evidence adapter binds harness lock, actual model, and recomputed catalog cost", async () => {
  const build = await buildLock();
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
  const invoke = async () => ({
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
    evaluatedTransformIDs: [],
    appliedTransformIDs: [],
    recoveryResolved: true,
    latencyMs: 10,
  });
  const adapter = createPiAdapter(adapterIdentity(), invoke);
  const result = await adapter.run({
    build,
    contextIR: { schemaVersion: 1, segments: [] },
    plan: build.selected_plan,
    prompt: "x",
    runID: "run",
    evaluatedTransformIDs: [],
    appliedTransformIDs: [],
    recoveryResolved: true,
  });
  assert.equal(result.planSHA256, build.plan_sha256);
  assert.equal(result.inputTokens, 10);
  assert.equal(result.outputTokens, 2);
  assert.equal(result.verifiedSavingsUsd, 0);
});

test("harness adapter rejects another harness build and adapter version before execution", async () => {
  const build = await buildLock();
  const request = {
    build,
    contextIR: { schemaVersion: 1, segments: [] },
    plan: build.selected_plan,
    prompt: "x",
    runID: "run",
    evaluatedTransformIDs: [],
    appliedTransformIDs: [],
    recoveryResolved: true,
  };
  let calls = 0;
  const invoke = async () => {
    calls++;
    throw new Error("must not execute");
  };
  await assert.rejects(
    createClaudeAdapter(adapterIdentity(), invoke).run(request),
    /cave_harness_build_mismatch/,
  );
  await assert.rejects(
    createPiAdapter(adapterIdentity({ adapterVersion: "different" }), invoke).run(request),
    /cave_harness_build_mismatch/,
  );
  await assert.rejects(
    createPiAdapter(adapterIdentity({ upstreamVersion: "0.84.0" }), invoke).run(request),
    /cave_harness_build_mismatch/,
  );
  assert.equal(calls, 0);
});

test("harness adapter binds Context IR before execution", async () => {
  const build = await buildLock();
  let calls = 0;
  await assert.rejects(
    createPiAdapter(adapterIdentity(), async () => {
      calls++;
      throw new Error("must not execute");
    }).run({
      build,
      contextIR: {
        schemaVersion: 1,
        segments: [{
          id: "changed",
          kind: "history",
          stability: "turn",
          safety: "S0",
          priority: "normal",
          recovery: "none",
          cacheRegion: "live_zone",
          privacy: "local_sensitive",
          opaque: false,
          provenanceDigest: hex("c"),
          tokenCount: 1,
          bodyHandle: `cave_local_sha256:${hex("c")}`,
        }],
      },
      plan: build.selected_plan,
      prompt: "x",
      runID: "run",
      evaluatedTransformIDs: [],
      appliedTransformIDs: [],
      recoveryResolved: true,
    }),
    /cave_harness_context_ir_mismatch/,
  );
  assert.equal(calls, 0);
});

test("adapter contract uses explicit bundle and dependency identity, never function source", () => {
  const first = createPiAdapter(adapterIdentity(), async () => {
    throw new Error("first");
  });
  const equivalent = createPiAdapter(adapterIdentity(), async () => {
    throw new Error("different source");
  });
  const changedBundle = createPiAdapter(
    adapterIdentity({ bundleSHA256: hex("c") }),
    async () => {
      throw new Error("first");
    },
  );
  const changedDependencies = createPiAdapter(
    adapterIdentity({ dependencyLockSHA256: hex("d") }),
    async () => {
      throw new Error("first");
    },
  );
  assert.equal(first.contractSHA256, equivalent.contractSHA256);
  assert.notEqual(first.contractSHA256, changedBundle.contractSHA256);
  assert.notEqual(first.contractSHA256, changedDependencies.contractSHA256);
  assert.equal(first.manifest.upstreamVersion, "0.83.0");
  assert.throws(
    () => createPiAdapter(adapterIdentity({ bundleSHA256: "not-a-digest" }), async () => {
      throw new Error("first");
    }),
    /cave_harness_artifact_digest_invalid/,
  );
});

test("evidence adapter rejects mismatched model and caller-priced cost", async () => {
  const build = await buildLock();
  const request = {
    build,
    contextIR: { schemaVersion: 1, segments: [] },
    plan: build.selected_plan,
    prompt: "x",
    runID: "run",
    evaluatedTransformIDs: [],
    appliedTransformIDs: [],
    recoveryResolved: true,
  };
  const execution = {
    terminal: true,
    text: "ok",
    provider: "openai",
    model: "gpt-5.4-mini",
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 12,
    costUsd: 0.001,
    usageBasis: "provider_reported",
    priceBasis: "public_catalog",
    evaluatedTransformIDs: [],
    appliedTransformIDs: [],
    recoveryResolved: true,
    latencyMs: 1,
  };
  await assert.rejects(
    createPiAdapter(adapterIdentity(), async () => execution).run(request),
    /cave_harness_incomplete_evidence/,
  );
  await assert.rejects(
    createPiAdapter(adapterIdentity(), async () => ({
      ...execution,
      provider: "anthropic",
      model: "claude-haiku-4-5",
    })).run(request),
    /cave_harness_incomplete_evidence/,
  );
  const priced = catalogCost({
    provider: "anthropic",
    model: "claude-haiku-4-5",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  });
  await assert.rejects(
    createPiAdapter(adapterIdentity(), async () => ({
      ...execution,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: priced.usd,
    })).run(request),
    /cave_harness_incomplete_evidence/,
  );
});

test("harness evidence rejects a recurring price-window crossing", async () => {
  const build = await buildLock({ model: "deepseek/deepseek-v4-flash" });
  const accountingAt = new Date("2026-08-17T00:59:59Z");
  const priced = catalogCost({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }, accountingAt);
  const RealDate = Date;
  const instants = ["2026-08-17T00:59:59Z", "2026-08-17T01:00:00Z"];
  class BoundaryDate extends RealDate {
    constructor(...args) {
      if (args.length > 0) {
        super(...args);
        return;
      }
      super(instants.shift() ?? "2026-08-17T01:00:00Z");
    }
  }
  globalThis.Date = BoundaryDate;
  try {
    await assert.rejects(createPiAdapter(adapterIdentity(), async () => ({
      terminal: true,
      text: "ok",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 12,
      costUsd: priced.usd,
      usageBasis: "provider_reported",
      priceBasis: "public_catalog",
      evaluatedTransformIDs: [],
      appliedTransformIDs: [],
      recoveryResolved: true,
      latencyMs: 1,
    })).run(adapterRequest(build)), /cave_harness_incomplete_evidence/);
  } finally {
    globalThis.Date = RealDate;
  }
});

function adapterRequest(build, overrides = {}) {
  return {
    build,
    contextIR: { schemaVersion: 1, segments: [] },
    plan: build.selected_plan,
    prompt: "x",
    runID: "run",
    evaluatedTransformIDs: [],
    appliedTransformIDs: [],
    recoveryResolved: true,
    ...overrides,
  };
}

test("Eve adapter aggregates durable step usage and validates runtime model identity", async () => {
  const identity = adapterIdentity({ adapterVersion: "0.29.2", upstreamVersion: "0.29.2" });
  const build = await buildLock({
    harnessId: "eve",
    adapterVersion: identity.adapterVersion,
    upstreamVersion: identity.upstreamVersion,
    reasoning: "none",
  });
  const sends = [];
  const adapter = createEveAdapter(identity, {
    async send(input) {
      sends.push(input);
      return {
        async result() {
          return {
            message: "ok",
            status: "completed",
            events: [
              { type: "session.started", data: { runtime: { modelId: "anthropic/claude-haiku-4-5", eveVersion: "0.29.2" } } },
              { type: "step.completed", data: { usage: {
                inputTokens: 10,
                outputTokens: 2,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              } } },
            ],
          };
        },
      };
    },
  });
  const controller = new AbortController();
  const result = await adapter.run(adapterRequest(build, { signal: controller.signal }));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].message, "x");
  assert.equal(sends[0].signal, controller.signal);
  assert.equal(result.harness, "eve");
  assert.equal(result.costUsd > 0, true);
});

test("Eve adapter executes an actual pinned ClientSession transport", async () => {
  const identity = adapterIdentity({ adapterVersion: "0.29.2", upstreamVersion: "0.29.2" });
  const build = await buildLock({
    harnessId: "eve",
    adapterVersion: identity.adapterVersion,
    upstreamVersion: identity.upstreamVersion,
    reasoning: "none",
  });
  const events = [
    { type: "session.started", data: { runtime: {
      agentId: "caveman-adapter-test",
      modelId: "anthropic/claude-haiku-4-5",
      eveVersion: "0.29.2",
    } } },
    { type: "message.completed", data: {
      message: "ok", finishReason: "stop", sequence: 0, stepIndex: 0, turnId: "turn-1",
    } },
    { type: "step.completed", data: {
      finishReason: "stop", sequence: 0, stepIndex: 0, turnId: "turn-1",
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    } },
    { type: "session.completed" },
  ];
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", body: init.body });
    if (url === "https://eve.test/eve/v1/session" && init.method === "POST") {
      return Response.json({ sessionId: "session-real" });
    }
    if (url === "https://eve.test/eve/v1/session/session-real/stream" && init.method === undefined) {
      return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      });
    }
    throw new Error(`unexpected Eve request: ${init.method ?? "GET"} ${url}`);
  };
  try {
    const session = new EveClient({ host: "https://eve.test" }).session();
    const result = await createEveAdapter(identity, session).run(adapterRequest(build));
    assert.deepEqual(calls.map(({ method, url }) => ({ method, url })), [
      { method: "POST", url: "https://eve.test/eve/v1/session" },
      { method: "GET", url: "https://eve.test/eve/v1/session/session-real/stream" },
    ]);
    assert.deepEqual(JSON.parse(calls[0].body), { message: "x" });
    assert.equal(result.text, "ok");
    assert.equal(result.model, "claude-haiku-4-5");
    assert.equal(result.totalTokens, 12);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Eve adapter pins installed upstream version before execution", () => {
  let calls = 0;
  assert.throws(
    () => createEveAdapter(adapterIdentity({ upstreamVersion: "0.29.3" }), {
      async send() {
        calls++;
        throw new Error("must not execute");
      },
    }),
    /cave_eve_upstream_version_(unsupported|mismatch)/,
  );
  assert.equal(calls, 0);
});

test("Eve adapter forwards no work after pre-abort", async () => {
  const identity = adapterIdentity({ adapterVersion: "0.29.2", upstreamVersion: "0.29.2" });
  const build = await buildLock({
    harnessId: "eve",
    adapterVersion: identity.adapterVersion,
    upstreamVersion: identity.upstreamVersion,
    reasoning: "none",
  });
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createEveAdapter(identity, {
      async send() {
        calls++;
        throw new Error("must not execute");
      },
    }).run(adapterRequest(build, { signal: controller.signal })),
    /cave_harness_aborted/,
  );
  assert.equal(calls, 0);
});
