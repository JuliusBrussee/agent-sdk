# `@caveman-ai/adapter-openai-agents` API reference

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.1.0`.

Native Caveman model-boundary adapter for OpenAI Agents SDK.

## Entrypoints

| Import specifier | Declarations | Exported symbols |
| --- | --- | --- |
| `@caveman-ai/adapter-openai-agents` | `packages/adapters/openai-agents/src/index.d.ts` | 12 |
| `@caveman-ai/adapter-openai-agents/manifest` | `packages/adapters/openai-agents/src/manifest.d.ts` | 1 |

## `@caveman-ai/adapter-openai-agents`

Declaration file: `packages/adapters/openai-agents/src/index.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `OpenAIAgentsAdapterOptions`, `OpenAIAgentsObserverError`, `OpenAIAgentsUsageObservation`
- **Type alias**: `OpenAIAgentsModelResponse`, `OpenAIAgentsStreamResponse`
- **Function**: `createOpenAIAgentsAdapter`, `normalizeOpenAIAgentsUsage`
- **Variable**: `createAdapter`, `default`, `manifest`, `OPENAI_AGENTS_CORE_VERSION`, `OPENAI_AGENTS_VERSION`

</details>

### Interfaces

#### `OpenAIAgentsAdapterOptions`

```ts
export interface OpenAIAgentsAdapterOptions {
  /** Canonical provider identity. Defaults to `openai`; override compatible providers. */
  readonly provider?: string;
  /** Required only when native `getModel()` is called without a model name. */
  readonly defaultModel?: string;
  /** Canonical Caveman request boundary. Provider I/O remains OpenAI Agents-owned. */
  readonly modelBoundary?: ModelBoundary<ModelRequest, OpenAIAgentsModelResponse>;
  /** Diagnostic-only exact raw-usage observation. */
  readonly onModelUsage?: (
    observation: OpenAIAgentsUsageObservation,
  ) => void | PromiseLike<void>;
  /** Diagnostic-only observer failure sink. */
  readonly onObserverError?: (
    error: OpenAIAgentsObserverError,
  ) => void | PromiseLike<void>;
  readonly role?: ModelBoundaryRole;
}
```

Declared in `packages/adapters/openai-agents/src/index.d.ts`.

#### `OpenAIAgentsObserverError`

```ts
export interface OpenAIAgentsObserverError {
  readonly source:
    | "usage.identity"
    | "usage.normalize"
    | "usage.sink"
    | "stream.inspect";
  readonly error: unknown;
}
```

Declared in `packages/adapters/openai-agents/src/index.d.ts`.

#### `OpenAIAgentsUsageObservation`

```ts
export interface OpenAIAgentsUsageObservation {
  readonly usage: ModelUsage;
  readonly identity: AdapterLifecycleIdentity & { readonly modelCallId: string };
}
```

Declared in `packages/adapters/openai-agents/src/index.d.ts`.

### Type aliases

#### `OpenAIAgentsModelResponse`

```ts
export type OpenAIAgentsModelResponse = ModelResponse | OpenAIAgentsStreamResponse;
```

Declared in `packages/adapters/openai-agents/src/index.d.ts`.

#### `OpenAIAgentsStreamResponse`

```ts
export type OpenAIAgentsStreamResponse = StreamEventResponseCompleted["response"];
```

Declared in `packages/adapters/openai-agents/src/index.d.ts`.

### Functions

#### `createOpenAIAgentsAdapter`

```ts
export function createOpenAIAgentsAdapter(
  provider: ModelProvider,
  options?: OpenAIAgentsAdapterOptions,
): ModelProvider;
```

Declared in `packages/adapters/openai-agents/src/index.d.ts`.

#### `normalizeOpenAIAgentsUsage`

```ts
export function normalizeOpenAIAgentsUsage(
  rawUsage: unknown,
  identity: Readonly<{ provider: string; model: string }>,
): ModelUsage;
```

Declared in `packages/adapters/openai-agents/src/index.d.ts`.

### Variables & constants

#### `createAdapter`

```ts
export const createAdapter: typeof createOpenAIAgentsAdapter;
```

Declared in `packages/adapters/openai-agents/src/index.d.ts`.

#### `default`

```ts
declare const adapterPackage: AdapterPackage<typeof createOpenAIAgentsAdapter>;
```

Declared in `packages/adapters/openai-agents/src/index.d.ts`.

#### `manifest`

```ts
export const manifest: AdapterManifestV2;
```

Declared in `packages/adapters/openai-agents/src/index.d.ts`.

#### `OPENAI_AGENTS_CORE_VERSION`

```ts
export const OPENAI_AGENTS_CORE_VERSION: "0.17.0";
```

Declared in `packages/adapters/openai-agents/src/index.d.ts`.

#### `OPENAI_AGENTS_VERSION`

```ts
export const OPENAI_AGENTS_VERSION: "0.17.0";
```

Declared in `packages/adapters/openai-agents/src/index.d.ts`.

## `@caveman-ai/adapter-openai-agents/manifest`

Declaration file: `packages/adapters/openai-agents/src/manifest.d.ts`.

<details><summary>Symbol index</summary>

- **Variable**: `adapterManifest`

</details>

### Variables & constants

#### `adapterManifest`

```ts
export const adapterManifest: AdapterManifestV2;
```

Declared in `packages/adapters/openai-agents/src/manifest.d.ts`.

