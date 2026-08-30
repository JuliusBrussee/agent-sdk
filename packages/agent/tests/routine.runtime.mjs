// Phase 5 of the determinism dividend (docs/DETERMINISM_DIVIDEND_SPEC.md §4.3):
// routine() is the productized guard + deopt. The guard is load-bearing, so
// every rejection path is tested as a DEOPT to the original tool rather than an
// error, and the outcome vocabulary stays closed. Nothing here mints money —
// the counters exist for observed before/after measurement only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { routine, routineOutcomes, schema, tool } from "../dist/index.js";
import { toolDefinitionSHA256 } from "../dist/build.js";
import {
  fauxAssistantMessage as upstreamFauxAssistantMessage,
  fauxProvider as upstreamFauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { run } from "../dist/index.js";
import routineAgent from "./fixtures/routine-agent.mjs";

function originalTool(name) {
  return tool({
    name,
    description: "Look up an order status.",
    input: schema.object({ order: schema.string() }),
    effect: "read",
    execute: ({ order }) => `original:${order}`,
  });
}

function countOf(name, outcome) {
  return routineOutcomes()
    .filter((item) => item.tool === name && item.outcome === outcome)
    .reduce((total, item) => total + item.count, 0);
}

test("a hit returns the routine result and records routine_hit", async () => {
  const composed = routine(originalTool("hit_lookup"), ({ order }) => `routine:${order}`);
  assert.equal(await composed.execute({ order: "A1" }), "routine:A1");
  assert.equal(countOf("hit_lookup", "routine_hit"), 1);
  assert.equal(countOf("hit_lookup", "routine_deopt_guard"), 0);
  assert.equal(countOf("hit_lookup", "routine_deopt_error"), 0);
});

test("the composed tool keeps the original name, description, and schema", () => {
  const original = originalTool("identity_lookup");
  const composed = routine(original, () => "routine");
  assert.equal(composed.name, original.name);
  assert.equal(composed.description, original.description);
  assert.deepEqual(composed.input, original.input);
  assert.equal(composed.effect, original.effect);
  assert.equal(composed.timeoutMs, original.timeoutMs);
});

test("a guard rejection deopts to the original tool", async () => {
  const composed = routine(
    originalTool("guard_lookup"),
    ({ order }) => `routine:${order}`,
    { guard: ({ order }) => order.startsWith("A") },
  );
  assert.equal(await composed.execute({ order: "B2" }), "original:B2");
  assert.equal(countOf("guard_lookup", "routine_deopt_guard"), 1);
  assert.equal(countOf("guard_lookup", "routine_hit"), 0);
});

test("a throwing guard is a rejection, not a crash", async () => {
  const composed = routine(
    originalTool("throwing_guard_lookup"),
    ({ order }) => `routine:${order}`,
    { guard: () => { throw new Error("guard exploded"); } },
  );
  assert.equal(await composed.execute({ order: "A1" }), "original:A1");
  assert.equal(countOf("throwing_guard_lookup", "routine_deopt_guard"), 1);
});

test("an impl throw deopts to the original and swallows the error", async () => {
  const composed = routine(originalTool("error_lookup"), () => {
    throw new Error("generated function is wrong");
  });
  assert.equal(await composed.execute({ order: "A1" }), "original:A1");
  assert.equal(countOf("error_lookup", "routine_deopt_error"), 1);
});

test("an impl rejection deopts to the original", async () => {
  const composed = routine(originalTool("reject_lookup"), async () => {
    throw new Error("async generated function is wrong");
  });
  assert.equal(await composed.execute({ order: "A1" }), "original:A1");
  assert.equal(countOf("reject_lookup", "routine_deopt_error"), 1);
});

test("schema-invalid input deopts instead of running the routine", async () => {
  let implCalls = 0;
  const composed = routine(originalTool("schema_lookup"), () => {
    implCalls += 1;
    return "routine";
  });
  // The original tool decides what an off-schema input means; the routine only
  // refuses to answer for a shape it was never witnessed on.
  assert.equal(await composed.execute({ order: 7 }), "original:7");
  assert.equal(implCalls, 0);
  assert.equal(countOf("schema_lookup", "routine_deopt_guard"), 1);
});

test("routine refuses a framework-reserved cave_ tool name", () => {
  const reserved = {
    ...originalTool("placeholder"),
    name: "cave_retrieve",
  };
  assert.throws(
    () => routine(reserved, () => "routine"),
    /cave_routine_reserved_tool_name:cave_retrieve/,
  );
});

test("routine refuses a subagent tool it could not deopt to", () => {
  const delegating = {
    ...originalTool("delegate"),
    runtime: { kind: "subagent" },
  };
  assert.throws(
    () => routine(delegating, () => "routine"),
    /cave_routine_subagent_unsupported:delegate/,
  );
});

test("the original's own error still propagates on a deopt", async () => {
  const exploding = tool({
    name: "exploding_lookup",
    description: "Look up an order status.",
    input: schema.object({ order: schema.string() }),
    effect: "read",
    execute: () => { throw new Error("upstream is down"); },
  });
  const composed = routine(exploding, () => { throw new Error("routine is wrong"); });
  // The routine swallows ITS OWN error, never the original's — a deopt returns
  // whatever the original tool does, including a throw the caller must see.
  await assert.rejects(composed.execute({ order: "A1" }), /upstream is down/);
  assert.equal(countOf("exploding_lookup", "routine_deopt_error"), 1);
});

test("the tool's abort signal reaches impl", async () => {
  const controller = new AbortController();
  const composed = routine(
    originalTool("signal_lookup"),
    (input, signal) => (signal === controller.signal ? "routine:signal" : "routine:none"),
  );
  assert.equal(await composed.execute({ order: "A1" }, controller.signal), "routine:signal");
});

test("a routine's digest folds in its impl and guard, not the wrapper", () => {
  const original = originalTool("digest_lookup");
  const one = toolDefinitionSHA256(routine(original, ({ order }) => `routine:${order}`));
  const two = toolDefinitionSHA256(routine(original, ({ order }) => `other:${order}`));
  const alsoOne = toolDefinitionSHA256(routine(original, ({ order }) => `routine:${order}`));
  // Without this the wrapper's own source hashed every routine identically, so
  // lock drift and cave_durable_definition_changed could not see an impl swap.
  assert.notEqual(one, two);
  assert.equal(one, alsoOne);
  assert.notEqual(
    one,
    toolDefinitionSHA256(routine(original, ({ order }) => `routine:${order}`, {
      guard: ({ order }) => order.startsWith("A"),
    })),
  );
  assert.notEqual(one, toolDefinitionSHA256(original));
});

test("routine refuses a Standard Schema tool it cannot re-validate", () => {
  const standardInput = {
    "~standard": {
      version: 1,
      vendor: "fixture",
      validate(value) {
        if (value === null || typeof value !== "object" || typeof value.order !== "string") {
          return { issues: [{ message: "order required" }] };
        }
        return { value: { order: value.order.toUpperCase() } };
      },
      jsonSchema: {
        input: () => ({
          type: "object",
          properties: { order: { type: "string" } },
          required: ["order"],
        }),
      },
    },
  };
  const standardTool = tool({
    name: "standard_order",
    description: "Look up an order status.",
    input: standardInput,
    effect: "read",
    execute: ({ order }) => `original:${order}`,
  });
  assert.throws(
    () => routine(standardTool, () => "routine"),
    /cave_routine_standard_schema_unsupported:standard_order/,
  );
});

test("routine refuses a Standard output Schema it cannot re-validate", () => {
  const standardOutput = {
    "~standard": {
      version: 1,
      vendor: "fixture",
      validate(value) {
        return { value };
      },
      jsonSchema: {
        output: () => ({ type: "string" }),
      },
    },
  };
  const standardTool = tool({
    name: "standard_output_order",
    description: "Look up an order status.",
    input: schema.object({ order: schema.string() }),
    output: standardOutput,
    effect: "read",
    execute: ({ order }) => `original:${order}`,
  });
  assert.throws(
    () => routine(standardTool, () => "routine"),
    /cave_routine_standard_schema_unsupported:standard_output_order/,
  );
});

test("routine refuses to wrap another routine", () => {
  const inner = routine(originalTool("nested_lookup"), () => "routine");
  assert.throws(
    () => routine(inner, () => "outer"),
    /cave_routine_nested_unsupported:nested_lookup/,
  );
});

test("routine refuses an async guard that could never reject", () => {
  assert.throws(
    () => routine(originalTool("async_guard_lookup"), () => "routine", {
      guard: async () => false,
    }),
    /cave_routine_async_guard_unsupported:async_guard_lookup/,
  );
});

// Same faux shims as framework.runtime.mjs: report reasoning usage as 0 so
// provider-usage validation sees a complete split.
function fauxProvider(options = {}) {
  const handle = upstreamFauxProvider(options);
  const streamSimple = handle.provider.streamSimple.bind(handle.provider);
  return {
    ...handle,
    provider: {
      ...handle.provider,
      streamSimple: (...args) => withReportedReasoning(streamSimple(...args)),
    },
  };
}

function withReportedReasoning(source) {
  const output = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    for await (const event of source) {
      const partial = event.partial === undefined
        ? {}
        : { partial: reportZeroReasoning(event.partial) };
      if (event.type === "done") {
        output.push({ ...event, ...partial, message: reportZeroReasoning(event.message) });
      } else if (event.type === "error") {
        output.push({ ...event, ...partial, error: reportZeroReasoning(event.error) });
      } else {
        output.push({ ...event, ...partial });
      }
    }
  });
  return output;
}

