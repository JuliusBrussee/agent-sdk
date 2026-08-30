# `@caveman-ai/adapter-vercel-ai-sdk` API reference

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.1.0`.

Native Caveman middleware and lifecycle adapter for Vercel AI SDK.

## Entrypoints

| Import specifier | Declarations | Exported symbols |
| --- | --- | --- |
| `@caveman-ai/adapter-vercel-ai-sdk` | `packages/adapters/vercel-ai-sdk/src/index.d.ts` | 15 |
| `@caveman-ai/adapter-vercel-ai-sdk/manifest` | `packages/adapters/vercel-ai-sdk/src/manifest.d.ts` | unbuilt |

## `@caveman-ai/adapter-vercel-ai-sdk`

Declaration file: `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `VercelAgentCallbacks`, `VercelAISDKAdapter`, `VercelAISDKAdapterOptions`
- **Type alias**: `VercelAgentCallbackInput`, `VercelGenerateResult`, `VercelModelRequest`, `VercelModelResponse`, `VercelProviderUsage`, `VercelStreamResult`
- **Function**: `createVercelAISDKAdapter`, `normalizeVercelUsage`
- **Variable**: `createAdapter`, `default`, `manifest`, `VERCEL_AI_SDK_VERSION`

</details>

### Interfaces

#### `VercelAgentCallbacks`

```ts
export interface VercelAgentCallbacks {
  readonly onStart?: GenerateTextOnStartCallback;
  readonly onStepStart?: GenerateTextOnStepStartCallback;
  readonly onToolExecutionStart?: OnToolExecutionStartCallback;
  readonly onToolExecutionEnd?: OnToolExecutionEndCallback;
  readonly onStepEnd?: GenerateTextOnStepEndCallback;
  readonly onEnd?: GenerateTextOnEndCallback;
}
```

Declared in `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

#### `VercelAISDKAdapter`

```ts
export interface VercelAISDKAdapter {
  readonly middleware: LanguageModelMiddleware;
  composeAgentCallbacks<Existing extends VercelAgentCallbackInput = VercelAgentCallbackInput>(
    existing?: Existing,
  ): VercelAgentCallbacks;
}
```

Declared in `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

#### `VercelAISDKAdapterOptions`

```ts
export interface VercelAISDKAdapterOptions {
  /** Canonical Caveman request boundary. Provider I/O remains Vercel-owned. */
  readonly modelBoundary?: ModelBoundary<VercelModelRequest, VercelModelResponse>;
  /** Diagnostic-only observer. Rejection never changes native execution. */
  readonly onLifecycleEvent?: (
    event: AdapterLifecycleEvent,
  ) => void | PromiseLike<void>;
  /** Diagnostic-only canonical usage observer. */
  readonly onModelUsage?: (usage: ModelUsage) => void | PromiseLike<void>;
  readonly role?: ModelBoundaryRole;
}
```

Declared in `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

### Type aliases

#### `VercelAgentCallbackInput`

```ts
export type VercelAgentCallbackInput = Partial<
  Record<keyof VercelAgentCallbacks, NativeCallback>
>;
```

Declared in `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

#### `VercelGenerateResult`

```ts
export type VercelGenerateResult = Awaited<ReturnType<WrapGenerate>>;
```

Declared in `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

#### `VercelModelRequest`

```ts
export type VercelModelRequest = Parameters<TransformParams>[0]["params"];
```

Declared in `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

#### `VercelModelResponse`

```ts
export type VercelModelResponse = VercelGenerateResult | VercelStreamResult;
```

Declared in `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

#### `VercelProviderUsage`

```ts
export type VercelProviderUsage = VercelGenerateResult["usage"];
```

Declared in `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

#### `VercelStreamResult`

```ts
export type VercelStreamResult = Awaited<ReturnType<WrapStream>>;
```

Declared in `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

### Functions

#### `createVercelAISDKAdapter`

```ts
export function createVercelAISDKAdapter(
  options?: VercelAISDKAdapterOptions,
): VercelAISDKAdapter;
```

Declared in `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

#### `normalizeVercelUsage`

```ts
export function normalizeVercelUsage(
  usage: VercelProviderUsage | LanguageModelUsage,
  identity: Readonly<{ provider: string; model: string }>,
): ModelUsage;
```

Declared in `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

### Variables & constants

#### `createAdapter`

```ts
export const createAdapter: typeof createVercelAISDKAdapter;
```

Declared in `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

#### `default`

```ts
declare const adapterPackage: AdapterPackage<typeof createVercelAISDKAdapter>;
```

Declared in `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

#### `manifest`

```ts
export const manifest: AdapterManifestV2;
```

Declared in `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

#### `VERCEL_AI_SDK_VERSION`

```ts
export const VERCEL_AI_SDK_VERSION: "7.0.84";
```

Declared in `packages/adapters/vercel-ai-sdk/src/index.d.ts`.

## `@caveman-ai/adapter-vercel-ai-sdk/manifest`

Declaration file: `packages/adapters/vercel-ai-sdk/src/manifest.d.ts`.

_Declarations not built. Run `npm run build` and regenerate._

