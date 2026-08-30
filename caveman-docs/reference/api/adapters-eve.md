# `@caveman-ai/adapter-eve` API reference

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.1.0`.

Caveman adapter for Eve ClientSession.

## Entrypoints

| Import specifier | Declarations | Exported symbols |
| --- | --- | --- |
| `@caveman-ai/adapter-eve` | `packages/adapters/eve/src/index.d.ts` | 4 |
| `@caveman-ai/adapter-eve/manifest` | `packages/adapters/eve/src/manifest.d.ts` | unbuilt |

## `@caveman-ai/adapter-eve`

Declaration file: `packages/adapters/eve/src/index.d.ts`.

<details><summary>Symbol index</summary>

- **Function**: `createAdapter`, `createEveAdapter`
- **Variable**: `default`, `manifest`

</details>

### Functions

#### `createAdapter`

```ts
export function createAdapter(
  identity: HarnessAdapterIdentity,
  session: EveSessionBinding,
): HarnessAdapter;
```

Declared in `packages/adapters/eve/src/index.d.ts`.

#### `createEveAdapter`

```ts
export function createAdapter(
  identity: HarnessAdapterIdentity,
  session: EveSessionBinding,
): HarnessAdapter;
```

Declared in `packages/adapters/eve/src/index.d.ts`.

### Variables & constants

#### `default`

```ts
declare const adapterPackage: AdapterPackage<typeof createAdapter>;
```

Declared in `packages/adapters/eve/src/index.d.ts`.

#### `manifest`

```ts
export const manifest: AdapterManifest;
```

Declared in `packages/adapters/eve/src/index.d.ts`.

## `@caveman-ai/adapter-eve/manifest`

Declaration file: `packages/adapters/eve/src/manifest.d.ts`.

_Declarations not built. Run `npm run build` and regenerate._

