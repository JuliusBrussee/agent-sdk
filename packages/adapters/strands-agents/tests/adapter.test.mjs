import assert from "node:assert/strict";
import test from "node:test";
import {
  Agent,
  BeforeInvocationEvent,
  FunctionTool,
  InvokeModelStage,
  Model,
} from "@strands-agents/sdk";
import { defineAdapterManifest } from "@caveman-ai/adapter-kit";
import { createAdapterLifecycleValidator } from "@caveman-ai/adapter-kit";
import { createModelBoundary } from "@caveman-ai/agent/model-boundary";
import adapterPackage, {
  STRANDS_AGENTS_VERSION,
  createStrandsAgentsAdapter,
  manifest,
  normalizeStrandsUsage,
} from "../src/index.js";

class ScriptedModel extends Model {
  constructor(scripts, modelId = "test-model") {
    super();
    this.config = { modelId };
    this.scripts = [...scripts];
    this.calls = [];
    this.closed = 0;
  }

  updateConfig(config) {
    this.config = { ...this.config, ...config };
  }

  getConfig() {
    return { ...this.config };
  }

  async *stream(messages, options) {
    this.calls.push({ messages, options });
    const script = this.scripts.shift();
    if (script instanceof Error) throw script;
    if (script === undefined) throw new Error("script missing");
    try {
      for (const event of script) yield event;
    } finally {
      this.closed += 1;
    }
  }
}

function textResponse(text, usage) {
  return [
    { type: "modelMessageStartEvent", role: "assistant" },
    { type: "modelContentBlockStartEvent" },
    { type: "modelContentBlockDeltaEvent", delta: { type: "textDelta", text } },
    { type: "modelContentBlockStopEvent" },
    { type: "modelMessageStopEvent", stopReason: "endTurn" },
    ...(usage === undefined ? [] : [{ type: "modelMetadataEvent", usage }]),
  ];
}

function toolResponse(name, toolUseId, input) {
  return [
    { type: "modelMessageStartEvent", role: "assistant" },
    {
      type: "modelContentBlockStartEvent",
      start: { type: "toolUseStart", name, toolUseId },
    },
    {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "toolUseInputDelta", input: JSON.stringify(input) },
    },
    { type: "modelContentBlockStopEvent" },
    { type: "modelMessageStopEvent", stopReason: "toolUse" },
  ];
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("manifest pins the exact native package and keeps unsupported claims closed", () => {
  assert.equal(adapterPackage.manifest, manifest);
  assert.equal(STRANDS_AGENTS_VERSION, "1.15.0");
  assert.deepEqual(manifest.upstream, {
    package: "@strands-agents/sdk",
    version: "1.15.0",
  });
  assert.equal(manifest.capabilities.modelInterception, "experimental");
  assert.equal(manifest.capabilities.runLifecycle, "experimental");
  assert.equal(manifest.capabilities.replayAwareness, "unsupported");
  assert.equal(manifest.lifecycle["model.requested"], "intercept");
  assert.equal(manifest.lifecycle["run.error"], "unsupported");
  assert.equal(manifest.lifecycle["tool.proposed"], "unsupported");
  assert.deepEqual(manifest.certifications, {});
  assert.deepEqual(defineAdapterManifest(manifest), manifest);
});

test("native Agent performs one transformed call with exact signal and terminal result", async () => {
  const nativeUsage = {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    cacheReadInputTokens: 2,
    cacheWriteInputTokens: 1,
  };
  const model = new ScriptedModel([textResponse("native-ok", nativeUsage)]);
  const lifecycle = [];
  const usages = [];
  const settled = [];
  let boundarySignal;
  const boundary = createModelBoundary([{
    id: "native-test",
    prepare({ request, context }) {
      boundarySignal = context.signal;
      return { ...request, systemPrompt: "transformed" };
    },
    settled({ response }) {
      settled.push(response);
    },
  }]);
  const plugin = createStrandsAgentsAdapter({
    model: { provider: "test", model: "test-model" },
    modelBoundary: boundary,
    onLifecycle: (event) => lifecycle.push(event),
    onModelUsage: (value) => usages.push(value),
  });
  const agent = new Agent({ model, plugins: [plugin], printer: false });
  const result = await agent.invoke("hello");
  await nextTurn();

  assert.equal(result.stopReason, "endTurn");
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].options.systemPrompt, "transformed");
  assert.equal(model.calls[0].options.cancelSignal, boundarySignal);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].stopReason, "endTurn");
  assert.equal(settled[0].metadata.usage, nativeUsage);
  assert.deepEqual(usages[0].usage, {
    schemaVersion: 1,
    provider: "test",
    model: "test-model",
    inputTokens: 7,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: null,
    totalTokens: 14,
    cost: { status: "unknown" },
  });
  assert.equal(usages[0].identity.modelCallId, lifecycle[1].identity.modelCallId);
  assert.deepEqual(lifecycle.map((event) => event.phase), [
    "run.started",
    "model.requested",
    "model.responded",
    "run.completed",
  ]);
  const validator = createAdapterLifecycleValidator();
  for (const event of lifecycle) validator.accept(event);
  validator.finish();
});

