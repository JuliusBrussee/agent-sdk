import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DiskDurableStore,
  agent,
  auto,
} from "../dist/index.js";
import { createAgentHandler } from "../dist/serve-handler.js";
import { createAgentServer } from "../dist/serve.js";
import { fauxProvider as upstreamFauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import WebSocket from "ws";

const TOKEN = "test-token-0123456789";
const execFileAsync = promisify(execFile);
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");

function fauxModel() {
  const handle = upstreamFauxProvider({ provider: "anthropic" });
  return { ...handle.getModel(), contextWindow: 200_000, maxTokens: 4_000 };
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

function pushMessage(selected, text, wait) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: usage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  void Promise.resolve(wait).then(() => {
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

function definition(id) {
  return agent({ id, instructions: "Remember every user message.", model: auto(), sandbox: "fixture" });
}

async function scratchStore() {
  const dir = await mkdtemp(resolve(tmpdir(), "cave-session-"));
  return { dir, store: new DiskDurableStore(dir) };
}

function request(path, init = {}) {
  return new Request(`https://agent.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
}

async function call(handler, path, init) {
  return handler.fetch(request(path, init));
}

async function createSession(handler, sessionId) {
  const response = await call(handler, "/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { sessionId });
}

async function send(handler, sessionId, text, options = {}) {
  const response = await call(handler, `/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, ...options }),
  });
  return { response, body: await response.json() };
}

async function sessionStatus(handler, sessionId) {
  const response = await call(handler, `/sessions/${sessionId}`);
  return { response, body: await response.json() };
}

async function idle(handler, sessionId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await sessionStatus(handler, sessionId);
    if (status.response.ok && status.body.active === undefined) return status.body;
    await new Promise((wake) => setTimeout(wake, 10));
  }
  throw new Error(`session ${sessionId} did not become idle`);
}

function makeHandler({ definition: selected, store, dir, streamFn }) {
  return createAgentHandler({
    definition: selected,
    token: TOKEN,
    store,
    rootDir: dir,
    runOptions: () => ({ ensureRuntime: false, model: fauxModel(), streamFn }),
  });
}

async function readTurns(response, turns) {
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  while (events.filter((event) => event.kind === "turn.end").length < turns) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      if (frame.startsWith(":")) continue;
      if (/^event: gap$/mu.test(frame)) throw new Error("unexpected SSE gap");
      const data = /^data: (.+)$/mu.exec(frame)?.[1];
      if (data !== undefined) events.push(JSON.parse(data));
    }
  }
  await reader.cancel();
  return events;
}

test("two session clients receive two consecutive runs", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const contexts = [];
  const handler = makeHandler({
    definition: definition("session-broadcast"),
    store,
    dir,
    streamFn: (selected, context) => {
      contexts.push(structuredClone(context.messages));
      return pushMessage(selected, `answer-${contexts.length}`);
    },
  });
  t.after(() => handler.close(1_000));
  await handler.recover();
  await createSession(handler, "shared");
  const clientOne = readTurns(await call(handler, "/sessions/shared/events"), 2);
  const clientTwo = readTurns(await call(handler, "/sessions/shared/events"), 2);

  assert.deepEqual((await send(handler, "shared", "first", { author: "ada" })).body, {
    runId: "shared.1", queued: false,
  });
  await idle(handler, "shared");
  assert.deepEqual((await send(handler, "shared", "second", { author: "lin" })).body, {
    runId: "shared.2", queued: false,
  });
  const [one, two] = await Promise.all([clientOne, clientTwo]);
  assert.deepEqual(one, two);
  assert.deepEqual(one.map((event) => event.seq), one.map((_, index) => index));
  assert.equal(one.filter((event) => event.kind === "turn.start").length, 2);
  assert.equal(one.filter((event) => event.kind === "turn.end").length, 2);
  assert.match(JSON.stringify(contexts[1]), /first/u);

  const status = (await sessionStatus(handler, "shared")).body;
  assert.deepEqual(status.runs.map((run) => run.runId), ["shared.1", "shared.2"]);
  assert.deepEqual(status.messages.map((message) => message.author), ["ada", "lin"]);
  assert.ok(one.every((event) => event.author === undefined));
});

