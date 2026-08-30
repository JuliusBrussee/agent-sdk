# `@caveman-ai/agent/build`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/build.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `BuildConfig`, `CandidatePlan`, `CandidatePolicy`, `CaveBuildLock`, `CavePlan`, `CompileInput`, `CompilerCapabilityManifest`, `CompileResult`, `CompilerPassRecord`, `ExecutablePipeline`, `ProfiledValidationEvidence`, `RunEvidence`, `TransformCapability`
- **Type alias**: `AnyCaveBuildLock`, `BuildHarnessID`, `CaveBuildLockV3`, `CompilerSemantic`, `CompileStatus`
- **Function**: `agentDefinitionSHA256`, `buildPolicySHA256`, `checkLock`, `compile`, `compileAndWrite`, `compilerPassIDsForPlanDiff`, `contextIRSHA256`, `defineBuild`, `generateCandidatePlans`, `knownGrader`, `nativePiPlanLoweringErrors`, `nativePiRequiredSemanticsForPlanDiff`, `parseAnyCaveBuildLock`, `parseCaveBuildLock`, `parseCaveBuildLockV3`, `prepareCandidatePlans`, `toolDefinitionSHA256`
- **Variable**: `BUILD_TARGET_CAPABILITY_LATTICE`, `PI_NATIVE_COMPILER_CAPABILITIES`, `PI_NATIVE_COMPILER_CONTRACT_SHA256`, `PROFILED_COMPILER_IDENTITY_SHA256`

</details>

## Interfaces

### `BuildConfig`

```ts
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
```

Declared in `packages/agent/dist/build.d.ts`.

### `CandidatePlan`

```ts
export interface CandidatePlan {
    plan: CavePlan;
    estimated_cost_usd_per_run: number;
    static_rejection?: "unsupported_provider" | "forbidden_transform" | "unpriced_model" | "dominated" | "policy_denied";
}
```

Declared in `packages/agent/dist/build.d.ts`.

### `CandidatePolicy`

Model/safety-class policy applied to generated candidates.

```ts
export interface CandidatePolicy {
    readonly allowedModels?: readonly string[];
    readonly deniedModels?: readonly string[];
    readonly forbiddenSafetyClasses?: readonly string[];
}
```

Declared in `packages/agent/dist/build.d.ts`.

### `CaveBuildLock`

```ts
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
```

Declared in `packages/agent/dist/build.d.ts`.

### `CavePlan`

```ts
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
```

Declared in `packages/agent/dist/build.d.ts`.

### `CompileInput`

```ts
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
```

Declared in `packages/agent/dist/build.d.ts`.

### `CompilerCapabilityManifest`

```ts
export interface CompilerCapabilityManifest {
    readonly schema_version: 1;
    readonly target: BuildHarnessID;
    readonly adapter_contract_sha256: string;
    readonly supported_semantics: readonly CompilerSemantic[];
    readonly required_semantics: readonly CompilerSemantic[];
}
```

Declared in `packages/agent/dist/build.d.ts`.

### `CompileResult`

```ts
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
```

Declared in `packages/agent/dist/build.d.ts`.

### `CompilerPassRecord`

```ts
export interface CompilerPassRecord {
    readonly pass_id: string;
    readonly version: 1;
    readonly basis: "development";
    readonly evidence_sha256: string;
}
```

Declared in `packages/agent/dist/build.d.ts`.

### `ExecutablePipeline`

```ts
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
        }
    ];
}
```

Declared in `packages/agent/dist/build.d.ts`.

### `ProfiledValidationEvidence`

```ts
export interface ProfiledValidationEvidence {
    readonly split_sha256: string;
    readonly eval_suite_sha256: string;
    readonly completed_runs: number;
    readonly actual_cost_usd: number;
    readonly baseline_catalog_cost_usd_per_task: number;
    readonly selected_catalog_cost_usd_per_task: number;
    readonly selected_plan_id: string;
}
```

Declared in `packages/agent/dist/build.d.ts`.

### `RunEvidence`

```ts
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
    graders: Array<{
        type: string;
        passed: boolean;
    }>;
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
```

Declared in `packages/agent/dist/build.d.ts`.

### `TransformCapability`

```ts
export interface TransformCapability {
    transformID: string;
    segmentKinds: readonly ContextKind[];
}
```

Declared in `packages/agent/dist/build.d.ts`.

## Type aliases

### `AnyCaveBuildLock`

```ts
export type AnyCaveBuildLock = CaveBuildLock | CaveBuildLockV3;
```

Declared in `packages/agent/dist/build.d.ts`.

### `BuildHarnessID`

```ts
export type BuildHarnessID = "pi" | "claude" | "vercel-ai-sdk" | "eve" | "mastra";
```

Declared in `packages/agent/dist/build.d.ts`.

### `CaveBuildLockV3`

Proof-carrying profiled build. It preserves every v2 identity/evidence field,
while versioning the wire shape because strict v2 parsers must reject extras.

```ts
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
```

Declared in `packages/agent/dist/build.d.ts`.

### `CompilerSemantic`

```ts
export type CompilerSemantic = "single_agent" | "model_binding" | "reasoning_binding" | "output_budget_binding" | "context_ir_binding" | "transform_evidence" | "recovery_evidence" | "baseline_fallback" | "abort_signal" | "tool_effect:read" | "tool_effect:idempotent" | "tool_effect:write" | "tool_effect:external";
```

Declared in `packages/agent/dist/build.d.ts`.

### `CompileStatus`

