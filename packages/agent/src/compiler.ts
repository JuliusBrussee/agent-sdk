import type {
  HarnessAdapter,
  HarnessRequest,
  HarnessResult,
} from "./adapters.js";
import { validateHarnessResult } from "./adapters.js";
import {
  buildPolicySHA256,
  BUILD_TARGET_CAPABILITY_LATTICE,
  compile,
  compilerPassIDsForPlanDiff,
  defineBuild,
  generateCandidatePlans,
  nativePiPlanLoweringErrors,
  nativePiRequiredSemanticsForPlanDiff,
  parseCaveBuildLockV3,
  PI_NATIVE_COMPILER_CAPABILITIES,
  PI_NATIVE_COMPILER_CONTRACT_SHA256,
  prepareCandidatePlans,
  PROFILED_COMPILER_IDENTITY_SHA256,
  type BuildHarnessID,
  type CandidatePlan,
  type CaveBuildLock,
  type CaveBuildLockV3,
  type CavePlan,
  type CompileInput,
  type CompileResult,
  type CompilerCapabilityManifest,
  type CompilerPassRecord,
  type CompilerSemantic,
  type ProfiledValidationEvidence,
  type TransformCapability,
} from "./build.js";
import { sha256, stableStringify } from "./context-ir.js";
import { contextIRIsContentBlind, createNativePiEvalRunner } from "./compile-runner.js";
import { parseWorkloadProfile, type WorkloadPartition, type WorkloadProfile } from "./profile.js";
import type { ContextKind, EvalDefinition, ToolDefinition } from "./primitives.js";
import { verifySandboxConformance } from "./runtime.js";
import {
  PI_ADAPTER_VERSION,
  PI_UPSTREAM_VERSION,
} from "./runtime-identity.js";

export const PROFILED_COMPILER_VERSION = "0.2.0" as const;
export const PROFILED_COMPILER_SHA256 = PROFILED_COMPILER_IDENTITY_SHA256;

const BASE_CAPABILITIES: readonly CompilerSemantic[] = [];
/** Generic targets stay baseline-only; exact native Pi has a separate owned lane. */
export const TARGET_CAPABILITY_LATTICE = BUILD_TARGET_CAPABILITY_LATTICE;

export interface CompilerTarget {
  readonly id: BuildHarnessID;
  readonly adapterVersion: string;
  readonly upstreamVersion: string;
  readonly adapterContractSHA256: string;
}

export interface CompileProfiledInput extends Omit<CompileInput,
  "evals" | "runner" | "seeds" | "adapterVersion" | "upstreamVersion" | "harnessId"> {
  readonly profile: WorkloadProfile;
  readonly developmentEvals: readonly EvalDefinition[];
  readonly holdoutEvals: readonly EvalDefinition[];
  readonly developmentSeeds?: readonly number[];
  readonly holdoutSeeds?: readonly number[];
  readonly developmentRunner: CompileInput["runner"];
  readonly holdoutRunner: CompileInput["runner"];
  readonly target: CompilerTarget;
  readonly requiredSemantics?: readonly CompilerSemantic[];
}

export interface CompileProfiledNativePiInput extends Omit<CompileProfiledInput,
  "developmentRunner" | "holdoutRunner" | "target" | "candidates" | "requiredSemantics"> {
  readonly rootDir: string;
  readonly entryPath: string;
  readonly transformCapabilities?: readonly TransformCapability[];
  readonly preferredTransforms?: ReadonlyMap<string, string>;
}

export type ProfiledCompileStatus = CompileResult["status"] | "holdout_failed" | "capability_refused";

export interface CompileProfiledResult {
  readonly status: ProfiledCompileStatus;
  readonly estimated_ceiling_usd: number;
  readonly actual_cost_usd: number | null;
  readonly development?: CompileResult;
  readonly holdout?: CompileResult;
  readonly lock?: CaveBuildLockV3;
  readonly reason?: string;
}

/**
 * Generic profiled compiler. Caller-owned runners are useful for adapters, but
 * cannot prove behavioral lowering; this lane deliberately emits baseline-only
 * locks.
 */
export async function compileProfiled(input: CompileProfiledInput): Promise<CompileProfiledResult> {
  return compileProfiledCore(input, "generic");
}

export interface NativePiCandidatePlanningInput {
  readonly agent: CompileProfiledInput["agent"];
  readonly contextIR: CompileProfiledInput["contextIR"];
  readonly baselinePlan: CavePlan;
  readonly modelCandidates?: readonly string[];
  readonly config: CompileProfiledInput["config"];
  readonly observedDynamicKinds: ReadonlySet<ContextKind>;
  readonly transformCapabilities?: readonly TransformCapability[];
  readonly preferredTransforms?: ReadonlyMap<string, string>;
  /** One admission instant for the entire static reservation frontier. */
  readonly accountingAt?: Date;
}

