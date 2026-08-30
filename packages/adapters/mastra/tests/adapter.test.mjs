import assert from "node:assert/strict";
import test from "node:test";
import { createAdapterLifecycleValidator } from "@caveman-ai/adapter-kit";
import { createModelBoundary } from "@caveman-ai/agent/model-boundary";
import {
  createMastraAdapter,
  manifest,
  normalizeMastraUsage,
} from "../src/index.js";

const model = Object.freeze({ provider: "test-provider", modelId: "test-model" });

function nativeArgs(state, extra = {}) {
  return {
    state,
    retryCount: 0,
    abortSignal: new AbortController().signal,
    tracingContext: { currentSpan: { traceId: "a".repeat(32) } },
    ...extra,
  };
}

test("manifest pins exact Mastra version and claims only exposed native seams", () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.upstream, {
    package: "@mastra/core",
    version: "1.63.2",
  });
  assert.equal(manifest.capabilities.modelInterception, "experimental");
  assert.equal(manifest.capabilities.replayAwareness, "unsupported");
  assert.equal(manifest.capabilities.durableObservation, "unsupported");
  assert.equal(manifest.capabilities.tracing, "unsupported");
  assert.equal(manifest.lifecycle["run.error"], "unsupported");
  assert.equal(manifest.lifecycle["model.error"], "unsupported");
  assert.deepEqual(manifest.certifications, {});
});

test("native Processor transforms only prompt and observes exact successful flow", async () => {
  const state = {};
  const prompt = [{ role: "user", content: [{ type: "text", text: "before" }] }];
  const transformedPrompt = [
    { role: "user", content: [{ type: "text", text: "after" }] },
  ];
  const lifecycle = [];
  const usages = [];
  const settled = [];
  const boundary = createModelBoundary([{
    id: "test-transform",
    prepare: () => transformedPrompt,
    settled: (value) => settled.push(value),
  }]);
  const processor = createMastraAdapter({
    modelBoundary: boundary,
    onLifecycle: (event) => lifecycle.push(event),
    onModelUsage: (usage) => usages.push(usage),
  });

  const requestResult = await processor.processLLMRequest(nativeArgs(state, {
    prompt,
    model,
    stepNumber: 0,
    steps: [],
  }));
  assert.equal(requestResult.prompt, transformedPrompt);
  assert.equal(lifecycle.length, 0);

  const toolCall = Object.freeze({
    type: "tool-call",
    runId: "native-run",
    from: "AGENT",
    payload: Object.freeze({
      toolCallId: "call-1",
      toolName: "lookup",
      args: { value: 1 },
    }),
  });
  assert.equal(
    await processor.processOutputStream(nativeArgs(state, { part: toolCall })),
    toolCall,
  );
  assert.equal(lifecycle.length, 0);

  const chunks = [{ type: "finish", payload: { done: true } }];
  processor.processLLMResponse(nativeArgs(state, {
    chunks,
    fromCache: false,
    model,
    stepNumber: 0,
  }));
  assert.deepEqual(lifecycle.map((event) => event.phase), [
    "run.started",
    "model.requested",
    "model.responded",
    "tool.proposed",
  ]);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].response.chunks, chunks);
  assert.equal(settled[0].response.fromCache, false);

  const toolResult = Object.freeze({
    type: "tool-result",
    runId: "native-run",
    from: "AGENT",
    payload: Object.freeze({
      toolCallId: "call-1",
      toolName: "lookup",
      result: { ok: true },
    }),
  });
  assert.equal(
    await processor.processOutputStream(nativeArgs(state, { part: toolResult })),
    toolResult,
  );

  const messageList = {};
  assert.equal(processor.processOutputStep(nativeArgs(state, {
    messageList,
    stepNumber: 0,
    usage: {
      inputTokens: 999,
      outputTokens: 999,
      totalTokens: 1_998,
      raw: {
        inputTokens: { total: 10, noCache: 7, cacheRead: 2, cacheWrite: 1 },
        outputTokens: { total: 4, text: 3, reasoning: 1 },
      },
    },
  })), messageList);
  assert.deepEqual(usages[0].usage, {
    schemaVersion: 1,
    provider: "test-provider",
    model: "test-model",
    inputTokens: 7,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 1,
    totalTokens: 14,
    cost: { status: "unpriced" },
  });

  assert.equal(processor.processOutputResult(nativeArgs(state, {
    messageList,
  })), messageList);
  assert.deepEqual(lifecycle.map((event) => event.phase), [
    "run.started",
    "model.requested",
    "model.responded",
    "tool.proposed",
    "tool.started",
    "tool.completed",
    "run.completed",
  ]);
  const validator = createAdapterLifecycleValidator();
  for (const event of lifecycle) validator.accept(event);
  validator.finish();
});

