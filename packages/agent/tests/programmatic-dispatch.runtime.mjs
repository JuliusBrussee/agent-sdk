import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, auto, run, schema, stream, subagent, tool } from "../dist/index.js";
import { DiskDurableStore } from "../dist/durable.js";
import { fauxProvider as upstreamFauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const MODEL_ID = "claude-haiku-4-5";

function fauxModel() {
  const handle = upstreamFauxProvider({ provider: "anthropic" });
  return { ...handle.getModel(), id: MODEL_ID };
}

function usage(input = 100, output = 10) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function message(selected, content, stopReason = "toolUse") {
  const stream = createAssistantMessageEventStream();
  const value = {
    role: "assistant",
    content,
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...value, content: [], stopReason: "pending" } });
    stream.push({ type: "done", reason: stopReason, message: value });
    stream.end(value);
  });
  return stream;
}

function definedAgent(id, composite) {
  return agent({
    id,
    instructions: "Use composite tool, then finish.",
    model: `anthropic/${MODEL_ID}`,
    sandbox: "host",
    tools: [composite],
  });
}

function compositeTool(nestedTools, execute, options = {}) {
  return tool({
    name: "code_cell",
    description: "Execute one composite cell.",
    input: schema.object({ cell: schema.string() }),
    effect: "write",
    result: "inline",
    nestedTools,
    ...options,
    execute,
  });
}

test("nested dispatch preserves names, errors, and hides raw results from provider transcript", async () => {
  const lookup = tool({
    name: "lookup",
    description: "Read one value.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    result: "inline",
    async execute({ key }) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return `SECRET:${key}`;
    },
  });
  const fail = tool({
    name: "fail_read",
    description: "Fail one read.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    result: "inline",
    execute: () => { throw new Error("nested failure"); },
  });
  const composite = compositeTool([lookup, fail], async (_input, _signal, context) => {
    assert.ok(context);
    assert.match(context.parentToolCallId, /^cell-1$/);
    const outcomes = await Promise.allSettled([
      context.dispatch("lookup", { key: "private" }),
      context.dispatch("fail_read", { key: "x" }),
    ]);
    assert.equal(outcomes[0].status, "fulfilled");
    assert.equal(outcomes[1].status, "rejected");
    return "filtered";
  });
  let providerCall = 0;
  const observedContexts = [];
  const routeErrorStreaks = [];
  const result = await run(definedAgent("nested-receipt", composite), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    modelRouter(input) {
      routeErrorStreaks.push(input.toolErrorStreak);
      return { model: input.currentModel, reason: "test", signals: ["test"] };
    },
    streamFn: (selected, context) => {
      observedContexts.push(JSON.stringify(context));
      providerCall++;
      return providerCall === 1
        ? message(selected, [{
          type: "toolCall",
          id: "cell-1",
          name: "code_cell",
          arguments: { cell: "one" },
        }])
        : message(selected, [{ type: "text", text: "done" }], "stop");
    },
  });

  assert.equal(result.stopReason, "complete");
  assert.deepEqual(result.toolCalls, ["code_cell", "lookup", "fail_read"]);
  assert.deepEqual(result.receipt.tools, [
    { name: "code_cell", calls: 1, errors: 0 },
    { name: "lookup", calls: 1, errors: 0 },
    { name: "fail_read", calls: 1, errors: 1 },
  ]);
  assert.deepEqual(routeErrorStreaks, [0, 1]);
  assert.equal(observedContexts[1].includes("SECRET:private"), false);
});