/** Pure, compiler-owned finite candidate frontier for exact native Pi. */
export function planNativePiCandidates(input: NativePiCandidatePlanningInput): CandidatePlan[] {
  const accountingAt = input.accountingAt ?? new Date();
  const config = defineBuild(input.config);
  const policy = candidatePolicyFromConfig(config);
  const observedDynamicKinds = new Set(input.observedDynamicKinds);
  const preferredTransforms = input.preferredTransforms === undefined
    ? new Map<string, string>()
    : new Map([...input.preferredTransforms].map(([segmentID, transformID]) =>
      [String(segmentID), String(transformID)]));
  const transformCapabilities = input.transformCapabilities === undefined
    ? undefined
    : JSON.parse(stableStringify(input.transformCapabilities)) as TransformCapability[];
  const raw = generateCandidatePlans(
    input.agent,
    input.contextIR,
    input.baselinePlan,
    [...(input.modelCandidates ?? [input.baselinePlan.model])],
    true,
    preferredTransforms,
    transformCapabilities,
    observedDynamicKinds,
    policy,
    accountingAt,
  );
  return prepareCandidatePlans(
    raw,
    input.baselinePlan,
    policy,
    {
      compilerGenerated: true,
      contextIR: input.contextIR,
      observedDynamicKinds,
    },
    accountingAt,
  ).filter((candidate) =>
    nativePiPlanLoweringErrors(input.baselinePlan, candidate.plan).length === 0 &&
    compilerPassIDsForPlanDiff(input.baselinePlan, candidate.plan).length <= 16);
}

/**
 * Native Pi lane. Compiler owns candidate shape plus both runAgentInternal
 * validation runners; callers cannot inject alternate behavioral plans.
 */
export async function compileProfiledNativePi(
  input: CompileProfiledNativePiInput,
): Promise<CompileProfiledResult> {
  if ("candidates" in input) {
    return emptyProfiled("capability_refused", "cave_compiler_native_candidates_owned");
  }
  if (input.agent.tools.length > 0) {
    return emptyProfiled(
      "capability_refused",
      "cave_compiler_tool_effect_coverage_unavailable",
    );
  }
  if (!contextIRIsContentBlind(input.contextIR)) {
    return emptyProfiled("capability_refused", "cave_privacy_conformance_failed");
  }
  const sandboxConformance = await verifySandboxConformance();
  if (!sandboxConformance) {
    return emptyProfiled("capability_refused", "cave_sandbox_conformance_failed");
  }
  const target = nativePiCompilerTarget();
  const runnerInput = {
    rootDir: input.rootDir,
    entryPath: input.entryPath,
    definition: input.agent,
    sandboxConformance,
    privacyConformance: true,
  };
  const profile = parseWorkloadProfile(input.profile);
  const observedDynamicKinds = observedDynamicContextKinds(profile.partitions.profile);
  const candidates = planNativePiCandidates({
    agent: input.agent,
    contextIR: input.contextIR,
    baselinePlan: input.baselinePlan,
    ...(input.modelCandidates === undefined ? {} : { modelCandidates: input.modelCandidates }),
    config: input.config,
    observedDynamicKinds,
    ...(input.transformCapabilities === undefined
      ? {}
      : { transformCapabilities: input.transformCapabilities }),
    ...(input.preferredTransforms === undefined
      ? {}
      : { preferredTransforms: input.preferredTransforms }),
  });
  const {
    rootDir: _rootDir,
    entryPath: _entryPath,
    transformCapabilities: _transformCapabilities,
    preferredTransforms: _preferredTransforms,
    ...compileInput
  } = input;
  return compileProfiledCore({
    ...compileInput,
    candidates,
    target,
    developmentRunner: createNativePiEvalRunner(runnerInput),
    holdoutRunner: createNativePiEvalRunner(runnerInput),
  }, "native_pi");
}

export function nativePiCompilerTarget(): CompilerTarget {
  return Object.freeze({
    id: "pi" as const,
    adapterVersion: PI_ADAPTER_VERSION,
    upstreamVersion: PI_UPSTREAM_VERSION,
    adapterContractSHA256: PI_NATIVE_COMPILER_CONTRACT_SHA256,
  });
}

