import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SUPPORTED_GRADER_TYPES } from "@caveman-ai/evals";
import { catalogCost, catalogPriceFingerprint, catalogSearchCeiling } from "./catalog.js";
import type { AgentDefinition } from "./index.js";
import {
  agentGraphHasSubagents,
  graphHasUnverifiedToolSchemaSemantics,
  graphUsesHostSandbox,
} from "./definition-graph.js";
import type { ContextIR } from "./context-ir.js";
import { contextIRToWire, sha256, stableStringify } from "./context-ir.js";
import {
  assertQualityGrader,
  type ContextKind,
  type EvalDefinition,
  type ToolDefinition,
} from "./primitives.js";
import { PI_NATIVE_COMPILER_CONTRACT } from "./runtime-identity.js";

export interface BuildConfig {
  entry: string;
  evals: string;
  efficiency: "max";
  requiredFixturePassRate: number;
  qualityRetention: number;
  maxSearchCostUsd: number;
  lock: "strict";
  sandbox: "required";
  allowedModels?: string[];
  deniedModels?: string[];
  maxP95LatencyMs?: number;
  forbiddenSafetyClasses?: string[];
  dataResidency?: string;
}

export function defineBuild(options: Partial<BuildConfig> & Pick<BuildConfig, "entry" | "evals">): BuildConfig {
  const allowed = new Set([
    "entry", "evals", "efficiency", "requiredFixturePassRate", "qualityRetention",
    "maxSearchCostUsd", "lock", "sandbox", "allowedModels", "deniedModels",
    "maxP95LatencyMs", "forbiddenSafetyClasses", "dataResidency",
  ]);
  if (!isRecord(options) || Object.keys(options).some((key) => !allowed.has(key)) ||
      typeof options.entry !== "string" || options.entry.trim().length === 0 ||
      typeof options.evals !== "string" || options.evals.trim().length === 0 ||
      (options.efficiency !== undefined && options.efficiency !== "max") ||
      (options.lock !== undefined && options.lock !== "strict") ||
      (options.sandbox !== undefined && options.sandbox !== "required") ||
      (options.requiredFixturePassRate !== undefined &&
        typeof options.requiredFixturePassRate !== "number") ||
      (options.qualityRetention !== undefined && typeof options.qualityRetention !== "number") ||
      (options.maxSearchCostUsd !== undefined && typeof options.maxSearchCostUsd !== "number") ||
      (options.maxP95LatencyMs !== undefined && typeof options.maxP95LatencyMs !== "number") ||
      (options.allowedModels !== undefined && !Array.isArray(options.allowedModels)) ||
      (options.deniedModels !== undefined && !Array.isArray(options.deniedModels)) ||
      (options.forbiddenSafetyClasses !== undefined && !Array.isArray(options.forbiddenSafetyClasses))) {
    throw new Error("caveman build: invalid build config shape");
  }
  if (options.dataResidency !== undefined) {
    throw new Error(
      "caveman build: dataResidency is not enforced yet; refusing to ignore residency policy",
    );
  }
  const config: BuildConfig = {
    entry: options.entry,
    evals: options.evals,
    efficiency: options.efficiency ?? "max",
    requiredFixturePassRate: options.requiredFixturePassRate ?? 1,
    qualityRetention: options.qualityRetention ?? 0.98,
    maxSearchCostUsd: options.maxSearchCostUsd ?? 2,
    lock: options.lock ?? "strict",
    sandbox: options.sandbox ?? "required",
    ...(options.allowedModels === undefined ? {} : { allowedModels: [...options.allowedModels] }),
    ...(options.deniedModels === undefined ? {} : { deniedModels: [...options.deniedModels] }),
    ...(options.maxP95LatencyMs === undefined ? {} : { maxP95LatencyMs: options.maxP95LatencyMs }),
    ...(options.forbiddenSafetyClasses === undefined ? {} : { forbiddenSafetyClasses: [...options.forbiddenSafetyClasses] }),
  };
  if (!(config.requiredFixturePassRate > 0 && config.requiredFixturePassRate <= 1)) {
    throw new Error("caveman build: requiredFixturePassRate must be in (0,1]");
  }
  if (!(config.qualityRetention > 0 && config.qualityRetention <= 1)) {
    throw new Error("caveman build: qualityRetention must be in (0,1]");
  }
  if (!Number.isFinite(config.maxSearchCostUsd) || !(config.maxSearchCostUsd > 0)) {
    throw new Error("caveman build: maxSearchCostUsd must be positive");
  }
  if (config.maxP95LatencyMs !== undefined &&
      (!Number.isSafeInteger(config.maxP95LatencyMs) || config.maxP95LatencyMs <= 0)) {
    throw new Error("caveman build: maxP95LatencyMs must be a positive integer");
  }
  for (const [name, values] of [
    ["allowedModels", config.allowedModels],
    ["deniedModels", config.deniedModels],
    ["forbiddenSafetyClasses", config.forbiddenSafetyClasses],
  ] as const) {
    if (values !== undefined && (new Set(values).size !== values.length ||
        values.some((value) => typeof value !== "string" || value.trim().length === 0))) {
      throw new Error(`caveman build: ${name} must contain unique non-empty strings`);
    }
  }
  return freezeBuildValue(config);
}

/** Canonical digest of validated effective compiler policy. */
export function buildPolicySHA256(config: BuildConfig): string {
  return sha256(stableStringify(defineBuild(config)));
}

export interface CavePlan {
  schema_version: 1;
  plan_id: string;
  model: string;
  reasoning: "none" | "minimal" | "low" | "medium" | "high";
  segment_routes: Array<{
    segment_kind: ContextKind;
    segment_id?: string;
    transform_id: string;
    fallback: "original";
  }>;
  budgets: {
    instructions: number;
    tools: number;
    memory: number;
    history: number;
    results_artifacts: number;
    reasoning: number;
    output: number;
    retry_cascade_reserve: number;
  };
  recovery: {
    namespace: string;
    tools: Array<"cave_retrieve" | "cave_search_tools" | "cave_memory_search" | "cave_artifact_page">;
  };
  fallbacks: {
    unknown: "original";
    transform_error: "original";
    not_smaller: "original";
  };
}

export interface CandidatePlan {
  plan: CavePlan;
  estimated_cost_usd_per_run: number;
  static_rejection?: "unsupported_provider" | "forbidden_transform" | "unpriced_model" | "dominated" | "policy_denied";
}

export interface RunEvidence {
  terminal: boolean;
  provider: string;
  model: string;
  usage_basis: "provider_reported" | "estimated" | "missing";
  price_basis: "public_catalog" | "unpriced";
  catalog_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  quality_score: number;
  graders: Array<{ type: string; passed: boolean }>;
  latency_ms: number;
  provider_visible_tokens: number;
  cache_prefix_sha256: string;
  cache_boundary_known: boolean;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_bust: boolean;
  error: boolean;
  recovery_resolved: boolean;
  privacy_passed: boolean;
  sandbox_passed: boolean;
  unknown_event?: boolean;
  unknown_transform?: boolean;
  output_digest: string;
}

export type BuildHarnessID = "pi" | "claude" | "vercel-ai-sdk" | "eve" | "mastra";

export interface CompileInput {
  agent: AgentDefinition;
  contextIR: ContextIR;
  evals: EvalDefinition[];
  candidates?: CandidatePlan[];
  baselinePlan: CavePlan;
  modelCandidates?: string[];
  /** Profile-observed dynamic context. Set by profile compiler, never guessed. */
  observedDynamicKinds?: readonly ContextKind[];
  seeds?: number[];
  config: BuildConfig;
  sourceSha256: string;
  catalogSha256: string;
  transformRegistrySha256: string;
  externalProvenanceSha256?: string;
  runtimeVersion: string;
  adapterVersion: string;
  upstreamVersion: string;
  harnessId?: BuildHarnessID;
  /** Harness deadline override. Production uses its configured default. */
  runnerTimeoutMs?: number;
  runner: (request: {
    plan: CavePlan;
    eval: EvalDefinition;
    seed: number;
    /** Remaining compiler search budget. First-party runners enforce it per run. */
    maxCostUsd: number;
    signal: AbortSignal;
  }) => Promise<RunEvidence>;
}

export type CompileStatus =
  | "locked"
  | "no_passing_build"
  | "needs_eval"
  | "search_budget_exceeded"
  | "incomplete_evidence";

export interface CaveBuildLock {
  schema_version: 2;
  agent_id: string;
  build_sha256: string;
  plan_sha256: string;
  source_sha256: string;
  agent_definition_sha256: string;
  context_ir_sha256: string;
  eval_suite_sha256: string;
  context_ir_schema: "1";
  harness: {
    id: BuildHarnessID;
    adapter_version: string;
    upstream_version: string;
  };
  runtime: {
    caveman_version: string;
    transform_registry_sha256: string;
    external_provenance_sha256: string;
  };
  catalog_sha256: string;
  baseline_plan_id: string;
  selected_plan_id: string;
  selected_plan: CavePlan;
  evidence: {
    status: "locked";
    basis: "inferred";
    quality_retention_lcb95: number;
    error_rate: number;
    p95_latency_ms: number;
    catalog_cost_usd_per_task: number;
    completed_runs: number;
  };
}

export type CompilerSemantic =
  | "single_agent"
  | "model_binding"
  | "reasoning_binding"
  | "output_budget_binding"
  | "context_ir_binding"
  | "transform_evidence"
  | "recovery_evidence"
  | "baseline_fallback"
  | "abort_signal"
  | "tool_effect:read"
  | "tool_effect:idempotent"
  | "tool_effect:write"
  | "tool_effect:external";

export const PROFILED_COMPILER_IDENTITY_SHA256 = sha256(stableStringify({
  id: "@caveman-ai/agent/profiled-compiler",
  version: "0.2.0",
  selection: "profile-propose/development-select/holdout-validate",
  fallback: "abort-only-with-baseline-artifact",
  pass_evidence: "development-validation-v1",
  target_evidence: "target-specific-revalidation",
  native_semantic_version: PI_NATIVE_COMPILER_CONTRACT.semantic_version,
}));

