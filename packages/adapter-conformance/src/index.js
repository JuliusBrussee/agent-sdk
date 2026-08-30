import { createHash } from "node:crypto";

import { ADAPTER_CAPABILITIES } from "@caveman-ai/adapter-kit";

export const ADAPTER_CONFORMANCE_CANDIDATE_SUITE =
  "@caveman-ai/adapter-conformance/candidate/v4";
export const ADAPTER_CONFORMANCE_REPORT_SCHEMA =
  "caveman.adapter-conformance.report.v4";

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_DEPTH = 64;
const MAX_SNAPSHOT_NODES = 16_384;
const MAX_SNAPSHOT_STRING_LENGTH = 1024 * 1024;
const readMonotonicNanoseconds = process.hrtime.bigint.bind(process.hrtime);

const CASE_DEFINITIONS = Object.freeze([
  caseDefinition("runLifecycle", "run-lifecycle.success"),
  caseDefinition("runLifecycle", "run-lifecycle.failure"),
  caseDefinition("modelInterception", "model-interception.request"),
  caseDefinition("modelInterception", "model-interception.response"),
  caseDefinition("modelInterception", "model-interception.error"),
  caseDefinition("contextTransformation", "context-transformation.deterministic"),
  caseDefinition("contextTransformation", "context-transformation.cache-prefix-stable"),
  caseDefinition("toolObservation", "tool-observation.success"),
  caseDefinition("toolObservation", "tool-observation.failure"),
  caseDefinition("usageAccounting", "usage-accounting.known"),
  caseDefinition("usageAccounting", "usage-accounting.unknown-fails-closed"),
  caseDefinition("streaming", "streaming.ordered-chunks"),
  caseDefinition("streaming", "streaming.terminal"),
  caseDefinition("streaming", "streaming.error"),
  caseDefinition("abort", "abort.pre-start"),
  caseDefinition("abort", "abort.in-flight"),
  caseDefinition("replayAwareness", "replay-awareness.attempt"),
  caseDefinition("replayAwareness", "replay-awareness.marker"),
  caseDefinition("durableObservation", "durable-observation.checkpoint"),
  caseDefinition("durableObservation", "durable-observation.resume"),
  caseDefinition("tracing", "tracing.run-model-tool"),
  caseDefinition("tracing", "tracing.error"),
  caseDefinition("compilation", "compilation.stable-output"),
  caseDefinition("compilation", "compilation.unsupported-input"),
]);

const PERFORMANCE_DEFINITIONS = Object.freeze([
  performanceDefinition("runLifecycle", "run-lifecycle.hook-overhead-p99", 100),
  performanceDefinition(
    "modelInterception",
    "model-interception.hook-overhead-p99",
    100,
  ),
  performanceDefinition(
    "contextTransformation",
    "context-transformation.hook-overhead-p99",
    250,
  ),
  performanceDefinition("toolObservation", "tool-observation.hook-overhead-p99", 100),
  performanceDefinition(
    "usageAccounting",
    "usage-accounting.hook-overhead-p99",
    100,
  ),
  performanceDefinition("streaming", "streaming.chunk-overhead-p99", 50, 10_000),
  performanceDefinition("tracing", "tracing.hook-overhead-p99", 100),
]);

const TEST_VECTOR_BODY = deepFreeze({
  id: "adapter-capabilities-v4",
  version: "4.0.0",
  cases: CASE_DEFINITIONS,
  performance: PERFORMANCE_DEFINITIONS,
});

export const ADAPTER_CONFORMANCE_TEST_VECTOR = deepFreeze({
  ...TEST_VECTOR_BODY,
  sha256: digestJSON(TEST_VECTOR_BODY),
});

