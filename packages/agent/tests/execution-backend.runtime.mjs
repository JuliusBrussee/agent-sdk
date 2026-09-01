import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxProvider as upstreamFauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createCodingAgent,
  runCodingTurn,
  startCodingSession,
} from "../dist/code.js";
import {
  httpExecutionBackend,
  localExecutionBackend,
} from "../dist/execution-backend.js";

const PRICED_MODEL = "claude-haiku-4-5";

function pricedFauxModel(overrides = {}) {
  const handle = upstreamFauxProvider({ provider: "anthropic" });
  return {
    ...handle.getModel(),
    id: PRICED_MODEL,
    contextWindow: 200_000,
    maxTokens: 4_000,
    ...overrides,
  };
}

function usage(fields = {}) {
  const input = fields.input ?? 10;
  const output = fields.output ?? 2;
  const cacheRead = fields.cacheRead ?? 0;
  const cacheWrite = fields.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: fields.reasoning ?? 0,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function pushMessage(selected, content, stopReason, used = usage()) {
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

function toolCall(id, name, args) {
  return { type: "toolCall", id, name, arguments: args };
}

function missing(path) {
  const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
  error.code = "ENOENT";
  return error;
}

function recordingBackend(initial = {}) {
  const calls = [];
  const files = new Map(Object.entries(initial).map(([path, text]) => [
    path,
    Buffer.from(text, "utf8"),
  ]));
  return {
    calls,
    files,
    backend: {
      id: "fixture",
      async exec(request) {
        calls.push({ operation: "exec", request });
        return {
          stdout: request.command === "rg" ? "source.txt:1:needle\n" : "backend bash\n",
          stderr: "",
          code: 0,
          timedOut: false,
          truncated: false,
        };
      },
      async readFile(path) {
        calls.push({ operation: "readFile", path });
        const value = files.get(path);
        if (value === undefined) throw missing(path);
        return value;
      },
      async writeFile(path, data) {
        calls.push({ operation: "writeFile", path, data: Buffer.from(data) });
        files.set(path, Buffer.from(data));
      },
    },
  };
}

function inProcessServerFetch(server) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const request = Readable.from(init.body === undefined ? [] : [Buffer.from(String(init.body))]);
    request.url = `${url.pathname}${url.search}`;
    request.headers = Object.fromEntries(new Headers(init.headers).entries());
    return await new Promise((accept, reject) => {
      const headers = new Headers();
      const response = {
        statusCode: 200,
        setHeader(name, value) {
          headers.set(name, String(value));
        },
        writeHead(status) {
          this.statusCode = status;
          return this;
        },
        end(body = "") {
          accept(new Response(body, { status: this.statusCode, headers }));
          return this;
        },
      };
      server.emit("request", request, response);
      request.once("error", reject);
    });
  };
}

test("non-local coding turn routes every workspace/process tool through backend only", async () => {
  const hostSentinel = resolve(tmpdir(), `cave-host-sentinel-${randomUUID()}`);
  const workspace = `/remote-workspace-${randomUUID()}`;
  const source = resolve(workspace, "source.txt");
  const created = resolve(workspace, "created.txt");
  const fixture = recordingBackend({ [source]: "needle old\n" });
  const coding = createCodingAgent({
    workspace,
    model: "anthropic/claude-haiku-4-5",
    executionBackend: fixture.backend,
  });
  const scripted = [
    [toolCall("read-1", "read_file", { path: "source.txt" })],
    [toolCall("write-1", "write_file", { path: "created.txt", content: "new\n" })],
    [toolCall("edit-1", "edit_file", {
      path: "source.txt",
      old_string: "old",
      new_string: "edited",
    })],
    [toolCall("grep-1", "grep", { pattern: "needle" })],
    [toolCall("bash-1", "bash", {
      command: `node -e 'require("fs").writeFileSync(${JSON.stringify(hostSentinel)},"bad")'`,
    })],
    [{ type: "text", text: "done" }],
  ];
  const session = await startCodingSession(coding, { cave: "off" });
  const result = await runCodingTurn(session, "exercise every effect", {
    model: pricedFauxModel(),
    streamFn(selected) {
      const content = scripted.shift();
      assert.notEqual(content, undefined);
      const stopReason = content.some((item) => item.type === "toolCall") ? "toolUse" : "stop";
      return pushMessage(selected, content, stopReason);
    },
  });
  assert.equal(result.text, "done");
  assert.deepEqual(result.toolCalls, ["read_file", "write_file", "edit_file", "grep", "bash"]);
  assert.equal(Buffer.from(fixture.files.get(source)).toString("utf8"), "needle edited\n");
  assert.equal(Buffer.from(fixture.files.get(created)).toString("utf8"), "new\n");
  assert.deepEqual(
    new Set(fixture.calls.map((call) => call.operation)),
    new Set(["exec", "readFile", "writeFile"]),
  );
  assert.deepEqual(
    fixture.calls.filter((call) => call.operation === "exec").map((call) => call.request.command),
    ["rg", "sh"],
  );
  assert.equal(fixture.calls.filter((call) => call.operation === "readFile").length, 3);
  assert.equal(fixture.calls.filter((call) => call.operation === "writeFile").length, 2);
  await assert.rejects(() => access(workspace), /ENOENT/);
  await assert.rejects(() => access(hostSentinel), /ENOENT/);
  await coding.close();
});