// Generic adapters cannot prove behavioral materialization. Exact native Pi
// can execute candidate plans through compiler-owned runAgentInternal runners.
// Lock hashes remain integrity bindings, not software-supply-chain attestation.
const BASE_COMPILER_CAPABILITIES: readonly CompilerSemantic[] = [];
export const PI_NATIVE_COMPILER_CONTRACT_SHA256 = sha256(
  stableStringify(PI_NATIVE_COMPILER_CONTRACT),
);
export const PI_NATIVE_COMPILER_CAPABILITIES: readonly CompilerSemantic[] = Object.freeze([
  "abort_signal",
  "context_ir_binding",
  "model_binding",
  "output_budget_binding",
  "reasoning_binding",
  "recovery_evidence",
  "single_agent",
  "transform_evidence",
]);
export const BUILD_TARGET_CAPABILITY_LATTICE: Readonly<Record<BuildHarnessID, readonly CompilerSemantic[]>> =
  Object.freeze({
    pi: Object.freeze([]),
    claude: Object.freeze([]),
    "vercel-ai-sdk": Object.freeze([]),
    eve: Object.freeze([]),
    mastra: Object.freeze([]),
  });

export interface CompilerCapabilityManifest {
  readonly schema_version: 1;
  readonly target: BuildHarnessID;
  readonly adapter_contract_sha256: string;
  readonly supported_semantics: readonly CompilerSemantic[];
  readonly required_semantics: readonly CompilerSemantic[];
}

export interface CompilerPassRecord {
  readonly pass_id: string;
  readonly version: 1;
  readonly basis: "development";
  readonly evidence_sha256: string;
}

export interface ExecutablePipeline {
  readonly schema_version: 1;
  readonly target: BuildHarnessID;
  readonly semantic_plan_sha256: string;
  readonly entry_step_id: "selected";
  readonly steps: readonly [
    {
      readonly step_id: "selected";
      readonly kind: "harness";
      readonly plan_id: string;
      readonly plan_sha256: string;
      readonly on_error: "baseline" | "abort";
    },
    {
      readonly step_id: "baseline";
      readonly kind: "baseline_fallback";
      readonly plan_id: string;
      readonly plan_sha256: string;
    },
  ];
}

export interface ProfiledValidationEvidence {
  readonly split_sha256: string;
  readonly eval_suite_sha256: string;
  readonly completed_runs: number;
  readonly actual_cost_usd: number;
  readonly baseline_catalog_cost_usd_per_task: number;
  readonly selected_catalog_cost_usd_per_task: number;
  readonly selected_plan_id: string;
}

/**
 * Proof-carrying profiled build. It preserves every v2 identity/evidence field,
 * while versioning the wire shape because strict v2 parsers must reject extras.
 */
export type CaveBuildLockV3 = Omit<CaveBuildLock, "schema_version" | "build_sha256"> & {
  readonly schema_version: 3;
  readonly build_sha256: string;
  readonly compiler: {
    readonly id: "@caveman-ai/agent/profiled-compiler";
    readonly version: "0.2.0";
    readonly compiler_sha256: string;
    readonly profile_sha256: string;
    readonly profile_partition_sha256: string;
    readonly development_sha256: string;
    readonly holdout_sha256: string;
    readonly policy_sha256: string;
    readonly capability_manifest_sha256: string;
  };
  readonly capability_manifest: CompilerCapabilityManifest;
  readonly executable_pipeline: ExecutablePipeline;
  readonly passes: readonly CompilerPassRecord[];
  readonly baseline_fallback: {
    readonly plan_id: string;
    readonly plan_sha256: string;
    readonly plan: CavePlan;
  };
  readonly validation: {
    readonly development: ProfiledValidationEvidence;
    readonly holdout: ProfiledValidationEvidence;
  };
};

export interface CompileResult {
  status: CompileStatus;
  estimated_ceiling_usd: number;
  planned_runs: number;
  completed_runs: number;
  static_rejections: number;
  actual_cost_usd: number | null;
  best_observed_plan_id?: string;
  baseline_catalog_cost_usd_per_task?: number;
  selected_catalog_cost_usd_per_task?: number;
  lock?: CaveBuildLock;
  reason?: string;
}

type Completed = {
  candidate: CandidatePlan;
  evidence: Array<{ fixture: string; seed: number; value: RunEvidence }>;
  costPerTask: number;
  errorRate: number;
  p95Latency: number;
  fixturePassRate: number;
  retentionLCB95: number;
  passing: boolean;
};

export async function compile(input: CompileInput): Promise<CompileResult> {
  input = { ...input, config: defineBuild(input.config) };
  for (const fixture of input.evals) {
    for (const grader of fixture.quality) assertQualityGrader(grader);
  }
  // One explicit accounting instant prices the static search reservation. Actual
  // multi-call spend remains the runner's per-request settled catalog evidence.
  const planningAccountingAt = new Date();
  // An unsandboxed run cannot produce a lock. Host mode runs tool
  // closures in the host process, so its evidence shows no containment and is
  // refused here rather than downgraded to a soft status. The whole definition
  // graph is checked, not just the root: a host subagent under a fixture root
  // runs its closures in this process exactly as a host root would, and the CLI
  // saves that lock all the same. Coding agents lock by compiling against
  // fixture corpora with a contained sandbox mode.
  if (graphUsesHostSandbox(input.agent)) {
    throw new Error("cave_host_sandbox_lock_ineligible");
  }
  if (graphHasUnverifiedToolSchemaSemantics(input.agent)) {
    throw new Error("cave_tool_schema_semantics_unverified");
  }
  // RunResult currently rolls descendant usage into root provider/model totals.
  // Refuse until compiler evidence prices every nested receipt call separately.
  if (agentGraphHasSubagents(input.agent)) {
    throw new Error("cave_compiler_subagent_cost_attribution_unavailable");
  }
  const baselinePlan = freezeBuildValue(
    JSON.parse(stableStringify(input.baselinePlan)) as CavePlan,
  );
  if (!isRecord(baselinePlan) || !validPlanShape(baselinePlan)) {
    throw new Error("cave_candidate_baseline_invalid");
  }
  const agentID = input.agent.id;
  const agentDefinitionDigest = agentDefinitionSHA256(input.agent);
  const contextIRDigest = contextIRSHA256(input.contextIR);
  const evalSnapshot = freezeBuildValue(
    JSON.parse(stableStringify(input.evals)) as EvalDefinition[],
  );
  if (evalSnapshot.length === 0) {
    return emptyResult("needs_eval", "no eval fixture");
  }
  const evalSuiteSha256 = sha256(stableStringify(evalSnapshot));
  const seeds = input.seeds ?? [1, 2, 3, 4, 5];
  if (seeds.length === 0 || new Set(seeds).size !== seeds.length) {
    throw new Error("caveman build: seeds must be a non-empty unique set");
  }
  const policy = candidatePolicy(input.config);
  const generated = input.candidates === undefined;
  const declaredDynamicKinds = input.observedDynamicKinds ?? (input.evals.some((fixture) =>
    fixture.quality.some((grader) => grader.type === "tool_called"))
    ? ["history", "tool_result"] as ContextKind[]
    : []);
  if (declaredDynamicKinds.some((kind) => kind !== "history" && kind !== "tool_result")) {
    throw new Error("cave_candidate_dynamic_kind_invalid");
  }
  const observedDynamicKinds = new Set(declaredDynamicKinds);
  const rawCandidates = input.candidates ?? generateCandidatePlans(
    input.agent,
    input.contextIR,
    baselinePlan,
    input.modelCandidates ?? [baselinePlan.model],
    true,
    new Map(),
    ENGINE_TRANSFORM_CAPABILITIES,
    observedDynamicKinds,
    policy,
    planningAccountingAt,
  );
  // Caller candidates are untrusted compiler input. Snapshot, validate, and
  // recompute their catalog ceiling/policy before any runner can mutate or use
  // them. Generated candidates are frozen through the same boundary.
  const candidates = prepareCandidatePlans(
    rawCandidates,
    baselinePlan,
    policy,
    {
      compilerGenerated: generated,
      contextIR: input.contextIR,
      observedDynamicKinds,
    },
    planningAccountingAt,
  );
  if (candidates.length === 0) throw new Error("caveman build: generated no candidate plans");
  const runnable = candidates.filter((candidate) => !candidate.static_rejection);
  const staticRejections = candidates.length - runnable.length;
  const plannedRuns = runnable.length * evalSnapshot.length * seeds.length;
  const estimatedCeiling = roundUsd(
    runnable.reduce((sum, candidate) => sum + candidate.estimated_cost_usd_per_run * evalSnapshot.length * seeds.length, 0),
  );
  if (estimatedCeiling > input.config.maxSearchCostUsd) {
    return {
      status: "search_budget_exceeded",
      estimated_ceiling_usd: estimatedCeiling,
      planned_runs: plannedRuns,
      completed_runs: 0,
      static_rejections: staticRejections,
      actual_cost_usd: 0,
      reason: "static public-catalog reservation ceiling exceeds configured search budget",
    };
  }

  let actualCost = 0;
  let completedRuns = 0;
  let incomplete = false;
  let unknownGraderType: string | undefined;
  let providerModelDrift = false;
  let budgetExceeded = false;
  const byPlan = new Map<string, Completed["evidence"]>();

  outer:
  for (const candidate of runnable) {
    const evidence: Completed["evidence"] = [];
    byPlan.set(candidate.plan.plan_id, evidence);
    for (const fixture of evalSnapshot) {
      for (const seed of seeds) {
        if (actualCost >= input.config.maxSearchCostUsd) {
          budgetExceeded = true;
          break outer;
        }
        let value: RunEvidence;
        try {
          const maxCostUsd = Math.max(
            Number.EPSILON,
            roundUsd(input.config.maxSearchCostUsd - actualCost),
          );
          const runStartedAt = new Date();
          const reported = await withDeadline(
            (signal) => input.runner({
              plan: candidate.plan,
              eval: fixture,
              seed,
              maxCostUsd,
              signal,
            }),
            input.runnerTimeoutMs ?? 300_000,
          );
          value = repriceRunEvidence(reported, runStartedAt, new Date());
        } catch (error) {
          return {
            estimated_ceiling_usd: estimatedCeiling,
            planned_runs: plannedRuns,
            completed_runs: completedRuns,
            static_rejections: staticRejections,
            actual_cost_usd: null,
            status: "incomplete_evidence",
            reason: `runner failed or timed out before terminal usage evidence; actual cost unknown (${runnerFailureCode(error)})`,
          };
        }
        actualCost = roundUsd(actualCost + Math.max(0, value.catalog_cost_usd));
        completedRuns++;
        evidence.push({ fixture: fixture.id, seed, value });
        if (!completeEvidence(value, candidate.plan, fixture)) {
          incomplete = true;
          providerModelDrift ||= !providerModelMatchesPlan(value, candidate.plan);
          unknownGraderType ??= firstUnknownGrader(value);
        }
        if (actualCost > input.config.maxSearchCostUsd + 1e-12) {
          budgetExceeded = true;
          break outer;
        }
      }
    }
  }

  const base = {
    estimated_ceiling_usd: estimatedCeiling,
    planned_runs: plannedRuns,
    completed_runs: completedRuns,
    static_rejections: staticRejections,
    actual_cost_usd: actualCost,
  };
  if (budgetExceeded || completedRuns !== plannedRuns) {
    return {
      ...base,
      status: budgetExceeded ? "search_budget_exceeded" : "incomplete_evidence",
      reason: budgetExceeded ? "observed public-catalog search budget crossed" : "run cardinality incomplete",
    };
  }
  if (incomplete) {
    return {
      ...base,
      status: "incomplete_evidence",
      reason: providerModelDrift
        ? "provider/model identity drift against candidate plan"
        : unknownGraderType !== undefined
          ? `unknown grader type "${unknownGraderType}": not in canonical @caveman-ai/evals taxonomy`
          : "usage, terminal, grader, recovery, privacy, or sandbox evidence missing",
    };
  }

  const baselineEvidence = byPlan.get(baselinePlan.plan_id);
  if (!baselineEvidence || baselineEvidence.length !== evalSnapshot.length * seeds.length) {
    return { ...base, status: "incomplete_evidence", reason: "complete baseline evidence missing" };
  }
  if (sha256(stableStringify(evalSnapshot)) !== evalSuiteSha256) {
    throw new Error("cave_compiler_eval_snapshot_mutated");
  }
  const completed = runnable.map((candidate) => summarizeCandidate(
    candidate,
    byPlan.get(candidate.plan.plan_id) ?? [],
    baselineEvidence,
    input.config,
    evalSuiteSha256,
    evalSnapshot,
  ));
  const passing = completed.filter((candidate) => candidate.passing);
  const bestObserved = [...completed].sort(selectionOrder)[0];
  const baselineCompleted = completed.find((candidate) =>
    candidate.candidate.plan.plan_id === baselinePlan.plan_id
  );
  if (baselineCompleted === undefined) {
    return { ...base, status: "incomplete_evidence", reason: "baseline candidate summary missing" };
  }
  if (passing.length === 0) {
    return {
      ...base,
      status: "no_passing_build",
      baseline_catalog_cost_usd_per_task: baselineCompleted.costPerTask,
      ...(bestObserved === undefined ? {} : { best_observed_plan_id: bestObserved.candidate.plan.plan_id }),
      reason: "no complete candidate met quality and guardrail floors",
    };
  }
  passing.sort(selectionOrder);
  const selected = passing[0]!;
  const planSha256 = sha256(stableStringify(selected.candidate.plan));
  const lockWithoutBuild = {
    schema_version: 2 as const,
    agent_id: agentID,
    plan_sha256: planSha256,
    source_sha256: input.sourceSha256,
    agent_definition_sha256: agentDefinitionDigest,
    context_ir_sha256: contextIRDigest,
    eval_suite_sha256: evalSuiteSha256,
    context_ir_schema: "1" as const,
    harness: {
      id: input.harnessId ?? "pi",
      adapter_version: input.adapterVersion,
      upstream_version: input.upstreamVersion,
    },
    runtime: {
      caveman_version: input.runtimeVersion,
      transform_registry_sha256: input.transformRegistrySha256,
      external_provenance_sha256: input.externalProvenanceSha256 ?? "",
    },
    catalog_sha256: input.catalogSha256,
    baseline_plan_id: baselinePlan.plan_id,
    selected_plan_id: selected.candidate.plan.plan_id,
    selected_plan: selected.candidate.plan,
    evidence: {
      status: "locked" as const,
      basis: "inferred" as const,
      quality_retention_lcb95: selected.retentionLCB95,
      error_rate: selected.errorRate,
      p95_latency_ms: selected.p95Latency,
      catalog_cost_usd_per_task: selected.costPerTask,
      completed_runs: selected.evidence.length,
    },
  };
  const buildSha256 = sha256(stableStringify(lockWithoutBuild));
  const lock: CaveBuildLock = {
    ...lockWithoutBuild,
    build_sha256: buildSha256,
  };
  return {
    ...base,
    status: "locked",
    best_observed_plan_id: selected.candidate.plan.plan_id,
    baseline_catalog_cost_usd_per_task: baselineCompleted.costPerTask,
    selected_catalog_cost_usd_per_task: selected.costPerTask,
    lock,
  };
}

