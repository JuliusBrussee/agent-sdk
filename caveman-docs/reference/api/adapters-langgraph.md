# `@caveman-ai/adapter-langgraph` API reference

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.1.0`.

Native observation adapter for LangGraph.js.

## Entrypoints

| Import specifier | Declarations | Exported symbols |
| --- | --- | --- |
| `@caveman-ai/adapter-langgraph` | `packages/adapters/langgraph/src/index.d.ts` | 16 |
| `@caveman-ai/adapter-langgraph/manifest` | `packages/adapters/langgraph/src/manifest.d.ts` | 1 |

## `@caveman-ai/adapter-langgraph`

Declaration file: `packages/adapters/langgraph/src/index.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `LangGraphAdapter`, `LangGraphAdapterOptions`, `LangGraphModelContext`, `LangGraphModelIdentity`, `LangGraphObserverError`, `LangGraphUsageObservation`
- **Type alias**: `LangGraphLifecycleSink`, `LangGraphModelResolver`, `LangGraphObserverErrorSink`, `LangGraphStreamSink`, `LangGraphStreamTransformerFactory`, `LangGraphUsageSink`
- **Function**: `createAdapter`, `createLangGraphAdapter`
- **Variable**: `default`, `manifest`

</details>

### Interfaces

#### `LangGraphAdapter`

```ts
export interface LangGraphAdapter {
  readonly callbackHandler: BaseCallbackHandler;
  readonly callbacks: readonly [BaseCallbackHandler];
  readonly transformer: LangGraphStreamTransformerFactory;
  readonly transformers: readonly [LangGraphStreamTransformerFactory];
  composeCallbacks(existing?: Callbacks): Callbacks;
  composeConfig(): RunnableConfig & { readonly callbacks: Callbacks };
  composeConfig<TConfig extends RunnableConfig>(
    config: TConfig,
  ): TConfig & { readonly callbacks: Callbacks };
  composeTransformers(): readonly [LangGraphStreamTransformerFactory];
  composeTransformers<
    const TTransformers extends readonly (() => StreamTransformer<unknown>)[],
  >(
    existing: TTransformers,
  ): readonly [...TTransformers, LangGraphStreamTransformerFactory];
}
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

#### `LangGraphAdapterOptions`

```ts
export interface LangGraphAdapterOptions {
  /** Static identity for single-model graphs. Mutually exclusive with `resolveModel`. */
  readonly model?: LangGraphModelIdentity;
  /** Per-call identity for multi-model graphs. Mutually exclusive with `model`. */
  readonly resolveModel?: LangGraphModelResolver;
  readonly onLifecycle?: LangGraphLifecycleSink;
  readonly onUsage?: LangGraphUsageSink;
  readonly onStreamEvent?: LangGraphStreamSink;
  readonly onObserverError?: LangGraphObserverErrorSink;
}
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

#### `LangGraphModelContext`

```ts
export interface LangGraphModelContext {
  readonly nativeRunId: string;
  readonly parentRunId: string;
  readonly serializedId: readonly string[];
  readonly providerHint: string | null;
  readonly modelHint: string | null;
}
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

#### `LangGraphModelIdentity`

```ts
export interface LangGraphModelIdentity {
  readonly provider: string;
  readonly model: string;
}
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

#### `LangGraphObserverError`

```ts
export interface LangGraphObserverError {
  readonly stage: string;
  readonly error: unknown;
}
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

#### `LangGraphUsageObservation`

```ts
export interface LangGraphUsageObservation {
  readonly usage: ModelUsage;
  readonly identity: AdapterLifecycleIdentity;
}
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

### Type aliases

#### `LangGraphLifecycleSink`

```ts
export type LangGraphLifecycleSink = (
  event: AdapterLifecycleEvent,
) => void | PromiseLike<void>;
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

#### `LangGraphModelResolver`

```ts
export type LangGraphModelResolver = (
  context: LangGraphModelContext,
) => LangGraphModelIdentity | null | undefined;
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

#### `LangGraphObserverErrorSink`

```ts
export type LangGraphObserverErrorSink = (
  error: LangGraphObserverError,
) => void | PromiseLike<void>;
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

#### `LangGraphStreamSink`

```ts
export type LangGraphStreamSink = (
  event: Readonly<ProtocolEvent>,
) => void | PromiseLike<void>;
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

#### `LangGraphStreamTransformerFactory`

```ts
export type LangGraphStreamTransformerFactory = () => StreamTransformer<Readonly<Record<string, never>>>;
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

#### `LangGraphUsageSink`

```ts
export type LangGraphUsageSink = (
  observation: LangGraphUsageObservation,
) => void | PromiseLike<void>;
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

### Functions

#### `createAdapter`

```ts
export function createLangGraphAdapter(options?: LangGraphAdapterOptions): LangGraphAdapter;
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

#### `createLangGraphAdapter`

```ts
export function createLangGraphAdapter(options?: LangGraphAdapterOptions): LangGraphAdapter;
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

### Variables & constants

#### `default`

```ts
declare const adapterPackage: AdapterPackage<typeof createLangGraphAdapter>;
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

#### `manifest`

```ts
export const manifest: AdapterManifestV2;
```

Declared in `packages/adapters/langgraph/src/index.d.ts`.

## `@caveman-ai/adapter-langgraph/manifest`

Declaration file: `packages/adapters/langgraph/src/manifest.d.ts`.

<details><summary>Symbol index</summary>

- **Variable**: `adapterManifest`

</details>

### Variables & constants

#### `adapterManifest`

```ts
export const adapterManifest: AdapterManifestV2;
```

Declared in `packages/adapters/langgraph/src/manifest.d.ts`.

