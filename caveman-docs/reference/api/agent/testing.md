# `@caveman-ai/agent/testing`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/testing.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `FauxModelOptions`, `ScriptedTurn`
- **Function**: `fauxModel`, `scriptedStream`

</details>

## Interfaces

### `FauxModelOptions`

```ts
export interface FauxModelOptions {
    readonly provider?: string;
    readonly id?: string;
    /**
     * Use a model id that exists in the public pricing catalog. Off by default,
     * because an uncataloged model is what proves a USD budget fails closed.
     */
    readonly priced?: boolean;
}
```

Declared in `packages/agent/dist/testing.d.ts`.

### `ScriptedTurn`

```ts
export interface ScriptedTurn {
    readonly text?: string;
    readonly toolCalls?: ReadonlyArray<{
        readonly name: string;
        readonly args: unknown;
    }>;
    readonly usage?: Partial<Usage>;
}
```

Declared in `packages/agent/dist/testing.d.ts`.

## Functions

### `fauxModel`

A model handle that never reaches a provider.

```ts
export declare function fauxModel(options?: FauxModelOptions): Model<Api>;
```

Declared in `packages/agent/dist/testing.d.ts`.

### `scriptedStream`

A {@link StreamFn} that answers each provider call with the next scripted
turn. A turn with tool calls stops with `toolUse`, so the agent loop runs
the tools and comes back for the next one.

The script running out is an error, not an empty answer: a test that made
one more call than it scripted has found something, and silently inventing
a turn would hide it.

```ts
export declare function scriptedStream(turns: ReadonlyArray<ScriptedTurn>, 
/** Clock for message timestamps; fix it when a test asserts exact bytes. */
options?: {
    readonly now?: () => number;
}): StreamFn;
```

Declared in `packages/agent/dist/testing.d.ts`.