const REPORT_KEYS = Object.freeze([
  "schema",
  "suite",
  "adapter",
  "upstream",
  "environment",
  "packages",
  "testVector",
  "capabilities",
  "performance",
  "totals",
  "reportDigest",
]);
const BODY_KEYS = Object.freeze(REPORT_KEYS.filter((key) => key !== "reportDigest"));
const INPUT_KEYS = Object.freeze([
  "adapter",
  "upstream",
  "artifacts",
  "capabilities",
  "cases",
  "performance",
]);
const SUBJECT_KEYS = Object.freeze(["id", "packageName", "version"]);
const UPSTREAM_KEYS = Object.freeze(["packageName", "version"]);
const ARTIFACT_KEYS = Object.freeze(["adapter", "upstream"]);
const ENVIRONMENT_KEYS = Object.freeze(["runtime", "platform", "execution"]);
const RUNTIME_KEYS = Object.freeze(["name", "version"]);
const PLATFORM_KEYS = Object.freeze(["name", "architecture"]);
const PACKAGE_KEYS = Object.freeze(["role", "name", "version", "sha256"]);
const VECTOR_REPORT_KEYS = Object.freeze([
  "id",
  "version",
  "sha256",
  "executedSetSHA256",
]);
const CAPABILITY_KEYS = Object.freeze([
  "name",
  "cases",
  "caseCounts",
  "performanceCounts",
  "qualification",
]);
const CASE_OUTPUT_KEYS = Object.freeze([
  "id",
  "status",
  "code",
  "evidenceSHA256",
]);
const COUNTS_KEYS = Object.freeze(["passed", "failed", "skipped", "total"]);
const QUALIFICATION_KEYS = Object.freeze(["status", "blockers"]);
const PERFORMANCE_OUTPUT_KEYS = Object.freeze([
  "id",
  "capability",
  "metric",
  "unit",
  "clock",
  "percentile",
  "warmupCount",
  "requiredSampleCount",
  "sampleCount",
  "observed",
  "threshold",
  "status",
  "code",
]);
const THRESHOLD_KEYS = Object.freeze(["operator", "value"]);
const TOTAL_KEYS = Object.freeze(["capabilities", "cases", "performance"]);
const CAPABILITY_TOTAL_KEYS = Object.freeze(["passed", "blocked", "total"]);
const RESULT_STATES = Object.freeze(["passed", "failed", "skipped"]);
const SAFE_RESULT_CODES = new Set([
  "adapter_error",
  "assertion_failed",
  "fixture_unavailable",
  "runtime_unavailable",
  "timeout",
  "upstream_error",
  "upstream_unavailable",
]);
const INTERNAL_CASE_CODES = new Set([
  ...SAFE_RESULT_CODES,
  "case_failed",
  "case_result_invalid",
  "case_result_missing",
  "case_skipped",
  "case_threw",
]);
const INTERNAL_PERFORMANCE_CODES = new Set([
  ...SAFE_RESULT_CODES,
  "performance_callback_result_invalid",
  "performance_callback_threw",
  "performance_skipped",
  "performance_threshold_failed",
]);
const HEX_64 = /^[0-9a-f]{64}$/;
const CANDIDATE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
// Reports bind executed bytes to one immutable upstream release. Dist-tags,
// ranges, partial versions, and leading-zero numeric identifiers are not
// reproducible package identities.
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const CAPABILITY_INDEX = new Map(
  ADAPTER_CAPABILITIES.map((capability, index) => [capability, index]),
);
const CASE_BY_ID = uniqueDefinitions(CASE_DEFINITIONS, "case");
const PERFORMANCE_BY_ID = uniqueDefinitions(PERFORMANCE_DEFINITIONS, "performance");
validateSuiteDefinition();

/**
 * Canonical JSON serialization. Object keys sort by UTF-16 code unit order;
 * arrays retain semantic order. Non-JSON values, sparse arrays, cycles, and
 * custom prototypes fail closed.
 */
export function canonicalSerialize(value) {
  return serializeCanonicalSnapshot(snapshotCanonicalData(value, "canonical"));
}

/** Hash artifact bytes. Textual digest claims are never accepted as evidence. */
export function computeArtifactSHA256(bytes) {
  return hashArtifactBytes(snapshotArtifactBytes(bytes, "artifact"));
}

/** Runtime evidence derived from current Node process. */
export function createNodeConformanceEnvironment() {
  if (arguments.length !== 0) {
    throw new Error("cave_adapter_conformance_invalid:environment_arguments");
  }
  return deepFreeze({
    runtime: { name: "node", version: process.versions.node },
    platform: { name: process.platform, architecture: process.arch },
    execution: "uncontained-host",
  });
}

/**
 * Execute complete canonical vectors for selected capabilities. Cases receive
 * immutable suite metadata and must return non-empty evidence bytes to pass.
 */
export async function runAdapterConformance(input) {
  const environment = createNodeConformanceEnvironment();
  const snapshot = snapshotInput(input);
  const caseResults = [];

  for (const testCase of snapshot.cases) {
    try {
      const result = await testCase.run(testCase.vector);
      caseResults.push(normalizeCaseResult(testCase.id, result));
    } catch {
      caseResults.push(caseFailure(testCase.id, "case_threw"));
    }
  }

  const performance = snapshot.performance.map(measurePerformanceResult);
  const capabilities = snapshot.capabilities.map((name) => {
    const cases = CASE_DEFINITIONS
      .filter((definition) => definition.capability === name)
      .map((definition) => caseResults.find((result) => result.id === definition.id));
    const capabilityPerformance = performance.filter((result) =>
      result.capability === name);
    const caseCounts = countStatuses(cases);
    const performanceCounts = countStatuses(capabilityPerformance);
    const blockers = qualificationBlockers(caseCounts, performanceCounts);
    return {
      name,
      cases,
      caseCounts,
      performanceCounts,
      qualification: {
        status: blockers.length === 0 ? "passed" : "blocked",
        blockers,
      },
    };
  });

  const body = {
    schema: ADAPTER_CONFORMANCE_REPORT_SCHEMA,
    suite: ADAPTER_CONFORMANCE_CANDIDATE_SUITE,
    adapter: snapshot.adapter,
    upstream: snapshot.upstream,
    environment,
    packages: snapshot.packages,
    testVector: {
      id: ADAPTER_CONFORMANCE_TEST_VECTOR.id,
      version: ADAPTER_CONFORMANCE_TEST_VECTOR.version,
      sha256: ADAPTER_CONFORMANCE_TEST_VECTOR.sha256,
      executedSetSHA256: digestJSON(executedSet(snapshot.capabilities)),
    },
    capabilities,
    performance,
    totals: {
      capabilities: {
        passed: capabilities.filter((item) =>
          item.qualification.status === "passed").length,
        blocked: capabilities.filter((item) =>
          item.qualification.status === "blocked").length,
        total: capabilities.length,
      },
      cases: countStatuses(caseResults),
      performance: countStatuses(performance),
    },
  };
  return defineConformanceReport({
    ...body,
    reportDigest: candidateDigest(body),
  });
}