async function compileProfiledCore(
  input: CompileProfiledInput,
  lane: "generic" | "native_pi",
): Promise<CompileProfiledResult> {
  input = {
    ...input,
    config: defineBuild(input.config),
    baselinePlan: deepFreeze(JSON.parse(stableStringify(input.baselinePlan)) as CavePlan),
    contextIR: deepFreeze(JSON.parse(stableStringify(input.contextIR)) as CompileProfiledInput["contextIR"]),
    developmentEvals: deepFreeze(
      JSON.parse(stableStringify(input.developmentEvals)) as EvalDefinition[],
    ),
    holdoutEvals: deepFreeze(JSON.parse(stableStringify(input.holdoutEvals)) as EvalDefinition[]),
    target: deepFreeze({ ...input.target }),
    ...(input.modelCandidates === undefined
      ? {}
      : { modelCandidates: deepFreeze([...input.modelCandidates]) }),
    ...(input.candidates === undefined
      ? {}
      : {
          candidates: deepFreeze(
            JSON.parse(stableStringify(input.candidates)) as CandidatePlan[],
          ),
        }),
    ...(input.requiredSemantics === undefined
      ? {}
      : { requiredSemantics: deepFreeze([...input.requiredSemantics]) }),
  };
  const identityError = profiledIdentityError(input);
  if (identityError !== undefined) {
    return emptyProfiled("capability_refused", identityError);
  }
  const profile = parseWorkloadProfile(input.profile);
  const expectedProfileAgent = sha256(input.agent.id);
  if (profile.partitions.profile.trajectories.some((trajectory) =>
    trajectory.agent_sha256 !== expectedProfileAgent)) {
    throw new Error("cave_compiler_profile_agent_mismatch");
  }
  if (profile.partitions.development.trajectory_count !== 0 ||
      profile.partitions.holdout.trajectory_count !== 0) {
    throw new Error("cave_compiler_validation_profile_must_be_unopened");
  }
  if (lane === "native_pi" && input.agent.tools.length > 0) {
    return emptyProfiled(
      "capability_refused",
      "cave_compiler_tool_effect_coverage_unavailable",
    );
  }
  if (lane === "generic" && input.agent.tools.some((tool) => tool.runtime?.kind === "subagent")) {
    return emptyProfiled(
      "capability_refused",
      "cave_compiler_subagent_cost_attribution_unavailable",
    );
  }
  assertEvalIsolation(input.developmentEvals, input.holdoutEvals, profile);
  if (lane === "generic" && isNativePiTarget(input.target)) {
    return emptyProfiled("capability_refused", "cave_compiler_native_runner_required");
  }
  if (input.target.id === "claude") {
    return emptyProfiled("capability_refused", "cave_compiler_target_not_executable:claude");
  }
  if (input.target.id === "eve" && input.baselinePlan.reasoning !== "none") {
    return emptyProfiled("capability_refused", "cave_compiler_eve_reasoning_unobservable");
  }
  const developmentSeeds = normalizeSeeds(input.developmentSeeds);
  const holdoutSeeds = normalizeSeeds(input.holdoutSeeds);
  const candidates = resolveProfiledCandidates(input, profile, lane);
  const approvedDevelopment = approved(input.developmentEvals);
  const approvedHoldout = approved(input.holdoutEvals);
  if (approvedDevelopment.length === 0 || approvedHoldout.length === 0) {
    return emptyProfiled("needs_eval", "development and holdout each require an approved required eval");
  }
  const runnable = candidates.filter((candidate) => candidate.static_rejection === undefined);
  const preHoldoutRequirements = lane === "native_pi"
    ? nativeCandidateRequirementUnion(input.baselinePlan, runnable)
    : genericRequiredSemantics(input.requiredSemantics, input.agent.tools);
  let capabilityManifest: CompilerCapabilityManifest;
  try {
    capabilityManifest = capabilityManifestForLane(input.target, preHoldoutRequirements, lane);
  } catch (error) {
    return emptyProfiled("capability_refused", safeError(error));
  }
  const developmentCeiling = ceiling(runnable, approvedDevelopment.length, developmentSeeds.length);
  const baselineEstimate = runnable.find((candidate) =>
    candidate.plan.plan_id === input.baselinePlan.plan_id)?.estimated_cost_usd_per_run ?? 0;
  const maxSelectedEstimate = Math.max(0, ...runnable.map((candidate) => candidate.estimated_cost_usd_per_run));
  const hasBehavioralCandidate = runnable.some((candidate) =>
    candidate.plan.plan_id !== input.baselinePlan.plan_id);
  const reservedHoldoutCeiling = roundUsd((hasBehavioralCandidate
    ? baselineEstimate + maxSelectedEstimate
    : baselineEstimate) * approvedHoldout.length * holdoutSeeds.length);
  const totalCeiling = roundUsd(developmentCeiling + reservedHoldoutCeiling);
  if (totalCeiling > input.config.maxSearchCostUsd) {
    return {
      status: "search_budget_exceeded",
      estimated_ceiling_usd: totalCeiling,
      actual_cost_usd: 0,
      reason: "combined development and untouched-holdout ceiling exceeds configured cap",
    };
  }

  const common = compileBase(input, profile);
  const development = await compile({
    ...common,
    evals: [...input.developmentEvals],
    candidates,
    seeds: [...developmentSeeds],
    config: { ...input.config, maxSearchCostUsd: Math.max(Number.EPSILON, developmentCeiling) },
    adapterVersion: input.target.adapterVersion,
    upstreamVersion: input.target.upstreamVersion,
    harnessId: input.target.id,
    runner: input.developmentRunner,
  });
  if (development.status !== "locked" || development.lock === undefined ||
      development.actual_cost_usd === null) {
    return {
      status: development.status,
      estimated_ceiling_usd: totalCeiling,
      actual_cost_usd: development.actual_cost_usd,
      development,
      ...(development.reason === undefined ? {} : { reason: development.reason }),
    };
  }
  if (development.actual_cost_usd > developmentCeiling + 1e-12) {
    return {
      status: "search_budget_exceeded",
      estimated_ceiling_usd: totalCeiling,
      actual_cost_usd: development.actual_cost_usd,
      development,
      reason: "development evidence exceeded its reserved public-catalog ceiling",
    };
  }
  const lockedDevelopment: CompileResult & { lock: CaveBuildLock } = {
    ...development,
    lock: development.lock,
  };
  if (lane === "native_pi" && !stageCostWithinBaseline(lockedDevelopment)) {
    return {
      status: "no_passing_build",
      estimated_ceiling_usd: totalCeiling,
      actual_cost_usd: development.actual_cost_usd,
      development,
      reason: "cave_compiler_native_selected_cost_regression:development",
    };
  }

  const selectedCandidate = candidates.find((candidate) =>
    candidate.plan.plan_id === development.lock!.selected_plan_id);
  const baselineCandidate = candidates.find((candidate) =>
    candidate.plan.plan_id === input.baselinePlan.plan_id);
  if (selectedCandidate === undefined || baselineCandidate === undefined) {
    return failedHoldout(totalCeiling, development, "selected or baseline candidate missing");
  }
  const holdoutCandidates = selectedCandidate.plan.plan_id === baselineCandidate.plan.plan_id
    ? [selectedCandidate]
    : [baselineCandidate, selectedCandidate];
  const holdoutCeiling = ceiling(holdoutCandidates, approvedHoldout.length, holdoutSeeds.length);
  const remaining = roundUsd(input.config.maxSearchCostUsd - development.actual_cost_usd);
  if (!(remaining > 0) || holdoutCeiling > remaining) {
    return {
      status: "search_budget_exceeded",
      estimated_ceiling_usd: totalCeiling,
      actual_cost_usd: development.actual_cost_usd,
      development,
      reason: "untouched holdout no longer fits the remaining search budget",
    };
  }
  const holdout = await compile({
    ...common,
    evals: [...input.holdoutEvals],
    candidates: holdoutCandidates,
    seeds: [...holdoutSeeds],
    config: { ...input.config, maxSearchCostUsd: remaining },
    adapterVersion: input.target.adapterVersion,
    upstreamVersion: input.target.upstreamVersion,
    harnessId: input.target.id,
    runner: input.holdoutRunner,
  });
  const actualCost = holdout.actual_cost_usd === null
    ? null
    : roundUsd(development.actual_cost_usd + holdout.actual_cost_usd);
  if (holdout.status !== "locked" || holdout.lock === undefined || actualCost === null ||
      holdout.lock.selected_plan_id !== development.lock.selected_plan_id) {
    return {
      status: "holdout_failed",
      estimated_ceiling_usd: totalCeiling,
      actual_cost_usd: actualCost,
      development,
      holdout,
      reason: holdout.reason ?? "development-selected plan did not pass untouched holdout",
    };
  }
  if (actualCost > input.config.maxSearchCostUsd + 1e-12) {
    return {
      status: "search_budget_exceeded",
      estimated_ceiling_usd: totalCeiling,
      actual_cost_usd: actualCost,
      development,
      holdout,
      reason: "combined measured search cost exceeded configured cap",
    };
  }
  const lockedHoldout: CompileResult & { lock: CaveBuildLock } = {
    ...holdout,
    lock: holdout.lock,
  };
  if (lane === "native_pi" && !stageCostWithinBaseline(lockedHoldout)) {
    return {
      status: "holdout_failed",
      estimated_ceiling_usd: totalCeiling,
      actual_cost_usd: actualCost,
      development,
      holdout,
      reason: "cave_compiler_native_selected_cost_regression:holdout",
    };
  }
  if (!sameStageIdentity(lockedDevelopment.lock, lockedHoldout.lock)) {
    return {
      status: "holdout_failed",
      estimated_ceiling_usd: totalCeiling,
      actual_cost_usd: actualCost,
      development,
      holdout,
      reason: "cave_compiler_stage_identity_mismatch",
    };
  }

  const postHoldoutRequirements = lane === "native_pi"
    ? nativePiRequiredSemanticsForPlanDiff(input.baselinePlan, lockedHoldout.lock.selected_plan)
    : genericRequiredSemantics(input.requiredSemantics, input.agent.tools);
  try {
    capabilityManifest = capabilityManifestForLane(input.target, postHoldoutRequirements, lane);
  } catch (error) {
    return {
      status: "capability_refused",
      estimated_ceiling_usd: totalCeiling,
      actual_cost_usd: actualCost,
      development,
      holdout,
      reason: safeError(error),
    };
  }

  const developmentValidation = validationEvidence(
    profile.partitions.development, development.lock.eval_suite_sha256, lockedDevelopment,
  );
  const holdoutValidation = validationEvidence(
    profile.partitions.holdout, holdout.lock.eval_suite_sha256, lockedHoldout,
  );
  const lock = makeV3Lock({
    input,
    profile,
    development: lockedDevelopment,
    holdout: lockedHoldout,
    capabilityManifest,
    developmentValidation,
    holdoutValidation,
  });
  return {
    status: "locked",
    estimated_ceiling_usd: totalCeiling,
    actual_cost_usd: actualCost,
    development,
    holdout,
    lock,
  };
}