test("cache replay remains host-owned and creates no provider accounting", async () => {
  const state = {};
  const lifecycle = [];
  const usages = [];
  let settled = 0;
  const processor = createMastraAdapter({
    modelBoundary: createModelBoundary([{
      id: "cache-test",
      settled: () => { settled += 1; },
    }]),
    onLifecycle: (event) => lifecycle.push(event),
    onModelUsage: (usage) => usages.push(usage),
  });
  const prompt = [];
  const prepared = await processor.processLLMRequest(nativeArgs(state, {
    prompt,
    model,
    stepNumber: 0,
    steps: [],
  }));
  assert.equal(prepared.prompt, prompt);
  processor.processLLMResponse(nativeArgs(state, {
    chunks: [],
    fromCache: true,
    model,
    stepNumber: 0,
  }));
  processor.processOutputStep(nativeArgs(state, {
    messageList: {},
    stepNumber: 0,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  }));
  processor.processOutputResult(nativeArgs(state, { messageList: {} }));
  assert.equal(settled, 0);
  assert.deepEqual(lifecycle, []);
  assert.deepEqual(usages, []);
});

test("nonretryable native error reaches boundary failure observer exactly once", async () => {
  const state = {};
  const failures = [];
  const observerErrors = [];
  const processor = createMastraAdapter({
    modelBoundary: createModelBoundary([{
      id: "failure-test",
      failed: ({ error }) => failures.push(error),
    }]),
    onObserverError: (error) => observerErrors.push(error),
  });
  await processor.processLLMRequest(nativeArgs(state, {
    prompt: [],
    model,
    stepNumber: 0,
    steps: [],
  }));
  const failure = new Error("native failure");
  assert.equal(processor.processAPIError(nativeArgs(state, {
    error: failure,
    stepNumber: 0,
    messageList: {},
  })), undefined);
  assert.equal(processor.processAPIError(nativeArgs(state, {
    error: failure,
    stepNumber: 0,
    messageList: {},
  })), undefined);
  await Promise.resolve();
  assert.deepEqual(failures, [failure]);
  assert.deepEqual(observerErrors, []);
});

test("tool failures are exact, duplicate terminal chunks are idempotent", async () => {
  const state = {};
  const lifecycle = [];
  const processor = createMastraAdapter({
    onLifecycle: (event) => lifecycle.push(event),
  });
  await processor.processLLMRequest(nativeArgs(state, {
    prompt: [],
    model,
    stepNumber: 2,
    steps: [],
  }));
  processor.processLLMResponse(nativeArgs(state, {
    chunks: [],
    fromCache: false,
    model,
    stepNumber: 2,
  }));
  const toolError = {
    type: "tool-error",
    payload: { toolCallId: "bad-call", toolName: "broken", error: new Error("x") },
  };
  assert.equal(await processor.processOutputStream(nativeArgs(state, { part: toolError })), toolError);
  assert.equal(await processor.processOutputStream(nativeArgs(state, { part: toolError })), toolError);
  processor.processOutputResult(nativeArgs(state, { messageList: {} }));
  assert.deepEqual(lifecycle.map((event) => event.phase), [
    "run.started",
    "model.requested",
    "model.responded",
    "tool.proposed",
    "tool.error",
    "run.completed",
  ]);
  const validator = createAdapterLifecycleValidator();
  for (const event of lifecycle) validator.accept(event);
  validator.finish();
});

test("host control chunks pass through by identity and create no lifecycle events", async () => {
  const state = {};
  const lifecycle = [];
  const processor = createMastraAdapter({ onLifecycle: (event) => lifecycle.push(event) });
  await processor.processLLMRequest(nativeArgs(state, {
    prompt: [],
    model,
    stepNumber: 0,
    steps: [],
  }));
  const controlChunk = Object.freeze({
    type: "tool-call-suspended",
    payload: Object.freeze({ opaque: true }),
  });
  assert.equal(
    await processor.processOutputStream(nativeArgs(state, { part: controlChunk })),
    controlChunk,
  );
  assert.deepEqual(lifecycle, []);
});

