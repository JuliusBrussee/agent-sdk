import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage as upstreamFauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  agent,
  compareConnectEfficiency,
  connectEnvironment,
  ConnectRuntime,
  createConnect,
  executeConnectTool,
  run,
  schema,
} from "../dist/index.js";

function fauxAssistantMessage(...args) {
  const message = upstreamFauxAssistantMessage(...args);
  return {
    ...message,
    usage: { ...message.usage, reasoning: message.usage.reasoning ?? 0 },
  };
}

function withReportedReasoning(source) {
  const output = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    for await (const event of source) {
      const patch = event.partial === undefined
        ? {}
        : { partial: { ...event.partial, usage: { ...event.partial.usage, reasoning: event.partial.usage?.reasoning ?? 0 } } };
      if (event.type === "done") {
        output.push({
          ...event,
          ...patch,
          message: { ...event.message, usage: { ...event.message.usage, reasoning: event.message.usage.reasoning ?? 0 } },
        });
      } else if (event.type === "error") {
        output.push({ ...event, ...patch, error: event.error });
      } else {
        output.push({ ...event, ...patch });
      }
    }
  });
  return output;
}

async function fakeConnectBinary(root) {
  const path = join(root, "cave-connectd");
  await writeFile(path, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "providers") {
  process.stdout.write(JSON.stringify({ ok: true, providers: [] }) + "\\n");
  process.exit(0);
}
if (args[0] !== "mcp") process.exit(7);
const requests = readFileSync(0, "utf8").trim().split("\\n").map(JSON.parse);
const request = requests.find((item) => item.id === 2);
if (request?.method === "tools/list") {
  const cursor = request.params?.cursor;
  const result = cursor === "tools-page-2"
    ? {
        tools: [{
          name: "caveman_records_list",
          description: "List exact connected records.",
          inputSchema: { type: "object", properties: { model: { type: "string" } } },
        }],
      }
    : {
        tools: [{
          name: "caveman_connection_list",
          title: "List connections",
          description: "List configured connections.",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { provider: { type: "string" } },
          },
          outputSchema: { type: "object", properties: { data: { type: "array" } } },
          annotations: { readOnlyHint: true, openWorldHint: false },
          execution: { taskSupport: "forbidden" },
          icons: [{ src: "data:image/png;base64,AA==", mimeType: "image/png", sizes: ["16x16"], theme: "dark" }],
          _meta: { provider: { owned_by: "cave-connectd" } },
        }],
        nextCursor: "tools-page-2",
      };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\\n");
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result }) + "\\n");
  process.exit(0);
}
const name = request?.params?.name;
const input = request?.params?.arguments ?? {};
let data;
if (name === "caveman_connection_list") {
  data = { data: [{
    provider_config_key: "github",
    connection_id: "github-work",
    auth_mode: "OAUTH2",
    status: "connected",
    credentials: { access_token: "must-not-surface" },
  }] };
} else if (name === "caveman_records_list") {
  data = input.cursor === "page-2"
    ? { records: [{ id: "2", title: "second" }], next_cursor: null }
    : { records: [{ id: "1", title: "first" }], next_cursor: "page-2" };
} else if (name === "caveman_sync_trigger") {
  data = { run_id: "7", status: "queued", sync: input.sync };
} else if (name === "caveman_sync_status") {
  data = { run_id: input.run_id, status: "succeeded" };
} else if (name === "caveman_sync_search") {
  data = { syncs: [{ name: "issues", models: ["Issue"] }], next_offset: null };
} else if (name === "caveman_tool_search") {
  data = { tools: [{ name: "get-issue" }], next_offset: null };
} else if (name === "caveman_tool_call") {
  data = { ok: true, action: input.action };
} else {
  process.exit(8);
}
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\\n");
process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data },
}) + "\\n");
`, "utf8");
  await chmod(path, 0o700);
  return path;
}

function listToolsExecutor(page, duplicateResponse = false) {
  return async (_binary, args, options) => {
    if (args[0] === "providers") {
      return { exitCode: 0, stdout: '{"ok":true}\n', stderr: "" };
    }
    assert.deepEqual(args, ["mcp"]);
    const requests = options.input.trim().split("\n").map(JSON.parse);
    const request = requests.find((item) => item.id === 2);
    assert.equal(request.method, "tools/list");
    const result = page(request.params?.cursor);
    const response = JSON.stringify({ jsonrpc: "2.0", id: 2, result });
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n${response}\n${duplicateResponse ? `${response}\n` : ""}`,
      stderr: "",
    };
  };
}

function minimalMcpTool(name, extra = {}) {
  return { name, inputSchema: { type: "object" }, ...extra };
}

test("Connect child environment excludes provider credentials and daemon Bearer", () => {
  assert.deepEqual(connectEnvironment({
    HOME: "/tmp/home",
    PATH: "/bin",
    OPENAI_API_KEY: "provider-secret",
    CAVE_CONNECT_SECRET_KEY: "daemon-secret",
    CAVE_CONNECT_DATA_DIR: "/tmp/connect",
  }), {
    HOME: "/tmp/home",
    PATH: "/bin",
    CAVE_CONNECT_DATA_DIR: "/tmp/connect",
  });
});

