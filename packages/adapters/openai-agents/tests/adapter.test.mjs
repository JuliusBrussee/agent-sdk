import assert from "node:assert/strict";
import test from "node:test";
import {
  ScriptedModel,
  assistantMessage,
  modelError,
  modelResponse,
  modelStream,
} from "@openai/agents/testing";
import { Agent, Runner, Usage } from "@openai/agents";
import { createModelBoundary } from "@caveman-ai/agent/model-boundary";
import { defineAdapterManifest } from "@caveman-ai/adapter-kit";
import adapterPackage, {
  OPENAI_AGENTS_CORE_VERSION,
  OPENAI_AGENTS_VERSION,
  createOpenAIAgentsAdapter,
  manifest,
  normalizeOpenAIAgentsUsage,
} from "../src/index.js";

function request(overrides = {}) {
  return {
    input: "hello",
    modelSettings: { temperature: 0.2, preserveRawUsage: false },
    tools: [],
    outputType: "text",
    handoffs: [],
    tracing: false,
    ...overrides,
  };
}

function response(rawUsage) {
  return {
    usage: new Usage({
      requests: 1,
      inputTokens: 999,
      outputTokens: 999,
      totalTokens: 1_998,
    }),
    output: [assistantMessage("ok")],
    responseId: "response-1",
    rawUsage,
  };
}

test("manifest pins exact native versions and claims only model seam", () => {
  assert.equal(adapterPackage.manifest, manifest);
  assert.equal(OPENAI_AGENTS_VERSION, "0.17.0");
  assert.equal(OPENAI_AGENTS_CORE_VERSION, "0.17.0");
  assert.deepEqual(manifest.upstream, {
    package: "@openai/agents",
    version: "0.17.0",
  });
  assert.equal(manifest.capabilities.modelInterception, "experimental");
  assert.equal(manifest.capabilities.runLifecycle, "unsupported");
  assert.equal(manifest.capabilities.toolObservation, "unsupported");
  assert.equal(manifest.capabilities.tracing, "unsupported");
  assert.equal(manifest.lifecycle["model.requested"], "intercept");
  assert.equal(manifest.lifecycle["run.error"], "unsupported");
  assert.deepEqual(manifest.certifications, {});
  assert.deepEqual(defineAdapterManifest(manifest), manifest);
});

test("native Runner executes through wrapped ScriptedModel without replacing host loop", async () => {
  const scripted = new ScriptedModel([[assistantMessage("native-ok")]]);
  const modelProvider = createOpenAIAgentsAdapter({ getModel: () => scripted });
  const runner = new Runner({ modelProvider, tracingDisabled: true });
  const agent = new Agent({
    name: "native-test",
    instructions: "Return scripted output.",
    model: "gpt-5-mini",
  });
  const result = await runner.run(agent, "hello");
  assert.equal(result.finalOutput, "native-ok");
  assert.equal(scripted.calls.length, 1);
  assert.equal(scripted.firstCall.request.modelSettings.preserveRawUsage, true);
  scripted.assertComplete();
});

test("native ScriptedModel receives detached raw-usage request and exact terminal response", async () => {
  const rawUsage = {
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 1 },
  };
  const scripted = new ScriptedModel([modelResponse(response(rawUsage))]);
  const settled = [];
  const prepared = [];
  const usage = [];
  const boundary = createModelBoundary([{
    id: "native-test",
    prepare({ request: modelRequest }) {
      prepared.push(modelRequest);
    },
    settled(value) {
      settled.push(value.response);
    },
  }]);
  const nativeProvider = {
    getModel(name) {
      assert.equal(name, "gpt-5-mini");
      return scripted;
    },
  };
  const wrappedProvider = createOpenAIAgentsAdapter(nativeProvider, {
    modelBoundary: boundary,
    onModelUsage(value) {
      usage.push(value);
    },
  });
  const original = request();
  const model = await wrappedProvider.getModel("gpt-5-mini");
  const result = await model.getResponse(original);
  await Promise.resolve();

  assert.equal(original.modelSettings.preserveRawUsage, false);
  assert.notEqual(scripted.firstCall.request, original);
  assert.notEqual(scripted.firstCall.request.modelSettings, original.modelSettings);
  assert.equal(scripted.firstCall.request.modelSettings.preserveRawUsage, true);
  assert.equal(prepared.length, 1);
  assert.deepEqual(prepared[0], scripted.firstCall.request);
  assert.equal(settled[0], result);
  assert.deepEqual(usage[0].usage, {
    schemaVersion: 1,
    provider: "openai",
    model: "gpt-5-mini",
    inputTokens: 8,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: null,
    reasoningTokens: 1,
    totalTokens: 14,
    cost: { status: "unknown" },
  });
  assert.ok(usage[0].identity.modelCallId);
  scripted.assertComplete();
});