test("programmatic nested subagent uses canonical child runner and receipt rollup", async () => {
  const explorer = agent({
    id: "programmatic-explorer",
    instructions: "Return compact repository evidence.",
    model: auto(),
    sandbox: "host",
  });
  const delegated = subagent({
    name: "delegate_explorer",
    description: "Explore in separate context.",
    agent: explorer,
    maxCalls: 1,
    maxCostUsd: 10,
    maxTokens: 1_000,
    maxContextTokens: 10_000,
  });
  const composite = compositeTool([delegated], async (_input, _signal, context) => {
    assert.ok(context);
    const result = await context.dispatch("delegate_explorer", { task: "Locate routing tests." });
    return JSON.stringify(result);
  });
  let providerCall = 0;
  const result = await run(definedAgent("programmatic-subagent-root", composite), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    streamFn(selected) {
      providerCall++;
      if (providerCall === 1) {
        return message(selected, [{
          type: "toolCall",
          id: "programmatic-subagent-cell",
          name: "code_cell",
          arguments: { cell: "delegate" },
        }]);
      }
      return providerCall === 2
        ? message(selected, [{ type: "text", text: "child evidence" }], "stop")
        : message(selected, [{ type: "text", text: "done" }], "stop");
    },
  });

  assert.equal(result.text, "done");
  assert.deepEqual(result.toolCalls, ["code_cell", "delegate_explorer"]);
  assert.deepEqual(result.receipt.tools, [
    { name: "code_cell", calls: 1, errors: 0 },
    { name: "delegate_explorer", calls: 1, errors: 0 },
  ]);
  assert.equal(result.receipt.subagents.length, 1);
  assert.equal(result.receipt.subagents[0]?.agentId, "programmatic-explorer");
});

test("programmatic nested subagent emits live nested lifecycle", async () => {
  const explorer = agent({
    id: "streamed-programmatic-explorer",
    instructions: "Return compact repository evidence.",
    model: `anthropic/${MODEL_ID}`,
    sandbox: "host",
  });
  const delegated = subagent({
    name: "delegate_explorer",
    description: "Explore in separate context.",
    agent: explorer,
    maxCalls: 1,
    maxCostUsd: 10,
    maxTokens: 1_000,
    maxContextTokens: 10_000,
  });
  const composite = compositeTool([delegated], async (_input, _signal, context) => {
    assert.ok(context);
    return JSON.stringify(await context.dispatch("delegate_explorer", { task: "Locate routing tests." }));
  });
  let providerCall = 0;
  const events = [];
  for await (const event of stream(definedAgent("streamed-programmatic-root", composite), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    streamFn(selected) {
      providerCall++;
      if (providerCall === 1) {
        return message(selected, [{
          type: "toolCall",
          id: "streamed-programmatic-cell",
          name: "code_cell",
          arguments: { cell: "delegate" },
        }]);
      }
      return providerCall === 2
        ? message(selected, [{ type: "text", text: "child evidence" }], "stop")
        : message(selected, [{ type: "text", text: "done" }], "stop");
    },
  })) events.push(event);

  const lifecycle = events.filter((event) => event.type.startsWith("nested_tool_"));
  assert.equal(lifecycle.length, 2);
  assert.deepEqual(lifecycle[0], {
    type: "nested_tool_start",
    runId: events[0].runId,
    id: "streamed-programmatic-cell:nested:1",
    name: "delegate_explorer",
    args: { task: "Locate routing tests." },
  });
  assert.equal(lifecycle[1]?.type, "nested_tool_end");
  assert.equal(lifecycle[1]?.id, "streamed-programmatic-cell:nested:1");
  assert.equal(lifecycle[1]?.name, "delegate_explorer");
  assert.equal(lifecycle[1]?.isError, false);
  assert.equal(lifecycle[1]?.result?.text, "child evidence");
  assert.equal(lifecycle[1]?.result?.agent_id, "streamed-programmatic-explorer");
  assert.equal(lifecycle[1]?.result?.usage_basis, "provider_reported");
  assert.equal(lifecycle[1]?.result?.stop_reason, "complete");
});

test("agent graph rejects subagent cycles hidden inside programmatic composite", async () => {
  const cyclic = {
    kind: "agent",
    id: "programmatic-cycle",
    instructions: "Invalid cycle.",
    model: `anthropic/${MODEL_ID}`,
    reasoning: "off",
    tools: [],
    contexts: [],
    sandbox: "host",
  };
  const delegated = subagent({
    name: "delegate_cycle",
    description: "Invalid cycle.",
    agent: cyclic,
  });
  cyclic.tools = [compositeTool([delegated], () => "never")];
  let providerCalls = 0;
  await assert.rejects(
    run(cyclic, "go", {
      ensureRuntime: false,
      model: fauxModel(),
      streamFn(selected) {
        providerCalls++;
        return message(selected, [{ type: "text", text: "must not run" }], "stop");
      },
    }),
    /cave_subagent_definition_cycle/,
  );
  assert.equal(providerCalls, 0);
});

