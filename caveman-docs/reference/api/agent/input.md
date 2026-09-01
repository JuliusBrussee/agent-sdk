# `@caveman-ai/agent/input`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/input.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `AgentAudioInputPart`, `AgentFileInputPart`, `AgentImageInputPart`, `AgentInputBase64Source`, `AgentInputEncoder`, `AgentInputURLSource`, `AgentOpaqueInputPart`, `AgentTextInputPart`, `NormalizedAgentInput`
- **Type alias**: `AgentInput`, `AgentInputPart`, `AgentInputSource`, `FiniteJSON`
- **Function**: `defineAgentInputEncoder`, `encodeAgentInput`, `normalizeAgentInput`
- **Variable**: `AGENT_INPUT_MAX_BASE64_BYTES_PER_PART`, `AGENT_INPUT_MAX_BASE64_BYTES_TOTAL`, `AGENT_INPUT_MAX_FILE_NAME_LENGTH`, `AGENT_INPUT_MAX_MIME_LENGTH`, `AGENT_INPUT_MAX_PARTS`, `AGENT_INPUT_MAX_TEXT_BYTES`, `AGENT_INPUT_MAX_URL_LENGTH`

</details>

## Interfaces

### `AgentAudioInputPart`

```ts
export interface AgentAudioInputPart {
    readonly type: "audio";
    readonly mimeType: string;
    readonly source: AgentInputSource;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentFileInputPart`

```ts
export interface AgentFileInputPart {
    readonly type: "file";
    readonly mimeType: string;
    readonly source: AgentInputSource;
    readonly name?: string;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentImageInputPart`

```ts
export interface AgentImageInputPart {
    readonly type: "image";
    readonly mimeType: string;
    readonly source: AgentInputSource;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentInputBase64Source`

```ts
export interface AgentInputBase64Source {
    readonly type: "base64";
    readonly data: string;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentInputEncoder`

```ts
export interface AgentInputEncoder<Output> {
    readonly id: string;
    /** Pure capability check. Called for every part before `encode`. */
    readonly supports: (part: AgentInputPart) => boolean;
    /** Encodes normalized data only. URL retrieval remains provider/host-owned. */
    readonly encode: (input: NormalizedAgentInput, signal: AbortSignal) => Output | Promise<Output>;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentInputURLSource`

```ts
export interface AgentInputURLSource {
    readonly type: "url";
    readonly url: string;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentOpaqueInputPart`

```ts
export interface AgentOpaqueInputPart {
    readonly type: "opaque";
    readonly provider: string;
    readonly value: FiniteJSON;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentTextInputPart`

```ts
export interface AgentTextInputPart {
    readonly type: "text";
    readonly text: string;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `NormalizedAgentInput`

```ts
export interface NormalizedAgentInput {
    readonly parts: readonly AgentInputPart[];
    readonly textBytes: number;
    readonly base64Bytes: number;
    readonly remoteReferences: number;
}
```

Declared in `packages/agent/dist/input.d.ts`.

## Type aliases

### `AgentInput`

```ts
export type AgentInput = string | readonly AgentInputPart[];
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentInputPart`

```ts
export type AgentInputPart = AgentTextInputPart | AgentImageInputPart | AgentAudioInputPart | AgentFileInputPart | AgentOpaqueInputPart;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentInputSource`

```ts
export type AgentInputSource = AgentInputURLSource | AgentInputBase64Source;
```

Declared in `packages/agent/dist/input.d.ts`.

### `FiniteJSON`

```ts
export type FiniteJSON = null | boolean | number | string | readonly FiniteJSON[] | {
    readonly [key: string]: FiniteJSON;
};
```

Declared in `packages/agent/dist/input.d.ts`.

## Functions

### `defineAgentInputEncoder`

```ts
export declare function defineAgentInputEncoder<Output>(encoder: AgentInputEncoder<Output>): AgentInputEncoder<Output>;
```

Declared in `packages/agent/dist/input.d.ts`.

### `encodeAgentInput`

Normalizes once, preflights every part, then invokes one selected encoder.

```ts
export declare function encodeAgentInput<Output>(input: AgentInput, selectedEncoder: AgentInputEncoder<Output>, signal?: AbortSignal): Promise<Output>;
```

Declared in `packages/agent/dist/input.d.ts`.

### `normalizeAgentInput`

```ts
export declare function normalizeAgentInput(input: AgentInput): NormalizedAgentInput;
```

Declared in `packages/agent/dist/input.d.ts`.

## Variables & constants

### `AGENT_INPUT_MAX_BASE64_BYTES_PER_PART`

```ts
export declare const AGENT_INPUT_MAX_BASE64_BYTES_PER_PART: number;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AGENT_INPUT_MAX_BASE64_BYTES_TOTAL`

```ts
export declare const AGENT_INPUT_MAX_BASE64_BYTES_TOTAL: number;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AGENT_INPUT_MAX_FILE_NAME_LENGTH`

```ts
export declare const AGENT_INPUT_MAX_FILE_NAME_LENGTH = 255;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AGENT_INPUT_MAX_MIME_LENGTH`

```ts
export declare const AGENT_INPUT_MAX_MIME_LENGTH = 127;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AGENT_INPUT_MAX_PARTS`

```ts
export declare const AGENT_INPUT_MAX_PARTS = 64;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AGENT_INPUT_MAX_TEXT_BYTES`

```ts
export declare const AGENT_INPUT_MAX_TEXT_BYTES: number;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AGENT_INPUT_MAX_URL_LENGTH`

```ts
export declare const AGENT_INPUT_MAX_URL_LENGTH = 8192;
```

Declared in `packages/agent/dist/input.d.ts`.

