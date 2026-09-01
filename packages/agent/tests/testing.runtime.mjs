import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, run, schema, tool } from "../dist/index.js";
import { fauxModel, scriptedStream } from "../dist/testing.js";

test("fauxModel is unpriced by default and cataloged on request", () => {
  const plain = fauxModel();
  assert.equal(plain.provider, "anthropic");
  assert.equal(plain.contextWindow, 200_000);
  assert.equal(plain.maxTokens, 4_000);
  // Unpriced by default: an uncataloged id is what proves a USD budget fails
  // closed rather than metering fiction.
  assert.notEqual(plain.id, "claude-haiku-4-5");
  assert.equal(fauxModel({ priced: true }).id, "claude-haiku-4-5");
  assert.equal(fauxModel({ id: "acme-lab-preview" }).id, "acme-lab-preview");
  assert.equal(fauxModel({ provider: "openai" }).provider, "openai");
});

test("a USD budget refuses the unpriced faux model", async () => {
  await assert.rejects(
    run(
      agent({ id: "unpriced-budget", instructions: "Answer.", model: "anthropic/claude-haiku-4-5", sandbox: "fixture" }),
      "go",
      {
        ensureRuntime: false,
        model: fauxModel(),
        budget: { maxUsd: 1 },
        streamFn: scriptedStream([{ text: "must not run" }]),
      },
    ),
    /cave_budget_denomination_unavailable/,
  );
});

test("scriptedStream answers turns in order and drives the tool loop", async () => {
  const calls = [];
  const defined = agent({
    id: "scripted-loop",
    instructions: "Poll, then answer.",
    model: "anthropic/claude-haiku-4-5",
    sandbox: "fixture",
    tools: [tool({
      name: "poll",
      description: "Poll the queue.",
      input: schema.object({ key: schema.string() }),
      effect: "read",
      allowRepeat: true,
      execute: (input) => {
        calls.push(input.key);
        return `${input.key}: 3 items`;
      },
    })],
  });
  const result = await run(defined, "how many?", {
    ensureRuntime: false,
    model: fauxModel(),
    streamFn: scriptedStream([
      { toolCalls: [{ name: "poll", args: { key: "queue-a" } }] },
      { text: "3 items are queued", usage: { input: 200, output: 20 } },
    ]),
  });
  assert.deepEqual(calls, ["queue-a"]);
  assert.equal(result.text, "3 items are queued");
  // Usage is whatever the script said, defaults filled in for the first turn.
  assert.equal(result.inputTokens, 100 + 200);
  assert.equal(result.outputTokens, 10 + 20);
  // Never a gateway claim: this process produced both turns.
  assert.equal(result.mode, "observe-only");
});

test("a script that runs out is an error, not an invented turn", async () => {
  const defined = agent({
    id: "scripted-exhausted",
    instructions: "Poll forever.",
    model: "anthropic/claude-haiku-4-5",
    sandbox: "fixture",
    tools: [tool({
      name: "poll",
      description: "Poll the queue.",
      input: schema.object({}),
      effect: "read",
      allowRepeat: true,
      execute: () => "more",
    })],
  });
  // The run fails loudly rather than hanging or inventing another answer.
  await assert.rejects(
    run(defined, "go", {
      ensureRuntime: false,
      model: fauxModel(),
      streamFn: scriptedStream([{ toolCalls: [{ name: "poll", args: {} }] }]),
    }),
    /cave_provider_terminal_error/,
  );
  assert.throws(
    () => scriptedStream([])({ api: "faux", provider: "anthropic", id: "faux-1" }),
    /cave_testing_script_exhausted/,
  );
});

test("scriptedStream takes an injectable clock so byte assertions are deterministic", async () => {
  const selected = fauxModel();
  const timestampOf = async (stream) => {
    for await (const event of stream) {
      if (event.type === "done") return event.message.timestamp;
    }
    return undefined;
  };
  const fixed = await timestampOf(
    scriptedStream([{ text: "answered" }], { now: () => 1_700_000_000_000 })(selected),
  );
  assert.equal(fixed, 1_700_000_000_000);
  // Default is still the wall clock.
  const wallClock = await timestampOf(scriptedStream([{ text: "answered" }])(selected));
  assert.equal(Math.abs(wallClock - Date.now()) < 5_000, true);
});