async function withDeadline<T>(
  invoke: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("caveman build: runner timeout must be a positive integer");
  }
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("cave_build_runner_timeout");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    // Abort asks cooperative runners to stop; the independent race prevents an
    // adapter that ignores AbortSignal from pinning the compiler forever. A late
    // runner can never mint a lock or known actual cost after this branch returns.
    return await Promise.race([Promise.resolve().then(() => invoke(controller.signal)), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function compileAndWrite(input: CompileInput, lockPath = ".caveman/agent.lock.json"): Promise<CompileResult> {
  const result = await compile(input);
  if (!result.lock) return result;
  const target = resolve(lockPath);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(result.lock, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return result;
}

export function checkLock(lock: CaveBuildLock, current: {
  sourceSha256: string;
  agentDefinitionSha256: string;
  contextIRSha256: string;
  evalSuiteSha256: string;
  runtimeVersion: string;
  adapterVersion: string;
  upstreamVersion: string;
  transformRegistrySha256: string;
  externalProvenanceSha256?: string;
  catalogSha256: string;
}): { valid: boolean; stale: string[] } {
  const stale: string[] = lockIntegrityErrors(lock);
  if (lock.source_sha256 !== current.sourceSha256) stale.push("source");
  if (lock.agent_definition_sha256 !== current.agentDefinitionSha256) stale.push("agent_definition");
  if (lock.context_ir_sha256 !== current.contextIRSha256) stale.push("context_ir");
  if (lock.eval_suite_sha256 !== current.evalSuiteSha256) stale.push("eval_suite");
  if (lock.runtime.caveman_version !== current.runtimeVersion) stale.push("runtime");
  if (lock.harness.adapter_version !== current.adapterVersion) stale.push("adapter");
  if (lock.harness.upstream_version !== current.upstreamVersion) stale.push("upstream");
  if (lock.runtime.transform_registry_sha256 !== current.transformRegistrySha256) stale.push("transform_registry");
  if (lock.runtime.external_provenance_sha256 !== (current.externalProvenanceSha256 ?? "")) stale.push("external_provenance");
  if (lock.catalog_sha256 !== current.catalogSha256) stale.push("catalog");
  return { valid: stale.length === 0, stale };
}

export function parseCaveBuildLock(value: unknown): CaveBuildLock {
  if (!hasWellFormedUnicode(value)) throw new Error("cave_invalid_lock:unicode");
  if (!isRecord(value) || !exactKeys(value, [
    "schema_version", "agent_id", "build_sha256", "plan_sha256", "source_sha256",
    "agent_definition_sha256", "context_ir_sha256", "eval_suite_sha256",
    "context_ir_schema", "harness", "runtime", "catalog_sha256",
    "baseline_plan_id", "selected_plan_id", "selected_plan", "evidence",
  ])) {
    throw new Error("cave_invalid_lock:shape");
  }
  const lock = value as unknown as CaveBuildLock;
  if (lock.schema_version !== 2 || lock.context_ir_schema !== "1" ||
      !validCoreLockIdentity(lock) || !validHarness(lock.harness) || !validRuntime(lock.runtime) ||
      !validEvidence(lock.evidence) ||
      !isRecord(lock.selected_plan) || !exactKeys(lock.selected_plan, [
        "schema_version", "plan_id", "model", "reasoning", "segment_routes",
        "budgets", "recovery", "fallbacks",
      ]) || !validPlanShape(lock.selected_plan)) {
    throw new Error("cave_invalid_lock:shape");
  }
  const integrity = lockIntegrityErrors(lock);
  if (integrity.length > 0) throw new Error(`cave_invalid_lock:${integrity.join(",")}`);
  return lock;
}

export function parseCaveBuildLockV3(value: unknown): CaveBuildLockV3 {
  if (!hasWellFormedUnicode(value)) throw new Error("cave_invalid_lock_v3:unicode");
  if (!isRecord(value) || !exactKeys(value, [
    "schema_version", "agent_id", "build_sha256", "plan_sha256", "source_sha256",
    "agent_definition_sha256", "context_ir_sha256", "eval_suite_sha256",
    "context_ir_schema", "harness", "runtime", "catalog_sha256",
    "baseline_plan_id", "selected_plan_id", "selected_plan", "evidence",
    "compiler", "capability_manifest", "executable_pipeline", "passes",
    "baseline_fallback", "validation",
  ])) {
    throw new Error("cave_invalid_lock_v3:shape");
  }
  const lock = value as unknown as CaveBuildLockV3;
  if (lock.schema_version !== 3 || lock.context_ir_schema !== "1" ||
      !validCoreLockIdentity(lock) || !validHarness(lock.harness) || !validRuntime(lock.runtime) ||
      !validEvidence(lock.evidence) || !isRecord(lock.selected_plan) ||
      !exactKeys(lock.selected_plan, [
        "schema_version", "plan_id", "model", "reasoning", "segment_routes",
        "budgets", "recovery", "fallbacks",
      ]) || !validPlanShape(lock.selected_plan) ||
      !validCompilerMetadata(lock.compiler) ||
      !validCapabilityManifest(lock.capability_manifest) ||
      !validExecutablePipeline(lock.executable_pipeline) ||
      !Array.isArray(lock.passes) || lock.passes.length < 1 || lock.passes.length > 16 ||
      !lock.passes.every(validCompilerPass) ||
      !isRecord(lock.baseline_fallback) || !exactKeys(lock.baseline_fallback, ["plan_id", "plan_sha256", "plan"]) ||
      !isRecord(lock.baseline_fallback.plan) || !exactKeys(lock.baseline_fallback.plan, [
        "schema_version", "plan_id", "model", "reasoning", "segment_routes",
        "budgets", "recovery", "fallbacks",
      ]) || !validPlanShape(lock.baseline_fallback.plan) ||
      !validValidation(lock.validation)) {
    throw new Error("cave_invalid_lock_v3:shape");
  }
  const integrity = v3LockIntegrityErrors(lock);
  if (integrity.length > 0) throw new Error(`cave_invalid_lock_v3:${integrity.join(",")}`);
  return lock;
}

export type AnyCaveBuildLock = CaveBuildLock | CaveBuildLockV3;

/** Strict version dispatcher. Each version's parser still rejects extras. */
export function parseAnyCaveBuildLock(value: unknown): AnyCaveBuildLock {
  if (!isRecord(value)) throw new Error("cave_invalid_lock:shape");
  if (value.schema_version === 2) return parseCaveBuildLock(value);
  if (value.schema_version === 3) return parseCaveBuildLockV3(value);
  throw new Error("cave_invalid_lock:unsupported_schema");
}

function validHarness(value: unknown): value is CaveBuildLock["harness"] {
  return isRecord(value) && exactKeys(value, ["id", "adapter_version", "upstream_version"]) &&
    ["pi", "claude", "vercel-ai-sdk", "eve", "mastra"].includes(String(value.id)) &&
    typeof value.adapter_version === "string" && value.adapter_version.trim().length > 0 &&
    value.adapter_version.length <= 128 &&
    typeof value.upstream_version === "string" && value.upstream_version.trim().length > 0 &&
    value.upstream_version.length <= 128;
}

function validCoreLockIdentity(value: CaveBuildLock | CaveBuildLockV3): boolean {
  return typeof value.agent_id === "string" && value.agent_id.trim().length > 0 &&
    typeof value.baseline_plan_id === "string" && value.baseline_plan_id.trim().length > 0 &&
    typeof value.selected_plan_id === "string" && value.selected_plan_id.trim().length > 0 &&
    [value.build_sha256, value.plan_sha256, value.source_sha256,
      value.agent_definition_sha256, value.context_ir_sha256,
      value.eval_suite_sha256, value.catalog_sha256]
      .every((item) => typeof item === "string" && /^[0-9a-f]{64}$/.test(item));
}

function validRuntime(value: unknown): value is CaveBuildLock["runtime"] {
  return isRecord(value) && exactKeys(value, [
    "caveman_version", "transform_registry_sha256", "external_provenance_sha256",
  ]) && typeof value.caveman_version === "string" && value.caveman_version.trim().length > 0 &&
    value.caveman_version.length <= 128 &&
    typeof value.transform_registry_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.transform_registry_sha256) &&
    typeof value.external_provenance_sha256 === "string" &&
    (value.external_provenance_sha256 === "" || /^[0-9a-f]{64}$/.test(value.external_provenance_sha256));
}

function validEvidence(value: unknown): value is CaveBuildLock["evidence"] {
  return isRecord(value) && exactKeys(value, [
    "status", "basis", "quality_retention_lcb95", "error_rate", "p95_latency_ms",
    "catalog_cost_usd_per_task", "completed_runs",
  ]) && value.status === "locked" && value.basis === "inferred" &&
    typeof value.quality_retention_lcb95 === "number" && Number.isFinite(value.quality_retention_lcb95) &&
    value.quality_retention_lcb95 >= 0 && value.quality_retention_lcb95 <= 1 &&
    typeof value.error_rate === "number" && Number.isFinite(value.error_rate) &&
    value.error_rate >= 0 && value.error_rate <= 1 &&
    Number.isSafeInteger(value.p95_latency_ms) && Number(value.p95_latency_ms) >= 0 &&
    typeof value.catalog_cost_usd_per_task === "number" &&
    Number.isFinite(value.catalog_cost_usd_per_task) && value.catalog_cost_usd_per_task >= 0 &&
    Number.isSafeInteger(value.completed_runs) && Number(value.completed_runs) > 0;
}

function validCompilerMetadata(value: unknown): value is CaveBuildLockV3["compiler"] {
  return isRecord(value) && exactKeys(value, [
    "id", "version", "compiler_sha256", "profile_sha256", "profile_partition_sha256",
    "development_sha256", "holdout_sha256", "policy_sha256", "capability_manifest_sha256",
  ]) && value.id === "@caveman-ai/agent/profiled-compiler" && value.version === "0.2.0" &&
    value.compiler_sha256 === PROFILED_COMPILER_IDENTITY_SHA256 &&
    [value.compiler_sha256, value.profile_sha256, value.profile_partition_sha256,
      value.development_sha256, value.holdout_sha256, value.policy_sha256,
      value.capability_manifest_sha256]
      .every((item) => typeof item === "string" && /^[0-9a-f]{64}$/.test(item));
}

const COMPILER_SEMANTICS: readonly CompilerSemantic[] = [
  "single_agent", "model_binding", "reasoning_binding", "output_budget_binding",
  "context_ir_binding", "transform_evidence", "recovery_evidence", "baseline_fallback",
  "abort_signal", "tool_effect:read", "tool_effect:idempotent", "tool_effect:write",
  "tool_effect:external",
];

function validCapabilityManifest(value: unknown): value is CompilerCapabilityManifest {
  if (!isRecord(value) || !exactKeys(value, [
    "schema_version", "target", "adapter_contract_sha256", "supported_semantics", "required_semantics",
  ]) || value.schema_version !== 1 ||
      !["pi", "claude", "vercel-ai-sdk", "eve", "mastra"].includes(String(value.target)) ||
      typeof value.adapter_contract_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.adapter_contract_sha256) ||
      !Array.isArray(value.supported_semantics) || !Array.isArray(value.required_semantics)) return false;
  const supported = value.supported_semantics;
  const required = value.required_semantics;
  const targetCapabilities = value.target === "pi" &&
      value.adapter_contract_sha256 === PI_NATIVE_COMPILER_CONTRACT_SHA256
    ? PI_NATIVE_COMPILER_CAPABILITIES
    : BUILD_TARGET_CAPABILITY_LATTICE[value.target as BuildHarnessID];
  return supported.every((item): item is CompilerSemantic =>
    typeof item === "string" && COMPILER_SEMANTICS.includes(item as CompilerSemantic)) &&
    required.every((item): item is CompilerSemantic =>
      typeof item === "string" && COMPILER_SEMANTICS.includes(item as CompilerSemantic)) &&
    new Set(supported).size === supported.length && new Set(required).size === required.length &&
    [...supported].sort().every((item, index) => item === supported[index]) &&
    [...required].sort().every((item, index) => item === required[index]) &&
    stableStringify(supported) === stableStringify(targetCapabilities) &&
    BASE_COMPILER_CAPABILITIES.every((item) => required.includes(item)) &&
    required.every((item) => supported.includes(item));
}

function validExecutablePipeline(value: unknown): value is ExecutablePipeline {
  if (!isRecord(value) || !exactKeys(value, [
    "schema_version", "target", "semantic_plan_sha256", "entry_step_id", "steps",
  ]) || value.schema_version !== 1 || value.entry_step_id !== "selected" ||
      !["pi", "claude", "vercel-ai-sdk", "eve", "mastra"].includes(String(value.target)) ||
      typeof value.semantic_plan_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.semantic_plan_sha256) ||
      !Array.isArray(value.steps) || value.steps.length !== 2) return false;
  const [selected, baseline] = value.steps;
  return isRecord(selected) && exactKeys(selected, [
    "step_id", "kind", "plan_id", "plan_sha256", "on_error",
  ]) && selected.step_id === "selected" && selected.kind === "harness" &&
    typeof selected.plan_id === "string" && typeof selected.plan_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(selected.plan_sha256) && selected.on_error === "abort" &&
    isRecord(baseline) && exactKeys(baseline, ["step_id", "kind", "plan_id", "plan_sha256"]) &&
    baseline.step_id === "baseline" && baseline.kind === "baseline_fallback" &&
    typeof baseline.plan_id === "string" && typeof baseline.plan_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(baseline.plan_sha256);
}