test("model resolver sees the concrete model and model selection stays host-owned", async () => {
  const model = new ScriptedModel([textResponse("ok")], "routed-model");
  const contexts = [];
  let boundarySignal;
  const boundary = createModelBoundary([{
    id: "resolver-test",
    prepare({ request, context }) {
      boundarySignal = context.signal;
      return { ...request, projectedInputTokens: 12 };
    },
  }]);
  const plugin = createStrandsAgentsAdapter({
    resolveModel(context) {
      contexts.push(context);
      return { provider: "native", model: context.modelId };
    },
    modelBoundary: boundary,
  });
  const agent = new Agent({ model, plugins: [plugin], printer: false });
  await agent.invoke("hello");

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].model, model);
  assert.equal(contexts[0].modelId, "routed-model");
  assert.equal(model.calls[0].options.cancelSignal, boundarySignal);
  assert.equal(model.modelId, "routed-model");
});

test("tool hooks observe native execution without replacing the loop", async () => {
  const model = new ScriptedModel([
    toolResponse("echo", "tool-1", { value: "hello" }),
    textResponse("done"),
  ]);
  const toolCalls = [];
  const echo = new FunctionTool({
    name: "echo",
    description: "Echo a value",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    callback(input) {
      toolCalls.push(input);
      return input;
    },
  });
  const lifecycle = [];
  const agent = new Agent({
    model,
    tools: [echo],
    plugins: [createStrandsAgentsAdapter({
      onLifecycle: (event) => lifecycle.push(event),
    })],
    printer: false,
  });
  const result = await agent.invoke("use the tool");
  await nextTurn();

  assert.equal(result.stopReason, "endTurn");
  assert.equal(model.calls.length, 2);
  assert.deepEqual(toolCalls, [{ value: "hello" }]);
  assert.deepEqual(lifecycle.map((event) => event.phase), [
    "run.started",
    "model.requested",
    "model.responded",
    "tool.started",
    "tool.completed",
    "model.requested",
    "model.responded",
    "run.completed",
  ]);
  const validator = createAdapterLifecycleValidator();
  for (const event of lifecycle) validator.accept(event);
  validator.finish();
});

test("native model errors are observed once and rethrown unchanged by the adapter", async () => {
  const providerFailure = new Error("native provider failed");
  const model = new ScriptedModel([providerFailure]);
  const failed = [];
  const lifecycle = [];
  const boundary = createModelBoundary([{
    id: "failure-test",
    failed({ error }) {
      failed.push(error);
    },
  }]);
  const agent = new Agent({
    model,
    retryStrategy: null,
    plugins: [createStrandsAgentsAdapter({
      model: { provider: "test", model: "test-model" },
      modelBoundary: boundary,
      onLifecycle: (event) => lifecycle.push(event),
    })],
    printer: false,
  });
  let nativeFailure;
  await assert.rejects(agent.invoke("fail"), (error) => {
    nativeFailure = error;
    return true;
  });
  await nextTurn();

  assert.equal(failed.length, 1);
  assert.equal(failed[0], nativeFailure);
  assert.deepEqual(lifecycle.map((event) => event.phase), [
    "run.started",
    "model.requested",
    "model.error",
  ]);
});

test("native consumer close produces one boundary failure despite upstream provider-close gap", async () => {
  const model = new ScriptedModel([textResponse("streaming")]);
  const failed = [];
  const boundary = createModelBoundary([{
    id: "close-test",
    failed({ error }) {
      failed.push(error);
    },
  }]);
  const agent = new Agent({
    model,
    plugins: [createStrandsAgentsAdapter({
      model: { provider: "test", model: "test-model" },
      modelBoundary: boundary,
    })],
    printer: false,
  });
  const iterator = agent.stream("hello");
  while (model.calls.length === 0) {
    const item = await iterator.next();
    assert.equal(item.done, false);
  }
  await iterator.return();
  await nextTurn();

  // Strands 1.15.0 manually pulls Model.streamAggregated() and does not call
  // return() on that provider generator when Agent.stream() is closed early.
  assert.equal(model.closed, 0);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].message, "cave_strands_adapter_model_stream_closed");
});

test("Wrap middleware itself forwards consumer return to native next exactly", async () => {
  const hooks = new Map();
  let middleware;
  const signal = new AbortController().signal;
  const fakeAgent = {
    id: "fake-agent",
    cancelSignal: signal,
    addHook(eventType, callback) {
      hooks.set(eventType, callback);
      return () => undefined;
    },
    addMiddleware(phase, handler) {
      assert.equal(phase, InvokeModelStage.Wrap);
      middleware = handler;
      return () => undefined;
    },
  };
  const failed = [];
  const boundary = createModelBoundary([{
    id: "return-test",
    failed({ error }) {
      failed.push(error);
    },
  }]);
  const plugin = createStrandsAgentsAdapter({
    model: { provider: "test", model: "model" },
    modelBoundary: boundary,
  });
  plugin.initAgent(fakeAgent);

  const invocationState = {};
  hooks.get(BeforeInvocationEvent)({ agent: fakeAgent, invocationState });
  const marker = Object.freeze({ type: "native-event" });
  let nativeClosed = 0;
  const next = async function* (received) {
    assert.equal(received.agent, fakeAgent);
    try {
      yield marker;
      return { result: { stopReason: "endTurn" } };
    } finally {
      nativeClosed += 1;
    }
  };
  const iterator = middleware({
    agent: fakeAgent,
    model: { modelId: "model" },
    messages: [],
    toolSpecs: [],
    invocationState,
  }, next);
  assert.deepEqual(await iterator.next(), { done: false, value: marker });
  assert.deepEqual(await iterator.return(), { done: true, value: undefined });
  await nextTurn();

  assert.equal(nativeClosed, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].message, "cave_strands_adapter_model_stream_closed");
});

