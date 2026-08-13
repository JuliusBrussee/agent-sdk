#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(BENCH_DIR, "../../..");
const SPLITS = Object.freeze(["train", "dev", "held"]);
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;
const SAFE_SYMBOL = /^[a-z][a-z0-9_]*$/;
const APPROVED_TRAINING_USE_CONSTRAINT =
  "Evaluation fixture only. Not approved as model-training data.";
const APPROVED_CORPUS_ROLE = "synthetic_structural_rehearsal_fixture";

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) fail("cave_compiler_replay_schema", `${label} must be an object`);
}

function assertExactKeys(value, keys, label) {
  assertObject(value, label);
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "cave_compiler_replay_schema",
      `${label} keys=${actual.join(",")} expected=${expected.join(",")}`,
    );
  }
}

function assertString(value, label, pattern) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    fail("cave_compiler_replay_schema", `${label} is invalid`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("cave_compiler_replay_schema", `${label} must be a positive integer`);
  }
}

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortedObject(value[key])]),
  );
}

export function canonicalStringify(value) {
  return JSON.stringify(sortedObject(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJSON(path, label) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    fail("cave_compiler_replay_missing", `${label}: ${error.message}`);
  }
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    fail("cave_compiler_replay_schema", `${label}: ${error.message}`);
  }
}

function safeResolve(root, path, label) {
  assertString(path, label);
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    fail("cave_compiler_replay_path", `${label} escapes its root`);
  }
  return absolute;
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(current, entry.name);
    if (entry.isSymbolicLink()) {
      fail("cave_compiler_replay_path", `symlink forbidden in corpus: ${relative(root, path)}`);
    }
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
    else fail("cave_compiler_replay_path", `unsupported corpus entry: ${relative(root, path)}`);
  }
  return files;
}

function validateThirdParty(value) {
  assertExactKeys(value, ["schema", "corpus", "replay_fixture"], "third-party manifest");
  if (value.schema !== "cavebench.third-party-data.v1") {
    fail("cave_compiler_replay_schema", "unknown third-party manifest schema");
  }
  assertExactKeys(value.corpus, [
    "name", "source_url", "source_commit", "license", "license_url", "local_path",
    "manifest_sha256", "task_count", "notice_path", "redistribution",
    "training_use_constraint", "approved_role",
  ], "third-party corpus");
  for (const field of ["name", "source_url", "source_commit", "license", "license_url", "local_path", "notice_path", "redistribution", "training_use_constraint", "approved_role"]) {
    assertString(value.corpus[field], `third-party corpus.${field}`);
  }
  if (value.corpus.training_use_constraint !== APPROVED_TRAINING_USE_CONSTRAINT) {
    fail("cave_compiler_replay_schema", "third-party corpus training-use constraint is not approved");
  }
  if (value.corpus.approved_role !== APPROVED_CORPUS_ROLE) {
    fail("cave_compiler_replay_schema", "third-party corpus role is not approved");
  }
  assertString(value.corpus.manifest_sha256, "third-party corpus.manifest_sha256", HEX_SHA256);
  assertPositiveInteger(value.corpus.task_count, "third-party corpus.task_count");
  assertExactKeys(value.replay_fixture, ["path", "sha256", "provenance"], "replay fixture provenance");
  assertString(value.replay_fixture.path, "replay fixture.path");
  assertString(value.replay_fixture.sha256, "replay fixture.sha256", HEX_SHA256);
  assertString(value.replay_fixture.provenance, "replay fixture.provenance");
}

