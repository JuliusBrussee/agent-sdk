import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as conformance from "../src/index.js";
import {
  ADAPTER_CONFORMANCE_CANDIDATE_SUITE,
  ADAPTER_CONFORMANCE_REPORT_SCHEMA,
  ADAPTER_CONFORMANCE_TEST_VECTOR,
  canonicalSerialize,
  computeArtifactSHA256,
  computeConformanceReportDigest,
  createNodeConformanceEnvironment,
  defineConformanceReport,
  runAdapterConformance,
} from "../src/index.js";
import {
  ADAPTER_CAPABILITIES,
  ADAPTER_CONFORMANCE_SUITE as KIT_CONFORMANCE_SUITE,
  defineAdapterManifest,
} from "../../adapter-kit/src/index.js";

const encoder = new TextEncoder();
const ADAPTER_BYTES = encoder.encode("adapter-package-tarball-v1");
const UPSTREAM_BYTES = encoder.encode("upstream-package-tarball-v1");

function vectorCases(capabilities, run = ({ id }) => ({
  status: "passed",
  evidence: encoder.encode(`observed:${id}`),
})) {
  const selected = new Set(capabilities);
  return ADAPTER_CONFORMANCE_TEST_VECTOR.cases
    .filter((item) => selected.has(item.capability))
    .map((item) => ({ id: item.id, run }));
}

function vectorPerformance(capabilities, onRun = () => {}) {
  const selected = new Set(capabilities);
  return ADAPTER_CONFORMANCE_TEST_VECTOR.performance
    .filter((item) => selected.has(item.capability))
    .map((item) => ({
      id: item.id,
      run(vector) { onRun(item, vector); },
    }));
}

function fixture(capabilities = ["runLifecycle"], overrides = {}) {
  return {
    adapter: {
      id: "fixture",
      packageName: "@caveman-ai/adapter-fixture",
      version: "1.2.3",
    },
    upstream: { packageName: "fixture-sdk", version: "4.5.6" },
    artifacts: {
      adapter: new Uint8Array(ADAPTER_BYTES),
      upstream: new Uint8Array(UPSTREAM_BYTES),
    },
    capabilities,
    cases: vectorCases(capabilities),
    performance: vectorPerformance(capabilities),
    ...overrides,
  };
}

test("canonical suite owns exact v2 capabilities and v4 measured vectors", () => {
  assert.deepEqual(ADAPTER_CAPABILITIES, [
    "runLifecycle",
    "modelInterception",
    "contextTransformation",
    "toolObservation",
    "usageAccounting",
    "streaming",
    "abort",
    "replayAwareness",
    "durableObservation",
    "tracing",
    "compilation",
  ]);
  assert.notEqual(ADAPTER_CONFORMANCE_CANDIDATE_SUITE, KIT_CONFORMANCE_SUITE);
  assert.equal(ADAPTER_CONFORMANCE_TEST_VECTOR.id, "adapter-capabilities-v4");
  assert.equal(ADAPTER_CONFORMANCE_TEST_VECTOR.version, "4.0.0");
  assert.equal(ADAPTER_CONFORMANCE_TEST_VECTOR.cases.length, 24);
  assert.equal(ADAPTER_CONFORMANCE_TEST_VECTOR.performance.length, 7);
  assert.equal(
    ADAPTER_CONFORMANCE_TEST_VECTOR.sha256,
    "8dec2730881a52e2f924f0b5368eda07eb0d39da4188e8fc3ea4935b18fc23f9",
  );
  for (const capability of ADAPTER_CAPABILITIES) {
    assert.ok(ADAPTER_CONFORMANCE_TEST_VECTOR.cases.some((item) =>
      item.capability === capability));
  }
  for (const benchmark of ADAPTER_CONFORMANCE_TEST_VECTOR.performance) {
    assert.equal(benchmark.clock, "node:process.hrtime.bigint:captured");
    assert.equal(benchmark.percentile, 99);
    assert.ok(benchmark.warmupCount > 0);
    assert.ok(benchmark.sampleCount > 0);
    assert.equal(benchmark.threshold.operator, "lte");
  }
  assert.equal(Object.isFrozen(ADAPTER_CONFORMANCE_TEST_VECTOR), true);
  assert.equal(Object.isFrozen(ADAPTER_CONFORMANCE_TEST_VECTOR.performance[0]), true);
});

