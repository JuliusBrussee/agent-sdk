# `@caveman-ai/adapter-claude-agent-sdk` API reference

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.1.0`.

Caveman adapter for Anthropic Claude Agent SDK.

## Entrypoints

| Import specifier | Declarations | Exported symbols |
| --- | --- | --- |
| `@caveman-ai/adapter-claude-agent-sdk` | `packages/adapters/claude-agent-sdk/src/index.d.ts` | 6 |
| `@caveman-ai/adapter-claude-agent-sdk/manifest` | `packages/adapters/claude-agent-sdk/src/manifest.d.ts` | unbuilt |

## `@caveman-ai/adapter-claude-agent-sdk`

Declaration file: `packages/adapters/claude-agent-sdk/src/index.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `ClaudeRunOptions`
- **Function**: `createAdapter`, `createClaudeAdapter`, `runClaudeAgent`
- **Variable**: `default`, `manifest`

</details>

### Interfaces

#### `ClaudeRunOptions`

```ts
export interface ClaudeRunOptions {
    rootDir?: string;
    entryPath?: string;
    gatewayURL?: string;
    ensureRuntime?: boolean;
    /** Same contract as `RunOptions.cave`. Claude runs are always unlocked, so an
     * unreachable local gateway degrades to observe-only instead of failing. */
    cave?: "auto" | "off";
    fetch?: typeof globalThis.fetch;
    engineBin?: string;
    signal?: AbortSignal;
    sandboxProfile?: RunOptions["sandboxProfile"];
    claudeCodePath?: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
}
```

Declared in `packages/agent/dist/claude-runtime.d.ts`.

### Functions

#### `createAdapter`

```ts
export function createAdapter(
  identity: HarnessAdapterIdentity,
  invoke: HarnessInvoke,
): HarnessAdapter;
```

Declared in `packages/adapters/claude-agent-sdk/src/index.d.ts`.

#### `createClaudeAdapter`

```ts
export function createAdapter(
  identity: HarnessAdapterIdentity,
  invoke: HarnessInvoke,
): HarnessAdapter;
```

Declared in `packages/adapters/claude-agent-sdk/src/index.d.ts`.

#### `runClaudeAgent`

Claude Agent SDK lane. Public calls are unlocked and never claim a Cave Build.

```ts
export declare function runClaudeAgent(definition: AgentDefinition, input: string, options?: ClaudeRunOptions): Promise<RunResult>;
```

Declared in `packages/agent/dist/claude-runtime.d.ts`.

### Variables & constants

#### `default`

```ts
declare const adapterPackage: AdapterPackage<typeof createAdapter>;
```

Declared in `packages/adapters/claude-agent-sdk/src/index.d.ts`.

#### `manifest`

```ts
export const manifest: AdapterManifest;
```

Declared in `packages/adapters/claude-agent-sdk/src/index.d.ts`.

## `@caveman-ai/adapter-claude-agent-sdk/manifest`

Declaration file: `packages/adapters/claude-agent-sdk/src/manifest.d.ts`.

_Declarations not built. Run `npm run build` and regenerate._