function validateCases(value) {
  assertExactKeys(value, [
    "schema", "declared_tool_schemas", "declared_context_segments", "expected_cardinality", "cases",
  ], "cases fixture");
  if (value.schema !== "cavebench.compiler-replay.cases.v1") {
    fail("cave_compiler_replay_schema", "unknown cases fixture schema");
  }
  if (!Array.isArray(value.declared_tool_schemas) || value.declared_tool_schemas.length === 0) {
    fail("cave_compiler_replay_schema", "declared_tool_schemas must be non-empty");
  }
  const tools = new Set();
  for (const [index, tool] of value.declared_tool_schemas.entries()) {
    assertExactKeys(tool, ["name", "bytes"], `declared_tool_schemas[${index}]`);
    assertString(tool.name, `declared_tool_schemas[${index}].name`, SAFE_SYMBOL);
    assertPositiveInteger(tool.bytes, `declared_tool_schemas[${index}].bytes`);
    if (tools.has(tool.name)) fail("cave_compiler_replay_schema", `duplicate tool ${tool.name}`);
    tools.add(tool.name);
  }
  if (!Array.isArray(value.declared_context_segments) || value.declared_context_segments.length === 0) {
    fail("cave_compiler_replay_schema", "declared_context_segments must be non-empty");
  }
  const contexts = new Set();
  let taskFileSegments = 0;
  for (const [index, context] of value.declared_context_segments.entries()) {
    assertExactKeys(context, ["kind", "bytes"], `declared_context_segments[${index}]`);
    assertString(context.kind, `declared_context_segments[${index}].kind`, SAFE_SYMBOL);
    if (context.bytes === "task_file") taskFileSegments++;
    else assertPositiveInteger(context.bytes, `declared_context_segments[${index}].bytes`);
    if (contexts.has(context.kind)) fail("cave_compiler_replay_schema", `duplicate context ${context.kind}`);
    contexts.add(context.kind);
  }
  if (taskFileSegments !== 1 || !value.declared_context_segments.some(({ kind, bytes }) => kind === "task" && bytes === "task_file")) {
    fail("cave_compiler_replay_schema", "exactly one task/task_file context segment is required");
  }
  assertExactKeys(value.expected_cardinality, SPLITS, "expected_cardinality");
  for (const split of SPLITS) assertPositiveInteger(value.expected_cardinality[split], `expected_cardinality.${split}`);
  if (!Array.isArray(value.cases)) fail("cave_compiler_replay_schema", "cases must be an array");
  for (const [index, item] of value.cases.entries()) {
    assertExactKeys(item, ["task_id", "family", "split", "required_context", "model_calls", "tool_sequence"], `cases[${index}]`);
    assertString(item.task_id, `cases[${index}].task_id`, SAFE_ID);
    assertString(item.family, `cases[${index}].family`, SAFE_ID);
    if (!SPLITS.includes(item.split)) fail("cave_compiler_replay_schema", `cases[${index}].split is invalid`);
    if (!Array.isArray(item.required_context) || item.required_context.length === 0 || new Set(item.required_context).size !== item.required_context.length) {
      fail("cave_compiler_replay_schema", `cases[${index}].required_context is invalid`);
    }
    for (const kind of item.required_context) {
      if (!contexts.has(kind)) fail("cave_compiler_replay_schema", `case ${item.task_id} requires unknown context ${kind}`);
    }
    assertPositiveInteger(item.model_calls, `cases[${index}].model_calls`);
    if (!Array.isArray(item.tool_sequence) || item.tool_sequence.length === 0) {
      fail("cave_compiler_replay_schema", `cases[${index}].tool_sequence is invalid`);
    }
    for (const tool of item.tool_sequence) {
      if (!tools.has(tool)) fail("cave_compiler_replay_schema", `case ${item.task_id} calls unknown tool ${tool}`);
    }
  }
}

