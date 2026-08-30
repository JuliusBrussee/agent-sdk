import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createAdapterLifecycleValidator } from "@caveman-ai/adapter-kit";
import { createModelBoundary } from "@caveman-ai/agent/model-boundary";
import { MockLanguageModelV4 } from "ai/test";
import { wrapLanguageModel } from "ai";
import {
  VERCEL_AI_SDK_VERSION,
  createVercelAISDKAdapter,
  manifest,
  normalizeVercelUsage,
} from "@caveman-ai/adapter-vercel-ai-sdk";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const require = createRequire(import.meta.url);

function rawUsage(overrides = {}) {
  return {
    inputTokens: {
      total: 7,
      noCache: 4,
      cacheRead: 1,
      cacheWrite: 2,
      ...(overrides.inputTokens ?? {}),
    },
    outputTokens: {
      total: 7,
      text: 5,
      reasoning: 2,
      ...(overrides.outputTokens ?? {}),
    },
  };
}

function generateResult(usage = rawUsage()) {
  return {
    content: [{ type: "text", text: "ok" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: [],
  };
}

function startCallbacks(callbacks, callId = "call-native-1", stepNumber = 0) {
  callbacks.onStart({ callId });
  callbacks.onStepStart({
    callId,
    stepNumber,
    provider: "fixture-provider",
    modelId: "fixture-model",
  });
}

test("manifest is exact V2, experimental-only, and truthful about unavailable paths", () => {
  assert.equal(require("ai/package.json").version, "7.0.84");
  assert.equal(VERCEL_AI_SDK_VERSION, "7.0.84");
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.upstream, { package: "ai", version: "7.0.84" });
  assert.equal(manifest.lifecycle["model.requested"], "intercept");
  assert.equal(manifest.lifecycle["run.error"], "unsupported");
  assert.equal(manifest.capabilities.replayAwareness, "unsupported");
  assert.deepEqual(manifest.certifications, {});
  assert.equal(
    Object.values(manifest.capabilities).includes("certified"),
    false,
  );
});

test("native MockLanguageModelV4 generate transforms request and preserves result identity", async () => {
  const settled = [];
  const usage = [];
  const events = [];
  const boundary = createModelBoundary([{
    id: "fixture-transform",
    prepare({ request }) {
      return { ...request, temperature: 0.25 };
    },
    settled(input) {
      settled.push(input.response);
    },
  }]);
  const adapter = createVercelAISDKAdapter({
    modelBoundary: boundary,
    onLifecycleEvent: (event) => events.push(event),
    onModelUsage: (value) => usage.push(value),
  });
  const nativeResult = generateResult();
  const nativeModel = new MockLanguageModelV4({
    provider: "fixture-provider",
    modelId: "fixture-model",
    doGenerate: nativeResult,
  });
  const wrapped = wrapLanguageModel({
    model: nativeModel,
    middleware: adapter.middleware,
  });
  const callbacks = adapter.composeAgentCallbacks();
  startCallbacks(callbacks);

  const result = await wrapped.doGenerate({ prompt: [] });
  callbacks.onEnd({ callId: "call-native-1" });
  await tick();

  assert.strictEqual(result, nativeResult);
  assert.equal(nativeModel.doGenerateCalls.length, 1);
  assert.equal(nativeModel.doGenerateCalls[0].temperature, 0.25);
  assert.strictEqual(settled[0], nativeResult);
  assert.deepEqual(usage[0], {
    schemaVersion: 1,
    provider: "fixture-provider",
    model: "fixture-model",
    inputTokens: 4,
    outputTokens: 7,
    cacheReadTokens: 1,
    cacheWriteTokens: 2,
    reasoningTokens: 2,
    totalTokens: 14,
    cost: { status: "unpriced" },
  });
  assert.deepEqual(events.map((event) => event.phase), [
    "run.started",
    "model.requested",
    "model.responded",
    "run.completed",
  ]);
  const validator = createAdapterLifecycleValidator();
  for (const event of events) validator.accept(event);
  validator.finish();
});

test("generate failure and retry preserve thrown identity and increment model attempt", async () => {
  const failure = new Error("native provider failure");
  const failed = [];
  const events = [];
  let calls = 0;
  const boundary = createModelBoundary([{
    id: "failure-observer",
    failed({ error }) {
      failed.push(error);
    },
  }]);
  const adapter = createVercelAISDKAdapter({
    modelBoundary: boundary,
    onLifecycleEvent: (event) => events.push(event),
  });
  const nativeResult = generateResult();
  const nativeModel = new MockLanguageModelV4({
    provider: "fixture-provider",
    modelId: "fixture-model",
    doGenerate: async () => {
      calls += 1;
      if (calls === 1) throw failure;
      return nativeResult;
    },
  });
  const wrapped = wrapLanguageModel({ model: nativeModel, middleware: adapter.middleware });
  const callbacks = adapter.composeAgentCallbacks();
  startCallbacks(callbacks, "call-retry");
  const prompt = [];

  let caught;
  try {
    await wrapped.doGenerate({ prompt });
  } catch (error) {
    caught = error;
  }
  assert.strictEqual(caught, failure);

  const result = await wrapped.doGenerate({ prompt });
  callbacks.onEnd({ callId: "call-retry" });
  await tick();

  assert.strictEqual(result, nativeResult);
  assert.strictEqual(failed[0], failure);
  assert.deepEqual(events.map((event) => [event.phase, event.identity.attempt]), [
    ["run.started", 1],
    ["model.requested", 1],
    ["model.error", 1],
    ["model.requested", 2],
    ["model.responded", 2],
    ["run.completed", 1],
  ]);
  const validator = createAdapterLifecycleValidator();
  for (const event of events) validator.accept(event);
  validator.finish();
});

test("stream stays pull-driven and preserves chunks, usage, and terminal observation", async () => {
  let pulls = 0;
  const settled = [];
  const usages = [];
  const chunks = [
    { type: "text-delta", id: "text-1", delta: "a" },
    {
      type: "finish",
      usage: rawUsage(),
      finishReason: { unified: "stop", raw: "stop" },
    },
  ];
  const source = new ReadableStream({
    pull(controller) {
      pulls += 1;
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  const nativeResult = { stream: source, response: { headers: { "x-test": "yes" } } };
  const boundary = createModelBoundary([{
    id: "stream-observer",
    settled({ response }) {
      settled.push(response);
    },
  }]);
  const adapter = createVercelAISDKAdapter({
    modelBoundary: boundary,
    onModelUsage: (usage) => usages.push(usage),
  });
  const nativeModel = new MockLanguageModelV4({
    provider: "fixture-provider",
    modelId: "fixture-model",
    doStream: nativeResult,
  });
  const wrapped = wrapLanguageModel({ model: nativeModel, middleware: adapter.middleware });
  const result = await wrapped.doStream({ prompt: [] });

  assert.equal(pulls, 0);
  assert.strictEqual(result.response, nativeResult.response);
  const reader = result.stream.getReader();
  assert.deepEqual(await reader.read(), {
    done: false,
    value: { type: "text-delta", id: "text-1", delta: "a" },
  });
  assert.equal(pulls, 1);
  const finish = await reader.read();
  assert.equal(finish.done, false);
  assert.equal(finish.value.type, "finish");
  assert.equal(pulls, 2);
  await tick();

  assert.strictEqual(settled[0], nativeResult);
  assert.equal(usages[0].totalTokens, 14);
  assert.equal(usages[0].cost.status, "unpriced");
});

test("stream forwards cancellation and source errors with exact identity", async () => {
  const cancelReason = { kind: "stop" };
  let forwardedCancel;
  const cancelledFailures = [];
  const cancelAdapter = createVercelAISDKAdapter({
    modelBoundary: createModelBoundary([{
      id: "cancel-observer",
      failed({ error }) {
        cancelledFailures.push(error);
      },
    }]),
  });
  const cancelSource = new ReadableStream({
    cancel(reason) {
      forwardedCancel = reason;
    },
  }, { highWaterMark: 0 });
  const cancelModel = new MockLanguageModelV4({
    doStream: { stream: cancelSource },
  });
  const cancelWrapped = wrapLanguageModel({
    model: cancelModel,
    middleware: cancelAdapter.middleware,
  });
  const cancelResult = await cancelWrapped.doStream({ prompt: [] });
  await cancelResult.stream.cancel(cancelReason);
  await tick();
  assert.strictEqual(forwardedCancel, cancelReason);
  assert.strictEqual(cancelledFailures[0], cancelReason);

  const sourceFailure = new Error("source failed");
  const observedFailures = [];
  const errorAdapter = createVercelAISDKAdapter({
    modelBoundary: createModelBoundary([{
      id: "stream-error-observer",
      failed({ error }) {
        observedFailures.push(error);
      },
    }]),
  });
  const errorSource = new ReadableStream({
    pull() {
      throw sourceFailure;
    },
  }, { highWaterMark: 0 });
  const errorModel = new MockLanguageModelV4({ doStream: { stream: errorSource } });
  const errorWrapped = wrapLanguageModel({
    model: errorModel,
    middleware: errorAdapter.middleware,
  });
  const errorResult = await errorWrapped.doStream({ prompt: [] });
  let caught;
  try {
    await errorResult.stream.getReader().read();
  } catch (error) {
    caught = error;
  }
  await tick();
  assert.strictEqual(caught, sourceFailure);
  assert.strictEqual(observedFailures[0], sourceFailure);
});

test("stream cancellation during pending pull forwards once without wrapper error", async () => {
  let release;
  let forwarded;
  const source = new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => { release = resolve; });
      controller.enqueue({ type: "text-delta", id: "late", delta: "late" });
    },
    cancel(reason) {
      forwarded = reason;
      release?.();
    },
  }, { highWaterMark: 0 });
  const adapter = createVercelAISDKAdapter();
  const model = new MockLanguageModelV4({ doStream: { stream: source } });
  const wrapped = wrapLanguageModel({ model, middleware: adapter.middleware });
  const result = await wrapped.doStream({ prompt: [] });
  const reader = result.stream.getReader();
  const pending = reader.read();
  await tick();
  const reason = new Error("cancel pending pull");
  await reader.cancel(reason);
  assert.strictEqual(forwarded, reason);
  assert.deepEqual(await pending, { done: true, value: undefined });
});