export function capabilityManifestFor(
  target: CompilerTarget,
  required: readonly CompilerSemantic[],
): CompilerCapabilityManifest {
  if (isNativePiTarget(target)) throw new Error("cave_compiler_native_runner_required");
  return capabilityManifestForLane(target, required, "generic");
}

function capabilityManifestForLane(
  target: CompilerTarget,
  required: readonly CompilerSemantic[],
  lane: "generic" | "native_pi",
): CompilerCapabilityManifest {
  if (!/^[0-9a-f]{64}$/.test(target.adapterContractSHA256)) {
    throw new Error("cave_compiler_adapter_contract_digest_invalid");
  }
  if (lane === "native_pi" && !isNativePiTarget(target)) {
    throw new Error("cave_compiler_native_target_identity_invalid");
  }
  const supported = [...(lane === "native_pi"
    ? PI_NATIVE_COMPILER_CAPABILITIES
    : TARGET_CAPABILITY_LATTICE[target.id])].sort();
  const normalizedRequired = [...new Set(required)].sort();
  const unsupported = normalizedRequired.filter((semantic) => !supported.includes(semantic));
  if (unsupported.length > 0) {
    throw new Error(`cave_compiler_capability_unsupported:${target.id}:${unsupported.join(",")}`);
  }
  return deepFreeze({
    schema_version: 1 as const,
    target: target.id,
    adapter_contract_sha256: target.adapterContractSHA256,
    supported_semantics: supported,
    required_semantics: normalizedRequired,
  });
}