async function validateCorpus({ corpusRoot, corpusManifestBytes, corpusManifest, provenance }) {
  if (sha256(corpusManifestBytes) !== provenance.corpus.manifest_sha256) {
    fail("cave_compiler_replay_hash", "corpus manifest hash mismatch");
  }
  assertObject(corpusManifest, "corpus manifest");
  if (corpusManifest.schema !== "cavebench.agent.corpus.v1" ||
      corpusManifest.source_repo !== provenance.corpus.source_url ||
      corpusManifest.source_sha !== provenance.corpus.source_commit ||
      corpusManifest.license !== provenance.corpus.license) {
    fail("cave_compiler_replay_provenance", "corpus source, commit, license, or schema mismatch");
  }
  if (!Array.isArray(corpusManifest.tasks) || corpusManifest.tasks.length !== provenance.corpus.task_count) {
    fail("cave_compiler_replay_cardinality", "corpus task count mismatch");
  }
  const taskInfo = new Map();
  for (const task of corpusManifest.tasks) {
    assertObject(task, "corpus task");
    assertString(task.id, "corpus task.id", SAFE_ID);
    if (taskInfo.has(task.id)) fail("cave_compiler_replay_cardinality", `duplicate corpus task ${task.id}`);
    assertObject(task.file_sha256, `corpus task ${task.id}.file_sha256`);
    const expectedFiles = Object.keys(task.file_sha256).sort();
    if (expectedFiles.length === 0 || !expectedFiles.includes(`${task.id}/task.md`)) {
      fail("cave_compiler_replay_provenance", `task ${task.id} lacks a pinned task.md`);
    }
    for (const file of expectedFiles) {
      if (!file.startsWith(`${task.id}/`)) fail("cave_compiler_replay_path", `task ${task.id} owns foreign path ${file}`);
      assertString(task.file_sha256[file], `${file} sha256`, HEX_SHA256);
      const actual = sha256(await readFile(safeResolve(corpusRoot, file, file)));
      if (actual !== task.file_sha256[file]) fail("cave_compiler_replay_hash", `${file} hash mismatch`);
    }
    const taskRoot = safeResolve(corpusRoot, task.id, `task ${task.id}`);
    const actualFiles = (await listFiles(taskRoot, taskRoot)).sort();
    const declaredForTask = expectedFiles.map((file) => file.slice(task.id.length + 1));
    if (JSON.stringify(actualFiles) !== JSON.stringify(declaredForTask)) {
      fail("cave_compiler_replay_hash", `task ${task.id} file cardinality mismatch`);
    }
    const verifierEntries = expectedFiles
      .filter((file) => file.startsWith(`${task.id}/verifier/`))
      .map((file) => [file, task.file_sha256[file]]);
    if (verifierEntries.length === 0) fail("cave_compiler_replay_verifier", `task ${task.id} has no pinned verifier`);
    const taskPath = safeResolve(corpusRoot, `${task.id}/task.md`, `task ${task.id} task.md`);
    taskInfo.set(task.id, {
      taskBytes: (await stat(taskPath)).size,
      taskSHA256: task.file_sha256[`${task.id}/task.md`],
      verifierBundleSHA256: sha256(canonicalStringify(verifierEntries)),
    });
  }
  const notice = await readFile(resolve(corpusRoot, "NOTICE"), "utf8");
  const noticeLicenseLabels = {
    "Apache-2.0": ["Apache-2.0", "Apache License 2.0"],
  }[provenance.corpus.license];
  if (!notice.includes(provenance.corpus.source_url) ||
      !notice.includes(provenance.corpus.source_commit) ||
      !noticeLicenseLabels?.some((label) => notice.includes(label))) {
    fail("cave_compiler_replay_provenance", "corpus NOTICE does not preserve source, commit, and license");
  }
  return taskInfo;
}

function validateSplit(cases, expectedCardinality, corpusTaskIDs) {
  const taskIDs = new Set();
  const familySplit = new Map();
  const counts = Object.fromEntries(SPLITS.map((split) => [split, 0]));
  const families = Object.fromEntries(SPLITS.map((split) => [split, []]));
  for (const item of cases) {
    if (taskIDs.has(item.task_id)) fail("cave_compiler_replay_cardinality", `duplicate case task ${item.task_id}`);
    taskIDs.add(item.task_id);
    counts[item.split]++;
    families[item.split].push(item.family);
    const prior = familySplit.get(item.family);
    if (prior !== undefined && prior !== item.split) {
      fail("cave_compiler_replay_split_leakage", `family ${item.family} appears in ${prior} and ${item.split}`);
    }
    if (prior === undefined) familySplit.set(item.family, item.split);
  }
  for (const split of SPLITS) {
    if (counts[split] !== expectedCardinality[split]) {
      fail("cave_compiler_replay_cardinality", `${split} cases=${counts[split]} expected=${expectedCardinality[split]}`);
    }
    families[split] = [...new Set(families[split])].sort();
  }
  const expectedTasks = [...corpusTaskIDs].sort();
  const actualTasks = [...taskIDs].sort();
  if (JSON.stringify(actualTasks) !== JSON.stringify(expectedTasks)) {
    fail("cave_compiler_replay_cardinality", "fixture task set differs from pinned corpus task set");
  }
  return { counts, families };
}

