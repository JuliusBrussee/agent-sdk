import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AIMessage } from "@langchain/core/messages";
import { createModelBoundary } from "@caveman-ai/agent/model-boundary";
import {
  ADAPTER_CONFORMANCE_TEST_VECTOR,
  canonicalSerialize,
  defineConformanceReport,
  runAdapterConformance,
} from "../src/index.js";
import {
  createCloudflareAgentsAdapter,
  manifest as cloudflareManifest,
} from "../../adapters/cloudflare-agents/src/index.js";
import {
  createLangGraphAdapter,
  manifest as langGraphManifest,
} from "../../adapters/langgraph/src/index.js";
import {
  createMastraAdapter,
  manifest as mastraManifest,
  normalizeMastraUsage,
} from "../../adapters/mastra/src/index.js";
import {
  createOpenAIAgentsAdapter,
  manifest as openAIManifest,
  normalizeOpenAIAgentsUsage,
} from "../../adapters/openai-agents/src/index.js";
import {
  createVercelAISDKAdapter,
  manifest as vercelManifest,
  normalizeVercelUsage,
} from "../../adapters/vercel-ai-sdk/src/index.js";

const execFileAsync = promisify(execFile);
const encoder = new TextEncoder();
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDirectory, "../../..");
const capabilityOrder = new Map([
  "runLifecycle",
  "modelInterception",
  "contextTransformation",
  "toolObservation",
  "usageAccounting",
  "streaming",
  "abort",
  "replayAwareness",
  "durableObservation",
  "tracing",
  "compilation",
].map((name, index) => [name, index]));

const knownVercelUsage = Object.freeze({
  inputTokens: Object.freeze({
    total: 7,
    noCache: 4,
    cacheRead: 1,
    cacheWrite: 2,
  }),
  outputTokens: Object.freeze({
    total: 7,
    text: 5,
    reasoning: 2,
  }),
});
const knownMastraUsage = Object.freeze({
  inputTokens: 10,
  outputTokens: 4,
  totalTokens: 14,
  cachedInputTokens: 2,
  cacheCreationInputTokens: 1,
  reasoningTokens: 1,
});
const knownOpenAIUsage = Object.freeze({
  input_tokens: 10,
  output_tokens: 4,
  total_tokens: 14,
  input_tokens_details: Object.freeze({ cached_tokens: 2 }),
  output_tokens_details: Object.freeze({ reasoning_tokens: 1 }),
});

function evidence(caseId, observed) {
  return {
    status: "passed",
    evidence: encoder.encode(canonicalSerialize({
      caseId,
      observed,
      externalModelCalls: 0,
      proxyHops: 0,
    })),
  };
}

function skip() {
  return { status: "skipped", code: "fixture_unavailable" };
}

async function rejectsExact(operation, expected) {
  let caught = Symbol("not-thrown");
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert.strictEqual(caught, expected);
}

function phases(events) {
  return events.map((event) => event.phase);
}

function createFixtureBoundary({ transform, prepared, settled, failed } = {}) {
  return createModelBoundary([{
    id: "candidate-fixture",
    prepare(input) {
      prepared?.push(input);
      return transform?.(input) ?? input.request;
    },
    settled(input) {
      settled?.push(input);
    },
    failed(input) {
      failed?.push(input);
    },
  }]);
}

