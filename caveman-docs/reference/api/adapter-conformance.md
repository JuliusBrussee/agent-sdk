# `@caveman-ai/adapter-conformance` API reference

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.1.0`.

Deterministic, fail-closed conformance reports for Caveman agent adapters.

## Entrypoints

| Import specifier | Declarations | Exported symbols |
| --- | --- | --- |
| `@caveman-ai/adapter-conformance` | `packages/adapter-conformance/src/index.d.ts` | 29 |

## `@caveman-ai/adapter-conformance`

Declaration file: `packages/adapter-conformance/src/index.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `AdapterConformanceInput`, `AdapterConformanceReport`, `CanonicalConformanceCaseDefinition`, `CanonicalConformancePerformanceDefinition`, `CanonicalConformanceTestVector`, `ConformanceAdapterMetadata`, `ConformanceArtifactBytes`, `ConformanceCapabilityOutput`, `ConformanceCase`, `ConformanceCaseOutput`, `ConformanceCaseVector`, `ConformanceCounts`, `ConformanceEnvironment`, `ConformancePackageMetadata`, `ConformancePerformanceOutput`, `ConformanceThreshold`, `ConformanceUpstreamMetadata`
- **Type alias**: `ConformanceCaseResult`, `ConformancePerformanceInput`, `ConformanceResultStatus`
- **Function**: `canonicalSerialize`, `computeArtifactSHA256`, `computeConformanceReportDigest`, `createNodeConformanceEnvironment`, `defineConformanceReport`, `runAdapterConformance`
- **Variable**: `ADAPTER_CONFORMANCE_CANDIDATE_SUITE`, `ADAPTER_CONFORMANCE_REPORT_SCHEMA`, `ADAPTER_CONFORMANCE_TEST_VECTOR`

</details>

### Interfaces

#### `AdapterConformanceInput`

