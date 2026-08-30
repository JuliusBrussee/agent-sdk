import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  DiskDurableStore,
  agent,
  auto,
  createConversation,
  memory,
  run,
  schema,
  stream,
  tool,
} from "../dist/index.js";
import {
  createInMemoryMemoryStorage,
  createMemoryEngine,
} from "../dist/memory-api.js";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

function memoryDurableStore() {
  const journals = new Map();
  const appends = [];
  return {
    appends,
    async load(runId) {
      return journals.get(runId) ?? [];
    },
    async append(runId, data) {
      appends.push({ runId, data });
      const next = data.split("\n").filter(Boolean);
      journals.set(runId, [...(journals.get(runId) ?? []), ...next]);
    },
    async acquire() {
      return async () => {};
    },
    async close() {},
  };
}

function defined(id) {
  return agent({
    id,
    instructions: "Describe supplied input.",
    model: auto(),
    reasoning: "off",
    sandbox: "fixture",
  });
}

function options(faux, capture) {
  return {
    cave: "off",
    ensureRuntime: false,
    model: faux.getModel(),
    streamFn(model, context, streamOptions) {
      capture?.(context);
      return faux.provider.streamSimple(model, context, streamOptions);
    },
  };
}

test("native Pi runtime preserves ordered mixed text and inline base64 images", async () => {
  const faux = fauxProvider({ provider: "faux-vision" });
  faux.setResponses([fauxAssistantMessage("seen")]);
  const caller = [
    { type: "text", text: "before" },
    {
      type: "image",
      mimeType: "image/png",
      source: { type: "base64", data: "TQ==" },
    },
    { type: "text", text: "after" },
  ];
  let captured;
  const result = await run(defined("multimodal-order"), caller, options(faux, (context) => {
    captured = structuredClone(context);
  }));
  caller[0].text = "mutated";
  caller[1].source.data = "AAAA";

  assert.equal(result.text, "seen");
  assert.deepEqual(captured.messages.at(-1), {
    role: "user",
    content: [
      { type: "text", text: "before" },
      { type: "image", data: "TQ==", mimeType: "image/png" },
      { type: "text", text: "after" },
    ],
    timestamp: captured.messages.at(-1).timestamp,
  });
});

test("stream snapshots input before caller mutation and first consumption", async () => {
  const faux = fauxProvider({ provider: "faux-stream-snapshot" });
  faux.setResponses([fauxAssistantMessage("seen")]);
  const input = [{
    type: "image",
    mimeType: "image/png",
    source: { type: "base64", data: "TQ==" },
  }];
  let captured;
  const events = stream(defined("multimodal-stream-snapshot"), input, options(faux, (context) => {
    captured = structuredClone(context);
  }));
  input[0].source.data = "Tg==";
  for await (const _event of events) {}
  assert.equal(captured.messages.at(-1).content[0].data, "TQ==");
});

test("Pi adapter rejects unsupported normalized parts before provider traffic", async () => {
  const faux = fauxProvider({ provider: "faux-unsupported" });
  let providerCalls = 0;
  await assert.rejects(
    run(defined("multimodal-unsupported"), [
      {
        type: "image",
        mimeType: "image/png",
        source: { type: "url", url: "https://example.com/image.png" },
      },
      {
        type: "audio",
        mimeType: "audio/wav",
        source: { type: "base64", data: "TQ==" },
      },
      {
        type: "file",
        mimeType: "application/pdf",
        source: { type: "base64", data: "TQ==" },
      },
      { type: "opaque", provider: "openai", value: null },
    ], options(faux, () => { providerCalls += 1; })),
    /cave_input_unsupported:pi:0,1,2,3/,
  );
  assert.equal(providerCalls, 0);
});

