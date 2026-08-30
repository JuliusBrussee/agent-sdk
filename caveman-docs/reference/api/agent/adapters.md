# `@caveman-ai/agent/adapters`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/adapters.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `EveMessageResponseBinding`, `EveSessionBinding`, `HarnessAdapter`, `HarnessAdapterIdentity`, `HarnessAdapterManifest`, `HarnessExecution`, `HarnessRequest`, `HarnessResult`
- **Type alias**: `HarnessID`, `HarnessInvoke`
- **Function**: `createEveAdapter`, `createHarnessAdapter`, `validateHarnessResult`
- **Variable**: `createClaudeAdapter`, `createPiAdapter`, `EVE_VERSION`

</details>

## Interfaces

### `EveMessageResponseBinding`

```ts
export interface EveMessageResponseBinding {
    result(): Promise<{
        message: string | undefined;
        status: "completed" | "failed" | "waiting";
        events: unknown[];
    }>;
}
```

Declared in `packages/agent/dist/adapters.d.ts`.

### `EveSessionBinding`

```ts
export interface EveSessionBinding {
    send(input: {
        message: string;
        signal?: AbortSignal;
    }): Promise<EveMessageResponseBinding>;
}
```

Declared in `packages/agent/dist/adapters.d.ts`.

### `HarnessAdapter`

```ts
export interface HarnessAdapter {
    readonly id: HarnessID;
    readonly version: string;
    readonly manifest: HarnessAdapterManifest;
    readonly contractSHA256: string;
    run(request: HarnessRequest): Promise<HarnessResult>;
}
```

Declared in `packages/agent/dist/adapters.d.ts`.

### `HarnessAdapterIdentity`

```ts
export interface HarnessAdapterIdentity {
    adapterVersion: string;
    upstreamVersion: string;
    bundleSHA256: string;
    dependencyLockSHA256: string;
}
```

Declared in `packages/agent/dist/adapters.d.ts`.

### `HarnessAdapterManifest`

```ts
export interface HarnessAdapterManifest extends HarnessAdapterIdentity {
    schemaVersion: 1;
    harness: HarnessID;
    wireContract: Readonly<Record<string, unknown>>;
}
```

Declared in `packages/agent/dist/adapters.d.ts`.

### `HarnessExecution`

```ts
export interface HarnessExecution {
    terminal: boolean;
    text: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    costUsd: number;
    usageBasis: "provider_reported" | "missing";
    priceBasis: "public_catalog" | "unpriced";
    evaluatedTransformIDs: string[];
    appliedTransformIDs: string[];
    recoveryResolved: boolean;
    latencyMs: number;
}
```

Declared in `packages/agent/dist/adapters.d.ts`.

### `HarnessRequest`

```ts
export interface HarnessRequest {
    build: CaveBuildLock;
    contextIR: ContextIR;
    plan: CavePlan;
    prompt: string;
    runID: string;
    evaluatedTransformIDs: string[];
    appliedTransformIDs: string[];
    recoveryResolved: boolean;
    signal?: AbortSignal;
}
```

Declared in `packages/agent/dist/adapters.d.ts`.

### `HarnessResult`

```ts
export interface HarnessResult extends HarnessExecution {
    harness: HarnessID;
    adapterBuildSHA256: string;
    adapterContractSHA256: string;
    sourceBuildSHA256: string;
    planSHA256: string;
    contextIRSHA256: string;
    claimBasis: "inferred";
    verifiedSavingsUsd: 0;
}
```

Declared in `packages/agent/dist/adapters.d.ts`.

## Type aliases

### `HarnessID`

```ts
export type HarnessID = "pi" | "claude" | "vercel-ai-sdk" | "eve" | "mastra";
```

Declared in `packages/agent/dist/adapters.d.ts`.

### `HarnessInvoke`

```ts
export type HarnessInvoke = (request: Readonly<HarnessRequest>) => Promise<HarnessExecution>;
```

Declared in `packages/agent/dist/adapters.d.ts`.

## Functions

### `createEveAdapter`

```ts
export declare function createEveAdapter(identity: HarnessAdapterIdentity, session: EveSessionBinding): HarnessAdapter;
```

Declared in `packages/agent/dist/adapters.d.ts`.

### `createHarnessAdapter`

```ts
export declare function createHarnessAdapter(id: HarnessID, identity: HarnessAdapterIdentity, wireContract: Readonly<Record<string, unknown>>, invoke: HarnessInvoke): HarnessAdapter;
```

Declared in `packages/agent/dist/adapters.d.ts`.

### `validateHarnessResult`

Revalidate a caller-controlled adapter result before exposing any claim.

```ts
export declare function validateHarnessResult(value: unknown, input: {
    readonly adapter: HarnessAdapter;
    readonly request: HarnessRequest;
    /** Trusted times captured around adapter.run by the owning pipeline. */
    readonly accountingStartedAt: Date;
    readonly accountingFinishedAt: Date;
}): HarnessResult;
```

Declared in `packages/agent/dist/adapters.d.ts`.

## Variables & constants

### `createClaudeAdapter`

```ts
export declare const createClaudeAdapter: (identity: HarnessAdapterIdentity, invoke: HarnessInvoke) => HarnessAdapter;
```

Declared in `packages/agent/dist/adapters.d.ts`.

### `createPiAdapter`

```ts
export declare const createPiAdapter: (identity: HarnessAdapterIdentity, invoke: HarnessInvoke) => HarnessAdapter;
```

Declared in `packages/agent/dist/adapters.d.ts`.

### `EVE_VERSION`

```ts
export declare const EVE_VERSION = "0.29.2";
```

Declared in `packages/agent/dist/adapters.d.ts`.