function validCompilerPass(value: unknown): value is CompilerPassRecord {
  return isRecord(value) && exactKeys(value, ["pass_id", "version", "basis", "evidence_sha256"]) &&
    typeof value.pass_id === "string" && validCompilerPassID(value.pass_id) && value.version === 1 &&
    value.basis === "development" && typeof value.evidence_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.evidence_sha256);
}

function validCompilerPassID(value: string): boolean {
  if ([
    "profile_guided_selection",
    "model_selection",
    "reasoning_selection",
    "output_budget_selection",
  ].includes(value)) return true;
  const [prefix, kind, transformID, extra] = value.split(":");
  return extra === undefined && prefix === "context_route" &&
    ["instruction", "user_intent", "tool_schema", "skill", "memory", "history",
      "tool_result", "artifact", "error", "output_contract"].includes(kind ?? "") &&
    /^caveman\.[a-z0-9.-]{1,120}$/.test(transformID ?? "");
}

function validValidation(value: unknown): value is CaveBuildLockV3["validation"] {
  return isRecord(value) && exactKeys(value, ["development", "holdout"]) &&
    validValidationEvidence(value.development) && validValidationEvidence(value.holdout);
}

function validValidationEvidence(value: unknown): value is ProfiledValidationEvidence {
  return isRecord(value) && exactKeys(value, [
    "split_sha256", "eval_suite_sha256", "completed_runs", "actual_cost_usd",
    "baseline_catalog_cost_usd_per_task", "selected_catalog_cost_usd_per_task", "selected_plan_id",
  ]) && typeof value.split_sha256 === "string" && /^[0-9a-f]{64}$/.test(value.split_sha256) &&
    typeof value.eval_suite_sha256 === "string" && /^[0-9a-f]{64}$/.test(value.eval_suite_sha256) &&
    Number.isSafeInteger(value.completed_runs) && Number(value.completed_runs) > 0 &&
    [value.actual_cost_usd, value.baseline_catalog_cost_usd_per_task,
      value.selected_catalog_cost_usd_per_task].every((item) =>
      typeof item === "number" && Number.isFinite(item) && item >= 0) &&
    typeof value.selected_plan_id === "string" && value.selected_plan_id.trim().length > 0;
}