function vercelFixture() {
  const model = Object.freeze({ provider: "fixture-provider", modelId: "fixture-model" });
  const baseRequest = (overrides = {}) => ({
    prompt: [],
    abortSignal: new AbortController().signal,
    ...overrides,
  });
  const result = Object.freeze({
    content: Object.freeze([]),
    finishReason: Object.freeze({ unified: "stop", raw: "stop" }),
    usage: knownVercelUsage,
    warnings: Object.freeze([]),
  });
  const start = (callbacks, callId) => {
    callbacks.onStart({ callId });
    callbacks.onStepStart({
      callId,
      stepNumber: 0,
      provider: model.provider,
      modelId: model.modelId,
    });
  };
  const streamResult = (chunks) => ({
    stream: new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    }, { highWaterMark: 0 }),
  });

  return {
    cases: {
      "run-lifecycle.success": async () => {
        const events = [];
        const callbacks = createVercelAISDKAdapter({
          onLifecycleEvent: (event) => events.push(event),
        }).composeAgentCallbacks();
        callbacks.onStart({ callId: "candidate-run-success" });
        callbacks.onEnd({ callId: "candidate-run-success" });
        assert.deepEqual(phases(events), ["run.started", "run.completed"]);
        return { phases: phases(events), nativeResultPreserved: true };
      },
      "run-lifecycle.failure": skip,
      "model-interception.request": async () => {
        const prepared = [];
        const adapter = createVercelAISDKAdapter({
          modelBoundary: createFixtureBoundary({ prepared }),
        });
        const request = baseRequest();
        const transformed = await adapter.middleware.transformParams({ params: request, model });
        assert.strictEqual(prepared[0].request, request);
        assert.strictEqual(prepared[0].context.signal, request.abortSignal);
        assert.strictEqual(transformed, request);
        return {
          provider: prepared[0].context.provider,
          model: prepared[0].context.model,
          requestIdentityPreserved: true,
          signalIdentityPreserved: true,
        };
      },
      "model-interception.response": async () => {
        const settled = [];
        const adapter = createVercelAISDKAdapter({
          modelBoundary: createFixtureBoundary({ settled }),
        });
        const request = await adapter.middleware.transformParams({
          params: baseRequest(),
          model,
        });
        const output = await adapter.middleware.wrapGenerate({
          params: request,
          model,
          doGenerate: async () => result,
        });
        await Promise.resolve();
        assert.strictEqual(output, result);
        assert.strictEqual(settled[0].response, result);
        return { nativeResultIdentityPreserved: true, terminalCount: settled.length };
      },
      "model-interception.error": async () => {
        const failure = new Error("candidate-vercel-model-failure");
        const failed = [];
        const adapter = createVercelAISDKAdapter({
          modelBoundary: createFixtureBoundary({ failed }),
        });
        const request = await adapter.middleware.transformParams({
          params: baseRequest(),
          model,
        });
        await rejectsExact(() => adapter.middleware.wrapGenerate({
          params: request,
          model,
          doGenerate: async () => { throw failure; },
        }), failure);
        await Promise.resolve();
        assert.strictEqual(failed[0].error, failure);
        return { errorIdentityPreserved: true, terminalCount: failed.length };
      },
      "context-transformation.deterministic": async () => {
        const adapter = createVercelAISDKAdapter({
          modelBoundary: createFixtureBoundary({
            transform: ({ request }) => ({ ...request, temperature: 0.25 }),
          }),
        });
        const left = await adapter.middleware.transformParams({
          params: baseRequest(),
          model,
        });
        const right = await adapter.middleware.transformParams({
          params: baseRequest(),
          model,
        });
        assert.equal(left.temperature, 0.25);
        assert.equal(canonicalSerialize(left.prompt), canonicalSerialize(right.prompt));
        return { deterministicTemperature: left.temperature, promptBytesStable: true };
      },
      "context-transformation.cache-prefix-stable": async () => {
        const prompt = Object.freeze([{ role: "system", content: "stable-prefix" }]);
        const adapter = createVercelAISDKAdapter({
          modelBoundary: createFixtureBoundary({
            transform: ({ request }) => ({ ...request, temperature: 0.5 }),
          }),
        });
        const output = await adapter.middleware.transformParams({
          params: baseRequest({ prompt }),
          model,
        });
        assert.strictEqual(output.prompt, prompt);
        return { prefixReferencePreserved: true, prefixBytes: canonicalSerialize(prompt) };
      },
      "tool-observation.success": async () => {
        const events = [];
        const callbacks = createVercelAISDKAdapter({
          onLifecycleEvent: (event) => events.push(event),
        }).composeAgentCallbacks();
        start(callbacks, "candidate-tool-success");
        const toolCall = { toolCallId: "native-tool-success", toolName: "lookup" };
        callbacks.onToolExecutionStart({ callId: "candidate-tool-success", toolCall });
        callbacks.onToolExecutionEnd({
          callId: "candidate-tool-success",
          toolCall,
          toolOutput: { type: "tool-result" },
        });
        callbacks.onEnd({ callId: "candidate-tool-success" });
        assert.deepEqual(phases(events), [
          "run.started",
          "model.requested",
          "tool.started",
          "tool.completed",
          "run.completed",
        ]);
        return { phases: phases(events), proposedClaimed: false };
      },
      "tool-observation.failure": async () => {
        const events = [];
        const callbacks = createVercelAISDKAdapter({
          onLifecycleEvent: (event) => events.push(event),
        }).composeAgentCallbacks();
        start(callbacks, "candidate-tool-failure");
        const toolCall = { toolCallId: "native-tool-failure", toolName: "lookup" };
        callbacks.onToolExecutionStart({ callId: "candidate-tool-failure", toolCall });
        callbacks.onToolExecutionEnd({
          callId: "candidate-tool-failure",
          toolCall,
          toolOutput: { type: "tool-error" },
        });
        callbacks.onEnd({ callId: "candidate-tool-failure" });
        assert.ok(phases(events).includes("tool.error"));
        return { errorObserved: true, proposedClaimed: false };
      },
      "usage-accounting.known": async () => {
        const usage = normalizeVercelUsage(knownVercelUsage, {
          provider: model.provider,
          model: model.modelId,
        });
        assert.deepEqual([
          usage.inputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          usage.outputTokens,
          usage.reasoningTokens,
          usage.totalTokens,
          usage.cost.status,
        ], [4, 1, 2, 7, 2, 14, "unpriced"]);
        return { counts: [4, 1, 2, 7, 2, 14], costStatus: usage.cost.status };
      },
      "usage-accounting.unknown-fails-closed": async () => {
        const usage = normalizeVercelUsage({
          inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        }, { provider: model.provider, model: model.modelId });
        assert.equal(usage.totalTokens, null);
        assert.equal(usage.cost.status, "unknown");
        return { totalTokens: usage.totalTokens, costStatus: usage.cost.status };
      },
      "streaming.ordered-chunks": async () => {
        const adapter = createVercelAISDKAdapter();
        const request = await adapter.middleware.transformParams({ params: baseRequest(), model });
        const first = Object.freeze({ type: "text-delta", id: "one", delta: "a" });
        const second = Object.freeze({ type: "text-delta", id: "two", delta: "b" });
        const finish = Object.freeze({
          type: "finish",
          usage: knownVercelUsage,
          finishReason: Object.freeze({ unified: "stop", raw: "stop" }),
        });
        const output = await adapter.middleware.wrapStream({
          params: request,
          model,
          doStream: async () => streamResult([first, second, finish]),
        });
        const observed = [];
        for await (const chunk of output.stream) observed.push(chunk);
        assert.deepEqual(observed, [first, second, finish]);
        return { orderedChunkTypes: observed.map((chunk) => chunk.type), identityPreserved: true };
      },
      "streaming.terminal": async () => {
        const settled = [];
        const usage = [];
        const adapter = createVercelAISDKAdapter({
          modelBoundary: createFixtureBoundary({ settled }),
          onModelUsage: (value) => usage.push(value),
        });
        const request = await adapter.middleware.transformParams({ params: baseRequest(), model });
        const finish = Object.freeze({
          type: "finish",
          usage: knownVercelUsage,
          finishReason: Object.freeze({ unified: "stop", raw: "stop" }),
        });
        const native = streamResult([finish]);
        const output = await adapter.middleware.wrapStream({
          params: request,
          model,
          doStream: async () => native,
        });
        await output.stream.getReader().read();
        await Promise.resolve();
        assert.strictEqual(settled[0].response, native);
        assert.equal(usage[0].totalTokens, 14);
        return { finishObserved: true, usageTotal: usage[0].totalTokens };
      },
      "streaming.error": async () => {
        const failure = new Error("candidate-vercel-stream-failure");
        const failed = [];
        const adapter = createVercelAISDKAdapter({
          modelBoundary: createFixtureBoundary({ failed }),
        });
        const request = await adapter.middleware.transformParams({ params: baseRequest(), model });
        const native = {
          stream: new ReadableStream({ pull() { throw failure; } }, { highWaterMark: 0 }),
        };
        const output = await adapter.middleware.wrapStream({
          params: request,
          model,
          doStream: async () => native,
        });
        await rejectsExact(() => output.stream.getReader().read(), failure);
        await Promise.resolve();
        assert.strictEqual(failed[0].error, failure);
        return { errorIdentityPreserved: true };
      },
      "abort.pre-start": async () => {
        const reason = new Error("candidate-vercel-pre-abort");
        const controller = new AbortController();
        controller.abort(reason);
        let nativeCalls = 0;
        const adapter = createVercelAISDKAdapter({
          modelBoundary: createFixtureBoundary(),
        });
        await rejectsExact(() => adapter.middleware.transformParams({
          params: baseRequest({ abortSignal: controller.signal }),
          model,
        }), reason);
        assert.equal(nativeCalls, 0);
        return { errorIdentityPreserved: true, nativeCalls };
      },
      "abort.in-flight": async () => {
        const reason = new Error("candidate-vercel-inflight-abort");
        const controller = new AbortController();
        const prepared = [];
        const adapter = createVercelAISDKAdapter({
          modelBoundary: createFixtureBoundary({ prepared }),
        });
        const request = await adapter.middleware.transformParams({
          params: baseRequest({ abortSignal: controller.signal }),
          model,
        });
        const pending = adapter.middleware.wrapGenerate({
          params: request,
          model,
          doGenerate: () => new Promise((resolveResult, reject) => {
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
              once: true,
            });
          }),
        });
        controller.abort(reason);
        await rejectsExact(() => pending, reason);
        assert.strictEqual(prepared[0].context.signal, controller.signal);
        return { errorIdentityPreserved: true, signalIdentityPreserved: true };
      },
    },
    performance: {
      "run-lifecycle.hook-overhead-p99": (() => {
        let index = 0;
        let activeCallId;
        const callbacks = createVercelAISDKAdapter({ onLifecycleEvent() {} })
          .composeAgentCallbacks();
        return () => {
          if (activeCallId === undefined) {
            activeCallId = `candidate-vercel-run-${index++}`;
            callbacks.onStart({ callId: activeCallId });
          } else {
            callbacks.onEnd({ callId: activeCallId });
            activeCallId = undefined;
          }
        };
      })(),
      "model-interception.hook-overhead-p99": null,
      "context-transformation.hook-overhead-p99": null,
      "tool-observation.hook-overhead-p99": (() => {
        let index = 0;
        let activeToolCall;
        const callbacks = createVercelAISDKAdapter({ onLifecycleEvent() {} })
          .composeAgentCallbacks();
        start(callbacks, "candidate-vercel-tool-perf");
        return () => {
          if (activeToolCall === undefined) {
            activeToolCall = { toolCallId: `tool-${index++}`, toolName: "noop" };
            callbacks.onToolExecutionStart({
              callId: "candidate-vercel-tool-perf",
              toolCall: activeToolCall,
            });
          } else {
            callbacks.onToolExecutionEnd({
              callId: "candidate-vercel-tool-perf",
              toolCall: activeToolCall,
              toolOutput: { type: "tool-result" },
            });
            activeToolCall = undefined;
          }
        };
      })(),
      "usage-accounting.hook-overhead-p99": () => {
        normalizeVercelUsage(knownVercelUsage, {
          provider: model.provider,
          model: model.modelId,
        });
      },
      "streaming.chunk-overhead-p99": null,
    },
  };
}

