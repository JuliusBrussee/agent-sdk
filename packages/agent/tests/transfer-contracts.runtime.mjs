import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialIsMetered,
  inspectCredential,
  normalizeCredentialRequest,
  normalizeCredentialMetadata,
  resolveCredential,
} from "../dist/credentials.js";
import {
  captureCheckpoint,
  compareCheckpoints,
  defineCheckpointEvidence,
  restoreCheckpoint,
} from "../dist/checkpoints.js";
import {
  defineHostRuntimeDescriptor,
  defineRuntimeDescriptor,
  readRuntimeDescriptor,
} from "../dist/runtime-descriptor.js";
import {
  defineTraceSpanRecord,
  emitTraceSpan,
  flushTraceBridge,
} from "../dist/tracing.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const timestamp = "2026-08-30T10:00:00.000Z";

function hostRuntime() {
  return defineHostRuntimeDescriptor({
    backend: { id: "host", version: "1.0.0" },
    filesystem: { read: "workspace", write: "workspace" },
    network: "unrestricted",
    subprocess: "uncontained",
    limits: {
      deadline: "enforced",
      outputBytes: "enforced",
      memory: "unknown",
      cpu: "unknown",
    },
    observedAt: timestamp,
    digest: digestA,
  });
}

test("runtime descriptors detach facts and host execution stays uncontained", async () => {
  const input = {
    schemaVersion: 1,
    backend: { id: "probe" },
    containment: "unknown",
    filesystem: { read: "unknown", write: "unknown" },
    network: "unknown",
    subprocess: "unknown",
    limits: {
      deadline: "unknown",
      outputBytes: "unknown",
      memory: "unknown",
      cpu: "unknown",
    },
    evidence: { basis: "live_probe", observedAt: timestamp },
  };
  const descriptor = defineRuntimeDescriptor(input);
  input.backend.id = "mutated";
  assert.equal(descriptor.backend.id, "probe");
  assert.equal(Object.isFrozen(descriptor.filesystem), true);
  assert.equal(hostRuntime().containment, "uncontained");

  assert.throws(() => defineRuntimeDescriptor({
    ...input,
    containment: "os",
    evidence: { basis: "host" },
  }), /cave_runtime_descriptor_invalid:host_containment/);

  await assert.rejects(readRuntimeDescriptor({
    describe() {
      throw new Error("secret-runtime-detail");
    },
  }), (error) => error.message === "cave_runtime_descriptor_provider_failed");
  const controller = new AbortController();
  controller.abort(new Error("secret-abort-reason"));
  await assert.rejects(
    readRuntimeDescriptor({ describe: () => hostRuntime() }, controller.signal),
    (error) => error.message === "cave_runtime_descriptor_aborted",
  );
});

