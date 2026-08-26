import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  DiskDurableStore,
  agent,
  auto,
  run,
  schema,
  stream,
  subagent,
  tool,
} from "../dist/index.js";
import { fauxProvider as upstreamFauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const receiptSchema = JSON.parse(readFileSync(
  new URL("../../shared/contracts/schemas/agent-run-receipt.schema.json", import.meta.url),
  "utf8",
));
const validateReceipt = new Ajv2020({ strict: true, allErrors: true }).compile(receiptSchema);

function assertSharedReceiptContract(receipt) {
  const wire = JSON.parse(JSON.stringify(receipt));
  assert.equal(
    validateReceipt(wire),
    true,
    validateReceipt.errors === null ? "invalid receipt" : JSON.stringify(validateReceipt.errors),
  );
}

function fauxModel() {
  const handle = upstreamFauxProvider({ provider: "anthropic" });
  return { ...handle.getModel(), contextWindow: 200_000, maxTokens: 4_000 };
}

function pricedFauxModel() {
  return { ...fauxModel(), id: "claude-haiku-4-5" };
}

function usage(fields = {}) {
  const input = fields.input ?? 100;
  const output = fields.output ?? 10;
  return {
    input,
    output,
    cacheRead: fields.cacheRead ?? 0,
    cacheWrite: fields.cacheWrite ?? 0,
    reasoning: 0,
    totalTokens: input + output + (fields.cacheRead ?? 0) + (fields.cacheWrite ?? 0),
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

function pollingAgent(id, onPoll = () => "polled: 3 items") {
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
      execute: onPoll,
    })],
  });
}

async function scratchStore() {
  const dir = await mkdtemp(resolve(tmpdir(), "cave-durable-"));
  return { dir, store: new DiskDurableStore(dir) };
}

async function journalPath(dir, runId) {
  const { readdir } = await import("node:fs/promises");
  const entry = (await readdir(dir)).find((name) => name.startsWith(`${runId}-`));
  assert.notEqual(entry, undefined, `no journal directory for ${runId}`);
  return resolve(dir, entry, "journal.jsonl");
}

async function journalLines(dir, runId) {
  const raw = await readFile(await journalPath(dir, runId), "utf8");
  return raw.trim().split("\n").map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Crash mid-provider-call, resume continues from the completed turn.
// ---------------------------------------------------------------------------

test("a run crashed mid-call resumes from its last completed turn without re-asking", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const defined = pollingAgent("durable-continue");
  const runId = "ticket-1";
  const controller = new AbortController();
  let firstAttemptCalls = 0;
  const iterator = stream(defined, "how many items are queued?", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    signal: controller.signal,
    streamFn: (selected) => {
      firstAttemptCalls++;
      if (firstAttemptCalls === 1) {
        return pushMessage(
          selected,
          [{ type: "toolCall", id: "p1", name: "poll", arguments: {} }],
          "toolUse",
          usage({ input: 120, output: 15 }),
        );
      }
      // The "crash": the process dies while call 2 is in flight. Its intent
      // is journaled; its usage never lands.
      controller.abort(new Error("simulated crash"));
      throw new Error("simulated crash");
    },
  });
  const events = [];
  for await (const event of iterator) events.push(event);
  assert.equal(events.at(-1).type, "run_error");
  assert.equal(firstAttemptCalls, 2);

  // The journal is pending (no terminal event), holds the completed turn,
  // the settled first call, and the unmatched second intent.
  const lines = await journalLines(dir, runId);
  assert.equal(lines.some((entry) => entry.type === "run_failed"), false);
  assert.equal(lines.some((entry) => entry.type === "run_completed"), false);
  assert.equal(lines.filter((entry) => entry.type === "turn").length, 1);
  assert.equal(lines.filter((entry) => entry.type === "call_settled").length, 1);
  assert.equal(lines.filter((entry) => entry.type === "call_started").length, 2);

  let secondAttemptContexts = [];
  const result = await run(defined, "how many items are queued?", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    streamFn: (selected, context) => {
      secondAttemptContexts.push(context.messages.map((message) => message.role));
      return pushMessage(
        selected,
        [{ type: "text", text: "3 items are queued" }],
        "stop",
        usage({ input: 200, output: 20 }),
      );
    },
  });
  assert.equal(result.text, "3 items are queued");
  assert.equal(result.resumed, true);
  // The resumed context continues the transcript: exactly one user message
  // (never the prompt twice), ending at the crashed run's tool result.
  assert.equal(secondAttemptContexts.length, 1);
  const roles = secondAttemptContexts[0];
  assert.equal(roles.filter((role) => role === "user").length, 1);
  assert.equal(roles.at(-1), "toolResult");
  // Totals cover the whole logical run; the resume block attributes it.
  assert.equal(result.inputTokens, 120 + 200);
  assert.equal(result.outputTokens, 15 + 20);
  assert.equal(result.receipt.resume.attempts, 2);
  assert.equal(result.receipt.resume.priorCalls, 1);
  assert.equal(result.receipt.resume.possibleDoubleCountCalls, 1);
  assert.equal(result.receipt.resume.discardedPartialTurn, false);
  assert.equal(result.receipt.calls.length, 1);
  assertSharedReceiptContract(result.receipt);
});

