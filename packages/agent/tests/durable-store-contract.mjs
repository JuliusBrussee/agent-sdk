// The part of the DurableStore contract that is the same for every store:
// bytes in append order, one driver at a time, and a crashed run that resumes
// from its last completed turn. `durable.runtime.mjs` proves it for
// DiskDurableStore; the SQL and object-storage stores prove it here.
import assert from "node:assert/strict";
import { agent, auto, run, schema, stream, tool } from "../dist/index.js";
import { fauxModel, scriptedStream } from "../dist/testing.js";

function pollingAgent(id) {
  return agent({
    id,
    instructions: "Poll, then answer.",
    model: auto(),
    sandbox: "fixture",
    tools: [tool({
      name: "poll",
      description: "Poll the queue.",
      input: schema.object({}),
      effect: "read",
      allowRepeat: true,
      execute: () => "polled: 3 items",
    })],
  });
}

/** Append order, torn-tail-free reads, and enumeration. */
export async function assertJournalRoundTrip(store) {
  await store.append("round-trip", "first\nsecond\n");
  await store.append("round-trip", "third\n");
  await store.append("other-run", "alone\n");
  assert.deepEqual(await store.load("round-trip"), ["first", "second", "third"]);
  assert.deepEqual(await store.load("never-written"), []);
  assert.deepEqual([...await store.list()].sort(), ["other-run", "round-trip"]);
  await store.close("round-trip");
  await store.close("other-run");
}

/** One driver at a time, and the lock is releasable. */
export async function assertExclusiveAcquire(store, second = store) {
  const release = await store.acquire("contended");
  await assert.rejects(second.acquire("contended"), /cave_durable_run_locked/);
  await release();
  const again = await second.acquire("contended");
  await again();
  await store.close("contended");
  await second.close("contended");
}

/**
 * A run that dies mid-call resumes from its last completed turn: the tool
 * result is still in the transcript, the prompt is not asked twice, and the
 * settled spend of the first attempt is carried forward rather than re-spent.
 */
export async function assertDurableResume(store, runId) {
  const defined = pollingAgent(`store-resume-${runId.replace(/[^a-z0-9]/g, "")}`);
  const controller = new AbortController();
  const firstTurn = scriptedStream([
    { toolCalls: [{ name: "poll", args: {} }], usage: { input: 120, output: 15 } },
  ]);
  let calls = 0;
  const events = [];
  for await (const event of stream(defined, "how many items are queued?", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    signal: controller.signal,
    streamFn: (selected, context, options) => {
      calls += 1;
      if (calls === 1) return firstTurn(selected, context, options);
      // The "crash": the process dies with call 2 in flight.
      controller.abort(new Error("simulated crash"));
      throw new Error("simulated crash");
    },
  })) {
    events.push(event);
  }
  assert.equal(events.at(-1).type, "run_error");
  assert.equal(calls, 2);

  const journal = (await store.load(runId)).map((line) => JSON.parse(line));
  assert.equal(journal.some((entry) => entry.type === "run_completed"), false);
  assert.equal(journal.filter((entry) => entry.type === "turn").length, 1);
  assert.equal(journal.filter((entry) => entry.type === "call_settled").length, 1);

  const roles = [];
  const result = await run(defined, "how many items are queued?", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    streamFn: (selected, context, options) => {
      roles.push(context.messages.map((message) => message.role));
      return scriptedStream([
        { text: "3 items are queued", usage: { input: 200, output: 20 } },
      ])(selected, context, options);
    },
  });
  assert.equal(result.text, "3 items are queued");
  assert.equal(result.resumed, true);
  assert.equal(roles.length, 1);
  assert.equal(roles[0].filter((role) => role === "user").length, 1);
  assert.equal(roles[0].at(-1), "toolResult");
  assert.equal(result.inputTokens, 120 + 200);
  assert.equal(result.outputTokens, 15 + 20);
  await store.close(runId);
}