test("callback composition preserves result, receiver, and error identity", async () => {
  const lifecycle = [];
  const observerFailure = new Error("ignored observer failure");
  const adapter = createVercelAISDKAdapter({
    onLifecycleEvent(event) {
      lifecycle.push(event);
      throw observerFailure;
    },
  });
  const callbackResult = Promise.resolve();
  const receiver = {};
  const existing = {
    onStart(event) {
      assert.strictEqual(this, receiver);
      assert.equal(event.callId, "callback-call");
      return callbackResult;
    },
  };
  const callbacks = adapter.composeAgentCallbacks(existing);
  assert.strictEqual(
    callbacks.onStart.call(receiver, { callId: "callback-call" }),
    callbackResult,
  );
  await callbackResult;
  assert.equal(lifecycle[0].phase, "run.started");

  const callbackFailure = new Error("existing callback failed");
  const failing = createVercelAISDKAdapter({
    onLifecycleEvent: (event) => lifecycle.push(event),
  }).composeAgentCallbacks({
    onStart() {
      throw callbackFailure;
    },
  });
  assert.throws(
    () => failing.onStart({ callId: "never-observed" }),
    (error) => error === callbackFailure,
  );
  assert.equal(lifecycle.some(
    (event) => event.identity.nativeIds.vercelCallId === "never-observed",
  ), false);
});

