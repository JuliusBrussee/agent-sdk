import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  agent,
  createCompilerWorkloadProfile,
  eval as defineEval,
  lowerContext,
  normalizeTrajectory,
  schema,
  sha256,
  stableStringify,
  subagent,
  tool,
} from "../dist/index.js";
import { CATALOG_SHA256 } from "../dist/catalog.js";
import { compileProfiledNativePi } from "../dist/compiler.js";
import { runNativePiFixture } from "../dist/compile-runner.js";
import { runAgentInternal } from "../dist/runtime.js";
import { PI_NATIVE_COMPILER_CONTRACT } from "../dist/runtime-identity.js";
import {
  PI_NATIVE_COMPILER_CAPABILITIES,
  PI_NATIVE_COMPILER_CONTRACT_SHA256,
  parseCaveBuildLockV3,
} from "../dist/build.js";

const hex = (value) => value.repeat(64);

test("owned native Pi compiler selects and executes a lower output budget", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({ url: request.url });
    if (request.url === "/health/ready") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: true,
        service: "caveman-proxy",
        schema: "caveman.proxy.health.v1",
        adapters: 1,
        billing: "byok",
      }));
      return;
    }
    if (request.url !== "/openai/v1/responses") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const payload = JSON.parse(Buffer.concat(body).toString("utf8"));
    requests.push({ url: request.url, payload, headers: request.headers });
    const requestedOutput = payload.max_output_tokens;
    const high = requestedOutput > 64;
    const outputTokens = high ? 80 : 8;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const item = {
      id: "msg_caveman",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    };
    for (const event of [
      { type: "response.created", response: { id: "resp_caveman", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_caveman",
          status: "completed",
          output: [item],
          usage: {
            input_tokens: 100,
            output_tokens: outputTokens,
            total_tokens: 100 + outputTokens,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const gatewayURL = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(resolve(tmpdir(), "caveman-native-compile-"));
  const proxy = resolve(root, "caveman-proxy");
  const previous = {
    key: process.env.OPENAI_API_KEY,
    proxy: process.env.CAVEMAN_PROXY_BIN,
    gateway: process.env.CAVE_GATEWAY_URL,
  };
  try {
    await mkdir(resolve(root, "src"), { recursive: true });
    await writeFile(resolve(root, "src/agent.ts"), "export default {};\n");
    await symlink(resolve(import.meta.dirname, "../node_modules"), resolve(root, "node_modules"), "dir");
    await writeFile(proxy, `#!/usr/bin/env node
if (process.argv[2] !== "status") process.exit(2);
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
process.stdout.write(JSON.stringify({
  owner: "start",
  instance_token: "0123456789abcdef0123456789abcdef",
  pid: process.pid,
  port,
}));
`);
    await chmod(proxy, 0o755);
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.CAVEMAN_PROXY_BIN = proxy;
    process.env.CAVE_GATEWAY_URL = gatewayURL;

    const model = {
      id: "gpt-5.4-mini",
      name: "Local OpenAI fixture",
      api: "openai-responses",
      provider: "openai",
      baseUrl: `${gatewayURL}/openai/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    };
    const definition = agent({
      id: "native-compiler",
      instructions: "Reply exactly: ok",
      model,
      reasoning: "off",
      sandbox: "fixture",
    });
    const contextIR = (await lowerContext({
      instructions: definition.instructions,
      tools: definition.tools,
    })).ir;
    const plan = (id, reasoning, output, reasoningBudget) => ({
      schema_version: 1,
      plan_id: id,
      model: "openai/gpt-5.4-mini",
      reasoning,
      segment_routes: [],
      budgets: {
        instructions: 1_000,
        tools: 0,
        memory: 0,
        history: 1_000,
        results_artifacts: 1_000,
        reasoning: reasoningBudget,
        output,
        retry_cascade_reserve: 0,
      },
      recovery: { namespace: "native-compiler", tools: [] },
      fallbacks: { unknown: "original", transform_error: "original", not_smaller: "original" },
    });
    const baseline = plan("baseline.wide", "none", 512, 0);
    const profile = createCompilerWorkloadProfile([normalizeTrajectory({
      runId: "profile-run",
      agentId: definition.id,
      text: "raw profile output",
      contextIR: { schemaVersion: 1, segments: [] },
      contextBill: { instruction: 10 },
      cachePrefixSHA256: hex("c"),
      cacheBoundaryKnown: true,
      cacheBust: false,
      usageBasis: "provider_reported",
      inputTokens: 100,
      outputTokens: 80,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningUsageBasis: "provider_reported",
      reasoningTokens: 0,
      costUsd: 0,
      priceBasis: "public_catalog",
      mode: "optimized",
      provider: "openai",
      model: "gpt-5.4-mini",
      latencyMs: 1,
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
      split: "profile",
      caseId: "profile-case",
      lineageId: "profile-family",
      inputSha256: sha256("profile input"),
    })]);
    const fixtures = (split) => ["a", "b"].map((suffix) => defineEval({
      id: `${split}-${suffix}`,
      lineageId: `${split}-family-${suffix}`,
      split,
      input: `${split} input ${suffix}`,
      quality: [{ type: "exact_match", expected: "ok" }],
    }));
    try {
      await runNativePiFixture({
        rootDir: root,
        entryPath: "src/agent.ts",
        definition,
        plan: baseline,
        fixture: fixtures("development")[0],
        seed: 0,
        sandboxConformance: true,
        privacyConformance: true,
        conversations: new Map(),
        maxCostUsd: 10,
        signal: new AbortController().signal,
      });
    } catch (error) {
      assert.fail(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        cause: error?.cause instanceof Error ? error.cause.message : String(error?.cause),
        requests,
      }));
    }
    const result = await compileProfiledNativePi({
      rootDir: root,
      entryPath: "src/agent.ts",
      agent: definition,
      contextIR,
      profile,
      developmentEvals: fixtures("development"),
      holdoutEvals: fixtures("holdout"),
      developmentSeeds: [1, 2, 3, 4, 5],
      holdoutSeeds: [1, 2, 3, 4, 5],
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
      catalogSha256: CATALOG_SHA256,
      transformRegistrySha256: hex("3"),
      runtimeVersion: "0.2.0",
    });
    assert.equal(result.status, "locked", JSON.stringify({ result, requests }));
    assert.ok(result.lock);
    assert.notEqual(result.lock.selected_plan_id, "baseline.wide", JSON.stringify({
      development: result.development,
      holdout: result.holdout,
      requests: requests.filter((item) => item.payload).map((item) => ({
        max_output_tokens: item.payload.max_output_tokens,
        plan: item.headers?.["x-cave-agent-plan"],
      })),
    }));
    assert.equal(result.lock.selected_plan.budgets.output, 64);
    assert.equal(result.lock.capability_manifest.adapter_contract_sha256,
      PI_NATIVE_COMPILER_CONTRACT_SHA256);
    assert.deepEqual(result.lock.capability_manifest.supported_semantics,
      [
        "abort_signal",
        "context_ir_binding",
        "model_binding",
        "output_budget_binding",
        "reasoning_binding",
        "recovery_evidence",
        "single_agent",
        "transform_evidence",
      ]);
    assert.deepEqual(PI_NATIVE_COMPILER_CAPABILITIES,
      result.lock.capability_manifest.supported_semantics);
    assert.equal(PI_NATIVE_COMPILER_CONTRACT.semantic_version, "tool-free-v1");
    assert.deepEqual(result.lock.capability_manifest.required_semantics, [
      "abort_signal",
      "output_budget_binding",
      "single_agent",
    ]);
    assert.deepEqual(result.lock.passes.map((item) => item.pass_id),
      ["output_budget_selection", "profile_guided_selection"]);
    assert.deepEqual(parseCaveBuildLockV3(result.lock), result.lock);
    const costRegression = structuredClone(result.lock);
    costRegression.validation.holdout.selected_catalog_cost_usd_per_task =
      costRegression.validation.holdout.baseline_catalog_cost_usd_per_task + Number.EPSILON;
    costRegression.evidence.catalog_cost_usd_per_task =
      costRegression.validation.holdout.selected_catalog_cost_usd_per_task;
    const { build_sha256: _oldCostBuild, ...costRegressionPayload } = costRegression;
    costRegression.build_sha256 = sha256(stableStringify(costRegressionPayload));
    assert.throws(
      () => parseCaveBuildLockV3(costRegression),
      /native_cost_regression/,
    );
    const semanticMismatch = structuredClone(result.lock);
    semanticMismatch.capability_manifest.required_semantics = [
      "abort_signal",
      "model_binding",
      "output_budget_binding",
      "single_agent",
    ];
    semanticMismatch.compiler.capability_manifest_sha256 = sha256(
      stableStringify(semanticMismatch.capability_manifest),
    );
    const { build_sha256: _oldSemanticBuild, ...semanticMismatchPayload } = semanticMismatch;
    semanticMismatch.build_sha256 = sha256(stableStringify(semanticMismatchPayload));
    assert.throws(
      () => parseCaveBuildLockV3(semanticMismatch),
      /native_required_semantics/,
    );
    assert.ok(requests.some((item) =>
      item.payload?.max_output_tokens > 64));
    assert.ok(requests.some((item) =>
      item.payload?.max_output_tokens === result.lock.selected_plan.budgets.output));

    const productionStart = requests.length;
    const locked = await runAgentInternal(definition, "production input", {
      rootDir: root,
      entryPath: "src/agent.ts",
      lockedBuild: result.lock,
      maxCostUsd: 10,
      sessionId: "native-locked-proof",
    });
    assert.equal(locked.text, "ok");
    assert.equal(locked.unlocked, false);
    const productionRequest = requests.slice(productionStart).find((item) => item.payload !== undefined);
    assert.ok(productionRequest);
    assert.equal(
      productionRequest.payload.max_output_tokens,
      64,
    );
    assert.equal(productionRequest.headers["x-cave-agent-build"], result.lock.build_sha256);
  } finally {
    if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.key;
    if (previous.proxy === undefined) delete process.env.CAVEMAN_PROXY_BIN;
    else process.env.CAVEMAN_PROXY_BIN = previous.proxy;
    if (previous.gateway === undefined) delete process.env.CAVE_GATEWAY_URL;
    else process.env.CAVE_GATEWAY_URL = previous.gateway;
    await new Promise((accept) => server.close(accept));
    await rm(root, { recursive: true, force: true });
  }
});

test("owned native Pi compiler refuses every tool agent before provider traffic", async () => {
  let providerCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    providerCalls++;
    throw new Error("provider call must not happen");
  };
  try {
    const definition = agent({
      id: "native-tool-refusal",
      instructions: "Do not run.",
      model: "anthropic/claude-haiku-4-5",
      sandbox: "fixture",
      tools: [tool({
        name: "read_value",
        description: "Read a value.",
        input: schema.object({}),
        effect: "read",
        async execute() { return "value"; },
      })],
    });
    const baseline = {
      schema_version: 1,
      plan_id: "baseline.tool-agent",
      model: "anthropic/claude-haiku-4-5",
      reasoning: "none",
      segment_routes: [],
      budgets: {
        instructions: 1_000,
        tools: 1_000,
        memory: 0,
        history: 1_000,
        results_artifacts: 1_000,
        reasoning: 0,
        output: 512,
        retry_cascade_reserve: 0,
      },
      recovery: { namespace: definition.id, tools: [] },
      fallbacks: { unknown: "original", transform_error: "original", not_smaller: "original" },
    };
    const result = await compileProfiledNativePi({
      rootDir: "/does-not-run",
      entryPath: "src/agent.ts",
      agent: definition,
      contextIR: { schemaVersion: 1, segments: [] },
      profile: {},
      developmentEvals: [],
      holdoutEvals: [],
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
      catalogSha256: CATALOG_SHA256,
      transformRegistrySha256: hex("3"),
      runtimeVersion: "0.2.0",
    });
    assert.equal(result.status, "capability_refused");
    assert.equal(result.reason, "cave_compiler_tool_effect_coverage_unavailable");
    const child = agent({
      id: "native-tool-child",
      instructions: "Do not run.",
      model: "anthropic/claude-haiku-4-5",
      sandbox: "fixture",
    });
    const subagentDefinition = agent({
      id: "native-subagent-refusal",
      instructions: "Do not run.",
      model: "anthropic/claude-haiku-4-5",
      sandbox: "fixture",
      tools: [subagent({
        name: "delegate",
        description: "Delegate a task.",
        agent: child,
      })],
    });
    const subagentResult = await compileProfiledNativePi({
      rootDir: "/does-not-run",
      entryPath: "src/agent.ts",
      agent: subagentDefinition,
      contextIR: { schemaVersion: 1, segments: [] },
      profile: {},
      developmentEvals: [],
      holdoutEvals: [],
      baselinePlan: {
        ...baseline,
        plan_id: "baseline.subagent",
        recovery: { namespace: subagentDefinition.id, tools: [] },
      },
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
      catalogSha256: CATALOG_SHA256,
      transformRegistrySha256: hex("3"),
      runtimeVersion: "0.2.0",
    });
    assert.equal(subagentResult.status, "capability_refused");
    assert.equal(subagentResult.reason, "cave_compiler_tool_effect_coverage_unavailable");
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