test("request clone preserves signal, option identities, symbols, and native result identity", async () => {
  const marker = Symbol("marker");
  const signal = new AbortController().signal;
  const tools = [];
  const result = response(undefined);
  let received;
  const nativeModel = {
    async getResponse(value) {
      received = value;
      return result;
    },
    async *getStreamedResponse() {},
  };
  const model = await createOpenAIAgentsAdapter({
    getModel: () => nativeModel,
  }).getModel("gpt-5-mini");
  const original = request({ signal, tools, [marker]: "kept" });
  assert.equal(await model.getResponse(original), result);
  assert.notEqual(received, original);
  assert.equal(received.signal, signal);
  assert.equal(received.tools, tools);
  assert.equal(received[marker], "kept");
  assert.equal(received.modelSettings.temperature, 0.2);
  assert.equal(received.modelSettings.preserveRawUsage, true);
});

test("native ScriptedModel stream remains lazy and preserves exact event identities", async () => {
  const started = { type: "response_started" };
  const done = {
    type: "response_done",
    response: {
      id: "response-stream",
      usage: {},
      output: [],
      rawUsage: {
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    },
  };
  async function* events() {
    yield started;
    yield done;
  }
  const scripted = new ScriptedModel([modelStream(events())]);
  const usage = [];
  const settled = [];
  const boundary = createModelBoundary([{
    id: "stream-test",
    settled: ({ response: terminal }) => settled.push(terminal),
  }]);
  const model = await createOpenAIAgentsAdapter(
    { getModel: () => scripted },
    { modelBoundary: boundary, onModelUsage: (value) => usage.push(value) },
  ).getModel("gpt-5-mini");
  const stream = model.getStreamedResponse(request());
  assert.equal(scripted.calls.length, 0);
  const iterator = stream[Symbol.asyncIterator]();
  assert.equal(scripted.calls.length, 0);
  const startedRead = await iterator.next();
  assert.equal(startedRead.done, false);
  assert.equal(startedRead.value, started);
  assert.equal(scripted.calls.length, 1);
  const doneRead = await iterator.next();
  assert.equal(doneRead.done, false);
  assert.equal(doneRead.value, done);
  await Promise.resolve();
  assert.equal(settled[0], done.response);
  assert.equal(usage[0].usage.inputTokens, 5);
  assert.equal(usage[0].usage.outputTokens, 3);
  assert.equal(usage[0].usage.cacheReadTokens, 0);
  assert.equal(usage[0].usage.cacheWriteTokens, null);
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  scripted.assertComplete();
});

test("stream wrapper performs zero prefetch and forwards return, throw, and errors exactly", async () => {
  const returned = Object.freeze({ done: true, value: "native-return" });
  const thrownResult = Object.freeze({ done: false, value: { type: "response_started" } });
  const nextResult = Object.freeze({ done: false, value: { type: "response_started" } });
  const nextFailure = new Error("native next failed");
  const calls = [];
  let streamCalls = 0;
  const iterator = {
    next(value) {
      calls.push(["next", value]);
      if (value === "success") return nextResult;
      return Promise.reject(nextFailure);
    },
    return(value) {
      calls.push(["return", value]);
      return returned;
    },
    throw(error) {
      calls.push(["throw", error]);
      return thrownResult;
    },
  };
  const nativeModel = {
    async getResponse() {
      throw new Error("unused");
    },
    getStreamedResponse() {
      streamCalls += 1;
      return { [Symbol.asyncIterator]: () => iterator };
    },
  };
  const model = await createOpenAIAgentsAdapter({
    getModel: () => nativeModel,
  }).getModel("gpt-5-mini");

  const cancelledBeforePull = model.getStreamedResponse(request());
  assert.deepEqual(await cancelledBeforePull[Symbol.asyncIterator]().return("early"), {
    done: true,
    value: "early",
  });
  assert.equal(streamCalls, 0);

  const successfulStream = model.getStreamedResponse(request())[Symbol.asyncIterator]();
  assert.equal(await successfulStream.next("success"), nextResult);

  const returnedStream = model.getStreamedResponse(request())[Symbol.asyncIterator]();
  const pending = returnedStream.next("pull");
  await assert.rejects(pending, (error) => error === nextFailure);
  assert.equal(streamCalls, 2);

  const returnStream = model.getStreamedResponse(request())[Symbol.asyncIterator]();
  const first = returnStream.next("fail");
  await assert.rejects(first, (error) => error === nextFailure);
  assert.equal(await returnStream.return("cancel"), returned);

  const throwStream = model.getStreamedResponse(request())[Symbol.asyncIterator]();
  const failed = throwStream.next("fail-again");
  await assert.rejects(failed, (error) => error === nextFailure);
  const injected = new Error("consumer throw");
  assert.equal(await throwStream.throw(injected), thrownResult);
  assert.deepEqual(calls, [
    ["next", "success"],
    ["next", "pull"],
    ["next", "fail"],
    ["return", "cancel"],
    ["next", "fail-again"],
    ["throw", injected],
  ]);
});

test("native rejection and retry advice preserve exact error and advice", async () => {
  const sentinel = new Error("provider failed");
  const advice = Object.freeze({
    suggested: true,
    replaySafety: "safe",
    reason: "native",
  });
  const scripted = new ScriptedModel([modelError(sentinel, advice)]);
  const failed = [];
  const boundary = createModelBoundary([{
    id: "failure-test",
    failed: ({ error }) => failed.push(error),
  }]);
  const model = await createOpenAIAgentsAdapter(
    { getModel: () => scripted },
    { modelBoundary: boundary },
  ).getModel("gpt-5-mini");
  const original = request();
  await assert.rejects(model.getResponse(original), (error) => error === sentinel);
  await Promise.resolve();
  assert.equal(failed[0], sentinel);
  assert.deepEqual(await model.getRetryAdvice({
    request: original,
    error: sentinel,
    stream: false,
    attempt: 1,
  }), advice);
});

test("getRetryAdvice returns exact native value without wrapping", async () => {
  const advice = Object.freeze({ suggested: false, replaySafety: "unsafe" });
  const nativeModel = {
    async getResponse() {
      return response(undefined);
    },
    async *getStreamedResponse() {},
    getRetryAdvice() {
      return advice;
    },
  };
  const model = await createOpenAIAgentsAdapter({
    getModel: () => nativeModel,
  }).getModel("gpt-5-mini");
  assert.equal(model.getRetryAdvice({
    request: request(),
    error: new Error("failed"),
    stream: false,
    attempt: 1,
  }), advice);
});

test("usage normalization never converts absent raw values into zero", () => {
  const unknown = normalizeOpenAIAgentsUsage(undefined, {
    provider: "openai",
    model: "gpt-5-mini",
  });
  assert.deepEqual(unknown, {
    schemaVersion: 1,
    provider: "openai",
    model: "gpt-5-mini",
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    cost: { status: "unknown" },
  });
  assert.deepEqual(normalizeOpenAIAgentsUsage({
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    input_tokens_details: null,
    output_tokens_details: null,
  }, {
    provider: "openai",
    model: "gpt-5-mini",
  }), unknown);

  assert.throws(
    () => normalizeOpenAIAgentsUsage({
      input_tokens: 1,
      prompt_tokens: 1,
    }, { provider: "openai", model: "gpt-5-mini" }),
    /cave_openai_agents_adapter_usage_ambiguous:input_tokens/,
  );
  assert.throws(
    () => normalizeOpenAIAgentsUsage({
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 2 },
    }, { provider: "openai", model: "gpt-5-mini" }),
    /cave_openai_agents_adapter_usage_invalid:cached_tokens/,
  );
});