// ---------------------------------------------------------------------------
// Crash mid-tool (no completed turn): fresh restart, spend still counted.
// ---------------------------------------------------------------------------

test("a run whose crash lost the turn restarts fresh but never loses settled spend", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const controller = new AbortController();
  const defined = pollingAgent("durable-fresh");
  const runId = "ticket-2";
  let calls = 0;
  const iterator = stream(defined, "poll once", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    signal: controller.signal,
    budget: { maxTokens: 100_000 },
    streamFn: (selected) => {
      calls++;
      if (calls === 1) {
        return pushMessage(
          selected,
          [{ type: "toolCall", id: "p1", name: "poll", arguments: {} }],
          "toolUse",
          usage({ input: 300, output: 30 }),
        );
      }
      controller.abort(new Error("simulated crash"));
      throw new Error("simulated crash");
    },
  });
  for await (const _event of iterator) { /* drain to termination */ }

  // A SIGKILL loses whatever was not yet flushed. The in-process simulation
  // above flushes everything on its way down, so reproduce the killed
  // process's journal directly: settled money made it to disk, the turn's
  // conversation state did not.
  const truncatedPath = await journalPath(dir, runId);
  const written = (await readFile(truncatedPath, "utf8")).split("\n").filter(Boolean);
  const lastIntent = written.findLastIndex((line) => JSON.parse(line).type === "call_started");
  const survived = written.filter((line, index) => {
    const type = JSON.parse(line).type;
    if (type === "turn" || type === "tool") return false;
    // The graceful in-process teardown also flushed a worst-case settle for
    // the in-flight call; a killed process never writes it.
    if (type === "call_settled" && index > lastIntent) return false;
    return true;
  });
  await writeFile(truncatedPath, `${survived.join("\n")}\n`);

  let roles;
  const result = await run(defined, "poll once", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    budget: { maxTokens: 100_000 },
    streamFn: (selected, context) => {
      roles = context.messages.map((message) => message.role);
      return pushMessage(
        selected,
        [{ type: "text", text: "done" }],
        "stop",
        usage({ input: 150, output: 12 }),
      );
    },
  });
  // No completed turn survived, so the run restarted from the prompt alone…
  assert.equal(roles.filter((role) => role === "user").length, 1);
  assert.equal(roles.at(-1), "user");
  // …but the crashed attempt's settled call is preloaded, not forgotten: the
  // meter's spent figure covers both attempts, and the call that was in
  // flight at the crash is surfaced, not guessed at.
  assert.equal(result.receipt.resume.priorCalls, 1);
  assert.equal(result.receipt.resume.priorSettled, 330);
  assert.equal(result.receipt.resume.possibleDoubleCountCalls, 1);
  assert.equal(result.receipt.spent, 330 + 162);
  assert.equal(result.resumed, true);
  assertSharedReceiptContract(result.receipt);
});