test("nested fanout shares one run cap across composite cells", async () => {
  const read = tool({
    name: "read_item",
    description: "Read one item.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    result: "inline",
    execute: ({ key }) => `value:${key}`,
  });
  const composite = compositeTool([read], async ({ cell }, _signal, context) => {
    assert.ok(context);
    const outcomes = await Promise.allSettled([
      context.dispatch("read_item", { key: `${cell}-a` }),
      context.dispatch("read_item", { key: `${cell}-b` }),
    ]);
    return outcomes.map((item) => item.status).join(",");
  });
  let providerCall = 0;
  const result = await run(definedAgent("nested-run-cap", composite), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    maxToolCalls: 3,
    streamFn: (selected) => {
      providerCall++;
      if (providerCall <= 2) {
        return message(selected, [{
          type: "toolCall",
          id: `cell-${providerCall}`,
          name: "code_cell",
          arguments: { cell: String(providerCall) },
        }]);
      }
      return message(selected, [{ type: "text", text: "done" }], "stop");
    },
  });

  assert.equal(result.stopReason, "complete");
  assert.deepEqual(result.receipt.tools, [
    { name: "code_cell", calls: 2, errors: 0 },
    { name: "read_item", calls: 4, errors: 1 },
  ]);
  assert.equal(result.toolCalls.filter((name) => name === "read_item").length, 4);
});

test("nested fanout breaker spans multiple composite cells in one assistant turn", async () => {
  const read = tool({
    name: "fanout_read",
    description: "Read one item.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    result: "inline",
    execute: ({ key }) => key,
  });
  const composite = compositeTool([read], async ({ cell }, _signal, context) => {
    assert.ok(context);
    const outcomes = await Promise.allSettled([
      context.dispatch("fanout_read", { key: `${cell}-a` }),
      context.dispatch("fanout_read", { key: `${cell}-b` }),
    ]);
    return outcomes.map((item) => item.status).join(",");
  });
  let providerCall = 0;
  const result = await run(definedAgent("nested-turn-fanout", composite), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    breakers: { maxToolCallsPerTurn: 3 },
    streamFn: (selected) => {
      providerCall++;
      if (providerCall === 1) {
        return message(selected, ["one", "two"].map((cell) => ({
          type: "toolCall",
          id: `${cell}-cell`,
          name: "code_cell",
          arguments: { cell },
        })));
      }
      return message(selected, [{ type: "text", text: "done" }], "stop");
    },
  });

  assert.equal(result.stopReason, "complete");
  assert.deepEqual(result.receipt.tools, [
    { name: "code_cell", calls: 2, errors: 0 },
    { name: "fanout_read", calls: 4, errors: 1 },
  ]);
  assert.equal(
    result.receipt.breakers.filter((event) => event.kind === "fan_out_blocked").length,
    1,
  );
});

test("composite envelopes have separate bounded fanout", async () => {
  const composite = compositeTool([], () => "empty");
  let providerCall = 0;
  const result = await run(definedAgent("composite-envelope-fanout", composite), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    breakers: { maxToolCallsPerTurn: 3 },
    streamFn: (selected) => {
      providerCall++;
      if (providerCall === 1) {
        return message(selected, ["one", "two", "three", "four"].map((cell) => ({
          type: "toolCall",
          id: `${cell}-cell`,
          name: "code_cell",
          arguments: { cell },
        })));
      }
      return message(selected, [{ type: "text", text: "done" }], "stop");
    },
  });

  assert.equal(result.stopReason, "complete");
  assert.deepEqual(result.receipt.tools, [
    { name: "code_cell", calls: 4, errors: 1 },
  ]);
});