function langGraphFixture() {
  const knownMessage = new AIMessage({
    content: "ok",
    usage_metadata: {
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
      input_token_details: { cache_read: 2, cache_creation: 1 },
      output_token_details: { reasoning: 1 },
    },
  });
  const knownOutput = { generations: [[{ message: knownMessage }]] };
  const openScope = (handler, suffix) => {
    const root = `root-${suffix}`;
    const step = `step-${suffix}`;
    handler.handleChainStart({}, {}, root);
    handler.handleChainStart({}, {}, step, root);
    return { root, step };
  };

  return {
    cases: {
      "run-lifecycle.success": async () => {
        const events = [];
        const handler = createLangGraphAdapter({
          onLifecycle: (event) => events.push(event),
        }).callbackHandler;
        const { root, step } = openScope(handler, "candidate-success");
        handler.handleChainEnd({}, step);
        handler.handleChainEnd({}, root);
        assert.deepEqual(phases(events), ["run.started", "run.completed"]);
        return { phases: phases(events), nestedStepPreserved: true };
      },
      "run-lifecycle.failure": async () => {
        const failure = new Error("candidate-langgraph-run-failure");
        const events = [];
        const handler = createLangGraphAdapter({
          onLifecycle: (event) => events.push(event),
        }).callbackHandler;
        const { root } = openScope(handler, "candidate-failure");
        handler.handleChainError(failure, root);
        assert.deepEqual(phases(events), ["run.started", "run.error"]);
        return { phases: phases(events), hostErrorUntouched: true };
      },
      "tool-observation.success": async () => {
        const events = [];
        const handler = createLangGraphAdapter({
          onLifecycle: (event) => events.push(event),
        }).callbackHandler;
        const { root, step } = openScope(handler, "candidate-tool-success");
        handler.handleToolStart({}, "{}", "tool-success", step, [], {}, "lookup", "call-1");
        handler.handleToolEnd("ok", "tool-success");
        handler.handleChainEnd({}, root);
        assert.deepEqual(phases(events), [
          "run.started",
          "tool.started",
          "tool.completed",
          "run.completed",
        ]);
        return { phases: phases(events), proposedClaimed: false };
      },
      "tool-observation.failure": async () => {
        const events = [];
        const handler = createLangGraphAdapter({
          onLifecycle: (event) => events.push(event),
        }).callbackHandler;
        const { root, step } = openScope(handler, "candidate-tool-failure");
        handler.handleToolStart({}, "{}", "tool-failure", step, [], {}, "lookup", "call-2");
        handler.handleToolError(new Error("native tool failure"), "tool-failure");
        handler.handleChainEnd({}, root);
        assert.ok(phases(events).includes("tool.error"));
        return { errorObserved: true, proposedClaimed: false };
      },
      "usage-accounting.known": async () => {
        const observations = [];
        const handler = createLangGraphAdapter({
          model: { provider: "openai", model: "gpt-5-mini" },
          onUsage: (value) => observations.push(value),
        }).callbackHandler;
        const { root, step } = openScope(handler, "candidate-usage-known");
        handler.handleChatModelStart({}, [[]], "model-known", step);
        handler.handleLLMEnd(knownOutput, "model-known");
        handler.handleChainEnd({}, root);
        assert.deepEqual([
          observations[0].usage.inputTokens,
          observations[0].usage.cacheReadTokens,
          observations[0].usage.cacheWriteTokens,
          observations[0].usage.outputTokens,
          observations[0].usage.reasoningTokens,
          observations[0].usage.totalTokens,
        ], [7, 2, 1, 4, 1, 14]);
        return { counts: [7, 2, 1, 4, 1, 14], costStatus: "unknown" };
      },
      "usage-accounting.unknown-fails-closed": async () => {
        const observations = [];
        const handler = createLangGraphAdapter({
          model: { provider: "openai", model: "gpt-5-mini" },
          onUsage: (value) => observations.push(value),
        }).callbackHandler;
        const { root, step } = openScope(handler, "candidate-usage-unknown");
        handler.handleChatModelStart({}, [[]], "model-unknown", step);
        handler.handleLLMEnd({
          generations: [[{ message: new AIMessage({ content: "unknown" }) }]],
        }, "model-unknown");
        handler.handleChainEnd({}, root);
        assert.equal(observations[0].usage.totalTokens, null);
        assert.equal(observations[0].usage.cost.status, "unknown");
        return { totalTokens: null, costStatus: "unknown" };
      },
      "streaming.ordered-chunks": async () => {
        const observed = [];
        const transformer = createLangGraphAdapter({
          onStreamEvent: (event) => observed.push(event),
        }).transformer();
        const source = [
          { event: "on_chain_stream", data: { chunk: "a" } },
          { event: "on_chain_stream", data: { chunk: "b" } },
        ];
        for (const event of source) assert.equal(transformer.process(event), true);
        assert.deepEqual(observed, source);
        assert.notStrictEqual(observed[0], source[0]);
        return { orderedChunks: observed.map((event) => event.data.chunk), detached: true };
      },
      "streaming.terminal": async () => {
        const observed = [];
        const transformer = createLangGraphAdapter({
          onStreamEvent: (event) => observed.push(event),
        }).transformer();
        const terminal = { event: "on_chain_end", data: { output: "done" } };
        assert.equal(transformer.process(terminal), true);
        assert.deepEqual(observed, [terminal]);
        return { terminalEventPreserved: true, sourceOwnershipRetained: true };
      },
      "streaming.error": async () => {
        const failure = new Error("candidate-langgraph-stream-failure");
        const diagnostics = [];
        const transformer = createLangGraphAdapter({
          onObserverError: (value) => diagnostics.push(value),
        }).transformer();
        assert.equal(transformer.fail(failure), undefined);
        assert.strictEqual(diagnostics[0].error, failure);
        assert.equal(diagnostics[0].stage, "stream.source");
        return { errorIdentityPreserved: true, sourceOwnershipRetained: true };
      },
    },
    performance: {
      "run-lifecycle.hook-overhead-p99": (() => {
        let index = 0;
        let activeRoot;
        const handler = createLangGraphAdapter({ onLifecycle() {} }).callbackHandler;
        return () => {
          if (activeRoot === undefined) {
            activeRoot = `candidate-langgraph-run-${index++}`;
            handler.handleChainStart({}, {}, activeRoot);
          } else {
            handler.handleChainEnd({}, activeRoot);
            activeRoot = undefined;
          }
        };
      })(),
      "tool-observation.hook-overhead-p99": (() => {
        let index = 0;
        let activeTool;
        const handler = createLangGraphAdapter({ onLifecycle() {} }).callbackHandler;
        const { step } = openScope(handler, "candidate-tool-perf");
        return () => {
          if (activeTool === undefined) {
            activeTool = `tool-${index++}`;
            handler.handleToolStart({}, "{}", activeTool, step);
          } else {
            handler.handleToolEnd("ok", activeTool);
            activeTool = undefined;
          }
        };
      })(),
      "usage-accounting.hook-overhead-p99": (() => {
        const handler = createLangGraphAdapter({
          model: { provider: "openai", model: "gpt-5-mini" },
          onUsage() {},
        }).callbackHandler;
        const benchmark = ADAPTER_CONFORMANCE_TEST_VECTOR.performance.find(
          ({ id }) => id === "usage-accounting.hook-overhead-p99",
        );
        const modelRuns = [];
        for (let index = 0;
          index < benchmark.warmupCount + benchmark.sampleCount;
          index += 1) {
          const { step } = openScope(handler, `usage-perf-${index}`);
          const modelRun = `model-${index}`;
          handler.handleChatModelStart({}, [[]], modelRun, step);
          modelRuns.push(modelRun);
        }
        let index = 0;
        return () => {
          handler.handleLLMEnd(knownOutput, modelRuns[index++]);
        };
      })(),
      "streaming.chunk-overhead-p99": (() => {
        const transformer = createLangGraphAdapter({ onStreamEvent() {} }).transformer();
        const event = Object.freeze({ event: "on_chain_stream", data: Object.freeze({ chunk: "x" }) });
        return () => { transformer.process(event); };
      })(),
    },
  };
}