/** Validate that an existing target-specific build still matches exact adapter identity. */
export function assertProfiledBuildTarget(
  value: CaveBuildLockV3,
  target: CompilerTarget,
): CaveBuildLockV3 {
  const build = parseCaveBuildLockV3(value);
  if (target.id !== build.harness.id || target.adapterVersion !== build.harness.adapter_version ||
      target.upstreamVersion !== build.harness.upstream_version ||
      target.adapterContractSHA256 !== build.capability_manifest.adapter_contract_sha256) {
    // Development selection and holdout evidence belong to this exact target.
    // Retargeting the bytes would preserve an old target's proof and mint an
    // unsound build. Call compileProfiled for the new target instead.
    throw new Error("cave_compiler_target_revalidation_required");
  }
  return build;
}

export interface ExecuteCompiledPipelineInput {
  readonly build: CaveBuildLockV3;
  readonly adapter: HarnessAdapter;
  readonly contextIR: HarnessRequest["contextIR"];
  readonly prompt: string;
  readonly runID: string;
  readonly evaluatedTransformIDs: readonly string[];
  readonly appliedTransformIDs: readonly string[];
  readonly recoveryResolved: boolean;
  readonly signal?: AbortSignal;
}

export interface CompiledPipelineResult {
  readonly buildSHA256: string;
  readonly semanticPlanSHA256: string;
  readonly target: BuildHarnessID;
  readonly fallbackUsed: boolean;
  readonly execution: HarnessResult;
}

/** Execute a locked target build. v0.2 aborts every adapter failure. */
export async function executeCompiledPipeline(
  input: ExecuteCompiledPipelineInput,
): Promise<CompiledPipelineResult> {
  const build = parseCaveBuildLockV3(
    JSON.parse(stableStringify(input.build)) as CaveBuildLockV3,
  );
  if (isNativePiTarget({
    id: build.harness.id,
    adapterVersion: build.harness.adapter_version,
    upstreamVersion: build.harness.upstream_version,
    adapterContractSHA256: build.capability_manifest.adapter_contract_sha256,
  })) {
    // Native locks execute only through runAgentInternal's locked-build path.
    // A structural HarnessAdapter cannot stand in for that owned runtime.
    throw new Error("cave_compiler_native_execution_requires_run_agent_internal");
  }
  if (input.adapter.id !== build.harness.id || input.adapter.version !== build.harness.adapter_version ||
      input.adapter.manifest.upstreamVersion !== build.harness.upstream_version ||
      input.adapter.contractSHA256 !== build.capability_manifest.adapter_contract_sha256) {
    throw new Error("cave_compiler_target_adapter_mismatch");
  }
  const selectedRequest = adapterRequest(input, build, build.selected_plan,
    input.evaluatedTransformIDs, input.appliedTransformIDs, input.recoveryResolved);
  let selectedExecution: HarnessResult;
  try {
    const accountingStartedAt = new Date();
    const reported = await input.adapter.run(selectedRequest);
    const accountingFinishedAt = new Date();
    selectedExecution = validateHarnessResult(
      reported,
      {
        adapter: input.adapter,
        request: selectedRequest,
        accountingStartedAt,
        accountingFinishedAt,
      },
    );
  } catch (error) {
    if (input.signal?.aborted === true) throw error;
    if (error instanceof Error && error.message.startsWith("cave_harness_result_")) {
      throw new Error("cave_compiler_runtime_claim_invalid", { cause: error });
    }
    // Failure may follow paid work or a hidden effect. No structured partial
    // receipt exists yet, so retry would both lose spend and risk duplication.
    throw new Error("cave_compiler_baseline_replay_unsafe", { cause: error });
  }
  return {
    buildSHA256: build.build_sha256,
    semanticPlanSHA256: build.plan_sha256,
    target: build.harness.id,
    fallbackUsed: false,
    execution: selectedExecution,
  };
}

function adapterRequest(
  input: ExecuteCompiledPipelineInput,
  build: CaveBuildLockV3,
  plan: CavePlan,
  evaluatedTransformIDs: readonly string[],
  appliedTransformIDs: readonly string[],
  recoveryResolved: boolean,
): HarnessRequest {
  const request = {
    build: adapterBuild(build, plan),
    contextIR: input.contextIR,
    plan,
    prompt: input.prompt,
    runID: input.runID,
    evaluatedTransformIDs: [...evaluatedTransformIDs],
    appliedTransformIDs: [...appliedTransformIDs],
    recoveryResolved,
  };
  const snapshot = deepFreeze(structuredClone(request));
  return input.signal === undefined
    ? snapshot
    : Object.freeze({ ...snapshot, signal: input.signal });
}

function adapterBuild(build: CaveBuildLockV3, plan: CavePlan): CaveBuildLock {
  const planSHA256 = sha256(stableStringify(plan));
  const payload = {
    schema_version: 2 as const,
    agent_id: build.agent_id,
    plan_sha256: planSHA256,
    source_sha256: build.source_sha256,
    agent_definition_sha256: build.agent_definition_sha256,
    context_ir_sha256: build.context_ir_sha256,
    eval_suite_sha256: build.eval_suite_sha256,
    context_ir_schema: "1" as const,
    harness: build.harness,
    runtime: build.runtime,
    catalog_sha256: build.catalog_sha256,
    baseline_plan_id: build.baseline_plan_id,
    selected_plan_id: plan.plan_id,
    selected_plan: plan,
    evidence: build.evidence,
  };
  return { ...payload, build_sha256: sha256(stableStringify(payload)) };
}

