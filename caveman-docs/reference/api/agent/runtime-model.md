# `@caveman-ai/agent/runtime-model`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/runtime-model.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `ProjectedRuntimeModel`, `RuntimeModelFacts`, `RuntimeModelProjectionOptions`
- **Type alias**: `RuntimeModelCredentialReadiness`, `RuntimeModelExecution`, `RuntimeModelModality`, `RuntimeModelUSDAccounting`
- **Function**: `projectRuntimeModels`
- **Variable**: `RUNTIME_MODEL_MAX_MODALITIES`, `RUNTIME_MODEL_MAX_MODALITY_LENGTH`, `RUNTIME_MODEL_MAX_MODEL_BYTES`, `RUNTIME_MODEL_MAX_MODELS`, `RUNTIME_MODEL_MAX_PROVIDER_LENGTH`, `RUNTIME_MODEL_PRICE_ATTESTATION_MAX_AGE_MS`

</details>

## Interfaces

### `ProjectedRuntimeModel`

Projection of runtime-owned execution facts plus catalog-owned accounting
identity. Catalog data can annotate a runtime row, never create or modify it.

```ts
export interface ProjectedRuntimeModel {
    readonly schemaVersion: 1;
    readonly identity: {
        readonly provider: string;
        readonly model: string;
    };
    readonly runtime: {
        readonly execution: RuntimeModelExecution;
        readonly credentialReadiness: RuntimeModelCredentialReadiness;
        readonly modalities: {
            readonly input: readonly RuntimeModelModality[] | null;
            readonly output: readonly RuntimeModelModality[] | null;
        };
        readonly limits: {
            readonly contextTokens: number | null;
            readonly outputTokens: number | null;
        };
    };
    readonly usdAccounting: RuntimeModelUSDAccounting;
}
```

Declared in `packages/agent/dist/runtime-model.d.ts`.

### `RuntimeModelFacts`

Facts supplied by one runtime/provider registry. Price, display, tier, and
default-model metadata deliberately do not belong here.

```ts
export interface RuntimeModelFacts {
    readonly schemaVersion: 1;
    readonly provider: string;
    readonly model: string;
    readonly execution: RuntimeModelExecution;
    readonly credentialReadiness: RuntimeModelCredentialReadiness;
    readonly modalities: {
        /** `null` means the runtime cannot attest supported input modalities. */
        readonly input: readonly RuntimeModelModality[] | null;
        /** `null` means the runtime cannot attest supported output modalities. */
        readonly output: readonly RuntimeModelModality[] | null;
    };
    readonly limits: {
        /** `null` is unknown, never unlimited. */
        readonly contextTokens: number | null;
        /** `null` is unknown, never unlimited. */
        readonly outputTokens: number | null;
    };
}
```

Declared in `packages/agent/dist/runtime-model.d.ts`.

### `RuntimeModelProjectionOptions`

```ts
export interface RuntimeModelProjectionOptions {
    /** Exact owned accounting instant. Must fall inside catalog attestation interval. */
    readonly accountingAt?: string;
}
```

Declared in `packages/agent/dist/runtime-model.d.ts`.

## Type aliases

### `RuntimeModelCredentialReadiness`

```ts
export type RuntimeModelCredentialReadiness = "ready" | "missing" | "unknown";
```

Declared in `packages/agent/dist/runtime-model.d.ts`.

### `RuntimeModelExecution`

```ts
export type RuntimeModelExecution = "executable" | "unavailable" | "unknown";
```

Declared in `packages/agent/dist/runtime-model.d.ts`.

### `RuntimeModelModality`

```ts
export type RuntimeModelModality = string;
```

Declared in `packages/agent/dist/runtime-model.d.ts`.

### `RuntimeModelUSDAccounting`

```ts
export type RuntimeModelUSDAccounting = Readonly<{
    status: "available";
    basis: "public_catalog";
    priceFingerprint: string;
    provenanceSha256: string;
}> | Readonly<{
    status: "unknown";
}>;
```

Declared in `packages/agent/dist/runtime-model.d.ts`.

## Functions

### `projectRuntimeModels`

Validate, detach, freeze, and account runtime model facts without I/O.

```ts
export declare function projectRuntimeModels(models: readonly RuntimeModelFacts[], options?: RuntimeModelProjectionOptions): readonly ProjectedRuntimeModel[];
```

Declared in `packages/agent/dist/runtime-model.d.ts`.

## Variables & constants

### `RUNTIME_MODEL_MAX_MODALITIES`

```ts
export declare const RUNTIME_MODEL_MAX_MODALITIES = 8;
```

Declared in `packages/agent/dist/runtime-model.d.ts`.

### `RUNTIME_MODEL_MAX_MODALITY_LENGTH`

```ts
export declare const RUNTIME_MODEL_MAX_MODALITY_LENGTH = 64;
```

Declared in `packages/agent/dist/runtime-model.d.ts`.

### `RUNTIME_MODEL_MAX_MODEL_BYTES`

```ts
export declare const RUNTIME_MODEL_MAX_MODEL_BYTES = 1024;
```

Declared in `packages/agent/dist/runtime-model.d.ts`.

### `RUNTIME_MODEL_MAX_MODELS`

```ts
export declare const RUNTIME_MODEL_MAX_MODELS = 8192;
```

Declared in `packages/agent/dist/runtime-model.d.ts`.

### `RUNTIME_MODEL_MAX_PROVIDER_LENGTH`

```ts
export declare const RUNTIME_MODEL_MAX_PROVIDER_LENGTH = 128;
```

Declared in `packages/agent/dist/runtime-model.d.ts`.

### `RUNTIME_MODEL_PRICE_ATTESTATION_MAX_AGE_MS`

Maximum interval one reviewed catalog price can attest for exact accounting.

```ts
export declare const RUNTIME_MODEL_PRICE_ATTESTATION_MAX_AGE_MS: number;
```

Declared in `packages/agent/dist/runtime-model.d.ts`.

