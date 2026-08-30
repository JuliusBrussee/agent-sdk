# `@caveman-ai/agent/model-usage`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/model-usage.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `CompleteModelUsage`, `ModelUsage`
- **Type alias**: `ModelUsageAccountingStatus`, `ModelUsageCost`, `ModelUsageTokenCount`
- **Function**: `defineModelUsage`, `modelUsageAccountingStatus`, `requireCompleteModelUsage`

</details>

## Interfaces

### `CompleteModelUsage`

```ts
export interface CompleteModelUsage extends ModelUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly reasoningTokens: number;
    readonly totalTokens: number;
}
```

Declared in `packages/agent/dist/model-usage.d.ts`.

### `ModelUsage`

One provider call's disjoint usage. `inputTokens` excludes cache read/write;
reasoning tokens are a subset of output tokens. `null` means unknown and is
never coerced to zero. Raw provider payloads are intentionally excluded.

```ts
export interface ModelUsage {
    readonly schemaVersion: 1;
    readonly provider: string;
    readonly model: string;
    readonly inputTokens: ModelUsageTokenCount;
    readonly outputTokens: ModelUsageTokenCount;
    readonly cacheReadTokens: ModelUsageTokenCount;
    readonly cacheWriteTokens: ModelUsageTokenCount;
    readonly reasoningTokens: ModelUsageTokenCount;
    readonly totalTokens: ModelUsageTokenCount;
    readonly cost: ModelUsageCost;
}
```

Declared in `packages/agent/dist/model-usage.d.ts`.

## Type aliases

### `ModelUsageAccountingStatus`

```ts
export type ModelUsageAccountingStatus = "complete_priced" | "complete_unpriced" | "incomplete";
```

Declared in `packages/agent/dist/model-usage.d.ts`.

### `ModelUsageCost`

```ts
export type ModelUsageCost = {
    readonly status: "estimated";
    readonly basis: "public_catalog";
    readonly usd: number;
} | {
    readonly status: "unpriced";
} | {
    readonly status: "unknown";
};
```

Declared in `packages/agent/dist/model-usage.d.ts`.

### `ModelUsageTokenCount`

```ts
export type ModelUsageTokenCount = number | null;
```

Declared in `packages/agent/dist/model-usage.d.ts`.

## Functions

### `defineModelUsage`

Validate, detach, and freeze one model-call usage record.

```ts
export declare function defineModelUsage(value: unknown): ModelUsage;
```

Declared in `packages/agent/dist/model-usage.d.ts`.

### `modelUsageAccountingStatus`

```ts
export declare function modelUsageAccountingStatus(value: ModelUsage): ModelUsageAccountingStatus;
```

Declared in `packages/agent/dist/model-usage.d.ts`.

### `requireCompleteModelUsage`

Fail closed where token accounting requires every disjoint component.

```ts
export declare function requireCompleteModelUsage(value: ModelUsage): CompleteModelUsage;
```

Declared in `packages/agent/dist/model-usage.d.ts`.

