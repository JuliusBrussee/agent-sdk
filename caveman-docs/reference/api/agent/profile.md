# `@caveman-ai/agent/profile`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/profile.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `ProfileToolEffect`, `WorkloadPartition`, `WorkloadProfile`
- **Function**: `createCompilerWorkloadProfile`, `createWorkloadProfile`, `parseWorkloadProfile`, `workloadSplitSHA256`
- **Variable**: `WORKLOAD_PROFILE_SCHEMA_VERSION`

</details>

## Interfaces

### `ProfileToolEffect`

```ts
export interface ProfileToolEffect {
    readonly tool_sha256: string;
    readonly effect: ToolEffect;
    readonly calls: number;
    readonly errors: number;
}
```

Declared in `packages/agent/dist/profile.d.ts`.

### `WorkloadPartition`

```ts
export interface WorkloadPartition {
    readonly split: WorkloadSplit;
    readonly split_sha256: string;
    readonly trajectory_count: number;
    readonly case_count: number;
    readonly model_calls: number;
    readonly provider_visible_tokens: number;
    /** Public-catalog subtotal for priced rows only; completeness is reported beside it. */
    readonly catalog_cost_usd: number;
    readonly provider_reported_count: number;
    readonly usage_incomplete_count: number;
    readonly priced_count: number;
    readonly unpriced_count: number;
    readonly error_count: number;
    readonly tool_effects: readonly ProfileToolEffect[];
    readonly trajectories: readonly NormalizedTrajectory[];
}
```

Declared in `packages/agent/dist/profile.d.ts`.

### `WorkloadProfile`

```ts
export interface WorkloadProfile {
    readonly schema_version: typeof WORKLOAD_PROFILE_SCHEMA_VERSION;
    readonly profile_sha256: string;
    readonly partitions: {
        readonly profile: WorkloadPartition;
        readonly development: WorkloadPartition;
        readonly holdout: WorkloadPartition;
    };
    readonly tool_effects: readonly ProfileToolEffect[];
}
```

Declared in `packages/agent/dist/profile.d.ts`.

## Functions

### `createCompilerWorkloadProfile`

Build compiler input before development selection and holdout execution.
Only profile observations exist at this point by design. Development and
holdout stay empty until their eval runners execute, so compiler cannot
inspect either before plan freeze.

```ts
export declare function createCompilerWorkloadProfile(input: readonly NormalizedTrajectory[]): WorkloadProfile;
```

Declared in `packages/agent/dist/profile.d.ts`.

### `createWorkloadProfile`

Build a deterministic, content-blind workload profile. Input order has no
effect on any digest. A workload case may occur in exactly one split.

```ts
export declare function createWorkloadProfile(input: readonly NormalizedTrajectory[]): WorkloadProfile;
```

Declared in `packages/agent/dist/profile.d.ts`.

### `parseWorkloadProfile`

Strict parser: unknown fields, altered summaries, and altered digests fail.

```ts
export declare function parseWorkloadProfile(value: unknown): WorkloadProfile;
```

Declared in `packages/agent/dist/profile.d.ts`.

### `workloadSplitSHA256`

```ts
export declare function workloadSplitSHA256(profile: WorkloadProfile, split: WorkloadSplit): string;
```

Declared in `packages/agent/dist/profile.d.ts`.

## Variables & constants

### `WORKLOAD_PROFILE_SCHEMA_VERSION`

```ts
export declare const WORKLOAD_PROFILE_SCHEMA_VERSION: 1;
```

Declared in `packages/agent/dist/profile.d.ts`.