/** Validate, snapshot, and deeply freeze report including self digest. */
export function defineConformanceReport(value) {
  const snapshot = snapshotCanonicalData(value, "report");
  requireRecord(snapshot, "report");
  requireExactKeys(snapshot, REPORT_KEYS, "report");
  const { reportDigest, ...body } = snapshot;
  validateReportBody(body);
  requireMatch(reportDigest, CANDIDATE_DIGEST, "report_digest");
  const expected = candidateDigestDetached(body);
  if (reportDigest !== expected) {
    throw new Error("cave_adapter_conformance_invalid:report_digest_mismatch");
  }
  return deepFreeze(snapshot);
}

/** Compute report-body digest. Input may be body or full report. */
export function computeConformanceReportDigest(value) {
  const snapshot = snapshotCanonicalData(value, "report");
  requireRecord(snapshot, "report");
  const keys = Object.keys(snapshot).sort();
  const reportKeys = [...REPORT_KEYS].sort();
  const bodyKeys = [...BODY_KEYS].sort();
  let body;
  if (sameStrings(keys, reportKeys)) {
    const { reportDigest: _digest, ...withoutDigest } = snapshot;
    body = withoutDigest;
  } else if (sameStrings(keys, bodyKeys)) {
    body = snapshot;
  } else {
    throw new Error("cave_adapter_conformance_invalid:report_keys");
  }
  validateReportBody(body);
  return candidateDigestDetached(body);
}

function snapshotInput(value) {
  const input = readExactDataRecord(value, INPUT_KEYS, "input");
  const adapter = validateAdapter(input.adapter);
  const upstream = validateUpstream(input.upstream);
  const packages = validateArtifacts(input.artifacts, adapter, upstream);
  const capabilities = validateCapabilities(snapshotDataArray(
    input.capabilities,
    "capabilities",
  ));
  const cases = validateCases(input.cases, capabilities);
  const performance = validatePerformanceInput(input.performance, capabilities);
  return deepFreeze({ adapter, upstream, packages, capabilities, cases, performance });
}

function validateReportBody(value) {
  requireExactKeys(value, BODY_KEYS, "report_body");
  if (value.schema !== ADAPTER_CONFORMANCE_REPORT_SCHEMA ||
      value.suite !== ADAPTER_CONFORMANCE_CANDIDATE_SUITE) {
    throw new Error("cave_adapter_conformance_invalid:report_schema");
  }
  const adapter = validateAdapter(value.adapter);
  const upstream = validateUpstream(value.upstream);
  validateEnvironment(value.environment);
  validatePackages(value.packages, adapter, upstream);
  validateReportTestVector(value.testVector);
  requireArray(value.capabilities, "report_capabilities");
  requireArray(value.performance, "report_performance");

  const names = value.capabilities.map((capability) => capability?.name);
  validateCapabilities(names, true);
  const selected = new Set(names);
  const seenCases = new Set();
  for (const capability of value.capabilities) {
    requireRecord(capability, "report_capability");
    requireExactKeys(capability, CAPABILITY_KEYS, "report_capability");
    requireCapability(capability.name, "report_capability_name");
    requireArray(capability.cases, "report_cases");
    const expectedCases = CASE_DEFINITIONS.filter((definition) =>
      definition.capability === capability.name);
    if (capability.cases.length !== expectedCases.length) {
      throw new Error("cave_adapter_conformance_invalid:report_case_coverage");
    }
    capability.cases.forEach((result, index) => {
      validateCaseOutput(result);
      if (result.id !== expectedCases[index].id || seenCases.has(result.id)) {
        throw new Error("cave_adapter_conformance_invalid:report_case_coverage");
      }
      seenCases.add(result.id);
    });
    const caseCounts = countStatuses(capability.cases);
    validateCounts(capability.caseCounts, caseCounts, "report_case_counts");
    requireRecord(capability.qualification, "report_qualification");
    requireExactKeys(
      capability.qualification,
      QUALIFICATION_KEYS,
      "report_qualification",
    );
    requireArray(capability.qualification.blockers, "report_qualification_blockers");
  }

  const expectedPerformance = PERFORMANCE_DEFINITIONS.filter((definition) =>
    selected.has(definition.capability));
  if (value.performance.length !== expectedPerformance.length) {
    throw new Error("cave_adapter_conformance_invalid:report_performance_coverage");
  }
  value.performance.forEach((result, index) => {
    validatePerformanceOutput(result, expectedPerformance[index]);
  });

  for (const capability of value.capabilities) {
    const performanceCounts = countStatuses(value.performance.filter((result) =>
      result.capability === capability.name));
    validateCounts(
      capability.performanceCounts,
      performanceCounts,
      "report_performance_counts",
    );
    const blockers = qualificationBlockers(
      capability.caseCounts,
      capability.performanceCounts,
    );
    const expectedStatus = blockers.length === 0 ? "passed" : "blocked";
    if (capability.qualification.status !== expectedStatus ||
        !sameStrings(capability.qualification.blockers, blockers)) {
      throw new Error("cave_adapter_conformance_invalid:report_qualification");
    }
  }

  validateTotals(value.totals, value.capabilities, value.performance);
  const expectedExecutedSet = digestJSON(executedSet(names));
  if (value.testVector.executedSetSHA256 !== expectedExecutedSet) {
    throw new Error("cave_adapter_conformance_invalid:executed_set_sha256");
  }
}