test("tool callbacks map native tool-error without changing native event", () => {
  const events = [];
  const adapter = createVercelAISDKAdapter({
    onLifecycleEvent: (event) => events.push(event),
  });
  const callbacks = adapter.composeAgentCallbacks();
  startCallbacks(callbacks, "tool-run");
  const toolCall = { type: "tool-call", toolCallId: "native-tool-1", toolName: "lookup" };
  callbacks.onToolExecutionStart({ callId: "tool-run", toolCall });
  const toolError = new Error("tool failed");
  const endEvent = {
    callId: "tool-run",
    toolCall,
    toolOutput: { type: "tool-error", error: toolError },
  };
  assert.equal(callbacks.onToolExecutionEnd(endEvent), undefined);
  assert.strictEqual(endEvent.toolOutput.error, toolError);
  assert.deepEqual(events.slice(-2).map((event) => event.phase), [
    "tool.started",
    "tool.error",
  ]);
});

test("usage normalization maps unknown to null and never mints unpriced completeness", () => {
  const incomplete = normalizeVercelUsage(rawUsage({
    inputTokens: { noCache: undefined },
    outputTokens: { reasoning: undefined },
  }), { provider: "fixture-provider", model: "fixture-model" });
  assert.equal(incomplete.inputTokens, null);
  assert.equal(incomplete.reasoningTokens, null);
  assert.equal(incomplete.totalTokens, null);
  assert.deepEqual(incomplete.cost, { status: "unknown" });

  const publicUsage = normalizeVercelUsage({
    inputTokens: 7,
    inputTokenDetails: {
      noCacheTokens: 4,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
    },
    outputTokens: 7,
    outputTokenDetails: { textTokens: 5, reasoningTokens: 2 },
    totalTokens: 14,
  }, { provider: "fixture-provider", model: "fixture-model" });
  assert.equal(publicUsage.inputTokens, 4);
  assert.equal(publicUsage.totalTokens, 14);
  assert.deepEqual(publicUsage.cost, { status: "unpriced" });

  assert.throws(
    () => normalizeVercelUsage(rawUsage({
      inputTokens: { noCache: -1 },
    }), { provider: "fixture-provider", model: "fixture-model" }),
    /cave_model_usage_invalid:inputTokens/,
  );
});

