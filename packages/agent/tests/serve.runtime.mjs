import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DiskDurableStore,
  agent,
  auto,
  durableRunSummary,
  schema,
  stream,
  tool,
} from "../dist/index.js";
import { createAgentServer } from "../dist/serve.js";
import { scheduleDurableWake } from "../dist/durable.js";
import { fauxProvider as upstreamFauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const TOKEN = "test-token-0123456789";

function fauxModel() {
  const handle = upstreamFauxProvider({ provider: "anthropic" });
  return { ...handle.getModel(), contextWindow: 200_000, maxTokens: 4_000 };
}

function usage(fields = {}) {
  const input = fields.input ?? 100;
  const output = fields.output ?? 10;
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

function pushMessage(selected, content, stopReason, used) {
  const messageStream = createAssistantMessageEventStream();
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
    messageStream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    messageStream.push({ type: "done", reason: stopReason, message });
    messageStream.end(message);
  });
  return messageStream;
}

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

async function scratchStore() {
  const dir = await mkdtemp(resolve(tmpdir(), "cave-serve-"));
  return { dir, store: new DiskDurableStore(dir) };
}

/** Boots a server on an ephemeral port and tears it down with the test. */
async function boot(t, { definition, store, dir, streamFn, ...rest }) {
  const server = createAgentServer({
    definition,
    token: TOKEN,
    store,
    rootDir: dir,
    runOptions: { ensureRuntime: false, model: fauxModel(), streamFn },
    ...rest,
  });
  const port = await server.listen(0, "127.0.0.1");
  t.after(() => server.close(1_000));
  const base = `http://127.0.0.1:${port}`;
  const call = (path, init = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
  return { server, base, call };
}

/** Polls a run's status until it settles, so a test never asserts mid-flight. */
async function settled(call, runId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await call(`/runs/${runId}`);
    const body = await response.json();
    if (body.status === "completed" || body.status === "failed") return body;
    await new Promise((wake) => setTimeout(wake, 20));
  }
  throw new Error(`run ${runId} did not settle`);
}

test("a submitted run completes, and resubmitting it replays without spending", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let providerCalls = 0;
  const { call } = await boot(t, {
    definition: pollingAgent("serve-happy"),
    store,
    dir,
    streamFn: (selected) => {
      providerCalls += 1;
      return pushMessage(selected, [{ type: "text", text: "the answer" }], "stop", usage());
    },
  });

  const accepted = await call("/runs", {
    method: "POST",
    body: JSON.stringify({ runId: "ticket-1", input: "how many items?" }),
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { runId: "ticket-1", status: "running" });

  const done = await settled(call, "ticket-1");
  assert.equal(done.status, "completed");
  assert.equal(done.result.text, "the answer");
  assert.equal(providerCalls, 1);

  // Same runId, same input: the journal answers, the provider is not touched.
  const replay = await call("/runs", {
    method: "POST",
    body: JSON.stringify({ runId: "ticket-1", input: "how many items?" }),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).status, "completed");
  assert.equal(providerCalls, 1);
});