test("complete canonical suite covers every capability exactly", async () => {
  const counts = new Map();
  const capabilities = [...ADAPTER_CAPABILITIES].reverse();
  const report = await runAdapterConformance(fixture(capabilities, {
    performance: vectorPerformance(capabilities, (definition) => {
      counts.set(definition.id, (counts.get(definition.id) ?? 0) + 1);
    }),
  }));
  assert.deepEqual(report.capabilities.map((item) => item.name), ADAPTER_CAPABILITIES);
  assert.deepEqual(report.totals, {
    capabilities: { passed: 11, blocked: 0, total: 11 },
    cases: { passed: 24, failed: 0, skipped: 0, total: 24 },
    performance: { passed: 7, failed: 0, skipped: 0, total: 7 },
  });
  for (const definition of ADAPTER_CONFORMANCE_TEST_VECTOR.performance) {
    assert.equal(
      counts.get(definition.id),
      definition.warmupCount + definition.sampleCount,
    );
  }
});

test("caller ordering normalizes while report digest covers measured output", async () => {
  const executionOrder = [];
  const capabilities = ["tracing", "runLifecycle"];
  const cases = vectorCases(capabilities, ({ id }) => {
    executionOrder.push(id);
    return { status: "passed", evidence: encoder.encode(`observed:${id}`) };
  });
  const report = await runAdapterConformance(fixture(capabilities, {
    cases: [...cases].reverse(),
    performance: [...vectorPerformance(capabilities)].reverse(),
  }));
  assert.deepEqual(
    executionOrder,
    ADAPTER_CONFORMANCE_TEST_VECTOR.cases
      .filter((item) => new Set(capabilities).has(item.capability))
      .map((item) => item.id),
  );
  assert.deepEqual(report.capabilities.map((item) => item.name), [
    "runLifecycle",
    "tracing",
  ]);
  assert.deepEqual(report.performance.map((item) => item.capability), [
    "runLifecycle",
    "tracing",
  ]);
  const { reportDigest, ...body } = report;
  const expected = `sha256:${createHash("sha256")
    .update(canonicalSerialize(body))
    .digest("hex")}`;
  assert.equal(reportDigest, expected);
  assert.equal(computeConformanceReportDigest(report), expected);
  assert.equal(computeConformanceReportDigest(body), expected);
});

test("artifact bytes are snapshotted and SHA-256 is computed, never claimed", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const input = fixture(["abort"], {
    cases: vectorCases(["abort"], async ({ id }) => {
      await waiting;
      return { status: "passed", evidence: encoder.encode(id) };
    }),
  });
  const expectedAdapterSHA = computeArtifactSHA256(input.artifacts.adapter);
  const expectedUpstreamSHA = computeArtifactSHA256(input.artifacts.upstream);
  const pending = runAdapterConformance(input);
  input.adapter.version = "9.9.9";
  input.artifacts.adapter.fill(0);
  input.artifacts.upstream.fill(0);
  input.capabilities[0] = "compilation";
  release();
  const report = await pending;

  assert.equal(report.adapter.version, "1.2.3");
  assert.equal(report.packages[0].sha256, expectedAdapterSHA);
  assert.equal(report.packages[1].sha256, expectedUpstreamSHA);
  assert.deepEqual(report.capabilities.map((item) => item.name), ["abort"]);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.capabilities[0].cases), true);

  await assert.rejects(
    runAdapterConformance(fixture(["abort"], {
      artifacts: { adapter: new Uint8Array(), upstream: UPSTREAM_BYTES },
    })),
    /cave_adapter_conformance_invalid:adapter_artifact/,
  );
  await assert.rejects(
    runAdapterConformance({ ...fixture(["abort"]), packages: [] }),
    /cave_adapter_conformance_invalid:input_keys/,
  );
});

