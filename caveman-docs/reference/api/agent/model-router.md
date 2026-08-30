# `@caveman-ai/agent/model-router`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/model-router.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `CreateModelRouterOptions`, `ModelRouter`, `ModelRouterContext`, `ModelRouterDefinition`, `ModelRouterSnapshot`, `ModelRouterTransition`
- **Type alias**: `FiniteJSON`, `ModelRouterJSON`
- **Function**: `adaptStatelessModelCallRouter`, `asModelCallRouter`, `createModelRouter`, `normalizeFiniteJSON`
- **Variable**: `FINITE_JSON_MAX_BYTES`, `FINITE_JSON_MAX_DEPTH`, `FINITE_JSON_MAX_ENTRIES`, `MODEL_ROUTER_MAX_SIGNALS`, `MODEL_ROUTER_STATE_MAX_BYTES`, `MODEL_ROUTER_STATE_MAX_DEPTH`, `MODEL_ROUTER_STATE_MAX_ENTRIES`

</details>

## Interfaces

### `CreateModelRouterOptions`

```ts
export interface CreateModelRouterOptions {
    readonly snapshot?: ModelRouterSnapshot;
}
```

Declared in `packages/agent/dist/model-router.d.ts`.

### `ModelRouter`

```ts
export interface ModelRouter {
    readonly id: string;
    route(input: ModelCallRouteInput, signal?: AbortSignal): Promise<ModelCallRouteDecision>;
    snapshot(): ModelRouterSnapshot;
}
```

Declared in `packages/agent/dist/model-router.d.ts`.

### `ModelRouterContext`

```ts
export interface ModelRouterContext {
    readonly input: ModelCallRouteInput;
    readonly state: ModelRouterJSON;
    readonly revision: number;
    readonly signal: AbortSignal;
}
```

Declared in `packages/agent/dist/model-router.d.ts`.

### `ModelRouterDefinition`

```ts
export interface ModelRouterDefinition {
    readonly id: string;
    readonly initialState?: ModelRouterJSON;
    readonly route: (context: ModelRouterContext) => ModelRouterTransition | Promise<ModelRouterTransition>;
}
```

Declared in `packages/agent/dist/model-router.d.ts`.

### `ModelRouterSnapshot`

```ts
export interface ModelRouterSnapshot {
    readonly schemaVersion: 1;
    readonly routerId: string;
    readonly revision: number;
    readonly state: ModelRouterJSON;
}
```

Declared in `packages/agent/dist/model-router.d.ts`.

### `ModelRouterTransition`

```ts
export interface ModelRouterTransition {
    readonly decision: ModelCallRouteDecision;
    readonly state: ModelRouterJSON;
}
```

Declared in `packages/agent/dist/model-router.d.ts`.

## Type aliases

### `FiniteJSON`

```ts
export type FiniteJSON = null | boolean | number | string | readonly FiniteJSON[] | {
    readonly [key: string]: FiniteJSON;
};
```

Declared in `packages/agent/dist/model-router.d.ts`.

### `ModelRouterJSON`

```ts
export type ModelRouterJSON = FiniteJSON;
```

Declared in `packages/agent/dist/model-router.d.ts`.

## Functions

### `adaptStatelessModelCallRouter`

Wraps existing `ModelCallRouter` code in a state-free router. Its snapshot is
always revision zero with null state; adaptation cannot invent durability.

```ts
export declare function adaptStatelessModelCallRouter(id: string, router: ModelCallRouter): ModelRouter;
```

Declared in `packages/agent/dist/model-router.d.ts`.

### `asModelCallRouter`

Adapts routing only; existing runtime remains sole owner of provider I/O.

```ts
export declare function asModelCallRouter(router: ModelRouter): ModelCallRouter;
```

Declared in `packages/agent/dist/model-router.d.ts`.

### `createModelRouter`

```ts
export declare function createModelRouter(definition: ModelRouterDefinition, options?: CreateModelRouterOptions): ModelRouter;
```

Declared in `packages/agent/dist/model-router.d.ts`.

### `normalizeFiniteJSON`

Copies, deep-freezes, and bounds one JSON value for state or opaque input.

```ts
export declare function normalizeFiniteJSON(value: unknown): FiniteJSON;
```

Declared in `packages/agent/dist/model-router.d.ts`.

## Variables & constants

### `FINITE_JSON_MAX_BYTES`

```ts
export declare const FINITE_JSON_MAX_BYTES: number;
```

Declared in `packages/agent/dist/model-router.d.ts`.

### `FINITE_JSON_MAX_DEPTH`

```ts
export declare const FINITE_JSON_MAX_DEPTH = 16;
```

Declared in `packages/agent/dist/model-router.d.ts`.

### `FINITE_JSON_MAX_ENTRIES`

```ts
export declare const FINITE_JSON_MAX_ENTRIES = 1024;
```

Declared in `packages/agent/dist/model-router.d.ts`.

### `MODEL_ROUTER_MAX_SIGNALS`

```ts
export declare const MODEL_ROUTER_MAX_SIGNALS = 64;
```

Declared in `packages/agent/dist/model-router.d.ts`.

### `MODEL_ROUTER_STATE_MAX_BYTES`

```ts
export declare const MODEL_ROUTER_STATE_MAX_BYTES: number;
```

Declared in `packages/agent/dist/model-router.d.ts`.

### `MODEL_ROUTER_STATE_MAX_DEPTH`

```ts
export declare const MODEL_ROUTER_STATE_MAX_DEPTH = 16;
```

Declared in `packages/agent/dist/model-router.d.ts`.

### `MODEL_ROUTER_STATE_MAX_ENTRIES`

```ts
export declare const MODEL_ROUTER_STATE_MAX_ENTRIES = 1024;
```

Declared in `packages/agent/dist/model-router.d.ts`.

