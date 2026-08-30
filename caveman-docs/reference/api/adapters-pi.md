# `@caveman-ai/adapter-pi` API reference

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.1.0`.

Caveman adapter and exact-native compiler target for Pi.

## Entrypoints

| Import specifier | Declarations | Exported symbols |
| --- | --- | --- |
| `@caveman-ai/adapter-pi` | `packages/adapters/pi/src/index.d.ts` | 6 |
| `@caveman-ai/adapter-pi/manifest` | `packages/adapters/pi/src/manifest.d.ts` | unbuilt |

## `@caveman-ai/adapter-pi`

Declaration file: `packages/adapters/pi/src/index.d.ts`.

<details><summary>Symbol index</summary>

- **Function**: `compileProfiledNativePi`, `createAdapter`, `createPiAdapter`, `nativePiCompilerTarget`
- **Variable**: `default`, `manifest`

</details>

### Functions

#### `compileProfiledNativePi`

Native Pi lane. Compiler owns candidate shape plus both runAgentInternal
validation runners; callers cannot inject alternate behavioral plans.

```ts
export declare function compileProfiledNativePi(input: CompileProfiledNativePiInput): Promise<CompileProfiledResult>;
```

Declared in `packages/agent/dist/compiler.d.ts`.

#### `createAdapter`

```ts
export function createAdapter(
  identity: HarnessAdapterIdentity,
  invoke: HarnessInvoke,
): HarnessAdapter;
```

Declared in `packages/adapters/pi/src/index.d.ts`.

#### `createPiAdapter`

```ts
export function createAdapter(
  identity: HarnessAdapterIdentity,
  invoke: HarnessInvoke,
): HarnessAdapter;
```

Declared in `packages/adapters/pi/src/index.d.ts`.

#### `nativePiCompilerTarget`

```ts
export declare function nativePiCompilerTarget(): CompilerTarget;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### Variables & constants

#### `default`

```ts
declare const adapterPackage: AdapterPackage<typeof createAdapter>;
```

Declared in `packages/adapters/pi/src/index.d.ts`.

#### `manifest`

```ts
export const manifest: AdapterManifest;
```

Declared in `packages/adapters/pi/src/index.d.ts`.

## `@caveman-ai/adapter-pi/manifest`

Declaration file: `packages/adapters/pi/src/manifest.d.ts`.

_Declarations not built. Run `npm run build` and regenerate._

