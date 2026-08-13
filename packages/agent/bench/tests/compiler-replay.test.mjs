import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalStringify,
  assertCheckedReport,
  runCompilerReplay,
  sha256,
} from "../compiler-replay.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = resolve(TEST_DIR, "..");
const CASES_PATH = resolve(BENCH_DIR, "fixtures/cases.json");
const THIRD_PARTY_PATH = resolve(BENCH_DIR, "third-party-data.json");
const RUNNER_PATH = resolve(BENCH_DIR, "compiler-replay.mjs");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

async function mutatedInputs(mutateCases, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cave-compiler-replay-"));
  temporaryDirectories.push(directory);
  const cases = JSON.parse(await readFile(CASES_PATH, "utf8"));
  const provenance = JSON.parse(await readFile(THIRD_PARTY_PATH, "utf8"));
  mutateCases?.(cases);
  options.mutateProvenance?.(provenance);
  const caseBytes = `${JSON.stringify(cases, null, 2)}\n`;
  if (options.rehash !== false) provenance.replay_fixture.sha256 = sha256(caseBytes);
  const casesPath = join(directory, "cases.json");
  const thirdPartyPath = join(directory, "third-party-data.json");
  await Promise.all([
    writeFile(casesPath, caseBytes),
    writeFile(thirdPartyPath, `${JSON.stringify(provenance, null, 2)}\n`),
  ]);
  return { casesPath, thirdPartyPath };
}

test("future-pass structural rehearsal is deterministic and cannot pose as release proof", async () => {
  const first = await runCompilerReplay();
  const second = await runCompilerReplay();
  assert.deepEqual(second, first);

  const { report_sha256: reportSHA256, ...baseReport } = first;
  assert.equal(reportSHA256, sha256(canonicalStringify(baseReport)));
  assert.equal(first.schema, "cavebench.compiler-replay.report.v2");
  assert.equal(first.benchmark_subject, "future_profiled_dead_structure_elimination_fixture");
  assert.equal(first.current_v0_2_release_proof, false);
  assert.equal(first.evidence_basis, "synthetic_structural_rehearsal");
  assert.equal(first.causal, false);
  assert.equal(first.publishable, false);
  assert.equal(first.environment.provider_calls, 0);
  assert.equal(first.environment.current_v0_2_compiler_executed, false);
  assert.equal(first.environment.external_verifier_executed, false);
  assert.equal(first.environment.external_verifier_result, "unavailable");
  assert.equal(
    first.corpus.training_use_constraint,
    "Evaluation fixture only. Not approved as model-training data.",
  );
  assert.equal(first.corpus.approved_role, "synthetic_structural_rehearsal_fixture");
  assert.deepEqual(first.split.counts, { train: 4, dev: 4, held: 4 });
  assert.equal(first.split.leakage_detected, false);
  assert.equal(first.declared_outcome_consistency.external_verifier_executed, false);
  assert.equal(first.declared_outcome_consistency.external_verifier_result, "unavailable");
  assert.equal(first.declared_outcome_consistency.outcome_digest_preserved, true);
  assert.equal(first.declared_outcome_consistency.structurally_consistent_cases, 12);
  assert.ok(first.cases.every((item) => item.declared_outcome_digest_preserved));
  assert.equal("compiler" in first, false);
  assert.equal("verifier_preservation" in first, false);
  assert.equal("exact" in first.declared_outcome_consistency, false);
  assert.equal("cases_passed" in first.declared_outcome_consistency, false);
  assert.ok(first.cases.every((item) => !("exact_replay_preserved" in item)));

  assert.equal(
    first.structural_work.baseline.tool_schema_bytes -
      first.structural_work.profiled.tool_schema_bytes,
    10_200,
  );
  assert.equal(
    first.structural_work.baseline.context_bytes -
      first.structural_work.profiled.context_bytes,
    12_288,
  );
  assert.equal(first.structural_work.structural_bytes_removed, 22_488);
  assert.equal(first.structural_work.model_calls_changed, 0);
  assert.equal(first.structural_work.tool_calls_changed, 0);
  assert.match(first.future_pass_rehearsal.implementation, /not @caveman-ai\/agent compiler code/);
  assert.equal(first.future_pass_rehearsal.wall_clock_overhead.defined, false);
  assert.equal(first.future_pass_rehearsal.monetary_search_cost.defined, false);
  assert.equal(first.future_pass_rehearsal.break_even_runs.defined, false);

  const trainingUseMutation = structuredClone(baseReport);
  trainingUseMutation.corpus.training_use_constraint = "model training permitted";
  assert.notEqual(sha256(canonicalStringify(trainingUseMutation)), reportSHA256);
  const roleMutation = structuredClone(baseReport);
  roleMutation.corpus.approved_role = "release_proof";
  assert.notEqual(sha256(canonicalStringify(roleMutation)), reportSHA256);
});