```ts
export type CompileStatus = "locked" | "no_passing_build" | "needs_eval" | "search_budget_exceeded" | "incomplete_evidence";
```

Declared in `packages/agent/dist/build.d.ts`.

## Functions

### `agentDefinitionSHA256`

```ts
export declare function agentDefinitionSHA256(agent: AgentDefinition): string;
```

Declared in `packages/agent/dist/build.d.ts`.

### `buildPolicySHA256`

Canonical digest of validated effective compiler policy.

```ts
export declare function buildPolicySHA256(config: BuildConfig): string;
```

Declared in `packages/agent/dist/build.d.ts`.

### `checkLock`

```ts
export declare function checkLock(lock: CaveBuildLock, current: {
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
}): {
    valid: boolean;
    stale: string[];
};
```

Declared in `packages/agent/dist/build.d.ts`.

### `compile`

```ts
export declare function compile(input: CompileInput): Promise<CompileResult>;
```

Declared in `packages/agent/dist/build.d.ts`.

### `compileAndWrite`

```ts
export declare function compileAndWrite(input: CompileInput, lockPath?: string): Promise<CompileResult>;
```

Declared in `packages/agent/dist/build.d.ts`.

### `compilerPassIDsForPlanDiff`

```ts
export declare function compilerPassIDsForPlanDiff(baseline: CavePlan, selected: CavePlan): string[];
```

Declared in `packages/agent/dist/build.d.ts`.

### `contextIRSHA256`

```ts
export declare function contextIRSHA256(contextIR: ContextIR): string;
```

Declared in `packages/agent/dist/build.d.ts`.

### `defineBuild`

```ts
export declare function defineBuild(options: Partial<BuildConfig> & Pick<BuildConfig, "entry" | "evals">): BuildConfig;
```

Declared in `packages/agent/dist/build.d.ts`.

### `generateCandidatePlans`

```ts
export declare function generateCandidatePlans(agent: AgentDefinition, contextIR: ContextIR, baseline: CavePlan, models: string[], includeTransformCandidates: boolean, preferredTransforms?: ReadonlyMap<string, string>, transformCapabilities?: readonly TransformCapability[], observedDynamicKinds?: ReadonlySet<ContextKind>, policy?: CandidatePolicy, accountingAt?: Date): CandidatePlan[];
```

Declared in `packages/agent/dist/build.d.ts`.

### `knownGrader`

```ts
export declare function knownGrader(type: string): boolean;
```

Declared in `packages/agent/dist/build.d.ts`.

### `nativePiPlanLoweringErrors`

Fields exact native Pi v0.2 can materialize and validate.

```ts
export declare function nativePiPlanLoweringErrors(baseline: CavePlan, selected: CavePlan): string[];
```

Declared in `packages/agent/dist/build.d.ts`.

### `nativePiRequiredSemanticsForPlanDiff`

Exact behavior bindings required by a compiler-owned, tool-free native Pi plan.

```ts
export declare function nativePiRequiredSemanticsForPlanDiff(baseline: CavePlan, selected: CavePlan): CompilerSemantic[];
```

Declared in `packages/agent/dist/build.d.ts`.

### `parseAnyCaveBuildLock`

Strict version dispatcher. Each version's parser still rejects extras.

```ts
export declare function parseAnyCaveBuildLock(value: unknown): AnyCaveBuildLock;
```

Declared in `packages/agent/dist/build.d.ts`.

### `parseCaveBuildLock`

```ts
export declare function parseCaveBuildLock(value: unknown): CaveBuildLock;
```

Declared in `packages/agent/dist/build.d.ts`.

### `parseCaveBuildLockV3`

```ts
export declare function parseCaveBuildLockV3(value: unknown): CaveBuildLockV3;
```

Declared in `packages/agent/dist/build.d.ts`.

### `prepareCandidatePlans`

Validate, canonically snapshot, policy-check, price, and freeze runner input.

```ts
export declare function prepareCandidatePlans(candidates: readonly CandidatePlan[], baseline: CavePlan, policy: CandidatePolicy, options: {
    readonly compilerGenerated: boolean;
    readonly contextIR: ContextIR;
    readonly observedDynamicKinds: ReadonlySet<ContextKind>;
}, accountingAt?: Date): CandidatePlan[];
```

Declared in `packages/agent/dist/build.d.ts`.

### `toolDefinitionSHA256`

```ts
export declare function toolDefinitionSHA256(tool: ToolDefinition): string;
```

Declared in `packages/agent/dist/build.d.ts`.

## Variables & constants

### `BUILD_TARGET_CAPABILITY_LATTICE`

```ts
export declare const BUILD_TARGET_CAPABILITY_LATTICE: Readonly<Record<BuildHarnessID, readonly CompilerSemantic[]>>;
```

Declared in `packages/agent/dist/build.d.ts`.

### `PI_NATIVE_COMPILER_CAPABILITIES`

```ts
export declare const PI_NATIVE_COMPILER_CAPABILITIES: readonly CompilerSemantic[];
```

Declared in `packages/agent/dist/build.d.ts`.

### `PI_NATIVE_COMPILER_CONTRACT_SHA256`

```ts
export declare const PI_NATIVE_COMPILER_CONTRACT_SHA256: string;
```

Declared in `packages/agent/dist/build.d.ts`.

### `PROFILED_COMPILER_IDENTITY_SHA256`

```ts
export declare const PROFILED_COMPILER_IDENTITY_SHA256: string;
```

Declared in `packages/agent/dist/build.d.ts`.