test("composite declaration cannot fake write progress", async () => {
  const read = tool({
    name: "same_read",
    description: "Return same value.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    result: "inline",
    execute: () => "same",
  });
  const composite = compositeTool([read], async (_input, _signal, context) => {
    assert.ok(context);
    await context.dispatch("same_read", { key: "x" });
    return "same";
  });
  let providerCalls = 0;
  const result = await run(definedAgent("nested-no-progress", composite), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    breakers: { noProgressTurns: 2 },
    streamFn: (selected) => {
      providerCalls++;
      return message(selected, [{
        type: "toolCall",
        id: `cell-${providerCalls}`,
        name: "code_cell",
        arguments: { cell: "same" },
      }]);
    },
  });

  assert.equal(providerCalls, 2);
  assert.equal(result.stopReason, "no_progress");
  assert.equal(result.receipt.breakers.some((event) => event.kind === "no_progress"), true);
});

test("successful nested writes record real progress", async () => {
  let mutations = 0;
  const write = tool({
    name: "advance",
    description: "Advance state.",
    input: schema.object({ key: schema.string() }),
    effect: "write",
    result: "inline",
    allowRepeat: true,
    execute: () => { mutations++; return "same"; },
  });
  const composite = compositeTool([write], async (_input, _signal, context) => {
    assert.ok(context);
    await context.dispatch("advance", { key: "x" });
    return "same";
  });
  let providerCalls = 0;
  const result = await run(definedAgent("nested-write-progress", composite), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    breakers: { noProgressTurns: 2 },
    streamFn: (selected) => {
      providerCalls++;
      if (providerCalls <= 2) {
        return message(selected, [{
          type: "toolCall",
          id: `cell-${providerCalls}`,
          name: "code_cell",
          arguments: { cell: "same" },
        }]);
      }
      return message(selected, [{ type: "text", text: "done" }], "stop");
    },
  });

  assert.equal(result.stopReason, "complete");
  assert.equal(mutations, 2);
  assert.equal(result.receipt.breakers.some((event) => event.kind === "no_progress"), false);
});

test("composite completion waits for fire-and-forget nested writes", async () => {
  let mutated = false;
  const write = tool({
    name: "slow_write",
    description: "Write after delay.",
    input: schema.object({ key: schema.string() }),
    effect: "write",
    result: "inline",
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, 40));
      mutated = true;
      return "done";
    },
  });
  const composite = compositeTool([write], (_input, _signal, context) => {
    assert.ok(context);
    void context.dispatch("slow_write", { key: "x" });
    return "cell done";
  });
  let providerCall = 0;
  const startedAt = performance.now();
  const result = await run(definedAgent("nested-write-drain", composite), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    streamFn: (selected) => {
      providerCall++;
      return providerCall === 1
        ? message(selected, [{
          type: "toolCall",
          id: "drain-cell",
          name: "code_cell",
          arguments: { cell: "one" },
        }])
        : message(selected, [{ type: "text", text: "done" }], "stop");
    },
  });

  assert.equal(result.stopReason, "complete");
  assert.equal(mutated, true);
  assert.equal(performance.now() - startedAt >= 35, true);
});

test("aborted composite waits for admitted nested mutation to quiesce", async () => {
  let release;
  let markStarted;
  let mutated = false;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const write = tool({
    name: "abort_write",
    description: "Finish one admitted write despite cancellation.",
    input: schema.object({ key: schema.string() }),
    effect: "write",
    result: "inline",
    async execute() {
      markStarted();
      await gate;
      mutated = true;
      return "done";
    },
  });
  const composite = compositeTool([write], async (_input, _signal, context) => {
    assert.ok(context);
    await context.dispatch("abort_write", { key: "x" });
    return "cell done";
  });
  const controller = new AbortController();
  const execution = run(definedAgent("nested-abort-drain", composite), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    signal: controller.signal,
    streamFn: (selected) => message(selected, [{
      type: "toolCall",
      id: "abort-cell",
      name: "code_cell",
      arguments: { cell: "one" },
    }]),
  });
  let settled = false;
  void execution.then(() => { settled = true; }, () => { settled = true; });
  await started;
  controller.abort(new Error("test nested abort"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  assert.equal(mutated, false);
  release();
  await assert.rejects(execution, /cave_provider_terminal_aborted/);
  assert.equal(mutated, true);
});

test("two concurrent runs keep nested admission and receipts isolated", async () => {
  const read = tool({
    name: "run_read",
    description: "Read one run value.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    result: "inline",
    async execute({ key }) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return key;
    },
  });
  const composite = compositeTool([read], async ({ cell }, _signal, context) => {
    assert.ok(context);
    return context.dispatch("run_read", { key: cell });
  });
  const defined = definedAgent("nested-concurrent", composite);
  const runOne = (tag) => {
    let providerCall = 0;
    return run(defined, tag, {
      ensureRuntime: false,
      model: fauxModel(),
      maxToolCalls: 1,
      streamFn: (selected) => {
        providerCall++;
        return providerCall === 1
          ? message(selected, [{
            type: "toolCall",
            id: `${tag}-cell`,
            name: "code_cell",
            arguments: { cell: tag },
          }])
          : message(selected, [{ type: "text", text: "done" }], "stop");
      },
    });
  };

  const [left, right] = await Promise.all([runOne("left"), runOne("right")]);
  for (const result of [left, right]) {
    assert.equal(result.stopReason, "complete");
    assert.deepEqual(result.receipt.tools, [
      { name: "code_cell", calls: 1, errors: 0 },
      { name: "run_read", calls: 1, errors: 0 },
    ]);
  }
});