test("Connect CLI maps bare provider to connect command", async () => {
  const root = await mkdtemp(join(tmpdir(), "cave-connect-map-"));
  try {
    const binary = await fakeConnectBinary(root);
    const calls = [];
    const runtime = new ConnectRuntime({
      binary,
      execute: async (_binary, args, options) => {
        calls.push({ args, options });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(await runtime.delegate(["github"]), 0);
    assert.deepEqual(calls[0].args, ["connect", "github"]);
    assert.equal(calls[0].options.capture, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Connect runtime lists exact paginated MCP tools as detached frozen data", async () => {
  const root = await mkdtemp(join(tmpdir(), "cave-connect-tools-"));
  try {
    const binary = await fakeConnectBinary(root);
    const runtime = new ConnectRuntime({ binary });
    const tools = await runtime.listTools();
    assert.deepEqual(tools.map((entry) => entry.name), [
      "caveman_connection_list",
      "caveman_records_list",
    ]);
    assert.equal(tools[0].inputSchema.type, "object");
    assert.equal(tools[0].annotations.readOnlyHint, true);
    assert.equal(tools[0].execution.taskSupport, "forbidden");
    assert.equal(tools[0].icons[0].theme, "dark");
    assert.equal(tools[0]._meta.provider.owned_by, "cave-connectd");
    assert.equal(Object.getPrototypeOf(tools[0].inputSchema), null);
    assert.equal(Object.isFrozen(tools), true);
    assert.equal(Object.isFrozen(tools[0]), true);
    assert.equal(Object.isFrozen(tools[0].inputSchema.properties), true);
    assert.equal(Object.isFrozen(tools[0]._meta.provider), true);
    assert.throws(() => {
      tools[0].inputSchema.properties.provider.type = "number";
    }, TypeError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Connect runtime projects frozen credential-free connection metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "cave-connect-connections-"));
  try {
    const binary = await fakeConnectBinary(root);
    const connections = await new ConnectRuntime({ binary }).connections();
    assert.deepEqual(connections, [{
      connectionId: "github-work",
      provider: "github",
      authMode: "OAUTH2",
      status: "connected",
    }]);
    assert.equal(Object.isFrozen(connections), true);
    assert.equal(Object.isFrozen(connections[0]), true);
    assert.equal("credentials" in connections[0], false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Connect runtime rejects malformed, duplicate, cyclic, and duplicate-response tool lists", async () => {
  const root = await mkdtemp(join(tmpdir(), "cave-connect-tools-invalid-"));
  try {
    const binary = await fakeConnectBinary(root);
    await assert.rejects(
      new ConnectRuntime({
        binary,
        execute: listToolsExecutor(() => ({ tools: [{ name: "broken" }] })),
      }).listTools(),
      /cave_connect_mcp_tool_list_invalid/,
    );

    await assert.rejects(
      new ConnectRuntime({
        binary,
        execute: listToolsExecutor((cursor) => cursor === undefined
          ? { tools: [minimalMcpTool("same")], nextCursor: "again" }
          : { tools: [minimalMcpTool("same")] }),
      }).listTools(),
      /cave_connect_mcp_tool_list_duplicate:same/,
    );

    await assert.rejects(
      new ConnectRuntime({
        binary,
        execute: listToolsExecutor(() => ({ tools: [], nextCursor: "same-cursor" })),
      }).listTools(),
      /cave_connect_mcp_tool_list_cursor_cycle/,
    );

    await assert.rejects(
      new ConnectRuntime({
        binary,
        execute: listToolsExecutor(() => ({ tools: [] }), true),
      }).listTools(),
      /cave_connect_mcp_response_duplicate:2/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Connect runtime bounds MCP tool discovery pages, count, and aggregate bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cave-connect-tools-limits-"));
  try {
    const binary = await fakeConnectBinary(root);
    let page = 0;
    await assert.rejects(
      new ConnectRuntime({
        binary,
        execute: listToolsExecutor(() => ({
          tools: [],
          nextCursor: `cursor-${++page}`,
        })),
      }).listTools(),
      /cave_connect_mcp_tool_list_page_limit/,
    );
    assert.equal(page, 32);

    await assert.rejects(
      new ConnectRuntime({
        binary,
        execute: listToolsExecutor(() => ({
          tools: Array.from({ length: 1_025 }, (_, index) => minimalMcpTool(`tool_${index}`)),
        })),
      }).listTools(),
      /cave_connect_mcp_tool_list_count_limit/,
    );

    await assert.rejects(
      new ConnectRuntime({
        binary,
        execute: listToolsExecutor(() => ({
          tools: [minimalMcpTool("large", { description: "x".repeat(1024 * 1024) })],
        })),
      }).listTools(),
      /cave_connect_mcp_tool_list_byte_limit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Connect source allowlist paginates exact records and exposes incompleteness", async () => {
  const root = await mkdtemp(join(tmpdir(), "cave-connect-test-"));
  try {
    const binary = await fakeConnectBinary(root);
    const complete = createConnect({
      binary,
      sources: [{
        id: "work-github",
        provider: "github",
        collect: ["issues"],
        models: ["Issue"],
        actions: ["get-issue"],
      }],
      quality: { maxPages: 2, maxRecords: 10 },
    });
    const runtime = complete.tool.runtime;
    assert.equal(runtime.kind, "caveman-connect");
    const records = await executeConnectTool(runtime, {
      operation: "records",
      source: "work-github",
      model: "Issue",
      limit: 10,
    });
    assert.deepEqual(records.records.map((item) => item.id), ["1", "2"]);
    assert.equal(records.complete, true);
    assert.equal(records.must_refuse, false);

    const capped = createConnect({
      binary,
      sources: [{ id: "work-github", provider: "github", models: ["Issue"] }],
      quality: { maxPages: 1, maxRecords: 10 },
    });
    const partial = await executeConnectTool(capped.tool.runtime, {
      operation: "records",
      source: "work-github",
      model: "Issue",
      limit: 10,
    });
    assert.equal(partial.complete, false);
    assert.equal(partial.must_refuse, true);
    assert.equal(partial.next_cursor, "page-2");
    assert.equal(partial.capped_by, "pages");

    await assert.rejects(
      executeConnectTool(runtime, {
        operation: "call_action",
        source: "work-github",
        action: "delete-repository",
        input: {},
      }),
      /cave_connect_action_not_allowed/,
    );
    assert.deepEqual(await complete.collect("work-github"), [
      { run_id: "7", status: "queued", sync: "issues" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Connect runtime tool works under required sandbox without host execution", async () => {
  const integration = createConnect({
    binary: "/absolute/not-used-for-sources-operation",
    sources: [{ id: "github", provider: "github" }],
  });
  const definition = agent({
    id: "connect-required",
    instructions: "List configured sources, then answer done.",
    model: "anthropic/faux-1",
    tools: [integration.tool],
    sandbox: "required",
  });
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("connected_data", { operation: "sources" }, { id: "connect-1" })),
    fauxAssistantMessage("done"),
  ]);
  const result = await run(definition, "Which sources exist?", {
    ensureRuntime: false,
    model: faux.getModel(),
    streamFn: (...args) => withReportedReasoning(faux.provider.streamSimple(...args)),
  });
  assert.equal(result.text, "done");
  assert.deepEqual(result.toolCalls, ["connected_data"]);
});

test("Connect special runtime cannot bypass declared output validation", async () => {
  const integration = createConnect({
    binary: "/absolute/not-used-for-sources-operation",
    sources: [{ id: "github", provider: "github" }],
  });
  const constrained = Object.freeze(Object.create(
    Object.getPrototypeOf(integration.tool),
    {
      ...Object.getOwnPropertyDescriptors(integration.tool),
      output: { value: schema.string(), enumerable: true },
    },
  ));
  const definition = agent({
    id: "connect-output-contract",
    instructions: "List configured sources, then recover from tool error.",
    model: "anthropic/faux-1",
    tools: [constrained],
    sandbox: "required",
  });
  const faux = fauxProvider();
  let observed = "";
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("connected_data", { operation: "sources" }, { id: "connect-output-1" })),
    (context) => {
      observed = JSON.stringify(context.messages);
      return fauxAssistantMessage("done");
    },
  ]);
  const result = await run(definition, "Which sources exist?", {
    ensureRuntime: false,
    model: faux.getModel(),
    streamFn: (...args) => withReportedReasoning(faux.provider.streamSimple(...args)),
  });
  assert.equal(result.text, "done");
  assert.match(observed, /cave_tool_output_schema_mismatch:connected_data/);
  assert.doesNotMatch(observed, /provider_config_key|connection_id/);
});

test("Connect efficiency gate rejects cheaper incomplete or lower-quality runs", () => {
  const baseline = {
    taskSuccess: true,
    quality: 1,
    providerCostUsd: 0.10,
    providerInputTokens: 10_000,
    providerOutputTokens: 500,
    retries: 0,
    retrievalCalls: 0,
    retrievalCostUsd: 0,
    collectionCostUsd: 0,
    completeData: true,
  };
  const accepted = compareConnectEfficiency(baseline, {
    ...baseline,
    providerCostUsd: 0.05,
    providerInputTokens: 4_000,
    retrievalCalls: 2,
    retrievalCostUsd: 0.01,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.costDeltaUsd, -0.04);
  assert.equal(accepted.evidence, "inferred");

  const rejected = compareConnectEfficiency(baseline, {
    ...baseline,
    quality: 0.8,
    providerCostUsd: 0.01,
    providerInputTokens: 1_000,
    completeData: false,
  });
  assert.equal(rejected.accepted, false);
  assert.deepEqual(rejected.reasons, ["connected_data_incomplete", "quality_regressed"]);
});