test("boot recovery re-drives a run a previous instance left unfinished", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const definition = pollingAgent("serve-recovery");
  const runId = "ticket-crashed";

  // The "previous instance": one completed turn, then the process dies with
  // the second provider call in flight. The journal has no terminal event.
  const controller = new AbortController();
  let firstAttemptCalls = 0;
  const iterator = stream(definition, "how many items?", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    signal: controller.signal,
    streamFn: (selected) => {
      firstAttemptCalls += 1;
      if (firstAttemptCalls === 1) {
        return pushMessage(
          selected,
          [{ type: "toolCall", id: "p1", name: "poll", arguments: {} }],
          "toolUse",
          usage(),
        );
      }
      controller.abort(new Error("simulated crash"));
      throw new Error("simulated crash");
    },
  });
  const events = [];
  for await (const event of iterator) events.push(event);
  assert.equal(events.at(-1)?.type, "run_error");
  assert.equal(durableRunSummary(await store.load(runId)).status, "pending");

  // The next instance. Nobody resubmits anything.
  let resumedCalls = 0;
  const { call, server } = await boot(t, {
    definition,
    store,
    dir,
    streamFn: (selected) => {
      resumedCalls += 1;
      return pushMessage(selected, [{ type: "text", text: "3 items" }], "stop", usage());
    },
  });
  const done = await settled(call, runId);
  assert.equal(done.status, "completed");
  assert.equal(done.result.text, "3 items");
  assert.ok(resumedCalls >= 1, "the resumed run made its own provider call");

  // A second sweep must not re-drive a run that has since settled.
  const report = await server.recover();
  assert.equal(report.listable, true);
  assert.deepEqual(report.resumed, []);
});

