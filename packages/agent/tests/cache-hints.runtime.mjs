import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, schema, tool } from "../dist/index.js";
import { runAgentInternal } from "../dist/runtime.js";
import { CachePlanEngine, optimizeNativeRequest } from "../dist/cache-planner/index.js";
import { fauxProvider as upstreamFauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// Native request-path wiring (phase 2, deliverable D — scoped at Phase-2
// review): Anthropic caching is provider-native via Pi's own markers; the SDK
// planner adds openai affinity routing keys and takes over other wires only
// when proven live (#225). These tests use PRODUCTION-SHAPED Pi payloads:
// anthropic requests carry Pi's cache_control markers and must pass through
// byte-identical (caller-managed — correct, not a failure); an openai
// affinity request without markers gets exactly prompt_cache_key; explicit
// grammars never leave the SDK on the live path.

function fauxModel(overrides = {}) {
  const handle = upstreamFauxProvider({ provider: overrides.provider ?? "anthropic" });
  return {
    ...handle.getModel(),
    id: "claude-haiku-4-5",
    contextWindow: 200_000,
    maxTokens: 4_000,
    ...overrides,
  };
}

function usage() {
  return {
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 110,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function pushMessage(selected, content, stopReason, used) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content,
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: used,
    stopReason,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });
  return stream;
}

function quietAgent(id) {
  return agent({
    id,
    instructions: "Answer briefly.",
    model: "anthropic/claude-haiku-4-5",
    sandbox: "fixture",
    tools: [tool({
      name: "lookup",
      description: "Look one thing up.",
      input: schema.object({ key: schema.string() }),
      effect: "read",
      execute: (input) => `${input.key}:ok`,
    })],
  });
}

/** Anthropic body as Pi's buildParams actually sends it: markers present. */
function productionAnthropicPayload(selected) {
  return {
    model: selected.id,
    system: [{
      type: "text",
      text: "Answer briefly.",
      cache_control: { type: "ephemeral" },
    }],
    tools: [{
      name: "lookup",
      description: "Look one thing up.",
      input_schema: { type: "object" },
      cache_control: { type: "ephemeral" },
    }],
    messages: [{
      role: "user",
      content: [{
        type: "text",
        text: "Inspect this repository",
        cache_control: { type: "ephemeral" },
      }],
    }],
    max_tokens: 256,
  };
}

/** OpenAI chat body as Pi sends it when its own prompt_cache_key is off. */
function productionOpenAIPayload(selected) {
  return {
    model: selected.id,
    messages: [
      { role: "system", content: "Answer briefly." },
      { role: "user", content: "What should I do next?" },
    ],
  };
}

async function seenPayload(id, model, buildPayload, extraOptions = {}) {
  const seen = [];
  await runAgentInternal(quietAgent(id), "go", {
    ensureRuntime: false,
    // Pin the resolved route off the gateway: on a workstation with a live
    // loopback gateway the run would otherwise route through it (and the
    // gateway would own cache hints instead of the in-SDK planner).
    caveRoute: { useGateway: false, providerBilling: "unknown" },
    model,
    ...extraOptions,
    streamFn: (selected, context, streamOptions) => {
      const outgoing = buildPayload(selected, context);
      const returned = streamOptions?.onPayload?.(outgoing, selected);
      seen.push({ outgoing, returned });
      return pushMessage(selected, [{ type: "text", text: "done" }], "stop", usage());
    },
  });
  assert.equal(seen.length > 0, true);
  return seen[0];
}

test("production anthropic payloads pass through byte-identical (caller-managed)", async () => {
  const { outgoing, returned } = await seenPayload(
    "hints-anthropic-caller-managed",
    fauxModel({ api: "anthropic-messages" }),
    (selected) => productionAnthropicPayload(selected),
  );
  // Pi's cache_control markers ARE the provider-native cache path; the seam
  // must not double-apply or reshape anything.
  assert.equal(returned, outgoing);
  // And the planner itself calls this caller-managed, which is the point:
  const direct = optimizeNativeRequest(new CachePlanEngine(), {
    scope: "hints/anthropic",
    epoch: "session-1",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    endpoint: "/v1/messages",
    body: JSON.stringify(productionAnthropicPayload({ id: "claude-haiku-4-5" })),
    runtimeMode: "optimize",
  });
  assert.equal(direct.applied, false);
  assert.equal(direct.reason, "caller_managed");
});

test("openai affinity requests without markers get exactly prompt_cache_key", async () => {
  const { outgoing, returned } = await seenPayload(
    "hints-openai-affinity",
    fauxModel({ provider: "openai", api: "openai-completions", id: "gpt-5.4-mini" }),
    (selected) => productionOpenAIPayload(selected),
  );
  assert.notEqual(returned, outgoing, "the hinted payload is a new object");
  assert.equal(typeof returned.prompt_cache_key, "string");
  assert.equal(returned.prompt_cache_key.length, 32);
  // Affinity routing key ONLY — no explicit-cache grammar on the live path.
  assert.equal(returned.prompt_cache_options, undefined);
  assert.equal(JSON.stringify(returned).includes("prompt_cache_breakpoint"), false);
  // Everything model-visible is otherwise untouched, and the original object
  // was never mutated.
  assert.deepEqual(returned.messages, outgoing.messages);
  assert.equal(outgoing.prompt_cache_key, undefined);
});

test("explicit-cache openai grammars never leave the SDK live (#225 gate)", async () => {
  const { outgoing, returned } = await seenPayload(
    "hints-openai-explicit-gated",
    fauxModel({ provider: "openai", api: "openai-completions", id: "gpt-5.6" }),
    (selected) => productionOpenAIPayload(selected),
  );
  // gpt-5.6 resolves the explicit-cache profile; its grammar is
  // fixture-parity-only until #225's live smoke passes.
  assert.equal(returned, outgoing);
  // Prove the GATE blocked it — the planner itself would have applied:
  const direct = optimizeNativeRequest(new CachePlanEngine(), {
    scope: "hints/openai-explicit",
    epoch: "session-1",
    provider: "openai",
    model: "gpt-5.6",
    endpoint: "/v1/chat/completions",
    body: JSON.stringify(productionOpenAIPayload({ id: "gpt-5.6" })),
    runtimeMode: "optimize",
  });
  assert.equal(direct.applied, true);
  assert.equal(direct.plan?.mode, "explicit");
});

test("cave: off disables native cache hints", async () => {
  const { outgoing, returned } = await seenPayload(
    "hints-cave-off",
    fauxModel({ provider: "openai", api: "openai-completions", id: "gpt-5.4-mini" }),
    (selected) => productionOpenAIPayload(selected),
    { cave: "off" },
  );
  assert.equal(returned, outgoing);
});