function v3LockIntegrityErrors(lock: CaveBuildLockV3): string[] {
  const errors: string[] = [];
  const nativeContractClaim = lock.capability_manifest.target === "pi" &&
    lock.capability_manifest.adapter_contract_sha256 === PI_NATIVE_COMPILER_CONTRACT_SHA256;
  const nativePi = nativeContractClaim && lock.harness.id === "pi" &&
    lock.harness.adapter_version === PI_NATIVE_COMPILER_CONTRACT.adapter_version &&
    lock.harness.upstream_version === PI_NATIVE_COMPILER_CONTRACT.upstream_version;
  if (sha256(stableStringify(lock.selected_plan)) !== lock.plan_sha256) errors.push("plan_digest");
  if (lock.selected_plan.plan_id !== lock.selected_plan_id) errors.push("selected_plan_id");
  if (sha256(stableStringify(lock.baseline_fallback.plan)) !== lock.baseline_fallback.plan_sha256) {
    errors.push("baseline_plan_digest");
  }
  if (lock.baseline_fallback.plan.plan_id !== lock.baseline_fallback.plan_id ||
      lock.baseline_fallback.plan_id !== lock.baseline_plan_id) errors.push("baseline_plan_id");
  if (!nativePi && (stableStringify(lock.selected_plan) !== stableStringify(lock.baseline_fallback.plan) ||
      lock.selected_plan_id !== lock.baseline_plan_id ||
      lock.plan_sha256 !== lock.baseline_fallback.plan_sha256)) {
    errors.push("behavioral_lowering_unavailable");
  }
  if (nativePi) {
    errors.push(...nativePiPlanLoweringErrors(
      lock.baseline_fallback.plan,
      lock.selected_plan,
    ));
    if (stableStringify(lock.capability_manifest.required_semantics) !== stableStringify(
      nativePiRequiredSemanticsForPlanDiff(lock.baseline_fallback.plan, lock.selected_plan),
    )) errors.push("native_required_semantics");
  }
  if (nativeContractClaim && !nativePi) errors.push("native_contract_identity");
  if (lock.harness.id === "claude") errors.push("target_not_executable");
  if (lock.harness.id === "eve" && lock.selected_plan.reasoning !== "none") {
    errors.push("eve_reasoning_unobservable");
  }
  if (lock.executable_pipeline.target !== lock.harness.id ||
      lock.capability_manifest.target !== lock.harness.id) errors.push("target");
  if (lock.executable_pipeline.semantic_plan_sha256 !== lock.plan_sha256) errors.push("semantic_plan_digest");
  const [selected, baseline] = lock.executable_pipeline.steps;
  if (selected.plan_id !== lock.selected_plan_id || selected.plan_sha256 !== lock.plan_sha256) {
    errors.push("selected_step");
  }
  if (selected.on_error !== "abort") errors.push("fallback_policy");
  if (baseline.plan_id !== lock.baseline_fallback.plan_id ||
      baseline.plan_sha256 !== lock.baseline_fallback.plan_sha256) errors.push("baseline_step");
  if (sha256(stableStringify(lock.capability_manifest)) !== lock.compiler.capability_manifest_sha256) {
    errors.push("capability_manifest_digest");
  }
  if (lock.validation.development.selected_plan_id !== lock.selected_plan_id ||
      lock.validation.holdout.selected_plan_id !== lock.selected_plan_id) errors.push("validation_plan");
  if (!nativePi && (lock.validation.development.selected_catalog_cost_usd_per_task !==
        lock.validation.development.baseline_catalog_cost_usd_per_task ||
      lock.validation.holdout.selected_catalog_cost_usd_per_task !==
        lock.validation.holdout.baseline_catalog_cost_usd_per_task)) {
    errors.push("baseline_economics");
  }
  if (nativePi && (
    lock.validation.development.selected_catalog_cost_usd_per_task >
      lock.validation.development.baseline_catalog_cost_usd_per_task ||
    lock.validation.holdout.selected_catalog_cost_usd_per_task >
      lock.validation.holdout.baseline_catalog_cost_usd_per_task
  )) errors.push("native_cost_regression");
  if (lock.evidence.catalog_cost_usd_per_task !==
      lock.validation.holdout.selected_catalog_cost_usd_per_task) errors.push("evidence_cost");
  if (sha256(stableStringify({
    split_sha256: lock.validation.development.split_sha256,
    eval_suite_sha256: lock.validation.development.eval_suite_sha256,
  })) !== lock.compiler.development_sha256) errors.push("development_digest");
  if (sha256(stableStringify({
    split_sha256: lock.validation.holdout.split_sha256,
    eval_suite_sha256: lock.validation.holdout.eval_suite_sha256,
  })) !== lock.compiler.holdout_sha256) errors.push("holdout_digest");
  if (sha256(stableStringify({
    development: lock.validation.development.eval_suite_sha256,
    holdout: lock.validation.holdout.eval_suite_sha256,
  })) !== lock.eval_suite_sha256) errors.push("eval_suite_digest");
  const actualPassIDs = lock.passes.map((pass) => pass.pass_id);
  if (stableStringify(actualPassIDs) !== stableStringify(
    compilerPassIDsForPlanDiff(lock.baseline_fallback.plan, lock.selected_plan),
  )) {
    errors.push("pass_manifest");
  }
  if (lock.passes.some((pass) => pass.evidence_sha256 !== sha256(stableStringify({
    development: lock.validation.development,
    pass_id: pass.pass_id,
    selected: lock.selected_plan_id,
  })))) errors.push("pass_evidence_digest");
  const { build_sha256: _build, ...withoutBuild } = lock;
  if (sha256(stableStringify(withoutBuild)) !== lock.build_sha256) errors.push("build_digest");
  return errors;
}

export function compilerPassIDsForPlanDiff(
  baseline: CavePlan,
  selected: CavePlan,
): string[] {
  const passes = new Set<string>(["profile_guided_selection"]);
  if (baseline.model !== selected.model) passes.add("model_selection");
  if (baseline.reasoning !== selected.reasoning) passes.add("reasoning_selection");
  if (baseline.budgets.output !== selected.budgets.output) passes.add("output_budget_selection");
  const baselineRoutes = new Set(baseline.segment_routes.map((route) => stableStringify(route)));
  for (const route of selected.segment_routes) {
    if (!baselineRoutes.has(stableStringify(route))) {
      passes.add(`context_route:${route.segment_kind}:${route.transform_id}`);
    }
  }
  return [...passes].sort();
}

/** Exact behavior bindings required by a compiler-owned, tool-free native Pi plan. */
export function nativePiRequiredSemanticsForPlanDiff(
  baseline: CavePlan,
  selected: CavePlan,
): CompilerSemantic[] {
  const required = new Set<CompilerSemantic>(["abort_signal", "single_agent"]);
  if (baseline.model !== selected.model) required.add("model_binding");
  if (baseline.reasoning !== selected.reasoning) required.add("reasoning_binding");
  if (baseline.budgets.output !== selected.budgets.output) {
    required.add("output_budget_binding");
  }
  if (stableStringify(baseline.segment_routes) !== stableStringify(selected.segment_routes)) {
    required.add("context_ir_binding");
    required.add("transform_evidence");
    required.add("recovery_evidence");
  }
  return [...required].sort();
}

/** Fields exact native Pi v0.2 can materialize and validate. */
export function nativePiPlanLoweringErrors(
  baseline: CavePlan,
  selected: CavePlan,
): string[] {
  const errors: string[] = [];
  if (baseline.segment_routes.length !== 0 ||
      stableStringify(baseline.recovery.tools) !== stableStringify([])) {
    errors.push("native_baseline_not_pass_through");
  }
  const unchangedBudgetKeys: readonly (keyof CavePlan["budgets"])[] = [
    "instructions", "tools", "memory", "history", "results_artifacts",
    "reasoning", "retry_cascade_reserve",
  ];
  if (unchangedBudgetKeys.some((key) => selected.budgets[key] !== baseline.budgets[key])) {
    errors.push("native_budget_delta_unsupported");
  }
  if (selected.budgets.output > baseline.budgets.output) {
    errors.push("native_output_budget_increase");
  }
  const reasoningRank: Readonly<Record<CavePlan["reasoning"], number>> = {
    none: 0,
    minimal: 1,
    low: 2,
    medium: 3,
    high: 4,
  };
  if (reasoningRank[selected.reasoning] > reasoningRank[baseline.reasoning]) {
    errors.push("native_reasoning_increase");
  }
  if (selected.recovery.namespace !== baseline.recovery.namespace) {
    errors.push("native_recovery_namespace_delta");
  }
  if (stableStringify(selected.recovery.tools) !==
      stableStringify(recoveryTools(selected.segment_routes))) {
    errors.push("native_recovery_tools_delta");
  }
  if (stableStringify(selected.fallbacks) !== stableStringify(baseline.fallbacks)) {
    errors.push("native_fallback_delta");
  }
  const routes = selected.segment_routes.map((route) => stableStringify(route));
  if (new Set(routes).size !== routes.length) errors.push("native_duplicate_route");
  const routeTargets = selected.segment_routes.map((route) =>
    `${route.segment_kind}\u0000${route.segment_id ?? ""}`);
  if (new Set(routeTargets).size !== routeTargets.length) errors.push("native_duplicate_route_target");
  const sameBehavior = stableStringify({ ...baseline, plan_id: "" }) ===
    stableStringify({ ...selected, plan_id: "" });
  if (!sameBehavior && baseline.plan_id === selected.plan_id) {
    errors.push("native_behavior_delta_plan_id_unchanged");
  }
  if (sameBehavior && baseline.plan_id !== selected.plan_id) errors.push("native_plan_id_only_delta");
  return [...new Set(errors)].sort();
}

function validPlanShape(plan: Record<string, unknown>): boolean {
  if (plan.schema_version !== 1 || typeof plan.plan_id !== "string" || plan.plan_id.trim().length === 0 ||
      typeof plan.model !== "string" || plan.model.trim().length === 0 ||
      !["none", "minimal", "low", "medium", "high"].includes(String(plan.reasoning)) ||
      !isRecord(plan.budgets) || !exactKeys(plan.budgets, [
        "instructions", "tools", "memory", "history", "results_artifacts",
        "reasoning", "output", "retry_cascade_reserve",
      ]) ||
      Object.values(plan.budgets).some((value) => !Number.isSafeInteger(value) || Number(value) < 0) ||
      !isRecord(plan.recovery) || !exactKeys(plan.recovery, ["namespace", "tools"]) ||
      !isRecord(plan.fallbacks) || !exactKeys(plan.fallbacks, ["unknown", "transform_error", "not_smaller"]) ||
      !Array.isArray(plan.segment_routes)) {
    return false;
  }
  const recoveryTools = plan.recovery.tools;
  if (typeof plan.recovery.namespace !== "string" || plan.recovery.namespace.trim().length === 0 ||
      !Array.isArray(recoveryTools) || new Set(recoveryTools).size !== recoveryTools.length ||
      recoveryTools.some((tool) => !["cave_retrieve", "cave_search_tools", "cave_memory_search",
        "cave_artifact_page"].includes(String(tool))) ||
      plan.fallbacks.unknown !== "original" || plan.fallbacks.transform_error !== "original" ||
      plan.fallbacks.not_smaller !== "original") return false;
  const contextKinds = ["instruction", "user_intent", "tool_schema", "skill", "memory", "history",
    "tool_result", "artifact", "error", "output_contract"];
  return plan.segment_routes.every((route) =>
    isRecord(route) &&
    (exactKeys(route, ["segment_kind", "transform_id", "fallback"]) ||
      exactKeys(route, ["segment_kind", "segment_id", "transform_id", "fallback"])) &&
    typeof route.segment_kind === "string" && contextKinds.includes(route.segment_kind) &&
    typeof route.transform_id === "string" && /^caveman\.[a-z0-9.-]{1,120}$/.test(route.transform_id) &&
    (route.segment_id === undefined || (typeof route.segment_id === "string" && route.segment_id.trim().length > 0)) &&
    route.fallback === "original");
}