function validateAdapter(value) {
  const fields = readExactDataRecord(value, SUBJECT_KEYS, "adapter");
  requireMatch(fields.id, ID, "adapter_id");
  requireMatch(fields.packageName, PACKAGE_NAME, "adapter_package");
  requireMatch(fields.version, VERSION, "adapter_version");
  return {
    id: fields.id,
    packageName: fields.packageName,
    version: fields.version,
  };
}

function validateUpstream(value) {
  const fields = readExactDataRecord(value, UPSTREAM_KEYS, "upstream");
  requireMatch(fields.packageName, PACKAGE_NAME, "upstream_package");
  requireMatch(fields.version, VERSION, "upstream_version");
  return { packageName: fields.packageName, version: fields.version };
}

function validateArtifacts(value, adapter, upstream) {
  const artifacts = readExactDataRecord(value, ARTIFACT_KEYS, "artifacts");
  const adapterBytes = snapshotArtifactBytes(artifacts.adapter, "adapter_artifact");
  const upstreamBytes = snapshotArtifactBytes(artifacts.upstream, "upstream_artifact");
  return deepFreeze([
    {
      role: "adapter",
      name: adapter.packageName,
      version: adapter.version,
      sha256: hashArtifactBytes(adapterBytes),
    },
    {
      role: "upstream",
      name: upstream.packageName,
      version: upstream.version,
      sha256: hashArtifactBytes(upstreamBytes),
    },
  ]);
}

function validatePackages(value, adapter, upstream) {
  requireArray(value, "packages");
  if (value.length !== 2) {
    throw new Error("cave_adapter_conformance_invalid:packages_count");
  }
  const expected = [
    { role: "adapter", name: adapter.packageName, version: adapter.version },
    { role: "upstream", name: upstream.packageName, version: upstream.version },
  ];
  value.forEach((item, index) => {
    requireRecord(item, "package");
    requireExactKeys(item, PACKAGE_KEYS, "package");
    requireMatch(item.sha256, HEX_64, "package_sha256");
    if (item.role !== expected[index].role || item.name !== expected[index].name ||
        item.version !== expected[index].version) {
      throw new Error("cave_adapter_conformance_invalid:packages_subject_mismatch");
    }
  });
}

function validateEnvironment(value) {
  requireRecord(value, "environment");
  requireExactKeys(value, ENVIRONMENT_KEYS, "environment");
  requireRecord(value.runtime, "environment_runtime");
  requireExactKeys(value.runtime, RUNTIME_KEYS, "environment_runtime");
  if (value.runtime.name !== "node") {
    throw new Error("cave_adapter_conformance_invalid:environment_runtime_name");
  }
  requireMatch(value.runtime.version, VERSION, "environment_runtime_version");
  requireRecord(value.platform, "environment_platform");
  requireExactKeys(value.platform, PLATFORM_KEYS, "environment_platform");
  requireMatch(value.platform.name, ID, "environment_platform_name");
  requireMatch(value.platform.architecture, ID, "environment_platform_architecture");
  if (value.execution !== "uncontained-host") {
    throw new Error("cave_adapter_conformance_invalid:environment_execution");
  }
}

function validateReportTestVector(value) {
  requireRecord(value, "report_test_vector");
  requireExactKeys(value, VECTOR_REPORT_KEYS, "report_test_vector");
  if (value.id !== ADAPTER_CONFORMANCE_TEST_VECTOR.id ||
      value.version !== ADAPTER_CONFORMANCE_TEST_VECTOR.version ||
      value.sha256 !== ADAPTER_CONFORMANCE_TEST_VECTOR.sha256) {
    throw new Error("cave_adapter_conformance_invalid:test_vector");
  }
  requireMatch(value.executedSetSHA256, HEX_64, "executed_set_sha256");
}