function makeV3Lock(input: {
  input: CompileProfiledInput;
  profile: WorkloadProfile;
  development: CompileResult & { lock: CaveBuildLock };
  holdout: CompileResult & { lock: CaveBuildLock };
  capabilityManifest: CompilerCapabilityManifest;
  developmentValidation: ProfiledValidationEvidence;
  holdoutValidation: ProfiledValidationEvidence;
}): CaveBuildLockV3 {
  const selectedPlan = input.development.lock.selected_plan;
  const baselineSHA256 = sha256(stableStringify(input.input.baselinePlan));
  const capabilitySHA256 = sha256(stableStringify(input.capabilityManifest));
  const developmentSHA256 = sha256(stableStringify({
    split_sha256: input.developmentValidation.split_sha256,
    eval_suite_sha256: input.developmentValidation.eval_suite_sha256,
  }));
  const holdoutSHA256 = sha256(stableStringify({
    split_sha256: input.holdoutValidation.split_sha256,
    eval_suite_sha256: input.holdoutValidation.eval_suite_sha256,
  }));
  const passes = compilerPasses(
    input.input.baselinePlan,
    selectedPlan,
    input.developmentValidation,
  );
  const payload = {
    schema_version: 3 as const,
    agent_id: input.development.lock.agent_id,
    plan_sha256: input.development.lock.plan_sha256,
    source_sha256: input.development.lock.source_sha256,
    agent_definition_sha256: input.development.lock.agent_definition_sha256,
    context_ir_sha256: input.development.lock.context_ir_sha256,
    eval_suite_sha256: sha256(stableStringify({
      development: input.developmentValidation.eval_suite_sha256,
      holdout: input.holdoutValidation.eval_suite_sha256,
    })),
    context_ir_schema: "1" as const,
    harness: input.holdout.lock.harness,
    runtime: input.holdout.lock.runtime,
    catalog_sha256: input.development.lock.catalog_sha256,
    baseline_plan_id: input.input.baselinePlan.plan_id,
    selected_plan_id: selectedPlan.plan_id,
    selected_plan: selectedPlan,
    evidence: input.holdout.lock.evidence,
    compiler: {
      id: "@caveman-ai/agent/profiled-compiler" as const,
      version: PROFILED_COMPILER_VERSION,
      compiler_sha256: PROFILED_COMPILER_SHA256,
      profile_sha256: input.profile.profile_sha256,
      profile_partition_sha256: input.profile.partitions.profile.split_sha256,
      development_sha256: developmentSHA256,
      holdout_sha256: holdoutSHA256,
      policy_sha256: buildPolicySHA256(input.input.config),
      capability_manifest_sha256: capabilitySHA256,
    },
    capability_manifest: input.capabilityManifest,
    executable_pipeline: {
      schema_version: 1 as const,
      target: input.holdout.lock.harness.id,
      semantic_plan_sha256: input.development.lock.plan_sha256,
      entry_step_id: "selected" as const,
      steps: [
        {
          step_id: "selected" as const,
          kind: "harness" as const,
          plan_id: selectedPlan.plan_id,
          plan_sha256: input.development.lock.plan_sha256,
          on_error: "abort" as const,
        },
        {
          step_id: "baseline" as const,
          kind: "baseline_fallback" as const,
          plan_id: input.input.baselinePlan.plan_id,
          plan_sha256: baselineSHA256,
        },
      ] as const,
    },
    passes,
    baseline_fallback: {
      plan_id: input.input.baselinePlan.plan_id,
      plan_sha256: baselineSHA256,
      plan: input.input.baselinePlan,
    },
    validation: {
      development: input.developmentValidation,
      holdout: input.holdoutValidation,
    },
  };
  return parseCaveBuildLockV3({
    ...payload,
    build_sha256: sha256(stableStringify(payload)),
  });
}

function compilerPasses(
  baseline: CavePlan,
  selected: CavePlan,
  development: ProfiledValidationEvidence,
): readonly CompilerPassRecord[] {
  return deepFreeze(compilerPassIDsForPlanDiff(baseline, selected).map((pass_id) => ({
    pass_id,
    version: 1 as const,
    basis: "development" as const,
    evidence_sha256: sha256(stableStringify({ development, pass_id, selected: selected.plan_id })),
  })));
}

function resolveProfiledCandidates(
  input: CompileProfiledInput,
  profile: WorkloadProfile,
  lane: "generic" | "native_pi",
): CandidatePlan[] {
  const accountingAt = new Date();
  const policy = candidatePolicyFromConfig(input.config);
  const observedDynamicKinds = observedDynamicContextKinds(profile.partitions.profile);
  const generated = input.candidates === undefined || lane === "native_pi";
  const raw = input.candidates ?? generateCandidatePlans(
    input.agent, input.contextIR, input.baselinePlan,
    input.modelCandidates ?? [input.baselinePlan.model], true, new Map(), undefined,
    observedDynamicKinds, policy,
    accountingAt,
  );
  const prepared = prepareCandidatePlans(
    raw,
    input.baselinePlan,
    policy,
    {
      compilerGenerated: generated,
      contextIR: input.contextIR,
      observedDynamicKinds,
    },
    accountingAt,
  ).filter((candidate) => candidate.static_rejection === undefined);
  if (lane === "native_pi") {
    return prepared.filter((candidate) =>
      compilerPassIDsForPlanDiff(input.baselinePlan, candidate.plan).length <= 16);
  }
  // Caller-owned runners cannot prove behavioral materialization.
  const baseline = stableStringify(input.baselinePlan);
  return prepared.filter((candidate) => stableStringify(candidate.plan) === baseline);
}

function isNativePiTarget(target: CompilerTarget): boolean {
  return target.id === "pi" &&
    target.adapterVersion === PI_ADAPTER_VERSION &&
    target.upstreamVersion === PI_UPSTREAM_VERSION &&
    target.adapterContractSHA256 === PI_NATIVE_COMPILER_CONTRACT_SHA256;
}