// ---------------------------------------------------------------------------
// Terminal outcomes replay without spending (idempotency key semantics).
// ---------------------------------------------------------------------------

test("a completed durable run returns its journaled result without spending again", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const defined = pollingAgent("durable-idempotent");
  const runId = "ticket-3";
  const options = (streamFn) => ({
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    streamFn,
  });
  const first = await run(defined, "answer", options((selected) => pushMessage(
    selected,
    [{ type: "text", text: "the answer" }],
    "stop",
    usage(),
  )));
  assert.equal(first.text, "the answer");
  let replayCalls = 0;
  const replay = await run(defined, "answer", options(() => {
    replayCalls++;
    throw new Error("must not be called");
  }));
  assert.equal(replayCalls, 0);
  assert.equal(replay.text, "the answer");
  assert.equal(replay.runId, runId);
});

test("a failed durable run replays its error without spending again", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const defined = pollingAgent("durable-terminal-error");
  const runId = "ticket-4";
  const options = (streamFn) => ({
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    streamFn,
  });
  let firstError;
  try {
    await run(defined, "answer", options(() => {
      throw new Error("provider exploded");
    }));
  } catch (error) {
    firstError = error;
  }
  assert.notEqual(firstError, undefined);
  let replayCalls = 0;
  let replayError;
  try {
    await run(defined, "answer", options(() => {
      replayCalls++;
      throw new Error("must not be called");
    }));
  } catch (error) {
    replayError = error;
  }
  assert.equal(replayCalls, 0);
  assert.notEqual(replayError, undefined);
  assert.equal(replayError.message, firstError.message);
});

// ---------------------------------------------------------------------------
// Identity fails closed.
// ---------------------------------------------------------------------------

test("resume with a changed definition or input fails closed", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runId = "ticket-5";
  const controller = new AbortController();
  let crash = true;
  const defined = pollingAgent("durable-identity", () => {
    if (crash) {
      controller.abort(new Error("crash"));
      return new Promise(() => {});
    }
    return "polled";
  });
  const iterator = stream(defined, "original input", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    signal: controller.signal,
    streamFn: (selected) => pushMessage(
      selected,
      [{ type: "toolCall", id: "p1", name: "poll", arguments: {} }],
      "toolUse",
      usage(),
    ),
  });
  for await (const _event of iterator) { /* drain */ }

  const changedDefinition = agent({
    id: "durable-identity",
    instructions: "Different brain entirely.",
    model: auto(),
    sandbox: "fixture",
  });
  await assert.rejects(
    run(changedDefinition, "original input", {
      ensureRuntime: false,
      model: fauxModel(),
      durable: { runId, store },
      streamFn: () => { throw new Error("must not be called"); },
    }),
    /cave_durable_definition_changed/,
  );
  await assert.rejects(
    run(defined, "different input", {
      ensureRuntime: false,
      model: fauxModel(),
      durable: { runId, store },
      streamFn: () => { throw new Error("must not be called"); },
    }),
    /cave_durable_input_mismatch/,
  );
  await assert.rejects(
    run(defined, "original input", {
      ensureRuntime: false,
      model: fauxModel(),
      durable: { runId, store },
      budget: { maxTokens: 5_000 },
      streamFn: () => { throw new Error("must not be called"); },
    }),
    /cave_durable_budget_changed/,
  );
});

// ---------------------------------------------------------------------------
// Option guards and the lock.
// ---------------------------------------------------------------------------

test("durable option combinations fail closed before any spend", async () => {
  const defined = pollingAgent("durable-guards");
  const base = {
    ensureRuntime: false,
    model: fauxModel(),
    streamFn: () => { throw new Error("must not be called"); },
  };
  await assert.rejects(
    run(defined, "go", { ...base, durable: { runId: "bad id with spaces" } }),
    /cave_durable_run_id_invalid/,
  );
  const { createConversation } = await import("../dist/index.js");
  await assert.rejects(
    run(defined, "go", {
      ...base,
      durable: { runId: "ok-1" },
      conversation: createConversation(),
    }),
    /cave_durable_conversation_unsupported/,
  );
  await assert.rejects(
    run(defined, "go", { ...base, durable: { runId: "ok-2" }, maxCostUsd: 5 }),
    /cave_durable_max_cost_usd_unsupported/,
  );
});

