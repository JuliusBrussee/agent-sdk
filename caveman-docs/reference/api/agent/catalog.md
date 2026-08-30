# `@caveman-ai/agent/catalog`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/catalog.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `CatalogCacheProfile`, `CatalogModelFacts`, `CatalogPrice`, `CatalogPriceRates`, `CatalogRecurringUTCPriceWindow`, `CatalogRecurringUTCPricing`, `CatalogUsage`
- **Type alias**: `CatalogSupportState`
- **Function**: `catalogCacheProfile`, `catalogCost`, `catalogCostForPrice`, `catalogModelFacts`, `catalogModelRuntimeEligible`, `catalogPriceAt`, `catalogPriceFingerprint`, `catalogPriceVerifiedAt`, `catalogRuntimeModel`, `catalogSearchCeiling`
- **Variable**: `CATALOG_SEMANTIC_SHA256`, `CATALOG_SHA256`, `PRICE_PROVENANCE_SHA256`

</details>

## Interfaces

### `CatalogCacheProfile`

Provider cache-capability facts for the in-SDK cache planner, one entry per
runtime-eligible USD catalog row with a supported cache profile — every
region, keyed "provider/model@region", because cache facts are regional.
Rates ground write/read multipliers; null stays unknown, never guessed.

```ts
export interface CatalogCacheProfile {
    id: string;
    mode: "explicit" | "implicit" | "affinity" | "automatic";
    attribution: string;
    minPrefixTokens: number;
    maxBreakpoints: number;
    ttlSeconds: number;
    rolling: boolean;
    routingKey: boolean;
    maxRpmPerKey: number;
    endpoints: readonly string[];
    inputPerMillion: number | null;
    cacheReadPerMillion: number | null;
    cacheWritePerMillion: number | null;
}
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `CatalogModelFacts`

```ts
export interface CatalogModelFacts {
    lifecycle: "discovered" | "reviewed" | "routable" | "retired";
    messagesAPI: CatalogSupportState;
    adaptiveThinking: CatalogSupportState;
    manualThinking: CatalogSupportState;
}
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `CatalogPrice`

```ts
export interface CatalogPrice extends CatalogPriceRates {
    verifiedAt: string;
    recurringUTCPricing?: CatalogRecurringUTCPricing;
}
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `CatalogPriceRates`

```ts
export interface CatalogPriceRates {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheMode: "unknown" | "unsupported" | "explicit" | "implicit" | "affinity" | "automatic";
    cacheReadPerMillion: number | null;
    cacheWritePerMillion: number | null;
    reasoningPerMillion: number | null;
}
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `CatalogRecurringUTCPriceWindow`

```ts
export interface CatalogRecurringUTCPriceWindow {
    startSecondUTC: number;
    endSecondUTC: number;
    price: CatalogPriceRates;
}
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `CatalogRecurringUTCPricing`

```ts
export interface CatalogRecurringUTCPricing {
    effectiveFrom: string;
    defaultPrice: CatalogPriceRates;
    windows: readonly CatalogRecurringUTCPriceWindow[];
}
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `CatalogUsage`

```ts
export interface CatalogUsage {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
}
```

Declared in `packages/agent/dist/catalog.d.ts`.

## Type aliases

### `CatalogSupportState`

```ts
export type CatalogSupportState = "unknown" | "unsupported" | "supported";
```

Declared in `packages/agent/dist/catalog.d.ts`.

## Functions

### `catalogCacheProfile`

Cache profile lookup mirroring the Go engine: empty region means "global".

```ts
export declare function catalogCacheProfile(provider: string, model: string, region?: string): CatalogCacheProfile | undefined;
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `catalogCost`

```ts
export declare function catalogCost(usage: CatalogUsage, accountingAt?: Date): {
    priced: boolean;
    usd: number;
};
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `catalogCostForPrice`

```ts
export declare function catalogCostForPrice(price: CatalogPriceRates | undefined, usage: CatalogUsage): {
    priced: boolean;
    usd: number;
};
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `catalogModelFacts`

```ts
export declare function catalogModelFacts(provider: string, model: string): CatalogModelFacts | undefined;
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `catalogModelRuntimeEligible`

```ts
export declare function catalogModelRuntimeEligible(facts: CatalogModelFacts | undefined): facts is CatalogModelFacts;
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `catalogPriceAt`

```ts
export declare function catalogPriceAt(price: CatalogPrice | undefined, accountingAt?: Date): CatalogPriceRates | undefined;
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `catalogPriceFingerprint`

Exact money-rate identity at a request time. It includes every nullable rate,
cache semantics, schedule epoch, and the generated price-provenance digest.

```ts
export declare function catalogPriceFingerprint(provider: string, model: string, accountingAt?: Date): string | undefined;
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `catalogPriceVerifiedAt`

Exact pricing-review instant from the generated catalog source.

```ts
export declare function catalogPriceVerifiedAt(provider: string, model: string): string | undefined;
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `catalogRuntimeModel`

```ts
export declare function catalogRuntimeModel(provider: string, model: string): CatalogModelFacts | undefined;
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `catalogSearchCeiling`

```ts
export declare function catalogSearchCeiling(model: string, inputTokens: number, outputTokens: number, accountingAt?: Date): number | undefined;
```

Declared in `packages/agent/dist/catalog.d.ts`.

## Variables & constants

### `CATALOG_SEMANTIC_SHA256`

```ts
export declare const CATALOG_SEMANTIC_SHA256 = "f9f74e012f52474ed3f0d4fdc40feef766cb035dd61eec1d97282946385942bb";
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `CATALOG_SHA256`

```ts
export declare const CATALOG_SHA256 = "44f273c90cd7ab4707888fdf7ac5aea21d668e2204ef8a66683644e9151e1ce8";
```

Declared in `packages/agent/dist/catalog.d.ts`.

### `PRICE_PROVENANCE_SHA256`

```ts
export declare const PRICE_PROVENANCE_SHA256 = "3712b1307ed08b02a1bb2c6ec4df1c3af14a6a3b619cba8b34f513f4bcc00035";
```

Declared in `packages/agent/dist/catalog.d.ts`.