test("image input fails before provider traffic when selected model is text-only", async () => {
  const faux = fauxProvider({
    provider: "faux-text",
    models: [{ id: "text-only", input: ["text"] }],
  });
  let providerCalls = 0;
  await assert.rejects(
    run(defined("multimodal-model-gate"), [{
      type: "image",
      mimeType: "image/png",
      source: { type: "base64", data: "TQ==" },
    }], options(faux, () => { providerCalls += 1; })),
    /cave_model_input_unsupported:faux-text\/text-only:images/,
  );
  assert.equal(providerCalls, 0);
});

test("tool arguments named image do not trigger text-only model media gate", async () => {
  const inspect = tool({
    name: "inspect",
    description: "Inspect plain JSON metadata.",
    input: schema.object({ payload: schema.object({ type: schema.string() }) }),
    effect: "read",
    result: "inline",
    execute: ({ payload }) => payload,
  });
  const definedWithTool = agent({
    id: "multimodal-tool-argument",
    instructions: "Inspect metadata, then answer.",
    model: auto(),
    tools: [inspect],
    reasoning: "off",
    sandbox: "fixture",
  });
  const faux = fauxProvider({
    provider: "faux-text-tools",
    models: [{ id: "text-only", input: ["text"] }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("inspect", { payload: { type: "image" } }, { id: "inspect-image-word" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("plain metadata"),
  ]);
  let providerCalls = 0;
  const result = await run(
    definedWithTool,
    "inspect this metadata",
    options(faux, () => { providerCalls += 1; }),
  );
  assert.equal(result.text, "plain metadata");
  assert.equal(providerCalls, 2);
});

test("image-only input gets stable non-secret ambient-memory projection", async () => {
  const id = "multimodal-memory";
  const definedWithMemory = agent({
    id,
    instructions: "Describe supplied input.",
    model: auto(),
    memory: memory({ namespace: "multimodal" }),
    reasoning: "off",
    sandbox: "fixture",
  });
  const engine = createMemoryEngine({
    scope: { tenant: "_", agentId: id, namespace: "multimodal" },
    storage: createInMemoryMemoryStorage(),
    ttlMs: 86_400_000,
  });
  const faux = fauxProvider({ provider: "anthropic" });
  faux.setResponses([fauxAssistantMessage("memory seen")]);
  let providerCalls = 0;

  const result = await run(definedWithMemory, [{
    type: "image",
    mimeType: "image/png",
    source: { type: "base64", data: "TQ==" },
  }], {
    ...options(faux, () => { providerCalls += 1; }),
    memory: { engine },
  });

  assert.equal(result.text, "memory seen");
  assert.equal(providerCalls, 1);
  await engine.flush();
});

test("context bill scales with current and prior provider-visible image bytes", async () => {
  const oneMiBImage = Buffer.alloc(1024 * 1024).toString("base64");
  const conversation = createConversation();
  const faux = fauxProvider({ provider: "faux-context-vision" });
  faux.setResponses([
    fauxAssistantMessage("first"),
    fauxAssistantMessage("second"),
  ]);
  let firstContext;
  for await (const event of stream(defined("multimodal-context"), [{
    type: "image",
    mimeType: "image/png",
    source: { type: "base64", data: oneMiBImage },
  }], {
    ...options(faux),
    conversation,
  })) {
    if (event.type === "context_ready") firstContext = event;
  }
  assert.ok(firstContext.bill.user_intent > 300_000);
  assert.equal(
    firstContext.contextIR.segments.find((segment) => segment.id === "turn.input")?.opaque,
    true,
  );

  let secondContext;
  for await (const event of stream(defined("multimodal-context"), "continue", {
    ...options(faux),
    conversation,
  })) {
    if (event.type === "context_ready") secondContext = event;
  }
  assert.ok(secondContext.bill.history > 300_000);
  assert.equal(
    secondContext.contextIR.segments.some((segment) =>
      segment.kind === "history" && segment.opaque && segment.tokenCount > 300_000),
    true,
  );
});

test("oversized durable inline image refuses before journal or provider traffic", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "cave-multimodal-durable-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "faux-durable-limit" });
  let providerCalls = 0;
  await assert.rejects(
    run(defined("multimodal-durable-limit"), [{
      type: "image",
      mimeType: "image/png",
      source: { type: "base64", data: Buffer.alloc(6 * 1024 * 1024).toString("base64") },
    }], {
      ...options(faux, () => { providerCalls += 1; }),
      durable: { runId: "multimodal-durable-limit-1", store: new DiskDurableStore(root) },
    }),
    /cave_durable_input_bytes_limit/,
  );
  assert.equal(providerCalls, 0);
  assert.deepEqual(await readdir(root), []);
});

test("durable size preflight counts JSON escaping before traffic", async () => {
  const faux = fauxProvider({ provider: "faux-durable-escaped-limit" });
  const store = memoryDurableStore();
  let providerCalls = 0;
  await assert.rejects(
    run(defined("multimodal-durable-escaped-limit"), [
      { type: "text", text: "\0".repeat(1024 * 1024) },
      {
        type: "image",
        mimeType: "image/png",
        source: { type: "base64", data: Buffer.alloc(3 * 1024 * 1024).toString("base64") },
      },
    ], {
      ...options(faux, () => { providerCalls += 1; }),
      durable: { runId: "multimodal-durable-escaped-limit-1", store },
    }),
    /cave_durable_input_bytes_limit/,
  );
  assert.equal(providerCalls, 0);
  assert.deepEqual(store.appends, []);
});

test("durable conversation cumulative media preflights before second-run traffic", async () => {
  const image = Buffer.alloc(3 * 1024 * 1024).toString("base64");
  const conversation = createConversation();
  const store = memoryDurableStore();
  const faux = fauxProvider({ provider: "faux-durable-cumulative" });
  faux.setResponses([fauxAssistantMessage("first")]);
  let providerCalls = 0;
  await run(defined("multimodal-durable-cumulative"), [{
    type: "image",
    mimeType: "image/png",
    source: { type: "base64", data: image },
  }], {
    ...options(faux, () => { providerCalls += 1; }),
    conversation,
    durable: { runId: "multimodal-durable-cumulative-1", store },
  });
  const appendsAfterFirst = store.appends.length;

  await assert.rejects(
    run(defined("multimodal-durable-cumulative"), [{
      type: "image",
      mimeType: "image/png",
      source: { type: "base64", data: image },
    }], {
      ...options(faux, () => { providerCalls += 1; }),
      conversation,
      durable: { runId: "multimodal-durable-cumulative-2", store },
    }),
    /cave_durable_input_bytes_limit/,
  );
  assert.equal(providerCalls, 1);
  assert.equal(store.appends.length, appendsAfterFirst);
});

test("durable multimodal identity replays exact content and rejects changed bytes", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "cave-multimodal-durable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DiskDurableStore(root);
  const faux = fauxProvider({ provider: "faux-durable-vision" });
  faux.setResponses([fauxAssistantMessage("durable seen")]);
  let providerCalls = 0;
  const runOptions = {
    ...options(faux, () => { providerCalls += 1; }),
    durable: { runId: "multimodal-durable-1", store },
  };
  const first = await run(defined("multimodal-durable"), [{
    type: "image",
    mimeType: "image/png",
    source: { type: "base64", data: "TQ==" },
  }], runOptions);
  const replay = await run(defined("multimodal-durable"), [{
    type: "image",
    mimeType: "image/png",
    source: { type: "base64", data: "TQ==" },
  }], runOptions);
  assert.equal(first.text, "durable seen");
  assert.deepEqual(replay, first);
  assert.equal(providerCalls, 1);

  await assert.rejects(
    run(defined("multimodal-durable"), [{
      type: "image",
      mimeType: "image/png",
      source: { type: "base64", data: "Tg==" },
    }], runOptions),
    /cave_durable_input_mismatch/,
  );
  assert.equal(providerCalls, 1);
});
