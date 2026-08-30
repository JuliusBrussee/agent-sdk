# `@caveman-ai/agent/claude`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/claude.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `ClaudeRunOptions`
- **Function**: `runClaudeAgent`

</details>

## Interfaces

### `ClaudeRunOptions`

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

## Functions

### `runClaudeAgent`

Claude Agent SDK lane. Public calls are unlocked and never claim a Cave Build.

```ts
export declare function runClaudeAgent(definition: AgentDefinition, input: string, options?: ClaudeRunOptions): Promise<RunResult>;
```

Declared in `packages/agent/dist/claude-runtime.d.ts`.

