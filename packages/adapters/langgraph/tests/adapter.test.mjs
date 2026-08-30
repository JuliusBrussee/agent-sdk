import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdapterLifecycleValidator,
  defineAdapterManifest,
} from "@caveman-ai/adapter-kit";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { AIMessage } from "@langchain/core/messages";
import { FakeChatModel } from "@langchain/core/utils/testing";
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import adapterPackage, {
  createLangGraphAdapter,
  manifest,
} from "../src/index.js";

test("manifest is exact, granular, experimental, and uncertified", () => {
  assert.equal(adapterPackage.manifest, manifest);
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.upstream, {
    package: "@langchain/langgraph",
    version: "1.4.13",
  });
  assert.equal(manifest.capabilities.modelInterception, "unsupported");
  assert.equal(manifest.capabilities.contextTransformation, "unsupported");
  assert.equal(manifest.capabilities.usageAccounting, "experimental");
  assert.equal(manifest.capabilities.tracing, "unsupported");
  assert.equal(manifest.lifecycle["tool.proposed"], "unsupported");
  assert.deepEqual(manifest.certifications, {});
  assert.deepEqual(defineAdapterManifest(manifest), manifest);
});

test("callback and config composition preserve native callbacks", () => {
  const adapter = createLangGraphAdapter();
  const existing = BaseCallbackHandler.fromMethods({});
  const callbacks = adapter.composeCallbacks([existing]);
  assert.deepEqual(callbacks, [existing, adapter.callbackHandler]);

  const manager = new CallbackManager(undefined, {
    handlers: [existing],
    inheritableHandlers: [existing],
  });
  const composedManager = adapter.composeCallbacks(manager);
  assert.notEqual(composedManager, manager);
  assert.deepEqual(manager.handlers, [existing]);
  assert.ok(composedManager.handlers.includes(existing));
  assert.ok(composedManager.handlers.includes(adapter.callbackHandler));

  const configurable = { thread_id: "thread-compose" };
  const config = adapter.composeConfig({ callbacks: [existing], configurable });
  assert.equal(config.configurable, configurable);
  assert.deepEqual(config.callbacks, [existing, adapter.callbackHandler]);

  const { composeConfig, composeCallbacks, composeTransformers } = adapter;
  assert.deepEqual(composeCallbacks([existing]), [existing, adapter.callbackHandler]);
  assert.deepEqual(composeConfig({ configurable }).configurable, configurable);
  assert.equal(composeTransformers([])[0], adapter.transformer);
});

test("native StateGraph and MemorySaver emit valid lifecycle without changing output", async () => {
  const events = [];
  const observerErrors = [];
  const adapter = createLangGraphAdapter({
    onLifecycle(event) {
      events.push(event);
      throw new Error("observer failed");
    },
    onObserverError(value) {
      observerErrors.push(value);
    },
  });
  const State = Annotation.Root({ count: Annotation() });
  const checkpointer = new MemorySaver();
  const graph = new StateGraph(State)
    .addNode("increment", ({ count }) => ({ count: count + 1 }))
    .addEdge(START, "increment")
    .addEdge("increment", END)
    .compile({ checkpointer });

  const output = await graph.invoke(
    { count: 1 },
    adapter.composeConfig({ configurable: { thread_id: "thread-lifecycle" } }),
  );
  assert.deepEqual(output, { count: 2 });
  const state = await graph.getState({ configurable: { thread_id: "thread-lifecycle" } });
  assert.deepEqual(state.values, { count: 2 });
  assert.deepEqual(events.map(({ phase }) => phase), ["run.started", "run.completed"]);
  assert.equal(events[0].identity.runId, events[1].identity.runId);
  assert.ok(Object.isFrozen(events[0]));
  const validator = createAdapterLifecycleValidator();
  for (const event of events) validator.accept(event);
  validator.finish();
  assert.equal(observerErrors.length, 2);
});

test("native graph rejection preserves exact error identity", async () => {
  const sentinel = new Error("graph failed");
  const events = [];
  const adapter = createLangGraphAdapter({
    onLifecycle(event) {
      events.push(event);
      return Promise.reject(new Error("async observer failed"));
    },
  });
  const State = Annotation.Root({ value: Annotation() });
  const graph = new StateGraph(State)
    .addNode("fail", () => {
      throw sentinel;
    })
    .addEdge(START, "fail")
    .addEdge("fail", END)
    .compile({ checkpointer: new MemorySaver() });

  await assert.rejects(
    graph.invoke(
      { value: 1 },
      adapter.composeConfig({ configurable: { thread_id: "thread-error" } }),
    ),
    (error) => error === sentinel,
  );
  await Promise.resolve();
  assert.deepEqual(events.map(({ phase }) => phase), ["run.started", "run.error"]);
});

