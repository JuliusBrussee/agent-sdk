# `@caveman-ai/adapter-strands-agents` API reference

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.1.0`.

Native Caveman model-boundary and lifecycle adapter for Strands Agents SDK.

## Entrypoints

| Import specifier | Declarations | Exported symbols |
| --- | --- | --- |
| `@caveman-ai/adapter-strands-agents` | `packages/adapters/strands-agents/src/index.d.ts` | 16 |
| `@caveman-ai/adapter-strands-agents/manifest` | `packages/adapters/strands-agents/src/manifest.d.ts` | 1 |

## `@caveman-ai/adapter-strands-agents`

Declaration file: `packages/adapters/strands-agents/src/index.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `StrandsAgentsAdapterOptions`, `StrandsModelIdentity`, `StrandsModelRequest`, `StrandsModelResolutionContext`, `StrandsModelUsageObservation`, `StrandsObserverError`
- **Type alias**: `StrandsLifecycleSink`, `StrandsModelResolver`, `StrandsModelUsageSink`, `StrandsObserverErrorSink`
- **Function**: `createAdapter`, `createStrandsAgentsAdapter`, `normalizeStrandsUsage`
- **Variable**: `default`, `manifest`, `STRANDS_AGENTS_VERSION`

</details>

### Interfaces

#### `StrandsAgentsAdapterOptions`

```ts
export interface StrandsAgentsAdapterOptions {
  /** Static identity for a single-model agent. Mutually exclusive with `resolveModel`. */
  readonly model?: StrandsModelIdentity;
  /** Resolve the concrete model selected by Strands routing for each native call. */
  readonly resolveModel?: StrandsModelResolver;
  readonly modelBoundary?: ModelBoundary<
    StrandsModelRequest,
    InvokeModelResult["result"]
  >;
  readonly role?: ModelBoundaryRole;
  readonly onLifecycle?: StrandsLifecycleSink;
  readonly onModelUsage?: StrandsModelUsageSink;
  readonly onObserverError?: StrandsObserverErrorSink;
}
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

#### `StrandsModelIdentity`

```ts
export interface StrandsModelIdentity {
  readonly provider: string;
  readonly model: string;
}
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

#### `StrandsModelRequest`

```ts
export interface StrandsModelRequest {
  readonly messages: readonly Message[];
  readonly systemPrompt?: SystemPrompt;
  readonly toolSpecs: readonly ToolSpec[];
  readonly toolChoice?: ToolChoice;
  readonly projectedInputTokens?: number;
  readonly dynamicTrailingBlocks?: number;
}
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

#### `StrandsModelResolutionContext`

```ts
export interface StrandsModelResolutionContext {
  readonly model: Model;
  readonly modelId: string | null;
}
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

#### `StrandsModelUsageObservation`

```ts
export interface StrandsModelUsageObservation {
  readonly usage: ModelUsage;
  readonly identity: AdapterLifecycleIdentity;
}
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

#### `StrandsObserverError`

```ts
export interface StrandsObserverError {
  readonly stage: string;
  readonly error: unknown;
}
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

### Type aliases

#### `StrandsLifecycleSink`

```ts
export type StrandsLifecycleSink = (
  event: AdapterLifecycleEvent,
) => void | PromiseLike<void>;
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

#### `StrandsModelResolver`

```ts
export type StrandsModelResolver = (
  context: StrandsModelResolutionContext,
) => StrandsModelIdentity | null | undefined;
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

#### `StrandsModelUsageSink`

```ts
export type StrandsModelUsageSink = (
  observation: StrandsModelUsageObservation,
) => void | PromiseLike<void>;
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

#### `StrandsObserverErrorSink`

```ts
export type StrandsObserverErrorSink = (
  error: StrandsObserverError,
) => void | PromiseLike<void>;
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

### Functions

#### `createAdapter`

```ts
export function createStrandsAgentsAdapter(
  options?: StrandsAgentsAdapterOptions,
): Plugin;
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

#### `createStrandsAgentsAdapter`

```ts
export function createStrandsAgentsAdapter(
  options?: StrandsAgentsAdapterOptions,
): Plugin;
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

#### `normalizeStrandsUsage`

```ts
export function normalizeStrandsUsage(
  usage: Usage | null | undefined,
  identity: StrandsModelIdentity,
): ModelUsage;
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

### Variables & constants

#### `default`

```ts
declare const adapterPackage: AdapterPackage<typeof createStrandsAgentsAdapter>;
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

#### `manifest`

```ts
export const manifest: AdapterManifestV2;
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

#### `STRANDS_AGENTS_VERSION`

```ts
export const STRANDS_AGENTS_VERSION: "1.15.0";
```

Declared in `packages/adapters/strands-agents/src/index.d.ts`.

## `@caveman-ai/adapter-strands-agents/manifest`

Declaration file: `packages/adapters/strands-agents/src/manifest.d.ts`.

<details><summary>Symbol index</summary>

- **Variable**: `adapterManifest`

</details>

### Variables & constants

#### `adapterManifest`

```ts
export const adapterManifest: AdapterManifestV2;
```

Declared in `packages/adapters/strands-agents/src/manifest.d.ts`.