test("report subjects require exact reproducible SemVer identities", async () => {
  for (const version of ["latest", "^1.2.3", "1.2", "01.2.3", "1.02.3", "1.2.03"]) {
    await assert.rejects(
      runAdapterConformance(fixture(["abort"], {
        adapter: {
          id: "fixture",
          packageName: "@caveman-ai/adapter-fixture",
          version,
        },
      })),
      /cave_adapter_conformance_invalid:adapter_version/,
    );
    await assert.rejects(
      runAdapterConformance(fixture(["abort"], {
        upstream: { packageName: "fixture-sdk", version },
      })),
      /cave_adapter_conformance_invalid:upstream_version/,
    );
  }

  const prerelease = await runAdapterConformance(fixture(["abort"], {
    adapter: {
      id: "fixture",
      packageName: "@caveman-ai/adapter-fixture",
      version: "1.2.3-rc.1+build.9",
    },
  }));
  assert.equal(prerelease.adapter.version, "1.2.3-rc.1+build.9");
});

test("candidate report API surface contains evidence operations only", async () => {
  const oneByte = new Uint8Array([1]);
  const report = await runAdapterConformance(fixture(ADAPTER_CAPABILITIES, {
    cases: vectorCases(ADAPTER_CAPABILITIES, () => ({
      status: "passed",
      evidence: oneByte,
    })),
  }));
  assert.equal(report.totals.capabilities.passed, 11);
  assert.deepEqual(Object.keys(conformance).sort(), [
    "ADAPTER_CONFORMANCE_CANDIDATE_SUITE",
    "ADAPTER_CONFORMANCE_REPORT_SCHEMA",
    "ADAPTER_CONFORMANCE_TEST_VECTOR",
    "canonicalSerialize",
    "computeArtifactSHA256",
    "computeConformanceReportDigest",
    "createNodeConformanceEnvironment",
    "defineConformanceReport",
    "runAdapterConformance",
  ]);
  assert.deepEqual(Object.keys(report.capabilities[0]).sort(), [
    "caseCounts",
    "cases",
    "name",
    "performanceCounts",
    "qualification",
  ]);
  assert.equal(report.capabilities[0].qualification.status, "passed");
  assert.throws(
    () => defineAdapterManifest({
      schemaVersion: 1,
      id: "fixture",
      packageName: "@caveman-ai/adapter-fixture",
      adapterVersion: "1.2.3",
      upstream: { package: "fixture-sdk", version: "4.5.6" },
      capabilities: {
        run: "certified",
        stream: "unsupported",
        tools: "unsupported",
        usage: "unsupported",
        abort: "unsupported",
        durable: "unsupported",
        compile: "unsupported",
      },
      certifications: {
        run: { suite: report.suite, reportSHA256: report.reportDigest },
      },
    }),
    /cave_adapter_certification_invalid:run/,
  );
});

test("incomplete, arbitrary, and no-op case vectors fail closed", async () => {
  const runInput = fixture();
  await assert.rejects(
    runAdapterConformance({ ...runInput, cases: runInput.cases.slice(1) }),
    /cave_adapter_conformance_invalid:case_coverage/,
  );
  await assert.rejects(
    runAdapterConformance({
      ...runInput,
      cases: [...runInput.cases, { id: "caller.no-op", run: async () => {} }],
    }),
    /cave_adapter_conformance_invalid:case_unknown/,
  );

  const noOp = await runAdapterConformance(fixture(["abort"], {
    cases: vectorCases(["abort"], async () => {}),
  }));
  assert.equal(noOp.capabilities[0].qualification.status, "blocked");
  assert.deepEqual(noOp.capabilities[0].cases.map((item) => item.code), [
    "case_result_missing",
    "case_result_missing",
  ]);
});