function hasWellFormedUnicode(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        return false;
      }
    }
    return true;
  }
  if (value === null || typeof value !== "object") return true;
  if (seen.has(value)) return true;
  seen.add(value);
  return Object.entries(value).every(([key, child]) =>
    hasWellFormedUnicode(key, seen) && hasWellFormedUnicode(child, seen));
}

function lockIntegrityErrors(lock: CaveBuildLock): string[] {
  const errors: string[] = [];
  if (sha256(stableStringify(lock.selected_plan)) !== lock.plan_sha256) errors.push("plan_digest");
  const { build_sha256: _build, ...withoutBuild } = lock;
  if (sha256(stableStringify(withoutBuild)) !== lock.build_sha256) errors.push("build_digest");
  return errors;
}

export function agentDefinitionSHA256(agent: AgentDefinition): string {
  return sha256(stableStringify(lockableValue(agent, new WeakSet<object>())));
}

export function toolDefinitionSHA256(tool: ToolDefinition): string {
  return sha256(stableStringify(lockableValue(tool, new WeakSet<object>())));
}

export function contextIRSHA256(contextIR: ContextIR): string {
  return sha256(stableStringify(contextIRToWire(contextIR)));
}

function lockableValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") return { cave_bigint: value.toString() };
  if (typeof value === "function" || typeof value === "undefined" || typeof value === "symbol") {
    return undefined;
  }
  if (typeof value !== "object") {
    throw new Error("caveman build: agent definition contains an unsupported value");
  }
  if (seen.has(value)) throw new Error("caveman build: cyclic agent definition is not lockable");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => lockableValue(item, seen) ?? null);
    }
    const projected: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const locked = lockableValue(item, seen);
      if (locked !== undefined) projected[key] = locked;
    }
    const implementationSource = Reflect.get(
      value,
      Symbol.for("@caveman-ai/agent:tool-implementation-source"),
    );
    if (typeof implementationSource === "string") {
      projected.cave_tool_implementation_sha256 = sha256(implementationSource);
    }
    const schemaImplementationSource = Reflect.get(
      value,
      Symbol.for("@caveman-ai/agent:tool-schema-implementation-source"),
    );
    if (typeof schemaImplementationSource === "string") {
      projected.cave_tool_schema_implementation_sha256 = sha256(schemaImplementationSource);
    }
    return projected;
  } finally {
    seen.delete(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runnerFailureCode(error: unknown): string {
  let current = error;
  let code = "cave_runner_failed";
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const matches = [...current.message.matchAll(/\b(cave_[a-z0-9_.-]+)/g)];
    if (matches.at(-1)?.[1] !== undefined) code = matches.at(-1)![1]!;
    current = current.cause;
  }
  return code;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index]);
}

export function generateCandidatePlans(
  agent: AgentDefinition,
  contextIR: ContextIR,
  baseline: CavePlan,
  models: string[],
  includeTransformCandidates: boolean,
  preferredTransforms: ReadonlyMap<string, string> = new Map(),
  transformCapabilities: readonly TransformCapability[] = ENGINE_TRANSFORM_CAPABILITIES,
  observedDynamicKinds: ReadonlySet<ContextKind> = new Set(),
  policy?: CandidatePolicy,
  accountingAt: Date = new Date(),
): CandidatePlan[] {
  const candidates: CandidatePlan[] = [{
    plan: baseline,
    estimated_cost_usd_per_run: 0.01,
  }];
  if (includeTransformCandidates) {
    const candidateRoute = (
      segmentKind: ContextKind,
      transformID: string,
      segmentID?: string,
    ): CavePlan["segment_routes"][number] => ({
      ...(segmentID === undefined ? {} : { segment_id: segmentID }),
      segment_kind: segmentKind,
      transform_id: transformID,
      fallback: "original",
    });
    for (const segment of contextIR.segments) {
      if (segment.safety !== "S4" || segment.opaque || opaqueSegmentID(segment.id)) continue;
      for (const capability of transformCapabilities) {
        if (!capability.segmentKinds.includes(segment.kind)) continue;
        const routes: CavePlan["segment_routes"] = [
          candidateRoute(segment.kind, capability.transformID, segment.id),
        ];
        candidates.push({
          plan: {
            ...baseline,
            plan_id: `${baseline.plan_id}.segment.${stableID(segment.id)}.${stableID(capability.transformID)}`,
            segment_routes: routes,
            recovery: { namespace: agent.id, tools: recoveryTools(routes) },
          },
          estimated_cost_usd_per_run: 0.008,
        });
      }
    }
    // History and tool results do not exist until runtime. They still need a
    // finite, eval-gated frontier so compiler can select a locked route using
    // real fixture traffic rather than silently leaving dynamic context out.
    const representedKinds = new Set(contextIR.segments.map((segment) => segment.kind));
    const dynamicKinds = [...observedDynamicKinds]
      .filter((kind): kind is "history" | "tool_result" =>
        kind === "history" || kind === "tool_result");
    for (const segmentKind of dynamicKinds) {
      if (representedKinds.has(segmentKind)) continue;
      for (const capability of transformCapabilities) {
        if (!capability.segmentKinds.includes(segmentKind)) continue;
        const routes: CavePlan["segment_routes"] = [
          candidateRoute(segmentKind, capability.transformID),
        ];
        candidates.push({
          plan: {
            ...baseline,
            plan_id: `${baseline.plan_id}.dynamic.${segmentKind}.${stableID(capability.transformID)}`,
            segment_routes: routes,
            recovery: { namespace: agent.id, tools: recoveryTools(routes) },
          },
          estimated_cost_usd_per_run: 0.008,
        });
      }
    }
    if (dynamicKinds.length > 1) {
      let combinations: CavePlan["segment_routes"][] = [[]];
      for (const segmentKind of dynamicKinds) {
        const options = transformCapabilities
          .filter((capability) => capability.segmentKinds.includes(segmentKind))
          .map((capability) => candidateRoute(segmentKind, capability.transformID));
        combinations = combinations.flatMap((routes) =>
          options.map((route) => [...routes, route]));
      }
      for (const routes of combinations) {
        candidates.push({
          plan: {
            ...baseline,
            plan_id: `${baseline.plan_id}.dynamic-joint.${routes.map((route) =>
              `${route.segment_kind}.${stableID(route.transform_id)}`).join(".")}`,
            segment_routes: routes,
            recovery: { namespace: agent.id, tools: recoveryTools(routes) },
          },
          estimated_cost_usd_per_run: 0.006,
        });
      }
    }
    const profiledRoutes: CavePlan["segment_routes"] = [];
    for (const segment of contextIR.segments) {
      const transformID = preferredTransforms.get(segment.id);
      if (!transformID || segment.safety !== "S4" || segment.opaque || opaqueSegmentID(segment.id)) continue;
      const capability = transformCapabilities.find((item) => item.transformID === transformID);
      if (!capability?.segmentKinds.includes(segment.kind)) continue;
      profiledRoutes.push(candidateRoute(segment.kind, transformID, segment.id));
    }
    if (profiledRoutes.length > 0) {
      candidates.push({
        plan: {
          ...baseline,
          plan_id: `${baseline.plan_id}.profiled-best-of`,
          segment_routes: profiledRoutes,
          recovery: { namespace: agent.id, tools: recoveryTools(profiledRoutes) },
        },
        estimated_cost_usd_per_run: 0.006,
      });
    }
  }

  const contextPlans = [...candidates];
  for (const contextPlan of contextPlans) {
    for (const model of models) {
      if (model === contextPlan.plan.model) continue;
      candidates.push({
        ...contextPlan,
        plan: {
          ...contextPlan.plan,
          plan_id: `${contextPlan.plan.plan_id}.model.${stableID(model)}`,
          model,
        },
      });
    }
  }
  const modelPlans = [...candidates];
  const reasoningOrder: CavePlan["reasoning"][] = ["none", "minimal", "low", "medium", "high"];
  for (const modelPlan of modelPlans) {
    const baselineIndex = reasoningOrder.indexOf(modelPlan.plan.reasoning);
    for (const reasoning of reasoningOrder.slice(0, baselineIndex)) {
      candidates.push({
        ...modelPlan,
        plan: {
          ...modelPlan.plan,
          plan_id: `${modelPlan.plan.plan_id}.reasoning.${reasoning}`,
          reasoning,
        },
      });
    }
  }
  // Runtime output allowance is searched, not recommended after the fact.
  // Development selects; untouched holdout must independently retain quality.
  const reasoningPlans = [...candidates];
  for (const candidate of reasoningPlans) {
    for (const output of outputBudgetFrontier(candidate.plan.budgets.output)) {
      candidates.push({
        ...candidate,
        plan: {
          ...candidate.plan,
          plan_id: `${candidate.plan.plan_id}.output.${output}`,
          budgets: { ...candidate.plan.budgets, output },
        },
      });
    }
  }
  const deduplicated = deduplicatePlans(candidates);
  // The catalog pricing + model/safety-class policy filter live HERE, not just
  // in the CLI, so the public compile() API enforces exactly what the CLI does
  // An unpriced model becomes a static_rejection, a denied/
  // disallowed model or a forbidden safety class is rejected, and every runnable
  // candidate carries its real public-catalog search ceiling. When no policy is
  // supplied the candidates keep their generation-time placeholder costs.
  return policy === undefined
    ? deduplicated
    : applyCandidatePolicy(deduplicated, policy, accountingAt);
}

function outputBudgetFrontier(baseline: number): number[] {
  if (!Number.isSafeInteger(baseline) || baseline <= 1) return [];
  const floor = Math.min(64, baseline);
  return [...new Set([0.5, 0.25, 0.125].map((ratio) =>
    Math.max(floor, Math.floor(baseline * ratio))))]
    .filter((value) => value > 0 && value < baseline)
    .sort((left, right) => right - left);
}

/** Model/safety-class policy applied to generated candidates. */
export interface CandidatePolicy {
  readonly allowedModels?: readonly string[];
  readonly deniedModels?: readonly string[];
  readonly forbiddenSafetyClasses?: readonly string[];
}