function buildPlan(id, tools, contexts) {
  return Object.freeze({
    id,
    tools: Object.freeze([...tools].sort()),
    contexts: Object.freeze([...contexts].sort()),
  });
}

function contextBytes(fixture, retained, taskBytes) {
  return fixture.declared_context_segments.reduce((total, segment) => {
    if (!retained.has(segment.kind)) return total;
    return total + (segment.bytes === "task_file" ? taskBytes : segment.bytes);
  }, 0);
}

function schemaBytes(fixture, retained) {
  return fixture.declared_tool_schemas.reduce(
    (total, tool) => total + (retained.has(tool.name) ? tool.bytes : 0),
    0,
  );
}

function evaluateCase(fixture, item, info, plan) {
  const retainedTools = new Set(plan.tools);
  const retainedContexts = new Set(plan.contexts);
  const missingTools = [...new Set(item.tool_sequence.filter((tool) => !retainedTools.has(tool)))].sort();
  const missingContexts = item.required_context.filter((kind) => !retainedContexts.has(kind)).sort();
  const outcome = {
    task_id: item.task_id,
    task_sha256: info.taskSHA256,
    verifier_bundle_sha256: info.verifierBundleSHA256,
    model_calls: item.model_calls,
    tool_sequence: item.tool_sequence,
    required_context: item.required_context,
  };
  return {
    passed: missingTools.length === 0 && missingContexts.length === 0,
    missingTools,
    missingContexts,
    schemaBytes: schemaBytes(fixture, retainedTools),
    contextBytes: contextBytes(fixture, retainedContexts, info.taskBytes),
    modelCalls: item.model_calls,
    toolCalls: item.tool_sequence.length,
    toolSequenceSHA256: sha256(canonicalStringify(item.tool_sequence)),
    verifierBundleSHA256: info.verifierBundleSHA256,
    outcomeSHA256: sha256(canonicalStringify(outcome)),
  };
}

function totals(rows) {
  return rows.reduce((total, row) => ({
    tool_schema_bytes: total.tool_schema_bytes + row.schemaBytes,
    context_bytes: total.context_bytes + row.contextBytes,
    model_calls: total.model_calls + row.modelCalls,
    tool_calls: total.tool_calls + row.toolCalls,
  }), { tool_schema_bytes: 0, context_bytes: 0, model_calls: 0, tool_calls: 0 });
}

function comparePlan(fixture, cases, taskInfo, plan) {
  const rows = cases.map((item) => evaluateCase(fixture, item, taskInfo.get(item.task_id), plan));
  return { passed: rows.every((row) => row.passed), rows, totals: totals(rows) };
}

function structuralSize(value) {
  return value.tool_schema_bytes + value.context_bytes;
}

function reportCase(item, baseline, profiled) {
  const structurallyConsistent = baseline.passed && profiled.passed &&
    baseline.modelCalls === profiled.modelCalls &&
    baseline.toolCalls === profiled.toolCalls &&
    baseline.toolSequenceSHA256 === profiled.toolSequenceSHA256 &&
    baseline.verifierBundleSHA256 === profiled.verifierBundleSHA256 &&
    baseline.outcomeSHA256 === profiled.outcomeSHA256;
  if (!structurallyConsistent) {
    fail("cave_compiler_replay_structural_consistency", `declared replay metadata diverged for ${item.task_id}`);
  }
  return {
    task_id: item.task_id,
    family: item.family,
    split: item.split,
    baseline: {
      tool_schema_bytes: baseline.schemaBytes,
      context_bytes: baseline.contextBytes,
      model_calls: baseline.modelCalls,
      tool_calls: baseline.toolCalls,
      tool_sequence_sha256: baseline.toolSequenceSHA256,
    },
    profiled: {
      tool_schema_bytes: profiled.schemaBytes,
      context_bytes: profiled.contextBytes,
      model_calls: profiled.modelCalls,
      tool_calls: profiled.toolCalls,
      tool_sequence_sha256: profiled.toolSequenceSHA256,
    },
    structural_bytes_removed:
      (baseline.schemaBytes + baseline.contextBytes) - (profiled.schemaBytes + profiled.contextBytes),
    pinned_verifier_bundle_sha256: baseline.verifierBundleSHA256,
    baseline_declared_outcome_sha256: baseline.outcomeSHA256,
    future_plan_declared_outcome_sha256: profiled.outcomeSHA256,
    declared_outcome_digest_preserved: true,
  };
}

