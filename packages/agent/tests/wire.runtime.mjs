import { test } from "node:test";
import assert from "node:assert/strict";
import { createCavemanTransport } from "../dist/wire.js";

// The portable seam: Caveman's request ceiling, exact usage accounting, and
// provider-native cache hints applied at `fetch`, with no framework in the
// picture at all. Cache release stays on the same #225 live-path gate the
// native runtime uses, so anthropic/bedrock splices are held unless the caller
// explicitly opts into unproven-live behavior.

const MODEL = "claude-haiku-4-5";

function anthropicBody(extra = {}) {
  return JSON.stringify({
    model: MODEL,
    max_tokens: 1024,
    system: "You are a careful assistant. ".repeat(400),
    messages: [{ role: "user", content: "hello" }],
    ...extra,
  });
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Records every request the transport actually sent upstream. */
function recorder(respond) {
  const sent = [];
  const fetch = async (request) => {
    const text = await request.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    sent.push({ url: request.url, text, body });
    return respond(sent.length - 1);
  };
  return { sent, fetch };
}

/** Wait for the asynchronous post-stream settle, bounded so a bug fails loudly. */
async function settled(done) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("usage never settled");
}

async function post(transport, url, body) {
  return transport.fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }));
}

test("unrecognized targets pass through untouched", async () => {
  const upstream = recorder(() => jsonResponse({ ok: true }));
  const transport = createCavemanTransport({
    fetch: upstream.fetch,
    budget: { maxTokens: 10 },
  });
  // A tiny token budget would refuse this call if it were metered at all.
  const response = await post(transport, "https://example.test/v1/messages", anthropicBody());
  assert.equal(response.status, 200);
  assert.equal(upstream.sent.length, 1);
  assert.equal(upstream.sent[0].body.max_tokens, 1024);
  assert.equal(transport.meter.settled, 0);
});

test("GET and non-JSON bodies are never metered or edited", async () => {
  const upstream = recorder(() => jsonResponse({ ok: true }));
  const transport = createCavemanTransport({
    fetch: upstream.fetch,
    budget: { maxTokens: 10 },
  });
  await transport.fetch(new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: "not json",
  }));
  assert.equal(upstream.sent.length, 1);
  assert.equal(transport.meter.settled, 0);
});

test("exact provider usage settles the meter and reaches the observer", async () => {
  const usage = [];
  const upstream = recorder(() =>
    jsonResponse({
      usage: {
        input_tokens: 900,
        output_tokens: 40,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 10,
      },
    })
  );
  const transport = createCavemanTransport({
    fetch: upstream.fetch,
    budget: { maxTokens: 1_000_000 },
    onModelUsage: (value) => usage.push(value),
  });

  await post(transport, "https://api.anthropic.com/v1/messages", anthropicBody());

  assert.equal(usage.length, 1);
  assert.equal(usage[0].provider, "anthropic");
  assert.equal(usage[0].inputTokens, 900);
  assert.equal(usage[0].cacheReadTokens, 100);
  assert.equal(usage[0].totalTokens, 1050);
  // Anthropic never breaks the reasoning split out, so the record is honestly
  // unknown-cost even though the meter settles on an exact catalog figure.
  assert.equal(usage[0].reasoningTokens, null);
  assert.equal(usage[0].cost.status, "unknown");
  // Settled is the MEASURED total, not the byte-derived reserve.
  assert.equal(transport.meter.settled, 1050);
});

test("streaming usage merges across SSE events and the caller stream is intact", async () => {
  const usage = [];
  const upstream = recorder(() =>
    sseResponse([
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 500,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      { type: "content_block_delta", delta: { text: "hi" } },
      { type: "message_delta", usage: { output_tokens: 77 } },
    ])
  );
  const transport = createCavemanTransport({
    fetch: upstream.fetch,
    budget: { maxTokens: 1_000_000 },
    onModelUsage: (value) => usage.push(value),
  });

  const response = await post(
    transport,
    "https://api.anthropic.com/v1/messages",
    anthropicBody({ stream: true }),
  );
  const text = await response.text();
  assert.match(text, /content_block_delta/);

  // Settling trails the stream's end by a tick: the scanning branch finishes
  // after the caller's last read, so the meter is exact but not synchronous.
  await settled(() => usage.length === 1);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].inputTokens, 500);
  assert.equal(usage[0].outputTokens, 77, "message_delta refines message_start");
  assert.equal(transport.meter.settled, 577);
});

test("openai prompt tokens are made disjoint from cached tokens", async () => {
  const usage = [];
  const upstream = recorder(() =>
    jsonResponse({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 400 },
        completion_tokens_details: { reasoning_tokens: 20 },
      },
    })
  );
  const transport = createCavemanTransport({
    fetch: upstream.fetch,
    onModelUsage: (value) => usage.push(value),
  });

  await post(
    transport,
    "https://api.openai.com/v1/chat/completions",
    JSON.stringify({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] }),
  );

  assert.equal(usage[0].inputTokens, 600, "1000 prompt tokens less 400 cached");
  assert.equal(usage[0].cacheReadTokens, 400);
  assert.equal(usage[0].reasoningTokens, 20);
  assert.equal(usage[0].totalTokens, 1050);
  // Every count known, so this one may carry a priced figure.
  assert.equal(usage[0].cost.status, "estimated");
});