```ts
export interface AdapterConformanceInput {
  readonly adapter: ConformanceAdapterMetadata;
  readonly upstream: ConformanceUpstreamMetadata;
  readonly artifacts: ConformanceArtifactBytes;
  readonly capabilities: readonly AdapterCapability[];
  readonly cases: readonly ConformanceCase[];
  readonly performance: readonly ConformancePerformanceInput[];
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `AdapterConformanceReport`

```ts
export interface AdapterConformanceReport {
  readonly schema: typeof ADAPTER_CONFORMANCE_REPORT_SCHEMA;
  readonly suite: typeof ADAPTER_CONFORMANCE_CANDIDATE_SUITE;
  readonly adapter: ConformanceAdapterMetadata;
  readonly upstream: ConformanceUpstreamMetadata;
  readonly environment: ConformanceEnvironment;
  readonly packages: readonly [
    ConformancePackageMetadata & { readonly role: "adapter" },
    ConformancePackageMetadata & { readonly role: "upstream" },
  ];
  readonly testVector: {
    readonly id: typeof ADAPTER_CONFORMANCE_TEST_VECTOR.id;
    readonly version: typeof ADAPTER_CONFORMANCE_TEST_VECTOR.version;
    readonly sha256: string;
    readonly executedSetSHA256: string;
  };
  readonly capabilities: readonly ConformanceCapabilityOutput[];
  readonly performance: readonly ConformancePerformanceOutput[];
  readonly totals: {
    readonly capabilities: {
      readonly passed: number;
      readonly blocked: number;
      readonly total: number;
    };
    readonly cases: ConformanceCounts;
    readonly performance: ConformanceCounts;
  };
  readonly reportDigest: `sha256:${string}`;
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `CanonicalConformanceCaseDefinition`

```ts
export interface CanonicalConformanceCaseDefinition {
  readonly capability: AdapterCapability;
  readonly id: string;
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `CanonicalConformancePerformanceDefinition`

```ts
export interface CanonicalConformancePerformanceDefinition {
  readonly capability: AdapterCapability;
  readonly id: string;
  readonly metric: "hook-overhead-p99";
  readonly unit: "microseconds";
  readonly clock: "node:process.hrtime.bigint:captured";
  readonly percentile: 99;
  readonly warmupCount: number;
  readonly sampleCount: number;
  readonly threshold: ConformanceThreshold;
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `CanonicalConformanceTestVector`

```ts
export interface CanonicalConformanceTestVector {
  readonly id: "adapter-capabilities-v4";
  readonly version: "4.0.0";
  readonly cases: readonly CanonicalConformanceCaseDefinition[];
  readonly performance: readonly CanonicalConformancePerformanceDefinition[];
  readonly sha256: string;
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ConformanceAdapterMetadata`

```ts
export interface ConformanceAdapterMetadata {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ConformanceArtifactBytes`

```ts
export interface ConformanceArtifactBytes {
  readonly adapter: Uint8Array;
  readonly upstream: Uint8Array;
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ConformanceCapabilityOutput`

```ts
export interface ConformanceCapabilityOutput {
  readonly name: AdapterCapability;
  readonly cases: readonly ConformanceCaseOutput[];
  readonly caseCounts: ConformanceCounts;
  readonly performanceCounts: ConformanceCounts;
  readonly qualification: {
    readonly status: "passed" | "blocked";
    readonly blockers: readonly string[];
  };
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ConformanceCase`

```ts
export interface ConformanceCase {
  readonly id: string;
  readonly run: (
    vector: ConformanceCaseVector,
  ) => ConformanceCaseResult | Promise<ConformanceCaseResult>;
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ConformanceCaseOutput`

```ts
export interface ConformanceCaseOutput {
  readonly id: string;
  readonly status: ConformanceResultStatus;
  readonly code: string | null;
  readonly evidenceSHA256: string | null;
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ConformanceCaseVector`

```ts
export interface ConformanceCaseVector {
  readonly id: string;
  readonly capability: AdapterCapability;
  readonly testVectorSHA256: string;
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ConformanceCounts`

```ts
export interface ConformanceCounts {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number;
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ConformanceEnvironment`

```ts
export interface ConformanceEnvironment {
  readonly runtime: { readonly name: "node"; readonly version: string };
  readonly platform: { readonly name: string; readonly architecture: string };
  readonly execution: "uncontained-host";
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ConformancePackageMetadata`

```ts
export interface ConformancePackageMetadata {
  readonly role: "adapter" | "upstream";
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ConformancePerformanceOutput`

```ts
export interface ConformancePerformanceOutput {
  readonly id: string;
  readonly capability: AdapterCapability;
  readonly metric: "hook-overhead-p99";
  readonly unit: "microseconds";
  readonly clock: "node:process.hrtime.bigint:captured";
  readonly percentile: 99;
  readonly warmupCount: number;
  readonly requiredSampleCount: number;
  readonly sampleCount: number;
  readonly observed: number | null;
  readonly threshold: ConformanceThreshold;
  readonly status: ConformanceResultStatus;
  readonly code: string | null;
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ConformanceThreshold`

```ts
export interface ConformanceThreshold {
  readonly operator: "lte";
  readonly value: number;
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ConformanceUpstreamMetadata`

```ts
export interface ConformanceUpstreamMetadata {
  readonly packageName: string;
  readonly version: string;
}
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

### Type aliases

#### `ConformanceCaseResult`

```ts
export type ConformanceCaseResult =
  | { readonly status: "passed"; readonly evidence: Uint8Array }
  | { readonly status: "failed" | "skipped"; readonly code: string };
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ConformancePerformanceInput`

```ts
export type ConformancePerformanceInput =
  | {
      readonly id: string;
      readonly run: (vector: ConformanceCaseVector) => void;
    }
  | { readonly id: string; readonly skipped: { readonly code: string } };
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ConformanceResultStatus`

```ts
export type ConformanceResultStatus = "passed" | "failed" | "skipped";
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

### Functions

#### `canonicalSerialize`

```ts
export function canonicalSerialize(value: unknown): string;
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `computeArtifactSHA256`

```ts
export function computeArtifactSHA256(bytes: Uint8Array): string;
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `computeConformanceReportDigest`

```ts
export function computeConformanceReportDigest(
  value: AdapterConformanceReport | Omit<AdapterConformanceReport, "reportDigest">,
): `sha256:${string}`;
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `createNodeConformanceEnvironment`

```ts
export function createNodeConformanceEnvironment(): ConformanceEnvironment;
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `defineConformanceReport`

```ts
export function defineConformanceReport(
  value: AdapterConformanceReport,
): AdapterConformanceReport;
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `runAdapterConformance`

```ts
export function runAdapterConformance(
  input: AdapterConformanceInput,
): Promise<AdapterConformanceReport>;
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

### Variables & constants

#### `ADAPTER_CONFORMANCE_CANDIDATE_SUITE`

```ts
export const ADAPTER_CONFORMANCE_CANDIDATE_SUITE:
  "@caveman-ai/adapter-conformance/candidate/v4";
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ADAPTER_CONFORMANCE_REPORT_SCHEMA`

```ts
export const ADAPTER_CONFORMANCE_REPORT_SCHEMA:
  "caveman.adapter-conformance.report.v4";
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

#### `ADAPTER_CONFORMANCE_TEST_VECTOR`

```ts
export const ADAPTER_CONFORMANCE_TEST_VECTOR: CanonicalConformanceTestVector;
```

Declared in `packages/adapter-conformance/src/index.d.ts`.

