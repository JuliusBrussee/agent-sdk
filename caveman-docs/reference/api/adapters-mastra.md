# `@caveman-ai/adapter-mastra` API reference

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.1.0`.

Native Caveman Processor adapter for Mastra.

## Entrypoints

| Import specifier | Declarations | Exported symbols |
| --- | --- | --- |
| `@caveman-ai/adapter-mastra` | `packages/adapters/mastra/src/index.d.ts` | 12 |
| `@caveman-ai/adapter-mastra/manifest` | `packages/adapters/mastra/src/manifest.d.ts` | 1 |

## `@caveman-ai/adapter-mastra`

Declaration file: `packages/adapters/mastra/src/index.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `MastraAdapterOptions`, `MastraAdapterProcessor`, `MastraModelIdentity`, `MastraModelResponse`, `MastraObserverError`, `MastraUsageObservation`
- **Type alias**: `MastraModelRequest`
- **Function**: `createAdapter`, `createMastraAdapter`, `normalizeMastraUsage`
- **Variable**: `default`, `manifest`

</details>

### Interfaces

#### `MastraAdapterOptions`

```ts
export interface MastraAdapterOptions {
  /** Optional static identity. Native model.provider/modelId are used by default. */
  readonly model?: MastraModelIdentity;
  readonly modelBoundary?: ModelBoundary<MastraModelRequest, MastraModelResponse>;
  readonly onLifecycle?: (
    event: AdapterLifecycleEvent,
  ) => void | PromiseLike<void>;
  readonly onModelUsage?: (
    observation: MastraUsageObservation,
  ) => void | PromiseLike<void>;
  readonly onObserverError?: (
    error: MastraObserverError,
  ) => void | PromiseLike<void>;
}
```

Declared in `packages/adapters/mastra/src/index.d.ts`.

#### `MastraAdapterProcessor`

```ts
export interface MastraAdapterProcessor extends Processor<"caveman-agent-sdk"> {
  readonly id: "caveman-agent-sdk";
  readonly name: "Caveman Agent SDK";
  processLLMRequest(args: ProcessLLMRequestArgs): Promise<ProcessLLMRequestResult>;
  processLLMResponse(args: ProcessLLMResponseArgs): void;
  processOutputStream(args: ProcessOutputStreamArgs): Promise<ChunkType>;
  processOutputStep(args: ProcessOutputStepArgs): ProcessorMessageResult;
  processOutputResult(args: ProcessOutputResultArgs): ProcessorMessageResult;
  processAPIError(args: ProcessAPIErrorArgs): void;
}
```

Declared in `packages/adapters/mastra/src/index.d.ts`.

#### `MastraModelIdentity`

```ts
export interface MastraModelIdentity {
  readonly provider: string;
  readonly model: string;
}
```

Declared in `packages/adapters/mastra/src/index.d.ts`.

#### `MastraModelResponse`

```ts
export interface MastraModelResponse {
  readonly chunks: ProcessLLMResponseArgs["chunks"];
  readonly warnings: ProcessLLMResponseArgs["warnings"];
  readonly request: ProcessLLMResponseArgs["request"];
  readonly rawResponse: ProcessLLMResponseArgs["rawResponse"];
  readonly fromCache: false;
  readonly model: ProcessLLMResponseArgs["model"];
  readonly stepNumber: number;
}
```

Declared in `packages/adapters/mastra/src/index.d.ts`.

#### `MastraObserverError`

```ts
export interface MastraObserverError {
  readonly stage: string;
  readonly error: unknown;
}
```

Declared in `packages/adapters/mastra/src/index.d.ts`.

#### `MastraUsageObservation`

```ts
export interface MastraUsageObservation {
  readonly usage: ModelUsage;
  readonly identity: AdapterLifecycleIdentity;
}
```

Declared in `packages/adapters/mastra/src/index.d.ts`.

### Type aliases

#### `MastraModelRequest`

```ts
export type MastraModelRequest = ProcessLLMRequestArgs["prompt"];
```

Declared in `packages/adapters/mastra/src/index.d.ts`.

### Functions

#### `createAdapter`

```ts
export function createMastraAdapter(options?: MastraAdapterOptions): MastraAdapterProcessor;
```

Declared in `packages/adapters/mastra/src/index.d.ts`.

#### `createMastraAdapter`

```ts
export function createMastraAdapter(options?: MastraAdapterOptions): MastraAdapterProcessor;
```

Declared in `packages/adapters/mastra/src/index.d.ts`.

#### `normalizeMastraUsage`

```ts
export function normalizeMastraUsage(
  usage: ProcessOutputStepArgs["usage"],
  identity: MastraModelIdentity,
): ModelUsage;
```

Declared in `packages/adapters/mastra/src/index.d.ts`.

### Variables & constants

#### `default`

```ts
declare const adapterPackage: AdapterPackage<typeof createMastraAdapter>;
```

Declared in `packages/adapters/mastra/src/index.d.ts`.

#### `manifest`

```ts
export const manifest: AdapterManifestV2;
```

Declared in `packages/adapters/mastra/src/index.d.ts`.

## `@caveman-ai/adapter-mastra/manifest`

Declaration file: `packages/adapters/mastra/src/manifest.d.ts`.

<details><summary>Symbol index</summary>

- **Variable**: `adapterManifest`

</details>

### Variables & constants

#### `adapterManifest`

```ts
export const adapterManifest: AdapterManifestV2;
```

Declared in `packages/adapters/mastra/src/manifest.d.ts`.