test("credentials resolve just in time, detach secrets, and fail closed", async () => {
  const headers = { Authorization: "Bearer secret" };
  const environment = { AWS_PROFILE: "billing-prod" };
  let calls = 0;
  const resolver = {
    inspect(request) {
      assert.equal(Object.isFrozen(request), true);
      return { provider: "openai", kind: "api_key", billing: "metered" };
    },
    resolve(request) {
      calls++;
      assert.equal(request.provider, "openai");
      assert.equal(Object.isFrozen(request), true);
      return {
        metadata: { provider: "openai", kind: "api_key", billing: "metered" },
        material: { headers, env: environment, baseURL: "https://api.openai.com/v1" },
      };
    },
  };
  const metadata = await inspectCredential(resolver, {
    provider: "openai",
    purpose: "model",
  });
  assert.equal(metadata.billing, "metered");
  assert.equal(credentialIsMetered(metadata), true);
  assert.equal(credentialIsMetered(
    normalizeCredentialMetadata({
      provider: "openai",
      kind: "oauth",
      billing: "unknown",
    }),
  ), false);

  const resolved = await resolveCredential(resolver, {
    provider: "openai",
    model: "gpt-5",
    purpose: "model",
  });
  headers.Authorization = "mutated";
  environment.AWS_PROFILE = "mutated";
  assert.equal(calls, 1);
  assert.equal(resolved.material.headers.Authorization, "Bearer secret");
  assert.equal(resolved.material.env.AWS_PROFILE, "billing-prod");
  assert.equal(Object.isFrozen(resolved.material.headers), true);
  assert.equal(Object.isFrozen(resolved.material.env), true);

  await assert.rejects(resolveCredential({
    resolve() {
      throw new Error("sk-secret-must-not-leak");
    },
  }, { provider: "openai", purpose: "model" }),
  (error) => error.message === "cave_credential_resolve_failed");
  await assert.rejects(resolveCredential({ resolve: () => undefined }, {
    provider: "openai",
    purpose: "model",
  }), /cave_credential_unavailable/);
  await assert.rejects(resolveCredential({ resolve: () => ({
    metadata: {
      provider: "openai",
      kind: "oauth",
      billing: "unknown",
      expiresAt: 1,
    },
    material: { apiKey: "expired" },
  }) }, { provider: "openai", purpose: "model" }), /cave_credential_expired/);
  await assert.rejects(resolveCredential({ resolve: () => ({
    metadata: { provider: "other", kind: "api_key", billing: "metered" },
    material: { apiKey: "wrong-provider" },
  }) }, { provider: "openai", purpose: "model" }),
  /cave_credential_invalid:metadata_provider_mismatch/);
  await assert.rejects(resolveCredential({ resolve: () => ({
    metadata: { provider: "openai", kind: "api_key", billing: "metered" },
    material: { env: { "BAD-NAME": "secret" } },
  }) }, { provider: "openai", purpose: "model" }),
  /cave_credential_invalid:env/);
  assert.equal((await resolveCredential({ resolve: () => ({
    metadata: { provider: "local", kind: "other", billing: "unknown" },
    material: { keyless: true, baseURL: "http://127.0.0.1:11434/v1" },
  }) }, { provider: "local", purpose: "model" })).material.keyless, true);
  await assert.rejects(resolveCredential({ resolve: () => ({
    metadata: { provider: "local", kind: "other", billing: "unknown" },
    material: { keyless: true, apiKey: "contradiction" },
  }) }, { provider: "local", purpose: "model" }),
  /cave_credential_invalid:keyless/);
});

test("provider methods are captured once and never depend on bind", async () => {
  let describeReads = 0;
  const runtimeProvider = {};
  Object.defineProperty(runtimeProvider, "describe", {
    enumerable: true,
    get() {
      describeReads++;
      if (describeReads > 1) throw new Error("secret-second-read");
      return function describe() {
        assert.equal(this, runtimeProvider);
        return hostRuntime();
      };
    },
  });
  assert.equal((await readRuntimeDescriptor(runtimeProvider)).backend.id, "host");
  assert.equal(describeReads, 1);

  const resolve = function resolve() {
    return {
      metadata: { provider: "openai", kind: "api_key", billing: "metered" },
      material: { apiKey: "secret" },
    };
  };
  Object.defineProperty(resolve, "bind", {
    get() {
      throw new Error("secret-bind-getter");
    },
  });
  assert.equal((await resolveCredential({ resolve }, {
    provider: "openai",
    purpose: "model",
  })).metadata.provider, "openai");

  const emit = function emit() {
    assert.equal(this.bridge, true);
  };
  Object.defineProperty(emit, "bind", {
    get() {
      throw new Error("secret-bind-getter");
    },
  });
  const bridge = { bridge: true, emit };
  const span = defineTraceSpanRecord({
    schemaVersion: 1,
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    name: "agent.run",
    kind: "internal",
    startUnixNano: "1",
    endUnixNano: "2",
    status: "ok",
    attributes: {},
    events: [],
  });
  assert.equal(await emitTraceSpan(bridge, span), "emitted");
});