test("method getters captured once and observer failures cannot alter native result", async () => {
  const result = response(undefined);
  let providerReads = 0;
  let responseReads = 0;
  let streamReads = 0;
  let retryReads = 0;
  const nativeModel = Object.create(null, {
    getResponse: {
      get() {
        responseReads += 1;
        return async () => result;
      },
    },
    getStreamedResponse: {
      get() {
        streamReads += 1;
        return async function* () {};
      },
    },
    getRetryAdvice: {
      get() {
        retryReads += 1;
        return undefined;
      },
    },
  });
  const nativeProvider = Object.create(null, {
    getModel: {
      get() {
        providerReads += 1;
        return () => nativeModel;
      },
    },
  });
  const observerErrors = [];
  const wrapped = createOpenAIAgentsAdapter(nativeProvider, {
    onModelUsage() {
      throw new Error("observer failed");
    },
    onObserverError(value) {
      observerErrors.push(value);
    },
  });
  const model = await wrapped.getModel("gpt-5-mini");
  assert.equal(await model.getResponse(request()), result);
  await Promise.resolve();
  assert.deepEqual(
    { providerReads, responseReads, streamReads, retryReads },
    { providerReads: 1, responseReads: 1, streamReads: 1, retryReads: 1 },
  );
  assert.equal(observerErrors[0].source, "usage.sink");
});

test("boundary cannot disable required raw usage", async () => {
  let nativeCalls = 0;
  const failures = [];
  const boundary = createModelBoundary([{
    id: "disable-raw",
    prepare({ request: value }) {
      return { ...value, modelSettings: { ...value.modelSettings, preserveRawUsage: false } };
    },
    failed({ error }) {
      failures.push(error);
    },
  }]);
  const model = await createOpenAIAgentsAdapter({
    getModel: () => ({
      async getResponse() {
        nativeCalls += 1;
        return response(undefined);
      },
      async *getStreamedResponse() {},
    }),
  }, { modelBoundary: boundary }).getModel("gpt-5-mini");
  await assert.rejects(
    model.getResponse(request()),
    /cave_openai_agents_adapter_boundary_raw_usage_disabled/,
  );
  await Promise.resolve();
  assert.equal(nativeCalls, 0);
  assert.match(failures[0].message, /boundary_raw_usage_disabled/);
});