test("observer failures cannot replace native Processor values", async () => {
  const state = {};
  const failures = [];
  const processor = createMastraAdapter({
    onLifecycle: () => { throw new Error("sink failure"); },
    onModelUsage: () => Promise.reject(new Error("usage failure")),
    onObserverError: (failure) => failures.push(failure),
  });
  const prompt = [];
  const result = await processor.processLLMRequest(nativeArgs(state, {
    prompt,
    model,
    stepNumber: 0,
    steps: [],
  }));
  assert.equal(result.prompt, prompt);
  processor.processLLMResponse(nativeArgs(state, {
    chunks: [],
    fromCache: false,
    model,
    stepNumber: 0,
  }));
  const messageList = {};
  assert.equal(processor.processOutputStep(nativeArgs(state, {
    messageList,
    stepNumber: 0,
    usage: {
      inputTokens: 2,
      outputTokens: 1,
      totalTokens: 3,
      cachedInputTokens: 1,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
    },
  })), messageList);
  assert.equal(processor.processOutputResult(nativeArgs(state, { messageList })), messageList);
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(failures.some((failure) => failure.stage === "lifecycle.sink"));
  assert.ok(failures.some((failure) => failure.stage === "usage.sink"));
});

test("usage conversion prefers V3 raw and keeps V2 unknown fields null", () => {
  const identity = { provider: "provider", model: "model" };
  assert.deepEqual(normalizeMastraUsage({
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    cachedInputTokens: 2,
    cacheCreationInputTokens: 1,
    reasoningTokens: 1,
  }, identity), {
    schemaVersion: 1,
    provider: "provider",
    model: "model",
    inputTokens: 7,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 1,
    totalTokens: 14,
    cost: { status: "unpriced" },
  });

  assert.deepEqual(normalizeMastraUsage({
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
  }, identity), {
    schemaVersion: 1,
    provider: "provider",
    model: "model",
    inputTokens: null,
    outputTokens: 4,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: 14,
    cost: { status: "unknown" },
  });

  const raw = {
    inputTokens: { total: 10, noCache: 6, cacheRead: 3, cacheWrite: 1 },
    outputTokens: { total: 5, text: 3, reasoning: 2 },
  };
  const normalized = normalizeMastraUsage({
    inputTokens: 100,
    outputTokens: 100,
    totalTokens: 200,
    raw,
  }, identity);
  assert.equal(normalized.inputTokens, 6);
  assert.equal(normalized.cacheReadTokens, 3);
  assert.equal(normalized.cacheWriteTokens, 1);
  assert.equal(normalized.totalTokens, 15);

  assert.throws(
    () => normalizeMastraUsage({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 13,
      cachedInputTokens: 2,
      cacheCreationInputTokens: 1,
      reasoningTokens: 1,
    }, identity),
    /cave_model_usage_invalid:totalTokens/,
  );
});

test("option accessors and unknown keys fail without executing getter", () => {
  let reads = 0;
  const accessor = {};
  Object.defineProperty(accessor, "onLifecycle", {
    enumerable: true,
    get() {
      reads += 1;
      return () => undefined;
    },
  });
  assert.throws(
    () => createMastraAdapter(accessor),
    /cave_mastra_adapter_options_invalid/,
  );
  assert.equal(reads, 0);
  assert.throws(
    () => createMastraAdapter({ unknown: true }),
    /cave_mastra_adapter_options_invalid/,
  );
});

test("model boundary method is captured once and invoked with native receiver", async () => {
  let reads = 0;
  let receiver;
  let terminalReceiver;
  let boundaryCall;
  const boundary = {};
  Object.defineProperty(boundary, "prepare", {
    get() {
      reads += 1;
      return function prepare(request, context) {
        receiver = this;
        boundaryCall = Object.freeze({
          request,
          context,
          async settled(response) {
            terminalReceiver = this;
            return response;
          },
          async failed(error) { throw error; },
        });
        return boundaryCall;
      };
    },
  });
  const processor = createMastraAdapter({ modelBoundary: boundary });
  assert.equal(reads, 1);
  const prompt = [];
  const state = {};
  const result = await processor.processLLMRequest(nativeArgs(state, {
    prompt,
    model,
    stepNumber: 0,
    steps: [],
  }));
  processor.processLLMResponse(nativeArgs(state, {
    chunks: [],
    fromCache: false,
    model,
    stepNumber: 0,
  }));
  await Promise.resolve();
  assert.equal(result.prompt, prompt);
  assert.equal(receiver, boundary);
  assert.equal(terminalReceiver, boundaryCall);
  assert.equal(reads, 1);
});

test("native abort signal reaches model boundary without provider ownership", async () => {
  const reason = new Error("native abort");
  const controller = new AbortController();
  controller.abort(reason);
  const processor = createMastraAdapter({
    modelBoundary: createModelBoundary([{ id: "abort-test" }]),
  });
  await assert.rejects(
    processor.processLLMRequest(nativeArgs({}, {
      abortSignal: controller.signal,
      prompt: [],
      model,
      stepNumber: 0,
      steps: [],
    })),
    (error) => error === reason,
  );
});