test("suite measures hot callback; caller numeric results and threshold edits reject", async () => {
  const definition = ADAPTER_CONFORMANCE_TEST_VECTOR.performance.find((item) =>
    item.capability === "runLifecycle");
  await assert.rejects(
    runAdapterConformance(fixture(["runLifecycle"], {
      performance: [{
        id: definition.id,
        measurement: { sampleCount: 1_000_000, value: 0.0001 },
      }],
    })),
    /cave_adapter_conformance_invalid:performance_result/,
  );
  await assert.rejects(
    runAdapterConformance(fixture(["runLifecycle"], {
      performance: [{
        id: definition.id,
        run() {},
        threshold: { operator: "lte", value: Number.MAX_VALUE },
      }],
    })),
    /cave_adapter_conformance_invalid:performance_keys/,
  );

  let calls = 0;
  const measured = await runAdapterConformance(fixture(["runLifecycle"], {
    performance: [{ id: definition.id, run() { calls += 1; } }],
  }));
  assert.equal(calls, definition.warmupCount + definition.sampleCount);
  assert.equal(measured.performance[0].sampleCount, definition.sampleCount);
  assert.equal(measured.performance[0].requiredSampleCount, definition.sampleCount);
  assert.equal(measured.performance[0].clock, "node:process.hrtime.bigint:captured");
  assert.equal(measured.performance[0].percentile, 99);
  assert.equal(typeof measured.performance[0].observed, "number");

  const clockDescriptor = Object.getOwnPropertyDescriptor(process.hrtime, "bigint");
  let replacedClock = false;
  let capturedClockReport;
  try {
    capturedClockReport = await runAdapterConformance(fixture(["runLifecycle"], {
      performance: [{
        id: definition.id,
        run() {
          if (replacedClock) return;
          replacedClock = true;
          Object.defineProperty(process.hrtime, "bigint", {
            configurable: true,
            value: () => 0n,
          });
        },
      }],
    }));
  } finally {
    Object.defineProperty(process.hrtime, "bigint", clockDescriptor);
  }
  assert.ok(capturedClockReport.performance[0].observed > 0);

  const returned = await runAdapterConformance(fixture(["runLifecycle"], {
    performance: [{ id: definition.id, run() { return 1; } }],
  }));
  assert.equal(
    returned.performance[0].code,
    "performance_callback_result_invalid",
  );

  const threw = await runAdapterConformance(fixture(["runLifecycle"], {
    performance: [{ id: definition.id, run() { throw new Error("secret"); } }],
  }));
  assert.equal(threw.performance[0].code, "performance_callback_threw");
});

test("performance skips and case codes use fixed vocabulary", async () => {
  const secret = "CAVE_TEST_SECRET_dont_serialize";
  const definition = ADAPTER_CONFORMANCE_TEST_VECTOR.performance.find((item) =>
    item.capability === "streaming");
  const report = await runAdapterConformance(fixture(["streaming"], {
    performance: [{ id: definition.id, skipped: { code: secret } }],
    cases: vectorCases(["streaming"], () => ({ status: "failed", code: secret })),
  }));
  assert.equal(report.performance[0].code, "performance_skipped");
  assert.deepEqual(report.capabilities[0].cases.map((item) => item.code), [
    "case_failed",
    "case_failed",
    "case_failed",
  ]);
  assert.doesNotMatch(canonicalSerialize(report), new RegExp(secret));
});