test("non-local backend refuses explicitly configured command sessions at construction", () => {
  const fixture = recordingBackend();
  assert.throws(
    () => createCodingAgent({
      workspace: "/remote",
      model: "anthropic/claude-haiku-4-5",
      executionBackend: fixture.backend,
      commandSessions: true,
    }),
    /cave_execution_backend_command_sessions_local_only/,
  );
});

test("http backend round-trips exec/read/write, enforces bearer auth, and caps output", async () => {
  const files = new Map([["/workspace/input.txt", Buffer.from("hello")]]);
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const input = JSON.parse(Buffer.concat(body).toString("utf8") || "{}");
    requests.push({ url: request.url, authorization: request.headers.authorization, input });
    if (request.headers.authorization !== "Bearer correct-token") {
      response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/exec") {
      response.end(JSON.stringify({
        stdout: "123456789",
        stderr: "stderr-must-be-cut",
        code: 0,
        timedOut: false,
        truncated: false,
      }));
      return;
    }
    if (request.url === "/read") {
      const data = files.get(input.path);
      if (data === undefined) {
        response.writeHead(404).end(JSON.stringify({ error: "missing" }));
        return;
      }
      response.end(JSON.stringify({ data: data.toString("base64") }));
      return;
    }
    if (request.url === "/write") {
      files.set(input.path, Buffer.from(input.data, "base64"));
      response.end("{}");
      return;
    }
    response.writeHead(404).end("{}");
  });
  const fetch = inProcessServerFetch(server);
  try {
    const url = "http://execution-backend.fixture";
    const backend = httpExecutionBackend({ url, token: "correct-token", fetch });
    const read = await backend.readFile("/workspace/input.txt");
    assert.equal(Buffer.from(read).toString("utf8"), "hello");
    await backend.writeFile("/workspace/output.txt", Buffer.from("written"));
    assert.equal(files.get("/workspace/output.txt").toString("utf8"), "written");
    const exec = await backend.exec({
      command: "printf",
      args: ["123456789"],
      cwd: "/workspace",
      env: { PATH: "/usr/bin" },
      timeoutMs: 1_000,
      maxOutputBytes: 4,
    });
    assert.deepEqual(exec, {
      stdout: "1234",
      stderr: "",
      code: 0,
      timedOut: false,
      truncated: true,
    });
    assert.deepEqual(requests.at(-1).input, {
      command: "printf",
      args: ["123456789"],
      cwd: "/workspace",
      env: { PATH: "/usr/bin" },
      timeoutMs: 1_000,
      maxOutputBytes: 4,
    });
    const unauthorized = httpExecutionBackend({ url, token: "wrong-token", fetch });
    await assert.rejects(
      () => unauthorized.readFile("/workspace/input.txt"),
      /cave_execution_backend_http_read_failed:401/,
    );
  } finally {
    server.close();
  }
});

test("explicit local backend is byte-identical to default coding tool behavior", async () => {
  const defaultWorkspace = await mkdtemp(resolve(tmpdir(), "cave-exec-default-"));
  const explicitWorkspace = await mkdtemp(resolve(tmpdir(), "cave-exec-explicit-"));
  try {
    await Promise.all([
      writeFile(resolve(defaultWorkspace, "source.txt"), "needle old\n", "utf8"),
      writeFile(resolve(explicitWorkspace, "source.txt"), "needle old\n", "utf8"),
    ]);
    const defaultAgent = createCodingAgent({
      workspace: defaultWorkspace,
      model: "anthropic/claude-haiku-4-5",
    });
    const explicitAgent = createCodingAgent({
      workspace: explicitWorkspace,
      model: "anthropic/claude-haiku-4-5",
      executionBackend: localExecutionBackend(),
    });
    const defaults = Object.fromEntries(defaultAgent.definition.tools.map((tool) => [tool.name, tool]));
    const explicit = Object.fromEntries(explicitAgent.definition.tools.map((tool) => [tool.name, tool]));
    const calls = [
      ["read_file", { path: "source.txt" }],
      ["write_file", { path: "created.txt", content: "created\n" }],
      ["edit_file", { path: "source.txt", old_string: "old", new_string: "edited" }],
      ["grep", { pattern: "needle", path: "source.txt" }],
      ["bash", { command: "printf local-output" }],
    ];
    for (const [name, input] of calls) {
      assert.equal(await explicit[name].execute(input), await defaults[name].execute(input), name);
    }
    assert.equal(
      await readFile(resolve(explicitWorkspace, "source.txt"), "utf8"),
      await readFile(resolve(defaultWorkspace, "source.txt"), "utf8"),
    );
    await Promise.all([defaultAgent.close(), explicitAgent.close()]);
  } finally {
    await Promise.all([
      rm(defaultWorkspace, { recursive: true, force: true }),
      rm(explicitWorkspace, { recursive: true, force: true }),
    ]);
  }
});