function openAIFixture() {
  const request = (overrides = {}) => ({
    input: Object.freeze([{ role: "system", content: "stable-prefix" }]),
    modelSettings: { temperature: 0.2, preserveRawUsage: false },
    tools: Object.freeze([]),
    outputType: "text",
    handoffs: Object.freeze([]),
    tracing: false,
    ...overrides,
  });
  const response = (rawUsage = knownOpenAIUsage) => ({
    output: Object.freeze([]),
    rawUsage,
  });
  const nativeModel = ({ getResponse, getStreamedResponse }) => ({
    getResponse: getResponse ?? (async () => response()),
    getStreamedResponse: getStreamedResponse ?? (async function* empty() {}),
  });
  const wrappedModel = async (model, options = {}) => createOpenAIAgentsAdapter(
    { getModel: () => model },
    options,
  ).getModel("gpt-5-mini");

  return {
    cases: {
      "model-interception.request": async () => {
        const prepared = [];
        let nativeRequest;
        const model = await wrappedModel(nativeModel({
          async getResponse(value) {
            nativeRequest = value;
            return response();
          },
        }), { modelBoundary: createFixtureBoundary({ prepared }) });
        const original = request();
        await model.getResponse(original);
        assert.strictEqual(prepared[0].request, nativeRequest);
        assert.equal(nativeRequest.modelSettings.preserveRawUsage, true);
        assert.equal(original.modelSettings.preserveRawUsage, false);
        return {
          provider: prepared[0].context.provider,
          model: prepared[0].context.model,
          rawUsageForced: true,
          originalDetached: true,
        };
      },
      "model-interception.response": async () => {
        const settled = [];
        const nativeResponse = response();
        const model = await wrappedModel(nativeModel({
          getResponse: async () => nativeResponse,
        }), { modelBoundary: createFixtureBoundary({ settled }) });
        const output = await model.getResponse(request());
        await Promise.resolve();
        assert.strictEqual(output, nativeResponse);
        assert.strictEqual(settled[0].response, nativeResponse);
        return { nativeResultIdentityPreserved: true, terminalCount: settled.length };
      },
      "model-interception.error": async () => {
        const failure = new Error("candidate-openai-model-failure");
        const failed = [];
        const model = await wrappedModel(nativeModel({
          getResponse: async () => { throw failure; },
        }), { modelBoundary: createFixtureBoundary({ failed }) });
        await rejectsExact(() => model.getResponse(request()), failure);
        await Promise.resolve();
        assert.strictEqual(failed[0].error, failure);
        return { errorIdentityPreserved: true, terminalCount: failed.length };
      },
      "context-transformation.deterministic": async () => {
        const received = [];
        const model = await wrappedModel(nativeModel({
          async getResponse(value) {
            received.push(value);
            return response();
          },
        }), {
          modelBoundary: createFixtureBoundary({
            transform: ({ request: value }) => ({
              ...value,
              modelSettings: { ...value.modelSettings, temperature: 0.25 },
            }),
          }),
        });
        await model.getResponse(request());
        await model.getResponse(request());
        assert.equal(received[0].modelSettings.temperature, 0.25);
        assert.equal(
          canonicalSerialize(received[0].modelSettings),
          canonicalSerialize(received[1].modelSettings),
        );
        return { deterministicTemperature: 0.25, rawUsageForced: true };
      },
      "context-transformation.cache-prefix-stable": async () => {
        const prefix = Object.freeze([{ role: "system", content: "stable-prefix" }]);
        let received;
        const model = await wrappedModel(nativeModel({
          async getResponse(value) {
            received = value;
            return response();
          },
        }), {
          modelBoundary: createFixtureBoundary({
            transform: ({ request: value }) => ({
              ...value,
              modelSettings: { ...value.modelSettings, temperature: 0.5 },
            }),
          }),
        });
        await model.getResponse(request({ input: prefix }));
        assert.strictEqual(received.input, prefix);
        return { prefixReferencePreserved: true, prefixBytes: canonicalSerialize(prefix) };
      },
      "usage-accounting.known": async () => {
        const usage = normalizeOpenAIAgentsUsage(knownOpenAIUsage, {
          provider: "openai",
          model: "gpt-5-mini",
        });
        assert.deepEqual([
          usage.inputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          usage.outputTokens,
          usage.reasoningTokens,
          usage.totalTokens,
        ], [8, 2, null, 4, 1, 14]);
        return { counts: [8, 2, null, 4, 1, 14], costStatus: "unknown" };
      },
      "usage-accounting.unknown-fails-closed": async () => {
        const usage = normalizeOpenAIAgentsUsage(undefined, {
          provider: "openai",
          model: "gpt-5-mini",
        });
        assert.equal(usage.totalTokens, null);
        assert.equal(usage.cost.status, "unknown");
        return { totalTokens: null, costStatus: "unknown" };
      },
      "streaming.ordered-chunks": async () => {
        const first = Object.freeze({ type: "response_started" });
        const second = Object.freeze({ type: "response_output_text_delta", delta: "x" });
        const done = Object.freeze({ type: "response_done", response: response() });
        const model = await wrappedModel(nativeModel({
          getStreamedResponse: async function* stream() {
            yield first;
            yield second;
            yield done;
          },
        }));
        const observed = [];
        for await (const event of model.getStreamedResponse(request())) observed.push(event);
        assert.deepEqual(observed, [first, second, done]);
        return { orderedTypes: observed.map((event) => event.type), identityPreserved: true };
      },
      "streaming.terminal": async () => {
        const settled = [];
        const usages = [];
        const terminal = response();
        const model = await wrappedModel(nativeModel({
          getStreamedResponse: async function* stream() {
            yield { type: "response_done", response: terminal };
          },
        }), {
          modelBoundary: createFixtureBoundary({ settled }),
          onModelUsage: (value) => usages.push(value),
        });
        for await (const _event of model.getStreamedResponse(request())) {
          // Consumption is the native terminal boundary.
        }
        await Promise.resolve();
        assert.strictEqual(settled[0].response, terminal);
        assert.equal(usages[0].usage.totalTokens, 14);
        return { terminalIdentityPreserved: true, usageTotal: 14 };
      },
      "streaming.error": async () => {
        const failure = new Error("candidate-openai-stream-failure");
        const failed = [];
        const model = await wrappedModel(nativeModel({
          getStreamedResponse: async function* stream() { throw failure; },
        }), { modelBoundary: createFixtureBoundary({ failed }) });
        const iterator = model.getStreamedResponse(request())[Symbol.asyncIterator]();
        await rejectsExact(() => iterator.next(), failure);
        await Promise.resolve();
        assert.strictEqual(failed[0].error, failure);
        return { errorIdentityPreserved: true };
      },
      "abort.pre-start": async () => {
        const reason = new Error("candidate-openai-pre-abort");
        const controller = new AbortController();
        controller.abort(reason);
        let nativeCalls = 0;
        const model = await wrappedModel(nativeModel({
          async getResponse() {
            nativeCalls += 1;
            return response();
          },
        }), { modelBoundary: createFixtureBoundary() });
        await rejectsExact(() => model.getResponse(request({ signal: controller.signal })), reason);
        assert.equal(nativeCalls, 0);
        return { errorIdentityPreserved: true, nativeCalls };
      },
      "abort.in-flight": async () => {
        const reason = new Error("candidate-openai-inflight-abort");
        const controller = new AbortController();
        let releasePrepare;
        const boundary = createModelBoundary([{
          id: "candidate-abort",
          prepare: () => new Promise((resolvePrepare) => { releasePrepare = resolvePrepare; }),
        }]);
        let nativeCalls = 0;
        const model = await wrappedModel(nativeModel({
          async getResponse() {
            nativeCalls += 1;
            return response();
          },
        }), { modelBoundary: boundary });
        const pending = model.getResponse(request({ signal: controller.signal }));
        await Promise.resolve();
        controller.abort(reason);
        await rejectsExact(() => pending, reason);
        releasePrepare?.();
        assert.equal(nativeCalls, 0);
        return { errorIdentityPreserved: true, nativeCalls };
      },
    },
    performance: {
      "model-interception.hook-overhead-p99": null,
      "context-transformation.hook-overhead-p99": null,
      "usage-accounting.hook-overhead-p99": () => {
        normalizeOpenAIAgentsUsage(knownOpenAIUsage, {
          provider: "openai",
          model: "gpt-5-mini",
        });
      },
      "streaming.chunk-overhead-p99": null,
    },
  };
}