function validateCapabilities(value, requireCanonical = false) {
  requireArray(value, "capabilities");
  if (value.length === 0) {
    throw new Error("cave_adapter_conformance_invalid:capabilities_empty");
  }
  const capabilities = value.map((capability) => {
    requireCapability(capability, "capability");
    return capability;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error("cave_adapter_conformance_invalid:capabilities_duplicate");
  }
  const canonical = [...capabilities].sort(compareCapability);
  if (requireCanonical && !sameStrings(capabilities, canonical)) {
    throw new Error("cave_adapter_conformance_invalid:capabilities_order");
  }
  return canonical;
}

function validateCases(value, capabilities) {
  const sourceCases = snapshotDataArray(value, "cases");
  const selected = new Set(capabilities);
  const expected = CASE_DEFINITIONS.filter((definition) =>
    selected.has(definition.capability));
  const runners = new Map();
  for (const sourceCase of sourceCases) {
    const testCase = readExactDataRecord(sourceCase, ["id", "run"], "case");
    const definition = CASE_BY_ID.get(testCase.id);
    if (definition === undefined || !selected.has(definition.capability)) {
      throw new Error("cave_adapter_conformance_invalid:case_unknown");
    }
    if (runners.has(testCase.id)) {
      throw new Error("cave_adapter_conformance_invalid:duplicate_case");
    }
    if (typeof testCase.run !== "function") {
      throw new Error("cave_adapter_conformance_invalid:case_runner");
    }
    runners.set(testCase.id, testCase.run);
  }
  if (runners.size !== expected.length ||
      expected.some((definition) => !runners.has(definition.id))) {
    throw new Error("cave_adapter_conformance_invalid:case_coverage");
  }
  return expected.map((definition) => Object.freeze({
    id: definition.id,
    run: runners.get(definition.id),
    vector: deepFreeze({
      id: definition.id,
      capability: definition.capability,
      testVectorSHA256: ADAPTER_CONFORMANCE_TEST_VECTOR.sha256,
    }),
  }));
}

function validatePerformanceInput(value, capabilities) {
  const sourcePerformance = snapshotDataArray(value, "performance");
  const selected = new Set(capabilities);
  const expected = PERFORMANCE_DEFINITIONS.filter((definition) =>
    selected.has(definition.capability));
  const inputs = new Map();
  for (const sourceItem of sourcePerformance) {
    const item = readDataRecord(sourceItem, "performance");
    const hasRun = Object.hasOwn(item, "run");
    const hasSkipped = Object.hasOwn(item, "skipped");
    if (hasRun === hasSkipped) {
      throw new Error("cave_adapter_conformance_invalid:performance_result");
    }
    requireExactKeys(
      item,
      ["id", hasRun ? "run" : "skipped"],
      "performance",
    );
    const definition = PERFORMANCE_BY_ID.get(item.id);
    if (definition === undefined || !selected.has(definition.capability)) {
      throw new Error("cave_adapter_conformance_invalid:performance_unknown");
    }
    if (inputs.has(item.id)) {
      throw new Error("cave_adapter_conformance_invalid:duplicate_performance");
    }
    if (hasRun) {
      if (typeof item.run !== "function") {
        throw new Error("cave_adapter_conformance_invalid:performance_runner");
      }
      inputs.set(item.id, {
        ...definition,
        run: item.run,
      });
    } else {
      const skipped = readExactDataRecord(
        item.skipped,
        ["code"],
        "performance_skipped",
      );
      inputs.set(item.id, {
        ...definition,
        skipped: { code: sanitizeResultCode(skipped.code, "performance_skipped") },
      });
    }
  }
  if (inputs.size !== expected.length ||
      expected.some((definition) => !inputs.has(definition.id))) {
    throw new Error("cave_adapter_conformance_invalid:performance_coverage");
  }
  return expected.map((definition) => inputs.get(definition.id));
}

function normalizeCaseResult(id, value) {
  if (value === undefined) return caseFailure(id, "case_result_missing");
  let result;
  try {
    result = readDataRecord(value, "case_result_input");
  } catch {
    return caseFailure(id, "case_result_invalid");
  }
  if (result.status === "passed" && exactKeys(result, ["status", "evidence"]) &&
      isArtifactBytes(result.evidence) && result.evidence.byteLength > 0 &&
      result.evidence.byteLength <= MAX_EVIDENCE_BYTES) {
    return {
      id,
      status: "passed",
      code: null,
      evidenceSHA256: computeArtifactSHA256(new Uint8Array(result.evidence)),
    };
  }
  if ((result.status === "failed" || result.status === "skipped") &&
      exactKeys(result, ["status", "code"])) {
    return {
      id,
      status: result.status,
      code: sanitizeResultCode(
        result.code,
        result.status === "failed" ? "case_failed" : "case_skipped",
      ),
      evidenceSHA256: null,
    };
  }
  return caseFailure(id, "case_result_invalid");
}

function caseFailure(id, code) {
  return { id, status: "failed", code, evidenceSHA256: null };
}

function measurePerformanceResult(value) {
  const common = {
    id: value.id,
    capability: value.capability,
    metric: value.metric,
    unit: value.unit,
    clock: value.clock,
    percentile: value.percentile,
    warmupCount: value.warmupCount,
    requiredSampleCount: value.sampleCount,
    threshold: value.threshold,
  };
  if (value.skipped !== undefined) {
    return {
      ...common,
      sampleCount: 0,
      observed: null,
      status: "skipped",
      code: value.skipped.code,
    };
  }

  const vector = deepFreeze({
    id: value.id,
    capability: value.capability,
    testVectorSHA256: ADAPTER_CONFORMANCE_TEST_VECTOR.sha256,
  });
  for (let index = 0; index < value.warmupCount; index += 1) {
    let result;
    try {
      result = value.run(vector);
    } catch {
      return performanceCallbackFailure(common, "performance_callback_threw", 0);
    }
    if (result !== undefined) {
      return performanceCallbackFailure(
        common,
        "performance_callback_result_invalid",
        0,
      );
    }
  }

  const samples = new Float64Array(value.sampleCount);
  for (let index = 0; index < value.sampleCount; index += 1) {
    const started = readMonotonicNanoseconds();
    let result;
    try {
      result = value.run(vector);
    } catch {
      return performanceCallbackFailure(
        common,
        "performance_callback_threw",
        index,
      );
    }
    const finished = readMonotonicNanoseconds();
    if (result !== undefined) {
      return performanceCallbackFailure(
        common,
        "performance_callback_result_invalid",
        index,
      );
    }
    samples[index] = Number(finished - started) / 1_000;
  }
  samples.sort();
  const percentileIndex = Math.ceil((value.percentile / 100) * samples.length) - 1;
  const observed = samples[percentileIndex];
  const passed = compareThreshold(
    observed,
    value.threshold.operator,
    value.threshold.value,
  );
  return {
    ...common,
    sampleCount: value.sampleCount,
    observed,
    status: passed ? "passed" : "failed",
    code: passed ? null : "performance_threshold_failed",
  };
}

function performanceCallbackFailure(common, code, sampleCount) {
  return {
    ...common,
    sampleCount,
    observed: null,
    status: "failed",
    code,
  };
}

function validateMeasuredPerformanceFailure(value, definition) {
  if (value.status !== "failed" || value.observed !== null ||
      !Number.isSafeInteger(value.sampleCount) || value.sampleCount < 0 ||
      value.sampleCount >= definition.sampleCount ||
      (value.code !== "performance_callback_threw" &&
       value.code !== "performance_callback_result_invalid")) {
    throw new Error("cave_adapter_conformance_invalid:performance_callback_failure");
  }
}

function validateCaseOutput(value) {
  requireRecord(value, "case_result");
  requireExactKeys(value, CASE_OUTPUT_KEYS, "case_result");
  requireMatch(value.id, ID, "case_result_id");
  requireOneOf(value.status, RESULT_STATES, "case_result_status");
  if (value.status === "passed") {
    if (value.code !== null) {
      throw new Error("cave_adapter_conformance_invalid:case_result_code");
    }
    requireMatch(value.evidenceSHA256, HEX_64, "case_evidence_sha256");
  } else if (!INTERNAL_CASE_CODES.has(value.code) || value.evidenceSHA256 !== null) {
    throw new Error("cave_adapter_conformance_invalid:case_result_code");
  }
}

function validatePerformanceOutput(value, definition) {
  requireRecord(value, "performance_result");
  requireExactKeys(value, PERFORMANCE_OUTPUT_KEYS, "performance_result");
  if (value.id !== definition.id || value.capability !== definition.capability ||
      value.metric !== definition.metric || value.unit !== definition.unit ||
      value.clock !== definition.clock ||
      value.percentile !== definition.percentile ||
      value.warmupCount !== definition.warmupCount ||
      value.requiredSampleCount !== definition.sampleCount ||
      !sameThreshold(value.threshold, definition.threshold)) {
    throw new Error("cave_adapter_conformance_invalid:performance_definition");
  }
  requireOneOf(value.status, RESULT_STATES, "performance_result_status");
  if (value.status === "skipped") {
    if (value.sampleCount !== 0 || value.observed !== null ||
        !INTERNAL_PERFORMANCE_CODES.has(value.code)) {
      throw new Error("cave_adapter_conformance_invalid:performance_skipped_value");
    }
    return;
  }
  if (value.code === "performance_callback_threw" ||
      value.code === "performance_callback_result_invalid") {
    validateMeasuredPerformanceFailure(value, definition);
    return;
  }
  requirePositiveInteger(value.sampleCount, "performance_sample_count");
  requireNonNegativeFinite(value.observed, "performance_observed");
  if (value.sampleCount !== definition.sampleCount) {
    throw new Error("cave_adapter_conformance_invalid:performance_sample_count");
  }
  let expectedStatus;
  let expectedCode;
  if (compareThreshold(
    value.observed,
    definition.threshold.operator,
    definition.threshold.value,
  )) {
    expectedStatus = "passed";
    expectedCode = null;
  } else {
    expectedStatus = "failed";
    expectedCode = "performance_threshold_failed";
  }
  if (value.status !== expectedStatus || value.code !== expectedCode) {
    throw new Error("cave_adapter_conformance_invalid:performance_status");
  }
}

function qualificationBlockers(caseCounts, performanceCounts) {
  const blockers = [];
  if (caseCounts.failed > 0) blockers.push("case_failed");
  if (caseCounts.skipped > 0) blockers.push("case_skipped");
  if (performanceCounts.failed > 0) blockers.push("performance_failed");
  if (performanceCounts.skipped > 0) blockers.push("performance_skipped");
  return blockers.sort();
}

function validateTotals(value, capabilities, performance) {
  requireRecord(value, "totals");
  requireExactKeys(value, TOTAL_KEYS, "totals");
  requireRecord(value.capabilities, "totals_capabilities");
  requireExactKeys(value.capabilities, CAPABILITY_TOTAL_KEYS, "totals_capabilities");
  validateIntegerRecord(value.capabilities, {
    passed: capabilities.filter((item) =>
      item.qualification.status === "passed").length,
    blocked: capabilities.filter((item) =>
      item.qualification.status === "blocked").length,
    total: capabilities.length,
  }, "totals_capabilities");
  validateCounts(
    value.cases,
    countStatuses(capabilities.flatMap((item) => item.cases)),
    "totals_cases",
  );
  validateCounts(value.performance, countStatuses(performance), "totals_performance");
}

function executedSet(capabilities) {
  const selected = new Set(capabilities);
  return {
    cases: CASE_DEFINITIONS.filter((item) => selected.has(item.capability)),
    performance: PERFORMANCE_DEFINITIONS.filter((item) =>
      selected.has(item.capability)),
  };
}

function caseDefinition(capability, id) {
  return Object.freeze({ capability, id });
}

function performanceDefinition(capability, id, threshold, sampleCount = 2_000) {
  return deepFreeze({
    capability,
    id,
    metric: "hook-overhead-p99",
    unit: "microseconds",
    clock: "node:process.hrtime.bigint:captured",
    percentile: 99,
    warmupCount: sampleCount >= 10_000 ? 1_000 : 250,
    sampleCount,
    threshold: { operator: "lte", value: threshold },
  });
}

function uniqueDefinitions(definitions, field) {
  const values = new Map();
  for (const definition of definitions) {
    if (values.has(definition.id)) {
      throw new Error(`cave_adapter_conformance_suite_invalid:duplicate_${field}`);
    }
    values.set(definition.id, definition);
  }
  return values;
}

function validateSuiteDefinition() {
  if (ADAPTER_CAPABILITIES.length !== 11 ||
      !CASE_DEFINITIONS.every((item) => CAPABILITY_INDEX.has(item.capability)) ||
      !PERFORMANCE_DEFINITIONS.every((item) => CAPABILITY_INDEX.has(item.capability)) ||
      !ADAPTER_CAPABILITIES.every((capability) =>
        CASE_DEFINITIONS.some((item) => item.capability === capability))) {
    throw new Error("cave_adapter_conformance_suite_invalid:capabilities");
  }
}

function compareCapability(left, right) {
  return CAPABILITY_INDEX.get(left) - CAPABILITY_INDEX.get(right);
}

function compareThreshold(observed, operator, threshold) {
  if (operator === "lte") return observed <= threshold;
  throw new Error("cave_adapter_conformance_suite_invalid:threshold_operator");
}

function sameThreshold(left, right) {
  return isRecord(left) && exactKeys(left, THRESHOLD_KEYS) &&
    left.operator === right.operator && left.value === right.value;
}

function sanitizeResultCode(value, fallback) {
  return typeof value === "string" && SAFE_RESULT_CODES.has(value) ? value : fallback;
}

function snapshotArtifactBytes(value, field) {
  try {
    if (!(value instanceof Uint8Array) || value.byteLength === 0) throw new Error();
    return new Uint8Array(value);
  } catch {
    throw new Error(`cave_adapter_conformance_invalid:${field}`);
  }
}

function hashArtifactBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isArtifactBytes(value) {
  return value instanceof Uint8Array;
}

function countStatuses(values) {
  const counts = { passed: 0, failed: 0, skipped: 0, total: values.length };
  for (const value of values) {
    if (!RESULT_STATES.includes(value.status)) {
      throw new Error("cave_adapter_conformance_invalid:result_status");
    }
    counts[value.status] += 1;
  }
  return counts;
}

function validateCounts(value, expected, field) {
  requireRecord(value, field);
  requireExactKeys(value, COUNTS_KEYS, field);
  validateIntegerRecord(value, expected, field);
}

function validateIntegerRecord(value, expected, field) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 ||
        value[key] !== expectedValue) {
      throw new Error(`cave_adapter_conformance_invalid:${field}`);
    }
  }
}