test("environment is derived and always reports uncontained host execution", async () => {
  const environment = createNodeConformanceEnvironment();
  assert.equal(environment.runtime.name, "node");
  assert.equal(environment.runtime.version, process.versions.node);
  assert.equal(environment.platform.name, process.platform);
  assert.equal(environment.platform.architecture, process.arch);
  assert.equal(environment.execution, "uncontained-host");
  assert.throws(
    () => createNodeConformanceEnvironment({ execution: "container" }),
    /cave_adapter_conformance_invalid:environment_arguments/,
  );
  await assert.rejects(
    runAdapterConformance({
      ...fixture(["abort"]),
      environment: { execution: "container" },
    }),
    /cave_adapter_conformance_invalid:input_keys/,
  );

  const nodeDescriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const architectureDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
  let mutated = false;
  let report;
  const cases = vectorCases(["abort"], ({ id }) => {
    if (!mutated) {
      mutated = true;
      Object.defineProperty(process.versions, "node", {
        configurable: true,
        value: "0.0.0",
      });
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "spoofos",
      });
      Object.defineProperty(process, "arch", {
        configurable: true,
        value: "spoofarch",
      });
    }
    return { status: "passed", evidence: encoder.encode(id) };
  });
  try {
    report = await runAdapterConformance(fixture(["abort"], { cases }));
  } finally {
    Object.defineProperty(process.versions, "node", nodeDescriptor);
    Object.defineProperty(process, "platform", platformDescriptor);
    Object.defineProperty(process, "arch", architectureDescriptor);
  }
  assert.deepEqual(report.environment, environment);

  const proxyFixture = fixture(["abort"]);
  let inputTrapRan = false;
  const adapterProxy = new Proxy(proxyFixture.adapter, {
    getPrototypeOf(target) {
      if (!inputTrapRan) {
        inputTrapRan = true;
        Object.defineProperty(process.versions, "node", {
          configurable: true,
          value: "0.0.1",
        });
        Object.defineProperty(process, "platform", {
          configurable: true,
          value: "proxyos",
        });
        Object.defineProperty(process, "arch", {
          configurable: true,
          value: "proxyarch",
        });
      }
      return Reflect.getPrototypeOf(target);
    },
  });
  try {
    report = await runAdapterConformance({
      ...proxyFixture,
      adapter: adapterProxy,
    });
  } finally {
    Object.defineProperty(process.versions, "node", nodeDescriptor);
    Object.defineProperty(process, "platform", platformDescriptor);
    Object.defineProperty(process, "arch", architectureDescriptor);
  }
  assert.equal(inputTrapRan, true);
  assert.deepEqual(report.environment, environment);
});