test("per-parent scheduler overlaps reads and serializes effect barriers", async () => {
  const events = [];
  let activeReads = 0;
  let maxReads = 0;
  let activeWrites = 0;
  let maxWrites = 0;
  const read = tool({
    name: "ordered_read",
    description: "Read with observable scheduling.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    result: "inline",
    async execute({ key }) {
      events.push(`read:${key}:start`);
      activeReads++;
      maxReads = Math.max(maxReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeReads--;
      events.push(`read:${key}:end`);
      return key;
    },
  });
  const write = tool({
    name: "ordered_write",
    description: "Write with observable scheduling.",
    input: schema.object({ key: schema.string() }),
    effect: "write",
    result: "inline",
    async execute({ key }) {
      events.push(`write:${key}:start`);
      activeWrites++;
      maxWrites = Math.max(maxWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeWrites--;
      events.push(`write:${key}:end`);
      return key;
    },
  });
  const composite = compositeTool([read, write], async (_input, _signal, context) => {
    assert.ok(context);
    await Promise.all([
      context.dispatch("ordered_read", { key: "a" }),
      context.dispatch("ordered_read", { key: "b" }),
      context.dispatch("ordered_write", { key: "one" }),
      context.dispatch("ordered_write", { key: "two" }),
      context.dispatch("ordered_read", { key: "c" }),
    ]);
    return "done";
  });
  let providerCall = 0;
  const result = await run(definedAgent("nested-ordering", composite), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    maxToolCalls: 5,
    streamFn: (selected) => {
      providerCall++;
      return providerCall === 1
        ? message(selected, [{
          type: "toolCall",
          id: "ordered-cell",
          name: "code_cell",
          arguments: { cell: "one" },
        }])
        : message(selected, [{ type: "text", text: "done" }], "stop");
    },
  });

  assert.equal(result.stopReason, "complete");
  assert.equal(maxReads, 2, "reads before the effect barrier overlap");
  assert.equal(maxWrites, 1, "writes never overlap");
  assert.ok(events.indexOf("write:one:start") > events.indexOf("read:a:end"));
  assert.ok(events.indexOf("write:one:start") > events.indexOf("read:b:end"));
  assert.ok(events.indexOf("write:two:start") > events.indexOf("write:one:end"));
  assert.ok(events.indexOf("read:c:start") > events.indexOf("write:two:end"));
});

test("speculation claim hint without bound run scope executes canonical work", async () => {
  let executions = 0;
  const read = tool({
    name: "safe_read",
    description: "Read safely.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    speculative: true,
    result: "inline",
    execute: () => { executions++; return "live"; },
  });
  const composite = compositeTool(
    [read],
    async (_input, _signal, context) => {
      assert.ok(context);
      return context.dispatch("safe_read", { key: "x" }, {
        claimSpeculation: true,
      });
    },
    { speculativeTools: ["safe_read"] },
  );
  let providerCall = 0;
  const result = await run(definedAgent("nested-precomputed", composite), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    maxToolCalls: 1,
    streamFn: (selected) => {
      providerCall++;
      return providerCall === 1
        ? message(selected, [{
          type: "toolCall",
          id: "spec-cell",
          name: "code_cell",
          arguments: { cell: "one" },
        }])
        : message(selected, [{ type: "text", text: "done" }], "stop");
    },
  });

  assert.equal(result.stopReason, "complete");
  assert.equal(executions, 1);
  assert.deepEqual(result.receipt.tools, [
    { name: "code_cell", calls: 1, errors: 0 },
    { name: "safe_read", calls: 1, errors: 0 },
  ]);
});