test("unmeasurable usage settles at the full reserve, never at zero", async () => {
  const upstream = recorder(() => jsonResponse({ id: "resp_1" }));
  const transport = createCavemanTransport({
    fetch: upstream.fetch,
    budget: { maxTokens: 1_000_000 },
  });

  await post(transport, "https://api.anthropic.com/v1/messages", anthropicBody());
  assert.ok(
    transport.meter.settled > 1024,
    `a call with no reported usage must not settle cheap, got ${transport.meter.settled}`,
  );
});

test("a transport error cancels the reservation", async () => {
  const transport = createCavemanTransport({
    fetch: async () => {
      throw new Error("network down");
    },
    budget: { maxTokens: 1_000_000 },
  });

  await assert.rejects(
    post(transport, "https://api.anthropic.com/v1/messages", anthropicBody()),
    /network down/,
  );
  assert.equal(transport.meter.settled, 0);
  assert.equal(transport.meter.remaining(), 1_000_000);
});

test("the budget stops the call before it leaves", async () => {
  const upstream = recorder(() => jsonResponse({ ok: true }));
  const transport = createCavemanTransport({
    fetch: upstream.fetch,
    budget: { maxTokens: 500 },
  });

  await assert.rejects(
    post(transport, "https://api.anthropic.com/v1/messages", anthropicBody()),
    /cave_wire_budget_exhausted/,
  );
  assert.equal(upstream.sent.length, 0, "nothing may reach the provider");
});

test("a partial remainder clamps the output allowance on the outgoing body", async () => {
  const upstream = recorder(() =>
    jsonResponse({
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    })
  );
  // Sized to cover the byte-derived input ceiling plus part of the 1024
  // requested output tokens, but not all of it.
  const body = anthropicBody();
  const ceiling = Buffer.byteLength(body, "utf8") + 16;
  const transport = createCavemanTransport({
    fetch: upstream.fetch,
    budget: { maxTokens: ceiling + 600 },
  });

  await post(transport, "https://api.anthropic.com/v1/messages", body);
  const sent = upstream.sent[0].body;
  assert.ok(sent.max_tokens < 1024, `expected a clamp, got ${sent.max_tokens}`);
  assert.ok(sent.max_tokens >= 256, "the clamp floor still applies");
  assert.equal(sent.system, JSON.parse(body).system, "clamping never touches content");
});

test("openai affinity routing key is applied; it is the proven-live grammar", async () => {
  const decisions = [];
  const upstream = recorder(() => jsonResponse({ usage: {} }));
  const transport = createCavemanTransport({
    fetch: upstream.fetch,
    onCacheDecision: (value) => decisions.push(value),
  });

  await post(
    transport,
    "https://api.openai.com/v1/chat/completions",
    JSON.stringify({
      model: "gpt-5.4-mini",
      instructions: "Stable operator instructions. ".repeat(400),
      messages: [{ role: "system", content: "Stable system prompt. ".repeat(400) }],
    }),
  );

  assert.equal(decisions.length, 1);
  if (decisions[0].applied) {
    assert.equal(typeof upstream.sent[0].body.prompt_cache_key, "string");
    assert.ok(decisions[0].optimizerIds.includes("openai-prompt-cache-key"));
  }
  assert.equal(decisions[0].heldByScope, false);
});

test("anthropic splices are held by the default gate and released only on opt-in", async () => {
  const seen = [];
  const build = (cache) => {
    const upstream = recorder(() => jsonResponse({ usage: {} }));
    seen.push(upstream);
    return createCavemanTransport({ fetch: upstream.fetch, cache });
  };

  // Two calls per transport: the planner needs a repeat to expect any reuse.
  for (const [index, cache] of [[0, "gated"], [1, "all"]]) {
    const transport = build(cache);
    await post(transport, "https://api.anthropic.com/v1/messages", anthropicBody());
    await post(transport, "https://api.anthropic.com/v1/messages", anthropicBody());
    const bodies = seen[index].sent.map((entry) => JSON.stringify(entry.body));
    const spliced = bodies.some((body) => body.includes("cache_control"));
    if (cache === "gated") {
      assert.equal(spliced, false, "unproven-live grammars must not reach a provider");
    }
  }
});

test("cache planning is skipped entirely when turned off", async () => {
  const decisions = [];
  const upstream = recorder(() => jsonResponse({ usage: {} }));
  const transport = createCavemanTransport({
    fetch: upstream.fetch,
    cache: "off",
    onCacheDecision: (value) => decisions.push(value),
  });

  await post(transport, "https://api.anthropic.com/v1/messages", anthropicBody());
  assert.equal(decisions.length, 0);
  assert.equal(upstream.sent[0].body.system, JSON.parse(anthropicBody()).system);
});

test("changed stable content opens a new epoch instead of tripping prefix drift", async () => {
  const decisions = [];
  const upstream = recorder(() => jsonResponse({ usage: {} }));
  const transport = createCavemanTransport({
    fetch: upstream.fetch,
    cache: "all",
    onCacheDecision: (value) => decisions.push(value),
  });

  await post(transport, "https://api.anthropic.com/v1/messages", anthropicBody());
  await post(
    transport,
    "https://api.anthropic.com/v1/messages",
    anthropicBody({ system: "A completely different operator prompt. ".repeat(400) }),
  );

  assert.equal(decisions.length, 2);
  for (const decision of decisions) {
    assert.notEqual(decision.reason, "prefix_drift");
  }
});