test("check compares deterministic output against committed artifact bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cave-compiler-report-check-"));
  temporaryDirectories.push(directory);
  const report = await runCompilerReplay();
  const path = join(directory, "report.json");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  await assert.doesNotReject(assertCheckedReport(report, path));
  await writeFile(path, JSON.stringify(report));
  await assert.rejects(
    assertCheckedReport(report, path),
    /cave_compiler_replay_stale: .*byte_equal=false canonical_equal=true/,
  );
  const changed = structuredClone(report);
  changed.corpus.training_use_constraint = "model training permitted";
  await writeFile(path, `${JSON.stringify(changed, null, 2)}\n`);
  await assert.rejects(
    assertCheckedReport(report, path),
    /cave_compiler_replay_stale: .*byte_equal=false canonical_equal=false/,
  );
});

test("runner has no network or process execution capability", async () => {
  const source = await readFile(RUNNER_PATH, "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(imports, [
    "node:crypto",
    "node:fs/promises",
    "node:path",
    "node:url",
  ]);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /node:(?:http|https|net|tls|dgram|dns|child_process)/);
});

test("fixture hash mismatch fails closed", async () => {
  const inputs = await mutatedInputs(
    (cases) => { cases.cases[0].model_calls += 1; },
    { rehash: false },
  );
  await assert.rejects(
    runCompilerReplay(inputs),
    /cave_compiler_replay_hash: cases fixture hash mismatch/,
  );
});

test("corpus manifest hash mismatch fails closed", async () => {
  const inputs = await mutatedInputs(undefined, {
    mutateProvenance(provenance) {
      provenance.corpus.manifest_sha256 = "0".repeat(64);
    },
  });
  await assert.rejects(
    runCompilerReplay(inputs),
    /cave_compiler_replay_hash: corpus manifest hash mismatch/,
  );
});

test("unapproved training-use constraint fails closed", async () => {
  const inputs = await mutatedInputs(undefined, {
    mutateProvenance(provenance) {
      provenance.corpus.training_use_constraint = "Model training permitted.";
    },
  });
  await assert.rejects(
    runCompilerReplay(inputs),
    /cave_compiler_replay_schema: third-party corpus training-use constraint is not approved/,
  );
});

test("unapproved corpus role fails closed", async () => {
  const inputs = await mutatedInputs(undefined, {
    mutateProvenance(provenance) {
      provenance.corpus.approved_role = "release_proof";
    },
  });
  await assert.rejects(
    runCompilerReplay(inputs),
    /cave_compiler_replay_schema: third-party corpus role is not approved/,
  );
});

test("cross-split family leakage fails closed", async () => {
  const inputs = await mutatedInputs((cases) => {
    const train = cases.cases.find((item) => item.split === "train");
    const held = cases.cases.find((item) => item.split === "held");
    held.family = train.family;
  });
  await assert.rejects(
    runCompilerReplay(inputs),
    /cave_compiler_replay_split_leakage/,
  );
});

test("split cardinality mismatch fails closed", async () => {
  const inputs = await mutatedInputs((cases) => {
    const index = cases.cases.findIndex((item) => item.split === "held");
    cases.cases.splice(index, 1);
  });
  await assert.rejects(
    runCompilerReplay(inputs),
    /cave_compiler_replay_cardinality: held cases=3 expected=4/,
  );
});

test("required held tool removed by the profile fails closed", async () => {
  const inputs = await mutatedInputs((cases) => {
    const held = cases.cases.find((item) => item.split === "held");
    held.tool_sequence.push("legacy_remote_lookup");
  });
  await assert.rejects(
    runCompilerReplay(inputs),
    /cave_compiler_replay_structural_consistency: held fixture requirements failed/,
  );
});