function planSummary(plan) {
  return { id: plan.id, retained_tools: plan.tools, retained_context: plan.contexts };
}

function createSplitAccess(cases) {
  let planLocked = false;
  return Object.freeze({
    selection(split) {
      if (planLocked || (split !== "train" && split !== "dev")) {
        fail("cave_compiler_replay_split_access", `selection cannot read ${split}`);
      }
      return cases.filter((item) => item.split === split);
    },
    lock() {
      if (planLocked) fail("cave_compiler_replay_split_access", "plan already locked");
      planLocked = true;
    },
    held() {
      if (!planLocked) fail("cave_compiler_replay_split_access", "held opened before plan lock");
      return cases.filter((item) => item.split === "held");
    },
  });
}

export async function runCompilerReplay(options = {}) {
  const thirdPartyPath = resolve(options.thirdPartyPath ?? resolve(BENCH_DIR, "third-party-data.json"));
  const provenanceRead = await readJSON(thirdPartyPath, "third-party manifest");
  validateThirdParty(provenanceRead.value);
  const provenance = provenanceRead.value;
  const casesPath = resolve(options.casesPath ?? safeResolve(REPO_ROOT, provenance.replay_fixture.path, "replay fixture.path"));
  const casesRead = await readJSON(casesPath, "cases fixture");
  if (sha256(casesRead.bytes) !== provenance.replay_fixture.sha256) {
    fail("cave_compiler_replay_hash", "cases fixture hash mismatch");
  }
  validateCases(casesRead.value);
  const fixture = casesRead.value;
  const corpusRoot = resolve(options.corpusRoot ?? safeResolve(REPO_ROOT, provenance.corpus.local_path, "corpus.local_path"));
  const corpusManifestRead = await readJSON(resolve(corpusRoot, "manifest.json"), "corpus manifest");
  const taskInfo = await validateCorpus({
    corpusRoot,
    corpusManifestBytes: corpusManifestRead.bytes,
    corpusManifest: corpusManifestRead.value,
    provenance,
  });
  const split = validateSplit(fixture.cases, fixture.expected_cardinality, taskInfo.keys());

  const allTools = fixture.declared_tool_schemas.map(({ name }) => name);
  const allContexts = fixture.declared_context_segments.map(({ kind }) => kind);
  const baselinePlan = buildPlan("baseline", allTools, allContexts);
  const splitAccess = createSplitAccess(fixture.cases);
  const training = splitAccess.selection("train");
  const observedTools = new Set(training.flatMap((item) => item.tool_sequence));
  const observedContexts = new Set(training.flatMap((item) => item.required_context));
  const profiledPlan = buildPlan("profiled-dead-structure-elimination", observedTools, observedContexts);

  // Selection may inspect train and dev only. Held cases are not evaluated
  // until selectedPlan is immutable below.
  const development = splitAccess.selection("dev");
  const baselineDev = comparePlan(fixture, development, taskInfo, baselinePlan);
  const profiledDev = comparePlan(fixture, development, taskInfo, profiledPlan);
  if (!baselineDev.passed) {
    fail("cave_compiler_replay_structural_consistency", "baseline failed development fixture requirements");
  }
  if (!profiledDev.passed) {
    fail("cave_compiler_replay_structural_consistency", "future plan failed development fixture requirements");
  }
  if (structuralSize(profiledDev.totals) >= structuralSize(baselineDev.totals)) {
    fail("cave_compiler_replay_no_structural_candidate", "profiled plan removed no development structure");
  }
  const selectedPlan = profiledPlan;
  const lockSHA256 = sha256(canonicalStringify({
    fixture_sha256: provenance.replay_fixture.sha256,
    corpus_manifest_sha256: provenance.corpus.manifest_sha256,
    selected_plan: selectedPlan,
    selection_split: "dev",
  }));

  splitAccess.lock();
  const held = splitAccess.held();
  const heldResult = comparePlan(fixture, held, taskInfo, selectedPlan);
  if (!heldResult.passed) {
    const failed = held
      .map((item, index) => ({ item, result: heldResult.rows[index] }))
      .filter(({ result }) => !result.passed)
      .map(({ item, result }) => `${item.task_id}[tools=${result.missingTools.join("|")};contexts=${result.missingContexts.join("|")}]`);
    fail("cave_compiler_replay_structural_consistency", `held fixture requirements failed: ${failed.join(",")}`);
  }

  const baselineAll = comparePlan(fixture, fixture.cases, taskInfo, baselinePlan);
  const profiledAll = comparePlan(fixture, fixture.cases, taskInfo, selectedPlan);
  const cases = fixture.cases.map((item, index) =>
    reportCase(item, baselineAll.rows[index], profiledAll.rows[index]));
  const bySplit = Object.fromEntries(SPLITS.map((name) => {
    const selected = cases.filter((item) => item.split === name);
    const baseline = {
      tool_schema_bytes: selected.reduce((sum, item) => sum + item.baseline.tool_schema_bytes, 0),
      context_bytes: selected.reduce((sum, item) => sum + item.baseline.context_bytes, 0),
      model_calls: selected.reduce((sum, item) => sum + item.baseline.model_calls, 0),
      tool_calls: selected.reduce((sum, item) => sum + item.baseline.tool_calls, 0),
    };
    const profiled = {
      tool_schema_bytes: selected.reduce((sum, item) => sum + item.profiled.tool_schema_bytes, 0),
      context_bytes: selected.reduce((sum, item) => sum + item.profiled.context_bytes, 0),
      model_calls: selected.reduce((sum, item) => sum + item.profiled.model_calls, 0),
      tool_calls: selected.reduce((sum, item) => sum + item.profiled.tool_calls, 0),
    };
    return [name, {
      baseline,
      profiled,
      structural_bytes_removed: structuralSize(baseline) - structuralSize(profiled),
    }];
  }));
  const baselineStructural = baselineAll.totals;
  const profiledStructural = profiledAll.totals;
  const removed = structuralSize(baselineStructural) - structuralSize(profiledStructural);

  const baseReport = {
    schema: "cavebench.compiler-replay.report.v2",
    benchmark_subject: "future_profiled_dead_structure_elimination_fixture",
    current_v0_2_release_proof: false,
    evidence_basis: "synthetic_structural_rehearsal",
    causal: false,
    publishable: false,
    deterministic: true,
    claim_boundary: "Bespoke future-pass fixture only. Runner does not import or execute @caveman-ai/agent compileProfiled, CaveBuild v3, or target adapters. No model or external verifier was executed. This is not compiler conformance, task correctness, causal token, cost, latency, production, observed, or verified savings evidence.",
    environment: {
      network: "unused; runner imports only local filesystem, path, URL, and cryptographic-hash modules",
      provider_calls: 0,
      current_v0_2_compiler_executed: false,
      external_verifier_executed: false,
      external_verifier_result: "unavailable",
    },
    corpus: {
      source_url: provenance.corpus.source_url,
      source_commit: provenance.corpus.source_commit,
      license: provenance.corpus.license,
      license_url: provenance.corpus.license_url,
      training_use_constraint: provenance.corpus.training_use_constraint,
      approved_role: provenance.corpus.approved_role,
      manifest_sha256: provenance.corpus.manifest_sha256,
      replay_fixture_sha256: provenance.replay_fixture.sha256,
      tasks: provenance.corpus.task_count,
      all_declared_file_hashes_verified: true,
    },
    split: {
      strategy: "family-disjoint train profile -> dev selection -> immutable lock -> held replay",
      counts: split.counts,
      families: split.families,
      leakage_detected: false,
      selection_evidence_splits: ["train", "dev"],
      held_opened_after_lock: true,
    },
    future_pass_rehearsal: {
      implementation: "bench-local bespoke dead-structure fixture; not @caveman-ai/agent compiler code",
      candidates_considered: [planSummary(baselinePlan), planSummary(profiledPlan)],
      selected_plan: planSummary(selectedPlan),
      lock_sha256: lockSHA256,
      wall_clock_overhead: { defined: false, reason: "Wall-clock timing is intentionally excluded from byte-reproducible replay." },
      monetary_search_cost: { defined: false, reason: "Replay performs no provider or billable model calls." },
      break_even_runs: { defined: false, reason: "No measured monetary runtime delta exists in replay evidence." },
    },
    structural_work: {
      unit: "fixture-declared schema/fixed-context byte weights plus exact pinned task.md file bytes; call counts are deterministic replay events",
      baseline: baselineStructural,
      profiled: profiledStructural,
      structural_bytes_removed: removed,
      structural_fraction_removed: removed / structuralSize(baselineStructural),
      model_calls_changed: profiledStructural.model_calls - baselineStructural.model_calls,
      tool_calls_changed: profiledStructural.tool_calls - baselineStructural.tool_calls,
      by_split: bySplit,
    },
    declared_outcome_consistency: {
      basis: "Equality of hashes constructed from fixture-declared task, call, tool-sequence, context-requirement, and pinned-file metadata. This is an internal regression invariant, not independent task verification.",
      external_verifier_executed: false,
      external_verifier_result: "unavailable",
      outcome_digest_preserved: true,
      structurally_consistent_cases: cases.length,
      structurally_consistent_cases_expected: fixture.cases.length,
    },
    cases,
  };
  const report = {
    ...baseReport,
    report_sha256: sha256(canonicalStringify(baseReport)),
  };
  if (options.outputPath !== undefined) {
    await writeFile(resolve(options.outputPath), `${JSON.stringify(report, null, 2)}\n`, { flag: "w" });
  }
  return report;
}