test("two processes cannot drive one durable run", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const release = await store.acquire("ticket-6");
  await assert.rejects(store.acquire("ticket-6"), /cave_durable_run_locked/);
  await release();
  const again = await store.acquire("ticket-6");
  await again();
});

// ---------------------------------------------------------------------------
// Subagent money events land in the root journal.
// ---------------------------------------------------------------------------

test("a subagent's settled calls journal through the root and restore on resume", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const child = agent({
    id: "durable-child",
    instructions: "Answer the delegated task.",
    model: "anthropic/claude-haiku-4-5",
    sandbox: "fixture",
  });
  const controller = new AbortController();
  const parent = agent({
    id: "durable-parent",
    instructions: "Delegate, then answer.",
    model: auto(),
    sandbox: "fixture",
    tools: [subagent({
      name: "delegate",
      description: "Delegate a task.",
      agent: child,
      maxCostUsd: 10,
    })],
  });
  const runId = "ticket-7";
  let call = 0;
  const iterator = stream(parent, "delegate this", {
    ensureRuntime: false,
    model: pricedFauxModel(),
    durable: { runId, store },
    signal: controller.signal,
    streamFn: (selected) => {
      call++;
      if (call === 1) {
        return pushMessage(
          selected,
          [{ type: "toolCall", id: "d1", name: "delegate", arguments: { task: "sub" } }],
          "toolUse",
          usage({ input: 500, output: 50 }),
        );
      }
      if (call === 2) {
        // The child's own provider call.
        return pushMessage(
          selected,
          [{ type: "text", text: "child answer" }],
          "stop",
          usage({ input: 400, output: 40 }),
        );
      }
      controller.abort(new Error("simulated crash"));
      throw new Error("simulated crash");
    },
  });
  for await (const _event of iterator) { /* drain */ }

  const lines = await journalLines(dir, runId);
  const settled = lines.filter((entry) => entry.type === "call_settled");
  assert.equal(settled.length, 2);
  assert.deepEqual(settled.map((entry) => entry.path).sort(), ["", "delegate"]);

  const result = await run(parent, "delegate this", {
    ensureRuntime: false,
    model: pricedFauxModel(),
    durable: { runId, store },
    streamFn: (selected) => pushMessage(
      selected,
      [{ type: "text", text: "final" }],
      "stop",
      usage({ input: 100, output: 10 }),
    ),
  });
  assert.equal(result.receipt.resume.priorCalls, 2);
  // Root call (550) + child call (440) both restore into the logical totals.
  assert.equal(result.inputTokens, 500 + 400 + 100);
  assertSharedReceiptContract(result.receipt);
});

// ---------------------------------------------------------------------------
// analyzeJournal: reconstruction and fail-closed validation (review findings
// 3/11/14 — journaled money is validated, never trusted).
// ---------------------------------------------------------------------------

const { analyzeJournal, DURABLE_JOURNAL_VERSION } = await import("../dist/durable.js");

const IDENTITY = {
  runId: "u1",
  definitionSha256: "d",
  input: "i",
  denomination: "none",
  budgetMax: undefined,
  budgetSha256: "none",
};

function line(event) {
  return JSON.stringify({ v: DURABLE_JOURNAL_VERSION, at: "2026-08-15T00:00:00.000Z", ...event });
}

function startedLine(overrides = {}) {
  return line({
    type: "run_started",
    runId: "u1",
    agentId: "a",
    definitionSha256: "d",
    input: "i",
    sessionId: "s",
    denomination: "none",
    budgetMax: undefined,
    budgetSha256: "none",
    pid: 1,
    ...overrides,
  });
}

function settledLine(overrides = {}) {
  return line({
    type: "call_settled",
    path: "",
    kind: "model",
    call: {
      provider: "anthropic",
      model: "m",
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      estimatedUsd: 0.01,
      unpriced: false,
      usageBasis: "provider_reported",
      ...overrides,
    },
  });
}