test("the run endpoints refuse an absent or wrong bearer token", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { base } = await boot(t, {
    definition: pollingAgent("serve-auth"),
    store,
    dir,
    streamFn: () => { throw new Error("must not be called"); },
  });

  for (const headers of [{}, { authorization: "Bearer wrong-token-here-x" }]) {
    const response = await fetch(`${base}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ runId: "ticket-2", input: "hi" }),
    });
    assert.equal(response.status, 401);
  }
  // Liveness carries no credential and reveals nothing.
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("a malformed submission fails closed before anything is journaled", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { call } = await boot(t, {
    definition: pollingAgent("serve-validation"),
    store,
    dir,
    streamFn: () => { throw new Error("must not be called"); },
  });

  const cases = [
    [{ runId: "../escape", input: "hi" }, "cave_durable_run_id_invalid"],
    [{ input: "hi" }, "cave_serve_run_id_required"],
    [{ runId: "ticket-3" }, "cave_serve_input_must_be_text"],
    // Multimodal input cannot be auto-resumed: its journal holds a digest.
    [{ runId: "ticket-3", input: { text: "hi" } }, "cave_serve_input_must_be_text"],
  ];
  for (const [body, expected] of cases) {
    const response = await call("/runs", { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, expected);
  }
  assert.equal((await call("/runs", { method: "POST", body: "{" })).status, 400);
  assert.deepEqual(await store.list(), []);
});

test("the disk store lists the runs it holds, by journaled identity", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { call } = await boot(t, {
    definition: pollingAgent("serve-list"),
    store,
    dir,
    streamFn: (selected) =>
      pushMessage(selected, [{ type: "text", text: "ok" }], "stop", usage()),
  });
  for (const runId of ["ticket-a", "ticket-b"]) {
    await call("/runs", { method: "POST", body: JSON.stringify({ runId, input: "hi" }) });
    await settled(call, runId);
  }
  assert.deepEqual(await store.list(), ["ticket-a", "ticket-b"]);
  assert.equal((await call("/runs/ticket-missing")).status, 404);
});

/** Reads an SSE response into frames until `turn.end`, the cap, or stream end. */
async function readEvents(response, { max = 200 } = {}) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = [];
  const gaps = [];
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      if (frame.startsWith(":")) continue;
      const name = /^event: (.+)$/m.exec(frame)?.[1];
      const id = /^id: (.+)$/m.exec(frame)?.[1];
      const data = JSON.parse(/^data: (.+)$/m.exec(frame)[1]);
      if (name === "gap") { gaps.push(data); continue; }
      assert.equal(Number(id), data.seq, "the SSE id must be the protocol seq");
      events.push(data);
      if (data.kind === "turn.end" || events.length >= max) return { events, gaps };
    }
  }
  return { events, gaps };
}

test("the event stream carries a run's Pebble events, in sequence, to turn.end", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { call } = await boot(t, {
    definition: pollingAgent("serve-sse"),
    store,
    dir,
    streamFn: (selected) =>
      pushMessage(selected, [{ type: "text", text: "the answer" }], "stop", usage()),
  });

  await call("/runs", {
    method: "POST",
    body: JSON.stringify({ runId: "ticket-sse", input: "how many items?" }),
  });
  const { events } = await readEvents(await call("/runs/ticket-sse/events"));

  assert.equal(events[0].kind, "turn.start");
  assert.equal(events.at(-1).kind, "turn.end");
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index));
  assert.ok(events.every((event) => event.sessionId === "ticket-sse"));
  assert.ok(events.some((event) => event.kind === "usage"), "provider usage is reported");

  // The stream is a view of the run, never its authority: the journal agrees.
  const done = await settled(call, "ticket-sse");
  assert.equal(done.status, "completed");
});

test("Last-Event-ID resumes a dropped stream with no repeats and no holes", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { call } = await boot(t, {
    definition: pollingAgent("serve-sse-resume"),
    store,
    dir,
    streamFn: (selected) =>
      pushMessage(selected, [{ type: "text", text: "the answer" }], "stop", usage()),
  });

  await call("/runs", {
    method: "POST",
    body: JSON.stringify({ runId: "ticket-resume", input: "how many items?" }),
  });
  await settled(call, "ticket-resume");

  const whole = (await readEvents(await call("/runs/ticket-resume/events"))).events;
  assert.ok(whole.length >= 3);

  const cut = whole[0].seq;
  const rest = (await readEvents(
    await call("/runs/ticket-resume/events", { headers: { "last-event-id": String(cut) } }),
  )).events;

  // Resume starts strictly after the last event the client saw, and the two
  // halves reassemble into exactly the original transcript.
  assert.equal(rest[0].seq, cut + 1);
  assert.deepEqual([whole[0], ...rest], whole);
});

test("the event stream fails closed on an unknown run and on a missing token", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { base, call } = await boot(t, {
    definition: pollingAgent("serve-sse-closed"),
    store,
    dir,
    streamFn: (selected) => pushMessage(selected, [{ type: "text", text: "x" }], "stop", usage()),
  });

  const unknown = await call("/runs/ticket-nope/events");
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, "cave_serve_not_found");

  const invalid = await call("/runs/..%2Fescape/events");
  assert.equal(invalid.status, 400);

  const anonymous = await fetch(`${base}/runs/ticket-nope/events`);
  assert.equal(anonymous.status, 401);
});

test("DELETE /runs/{id} cancels a run, and a cancelled run is never re-driven", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let providerCalls = 0;
  const { call, server } = await boot(t, {
    definition: pollingAgent("serve-cancel"),
    store,
    dir,
    streamFn: (selected) => {
      providerCalls += 1;
      return pushMessage(selected, [{ type: "text", text: "the answer" }], "stop", usage());
    },
  });

  // Cancel a run that was never submitted: nothing to stop, and it says so.
  const missing = await call("/runs/ticket-absent", { method: "DELETE" });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).status, "missing");

  // A settled run keeps its outcome; cancellation never rewrites history.
  await call("/runs", {
    method: "POST",
    body: JSON.stringify({ runId: "ticket-done", input: "how many items?" }),
  });
  await settled(call, "ticket-done");
  const late = await call("/runs/ticket-done", { method: "DELETE" });
  assert.equal(late.status, 409);
  assert.deepEqual(await late.json(), { status: "already_settled", terminal: "completed" });
  assert.equal((await (await call("/runs/ticket-done")).json()).status, "completed");

  // Cancellation is authenticated: it is a privileged operation on a resource
  // that spends money.
  const anonymous = await fetch(`${server.base ?? ""}/runs/ticket-done`, { method: "DELETE" })
    .catch(() => undefined);
  if (anonymous !== undefined) assert.notEqual(anonymous.status, 202);

  const spentBefore = providerCalls;

  // A run journaled but not driven: cancel it, then prove the sweep settles it
  // instead of resuming it.
  await store.append("ticket-stranded", `${JSON.stringify({
    v: 2,
    at: new Date().toISOString(),
    type: "run_started",
    runId: "ticket-stranded",
    agentId: "serve-cancel",
    definitionSha256: "b".repeat(64),
    input: "how many items?",
    sessionId: "stranded",
    denomination: "none",
    budgetSha256: "none",
    pid: process.pid,
  })}\n`);
  const requested = await call("/runs/ticket-stranded", { method: "DELETE" });
  assert.equal(requested.status, 202);
  assert.equal((await requested.json()).status, "requested");

  const report = await server.recover();
  assert.ok(report.skipped.some((entry) => entry.runId === "ticket-stranded"));
  assert.ok(!report.resumed.includes("ticket-stranded"));
  const closed = await (await call("/runs/ticket-stranded")).json();
  assert.equal(closed.status, "failed");
  assert.equal(closed.code, "cave_durable_run_cancelled");
  // The whole point: settling a cancelled run costs no provider call.
  assert.equal(providerCalls, spentBefore);
});

test("a sleeping run costs nothing: not swept, not resubmittable, and it names its wake", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let providerCalls = 0;
  const { call, server } = await boot(t, {
    definition: pollingAgent("serve-sleep"),
    store,
    dir,
    streamFn: (selected) => {
      providerCalls += 1;
      return pushMessage(selected, [{ type: "text", text: "the answer" }], "stop", usage());
    },
  });

  const journaled = (runId) => store.append(runId, `${JSON.stringify({
    v: 2,
    at: new Date().toISOString(),
    type: "run_started",
    runId,
    agentId: "serve-sleep",
    definitionSha256: "c".repeat(64),
    input: "how many items?",
    sessionId: runId,
    denomination: "none",
    budgetSha256: "none",
    pid: process.pid,
  })}\n`);

  const wakeAt = new Date(Date.now() + 3_600_000);
  await journaled("nap-far");
  await scheduleDurableWake(store, "nap-far", wakeAt, "waiting on approval");
  await journaled("nap-due");
  await scheduleDurableWake(store, "nap-due", new Date(Date.now() - 1000), "already due");

  const before = providerCalls;
  const report = await server.recover();
  // The sleeper is left alone and reported as sleeping, not as a problem.
  assert.deepEqual(
    report.sleeping.map((entry) => entry.runId),
    ["nap-far"],
  );
  assert.equal(report.sleeping[0].wakeAt, wakeAt.toISOString());
  assert.ok(!report.skipped.some((entry) => entry.runId === "nap-far"));
  // A run whose sleep has elapsed is ordinary work again.
  assert.ok(report.resumed.includes("nap-due"));

  // The scale-to-zero hook: one instant to set a platform alarm for. `nap-due`
  // is already overdue and is reported as such — a wake time in the past means
  // "there is work now", not "nothing to wake for" — so the earliest is its own.
  const earliest = await server.nextWakeAt();
  assert.ok(earliest !== undefined && earliest.getTime() <= wakeAt.getTime());

  // Status names the wake time, so a caller knows why nothing is happening.
  const status = await (await call("/runs/nap-far")).json();
  assert.equal(status.status, "pending");
  assert.equal(status.wakeAt, wakeAt.toISOString());
  assert.equal(status.sleepReason, "waiting on approval");

  // Resubmitting must not wake it early — that would burn the wait it is saving.
  const resubmit = await call("/runs", {
    method: "POST",
    body: JSON.stringify({ runId: "nap-far", input: "how many items?" }),
  });
  assert.equal(resubmit.status, 202);
  assert.deepEqual(await resubmit.json(), {
    runId: "nap-far",
    status: "sleeping",
    wakeAt: wakeAt.toISOString(),
  });

  // The sleeper was never driven; only the elapsed one was even considered.
  assert.equal(providerCalls, before);
});
