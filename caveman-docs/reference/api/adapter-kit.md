# `@caveman-ai/adapter-kit` API reference

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.1.0`.

Fail-closed adapter manifests and registry for Caveman agent integrations.

## Entrypoints

| Import specifier | Declarations | Exported symbols |
| --- | --- | --- |
| `@caveman-ai/adapter-kit` | `packages/adapter-kit/src/index.d.ts` | 31 |

## `@caveman-ai/adapter-kit`

Declaration file: `packages/adapter-kit/src/index.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `AdapterCertificationEvidence`, `AdapterLifecycleEvent`, `AdapterLifecycleIdentity`, `AdapterLifecycleSourceIdentity`, `AdapterLifecycleValidator`, `AdapterLifecycleValidatorOptions`, `AdapterManifestV1`, `AdapterManifestV2`, `AdapterPackage`, `AdapterRegistry`
- **Type alias**: `AdapterCapability`, `AdapterCapabilityState`, `AdapterCapabilityV1`, `AdapterCertification`, `AdapterLifecycleAccess`, `AdapterLifecycleCapabilities`, `AdapterLifecyclePhase`, `AdapterManifest`
- **Function**: `createAdapterLifecycleValidator`, `createAdapterRegistry`, `defineAdapterLifecycleCapabilities`, `defineAdapterLifecycleEvent`, `defineAdapterLifecycleIdentity`, `defineAdapterManifest`, `defineAdapterPackage`
- **Variable**: `ADAPTER_CAPABILITIES`, `ADAPTER_CAPABILITIES_V1`, `ADAPTER_CAPABILITY_STATES`, `ADAPTER_CONFORMANCE_SUITE`, `ADAPTER_LIFECYCLE_ACCESS`, `ADAPTER_LIFECYCLE_PHASES`

</details>

### Interfaces

#### `AdapterCertificationEvidence`

```ts
export interface AdapterCertificationEvidence {
  readonly suite: typeof ADAPTER_CONFORMANCE_SUITE;
  readonly reportSHA256: string;
}
```

Declared in `packages/adapter-kit/src/index.d.ts`.

#### `AdapterLifecycleEvent`

```ts
export interface AdapterLifecycleEvent {
  readonly schemaVersion: 1;
  readonly seq: number;
  readonly phase: AdapterLifecyclePhase;
  readonly identity: AdapterLifecycleIdentity;
}
```

Declared in `packages/adapter-kit/src/lifecycle.d.ts`.

#### `AdapterLifecycleIdentity`

```ts
export interface AdapterLifecycleIdentity {
  readonly runId: string;
  readonly stepId?: string;
  readonly modelCallId?: string;
  readonly toolCallId?: string;
  readonly attempt: number;
  readonly replay: boolean;
  readonly replaySource?: AdapterLifecycleSourceIdentity;
  readonly nativeIds: Readonly<Record<string, string>>;
}
```

Declared in `packages/adapter-kit/src/lifecycle.d.ts`.

#### `AdapterLifecycleSourceIdentity`

```ts
export interface AdapterLifecycleSourceIdentity {
  readonly runId: string;
  readonly stepId?: string;
  readonly modelCallId?: string;
  readonly toolCallId?: string;
  readonly attempt: number;
}
```

Declared in `packages/adapter-kit/src/lifecycle.d.ts`.

#### `AdapterLifecycleValidator`

```ts
export interface AdapterLifecycleValidator {
  accept(value: AdapterLifecycleEvent): AdapterLifecycleEvent;
  /** Seal one bounded batch; every started run must be terminal. Idempotent. */
  finish(): void;
}
```

Declared in `packages/adapter-kit/src/lifecycle.d.ts`.

#### `AdapterLifecycleValidatorOptions`

```ts
export interface AdapterLifecycleValidatorOptions {
  readonly maxRuns?: number;
  readonly maxScopesPerRun?: number;
}
```

Declared in `packages/adapter-kit/src/lifecycle.d.ts`.

#### `AdapterManifestV1`

```ts
export interface AdapterManifestV1 extends AdapterManifestBase {
  readonly schemaVersion: 1;
  readonly capabilities: Readonly<Record<AdapterCapabilityV1, AdapterCapabilityState>>;
  readonly certifications: Readonly<
    Partial<Record<AdapterCapabilityV1, AdapterCertificationEvidence>>
  >;
}
```

Declared in `packages/adapter-kit/src/index.d.ts`.

#### `AdapterManifestV2`

```ts
export interface AdapterManifestV2 extends AdapterManifestBase {
  readonly schemaVersion: 2;
  readonly capabilities: Readonly<Record<AdapterCapability, AdapterCapabilityState>>;
  readonly lifecycle: AdapterLifecycleCapabilities;
  readonly certifications: Readonly<
    Partial<Record<AdapterCapability, AdapterCertificationEvidence>>
  >;
}
```

Declared in `packages/adapter-kit/src/index.d.ts`.

#### `AdapterPackage`

```ts
export interface AdapterPackage<TFactory extends (...args: any[]) => unknown = (...args: any[]) => unknown> {
  readonly manifest: AdapterManifest;
  readonly createAdapter: TFactory;
}
```

Declared in `packages/adapter-kit/src/index.d.ts`.

#### `AdapterRegistry`

```ts
export interface AdapterRegistry {
  register<TFactory extends (...args: any[]) => unknown>(
    value: AdapterPackage<TFactory>,
  ): AdapterPackage<TFactory>;
  get(id: string): AdapterPackage | undefined;
  list(): readonly AdapterPackage[];
}
```