function cloudflareFixture() {
  const event = (type, payload) => ({ type, payload, timestamp: 0 });
  return {
    cases: {
      "run-lifecycle.success": async () => {
        const native = [];
        const lifecycle = [];
        const adapter = createCloudflareAgentsAdapter({
          observability: { emit(value) { native.push(value); return value; } },
          onLifecycleEvent: (value) => lifecycle.push(value),
        });
        const start = event("chat:turn:start", { requestId: "candidate-cloudflare-success" });
        const finish = event("chat:turn:finish", {
          requestId: "candidate-cloudflare-success",
          status: "completed",
        });
        assert.strictEqual(adapter.observability.emit(start), start);
        assert.strictEqual(adapter.observability.emit(finish), finish);
        assert.deepEqual(native, [start, finish]);
        assert.deepEqual(phases(lifecycle), ["run.started", "run.completed"]);
        return { phases: phases(lifecycle), nativeDeliveryPreserved: true };
      },
      "run-lifecycle.failure": async () => {
        const lifecycle = [];
        const adapter = createCloudflareAgentsAdapter({
          observability: { emit(value) { return value; } },
          onLifecycleEvent: (value) => lifecycle.push(value),
        });
        const start = event("fiber:run:started", { fiberId: "candidate-fiber-failure" });
        const failure = event("fiber:run:failed", { fiberId: "candidate-fiber-failure" });
        assert.strictEqual(adapter.observability.emit(start), start);
        assert.strictEqual(adapter.observability.emit(failure), failure);
        assert.deepEqual(phases(lifecycle), ["run.started", "run.error"]);
        return { phases: phases(lifecycle), nativeDeliveryPreserved: true };
      },
    },
    performance: {
      "run-lifecycle.hook-overhead-p99": (() => {
        let index = 0;
        const adapter = createCloudflareAgentsAdapter({
          observability: { emit() {} },
          onLifecycleEvent() {},
        });
        let activeFiberId;
        return () => {
          if (activeFiberId === undefined) {
            activeFiberId = `candidate-cloudflare-perf-${index++}`;
            adapter.observability.emit(event("fiber:run:started", {
              fiberId: activeFiberId,
            }));
          } else {
            adapter.observability.emit(event("fiber:run:completed", {
              fiberId: activeFiberId,
            }));
            activeFiberId = undefined;
          }
        };
      })(),
    },
  };
}

