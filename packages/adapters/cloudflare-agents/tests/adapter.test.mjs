import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAdapterLifecycleValidator } from "@caveman-ai/adapter-kit";
import {
  subscribe,
} from "agents/observability";
import {
  CLOUDFLARE_AGENTS_VERSION,
  createCloudflareAgentsAdapter,
  manifest,
} from "@caveman-ai/adapter-cloudflare-agents";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function nativeVersion() {
  const entry = import.meta.resolve("agents");
  const packagePath = fileURLToPath(new URL("../package.json", entry));
  return JSON.parse(readFileSync(packagePath, "utf8")).version;
}

function event(type, payload) {
  return {
    type,
    agent: "FixtureAgent",
    name: "fixture-instance",
    payload,
    timestamp: Date.now(),
  };
}

function assertValid(events) {
  const validator = createAdapterLifecycleValidator();
  for (const value of events) validator.accept(value);
  validator.finish();
}

test("manifest pins exact native package and claims only observed run lifecycle", () => {
  assert.equal(nativeVersion(), "0.22.0");
  assert.equal(CLOUDFLARE_AGENTS_VERSION, "0.22.0");
  assert.deepEqual(manifest.upstream, { package: "agents", version: "0.22.0" });
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.capabilities.runLifecycle, "experimental");
  assert.equal(manifest.lifecycle["run.started"], "observe");
  assert.equal(manifest.lifecycle["run.completed"], "observe");
  assert.equal(manifest.lifecycle["run.error"], "observe");
  assert.equal(manifest.capabilities.modelInterception, "unsupported");
  assert.equal(manifest.capabilities.toolObservation, "unsupported");
  assert.equal(manifest.capabilities.durableObservation, "unsupported");
  assert.equal(manifest.capabilities.replayAwareness, "unsupported");
  assert.deepEqual(manifest.certifications, {});
  assert.equal(Object.values(manifest.capabilities).includes("certified"), false);
});

test("native genericObservability composes without replacing Cloudflare delivery", async () => {
  const nativeEvents = [];
  const lifecycle = [];
  const unsubscribe = subscribe("chat", (value) => nativeEvents.push(value));
  const adapter = createCloudflareAgentsAdapter({
    onLifecycleEvent: (value) => lifecycle.push(value),
  });
  const start = event("chat:turn:start", {
    requestId: "request-native-1",
    trigger: "programmatic",
    admission: "queue",
  });
  const finish = event("chat:turn:finish", {
    requestId: "request-native-1",
    trigger: "programmatic",
    admission: "queue",
    status: "completed",
    durationMs: 4,
  });

  try {
    assert.equal(adapter.observability.emit(start), undefined);
    assert.equal(adapter.observability.emit(finish), undefined);
    await tick();
  } finally {
    unsubscribe();
  }

  assert.deepEqual(nativeEvents, [start, finish]);
  assert.deepEqual(lifecycle.map((value) => value.phase), [
    "run.started",
    "run.completed",
  ]);
  assert.equal(lifecycle[0].identity.runId, "cloudflare:chat:request-native-1");
  assert.deepEqual(lifecycle[0].identity.nativeIds, {
    cloudflareRequestId: "request-native-1",
  });
  assert.deepEqual(lifecycle[0].identity, lifecycle[1].identity);
  assertValid(lifecycle);
});

test("exact chat non-success statuses terminate as canonical errors", () => {
  for (const status of ["error", "aborted"]) {
    const lifecycle = [];
    const adapter = createCloudflareAgentsAdapter({
      onLifecycleEvent: (value) => lifecycle.push(value),
    });
    const requestId = `request-${status}`;
    adapter.observability.emit(event("chat:turn:start", {
      requestId,
      trigger: "programmatic",
      admission: "queue",
    }));
    adapter.observability.emit(event("chat:turn:finish", {
      requestId,
      trigger: "programmatic",
      admission: "queue",
      status,
      durationMs: 1,
    }));
    assert.deepEqual(lifecycle.map((value) => value.phase), ["run.started", "run.error"]);
    assertValid(lifecycle);
  }
});