Declared in `packages/adapter-kit/src/index.d.ts`.

### Type aliases

#### `AdapterCapability`

```ts
export type AdapterCapability = typeof ADAPTER_CAPABILITIES[number];
```

Declared in `packages/adapter-kit/src/index.d.ts`.

#### `AdapterCapabilityState`

```ts
export type AdapterCapabilityState = "unsupported" | "experimental" | "certified";
```

Declared in `packages/adapter-kit/src/index.d.ts`.

#### `AdapterCapabilityV1`

```ts
export type AdapterCapabilityV1 = typeof ADAPTER_CAPABILITIES_V1[number];
```

Declared in `packages/adapter-kit/src/index.d.ts`.

#### `AdapterCertification`

```ts
export type AdapterCertification = AdapterCertificationEvidence;
```

Declared in `packages/adapter-kit/src/index.d.ts`.

#### `AdapterLifecycleAccess`

```ts
export type AdapterLifecycleAccess = "unsupported" | "observe" | "intercept";
```

Declared in `packages/adapter-kit/src/lifecycle.d.ts`.

#### `AdapterLifecycleCapabilities`

```ts
export type AdapterLifecycleCapabilities = Readonly<
  Record<AdapterLifecyclePhase, AdapterLifecycleAccess>
>;
```

Declared in `packages/adapter-kit/src/lifecycle.d.ts`.

#### `AdapterLifecyclePhase`

```ts
export type AdapterLifecyclePhase = typeof ADAPTER_LIFECYCLE_PHASES[number];
```

Declared in `packages/adapter-kit/src/lifecycle.d.ts`.

#### `AdapterManifest`

```ts
export type AdapterManifest = AdapterManifestV1 | AdapterManifestV2;
```

Declared in `packages/adapter-kit/src/index.d.ts`.

### Functions

#### `createAdapterLifecycleValidator`

```ts
export function createAdapterLifecycleValidator(
  options?: AdapterLifecycleValidatorOptions,
): AdapterLifecycleValidator;
```

Declared in `packages/adapter-kit/src/lifecycle.d.ts`.

#### `createAdapterRegistry`

```ts
export function createAdapterRegistry(): AdapterRegistry;
```

Declared in `packages/adapter-kit/src/index.d.ts`.

#### `defineAdapterLifecycleCapabilities`

```ts
export function defineAdapterLifecycleCapabilities(
  value: AdapterLifecycleCapabilities,
): AdapterLifecycleCapabilities;
```

Declared in `packages/adapter-kit/src/lifecycle.d.ts`.

#### `defineAdapterLifecycleEvent`

```ts
export function defineAdapterLifecycleEvent(value: AdapterLifecycleEvent): AdapterLifecycleEvent;
```

Declared in `packages/adapter-kit/src/lifecycle.d.ts`.

#### `defineAdapterLifecycleIdentity`

```ts
export function defineAdapterLifecycleIdentity(
  value: AdapterLifecycleIdentity,
): AdapterLifecycleIdentity;
```

Declared in `packages/adapter-kit/src/lifecycle.d.ts`.

#### `defineAdapterManifest`

```ts
export function defineAdapterManifest<TManifest extends AdapterManifest>(
  value: TManifest,
): TManifest;
```

Declared in `packages/adapter-kit/src/index.d.ts`.

#### `defineAdapterPackage`

```ts
export function defineAdapterPackage<TFactory extends (...args: any[]) => unknown>(
  value: AdapterPackage<TFactory>,
): AdapterPackage<TFactory>;
```

Declared in `packages/adapter-kit/src/index.d.ts`.

### Variables & constants

#### `ADAPTER_CAPABILITIES`

```ts
export const ADAPTER_CAPABILITIES: readonly [
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
];
```

Declared in `packages/adapter-kit/src/index.d.ts`.

#### `ADAPTER_CAPABILITIES_V1`

```ts
export const ADAPTER_CAPABILITIES_V1: readonly [
  "run",
  "stream",
  "tools",
  "usage",
  "abort",
  "durable",
  "compile",
];
```

Declared in `packages/adapter-kit/src/index.d.ts`.

#### `ADAPTER_CAPABILITY_STATES`

```ts
export const ADAPTER_CAPABILITY_STATES: readonly AdapterCapabilityState[];
```

Declared in `packages/adapter-kit/src/index.d.ts`.

#### `ADAPTER_CONFORMANCE_SUITE`

```ts
export const ADAPTER_CONFORMANCE_SUITE: "@caveman-ai/adapter-conformance/v1";
```

Declared in `packages/adapter-kit/src/index.d.ts`.

#### `ADAPTER_LIFECYCLE_ACCESS`

```ts
export const ADAPTER_LIFECYCLE_ACCESS: readonly AdapterLifecycleAccess[];
```

Declared in `packages/adapter-kit/src/lifecycle.d.ts`.

#### `ADAPTER_LIFECYCLE_PHASES`

```ts
export const ADAPTER_LIFECYCLE_PHASES: readonly [
  "run.started",
  "run.completed",
  "run.error",
  "model.requested",
  "model.responded",
  "model.error",
  "tool.proposed",
  "tool.started",
  "tool.completed",
  "tool.error",
  "checkpoint.committed",
  "session.committed",
];
```

Declared in `packages/adapter-kit/src/lifecycle.d.ts`.