test("accessors, symbols, custom prototypes, cycles, and sparse arrays reject", async () => {
  const proxySecret = "PROXY_SECRET_123";
  const hostileRecord = new Proxy({}, {
    getPrototypeOf() {
      throw new Error(`cave_adapter_conformance_invalid:${proxySecret}`);
    },
  });
  assert.throws(
    () => canonicalSerialize(hostileRecord),
    (error) => {
      assert.equal(
        error.message,
        "cave_adapter_conformance_invalid:canonical_descriptor_read",
      );
      assert.doesNotMatch(error.message, new RegExp(proxySecret));
      return true;
    },
  );
  await assert.rejects(
    runAdapterConformance({ ...fixture(["abort"]), adapter: hostileRecord }),
    (error) => {
      assert.equal(
        error.message,
        "cave_adapter_conformance_invalid:adapter_descriptor_read",
      );
      assert.doesNotMatch(error.message, new RegExp(proxySecret));
      return true;
    },
  );

  const hostileArtifact = new Proxy(new Uint8Array([1]), {
    get(target, key, receiver) {
      if (key === "byteLength") throw new Error(proxySecret);
      return Reflect.get(target, key, receiver);
    },
  });
  assert.throws(
    () => computeArtifactSHA256(hostileArtifact),
    (error) => {
      assert.equal(error.message, "cave_adapter_conformance_invalid:artifact");
      assert.doesNotMatch(error.message, new RegExp(proxySecret));
      return true;
    },
  );

  let getterCalls = 0;
  const input = fixture(["abort"]);
  Object.defineProperty(input.adapter, "version", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return getterCalls === 1 ? "1.2.3" : "9.9.9";
    },
  });
  await assert.rejects(
    runAdapterConformance(input),
    /cave_adapter_conformance_invalid:adapter_data_descriptor/,
  );
  assert.equal(getterCalls, 0);

  let resultGetterCalls = 0;
  const accessorResult = {};
  Object.defineProperty(accessorResult, "status", {
    enumerable: true,
    get() { resultGetterCalls += 1; return "passed"; },
  });
  const accessorCases = vectorCases(["abort"]);
  accessorCases[0] = { id: accessorCases[0].id, run: () => accessorResult };
  const resultReport = await runAdapterConformance(fixture(["abort"], {
    cases: accessorCases,
  }));
  assert.equal(resultReport.capabilities[0].cases[0].code, "case_result_invalid");
  assert.equal(resultGetterCalls, 0);

  const report = await runAdapterConformance(fixture(["abort"]));
  const accessorReport = JSON.parse(JSON.stringify(report));
  let reportGetterCalls = 0;
  Object.defineProperty(accessorReport.capabilities[0].qualification, "status", {
    enumerable: true,
    get() {
      reportGetterCalls += 1;
      return reportGetterCalls === 1 ? "passed" : "blocked";
    },
  });
  assert.throws(
    () => defineConformanceReport(accessorReport),
    /cave_adapter_conformance_invalid:report_data_descriptor/,
  );
  assert.equal(reportGetterCalls, 0);

  const symbolReport = JSON.parse(JSON.stringify(report));
  symbolReport[Symbol("extra")] = true;
  assert.throws(
    () => defineConformanceReport(symbolReport),
    /cave_adapter_conformance_invalid:report_symbol/,
  );
  assert.throws(
    () => defineConformanceReport(Object.assign(Object.create({}), report)),
    /cave_adapter_conformance_invalid:report_prototype/,
  );

  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => canonicalSerialize(cycle), /canonical_cycle/);
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => canonicalSerialize(sparse), /canonical_sparse_array/);
});

test("report validation returns detached snapshot and rejects mutation", async () => {
  const report = await runAdapterConformance(fixture(["abort"]));
  const source = JSON.parse(JSON.stringify(report));
  const defined = defineConformanceReport(source);
  source.adapter.version = "9.9.9";
  assert.equal(defined.adapter.version, "1.2.3");
  assert.equal(Object.isFrozen(defined.adapter), true);

  assert.throws(
    () => defineConformanceReport({ ...report, unexpected: true }),
    /cave_adapter_conformance_invalid:report_keys/,
  );
  assert.throws(
    () => defineConformanceReport({
      ...report,
      testVector: { ...report.testVector, sha256: "d".repeat(64) },
    }),
    /cave_adapter_conformance_invalid:test_vector/,
  );
  assert.throws(
    () => defineConformanceReport({ ...report, reportDigest: `sha256:${"0".repeat(64)}` }),
    /cave_adapter_conformance_invalid:report_digest_mismatch/,
  );
});

test("canonical serializer rejects ambiguous or non-JSON input without getters", () => {
  assert.equal(
    canonicalSerialize({ z: 1, a: { y: true, x: null } }),
    '{"a":{"x":null,"y":true},"z":1}',
  );
  assert.throws(() => canonicalSerialize(undefined), /canonical_type/);
  assert.throws(() => canonicalSerialize(Number.NaN), /canonical_number/);
  assert.throws(() => canonicalSerialize(new Date()), /canonical_prototype/);
  let calls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "secret", {
    enumerable: true,
    get() { calls += 1; return "secret"; },
  });
  assert.throws(() => canonicalSerialize(accessor), /canonical_data_descriptor/);
  assert.equal(calls, 0);
});

test("source has narrow runtime dependencies and no ambient environment reads", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.deepEqual(
    [...source.matchAll(/from "([^"]+)";/g)].map((match) => match[1]),
    ["node:crypto", "@caveman-ai/adapter-kit"],
  );
  assert.doesNotMatch(source, /process\.env|node:(?:http|https|net|tls|child_process)/);
});