test("trace projection is bounded, content-blind, sampled, and diagnostic-only", async () => {
  const source = {
    schemaVersion: 1,
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    name: "agent.model",
    kind: "client",
    startUnixNano: "100",
    endUnixNano: "200",
    status: "ok",
    attributes: {
      "caveman.run.id": "run-1",
      "caveman.attempt": 1,
      "caveman.replay": false,
      "gen_ai.request.model": "gpt-5",
    },
    events: [{ name: "model.responded", atUnixNano: "150" }],
  };
  const span = defineTraceSpanRecord(source);
  source.attributes["caveman.run.id"] = "mutated";
  assert.equal(span.attributes["caveman.run.id"], "run-1");

  let emitted;
  assert.equal(await emitTraceSpan({ emit(value) { emitted = value; } }, span), "emitted");
  assert.deepEqual(emitted, span);
  assert.notEqual(emitted, span);
  assert.equal(Object.isFrozen(emitted.events), true);
  assert.equal(await emitTraceSpan({ emit() { throw new Error("secret"); } }, span), "bridge_failed");
  assert.equal(await emitTraceSpan({ emit() { assert.fail("must not emit"); } }, span, {
    sampleRate: 0,
  }), "sampled_out");
  assert.throws(() => defineTraceSpanRecord({
    ...source,
    attributes: { prompt: "secret" },
  }), /cave_trace_invalid:attributes/);
  assert.equal(await flushTraceBridge({ emit() {} }), "unsupported");
  assert.equal(await flushTraceBridge({ emit() {}, flush: () => new Promise(() => {}) }, {
    timeoutMs: 5,
  }), "timed_out");
});

test("checkpoint hooks validate evidence, refs, completeness, abort, and digest", async () => {
  const runtime = hostRuntime();
  const artifacts = [{ name: "dir/file with space.txt", digest: digestA, bytes: 4 }];
  const evidence = defineCheckpointEvidence({
    schemaVersion: 1,
    providerId: "fixture",
    ref: "plain:/tmp/checkpoint 1",
    sequence: 1,
    createdAt: timestamp,
    rootDigest: digestA,
    completeness: "complete",
    artifacts,
    omissionCount: 0,
    runtime,
  });
  artifacts[0].name = "mutated";
  assert.equal(evidence.artifacts[0].name, "dir/file with space.txt");
  assert.throws(() => defineCheckpointEvidence({
    ...evidence,
    completeness: "complete",
    omissionCount: 1,
  }), /cave_checkpoint_invalid:completeness/);

  const captured = await captureCheckpoint({
    capture(request) {
      assert.equal(Object.isFrozen(request), true);
      return evidence;
    },
    restore() {
      throw new Error("unused");
    },
  }, {
    sessionId: "session-1",
    runId: "run-1",
    stepId: "step-1",
    reason: "before_step",
  });
  assert.equal(captured.ref, evidence.ref);

  await assert.rejects(captureCheckpoint({
    capture() { throw new Error("secret-checkpoint-path"); },
    restore() { throw new Error("unused"); },
  }, {
    sessionId: "session-1",
    runId: "run-1",
    stepId: "step-1",
    reason: "manual",
  }), (error) => error.message === "cave_checkpoint_capture_failed");

  await assert.rejects(restoreCheckpoint({
    capture: () => evidence,
    restore: () => ({
      ref: evidence.ref,
      restoredAt: timestamp,
      beforeRootDigest: digestB,
      afterRootDigest: digestA,
      changedPathCount: 1,
      runtime,
    }),
  }, {
    sessionId: "session-1",
    ref: evidence.ref,
    expectedRootDigest: digestB,
  }), /cave_checkpoint_restore_mismatch/);

  await assert.rejects(compareCheckpoints({
    capture: () => evidence,
    restore: () => { throw new Error("unused"); },
  }, evidence.ref, "other ref"), /cave_checkpoint_compare_unsupported/);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(captureCheckpoint({
    capture: () => evidence,
    restore: () => { throw new Error("unused"); },
  }, {
    sessionId: "session-1",
    runId: "run-1",
    stepId: "step-1",
    reason: "manual",
    signal: controller.signal,
  }), /cave_checkpoint_aborted/);
});

