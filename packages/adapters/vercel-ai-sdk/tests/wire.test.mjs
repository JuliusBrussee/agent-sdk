import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { generateText, wrapLanguageModel } from "ai";
import { createCavemanTransport } from "@caveman-ai/agent/wire";
import { createVercelAISDKAdapter } from "@caveman-ai/adapter-vercel-ai-sdk";

// End-to-end proof that Caveman's request ceiling and usage accounting are
// PORTABLE: a real `ai@7.0.84` agent loop, a real provider-shaped Anthropic
// request, and no per-framework Caveman code on the metering path at all. The
// adapter still supplies lifecycle and its model boundary; the transport
// supplies the economics.
//
// The one stub is the provider package's own body construction, hand-written
// here to Anthropic's wire shape because `@ai-sdk/anthropic` is not a dependency
// of this adapter. Everything the transport sees is the real thing.

const require = createRequire(import.meta.url);
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5";

/**
 * A minimal LanguageModelV3 that posts an Anthropic-shaped body through the
 * injected fetch, exactly the way `createAnthropic({ fetch })` would.
 */
function anthropicModel(fetchImpl, { maxOutputTokens = 1024 } = {}) {
  return {
    specificationVersion: "v3",
    provider: "anthropic",
    modelId: MODEL,
    supportedUrls: {},
    async doGenerate(options) {
      const response = await fetchImpl(new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxOutputTokens,
          system: "You are a careful assistant. ".repeat(400),
          messages: [{ role: "user", content: describe(options.prompt) }],
        }),
      }));
      const payload = await response.json();
      return {
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: {
          inputTokens: { total: 900, noCache: 800, cacheRead: 100, cacheWrite: 0 },
          outputTokens: { total: 40, text: 40, reasoning: 0 },
        },
        warnings: [],
        request: { body: payload.echoedRequestBody },
      };
    },
    async doStream() {
      throw new Error("not used");
    },
  };
}

function describe(prompt) {
  return JSON.stringify(prompt).slice(0, 200);
}

function anthropicResponse(request, body) {
  return new Response(
    JSON.stringify({
      echoedRequestBody: body,
      usage: {
        input_tokens: 900,
        output_tokens: 40,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("pinned upstream is unchanged", () => {
  assert.equal(require("ai/package.json").version, "7.0.84");
});

test("a real ai@7.0.84 run is metered end to end with no per-framework code", async () => {
  const usage = [];
  const sent = [];
  const transport = createCavemanTransport({
    budget: { maxTokens: 1_000_000 },
    onModelUsage: (value) => usage.push(value),
    fetch: async (request) => {
      const body = JSON.parse(await request.text());
      sent.push(body);
      return anthropicResponse(request, body);
    },
  });

  const caveman = createVercelAISDKAdapter({ onModelUsage: () => {} });
  const result = await generateText({
    model: wrapLanguageModel({
      model: anthropicModel(transport.fetch),
      middleware: caveman.middleware,
    }),
    prompt: "hello",
  });

  assert.equal(result.text, "ok");
  assert.equal(sent.length, 1);
  assert.equal(usage.length, 1, "the transport observed the provider call");
  assert.equal(usage[0].provider, "anthropic");
  assert.equal(usage[0].inputTokens, 900);
  assert.equal(usage[0].cacheReadTokens, 100);
  // Exactly the provider-reported total, not the byte-derived reserve.
  assert.equal(transport.meter.settled, 1040);
});

test("the run stops at the cap before a request reaches the provider", async () => {
  const sent = [];
  const transport = createCavemanTransport({
    budget: { maxTokens: 500 },
    fetch: async (request) => {
      const body = JSON.parse(await request.text());
      sent.push(body);
      return anthropicResponse(request, body);
    },
  });

  await assert.rejects(
    generateText({
      model: wrapLanguageModel({
        model: anthropicModel(transport.fetch),
        middleware: createVercelAISDKAdapter().middleware,
      }),
      prompt: "hello",
    }),
    (error) => /cave_wire_budget_exhausted/.test(String(error?.message ?? error)),
  );
  assert.equal(sent.length, 0, "the cap held before any provider spend");
});

test("a partial remainder clamps the outgoing output allowance", async () => {
  const sent = [];
  const probe = JSON.stringify({
    model: MODEL,
    max_tokens: 1024,
    system: "You are a careful assistant. ".repeat(400),
    messages: [{ role: "user", content: "x" }],
  });
  const transport = createCavemanTransport({
    budget: { maxTokens: Buffer.byteLength(probe, "utf8") + 900 },
    fetch: async (request) => {
      const body = JSON.parse(await request.text());
      sent.push(body);
      return anthropicResponse(request, body);
    },
  });

  await generateText({
    model: wrapLanguageModel({
      model: anthropicModel(transport.fetch),
      middleware: createVercelAISDKAdapter().middleware,
    }),
    prompt: "hello",
  });

  assert.equal(sent.length, 1);
  assert.ok(sent[0].max_tokens < 1024, `expected a clamp, got ${sent[0].max_tokens}`);
  assert.ok(sent[0].max_tokens >= 256, "the clamp floor still applies");
});