function reportZeroReasoning(message) {
  return { ...message, usage: { ...message.usage, reasoning: 0 } };
}

function fauxAssistantMessage(...args) {
  const message = upstreamFauxAssistantMessage(...args);
  return {
    ...message,
    usage: { ...message.usage, reasoning: message.usage.reasoning ?? 0 },
  };
}

// The composed tool is an ordinary tool definition, so a required-sandbox run
// executes it through the isolated tool worker with no routine-specific path:
// same staged source graph, same definition digests, same fd-3 result frame.
// The worker is a separate process, so its routine counters die with it — the
// evidence here is the returned value, not a host-side count.
for (const [order, expected] of [["A1", "routine:A1"], ["B2", "original:B2"]]) {
  test(`a routine runs through the required sandbox worker (${order})`, async () => {
    const faux = fauxProvider();
    let observed = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("order_status", { order }, { id: `call-${order}` })),
      (context) => {
        observed = JSON.stringify(context.messages);
        return fauxAssistantMessage("done");
      },
    ]);
    const result = await run(routineAgent, order, {
      ensureRuntime: false,
      entryPath: "tests/fixtures/routine-agent.mjs",
      model: faux.getModel(),
      streamFn: faux.provider.streamSimple.bind(faux.provider),
    });
    assert.equal(result.text, "done");
    assert.match(observed, new RegExp(expected));
    // The closure ran in the tool worker, so the counter it recorded died with
    // that process: the host list holds NO entry for this tool. Honest absence,
    // not a zero (issue #248).
    assert.deepEqual(routineOutcomes().filter((item) => item.tool === "order_status"), []);
  });
}