test("durable journal records nested tool outcomes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cave-nested-journal-"));
  const store = new DiskDurableStore(resolve(root, "journal"));
  try {
    const read = tool({
      name: "journal_read",
      description: "Read one value.",
      input: schema.object({ key: schema.string() }),
      effect: "read",
      result: "inline",
      execute: ({ key }) => key,
    });
    const composite = compositeTool([read], async (_input, _signal, context) => {
      assert.ok(context);
      await context.dispatch("journal_read", { key: "x" });
      return "filtered";
    });
    let providerCall = 0;
    const runId = "nested-journal-run";
    const result = await run(definedAgent("nested-journal", composite), "go", {
      ensureRuntime: false,
      model: fauxModel(),
      rootDir: root,
      durable: { runId, store },
      streamFn: (selected) => {
        providerCall++;
        return providerCall === 1
          ? message(selected, [{
            type: "toolCall",
            id: "journal-cell",
            name: "code_cell",
            arguments: { cell: "one" },
          }])
          : message(selected, [{ type: "text", text: "done" }], "stop");
      },
    });
    assert.equal(result.stopReason, "complete");
    const events = (await store.load(runId)).map((line) => JSON.parse(line));
    assert.deepEqual(
      events.filter((event) => event.type === "tool").map((event) => [event.name, event.isError]),
      [["journal_read", false], ["code_cell", false]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested declaration rejects duplicate, recursive, and speculative write surfaces", () => {
  const read = tool({
    name: "read",
    description: "Read.",
    input: schema.object({}),
    effect: "read",
    execute: () => "ok",
  });
  assert.throws(
    () => compositeTool([read], () => "ok", { speculativeTools: ["read"] }),
    /invalid speculative nested tool/,
  );
  assert.throws(
    () => compositeTool([read, read], () => "ok"),
    /duplicate nested tool/,
  );
  const inner = compositeTool([read], () => "ok");
  assert.throws(
    () => compositeTool([inner], () => "ok"),
    /nested tools must be flat/,
  );
  const write = tool({
    name: "write",
    description: "Write.",
    input: schema.object({}),
    effect: "write",
    execute: () => "ok",
  });
  assert.throws(
    () => tool({
      name: "speculative_write",
      description: "Invalid speculative effect.",
      input: schema.object({}),
      effect: "write",
      speculative: true,
      execute: () => "ok",
    }),
    /speculative tool must be read-only/,
  );
  assert.throws(
    () => compositeTool([write], () => "ok", { speculativeTools: ["write"] }),
    /invalid speculative nested tool/,
  );
  assert.throws(
    () => tool({
      name: "read_composite",
      description: "Invalid parallel effect surface.",
      input: schema.object({}),
      effect: "read",
      nestedTools: [write],
      execute: () => "ok",
    }),
    /read composite cannot contain effectful nested tools/,
  );
  const runtime = {
    kind: "subagent",
    definition: {},
    maxInputChars: 100,
    maxCalls: 1,
    maxCostUsd: 1,
    maxContextTokens: 100,
  };
  const nestedRuntime = tool({
    name: "nested_runtime",
    description: "Supported nested subagent runtime.",
    input: schema.object({}),
    effect: "read",
    runtime,
    execute: () => "ok",
  });
  assert.equal(compositeTool([nestedRuntime], () => "ok").nestedTools?.[0], nestedRuntime);
  assert.throws(
    () => tool({
      name: "runtime_composite",
      description: "Unsupported composite runtime.",
      input: schema.object({}),
      effect: "read",
      runtime,
      nestedTools: [read],
      execute: () => "ok",
    }),
    /composite tool runtime unsupported/,
  );
});