test("exact skipped chat status is a normally-returned terminal run", () => {
  const lifecycle = [];
  const adapter = createCloudflareAgentsAdapter({
    onLifecycleEvent: (value) => lifecycle.push(value),
  });
  adapter.observability.emit(event("chat:turn:start", {
    requestId: "request-skipped",
    trigger: "programmatic",
    admission: "queue",
  }));
  adapter.observability.emit(event("chat:turn:finish", {
    requestId: "request-skipped",
    trigger: "programmatic",
    admission: "queue",
    status: "skipped",
    durationMs: 0,
  }));
  assert.deepEqual(lifecycle.map((value) => value.phase), ["run.started", "run.completed"]);
  assertValid(lifecycle);
});

test("native fiber lifecycle maps completed, failed, and interrupted pairs", () => {
  const terminals = [
    ["fiber:run:completed", "run.completed"],
    ["fiber:run:failed", "run.error"],
    ["fiber:run:interrupted", "run.error"],
  ];
  for (const [nativeTerminal, canonicalTerminal] of terminals) {
    const lifecycle = [];
    const adapter = createCloudflareAgentsAdapter({
      onLifecycleEvent: (value) => lifecycle.push(value),
    });
    const fiberId = `fiber-${nativeTerminal.split(":").at(-1)}`;
    adapter.observability.emit(event("fiber:run:started", {
      fiberId,
      fiberName: "fixture",
    }));
    adapter.observability.emit(event(nativeTerminal, {
      fiberId,
      fiberName: "fixture",
    }));
    assert.deepEqual(lifecycle.map((value) => value.phase), ["run.started", canonicalTerminal]);
    assert.equal(lifecycle[0].identity.runId, `cloudflare:fiber:${fiberId}`);
    assertValid(lifecycle);
  }
});

test("unknown status and invalid identity skip with diagnostics", () => {
  const lifecycle = [];
  const diagnostics = [];
  const adapter = createCloudflareAgentsAdapter({
    onLifecycleEvent: (value) => lifecycle.push(value),
    onObserverError: (value) => diagnostics.push(value),
  });
  adapter.observability.emit(event("chat:turn:start", {
    requestId: "request-unknown",
    trigger: "programmatic",
    admission: "queue",
  }));
  adapter.observability.emit(event("chat:turn:finish", {
    requestId: "request-unknown",
    trigger: "programmatic",
    admission: "queue",
    status: "future-status",
    durationMs: 1,
  }));
  adapter.observability.emit(event("fiber:run:started", {
    fiberId: "bad id",
    fiberName: "fixture",
  }));

  assert.deepEqual(lifecycle.map((value) => value.phase), ["run.started"]);
  assert.deepEqual(diagnostics.map((value) => value.stage), ["status", "identity"]);
});

test("unmapped native events produce zero Caveman lifecycle events", () => {
  const lifecycle = [];
  const diagnostics = [];
  const adapter = createCloudflareAgentsAdapter({
    onLifecycleEvent: (value) => lifecycle.push(value),
    onObserverError: (value) => diagnostics.push(value),
  });
  for (const value of [
    event("workflow:start", { workflowId: "workflow-1" }),
    event("workflow:event", { workflowId: "workflow-1", eventType: "progress" }),
    event("tool:result", { toolCallId: "tool-1", toolName: "search" }),
    event("agent_tool:recovery:row", { runId: "run-1", agentType: "fixture", status: "completed" }),
  ]) {
    adapter.observability.emit(value);
  }
  assert.deepEqual(lifecycle, []);
  assert.deepEqual(diagnostics, []);
});

test("composition captures native method once and preserves receiver, args, and result", () => {
  const calls = [];
  const sentinel = Object.freeze({ native: true });
  let reads = 0;
  const native = {
    marker: "native-receiver",
    get emit() {
      reads += 1;
      return function (...args) {
        calls.push({ receiver: this, args });
        return sentinel;
      };
    },
  };
  const adapter = createCloudflareAgentsAdapter({ observability: native });
  const first = event("state:update", {});
  const second = event("rpc", { method: "ping" });

  assert.strictEqual(adapter.observability.emit(first), sentinel);
  assert.strictEqual(adapter.observability.emit(second), sentinel);
  assert.equal(reads, 1);
  assert.strictEqual(calls[0].receiver, native);
  assert.strictEqual(calls[0].args[0], first);
  assert.strictEqual(calls[1].args[0], second);
});

