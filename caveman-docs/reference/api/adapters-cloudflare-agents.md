# `@caveman-ai/adapter-cloudflare-agents` API reference

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.1.0`.

Native Caveman observability adapter for Cloudflare Agents.

## Entrypoints

| Import specifier | Declarations | Exported symbols |
| --- | --- | --- |
| `@caveman-ai/adapter-cloudflare-agents` | `packages/adapters/cloudflare-agents/src/index.d.ts` | 8 |
| `@caveman-ai/adapter-cloudflare-agents/manifest` | `packages/adapters/cloudflare-agents/src/manifest.d.ts` | 1 |

## `@caveman-ai/adapter-cloudflare-agents`

Declaration file: `packages/adapters/cloudflare-agents/src/index.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `CloudflareAgentsAdapter`, `CloudflareAgentsAdapterOptions`, `CloudflareAgentsObserverError`
- **Function**: `createCloudflareAgentsAdapter`
- **Variable**: `CLOUDFLARE_AGENTS_VERSION`, `createAdapter`, `default`, `manifest`

</details>

### Interfaces

#### `CloudflareAgentsAdapter`

```ts
export interface CloudflareAgentsAdapter {
  /** Assign directly to an Agent instance's native `observability` field. */
  readonly observability: Observability;
}
```

Declared in `packages/adapters/cloudflare-agents/src/index.d.ts`.

#### `CloudflareAgentsAdapterOptions`

```ts
export interface CloudflareAgentsAdapterOptions {
  /** Existing native sink. Captured once and invoked with its original receiver. */
  readonly observability?: Observability;
  /** Best-effort canonical run observer. Rejection never changes native execution. */
  readonly onLifecycleEvent?: (
    event: AdapterLifecycleEvent,
  ) => void | PromiseLike<void>;
  /** Best-effort translation/sink diagnostic observer. */
  readonly onObserverError?: (
    diagnostic: CloudflareAgentsObserverError,
  ) => void | PromiseLike<void>;
}
```

Declared in `packages/adapters/cloudflare-agents/src/index.d.ts`.

#### `CloudflareAgentsObserverError`

```ts
export interface CloudflareAgentsObserverError {
  readonly stage:
    | "capacity"
    | "event"
    | "identity"
    | "lifecycle_sink"
    | "sequence"
    | "status"
    | "translate";
  readonly eventType: string;
  readonly error: unknown;
}
```

Declared in `packages/adapters/cloudflare-agents/src/index.d.ts`.

### Functions

#### `createCloudflareAgentsAdapter`

```ts
export function createCloudflareAgentsAdapter(
  options?: CloudflareAgentsAdapterOptions,
): CloudflareAgentsAdapter;
```

Declared in `packages/adapters/cloudflare-agents/src/index.d.ts`.

### Variables & constants

#### `CLOUDFLARE_AGENTS_VERSION`

```ts
export const CLOUDFLARE_AGENTS_VERSION: "0.22.0";
```

Declared in `packages/adapters/cloudflare-agents/src/index.d.ts`.

#### `createAdapter`

```ts
export const createAdapter: typeof createCloudflareAgentsAdapter;
```

Declared in `packages/adapters/cloudflare-agents/src/index.d.ts`.

#### `default`

```ts
declare const adapterPackage: AdapterPackage<typeof createCloudflareAgentsAdapter>;
```

Declared in `packages/adapters/cloudflare-agents/src/index.d.ts`.

#### `manifest`

```ts
export const manifest: AdapterManifestV2;
```

Declared in `packages/adapters/cloudflare-agents/src/index.d.ts`.

## `@caveman-ai/adapter-cloudflare-agents/manifest`

Declaration file: `packages/adapters/cloudflare-agents/src/manifest.d.ts`.

<details><summary>Symbol index</summary>

- **Variable**: `adapterManifest`

</details>

### Variables & constants

#### `adapterManifest`

```ts
export const adapterManifest: AdapterManifestV2;
```

Declared in `packages/adapters/cloudflare-agents/src/manifest.d.ts`.

