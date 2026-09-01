import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { agent, run, schema, tool } from "../dist/index.js";
import { fauxModel, scriptedStream } from "../dist/testing.js";

const run_ = promisify(execFile);
const dist = pathToFileURL(resolve(fileURLToPath(new URL("../dist/", import.meta.url)), "index.js")).href;
const distTesting = dist.replace(/index\.js$/, "testing.js");

function peekAgent(id, extra = {}) {
  return agent({
    id,
    instructions: "Use the tool, then answer.",
    model: "anthropic/claude-haiku-4-5",
    tools: [tool({
      name: "peek",
      description: "Peek at nothing.",
      input: schema.object({}),
      effect: "read",
      execute: () => "peeked",
    })],
    ...extra,
  });
}

const script = (body) => [
  `const { agent, auto, run, schema, tool } = await import(${JSON.stringify(dist)});`,
  `const { fauxModel, scriptedStream } = await import(${JSON.stringify(distTesting)});`,
  body,
].join("\n");

// ---------------------------------------------------------------------------
// Default 1 — a definition that never named a sandbox runs on the host, loudly.
// ---------------------------------------------------------------------------

test("an undeclared sandbox runs on the host and says so exactly once", async () => {
  const { stdout, stderr } = await run_(process.execPath, ["--input-type=module", "-e", script(`
    const build = (id) => agent({
      id,
      instructions: "Answer.",
      model: "anthropic/claude-haiku-4-5",
      tools: [tool({
        name: "peek",
        description: "Peek at nothing.",
        input: schema.object({}),
        effect: "read",
        execute: () => "peeked",
      })],
    });
    for (const id of ["host-default-one", "host-default-two"]) {
      const result = await run(build(id), "go", {
        ensureRuntime: false,
        model: fauxModel(),
        streamFn: scriptedStream([
          { toolCalls: [{ name: "peek", args: {} }] },
          { text: "answered" },
        ]),
      });
      process.stdout.write(result.text + "\\n");
    }
  `)]);
  assert.deepEqual(stdout.trim().split("\n"), ["answered", "answered"]);
  const warnings = stderr.split("\n").filter((line) =>
    /^cave: \S+ host execution — tools are not isolated$/.test(line));
  // Once per definition, not once per run and not once per process: a server
  // driving several definitions has to hear it for each of them.
  assert.deepEqual(warnings, [
    "cave: host-default-one host execution — tools are not isolated",
    "cave: host-default-two host execution — tools are not isolated",
  ]);
});

test("the host announcement repeats per definition but not per run", async () => {
  const { stdout, stderr } = await run_(process.execPath, ["--input-type=module", "-e", script(`
    const defined = agent({
      id: "host-default-repeat",
      instructions: "Answer.",
      model: "anthropic/claude-haiku-4-5",
    });
    for (let i = 0; i < 2; i += 1) {
      const result = await run(defined, "go", {
        ensureRuntime: false,
        model: fauxModel(),
        streamFn: scriptedStream([{ text: "answered" }]),
      });
      process.stdout.write(result.text + "\\n");
    }
  `)]);
  assert.deepEqual(stdout.trim().split("\n"), ["answered", "answered"]);
  const warnings = stderr.split("\n").filter((line) =>
    line === "cave: host-default-repeat host execution — tools are not isolated");
  assert.equal(warnings.length, 1);
});

test("an explicitly required sandbox still fails closed without an entryPath", async () => {
  await assert.rejects(
    run(peekAgent("declared-required", { sandbox: "required" }), "go", {
      ensureRuntime: false,
      model: fauxModel(),
      streamFn: scriptedStream([{ text: "must not run" }]),
    }),
    /cave_tool_sandbox_entry_required/,
  );
});

// ---------------------------------------------------------------------------
// Default 2 — auto() with several credentials picks one and names CAVE_MODEL.
// ---------------------------------------------------------------------------