test("native throw identity wins while Caveman observer remains best effort", () => {
  const lifecycle = [];
  const nativeError = new Error("native-observability-failure");
  const adapter = createCloudflareAgentsAdapter({
    observability: { emit() { throw nativeError; } },
    onLifecycleEvent: (value) => lifecycle.push(value),
  });
  const start = event("chat:turn:start", {
    requestId: "request-native-error",
    trigger: "programmatic",
    admission: "queue",
  });

  assert.throws(() => adapter.observability.emit(start), (error) => error === nativeError);
  assert.deepEqual(lifecycle.map((value) => value.phase), ["run.started"]);
});

test("native undefined throw remains a throw", () => {
  const adapter = createCloudflareAgentsAdapter({
    observability: { emit() { throw undefined; } },
    onLifecycleEvent() {},
  });
  let caught = false;
  let thrown = Symbol("unset");
  try {
    adapter.observability.emit(event("state:update", {}));
  } catch (error) {
    caught = true;
    thrown = error;
  }
  assert.equal(caught, true);
  assert.equal(thrown, undefined);
});

test("observer throws and rejections never alter native execution", async () => {
  const nativeEvents = [];
  const diagnostics = [];
  let call = 0;
  const adapter = createCloudflareAgentsAdapter({
    observability: { emit(value) { nativeEvents.push(value); return value; } },
    onLifecycleEvent() {
      call += 1;
      if (call === 1) throw new Error("sync-sink");
      return Promise.reject(new Error("async-sink"));
    },
    onObserverError: (value) => diagnostics.push(value),
  });
  const start = event("fiber:run:started", { fiberId: "fiber-sink", fiberName: "fixture" });
  const finish = event("fiber:run:completed", { fiberId: "fiber-sink", fiberName: "fixture" });

  assert.strictEqual(adapter.observability.emit(start), start);
  assert.strictEqual(adapter.observability.emit(finish), finish);
  await tick();
  assert.deepEqual(nativeEvents, [start, finish]);
  assert.deepEqual(diagnostics.map((value) => value.stage), [
    "lifecycle_sink",
    "lifecycle_sink",
  ]);
});

test("detached observer queue stays bounded under hung sinks", () => {
  let calls = 0;
  const hung = new Promise(() => {});
  const adapter = createCloudflareAgentsAdapter({
    onLifecycleEvent() {
      calls += 1;
      return hung;
    },
  });
  for (let index = 0; index < 80; index += 1) {
    adapter.observability.emit(event("fiber:run:started", {
      fiberId: `fiber-hung-${index}`,
      fiberName: "fixture",
    }));
  }
  assert.equal(calls, 64);
});

test("accessor-shaped native payload is never evaluated by translator", () => {
  let reads = 0;
  const diagnostics = [];
  const value = {
    type: "chat:turn:start",
    get payload() {
      reads += 1;
      return { requestId: "request-accessor" };
    },
    timestamp: Date.now(),
  };
  const adapter = createCloudflareAgentsAdapter({
    onLifecycleEvent() {},
    onObserverError: (error) => diagnostics.push(error),
  });
  adapter.observability.emit(value);
  assert.equal(reads, 0);
  assert.deepEqual(diagnostics.map((error) => error.stage), ["event"]);
});

test("hostile native event proxy cannot alter native result", () => {
  const sentinel = Object.freeze({ native: true });
  const value = new Proxy({}, {
    ownKeys() {
      throw new Error("hostile-event");
    },
  });
  const adapter = createCloudflareAgentsAdapter({
    observability: { emit() { return sentinel; } },
    onLifecycleEvent() {},
  });
  assert.strictEqual(adapter.observability.emit(value), sentinel);
});