test("active-run follow-up uses Pi queue and drains inside same run", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let release;
  const blocked = new Promise((resolveWait) => { release = resolveWait; });
  const contexts = [];
  const handler = makeHandler({
    definition: definition("session-follow-up"),
    store,
    dir,
    streamFn: (selected, context) => {
      contexts.push(structuredClone(context.messages));
      return pushMessage(selected, `call-${contexts.length}`, contexts.length === 1 ? blocked : undefined);
    },
  });
  t.after(() => handler.close(1_000));
  await handler.recover();
  await createSession(handler, "queued");
  assert.deepEqual((await send(handler, "queued", "start")).body, {
    runId: "queued.1", queued: false,
  });
  await new Promise((wake) => setTimeout(wake, 0));
  assert.deepEqual((await send(handler, "queued", "while active", { mode: "followUp" })).body, {
    runId: "queued.1", queued: true,
  });
  assert.equal((await sessionStatus(handler, "queued")).body.queued, 1);
  release();
  const done = await idle(handler, "queued");
  assert.equal(done.queued, 0);
  assert.equal(done.runs.length, 1);
  assert.equal(contexts.length, 2);
  assert.match(JSON.stringify(contexts[1]), /while active/u);
});

test("restart rehydrates checkpoint and third run sees prior messages", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const firstHandler = makeHandler({
    definition: definition("session-restart"),
    store,
    dir,
    streamFn: (selected) => pushMessage(selected, "remembered"),
  });
  await firstHandler.recover();
  await createSession(firstHandler, "restart");
  await send(firstHandler, "restart", "one");
  await idle(firstHandler, "restart");
  await send(firstHandler, "restart", "two");
  await idle(firstHandler, "restart");
  await firstHandler.close(1_000);

  const contexts = [];
  const restarted = makeHandler({
    definition: definition("session-restart"),
    store,
    dir,
    streamFn: (selected, context) => {
      contexts.push(structuredClone(context.messages));
      return pushMessage(selected, "third answer");
    },
  });
  t.after(() => restarted.close(1_000));
  await restarted.recover();
  assert.deepEqual((await send(restarted, "restart", "three")).body, {
    runId: "restart.3", queued: false,
  });
  await idle(restarted, "restart");
  assert.match(JSON.stringify(contexts[0]), /one/u);
  assert.match(JSON.stringify(contexts[0]), /two/u);
  assert.match(JSON.stringify(contexts[0]), /three/u);
});

test("missing terminal conversation checkpoint fails closed", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await store.append("broken.1", `${JSON.stringify({
    v: 2,
    at: new Date().toISOString(),
    type: "run_started",
    runId: "broken.1",
    agentId: "session-broken",
    definitionSha256: "a".repeat(64),
    input: "lost",
    sessionId: "broken",
    denomination: "none",
    budgetSha256: "none",
    pid: process.pid,
  })}\n`);
  const handler = makeHandler({
    definition: definition("session-broken"),
    store,
    dir,
    streamFn: () => { throw new Error("must not spend"); },
  });
  t.after(() => handler.close(1_000));
  await handler.recover();
  const status = await sessionStatus(handler, "broken");
  assert.equal(status.response.status, 409);
  assert.deepEqual(status.body, { error: "cave_session_conversation_unrecoverable" });
  const message = await send(handler, "broken", "must fail");
  assert.equal(message.response.status, 409);
  assert.equal(message.body.error, "cave_session_conversation_unrecoverable");
});

test("fetch handler serves sessions without importing node:http", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handler = makeHandler({
    definition: definition("session-fetch"),
    store,
    dir,
    streamFn: (selected) => pushMessage(selected, "ok"),
  });
  t.after(() => handler.close(1_000));
  await handler.recover();
  await createSession(handler, "fetch-only");
  assert.equal((await sessionStatus(handler, "fetch-only")).response.status, 200);

  const moduleUrl = pathToFileURL(resolve(DIST, "serve-handler.js")).href;
  const script = `
    const { createAgentHandler } = await import(${JSON.stringify(moduleUrl)});
    const journals = new Map();
    const store = {
      load: async (id) => journals.get(id) ?? [],
      append: async (id, data) => journals.set(id, [...(journals.get(id) ?? []), data]),
      acquire: async () => async () => {}, close: async () => {}, list: async () => [...journals.keys()],
    };
    const handler = createAgentHandler({
      definition: { id: "fetch-child", instructions: "unused", model: "auto", tools: [] },
      token: ${JSON.stringify(TOKEN)}, store,
    });
    const headers = { authorization: "Bearer ${TOKEN}", "content-type": "application/json" };
    const created = await handler.fetch(new Request("https://agent.test/sessions", {
      method: "POST", headers, body: JSON.stringify({ sessionId: "plain" }),
    }));
    const status = await handler.fetch(new Request("https://agent.test/sessions/plain", { headers }));
    if (created.status !== 201 || status.status !== 200) process.exit(2);
    if (process.moduleLoadList.includes("NativeModule node:http")) process.exit(3);
    await handler.close(0);
  `;
  const child = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script]);
  assert.equal(child.stderr, "");
});