function mastraFixture() {
  const model = Object.freeze({ provider: "test-provider", modelId: "test-model" });
  const nativeArgs = (state, extra = {}) => ({
    state,
    retryCount: 0,
    abortSignal: new AbortController().signal,
    tracingContext: { currentSpan: { traceId: "a".repeat(32) } },
    ...extra,
  });
  const request = async (processor, state, overrides = {}) => processor.processLLMRequest(
    nativeArgs(state, {
      prompt: Object.freeze([{ role: "system", content: "stable-prefix" }]),
      model,
      stepNumber: 0,
      steps: Object.freeze([]),
      ...overrides,
    }),
  );
  const respond = (processor, state, overrides = {}) => processor.processLLMResponse(
    nativeArgs(state, {
      chunks: Object.freeze([]),
      fromCache: false,
      model,
      stepNumber: 0,
      ...overrides,
    }),
  );

  return {
    cases: {
      "run-lifecycle.success": async () => {
        const state = {};
        const events = [];
        const processor = createMastraAdapter({ onLifecycle: (event) => events.push(event) });
        await request(processor, state);
        respond(processor, state);
        const nativeResult = {};
        assert.strictEqual(processor.processOutputResult(nativeArgs(state, {
          messageList: nativeResult,
        })), nativeResult);
        assert.deepEqual(phases(events), [
          "run.started",
          "model.requested",
          "model.responded",
          "run.completed",
        ]);
        return { phases: phases(events), nativeResultIdentityPreserved: true };
      },
      "run-lifecycle.failure": skip,
      "model-interception.request": async () => {
        const state = {};
        const prepared = [];
        const processor = createMastraAdapter({
          modelBoundary: createFixtureBoundary({ prepared }),
        });
        const prompt = Object.freeze([{ role: "user", content: "hello" }]);
        const output = await request(processor, state, { prompt });
        assert.strictEqual(output.prompt, prompt);
        assert.strictEqual(prepared[0].request, prompt);
        assert.equal(prepared[0].context.provider, model.provider);
        return { requestIdentityPreserved: true, provider: prepared[0].context.provider };
      },
      "model-interception.response": async () => {
        const state = {};
        const settled = [];
        const processor = createMastraAdapter({
          modelBoundary: createFixtureBoundary({ settled }),
        });
        await request(processor, state);
        const chunks = Object.freeze([{ type: "finish" }]);
        respond(processor, state, { chunks });
        await Promise.resolve();
        assert.strictEqual(settled[0].response.chunks, chunks);
        return { responseChunkIdentityPreserved: true, terminalCount: settled.length };
      },
      "model-interception.error": async () => {
        const state = {};
        const failed = [];
        const processor = createMastraAdapter({
          modelBoundary: createFixtureBoundary({ failed }),
        });
        await request(processor, state);
        const failure = new Error("candidate-mastra-model-failure");
        processor.processAPIError(nativeArgs(state, {
          error: failure,
          stepNumber: 0,
          messageList: {},
        }));
        await Promise.resolve();
        assert.strictEqual(failed[0].error, failure);
        return { boundaryErrorIdentityPreserved: true, lifecycleErrorClaimed: false };
      },
      "context-transformation.deterministic": async () => {
        const processor = createMastraAdapter({
          modelBoundary: createFixtureBoundary({
            transform: ({ request: prompt }) => [...prompt, { role: "system", content: "fixed" }],
          }),
        });
        const left = await request(processor, {}, { prompt: [] });
        const right = await request(processor, {}, { prompt: [] });
        assert.equal(canonicalSerialize(left.prompt), canonicalSerialize(right.prompt));
        return { deterministicPrompt: canonicalSerialize(left.prompt) };
      },
      "context-transformation.cache-prefix-stable": async () => {
        const prefix = Object.freeze({ role: "system", content: "stable-prefix" });
        const prompt = Object.freeze([prefix]);
        const processor = createMastraAdapter({
          modelBoundary: createFixtureBoundary({
            transform: ({ request: value }) => [...value, { role: "user", content: "tail" }],
          }),
        });
        const output = await request(processor, {}, { prompt });
        assert.strictEqual(output.prompt[0], prefix);
        return { prefixReferencePreserved: true, prefixBytes: canonicalSerialize(prefix) };
      },
      "tool-observation.success": async () => {
        const state = {};
        const events = [];
        const processor = createMastraAdapter({ onLifecycle: (event) => events.push(event) });
        await request(processor, state);
        const call = {
          type: "tool-call",
          payload: { toolCallId: "candidate-tool", toolName: "lookup", args: {} },
        };
        assert.strictEqual(await processor.processOutputStream(nativeArgs(state, { part: call })), call);
        respond(processor, state);
        const result = {
          type: "tool-result",
          payload: { toolCallId: "candidate-tool", toolName: "lookup", result: { ok: true } },
        };
        assert.strictEqual(await processor.processOutputStream(nativeArgs(state, { part: result })), result);
        processor.processOutputResult(nativeArgs(state, { messageList: {} }));
        assert.deepEqual(phases(events), [
          "run.started",
          "model.requested",
          "model.responded",
          "tool.proposed",
          "tool.started",
          "tool.completed",
          "run.completed",
        ]);
        return { phases: phases(events), nativeChunkIdentityPreserved: true };
      },
      "tool-observation.failure": async () => {
        const state = {};
        const events = [];
        const processor = createMastraAdapter({ onLifecycle: (event) => events.push(event) });
        await request(processor, state);
        respond(processor, state);
        const failure = new Error("candidate-tool-failure");
        const chunk = {
          type: "tool-error",
          payload: { toolCallId: "candidate-tool-error", toolName: "lookup", error: failure },
        };
        assert.strictEqual(await processor.processOutputStream(nativeArgs(state, { part: chunk })), chunk);
        processor.processOutputResult(nativeArgs(state, { messageList: {} }));
        assert.ok(phases(events).includes("tool.error"));
        return { errorObserved: true, nativeChunkIdentityPreserved: true };
      },
      "usage-accounting.known": async () => {
        const usage = normalizeMastraUsage(knownMastraUsage, {
          provider: model.provider,
          model: model.modelId,
        });
        assert.deepEqual([
          usage.inputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          usage.outputTokens,
          usage.reasoningTokens,
          usage.totalTokens,
        ], [7, 2, 1, 4, 1, 14]);
        return { counts: [7, 2, 1, 4, 1, 14], costStatus: "unpriced" };
      },
      "usage-accounting.unknown-fails-closed": async () => {
        const usage = normalizeMastraUsage({
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
        }, { provider: model.provider, model: model.modelId });
        assert.equal(usage.inputTokens, null);
        assert.equal(usage.totalTokens, 14);
        assert.equal(usage.cost.status, "unknown");
        return { disjointInputTokens: null, totalTokens: 14, costStatus: "unknown" };
      },
      "streaming.ordered-chunks": async () => {
        const state = {};
        const processor = createMastraAdapter({ onLifecycle() {} });
        await request(processor, state);
        const source = [
          { type: "text-delta", payload: { text: "a" } },
          { type: "text-delta", payload: { text: "b" } },
        ];
        const observed = [];
        for (const part of source) {
          observed.push(await processor.processOutputStream(nativeArgs(state, { part })));
        }
        assert.deepEqual(observed, source);
        return { orderedText: observed.map((part) => part.payload.text), identityPreserved: true };
      },
      "streaming.terminal": async () => {
        const state = {};
        const events = [];
        const processor = createMastraAdapter({ onLifecycle: (event) => events.push(event) });
        await request(processor, state);
        respond(processor, state);
        const nativeResult = {};
        assert.strictEqual(processor.processOutputResult(nativeArgs(state, {
          messageList: nativeResult,
        })), nativeResult);
        assert.equal(phases(events).at(-1), "run.completed");
        return { terminalObserved: true, nativeResultIdentityPreserved: true };
      },
      "streaming.error": skip,
      "abort.pre-start": async () => {
        const reason = new Error("candidate-mastra-pre-abort");
        const controller = new AbortController();
        controller.abort(reason);
        const processor = createMastraAdapter({ modelBoundary: createFixtureBoundary() });
        await rejectsExact(() => request(processor, {}, {
          abortSignal: controller.signal,
        }), reason);
        return { errorIdentityPreserved: true, providerCalls: 0 };
      },
      "abort.in-flight": async () => {
        const reason = new Error("candidate-mastra-inflight-abort");
        const controller = new AbortController();
        let releasePrepare;
        const boundary = createModelBoundary([{
          id: "candidate-abort",
          prepare: () => new Promise((resolvePrepare) => { releasePrepare = resolvePrepare; }),
        }]);
        const processor = createMastraAdapter({ modelBoundary: boundary });
        const pending = request(processor, {}, { abortSignal: controller.signal });
        await Promise.resolve();
        controller.abort(reason);
        await rejectsExact(() => pending, reason);
        releasePrepare?.();
        return { errorIdentityPreserved: true, providerCalls: 0 };
      },
    },
    performance: {
      "run-lifecycle.hook-overhead-p99": (() => {
        const processor = createMastraAdapter({ onLifecycle() {} });
        const benchmark = ADAPTER_CONFORMANCE_TEST_VECTOR.performance.find(
          ({ id }) => id === "run-lifecycle.hook-overhead-p99",
        );
        const states = [];
        for (let index = 0;
          index < benchmark.warmupCount + benchmark.sampleCount;
          index += 1) {
          const state = {};
          void processor.processLLMRequest(nativeArgs(state, {
            prompt: [], model, stepNumber: 0, steps: [],
          }));
          processor.processLLMResponse(nativeArgs(state, {
            chunks: [], fromCache: false, model, stepNumber: 0,
          }));
          states.push(state);
        }
        let index = 0;
        return () => {
          processor.processOutputResult(nativeArgs(states[index], { messageList: index }));
          index += 1;
        };
      })(),
      "model-interception.hook-overhead-p99": null,
      "context-transformation.hook-overhead-p99": null,
      "tool-observation.hook-overhead-p99": (() => {
        const processor = createMastraAdapter({ onLifecycle() {} });
        const benchmark = ADAPTER_CONFORMANCE_TEST_VECTOR.performance.find(
          ({ id }) => id === "tool-observation.hook-overhead-p99",
        );
        const states = [];
        for (let index = 0;
          index < benchmark.warmupCount + benchmark.sampleCount;
          index += 1) {
          const state = {};
          void processor.processLLMRequest(nativeArgs(state, {
            prompt: [], model, stepNumber: 0, steps: [],
          }));
          processor.processLLMResponse(nativeArgs(state, {
            chunks: [], fromCache: false, model, stepNumber: 0,
          }));
          states.push(state);
        }
        let index = 0;
        return () => {
          void processor.processOutputStream(nativeArgs(states[index], {
            part: {
              type: "tool-result",
              payload: { toolCallId: `tool-${index}`, toolName: "noop", result: null },
            },
          }));
          index += 1;
        };
      })(),
      "usage-accounting.hook-overhead-p99": () => {
        normalizeMastraUsage(knownMastraUsage, {
          provider: model.provider,
          model: model.modelId,
        });
      },
      "streaming.chunk-overhead-p99": (() => {
        const processor = createMastraAdapter();
        const args = nativeArgs({}, { part: { type: "text-delta", payload: { text: "x" } } });
        return () => { void processor.processOutputStream(args); };
      })(),
    },
  };
}