test("options and callback accessors fail closed without getter execution", () => {
  let reads = 0;
  const options = {};
  Object.defineProperty(options, "onModelUsage", {
    enumerable: true,
    get() {
      reads += 1;
      return () => undefined;
    },
  });
  assert.throws(
    () => createVercelAISDKAdapter(options),
    /cave_vercel_adapter_options_invalid/,
  );
  assert.equal(reads, 0);

  const callbacks = {};
  Object.defineProperty(callbacks, "onStart", {
    enumerable: true,
    get() {
      reads += 1;
      return () => undefined;
    },
  });
  assert.throws(
    () => createVercelAISDKAdapter().composeAgentCallbacks(callbacks),
    /cave_vercel_adapter_callback_invalid:onStart/,
  );
  assert.equal(reads, 0);
});

test("model boundary cannot replace Vercel abort signal", async () => {
  const original = new AbortController();
  const replacement = new AbortController();
  const adapter = createVercelAISDKAdapter({
    modelBoundary: createModelBoundary([{
      id: "bad-abort-transform",
      prepare({ request }) {
        return { ...request, abortSignal: replacement.signal };
      },
    }]),
  });
  const model = new MockLanguageModelV4({ doGenerate: generateResult() });
  const wrapped = wrapLanguageModel({ model, middleware: adapter.middleware });
  await assert.rejects(
    wrapped.doGenerate({ prompt: [], abortSignal: original.signal }),
    /cave_vercel_adapter_abort_signal_changed/,
  );
  assert.equal(model.doGenerateCalls.length, 0);
});