test("analyzeJournal fails closed on malformed journaled money", () => {
  assert.throws(
    () => analyzeJournal([startedLine(), settledLine({ estimatedUsd: "12" })], IDENTITY),
    /cave_durable_journal_corrupt/,
  );
  assert.throws(
    () => analyzeJournal([startedLine(), settledLine({ inputTokens: -5 })], IDENTITY),
    /cave_durable_journal_corrupt/,
  );
  assert.throws(
    () => analyzeJournal([startedLine(), line({ type: "turn", messages: "oops" })], IDENTITY),
    /cave_durable_journal_corrupt/,
  );
  assert.throws(
    () => analyzeJournal(
      [startedLine(), line({ type: "run_completed", result: { runId: "u1", costUsd: "lots" } })],
      IDENTITY,
    ),
    /cave_durable_journal_corrupt/,
  );
});

test("analyzeJournal fails closed on a changed budget contract digest", () => {
  assert.throws(
    () => analyzeJournal([startedLine({ budgetSha256: "other" })], IDENTITY),
    /cave_durable_budget_changed/,
  );
});

test("a snapshot resets the reconstruction and later turns append to it", () => {
  const state = analyzeJournal([
    startedLine(),
    line({ type: "turn", messages: [{ role: "user" }, { role: "assistant" }, { role: "toolResult" }] }),
    line({ type: "snapshot", messages: [{ role: "user", note: "compacted" }] }),
    line({ type: "turn", messages: [{ role: "assistant" }, { role: "toolResult", note: "after" }] }),
  ], IDENTITY);
  assert.equal(state.status, "pending");
  assert.deepEqual(
    state.resume.messages.map((message) => message.role),
    ["user", "assistant", "toolResult"],
  );
  assert.equal(state.resume.messages[0].note, "compacted");
  assert.equal(state.resume.messages.at(-1).note, "after");
});

test("double resume accumulates attempts and unmatched intents", () => {
  const intent = line({ type: "call_started", path: "", kind: "model", provider: "p", model: "m" });
  const state = analyzeJournal([
    startedLine(),
    intent,
    line({ type: "resumed", attempt: 2, unmatchedIntents: 1, pid: 2 }),
    intent,
  ], IDENTITY);
  assert.equal(state.status, "pending");
  assert.equal(state.resume.attempts, 2);
  assert.equal(state.resume.possibleDoubleCountCalls, 2);
});

test("abandoned intents consume no call ceiling and no double-count", () => {
  const state = analyzeJournal([
    startedLine(),
    line({ type: "call_started", path: "", kind: "model", provider: "p", model: "m" }),
    line({ type: "call_abandoned", path: "" }),
  ], IDENTITY);
  assert.equal(state.resume.priorRootModelCalls, 0);
  assert.equal(state.resume.possibleDoubleCountCalls, 0);
});

// ---------------------------------------------------------------------------
// The lock: single-winner stale takeover (review finding 2).
// ---------------------------------------------------------------------------

test("stale-lock takeover has exactly one winner", async (t) => {
  const { spawn } = await import("node:child_process");
  const { mkdir: mkdirP, writeFile: writeFileP, readdir } = await import("node:fs/promises");
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A genuinely dead pid: spawn a process and wait for it to exit.
  const deadPid = await new Promise((done) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.once("exit", () => done(child.pid));
  });
  // Plant the stale lock where the store expects it (digest-suffixed dir).
  await store.append("stale-1", "");
  const runDir = resolve(dir, (await readdir(dir)).find((name) => name.startsWith("stale-1")));
  await store.close("stale-1");
  const lockDir = resolve(runDir, "lock.d");
  await mkdirP(lockDir);
  await writeFileP(resolve(lockDir, "owner.json"), JSON.stringify({ pid: deadPid }));

  const attempts = await Promise.allSettled([
    store.acquire("stale-1"),
    store.acquire("stale-1"),
  ]);
  const winners = attempts.filter((entry) => entry.status === "fulfilled");
  const losers = attempts.filter((entry) => entry.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.match(losers[0].reason.message, /cave_durable_run_locked/);
  await winners[0].value();
});