function candidatePolicy(config: BuildConfig): CandidatePolicy {
  return {
    ...(config.allowedModels === undefined ? {} : { allowedModels: config.allowedModels }),
    ...(config.deniedModels === undefined ? {} : { deniedModels: config.deniedModels }),
    ...(config.forbiddenSafetyClasses === undefined
      ? {}
      : { forbiddenSafetyClasses: config.forbiddenSafetyClasses }),
  };
}

/** Validate, canonically snapshot, policy-check, price, and freeze runner input. */
export function prepareCandidatePlans(
  candidates: readonly CandidatePlan[],
  baseline: CavePlan,
  policy: CandidatePolicy,
  options: {
    readonly compilerGenerated: boolean;
    readonly contextIR: ContextIR;
    readonly observedDynamicKinds: ReadonlySet<ContextKind>;
  },
  accountingAt: Date = new Date(),
): CandidatePlan[] {
  if (!Array.isArray(candidates) || candidates.length === 0 ||
      !isRecord(baseline) || !validPlanShape(baseline)) {
    throw new Error("cave_candidate_shape_invalid");
  }
  type StaticRejection = NonNullable<CandidatePlan["static_rejection"]>;
  const allowedRejections: ReadonlySet<StaticRejection> = new Set([
    "unsupported_provider", "forbidden_transform", "unpriced_model", "dominated", "policy_denied",
  ]);
  const planIDs = new Set<string>();
  const snapshots: CandidatePlan[] = (candidates as readonly unknown[]).map((candidate) => {
    if (!isRecord(candidate) ||
        !Object.keys(candidate).every((key) => [
          "plan", "estimated_cost_usd_per_run", "static_rejection",
        ].includes(key)) ||
        !("plan" in candidate) || !("estimated_cost_usd_per_run" in candidate)) {
      throw new Error("cave_candidate_shape_invalid");
    }
    const estimatedCost = candidate.estimated_cost_usd_per_run;
    const staticRejection = candidate.static_rejection;
    if (typeof estimatedCost !== "number" || !Number.isFinite(estimatedCost) || estimatedCost < 0 ||
        (staticRejection !== undefined &&
          (typeof staticRejection !== "string" ||
            !allowedRejections.has(staticRejection as StaticRejection)))) {
      throw new Error("cave_candidate_shape_invalid");
    }
    const plan = JSON.parse(stableStringify(candidate.plan)) as CavePlan;
    if (!isRecord(plan) || !validPlanShape(plan) || planIDs.has(plan.plan_id)) {
      throw new Error("cave_candidate_plan_invalid");
    }
    planIDs.add(plan.plan_id);
    for (const route of plan.segment_routes) {
      const capability = ENGINE_TRANSFORM_CAPABILITIES.find((item) =>
        item.transformID === route.transform_id && item.segmentKinds.includes(route.segment_kind));
      if (capability === undefined) throw new Error("cave_candidate_transform_unsupported");
      if (route.segment_id === undefined) {
        if ((route.segment_kind !== "history" && route.segment_kind !== "tool_result") ||
            !options.observedDynamicKinds.has(route.segment_kind)) {
          throw new Error("cave_candidate_dynamic_route_unobserved");
        }
      } else {
        const segment = options.contextIR.segments.find((item) => item.id === route.segment_id);
        if (segment === undefined || segment.kind !== route.segment_kind || segment.safety !== "S4" ||
            segment.opaque || opaqueSegmentID(segment.id)) {
          throw new Error("cave_candidate_segment_route_unsafe");
        }
      }
    }
    if (stableStringify(plan.recovery.tools) !== stableStringify(recoveryTools(plan.segment_routes))) {
      throw new Error("cave_candidate_recovery_tools_invalid");
    }
    return {
      plan,
      estimated_cost_usd_per_run: estimatedCost,
      ...(!options.compilerGenerated || staticRejection === undefined
        ? {}
        : { static_rejection: staticRejection as StaticRejection }),
    } satisfies CandidatePlan;
  });
  const baselineCanonical = stableStringify(baseline);
  if (!snapshots.some((candidate) => stableStringify(candidate.plan) === baselineCanonical)) {
    throw new Error("cave_candidate_baseline_missing");
  }
  return freezeBuildValue(applyCandidatePolicy(snapshots, policy, accountingAt));
}

function applyCandidatePolicy(
  candidates: readonly CandidatePlan[],
  policy: CandidatePolicy,
  accountingAt: Date,
): CandidatePlan[] {
  return candidates.map((candidate) => {
    if (candidate.static_rejection !== undefined) return candidate;
    if (policy.deniedModels?.includes(candidate.plan.model) ||
        (policy.allowedModels !== undefined && !policy.allowedModels.includes(candidate.plan.model))) {
      return { ...candidate, static_rejection: "policy_denied" as const };
    }
    if (policy.forbiddenSafetyClasses?.includes("S4") &&
        candidate.plan.segment_routes.some((route) => route.transform_id.startsWith("caveman.engine."))) {
      return { ...candidate, static_rejection: "forbidden_transform" as const };
    }
    const budgets = candidate.plan.budgets;
    const ceiling = catalogSearchCeiling(
      candidate.plan.model,
      budgets.instructions + budgets.tools + budgets.memory + budgets.history +
        budgets.results_artifacts + budgets.retry_cascade_reserve,
      budgets.output + budgets.reasoning,
      accountingAt,
    );
    if (ceiling === undefined) {
      return { ...candidate, static_rejection: "unpriced_model" as const };
    }
    return { ...candidate, estimated_cost_usd_per_run: ceiling };
  });
}

function freezeBuildValue<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeBuildValue(child);
  }
  return value;
}

export interface TransformCapability {
  transformID: string;
  segmentKinds: readonly ContextKind[];
}

const ENGINE_TRANSFORM_CAPABILITIES: readonly TransformCapability[] = [
  { transformID: "caveman.engine.a11y.v1", segmentKinds: ["artifact", "tool_result"] },
  ...["code", "config", "diff", "html", "json", "log", "search-result", "tabular", "terminal", "text", "toon"]
    .map((name) => ({
      transformID: `caveman.engine.${name}.v1`,
      segmentKinds: ["artifact", "history", "skill", "tool_result"] as const,
    })),
  { transformID: "caveman.engine.repetition.v1", segmentKinds: ["history", "tool_result"] },
  { transformID: "caveman.engine.toolschema.v1", segmentKinds: ["tool_schema"] },
];

function opaqueSegmentID(id: string): boolean {
  return /(?:opaque|signed|signature|jwt|token|cipher|encrypted)/i.test(id);
}

function summarizeCandidate(
  candidate: CandidatePlan,
  evidence: Completed["evidence"],
  baseline: Completed["evidence"],
  config: BuildConfig,
  seedDigest: string,
  evals: EvalDefinition[],
): Completed {
  const requiredPassed = evidence.filter(({ value }) =>
    value.graders.length > 0 && value.graders.every((grader) => grader.passed)).length;
  const fixturePassRate = evidence.length === 0 ? 0 : requiredPassed / evidence.length;
  const errorRate = evidence.length === 0 ? 1 : evidence.filter(({ value }) => value.error).length / evidence.length;
  // Wire contract stores whole milliseconds. Round up so registration never
  // understates latency or rejects a real performance.now()-derived lock.
  const p95Latency = Math.ceil(percentile(evidence.map(({ value }) => value.latency_ms), 0.95));
  const costPerTask = roundUsd(evidence.reduce((sum, run) => sum + run.value.catalog_cost_usd, 0) / Math.max(1, evidence.length));
  const baselineByKey = new Map(baseline.map((run) => [`${run.fixture}:${run.seed}`, run.value.quality_score]));
  // Numeric seeds are orchestration/cache labels, not proven independent model
  // draws. Collapse repeats conservatively within each fixture, then bootstrap
  // only across distinct eval fixtures/task families. One fixture cannot mint a
  // 95% retention bound.
  const evalsByFamily = new Map<string, EvalDefinition[]>();
  for (const fixture of evals) {
    const family = fixture.lineageId ?? fixture.id;
    const rows = evalsByFamily.get(family) ?? [];
    rows.push(fixture);
    evalsByFamily.set(family, rows);
  }
  const pairedByFixture = [...evalsByFamily.values()].map((familyFixtures) => {
    const fixtureIDs = new Set(familyFixtures.map((fixture) => fixture.id));
    const ratios = evidence.filter((run) => fixtureIDs.has(run.fixture)).map((run) => {
      const base = baselineByKey.get(`${run.fixture}:${run.seed}`);
      if (base === undefined || base <= 0) return undefined;
      return Math.min(1, Math.max(0, run.value.quality_score / base));
    }).filter((value): value is number => value !== undefined);
    return ratios.length === 0 ? undefined : Math.min(...ratios);
  }).filter((value): value is number => value !== undefined);
  const retentionLCB95 = bootstrapLCB95(pairedByFixture, seedDigest);
  const fixtureGuardrailsPass = evals.every((fixture) => {
    const runs = evidence.filter((run) => run.fixture === fixture.id).map((run) => run.value);
    return runs.length > 0 && fixture.guardrails.every((guardrail) => {
      if (guardrail.type === "latency_threshold") {
        return percentile(runs.map((run) => run.latency_ms), 0.95) <= guardrail.p95_ms;
      }
      if (guardrail.type === "error_rate") {
        return runs.filter((run) => run.error).length / runs.length <= guardrail.max;
      }
      return false;
    });
  });
  const passing = fixturePassRate >= config.requiredFixturePassRate &&
    errorRate === 0 &&
    fixtureGuardrailsPass &&
    cacheGatePass(evidence, baseline, candidate.plan) &&
    retentionLCB95 >= config.qualityRetention &&
    (config.maxP95LatencyMs === undefined || p95Latency <= config.maxP95LatencyMs);
  return { candidate, evidence, costPerTask, errorRate, p95Latency, fixturePassRate, retentionLCB95, passing };
}

