# `@caveman-ai/agent/compiler`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/compiler.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `CompiledPipelineResult`, `CompileProfiledInput`, `CompileProfiledNativePiInput`, `CompileProfiledResult`, `CompilerTarget`, `ExecuteCompiledPipelineInput`, `NativePiCandidatePlanningInput`
- **Type alias**: `ProfiledCompileStatus`
- **Function**: `assertProfiledBuildTarget`, `capabilityManifestFor`, `compileProfiled`, `compileProfiledNativePi`, `executeCompiledPipeline`, `nativePiCompilerTarget`, `planNativePiCandidates`
- **Variable**: `PROFILED_COMPILER_SHA256`, `PROFILED_COMPILER_VERSION`, `TARGET_CAPABILITY_LATTICE`

</details>

## Interfaces

### `CompiledPipelineResult`

```ts
export interface CompiledPipelineResult {
    readonly buildSHA256: string;
    readonly semanticPlanSHA256: string;
    readonly target: BuildHarnessID;
    readonly fallbackUsed: boolean;
    readonly execution: HarnessResult;
}
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `CompileProfiledInput`

```ts
export interface CompileProfiledInput extends Omit<CompileInput, "evals" | "runner" | "seeds" | "adapterVersion" | "upstreamVersion" | "harnessId"> {
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
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `CompileProfiledNativePiInput`

```ts
export interface CompileProfiledNativePiInput extends Omit<CompileProfiledInput, "developmentRunner" | "holdoutRunner" | "target" | "candidates" | "requiredSemantics"> {
    readonly rootDir: string;
    readonly entryPath: string;
    readonly transformCapabilities?: readonly TransformCapability[];
    readonly preferredTransforms?: ReadonlyMap<string, string>;
}
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `CompileProfiledResult`

```ts
export interface CompileProfiledResult {
    readonly status: ProfiledCompileStatus;
    readonly estimated_ceiling_usd: number;
    readonly actual_cost_usd: number | null;
    readonly development?: CompileResult;
    readonly holdout?: CompileResult;
    readonly lock?: CaveBuildLockV3;
    readonly reason?: string;
}
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `CompilerTarget`

```ts
export interface CompilerTarget {
    readonly id: BuildHarnessID;
    readonly adapterVersion: string;
    readonly upstreamVersion: string;
    readonly adapterContractSHA256: string;
}
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `ExecuteCompiledPipelineInput`

```ts
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
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `NativePiCandidatePlanningInput`

```ts
export interface NativePiCandidatePlanningInput {
    readonly agent: CompileProfiledInput["agent"];
    readonly contextIR: CompileProfiledInput["contextIR"];
    readonly baselinePlan: CavePlan;
    readonly modelCandidates?: readonly string[];
    readonly config: CompileProfiledInput["config"];
    readonly observedDynamicKinds: ReadonlySet<ContextKind>;
    readonly transformCapabilities?: readonly TransformCapability[];
    readonly preferredTransforms?: ReadonlyMap<string, string>;
    /** One accounting instant for the entire static reservation frontier. */
    readonly accountingAt?: Date;
}
```

Declared in `packages/agent/dist/compiler.d.ts`.

## Type aliases

### `ProfiledCompileStatus`

```ts
export type ProfiledCompileStatus = CompileResult["status"] | "holdout_failed" | "capability_refused";
```

Declared in `packages/agent/dist/compiler.d.ts`.

## Functions

### `assertProfiledBuildTarget`

Validate that an existing target-specific build still matches exact adapter identity.

```ts
export declare function assertProfiledBuildTarget(value: CaveBuildLockV3, target: CompilerTarget): CaveBuildLockV3;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `capabilityManifestFor`

```ts
export declare function capabilityManifestFor(target: CompilerTarget, required: readonly CompilerSemantic[]): CompilerCapabilityManifest;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `compileProfiled`

Generic profiled compiler. Caller-owned runners are useful for adapters, but
cannot prove behavioral lowering; this lane deliberately emits baseline-only
locks.

```ts
export declare function compileProfiled(input: CompileProfiledInput): Promise<CompileProfiledResult>;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `compileProfiledNativePi`

Native Pi lane. Compiler owns candidate shape plus both runAgentInternal
validation runners; callers cannot inject alternate behavioral plans.

```ts
export declare function compileProfiledNativePi(input: CompileProfiledNativePiInput): Promise<CompileProfiledResult>;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `executeCompiledPipeline`

Execute a locked target build. v0.2 aborts every adapter failure.

```ts
export declare function executeCompiledPipeline(input: ExecuteCompiledPipelineInput): Promise<CompiledPipelineResult>;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `nativePiCompilerTarget`

```ts
export declare function nativePiCompilerTarget(): CompilerTarget;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `planNativePiCandidates`

Pure, compiler-owned finite candidate frontier for exact native Pi.

```ts
export declare function planNativePiCandidates(input: NativePiCandidatePlanningInput): CandidatePlan[];
```

Declared in `packages/agent/dist/compiler.d.ts`.

## Variables & constants

### `PROFILED_COMPILER_SHA256`

```ts
export declare const PROFILED_COMPILER_SHA256: string;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `PROFILED_COMPILER_VERSION`

```ts
export declare const PROFILED_COMPILER_VERSION: "0.2.0";
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `TARGET_CAPABILITY_LATTICE`

Generic targets stay baseline-only; exact native Pi has a separate owned lane.

```ts
export declare const TARGET_CAPABILITY_LATTICE: Readonly<Record<BuildHarnessID, readonly CompilerSemantic[]>>;
```

Declared in `packages/agent/dist/compiler.d.ts`.