test("Node WebSocket session path is bidirectional", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = createAgentServer({
    definition: definition("session-websocket"),
    token: TOKEN,
    store,
    rootDir: dir,
    runOptions: () => ({
      ensureRuntime: false,
      model: fauxModel(),
      streamFn: (selected) => pushMessage(selected, "over ws"),
    }),
  });
  t.after(() => server.close(1_000));
  const port = await server.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  const created = await fetch(`${base}/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "socket" }),
  });
  assert.equal(created.status, 201);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/sessions/socket/ws`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  t.after(() => socket.close());
  const events = [];
  await new Promise((resolveOpen, rejectOpen) => {
    socket.once("open", resolveOpen);
    socket.once("error", rejectOpen);
  });
  const ended = new Promise((resolveEnd, rejectEnd) => {
    socket.on("message", (raw) => {
      try {
        const event = JSON.parse(raw.toString("utf8"));
        events.push(event);
        if (event.kind === "turn.end") resolveEnd();
      } catch (error) { rejectEnd(error); }
    });
    socket.once("error", rejectEnd);
  });
  socket.send(JSON.stringify({ type: "message", text: "hello", author: "ws-user" }));
  await ended;
  assert.equal(events[0].kind, "turn.start");
  assert.equal(events.at(-1).kind, "turn.end");
  // The faux stream pushes one whole message, so no delta frames exist on any
  // transport; the proof of bidirectionality is that the message sent over the
  // socket started a run and was attributed.
  const status = await fetch(`${base}/sessions/socket`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.runs.length, 1);
  assert.equal(body.messages[0].author, "ws-user");
  assert.equal(body.messages[0].text, "hello");
});

test("Node upgrade fails closed when optional ws import is unavailable", async () => {
  const moduleUrl = pathToFileURL(resolve(DIST, "serve.js")).href;
  const script = `
    import { mock } from "node:test";
    mock.module("ws", { namedExports: {} });
    const { createAgentServer } = await import(${JSON.stringify(moduleUrl)});
    const started = JSON.stringify({
      v: 2, at: new Date().toISOString(), type: "run_started", runId: "missing.1",
      agentId: "ws-missing", definitionSha256: "a".repeat(64), input: "pending",
      sessionId: "missing", denomination: "none", budgetSha256: "none", pid: process.pid,
      conversation: {
        sessionId: "missing",
        messagesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        messages: [],
      },
    });
    const store = {
      load: async (id) => id === "missing.1" ? [started] : [],
      append: async () => {}, acquire: async () => async () => {}, close: async () => {},
      list: async () => ["missing.1"],
    };
    const server = createAgentServer({
      definition: { id: "ws-missing", instructions: "unused", model: "auto", tools: [] },
      token: ${JSON.stringify(TOKEN)}, store,
    });
    let output = "";
    let done;
    const ended = new Promise((resolve) => { done = resolve; });
    const socket = {
      end(value) { output += value; done(); },
      destroy() { done(); },
    };
    server.server.emit("upgrade", {
      headers: { host: "agent.test", authorization: "Bearer ${TOKEN}", upgrade: "websocket" },
      method: "GET", url: "/sessions/missing/ws",
    }, socket, Buffer.alloc(0));
    await ended;
    if (!output.includes("501") || !output.includes("cave_serve_websocket_unavailable")) process.exit(4);
    await server.close(0);
  `;
  await execFileAsync(process.execPath, [
    "--experimental-test-module-mocks",
    "--input-type=module",
    "--eval",
    script,
  ]);
});
