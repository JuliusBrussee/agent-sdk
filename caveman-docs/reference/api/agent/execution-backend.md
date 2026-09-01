# `@caveman-ai/agent/execution-backend`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/execution-backend.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `ExecRequest`, `ExecResult`, `ExecutionBackend`
- **Function**: `httpExecutionBackend`, `localExecutionBackend`

</details>

## Interfaces

### `ExecRequest`

```ts
export interface ExecRequest {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly signal?: AbortSignal;
}
```

Declared in `packages/agent/dist/execution-backend.d.ts`.

### `ExecResult`

```ts
export interface ExecResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number | null;
    readonly timedOut: boolean;
    readonly truncated: boolean;
}
```

Declared in `packages/agent/dist/execution-backend.d.ts`.

### `ExecutionBackend`

```ts
export interface ExecutionBackend {
    readonly id: string;
    exec(request: ExecRequest): Promise<ExecResult>;
    readFile(path: string, opts?: {
        maxBytes?: number;
    }): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    prepare?(): Promise<void>;
    snapshot?(): Promise<string>;
    restore?(snapshotId: string): Promise<void>;
    close?(): Promise<void>;
}
```

Declared in `packages/agent/dist/execution-backend.d.ts`.

## Functions

### `httpExecutionBackend`

```ts
export declare function httpExecutionBackend(opts: {
    url: string;
    token: string;
    fetch?: typeof fetch;
}): ExecutionBackend;
```

Declared in `packages/agent/dist/execution-backend.d.ts`.

### `localExecutionBackend`

```ts
export declare function localExecutionBackend(): ExecutionBackend;
```

Declared in `packages/agent/dist/execution-backend.d.ts`.