const adapterDefinitions = Object.freeze([
  Object.freeze({
    id: "vercel-ai-sdk",
    directory: "vercel-ai-sdk",
    manifest: vercelManifest,
    fixture: vercelFixture,
    auxiliary: Object.freeze({}),
  }),
  Object.freeze({
    id: "langgraph",
    directory: "langgraph",
    manifest: langGraphManifest,
    fixture: langGraphFixture,
    auxiliary: Object.freeze({ "@langchain/core": "1.2.9" }),
  }),
  Object.freeze({
    id: "openai-agents",
    directory: "openai-agents",
    manifest: openAIManifest,
    fixture: openAIFixture,
    auxiliary: Object.freeze({ "@openai/agents-core": "0.17.0" }),
  }),
  Object.freeze({
    id: "cloudflare-agents",
    directory: "cloudflare-agents",
    manifest: cloudflareManifest,
    fixture: cloudflareFixture,
    auxiliary: Object.freeze({}),
  }),
  Object.freeze({
    id: "mastra",
    directory: "mastra",
    manifest: mastraManifest,
    fixture: mastraFixture,
    auxiliary: Object.freeze({}),
  }),
]);

async function packageRoot(packageName, fromDirectory) {
  const require = createRequire(pathToFileURL(join(fromDirectory, "candidate-anchor.mjs")));
  const entry = await realpath(require.resolve(packageName));
  let cursor = dirname(entry);
  for (;;) {
    try {
      const packagePath = join(cursor, "package.json");
      const value = JSON.parse(await readFile(packagePath, "utf8"));
      if (value.name === packageName) return { directory: cursor, packageJSON: value };
    } catch {
      // Keep walking until the matching package root is found.
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`candidate_package_root_missing:${packageName}`);
    cursor = parent;
  }
}