export async function assertCheckedReport(report, outputPath) {
  const expected = `${JSON.stringify(report, null, 2)}\n`;
  let actual;
  try {
    actual = await readFile(resolve(outputPath), "utf8");
  } catch (error) {
    fail("cave_compiler_replay_stale", `checked report unavailable: ${error.message}`);
  }
  let actualReport;
  try {
    actualReport = JSON.parse(actual);
  } catch (error) {
    fail("cave_compiler_replay_stale", `checked report is not valid JSON: ${error.message}`);
  }
  const bytesEqual = actual === expected;
  const canonicalEqual = canonicalStringify(actualReport) === canonicalStringify(report);
  if (!bytesEqual || !canonicalEqual) {
    fail(
      "cave_compiler_replay_stale",
      `checked report differs from deterministic replay output: byte_equal=${bytesEqual} canonical_equal=${canonicalEqual}`,
    );
  }
}

function parseArguments(argv) {
  let check = false;
  let outputPath = resolve(BENCH_DIR, "compiler-replay-report.json");
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--check") {
      check = true;
    } else if (argument === "--output") {
      const value = argv[++index];
      if (!value) fail("cave_compiler_replay_cli", "--output requires a path");
      outputPath = resolve(value);
    } else {
      fail("cave_compiler_replay_cli", `unknown argument ${argument}`);
    }
  }
  return { check, outputPath };
}

async function main() {
  const { check, outputPath } = parseArguments(process.argv.slice(2));
  const report = await runCompilerReplay({ ...(check ? {} : { outputPath }) });
  if (check) await assertCheckedReport(report, outputPath);
  process.stdout.write(
    `compiler_replay subject=${report.benchmark_subject} current_v0_2_release_proof=${report.current_v0_2_release_proof} ` +
    `basis=${report.evidence_basis} causal=${report.causal} publishable=${report.publishable} ` +
    `held=${report.split.counts.held} outcome_digest_preserved=${report.declared_outcome_consistency.outcome_digest_preserved} ` +
    `report_sha256=${report.report_sha256}${check ? "" : ` output=${outputPath}`}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