// ---------------------------------------------------------------------------
// Cancelling at run_start releases the lock (review finding 5).
// ---------------------------------------------------------------------------

test("a consumer that cancels at run_start does not strand the lock", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const defined = pollingAgent("durable-cancel");
  const runId = "ticket-9";
  const iterator = stream(defined, "go", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    streamFn: () => { throw new Error("must not be called"); },
  });
  const first = await iterator.next();
  assert.equal(first.value.type, "run_start");
  await iterator.return();

  const result = await run(defined, "go", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    streamFn: (selected) => pushMessage(
      selected,
      [{ type: "text", text: "fresh" }],
      "stop",
      usage(),
    ),
  });
  assert.equal(result.text, "fresh");
});

// ---------------------------------------------------------------------------
// A journal that stops recording refuses to keep spending (review finding 7).
// ---------------------------------------------------------------------------

test("a failing store surfaces loudly instead of spending blind", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let appends = 0;
  const failing = {
    load: (runId) => store.load(runId),
    acquire: (runId) => store.acquire(runId),
    close: (runId) => store.close(runId),
    append: (runId, data) => {
      appends++;
      if (appends > 1) return Promise.reject(new Error("disk full"));
      return store.append(runId, data);
    },
  };
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.removeListener("unhandledRejection", onUnhandled));
  await assert.rejects(
    run(pollingAgent("durable-disk-full"), "go", {
      ensureRuntime: false,
      model: fauxModel(),
      durable: { runId: "ticket-10", store: failing },
      streamFn: (selected) => pushMessage(
        selected,
        [{ type: "toolCall", id: "p1", name: "poll", arguments: {} }],
        "toolUse",
        usage(),
      ),
    }),
  );
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(unhandled, []);
});

// ---------------------------------------------------------------------------
// Tranches journal and restore (review coverage gap 3).
// ---------------------------------------------------------------------------

test("released tranches survive a crash and fund the resumed run", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const defined = pollingAgent("durable-tranche");
  const runId = "ticket-11";
  const controller = new AbortController();
  let calls = 0;
  const iterator = stream(defined, "go", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    signal: controller.signal,
    budget: { maxTokens: 200_000, initialTokens: 1 },
    onBudgetExhausted: () => ({ release: 199_999, reason: "top-up" }),
    streamFn: (selected) => {
      calls++;
      if (calls === 1) {
        return pushMessage(
          selected,
          [{ type: "toolCall", id: "p1", name: "poll", arguments: {} }],
          "toolUse",
          usage({ input: 120, output: 15 }),
        );
      }
      controller.abort(new Error("simulated crash"));
      throw new Error("simulated crash");
    },
  });
  for await (const _event of iterator) { /* drain */ }

  const lines = await journalLines(dir, runId);
  const tranches = lines.filter((entry) => entry.type === "tranche");
  assert.equal(tranches.length, 1);
  assert.equal(tranches[0].amount, 199_999);

  const result = await run(defined, "go", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    budget: { maxTokens: 200_000, initialTokens: 1 },
    onBudgetExhausted: () => { throw new Error("must not re-escalate: the tranche is restored"); },
    streamFn: (selected) => pushMessage(
      selected,
      [{ type: "text", text: "done" }],
      "stop",
      usage({ input: 100, output: 10 }),
    ),
  });
  assert.equal(result.resumed, true);
  assert.equal(result.receipt.tranches.length, 1);
  assert.equal(result.receipt.tranches[0].amount, 199_999);
  // Prior settles include turn 1 (135) plus the crashed call's worst-case
  // settle (byte-derived, not a stable constant) — assert the relation, not
  // the hold: the resumed spend is exactly prior + this attempt's usage.
  assert.equal(result.receipt.resume.priorSettled >= 135, true);
  assert.equal(result.receipt.spent, result.receipt.resume.priorSettled + 110);
});