function observedDynamicContextKinds(partition: WorkloadPartition): ReadonlySet<ContextKind> {
  const observed = new Set<ContextKind>();
  for (const trajectory of partition.trajectories) {
    if ((trajectory.context_bill.history ?? 0) > 0) observed.add("history");
    if ((trajectory.context_bill.tool_result ?? 0) > 0 || trajectory.tools.length > 0) {
      observed.add("tool_result");
    }
  }
  return observed;
}

function genericRequiredSemantics(
  value: readonly CompilerSemantic[] | undefined,
  tools: readonly ToolDefinition[],
): CompilerSemantic[] {
  const required = new Set<CompilerSemantic>(BASE_CAPABILITIES);
  for (const semantic of value ?? []) required.add(semantic);
  for (const definition of tools) required.add(`tool_effect:${definition.effect}`);
  return [...required].sort();
}

function nativeCandidateRequirementUnion(
  baseline: CavePlan,
  candidates: readonly CandidatePlan[],
): CompilerSemantic[] {
  const required = new Set<CompilerSemantic>();
  for (const candidate of candidates) {
    for (const semantic of nativePiRequiredSemanticsForPlanDiff(baseline, candidate.plan)) {
      required.add(semantic);
    }
  }
  return [...required].sort();
}

function candidatePolicyFromConfig(config: CompileProfiledInput["config"]): {
  readonly allowedModels?: readonly string[];
  readonly deniedModels?: readonly string[];
  readonly forbiddenSafetyClasses?: readonly string[];
} {
  return {
    ...(config.allowedModels === undefined ? {} : { allowedModels: config.allowedModels }),
    ...(config.deniedModels === undefined ? {} : { deniedModels: config.deniedModels }),
    ...(config.forbiddenSafetyClasses === undefined
      ? {}
      : { forbiddenSafetyClasses: config.forbiddenSafetyClasses }),
  };
}

function profiledIdentityError(input: CompileProfiledInput): string | undefined {
  const targetIDs: readonly BuildHarnessID[] = ["pi", "claude", "vercel-ai-sdk", "eve", "mastra"];
  if (!targetIDs.includes(input.target.id)) return "cave_compiler_target_id_invalid";
  for (const [field, value] of [
    ["adapter_version", input.target.adapterVersion],
    ["upstream_version", input.target.upstreamVersion],
    ["runtime_version", input.runtimeVersion],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
      return `cave_compiler_identity_invalid:${field}`;
    }
  }
  for (const [field, value] of [
    ["adapter_contract_sha256", input.target.adapterContractSHA256],
    ["source_sha256", input.sourceSha256],
    ["catalog_sha256", input.catalogSha256],
    ["transform_registry_sha256", input.transformRegistrySha256],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(value)) return `cave_compiler_identity_invalid:${field}`;
  }
  if (input.externalProvenanceSha256 !== undefined &&
      !/^[0-9a-f]{64}$/.test(input.externalProvenanceSha256)) {
    return "cave_compiler_identity_invalid:external_provenance_sha256";
  }
  return undefined;
}

function validationEvidence(
  partition: WorkloadPartition,
  evalSuiteSHA256: string,
  result: CompileResult & { lock: CaveBuildLock },
): ProfiledValidationEvidence {
  if (result.actual_cost_usd === null || result.baseline_catalog_cost_usd_per_task === undefined ||
      result.selected_catalog_cost_usd_per_task === undefined) {
    throw new Error("cave_compiler_validation_economics_incomplete");
  }
  return deepFreeze({
    split_sha256: partition.split_sha256,
    eval_suite_sha256: evalSuiteSHA256,
    completed_runs: result.completed_runs,
    actual_cost_usd: result.actual_cost_usd,
    baseline_catalog_cost_usd_per_task: result.baseline_catalog_cost_usd_per_task,
    selected_catalog_cost_usd_per_task: result.selected_catalog_cost_usd_per_task,
    selected_plan_id: result.lock.selected_plan_id,
  });
}

function stageCostWithinBaseline(result: CompileResult & { lock: CaveBuildLock }): boolean {
  return result.baseline_catalog_cost_usd_per_task !== undefined &&
    result.selected_catalog_cost_usd_per_task !== undefined &&
    result.selected_catalog_cost_usd_per_task <=
      result.baseline_catalog_cost_usd_per_task;
}

function compileBase(input: CompileProfiledInput, profile: WorkloadProfile): Omit<CompileInput,
  "evals" | "runner" | "seeds" | "adapterVersion" | "upstreamVersion" | "harnessId" | "candidates"> {
  return {
    agent: input.agent,
    contextIR: input.contextIR,
    baselinePlan: input.baselinePlan,
    observedDynamicKinds: [...observedDynamicContextKinds(profile.partitions.profile)].sort(),
    ...(input.modelCandidates === undefined ? {} : { modelCandidates: input.modelCandidates }),
    config: input.config,
    sourceSha256: input.sourceSha256,
    catalogSha256: input.catalogSha256,
    transformRegistrySha256: input.transformRegistrySha256,
    ...(input.externalProvenanceSha256 === undefined ? {} : {
      externalProvenanceSha256: input.externalProvenanceSha256,
    }),
    runtimeVersion: input.runtimeVersion,
    ...(input.runnerTimeoutMs === undefined ? {} : { runnerTimeoutMs: input.runnerTimeoutMs }),
  };
}