test("native model callback converts AIMessage usage without fake zero or cost", async () => {
  class UsageChatModel extends FakeChatModel {
    getLsParams() {
      return { ls_provider: "openai", ls_model_name: "gpt-5-mini" };
    }

    async _generate() {
      return {
        generations: [{
          text: "ok",
          message: new AIMessage({
            content: "ok",
            usage_metadata: {
              input_tokens: 10,
              output_tokens: 4,
              total_tokens: 14,
              input_token_details: { cache_read: 2, cache_creation: 1 },
              output_token_details: { reasoning: 1 },
            },
          }),
        }],
      };
    }
  }

  const observations = [];
  const events = [];
  const adapter = createLangGraphAdapter({
    onLifecycle(event) {
      events.push(event);
    },
    onUsage(observation) {
      observations.push(observation);
    },
  });
  const State = Annotation.Root({ answer: Annotation() });
  const model = new UsageChatModel({});
  const graph = new StateGraph(State)
    .addNode("model", async (_state, config) => ({
      answer: await model.invoke("hello", config),
    }))
    .addEdge(START, "model")
    .addEdge("model", END)
    .compile({ checkpointer: new MemorySaver() });
  const output = await graph.invoke(
    {},
    adapter.composeConfig({ configurable: { thread_id: "thread-model-usage" } }),
  );
  assert.equal(output.answer.content, "ok");
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0].usage, {
    schemaVersion: 1,
    provider: "openai",
    model: "gpt-5-mini",
    inputTokens: 7,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 1,
    totalTokens: 14,
    cost: { status: "unknown" },
  });
  assert.ok(observations[0].identity.modelCallId);
  assert.deepEqual(events.map(({ phase }) => phase), [
    "run.started",
    "model.requested",
    "model.responded",
    "run.completed",
  ]);
  const validator = createAdapterLifecycleValidator();
  for (const event of events) validator.accept(event);
  validator.finish();

  const unknown = [];
  const unknownAdapter = createLangGraphAdapter({
    model: { provider: "openai", model: "gpt-5-mini" },
    onUsage: (observation) => unknown.push(observation),
  });
  const handler = unknownAdapter.callbackHandler;
  handler.handleChainStart({}, {}, "root-unknown");
  handler.handleChainStart({}, {}, "step-unknown", "root-unknown");
  handler.handleChatModelStart({}, [[]], "model-unknown", "step-unknown");
  handler.handleLLMEnd({
    generations: [[{ message: new AIMessage({ content: "unknown" }) }]],
  }, "model-unknown");
  assert.deepEqual(unknown[0].usage, {
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
});

test("native tool callbacks expose only supported started and terminal phases", () => {
  const events = [];
  const adapter = createLangGraphAdapter({ onLifecycle: (event) => events.push(event) });
  const handler = adapter.callbackHandler;
  handler.handleChainStart({}, {}, "root-tools");
  handler.handleChainStart({}, {}, "step-tools", "root-tools");
  handler.handleToolStart({}, "{}", "tool-success", "step-tools", [], {}, "lookup", "call-1");
  handler.handleToolEnd("ok", "tool-success");
  handler.handleToolStart({}, "{}", "tool-failure", "step-tools", [], {}, "write", "call-2");
  handler.handleToolError(new Error("failed"), "tool-failure");
  handler.handleChainEnd({}, "step-tools");
  handler.handleChainEnd({}, "root-tools");

  assert.deepEqual(events.map(({ phase }) => phase), [
    "run.started",
    "tool.started",
    "tool.completed",
    "tool.started",
    "tool.error",
    "run.completed",
  ]);
  assert.equal(events.some(({ phase }) => phase === "tool.proposed"), false);
  assert.equal(events[1].identity.toolCallId, "tool-success");
  assert.equal(events[1].identity.nativeIds.langchainToolCallId, "call-1");
  const validator = createAdapterLifecycleValidator();
  for (const event of events) validator.accept(event);
  validator.finish();
});

test("native v3 transformer observes detached events and never drops source events", async () => {
  const observed = [];
  const adapter = createLangGraphAdapter({
    onStreamEvent(event) {
      observed.push(event);
      assert.ok(Object.isFrozen(event));
      throw new Error("stream observer failed");
    },
  });
  const State = Annotation.Root({ value: Annotation() });
  const graph = new StateGraph(State)
    .addNode("increment", ({ value }) => ({ value: value + 1 }))
    .addEdge(START, "increment")
    .addEdge("increment", END)
    .compile({
      checkpointer: new MemorySaver(),
      transformers: adapter.transformers,
    });
  const run = await graph.streamEvents(
    { value: 3 },
    { version: "v3", configurable: { thread_id: "thread-stream" } },
  );
  const nativeEvents = [];
  for await (const event of run) nativeEvents.push(event);
  assert.ok(nativeEvents.length > 0);
  assert.equal(observed.length, nativeEvents.length);
  assert.deepEqual(await run.output, { value: 4 });
  assert.notEqual(observed[0], nativeEvents[0]);
  assert.deepEqual(observed[0], nativeEvents[0]);
});

test("options reject accessors, inherited fields, and conflicting model configuration", () => {
  const accessor = {};
  Object.defineProperty(accessor, "onUsage", {
    enumerable: true,
    get() {
      throw new Error("getter ran");
    },
  });
  assert.throws(() => createLangGraphAdapter(accessor), /cave_langgraph_options_invalid/);
  assert.throws(
    () => createLangGraphAdapter(Object.create({ onUsage() {} })),
    /cave_langgraph_options_invalid/,
  );
  assert.throws(
    () => createLangGraphAdapter({
      model: { provider: "openai", model: "gpt-5-mini" },
      resolveModel() {},
    }),
    /model_resolver_conflict/,
  );

  const diagnostics = [];
  const adapter = createLangGraphAdapter({
    onLifecycle() {},
    onObserverError: (value) => diagnostics.push(value),
  });
  assert.doesNotThrow(() => adapter.callbackHandler.handleChainStart({}, {}, "bad run id"));
  assert.equal(diagnostics[0].stage, "lifecycle.identity");
});