function cacheGatePass(
  evidence: Completed["evidence"],
  baseline: Completed["evidence"],
  plan: CavePlan,
): boolean {
  const byFixture = new Map<string, Completed["evidence"]>();
  const baselineByFixture = new Map<string, Completed["evidence"]>();
  for (const run of evidence) {
    const rows = byFixture.get(run.fixture) ?? [];
    rows.push(run);
    byFixture.set(run.fixture, rows);
  }
  for (const run of baseline) {
    const rows = baselineByFixture.get(run.fixture) ?? [];
    rows.push(run);
    baselineByFixture.set(run.fixture, rows);
  }
  for (const [fixture, rows] of byFixture) {
    const baseRows = baselineByFixture.get(fixture);
    if (!baseRows || rows.length < 5 || baseRows.length < 5) return false;
    rows.sort((a, b) => a.seed - b.seed);
    baseRows.sort((a, b) => a.seed - b.seed);
    const prefixes = new Set(rows.map((run) => run.value.cache_prefix_sha256));
    if (prefixes.size !== 1 ||
        rows.some((run) => !run.value.cache_boundary_known || run.value.cache_bust)) return false;
    const cacheSensitive = plan.segment_routes.length > 0;
    if (cacheSensitive &&
        (rows[0]!.value.cache_read_tokens !== 0 ||
          rows.slice(1).some((run) => run.value.cache_read_tokens <= 0))) return false;
    const warmCost = rows.slice(1).reduce((sum, run) => sum + run.value.catalog_cost_usd, 0);
    const baselineWarmCost = baseRows.slice(1).reduce((sum, run) => sum + run.value.catalog_cost_usd, 0);
    if (warmCost > baselineWarmCost + 1e-12) return false;
    const baselinePrefixes = new Set(baseRows.map((run) => run.value.cache_prefix_sha256));
    const startsNewEpoch = plan.segment_routes.length > 0 &&
      (baselinePrefixes.size !== 1 || !baselinePrefixes.has(rows[0]!.value.cache_prefix_sha256));
    if (startsNewEpoch) {
      const totalCost = rows.reduce((sum, run) => sum + run.value.catalog_cost_usd, 0);
      const baselineTotalCost = baseRows.reduce((sum, run) => sum + run.value.catalog_cost_usd, 0);
      if (totalCost >= baselineTotalCost - 1e-12) return false;
    }
  }
  return true;
}

function repriceRunEvidence(value: unknown, startedAt: Date, finishedAt: Date): RunEvidence {
  const source = isRecord(value) ? value : {};
  const usageComplete = typeof source.provider === "string" && source.provider.length > 0 &&
    typeof source.model === "string" && source.model.length > 0 &&
    [source.input_tokens, source.output_tokens, source.cache_read_tokens,
      source.cache_write_tokens, source.reasoning_tokens].every((item) =>
      typeof item === "number" && Number.isSafeInteger(item) && item >= 0) &&
    Number(source.output_tokens) >= Number(source.reasoning_tokens) &&
    Number(source.input_tokens) + Number(source.output_tokens) +
      Number(source.cache_read_tokens) + Number(source.cache_write_tokens) > 0;
  const usage = {
    provider: String(source.provider),
    model: String(source.model),
    inputTokens: Number(source.input_tokens),
    outputTokens: Number(source.output_tokens),
    cacheReadTokens: Number(source.cache_read_tokens),
    cacheWriteTokens: Number(source.cache_write_tokens),
    reasoningTokens: Number(source.reasoning_tokens),
  };
  const atStart = usageComplete ? catalogCost(usage, startedAt) : { priced: false, usd: 0 };
  const atFinish = usageComplete ? catalogCost(usage, finishedAt) : { priced: false, usd: 0 };
  const rateFingerprintAtStart = usageComplete
    ? catalogPriceFingerprint(String(source.provider), String(source.model), startedAt)
    : undefined;
  const rateFingerprintAtFinish = usageComplete
    ? catalogPriceFingerprint(String(source.provider), String(source.model), finishedAt)
    : undefined;
  // The compiler owns these timestamps. A caller cannot forge cost, and a run
  // spanning a recurring price transition is rejected rather than aggregate-
  // priced at either side of the boundary.
  const priced = atStart.priced && atFinish.priced && atStart.usd === atFinish.usd &&
    rateFingerprintAtStart !== undefined && rateFingerprintAtStart === rateFingerprintAtFinish
    ? atStart
    : { priced: false, usd: 0 };
  return freezeBuildValue({
    ...source,
    price_basis: priced.priced ? "public_catalog" as const : "unpriced" as const,
    catalog_cost_usd: priced.usd,
  } as unknown as RunEvidence);
}

function providerModelMatchesPlan(value: RunEvidence, plan: CavePlan): boolean {
  const separator = plan.model.indexOf("/");
  if (separator <= 0 || separator === plan.model.length - 1) return false;
  const expectedProvider = normalizeCatalogProvider(plan.model.slice(0, separator));
  const expectedModel = plan.model.slice(separator + 1);
  return normalizeCatalogProvider(value.provider) === expectedProvider && value.model === expectedModel;
}

function normalizeCatalogProvider(provider: string): string {
  if (provider === "google") return "gemini";
  if (provider === "google-vertex") return "vertex";
  return provider;
}

function completeEvidence(
  value: unknown,
  plan: CavePlan,
  fixture: EvalDefinition,
): value is RunEvidence {
  if (!isRecord(value) || !Array.isArray(value.graders)) return false;
  const gradersValid = value.graders.length > 0 && value.graders.every((grader) =>
    isRecord(grader) && exactKeys(grader, ["type", "passed"]) &&
    typeof grader.type === "string" && knownGrader(grader.type) &&
    typeof grader.passed === "boolean");
  if (value.terminal !== true || typeof value.provider !== "string" || value.provider.length === 0 ||
      typeof value.model !== "string" || value.model.length === 0 ||
      value.usage_basis !== "provider_reported" || value.price_basis !== "public_catalog" ||
      typeof value.catalog_cost_usd !== "number" || !Number.isFinite(value.catalog_cost_usd) ||
      value.catalog_cost_usd < 0 || typeof value.input_tokens !== "number" ||
      !Number.isSafeInteger(value.input_tokens) || value.input_tokens < 0 ||
      typeof value.output_tokens !== "number" || !Number.isSafeInteger(value.output_tokens) ||
      value.output_tokens < 0 || typeof value.reasoning_tokens !== "number" ||
      !Number.isSafeInteger(value.reasoning_tokens) || value.reasoning_tokens < 0 ||
      typeof value.quality_score !== "number" || !Number.isFinite(value.quality_score) ||
      value.quality_score < 0 || value.quality_score > 1 ||
      typeof value.latency_ms !== "number" || !Number.isFinite(value.latency_ms) ||
      value.latency_ms < 0 || typeof value.provider_visible_tokens !== "number" ||
      !Number.isSafeInteger(value.provider_visible_tokens) ||
      typeof value.cache_prefix_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.cache_prefix_sha256) ||
      value.cache_boundary_known !== true || typeof value.cache_read_tokens !== "number" ||
      !Number.isSafeInteger(value.cache_read_tokens) || value.cache_read_tokens < 0 ||
      typeof value.cache_write_tokens !== "number" ||
      !Number.isSafeInteger(value.cache_write_tokens) || value.cache_write_tokens < 0 ||
      value.cache_bust !== false || !gradersValid || typeof value.error !== "boolean" ||
      (value.unknown_event !== undefined && value.unknown_event !== false) ||
      (value.unknown_transform !== undefined && value.unknown_transform !== false) ||
      value.recovery_resolved !== true || value.privacy_passed !== true ||
      value.sandbox_passed !== true || typeof value.output_digest !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.output_digest)) {
    return false;
  }
  const evidence = value as unknown as RunEvidence;
  const expectedGraderTypes = fixture.quality.map((grader) => grader.type);
  const actualGraderTypes = evidence.graders.map((grader) => grader.type);
  const providerVisible = evidence.input_tokens + evidence.cache_read_tokens +
    evidence.cache_write_tokens;
  const disjointTotal = providerVisible + evidence.output_tokens;
  return providerModelMatchesPlan(evidence, plan) &&
    stableStringify(actualGraderTypes) === stableStringify(expectedGraderTypes) &&
    disjointTotal > 0 && Number.isSafeInteger(disjointTotal) &&
    evidence.output_tokens >= evidence.reasoning_tokens &&
    Number.isSafeInteger(providerVisible) &&
    evidence.provider_visible_tokens === providerVisible;
}

export function knownGrader(type: string): boolean {
  return (SUPPORTED_GRADER_TYPES as ReadonlySet<string>).has(type);
}

/** The first grader type an evidence row carries that is outside the taxonomy. */
function firstUnknownGrader(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.graders)) return undefined;
  const grader = value.graders.find((item) =>
    isRecord(item) && typeof item.type === "string" && !knownGrader(item.type));
  return isRecord(grader) && typeof grader.type === "string" ? grader.type : undefined;
}

function selectionOrder(a: Completed, b: Completed): number {
  return a.costPerTask - b.costPerTask ||
    a.p95Latency - b.p95Latency ||
    providerVisibleTokens(a) - providerVisibleTokens(b) ||
    a.candidate.plan.segment_routes.length - b.candidate.plan.segment_routes.length ||
    a.candidate.plan.plan_id.localeCompare(b.candidate.plan.plan_id);
}

function providerVisibleTokens(candidate: Completed): number {
  return candidate.evidence.reduce((sum, run) => sum + run.value.provider_visible_tokens, 0);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function bootstrapLCB95(values: number[], digest: string): number {
  if (values.length < 2) return 0;
  let state = Number.parseInt(digest.slice(0, 8), 16) || 1;
  const means = new Array<number>(10_000);
  for (let sample = 0; sample < means.length; sample++) {
    let total = 0;
    for (let i = 0; i < values.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const index = (state >>> 0) % values.length;
      total += values[index]!;
    }
    means[sample] = total / values.length;
  }
  means.sort((a, b) => a - b);
  return round(means[Math.floor(means.length * 0.05)]!, 6);
}

function recoveryTools(routes: CavePlan["segment_routes"]): CavePlan["recovery"]["tools"] {
  const tools = new Set<CavePlan["recovery"]["tools"][number]>();
  for (const route of routes) {
    tools.add("cave_retrieve");
    if (route.segment_kind === "tool_schema") tools.add("cave_search_tools");
    if (route.segment_kind === "memory") tools.add("cave_memory_search");
  }
  return [...tools].sort();
}

function deduplicatePlans(candidates: CandidatePlan[]): CandidatePlan[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const digest = sha256(stableStringify(candidate.plan));
    if (seen.has(digest)) return false;
    seen.add(digest);
    return true;
  });
}

function stableID(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function emptyResult(status: CompileStatus, reason: string): CompileResult {
  return {
    status,
    estimated_ceiling_usd: 0,
    planned_runs: 0,
    completed_runs: 0,
    static_rejections: 0,
    actual_cost_usd: 0,
    reason,
  };
}

function roundUsd(value: number): number {
  return round(value, 10);
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