function assertEvalIsolation(
  development: readonly EvalDefinition[],
  holdout: readonly EvalDefinition[],
  profile: WorkloadProfile,
): void {
  const developmentIDs = new Set(development.map((item) => item.id));
  if (developmentIDs.size !== development.length || new Set(holdout.map((item) => item.id)).size !== holdout.length) {
    throw new Error("cave_compiler_duplicate_eval_id");
  }
  if (holdout.some((item) => developmentIDs.has(item.id))) throw new Error("cave_compiler_eval_split_overlap");
  if ([...development, ...holdout].some((item) =>
    typeof item.lineageId !== "string" || item.lineageId.trim().length === 0)) {
    throw new Error("cave_compiler_eval_lineage_required");
  }
  if (development.some((item) => item.split !== "development") ||
      holdout.some((item) => item.split !== "holdout")) {
    throw new Error("cave_compiler_eval_split_role_required");
  }
  const developmentLineages = new Set(development.map((item) => sha256(item.lineageId!)));
  const holdoutLineages = new Set(holdout.map((item) => sha256(item.lineageId!)));
  if ([...holdoutLineages].some((lineage) => developmentLineages.has(lineage))) {
    throw new Error("cave_compiler_eval_lineage_overlap");
  }
  const profileLineages = new Set(profile.partitions.profile.trajectories.map((item) => item.lineage_sha256));
  const profiledDevelopment = new Set(
    profile.partitions.development.trajectories.map((item) => item.lineage_sha256),
  );
  const profiledHoldout = new Set(profile.partitions.holdout.trajectories.map((item) => item.lineage_sha256));
  const validationPending = profiledDevelopment.size === 0 && profiledHoldout.size === 0;
  if (!validationPending &&
      ([...developmentLineages].some((lineage) => !profiledDevelopment.has(lineage)) ||
        [...holdoutLineages].some((lineage) => !profiledHoldout.has(lineage)))) {
    throw new Error("cave_compiler_eval_lineage_not_profiled");
  }
  if ([...developmentLineages].some((lineage) =>
    profileLineages.has(lineage) || profiledHoldout.has(lineage)) ||
      [...holdoutLineages].some((lineage) =>
        profileLineages.has(lineage) || profiledDevelopment.has(lineage))) {
    throw new Error("cave_compiler_profile_eval_lineage_overlap");
  }
  const developmentInputDigests = development.map((item) =>
    sha256(stableStringify(item.input)));
  const holdoutInputDigests = holdout.map((item) =>
    sha256(stableStringify(item.input)));
  if (new Set(developmentInputDigests).size !== developmentInputDigests.length ||
      new Set(holdoutInputDigests).size !== holdoutInputDigests.length) {
    throw new Error("cave_compiler_eval_input_duplicate");
  }
  const developmentInputs = new Set(developmentInputDigests);
  if (holdout.some((item) => developmentInputs.has(sha256(stableStringify(item.input))))) {
    throw new Error("cave_compiler_eval_input_overlap");
  }
  const profileInputs = new Set(
    profile.partitions.profile.trajectories.map((item) => item.input_sha256),
  );
  if (development.some((item) => profileInputs.has(sha256(stableStringify(item.input)))) ||
      holdout.some((item) => profileInputs.has(sha256(stableStringify(item.input))))) {
    throw new Error("cave_compiler_profile_eval_input_overlap");
  }
}

function normalizeSeeds(value: readonly number[] | undefined): number[] {
  const seeds = [...(value ?? [1, 2, 3, 4, 5])];
  if (seeds.length === 0 || new Set(seeds).size !== seeds.length ||
      seeds.some((seed) => !Number.isSafeInteger(seed))) throw new Error("cave_compiler_seeds_invalid");
  return seeds;
}

function approved(evals: readonly EvalDefinition[]): EvalDefinition[] {
  return evals.filter((fixture) => fixture.approved && fixture.required);
}

function ceiling(candidates: readonly CandidatePlan[], fixtureCount: number, seedCount: number): number {
  return roundUsd(candidates.reduce((sum, candidate) =>
    sum + candidate.estimated_cost_usd_per_run * fixtureCount * seedCount, 0));
}

function failedHoldout(
  estimated: number,
  development: CompileResult,
  reason: string,
): CompileProfiledResult {
  return {
    status: "holdout_failed",
    estimated_ceiling_usd: estimated,
    actual_cost_usd: development.actual_cost_usd,
    development,
    reason,
  };
}

function sameStageIdentity(development: CaveBuildLock, holdout: CaveBuildLock): boolean {
  const project = (lock: CaveBuildLock) => ({
    agent_id: lock.agent_id,
    plan_sha256: lock.plan_sha256,
    source_sha256: lock.source_sha256,
    agent_definition_sha256: lock.agent_definition_sha256,
    context_ir_sha256: lock.context_ir_sha256,
    context_ir_schema: lock.context_ir_schema,
    harness: lock.harness,
    runtime: lock.runtime,
    catalog_sha256: lock.catalog_sha256,
    baseline_plan_id: lock.baseline_plan_id,
    selected_plan_id: lock.selected_plan_id,
    selected_plan: lock.selected_plan,
  });
  return stableStringify(project(development)) === stableStringify(project(holdout));
}

function emptyProfiled(status: ProfiledCompileStatus, reason: string): CompileProfiledResult {
  return { status, estimated_ceiling_usd: 0, actual_cost_usd: 0, reason };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "cave_compiler_unknown_error";
}

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e10) / 1e10;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