test("auto() with several credentials picks anthropic and names CAVE_MODEL", async () => {
  const { stdout, stderr } = await run_(process.execPath, ["--input-type=module", "-e", script(`
    const defined = agent({
      id: "auto-ambiguous",
      instructions: "Answer.",
      model: auto(),
      sandbox: "fixture",
    });
    const result = await run(defined, "go", {
      ensureRuntime: false,
      streamFn: (selected, context, options) => {
        process.stdout.write(selected.provider + "/" + selected.id + "\\n");
        return scriptedStream([{ text: "answered" }])(selected, context, options);
      },
    });
    process.stdout.write(result.text + "\\n");
  `)], {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "test-anthropic",
      OPENAI_API_KEY: "test-openai",
      GEMINI_API_KEY: "test-gemini",
      CAVE_MODEL: "",
    },
  });
  assert.deepEqual(stdout.trim().split("\n"), ["anthropic/claude-haiku-4-5", "answered"]);
  assert.equal(
    stderr.includes("cave: multiple provider credentials found — using anthropic/claude-haiku-4-5"),
    true,
    stderr,
  );
  assert.equal(stderr.includes("set CAVE_MODEL"), true, stderr);
});

test("auto() with no credential at all still throws", async () => {
  const cleared = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "CAVE_MODEL"];
  const previous = Object.fromEntries(cleared.map((name) => [name, process.env[name]]));
  for (const name of cleared) delete process.env[name];
  try {
    await assert.rejects(
      run(agent({ id: "auto-empty", instructions: "Answer.", model: (await import("../dist/index.js")).auto(), sandbox: "fixture" }), "go", {
        ensureRuntime: false,
        streamFn: scriptedStream([{ text: "must not run" }]),
      }),
      /no supported provider credential found/,
    );
  } finally {
    for (const name of cleared) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

// ---------------------------------------------------------------------------
// Honesty 1 — `ensureRuntime: false` on a loopback URL is probed, not assumed.
// ---------------------------------------------------------------------------

function routeCapture() {
  const selected = [];
  return {
    selected,
    streamFn: (model, context, options) => {
      selected.push(model);
      return scriptedStream([{ text: "answered" }])(model, context, options);
    },
  };
}

test("an unreachable loopback gateway degrades to observe-only instead of being assumed up", async () => {
  const capture = routeCapture();
  const native = fauxModel().baseUrl;
  const asked = [];
  const result = await run(peekAgent("healthz-down", { sandbox: "fixture" }), "go", {
    ensureRuntime: false,
    gatewayURL: "http://127.0.0.1:8787",
    fetch: async (url) => {
      asked.push(String(url));
      return new Response(null, { status: 503 });
    },
    model: fauxModel(),
    streamFn: capture.streamFn,
  });
  assert.equal(asked.some((url) => url.endsWith("/healthz")), true);
  assert.equal(result.mode, "observe-only");
  // Never routed: the request kept the provider's own base URL.
  assert.equal(capture.selected[0].baseUrl, native);
});

// ---------------------------------------------------------------------------
// Honesty 2 — a caller-supplied streamFn can never be reported as optimized.
// ---------------------------------------------------------------------------

test("a reachable gateway plus a caller streamFn is routed but never optimized", async () => {
  const capture = routeCapture();
  const result = await run(peekAgent("healthz-up", { sandbox: "fixture" }), "go", {
    ensureRuntime: false,
    gatewayURL: "http://127.0.0.1:8787",
    fetch: async (url) => String(url).endsWith("/healthz")
      ? new Response("ok")
      : new Response(null, { status: 404 }),
    model: fauxModel(),
    streamFn: capture.streamFn,
  });
  // The gateway answered and the model was routed through it...
  assert.equal(capture.selected[0].baseUrl, "http://127.0.0.1:8787/anthropic");
  // ...but this process produced the turn, so the receipt does not claim more.
  assert.equal(result.mode, "observe-only");
});

// ---------------------------------------------------------------------------
// Honesty 3 — the loopback liveness probe is memoized like the runtime probe.
// ---------------------------------------------------------------------------

test("concurrent runs against one loopback gateway share a single healthz probe", async () => {
  const gatewayURL = "http://127.0.0.1:8123";
  const nativeFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    asked.push(String(url));
    if (String(url).endsWith("/healthz")) return new Response("ok");
    return nativeFetch(url, init);
  };
  try {
    const go = (id) => run(peekAgent(id, { sandbox: "fixture" }), "go", {
      ensureRuntime: false,
      gatewayURL,
      model: fauxModel(),
      streamFn: routeCapture().streamFn,
    });
    const results = await Promise.all([go("probe-memo-a"), go("probe-memo-b")]);
    // Two runs, one probe: the memo coalesces the in-flight one and caches the
    // result, so a gateway that is down costs one timeout per window, not one
    // per run.
    assert.equal(asked.filter((url) => url.endsWith("/healthz")).length, 1);
    for (const result of results) assert.equal(result.mode, "observe-only");
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
