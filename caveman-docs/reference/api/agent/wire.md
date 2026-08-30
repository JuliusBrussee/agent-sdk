# `@caveman-ai/agent/wire`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/wire.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `CavemanTransport`, `CavemanTransportOptions`, `WireCacheDecision`
- **Type alias**: `WireCacheScope`
- **Function**: `createCavemanTransport`
- **Variable**: `WIRE_MAX_USAGE_SCAN_BYTES`

</details>

## Interfaces

### `CavemanTransport`

```ts
export interface CavemanTransport {
    /** Pass to any provider client that accepts a custom fetch. */
    readonly fetch: typeof globalThis.fetch;
    /** The live meter when a budget was configured. Read-only in practice. */
    readonly meter: BudgetMeter | undefined;
}
```

Declared in `packages/agent/dist/wire.d.ts`.

### `CavemanTransportOptions`

```ts
export interface CavemanTransportOptions {
    /**
     * Hard ceiling on this transport's spend. Denomination is caller-declared and
     * fails closed: a USD budget on a model the public catalog cannot price stops
     * the call rather than spending an unmeasurable amount.
     *
     * The wire cannot see which credential pays, so it cannot tell a metered API
     * key from a subscription. `maxTokens` is the honest default for portable use;
     * `maxUsd` asserts that this transport's key is billed in dollars.
     */
    readonly budget?: RunBudget;
    /** Defaults to `"gated"`. */
    readonly cache?: WireCacheScope;
    /** Cache scope id. Requests sharing a prefix must share it. */
    readonly scope?: string;
    /** Exact provider-reported usage, once per completed call. */
    readonly onModelUsage?: (usage: ModelUsage) => void;
    /** Every cache decision, applied or not. Diagnostic only. */
    readonly onCacheDecision?: (decision: WireCacheDecision) => void;
    /** Underlying transport. Defaults to `globalThis.fetch`. */
    readonly fetch?: typeof globalThis.fetch;
}
```

Declared in `packages/agent/dist/wire.d.ts`.

### `WireCacheDecision`

```ts
export interface WireCacheDecision {
    readonly provider: string;
    readonly model: string;
    readonly endpoint: string;
    readonly applied: boolean;
    readonly reason: string;
    readonly optimizerIds: readonly string[];
    readonly plan: CachePlan;
    /** True when the planner chose to act but {@link WireCacheScope} held it. */
    readonly heldByScope: boolean;
}
```

Declared in `packages/agent/dist/wire.d.ts`.

## Type aliases

### `WireCacheScope`

How much of the cache planner may reach a live provider.

`"gated"` mirrors `runtime.ts` exactly: only cache grammars proven against a
live provider leave the SDK, which today is the OpenAI affinity routing key
alone. Anthropic and Bedrock splices are byte-parity-tested against the Go
engine's fixtures but have never been sent to a live endpoint from this SDK
(#225), so they are held back here for the same reason.

`"all"` releases every grammar the planner selects. It is an explicit,
documented opt-in to unproven-live behavior, never a default.

```ts
export type WireCacheScope = "off" | "gated" | "all";
```

Declared in `packages/agent/dist/wire.d.ts`.

## Functions

### `createCavemanTransport`

```ts
export declare function createCavemanTransport(options?: CavemanTransportOptions): CavemanTransport;
```

Declared in `packages/agent/dist/wire.d.ts`.

## Variables & constants

### `WIRE_MAX_USAGE_SCAN_BYTES`

Largest response body scanned for usage. Past it, usage stays unknown.

```ts
export declare const WIRE_MAX_USAGE_SCAN_BYTES: number;
```

Declared in `packages/agent/dist/wire.d.ts`.