function digestJSON(value) {
  return createHash("sha256").update(canonicalSerialize(value)).digest("hex");
}

function candidateDigest(value) {
  return `sha256:${digestJSON(value)}`;
}

function candidateDigestDetached(value) {
  const sha256 = createHash("sha256")
    .update(serializeCanonicalSnapshot(value))
    .digest("hex");
  return `sha256:${sha256}`;
}

function snapshotCanonicalData(value, field) {
  return snapshotCanonicalValue(value, field, {
    ancestors: new Set(),
    nodes: 0,
  }, 0);
}

function snapshotCanonicalValue(value, field, state, depth) {
  if (depth > MAX_SNAPSHOT_DEPTH) {
    throw new Error(`cave_adapter_conformance_invalid:${field}_depth`);
  }
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length > MAX_SNAPSHOT_STRING_LENGTH) {
      throw new Error(`cave_adapter_conformance_invalid:${field}_string_length`);
    }
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`cave_adapter_conformance_invalid:${field}_number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`cave_adapter_conformance_invalid:${field}_type`);
  }
  state.nodes += 1;
  if (state.nodes > MAX_SNAPSHOT_NODES) {
    throw new Error(`cave_adapter_conformance_invalid:${field}_nodes`);
  }
  if (state.ancestors.has(value)) {
    throw new Error(`cave_adapter_conformance_invalid:${field}_cycle`);
  }
  state.ancestors.add(value);
  let snapshot;
  if (Array.isArray(value)) {
    snapshot = snapshotDataArray(value, field).map((item) =>
      snapshotCanonicalValue(item, field, state, depth + 1));
  } else {
    const fields = readDataRecord(value, field);
    snapshot = {};
    for (const [key, child] of Object.entries(fields)) {
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: snapshotCanonicalValue(child, field, state, depth + 1),
      });
    }
  }
  state.ancestors.delete(value);
  return snapshot;
}

function serializeCanonicalSnapshot(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalSnapshot).join(",")}]`;
  }
  const entries = Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${serializeCanonicalSnapshot(value[key])}`);
  return `{${entries.join(",")}}`;
}

function readExactDataRecord(value, keys, field) {
  const fields = readDataRecord(value, field);
  requireExactKeys(fields, keys, field);
  return fields;
}

function readDataRecord(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`cave_adapter_conformance_invalid:${field}`);
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(`cave_adapter_conformance_invalid:${field}_descriptor_read`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`cave_adapter_conformance_invalid:${field}_prototype`);
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new Error(`cave_adapter_conformance_invalid:${field}_symbol`);
  }
  const fields = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`cave_adapter_conformance_invalid:${field}_data_descriptor`);
    }
    Object.defineProperty(fields, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: descriptor.value,
    });
  }
  return fields;
}

function snapshotDataArray(value, field) {
  if (!Array.isArray(value)) {
    throw new Error(`cave_adapter_conformance_invalid:${field}`);
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(`cave_adapter_conformance_invalid:${field}_descriptor_read`);
  }
  if (prototype !== Array.prototype) {
    throw new Error(`cave_adapter_conformance_invalid:${field}_prototype`);
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new Error(`cave_adapter_conformance_invalid:${field}_symbol`);
  }
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
      lengthDescriptor.value > MAX_SNAPSHOT_NODES) {
    throw new Error(`cave_adapter_conformance_invalid:${field}_length`);
  }
  const length = lengthDescriptor.value;
  if (keys.length !== length + 1) {
    throw new Error(`cave_adapter_conformance_invalid:${field}_sparse_array`);
  }
  const result = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable ||
        !("value" in descriptor)) {
      throw new Error(`cave_adapter_conformance_invalid:${field}_data_descriptor`);
    }
    result[index] = descriptor.value;
  }
  return result;
}

function requireRecord(value, field) {
  if (!isRecord(value)) {
    throw new Error(`cave_adapter_conformance_invalid:${field}`);
  }
}

function requireArray(value, field) {
  if (!Array.isArray(value)) {
    throw new Error(`cave_adapter_conformance_invalid:${field}`);
  }
}

function requireExactKeys(value, keys, field) {
  if (!sameStrings(Object.keys(value).sort(), [...keys].sort())) {
    throw new Error(`cave_adapter_conformance_invalid:${field}_keys`);
  }
}

function requireMatch(value, pattern, field) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`cave_adapter_conformance_invalid:${field}`);
  }
}

function requireCapability(value, field) {
  if (typeof value !== "string" || !CAPABILITY_INDEX.has(value)) {
    throw new Error(`cave_adapter_conformance_invalid:${field}`);
  }
}

function requireOneOf(value, values, field) {
  if (!values.includes(value)) {
    throw new Error(`cave_adapter_conformance_invalid:${field}`);
  }
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`cave_adapter_conformance_invalid:${field}`);
  }
}

function requireNonNegativeFinite(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`cave_adapter_conformance_invalid:${field}`);
  }
}

function sameStrings(left, right) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function exactKeys(value, expected) {
  return sameStrings(Object.keys(value).sort(), [...expected].sort());
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