test("transfer contracts snapshot own data and reject accessors and sparse arrays", () => {
  let getterReads = 0;
  const descriptor = {
    backend: { id: "probe" },
    containment: "unknown",
    filesystem: { read: "unknown", write: "unknown" },
    network: "unknown",
    subprocess: "unknown",
    limits: {
      deadline: "unknown",
      outputBytes: "unknown",
      memory: "unknown",
      cpu: "unknown",
    },
    evidence: { basis: "live_probe" },
  };
  Object.defineProperty(descriptor, "schemaVersion", {
    enumerable: true,
    get() {
      getterReads++;
      return 1;
    },
  });
  assert.throws(
    () => defineRuntimeDescriptor(descriptor),
    /cave_runtime_descriptor_invalid:descriptor/,
  );
  assert.equal(getterReads, 0);

  Object.defineProperty(Object.prototype, "model", {
    configurable: true,
    enumerable: true,
    value: "inherited-model",
  });
  try {
    const normalized = normalizeCredentialRequest({
      provider: "openai",
      purpose: "model",
    });
    assert.equal(Object.hasOwn(normalized, "model"), false);
  } finally {
    delete Object.prototype.model;
  }

  assert.throws(() => defineCheckpointEvidence({
    schemaVersion: 1,
    providerId: "fixture",
    ref: "ref",
    sequence: 1,
    createdAt: timestamp,
    rootDigest: digestA,
    completeness: "unknown",
    artifacts: new Array(1),
    omissionCount: 1,
    runtime: hostRuntime(),
  }), /cave_checkpoint_invalid:artifacts/);

  assert.throws(() => defineTraceSpanRecord({
    schemaVersion: 1,
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    name: "agent.run",
    kind: "internal",
    startUnixNano: "1",
    endUnixNano: "2",
    status: "ok",
    attributes: {},
    events: new Array(1),
  }), /cave_trace_invalid:events/);
});

test("provider boundaries abort pending work and trace emission stays bounded", async () => {
  const never = () => new Promise(() => undefined);

  const runtimeAbort = new AbortController();
  const runtimePending = readRuntimeDescriptor({ describe: never }, runtimeAbort.signal);
  runtimeAbort.abort(new Error("secret-runtime-abort"));
  await assert.rejects(runtimePending, (error) =>
    error.message === "cave_runtime_descriptor_aborted");

  const credentialAbort = new AbortController();
  const credentialPending = resolveCredential({ resolve: never }, {
    provider: "openai",
    purpose: "model",
    signal: credentialAbort.signal,
  });
  credentialAbort.abort(new Error("secret-credential-abort"));
  await assert.rejects(credentialPending, (error) =>
    error.message === "cave_credential_aborted");

  const checkpointAbort = new AbortController();
  const checkpointPending = captureCheckpoint({
    capture: never,
    restore: never,
  }, {
    sessionId: "session-1",
    runId: "run-1",
    stepId: "step-1",
    reason: "manual",
    signal: checkpointAbort.signal,
  });
  checkpointAbort.abort(new Error("secret-checkpoint-abort"));
  await assert.rejects(checkpointPending, (error) =>
    error.message === "cave_checkpoint_aborted");

  const span = defineTraceSpanRecord({
    schemaVersion: 1,
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    name: "agent.run",
    kind: "internal",
    startUnixNano: "1",
    endUnixNano: "2",
    status: "ok",
    attributes: {},
    events: [],
  });
  assert.equal(await emitTraceSpan({ emit: never }, span, { timeoutMs: 5 }), "timed_out");
});

test("trace identity and event chronology fail closed", () => {
  const base = {
    schemaVersion: 1,
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    name: "agent.run",
    kind: "internal",
    startUnixNano: "100",
    endUnixNano: "200",
    status: "ok",
    attributes: {},
    events: [],
  };
  assert.throws(
    () => defineTraceSpanRecord({ ...base, traceId: "0".repeat(32) }),
    /cave_trace_invalid:identity/,
  );
  assert.throws(() => defineTraceSpanRecord({
    ...base,
    events: [
      { name: "model.requested", atUnixNano: "180" },
      { name: "model.responded", atUnixNano: "170" },
    ],
  }), /cave_trace_invalid:event_time_order/);
});