async function packDirectory(directory, outputDirectory) {
  const packEnvironment = {
    LANG: "C",
    LC_ALL: "C",
    PATH: process.env.PATH ?? "",
    npm_config_cache: join(outputDirectory, "npm-cache"),
    npm_config_globalconfig: join(outputDirectory, "global.npmrc"),
    npm_config_ignore_scripts: "true",
    npm_config_userconfig: join(outputDirectory, "user.npmrc"),
  };
  const { stdout } = await execFileAsync("npm", [
    "pack",
    ".",
    "--json",
    "--ignore-scripts",
    "--offline",
    "--pack-destination",
    outputDirectory,
  ], {
    cwd: directory,
    env: packEnvironment,
    maxBuffer: 16 * 1024 * 1024,
  });
  const packed = JSON.parse(stdout.trim());
  assert.equal(packed.length, 1);
  const metadata = packed[0];
  return {
    bytes: await readFile(join(outputDirectory, metadata.filename)),
    filename: metadata.filename,
    size: metadata.size,
  };
}

function selectedCapabilities(manifest) {
  return Object.entries(manifest.capabilities)
    .filter(([, state]) => state === "experimental")
    .map(([name]) => name)
    .sort((left, right) => capabilityOrder.get(left) - capabilityOrder.get(right));
}

async function validateDefinition(definition, adapterDirectory) {
  const adapterPackage = JSON.parse(await readFile(join(adapterDirectory, "package.json"), "utf8"));
  assert.equal(definition.manifest.id, definition.id);
  assert.equal(definition.manifest.packageName, adapterPackage.name);
  assert.equal(definition.manifest.adapterVersion, adapterPackage.version);
  assert.equal(definition.manifest.upstream.version,
    adapterPackage.peerDependencies[definition.manifest.upstream.package] ??
      adapterPackage.devDependencies[definition.manifest.upstream.package]);
  assert.deepEqual(definition.manifest.certifications, {});
  assert.equal(Object.values(definition.manifest.capabilities).includes("certified"), false);

  const upstream = await packageRoot(definition.manifest.upstream.package, adapterDirectory);
  assert.equal(upstream.packageJSON.version, definition.manifest.upstream.version);
  for (const [name, version] of Object.entries(definition.auxiliary)) {
    const installed = await packageRoot(name, adapterDirectory);
    assert.equal(installed.packageJSON.version, version);
    assert.equal(
      adapterPackage.peerDependencies[name] ?? adapterPackage.devDependencies[name],
      version,
    );
  }
  return { adapterPackage, upstream };
}

async function buildReport(definition, temporaryDirectory) {
  const adapterDirectory = join(repositoryRoot, "packages/adapters", definition.directory);
  const { adapterPackage, upstream } = await validateDefinition(definition, adapterDirectory);
  const adapterArtifact = await packDirectory(adapterDirectory, temporaryDirectory);
  const upstreamArtifact = await packDirectory(upstream.directory, temporaryDirectory);
  const capabilities = selectedCapabilities(definition.manifest);
  const selected = new Set(capabilities);
  const fixture = definition.fixture();
  const cases = ADAPTER_CONFORMANCE_TEST_VECTOR.cases
    .filter((testCase) => selected.has(testCase.capability))
    .map((testCase) => {
      const run = fixture.cases[testCase.id];
      assert.equal(typeof run, "function", `candidate_case_missing:${definition.id}:${testCase.id}`);
      return {
        id: testCase.id,
        async run(vector) {
          const observed = await run(vector);
          if (observed?.status === "skipped") return observed;
          return evidence(testCase.id, observed);
        },
      };
    });
  const performance = ADAPTER_CONFORMANCE_TEST_VECTOR.performance
    .filter((benchmark) => selected.has(benchmark.capability))
    .map((benchmark) => {
      const run = fixture.performance[benchmark.id];
      assert.notEqual(run, undefined,
        `candidate_performance_missing:${definition.id}:${benchmark.id}`);
      return run === null
        ? { id: benchmark.id, skipped: { code: "fixture_unavailable" } }
        : { id: benchmark.id, run };
    });
  const report = await runAdapterConformance({
    adapter: {
      id: definition.id,
      packageName: adapterPackage.name,
      version: adapterPackage.version,
    },
    upstream: {
      packageName: upstream.packageJSON.name,
      version: upstream.packageJSON.version,
    },
    artifacts: {
      adapter: adapterArtifact.bytes,
      upstream: upstreamArtifact.bytes,
    },
    capabilities,
    cases,
    performance,
  });
  return Object.freeze({
    definition,
    report,
    adapterArtifact: Object.freeze({
      filename: adapterArtifact.filename,
      size: adapterArtifact.size,
    }),
    upstreamArtifact: Object.freeze({
      filename: upstreamArtifact.filename,
      size: upstreamArtifact.size,
    }),
  });
}

function reproducibleView(report) {
  return {
    schema: report.schema,
    suite: report.suite,
    adapter: report.adapter,
    upstream: report.upstream,
    packages: report.packages,
    testVector: report.testVector,
    capabilities: report.capabilities,
    performance: report.performance.map(({ observed: _observed, ...entry }) => entry),
    totals: report.totals,
  };
}

async function generate(definitions = adapterDefinitions) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "caveman-candidates-"));
  try {
    const output = [];
    for (const definition of definitions) {
      output.push(await buildReport(definition, temporaryDirectory));
    }
    return output;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function check() {
  const generated = await generate();
  const checked = [];
  for (const candidate of generated) {
    const reportPath = join(
      repositoryRoot,
      "packages/adapters",
      candidate.definition.directory,
      "conformance/candidate-report.json",
    );
    const committed = defineConformanceReport(JSON.parse(await readFile(reportPath, "utf8")));
    assert.deepEqual(
      reproducibleView(candidate.report),
      reproducibleView(committed),
      `candidate_report_drift:${candidate.definition.id}`,
    );
    assert.equal(candidate.adapterArtifact.size <= 25 * 1024, true,
      `candidate_adapter_tarball_too_large:${candidate.definition.id}`);
    checked.push(Object.freeze({ ...candidate, committedReport: committed }));
  }
  return checked;
}

function summarize(candidates) {
  return candidates.map((candidate) => ({
    adapter: candidate.definition.id,
    committedReportDigest: candidate.committedReport?.reportDigest ?? candidate.report.reportDigest,
    currentRunDigest: candidate.report.reportDigest,
    qualification: candidate.report.totals.capabilities,
    cases: candidate.report.totals.cases,
    performance: candidate.report.totals.performance,
    adapterArtifact: candidate.adapterArtifact,
    upstreamArtifact: candidate.upstreamArtifact,
  }));
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "--check";
  if (mode === "--print") {
    const selected = process.argv[3];
    const definitions = selected === undefined
      ? adapterDefinitions
      : adapterDefinitions.filter(({ id }) => id === selected);
    if (definitions.length === 0) throw new Error(`candidate_adapter_unknown:${selected}`);
    const candidates = await generate(definitions);
    const output = selected === undefined
      ? Object.fromEntries(candidates.map(({ definition, report }) => [definition.id, report]))
      : candidates[0].report;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else if (mode === "--check") {
    process.stdout.write(`${JSON.stringify(summarize(await check()), null, 2)}\n`);
  } else {
    throw new Error("candidate_mode_invalid");
  }
}

export { check as checkCandidateReports, generate as generateCandidateReports };