test("pre-aborted native invocation performs zero model and boundary calls", async () => {
  const model = new ScriptedModel([textResponse("unused")]);
  let prepares = 0;
  const boundary = createModelBoundary([{
    id: "abort-test",
    prepare() {
      prepares += 1;
    },
  }]);
  const agent = new Agent({
    model,
    plugins: [createStrandsAgentsAdapter({
      model: { provider: "test", model: "test-model" },
      modelBoundary: boundary,
    })],
    printer: false,
  });
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  const result = await agent.invoke("hello", { cancelSignal: controller.signal });

  assert.equal(result.stopReason, "cancelled");
  assert.equal(model.calls.length, 0);
  assert.equal(prepares, 0);
});

test("observer-only resolver and sink failures never alter native execution", async () => {
  const model = new ScriptedModel([textResponse("ok", {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
  })]);
  const observerErrors = [];
  const agent = new Agent({
    model,
    plugins: [createStrandsAgentsAdapter({
      resolveModel() {
        throw new Error("resolver failed");
      },
      onModelUsage() {
        throw new Error("unused sink");
      },
      onLifecycle() {
        return Promise.reject(new Error("sink failed"));
      },
      onObserverError(value) {
        observerErrors.push(value);
      },
    })],
    printer: false,
  });
  const result = await agent.invoke("hello");
  await nextTurn();

  assert.equal(result.stopReason, "endTurn");
  assert.equal(model.calls.length, 1);
  assert.ok(observerErrors.some((value) => value.stage === "model.resolve"));
  assert.ok(observerErrors.some((value) => value.stage === "usage.identity"));
  assert.ok(observerErrors.some((value) => value.stage === "lifecycle.sink"));
});

test("usage normalization handles both cache conventions and preserves unknowns", () => {
  const identity = { provider: "test", model: "model" };
  assert.deepEqual(normalizeStrandsUsage({
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    cacheReadInputTokens: 2,
    cacheWriteInputTokens: 1,
  }, identity), {
    schemaVersion: 1,
    ...identity,
    inputTokens: 7,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: null,
    totalTokens: 14,
    cost: { status: "unknown" },
  });
  assert.deepEqual(normalizeStrandsUsage({
    inputTokens: 7,
    outputTokens: 4,
    totalTokens: 14,
    cacheReadInputTokens: 2,
    cacheWriteInputTokens: 1,
  }, identity).inputTokens, 7);
  assert.deepEqual(normalizeStrandsUsage({
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
  }, identity), {
    schemaVersion: 1,
    ...identity,
    inputTokens: null,
    outputTokens: 4,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: 14,
    cost: { status: "unknown" },
  });
  assert.deepEqual(normalizeStrandsUsage(undefined, identity).inputTokens, null);
  assert.throws(() => normalizeStrandsUsage({
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 99,
    cacheReadInputTokens: 2,
    cacheWriteInputTokens: 1,
  }, identity), /cave_strands_adapter_usage_invalid:totalTokens/);
  assert.throws(() => normalizeStrandsUsage({
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    cacheReadInputTokens: 2,
    cacheWriteInputTokens: 0,
  }, identity), /cave_strands_adapter_usage_invalid:inputTokens/);
});

test("strict options and transformed requests fail closed before provider I/O", async () => {
  assert.throws(
    () => createStrandsAgentsAdapter({ onModelUsage() {} }),
    /cave_strands_adapter_model_identity_required/,
  );
  assert.throws(
    () => createStrandsAgentsAdapter({
      model: { provider: "test", model: "model" },
      resolveModel: () => ({ provider: "test", model: "model" }),
    }),
    /model_resolver_conflict/,
  );

  const model = new ScriptedModel([textResponse("unused")]);
  const boundary = createModelBoundary([{
    id: "bad-request",
    prepare({ request }) {
      return { ...request, model };
    },
  }]);
  const agent = new Agent({
    model,
    retryStrategy: null,
    plugins: [createStrandsAgentsAdapter({
      model: { provider: "test", model: "test-model" },
      modelBoundary: boundary,
    })],
    printer: false,
  });
  await assert.rejects(
    agent.invoke("hello"),
    /cave_strands_adapter_model_request_invalid/,
  );
  assert.equal(model.calls.length, 0);
});
